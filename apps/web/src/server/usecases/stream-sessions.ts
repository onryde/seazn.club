import "server-only";
// server/usecases/stream-sessions.ts — the APPLICATION layer over the pure
// domain (server/relay/domain/*). One shape for every change:
//
//   apply(sessionId, command):  lock the row → toSession → decide(session,
//   command, now) → persist(next) → [consume_credit INSIDE the transaction]
//   → commit → the remaining effects through the ports → the session.
//
// This file never assigns `state`; it persists what `decide` returned. The
// expiry policy runs LAZILY through applyExpiry on every read, heartbeat,
// poll and admission (recommendation B) — no money or safety rule waits for
// the daily cron. Network calls (ingest, runner) happen OUTSIDE transactions;
// the replay fill (setFixtureStreamUrl, a withTenant caller) runs after every
// transaction has closed. E5: storage_exhausted is a REFUSAL (503, no row).
import type postgres from "postgres";
import { sql, type Tx } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import { hasFeature, overrideRow } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamSession, RelayHeartbeat, RelayHeartbeatReply, StreamSessionCurrent } from "@/server/api-v1/schemas";
import { RelayJobSession } from "@/server/api-v1/schemas";
import { resolveTemplate } from "@/components/overlay/template-registry";
import { checkDestination } from "@/lib/stream-destinations";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import {
  AUTO_STOP_AFTER_RESULT_SECONDS, CLOUDFLARE_STORED_MICROS_PER_MINUTE, EST_COST_CURRENCY, FLY_BILLING_SECONDS_PER_MONTH,
  FLY_PERFORMANCE_CPU_MICROS_PER_MONTH, FLY_PERFORMANCE_INCLUDED_GB_PER_CPU, FLY_RAM_MICROS_PER_GB_MONTH,
  CODE_GRACE_AFTER_FINISH_MINUTES, FINALISATION_GRACE_SECONDS, MAX_DURATION_MINUTES, PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, RECONNECT_QUIET_SECONDS, RUNNER_DEFAULT_GUEST,
  RECORDING_RETENTION_DAYS, RELAY_HEARTBEAT_INTERVAL_MS, RELAY_OVERLAY_DELAY_DEFAULT_MS,
  RUNNER_DEFAULT_REGION, SAMPLES_PER_SESSION_CAP, WARMING_TIMEOUT_MINUTES, relayEnvironment, relayOutputProfile, tunable,
} from "@/server/relay/config";
import {
  ACTIVE_STATES, TERMINAL_STATES, InvalidTransition, admit, admitMode, decide, eventRowsOf, holdStateOf, isTerminal,
  type Command, type Decision, type Effect, type HoldState, type PhoneStanding, type Session, type SessionState, type StartCause,
} from "@/server/relay/domain/session";
import { isPresent } from "@/server/relay/domain/pairing";
import { steppedDownTo } from "@/server/relay/domain/ladder";
import { autoStopApplies, autoStopVerdict, type PhoneMode } from "@/server/relay/domain/auto-stream";
import { codeStatus } from "@/server/relay/domain/stream-code";
import { InvalidRunnerTransition, machineNameFor, restartsInPlaceAfter, stoppedBeatTrigger, type ExitInfo, type RunnerEffect } from "@/server/relay/domain/runner";
import { evaluate, runnerDeadlineOf, warmingTimedOut, type Expiry } from "@/server/relay/domain/expiry";
import {
  type Ask10Phone, cameraEvidenceMatters, composedCameraLost, composedCameraWatched, composedNeverLive, livePhoneLost, lostCountdown, programmePhaseRowMatters,
  warmingPhoneLost,
} from "@/server/relay/domain/phone-lost";
import { elapsedMinutesSince, endedReservationMinutes, headroomAfterReservations, reservationMinutes } from "@/server/relay/domain/credits";
import { composedUnavailable, relayDrivers, type RelayDrivers } from "@/server/relay/drivers";
import { createFailureOf, createRefusedBeforeCall, type IngestProtocol, type IngestState, type OutputState, type RunnerSpec, type StorageUsage } from "@/server/relay/ports";
import {
  TargetSecretUnreadableError, lockStreamTarget, readCameraPlayback, readFirstInput, readPooledKey, readTargetSecret, storeInputCredentials, storePlaybackCredentials, wipeStreamCodeTok,
} from "@/server/relay/secret-columns";
import { youtubeDriver } from "@/server/youtube/driver";
import type { YouTubePort } from "@/server/youtube/port";
import { abandonPrepared, attachPrepared, prepareYoutubeBroadcast, youtubeRefusal } from "@/server/youtube/prepare";
import { scrubBeatText } from "@/server/relay/sanitise";
import { CAMERA_LIVE_PHASE, PROGRAMME_PHASE_EVENT, latestLiveRung, recordEvent, recordSample, recordStorageSnapshot, type EventSource } from "@/server/relay/telemetry";
import { mintRelayToken, relayTokenExpiry, verifyRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import {
  NoCreditsError, consumeForSession, creditBalance, creditBreakdown, ensureMonthlyStreamGrant, ensureMonthlyStreamGrantWithRate,
  lockOrg, neverLiveRefundStanding, refundConsumeForSession, restartAllowance, streamMonthlyRate, type StreamCreditBreakdown,
} from "./stream-credits";
import { DestinationNotAllowedError, TargetUnreadableError } from "./stream-targets";
import { holderHref, holderRows, wireHolder, type TargetHolder } from "./stream-target-holders";
import { setFixtureStreamUrl } from "./fixtures";
import { markAutoStartBlocked, writeStreamSettings } from "./stream-codes";

export { ACTIVE_STATES, TERMINAL_STATES };

/** M6: the states a session can still CONSUME from, i.e. not yet live — `apply` reads the org's monthly rate (a pooled
 *  read) for these alone. The domain decides a consume only from `warming`, and states only move forward. */
const CAN_STILL_CONSUME: readonly Session["state"][] = ["requested", "provisioning", "warming"];

/** `youtube` (YouTube Connect T11): the port a Go live on an API-backed destination prepares its broadcast through. Optional
 *  so a rig that streams only to pasted keys need not name one; absent, it is the process's driver (`youtubeOf`). */
export interface SessionDeps { drivers: RelayDrivers; now: () => Date; appUrl: string; youtube?: YouTubePort }
export function defaultDeps(appUrl: string): SessionDeps {
  // `youtube` is resolved when READ, not here: `youtubeDriver()` throws on a misspelt YOUTUBE_DRIVER, and every stream route
  // builds these deps — a Stop or a heartbeat on a pasted-key match must not fail on a YouTube setting it never uses.
  return { drivers: relayDrivers(), now: () => new Date(), appUrl, get youtube() { return youtubeDriver(); } };
}
const youtubeOf = (deps: SessionDeps): YouTubePort => deps.youtube ?? youtubeDriver();

// ---------------------------------------------------------------------------
// Persistence — the only SQL over fixture_stream_sessions' mutable columns.
// ---------------------------------------------------------------------------
interface Row {
  id: string; fixture_id: string; org_id: string; mode: "passthrough" | "composed"; state: Session["state"];
  desired_state: "live" | "ending"; fail_reason: Session["failReason"]; end_reason: Session["endReason"]; theme_id: string | null; overlay_delay_ms: number;
  target_id: string; machine_id: string | null; last_heartbeat: Record<string, unknown> | null; heartbeat_at: string | null; beat_window_at: string | null;
  started_at: string | null; ended_at: string | null; ending_at: string | null; max_duration_minutes: number; runner_retries: number;
  runner_attempts: number;
  runner_state: Session["runner"]["state"]; runner_name: string | null; runner_stop_requested_at: string | null;
  runner_exit_code: number | null; runner_oom_killed: boolean | null; runner_requested_stop: boolean | null;
  // R2003b (V450): the crash tally (domain/runner.ts CrashTally) — the session's count, this attempt's two bounds, the newest exit's instant
  runner_crash_count: number; runner_crash_beats: number; runner_crash_exits: number; runner_crash_exit_at: string | null;
  runner_crash_restart_seen: boolean;   // V467 (Owed 66): this attempt has read an in-place restart's exit — the restart-count floor is dropped
  // Owed 67 (V468): the restart tally (domain/runner.ts RestartTally) — the session's count, this attempt's two bounds, the newest exit's instant
  runner_restart_count: number; runner_restart_beats: number; runner_restart_exits: number; runner_restart_exit_at: string | null;
  created_by: string; created_at: string;
  output_uid: string | null;   // C1: the domain's proof an output exists to release (Session.outputUid)
  start_cause: Session["startCause"];   // capture QR v2 §5.3 (V430)
  warming_at: string | null;            // A8 (V430): the warming timeout's anchor
  ingest_read_failed: boolean;          // V430 (B7 re-review, the outage gap): the latest CLAIMED status read threw
}
/** A FUNCTION, not a module-scope fragment: building a `sql` fragment opens the pooled client, and `next build`
 *  evaluates this module (through the daily sweep's cron route) to collect route config in a process with no
 *  DATABASE_URL — PR #902's build died there, and every unit shard without a database failed to collect the suites
 *  importing it. That cron route's own test loads this module with no database to hold that. */
const cols = () => sql`id, fixture_id, org_id, mode, state, desired_state, fail_reason, end_reason, theme_id, overlay_delay_ms,
  target_id, machine_id, last_heartbeat, heartbeat_at, beat_window_at, started_at, ended_at, ending_at, max_duration_minutes,
  runner_retries, runner_attempts, runner_state, runner_name, runner_stop_requested_at,
  runner_exit_code, runner_oom_killed, runner_requested_stop, created_by, created_at, output_uid, start_cause, warming_at,
  ingest_read_failed, runner_crash_count, runner_crash_beats, runner_crash_exits, runner_crash_exit_at, runner_crash_restart_seen,
  runner_restart_count, runner_restart_beats, runner_restart_exits, runner_restart_exit_at`;

const d = (s: string | null): Date | null => (s ? new Date(s) : null);

/** A5 (lane-b carry 4): the runner's last exit lives in V410's three runner_exit_* columns — never in last_heartbeat's
 *  JSON, which every beat REPLACES (a beat landing between an observed OOM and its confirmed teardown turned machine_oom
 *  into machine_crash). All three null = no exit observed, read as `null`, which `failReasonFromExit` treats exactly as
 *  it treats an observed exit whose three facts are all null — so the mapping loses nothing. */
function exitOf(r: Pick<Row, "runner_exit_code" | "runner_oom_killed" | "runner_requested_stop">): ExitInfo | null {
  if (r.runner_exit_code === null && r.runner_oom_killed === null && r.runner_requested_stop === null) return null;
  return { exitCode: r.runner_exit_code, oomKilled: r.runner_oom_killed, requestedStop: r.runner_requested_stop };
}

function toSession(r: Row): Session {
  return {
    id: r.id, fixtureId: r.fixture_id, orgId: r.org_id, mode: r.mode, state: r.state, desiredState: r.desired_state,
    failReason: r.fail_reason, endReason: r.end_reason, runnerRetries: r.runner_retries, createdAt: new Date(r.created_at),
    startedAt: d(r.started_at), endedAt: d(r.ended_at), heartbeatAt: d(r.heartbeat_at), maxDurationMinutes: r.max_duration_minutes,
    // G1 (Task 2C re-review 1): the stale-beat WINDOW anchor (Task 2C I4, ruling A). `evaluate` times the beat from the LATER of
    // heartbeatAt and this. Dropping it here (or from cols()) is silent to tsc — a missing column reads undefined → null — and it
    // collapses the once-per-window bound to every 5 s poll; "G1: beat_window_at round-trips" is the witness.
    beatWindowAt: d(r.beat_window_at),
    // F22: when ENDING began. `evaluate` measures the ending backstop from HERE. Forgetting to map it
    // is silent — `endingAt` reads null forever and the policy quietly falls back to the wall clock,
    // which is the exact stranding F22 exists to end. The round-trip test is the only witness.
    endingAt: d(r.ending_at),
    outputUid: r.output_uid,
    // Capture QR v2 §5.3. A8: dropping warming_at here (or from cols()) is silent to tsc — it reads undefined → null and
    // the warming timeout quietly falls back to createdAt; "A8: warming_at round-trips" is the witness.
    startCause: r.start_cause, warmingAt: d(r.warming_at),
    runner: {
      // C3: ONE authority for the attempt — the persisted `runner_attempts` (create calls MADE).
      // Deriving it as `runner_retries + (state === "none" ? 0 : 1)` disagrees with the row after an
      // inline retry (the reread gives 2 where the domain rule `t.attempt === r.attempt + 1` wants 1),
      // and every retry test fails with InvalidTransition.
      state: r.runner_state, attempt: r.runner_attempts, name: r.runner_name,
      machineId: r.machine_id, stopRequestedAt: d(r.runner_stop_requested_at), lastExit: exitOf(r),
      // R2003b: dropping a column here (or from cols()) is silent to tsc — undefined reads as no crashes, and the cap never
      // fires; relay-internal-routes.test.ts "R2003b … the SEQUENCE" is the witness (its count crosses requests).
      crashes: { count: r.runner_crash_count, beats: r.runner_crash_beats, exits: r.runner_crash_exits, exitAt: d(r.runner_crash_exit_at), restartSeen: r.runner_crash_restart_seen,
        // Owed 67: the same silent-to-tsc trap — a dropped column reads undefined → the restart cap never fires; the route test's sequence is the witness.
        restarts: { count: r.runner_restart_count, beats: r.runner_restart_beats, exits: r.runner_restart_exits, exitAt: d(r.runner_restart_exit_at) } },
    },
  };
}

async function lockRow(tx: Tx, id: string): Promise<Row | null> {
  const [row] = await tx<Row[]>`select ${cols()} from fixture_stream_sessions where id = ${id} for update`;
  return row ?? null;
}
/** `exec` defaults to the pool. Inside a transaction pass the tx (m2): a pooled read nested in `sql.begin` holds the
 *  tx's connection AND takes a second one, the self-deadlock shape lib/db.ts warns about. */
async function readRow(id: string, exec: Tx | typeof sql = sql): Promise<Row | null> {
  const [row] = await exec<Row[]>`select ${cols()} from fixture_stream_sessions where id = ${id}`;
  return row ?? null;
}

/** What `readSessionDestination` needs of a session: its org, its destination row and the broadcast it streams into. */
type DestinationRow = { org_id: string; target_id: string; youtube_broadcast_id: string | null };
async function destinationRowOf(exec: Tx | typeof sql, sessionId: string): Promise<DestinationRow> {
  const [row] = await exec<DestinationRow[]>`
    select org_id, target_id, youtube_broadcast_id from fixture_stream_sessions where id = ${sessionId}`;
  if (!row) throw new Error(`stream session ${sessionId} not found`);
  return row;
}

/** YouTube Connect T11 (spec §5.2, §6.2): where a session's Cloudflare output goes, DECRYPTED for this request only. A session
 *  that names a broadcast streams to that broadcast's POOLED key (`readPooledKey`), never a key of the destination's own (an
 *  API-backed row has none); any other session to its pasted destination's key (`readTargetSecret`). Both reads are org-scoped,
 *  and the broadcast is read with a plain select and no lock: its callers (the add_output effect, which runs after `apply`'s
 *  commit, and the relay job's facts) hold no lock that the end step's broadcast → session order could cross (§6.3). A broadcast
 *  with no key cannot have been attached (`attachPrepared` matches the key), so it is refused by name, never guessed. */
export async function readSessionDestination(tx: Tx, row: DestinationRow): Promise<{ url: string; streamKey: string }> {
  if (row.youtube_broadcast_id === null) return readTargetSecret(tx, row.org_id, row.target_id);
  const [b] = await tx<{ key_id: string | null }[]>`
    select key_id from youtube_broadcasts where id = ${row.youtube_broadcast_id} and org_id = ${row.org_id}`;
  if (!b || b.key_id === null) throw new Error(`stream session: broadcast ${row.youtube_broadcast_id} has no pooled key to stream to`);
  return readPooledKey(tx, row.org_id, b.key_id);
}

/** The LOCKED destination row's source (the caller holds `lockStreamTarget`'s lock): its connection when it is API-backed, else
 *  null. What admission decides `api_backed` from (post-T3 amendment), so the session's flag and its target always agree. */
async function targetConnectionId(tx: Tx, orgId: string, targetId: string): Promise<string | null> {
  const [t] = await tx<{ connection_id: string | null }[]>`
    select youtube_connection_id as connection_id from org_stream_targets where id = ${targetId} and org_id = ${orgId}`;
  return t?.connection_id ?? null;
}

/** Persists the aggregate INCLUDING the runner sub-state — invariant 4: the
 *  intended name/attempt land here, in the same transaction as `creating`,
 *  BEFORE the create call runs (runEffects runs after commit). `lastExit` is
 *  written to V410's three runner_exit_* columns (A5) — the beat route writes
 *  last_heartbeat, so an exit kept there did not survive the next beat.
 *
 *  `state`, `end_reason` and `ending_at` move in ONE statement, and that is a
 *  correctness requirement, not tidiness: the DDL carries
 *  `fixture_stream_sessions_end_reason_state` (end_reason is null or state in
 *  ('ending','completed')), so splitting them into two UPDATEs makes the
 *  intermediate row violate the CHECK and the write fails 23514. Writing
 *  `ending_at` here is also what makes it the SAME instant as the transition —
 *  a later `update … set ending_at = now()` would anchor the backstop a few
 *  milliseconds late and, on a retried effect, move it. */
async function persist(tx: Tx, s: Session): Promise<void> {
  await tx`
    update fixture_stream_sessions
       set state = ${s.state}, desired_state = ${s.desiredState}, fail_reason = ${s.failReason}, end_reason = ${s.endReason},
           ending_at = ${s.endingAt},
           machine_id = ${s.runner.machineId}, runner_retries = ${s.runnerRetries},
           runner_state = ${s.runner.state}, runner_name = ${s.runner.name}, runner_stop_requested_at = ${s.runner.stopRequestedAt},
           runner_exit_code = ${s.runner.lastExit?.exitCode ?? null}, runner_oom_killed = ${s.runner.lastExit?.oomKilled ?? null},
           runner_requested_stop = ${s.runner.lastExit?.requestedStop ?? null},
           runner_crash_count = ${s.runner.crashes.count}, runner_crash_beats = ${s.runner.crashes.beats},
           runner_crash_exits = ${s.runner.crashes.exits}, runner_crash_exit_at = ${s.runner.crashes.exitAt},
           runner_crash_restart_seen = ${s.runner.crashes.restartSeen},
           runner_restart_count = ${s.runner.crashes.restarts.count}, runner_restart_beats = ${s.runner.crashes.restarts.beats},
           runner_restart_exits = ${s.runner.crashes.restarts.exits}, runner_restart_exit_at = ${s.runner.crashes.restarts.exitAt},
           started_at = ${s.startedAt}, ended_at = ${s.endedAt}, beat_window_at = ${s.beatWindowAt}
     where id = ${s.id}`;
  // G1: beat_window_at IS written — the stale-beat arm and the retry arm move it, and nothing else can persist it.
  // G2 (Task 2C re-review 1): heartbeat_at is NOT written here. The domain never changes heartbeatAt (only a beat
  // does), so this statement could only ECHO the value it loaded; the beat route (`heartbeat`, its bare UPDATE) is
  // the SINGLE writer of the last beat received. `lockRow` holds FOR UPDATE from load to this write, so the echo was
  // harmless today — the single-writer rule is what keeps it harmless if that lock ever narrows.
}

/** Df: the PROVISIONING-cost estimate, in minor units of EST_COST_CURRENCY.
 *
 *  **R1 estimates only what R1 MEASURES.** Two terms, both from columns this
 *  wave actually fills:
 *    • Cloudflare STORAGE, from `recording_seconds`, and
 *    • Fly COMPUTE, from `machine_seconds` × the guest actually booked.
 *
 *  DELIVERY / egress is deliberately NOT estimated. Viewer-minutes have no
 *  source anywhere in R1 — there is no player, no analytics pull, nothing that
 *  counts a watcher — so any multiplier would be a GUESS sitting in a money
 *  column. That is worse than leaving it out: a null reads as "unknown", while a
 *  fabricated integer reads as "measured", and this number will eventually be
 *  compared against a real invoice. `CLOUDFLARE_DELIVERED_MICROS_PER_MINUTE`
 *  therefore has NO consumer in R1; it stays in config.ts for the wave that
 *  ships a player. The test pins this: a session WITH viewers still estimates
 *  storage + compute only.
 *
 *  So: this is a PROVISIONING cost, not total spend, and the column comment,
 *  the `_INDEX.md` row and the organiser-facing wording must all say so.
 *
 *  Rates are integer MICRO-units (1e-6 of the currency) so the arithmetic stays
 *  exact until one final round to minor units (1e6 micros = 1 unit = 100 minor).
 *  A guest class the rates do not cover returns null — never a borrowed rate. */
export function estimateCostMinor(f: {
  recordingSeconds: number; machineSeconds: number;
  guestCpus: number | null; guestMemoryMb: number | null; guestCpuClass: string | null;
}): number | null {
  const storedMicros = (f.recordingSeconds / 60) * CLOUDFLARE_STORED_MICROS_PER_MINUTE;
  let computeMicros = 0;
  if (f.machineSeconds > 0) {
    // A passthrough session books no Machine, so it never reaches here and is storage-only —
    // which is the differential the test uses: passthrough and composed MUST differ.
    if (f.guestCpuClass !== "dedicated" || f.guestCpus === null || f.guestMemoryMb === null) return null;
    const cpu = (f.guestCpus * FLY_PERFORMANCE_CPU_MICROS_PER_MONTH * f.machineSeconds) / FLY_BILLING_SECONDS_PER_MONTH;
    // The preset price includes FLY_PERFORMANCE_INCLUDED_GB_PER_CPU per CPU; only the GB ABOVE it is billed (config.ts).
    const extraGb = Math.max(0, f.guestMemoryMb / 1024 - f.guestCpus * FLY_PERFORMANCE_INCLUDED_GB_PER_CPU);
    const ram = (extraGb * FLY_RAM_MICROS_PER_GB_MONTH * f.machineSeconds) / FLY_BILLING_SECONDS_PER_MONTH;
    computeMicros = cpu + ram;
  }
  return Math.round((storedMicros + computeMicros) / 10_000);
}

function logDecision(before: Session, dec: Decision, now: Date): void {
  for (const ev of dec.events) {
    log.info(
      { sid: before.id, fixtureId: before.fixtureId, orgId: before.orgId, state: dec.next.state, transition: `${before.state}->${dec.next.state}`,
        reason: ev.type === "SessionEnded" ? ev.reason : null, machineId: dec.next.runner.machineId, runnerState: dec.next.runner.state, event: ev.type, at: now.toISOString() },
      "stream session event",
    );
  }
}

/** Ruling 13 item 4: the facts a transition just made true, written beside
 *  the state in the same transaction. Each is `coalesce`d so a repeat never
 *  moves a timestamp. machine_seconds is computed from the events table —
 *  the FIRST `booting` runner_transition AFTER the last `destroyed` one (the
 *  attempt's boot entry), its occurred_at to NOW on entering `destroyed` (each
 *  boot billed once, M2). */
async function persistFacts(tx: Tx, before: Session, next: Session, cmd: Command, now: Date): Promise<void> {
  if (before.state !== "live" && next.state === "live") {
    await tx`update fixture_stream_sessions set live_at = coalesce(live_at, ${now}) where id = ${next.id}`;
  }
  // A8 (capture QR v2 §5.3): the instant the session ENTERED warming — the warming timeout's anchor (domain/expiry.ts),
  // so provisioning time never eats the phone's pre-flight window. Coalesced like live_at: a repeat never moves it.
  if (before.state !== "warming" && next.state === "warming") {
    await tx`update fixture_stream_sessions set warming_at = coalesce(warming_at, ${now}) where id = ${next.id}`;
  }
  if (cmd.type === "stop") {
    await tx`update fixture_stream_sessions set stop_requested_at = coalesce(stop_requested_at, ${now}) where id = ${next.id}`;
  }
  if (before.runner.state !== "creating" && next.runner.state === "creating") {
    await tx`update fixture_stream_sessions
                set runner_attempts = runner_attempts + 1, machine_region = ${RUNNER_DEFAULT_REGION},
                    guest_cpus = ${RUNNER_DEFAULT_GUEST.cpus}, guest_memory_mb = ${RUNNER_DEFAULT_GUEST.memoryMb}, guest_cpu_class = ${RUNNER_DEFAULT_GUEST.cpuClass}
              where id = ${next.id}`;
    // T10-c (Task 2C review, concern 8): an exit belongs to the attempt that was OBSERVED making it. `createStarted` keeps
    // `lastExit`, so without this a replacement that is lost WITHOUT an exit of its own (a stale beat, never a beat) fails
    // with the PREVIOUS attempt's reason — machine_oom where the plan's failure paths say machine_crash. `persist` above
    // wrote the carried value; the new attempt's intent clears the three exit columns (A5) in the same transaction, so the
    // next load reads null. Witness: "T10-c: a replacement lost by a stale beat fails machine_crash …".
    await tx`update fixture_stream_sessions set runner_exit_code = null, runner_oom_killed = null, runner_requested_stop = null where id = ${next.id}`;
  }
  if (before.runner.state !== "destroyed" && next.runner.state === "destroyed") {
    // M2 (Task 2C re-review 2): a runner can RE-ENTER destroyed with no new boot — fix round 4 takes a destroyed runner
    // through lost on a late create_ok and back on its destroy_ok. Anchoring on "the last booting row" alone added that
    // whole span a second time (and already over-counted an attempt-2 create_failed after attempt 1 booted). Only a boot
    // AFTER the last recorded entry into destroyed is still unbilled. This decision's own rows are written after
    // persistFacts, so the max(seq) below is the PREVIOUS destroyed. Witness: "machine_seconds counts each boot ONCE …".
    // The FIRST booting row past it, never the newest: `decide` writes a runner_transition for every step, same-state ones
    // included, so each look at a booting Machine is a booting→booting row (the ledger keeps them — an observation's
    // payload, R2003b's crashCount). Anchoring on the newest restarted the bill at every look (14591fb90). The window holds
    // ONE attempt (a create starts only from none or destroyed, invariant 1), so its first booting row is that attempt's
    // boot entry — and a ledger written before this fix, self rows and all, reads the same. Witness: "billing: a Machine
    // LOOKED AT N times while booting …".
    const [boot] = await tx<{ occurred_at: string }[]>`
      select b.occurred_at from fixture_stream_events b
       where b.session_id = ${next.id} and b.kind = 'runner_transition' and b.to_state = 'booting'
         and b.seq > coalesce((select max(d.seq) from fixture_stream_events d
                                where d.session_id = ${next.id} and d.kind = 'runner_transition' and d.to_state = 'destroyed'), 0)
       order by b.seq asc limit 1`;
    if (boot) {
      const seconds = Math.max(0, Math.round((now.getTime() - new Date(boot.occurred_at).getTime()) / 1000));
      await tx`update fixture_stream_sessions set machine_seconds = machine_seconds + ${seconds} where id = ${next.id}`;
    }
  }
  // Df: the cost estimate of an ENDED session, recomputed from the row whenever its Machine time can have moved: at the
  // TERMINAL transition, and again when its runner enters destroyed AFTER the end (PR #976 review I1). A session that
  // fails before its Machine is confirmed gone — the crash cap, a refusal, a warming/provision timeout, a credit refusal,
  // relay_disabled — is terminal while its runner is still lost/stopping/exited; the attempt's seconds land on the later
  // destroyed (the C27 cleanup), and an estimate frozen at the terminal transition read 0 Machine time for good (the sweep
  // re-estimates only a session with a recording). So it is an OVERWRITE — never `is null` — from the row read back inside
  // this transaction (the machine_seconds just written above included), through the one formula the sweep also overwrites
  // with: a repeat (a destroyed re-entry with no boot, a sweep before or after) lands on the same value. The STORAGE term
  // is still the sweep's to learn (`recording_seconds`, Task 12 step 5); this reads whatever it has learnt so far.
  const endedNow = !isTerminal(before.state) && isTerminal(next.state);
  const destroyedAfterEnd = isTerminal(before.state) && before.runner.state !== "destroyed" && next.runner.state === "destroyed";
  if (endedNow || destroyedAfterEnd) {
    const [f] = await tx<{ recording_seconds: number; machine_seconds: number; guest_cpus: number | null; guest_memory_mb: number | null; guest_cpu_class: string | null }[]>`
      select recording_seconds, machine_seconds, guest_cpus, guest_memory_mb, guest_cpu_class
        from fixture_stream_sessions where id = ${next.id}`;
    if (f) {
      const minor = estimateCostMinor({
        recordingSeconds: f.recording_seconds, machineSeconds: f.machine_seconds,
        guestCpus: f.guest_cpus, guestMemoryMb: f.guest_memory_mb, guestCpuClass: f.guest_cpu_class,
      });
      if (minor !== null) {
        await tx`update fixture_stream_sessions
                    set est_cost_minor = ${minor}, est_cost_currency = ${EST_COST_CURRENCY}
                  where id = ${next.id}`;
      }
    }
  }
}

/** Who asked (ruling 13; PII decision: a user id already in the system, never an IP). `phone` (capture QR v2 §6.7.1):
 *  the phone's own call, attributed to its stream code's `issued_by`. */
export interface Actor { userId: string | null; source: "client" | "admin" | "phone" }

// ---------------------------------------------------------------------------
// apply — THE seam. Effects that need the transaction run inside it
// (consume_credit); effects that need a port run after commit. The HISTORY
// rows (ruling 13) land in the same transaction as the state: a failure
// writing them rolls the state change back (the atomicity test).
// ---------------------------------------------------------------------------
export async function apply(
  sessionId: string,
  command: Command | ((s: Session, tx: Tx) => Command | null | Promise<Command | null>),
  deps: SessionDeps,
  actor?: Actor,
): Promise<Session | null> {
  const now = deps.now();
  // M6 (Task 14b review): the go-live consume rolls the org's free month over under the money lock it already holds, so
  // it needs the org's rate — a POOLED read (orgPlanKey) that must never run inside the transaction below (lib/db.ts's
  // nesting guard: a second connection per open transaction is a self-deadlock under load). So it is read HERE, and only
  // for a session that can still consume: states only move forward (domain/session.ts), and a consume is decided only
  // from `warming`, so a session seen live, ending or terminal now can never consume in this apply. The row is peeked
  // unlocked — `org_id` never changes, and `state` is only the gate for this read; the decision reads the LOCKED row.
  const [peek] = await sql<{ org_id: string; state: Session["state"] }[]>`select org_id, state from fixture_stream_sessions where id = ${sessionId}`;
  if (!peek) return null;
  // N4 (Task 14b re-review): a FAILED read must not block the apply. Most decisions from these states (Stop, every expiry)
  // never consume, so a pooled-read outage is reported and `monthly` stays unresolved: the consume guard below refuses the
  // one decision that needs the rate, by name, and the next apply retries the read.
  let monthly: { rate: number; now: Date } | undefined;
  if (CAN_STILL_CONSUME.includes(peek.state)) {
    try {
      monthly = { rate: await streamMonthlyRate(peek.org_id), now: new Date() };
    } catch (err) {
      log.error({ err: String(err), sessionId, orgId: peek.org_id, state: peek.state }, "stream session: the monthly credit rate read failed — reported; this apply decides without it and refuses a go-live consume");
      captureError(err, { orgId: peek.org_id, route: "relay.credits.apply_rate_read", extra: { sessionId, state: peek.state } });
    }
  }
  const outcome = (await sql.begin(async (tx) => {
    // A7 — LOCK ORDER. stream-credits.ts's rule is that every writer takes the org's money lock FIRST (`lockOrg`, before
    // any read), and its staff paths then take this session row (`staffRow`: lockOrg, then FOR KEY SHARE on the linked
    // session). `consumeForSession` below takes lockOrg itself, so locking the row first and consuming second is the
    // OPPOSITE order: an apply that goes live while a staff refund names this session deadlocks against it (Postgres
    // aborts one). So the org lock comes first here too, on every apply — which decisions consume is only known after
    // `decide`, and that needs the locked row. `org_id` is read without a lock because nothing ever changes it; it is
    // only the lock's key. consumeForSession's own lockOrg is then re-entrant. `recordEffect` and the projection's
    // writes take the row alone and never the org lock, so no cycle can form through them.
    // Witness: "A7 lock order: … the row stays free for a FOR UPDATE NOWAIT". (M6: the unlocked `org_id` read is the peek
    // above, before the transaction.)
    await lockOrg(tx, peek.org_id);
    const row = await lockRow(tx, sessionId);
    if (!row) return null;
    const before = toSession(row);
    // T7: a command function may READ on this transaction (never the pool — lib/db.ts's nesting guard) to re-take a
    // decision whose inputs live outside the Session (the tick's phone-lost ends: a beat, a pairing, a sample).
    const cmd = typeof command === "function" ? await command(before, tx) : command;
    // T5-a: a command function that returns null read the LOCKED row and found nothing to decide (the row moved on) —
    // write nothing, run nothing. The caller that returned null knows why and acts outside the transaction.
    if (cmd === null) return { session: before, effects: [] };
    let dec = decide(before, cmd, now);
    let applied: Command = cmd;
    if (dec.effects.some((e) => e.type === "consume_credit")) {
      // Two ways to arrive here with no rate: the read above FAILED (N4, already reported), or — "cannot happen" as a
      // guard — the peek saw a state that can no longer consume yet the LOCKED row decided a consume, which only a state
      // moved BACKWARDS between the two can do. Either way refused by name: consuming without the rollover would silently
      // draw a bought credit over this month's free one. Nothing is written; the next apply peeks and reads again.
      if (!monthly) {
        throw new HttpError(500, `Session ${sessionId} went live (${peek.state} at the rate read, ${before.state} under the lock) with no monthly credit rate resolved; refusing to consume without the monthly rollover`, "monthly_rate_unresolved");
      }
      if (before.mode === "composed" && before.outputUid === null) {
        // R2004, PR #981 review I3 — "cannot happen" as a guard: a composed session going live with NO destination output
        // (the add failed and the fail-closed path did not land, or a row seeded without one). The broadcast reaches
        // nobody, so it is never charged: refused by name, logged and reported, and the decision goes on unconsumed.
        log.error({ sid: sessionId, orgId: before.orgId, code: "composed_live_without_output" }, "stream session: a composed session went live with no destination output — the credit is NOT consumed");
        captureError(new Error(`stream session ${sessionId}: a composed session went live with no destination output — credit not consumed`),
          { orgId: before.orgId, route: "relay.credits.went_live_without_output", extra: { sessionId, code: "composed_live_without_output" } });
      } else {
        try {
          const c = await consumeForSession(tx, { orgId: before.orgId, fixtureId: before.fixtureId, sessionId, monthly }, now);
          if (c.ledgerId) await tx`update fixture_stream_sessions set credit_ledger_id = ${c.ledgerId} where id = ${sessionId}`;
        } catch (e) {
          if (!(e instanceof NoCreditsError)) throw e;
          applied = { type: "credit_refused" };
          dec = decide(before, applied, now);   // same transaction, the refusal is the state
        }
      }
    }
    await persist(tx, dec.next);
    await persistFacts(tx, before, dec.next, applied, now);
    if (actor) {
      await recordEvent(tx, { sessionId, orgId: before.orgId, source: actor.source, kind: "action", type: cmd.type, actorUserId: actor.userId, occurredAt: now, payload: { state: before.state } });
    }
    for (const r of eventRowsOf(before, dec, applied)) {
      await recordEvent(tx, { sessionId, orgId: before.orgId, source: r.source, kind: r.kind, type: r.type, from: r.from, to: r.to, payload: r.payload, occurredAt: now });
    }
    if (dec.effects.some((e) => e.type === "refund_credit")) {
      // R2008 (owner ruling 2026-10-19): the never-live cancellation returns the go-live consume, in THIS transaction — the
      // failure and the refund commit together or neither does, so a session is never failed with its credit still taken
      // nor refunded while still live. The ledger decides whether anything is owed (a free restart consumed nothing; a staff
      // refund may have returned it already), so the effect never assumes a consume; the event row records which it was (delta 0 and no ledger id: nothing was owed).
      // BOUNDED (free-gaps, owner ruling 2026-10-20): one never-live refund per fixture per reuse window — a refund the window
      // has no room for is withheld, and the event says so (`reason`), where delta 0 alone would read as "nothing was owed".
      const r = await refundConsumeForSession(tx, { orgId: before.orgId, sessionId, fixtureId: before.fixtureId, note: "R2008: the stream went live and its camera never appeared — credit returned" }, now);
      // `result` is 'ok' | 'failed' | null (V410's check): a refund the window had no room for succeeded at nothing and failed at
      // nothing — it was declined — so it claims neither (null), and the payload's `reason` says why (review m2).
      await recordEvent(tx, { sessionId, orgId: before.orgId, source: "domain", kind: "effect", type: "refund_credit", result: r.withheld ? null : "ok", occurredAt: now,
        payload: { delta: r.delta, balanceAfter: r.balance, ledgerId: r.ledgerId, ...(r.withheld ? { reason: "refund_capped" } : {}) } });
    }
    logDecision(before, dec, now);
    return { session: dec.next, effects: dec.effects.filter((e) => e.type !== "consume_credit" && e.type !== "refund_credit") };
  })) as { session: Session; effects: Effect[] } | null;
  if (!outcome) return null;
  return runEffects(outcome.session, outcome.effects, deps);
}

/** Ruling 13: every port effect's OUTCOME is a row — ok/failed, latency, the
 *  provider's status/code when it threw one — written under a short row lock
 *  after the effect (effects run post-commit by design; their result is a
 *  fact about the world, not about the row). Never throws past the effect's
 *  own error. */
async function recordEffect<T>(s: Session, type: string, source: "ingest" | "runner" | "output" | "domain" | "sweep", fn: () => Promise<T>, payload: Record<string, unknown> = {}): Promise<T> {
  const started = Date.now();
  const write = (result: "ok" | "failed", extra: Record<string, unknown>) =>
    sql.begin(async (tx) => {
      await lockRow(tx, s.id);
      await recordEvent(tx, { sessionId: s.id, orgId: s.orgId, source, kind: "effect", type, result, latencyMs: Date.now() - started,
        httpStatus: typeof extra.httpStatus === "number" ? extra.httpStatus : null, attempt: s.runner.attempt || null, payload: { ...payload, ...extra } });
    });
  try {
    const out = await fn();
    await write("ok", {});
    return out;
  } catch (err) {
    const e = err as { status?: number; code?: string; requestId?: string };
    await write("failed", { httpStatus: e.status ?? null, errorCode: e.code ?? null, requestId: e.requestId ?? null });
    throw err;
  }
}

/** A forced Machine destroy (both sites: the runner table's `force_destroy` effect, and a stale create's Machine). The
 *  PROVIDER call failing is recorded (recordEffect's `failed` row), REPORTED to Sentry and logged — and returned as
 *  `false`, never thrown at the reader (Task 11 review m5). The report is the alarm: a Machine whose destroy failed may
 *  still be running, billing and pushing to a public destination, and since m5 no route wrapper sees the error to report
 *  it (re-review N1). It names the session and the Machine — never the destination, its key or any URL.
 *
 *  Narrowed to the provider call (re-review N3): if the LEDGER write fails — recordEffect's own `write`, before or after
 *  the DELETE — nothing recorded the outcome, and that database fault is thrown on (the route wrapper reports it), carrying
 *  the provider's failure as its `cause` when the DELETE had failed first (r2-m1). Told apart by identity: only the exact
 *  error the provider call threw is caught here.
 *
 *  THIRD site, `sweep` (Task 12, A22(b)): the daily sweep's orphan pass destroys a listed Machine its session no longer
 *  owns through THIS helper — the retry owner of every forced destroy that failed at the other two sites — so its row is
 *  the same `force_destroy` effect (source `sweep`) and its failure the same alarm. The alarm names the LISTED Machine
 *  (`payload.machineName`) when the caller knows it: the row's own `runner.name` is a different attempt's there.
 *
 *  A FAILED destroy also CLEARS the session's `runner_gone_confirmed_at` (V422, A22(c)): that mark lets admission skip
 *  the provider for this session, and a Machine that survived a DELETE is exactly what admission must find again. */
type ForceDestroySite = "force_destroy" | "stale_create" | "sweep";

/** r2-m2 (Task 11 re-review): WHO retries a failed forced destroy, per site — the log line names the owner that really
 *  exists. A lost runner's teardown is re-issued by the table on its next stale beat, and a terminal session's orphan by
 *  the next admission on its fixture or destination (tearDownPriorMachines) and the daily sweep. A stale create's Machine
 *  is named by no row, so no cell ever re-issues it: the daily sweep's orphan pass (A22(b)) owns it. */
const DESTROY_RETRY_OWNER: Record<ForceDestroySite, string> = {
  force_destroy: "the runner table re-issues it while the session lives, then admission and the daily sweep",
  stale_create: "no row names this Machine, so the daily sweep's orphan pass retries it",
  sweep: "the next daily sweep retries it",
};

async function forceDestroy(
  s: Session, machineId: string, site: ForceDestroySite, payload: Record<string, unknown>, deps: SessionDeps,
): Promise<boolean> {
  const provider: { failure?: unknown } = {};
  try {
    await recordEffect(s, "force_destroy", site === "sweep" ? "sweep" : "runner", async () => {
      try {
        return await deps.drivers.runner.destroy(machineId);
      } catch (err) {
        provider.failure = err;
        throw err;
      }
    }, payload);
    return true;
  } catch (err) {
    if (!("failure" in provider) || err !== provider.failure) {
      // The ledger failed, not the provider (N3): thrown on. r2-m1: when the DELETE had failed first, its error rides as
      // `cause`, so the wrapper's one report still says a Machine may be running — the alarm below is never reached.
      if ("failure" in provider && err instanceof Error) err.cause ??= provider.failure;
      throw err;
    }
    await sql`update fixture_stream_sessions set runner_gone_confirmed_at = null where id = ${s.id} and runner_gone_confirmed_at is not null`;
    const machineName = typeof payload.machineName === "string" ? payload.machineName : s.runner.name;
    const extra = { sessionId: s.id, machineId, machineName, attempt: s.runner.attempt, site };
    captureError(err, { orgId: s.orgId, route: "relay.force_destroy", extra });
    log.error({ ...extra, err: String(err) }, `stream session: forced Machine destroy failed — recorded and reported; ${DESTROY_RETRY_OWNER[site]}`);
    return false;
  }
}

/** C1 (lane C final review; orchestrator ruling): WHERE a passthrough output release runs. `decision` is the terminal
 *  decision's own `release_output` effect; `late_add` an output whose add returned after the session ended; `admission`
 *  and `sweep` are the two retry owners of a release that failed. */
type ReleaseSite = "decision" | "late_add" | "admission" | "sweep";

/** C1: takes a passthrough session's Cloudflare OUTPUT off its input — the one thing that stops the simulcast — and marks
 *  the row `output_released_at` (V423). Never the input: it carries the recording (C2). `true` when there is nothing left
 *  to release (no output was ever recorded, or it is already released) or the removal was confirmed (a 404 counts).
 *
 *  A failure NEVER throws (orchestrator ruling): the terminal transition that asked for it has committed and stays, and
 *  the reader whose Stop or poll ran it gets its answer, not a 500. It is recorded (the `release_output` effect row, like
 *  every port effect), REPORTED to Sentry — a broadcast that may still be running is an alarm, the forceDestroy precedent
 *  — and left unmarked, which is exactly what the two retry owners select: the next admission on the same fixture or
 *  destination (`releasePriorOutputs`) and the daily sweep. The alarm names the session and the output uid (not a
 *  secret, Dg) — never the destination, its key or any URL. */
export async function releaseOutput(sessionId: string, site: ReleaseSite, deps: SessionDeps): Promise<boolean> {
  const [row] = await sql<(Row & { output_released_at: string | null; ingest_input_uid: string | null })[]>`
    select ${cols()}, output_released_at, ingest_input_uid from fixture_stream_sessions where id = ${sessionId}`;
  if (!row || row.output_uid === null || row.output_released_at !== null) return true;
  const s = toSession(row);
  const outputUid = row.output_uid;
  const extra = { sessionId, outputUid, inputUid: row.ingest_input_uid, site };
  try {
    // An output recorded with no input is not a state any writer produces (both are written by the provision/add pair);
    // a guard, not an assumption — it is reported like any failed removal rather than silently marked released.
    const inputId = row.ingest_input_uid;
    if (!inputId) throw new Error("stream session: an output is recorded with no live input to remove it from");
    await recordEffect(s, "release_output", site === "sweep" ? "sweep" : "output", () => deps.drivers.ingest.removeOutput(inputId, outputUid, { sessionId }),
      { inputUid: inputId, outputUid, reason: site });
    await sql`update fixture_stream_sessions set output_released_at = coalesce(output_released_at, ${deps.now()}) where id = ${sessionId}`;
    return true;
  } catch (err) {
    captureError(err, { orgId: s.orgId, route: "relay.release_output", extra });
    log.error({ ...extra, err: String(err) }, "stream session: passthrough output release failed — the broadcast may still be running; recorded and reported; the next admission on this fixture or destination and the daily sweep retry it");
    return false;
  }
}

/** The session has ENDED: the phone's own inputs — EVERY `camera` input of the session (Input A, and any further camera slot) —
 *  are switched OFF, so Cloudflare rejects any further push. A phone left sending after a Stop, a failure or the live limit
 *  otherwise keeps a connection open to Cloudflare for nothing. Found by role from `fixture_stream_inputs` — never
 *  `ingest_input_uid`, which is the OUTPUT input (Input B, the compositor's programme, on a composed session), and never a
 *  `programme` row — and switched OFF, never deleted: the input carries the recording (C2). A session with no camera input
 *  at the provider (it ended before it was provisioned, or the retention sweep has reclaimed it) has nothing to disable and
 *  records nothing.
 *
 *  BEST EFFORT, and it NEVER throws (the `releaseOutput` precedent), not for a provider fault and not for a database one:
 *  the terminal transition that asked for it has committed and stays, so nothing here blocks or fails the Stop, or skips the
 *  effects after it (the Machine's teardown, the replay fill). Three faults, told apart, each reported once:
 *   - the PROVIDER refused (`relay.disable_phone_input`): the input may still accept a phone. Recorded as the effect row
 *     (`failed`) and the adapter's own provider-call row with the HTTP status and Cloudflare's code;
 *   - the LEDGER failed after the provider said yes (`relay.disable_phone_input_db`, stage `ledger`): the input IS off, only
 *     its effect row is missing — never reported as a failed disable (the N3 identity test of `forceDestroy`, without its
 *     rethrow: this effect must not fail the reader);
 *   - a READ failed before any call (`relay.disable_phone_input_db`, stage `read`): nothing was attempted.
 *  A provider fault whose own ledger row then also failed is still the provider alarm — the input may still be on.
 *  One camera failing does not stop the next. No retry owner: each input belongs to ONE session (`provisionSession` makes a
 *  fresh pair per session), so nothing starts on it again, and it is reclaimed with the session's recordings by the
 *  retention sweep.
 *
 *  Idempotent at the provider (a disable of a disabled or gone input is success), and the domain emits the effect once per
 *  session — on ENTERING a terminal state — so a second Stop of an ended session decides nothing and calls nothing.
 *  `true` when no input was left on by a provider fault (and none was missed by a read fault). */
export async function disablePhoneInput(sessionId: string, deps: SessionDeps): Promise<boolean> {
  let s: Session;
  let cameras: { uid: string; slot: number }[];
  try {
    const row = await readRow(sessionId);
    if (!row) return true;
    s = toSession(row);
    cameras = await sql<{ uid: string; slot: number }[]>`
      select ingest_input_id as uid, slot from fixture_stream_inputs
       where session_id = ${sessionId} and role = 'camera' and ingest_input_id is not null order by slot asc`;
  } catch (err) {
    captureError(err, { route: "relay.disable_phone_input_db", extra: { sessionId, stage: "read" } });
    log.error({ sessionId, err: String(err) }, "stream session: the phone's input was NOT disabled — the session's rows could not be read; reported");
    return false;
  }
  let allOff = true;
  for (const { uid, slot } of cameras) {
    const extra = { sessionId, inputUid: uid, slot };
    const provider: { failure?: unknown } = {};
    try {
      await recordEffect(s, "disable_phone_input", "ingest", async () => {
        try {
          return await deps.drivers.ingest.setInputEnabled(uid, false, { sessionId, slot, role: "camera" });
        } catch (err) {
          provider.failure = err;
          throw err;
        }
      }, { inputUid: uid, slot });
    } catch (err) {
      if ("failure" in provider) {
        allOff = false;
        captureError(provider.failure, { orgId: s.orgId, route: "relay.disable_phone_input", extra: err === provider.failure ? extra : { ...extra, ledger: "unwritten" } });
        log.error({ ...extra, err: String(provider.failure) }, "stream session: the phone's input was NOT disabled — the session has ended, a phone still pushing keeps its connection until the input is reclaimed; recorded and reported");
      } else {
        captureError(err, { orgId: s.orgId, route: "relay.disable_phone_input_db", extra: { ...extra, stage: "ledger" } });
        log.error({ ...extra, err: String(err) }, "stream session: the phone's input was disabled, but its ledger row could not be written; reported");
      }
    }
  }
  return allOff;
}

/** Task 12's orphan pass (A22(b)): destroy a Machine the provider LISTS under `sessionId` that its row does not own,
 *  through the shared forceDestroy above (site `sweep`) — recorded on that session's own ledger and alarmed on failure,
 *  never duplicated here. The row is read fresh for the ledger's attempt. `null` when the row no longer exists: a
 *  sessionless Machine has no ledger to write, and the caller destroys it directly. */
export async function destroyListedMachine(
  sessionId: string, machine: { runnerId: string; name: string | null }, deps: SessionDeps,
): Promise<boolean | null> {
  const row = await readRow(sessionId);
  if (!row) return null;
  return forceDestroy(toSession(row), machine.runnerId, "sweep", { machineId: machine.runnerId, machineName: machine.name, reason: "sweep" }, deps);
}

/** I1 (lane C final review). A passthrough session leaves `warming` only when something OBSERVES its ingest connected —
 *  the organiser's poll in `currentSession`. That poll ran AFTER this expiry, and another court's create (targetHolderFor)
 *  and the daily backstop never observed at all, so a phone that connected at +1 min and was read by nobody was failed
 *  `no_inbound_timeout` at the timeout WHILE it streamed: no consume row, a false reason, the destination handed on. So
 *  before any expiry of a passthrough `warming` session, the ingest is read ONCE and a connected one goes live through
 *  the ordinary `ingest_connected` decision (which consumes the credit, or refuses it) — the expiry then finds nothing due.
 *
 *  Only when an expiry is DUE: a read with nothing to expire still asks no provider anything (G-T1's zero-call refusal).
 *  A session with no input row has nothing to observe and falls through to the expiry as before. Same input reader as
 *  the poll (one authority for which input a session has).
 *
 *  N1 (lane C re-review; orchestrator ruling): a read that THROWS — a 5xx, the network, a revoked token's 401 — is
 *  reported once and answered `true` ("the ingest is unknown"), never thrown: before N1 it escaped ahead of the expiry,
 *  so during an outage a warming session past its WALL CLOCK was never ended, kept its destination (V421), and every
 *  organiser poll and another court's start 500'd. What an unknown blocks is `heldByUnknownIngest`'s to say. */
async function observeIngestBeforeExpiry(sessionId: string, row: Row | null, deps: SessionDeps): Promise<boolean> {
  if (!row || row.mode !== "passthrough" || row.state !== "warming") return false;
  if (evaluate(toSession(row), deps.now()).kind === "none") return false;
  const input = (await sql.begin((tx) => readFirstInput(tx, sessionId))) as Awaited<ReturnType<typeof readFirstInput>>;
  const inputId = input?.ingestInputId ?? null;
  if (!inputId) return false;
  let status: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["inputStatus"]>>;
  try {
    status = await deps.drivers.ingest.inputStatus(inputId, { sessionId });
  } catch (err) {
    reportIngestReadFailure(err, { sessionId, orgId: row.org_id, inputUid: inputId, site: "expiry" });
    return true;
  }
  // G-a: a read with no evidence carries the previous poll's word. M-4 (final review; controller ruling): with NOTHING
  // to carry it reads as `unknown`, so the warming timeout runs normally. It was held like a failed read (N1), and since
  // a no-evidence read records nothing there was never anything to carry: a session whose every read said
  // `new_configuration_accepted` held its destination and fixture to the wall clock (5 h), not the 10-min warming window.
  const phone = status.state ?? carriedIngest(await latestPollSample(sessionId)) ?? "unknown";
  if (phone !== "connected") return false;
  await sql`update fixture_stream_sessions set first_ingest_at = coalesce(first_ingest_at, ${deps.now()}), ingest_protocol = coalesce(ingest_protocol, ${status.protocol}) where id = ${sessionId}`;
  await apply(sessionId, connectIfWarming, deps);
  return false;
}

/** The latest POLL sample — the one row the poll compares a new reading against (Ruling 13) and, for G-a, the phone's
 *  previous reading. Read from the DB, not from process memory, so a carry survives a restart and any number of
 *  processes. Undefined before any poll has recorded one. */
async function latestPollSample(sessionId: string): Promise<PollSample | undefined> {
  const [prev] = await sql<PollSample[]>`
    select ingest_state, output_state, sampled_at, raw->>'protocol' as protocol
      from fixture_stream_samples where session_id = ${sessionId} and source = 'poll' order by id desc limit 1`;
  return prev;
}
type PollSample = { ingest_state: string | null; output_state: string | null; sampled_at: Date; protocol: string | null };

/** D3's `since` as ONE SQL expression — the rule `currentSession` explains above its use: the first ingest_status event
 *  after the last one on the other side of ok, clamped to `live_at` and, for a non-ok word, to the phone's latest
 *  reconnect. `ok` says which side of ok the timed word is on: a literal for a poll that READ, or the sample's own column
 *  for a coalesced poll, so one rule serves both and the coalesced word and its since share a statement (I-1). */
function outputSinceExpr(sessionId: string, ok: boolean | postgres.Fragment): postgres.Fragment {
  return sql`greatest(
    (select occurred_at from fixture_stream_events
      where session_id = ${sessionId} and type = 'ingest_status'
        and seq > coalesce((select max(seq) from fixture_stream_events
                             where session_id = ${sessionId} and type = 'ingest_status'
                               and (coalesce(payload->>'outputState', '') = 'ok') <> ${ok}), 0)
      order by seq asc limit 1),
    (select live_at from fixture_stream_sessions where id = ${sessionId}),
    (select max(occurred_at) from fixture_stream_events
      where not ${ok} and session_id = ${sessionId} and type = 'ingest_status'
        and to_state = 'connected' and coalesce(from_state, '') <> 'connected'))`;
}

/** B0 fix round 1 (I-1): a coalesced poll's whole reading — the latest poll sample AND D3's `since` for its word — in ONE
 *  statement, so ONE snapshot. Read in two (the sample at the top of currentSession, the events several statements
 *  later), a reading poll's sample-and-event commit (R-1) landing between them served the OLD word timed by the NEW
 *  event: `since` fell back to live_at and the stream-key box flashed. A statement sees one snapshot under any isolation
 *  level, so nothing here depends on the transaction mode. */
async function latestPollSampleWithSince(sessionId: string): Promise<(PollSample & { since: Date | null }) | undefined> {
  const [s] = await sql<(PollSample & { since: Date | null })[]>`
    select p.ingest_state, p.output_state, p.sampled_at, p.raw->>'protocol' as protocol,
           ${outputSinceExpr(sessionId, sql`coalesce(p.output_state = 'ok', false)`)} as since
      from (select ingest_state, output_state, sampled_at, raw from fixture_stream_samples
             where session_id = ${sessionId} and source = 'poll' order by id desc limit 1) p`;
  return s;
}

/** I-1 (final review; controller ruling 2026-10-01): coalesce the organiser poll's Cloudflare reads ACROSS tabs, viewers
 *  and processes. Every open organiser fixture page polls `current` every STREAM_POLL_MS, and each poll read the input
 *  and its outputs: N tabs were N × 2 reads per 5 s against Cloudflare's account-wide API limit, and past that limit
 *  every read 429s — so no poll could observe warming → live, and the D3 box went silent.
 *
 *  The mechanism is a CONDITIONAL WRITE (V428): a poll claims the read by stamping `ingest_polled_at`, and only when the
 *  previous claim is at least POLL_CLAIM_WINDOW_MS old. Postgres re-checks the WHERE of a concurrent UPDATE against the row
 *  the winner committed, so two polls racing on one session claim it ONCE: the loser gets no row back and reads nothing.
 *  Not an advisory lock: the lock would have to be held across the two Cloudflare calls, which carry no timeout, so a
 *  slow provider would pin a pooled connection per session. A claim also coalesces the reads that FAIL (a 429 or a 5xx
 *  records no sample), which is the storm this exists to stop. The clock is deps.now(), the poll's own clock. */
async function claimIngestPoll(sessionId: string, now: Date): Promise<boolean> {
  const claimed = await sql<{ id: string }[]>`
    update fixture_stream_sessions set ingest_polled_at = ${now}
     where id = ${sessionId}
       and (ingest_polled_at is null or ingest_polled_at <= ${new Date(now.getTime() - POLL_CLAIM_WINDOW_MS)})
    returning id`;
  return claimed.length === 1;
}

/** I-1 window (controller ruling 2026-10-01: "under 5 s" meant coalescing CONCURRENT viewers, not a hard number). A lone
 *  tab polls on STREAM_POLL_MS by setInterval, so its next request lands about one interval after its own claim, give or
 *  take timer and network jitter; with the window AT the interval, a request even 1 ms early was served the previous
 *  reading and the lone viewer's Cloudflare cadence halved to 10 s. A second of allowance keeps every on-cadence poll a
 *  read while polls from other tabs inside it still coalesce. */
const POLL_JITTER_ALLOWANCE_MS = 1_000;
const POLL_CLAIM_WINDOW_MS = STREAM_POLL_MS - POLL_JITTER_ALLOWANCE_MS;

/** I-1: how old the latest poll sample may be for a poll that did NOT claim the read to answer from it — one poll
 *  interval behind the claim it deferred to (whose own sample may still be in flight). Older than that is not this
 *  poll's reading, and serving it would present a stale word as current: such a poll answers like a failed read
 *  (ingest and output null) and decides nothing. */
const COALESCED_SAMPLE_MAX_AGE_MS = 2 * STREAM_POLL_MS;

/** I-1: the stored words of a poll sample, each guarded to its port type (the poll writes only those). */
function sampledOutput(w: string | null): OutputState | null {
  return w === "ok" || w === "connecting" || w === "rejected" || w === "unknown" ? w : null;
}
function sampledProtocol(w: string | null): IngestProtocol | null {
  return w === "srt" || w === "rtmps" ? w : null;
}

/** G-a (controller ruling 2026-10-01): the word a no-evidence read (ports.ts IngestStatus.state null) carries forward —
 *  the latest poll sample's. Null when there is none; and a stored word outside the port's three is a guard, not a
 *  carry: the poll writes only those three, so anything else is not a reading this code can vouch for. */
function carriedIngest(prev: { ingest_state: string | null } | undefined): IngestState | null {
  const w = prev?.ingest_state ?? null;
  return w === "connected" || w === "disconnected" || w === "unknown" ? w : null;
}

/** N1: the ONE rule for what an unobservable ingest holds back — `warming_timeout` and nothing else. That expiry's claim
 *  is "no inbound video", which an unknown cannot support: the phone may be connected. `wall_clock` and every other
 *  expiry are claims about time or about the runner, true whatever the ingest is doing, so they still apply. */
function heldByUnknownIngest(expiry: Expiry, ingestUnknown: boolean): boolean {
  return ingestUnknown && expiry.kind === "warming_timeout";
}

/** N1: an ingest status read that threw — reported ONCE per failed read (Sentry + a log line), never thrown at the reader.
 *  Names the session and the input uid (not a secret, Dg); never a URL or key. `site` says which read: the expiry's
 *  observation or the organiser's poll. */
function reportIngestReadFailure(err: unknown, extra: { sessionId: string; orgId: string; inputUid: string; site: "expiry" | "poll" }): void {
  captureError(err, { orgId: extra.orgId, route: "relay.ingest_status", extra: { sessionId: extra.sessionId, inputUid: extra.inputUid, site: extra.site } });
  log.warn({ ...extra, err: String(err) }, "stream session: the ingest status read failed — reported; the read answers without it and the next one retries (a warming timeout is held until the ingest can be seen)");
}

/** `ingest_connected` as a T5-a command function: only a passthrough session still `warming` on the LOCKED row goes live
 *  on an observed connection; a row that moved on (stopped, expired, already live) writes nothing. Both observers use it:
 *  the expiry's (I1, above) and the organiser's poll (m1). */
function connectIfWarming(s: Session): Command | null {
  return s.mode === "passthrough" && s.state === "warming" ? { type: "ingest_connected" } : null;
}

/** One provider reading of a composed Machine, fed to the lifecycle table as the `observed` trigger — what `reconcileSession`
 *  does after the expiry and `observeRunnerBeforeGraceExpiry` does before a stop grace's. */
function applyObservation(sessionId: string, observed: Awaited<ReturnType<SessionDeps["drivers"]["runner"]["observe"]>>, deps: SessionDeps): Promise<Session | null> {
  return apply(sessionId, { type: "runner", trigger: { type: "observed", state: observed.state, exit: observed.exit, restarting: observed.restarting, restartingSince: observed.restartingSince,
    // R2003b: the exit's identity, the provider's restart count and the exit's own restart record — what the crash cap
    // counts an observed crash by
    exitAt: observed.exitAt, restartCount: observed.restartCount, exitRestarted: observed.exitRestarted } }, deps);
}

/** Measured on stg (2026-10-27, session 509ffe06): a stopped composed session's Machine exited 0 inside its grace and Fly
 *  destroyed it, but no read touched the session until the grace had run out. That read ran the expiry FIRST, so
 *  `grace_expired` force-destroyed a Machine that was already gone and the `observed` trigger that records "destroyed, exit 0"
 *  never ran — a clean stop read in the ledger exactly like a hang, and the teardown effects fired late. The table forces a
 *  destroy only "with no destroyed seen" (plan 2026-09-13 streaming-r1 §"Fly machine lifecycle"), so before a due
 *  `grace_expired` on a `stopping`/`exited` runner the Machine is read ONCE and fed to the table: a destroyed one completes
 *  the session through the ordinary observed path and the expiry then finds nothing due.
 *
 *  Only when that expiry is DUE: a read with nothing to expire asks the provider nothing extra. A read that THROWS is
 *  reported once (Sentry + a log line; the session, its Machine id and the attempt — never a URL or key) and the expiry runs
 *  as it always did — a provider outage must not leave a session in `ending`. */
async function observeRunnerBeforeGraceExpiry(sessionId: string, row: Row | null, deps: SessionDeps): Promise<void> {
  if (!row) return;
  const s = toSession(row);
  // `grace_expired` is only ever a COMPOSED stopping, exited or creating runner's, and a `creating` one holds no Machine id
  // yet (reconcileSession lists it by name) — so a runner with an id here is stopping or exited.
  const machineId = s.runner.machineId;
  if (!machineId || evaluate(s, deps.now()).kind !== "grace_expired") return;
  let observed: Awaited<ReturnType<SessionDeps["drivers"]["runner"]["observe"]>>;
  try {
    observed = await deps.drivers.runner.observe(machineId);
  } catch (err) {
    const extra = { sessionId, machineId, attempt: s.runner.attempt };
    captureError(err, { orgId: s.orgId, route: "relay.runner_observe_pre_grace", extra });
    log.warn({ ...extra, err: String(err) }, "stream session: the Machine could not be observed before its stop grace expired — reported; the expiry force-destroys it as before");
    return;
  }
  await applyObservation(sessionId, observed, deps);
}

/** The lazy expiry path (recommendation B). I1: a passthrough warming session's ingest is observed first; likewise a composed
 *  runner whose stop grace has run out has its Machine observed before the expiry may force-destroy it. */
export async function applyExpiry(sessionId: string, deps: SessionDeps): Promise<Session | null> {
  const row = await readRow(sessionId);                    // ONE read for both pre-observers (a passthrough warming row and a composed machine-holding row never overlap)
  const ingestUnknown = await observeIngestBeforeExpiry(sessionId, row, deps);
  await observeRunnerBeforeGraceExpiry(sessionId, row, deps);
  // `none` is the T5-a null command — write nothing, run nothing (post-2C-post plan sync). The committed domain REFUSES
  // `expire none` on a TERMINAL session (C27's negative pair: only `grace_expired` passes its guard), and `reconcileSession`
  // runs this on terminal rows by design — the sweep's backstop selects every terminal row whose runner is still alive, and
  // "the late create" reconciles a completed and a failed row. Handing `none` to those threw InvalidTransition out of the
  // reconcile and the whole daily sweep. On a non-terminal row `none` is `identity`, so dropping it moves nothing.
  return apply(sessionId, (s) => {
    const expiry = evaluate(s, deps.now());
    return expiry.kind === "none" || heldByUnknownIngest(expiry, ingestUnknown) ? null : { type: "expire", expiry };
  }, deps);
}

/** Expiry, then ONE observation of the Machine fed to the lifecycle table
 *  (plan §"Fly machine lifecycle" — the `observed` trigger). Every read,
 *  heartbeat, poll and admission calls this; the daily backstop too. */
export async function reconcileSession(sessionId: string, deps: SessionDeps): Promise<Session | null> {
  // M10 (Task 14b review): a deployment with NO relay (R5) cannot observe, expire on evidence, or stop anything through
  // a provider — every port of the disabled pair refuses. A session still up from before (the old fake default, or a
  // live deployment switched off) is ENDED, failed(relay_disabled), on the locked row; a terminal one is left alone.
  // Before this, a composed session's observation threw on every poll and the relay sweep skips a disabled deployment,
  // so nothing ever ended it. Money follows the domain's rules (session.ts `relay_disabled`).
  if (deps.drivers.disabled) return apply(sessionId, (s) => (isTerminal(s.state) ? null : { type: "relay_disabled" }), deps);
  const s = await applyExpiry(sessionId, deps);
  if (!s || s.mode !== "composed") return s;
  const r = s.runner;
  if (r.state === "none" || r.state === "destroyed") return s;
  // C27: a TERMINAL session whose runner is still creating/booting/playing/stopping/exited/lost
  // STILL owes one observation. `RUNNER_CLEANUP_TRIGGERS` are accepted on a terminal session — the
  // runner sub-machine advances, the session state does not. Skipping terminal rows here is what
  // left a FAILED session's Machine running until the daily orphan pass, i.e. up to 24 h of paid
  // compute for a session that ended minutes ago (and, on a stop-marked `creating` row, a Machine
  // nobody is holding the id of). The terminal guard belongs in `decide`, not in the caller.
  if (r.state === "creating") {
    // invariant 4: a process died mid-create → find OUR Machine and adopt it. T5-a: by NAME as well as session — an EARLIER
    // attempt's Machine is listed under the same session, and adopting it as this attempt's is the late cross-attempt adopt.
    const mine = (await deps.drivers.runner.list()).find((m) => m.sessionId === s.id && m.name === r.name);
    return mine ? apply(sessionId, { type: "runner", trigger: { type: "create_ok", machineId: mine.runnerId } }, deps) : s;
  }
  if (!r.machineId) return s;
  return applyObservation(sessionId, await deps.drivers.runner.observe(r.machineId), deps);
}

/** R2004, PR #981 review I3 (coordinator ruling, money): the destination output could not be added. Reported, then the
 *  session is FAILED on the locked row (`output_failed`) — which for composed also tears its Machine down (the runner's
 *  stop, then destroy: the credit refusal's teardown) — and, when it never went live, both of its inputs are deleted:
 *  nothing has broadcast into them, so they hold no recording for the delete to leak (C2), exactly the refused programme
 *  create's cleanup. A failed cleanup is reported with the uid and left to the retention sweep (the rows keep the uids).
 *  No credit: the session is terminal before anything can go live, and the went_live guard (apply) backs that. */
async function failClosedOnOutput(s: Session, inputUid: string, err: unknown, deps: SessionDeps): Promise<void> {
  captureError(err, { orgId: s.orgId, route: "relay.add_output", extra: { sessionId: s.id, mode: s.mode, inputUid } });
  log.error({ sid: s.id, mode: s.mode, inputUid, err }, "stream session: the destination output could not be added — the session fails closed");
  const failed = await apply(s.id, (cur) => (cur.state === "warming" || cur.state === "live" ? { type: "output_failed" } : null), deps);
  if (!failed || failed.startedAt !== null) return;
  const uids = (await sql<{ uid: string }[]>`
    select ingest_input_id as uid from fixture_stream_inputs where session_id = ${s.id} and ingest_input_id is not null order by role, slot`).map((r) => r.uid);
  for (const uid of uids) {
    await deps.drivers.ingest.deleteInput(uid).catch((cleanup: unknown) => {
      captureError(cleanup, { orgId: s.orgId, route: "relay.provision_cleanup", extra: { sessionId: s.id, inputUid: uid } });
      log.error({ sid: s.id, inputUid: uid, err: cleanup }, "stream session: an input of a session that failed closed was NOT deleted — the retention sweep retries it");
    });
  }
}

async function runEffects(session: Session, effects: Effect[], deps: SessionDeps): Promise<Session> {
  let current = session;
  for (const e of effects) {
    switch (e.type) {
      case "add_output": {
        const { inputId, target } = (await sql.begin(async (tx) => {
          // R2004: the session's OUTPUT input — passthrough's camera (the phone's input), composed's programme (Input B,
          // the compositor's), so a composed destination key reaches Cloudflare and never the Machine (spec §5.3).
          const input = await readFirstInput(tx, current.id, current.mode === "composed" ? "programme" : "camera");
          // T11: the pasted destination's key, or the pooled key of the broadcast an API-backed session streams into.
          return { inputId: input?.ingestInputId ?? null, target: await readSessionDestination(tx, await destinationRowOf(tx, current.id)) };
        })) as { inputId: string | null; target: { url: string; streamKey: string } };
        if (inputId) {
          let outputUid: string;
          try {
            outputUid = await recordEffect(current, "add_output", "output", () => deps.drivers.ingest.addOutput(inputId, target, { sessionId: current.id }), { inputUid: inputId });   // C9: exactly one, on the session's output input
          } catch (err) {
            // R2004, PR #981 review I3: a session with no destination fails CLOSED — never warming on, booting a Machine
            // and going live to nobody, which would consume a credit (went_live) for a broadcast no one can see.
            await failClosedOnOutput(current, inputId, err, deps);
            throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
          }
          // Dg: the slot-0 destination output's uid, beside ingest_input_uid (not a secret). The port
          // RETURNS it (Tasks 3/4); throwing that return away is what would leave the column inert.
          // coalesce so a re-run of an idempotent effect cannot move a recorded uid.
          const [after] = await sql<{ state: Session["state"] }[]>`
            update fixture_stream_sessions set output_uid = coalesce(output_uid, ${outputUid}) where id = ${current.id} returning state`;
          // C1: the session ENDED while this call was out (a Stop tapped during the add): its terminal decision read no
          // output and released nothing, so the output just made would simulcast for a session that is over. Released now.
          if (after && isTerminal(after.state)) await releaseOutput(current.id, "late_add", deps);
        }
        break;
      }
      case "release_output":
        await releaseOutput(current.id, "decision", deps);   // C1: never throws — a failure is reported and retried
        break;
      case "disable_phone_input":
        await disablePhoneInput(current.id, deps);           // never throws — a failure is reported; the Stop and the effects after it stand
        break;
      case "runner":
        current = await runRunnerEffect(current, e.effect, deps);
        break;
      case "retry_runner":
        current = await retryRunner(current, deps);
        break;
      case "complete_now":
        current = (await apply(current.id, { type: "complete" }, deps)) ?? current;
        break;
      case "fill_replay":
        await recordEffect(current, "fill_replay", "domain", () => fillReplayUrl(current.id));
        break;
      case "consume_credit":
      case "refund_credit":
        break; // ran inside apply's transaction
    }
  }
  return current;
}

/** The ONE retry: the next attempt's intent is persisted by apply (creating + name) BEFORE its create_machine effect runs.
 *  M1 (Task 2C re-review 2): the retry DECISION committed, but this effect runs after commit, and a concurrent request may
 *  have moved the row since — a late create_ok took the runner destroyed → lost (`lost × create_started` is not a cell), another
 *  reader already ran this retry (the attempt moved on), or the session ended. `decide` refuses under the row lock with
 *  InvalidRunnerTransition / InvalidTransition, and that refusal IS the answer: the retry is still owed by `lost × destroy_ok`,
 *  was already taken, or is no longer wanted. So it is a no-op that returns the row as it now stands — never a 500 out of the
 *  organiser's poll. The attempt is `current`'s (the decision's), never re-read, so a moved row cannot be re-retried here.
 *  Exported for the race witness only ("M1: a retry_runner effect whose runner moved on …"). */
export async function retryRunner(current: Session, deps: SessionDeps): Promise<Session> {
  const attempt = current.runner.attempt + 1;
  try {
    const next = (await apply(current.id, { type: "runner", trigger: { type: "create_started", name: machineNameFor(current.id, attempt), attempt } }, deps)) ?? current;
    log.warn({ sid: current.id, attempt, transition: "retry", reason: "runner_lost" }, "stream session: replacement Machine requested inline");
    return next;
  } catch (err) {
    if (!(err instanceof InvalidRunnerTransition) && !(err instanceof InvalidTransition)) throw err;
    log.info({ sid: current.id, attempt, transition: "retry_skipped", err: String(err) }, "stream session: retry refused under the row lock — the row moved on");
    const row = await readRow(current.id);
    return row ? toSession(row) : current;
  }
}

/** Runner effects run AFTER the row's transaction committed and feed their
 *  outcome back through `apply` — each is idempotent (desired vs observed). */
async function runRunnerEffect(s: Session, e: RunnerEffect, deps: SessionDeps): Promise<Session> {
  switch (e.type) {
    case "persist_intent":
      return s;   // apply already persisted `creating` + name + attempt in its transaction (invariant 4)
    case "create_machine": {
      // T5-a (Task 2C review concern 3, M5): the trigger carries no attempt, so the OUTCOME is fed to the row only while the
      // LOCKED row still names the Machine this call asked for. A create is slow; while it is out, C1 can lose the runner, the
      // destroy confirm and the retry persist attempt + 1 — and `creating × create_ok` would then adopt THIS attempt's Machine as
      // the next one's (or `booting × create_ok` would throw). Names carry the attempt (machineNameFor), so name equality is
      // attempt equality. Same name: every cell is designed for it (lost/destroyed × create_ok destroy the returned id).
      const stillOurs = (cur: Session) => cur.runner.name === s.runner.name;
      let handle: Awaited<ReturnType<typeof createRunner>>;
      try {
        handle = await recordEffect(s, "create_machine", "runner", () => createRunner(s, deps), { attempt: s.runner.attempt, machineName: s.runner.name });
      } catch (err) {
        // A3 (lane-b carry 2, owner-confirmed 2026-09-28) + A23: the PROOF is decided by the adapter, which alone knows
        // its provider's evidence, and crosses the PORT as a provider-neutral `RunnerCreateError` — this layer imports no
        // adapter. Made nothing (a refusal, a confirmed absence, a create refused before any call) or unknown; anything
        // that is not a RunnerCreateError is unknown, which the table answers with a by-name teardown before any retry.
        const trigger = { type: "create_failed" as const, ...createFailureOf(err) };
        log.error({ sid: s.id, attempt: s.runner.attempt, retryable: trigger.retryable, outcomeUnknown: trigger.outcomeUnknown, err: String(err) }, "stream session: Machine create failed");
        // A stale attempt's failure is not the current attempt's: dropped.
        return (await apply(s.id, (cur) => (stillOurs(cur) ? { type: "runner", trigger } : null), deps)) ?? s;
      }
      let foreign = false;
      const next = await apply(s.id, (cur) => {
        if (stillOurs(cur)) return { type: "runner", trigger: { type: "create_ok", machineId: handle.runnerId } };
        foreign = true;
        return null;
      }, deps);
      if (foreign) {
        // Nobody's Machine: the row never learned it, so no cell will ever destroy it — do it here, recorded like any effect.
        // A failed DELETE is recorded and ALARMED (forceDestroy) rather than thrown at the organiser's create or poll. On a
        // LIVE session it leaves a second Machine on the destination's key with no retry owner — Task 12's sweep rule
        // (destroy any listed Machine whose name's attempt is not the session's current one), routed; the alarm is what
        // tells a person meanwhile.
        log.warn({ sid: s.id, attempt: s.runner.attempt, machineId: handle.runnerId, transition: "stale_create" }, "stream session: a create returned after its attempt moved on — destroyed");
        await forceDestroy(s, handle.runnerId, "stale_create", { machineId: handle.runnerId, staleAttempt: s.runner.attempt }, deps);
      }
      return next ?? s;
    }
    case "stop_machine": {
      const id = s.runner.machineId;
      if (id) await recordEffect(s, "stop_machine", "runner", () => deps.drivers.runner.stop(id, { signal: e.signal, timeoutSeconds: e.timeoutSeconds }), { machineId: id, signal: e.signal, timeoutSeconds: e.timeoutSeconds });   // SIGINT (R0 :279); idempotent
      return s;
    }
    case "force_destroy": {
      // F15/P1-F-a: the teardown of a stop-marked `creating` session emits force_destroy with a NULL
      // machineId — the id was never learned. `if (id)` alone therefore SKIPS the destroy, the effect
      // still reports success, and the Machine leaks to the daily orphan sweep. Resolve it by NAME
      // (invariant 4 persisted `runner_name` before the create call) exactly as the crash-safe
      // reconcile does, and only then give up.
      let id = s.runner.machineId;
      if (!id && s.runner.name) {
        const mine = (await deps.drivers.runner.list()).find((m) => m.sessionId === s.id && m.name === s.runner.name);   // T5-a: THIS attempt's, by name
        id = mine?.runnerId ?? null;
      }
      // Task 11 review m5: a DELETE that fails is not the READER's error — the table owns the retry (a LOST runner's
      // teardown is re-issued on the next stale beat; a TERMINAL session's orphan is destroyed by the next admission on its
      // fixture or destination, tearDownPriorMachines, and by Task 12's daily orphan sweep once it lands). Throwing it on
      // re-issued nothing: it 500-ed the organiser's poll (or the Machine's facts read) with the provider's text at the
      // moment a stream ended, and skipped every effect after this one in the same decision (a completion's fill_replay).
      // No destroy_ok when it failed: nothing was confirmed.
      if (id && !(await forceDestroy(s, id, "force_destroy", { machineId: id }, deps))) return s;   // 404 = success (C7)
      // F-B (orchestrator ruling, post-2C-post plan sync): this effect runs after commit, and while the DELETE was out another
      // request may have confirmed this attempt's Machine gone (an observed `destroyed`) and run the ONE retry — the row now names
      // attempt + 1 in `creating` or `booting`, where `destroy_ok` is ✗ (InvalidRunnerTransition: a 500 out of the organiser's
      // poll). So the confirmation is fed only while the LOCKED row still names the Machine this effect was issued for — the
      // T5-a null-command form. Name equality is exact: names carry the attempt, every force_destroy-issuing cell leaves the
      // runner `lost`/`destroyed` at the SAME attempt and name, and only `destroyed × create_started` leaves those states, with
      // the next attempt's name. Otherwise the provider call above is already a recorded effect row and the confirmation is dropped.
      const stillOurs = (cur: Session) => cur.runner.name === s.runner.name;
      return (await apply(s.id, (cur) => (stillOurs(cur) ? { type: "runner", trigger: { type: "destroy_ok" } } : null), deps)) ?? s;
    }
  }
}

/** The job token is minted here and travels ONLY in the create call's env (invariant 5). */
async function createRunner(s: Session, deps: SessionDeps) {
  // Task 12 n1: everything the port call needs is built FIRST, and a throw while building it provably sent nothing — so it
  // is the port's made-nothing failure (`createRefusedBeforeCall`), never a plain Error the create catch must read as
  // outcome UNKNOWN (which ran lost → force_destroy → retry → the same refusal, alarming on every attempt).
  let spec: RunnerSpec;
  try {
    // #983 review r1: the token names THIS attempt (`att`), so a beat this Machine sends after a retry superseded it is
    // told from the replacement's. Each create mints its own: the retry's create_machine runs this again with attempt + 1.
    const jobToken = await mintRelayToken({ sid: s.id, scope: "relay-job", expiresAt: relayTokenExpiry(s), attempt: s.runner.attempt });
    // A2 (lane-b carry 1): the Machine's hard stop is `runnerDeadlineOf` — the session's wall clock PLUS
    // MAX_ANCHOR_DRIFT_SECONDS (whole-branch review I1). `deadlineOf` would let the Machine's own clock, which can run
    // ahead of ours, cut the broadcast before the session's wall-clock expiry ends it cleanly. Witness: "A2: …".
    // I1: the deployment's identity rides on the Machine — the daily sweep's only licence to destroy it later. In live
    // mode `relayEnvironment` REFUSES an unset ENV_NAME, so an untagged Machine is never created.
    spec = { sessionId: s.id, attempt: s.runner.attempt, environment: relayEnvironment(), jobToken, appUrl: deps.appUrl, guest: RUNNER_DEFAULT_GUEST, region: RUNNER_DEFAULT_REGION, deadlineAt: runnerDeadlineOf(s) };
  } catch (err) {
    throw createRefusedBeforeCall(err);
  }
  return deps.drivers.runner.create(spec);
}

// ---------------------------------------------------------------------------
// Admission (C3 + B: reservations exclude sessions the policy already expires)
// ---------------------------------------------------------------------------
/** G7 (lane C A22(d)): Cloudflare reports storage in FRACTIONAL minutes (R0 measured `totalStorageMinutes` 396.84 and
 *  33.31), and every column that records it is an INTEGER (V410: `storage_minutes_at_admission`, and the snapshot's
 *  used/limit/reserved/headroom, whose CHECK is `headroom = limit − used − reserved`). Postgres refuses a fraction for an
 *  integer parameter outright (22P02), so an unfitted number failed EVERY start and every sweep snapshot. The ONE place
 *  the reading is fitted, for admission and the sweep alike, and conservatively: `used` rounds UP and the limit DOWN, so
 *  the headroom computed from the fitted pair can only UNDER-state the room — never admit a match the account cannot hold.
 *  Integers pass through untouched. */
export function storageUsageForColumns(u: StorageUsage): StorageUsage {
  return { totalStorageMinutes: Math.ceil(u.totalStorageMinutes), totalStorageMinutesLimit: Math.floor(u.totalStorageMinutesLimit), videoCount: u.videoCount };
}

/** C3 + R2004: every session's claim on the one recording pool, per session (exported for its test — the pool is the
 *  whole database's, so a test reads its OWN rows out of this, never the sum).
 *
 *  THE START the rules below count from is `warming_at` — the instant the session entered `warming`, i.e. the inputs were
 *  provisioned and the camera's credentials issued. It is the earliest instant the camera input CAN record: a phone can
 *  publish to input A as soon as it is paired, which is during warming and BEFORE the session goes live (`started_at`
 *  would under-count a composed session's camera by its whole warming time — up to WARMING_TIMEOUT_MINUTES, 10, past
 *  which the session fails), and `first_ingest_at` is never written for a composed session at all (only the passthrough
 *  poll writes it). Counting from `warming_at` can over-count the programme input B by at most that warming window and a
 *  passthrough input (which records only while connected) likewise — an over-statement of a few minutes, never an
 *  under-statement of the camera. A session with no `warming_at` has no start because it never warmed: running, that is
 *  elapsed 0 (the buffer only — it has not begun); ended, it recorded nothing and reserves 0 (review of PR #1041, m3).
 *  A warmed session whose `ended_at` is missing is the unreadable case, and falls back to the WHOLE booking (never 0).
 *
 *   - a RUNNING session reserves, per recording it makes (`reservationMinutes`; one for passthrough, two for composed —
 *     owner ruling 2026-10-18, option (a): the camera (A) keeps recording so the phone's delivery watch keeps its HLS, and
 *     the programme (B) records the product), `min(maxDurationMinutes, ceil(minutes since the start) + RESERVATION_BUFFER_MINUTES)`
 *     — owner ruling 2026-10-26 (E1, "30 mins buffer"). This AMENDS the 2026-10-18 ruling's "a full match per recording
 *     while it runs": the reservation rolls with the stream instead of claiming 2 × 300 the moment it starts, so a new
 *     start needs only RECORDINGS_PER_SESSION × 30 (composed 60, passthrough 30) of headroom. The price is that a
 *     reservation no longer guarantees a full booking, so the pool CAN be overcommitted by streams that run long together;
 *     that is reported (`reportStorageOvercommit`) and never enforced against a running stream;
 *   - an ENDED composed session keeps the camera's share until the daily sweep has deleted A's recordings
 *     (`fixture_stream_inputs.recordings_deleted_at`, written by the daily sweep's camera pass, phase 1c) — the 2026-10-18
 *     ruling's "released once A's recording is deleted", which STANDS. Owner ruling 2026-10-26 ("C") amends HOW MUCH it
 *     keeps: only the minutes the session actually ran (start to `ended_at`), rounded UP to a whole minute and capped at
 *     the booking (`endedCameraReservationMinutes`) — not a whole match, so a 6-minute stream no longer holds 300 until
 *     the sweep (owner, stg 2026-10-26: 70.6 of 1000 minutes used and "Go live" refused for storage). A warmed session
 *     whose end is missing or unreadable is the whole booking, never 0. Bounded by the retention horizon (ended +
 *     RECORDING_RETENTION_DAYS): by then retention has deleted every recording that old, so a delete that never succeeds
 *     cannot hold the pool forever. A camera input the provider never made recorded nothing and reserves nothing. Once the
 *     camera's recording is finalised Cloudflare's own usage counts it too, so until the sweep deletes it a composed match's
 *     camera is counted twice — an under-statement of the room;
 *   - for the FINALISATION GRACE after `ended_at` (`FINALISATION_GRACE_SECONDS`: the ingest hold window plus a cautious processing allowance) EVERY recording of
 *     an ended session keeps its span reserved — composed twice (the camera and the programme), passthrough once (review I1
 *     of PR #1041, owner-directed 2026-10-26). R0 F2: an in-progress recording is counted by NOTHING in `storage-usage`; its
 *     minutes land in one lump when Cloudflare finalises it, that long after the input disconnects. Without this window
 *     the programme (and a passthrough recording) vanished from the pool at the instant a match ended and reappeared in
 *     Cloudflare's usage ~3 minutes later — exactly while the next match's start is being admitted. After it the programme
 *     and the passthrough recording are in the usage and stop reserving, and only the composed camera remains, as above.
 *     Everything is counted from the same `warming_at` span (`endedReservationMinutes`), an over-statement for the
 *     programme (which starts after the camera) and for a passthrough input, never an under-statement. */
export async function storageReservations(exec: Tx | typeof sql, now: Date): Promise<{ sessionId: string; minutes: number }[]> {
  const rows = await exec<Row[]>`select ${cols()} from fixture_stream_sessions where state in ${sql([...ACTIVE_STATES])}`;
  const running = rows
    .map(toSession)
    .filter((s) => { const x = evaluate(s, now).kind; return x === "none" || x === "stale_beat" || x === "grace_expired"; })   // a Machine being replaced or flushed still records
    .map((s) => ({ sessionId: s.id, minutes: reservationMinutes(s.mode, s.maxDurationMinutes, elapsedMinutesSince(s.warmingAt, now)) }));
  const horizon = new Date(now.getTime() - RECORDING_RETENTION_DAYS * 86_400_000);
  // An ENDED session is read when its recordings are still finalising (any mode: `ended_at` newer than the grace) or when it is
  // a composed one whose camera recording is still held. The amount is the domain's (`endedReservationMinutes`); a session that
  // reserves nothing (never warmed, or past the grace with the camera released) is absent from the read.
  const finalisingSince = new Date(now.getTime() - FINALISATION_GRACE_SECONDS * 1000);
  const ended = await exec<{ id: string; mode: "passthrough" | "composed"; max_duration_minutes: number; warming_at: string | null; ended_at: string | null; camera_held: boolean }[]>`
    select * from (
      select s.id, s.mode, s.max_duration_minutes, s.warming_at, s.ended_at,
             exists (select 1 from fixture_stream_inputs i
                      where i.session_id = s.id and i.role = 'camera' and i.ingest_input_id is not null and i.recordings_deleted_at is null) as camera_held
        from fixture_stream_sessions s
       where s.state in ${sql([...TERMINAL_STATES])} and coalesce(s.ended_at, s.created_at) > ${horizon}
    ) t
     where t.ended_at > ${finalisingSince} or (t.mode = 'composed' and t.camera_held)`;
  const settled = ended
    .map((e) => ({ sessionId: e.id, minutes: endedReservationMinutes({
      mode: e.mode, warmingAt: d(e.warming_at), endedAt: d(e.ended_at), maxDurationMinutes: e.max_duration_minutes, now, cameraHeld: e.camera_held }) }))
    .filter((r) => r.minutes > 0);
  return [...running, ...settled];
}

/** Owner ruling 2026-10-26 (E1): the pool's reading when the reservations outrun it. Pure of the database so the report's
 *  numbers are its test's to pin. NUMBERS ONLY — minutes and a count; no session, org or fixture id rides along. */
export function reportStorageOvercommit(a: { source: "admission" | "sweep"; usage: StorageUsage; reservedMinutes: number; reservingSessions: number; headroomMinutes: number }): void {
  log.warn({ source: a.source, headroomMinutes: a.headroomMinutes, usedMinutes: a.usage.totalStorageMinutes, limitMinutes: a.usage.totalStorageMinutesLimit,
    reservedMinutes: a.reservedMinutes, reservingSessions: a.reservingSessions }, "relay storage: the reservations exceed the pool — overcommitted");
  captureError(new Error("relay storage overcommitted: reservations exceed the recording pool"), { route: "relay.storage_overcommitted", extra: {
    source: a.source, headroomMinutes: a.headroomMinutes, usedMinutes: a.usage.totalStorageMinutes, limitMinutes: a.usage.totalStorageMinutesLimit,
    reservedMinutes: a.reservedMinutes, reservingSessions: a.reservingSessions } });
}

/** limit − used − Σ reservations. `source`, when given, names the pass reading it (an admission or the daily sweep), and a
 *  NEGATIVE result is then reported ONCE for that read as `relay.storage_overcommitted` (E1: a reservation no longer
 *  guarantees a full booking, so streams that run long together can outgrow the pool). Reporting never throws, never
 *  refuses and never touches a running stream — the headroom is returned either way. */
export async function storageHeadroomMinutes(exec: Tx | typeof sql, usage: StorageUsage, now: Date, source?: "admission" | "sweep"): Promise<number> {
  const reservations = await storageReservations(exec, now);
  const headroom = headroomAfterReservations(usage, reservations.map((r) => r.minutes));
  if (source !== undefined && headroom < 0) {
    try {
      reportStorageOvercommit({ source, usage, headroomMinutes: headroom, reservingSessions: reservations.length,
        reservedMinutes: reservations.reduce((n, r) => n + r.minutes, 0) });
    } catch (err) {
      log.error({ err: String(err) }, "relay storage: the overcommit report itself failed — the headroom is returned regardless");
    }
  }
  return headroom;
}

async function fixtureContext(fixtureId: string): Promise<{ orgId: string; competitionId: string }> {
  const [row] = await sql<{ org_id: string; competition_id: string }[]>`
    select c.org_id, c.id as competition_id from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
     where f.id = ${fixtureId}`;
  if (!row) throw new HttpError(404, "fixture not found");
  return { orgId: row.org_id, competitionId: row.competition_id };
}

async function activeSessionIdFor(fixtureId: string, exec: Tx | typeof sql = sql): Promise<string | null> {
  const [row] = await exec<{ id: string }[]>`
    select id from fixture_stream_sessions where fixture_id = ${fixtureId} and state in ${sql([...ACTIVE_STATES])} limit 1`;
  return row?.id ?? null;
}

/** The DESTINATION guard (gap 4; owner-directed 2026-09-27 from `_SCENARIO-2026-09-27-court-bound-device.md`, gap item 2).
 *  `target_id` is org-scoped with no court or fixture binding, so two DIFFERENT fixtures may name one `org_stream_targets`
 *  row and push the same RTMPS key: YouTube accepts one broadcast per key, so the second is refused or fights the first and
 *  the organiser reads "the stream did not start" with nothing in our data explaining it.
 *
 *  V421's `fixture_stream_sessions_one_active_target` is the REAL guard — the only one that survives a second writer, the
 *  same reason `fixture_stream_sessions_one_active` and `org_stream_credits_idempotency_key` are indexes and not code (Task
 *  7's m22 measured it: one key racing on two orgs holds two different money locks, both writers miss the lookup, and the
 *  INDEX refuses the loser). This read is the refusal ON TOP of it, so the organiser gets a sentence instead of a 23505 and
 *  a refused start makes no provider call at all.
 *
 *  It is deliberately NOT a new `admit` refusal: `admit` is Task 2A's committed pure function, and knowing WHO holds a
 *  destination is a database read, which `admit` by contract cannot do. So the refusal is thrown here and `refuse`'s switch
 *  over `admit`'s verdicts is untouched.
 *
 *  LAZY FIRST, then refuse (recommendation B; AGENTS.md failure class 13 — an idempotency guard that also swallowed a
 *  legitimate arrival). Every non-terminal holder is run through `applyExpiry` BEFORE anything is refused, because a holder
 *  the expiry policy already expires is not holding the destination — it is a crashed session nobody has read yet, and
 *  refusing on it would brick a paid destination until Task 12's daily sweep. On a holder `evaluate` answers `none` for,
 *  `applyExpiry` is the T5-a null command: nothing is written and no effect runs, which is why G-T1 still sees zero
 *  provider calls.
 *
 *  This fixture's OWN active session is excluded — `is distinct from`, so a holder whose fixture was DELETED
 *  (`fixture_id` is `on delete set null`, G2) still counts and simply cannot name a court. A second session on THIS
 *  fixture is `active_session`, which `admit` already answers and whose refusal the API, the Phone tab and the four
 *  dictionaries already carry; answering `target_in_use` there would send the organiser to the wrong screen.
 *
 *  The `org_stream_targets` join is also the tenancy floor: a target belonging to another org yields no holder, and the
 *  later `admit` answers 404 `target_not_found` from `targetBelongsToOrg`. This function never leaks another org's state. */
async function targetHolderFor(targetId: string, orgId: string, fixtureId: string, deps: SessionDeps): Promise<TargetHolder | null> {
  // T3 (M2, B1 review): the ONE holder query (stream-target-holders.ts `holderRows`) — Go live, the Directory list and
  // Replace key / Remove share one source for "held by a live or waiting match", so they cannot diverge.
  const first = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  if (first.length === 0) return null;
  for (const h of first) await applyExpiry(h.sessionId, deps);      // B: this start attempt IS the tick for the holder too
  const [still] = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  return still ?? null;
}

/** YouTube Connect T3 (spec §5.2): the cross-fixture arm of both prior-teardown queries below — "any terminal session on THIS
 *  destination, whichever fixture it was made for" — holds only for a PASTED destination, where a Machine or an output on
 *  the key fights the next publisher. An API-backed destination (a connection) streams several matches at once, each on its
 *  own pooled key, and its exclusivity is the key's (§5.4); another fixture's leftover there is neither destroyed nor
 *  retried from this admission, and refuses nothing. The fixture's OWN sessions stay in scope either way (the other arm).
 *  Decided by the TARGET's source (`youtube_connection_id`), in the caller's org. A target that is not this org's, or is
 *  gone, is not API-backed as far as this fragment can tell, so it keeps today's behaviour (`admit` answers it 404). */
const pastedTarget = (orgId: string, targetId: string) => sql`not exists (
  select 1 from org_stream_targets x where x.id = ${targetId} and x.org_id = ${orgId} and x.youtube_connection_id is not null)`;

/** 2C-post m5 (Task 2C-post review m5; post-2C-post plan sync). The fixture's one-active index releases the moment a session
 *  goes terminal — since F-A a stop whose Machine never auto-destroyed completes at grace + slack — whether or not that
 *  Machine's destroy was ever CONFIRMED: a force_destroy whose DELETE threw leaves the row completed + destroyed, and nothing
 *  lazy re-issues it. Invariant 1 is untouched, because the Machine NAME is per session (`relay-<sid>-r<n>`). The DESTINATION
 *  is not per session: a new session on the same fixture normally pushes to the same `org_stream_targets` row — the same RTMP
 *  stream key — and two publishers on one key fight on the platform's side. So admission applies Task 12's ORPHAN rule (a
 *  Machine the provider still lists whose session is terminal is destroyed) to THIS fixture's sessions, lazily, before
 *  `admit`: each such Machine is destroyed now, recorded as a `force_destroy` effect row on its own session. It answers the
 *  id of a session whose destroy FAILED — `admit` then refuses `active_session` naming it, which is the truth (that session's
 *  broadcast may still be running) and reuses the refusal the API, the Phone tab and its four dictionaries already carry —
 *  or null. The provider is asked ONLY when the fixture — or the destination, below — has a terminal composed session that
 *  ever held a runner, so a start while composed is off (and FLY_API_TOKEN may be absent) never calls it. It destroys
 *  directly and feeds nothing to `decide` (T12-a's rule): a terminal row's runner converges on its next reconcile or the backstop.
 *
 *  I1 (Task 10 fix round 1 + addendum). The DESTINATION is the unit of exclusivity (V421), and a Machine pushes to the
 *  destination's key whichever fixture it was made for — so the query also covers every terminal composed session on THIS
 *  target (`fixture_id = $f OR target_id = $t`, inside the caller's org; the target arm is for a PASTED destination only — `pastedTarget`). A TERMINAL session's still-listed Machine is an
 *  orphan by Task 12's rule whichever fixture it belongs to, so admission destroys it now rather than waiting for the daily
 *  sweep — refusing without trying would brick the destination for the next match on that court until then (failure class
 *  13; orchestrator ruling reversed 2026-09-28 on that reasoning). Each attempt is the SAME force_destroy effect row on the
 *  ended session either way, carrying `reason: "admission"` and the ADMITTING fixture, so its ledger says who destroyed it
 *  and why. Only a destroy that FAILS decides the refusal: this fixture's → `active_session` naming it (2C-post m5), another
 *  fixture's → `target_in_use` naming its court (`otherFixture`; a fixture-less session, its fixture deleted, is another
 *  fixture's). An ACTIVE session is never in this query: an active holder on another fixture was already refused, untouched,
 *  by `targetHolderFor`, and this fixture's own active session is refused `active_session` by `admit` — a live Machine is
 *  never destroyed from an admission.
 *
 *  A22(c) (Task 10 minor n1, V422): a row the daily sweep CONFIRMED gone — runner `destroyed` AND
 *  `runner_gone_confirmed_at` set, both — is left out, so a start whose every prior Machine is confirmed gone never asks
 *  the provider: a Fly outage no longer 500s a PASSTHROUGH start on a fixture whose old Machine died days ago. Both halves
 *  are read, never the mark alone: a late create_ok moves a marked row's runner `destroyed → lost`, which puts it back
 *  here whatever the column holds, and a forced destroy that fails clears the mark (forceDestroy). */
async function tearDownPriorMachines(
  fixtureId: string, targetId: string, orgId: string, deps: SessionDeps,
): Promise<{ sameFixture: string | null; otherFixture: Holder | null }> {
  // ONE read carries each row's destination label and court (the target FK is `not null` and restricts deletes, so the
  // inner join drops nothing): a refusal never needs a second read that could find the row gone.
  const prior = await sql<(Row & TerminalHolderRow)[]>`
    select p.*, t.label as holder_label, c.name as holder_court, ${terminalHolderCols()}
      from (select ${cols()} from fixture_stream_sessions
             where org_id = ${orgId} and (fixture_id = ${fixtureId} or (target_id = ${targetId} and ${pastedTarget(orgId, targetId)}))
               and mode = 'composed' and runner_state <> 'none' and state in ${sql([...TERMINAL_STATES])}
               and not (runner_state = 'destroyed' and runner_gone_confirmed_at is not null)) p
      join org_stream_targets t on t.id = p.target_id
      left join fixtures f on f.id = p.fixture_id
      left join courts c on c.id = f.court_id
      ${terminalHolderJoins()}`;
  if (prior.length === 0) return { sameFixture: null, otherFixture: null };
  const bySession = new Map(prior.map((r) => [r.id, { s: toSession(r), holder: terminalHolder(r) }] as const));
  const listed = (await deps.drivers.runner.list()).flatMap((m) => {
    const hit = m.sessionId ? bySession.get(m.sessionId) : undefined;
    return hit ? [{ m, ...hit }] : [];
  });
  for (const { m, s, holder } of listed) {
    try {
      await recordEffect(s, "force_destroy", "runner", () => deps.drivers.runner.destroy(m.runnerId), { machineId: m.runnerId, machineName: m.name, reason: "admission", fixtureId });
    } catch (err) {
      // r2-m3 (Task 11 re-review): a Machine that survived this DELETE may still be pushing to the destination — the same
      // alarm as forceDestroy's (route, extra shape), site `admission`, beside the 409 the organiser sees.
      captureError(err, { orgId, route: "relay.force_destroy", extra: { sessionId: s.id, machineId: m.runnerId, machineName: m.name, attempt: s.runner.attempt, site: "admission" } });
      if (s.fixtureId !== fixtureId) {
        log.warn({ sid: s.id, fixtureId, holderFixtureId: s.fixtureId, targetId, machineId: m.runnerId, err: String(err) }, "stream session: another fixture's ended session still has a Machine on this destination and its destroy failed — start refused");
        return { sameFixture: null, otherFixture: holder };
      }
      log.warn({ sid: s.id, fixtureId, machineId: m.runnerId, err: String(err) }, "stream session: a previous session's Machine is still listed and its destroy failed — start refused");
      return { sameFixture: s.id, otherFixture: null };
    }
  }
  return { sameFixture: null, otherFixture: null };
}

/** C1 (lane C final review; orchestrator ruling — mirror tearDownPriorMachines). A session that ended with
 *  its output release FAILED may still be simulcasting to its destination, and V421's one-active index covers active
 *  states only — so a new session on the same destination would add a SECOND output to the same key while the first
 *  phone still publishes. Admission therefore retries the release first, for every terminal session of THIS
 *  fixture or on THIS pasted destination (inside the caller's org; an API-backed one is exempt, `pastedTarget`) whose output is recorded and not released — either mode since
 *  R2004 (a composed session's output is on its programme input) — and refuses only
 *  when the retry fails: this fixture's → `active_session` naming it, another fixture's → `target_in_use` naming its
 *  court — the same two refusals, for the same reason, as a Machine that survived its destroy. The provider is asked
 *  only when such a row exists, so an ordinary start makes no extra call. */
async function releasePriorOutputs(
  fixtureId: string, targetId: string, orgId: string, deps: SessionDeps,
): Promise<{ sameFixture: string | null; otherFixture: Holder | null }> {
  const prior = await sql<({ id: string; fixture_id: string | null } & TerminalHolderRow)[]>`
    select s.id, s.fixture_id, t.label as holder_label, c.name as holder_court, ${terminalHolderCols()}
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      left join fixtures f on f.id = s.fixture_id
      left join courts c on c.id = f.court_id
      ${terminalHolderJoins()}
     where s.org_id = ${orgId} and (s.fixture_id = ${fixtureId} or (s.target_id = ${targetId} and ${pastedTarget(orgId, targetId)}))
       and s.state in ${sql([...TERMINAL_STATES])}   -- R2004: either mode holds an output (composed's on its programme input)
       and s.output_uid is not null and s.output_released_at is null
     order by s.created_at`;
  for (const p of prior) {
    if (await releaseOutput(p.id, "admission", deps)) continue;
    if (p.fixture_id !== fixtureId) {
      log.warn({ sid: p.id, fixtureId, holderFixtureId: p.fixture_id, targetId }, "stream session: another fixture's ended session may still be broadcasting on this destination and its output release failed — start refused");
      return { sameFixture: null, otherFixture: terminalHolder(p) };
    }
    log.warn({ sid: p.id, fixtureId }, "stream session: this fixture's previous session may still be broadcasting and its output release failed — start refused");
    return { sameFixture: p.id, otherFixture: null };
  }
  return { sameFixture: null, otherFixture: null };
}

/** The `target_in_use` refusal, ONE shape for every holder — an active session (`targetHolderFor`) and another fixture's
 *  ENDED session whose still-listed Machine (I1) or unreleased output (C1) admission could not take down. `code` is what
 *  the client acts on (Task 13's `CreateErrorCode`). The MESSAGE names the holder because "in use" alone sends an
 *  organiser hunting; it is the operator's line in the log and in Sentry. The client never renders `err.message`: it
 *  renders the dictionary copy from the machine-readable `extra` `{ holder }` (Task 11's controller ruling, widened by
 *  T3 to the match). SAME-ORG BY CONSTRUCTION: every producer reads only the caller's org (`holderRows`:
 *  `t.org_id = $org`; `tearDownPriorMachines` / `releasePriorOutputs`: `org_id = $org`), and a session can only
 *  reference a target `admit` proved is the org's — so the extra never names another organisation's fixture. The
 *  holder's SESSION id is deliberately not in it (`wireHolder`): nothing a client does with it.
 *  An ACTIVE holder comes from `holderRows`; a TERMINAL one is built by `terminalHolder` below. */
type Holder = Pick<TargetHolder, "sessionId" | "label" | "courtName" | "fixtureId" | "href" | "matchNo" | "state">;

/** T3 (spec §5.5): the extra is `wireHolder`'s — the SAME shape the Directory's `TARGET_IN_USE` sends — so the client
 *  names the match (`matchNo`, rendered through the locale's own breadcrumb.match), links its page (`href`) and says
 *  whether a phone is live or awaited (`state`). The message is the operator's line: the match when it has a number,
 *  else the court, else the fixture id. */
function targetInUse(h: Holder): HttpError {
  const where = h.matchNo !== null ? `match ${h.matchNo}` : h.courtName ? `court ${h.courtName}` : `fixture ${h.fixtureId ?? "(deleted)"}`;
  return new HttpError(
    409,
    `the destination "${h.label}" is already streaming for ${where}${h.matchNo !== null && h.courtName ? ` (court ${h.courtName})` : ""}`,
    "target_in_use",
    { holder: wireHolder(h) },
  );
}

/** The terminal holder's extra columns — the holder fixture's number and the slugs of its organiser page — read through
 *  the same left joins `holderRows` uses (a deleted fixture leaves them all null). */
interface TerminalHolderRow {
  holder_label: string; holder_court: string | null;
  fixture_no: number | null; org_slug: string | null; comp_slug: string | null; div_slug: string | null;
}
const terminalHolderCols = () => sql`f.fixture_no, o.slug as org_slug, comp.slug as comp_slug, d.slug as div_slug`;
const terminalHolderJoins = () => sql`
      left join divisions d on d.id = f.division_id
      left join competitions comp on comp.id = d.competition_id
      left join organizations o on o.id = comp.org_id`;

/** An ENDED session whose Machine (`tearDownPriorMachines`) or output (`releasePriorOutputs`) may still be on air. It
 *  reads `live`: to a person, the destination is still receiving from that match, whatever the row's state says. */
function terminalHolder(r: TerminalHolderRow & { id: string; fixture_id: string | null }): Holder {
  return {
    sessionId: r.id, label: r.holder_label, courtName: r.holder_court, fixtureId: r.fixture_id, matchNo: r.fixture_no,
    href: holderHref(r), state: "live",
  };
}

function refuse(refusal: Exclude<ReturnType<typeof admit>, { ok: true }>, headroom: number): never {
  switch (refusal.refusal) {
    // R2001: the deployment cannot run a composed session (no compositor image, or no relay) — the ingest's 503 family.
    case "composed_unavailable": throw new HttpError(503, "composed streaming is not available on this deployment", "composed_unavailable");
    case "plan_lacks_overlay": throw new PaymentRequiredError(RELAY_PLAN_GATES.overlay);
    case "overlay_required": throw new HttpError(409, "phone streaming needs the overlay tier", "overlay_required");
    case "plan_lacks_relay": throw new PaymentRequiredError(RELAY_PLAN_GATES.relay);
    case "no_credits": throw new HttpError(402, "This organisation has no match credits", "no_credits", { featureKey: RELAY_PLAN_GATES.relay });
    case "target_not_found": throw new HttpError(404, "stream target not found");
    case "storage_exhausted": throw new HttpError(503, "recording storage is exhausted; no new stream can start", "storage_exhausted", { headroomMinutes: headroom });
    case "active_session": throw new HttpError(409, "a session is already running for this fixture", "active_session", { sessionId: refusal.activeSessionId ?? null });
    // W5 / T10 (capture QR v2 §6.7.1): nothing to stream from — the organiser pairs a phone before anything is weighed.
    case "phone_not_paired": throw new HttpError(409, "no phone is paired on this match's stream code", "phone_not_paired");
    // Owner ruling 2026-10-09 (Option 1): a phone IS paired but has gone silent (§6.9) — woken, not rescanned.
    case "phone_not_responding": throw new HttpError(409, "the phone paired on this match's stream code is not responding", "phone_not_responding");
  }
}

/** B2: a saved key that will not open (a KEK change, a damaged byte) is the organiser's to fix — a typed 422 naming the
 *  remedy, logged with the fixture, target and kind only. Any other error (a missing RELAY_KEK is one: secret-columns
 *  rethrows it, M3) is returned unchanged for the caller to throw. */
function unreadableRefusal(err: unknown, fixtureId: string, targetId: string): unknown {
  // YouTube Connect T11: an API-backed destination never reaches this read (both callers branch on the row's source first), so
  // T8's interim mapping of its ApiBackedTargetError to the "replace the key" copy is gone — that remedy is meaningless for a
  // connection. Were one ever to arrive, it is returned unchanged: a named 500, never the pasted key's copy.
  if (!(err instanceof TargetSecretUnreadableError)) return err;
  log.warn({ fixtureId, targetId, kind: err.kind }, "stream session: the saved destination will not open — start refused; the organiser replaces the key");
  return TargetUnreadableError.forKind(err.kind);
}

/** M1: the early probe `createSession` runs before its first provider call. Under the same row lock admission takes, and
 *  only for this org's ACTIVE row — anything else is left for `admit` to answer 404, exactly as before. And only when
 *  `admit` would pass on everything it can weigh WITHOUT the storage read (`admitsBarStorage`, asked with this fixture's
 *  active session read on the same transaction): F-A5 (owner, 2026-09-29) puts "already running" — and the plan, the
 *  credit and the target's existence — before any destination question, and an unreadable key is one. Every such
 *  refusal is left for the admission below, which answers it as before, measurement included (the admission snapshot:
 *  ruling 13, streaming-r1 plan "Data captured"; pinned by the SAMPLES and SNAPSHOTS test). Found by the
 *  destination model's DEST_REGRESSION_FA5_UNREADABLE (stream-sessions.test.ts). */
async function refuseUnreadableTarget(
  orgId: string, fixtureId: string, targetId: string, admitsBarStorage: (activeSessionId: string | null) => boolean,
): Promise<boolean> {
  // YouTube Connect T11: answers whether the probe PASSED on this org's active row — the gate for preparing a broadcast, which
  // must refuse nothing `admit` would answer first (F-A5) and must never be made for a start the admission is about to refuse.
  return (await sql.begin(async (tx) => {
    if (!(await lockStreamTarget(tx, orgId, targetId))) return false;
    if (!admitsBarStorage(await activeSessionIdFor(fixtureId, tx))) return false;
    // An API-backed row has no key of its own to open: its key is the pooled one `prepare` picks next, opened in admission.
    if ((await targetConnectionId(tx, orgId, targetId)) !== null) return true;
    await readTargetSecret(tx, orgId, targetId).catch((err: unknown) => { throw unreadableRefusal(err, fixtureId, targetId); });
    return true;
  })) as boolean;
}

/** T11, post-T2 amendment: a pooled key that will not open under a valid RELAY_KEK (`TargetSecretUnreadableError`, kind
 *  `youtube`, its id the KEY's) is never the pasted key's "replace the key" refusal — an API row has no key to replace. It is
 *  `youtube_unavailable` (503) naming the connection; the caller's abandon then deletes the prepared broadcast. A missing or
 *  malformed RELAY_KEK (rethrown by secret-columns, M3) and anything else is returned unchanged, for the caller to throw. */
function pooledKeyRefusal(err: unknown, fixtureId: string, targetId: string, connectionId: string): unknown {
  if (!(err instanceof TargetSecretUnreadableError)) return err;
  log.warn({ fixtureId, targetId, keyId: err.targetId, connectionId }, "stream session: the broadcast's pooled stream key will not open — start refused youtube_unavailable");
  return youtubeRefusal("youtube_unavailable", connectionId);
}

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
  const prepared = probed ? await prepareYoutubeBroadcast({ orgId, fixtureId, targetId: body.targetId, now: deps.now() }, youtube) : null;
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

/** R2004: a composed camera input with no SRT playback credential cannot be read by the compositor — refused by name at
 *  provisioning, never discovered by a Machine that boots and has nothing to read. */
class CameraPlaybackMissing extends Error {
  constructor(inputId: string) {
    super(`stream session: the camera input ${inputId} came back without an SRT playback credential — a composed session cannot read it`);
    this.name = "CameraPlaybackMissing";
  }
}

async function provisionSession(sessionId: string, deps: SessionDeps): Promise<void> {
  const provisioning = (await apply(sessionId, { type: "provision" }, deps))!;
  const composed = provisioning.mode === "composed";
  let creds: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["createLiveInput"]>> | undefined;
  let programme: typeof creds;
  try {
    creds = await recordEffect(provisioning, "create_live_input", "ingest", () => deps.drivers.ingest.createLiveInput({ sessionId, slot: 0 }), { slot: 0 });
    if (composed) {
      // R2004 (spec §5.3): Input A is the camera, read by the compositor over SRT PLAYBACK; Input B is the programme, which
      // the compositor publishes to and the destination output attaches to. A first, so a camera the compositor could not
      // read never costs a second input.
      if (!creds.srtPlayback) throw new CameraPlaybackMissing(creds.inputId);
      programme = await recordEffect(provisioning, "create_live_input", "ingest",
        () => deps.drivers.ingest.createLiveInput({ sessionId, slot: 0, role: "programme" }), { slot: 0, role: "programme" });
    }
  } catch (err) {
    log.error({ sid: sessionId, err }, "stream session: ingest create failed");
    // R2004: an input this attempt DID make is not left at the provider — nothing has connected to it, so it holds no
    // recording for the delete to leak (C2). A failed cleanup is reported with the uid; the sweep cannot reclaim an input
    // whose row is about to go with its session, so the alarm is the only trace.
    if (creds) {
      const orphan = creds.inputId;
      await deps.drivers.ingest.deleteInput(orphan).catch((cleanup: unknown) => {
        captureError(cleanup, { orgId: provisioning.orgId, route: "relay.provision_cleanup", extra: { sessionId, inputUid: orphan } });
        log.error({ sid: sessionId, inputUid: orphan, err: String(cleanup) }, "stream session: a provisioned input was NOT deleted after the create failed — it is orphaned at the provider");
      });
    }
    // No §6.4 reason fits; no dead row (E5's logic) — the events cascade with it (the ONE delete the append-only trigger
    // allows). Final review m-1: an automatic start's stamp goes WITH its session, in one transaction — the FK's
    // `on delete set null` would clear only the id and leave `auto_started_at`, so a start that never existed would block
    // every retry of the match.
    await sql.begin(async (tx) => {
      await tx`update fixture_stream_settings set auto_started_at = null, auto_start_session_id = null where auto_start_session_id = ${sessionId}`;
      await tx`delete from fixture_stream_sessions where id = ${sessionId}`;
    });
    throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
  }
  const camera = creds!;
  await sql.begin(async (tx) => {
    const [inp] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and role = 'camera' and slot = 0`;
    await storeInputCredentials(tx, inp!.id, camera.inputId, camera);
    if (programme) {
      await storePlaybackCredentials(tx, inp!.id, camera.srtPlayback!);
      const [prog] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and role = 'programme' and slot = 0`;
      await storeInputCredentials(tx, prog!.id, programme.inputId, programme);
    }
    // ruling 13 facts: when, and which input (the uid is not a secret; the keys stayed *_enc). R2004: the session's OUTPUT
    // input — the one its destination output attaches to and whose recording is the session's: the camera for
    // passthrough, the programme for composed.
    const outputInput = programme ? programme.inputId : camera.inputId;
    await tx`update fixture_stream_sessions set provisioned_at = coalesce(provisioned_at, ${deps.now()}), ingest_input_uid = ${outputInput} where id = ${sessionId}`;
  });
  if (composed) {
    // The lifecycle's first edge: none → creating (intent persisted) → create_machine → create_ok | create_failed.
    // m4 (fix round 1): only while the row is STILL provisioning, decided on the LOCKED row (the null command writes and
    // runs nothing). Nothing holds a lock across the ingest call above, so the organiser's stop — or the provision timeout
    // — can have ended the session meanwhile, and `decide` refuses a runner create on an ended session: InvalidTransition,
    // a 500 on the organiser's own create. The session's state is then the answer; no Machine is asked for.
    await apply(sessionId, (s) => (s.state === "provisioning"
      ? { type: "runner", trigger: { type: "create_started", name: machineNameFor(sessionId, 1), attempt: 1 } }
      : null), deps);
  }
  // `provisioned` is applied ONLY while the row is still provisioning. A stop, the wall clock, or the
  // new provision_timeout (F18) can have moved it to ending/completed/failed while the ingest call was
  // in flight — and `decide` THROWS InvalidTransition on `provisioned` from any of those, turning a
  // routine race into a 500 on the organiser's own create. Re-read and skip if it moved.
  const afterIngest = await readRow(sessionId);
  if (afterIngest?.state === "provisioning") await apply(sessionId, { type: "provisioned" }, deps);   // effects: add_output (C9; R2004: composed's on B)
}

// ---------------------------------------------------------------------------
// Reads and the organiser's commands
// ---------------------------------------------------------------------------
async function latestRow(fixtureId: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`select ${cols()} from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at desc limit 1`;
  return row ?? null;
}

/** What the Phone tab's credits card shows (Task 14b, R2/R4): the balance split by bucket, plus the plan's monthly
 *  allowance for the "Your plan includes {n} free match credits" note. The division page's reader — it GRANTS this
 *  month's free credits first (R3b, `ensureMonthlyStreamGrant`, idempotent), so the idle tab of an org that has never
 *  started a stream already shows them. `total` is creditBalance's number (creditBreakdown sums the same rows), so the
 *  chip and the split cannot disagree.
 *
 *  C1 lives here now (Task 14b review M9 retired `relayBalance`, which nothing but its own test called): the balance is
 *  readable with NO session row. `currentSession` returns `null` until a session exists and `balance` rides inside that
 *  projection, so the idle Phone tab had no other source and read 0 for every credited org. Tenancy is checked the way
 *  the projection checks it: a mismatch is 404, never 403 (404 ≡ missing). */
export interface RelayCredits extends StreamCreditBreakdown {
  /** The plan's `streaming.credits.monthly` (V426), on the org's RESOLVED plan. */
  monthlyAllowance: number;
}

export async function relayCredits(auth: AuthCtx, orgId: string): Promise<RelayCredits> {
  if (orgId !== auth.orgId) throw new HttpError(404, "organisation not found");
  // I3: the ensure resolves the plan's rate to decide a mid-month top-up, and hands it back — the allowance printed on
  // the card is the same number the grant was topped up to, read once.
  let monthlyAllowance: number;
  try {
    ({ rate: monthlyAllowance } = await ensureMonthlyStreamGrantWithRate(orgId));
  } catch (err) {
    // I1: this is a WRITE made during the division page's GET, for every editable org. It can refuse by design (a
    // corrupt ledger's `ledger_negative`) or fail on the lock or the plan read, and a failed grant writes no key, so it
    // fails again on every render. Thrown from here it took down the org's whole fixtures tab (no error boundary under
    // d/[divSlug]/). Log it, report it, and answer the UNGRANTED balance. The next start (createSession) runs the
    // same ensure under the same guard (m4): it logs and reports there too, and admits on the ungranted balance.
    log.error({ err, orgId }, "relayCredits: monthly grant failed; answering the ungranted balance");
    captureError(err, { orgId, route: "relay.credits.monthly_grant" });
    monthlyAllowance = await streamMonthlyRate(orgId).catch(() => 0);
  }
  return { ...(await creditBreakdown(sql, orgId)), monthlyAllowance };
}

/** Spec 2026-09-30 §2 — each listed fixture with a session still up, as a person reads it (live | waiting), THIS org's
 *  only. Feeds the run sheet's chip (the division's path to Stop, frozen or not) and the fixture page's Stop-only mount.
 *  At most one ACTIVE session per fixture (V410 `fixture_stream_sessions_one_active`); `distinct on … created_at desc`
 *  still names the newest should that ever not hold. */
export async function openStreamStates(auth: AuthCtx, fixtureIds: readonly string[]): Promise<Record<string, HoldState>> {
  if (fixtureIds.length === 0) return {};
  const rows = await sql<OpenSessionRow[]>`
    select distinct on (fixture_id) id, fixture_id, state from fixture_stream_sessions
     where org_id = ${auth.orgId} and fixture_id in ${sql([...fixtureIds])} and state in ${sql([...ACTIVE_STATES])}
     order by fixture_id, created_at desc`;
  return holdStatesOf(rows);
}

/** One row of `openStreamStates`' read. */
export type OpenSessionRow = { id: string; fixture_id: string; state: SessionState };

/** The fold after `openStreamStates`' SQL filter, DB-free. ONE guard decides "active": that filter. A row the domain does
 *  not read as live/waiting (a terminal state, or a state this build does not know) means the filter and the domain
 *  disagree — an assumption that broke. B3 fix round 1, I-1 (controller ruling): that must NEVER block the organiser's
 *  page or its Stop, so the row is REPORTED to Sentry (session id and state only — no key, URL or secret) and skipped. */
export function holdStatesOf(rows: readonly OpenSessionRow[]): Record<string, HoldState> {
  const out: Record<string, HoldState> = {};
  for (const r of rows) {
    const s = holdStateOf(r.state);
    // `undefined` too: a state added to the DB but not to `holdStateOf`'s switch falls through it.
    if (s === null || s === undefined) {
      captureError(new Error("openStreamStates: a session the domain does not read as up passed the ACTIVE_STATES filter"), {
        route: "relay.open_stream_states",
        extra: { sessionId: r.id, state: r.state },
      });
      continue;
    }
    out[r.fixture_id] = s;
  }
  return out;
}

/** T7 (§6.11): what one tick observed. currentSession builds its projection from this, so the projection stays
 *  byte-identical to the pre-extraction code (A10). The three observation fields are the block's own locals, moved
 *  verbatim; `coalescedSince`'s three states (Date, null, undefined = not served) all mean something. */
export type TickObservation = {
  session: Session | null;
  ingestState: StreamSessionCurrent["ingest"];
  outputObserved: OutputState | null;            // D3: what THIS poll read of the destination; null = read nothing
  coalescedSince: Date | null | undefined;       // I-1 (B0): a served sample's own since; undefined = not served
  /** T8b (§6.5, A14 conjunct 2): THIS tick's fresh read of the phone — the word W19 judges on (a claimed read's own
   *  word, or a coalesced sample younger than COALESCED_SAMPLE_MAX_AGE_MS); undefined = no fresh read. */
  freshIngest: IngestState | undefined;
  /** W24 (controller ruling 2026-10-04): THIS tick's STATUS read threw (N1). The warming timeout's own observation is
   *  held by exactly that (`heldByUnknownIngest`), so the warming countdown reads it. An outputs read that threw is not
   *  it: the timeout's observation never reads the outputs. A coalesced tick answers as the claimed read it defers to
   *  (`ingest_read_failed`, B7 re-review's outage gap). False when no read was made or deferred to (no input). */
  phoneReadFailed: boolean;
  /** R2008 (review I1): the compositor's evidence about a COMPOSED session's camera, as THIS tick judged it — null when no rule
   *  could fire (`cameraEvidenceMatters`: not composed, not live, or the latest phase is not an outage's or a wait's). The
   *  organiser's countdown is built from it, so it names the deadline the tick judges. For a composed session `freshIngest`
   *  is the CAMERA's input word (read once the camera is gone and the phone silent past the quiet hold), not a phone's. */
  camera: CameraFacts | null;
};

/** T7 (§6.11): who advances a session. The organiser poll's reconcile-and-ingest block, extracted so a phone beat and the
 *  stream-tick job (W22) advance a session nobody is watching. In order: 1. lazy expiry; 2. the coalesced ingest read
 *  (`claimIngestPoll`; the sample and its event in ONE tx, B0 R-1); 3. warming → live (the credit); 4. target_rejected;
 *  5. m-5, then ask 10 (§6.8.3); 6. W19 (§6.8.5); 7. the automatic stop after the result (§7.3) — LAST, so a phone-lost
 *  end that the same tick makes is the session's reason (the first reason wins). `cause` names the caller in the log line
 *  of an end it makes. */
export async function tickSession(sessionId: string, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<TickObservation> {
  let row = await readRow(sessionId);
  if (!row) return { session: null, ingestState: null, outputObserved: null, coalescedSince: undefined, freshIngest: undefined, phoneReadFailed: false, camera: null };

  if (!isTerminal(row.state)) await reconcileSession(row.id, deps);      // expiry + one Machine observation
  row = (await readRow(sessionId))!;

  // The server-side ingest poll (design §6.4): passthrough warming → live on
  // connected; a rejected destination fails it. The client never decides.
  let ingestState: StreamSessionCurrent["ingest"] = null;
  let outputObserved: OutputState | null = null;   // D3: what THIS poll read of the destination; null when it read nothing
  let coalescedSince: Date | null | undefined;      // I-1 (B0 fix round 1): a served sample's own since; undefined = not served
  // W19 (§6.8.5 clause 2): THIS tick's fresh read of the phone — a claimed read's own word, or (FP17) a coalesced sample
  // younger than COALESCED_SAMPLE_MAX_AGE_MS. Undefined = no fresh read to judge on (no input, a failed or no-evidence
  // read, an older sample): W19 skips this tick and never guesses.
  let freshIngest: IngestState | undefined;
  let phoneReadFailed = false;
  if (row.mode === "passthrough" && (row.state === "warming" || row.state === "live")) {
    const input = (await sql.begin((tx) => readFirstInput(tx, row!.id))) as Awaited<ReturnType<typeof readFirstInput>>;
    const inputId = input?.ingestInputId ?? null;
    // N1: a provider read that throws is reported once and the projection answers without it (`ingest: null`) — never a
    // 500 on every organiser poll through an outage. Nothing is decided on an unknown; the next poll reads again.
    let read: { status: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["inputStatus"]>>; output: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["outputState"]>> } | null = null;
    let coalesced = false;   // I-1: another poll claimed this interval's read
    if (inputId) {
      if (!(await claimIngestPoll(row.id, deps.now()))) coalesced = true;
      else {
        phoneReadFailed = true;   // until the status read answers
        try {
          const status = await deps.drivers.ingest.inputStatus(inputId, { sessionId: row.id });
          phoneReadFailed = false;
          read = { status, output: await deps.drivers.ingest.outputState(inputId, { sessionId: row.id }) };
        } catch (err) {
          reportIngestReadFailure(err, { sessionId: row.id, orgId: row.org_id, inputUid: inputId, site: "poll" });
        }
        // The outage gap (B7 re-review): whether this claimed STATUS read threw, for the polls that coalesce onto it.
        // Written only when it changes, so a healthy session's polls add no write.
        if (phoneReadFailed !== row.ingest_read_failed) {
          await sql`update fixture_stream_sessions set ingest_read_failed = ${phoneReadFailed} where id = ${row.id}`;
        }
      }
    }
    if (coalesced && row.ingest_read_failed) {
      // The outage gap (B7 re-review): the claimed read this poll defers to THREW. It answers as that read did, nothing
      // served and nothing fresh, so the warming countdown is held here exactly as on the claimer's own poll (N1).
      phoneReadFailed = true;
    } else if (coalesced) {
      // I-1: no provider call — the view is the latest poll sample's, when it is recent enough to be this interval's
      // reading. Nothing is recorded and nothing is decided: the poll that read decided on what it read. D3's `since`
      // is computed exactly as for a read (events, clamps, this response's clock), from the sampled word — and, B0 fix
      // round 1 (I-1), in the SAME statement as the sample (`latestPollSampleWithSince`): read apart, a reading poll's
      // commit could land between them and serve the old word timed by the new event.
      const sample = await latestPollSampleWithSince(row.id);
      if (sample && deps.now().getTime() - new Date(sample.sampled_at).getTime() < COALESCED_SAMPLE_MAX_AGE_MS) {
        const phone = carriedIngest(sample);
        ingestState = phone === null ? null : { state: phone, protocol: sampledProtocol(sample.protocol) };
        outputObserved = sampledOutput(sample.output_state);
        coalescedSince = sample.since;
        freshIngest = phone ?? undefined;
      }
    }
    if (read) {
      const { status, output } = read;
      // One read of the latest poll sample serves both the change check below and G-a's carry.
      const prev = output !== null || status.state === null ? await latestPollSample(row.id) : undefined;
      // G-a (controller ruling 2026-10-01): a read with NO evidence about video (`null`, ports.ts) carries the previous
      // poll's word forward — never `unknown`, which read as No signal, and never a hold on go-live. With nothing to
      // carry (no poll has read the phone yet) the phone is unseen on this poll: `ingest: null`, as for a failed read.
      const phone: IngestState | null = status.state ?? carriedIngest(prev);
      freshIngest = status.state ?? undefined;   // a no-evidence read (G-a) is not a fresh word: its carry decides nothing
      ingestState = phone === null ? null : { state: phone, protocol: status.protocol };
      outputObserved = output;
      // Ruling 13: the poll is a SAMPLE every time and an OBSERVED event only when the state word changed — for a poll
      // that READ. m-2 (B5 re-review 2): an outputs read that failed (`null`, ports.ts) is not evidence, so that poll
      // records neither; as `unknown` it was a non-ok word that moved the D3 hold toward the key box. The phone's read
      // still answers the projection and still drives warming → live below. G-a: a carried word is recorded as the
      // reading it carries (the raw status keeps the no-evidence read itself); an unseen phone records nothing.
      if (output !== null && phone !== null) {
        // R-1 (re-review): the sample and its event commit in ONE transaction. A coalesced poll serves the latest poll
        // sample's word and computes D3's `since` from these events; as two commits, a reader landing between them was
        // served the NEW word with no event behind it, `since` fell back to live_at, and the stream-key box flashed for
        // one poll. Both Cloudflare reads are already done above: this transaction holds a connection for the row lock
        // and the two inserts only, never across a provider call. Inside it the order is invisible to a reader; neither
        // half alone is safe to serve (an event without its sample moves `since` under the previous word), so they must
        // never be split — stream-sessions.test.ts "R-1" holds a poll mid-write and refuses each write in turn.
        const changed = !prev || prev.ingest_state !== phone || prev.output_state !== output;
        const sid = row.id, orgId = row.org_id;
        await sql.begin(async (tx) => {
          if (changed) {
            await lockRow(tx, sid);
            await recordEvent(tx, { sessionId: sid, orgId, source: "ingest", kind: "observed", type: "ingest_status", from: prev?.ingest_state ?? null, to: phone, occurredAt: deps.now(),
              payload: { protocol: status.protocol, outputState: output, connected: phone === "connected" } });
          }
          // Dh: `ingest_reason` is Cloudflare's own `status.current.reason`, verbatim (Task 4 exposes it
          // on the status read). It is the one field that says WHY an input is disconnected, so a poll
          // sample without it records that something was wrong and drops the only explanation.
          await recordSample(tx, { sessionId: sid, source: "poll", ingestState: phone, outputState: output,
            ingestReason: status.reason, sampledAt: deps.now(), raw: status });
        });
      }
      if (phone === "connected") {
        await sql`update fixture_stream_sessions set first_ingest_at = coalesce(first_ingest_at, ${deps.now()}), ingest_protocol = coalesce(ingest_protocol, ${status.protocol}) where id = ${row.id}`;
      }
      // m1 (lane C final review): both re-decided on the LOCKED row (T5-a) — a Stop or an expiry that landed after the
      // unlocked read above leaves a row these no longer apply to, and a plain apply of either was InvalidTransition, a 500.
      if (output === "rejected") await apply(row.id, (s) => (s.state === "warming" || s.state === "live" ? { type: "target_rejected" } : null), deps);
      else if (row.state === "warming" && phone === "connected") await apply(row.id, connectIfWarming, deps);
      row = (await readRow(sessionId))!;
    }
  }

  // 5–6: the phone-lost ends, judged on what this tick read and re-taken on the LOCKED row.
  let camera: CameraFacts | null = null;
  if (!isTerminal(row.state)) {
    const ended = await endIfPhoneLost(row, freshIngest, deps, cause);
    row = ended.row;
    camera = ended.camera;
    if (ended.cameraWord !== undefined) freshIngest = ended.cameraWord;   // a composed session's fresh word is its CAMERA's (R2008)
  }
  // 7: the automatic stop after the result (PR-2 T5, FP7: here once, so every caller of the tick reaches it). It returns an
  // ending or terminal row untouched on its own.
  row = await endIfAutoStopDue(row, deps, cause);
  return { session: toSession(row), ingestState, outputObserved, coalescedSince, freshIngest, phoneReadFailed, camera };
}

/** The facts ask 10, W19 and m-5 judge, in ONE statement (one snapshot). The session's phone is its `pairing_id`
 *  (§6.5: a takeover moves it).
 *  - `has_phone` (C-1, controller ruling): the session HAS a phone at all. `pairing_id` is null for every session open
 *    when V430 deploys and for one whose fixture was deleted (T35: the pairings cascade, `on delete set null`). Such a
 *    session keeps TODAY's rules: the phone rules never judge it (`phoneLostEnd`).
 *  - `has_current`: that pairing has not ended. Its CODE's state is deliberately not read (C-2, controller ruling, spec
 *    C1b/C3): a Revoke & reissue ends the code, and the old code still serves the open session's phone until the
 *    session ends. The code-active filter belongs to NEW claims and the Go-live lookup (`currentPhoneOf`), never here.
 *  - `heard_go_live`: the phone has beaten since the session was created, so it is answered at an open session's
 *    cadence (§6.8.3).
 *  `exec` is apply's tx when re-taken under the row lock. */
type PhoneFacts = {
  first_ingest_at: Date | null; phone_beat_at: Date | null; has_phone: boolean; has_current: boolean; last_beat_at: Date | null;
  answered_poll_seconds: number | null; heard_go_live: boolean; last_connected_at: Date | null;
};
async function phoneFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<PhoneFacts | null> {
  const [f] = await exec<PhoneFacts[]>`
    select s.first_ingest_at, s.phone_beat_at, s.pairing_id is not null as has_phone, p.id is not null as has_current,
           p.last_beat_at, p.answered_poll_seconds,
           coalesce(p.id is not null and p.last_beat_at > s.created_at, false) as heard_go_live,
           (select max(x.sampled_at) from fixture_stream_samples x
             where x.session_id = s.id and x.source = 'poll' and x.ingest_state = 'connected') as last_connected_at
      from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id and p.ended_at is null
     where s.id = ${sessionId}`;
  return f ?? null;
}

/** T8b (§6.5, A14 conjunct 3): when a poll sample last read the input connected — null when none ever has. The beat's
 *  dead-phone takeover reads it on its own transaction (`exec`), through this module because only the samples' writers
 *  may name that table (enc-boundary claim 4). The same measure W19 judges on (`phoneFactsOf`). */
export async function lastConnectedSampleAt(exec: Tx | typeof sql, sessionId: string): Promise<Date | null> {
  const [r] = await exec<{ at: Date | null }[]>`
    select max(sampled_at) as at from fixture_stream_samples
     where session_id = ${sessionId} and source = 'poll' and ingest_state = 'connected'`;
  return r?.at ?? null;
}

/** Which phone-lost end, if any, a session owes now. `fresh` = this tick's fresh read (undefined: W19 cannot judge).
 *  - C-1 (controller ruling): a session with no phone (`has_phone` false) is judged by none of the rules below.
 *  - m-5 (controller ruling): a PASSTHROUGH session live with no first ingest recorded is judged by the warming rule —
 *    expire warming_timeout at warming_at + WARMING_TIMEOUT_MINUTES (`warmingTimedOut`, evaluate's own clock). Composed
 *    is excluded by name: a composed session never records first ingest (only the passthrough poll writes it), so the
 *    rule would end every composed broadcast at its warming deadline — and the domain refuses that cell anyway.
 *  - ask 10 (§6.8.3) and W19 (§6.8.5): the domain's own predicates, with the tunable timings (§6.15).
 *  - R2008: a COMPOSED live session is judged on `camera`, the compositor's own evidence (`cameraFactsOf`):
 *    - never live (owner ruling 2026-10-19): no camera ever appeared for PHONE_LOST_LIVE_MINUTES from go-live — an `expire`
 *      with `camera_never_live`, which fails the session and RETURNS its credit (the viewer never saw video). Reads nothing.
 *    - the camera lost after it was in: the composed W19 (`composedCameraLost`) with `fresh`, this tick's read of the camera's
 *      input (`readCameraWord`) — the same `stop phone_lost` as W19's: the organiser's copy, the credit (kept) and the
 *      reservation are the ones any composed end gets. */
function phoneLostEnd(s: Session, f: PhoneFacts, fresh: IngestState | undefined, now: Date, camera: CameraFacts | null = null): { command: Command; rule: "m-5" | "ask-10" | "w19" | "w19-composed" | "never-live-composed" } | null {
  if (isTerminal(s.state)) return null;
  if (!f.has_phone) return null;   // C-1: no phone, no phone rules — the session keeps today's expiry and runner ends
  if (s.mode === "passthrough" && s.state === "live" && f.first_ingest_at === null && warmingTimedOut(s, now)) {
    return { command: { type: "expire", expiry: { kind: "warming_timeout" } }, rule: "m-5" };
  }
  const silentFloor = tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS);
  if (warmingPhoneLost({ state: s.state, firstIngestAt: f.first_ingest_at, ...ask10PhoneOf(f) }, now, silentFloor)) {
    return { command: { type: "stop", reason: "phone_lost" }, rule: "ask-10" };
  }
  // m-3 (controller ruling): an `unknown` read — claimed or coalesced — never advances a phone-lost end. A Cloudflare
  // read blip must not end a paid broadcast as phone_lost; the next fresh word decides, and max_duration still bounds it.
  if (fresh !== undefined && fresh !== "unknown" && livePhoneLost({
    state: s.state, firstIngestAt: f.first_ingest_at, phoneBeatAt: f.phone_beat_at,
    freshReadConnected: fresh === "connected", lastConnectedSampleAt: f.last_connected_at,
  }, now, tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES))) return { command: { type: "stop", reason: "phone_lost" }, rule: "w19" };
  if (s.mode === "composed" && camera !== null && composedNeverLive({
    state: s.state, startedAt: s.startedAt, liveOnceAt: camera.live_once_at, waitedOnly: camera.waited_only, logBeganAt: camera.log_began_at,
  }, now, tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES))) return { command: { type: "expire", expiry: { kind: "camera_never_live" } }, rule: "never-live-composed" };
  if (s.mode === "composed" && camera !== null && fresh !== undefined && fresh !== "unknown" && composedCameraLost({
    state: s.state, phoneBeatAt: f.phone_beat_at, liveOnceAt: camera.live_once_at, reconnectingSince: camera.reconnecting_since,
    freshReadConnected: fresh === "connected",
  }, now, tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES))) return { command: { type: "stop", reason: "phone_lost" }, rule: "w19-composed" };
  return null;
}

/** R2008: what the compositor's beats say about the camera, from the `programme_phase` log (`logProgrammePhase`) — the
 *  composed stream's own evidence, as `first_ingest_at` and the connected samples are the passthrough stream's. One
 *  statement (one snapshot); `exec` is apply's tx when re-taken under the row lock, where it reads every beat stored before
 *  the lock was granted. Only called when a rule could fire (`cameraEvidenceMatters`).
 *  - `live_once_at`: the first beat, of any attempt, that reported `live` (null: the camera was never in).
 *  - `log_began_at`: the first phase row of any kind (null: the compositor never reported a phase).
 *  - `waited_only`: the log holds `waiting` and nothing else — no `live`, no `reconnecting`, no beat that reported none.
 *  - `reconnecting_since`: when the camera's OUTAGE began — the first row of the unbroken run of `reconnecting`/`waiting` rows
 *    that ends at the latest row (review I2: a compositor restarted during an outage opens on `waiting`, and the camera is
 *    exactly as gone). Null unless that latest row is a `reconnecting`/`waiting` of the CURRENT attempt: a run another
 *    attempt wrote last is another Machine's, and the current one has said nothing yet. A `live`, a `frozen` that followed a
 *    run, or a beat with no phase breaks the run — the camera came back, or the compositor stopped saying. */
export type CameraFacts = { live_once_at: Date | null; log_began_at: Date | null; waited_only: boolean; reconnecting_since: Date | null };
async function cameraFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<CameraFacts> {
  const [f] = await exec<CameraFacts[]>`
    with ev as (
      select seq, to_state, attempt, occurred_at from fixture_stream_events
       where session_id = ${sessionId} and type = ${PROGRAMME_PHASE_EVENT}
    ), last as (
      select to_state, attempt from ev order by seq desc limit 1
    ), brk as (
      select coalesce(max(seq), 0) as seq from ev where to_state is distinct from 'reconnecting' and to_state is distinct from 'waiting'
    )
    select (select min(occurred_at) from ev where to_state = ${CAMERA_LIVE_PHASE}) as live_once_at,
           (select min(occurred_at) from ev) as log_began_at,
           coalesce((select bool_and(coalesce(to_state = 'waiting', false)) from ev), false) as waited_only,
           case when l.to_state in ('reconnecting', 'waiting') and l.attempt = s.runner_attempts
                then (select min(occurred_at) from ev where seq > (select seq from brk)) end as reconnecting_since
      from fixture_stream_sessions s left join last l on true
     where s.id = ${sessionId}`;
  return f ?? { live_once_at: null, log_began_at: null, waited_only: false, reconnecting_since: null };
}

/** R2008: the composed W19's third clause — one fresh read of the CAMERA's input (A; the programme, B, is the compositor's
 *  own output and says nothing of the phone). Made only once the camera is gone and the phone silent past the quiet hold
 *  (`composedCameraWatched` — where the organiser's countdown arms, which shows on this word), so a healthy stream costs no
 *  Cloudflare call, and through the same claim window as the organiser's passthrough poll (`claimIngestPoll`: a tick that
 *  does not hold the claim reads nothing and decides nothing — and shows no countdown).
 *  Undefined = no fresh word: no input row, no claim, a read that threw (reported once, N1) or one with no evidence. The
 *  read records no sample and no event and never writes first ingest — a composed session never has one. */
async function readCameraWord(row: Row, deps: SessionDeps): Promise<IngestState | undefined> {
  const input = (await sql.begin((tx) => readFirstInput(tx, row.id))) as Awaited<ReturnType<typeof readFirstInput>>;
  const inputId = input?.ingestInputId ?? null;
  if (!inputId) return undefined;
  if (!(await claimIngestPoll(row.id, deps.now()))) return undefined;
  try {
    return (await deps.drivers.ingest.inputStatus(inputId, { sessionId: row.id })).state ?? undefined;
  } catch (err) {
    reportIngestReadFailure(err, { sessionId: row.id, orgId: row.org_id, inputUid: inputId, site: "poll" });
    return undefined;
  }
}

/** Ask 10's phone, from the facts: ONE mapping for the tick's end and the W24 countdown, so the countdown names the
 *  deadline the tick judges. With no current pairing the cadence is never read (both answer before it). */
function ask10PhoneOf(f: PhoneFacts): Ask10Phone {
  return {
    hasCurrentPairing: f.has_current, lastBeatAt: f.has_current ? f.last_beat_at : null,
    answeredPollSeconds: f.answered_poll_seconds ?? 0, heardGoLive: f.heard_go_live,
  };
}

/** Steps 5–6 of the tick. Judged first on an UNLOCKED read (the common answer is "nothing", and `apply` takes the org's
 *  money lock), then RE-TAKEN on the locked row inside `apply`: a beat, a Stop or another tick may have landed between
 *  the two, and the locked answer is the only one that may end a session (witnesses: "a tick racing a phone BEAT" and
 *  "two ticks AT ONCE"). A row that moved on answers null and nothing is written. */
async function endIfPhoneLost(row: Row, fresh: IngestState | undefined, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<{ row: Row; camera: CameraFacts | null; cameraWord: IngestState | undefined }> {
  const facts = await phoneFactsOf(sql, row.id);
  if (!facts) return { row, camera: null, cameraWord: undefined };
  // R2008: a composed session with a phone is judged on the compositor's evidence — read ONLY when a rule could fire (a live
  // session whose latest phase is `waiting` or `reconnecting`: `cameraEvidenceMatters`, the one gate), so a healthy stream
  // costs neither the query nor a Cloudflare call. Its camera's input is read once the camera is gone and the phone silent
  // past the quiet hold (`composedCameraWatched`): the end's third clause, and the word the organiser's countdown shows on.
  let camera: CameraFacts | null = null;
  let cameraWord: IngestState | undefined;
  if (row.mode === "composed" && facts.has_phone && cameraEvidenceMatters({ state: row.state, storedPhase: storedPhaseOf(row) })) {
    camera = await cameraFactsOf(sql, row.id);
    if (composedCameraWatched({ state: row.state, phoneBeatAt: facts.phone_beat_at, liveOnceAt: camera.live_once_at, reconnectingSince: camera.reconnecting_since },
      deps.now(), RECONNECT_QUIET_SECONDS)) {
      cameraWord = await readCameraWord(row, deps);
      fresh = cameraWord;
    }
  }
  if (phoneLostEnd(toSession(row), facts, fresh, deps.now(), camera) === null) return { row, camera, cameraWord };
  let rule: string | null = null;
  await apply(row.id, async (s, tx) => {
    const locked = await phoneFactsOf(tx, s.id);
    const lockedCamera = s.mode === "composed" && camera !== null ? await cameraFactsOf(tx, s.id) : null;
    const end = locked ? phoneLostEnd(s, locked, fresh, deps.now(), lockedCamera) : null;
    rule = end?.rule ?? null;
    return end?.command ?? null;
  }, deps);
  const after = (await readRow(row.id)) ?? row;
  if (rule !== null && isTerminal(after.state)) log.info({ sid: row.id, orgId: row.org_id, cause, rule, state: after.state }, "stream session: ended by the tick");
  return { row: after, camera, cameraWord };
}

/** The facts `autoStopDue` (§7.3) judges, in ONE statement (one snapshot). The session's phone is its `pairing_id`, ended or
 *  not: the mode that was set is what the session's phone chose (FP13 — it lags the phone's Settings by at most one poll
 *  interval, by design). Every join is a fact, not a filter: a session with no `pairing_id` has a null `mode` (no phone, never
 *  auto-stopped), one with no settings row has `auto_stream` false, and a deleted fixture (`fixture_id` null) returns no row
 *  at all. `session_predates_result` is compared HERE, in SQL: `created_at` and `finished_at` are database stamps at
 *  microsecond precision and a JS `Date` truncates both to the millisecond, so a session created in the result's own
 *  millisecond would read equal there (Review Focus 4). Two clocks stay apart: those two stamps are compared with each other,
 *  and the delay is `deps.now()` against `finished_at`. `exec` is apply's tx when re-taken under the row lock. */
type AutoStopFacts = { auto_stream: boolean; mode: string | null; finished_at: Date | null; session_predates_result: boolean };
async function autoStopFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<AutoStopFacts | null> {
  const [f] = await exec<AutoStopFacts[]>`
    select coalesce(st.auto_stream, false) as auto_stream, p.mode, f.finished_at,
           coalesce(s.created_at < f.finished_at, false) as session_predates_result
      from fixture_stream_sessions s
      join fixtures f on f.id = s.fixture_id
      left join fixture_stream_settings st on st.fixture_id = s.fixture_id
      left join fixture_stream_pairings p on p.id = s.pairing_id
     where s.id = ${sessionId}`;
  return f ?? null;
}
const phoneModeOf = (mode: string | null): PhoneMode | null => (mode === "automatic" || mode === "operator" ? mode : null);
/** B7 review M-3: whether §7.3 will ever stop this session (`autoStopApplies`), read from the SAME facts `autoStopDue` judges
 *  (one statement, the pre/post-result comparison in SQL) — the organiser panel's read model serves it, so the panel's
 *  "stops about N minutes after the result" line can never promise a stop the tick will not make. False for a session gone. */
export async function autoStopAppliesTo(sessionId: string): Promise<boolean> {
  const f = await autoStopFactsOf(sql, sessionId);
  return f !== null && autoStopApplies({
    autoStream: f.auto_stream, phoneMode: phoneModeOf(f.mode), finishedAt: f.finished_at, sessionPredatesResult: f.session_predates_result,
  });
}
function autoStopDue(f: AutoStopFacts, now: Date): boolean {
  return autoStopVerdict({
    autoStream: f.auto_stream, phoneMode: phoneModeOf(f.mode), finishedAt: f.finished_at, sessionPredatesResult: f.session_predates_result,
  }, now, tunable("AUTO_STOP_AFTER_RESULT_SECONDS", AUTO_STOP_AFTER_RESULT_SECONDS)).due;
}

/** Step 7 of the tick (§7.3): end the session `auto_stopped` once `autoStopDue`. Judged on an UNLOCKED read first (the common
 *  answer is "no", and `apply` takes the org's money lock), then RE-TAKEN on the locked row inside `apply`: a result reverted,
 *  a switch turned off or an organiser's Stop may have landed between the two, and only the locked answer ends anything. An
 *  `ending` or terminal session is not re-decided — the first reason wins (`ending × stop` is the identity in the domain, but
 *  deciding it would still cost the org lock). */
async function endIfAutoStopDue(row: Row, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<Row> {
  if (row.state === "ending" || isTerminal(row.state)) return row;
  const facts = await autoStopFactsOf(sql, row.id);
  if (!facts || !autoStopDue(facts, deps.now())) return row;
  let decided = false;
  await apply(row.id, async (s, tx) => {
    if (s.state === "ending" || isTerminal(s.state)) return null;
    const locked = await autoStopFactsOf(tx, s.id);
    decided = locked !== null && autoStopDue(locked, deps.now());
    return decided ? { type: "stop", reason: "auto_stopped" } : null;
  }, deps);
  const after = (await readRow(row.id)) ?? row;
  if (decided && (after.state === "ending" || isTerminal(after.state))) {
    log.info({ sid: row.id, orgId: row.org_id, cause, rule: "auto-stop", state: after.state }, "stream session: ended by the tick");
  }
  return after;
}

/** T7b (§6.11, W22): one stream-tick pass's answer. Written out LITERALLY, never inferred: the cron Worker reads
 *  `data.failed` as its failure counter (R3), and apps/cron-worker/test/drift.test.ts finds that field by reading this
 *  module's CODE (comments stripped) for its numeric declaration. `deferred` (the budget ran out) is NOT a failure: the
 *  next firing, five minutes on, reaches those sessions. */
export type StreamTickResult = { ticked: number; ended: number; failed: number; deferred: number };

/** T7b: the pass stops STARTING ticks once this much wall-clock time has gone. The cron Worker abandons a job at 60 s
 *  (JOB_TIMEOUT_MS, apps/cron-worker/src/call.ts) and records a timeout; stopping here leaves the tick in flight 15 s to
 *  finish, so an overrun usually reads `deferred` instead. stream-tick/route.test.ts pins it below the Worker's figure.
 *  RESIDUAL (B5 review m-2), a flat figure because no derived one exists: one tick's worst case is unbounded — a Fly
 *  observation can take ~43.5 s across its attempts (config.ts), and the Cloudflare calls set no request timeout
 *  (ingest-cf.ts) — so a tick started just inside the budget can still outlive the Worker's 60 s. That reads as a Worker
 *  timeout (status error, one Sentry event an hour under R2), never as silence, and the next firing ticks the rest. */
export const STREAM_TICK_BUDGET_MS = 45_000;

/** T7b (§6.11, W22): the stream-tick job's pass — `tickSession` on every OPEN session (ACTIVE_STATES, the one definition
 *  `openStreamStates` and the sweep use), across every org, oldest first, so a phone that dies with no panel open is still
 *  ended (ask 10, W19, m-5) within one firing. Each session is ticked inside its own try/catch: a throw adds 1 to `failed`
 *  and is logged, and never stops the next. A terminal result adds 1 to `ended` — "open when selected, terminal after its
 *  tick", so with two firings overlapping both may count one end; the END itself happens once (the locked re-check).
 *  Sessions not started before the wall-clock budget is spent are counted in `deferred`.
 *  TEST-ONLY options: `orgIds` scopes the selection (an empty list is refused — `org_id in ()` silently read as "no
 *  filter" would tick every org) and `wallClock` scripts the budget's clock. The cron route passes neither. */
export async function tickOpenSessions(
  deps: SessionDeps,
  opts: { orgIds?: readonly string[]; wallClock?: () => number } = {},
): Promise<StreamTickResult> {
  const orgIds = opts.orgIds === undefined ? undefined : [...opts.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) {
    throw new Error("stream tick: orgIds is empty — omit it to tick every organisation, or name at least one");
  }
  const wallClock = opts.wallClock ?? Date.now;
  const started = wallClock();
  const open = await sql<{ id: string }[]>`
    select id from fixture_stream_sessions
     where state in ${sql([...ACTIVE_STATES])} ${orgIds ? sql`and org_id in ${sql(orgIds)}` : sql``}
     order by created_at, id`;
  const out: StreamTickResult = { ticked: 0, ended: 0, failed: 0, deferred: 0 };
  for (let i = 0; i < open.length; i++) {
    if (wallClock() - started >= STREAM_TICK_BUDGET_MS) {
      out.deferred = open.length - i;
      break;
    }
    const sid = open[i]!.id;
    try {
      const t = await tickSession(sid, deps, "sweep");
      out.ticked++;
      if (t.session && isTerminal(t.session.state)) out.ended++;
    } catch (err) {
      // Logged, not reported to Sentry per session: the Worker raises the job's one event from `failed` (R3), throttled
      // to one an hour (R2); an event per session per firing would be twelve an hour for one stuck row.
      out.failed++;
      log.error({ sid, err: err instanceof Error ? err.message : String(err) }, "stream tick: a session's tick threw");
    }
  }
  log.info({ ...out, open: open.length, scoped: orgIds !== undefined }, "stream tick");
  return out;
}

export async function currentSession(auth: AuthCtx, fixtureId: string, deps: SessionDeps): Promise<StreamSessionCurrent | null> {
  const { orgId } = await fixtureContext(fixtureId);
  if (orgId !== auth.orgId) throw new HttpError(404, "fixture not found");
  let row = await latestRow(fixtureId);
  if (!row) return null;

  // B: the organiser's poll IS a tick (§6.11) — expiry + one Machine observation, the coalesced ingest read, warming →
  // live, target_rejected and the phone-lost ends. T7 (A10): the projection below is built from what THAT tick observed,
  // exactly as it was from the block's own locals before the extraction.
  const { ingestState, outputObserved, coalescedSince, freshIngest, phoneReadFailed, camera } = await tickSession(row.id, deps, "poll");
  row = (await latestRow(fixtureId))!;

  const [target] = await sql<{ id: string; kind: StreamSessionCurrent["target"]["kind"]; label: string }[]>`
    select id, kind, label from org_stream_targets where id = ${row.target_id}`;
  const [fx] = await sql<{ stream_url: string | null; status: string }[]>`select stream_url, status from fixtures where id = ${fixtureId}`;
  const hb = row.last_heartbeat as { fps?: number | null; bitrateKbps?: number | null } | null;
  // D3: the session's OWN net spend — its consume row, less any refund linked to it. Neither a restart inside the reuse
  // window (no consume row) nor a refunded consume is "a credit used". Unlinked refunds name no session and never count.
  // Org-scoped as reuseWindowOpen's arithmetic is; the lookup itself rides V425's partial (session_id) index on every
  // poll rather than walking the org's whole ledger through (org_id, created_at).
  const [spend] = await sql<{ net: number }[]>`
    select coalesce(sum(delta), 0)::int as net from org_stream_credits
     where org_id = ${row.org_id} and session_id = ${row.id} and reason in ('consume', 'refund')`;
  // D3: `since` is when the destination last received (I1, B2 review): for a non-ok word, the first ingest_status event
  // after the last one that read `ok` — so a flip BETWEEN two non-ok words (unknown → connecting) is inside the same
  // not-receiving period and never restarts the 30 s clock; for `ok`, the first event after the last non-ok one. These
  // are the events the poll above already records on every change (Ruling 13). CLAMPED to the session's `live_at`. The
  // destination is not tried before the phone is live, and Cloudflare reads `unknown` (non-ok) all through warming,
  // so an unclamped run would start the 30 s clock during warming and warn on the first live render (review #9). While
  // live, `since` is therefore "non-ok while live". `greatest` ignores a null `live_at` (not live yet). Null for
  // composed sessions and whenever this poll did not read the output.
  // I-2a (controller ruling 2026-10-01, B5 re-review 2 §3): for a NON-ok word it is clamped to the phone's latest
  // RECONNECT as well — an ingest_status event INTO `connected` from anything else. The mirror of the live clamp: the
  // destination is not fed while the phone is silent either, so when the phone returns Cloudflare re-dials it, and a
  // clock carried over from the drop put the stream-key box up at once over a key that was fine. A drop never moves it
  // (the last connect predates the drop), so the phone box's timing is unchanged; the key box needs 30 s of the phone
  // sending with the destination still not receiving. An `ok` word's since is not clamped: a phone that came back
  // without the destination ever stopping never restarted its receiving.
  let output: StreamSessionCurrent["output"] = null;
  if (row.mode === "passthrough" && outputObserved !== null) {
    const sinceAt = coalescedSince !== undefined ? coalescedSince
      : ((await sql<{ since: Date | null }[]>`select ${outputSinceExpr(row.id, outputObserved === "ok")} as since`)[0]?.since ?? null);
    const since = new Date(sinceAt ?? deps.now());
    // M6: the elapsed on THIS clock, at this response — the client judges D3 on it, never on the browser's clock.
    output = { state: outputObserved, since: since.toISOString(), elapsedMs: Math.max(0, deps.now().getTime() - since.getTime()) };
  }
  const allowance = await restartAllowance(sql, { orgId: row.org_id, fixtureId, excludeSessionId: null }, deps.now());
  // W24 (§6.12, T9): the countdown to the end the tick will make, from the clocks the tick judges (phoneFactsOf: the
  // phone's beat, the last connected sample, first ingest) and the row's warming entry, on this response's clock, and
  // from the reading THIS tick judged on (controller rulings 2026-10-04: shown iff that end fires, naming the EARLIEST
  // end and its reason; lostCountdown gates each end on what it reads). Ask 10's clock is the tick's own mapping. A session with no phone (C-1: pairing_id null) has no phone rules, so it has no
  // countdown either.
  const facts = await phoneFactsOf(sql, row.id);
  const countdownOf = (chargeStands: boolean) => lostCountdown({
    state: row.state, firstIngestAt: facts!.first_ingest_at, warmingAt: d(row.warming_at), phoneBeatAt: facts!.phone_beat_at,
    read: { fresh: freshIngest, served: ingestState?.state ?? null, failed: phoneReadFailed }, lastConnectedSampleAt: facts!.last_connected_at,
    phone: ask10PhoneOf(facts!),
    // R2008, I1: a composed session's countdown is built from the camera facts THIS tick judged on (null: no rule could fire).
    camera: camera && { startedAt: d(row.started_at), liveOnceAt: camera.live_once_at, reconnectingSince: camera.reconnecting_since, waitedOnly: camera.waited_only, logBeganAt: camera.log_began_at, chargeStands },
  }, deps.now(), {
    silentFloorSeconds: tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS),
    lostMinutes: tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES), warmingMinutes: WARMING_TIMEOUT_MINUTES,
    quietSeconds: RECONNECT_QUIET_SECONDS,
  });
  let countdown = facts?.has_phone ? countdownOf(false) : null;
  // Free-gaps (owner ruling 2026-10-20): a never-live countdown asks the SAME question the end acts on — will the credit come back
  // (or was none taken), or does the charge stand? — and only a never-live countdown pays for the ledger read. It re-names itself
  // with the answer; every other countdown is untouched.
  if (countdown?.kind === "live" && countdown.reason === "camera_never_live") {
    const standing = await neverLiveRefundStanding(sql, { orgId: row.org_id, sessionId: row.id, fixtureId: row.fixture_id }, deps.now());
    if (standing.chargeStands) countdown = countdownOf(true);
  }
  return {
    id: row.id, fixtureId, mode: row.mode, state: row.state, desiredState: row.desired_state, failReason: row.fail_reason,
    overlay: row.mode === "composed" ? { themeId: row.theme_id, delayMs: row.overlay_delay_ms } : null,
    health: row.heartbeat_at ? { fps: hb?.fps ?? null, bitrateKbps: hb?.bitrateKbps ?? null, lastBeatAt: new Date(row.heartbeat_at).toISOString() } : null,
    ingest: ingestState, output,
    balance: await creditBalance(sql, row.org_id),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    replayUrl: fx?.stream_url ?? null,
    target: { id: target!.id, kind: target!.kind, label: target!.label },
    fixtureDecided: fx?.status === "decided" || fx?.status === "finalized",
    fixtureHeld: fx?.status === "needs_decision",
    endReason: row.end_reason,
    creditUsed: spend!.net < 0,
    // I-1 + W23 (T6b, A9(a)): admission's own question, on admission's own clock (startBroadcast asks `restartAllowance`
    // with deps.now()), so the tab's "free restart" and the gate that waives the balance cannot disagree. `restart` is the
    // allowance (null while no window is open) — the one restart field since T11 retired the derived boolean beside it.
    restart: allowance.windowOpen ? allowance : null,
    startCause: row.start_cause,
    countdown,
  };
}

/** A12 / plan R-3 (controller, 2026-10-07): an organiser's Stop of a NON-terminal session turns automatic start off for the
 *  match (`auto_start_blocked_at`). Stamped on the transaction that DECIDES the stop (`apply`'s command function, the locked
 *  row, or the repeated tap's own lock), so the stamp commits or rolls back with the stop: a Stop the database refuses leaves
 *  no stamp, and a stamp can never survive without its stop. NOT stamped by: a Stop of a terminal session, a 409
 *  `not_active`, the tick's / the sweep's ends (`phone_lost`), the phone's own stop, `expireTargetHolders` (FP12) — none is
 *  an organiser's intent.
 *  A stamp that FAILS is reported and the Stop proceeds (a live broadcast must stop), so it runs in a SAVEPOINT: a failed
 *  statement aborts a Postgres transaction, and only the savepoint lets the stop's own writes carry on past it. */
async function stampOrganiserStop(tx: Tx, auth: AuthCtx, fixtureId: string, deps: SessionDeps): Promise<void> {
  try {
    await tx.savepoint((sp) => markAutoStartBlocked(auth.orgId, fixtureId, deps.now(), auth.userId ?? null, sp));
  } catch (err) {
    log.error({ err: String(err), orgId: auth.orgId, fixtureId }, "stream session: the Stop's automatic-start block was not stamped — the Stop proceeds");
    captureError(err, { orgId: auth.orgId, route: "relay.session.stop_stamp", extra: { fixtureId } });
  }
}

export async function stopSession(auth: AuthCtx, fixtureId: string, sessionId: string, deps: SessionDeps): Promise<StreamSessionCurrent> {
  const row = await readRow(sessionId);
  if (!row || row.fixture_id !== fixtureId || row.org_id !== auth.orgId) throw new HttpError(404, "session not found");
  // m7 (fix round 1): a REPEATED stop — a double tap, or a retry after a lost response — is idempotent. A session already
  // stopping (`ending`) or stopped is answered with the same projection the first stop returned, and nothing is DECIDED:
  // no decision, no provider call. A stop naming a session the fixture has since SUPERSEDED stays 409 not_active: the
  // fixture's projection would describe a DIFFERENT session.
  if (row.state === "ending" || isTerminal(row.state)) {
    if ((await latestRow(fixtureId))?.id !== sessionId) throw new HttpError(409, "session is not running", "not_active");
    // Task 10 n5: the TAP is still the organiser's action. A session `ending` for another reason (the deadline, a failure)
    // otherwise kept no record that anyone pressed Stop. The row names the actor and the state the tap met, under the row
    // lock (`seq` is per session); it decides nothing. A finished session's tap asks for nothing and is not recorded.
    if (row.state === "ending") {
      await sql.begin(async (tx) => {
        const locked = await lockRow(tx, sessionId);
        await recordEvent(tx, { sessionId, orgId: row.org_id, source: "client", kind: "action", type: "stop", actorUserId: auth.userId ?? null,
          occurredAt: deps.now(), payload: { state: locked?.state ?? row.state } });
        // A12 (R-3): the tap on a session still `ending` is a Stop of a non-terminal session — judged on the LOCKED row.
        if (locked && !isTerminal(locked.state)) await stampOrganiserStop(tx, auth, fixtureId, deps);
      });
    }
    return (await currentSession(auth, fixtureId, deps))!;
  }
  // M10: with no relay there is no provider to stop through — the session is ended failed(relay_disabled), the
  // reconcile's own decision, and the projection answers. Never the `stop` below, whose composed arm asks the runner and
  // would throw. N5 (Task 14b re-review): it goes through `apply` WITH the actor, so the tap is still the organiser's
  // recorded action (Task 10 n5) — the row names her and the decision her Stop made. A session another writer finished
  // first decides nothing and records nothing, as below.
  if (deps.drivers.disabled) {
    await apply(sessionId, async (s, tx) => {
      if (isTerminal(s.state)) return null;
      await stampOrganiserStop(tx, auth, fixtureId, deps);
      return { type: "relay_disabled" };
    }, deps, { userId: auth.userId ?? null, source: "client" });
    return (await currentSession(auth, fixtureId, deps))!;
  }
  // m1: re-decided on the LOCKED row (T5-a). A session another writer FINISHED after the read above (an expiry, a failure)
  // writes nothing — no decision, no tap, the same as the finished-session branch above — and the projection answers.
  // `ending` is still decided: `ending × stop` is identity, and it records the tap (n5). The A12 stamp rides this same
  // locked row (R-3): a terminal row writes neither the stop nor the stamp.
  await apply(sessionId, async (s, tx) => {
    if (isTerminal(s.state)) return null;
    await stampOrganiserStop(tx, auth, fixtureId, deps);
    return { type: "stop", reason: "stopped" };
  }, deps, { userId: auth.userId ?? null, source: "client" });   // passthrough: the complete_now effect finishes it; composed: runner session_stop → SIGINT → observed destroyed → completed. The actor lands as an `action` row (ruling 13); stop_requested_at is set by persistFacts.
  return (await currentSession(auth, fixtureId, deps))!;
}

async function jobSession(sessionId: string, token: string, deps: SessionDeps): Promise<Session> {
  await verifyRelayToken(token, { sid: sessionId, scope: "relay-job" });
  const s = await reconcileSession(sessionId, deps);                        // B: the Machine's own reads tick the policy too
  if (!s) throw new HttpError(404, "session not found");
  if (isTerminal(s.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  return s;
}

/** R2004 review m1: the secrets a composed Machine HOLDS, for scrubbing its free text — its job token, the programme
 *  input's stream key (it publishes there) and the camera's SRT playback passphrase and stream id (it reads there). The
 *  destination key never reaches a Machine (spec §5.3), so it is not one of them. Read only for a beat that carries
 *  free text; a read that fails still scrubs the token and every shape `scrubBeatText` knows, and says so. */
async function beatSecretsOf(sessionId: string, mode: string, token: string): Promise<string[]> {
  if (mode !== "composed") return [token];
  try {
    const { programme, playback } = await sql.begin(async (tx) => ({
      programme: await readFirstInput(tx, sessionId, "programme"),
      playback: await readCameraPlayback(tx, sessionId),
    })) as { programme: Awaited<ReturnType<typeof readFirstInput>>; playback: Awaited<ReturnType<typeof readCameraPlayback>> };
    return [token, programme?.rtmps?.streamKey, playback?.passphrase, playback?.streamId].filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch (err) {
    log.warn({ sid: sessionId, err }, "stream session: a composed beat's credentials could not be read to scrub its exit detail — scrubbed by shape and token only");
    return [token];
  }
}


/** The programme phase the STORED beat carries (whatever attempt wrote it), null when it carries none. */
const storedPhaseOf = (row: Row): string | null =>
  typeof row.last_heartbeat?.programmePhase === "string" ? row.last_heartbeat.programmePhase : null;

/** R2008: one `programme_phase` event per CHANGE of the phase the compositor reports THAT A RULE READS
 *  (`programmePhaseRowMatters`), written in the transaction that stores the beat, under the row lock — so the log and
 *  `last_heartbeat` cannot disagree, and the tick's locked re-take reads a log that already holds every beat stored before it
 *  took the lock. `from` is the phase the STORED beat carried (whatever attempt wrote it) and `to` this beat's, null for a
 *  beat that reports none: a Machine that stops reporting a phase has stopped saying `reconnecting`, which must end that run
 *  (the safe direction). Keyed to the beat's attempt by the typed `attempt` column — only the CURRENT attempt's phase is a
 *  claim about the camera now; a superseded beat never gets here (it returns before the write, #983 r1), so a stray Machine's
 *  `live` or `reconnecting` is no evidence either way.
 *  Rows are for what the rules read — `live`, `reconnecting`, `waiting`, a break in a run, a new attempt's first beat — so a
 *  camera flickering `live` <-> `frozen` all match long adds nothing: a `frozen` out of `live` is a blip (it is `reconnecting`,
 *  three seconds on, that is an outage), and `live` again after it is the phase the log already holds. The phase-change
 *  decision is taken on `cur`, the LOCKED row: two beats that peeked the same stored phase are serialised by the lock, and
 *  the second reads what the first left (the "m1" race test). The last-row read it adds runs only for a beat that CHANGES the
 *  stored phase, never on a steady one.
 *  Why a log of changes and not the beat samples: a sample carries no attempt (`raw` is the whole body, pinned so), is written
 *  after the beat's lock is released, and stops at SAMPLES_PER_SESSION_CAP; an event has none of those three faults. */
async function logProgrammePhase(tx: Tx, cur: Row, beat: RelayHeartbeat, at: Date): Promise<void> {
  const stored = storedPhaseOf(cur);
  const phase = beat.programmePhase ?? null;
  // The first beat after a replacement boots (or a stale window moved the anchor) is looked at even when its phase equals the
  // stored one: the stored beat is another process's, and without a row of its own a new attempt that opens on the phase its
  // predecessor ended on would have nothing to say the CURRENT attempt is reconnecting. A same-attempt blip that re-anchors
  // the window logs one duplicate, which can only restart a run (the safe direction).
  if (phase === stored && storedBeatIsThisAttempt(cur)) return;
  const [last] = await tx<{ to_state: string | null; attempt: number | null }[]>`
    select to_state, attempt from fixture_stream_events where session_id = ${cur.id} and type = ${PROGRAMME_PHASE_EVENT} order by seq desc limit 1`;
  if (!programmePhaseRowMatters(phase, last ? { to: last.to_state, attempt: last.attempt } : null, cur.runner_attempts)) return;
  await recordEvent(tx, { sessionId: cur.id, orgId: cur.org_id, source: "runner", kind: "observed", type: PROGRAMME_PHASE_EVENT,
    from: stored, to: phase, attempt: cur.runner_attempts, occurredAt: at });
}

export async function heartbeat(sessionId: string, token: string, body: RelayHeartbeat, deps: SessionDeps): Promise<RelayHeartbeatReply> {
  const { att } = await verifyRelayToken(token, { sid: sessionId, scope: "relay-job" });
  // R2002 review Q3: the Machine's free text is scrubbed before EITHER store keeps it (its job token, anything
  // JWT-shaped, everything from the first `?`), so last_heartbeat and the sample's raw hold the same detail.
  // A PEEK (unlocked, pooled) for the one read that cannot run inside the beat's transaction (lib/db's nesting guard):
  // the secrets to scrub with (R2004 m1), a pooled read of its own. The peek decides NOTHING else — it can be stale by
  // the time the lock is granted (#983 r2): the 410, the superseded attempt, the Owed 37 guard and the sizing alarm's
  // previous rung are all taken on the LOCKED row below.
  const peek = await readRow(sessionId);
  if (!peek) throw new HttpError(404, "session not found");
  if (isTerminal(peek.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  const beat: RelayHeartbeat = body.exitDetail == null ? body : { ...body, exitDetail: scrubBeatText(body.exitDetail, await beatSecretsOf(sessionId, peek.mode, token)) };
  // #983 review r1: a beat whose token names an attempt OLDER than the row's (`superseded`) is a replaced Machine's —
  // received after the retry moved on, where the beat_window_at anchor cannot tell it from the replacement's first beat.
  // It is a SAMPLE only: no row write, no expiry tick, no callback, no sizing alarm, and the reply is `ending` (drain).
  // Decided on the locked row below, and again on each callback's own locked row.
  // The beat is recorded FIRST (a late beat that arrived is not a stale one), then the policy runs.
  // Owed 37 (compositor PR #27): the compositor sends its FINAL beat on a lane of its own, so a periodic beat it sent
  // BEFORE the final can be received — and committed — AFTER it. So whether this beat may overwrite the stored one is
  // decided on the LOCKED row, in the transaction that writes it (an unlocked read let a beat that read the row before
  // the final committed overwrite the final after it). Once this attempt's stored beat is a final that closed the
  // attempt (`closesAttempt`), a non-final beat is a SAMPLE only: last_heartbeat keeps the exit's record, heartbeat_at
  // keeps the stale window running from the final (a late beat would delay `lost`), and the egress count stands. A
  // final beat still writes (a replayed final is the same fact), and so does a beat of a NEW attempt
  // (`storedBeatIsThisAttempt`). The row lock is taken alone — never the org lock — like recordEffect's (A7).
  // G5 (Task 11 review): `egressBytes` is optional, and an omitted field leaves the stored count alone — only a Machine
  // that REPORTS 0 stores 0 (the A29 rule: absent is not a measured zero). Within ONE attempt the count never goes
  // backwards (Owed 37: the GREATEST is kept — a lower count is an overtaken beat); a new attempt's count is its own.
  const { row: before, superseded, previousRung } = (await sql.begin(async (tx) => {
    const cur = await lockRow(tx, sessionId);
    if (!cur) throw new HttpError(404, "session not found");
    if (isTerminal(cur.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
    if (supersededAttempt(att, cur.runner_attempts)) return { row: cur, superseded: true, previousRung: null };
    // Read BEFORE this beat is stored or sampled, on the locked row (#983 r2).
    const previousRung = await previousRungOf(tx, cur);
    const thisAttempt = storedBeatIsThisAttempt(cur);
    if (thisAttempt && closesAttempt(cur.last_heartbeat) && beat.state !== "stopped") {
      log.info({ sid: sessionId, state: beat.state }, "stream session: a beat received after this attempt's final beat is a sample only — the stored final stands");
      return { row: cur, superseded: false, previousRung };
    }
    const egress = beat.egressBytes ?? null;
    if (cur.mode === "composed") await logProgrammePhase(tx, cur, beat, deps.now());   // R2008: with the stored beat, under its lock
    await tx`update fixture_stream_sessions set last_heartbeat = ${sql.json(beat as never)}, heartbeat_at = ${deps.now()},
               egress_bytes = case when ${thisAttempt}::boolean then greatest(${egress}::bigint, egress_bytes)
                                   else coalesce(${egress}::bigint, egress_bytes) end
              where id = ${sessionId}`;
    return { row: cur, superseded: false, previousRung };
  })) as { row: Row; superseded: boolean; previousRung: unknown };
  await sampleBeat(sessionId, before.org_id, beat, deps);
  if (superseded) {
    log.info({ sid: sessionId, state: beat.state, att, attempt: before.runner_attempts }, "stream session: a beat from a superseded attempt's Machine is a sample only — the current attempt is untouched; the Machine is told to drain");
    // #983 review r2 (coordinator ruling): the superseded Machine is answered `ending` whatever the session's own
    // desired state — it is a stray (its force-destroy failed, or has not landed), and a stray told `live` keeps
    // publishing. `ending` drains it; the final beat it then sends is a superseded beat too, so a sample only.
    return { desiredState: "ending" };
  }
  raiseSizingAlarm(before, beat, previousRung);
  let s = (await applyExpiry(sessionId, deps))!;
  // The runner's own callbacks are lifecycle triggers (plan §"Fly machine lifecycle"): playing/stopped, nothing else moves the table from a beat.
  // m1 (lane C final review): each callback is re-decided on the LOCKED row (T5-a) — another writer may have moved the row
  // since `s` was read, and a plain apply the table no longer accepts was InvalidTransition, a 500 on the Machine's beat.
  // callback_playing is refused on a TERMINAL session (it is not a runner cleanup trigger); callback_stopped is one, so a
  // terminal row still takes it. #983 r1: neither is fed to a runner of a LATER attempt than the beat's token names — a
  // retry can land between this beat's write and its callback, and the replacement must not be played (or stopped) by
  // the Machine it replaced.
  if (s.mode === "composed" && (s.runner.state === "booting" || s.runner.state === "playing") && body.state === "playing") {
    s = (await apply(sessionId, (cur) => (cur.mode === "composed" && !isTerminal(cur.state) && (cur.runner.state === "booting" || cur.runner.state === "playing")
      && !supersededAttempt(att, cur.runner.attempt)
      ? { type: "runner", trigger: { type: "callback_playing" } } : null), deps)) ?? s;
  }
  // R2003: a COMPOSED stopped beat is routed by its exit reason (stoppedBeatTrigger): `ended` / `deadline` end the
  // session (I2), `refused` fails it, no reason is today's lost → retry. null = record only — a signalled run is a stop
  // someone else asked for, and a session_gone one is already over. A record-only beat applies nothing (the lifecycle
  // has no trigger for it); its reason stays in last_heartbeat and the sample, and it never writes the runner exit facts
  // (A5). A passthrough stopped beat is untouched.
  // R2003b: `fatal` is `callback_crashed` — one crash, counted toward RUNNER_CRASH_CAP. Below it the runner stays as it
  // was (Fly restarts it in place on the SAME attempt, runner-fly.ts on-failure; if the restarted process never beats,
  // the composed stale window takes it lost → destroyed → the one retry); the crash that reaches the cap fails the session
  // machine_crash and tears the Machine down. It is not a teardown trigger, so it reaches a still-running session only:
  // `decide` refuses it on a terminal one (it would 500 the Machine's beat).
  // Owed 66: `restart` — the compositor's own in-place restart (exit 75) — is `callback_restarted`: NEVER a crash and never
  // counted; Fly restarts the process on the SAME attempt and its beats hold the stale window. The runner only NOTES it
  // (`restartSeen`: this attempt's restart-count floor is dropped, review m1) — from the beat, which goes out before the exit
  // 75 and so does not wait for a read of it. Like `callback_crashed` it is not a teardown trigger: a still-running session only.
  const stopped = s.mode === "composed" && body.state === "stopped" ? stoppedBeatTrigger(body.exitReason) : null;
  if (stopped && (s.runner.state === "stopping" || s.runner.state === "playing" || s.runner.state === "booting")) {
    s = (await apply(sessionId, (cur) => (cur.mode === "composed" && (cur.runner.state === "stopping" || cur.runner.state === "playing" || cur.runner.state === "booting")
      && (stopped.type === "callback_stopped" || !isTerminal(cur.state)) && !supersededAttempt(att, cur.runner.attempt)
      ? { type: "runner", trigger: stopped } : null), deps)) ?? s;
  }
  // Owed 108 fix (b): the phone-live edge counter, read fresh from its row (never from `before`, which predates the writes above)
  // and served on EVERY reply — the relay acts once per increase, so repeating the current value is how it stays idempotent. Absent
  // while the session has no phone-live history (no phone, or a phone that has not published yet): `null` and absent mean the same
  // to the relay, and omitting it keeps the reply of every such session exactly what it was before this field existed. The
  // superseded Machine's drain reply above carries none: a stray must only drain, never be nudged to reconnect.
  const [live] = await sql<{ phone_live_edge: number | null }[]>`select phone_live_edge from fixture_stream_sessions where id = ${sessionId}`;
  return live?.phone_live_edge == null ? { desiredState: s.desiredState } : { desiredState: s.desiredState, phoneLiveEdge: live.phone_live_edge };
}

/** The rung the sizing alarm's dedupe compares a beat with: the previous beat's, when that beat belongs to this attempt.
 *
 *  #980 review M2: the dedupe is per ATTEMPT. A retry boots a new Machine — a new process, whose ladder starts on
 *  `full` — and restarts the beat window (beat_window_at, I4: "booted a replacement … restarts the window here"). A
 *  stored beat from before that anchor is the OLD Machine's, so its rung says nothing about this one: the new attempt's
 *  first stepped beat alarms. (The stale-beat arm moves the anchor too; a re-alarm after it is the safe direction.)
 *
 *  #980 review, carried into R2004: a `stopped` beat is a process's FINAL beat and reports no rung. Fly restarts a
 *  crashed compositor IN PLACE (the same Machine and attempt), so the dedupe reads THROUGH that beat to the attempt's
 *  last live beat — kept whole in the beat samples — and the restarted process's first beat on the rung its predecessor
 *  held is no new step. Read only after a final beat, so an ordinary beat costs no query. A read that fails answers
 *  null: an extra alarm is the safe direction for a sizing alarm, a lost one is not. */
async function previousRungOf(tx: Tx, before: Row): Promise<unknown> {
  if (before.mode !== "composed") return null;
  if (!storedBeatIsThisAttempt(before)) return null;
  if (before.last_heartbeat?.state !== "stopped") return before.last_heartbeat?.rung ?? null;
  // #983 r2: read on the beat's own row-lock transaction (the LOCKED row's anchor, no second pooled connection), in a
  // SAVEPOINT: a read that fails rolls back to it and answers null, and the beat's write still commits — without the
  // savepoint a failed read would abort the whole transaction and 500 the beat.
  try {
    return await tx.savepoint((sp) => latestLiveRung(sp, before.id, before.beat_window_at));
  } catch (err) {
    log.error({ sid: before.id, err: String(err) }, "stream session: the sizing alarm's previous rung could not be read — the beat may re-alarm");
    return null;
  }
}

/** #983 review r1: whether a beat's job token names an attempt OLDER than the session's current one (runner_attempts,
 *  the create calls made) — i.e. it is the beat of a Machine a retry replaced. `att` null is a token minted before the
 *  claim existed (a session in flight across the deploy): never superseded, so it keeps the behaviour it had. */
function supersededAttempt(att: number | null, currentAttempt: number): boolean {
  return att !== null && att < currentAttempt;
}

/** Whether the row's STORED beat belongs to the current attempt. #980 review M2: a retry boots a new Machine — a new
 *  process — and restarts the beat window (beat_window_at, I4: "booted a replacement … restarts the window here"), so a
 *  stored beat from before that anchor is the OLD Machine's. (The stale-beat arm moves the anchor too: after it a stored
 *  beat reads as another attempt's, so a rung re-alarms and the next beat writes — the direction that never drops a live
 *  process's beat.) The sizing alarm's dedupe and the beat route's Owed 37 guard read it. It judges the STORED beat,
 *  which carries no attempt of its own; the INCOMING beat's attempt is its token's `att` (`supersededAttempt`). */
function storedBeatIsThisAttempt(row: Pick<Row, "beat_window_at" | "heartbeat_at">): boolean {
  return row.beat_window_at == null
    || (row.heartbeat_at != null && new Date(row.heartbeat_at).getTime() > new Date(row.beat_window_at).getTime());
}

/** Owed 37: a stored beat that is a FINAL after which no live process of this attempt is left to beat. Every stopped beat
 *  but two: a `fatal` final is a crash, and a `restart` final (Owed 66) the compositor's own in-place restart — Fly restarts
 *  both IN PLACE on the SAME attempt (R2003b / `restartsInPlaceAfter`, runner-fly.ts `on-failure`), and the restarted
 *  process's beats are what hold the composed stale window off — so they must still write (AGENTS.md class 13). A late
 *  beat of the exited process is indistinguishable from them without a seq, and writes too. The rest (R2003): no reason
 *  tears the Machine down (its retry is a NEW attempt), `ended` / `deadline` / `refused` end the session, `signalled` is
 *  exit 0 (Fly never restarts it), and `session_gone` is a run whose session is already over. */
function closesAttempt(stored: Row["last_heartbeat"]): boolean {
  if (stored?.state !== "stopped") return false;
  return !restartsInPlaceAfter(stored.exitReason as RelayHeartbeat["exitReason"]);
}

/** The relay sizing alarm (owner ruling 2026-10-18, compositor `docs/_INDEX.md` Owed 20: "no lite mode; if CPU impacts,
 *  measure and raise the CPU size"). The compositor's ladder is `full → overlay_half_rate` and the bottom holds, so a
 *  composed beat that STEPPED DOWN says its Machine is short of CPU. It is raised once per step and per attempt
 *  (domain/ladder.ts `steppedDownTo`, against the previous beat's STORED rung — so a web restart keeps the dedupe — when
 *  that beat belongs to this attempt), on two channels: a structured warning (`alarm: "sizing"`)
 *  and the house alerting path, Sentry, under route `relay.sizing_alarm` with ONE message so every alarm groups as one
 *  issue. Ops answer it by raising the Machine size (compositor C17 runbook). A passthrough session has no Machine, so it
 *  never alarms. Telemetry, like the sample: it never throws into the beat. */
function raiseSizingAlarm(before: Row, beat: RelayHeartbeat, previousRung: unknown): void {
  if (before.mode !== "composed") return;
  const rung = steppedDownTo(previousRung, beat.rung);
  if (rung === null) return;
  const facts = { sessionId: before.id, rung, previousRung, attempt: before.runner_attempts, machineId: before.machine_id };
  try {
    log.warn({ sid: before.id, orgId: before.org_id, alarm: "sizing", rung, previousRung, attempt: facts.attempt, machineId: facts.machineId },
      `relay sizing alarm: the compositor's degrade ladder stepped down to ${rung} — the Machine is short of CPU; raise the Machine size (compositor C17 runbook)`);
    captureError(new Error("relay sizing alarm: the compositor's degrade ladder stepped down — raise the Machine size"),
      { orgId: before.org_id, route: "relay.sizing_alarm", extra: facts });
  } catch (err) {
    log.error({ sid: before.id, err: String(err) }, "stream session: the sizing alarm was not raised — the beat is answered anyway");
  }
}

/** Ruling 13: every beat is a SAMPLE — typed columns from the fields RelayHeartbeat (Task 9) declares, the whole body in
 *  `raw` (sanitised). Capped per session; the cap is reported ONCE as an event.
 *
 *  ISOLATED, not transactional (Task 11 review I1b): a sample is telemetry and the beat is the control channel. A sample
 *  write that throws is logged and the beat goes on — its expiry tick, its callback_playing / callback_stopped and its
 *  reply. ONE transaction with the lifecycle is not available: the lifecycle is several transactions by design
 *  (applyExpiry and each callback `apply` take the row lock, commit, THEN run provider effects — the row lock is never
 *  held across a provider call), and a sample inside any of them would roll that transition back with it. telemetry.ts's
 *  `fitToColumn` removes the known cause (ffmpeg's fractional numbers in integer columns); this isolation is for the next. */
async function sampleBeat(sessionId: string, orgId: string, body: RelayHeartbeat, deps: SessionDeps): Promise<void> {
  try {
    const wrote = await recordSample(sql, { sessionId, source: "heartbeat", sampledAt: deps.now(), ingestState: body.state ?? null,
      fps: body.fps ?? null, bitrateKbps: body.bitrateKbps ?? null, droppedFrames: body.droppedFrames ?? null, encoderSpeed: body.encoderSpeed ?? null,
      runnerCpuPct: body.cpuPct ?? null, runnerMemMb: body.memMb ?? null,
      // Dh has NO source on this path, stated rather than left to look forgotten: `ingest_reason` is
      // Cloudflare's status.current.reason, and a Machine's beat reports the MACHINE, not the ingest
      // input. Reading the input here would add a paid Cloudflare call per beat (every 5 s per live
      // session). Explicitly null — a borrowed value in a column whose whole purpose is "what the
      // provider said" is a fabricated fact, and the poll writer is the one that fills it.
      ingestReason: null, raw: body });
    if (wrote === "capped") {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'samples_capped'`;
      if (n === 0) await sql.begin(async (tx) => { await lockRow(tx, sessionId); await recordEvent(tx, { sessionId, orgId, source: "runner", kind: "event", type: "samples_capped", occurredAt: deps.now(), payload: { count: SAMPLES_PER_SESSION_CAP } }); });
    }
  } catch (err) {
    log.error({ sid: sessionId, code: (err as { code?: string }).code ?? null, err: String(err) }, "stream session: a heartbeat sample was not recorded — the beat is answered anyway");
  }
}

/** R2002: the `data` of GET /api/internal/relay/sessions/{sid}, typed as the relay-job.v1 contract's session (STRICT:
 *  a key this returns that the contract does not declare is a tsc error here, and C07 refuses it on the wire). */
export async function sessionFactsForJob(sessionId: string, token: string, deps: SessionDeps): Promise<RelayJobSession> {
  const s = await jobSession(sessionId, token, deps);
  const row = (await readRow(sessionId))!;
  const pageToken = await mintRelayToken({ sid: sessionId, scope: "relay-page", expiresAt: relayTokenExpiry(s) });
  const base = { sessionId, fixtureId: s.fixtureId, mode: s.mode, themeId: row.theme_id, overlayDelayMs: row.overlay_delay_ms, maxDurationMinutes: s.maxDurationMinutes, pageToken };
  if (s.mode !== "composed") {
    // Passthrough has no Machine; its shape is today's, for contract completeness. T11: an API-backed session's is its
    // broadcast's pooled key — the same destination its Cloudflare output carries.
    const target = (await sql.begin(async (tx) => readSessionDestination(tx, await destinationRowOf(tx, sessionId)))) as { url: string; streamKey: string };
    return { ...base, target };
  }
  // #981 follow-up (C07 review; coordinator decision): the overlay page is `/overlay/fixtures/<fixtureId>`, and a fixture
  // deleted mid-session (V410 `on delete set null`) left the compositor `/overlay/fixtures/null`, which it accepted. A
  // composed session with no fixture has no page to render, so its facts are refused — 404 FIXTURE_GONE, a status C07's
  // GET table maps to `Refused` (exit 78, fatal config: the host does not restart it). Passthrough has no page; its facts
  // still answer `fixtureId: null`.
  if (s.fixtureId === null) {
    log.warn({ sid: sessionId, orgId: s.orgId, state: s.state }, "stream session: a composed session's fixture has been deleted — its job facts are refused");
    throw new HttpError(404, "the session's fixture has been deleted", "FIXTURE_GONE");
  }
  const fixtureId = s.fixtureId;
  // R2004 (spec §5.3): the Machine READS the camera (Input A) over SRT playback and PUBLISHES to the programme (Input B)
  // over RTMPS. The destination is a Cloudflare output on B, so its key is never read here and never reaches the Machine.
  const { programme, playback, sportKey } = (await sql.begin(async (tx) => ({
    programme: await readFirstInput(tx, sessionId, "programme"),
    playback: await readCameraPlayback(tx, sessionId),
    sportKey: (await tx<{ sport_key: string }[]>`select sport_key from fixture_stream_sessions where id = ${sessionId}`)[0]!.sport_key,
  }))) as { programme: Awaited<ReturnType<typeof readFirstInput>>; playback: Awaited<ReturnType<typeof readCameraPlayback>>; sportKey: string };
  // Provisioning stores both before the Machine is asked for, so a composed session past `provisioned` always has them. A
  // row without either is refused by name — never a session served with a guessed or empty credential.
  if (!programme?.rtmps) throw new Error(`stream session ${sessionId}: a composed session has no programme input credential to publish to`);
  if (!playback) throw new Error(`stream session ${sessionId}: a composed session has no camera playback credential to read`);
  // R2004 decision 5 / 7: the overlay page the compositor renders. `sid` because verifyRelayToken needs the expected sid;
  // `template` RESOLVED from the session's copy, so the URL always names a live, non-retired template.
  const overlay = new URL(`/overlay/fixtures/${encodeURIComponent(fixtureId)}`, deps.appUrl);
  overlay.search = new URLSearchParams({
    sid: sessionId, st: pageToken, host: "compositor", delay: String(row.overlay_delay_ms), template: resolveTemplate(row.theme_id, sportKey).id,
  }).toString();
  return RelayJobSession.parse({
    ...base,
    target: { url: programme.rtmps.url, streamKey: programme.rtmps.streamKey },
    input: { protocol: "srt", url: playback.url, streamId: playback.streamId, passphrase: playback.passphrase },
    output: relayOutputProfile(),
    heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
    overlayUrl: overlay.toString(),
  });
}

/** Ruling F / design §12.6: on completed, when fixtures.stream_url is null and
 *  the destination is YouTube with a watch URL, write it through the ONE
 *  stream-link path. Never overwrites a club's own link. */
export async function fillReplayUrl(sessionId: string): Promise<void> {
  const [row] = await sql<{ fixture_id: string; org_id: string; created_by: string; kind: string; watch_url: string | null; stream_url: string | null }[]>`
    select s.fixture_id, s.org_id, s.created_by, t.kind, t.watch_url, f.stream_url
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      join fixtures f on f.id = s.fixture_id
     where s.id = ${sessionId}`;
  if (!row || row.stream_url !== null || row.kind !== "youtube" || !row.watch_url) return;
  const actor: AuthCtx = { orgId: row.org_id, via: "session", userId: row.created_by, role: "owner", keyId: null };
  await setFixtureStreamUrl(actor, row.fixture_id, row.watch_url);
}

/** D2 — before Replace key or Remove reads "held", each current holder of the target gets its lazy expiry, the tick
 *  Go live's `targetHolderFor` already gives it: a session stuck past its deadline must not refuse a Remove forever.
 *  Outside any transaction (expiry may call the provider). Called by the stream-targets [targetId] route.
 *
 *  M-3 (final review): `targetId: null` ticks every holder of the ORG's destinations — the Directory's Streaming tab,
 *  before it lists them. Its "In use" lock disables exactly the Replace and Remove buttons whose routes tick a single
 *  target, so an abandoned Go live otherwise kept the lock up until someone opened that match or the daily sweep ran.
 *  A holder that is not due is untouched (applyExpiry reads it and finds nothing to do).
 *
 *  B0 (R-3's routed item, 2026-10-01): EACH holder is best-effort. A tick that throws — a provider failure recordEffect
 *  rethrows, or the apply's own write — is reported (captureError, route relay.expire_target_holders) and the loop goes
 *  on; it used to end the loop, so every LATER holder kept its lock until the next load. The answer names what the
 *  tick did: `expired` — the holders it left no longer holding the destination (a terminal state); `failed` — the holders
 *  whose tick threw and that STILL hold it. A holder that was not due is in neither.
 *
 *  B0 fix round 1 (m-2): a throw is classified by what COMMITTED, not by the throw. `apply` commits the decision before
 *  `runEffects`, so an effect that throws after commit (a post-completion `fill_replay` recordEffect rethrows) leaves the
 *  holder terminal — `expired`, and still reported. The row is re-read to tell; a re-read that itself fails says nothing
 *  about what committed, so the holder stays `failed`. */
export async function expireTargetHolders(orgId: string, targetId: string | null, deps: SessionDeps): Promise<{ expired: string[]; failed: string[] }> {
  const expired: string[] = [];
  const failed: string[] = [];
  for (const h of await holderRows(sql, targetId === null ? { orgId } : { orgId, targetId })) {
    try {
      const after = await applyExpiry(h.sessionId, deps);
      if (after && isTerminal(after.state)) expired.push(h.sessionId);
    } catch (err) {
      captureError(err, { orgId, route: "relay.expire_target_holders", extra: { sessionId: h.sessionId, targetId } });
      const now = await readRow(h.sessionId).catch(() => null);
      (now && isTerminal(now.state) ? expired : failed).push(h.sessionId);
    }
  }
  return { expired, failed };
}
