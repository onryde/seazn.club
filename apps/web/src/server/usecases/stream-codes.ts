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
import type { AuthCtx } from "@/server/api-v1/auth";
import { CaptureRefusalError, codeEnded } from "@/server/api-v1/capture-http";
import type { PutStreamSettings, StreamCodeShown, StreamSettings } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { CODE_GRACE_AFTER_FINISH_MINUTES, tunable } from "@/server/relay/config";
import { hasValidKek, sealWith } from "@/server/relay/crypto";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { type CodeCall, codeServes, codeStatus, normaliseCode } from "@/server/relay/domain/stream-code";
import { insertStreamCode, openStreamCodeTok, wipeStreamCodeTok } from "@/server/relay/secret-columns";

/** §6.1: 12 characters of lowercase Crockford base32 (60 bits). V430's `code` check admits exactly this alphabet. */
const CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CODE_LENGTH = 12;
/** A drawn code that collides with any other code is redrawn — at most this many times (§6.1, brief T5 Step 3). */
const CODE_RETRIES = 3;
/** PR-1 carries one camera: the QR names slot 0. */
const SLOT = 0;

/** The constant-time compare's stand-in for a code that does not exist (C1): an unknown code costs the SAME hash and the
 *  SAME `timingSafeEqual` as a wrong tok, so the two 401s cannot be told apart by timing. */
const DUMMY_TOK_HASH = createHash("sha256").update("capture-dummy-tok", "utf8").digest("hex");
function tokMatches(storedHex: string | null, tok: string): boolean {
  const given = Buffer.from(sha256Hex(tok), "hex");
  const stored = Buffer.from(storedHex ?? DUMMY_TOK_HASH, "hex");
  return timingSafeEqual(given, stored) && storedHex !== null;
}
const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export type ResolvedCode = {
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
async function fixtureOf(auth: AuthCtx, fixtureId: string): Promise<{ competitionId: string }> {
  const [row] = await sql<{ org_id: string; competition_id: string }[]>`
    select c.org_id, c.id as competition_id from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
     where f.id = ${fixtureId}`;
  if (!row || row.org_id !== auth.orgId) throw new HttpError(404, "fixture not found");
  return { competitionId: row.competition_id };
}

/** Serialise every ensure and reissue on one fixture (§6.1): without it two organisers opening the panel at once both
 *  see "no code", both mint, and the partial unique index refuses one with a 500. */
async function lockFixtureCode(tx: Tx, fixtureId: string): Promise<void> {
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
function freshTok(): { tok: string; tokEnc: Buffer } {
  if (!hasValidKek("RELAY_KEK")) throw new HttpError(503, KEK_MISSING, "RELAY_KEK_MISSING");
  const tok = randomBytes(16).toString("base64url");
  return { tok, tokEnc: sealWith("RELAY_KEK", tok) };
}

const drawCode = (): string => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

function isCodeCollision(err: unknown): boolean {
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
async function activeCodeOf(tx: Tx, fixtureId: string): Promise<ActiveCode | null> {
  const [row] = await tx<ActiveCode[]>`
    select id, code, tok_hash, created_at from fixture_stream_codes where fixture_id = ${fixtureId} and ended_at is null`;
  return row ?? null;
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
    const fresh = freshTok();
    const current = await activeCodeOf(tx, fixtureId);
    if (current) await wipeStreamCodeTok(tx, current.id, "reissued", auth.userId);
    return mintLocked(tx, auth, fixtureId, fresh);
  });
}

/**
 * Resolve a phone's code and tok for one call (C1). The phone-facing routes (T8a–T8c) call this first.
 *  - A malformed code is `404 not_a_stream_code` before any query (`normaliseCode` first: trim + lower-case).
 *  - An unknown code and a wrong tok are both `401 code_ended`, each through ONE constant-time compare.
 *  - C2: a code found past its grace with no open session is ended HERE (written lazily, committed), then refused.
 *  - C1b: an ENDED code answers only the fixture's open session's phone, for a session created before the end, and
 *    only a `get` or a `beat`.
 */
export async function resolveStreamCode(
  rawCode: string, tok: string, call: CodeCall, phone: string | null, now: Date,
): Promise<ResolvedCode> {
  const code = normaliseCode(rawCode);
  if (code === null) throw new CaptureRefusalError(404, "not_a_stream_code", "not a stream code");
  const [row] = await sql<{
    id: string; org_id: string; fixture_id: string; tok_hash: string; issued_by: string; ended_at: Date | null; finished_at: Date | null;
  }[]>`
    select c.id, c.org_id, c.fixture_id, c.tok_hash, c.issued_by, c.ended_at, f.finished_at
      from fixture_stream_codes c join fixtures f on f.id = c.fixture_id
     where c.code = ${code}`;
  if (!tokMatches(row?.tok_hash ?? null, tok) || !row) throw codeEnded();
  const [open] = await sql<{ created_at: Date; phone: string | null }[]>`
    select s.created_at, p.phone from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id
     where s.fixture_id = ${row.fixture_id} and s.state in ${sql([...ACTIVE_STATES])}
     order by s.created_at desc limit 1`;
  let endedAt = row.ended_at;
  let status = codeStatus({ endedAt, finishedAt: row.finished_at }, now, open !== undefined, graceMinutes());
  if (status === "expiry_due") {
    await sql.begin((tx) => wipeStreamCodeTok(tx, row.id, "expired", null));
    endedAt = now;
    status = "ended";
  }
  const callerIsOpenSessionPhone = open !== undefined && phone !== null && open.phone === phone;
  const sessionCreatedBeforeEnd = open !== undefined && endedAt !== null && open.created_at.getTime() < endedAt.getTime();
  const serves = codeServes({ status, callerIsOpenSessionPhone, sessionCreatedBeforeEnd, call });
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
  return { codeId: row.id, orgId: row.org_id, fixtureId: row.fixture_id, status: status as ResolvedCode["status"], issuedBy: row.issued_by };
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
  await fixtureOf(auth, fixtureId);
  return sql.begin(async (tx) => {
    if (body.targetId !== undefined) {
      await writeStreamSettings(tx, { orgId: auth.orgId, fixtureId, targetId: body.targetId, updatedBy: auth.userId });
    }
    if (body.autoStream !== undefined) {
      await writeAutoStream(tx, { orgId: auth.orgId, fixtureId, autoStream: body.autoStream, updatedBy: auth.userId });
    }
    const [row] = await tx<{ target_id: string | null; target_chosen: boolean; auto_stream: boolean }[]>`
      select target_id, target_chosen, auto_stream from fixture_stream_settings where fixture_id = ${fixtureId}`;
    // No row only for a body that named nothing (the route's schema refuses that): the defaults, with nothing written.
    if (row === undefined) return { targetId: null, autoStream: false };
    return { targetId: row.target_chosen ? row.target_id : null, autoStream: row.auto_stream };
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
    insert into fixture_stream_settings (fixture_id, org_id, target_id, target_chosen, updated_by, updated_at)
    values (${a.fixtureId}, ${a.orgId}, ${a.targetId}, true, ${a.updatedBy}, now())
    on conflict (fixture_id) do update
       set target_id = excluded.target_id, target_chosen = true, updated_by = excluded.updated_by, updated_at = now()`;
  return { targetId: a.targetId };
}

/** The one writer of `fixture_stream_settings.auto_stream` (W7, A4). An upsert that sets ONLY the switch, `updated_by` and
 *  `updated_at` — never `target_id` or `target_chosen`: a row it creates has chosen nothing, so the fixture keeps resolving
 *  the org's default destination (plan R-1), and a pick made earlier survives the toggle. Turning the switch OFF also clears
 *  `auto_start_refusal` (the refusal belonged to the attempt that is now off); `auto_started_at` and `auto_start_blocked_at`
 *  are never cleared by a toggle — an organiser Stop still blocks auto start for the match (A12). The caller has already
 *  proved the fixture is `orgId`'s. */
export async function writeAutoStream(
  tx: Tx, a: { orgId: string; fixtureId: string; autoStream: boolean; updatedBy: string | null },
): Promise<void> {
  await tx`
    insert into fixture_stream_settings (fixture_id, org_id, auto_stream, updated_by, updated_at)
    values (${a.fixtureId}, ${a.orgId}, ${a.autoStream}, ${a.updatedBy}, now())
    on conflict (fixture_id) do update
       set auto_stream = excluded.auto_stream, updated_by = excluded.updated_by, updated_at = now(),
           auto_start_refusal = case when excluded.auto_stream then fixture_stream_settings.auto_start_refusal else null end`;
}

/** A12: an organiser Stop turns auto START off for the match. Stamps `auto_start_blocked_at` once — the FIRST stamp wins and a
 *  later one is a true no-op (the update is skipped, so `updated_by`/`updated_at` stay the first Stop's too) — in the same kind
 *  of upsert as `writeAutoStream`: it creates a row that chose nothing when the switch was never touched, and never writes
 *  `target_id`/`target_chosen` (plan R-1, FP1). The caller has already proved the fixture is `orgId`'s. `exec` is the pool by
 *  default; pass the transaction (as `fixtureStreamTarget` accepts one) to stamp inside a caller's own, so the stamp commits or
 *  rolls back with it. */
export async function markAutoStartBlocked(
  orgId: string, fixtureId: string, at: Date, updatedBy: string | null, exec: Tx | typeof sql = sql,
): Promise<void> {
  await exec`
    insert into fixture_stream_settings (fixture_id, org_id, auto_start_blocked_at, updated_by, updated_at)
    values (${fixtureId}, ${orgId}, ${at}, ${updatedBy}, now())
    on conflict (fixture_id) do update
       set auto_start_blocked_at = excluded.auto_start_blocked_at, updated_by = excluded.updated_by, updated_at = now()
     where fixture_stream_settings.auto_start_blocked_at is null`;
}
