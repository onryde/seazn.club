import "server-only";
// server/usecases/stream-credit-history.ts — the ORGANISER-facing read of the match-credit ledger
// (Settings → Credits → Streaming). A NEW module on purpose: stream-credits.ts owns every WRITE of
// org_stream_credits and is not touched here; admin-stream-credits.ts is the STAFF read (it carries the
// staff user's email and the internal note, so it is never exposed as is).
//
// What an organiser may read, and what never leaves:
//  * date, a plain-words KIND, the signed change, the balance after the row, and — for a row that moved
//    because of one match — that match's names and a link. Nothing else.
//  * NOT `created_by`, NOT `note` (staff's internal text), NOT `idempotency_key`, NOT the Stripe ids. The
//    classifier below reads `created_by is not null` as a boolean, and the three keys it needs, and then
//    forgets them; a test pins the exact key set of a row.
//
// Authz — the AI credits tab's own audience (page.tsx there: "member-visible and NOT payer-gated"): any
// signed-in person of the org, whatever their role (owner / admin / viewer), plus the billing group's payer
// who is not a member (role null). Not an API key and not a device link: the tab is a person's page, and a
// scoring device never has a reason to read the money ledger. A different org is a 404, never a 403
// (404 ≡ missing, relayCredits' own rule).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { streamPassGrantKey } from "@/server/usecases/stream-credits";

/** The reasons `org_stream_credits_reason_check` (V410) allows. Pinned to the live constraint by a test, so a
 *  migration that adds a reason reds until this list — and the classifier's switch — grow with it. */
export const STREAM_LEDGER_REASONS = ["purchase", "consume", "refund", "grant", "revoke", "expire"] as const;
export type StreamLedgerReason = (typeof STREAM_LEDGER_REASONS)[number];

/** Every plain-words kind a history row can wear — the i18n keys `stream.credits.history.kind.*` are one per entry
 *  (a test holds the four dictionaries to this list). `other` is the unmapped door: no writer reaches it, the
 *  reader REPORTS any row that does, and a test fails if a real writer's row lands on it. */
export const STREAM_HISTORY_KINDS = [
  "packPurchase",    // purchase — a bought pack
  "monthlyGrant",    // grant, monthly bucket — the plan's free credits for the month (base grant or mid-month top-up)
  "passGrant",       // grant, pack bucket, stream-pass:* — an Event Pass's one-off credits
  "streamUsed",      // consume — one match streamed
  "refundNoCamera",  // refund, no author — the platform returned a credit: the stream went live and its camera never did (R2008)
  "refundStaff",     // refund by Seazn support (linked to a match or goodwill)
  "packRefund",      // revoke, no author — a bought pack was refunded on the card (or lost in a dispute) and its credits taken back
  "staffAdjust",     // grant / revoke by Seazn support
  "expired",         // expire — last month's unused free credits
  "other",
] as const;
export type StreamHistoryKind = (typeof STREAM_HISTORY_KINDS)[number];

/** The Stripe claw-back's idempotency key prefix (stream-credits.ts `recordStreamPackRefund`, a local literal there).
 *  Held to the writer by the matrix test: the real claw-back's row must land on `packRefund`. */
const CLAWBACK_KEY_PREFIX = "stream_pack_refund:";
/** The Event Pass grant's key prefix — the writer's own spelling (`streamPassGrantKey`), never a second copy. */
const PASS_KEY_PREFIX = streamPassGrantKey("");

export interface HistoryClassifyInput {
  reason: string;
  bucket: string;
  /** `created_by is not null` — a Seazn staff member wrote this row. Only the boolean ever leaves SQL. */
  byStaff: boolean;
  sessionId: string | null;
  idempotencyKey: string | null;
}

/**
 * One ledger row → the kind an organiser reads. PURE, and total over what the writers produce: every
 * (reason × author × bucket × key) a writer in stream-credits.ts can leave has a branch, and the combinations
 * none of them leave answer `other` (the reader reports those). The discriminators, per writer:
 *   purchase  recordPurchase                       → packPurchase
 *   consume   consumeForSession                    → streamUsed
 *   expire    rollMonthlyLocked                    → expired
 *   grant     staffRow('grant')   created_by set   → staffAdjust
 *             rollMonthlyLocked   bucket monthly   → monthlyGrant
 *             grantPassStreamCredits key stream-pass:* → passGrant
 *   revoke    staffRow('revoke')  created_by set   → staffAdjust
 *             recordStreamPackRefund key stream_pack_refund:* → packRefund
 *   refund    staffRow('refund')  created_by set   → refundStaff
 *             refundConsumeForSession (session, no author) → refundNoCamera
 * `refundConsumeForSession` has ONE production caller today (the R2008 never-live cancel); a second must add a
 * discriminator here, and the call-site test fails until it does.
 */
export function streamHistoryKind(row: HistoryClassifyInput): StreamHistoryKind {
  switch (row.reason) {
    case "purchase":
      return "packPurchase";
    case "consume":
      return "streamUsed";
    case "expire":
      return "expired";
    case "grant":
      if (row.byStaff) return "staffAdjust";
      if (row.bucket === "monthly") return "monthlyGrant";
      if (row.idempotencyKey?.startsWith(PASS_KEY_PREFIX)) return "passGrant";
      return "other";
    case "revoke":
      if (row.byStaff) return "staffAdjust";
      if (row.idempotencyKey?.startsWith(CLAWBACK_KEY_PREFIX)) return "packRefund";
      return "other";
    case "refund":
      if (row.byStaff) return "refundStaff";
      if (row.sessionId) return "refundNoCamera";
      return "other";
    default:
      return "other";
  }
}

/** The match a row moved for: the two sides' names (null = not yet decided), the competition and the fixture's own
 *  page. The UI formats the label — the words around the names are dictionary copy. */
export interface StreamHistoryFixture {
  homeName: string | null;
  awayName: string | null;
  fixtureNo: number;
  competitionName: string;
  href: string;
}

export interface StreamHistoryRow {
  id: string;
  /** ISO-8601, UTC. */
  dateIso: string;
  kind: StreamHistoryKind;
  /** Signed, as stored. */
  delta: number;
  /** The row's own snapshot of the org total after it — shown as a column, never read as the balance. */
  balanceAfter: number;
  fixture: StreamHistoryFixture | null;
}

export interface StreamHistoryPage {
  rows: StreamHistoryRow[];
  /** Opaque; hand it back as `cursor` for the next (older) page. Null on the last page. */
  nextCursor: string | null;
}

export const STREAM_HISTORY_DEFAULT_LIMIT = 25;
/** The ceiling of one read — also the CSV export's page size. */
export const STREAM_HISTORY_MAX_LIMIT = 1000;

/** A keyset cursor over the list's whole sort key, `(created_at, not-an-expiry, id)`:
 *   * `created_at` in the column's own TEXT form (microseconds — a JS Date would round to a millisecond and a row a
 *     microsecond older would be skipped or repeated);
 *   * whether the row is NOT an expiry (`t`/`f`) — the rollover writes the old month's expiry and the new month's grant
 *     in ONE transaction, so they share a `created_at` to the microsecond, and on a coin-flip id order the grant could
 *     list BELOW the expiry it follows, breaking the balance-after chain a reader follows down the page. An expiry
 *     therefore sorts as older than anything it ties with — the order the rollover wrote them in;
 *   * the id that breaks any remaining tie. */
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(at: string, notExpiry: boolean, id: string): string {
  return Buffer.from(`${at}|${notExpiry ? "t" : "f"}|${id}`).toString("base64url");
}

function decodeCursor(raw: string): { at: string; notExpiry: boolean; id: string } {
  const bad = () => new HttpError(400, "That history page link is not valid", "cursor_invalid");
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const [at, flag, id] = parts;
  if (parts.length !== 3 || !at || !TS.test(at) || (flag !== "t" && flag !== "f") || !id || !UUID.test(id)) throw bad();
  return { at, notExpiry: flag === "t", id };
}

/** A page-link value from a URL → a cursor, or undefined when it is not one of ours. For the PAGE, where a
 *  hand-edited `?before=` should land on the latest page rather than an error screen; the reader itself refuses. */
export function cursorFromQuery(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    decodeCursor(raw);
    return raw;
  } catch {
    return undefined;
  }
}

/** The audience gate — see the header. Org first (404), then the actor (403), so a foreign org's existence is
 *  never confirmed to a key or a device. Exported for the CSV route and the tab view, which read through it. */
export function assertCanReadStreamHistory(auth: AuthCtx, orgId: string): void {
  if (orgId.toLowerCase() !== auth.orgId.toLowerCase()) throw new HttpError(404, "organisation not found");
  if (auth.via !== "session") {
    throw new HttpError(403, "Only a signed-in person can read the match-credit history", "history_session_only");
  }
}

interface HistoryDbRow {
  id: string;
  created_at: Date | string;
  cursor_at: string;
  not_expiry: boolean;
  reason: string;
  bucket: string;
  delta: number;
  balance_after: number;
  by_staff: boolean;
  session_id: string | null;
  idempotency_key: string | null;
  org_slug: string;
  comp_slug: string | null;
  comp_name: string | null;
  div_slug: string | null;
  fixture_no: number | null;
  home_name: string | null;
  away_name: string | null;
}

/**
 * One page of `orgId`'s match-credit history, newest first. `limit` defaults to 25 and is 1..1000; `cursor` is a
 * previous page's `nextCursor`.
 *
 * Tenancy is the WHERE clause plus two join guards: the ledger row's org, and — for the match link — that the
 * session and the competition behind it belong to that SAME org. The ledger has no foreign key from a row to its
 * org's session, so the join is where a corrupt row would otherwise name another club's match.
 */
export async function listStreamCreditHistory(
  auth: AuthCtx,
  orgId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<StreamHistoryPage> {
  assertCanReadStreamHistory(auth, orgId);
  const limit = opts.limit ?? STREAM_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > STREAM_HISTORY_MAX_LIMIT) {
    throw new HttpError(422, `limit must be a whole number from 1 to ${STREAM_HISTORY_MAX_LIMIT}; got ${limit}`, "limit_invalid");
  }
  const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);

  // The cursor's instant is bound as `::text::timestamptz`, never `::timestamptz`: a parameter typed timestamptz is
  // serialised by postgres.js through a JS Date, which rounds to the millisecond and drops the microseconds the
  // cursor carries (the pagination test's microsecond-spaced rows are the witness). Typed text, the server parses it
  // at full precision.
  const rows = await sql<HistoryDbRow[]>`
    select c.id, c.created_at, c.created_at::text as cursor_at, (c.reason <> 'expire') as not_expiry, c.reason, c.bucket, c.delta, c.balance_after,
           (c.created_by is not null) as by_staff, c.session_id, c.idempotency_key,
           o.slug as org_slug,
           comp.slug as comp_slug, comp.name as comp_name, d.slug as div_slug, f.fixture_no,
           h.display_name as home_name, a.display_name as away_name
      from org_stream_credits c
      join organizations o on o.id = c.org_id
      left join fixture_stream_sessions s on s.id = c.session_id and s.org_id = c.org_id
      left join fixtures f on f.id = s.fixture_id
      left join divisions d on d.id = f.division_id
      left join competitions comp on comp.id = d.competition_id and comp.org_id = c.org_id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
     where c.org_id = ${orgId}
       ${cursor ? sql`and (c.created_at, (c.reason <> 'expire'), c.id) < (${cursor.at}::text::timestamptz, ${cursor.notExpiry}::boolean, ${cursor.id}::uuid)` : sql``}
     order by c.created_at desc, (c.reason <> 'expire') desc, c.id desc
     limit ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const mapped = page.map((r): StreamHistoryRow => {
    const kind = streamHistoryKind({
      reason: r.reason, bucket: r.bucket, byStaff: r.by_staff, sessionId: r.session_id, idempotencyKey: r.idempotency_key,
    });
    if (kind === "other") {
      // A row the classifier has no branch for: shown under the neutral label, never under a real one, and
      // reported — a new writer or reason needs a mapping, and this is how it is noticed. The report names the row
      // and the facts the classifier read, never a note or an author.
      log.error({ orgId, ledgerId: r.id, reason: r.reason, bucket: r.bucket }, "stream credit history: an org_stream_credits row has no mapping");
      captureError(new Error(`org_stream_credits row ${r.id} (reason ${r.reason}, bucket ${r.bucket}) has no history mapping`), {
        orgId, route: "settings.credits.stream_history.unmapped_row",
      });
    }
    const fixture: StreamHistoryFixture | null =
      r.fixture_no !== null && r.comp_slug !== null && r.div_slug !== null && r.comp_name !== null
        ? {
            homeName: r.home_name, awayName: r.away_name, fixtureNo: r.fixture_no, competitionName: r.comp_name,
            href: routes.fixture(r.org_slug, r.comp_slug, r.div_slug, r.fixture_no),
          }
        : null;
    return { id: r.id, dateIso: new Date(r.created_at).toISOString(), kind, delta: r.delta, balanceAfter: r.balance_after, fixture };
  });
  const last = page[page.length - 1];
  return { rows: mapped, nextCursor: hasMore && last ? encodeCursor(last.cursor_at, last.not_expiry, last.id) : null };
}

/** Every row, oldest page last — for the CSV export. Pages through the reader (so the audience gate, the tenancy
 *  guards and the order are the reader's, not a second query's) and stops at `STREAM_HISTORY_EXPORT_MAX_PAGES`,
 *  refusing by name rather than writing a file that silently ends early. */
export const STREAM_HISTORY_EXPORT_MAX_PAGES = 50;
export async function listAllStreamCreditHistory(auth: AuthCtx, orgId: string): Promise<StreamHistoryRow[]> {
  const out: StreamHistoryRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < STREAM_HISTORY_EXPORT_MAX_PAGES; i += 1) {
    const page = await listStreamCreditHistory(auth, orgId, { limit: STREAM_HISTORY_MAX_LIMIT, cursor });
    out.push(...page.rows);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new HttpError(
    500,
    `The match-credit history is longer than ${STREAM_HISTORY_EXPORT_MAX_PAGES * STREAM_HISTORY_MAX_LIMIT} rows; refusing to export a truncated file`,
    "history_export_too_long",
  );
}
