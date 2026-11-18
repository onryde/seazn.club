// server/usecases/stream-codes.ts — the stable per-fixture stream code (capture QR v2 §5.1, §6.1; W1, W2), modelled on
// device-links.ts: the fixture's advisory lock, the seal BEFORE any write, re-open and verify before a re-show.
//
// R1 (§17.1): the V430 tables are FORCE RLS with no policy, so every read and write here goes through the non-tenant
// `sql` — never `withTenant` — and the org is a WHERE the code writes: `org_id` from the fixture's org on a mint, and
// read back from the code row on a resolve. The SQL over the sealed tok lives in relay/secret-columns.ts
// (enc-boundary): this module holds the tok only in memory, between a seal or open and the answer.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { requireFeature } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { resolveStreamTarget, type SavedStreamTarget, type StreamTargetSource } from "@/lib/stream-destinations";
import { effectiveStreamMode, isPickableTemplate, type StreamPrefsRead } from "@/lib/stream-settings";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CaptureRefusalError, codeEnded } from "@/server/api-v1/capture-http";
import type { PutStreamSettings, StreamCodeShown, StreamMode, StreamSettings } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { CODE_GRACE_AFTER_FINISH_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, tunable } from "@/server/relay/config";
import { composedUnavailable } from "@/server/relay/drivers";
import { hasValidKek, sealWith } from "@/server/relay/crypto";
import { ACTIVE_STATES, type SessionState } from "@/server/relay/domain/session";
import { courtCodeView } from "@/server/relay/domain/court-stream";
import { type CodeCall, codeServes, codeStatus, type CodeView, normaliseCode, type RecordTail, recordTailAnchor } from "@/server/relay/domain/stream-code";
import type { CourtLinkRef, ResolvedCourtCode } from "./court-stream-codes";
import { liveCourtLinkFor } from "./court-streams";
import { insertStreamCode, openStreamCodeTok, wipeStreamCodeTok } from "@/server/relay/secret-columns";

/** §6.1: 12 characters of lowercase Crockford base32 (60 bits). V430's `code` check admits exactly this alphabet. */
const CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CODE_LENGTH = 12;
/** A drawn code that collides with any other code is redrawn — at most this many times (§6.1, brief T5 Step 3). */
export const CODE_RETRIES = 3;
/** PR-1 carries one camera: the QR names slot 0. */
export const SLOT = 0;

/** The constant-time compare's stand-in for a code that does not exist (C1): an unknown code costs the SAME hash and the
 *  SAME `timingSafeEqual` as a wrong tok, so the two 401s cannot be told apart by timing. */
const DUMMY_TOK_HASH = createHash("sha256").update("capture-dummy-tok", "utf8").digest("hex");
function tokMatches(storedHex: string | null, tok: string): boolean {
  const given = Buffer.from(sha256Hex(tok), "hex");
  const stored = Buffer.from(storedHex ?? DUMMY_TOK_HASH, "hex");
  return timingSafeEqual(given, stored) && storedHex !== null;
}
export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export type ResolvedCode = {
  kind: "fixture";
  codeId: string;
  orgId: string;
  fixtureId: string;
  status: "active" | "finishing" | "ended";
  issuedBy: string;
};

const KEK_MISSING = "Stream codes are not configured on this server (RELAY_KEK missing or malformed)";
const FIXTURE_FINISHED = "The match is over — there is nothing left to stream";

/** Editors only, session only (§6.1 "Who") — never an API key and never a device link (the device-links idiom). The
 *  panel's phone read model (stream-phone.ts, §9 "Session login") asks the same. */
export function requireSessionEditor(auth: AuthCtx): void {
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Stream codes can only be managed with a session login");
  }
}

/** The fixture's org and competition, pooled and OUTSIDE any transaction (`requireFeature` queries the pool; the
 *  device-links `competitionForFixture` reason). Another org's fixture reads exactly like a missing one. */
export async function fixtureOf(auth: AuthCtx, fixtureId: string): Promise<{ competitionId: string; sportKey: string }> {
  const [row] = await sql<{ org_id: string; competition_id: string; sport_key: string }[]>`
    select c.org_id, c.id as competition_id, d.sport_key from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
     where f.id = ${fixtureId}`;
  if (!row || row.org_id !== auth.orgId) throw new HttpError(404, "fixture not found");
  return { competitionId: row.competition_id, sportKey: row.sport_key };
}

/** Serialise every ensure and reissue on one fixture (§6.1): without it two organisers opening the panel at once both
 *  see "no code", both mint, and the partial unique index refuses one with a 500. */
export async function lockFixtureCode(tx: Tx, fixtureId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"stream_code:" + fixtureId}))`;
}

async function finishedAtOf(tx: Tx, fixtureId: string): Promise<Date | null> {
  const [row] = await tx<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${fixtureId}`;
  if (!row) throw new HttpError(404, "fixture not found");
  return row.finished_at;
}

async function hasOpenSession(exec: Tx | typeof sql, fixtureId: string): Promise<boolean> {
  const rows = await exec`
    select 1 from fixture_stream_sessions where fixture_id = ${fixtureId} and state in ${sql([...ACTIVE_STATES])} limit 1`;
  return rows.length > 0;
}

const graceMinutes = (): number => tunable("CODE_GRACE_AFTER_FINISH_MINUTES", CODE_GRACE_AFTER_FINISH_MINUTES);

/** A fresh tok and its envelope — sealed FIRST, before the caller writes anything (§6.1: a missing KEK writes nothing). */
export function freshTok(): { tok: string; tokEnc: Buffer } {
  if (!hasValidKek("RELAY_KEK")) throw new HttpError(503, KEK_MISSING, "RELAY_KEK_MISSING");
  const tok = randomBytes(16).toString("base64url");
  return { tok, tokEnc: sealWith("RELAY_KEK", tok) };
}

export const drawCode = (): string => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export function isCodeCollision(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === "23505" && e.constraint_name === "fixture_stream_codes_code_key";
}

/** Bump the serve counters (§6.1 "each serve bumps shown_count and coalesces first_shown_at") and answer the QR. */
async function show(tx: Tx, row: { id: string; code: string; createdAt: Date }, tok: string): Promise<StreamCodeShown> {
  await tx`
    update fixture_stream_codes set shown_count = shown_count + 1, first_shown_at = coalesce(first_shown_at, now())
     where id = ${row.id}`;
  return { qr: { v: 2, code: row.code, slot: SLOT, tok }, issuedAt: row.createdAt.toISOString() };
}

/** Insert the sealed code, redrawing on a code collision. Each attempt runs in a savepoint, so a 23505 does not abort
 *  the caller's transaction. Any other refusal — including the one-active index — is the caller's. */
async function mintLocked(tx: Tx, auth: AuthCtx, fixtureId: string, fresh: { tok: string; tokEnc: Buffer }): Promise<StreamCodeShown> {
  for (let attempt = 0; ; attempt++) {
    const code = drawCode();
    try {
      const { id, createdAt } = await tx.savepoint((sp) => insertStreamCode(sp, {
        orgId: auth.orgId, fixtureId, code, tokHash: sha256Hex(fresh.tok), tokEnc: fresh.tokEnc, issuedBy: auth.userId!,
      }));
      return show(tx, { id, code, createdAt }, fresh.tok);
    } catch (err) {
      if (isCodeCollision(err) && attempt < CODE_RETRIES) continue;
      throw err;
    }
  }
}

type ActiveCode = { id: string; code: string; tok_hash: string; created_at: Date };
export async function activeCodeOf(tx: Tx, fixtureId: string): Promise<ActiveCode | null> {
  const [row] = await tx<ActiveCode[]>`
    select id, code, tok_hash, created_at from fixture_stream_codes where fixture_id = ${fixtureId} and ended_at is null`;
  return row ?? null;
}

/**
 * Court stream, Web G (controller's rulings on the owner's "Ok", 2026-11-18): the one SQL answer to "does this match's own
 * code compete with its court's phone?". The guard exists so two phones never stream one match. An ACTIVE code
 * (`ended_at is null`) competes UNLESS it has been used and is now idle — free to retire only when ALL hold:
 *  - it has had a session: at least one session started on THIS code (`code_id`), so a session of a code it replaced does
 *    not count (an unscanned code, perhaps already printed, is never withdrawn silently: second ruling);
 *  - no session of the match is open (`ACTIVE_STATES`: requested, provisioning, warming, live, and `ending`, whose stop is
 *    still in flight);
 *  - no phone holds it: no current pairing (`ended_at is null`) PRESENT in §6.9's sense — last beat newer than
 *    max(PHONE_SILENT_FLOOR_SECONDS, answered_poll_seconds + PHONE_SILENT_SLACK_SECONDS), the window `isPresent`
 *    (relay/domain/pairing.ts) judges Go live by. A pairing that went silent is a phone that has left.
 * A code that is not competing lets the switch turn on and retire it (`setCourtStream`). `fixtureRef` is the match's id as
 * SQL — a bound value, or a column of the caller's query (`courtStreamsForDay`). Built on the caller's executor, so a
 * transaction reads its own rows.
 */
export function ownCodeCompetes(q: Tx | typeof sql, fixtureRef: ReturnType<typeof sql>, now: Date): ReturnType<typeof sql> {
  const floor = tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS);
  return q`exists (
    select 1 from fixture_stream_codes k
     where k.fixture_id = ${fixtureRef} and k.ended_at is null
       and (not exists (select 1 from fixture_stream_sessions s where s.code_id = k.id)
            or exists (select 1 from fixture_stream_sessions s where s.fixture_id = k.fixture_id and s.state in ${q([...ACTIVE_STATES])})
            or exists (select 1 from fixture_stream_pairings p
                        where p.code_id = k.id and p.ended_at is null
                          and p.last_beat_at > ${now}::timestamptz
                              - make_interval(secs => greatest(${floor}::int, p.answered_poll_seconds + ${PHONE_SILENT_SLACK_SECONDS}::int)))))`;
}

/** Court stream (spec §5.2): a match whose Stream switch is on AND whose court has a live link is streamed by that court's
 *  phone, so it mints no code of its own. Runs inside the fixture's code lock, the same lock `setCourtStream` takes. A switch
 *  left on after its link ended or was withdrawn does not stop a mint: no court is streaming it. */
async function refuseIfCourtStreamed(tx: Tx, orgId: string, fixtureId: string): Promise<void> {
  const [row] = await tx<{ court_id: string | null; court_stream: boolean | null }[]>`
    select f.court_id, s.court_stream from fixtures f
      left join fixture_stream_settings s on s.fixture_id = f.id
     where f.id = ${fixtureId}`;
  if (!row?.court_stream) return;
  if (await liveCourtLinkFor(tx, { orgId, courtId: row.court_id, now: new Date() })) {
    throw new HttpError(409, "This match is streamed by its court's phone; switch the court Stream off to give it its own code", "court_streamed");
  }
}

/**
 * The fixture's stream code, re-shown when it exists (§6.1 Ensure). Opening the panel never kills a QR a phone holds.
 *  - ACTIVE or ACTIVE·FINISHING (C4: inside the grace) → re-opened, re-verified against its hash, re-shown.
 *  - An envelope that opens to another tok, or not at all → never re-shown: ended as reissued and replaced (M2), logged.
 *  - Found expired (C2: past the grace, no open session) → the expiry is WRITTEN and committed, then C4 refuses the mint.
 *  - None → minted, unless the fixture is finished (C4: 422 fixture_finished).
 */
export async function ensureStreamCode(auth: AuthCtx, fixtureId: string): Promise<StreamCodeShown> {
  requireSessionEditor(auth);
  const { competitionId } = await fixtureOf(auth, fixtureId);
  await requireFeature(auth.orgId, "streaming.relay", competitionId);
  const outcome = await sql.begin(async (tx): Promise<StreamCodeShown | "finished"> => {
    await lockFixtureCode(tx, fixtureId);
    const finishedAt = await finishedAtOf(tx, fixtureId);
    await refuseIfCourtStreamed(tx, auth.orgId, fixtureId);
    const current = await activeCodeOf(tx, fixtureId);
    if (current) {
      const status = codeStatus({ endedAt: null, finishedAt }, new Date(), await hasOpenSession(tx, fixtureId), graceMinutes());
      if (status === "expiry_due") {
        await wipeStreamCodeTok(tx, current.id, "expired", null);
        return "finished";   // C2 committed, then C4 — the expired code stays ended (C5)
      }
      if (!hasValidKek("RELAY_KEK")) throw new HttpError(503, KEK_MISSING, "RELAY_KEK_MISSING");
      const tok = await openStreamCodeTok(tx, current.id);
      if (tok !== null && sha256Hex(tok) === current.tok_hash) {
        return show(tx, { id: current.id, code: current.code, createdAt: current.created_at }, tok);
      }
      log.warn({ codeId: current.id, fixtureId }, "stream code: the sealed tok is not this row's; ending it and reissuing");
      if (finishedAt !== null) return "finished";
      const fresh = freshTok();
      await wipeStreamCodeTok(tx, current.id, "reissued", auth.userId);
      return mintLocked(tx, auth, fixtureId, fresh);
    }
    if (finishedAt !== null) return "finished";
    const fresh = freshTok();
    return mintLocked(tx, auth, fixtureId, fresh);
  });
  if (outcome === "finished") throw new HttpError(422, FIXTURE_FINISHED, "fixture_finished");
  return outcome;
}

/**
 * Revoke & reissue (§6.1, C3): the ACTIVE code ends at once — ENDED(reissued), its sealed tok wiped, `ended_by` the
 * organiser — and a fresh one is minted and shown. The old code keeps serving its open session's phone a get and a beat
 * until that session ends (C1b); it serves no new claim and no start. The new tok is sealed BEFORE the old code is
 * ended, so a missing KEK leaves the old code exactly as it was.
 */
export async function reissueStreamCode(auth: AuthCtx, fixtureId: string): Promise<StreamCodeShown> {
  requireSessionEditor(auth);
  const { competitionId } = await fixtureOf(auth, fixtureId);
  await requireFeature(auth.orgId, "streaming.relay", competitionId);
  return sql.begin(async (tx) => {
    await lockFixtureCode(tx, fixtureId);
    if ((await finishedAtOf(tx, fixtureId)) !== null) throw new HttpError(422, FIXTURE_FINISHED, "fixture_finished");
    await refuseIfCourtStreamed(tx, auth.orgId, fixtureId);
    const fresh = freshTok();
    const current = await activeCodeOf(tx, fixtureId);
    if (current) await wipeStreamCodeTok(tx, current.id, "reissued", auth.userId);
    return mintLocked(tx, auth, fixtureId, fresh);
  });
}

/** The code row C1 judges, whichever its owner: a fixture (`fixture_id`) or a court link (`court_link_id`, V525). */
type CodeRow = {
  id: string; org_id: string; tok_hash: string; issued_by: string; ended_at: Date | null;
  end_cause: "reissued" | "expired" | "withdrawn" | null;
};
type FixtureCodeRow = CodeRow & { fixture_id: string; finished_at: Date | null };
/** What C1 reads off the code's owner: its CodeView (C2's clock), the grace C2 adds, the finish the record tail anchors an
 *  expiry on, and which sessions are the code's (the open one for C1b, all of them for C1(c)'s tail). */
type CodeOwner = {
  view: CodeView;
  graceMinutes: number;
  tailFinishedAt: Date | null;
  /** A fresh fragment each call: the owner's sessions, over `fixture_stream_sessions s`. */
  sessions: () => ReturnType<typeof sql>;
  /** Web batch A3 (2026-11-17), a court's code only: once its open session is `ending` — the stop decided, the phone told
   *  `over` — an ENDED code no longer serves that session's phone (C1b), so the phone's next get or beat is `401 code_ended`
   *  and it forgets the code. Without it, a withdrawn court whose last session lingered in `ending` (a composed session's
   *  runner teardown) kept answering its phone `waiting`, and the phone never forgot. */
  releasesOnEnding?: true;
};

/** Fix round 1 (finding 1): the session a beat names as running (`sid`; CI on #1242: never `stopped`), so a released court session's phone still hears its
 *  `over` (C1b) before it is refused. Only a uuid is ever read. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * C1 / C1b / C2 / C1(c) for a code whose tok VERIFIED, the same rules for both owners. Answers the status it serves at, or
 * throws `401 code_ended`. C2's expiry is written here (lazily, committed); a refused call from a pairing ends that pairing.
 */
async function serveCode(
  row: CodeRow, owner: CodeOwner, call: CodeCall, phone: string | null, now: Date, namedSid: string | null = null,
): Promise<"active" | "finishing" | "ended"> {
  const [open] = await sql<{ created_at: Date; phone: string | null; state: SessionState }[]>`
    select s.created_at, p.phone, s.state from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id
     where ${owner.sessions()} and s.state in ${sql([...ACTIVE_STATES])}
     order by s.created_at desc limit 1`;
  let endedAt = row.ended_at;
  let endCause = row.end_cause;
  let status = codeStatus(owner.view, now, open !== undefined, owner.graceMinutes);
  if (status === "expiry_due") {
    await sql.begin((tx) => wipeStreamCodeTok(tx, row.id, "expired", null));
    endedAt = now;
    endCause = "expired";
    status = "ended";
  }
  // A3: the court's released session holds nothing for a get or a beat (a record keeps C1(b) and its tail).
  const held = open !== undefined && !(owner.releasesOnEnding === true && open.state === "ending" && call !== "record") ? open : undefined;
  const callerIsOpenSessionPhone = held !== undefined && phone !== null && held.phone === phone;
  const sessionCreatedBeforeEnd = held !== undefined && endedAt !== null && held.created_at.getTime() < endedAt.getTime();
  // Spec 2026-10-12 §4 C1(c): a record call to an ENDED code with no open pre-end session is judged on the 24 h tail,
  // anchored on the later of the code's own end and the end of the owner's last session open when it ended.
  let tail: RecordTail | undefined;
  if (call === "record") {
    let anchor: Date | null = null;
    if (status === "ended" && !sessionCreatedBeforeEnd) {
      // Every session of the owner: recordTailAnchor alone decides which were open when the code ended (review fix 4 —
      // for an expiry that is finished_at + the grace, not the lazy ended_at a SQL filter here would have used).
      const sessions = await sql<{ created_at: Date; ended_at: Date | null }[]>`
        select s.created_at, s.ended_at from fixture_stream_sessions s where ${owner.sessions()}`;
      anchor = recordTailAnchor({
        endCause, endedAt, finishedAt: owner.tailFinishedAt, graceMinutes: owner.graceMinutes,
        sessions: sessions.map((s) => ({ createdAt: s.created_at, endedAt: s.ended_at })),
      });
    }
    tail = { now, anchor };
  }
  const serves = codeServes({ status, callerIsOpenSessionPhone, sessionCreatedBeforeEnd, call, tail })
    || (status === "ended" && call === "beat" && endedAt !== null && await namesItsEndedSession(owner, namedSid, phone, endedAt));
  if (!serves) {
    // §5.2: "ENDED(code_ended) is written lazily when a call from the pairing is refused 401" (B6 review M-6). Only a
    // call whose tok VERIFIED speaks for a pairing, and only one C1 refuses: the C1b phone (its open session created
    // before the code ended) is served by C1 — C3 merely narrows its calls — so its refused claim or start ends nothing.
    if (status === "ended" && phone !== null && !(callerIsOpenSessionPhone && sessionCreatedBeforeEnd)) {
      await sql`
        update fixture_stream_pairings set ended_at = ${now}, end_cause = 'code_ended'
         where code_id = ${row.id} and phone = ${phone} and ended_at is null`;
    }
    throw codeEnded();
  }
  return status as "active" | "finishing" | "ended";
}

/**
 * Fix round 1 (finding 1), for a court's code; fix round 2 (item 3) for a fixture's code too: a BEAT that names a session of the owner which its caller's pairing
 * held, created before the code ended, and stopping (`ending`) or stopped at or after that end, is served as C1b serves it,
 * so it hears `over` for that session. The phone then stops naming it, and its next beat (naming nothing it holds) is
 * `401 code_ended`. Without this, a stop that landed outside a beat (the desk's Stop, the Stream switch off, the tail) answered
 * the beat that names it with 401: the phone treats a 401 while a session runs as "the code ends after this session" and
 * keeps publishing, and every later beat is 401 too. A fixture's code meets the same case after a reissue: its session is
 * stopped outside a beat (the desk's Stop), so no session is open and C1b serves nothing; the beat naming it hears `over`.
 */
async function namesItsEndedSession(owner: CodeOwner, namedSid: string | null, phone: string | null, endedAt: Date): Promise<boolean> {
  if (namedSid === null || phone === null || !UUID_RE.test(namedSid)) return false;
  const [named] = await sql<{ created_at: Date; state: SessionState; ended_at: Date | null; phone: string | null }[]>`
    select s.created_at, s.state, s.ended_at, p.phone from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id
     where ${owner.sessions()} and s.id = ${namedSid}`;
  if (!named || named.phone !== phone || named.created_at.getTime() >= endedAt.getTime()) return false;
  return named.state === "ending" || (named.ended_at !== null && named.ended_at.getTime() >= endedAt.getTime());
}

/** A fixture's code: its own sessions, the fixture's finish and the grace after it (C2). */
async function serveFixtureCode(
  row: FixtureCodeRow, call: CodeCall, phone: string | null, now: Date, namedSid: string | null = null,
): Promise<ResolvedCode> {
  const status = await serveCode(row, {
    view: { endedAt: row.ended_at, finishedAt: row.finished_at },
    graceMinutes: graceMinutes(),
    tailFinishedAt: row.finished_at,
    sessions: () => sql`s.fixture_id = ${row.fixture_id}`,
  }, call, phone, now, namedSid);
  return { kind: "fixture", codeId: row.id, orgId: row.org_id, fixtureId: row.fixture_id, status, issuedBy: row.issued_by };
}

/** A court's code (court stream §5.4): the link's sessions, whichever match each streamed; the day's end is the finish, with
 *  no grace (`courtCodeView`). A withdrawal is an end like a reissue: C1b serves the open court session's phone a get and a
 *  beat, and the record tail anchors on the withdrawal. */
async function serveCourtCode(
  row: CodeRow, link: CourtLinkRef, call: CodeCall, phone: string | null, now: Date, namedSid: string | null,
): Promise<ResolvedCourtCode> {
  const status = await serveCode(row, {
    view: courtCodeView({ endedAt: row.ended_at, expiresAt: link.expiresAt }, now),
    graceMinutes: 0,
    tailFinishedAt: link.expiresAt,
    sessions: () => sql`s.court_link_id = ${link.id}`,
    releasesOnEnding: true,
  }, call, phone, now, namedSid);
  return { kind: "court", codeId: row.id, orgId: row.org_id, status, issuedBy: row.issued_by, link };
}

/**
 * Resolve a phone's code and tok for one call (C1). The phone-facing routes (T8a–T8c) call this first.
 *  - A malformed code is `404 not_a_stream_code` before any query (`normaliseCode` first: trim + lower-case).
 *  - An unknown code and a wrong tok are both `401 code_ended`, each through ONE constant-time compare.
 *  - C2: a code found past its grace with no open session is ended HERE (written lazily, committed), then refused.
 *  - C1b: an ENDED code answers only the fixture's open session's phone, for a session created before the end, and
 *    only a `get` or a `beat`.
 *  - `record` (spec 2026-10-12 §4, P11/Q1): C1b without the phone condition (R4), then C1(c)'s 24 h tail. The records
 *    route passes `phone = null`, so the lazy `code_ended` pairing write below never fires for a record.
 * A FIXTURE's code only: the inner join finds no fixture for a court's code (V525), which answers 401 like an unknown one.
 * `resolveAnyStreamCode` reads both.
 */
export async function resolveStreamCode(
  rawCode: string, tok: string, call: CodeCall, phone: string | null, now: Date,
): Promise<ResolvedCode> {
  const code = normaliseCode(rawCode);
  if (code === null) throw new CaptureRefusalError(404, "not_a_stream_code", "not a stream code");
  const [row] = await sql<FixtureCodeRow[]>`
    select c.id, c.org_id, c.fixture_id, c.tok_hash, c.issued_by, c.ended_at, c.end_cause, f.finished_at
      from fixture_stream_codes c join fixtures f on f.id = c.fixture_id
     where c.code = ${code}`;
  if (!tokMatches(row?.tok_hash ?? null, tok) || !row) throw codeEnded();
  return serveFixtureCode(row, call, phone, now);
}

type AnyCodeRow = CodeRow & {
  fixture_id: string | null; finished_at: Date | null; court_link_id: string | null;
  competition_id: string | null; court_id: string | null; court_name: string | null; opens_at: Date | null;
  expires_at: Date | null; target_id: string | null; withdrawn_at: Date | null;
};

/**
 * `resolveStreamCode` for a code of EITHER owner (court stream §5.4): ONE row read for both, the same constant-time tok
 * compare, the same C1 / C1b / C2 / C1(c) rules. A fixture's code answers exactly what `resolveStreamCode` answers, with
 * `kind: "fixture"`; a court's code answers `kind: "court"` with its link.
 */
export async function resolveAnyStreamCode(
  rawCode: string, tok: string, call: CodeCall, phone: string | null, now: Date, namedSid: string | null = null,
): Promise<ResolvedCode | ResolvedCourtCode> {
  const code = normaliseCode(rawCode);
  if (code === null) throw new CaptureRefusalError(404, "not_a_stream_code", "not a stream code");
  const [row] = await sql<AnyCodeRow[]>`
    select c.id, c.org_id, c.fixture_id, c.court_link_id, c.tok_hash, c.issued_by, c.ended_at, c.end_cause, f.finished_at,
           l.competition_id, l.court_id, k.name as court_name, l.opens_at, l.expires_at, l.target_id, l.withdrawn_at
      from fixture_stream_codes c
      left join fixtures f on f.id = c.fixture_id
      left join court_stream_links l on l.id = c.court_link_id
      left join courts k on k.id = l.court_id
     where c.code = ${code}`;
  if (!tokMatches(row?.tok_hash ?? null, tok) || !row) throw codeEnded();
  if (row.fixture_id !== null) return serveFixtureCode({ ...row, fixture_id: row.fixture_id }, call, phone, now, namedSid);
  // fixture_stream_codes_one_owner (V525): no fixture means a court link, and the link's court is the org's (its FK).
  if (row.court_link_id === null || row.court_id === null || row.court_name === null || row.competition_id === null
      || row.opens_at === null || row.expires_at === null || row.target_id === null) {
    throw new Error(`stream code ${row.id} has neither a fixture nor a court link`);
  }
  const link: CourtLinkRef = {
    id: row.court_link_id, competitionId: row.competition_id, courtId: row.court_id, courtName: row.court_name,
    opensAt: row.opens_at, expiresAt: row.expires_at, targetId: row.target_id, withdrawnAt: row.withdrawn_at,
  };
  return serveCourtCode(row, link, call, phone, now, namedSid);
}

// One sentence for every refusal of a code (C1): `codeEnded` lives in capture-http.ts, shared with the route's Bearer
// read (A17), so the wire never tells expired, revoked, unknown, wrong-tok and no-Bearer apart.

/**
 * The fixture's stream settings (§6.7.3 and §8.1): the destination pre-pick and the automatic-streaming switch, either or
 * both in ONE transaction, each written only when the body names it. `targetId: null` clears the pick. Another org's target,
 * an archived one and an unknown id are all 404 — the same sentence, no oracle — and a refused pick writes nothing. The pick
 * is written first, so the other direction is the one the transaction exists for: a failing switch write rolls the pick back.
 * The organiser's Go live writes the pick through `writeStreamSettings` too. The answer's `targetId` is the SAVED choice
 * (`target_chosen ? target_id : null`): a row the switch made alone has chosen nothing, even though the fixture still streams
 * to the org's default destination.
 */
export async function saveStreamSettings(auth: AuthCtx, fixtureId: string, body: PutStreamSettings): Promise<StreamSettings> {
  requireSessionEditor(auth);
  const { sportKey } = await fixtureOf(auth, fixtureId);
  const a = { orgId: auth.orgId, fixtureId, updatedBy: auth.userId };
  return sql.begin(async (tx) => {
    if (body.targetId !== undefined) await writeStreamSettings(tx, { ...a, targetId: body.targetId });
    if (body.autoStream !== undefined) await writeAutoStream(tx, { ...a, autoStream: body.autoStream });
    // R2006: each preference has its own writer, as each field above does. A refused template throws inside this
    // transaction, so a body that also named other fields writes none of them.
    if (body.streamMode !== undefined) await writeStreamMode(tx, { ...a, streamMode: body.streamMode });
    if (body.overlayTemplate !== undefined) await writeOverlayTemplate(tx, { ...a, sportKey, overlayTemplate: body.overlayTemplate });
    if (body.overlayDelayMs !== undefined) await writeOverlayDelay(tx, { ...a, overlayDelayMs: body.overlayDelayMs });
    const [row] = await tx<{
      target_id: string | null; target_chosen: boolean; auto_stream: boolean;
      stream_mode: StreamMode | null; overlay_template: string | null; overlay_delay_ms: number | null; revision: number;
    }[]>`
      select target_id, target_chosen, auto_stream, stream_mode, overlay_template, overlay_delay_ms, revision::float8 as revision
        from fixture_stream_settings where fixture_id = ${fixtureId}`;
    // No row only for a body that named nothing (the route's schema refuses that): the defaults, with nothing written.
    if (row === undefined) return { targetId: null, autoStream: false, streamMode: null, overlayTemplate: null, overlayDelayMs: null, revision: null };
    return {
      targetId: row.target_chosen ? row.target_id : null,
      autoStream: row.auto_stream,
      streamMode: row.stream_mode,
      overlayTemplate: row.overlay_template,
      overlayDelayMs: row.overlay_delay_ms,
      revision: row.revision,
    };
  });
}

/**
 * THE fixture's stream destination, read once (§6.7.3; B8 review I-1, controller ruling: ONE default-target resolver, no
 * write on view) — beside its one writer. The phone's start opens on it, the phone's descriptor names it, and the
 * panel's read model serves it, so the organiser's picker shows exactly what the phone would stream to (§17.13). ONE
 * statement reads both halves — the saved row and the org's live destinations `order by created_at, id`
 * (`listStreamTargets`'s order) — and `resolveStreamTarget` answers. A saved target archived, or not this org's, is simply
 * not in that list: the list is the one guard (B8 re-review n-1 removed a join that duplicated it). It writes nothing. The caller has already proved the fixture is `orgId`'s.
 * "A saved row" means a row that CHOSE (`target_chosen`, plan R-1): a settings row made by the auto switch or the A12 Stop
 * stamp has chosen nothing and reads as no row, so the fixture keeps the org's default destination.
 */
export async function fixtureStreamTarget(
  exec: Tx | typeof sql, a: { orgId: string; fixtureId: string },
): Promise<{ id: string; label: string; source: StreamTargetSource } | null> {
  const [r] = await exec<{ has_row: boolean; saved_id: string | null; live: { id: string; label: string }[] }[]>`
    select coalesce(st.target_chosen, false) as has_row, st.target_id as saved_id,
           coalesce((select json_agg(json_build_object('id', o.id, 'label', o.label) order by o.created_at, o.id)
                       from org_stream_targets o
                      where o.org_id = ${a.orgId} and o.archived_at is null), '[]'::json) as live
      from (select 1) as one
      left join fixture_stream_settings st on st.fixture_id = ${a.fixtureId}`;
  const saved: SavedStreamTarget = r!.has_row ? { row: true, targetId: r!.saved_id } : { row: false };
  const pick = resolveStreamTarget(saved, r!.live);
  return pick === null ? null : { id: pick.id, label: pick.label, source: pick.source };
}

/** The one writer of `fixture_stream_settings.target_id`. The caller has already proved the fixture is `orgId`'s. It also
 *  records that the organiser CHOSE (`target_chosen`, V431, plan R-1): a null `targetId` here is "cleared", whereas a
 *  settings row made for any other reason (the auto switch, the A12 Stop stamp) leaves the flag false and the fixture on
 *  the org's default destination. */
export async function writeStreamSettings(
  tx: Tx, a: { orgId: string; fixtureId: string; targetId: string | null; updatedBy: string | null },
): Promise<{ targetId: string | null }> {
  if (a.targetId !== null) {
    const live = await tx`
      select 1 from org_stream_targets where id = ${a.targetId} and org_id = ${a.orgId} and archived_at is null`;
    if (live.length === 0) throw new HttpError(404, "stream target not found");
  }
  await tx`
    insert into fixture_stream_settings (fixture_id, org_id, target_id, target_chosen, updated_by, updated_at, revision)
    values (${a.fixtureId}, ${a.orgId}, ${a.targetId}, true, ${a.updatedBy}, now(), 1)
    on conflict (fixture_id) do update
       set target_id = excluded.target_id, target_chosen = true, updated_by = excluded.updated_by, updated_at = now(),
           revision = fixture_stream_settings.revision + 1`;
  return { targetId: a.targetId };
}

/** The one writer of `fixture_stream_settings.auto_stream` (W7, A4). An upsert that sets ONLY the switch, `updated_by` and
 *  `updated_at`, and bumps `revision` (V466: every writer here does, under the row lock; an insert writes 1) — never
 *  `target_id` or `target_chosen`: a row it creates has chosen nothing, so the fixture keeps resolving the org's default
 *  destination (plan R-1), and a pick made earlier survives the toggle. Turning the switch OFF also clears
 *  `auto_start_refusal` (the refusal belonged to the attempt that is now off); `auto_started_at` and `auto_start_blocked_at`
 *  are never cleared by a toggle — an organiser Stop still blocks auto start for the match (A12). The caller has already
 *  proved the fixture is `orgId`'s. */
export async function writeAutoStream(
  tx: Tx, a: { orgId: string; fixtureId: string; autoStream: boolean; updatedBy: string | null },
): Promise<void> {
  await tx`
    insert into fixture_stream_settings (fixture_id, org_id, auto_stream, updated_by, updated_at, revision)
    values (${a.fixtureId}, ${a.orgId}, ${a.autoStream}, ${a.updatedBy}, now(), 1)
    on conflict (fixture_id) do update
       set auto_stream = excluded.auto_stream, updated_by = excluded.updated_by, updated_at = now(),
           revision = fixture_stream_settings.revision + 1,
           auto_start_refusal = case when excluded.auto_stream then fixture_stream_settings.auto_start_refusal else null end`;
}

/** R2006 (V466): the one writer of `fixture_stream_settings.stream_mode` — the organiser's "Camera only" (`passthrough`),
 *  "Add the score back" (`composed`) or the default (`null`). Modelled on `writeAutoStream`: an upsert that sets only the
 *  mode, `updated_by` and `updated_at`, and bumps `revision`, never `target_id`/`target_chosen` (plan R-1). The caller has
 *  already proved the fixture is `orgId`'s. */
export async function writeStreamMode(
  tx: Tx, a: { orgId: string; fixtureId: string; streamMode: StreamMode | null; updatedBy: string | null },
): Promise<void> {
  await tx`
    insert into fixture_stream_settings (fixture_id, org_id, stream_mode, updated_by, updated_at, revision)
    values (${a.fixtureId}, ${a.orgId}, ${a.streamMode}, ${a.updatedBy}, now(), 1)
    on conflict (fixture_id) do update
       set stream_mode = excluded.stream_mode, updated_by = excluded.updated_by, updated_at = now(),
           revision = fixture_stream_settings.revision + 1`;
}

/** R2006 (V462's `overlay_template`, R2004's reader): the one writer of the organiser's score style. An id this fixture's
 *  sport is not offered NOW (unknown, retired or sport-unsuitable — lib/stream-settings.ts `isPickableTemplate`) is
 *  refused 400 before the write; `null` resets to the sport's default. The same upsert shape as `writeStreamMode`. */
export async function writeOverlayTemplate(
  tx: Tx, a: { orgId: string; fixtureId: string; sportKey: string; overlayTemplate: string | null; updatedBy: string | null },
): Promise<void> {
  if (a.overlayTemplate !== null && !isPickableTemplate(a.overlayTemplate, a.sportKey)) {
    throw new HttpError(400, "overlay template not available for this fixture");
  }
  await tx`
    insert into fixture_stream_settings (fixture_id, org_id, overlay_template, updated_by, updated_at, revision)
    values (${a.fixtureId}, ${a.orgId}, ${a.overlayTemplate}, ${a.updatedBy}, now(), 1)
    on conflict (fixture_id) do update
       set overlay_template = excluded.overlay_template, updated_by = excluded.updated_by, updated_at = now(),
           revision = fixture_stream_settings.revision + 1`;
}

/** R2006 (V462's `overlay_delay_ms`): the one writer of the organiser's Score timing. `null` resets to the server's
 *  default (config.ts `RELAY_OVERLAY_DELAY_DEFAULT_MS`); `0` is a real override and is stored as 0. The bound is the
 *  schema's and the column's. A composed create copies the effective value into its session, so a session already running
 *  never moves. The same upsert shape as `writeStreamMode`. */
export async function writeOverlayDelay(
  tx: Tx, a: { orgId: string; fixtureId: string; overlayDelayMs: number | null; updatedBy: string | null },
): Promise<void> {
  await tx`
    insert into fixture_stream_settings (fixture_id, org_id, overlay_delay_ms, updated_by, updated_at, revision)
    values (${a.fixtureId}, ${a.orgId}, ${a.overlayDelayMs}, ${a.updatedBy}, now(), 1)
    on conflict (fixture_id) do update
       set overlay_delay_ms = excluded.overlay_delay_ms, updated_by = excluded.updated_by, updated_at = now(),
           revision = fixture_stream_settings.revision + 1`;
}

/** R2006 (V466): the mode a start that names none streams with — the phone operator's own start and the automatic start.
 *  The fixture's stored choice (`stream_mode`, null with no row) through `effectiveStreamMode`, against this deployment's
 *  `composedUnavailable()` — the ONE availability authority `startBroadcast` refuses on — so a stored `composed` on a
 *  deployment that cannot run one streams the camera rather than refusing. The organiser's Go live states its mode
 *  itself: its panel opens on the same stored choice and shows what it will send. */
export async function startModeFor(exec: Tx | typeof sql, fixtureId: string): Promise<StreamMode> {
  const [row] = await exec<{ stream_mode: StreamMode | null }[]>`
    select stream_mode from fixture_stream_settings where fixture_id = ${fixtureId}`;
  return effectiveStreamMode(row?.stream_mode ?? null, !composedUnavailable());
}

/** R2006: the stored score preferences of each listed fixture, for the panel's page context — ONE read for the page.
 *  A fixture with no row (or another org's) is left out, and the panel reads it as "all defaults". Each carries the
 *  row's `revision` (lib/stream-settings.ts `StreamPrefsRead`), the same number a PUT answer carries. */
export async function streamPrefsOf(orgId: string, fixtureIds: readonly string[]): Promise<Record<string, StreamPrefsRead>> {
  if (fixtureIds.length === 0) return {};
  const rows = await sql<{ fixture_id: string; stream_mode: StreamMode | null; overlay_template: string | null; overlay_delay_ms: number | null; revision: number }[]>`
    select fixture_id, stream_mode, overlay_template, overlay_delay_ms, revision::float8 as revision from fixture_stream_settings
     where org_id = ${orgId} and fixture_id in ${sql([...fixtureIds])}`;
  return Object.fromEntries(
    rows.map((r) => [r.fixture_id, { streamMode: r.stream_mode, overlayTemplate: r.overlay_template, overlayDelayMs: r.overlay_delay_ms, revision: r.revision }]),
  );
}

/** A12: an organiser Stop turns auto START off for the match. Stamps `auto_start_blocked_at` once — the FIRST stamp wins and a
 *  later one is a true no-op (the update is skipped, so `updated_by`/`updated_at` and `revision` stay the first Stop's
 *  too) — in the same kind of upsert as `writeAutoStream`: it creates a row that chose nothing when the switch was never touched, and never writes
 *  `target_id`/`target_chosen` (plan R-1, FP1). The caller has already proved the fixture is `orgId`'s. `exec` is the pool by
 *  default; pass the transaction (as `fixtureStreamTarget` accepts one) to stamp inside a caller's own, so the stamp commits or
 *  rolls back with it. */
export async function markAutoStartBlocked(
  orgId: string, fixtureId: string, at: Date, updatedBy: string | null, exec: Tx | typeof sql = sql,
): Promise<void> {
  await exec`
    insert into fixture_stream_settings (fixture_id, org_id, auto_start_blocked_at, updated_by, updated_at, revision)
    values (${fixtureId}, ${orgId}, ${at}, ${updatedBy}, now(), 1)
    on conflict (fixture_id) do update
       set auto_start_blocked_at = excluded.auto_start_blocked_at, updated_by = excluded.updated_by, updated_at = now(),
           revision = fixture_stream_settings.revision + 1
     where fixture_stream_settings.auto_start_blocked_at is null`;
}
