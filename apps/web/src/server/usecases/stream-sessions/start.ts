import "server-only";
// Go live: createSession and the ONE start path every start comes through (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, overrideRow } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamSession } from "@/server/api-v1/schemas";
import { checkDestination } from "@/lib/stream-destinations";
import {
  CODE_GRACE_AFTER_FINISH_MINUTES,
  MAX_DURATION_MINUTES,
  PHONE_SILENT_FLOOR_SECONDS,
  RELAY_OVERLAY_DELAY_DEFAULT_MS,
  tunable,
} from "@/server/relay/config";
import {
  ACTIVE_STATES,
  admit,
  admitMode,
  type PhoneStanding,
  type StartCause,
} from "@/server/relay/domain/session";
import { isPresent } from "@/server/relay/domain/pairing";
import { codeStatus } from "@/server/relay/domain/stream-code";
import { reservationMinutes } from "@/server/relay/domain/credits";
import { composedUnavailable } from "@/server/relay/drivers";
import {
  lockStreamTarget,
  readPooledKey,
  readTargetSecret,
  wipeStreamCodeTok,
} from "@/server/relay/secret-columns";
import { abandonPrepared, attachPrepared, prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { recordEvent, recordStorageSnapshot, type EventSource } from "@/server/relay/telemetry";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { creditBalance, ensureMonthlyStreamGrant, restartAllowance } from "../stream-credits";
import { DestinationNotAllowedError } from "../stream-targets";
import { writeStreamSettings } from "../stream-codes";
import { assertCompetitionNotFrozen } from "../entitlement-freeze";
import { type SessionDeps, youtubeOf } from "./deps";
import { fixtureContext, activeSessionIdFor } from "./lookups";
import { targetConnectionId } from "./destination";
import { applyExpiry } from "./expiry";
import { storageUsageForColumns, storageHeadroomMinutes } from "./storage";
import { targetHolderFor, tearDownPriorMachines, releasePriorOutputs, targetInUse } from "./holders";
import { refuse, unreadableRefusal, refuseUnreadableTarget, pooledKeyRefusal } from "./refusals";
import { provisionSession } from "./provision";

/** T11 (TEST-STRATEGY rule 4): the destination's source decides whether a broadcast was prepared, so a mismatch at the insert is
 *  a caller bug, refused by name. Reachable only through a race the probe cannot see (its answer and the locked row's differ). */
class PreparedMismatchError extends Error {
  constructor(apiBacked: boolean, fixtureId: string, targetId: string) {
    super(apiBacked
      ? `startBroadcast: an API-backed destination reached the session insert with no prepared broadcast (fixture ${fixtureId}, target ${targetId})`
      : `startBroadcast: a pasted destination reached the session insert with a prepared broadcast (fixture ${fixtureId}, target ${targetId})`);
    this.name = "PreparedMismatchError";
  }
}

export type { StartCause };

/** Capture QR v2 §5.3 (T6): who is starting. `userId` is the person the start is attributed to — the organiser, or for
 *  the phone's and the automatic start the stream code's `issued_by` (the issuer vouches for the phone, the device-link
 *  precedent). `pairingId` is the slot-0 pairing the start rides on; null only for an organiser's start on a fixture with
 *  none (a phone's or the automatic start always rides one, and is refused by name without it). */
export interface StartActor {
  userId: string;
  orgId: string;
  source: "organiser" | "phone" | "auto";
  pairingId: string | null;
}

/** The create action row's source per actor: the organiser's tab is the `client`, the phone is `phone` (A6, V430), and
 *  the automatic start is the domain's own decision. */
const START_EVENT_SOURCE = { organiser: "client", phone: "phone", auto: "domain" } as const satisfies Record<StartActor["source"], EventSource>;

/** W5 / T10 (§6.7.1, §6.9): slot 0's CURRENT pairing on the fixture's ACTIVE stream code, and its standing — `present`
 *  (current and not silent on `now`, admission's clock) or `silent` (owner ruling 2026-10-09: refused
 *  `phone_not_responding`, never `phone_not_paired`). Null is no current phone: `unpaired` to admission. Through the non-tenant `sql` (R1): V430's tables are FORCE RLS
 *  with no policy. At most one row: one active code per fixture, one current pairing per (code, slot) — V430's indexes.
 *  Both filters are load-bearing, and `c.ended_at is null` is the ONLY authority for a revoked code: T30 leaves a reissued
 *  code's pairings current "until they call", so without it the revoked phone would read present (witnesses: "W5 after
 *  Revoke & reissue" and "a SUPERSEDED pairing is not current").
 *  C2 (B7 re-review m-b, §6.12 "Code ended: no Go live"): the lookup EVALUATES the active code, on the same clock. Found
 *  expired, the first evaluation writes it (ended `expired`, tok wiped), as resolve, ensure and the panel's read do, and
 *  the code has no current phone: W5 answers `phone_not_paired`. An open session defers it (C2), so a Go live over one
 *  meets `active_session` as before. */
async function currentPhoneOf(fixtureId: string, now: Date): Promise<{ pairingId: string; standing: Exclude<PhoneStanding, "unpaired"> } | null> {
  const [c] = await sql<{
    id: string; finished_at: Date | null; open: boolean; pairing_id: string | null; last_beat_at: Date | null; answered_poll_seconds: number | null;
  }[]>`
    select c.id, f.finished_at,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = c.fixture_id and s.state in ${sql([...ACTIVE_STATES])}) as open,
           p.id as pairing_id, p.last_beat_at, p.answered_poll_seconds
      from fixture_stream_codes c
      join fixtures f on f.id = c.fixture_id
      left join fixture_stream_pairings p on p.code_id = c.id and p.slot = 0 and p.ended_at is null
     where c.fixture_id = ${fixtureId} and c.ended_at is null`;
  if (!c) return null;
  const grace = tunable("CODE_GRACE_AFTER_FINISH_MINUTES", CODE_GRACE_AFTER_FINISH_MINUTES);
  if (codeStatus({ endedAt: null, finishedAt: c.finished_at }, now, c.open, grace) === "expiry_due") {
    await sql.begin((tx) => wipeStreamCodeTok(tx, c.id, "expired", null));
    return null;
  }
  if (c.pairing_id === null) return null;
  const p = { id: c.pairing_id, last_beat_at: c.last_beat_at!, answered_poll_seconds: c.answered_poll_seconds! };
  const present = isPresent(
    { current: true, lastBeatAt: new Date(p.last_beat_at), answeredPoll: p.answered_poll_seconds },
    now, tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS),
  );
  return { pairingId: p.id, standing: present ? "present" : "silent" };
}

/** The organiser's Go live (the route's caller; unchanged signature). It resolves the actor, asks whether the fixture's
 *  phone is present (W5), starts through the ONE start path, and saves the destination as the fixture's pre-pick. */
export async function createSession(
  auth: AuthCtx, fixtureId: string, body: CreateStreamSession, deps: SessionDeps,
): Promise<{ sessionId: string }> {
  const { orgId } = await fixtureContext(fixtureId);
  if (orgId !== auth.orgId) throw new HttpError(404, "fixture not found");
  // The ACTOR is a guard, not a fallback. `created_by` is `uuid not null` with no FK, and `fillReplayUrl` later acts AS
  // that user when it writes the replay link. The plan wrote `auth.userId ?? orgId`, which for a caller with no user (an
  // API key: AuthCtx.userId is null) stores an ORG id in a users column and then impersonates it — a plausible lie in
  // both places. A start that spends a credit is attributed to a person or it does not happen; the session-only idiom
  // (device-links.ts, checkin-token.ts) answers 403. A device link carries its issuing organiser, so it passes.
  const actorUserId = auth.userId;
  if (actorUserId === null) throw new HttpError(403, "A stream can only be started by a signed-in organiser");
  const phone = await currentPhoneOf(fixtureId, deps.now());
  const started = await startBroadcast(
    { userId: actorUserId, orgId, source: "organiser", pairingId: phone?.pairingId ?? null },
    fixtureId,
    {
      targetId: body.targetId, startCause: "organiser", phone: phone?.standing ?? "unpaired", mode: body.mode,
      themeId: body.themeId ?? null, overlayDelayMs: body.overlayDelayMs,
    },
    deps,
  );
  // T6 (§6.6): the destination this Go live used becomes the fixture's pre-pick, which the phone's own start reads.
  // AFTER the start, and never failing it: a broadcast that IS running must not answer an error the organiser would
  // retry straight into active_session. A failed save is logged and reported; the next Go live saves it again.
  try {
    await sql.begin((tx) => writeStreamSettings(tx, { orgId, fixtureId, targetId: body.targetId, updatedBy: actorUserId }));
  } catch (err) {
    log.warn({ err, fixtureId, targetId: body.targetId }, "stream session: the destination pre-pick was not saved — the session is running");
    captureError(err, { orgId, route: "relay.session.pre_pick" });
  }
  return started;
}

/** Capture QR v2 §5.3 / §6.7 (T6): the ONE start path. The organiser's Go live (`createSession`), the phone operator's
 *  start and the automatic start all come through here, so admission, the destination doors, the storage read, the
 *  insert and provisioning are the same code for all three (A23); only the actor, `startCause` and `phone` differ.
 *  `phone` is the caller's answer: the organiser's is read from the pairing (unpaired, silent or present), the phone's
 *  and the automatic start's is `present` (the caller IS the current phone). */
export async function startBroadcast(
  actor: StartActor,
  fixtureId: string,
  opts: {
    targetId: string; startCause: StartCause; phone: PhoneStanding;
    /** R2006: REQUIRED, so no start path can stream a mode it did not decide. The organiser's Go live states the mode its
     *  panel showed; the phone's start and the automatic start read the fixture's stored choice (stream-codes.ts
     *  `startModeFor`). */
    mode: CreateStreamSession["mode"];
    themeId?: string | null;
    /** PR #989 review m2: the organiser's Go live states the timing its panel showed (null: the server's default).
     *  Absent — the phone's start, the automatic start — the fixture's stored timing. Composed only. */
    overlayDelayMs?: number | null;
    /** The automatic start's instant (§7.2, final review m-1): stamped as `auto_started_at` IN the insert's transaction, so
     *  the session and "once per match" commit together. Given exactly when `actor.source` is `auto`. */
    autoStartedAt?: Date;
  },
  deps: SessionDeps,
): Promise<{ sessionId: string }> {
  const { orgId, competitionId } = await fixtureContext(fixtureId);
  if (orgId !== actor.orgId) throw new HttpError(404, "fixture not found");
  const actorUserId = actor.userId;
  const body = { mode: opts.mode, targetId: opts.targetId, themeId: opts.themeId ?? null, overlayDelayMs: opts.overlayDelayMs };
  // R2001: can this deployment run a composed session at all (drivers.ts `composedUnavailable()`, the ONE authority the
  // organiser UI reads too)? Read ONCE, here, and handed to every `admit` below. Asked only for a composed start — a
  // passthrough start reads no new fact and its path is unchanged.
  const composedRunnerDown = body.mode === "composed" && composedUnavailable();
  // An assumption made a guard: every caller reads its pairing FROM this fixture's code, so a pairing on another
  // fixture's code is a caller bug — refused before anything is weighed or written, never a session tied to the wrong
  // phone. Witness: "startBroadcast refuses a pairing from another fixture's code".
  const pairing = actor.pairingId === null ? null : (await sql<{ code_id: string; issued_by: string }[]>`
    select p.code_id, c.issued_by from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where p.id = ${actor.pairingId} and c.fixture_id = ${fixtureId}`)[0] ?? null;
  if (actor.pairingId !== null && pairing === null) {
    throw new Error(`startBroadcast: pairing ${actor.pairingId} is not on fixture ${fixtureId}'s stream code`);
  }
  // §6.7.1 "the actor", made a guard (B4 review m-2): a phone's or the automatic start rides the slot's pairing and is
  // attributed to its stream code's `issued_by`, who vouches for the phone. A caller that names anyone else, or brings
  // no pairing, is a caller bug — refused by name before anything is weighed or written, so `created_by` and the
  // action row's actor can only ever be the issuer. Witness: "a phone or automatic start is attributed to its code's
  // issued_by".
  if (actor.source !== "organiser") {
    if (pairing === null) throw new Error(`startBroadcast: a ${actor.source} start rides the slot's pairing, and none was given for fixture ${fixtureId}`);
    if (actor.userId !== pairing.issued_by) {
      throw new Error(`startBroadcast: a ${actor.source} start is attributed to its stream code's issuer, not to user ${actor.userId}`);
    }
  }
  // Final review m-1, an assumption made a guard: the automatic start's stamp rides its own transaction below, so an auto
  // start that brings no instant (it would commit a session with no stamp — the second-start defect) and any other start
  // that brings one (it would mark a hand start as the match's automatic one) are caller bugs, refused before anything is
  // weighed or written. After the attribution guard, so that guard keeps answering first. Witness: "an automatic start
  // without its stamp instant, or a non-automatic start with one, is refused by name".
  if ((actor.source === "auto") !== (opts.autoStartedAt !== undefined)) {
    throw new Error(`startBroadcast: auto_started_at is stamped by an auto start and only by one (a ${actor.source} start ${opts.autoStartedAt === undefined ? "brought none" : "brought one"}) on fixture ${fixtureId}`);
  }
  // Match Day PB2 (owner 2026-11-02, "hide"; fix round 1 (a), controller ruling): a billing-frozen competition starts no
  // NEW stream by ANY path — the organiser's Go live (402 on the wire), the phone operator's start (`phoneStartRefusal`:
  // not_entitled) and the automatic start (`autoStartRefusalOf`: not_entitled, retried after the spacing) — because a stream
  // costs money. Asked HERE, the one start seam, after the caller-bug guards and before the relay, the credits, the storage
  // read and any provider call, so a refusal writes and spends nothing. Reading a session and stopping one never come
  // through here, so a stream already running keeps running (a frozen page's panel is Stop-only, fixture-stream-mount.ts).
  // Outside any transaction, as `frozenCompetitionIds` requires (entitlement-freeze.ts): no caller holds one here.
  await assertCompetitionNotFrozen(orgId, competitionId);
  // R5 (Task 14b): a production deployment with no RELAY_DRIVERS has no relay (drivers.ts `disabledRelayDrivers`).
  // Refused with the ingest's own 503 BEFORE anything else — no expiry, no provider call, no monthly grant, no row —
  // so nothing is faked and no credit moves. The Phone tab already reads this code.
  if (deps.drivers.disabled) {
    log.warn({ fixtureId, orgId }, "stream session: the relay is disabled on this deployment — start refused");
    throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
  }
  // R2001: a composed start on a deployment with no compositor runner is refused HERE — admission's FIRST gate, asked
  // alone (`admitMode`) because nothing later on the ladder can change its answer. No session row, input, credit or
  // runner is created: it comes before the expiry, the destination teardown, the monthly grant, the storage read, the
  // row, the Cloudflare input and the runner call. It used to be admitted and fail at the runner's constructor with the
  // row, the input and provisioning already made.
  const byMode = admitMode({ mode: body.mode, composedUnavailable: composedRunnerDown });
  if (!byMode.ok) {
    log.warn({ fixtureId, orgId }, "stream session: composed mode is unavailable on this deployment — start refused");
    refuse(byMode, 0);
  }
  // B: the fixture's own stuck session is expired here, not on a tick.
  const existing = await activeSessionIdFor(fixtureId);
  if (existing) await applyExpiry(existing, deps);
  // F-A5 over the destination doors (owner, 2026-09-29, "a match already streaming answers a second start before
  // credits, destination or storage are weighed"; applied to the holder guard by the owner's answer B, 2026-09-30): a
  // fixture STILL streaming after its own lazy expiry skips every destination door below — the holder guard and both
  // prior-teardown refusals, each a `target_in_use` naming ANOTHER match — and is carried to admission as this start's
  // session, so `admit` answers it `active_session` in its own order (the plan first), under the same target row lock,
  // with the same measurement as any refused admission and nothing spent. Carried, not re-read: were it to end between
  // here and the admission transaction, this start has skipped the destination doors and must not proceed on that.
  const stillRunning = existing ? await activeSessionIdFor(fixtureId) : null;
  let priorMachineSessionId: string | null = stillRunning;
  if (!stillRunning) {
    // The DESTINATION guard (gap 4), placed BEFORE the storage read and before `tearDownPriorMachines` — i.e. before any
    // provider call this create would make FOR THE NEW SESSION, so a refused start leaves no Cloudflare live input, no
    // Fly Machine and nothing to clean up. That early placement is the whole point of refusing in code at all (the index
    // alone would refuse only at the insert, after `ingest.storageUsage()` had already been called), and it is what
    // G-T1's zero-provider-call assertions witness. It sits AFTER this fixture's own lazy expiry on purpose: that expiry
    // can RELEASE this very target. The one provider call that can precede it belongs to that OLD session's teardown.
    const holder = await targetHolderFor(body.targetId, orgId, fixtureId, deps);
    if (holder) {
      log.warn({ fixtureId, targetId: body.targetId, holder: holder.sessionId, court: holder.courtName }, "stream session: the destination is already held by another fixture — start refused");
      throw targetInUse(holder);
    }
    // 2C-post m5: a PREVIOUS session's Machine the provider still lists is destroyed before this one may start; while
    // that destroy fails, admission answers `active_session` naming its session (outside the transaction: it calls the
    // provider). I1: ANOTHER fixture's ended session with a Machine still listed on this destination is destroyed the
    // same way; only when that destroy fails is the start `target_in_use`, naming its court, like an active holder.
    const prior = await tearDownPriorMachines(fixtureId, body.targetId, orgId, deps);
    if (prior.otherFixture) throw targetInUse(prior.otherFixture);
    // C1: the passthrough twin — an ended session whose output release failed is released now, refused only if it fails again.
    const priorOutput = await releasePriorOutputs(fixtureId, body.targetId, orgId, deps);
    if (priorOutput.otherFixture) throw targetInUse(priorOutput.otherFixture);
    priorMachineSessionId = prior.sameFixture ?? priorOutput.sameFixture;
  }

  // V426 (Task 14b, R3a): this month's free match credits are granted BEFORE the balance is read, so an org that has
  // never bought a pack is admitted on its plan's allowance. Idempotent and one indexed read once the period's row
  // exists. On the WALL clock, not deps.now(): the grant's period is the real UTC month (ledger rows carry the DB's
  // now()), and a test clock ticked across a month end must not mint a second grant mid-test. Outside the admission
  // transaction: it takes the org's money lock in a transaction of its own, which must not be held across `admit`.
  // m4 (lane-close fix): guarded the way relayCredits guards it — a grant that fails (a corrupt ledger's
  // `ledger_negative`, the lock, the plan read) is logged and reported, and admission reads the UNGRANTED balance. An
  // org with pack credits still goes live on them; one with nothing else gets the balance gate's own 402 no_credits.
  try {
    await ensureMonthlyStreamGrant(orgId);
  } catch (err) {
    log.error({ err, orgId, fixtureId }, "createSession: monthly grant failed; admitting on the ungranted balance");
    captureError(err, { orgId, route: "relay.session.monthly_grant" });
  }

  const [overlay, relay, balance, restartWithinReuseWindow, relayOverride] = await Promise.all([
    hasFeature(orgId, "streaming.overlay", competitionId),
    hasFeature(orgId, "streaming.relay", competitionId),
    creditBalance(sql, orgId),
    // I2 (§5.2) + W23 (T6b): a FREE restart of THIS fixture — inside the reuse window, fewer than three counted since its
    // anchor — costs nothing, so `admit` waives the balance gate for it. The same authority consumeForSession asks at
    // go-live, on the same clock (deps.now()). A 4th is an ordinary paid start: the balance gate answers it.
    restartAllowance(sql, { orgId, fixtureId, excludeSessionId: null }, deps.now()).then((a) => a.free),
    // Dc: HOW the org got `streaming.relay` — a live staff override, or the plan. `overrideRow` is the
    // existing single authority (it already filters expired overrides); no resolver edit. Since V426 every
    // plan grants the relay, so the FALSE branch (plan-granted) is the common one; stream-sessions.test.ts
    // drives it through createSession on an org with no override row.
    overrideRow(orgId, "streaming.relay"),
  ]);
  // W5 BEFORE the storage read (controller ruling, B4 fix round): a Go live with no phone to stream from asks Cloudflare
  // nothing. The probe is `admit` itself on everything it can weigh without storage, so the plan gates and
  // `active_session` (F-A5) still outrank W5 in admit's own order; only W5's answers are taken here — `phone_not_paired`
  // and, since the owner's 2026-10-09 split, `phone_not_responding` — and every other refusal is left to the admission
  // below, measurement included (ruling 13). Nothing was measured, so this refusal records no storage snapshot. The
  // destination doors above still answer first (§17.10).
  const early = admit({
    overlay, relay, balance, restartWithinReuseWindow, targetBelongsToOrg: true, phone: opts.phone, mode: body.mode, composedUnavailable: composedRunnerDown,
    // R2004: room for every recording THIS mode makes, so the probe can never refuse on storage (it has not read it).
    headroomMinutes: reservationMinutes(body.mode, MAX_DURATION_MINUTES), maxDurationMinutes: MAX_DURATION_MINUTES,
    activeSessionId: (await activeSessionIdFor(fixtureId)) ?? priorMachineSessionId,
  });
  if (!early.ok && (early.refusal === "phone_not_paired" || early.refusal === "phone_not_responding")) refuse(early, 0);
  // M1 (B2 review): a saved key that will not open is refused BEFORE the storage read below — the first provider call a
  // create makes for itself — so an unreadable Go live asks Cloudflare nothing at all. A PROBE only: it answers solely for
  // this org's ACTIVE row (an archived or foreign id falls through to `admit`'s 404, never an oracle), only when `admit`
  // would otherwise pass (F-A5, see `refuseUnreadableTarget`), and the read inside the admission transaction stays the
  // authority for everything that row lock protects.
  const probed = await refuseUnreadableTarget(orgId, fixtureId, body.targetId, (activeSessionId) => admit({
    overlay, relay, balance, restartWithinReuseWindow, targetBelongsToOrg: true, phone: opts.phone, mode: body.mode, composedUnavailable: composedRunnerDown,
    headroomMinutes: reservationMinutes(body.mode, MAX_DURATION_MINUTES), maxDurationMinutes: MAX_DURATION_MINUTES,   // storage not weighed yet: it cannot refuse here (R2004: in either mode)
    activeSessionId: activeSessionId ?? priorMachineSessionId,
  }).ok);
  // YouTube Connect T11 (spec §6.2): an API-backed destination streams into a broadcast prepared at YouTube HERE — once the
  // probe has passed (so nothing `admit` answers first is outranked, F-A5), after the destination doors above (so a Stop → Go
  // live inside the grace has released the prior output and torn down the prior Machine, and the key frees and is reused), and
  // before the storage read. Outside every transaction: prepare holds no lock across a YouTube call. Null for a pasted row.
  // Server-side only: neither the broadcast nor the Prepared ever comes from the request.
  // The port is a THUNK (T11 fix round 1, m3): prepare resolves it only for an API row, so a misspelt YOUTUBE_DRIVER cannot fail a
  // pasted-key Go live, phone start or automatic start. `abandonPrepared` below is reached only with a Prepared, i.e. an API row.
  const youtube = () => youtubeOf(deps);
  const prepared = probed ? await prepareYoutubeBroadcast({ orgId, fixtureId, targetId: body.targetId, now: deps.now(), startCause: opts.startCause }, youtube) : null;
  // T11 (R12, spec §6.2): ANY throw between the prepare and the session's commit — the storage read, every admission refusal
  // and the 23505 mappers below, a pooled key that will not open, a mismatch — abandons the prepared broadcast before it is
  // rethrown: deleted at YouTube with its row `failed`, or a reused one's reservation released; never left "upcoming" for the
  // orphan sweep. Chained AFTER the transaction has rolled back, so no lock is held across the YouTube call.
  const abandonThenRethrow = async (err: unknown): Promise<never> => {
    if (prepared !== null) await abandonPrepared(prepared, youtube());
    throw err;
  };
  const usage = await deps.drivers.ingest.storageUsage().then(storageUsageForColumns).catch(abandonThenRethrow);   // outside the transaction; G7: fitted to the integer columns
  const viaOverride = relayOverride?.bool_value === true;

  const sessionId = await (sql.begin(async (tx) => {
    // Spec §5.2: the target ROW LOCK, taken inside the admission transaction and BEFORE admit reads it — Replace key and
    // Remove take the same lock, so a Remove cannot interleave with this Go live. An archived target is absent here
    // (`archived_at is null`), so `admit` answers the existing 404 target_not_found shape.
    const targetBelongsToOrg = await lockStreamTarget(tx, orgId, body.targetId);
    const headroom = await storageHeadroomMinutes(tx, usage, deps.now(), "admission");   // E1: a negative reading is reported, never enforced on a running stream
    const snapshot = { source: "admission" as const, usedMinutes: usage.totalStorageMinutes, limitMinutes: usage.totalStorageMinutesLimit,
      reservedMinutes: usage.totalStorageMinutesLimit - usage.totalStorageMinutes - headroom, headroomMinutes: headroom, takenAt: deps.now() };
    const verdict = admit({
      overlay, relay, balance, restartWithinReuseWindow, targetBelongsToOrg, headroomMinutes: headroom, phone: opts.phone, mode: body.mode, composedUnavailable: composedRunnerDown,
      maxDurationMinutes: MAX_DURATION_MINUTES, activeSessionId: (await activeSessionIdFor(fixtureId, tx)) ?? priorMachineSessionId,   // m2: on the tx, never a 2nd pooled connection
    });
    if (!verdict.ok) {
      await recordStorageSnapshot(sql, { ...snapshot, sessionId: null });   // the ROOT client: this transaction is about to roll back with the refusal, the measurement must not (ruling 13)
      refuse(verdict, headroom);
    }
    // A20 (Task 9 re-review): the allowlist can SHRINK after a target was saved (LinkedIn was dropped 2026-09-28), and
    // createStreamTarget's check ran only when the row was written. The STORED url is re-checked here through the ONE
    // validator — after `admit` (so a target of another org is still 404 `target_not_found`, and nothing is opened for
    // it) and before the insert, i.e. before any credit, Cloudflare input or Machine exists for this start. The refusal is
    // the same typed 422 the save would have given, and like it never carries the url (its path can hold the key).
    // B2 (B1 review): a saved key that will not open (a KEK change, a damaged byte) was an unmapped 500 here. It is the
    // organiser's to fix, so it is a typed 422 naming the remedy — thrown inside this transaction, so no row is written
    // and nothing is spent (the credit is consumed only at live). M1: `refuseUnreadableTarget` already asked this before
    // the storage read; this read, under the row lock, stays the authority (a Replace key cannot interleave with it).
    // T11 (post-T3 amendment): the LOCKED row's source decides `api_backed`, so the session's flag and its target agree. An
    // API-backed row has no saved key to re-check: its broadcast's pooled key is opened instead, so one that will not open is
    // refused here — inside this transaction, before anything is written — as youtube_unavailable, never "replace the key".
    const connectionId = await targetConnectionId(tx, orgId, body.targetId);
    if ((connectionId !== null) !== (prepared !== null)) throw new PreparedMismatchError(connectionId !== null, fixtureId, body.targetId);
    if (connectionId !== null && prepared !== null) {
      await readPooledKey(tx, orgId, prepared.keyId).catch((err: unknown) => { throw pooledKeyRefusal(err, fixtureId, body.targetId, connectionId); });
    } else {
      const saved = await readTargetSecret(tx, orgId, body.targetId).catch((err: unknown) => { throw unreadableRefusal(err, fixtureId, body.targetId); });
      const destination = checkDestination(saved.url);
      if (!destination.ok) {
        log.warn({ fixtureId, targetId: body.targetId, rule: destination.rule }, "stream session: a saved destination the allowlist no longer admits — start refused");
        throw new DestinationNotAllowedError(destination.rule);
      }
    }
    // Db + Dc: the ADMISSION SNAPSHOT, written in the same statement as the row it describes.
    // These are snapshot facts with no FKs (`fixture_id` already joins) — they answer "what was
    // true when this stream started", which is not the same question as "what is true now": a
    // fixture can be rescheduled or moved to another court the day after a broadcast.
    // sport_key / competition_id / division_id / entitlement_via_override are NOT NULL with NO
    // default, so a producer that drops one fails 23502 here rather than writing a plausible lie.
    // Both race backstops (the fixture's and the destination's partial unique index) are mapped on the transaction
    // BOUNDARY below, never in a catch here: Note 4.
    const [s] = await tx<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, theme_id, max_duration_minutes, created_by,
                                           storage_minutes_at_admission, reserved_minutes, destination_kind,
                                           sport_key, competition_id, division_id, fixture_scheduled_at,
                                           venue_id, venue_address, org_timezone, entitlement_via_override,
                                           start_cause, code_id, pairing_id, overlay_delay_ms, api_backed, youtube_broadcast_id)
      select ${fixtureId}, ${orgId}, ${body.mode}, 'requested', ${body.targetId},
             -- R2004 decision 7: the organiser's template CHOICE is copied, never resolved here (a retired id still reads,
             -- then resolves at every reader); a themeId the create names wins. The running session never moves with it.
             coalesce(${body.themeId ?? null}::text, st.overlay_template),
             ${MAX_DURATION_MINUTES}, ${actorUserId},
             ${usage.totalStorageMinutes}, ${reservationMinutes(body.mode, MAX_DURATION_MINUTES)}, (select kind from org_stream_targets where id = ${body.targetId}),
             d.sport_key, d.competition_id, f.division_id, f.scheduled_at,
             c.venue_id, v.address, o.timezone, ${viaOverride},
             ${opts.startCause}, ${pairing?.code_id ?? null}, ${actor.pairingId},
             -- R2004 decision 4: the EFFECTIVE delay (the fixture's override, else the default) for composed; passthrough
             -- keeps the column's 0 (the field is unused in that mode). Copied, so a running session never changes.
             -- PR #989 review m2: a delay the create names wins over the stored one (null: the default), so the
             -- organiser's Go live streams the timing its panel showed even while that timing's own save is in flight.
             ${body.mode !== "composed"
               ? sql`0`
               : body.overlayDelayMs === undefined
                 ? sql`coalesce(st.overlay_delay_ms, ${RELAY_OVERLAY_DELAY_DEFAULT_MS}::int)`
                 : sql`${body.overlayDelayMs ?? RELAY_OVERLAY_DELAY_DEFAULT_MS}::int`},
             -- T11 (post-T1 amendment): written ONCE, here, and never updated — V479's broadcast_implies_api_backed holds them
             -- together, and the per-target index exempts an api_backed session from the moment it exists.
             ${connectionId !== null}, ${prepared?.broadcastId ?? null}
        from fixtures f
        join divisions d on d.id = f.division_id
        join organizations o on o.id = ${orgId}
        left join courts c on c.id = f.court_id          -- a fixture with no court leaves venue_* null
        left join venues v on v.id = c.venue_id
        left join fixture_stream_settings st on st.fixture_id = f.id   -- R2004: the fixture's stored overlay choices
       where f.id = ${fixtureId}
      returning id`;
    // #981 follow-up: the insert copies its facts FROM the fixture row, so a fixture deleted after the entry's check
    // (`fixtureContext`) inserts nothing. Refused with that check's own 404 — never a bare TypeError 500, and never a
    // session (composed: one whose overlay page would name no fixture). Inside the transaction: nothing is written.
    if (!s) throw new HttpError(404, "fixture not found");
    const sid = s.id;
    // T11: the prepared broadcast goes live WITH its session — one transaction, so neither commits without the other.
    if (prepared !== null) await attachPrepared(tx, prepared, sid);
    await tx`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 0)`;   // M3: same transaction
    // R2004: a composed session's programme input (Input B) — the compositor publishes to it and the output attaches to it.
    if (body.mode === "composed") await tx`insert into fixture_stream_inputs (session_id, slot, role) values (${sid}, 0, 'programme')`;
    // Final review m-1: "once per match" commits WITH the session it records — never in a statement of its own after this
    // transaction, where a failure (or a dead process) left an automatic session with no stamp, and the next beat past the
    // retry spacing started a second one. The claim's row (`maybeAutoStart`) is the one stamped; a start that finds none
    // is refused by name, and the whole transaction with it.
    if (opts.autoStartedAt !== undefined) {
      const stamped = await tx`update fixture_stream_settings
                                  set auto_started_at = ${opts.autoStartedAt}, auto_start_session_id = ${sid}, auto_start_refusal = null
                                where fixture_id = ${fixtureId}`;
      if (stamped.count !== 1) throw new Error(`startBroadcast: an auto start found no settings row to stamp auto_started_at on fixture ${fixtureId}`);
    }
    await recordStorageSnapshot(tx, { ...snapshot, sessionId: sid });
    await recordEvent(tx, { sessionId: sid, orgId, source: START_EVENT_SOURCE[actor.source], kind: "action", type: "create", actorUserId, occurredAt: deps.now(),
      payload: { mode: body.mode, targetId: body.targetId, headroomMinutes: headroom, credits: balance, startCause: opts.startCause, pairingId: actor.pairingId } });
    return sid;
  }) as Promise<string>).catch(async (err: unknown) => {
    // The race backstops, mapped OUTSIDE `sql.begin` — Task 7's `staffRow` idiom and its measured reason: postgres.js
    // rethrows a query error at the transaction boundary even when the callback caught it. Note 4: the plan mapped the
    // FIXTURE index inside the transaction and left it so; that catch is gone, and both indexes are mapped here, BY NAME
    // (an unnamed 23505 would report a destination collision as "a session is already running for this fixture").
    // Witnesses: "Note 4: two creates on ONE fixture at once …" and "G-T6 the RACE".
    const pg = err as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === "fixture_stream_sessions_one_active") {
      // admit saw no active row; the index saw one land first. The winner committed before this insert could fail, so a
      // fresh read names it.
      refuse({ ok: false, refusal: "active_session", activeSessionId: (await activeSessionIdFor(fixtureId)) ?? undefined }, 0);
    }
    if (pg.code === "23505" && pg.constraint_name === "fixture_stream_sessions_one_active_target") {
      // Never `active_session` — a different fact with a different dictionary string. The message cannot name the holder
      // here (the transaction rolled back and the read is gone), which is exactly why `targetHolderFor` refuses first:
      // this branch is the loser of a real race (G-T6), not the path an organiser normally meets.
      throw new HttpError(409, "that destination is already streaming for another fixture", "target_in_use", { holder: null });
    }
    throw err;
  }).catch(abandonThenRethrow);

  try {
    await provisionSession(sessionId, deps);
  } catch (err) {
    // T11 fix round 1 (I-1): the admission HAS committed, so `abandonThenRethrow` is behind us. When provisioning then deletes the
    // session (Cloudflare refused the input: `provisionSession` removes the row and answers 503 ingest_unavailable), the FK nulls the
    // broadcast's `last_session_id` and leaves a NEW broadcast `live` with no session: the end rule never ends it (no session has
    // used it), its pooled key stays held, and it stays "upcoming" at YouTube (spec §6.2: deleted, never left upcoming).
    // `abandonPrepared` fails and deletes it — and only a row with no session: one whose session still exists keeps its
    // `last_session_id` and is left to that session's own end. A REUSED broadcast is left as it is, by `abandonPrepared`'s own
    // reused branch (it releases a reservation and never deletes): its earlier sessions stay on it, so it stays `live` and the end
    // rule ends it at their Stop + the grace; deleting it would delete a video that streamed.
    if (prepared !== null) await abandonPrepared(prepared, youtube());
    throw err;
  }
  return { sessionId };
}
