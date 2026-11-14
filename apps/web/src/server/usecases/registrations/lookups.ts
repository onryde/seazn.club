import "server-only";
// Shared loaders: settings, division context, registration rows by token / ref / org, token match (see ./index.ts).
import { timingSafeEqual } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import { parseTypedReference } from "@/lib/ref-code";
import { audit } from "../audit";
import type { Tx, RegistrationSettingsRow, RegistrationWithGroupRow, AnySql, DivisionCtx } from "./types";
import { hashRegistrationToken } from "./helpers";

/** r.* ∪ g.* for `RegistrationWithGroupRow` — every SELECT that needs the
 *  joined shape interpolates `${regGroupCols(db)}` (same convention as
 *  org-posts.ts's `COLS`/discipline.ts's `SELECT_SUSPENSION`), built from the
 *  SAME `sql`/`tx` instance as the surrounding query so the two tables'
 *  column list can only drift in one place. `g.refunded_cents` is aliased to
 *  `group_refunded_cents` so it never collides with `r.refunded_cents`
 *  (V368) — see the block comment above `RegistrationWithGroupRow`.
 *
 *  `r.cart_position` and `g.cart_size` (V519, registration redesign B5 T18) are the two stored halves of an entry's own reference:
 *  `entryReferenceOf(row)` (lib/ref-code.ts) reads them with `ref_code`. `cart_size` is the cart's STORED size (how many entries it
 *  was sent with), never a count of the entries read here, so a withdrawn or deleted sibling cannot move another entry's reference. */
export function regGroupCols(db: AnySql) {
  return db`
    r.id, r.division_id, r.org_id, r.status, r.display_name, r.answers,
    r.amount_cents, r.refunded_cents, r.late_refunded_cents, r.approved_at, r.entrant_id, r.promoted_at, r.withdrawn_at,
    r.charged_at, r.promotion_expires_at, r.waitlisted_at,
    r.payment_intent_id as entry_payment_intent_id,
    r.group_id, r.cart_position, r.join_code, r.free_agent, r.created_at, r.updated_at,
    g.contact_name, g.contact_email, g.user_id, g.locale, g.ref_code, g.cart_size,
    g.access_token_hash, g.currency, g.payment_method, g.checkout_session_id,
    g.payment_intent_id, g.expires_at, g.reminded_at,
    g.refunded_cents as group_refunded_cents,
    g.refunded_at, g.disputed_at, g.dispute_id, g.offline_marked_paid_at,
    g.offline_marked_paid_by, g.fee_percent, g.privacy_consent_at,
    g.privacy_consent_version, g.media_consent_at, g.media_consent_version`;
}

export const SETTINGS_COLS = [
  "division_id", "enabled", "entrant_kind", "opens_at", "closes_at",
  "capacity", "fee_cents", "refund_lock_at", "form_fields",
  "payment_method", "payment_instructions", "approval", "allow_free_agents",
  "free_agent_fee_cents", "place_by_at", "updated_at",
] as const;

/** Statuses that hold a capacity spot. Imported from `@/lib/registration-
 *  status` (RS004 W3b review finding 1) rather than declared here: that
 *  module is dependency-free, so the registration hub's read-only page.tsx
 *  can import the SAME array without dragging this module's Stripe/email
 *  clients along. Re-exported below so `registration-submit.ts` and
 *  `registration-approval.ts` keep importing it from `"./registrations"`
 *  unchanged. */
export { SPOT_HOLDERS };

/** Exported for `registration-approval.ts` (RS002 W5) — approve/reject/
 *  promote all need the same live division-settings read `confirmRegistration`
 *  et al. already use. */
export async function loadSettings(db: AnySql, divisionId: string): Promise<RegistrationSettingsRow | null> {
  const [row] = await db<RegistrationSettingsRow[]>`
    select ${sql(SETTINGS_COLS as unknown as string[])} from registration_settings
    where division_id = ${divisionId}`;
  return row ?? null;
}

/** Append to the competition_events audit ledger (016 pattern). Moved to
 *  `./audit` (RS011) so `registration-eligibility.ts` — a deliberate LEAF —
 *  can call it too without an import cycle; see that module's header.
 *  `audit` is imported (not just re-exported) at the top of this file — a
 *  bare `export {x} from mod` gives THIS module no local binding, and every
 *  call site below uses the local name. Re-exported so every existing
 *  importer (`registration-approval.ts`, `registration-assign.ts`) keeps
 *  compiling unchanged. */
export { audit };

/** A division's name, for a mail that names it. Refused by name when the division is gone (a mail about a division that does not
 *  exist is a wiring fault, never a blank). Moved here from lifecycle-mail.ts (walk-fix F2): the promotion mail names the division
 *  it seated an entry in, too. */
export async function divisionNameOf(db: AnySql, divisionId: string): Promise<string> {
  const [row] = await db<{ name: string }[]>`select name from divisions where id = ${divisionId}`;
  if (!row) throw new Error(`lifecycle mail: division ${divisionId} not found`);
  return row.name;
}

export async function divisionCtx(db: AnySql, divisionId: string): Promise<DivisionCtx> {
  const [row] = await db<DivisionCtx[]>`
    select d.id, d.competition_id, d.org_id, d.slug as div_slug,
           c.name as comp_name, c.slug as comp_slug, c.visibility as comp_visibility,
           c.starts_on, c.ends_on,
           o.slug as org_slug, o.name as org_name, o.default_locale, o.payment_instructions,
           o.stripe_charges_enabled as charges_enabled, o.currency, o.timezone as org_timezone
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

/** The `DivisionCtx` view of a division's submit context: the same columns `divisionCtx` above selects, from the
 *  read this submit already made, field for field (registration redesign B1 T5). Moved here beside `divisionCtx` from
 *  registration-submit.ts (B1 fix round 1, MOD-2); the submit's own row type is file-local there, and this folder never imports
 *  that file, so the parameter names exactly what the projection reads: every `DivisionCtx` field, the org's currency under the
 *  submit's name for it. */
export function knownCtxOf(c: Omit<DivisionCtx, "currency"> & { org_currency: string }): DivisionCtx {
  return {
    id: c.id,
    competition_id: c.competition_id,
    org_id: c.org_id,
    comp_name: c.comp_name,
    comp_slug: c.comp_slug,
    comp_visibility: c.comp_visibility,
    starts_on: c.starts_on,
    ends_on: c.ends_on,
    div_slug: c.div_slug,
    org_slug: c.org_slug,
    org_name: c.org_name,
    default_locale: c.default_locale,
    payment_instructions: c.payment_instructions,
    charges_enabled: c.charges_enabled,
    org_timezone: c.org_timezone,
    currency: c.org_currency,
  };
}


/** Origin for emails fired from request-less paths (withdraw promotions):
 *  same override order as lib/base-url, localhost as the dev fallback.
 *  Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`
 *  is request-less too. */
export function fallbackOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Exported for `registration-submit.ts` (RS002 W4) — the submit path's
 *  per-division window gate reuses this VERBATIM rather than re-deriving it. */
export function windowOpen(s: RegistrationSettingsRow, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.opens_at && now < new Date(s.opens_at)) return false;
  if (s.closes_at && now > new Date(s.closes_at)) return false;
  return true;
}

export async function regByToken(regId: string, token: string): Promise<RegistrationWithGroupRow> {
  // access_token_hash lives on the cart now (V364).
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId} and g.access_token_hash = ${hashRegistrationToken(token)}`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** What a typed reference names: the cart's reference, and the entry number quoted (null for a bare one). The checksum rejects typos
 *  before the DB sees them; dashes/case are normalised so "sz abcd efgh" read over a phone still resolves, and `SZ-ABCD-EFGH-2` as the
 *  mails print it resolves to the cart (B5 T18 review m1). A reference no entry could carry is the one 404 an unknown reference gets. */
export function typedReference(ref: string): { canonical: string; position: number | null } {
  const typed = parseTypedReference(ref);
  if (!typed) throw new HttpError(404, "registration not found");
  return { canonical: typed.refCode, position: typed.position };
}

export async function regByRef(ref: string): Promise<RegistrationWithGroupRow> {
  const { canonical, position } = typedReference(ref);
  // ref_code lives on the cart now (V364) — shared by every entry in it. A
  // cart can hold more than one entry (RS002/RS003 shipped group submit).
  // A typed number names THAT entry (tidy round, re-review m4): `-2` returns
  // the entry at cart_position 2, so /r/<ref>-2/ticket.png draws entry 2.
  // A bare reference (or a number whose entry was deleted) picks the oldest
  // deterministically, which is right for the bare callers: the ticket.png
  // render, and reconcile's status check. RS006 decided /r/[ref] itself shows
  // the WHOLE cart: see publicCartByRef, which calls this for the
  // checksum/lookup/404 behaviour and then re-selects every entry in the
  // resolved group. `nulls last`: a bare reference compares to null on every
  // row, which leaves the age order alone.
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.ref_code = ${canonical}
      and (${position}::int is null or ${position}::int <= g.cart_size)
    order by (r.cart_position = ${position}::int) desc nulls last, r.created_at, r.id limit 1`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** Resolves ONE specific cart entry for a ref, verifying in a SINGLE query
 *  that (a) `entryId` belongs to the group `ref` itself names and (b) the
 *  supplied token matches THAT group's access_token_hash — mirrors
 *  `regByToken` exactly (same SQL-side hash equality, same no-row-means-404
 *  contract), just scoped by ref_code too. `ref_code` carries a unique index
 *  (V363), so `g.ref_code = canonical` can join at most one group: an
 *  entryId from a different cart simply has no row satisfying all three
 *  predicates at once, regardless of whether the token is otherwise valid
 *  for THAT other cart. A wrong ref, a wrong token, and a foreign entryId
 *  all 404 identically (RS006 follow-up: withdraw is per-entry now — see
 *  `withdrawRegistrationByRef`). A typed number names an entry, as in
 *  `regByRef` (tidy round, re-review m4): `<ref>-2` with entry 1's id is the
 *  same 404, never a withdrawal of the entry the number did not name. The /r
 *  page posts the bare cart reference, which names any entry of the cart. */
export async function regByRefAndToken(
  ref: string,
  entryId: string,
  token: string,
): Promise<RegistrationWithGroupRow> {
  const { canonical, position } = typedReference(ref);
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.ref_code = ${canonical} and r.id = ${entryId}
      and (${position}::int is null or (${position}::int <= g.cart_size and r.cart_position = ${position}::int))
      and g.access_token_hash = ${hashRegistrationToken(token)}`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** A fixed, deterministic hash to compare against when no group matches —
 *  keeps `groupByRef`'s work (one hash + one `timingSafeEqual` call) the same
 *  whether or not `ref` exists, so a nonexistent ref and a real ref with the
 *  wrong token take the same path at the same cost. */
export const DUMMY_ACCESS_HASH = hashRegistrationToken("");

/** Constant-time token check — mirrors the repo's sole existing precedent
 *  (`api/internal/revalidate`'s `secretOk`): length-gate before
 *  `timingSafeEqual`, which THROWS on a length mismatch rather than
 *  returning false. Both inputs are always sha256 hex (64 chars), so the
 *  length gate never actually trips in practice — it exists so this can
 *  never throw regardless. */
export function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(hashRegistrationToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exported for `registration-approval.ts` (RS002 W5) — approve/reject/
 *  promote all load-and-lock a registration under `withTenant` the same way
 *  `confirmRegistration` et al. already do. */
export async function orgReg(tx: Tx, regId: string): Promise<RegistrationWithGroupRow> {
  const [reg] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId} for update`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** Exported for `registration-approval.ts` (RS002 W5) — same
 *  reload-without-lock read `confirmRegistration` et al. return after their
 *  own mutation. */
export async function orgRegAfter(tx: Tx, regId: string): Promise<RegistrationWithGroupRow> {
  const [reg] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId}`;
  return reg;
}
