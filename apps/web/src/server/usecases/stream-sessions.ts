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
import { sql, type Tx } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import { hasFeature, overrideRow } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamSession, RelayHeartbeat, StreamSessionCurrent } from "@/server/api-v1/schemas";
import type { CaptureQrV1 } from "@/lib/capture-qr";
import { checkDestination } from "@/lib/stream-destinations";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import {
  CLOUDFLARE_STORED_MICROS_PER_MINUTE, EST_COST_CURRENCY, FLY_BILLING_SECONDS_PER_MONTH,
  FLY_PERFORMANCE_CPU_MICROS_PER_MONTH, FLY_PERFORMANCE_INCLUDED_GB_PER_CPU, FLY_RAM_MICROS_PER_GB_MONTH,
  MAX_DURATION_MINUTES, QR_PREFERRED_DEFAULT, RUNNER_DEFAULT_GUEST, RUNNER_DEFAULT_REGION, SAMPLES_PER_SESSION_CAP, SRT_LATENCY_MS,
  relayEnvironment,
} from "@/server/relay/config";
import {
  ACTIVE_STATES, TERMINAL_STATES, InvalidTransition, admit, decide, eventRowsOf, holdStateOf, isTerminal,
  type Command, type Decision, type Effect, type HoldState, type Session, type SessionState,
} from "@/server/relay/domain/session";
import { InvalidRunnerTransition, machineNameFor, type ExitInfo, type RunnerEffect } from "@/server/relay/domain/runner";
import { evaluate, runnerDeadlineOf, type Expiry } from "@/server/relay/domain/expiry";
import { headroomAfterReservations } from "@/server/relay/domain/credits";
import { relayDrivers, type RelayDrivers } from "@/server/relay/drivers";
import { createFailureOf, createRefusedBeforeCall, type IngestProtocol, type IngestState, type OutputState, type RunnerSpec, type StorageUsage } from "@/server/relay/ports";
import { TargetSecretUnreadableError, lockStreamTarget, readFirstInput, readTargetSecret, storeInputCredentials } from "@/server/relay/secret-columns";
import { recordEvent, recordSample, recordStorageSnapshot } from "@/server/relay/telemetry";
import { mintRelayToken, relayTokenExpiry, verifyRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import {
  NoCreditsError, consumeForSession, creditBalance, creditBreakdown, ensureMonthlyStreamGrant, ensureMonthlyStreamGrantWithRate,
  lockOrg, reuseWindowOpen, streamMonthlyRate, type StreamCreditBreakdown,
} from "./stream-credits";
import { DestinationNotAllowedError, TargetUnreadableError } from "./stream-targets";
import { holderHref, holderRows, wireHolder, type TargetHolder } from "./stream-target-holders";
import { setFixtureStreamUrl } from "./fixtures";

export { ACTIVE_STATES, TERMINAL_STATES };

/** M6: the states a session can still CONSUME from, i.e. not yet live — `apply` reads the org's monthly rate (a pooled
 *  read) for these alone. The domain decides a consume only from `warming`, and states only move forward. */
const CAN_STILL_CONSUME: readonly Session["state"][] = ["requested", "provisioning", "warming"];

export interface SessionDeps { drivers: RelayDrivers; now: () => Date; appUrl: string }
export function defaultDeps(appUrl: string): SessionDeps {
  return { drivers: relayDrivers(), now: () => new Date(), appUrl };
}

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
  created_by: string; created_at: string;
  output_uid: string | null;   // C1: the domain's proof an output exists to release (Session.outputUid)
}
/** A FUNCTION, not a module-scope fragment: building a `sql` fragment opens the pooled client, and `next build`
 *  evaluates this module (through the daily sweep's cron route) to collect route config in a process with no
 *  DATABASE_URL — PR #902's build died there, and every unit shard without a database failed to collect the suites
 *  importing it. That cron route's own test loads this module with no database to hold that. */
const cols = () => sql`id, fixture_id, org_id, mode, state, desired_state, fail_reason, end_reason, theme_id, overlay_delay_ms,
  target_id, machine_id, last_heartbeat, heartbeat_at, beat_window_at, started_at, ended_at, ending_at, max_duration_minutes,
  runner_retries, runner_attempts, runner_state, runner_name, runner_stop_requested_at,
  runner_exit_code, runner_oom_killed, runner_requested_stop, created_by, created_at, output_uid`;

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
    runner: {
      // C3: ONE authority for the attempt — the persisted `runner_attempts` (create calls MADE).
      // Deriving it as `runner_retries + (state === "none" ? 0 : 1)` disagrees with the row after an
      // inline retry (the reread gives 2 where the domain rule `t.attempt === r.attempt + 1` wants 1),
      // and every retry test fails with InvalidTransition.
      state: r.runner_state, attempt: r.runner_attempts, name: r.runner_name,
      machineId: r.machine_id, stopRequestedAt: d(r.runner_stop_requested_at), lastExit: exitOf(r),
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
 *  the last `booting` runner_transition AFTER the last `destroyed` one, its
 *  occurred_at to NOW on entering `destroyed` (each boot billed once, M2). */
async function persistFacts(tx: Tx, before: Session, next: Session, cmd: Command, now: Date): Promise<void> {
  if (before.state !== "live" && next.state === "live") {
    await tx`update fixture_stream_sessions set live_at = coalesce(live_at, ${now}) where id = ${next.id}`;
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
    const [boot] = await tx<{ occurred_at: string }[]>`
      select b.occurred_at from fixture_stream_events b
       where b.session_id = ${next.id} and b.kind = 'runner_transition' and b.to_state = 'booting'
         and b.seq > coalesce((select max(d.seq) from fixture_stream_events d
                                where d.session_id = ${next.id} and d.kind = 'runner_transition' and d.to_state = 'destroyed'), 0)
       order by b.seq desc limit 1`;
    if (boot) {
      const seconds = Math.max(0, Math.round((now.getTime() - new Date(boot.occurred_at).getTime()) / 1000));
      await tx`update fixture_stream_sessions set machine_seconds = machine_seconds + ${seconds} where id = ${next.id}`;
    }
  }
  // Df: the cost estimate, at the TERMINAL transition — the first instant at which machine_seconds and
  // the guest are final. Read the row back inside this transaction so the machine_seconds just written
  // above is included. `is null` makes it idempotent: a repeat of the same terminal transition never
  // moves a recorded estimate. The STORAGE term is refined later by the sweep, which is the one writer
  // that learns `recording_seconds` (Task 12 step 5) — at this instant it is usually still 0, and the
  // sweep recomputes rather than leaving a compute-only number standing as the whole estimate.
  if (!isTerminal(before.state) && isTerminal(next.state)) {
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
                  where id = ${next.id} and est_cost_minor is null`;
      }
    }
  }
}

/** Who asked (ruling 13; PII decision: a user id already in the system, never an IP). */
export interface Actor { userId: string | null; source: "client" | "admin" }

// ---------------------------------------------------------------------------
// apply — THE seam. Effects that need the transaction run inside it
// (consume_credit); effects that need a port run after commit. The HISTORY
// rows (ruling 13) land in the same transaction as the state: a failure
// writing them rolls the state change back (the atomicity test).
// ---------------------------------------------------------------------------
export async function apply(
  sessionId: string,
  command: Command | ((s: Session) => Command | null),
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
    const cmd = typeof command === "function" ? command(before) : command;
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
      try {
        const c = await consumeForSession(tx, { orgId: before.orgId, fixtureId: before.fixtureId, sessionId, monthly }, now);
        if (c.ledgerId) await tx`update fixture_stream_sessions set credit_ledger_id = ${c.ledgerId} where id = ${sessionId}`;
      } catch (e) {
        if (!(e instanceof NoCreditsError)) throw e;
        applied = { type: "credit_refused" };
        dec = decide(before, applied, now);   // same transaction, the refusal is the state
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
    logDecision(before, dec, now);
    return { session: dec.next, effects: dec.effects.filter((e) => e.type !== "consume_credit") };
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
async function observeIngestBeforeExpiry(sessionId: string, deps: SessionDeps): Promise<boolean> {
  const row = await readRow(sessionId);
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

/** I-1 (final review; controller ruling 2026-10-01): coalesce the organiser poll's Cloudflare reads ACROSS tabs, viewers
 *  and processes. Every open organiser fixture page polls `current` every STREAM_POLL_MS, and each poll read the input
 *  and its outputs: N tabs were N × 2 reads per 5 s against Cloudflare's account-wide API limit, and past that limit
 *  every read 429s — so no poll could observe warming → live, and the D3 box went silent.
 *
 *  The mechanism is a CONDITIONAL WRITE (V428): a poll claims the read by stamping `ingest_polled_at`, and only when the
 *  previous claim is at least STREAM_POLL_MS old. Postgres re-checks the WHERE of a concurrent UPDATE against the row
 *  the winner committed, so two polls racing on one session claim it ONCE: the loser gets no row back and reads nothing.
 *  Not an advisory lock: the lock would have to be held across the two Cloudflare calls, which carry no timeout, so a
 *  slow provider would pin a pooled connection per session. A claim also coalesces the reads that FAIL (a 429 or a 5xx
 *  records no sample), which is the storm this exists to stop. The clock is deps.now(), the poll's own clock. */
async function claimIngestPoll(sessionId: string, now: Date): Promise<boolean> {
  const claimed = await sql<{ id: string }[]>`
    update fixture_stream_sessions set ingest_polled_at = ${now}
     where id = ${sessionId}
       and (ingest_polled_at is null or ingest_polled_at <= ${new Date(now.getTime() - STREAM_POLL_MS)})
    returning id`;
  return claimed.length === 1;
}

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

/** The lazy expiry path (recommendation B). I1: a passthrough warming session's ingest is observed first. */
export async function applyExpiry(sessionId: string, deps: SessionDeps): Promise<Session | null> {
  const ingestUnknown = await observeIngestBeforeExpiry(sessionId, deps);
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
  const observed = await deps.drivers.runner.observe(r.machineId);
  return apply(sessionId, { type: "runner", trigger: { type: "observed", state: observed.state, exit: observed.exit } }, deps);
}

async function runEffects(session: Session, effects: Effect[], deps: SessionDeps): Promise<Session> {
  let current = session;
  for (const e of effects) {
    switch (e.type) {
      case "add_output": {
        const { inputId, target } = (await sql.begin(async (tx) => {
          const input = await readFirstInput(tx, current.id);
          return { inputId: input?.ingestInputId ?? null, target: await readTargetSecret(tx, current.orgId, (await readRow(current.id, tx))!.target_id) };
        })) as { inputId: string | null; target: { url: string; streamKey: string } };
        if (inputId) {
          const outputUid = await recordEffect(current, "add_output", "output", () => deps.drivers.ingest.addOutput(inputId, target, { sessionId: current.id }), { inputUid: inputId });   // C9: exactly one, passthrough only
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
    const jobToken = await mintRelayToken({ sid: s.id, scope: "relay-job", expiresAt: relayTokenExpiry(s) });
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

export async function storageHeadroomMinutes(exec: Tx | typeof sql, usage: StorageUsage, now: Date): Promise<number> {
  const rows = await exec<Row[]>`select ${cols()} from fixture_stream_sessions where state in ${sql([...ACTIVE_STATES])}`;
  const reservations = rows
    .map(toSession)
    .filter((s) => { const x = evaluate(s, now).kind; return x === "none" || x === "stale_beat" || x === "grace_expired"; })   // a Machine being replaced or flushed still records
    .map((s) => s.maxDurationMinutes);
  return headroomAfterReservations(usage, reservations);
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
 *  target (`fixture_id = $f OR target_id = $t`, inside the caller's org). A TERMINAL session's still-listed Machine is an
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
             where org_id = ${orgId} and (fixture_id = ${fixtureId} or target_id = ${targetId})
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

/** C1 (lane C final review; orchestrator ruling — mirror tearDownPriorMachines). A passthrough session that ended with
 *  its output release FAILED may still be simulcasting to its destination, and V421's one-active index covers active
 *  states only — so a new session on the same destination would add a SECOND output to the same key while the first
 *  phone still publishes. Admission therefore retries the release first, for every terminal passthrough session of THIS
 *  fixture or on THIS destination (inside the caller's org) whose output is recorded and not released, and refuses only
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
     where s.org_id = ${orgId} and (s.fixture_id = ${fixtureId} or s.target_id = ${targetId})
       and s.mode = 'passthrough' and s.state in ${sql([...TERMINAL_STATES])}
       and s.output_uid is not null and s.output_released_at is null
     order by s.created_at`;
  for (const p of prior) {
    if (await releaseOutput(p.id, "admission", deps)) continue;
    if (p.fixture_id !== fixtureId) {
      log.warn({ sid: p.id, fixtureId, holderFixtureId: p.fixture_id, targetId }, "stream session: another fixture's ended passthrough session may still be broadcasting on this destination and its output release failed — start refused");
      return { sameFixture: null, otherFixture: terminalHolder(p) };
    }
    log.warn({ sid: p.id, fixtureId }, "stream session: this fixture's previous passthrough session may still be broadcasting and its output release failed — start refused");
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
    case "plan_lacks_overlay": throw new PaymentRequiredError(RELAY_PLAN_GATES.overlay);
    case "overlay_required": throw new HttpError(409, "phone streaming needs the overlay tier", "overlay_required");
    case "plan_lacks_relay": throw new PaymentRequiredError(RELAY_PLAN_GATES.relay);
    case "no_credits": throw new HttpError(402, "This organisation has no match credits", "no_credits", { featureKey: RELAY_PLAN_GATES.relay });
    case "target_not_found": throw new HttpError(404, "stream target not found");
    case "storage_exhausted": throw new HttpError(503, "recording storage is exhausted; no new stream can start", "storage_exhausted", { headroomMinutes: headroom });
    case "active_session": throw new HttpError(409, "a session is already running for this fixture", "active_session", { sessionId: refusal.activeSessionId ?? null });
  }
}

/** B2: a saved key that will not open (a KEK change, a damaged byte) is the organiser's to fix — a typed 422 naming the
 *  remedy, logged with the fixture, target and kind only. Any other error (a missing RELAY_KEK is one: secret-columns
 *  rethrows it, M3) is returned unchanged for the caller to throw. */
function unreadableRefusal(err: unknown, fixtureId: string, targetId: string): unknown {
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
): Promise<void> {
  await sql.begin(async (tx) => {
    if (!(await lockStreamTarget(tx, orgId, targetId))) return;
    if (!admitsBarStorage(await activeSessionIdFor(fixtureId, tx))) return;
    await readTargetSecret(tx, orgId, targetId).catch((err: unknown) => { throw unreadableRefusal(err, fixtureId, targetId); });
  });
}

export async function createSession(
  auth: AuthCtx, fixtureId: string, body: CreateStreamSession, deps: SessionDeps,
): Promise<{ sessionId: string }> {
  const { orgId, competitionId } = await fixtureContext(fixtureId);
  if (orgId !== auth.orgId) throw new HttpError(404, "fixture not found");
  // The ACTOR is a guard, not a fallback. `created_by` is `uuid not null` with no FK, and `fillReplayUrl` later acts AS
  // that user when it writes the replay link. The plan wrote `auth.userId ?? orgId`, which for a caller with no user (an
  // API key: AuthCtx.userId is null) stores an ORG id in a users column and then impersonates it — a plausible lie in
  // both places. A start that spends a credit is attributed to a person or it does not happen; the session-only idiom
  // (device-links.ts, checkin-token.ts) answers 403. A device link carries its issuing organiser, so it passes.
  const actorUserId = auth.userId;
  if (actorUserId === null) throw new HttpError(403, "A stream can only be started by a signed-in organiser");
  // R5 (Task 14b): a production deployment with no RELAY_DRIVERS has no relay (drivers.ts `disabledRelayDrivers`).
  // Refused with the ingest's own 503 BEFORE anything else — no expiry, no provider call, no monthly grant, no row —
  // so nothing is faked and no credit moves. The Phone tab already reads this code.
  if (deps.drivers.disabled) {
    log.warn({ fixtureId, orgId }, "stream session: the relay is disabled on this deployment — start refused");
    throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
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
    // I2 (§5.2): a restart of THIS fixture inside the reuse window costs nothing, so `admit` waives the balance gate for
    // it. The same authority consumeForSession asks at go-live, on the same clock (deps.now()).
    reuseWindowOpen(sql, { orgId, fixtureId }, deps.now()),
    // Dc: HOW the org got `streaming.relay` — a live staff override, or the plan. `overrideRow` is the
    // existing single authority (it already filters expired overrides); no resolver edit. Since V426 every
    // plan grants the relay, so the FALSE branch (plan-granted) is the common one; stream-sessions.test.ts
    // drives it through createSession on an org with no override row.
    overrideRow(orgId, "streaming.relay"),
  ]);
  // M1 (B2 review): a saved key that will not open is refused BEFORE the storage read below — the first provider call a
  // create makes for itself — so an unreadable Go live asks Cloudflare nothing at all. A PROBE only: it answers solely for
  // this org's ACTIVE row (an archived or foreign id falls through to `admit`'s 404, never an oracle), only when `admit`
  // would otherwise pass (F-A5, see `refuseUnreadableTarget`), and the read inside the admission transaction stays the
  // authority for everything that row lock protects.
  await refuseUnreadableTarget(orgId, fixtureId, body.targetId, (activeSessionId) => admit({
    overlay, relay, balance, restartWithinReuseWindow, targetBelongsToOrg: true,
    headroomMinutes: MAX_DURATION_MINUTES, maxDurationMinutes: MAX_DURATION_MINUTES,   // storage not weighed yet: it cannot refuse here
    activeSessionId: activeSessionId ?? priorMachineSessionId,
  }).ok);
  const usage = await deps.drivers.ingest.storageUsage().then(storageUsageForColumns);   // outside the transaction; G7: fitted to the integer columns
  const viaOverride = relayOverride?.bool_value === true;

  const sessionId = await (sql.begin(async (tx) => {
    // Spec §5.2: the target ROW LOCK, taken inside the admission transaction and BEFORE admit reads it — Replace key and
    // Remove take the same lock, so a Remove cannot interleave with this Go live. An archived target is absent here
    // (`archived_at is null`), so `admit` answers the existing 404 target_not_found shape.
    const targetBelongsToOrg = await lockStreamTarget(tx, orgId, body.targetId);
    const headroom = await storageHeadroomMinutes(tx, usage, deps.now());
    const snapshot = { source: "admission" as const, usedMinutes: usage.totalStorageMinutes, limitMinutes: usage.totalStorageMinutesLimit,
      reservedMinutes: usage.totalStorageMinutesLimit - usage.totalStorageMinutes - headroom, headroomMinutes: headroom, takenAt: deps.now() };
    const verdict = admit({
      overlay, relay, balance, restartWithinReuseWindow, targetBelongsToOrg, headroomMinutes: headroom,
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
    const saved = await readTargetSecret(tx, orgId, body.targetId).catch((err: unknown) => { throw unreadableRefusal(err, fixtureId, body.targetId); });
    const destination = checkDestination(saved.url);
    if (!destination.ok) {
      log.warn({ fixtureId, targetId: body.targetId, rule: destination.rule }, "stream session: a saved destination the allowlist no longer admits — start refused");
      throw new DestinationNotAllowedError(destination.rule);
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
                                           venue_id, venue_address, org_timezone, entitlement_via_override)
      select ${fixtureId}, ${orgId}, ${body.mode}, 'requested', ${body.targetId}, ${body.themeId ?? null}, ${MAX_DURATION_MINUTES}, ${actorUserId},
             ${usage.totalStorageMinutes}, ${MAX_DURATION_MINUTES}, (select kind from org_stream_targets where id = ${body.targetId}),
             d.sport_key, d.competition_id, f.division_id, f.scheduled_at,
             c.venue_id, v.address, o.timezone, ${viaOverride}
        from fixtures f
        join divisions d on d.id = f.division_id
        join organizations o on o.id = ${orgId}
        left join courts c on c.id = f.court_id          -- a fixture with no court leaves venue_* null
        left join venues v on v.id = c.venue_id
       where f.id = ${fixtureId}
      returning id`;
    const sid = s!.id;
    await tx`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 0)`;   // M3: same transaction
    await recordStorageSnapshot(tx, { ...snapshot, sessionId: sid });
    await recordEvent(tx, { sessionId: sid, orgId, source: "client", kind: "action", type: "create", actorUserId, occurredAt: deps.now(),
      payload: { mode: body.mode, targetId: body.targetId, headroomMinutes: headroom, credits: balance } });
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
  });

  await provisionSession(sessionId, deps);
  return { sessionId };
}

async function provisionSession(sessionId: string, deps: SessionDeps): Promise<void> {
  const provisioning = (await apply(sessionId, { type: "provision" }, deps))!;
  let creds;
  try {
    creds = await recordEffect(provisioning, "create_live_input", "ingest", () => deps.drivers.ingest.createLiveInput({ sessionId, slot: 0 }), { slot: 0 });
  } catch (err) {
    log.error({ sid: sessionId, err }, "stream session: ingest create failed");
    await sql`delete from fixture_stream_sessions where id = ${sessionId}`;   // no §6.4 reason fits; no dead row (E5's logic) — the events cascade with it (the ONE delete the append-only trigger allows)
    throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
  }
  await sql.begin(async (tx) => {
    const [inp] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and slot = 0`;
    await storeInputCredentials(tx, inp!.id, creds.inputId, creds);
    await tx`update fixture_stream_sessions set provisioned_at = coalesce(provisioned_at, ${deps.now()}), ingest_input_uid = ${creds.inputId} where id = ${sessionId}`;   // ruling 13 facts: when, and which input (the uid is not a secret; the keys stayed *_enc)
  });
  if (provisioning.mode === "composed") {
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
  if (afterIngest?.state === "provisioning") await apply(sessionId, { type: "provisioned" }, deps);   // effects: add_output for passthrough (C9)
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

export async function currentSession(auth: AuthCtx, fixtureId: string, deps: SessionDeps, opts: { reveal?: boolean } = {}): Promise<StreamSessionCurrent | null> {
  const { orgId } = await fixtureContext(fixtureId);
  if (orgId !== auth.orgId) throw new HttpError(404, "fixture not found");
  let row = await latestRow(fixtureId);
  if (!row) return null;

  if (!isTerminal(row.state)) await reconcileSession(row.id, deps);      // B: the organiser's poll IS the tick — expiry + one Machine observation
  row = (await latestRow(fixtureId))!;

  // The server-side ingest poll (design §6.4): passthrough warming → live on
  // connected; a rejected destination fails it. The client never decides.
  let ingestState: StreamSessionCurrent["ingest"] = null;
  let outputObserved: OutputState | null = null;   // D3: what THIS poll read of the destination; null when it read nothing
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
        try {
          read = { status: await deps.drivers.ingest.inputStatus(inputId, { sessionId: row.id }), output: await deps.drivers.ingest.outputState(inputId, { sessionId: row.id }) };
        } catch (err) {
          reportIngestReadFailure(err, { sessionId: row.id, orgId: row.org_id, inputUid: inputId, site: "poll" });
        }
      }
    }
    if (coalesced) {
      // I-1: no provider call — the view is the latest poll sample's, when it is recent enough to be this interval's
      // reading. Nothing is recorded and nothing is decided: the poll that read decided on what it read. D3's `since`
      // below is computed exactly as for a read (events, clamps, this response's clock), from the sampled word.
      const sample = await latestPollSample(row.id);
      if (sample && deps.now().getTime() - new Date(sample.sampled_at).getTime() < COALESCED_SAMPLE_MAX_AGE_MS) {
        const phone = carriedIngest(sample);
        ingestState = phone === null ? null : { state: phone, protocol: sampledProtocol(sample.protocol) };
        outputObserved = sampledOutput(sample.output_state);
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
      ingestState = phone === null ? null : { state: phone, protocol: status.protocol };
      outputObserved = output;
      // Ruling 13: the poll is a SAMPLE every time and an OBSERVED event only when the state word changed — for a poll
      // that READ. m-2 (B5 re-review 2): an outputs read that failed (`null`, ports.ts) is not evidence, so that poll
      // records neither; as `unknown` it was a non-ok word that moved the D3 hold toward the key box. The phone's read
      // still answers the projection and still drives warming → live below. G-a: a carried word is recorded as the
      // reading it carries (the raw status keeps the no-evidence read itself); an unseen phone records nothing.
      if (output !== null && phone !== null) {
        // Dh: `ingest_reason` is Cloudflare's own `status.current.reason`, verbatim (Task 4 exposes it
        // on the status read). It is the one field that says WHY an input is disconnected, so a poll
        // sample without it records that something was wrong and drops the only explanation.
        await recordSample(sql, { sessionId: row.id, source: "poll", ingestState: phone, outputState: output,
          ingestReason: status.reason, sampledAt: deps.now(), raw: status });
        if (!prev || prev.ingest_state !== phone || prev.output_state !== output) {
          const sid = row.id, orgId = row.org_id;
          await sql.begin(async (tx) => {
            await lockRow(tx, sid);
            await recordEvent(tx, { sessionId: sid, orgId, source: "ingest", kind: "observed", type: "ingest_status", from: prev?.ingest_state ?? null, to: phone, occurredAt: deps.now(),
              payload: { protocol: status.protocol, outputState: output, connected: phone === "connected" } });
          });
        }
      }
      if (phone === "connected") {
        await sql`update fixture_stream_sessions set first_ingest_at = coalesce(first_ingest_at, ${deps.now()}), ingest_protocol = coalesce(ingest_protocol, ${status.protocol}) where id = ${row.id}`;
      }
      // m1 (lane C final review): both re-decided on the LOCKED row (T5-a) — a Stop or an expiry that landed after the
      // unlocked read above leaves a row these no longer apply to, and a plain apply of either was InvalidTransition, a 500.
      if (output === "rejected") await apply(row.id, (s) => (s.state === "warming" || s.state === "live" ? { type: "target_rejected" } : null), deps);
      else if (row.state === "warming" && phone === "connected") await apply(row.id, connectIfWarming, deps);
      row = (await latestRow(fixtureId))!;
    }
  }

  const qr = (await sql.begin(async (tx): Promise<CaptureQrV1 | null> => {
    if (row!.state !== "provisioning" && row!.state !== "warming") return null;
    const input = await readFirstInput(tx, row!.id);
    if (!input || !input.srt || !input.rtmps) return null;   // the empty case: null, not a default
    // De, in two halves — and the split is the whole point.
    // `qr_issued_first_at` is when the payload was first SERVED. Every projection that
    // carries a QR is a serve, so it is coalesced unconditionally here.
    // The REVEAL counters are a different fact: a reveal is the organiser's own act of
    // disclosing the credentials — the tab showing them for the first time this session,
    // or a tap on Copy — and the caller says so with `reveal`. A POLL IS NOT A REVEAL.
    // The Phone tab polls `current` every STREAM_POLL_MS (5 s) and WARMING_TIMEOUT_MINUTES
    // is 10, so counting every projection banks ~120 "reveals" for one disclosure: a
    // number that scales with how long warming took, is not comparable between sessions,
    // and reports credentials revealed ~100× more often than they were, under a column
    // name that says otherwise. Every downstream read (the `_INDEX.md` inventory, any
    // future admin view) inherits that lie.
    // The lock this transaction already holds is what makes the increment safe: two
    // concurrent reveals cannot lose a count. first-at is coalesced and never moves.
    await lockRow(tx, row!.id);
    await tx`update fixture_stream_sessions set qr_issued_first_at = coalesce(qr_issued_first_at, ${deps.now()}) where id = ${row!.id}`;
    if (opts.reveal) {
      await tx`update fixture_stream_sessions
                  set credentials_revealed_first_at = coalesce(credentials_revealed_first_at, ${deps.now()}),
                      credentials_reveal_count = credentials_reveal_count + 1
                where id = ${row!.id}`;
    }
    return {
      v: 1, sid: row!.id, slot: input.slot,
      cred: { srt: { ...input.srt, latencyMs: SRT_LATENCY_MS }, rtmps: { ...input.rtmps } },
      preferred: QR_PREFERRED_DEFAULT,
      exp: Math.floor(relayTokenExpiry({ createdAt: new Date(row!.created_at), startedAt: d(row!.started_at), maxDurationMinutes: row!.max_duration_minutes }).getTime() / 1000),
    };
  })) as CaptureQrV1 | null;

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
    const [first] = await sql<{ since: Date | null }[]>`
      select greatest(
        (select occurred_at from fixture_stream_events
          where session_id = ${row.id} and type = 'ingest_status'
            and seq > coalesce((select max(seq) from fixture_stream_events
                                 where session_id = ${row.id} and type = 'ingest_status'
                                   and (coalesce(payload->>'outputState', '') = 'ok') <> ${outputObserved === "ok"}), 0)
          order by seq asc limit 1),
        (select live_at from fixture_stream_sessions where id = ${row.id}),
        (select max(occurred_at) from fixture_stream_events
          where ${outputObserved !== "ok"} and session_id = ${row.id} and type = 'ingest_status'
            and to_state = 'connected' and coalesce(from_state, '') <> 'connected')
      ) as since`;
    const since = new Date(first?.since ?? deps.now());
    // M6: the elapsed on THIS clock, at this response — the client judges D3 on it, never on the browser's clock.
    output = { state: outputObserved, since: since.toISOString(), elapsedMs: Math.max(0, deps.now().getTime() - since.getTime()) };
  }
  return {
    id: row.id, fixtureId, mode: row.mode, state: row.state, desiredState: row.desired_state, failReason: row.fail_reason,
    health: row.heartbeat_at ? { fps: hb?.fps ?? null, bitrateKbps: hb?.bitrateKbps ?? null, lastBeatAt: new Date(row.heartbeat_at).toISOString() } : null,
    ingest: ingestState, output, qr,
    balance: await creditBalance(sql, row.org_id),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    replayUrl: fx?.stream_url ?? null,
    target: { id: target!.id, kind: target!.kind, label: target!.label },
    fixtureDecided: fx?.status === "decided" || fx?.status === "finalized",
    endReason: row.end_reason,
    creditUsed: spend!.net < 0,
    // I-1: admission's own question, on admission's own clock (createSession asks `reuseWindowOpen` with deps.now()), so
    // the tab's "free restart" and the gate that waives the balance cannot disagree.
    restartFree: await reuseWindowOpen(sql, { orgId: row.org_id, fixtureId }, deps.now()),
  };
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
    await apply(sessionId, (s) => (isTerminal(s.state) ? null : { type: "relay_disabled" }), deps, { userId: auth.userId ?? null, source: "client" });
    return (await currentSession(auth, fixtureId, deps))!;
  }
  // m1: re-decided on the LOCKED row (T5-a). A session another writer FINISHED after the read above (an expiry, a failure)
  // writes nothing — no decision, no tap, the same as the finished-session branch above — and the projection answers.
  // `ending` is still decided: `ending × stop` is identity, and it records the tap (n5).
  await apply(sessionId, (s) => (isTerminal(s.state) ? null : { type: "stop" }), deps, { userId: auth.userId ?? null, source: "client" });   // passthrough: the complete_now effect finishes it; composed: runner session_stop → SIGINT → observed destroyed → completed. The actor lands as an `action` row (ruling 13); stop_requested_at is set by persistFacts.
  return (await currentSession(auth, fixtureId, deps))!;
}

async function jobSession(sessionId: string, token: string, deps: SessionDeps): Promise<Session> {
  await verifyRelayToken(token, { sid: sessionId, scope: "relay-job" });
  const s = await reconcileSession(sessionId, deps);                        // B: the Machine's own reads tick the policy too
  if (!s) throw new HttpError(404, "session not found");
  if (isTerminal(s.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  return s;
}

export async function heartbeat(sessionId: string, token: string, body: RelayHeartbeat, deps: SessionDeps): Promise<{ desiredState: "live" | "ending" }> {
  await verifyRelayToken(token, { sid: sessionId, scope: "relay-job" });
  const before = await readRow(sessionId);
  if (!before) throw new HttpError(404, "session not found");
  if (isTerminal(before.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  // The beat is recorded FIRST (a late beat that arrived is not a stale one), then the policy runs.
  // G5 (Task 11 review): `egressBytes` is optional, and an omitted field leaves the stored count alone — only a Machine
  // that REPORTS 0 stores 0 (the A29 rule: absent is not a measured zero).
  await sql`update fixture_stream_sessions set last_heartbeat = ${sql.json(body as never)}, heartbeat_at = ${deps.now()},
              egress_bytes = coalesce(${body.egressBytes ?? null}::bigint, egress_bytes) where id = ${sessionId}`;
  await sampleBeat(sessionId, before.org_id, body, deps);
  let s = (await applyExpiry(sessionId, deps))!;
  // The runner's own callbacks are lifecycle triggers (plan §"Fly machine lifecycle"): playing/stopped, nothing else moves the table from a beat.
  // m1 (lane C final review): each callback is re-decided on the LOCKED row (T5-a) — another writer may have moved the row
  // since `s` was read, and a plain apply the table no longer accepts was InvalidTransition, a 500 on the Machine's beat.
  // callback_playing is refused on a TERMINAL session (it is not a runner cleanup trigger); callback_stopped is one, so a
  // terminal row still takes it.
  if (s.mode === "composed" && (s.runner.state === "booting" || s.runner.state === "playing") && body.state === "playing") {
    s = (await apply(sessionId, (cur) => (cur.mode === "composed" && !isTerminal(cur.state) && (cur.runner.state === "booting" || cur.runner.state === "playing")
      ? { type: "runner", trigger: { type: "callback_playing" } } : null), deps)) ?? s;
  }
  if (s.mode === "composed" && body.state === "stopped" && (s.runner.state === "stopping" || s.runner.state === "playing" || s.runner.state === "booting")) {
    s = (await apply(sessionId, (cur) => (cur.mode === "composed" && (cur.runner.state === "stopping" || cur.runner.state === "playing" || cur.runner.state === "booting")
      ? { type: "runner", trigger: { type: "callback_stopped" } } : null), deps)) ?? s;
  }
  return { desiredState: s.desiredState };
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

export async function sessionFactsForJob(sessionId: string, token: string, deps: SessionDeps) {
  const s = await jobSession(sessionId, token, deps);
  const row = (await readRow(sessionId))!;
  const target = (await sql.begin((tx) => readTargetSecret(tx, s.orgId, row.target_id))) as { url: string; streamKey: string };
  const pageToken = await mintRelayToken({ sid: sessionId, scope: "relay-page", expiresAt: relayTokenExpiry(s) });
  return { sessionId, fixtureId: s.fixtureId, mode: s.mode, themeId: row.theme_id, overlayDelayMs: row.overlay_delay_ms, maxDurationMinutes: s.maxDurationMinutes, target, pageToken };
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
 *  Outside any transaction (expiry may call the provider). Called by the stream-targets [targetId] route. */
export async function expireTargetHolders(orgId: string, targetId: string, deps: SessionDeps): Promise<void> {
  for (const h of await holderRows(sql, { orgId, targetId })) await applyExpiry(h.sessionId, deps);
}
