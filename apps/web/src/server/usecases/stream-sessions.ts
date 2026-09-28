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
import { hasFeature, overrideRow } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamSession, RelayHeartbeat, StreamSessionCurrent } from "@/server/api-v1/schemas";
import type { CaptureQrV1 } from "@/lib/capture-qr";
import { checkDestination } from "@/lib/stream-destinations";
import {
  CLOUDFLARE_STORED_MICROS_PER_MINUTE, EST_COST_CURRENCY, FLY_BILLING_SECONDS_PER_MONTH,
  FLY_PERFORMANCE_CPU_MICROS_PER_MONTH, FLY_RAM_MICROS_PER_GB_MONTH,
  MAX_DURATION_MINUTES, QR_PREFERRED_DEFAULT, RUNNER_DEFAULT_GUEST, RUNNER_DEFAULT_REGION, SAMPLES_PER_SESSION_CAP, SRT_LATENCY_MS,
} from "@/server/relay/config";
import {
  ACTIVE_STATES, TERMINAL_STATES, InvalidTransition, admit, decide, eventRowsOf, isTerminal,
  type Command, type Decision, type Effect, type Session,
} from "@/server/relay/domain/session";
import { InvalidRunnerTransition, machineNameFor, type ExitInfo, type RunnerEffect } from "@/server/relay/domain/runner";
import { evaluate, runnerDeadlineOf } from "@/server/relay/domain/expiry";
import { headroomAfterReservations } from "@/server/relay/domain/credits";
import { relayDrivers, type RelayDrivers } from "@/server/relay/drivers";
import type { StorageUsage } from "@/server/relay/ports";
import { createFailedFrom } from "@/server/relay/runner-fly";
import { readFirstInput, readTargetSecret, storeInputCredentials } from "@/server/relay/secret-columns";
import { recordEvent, recordSample, recordStorageSnapshot } from "@/server/relay/telemetry";
import { mintRelayToken, relayTokenExpiry, verifyRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { NoCreditsError, consumeForSession, creditBalance, lockOrg, reuseWindowOpen } from "./stream-credits";
import { DestinationNotAllowedError } from "./stream-targets";
import { setFixtureStreamUrl } from "./fixtures";

export { ACTIVE_STATES, TERMINAL_STATES };

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
}
const COLS = sql`id, fixture_id, org_id, mode, state, desired_state, fail_reason, end_reason, theme_id, overlay_delay_ms,
  target_id, machine_id, last_heartbeat, heartbeat_at, beat_window_at, started_at, ended_at, ending_at, max_duration_minutes,
  runner_retries, runner_attempts, runner_state, runner_name, runner_stop_requested_at,
  runner_exit_code, runner_oom_killed, runner_requested_stop, created_by, created_at`;

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
    // heartbeatAt and this. Dropping it here (or from COLS) is silent to tsc — a missing column reads undefined → null — and it
    // collapses the once-per-window bound to every 5 s poll; "G1: beat_window_at round-trips" is the witness.
    beatWindowAt: d(r.beat_window_at),
    // F22: when ENDING began. `evaluate` measures the ending backstop from HERE. Forgetting to map it
    // is silent — `endingAt` reads null forever and the policy quietly falls back to the wall clock,
    // which is the exact stranding F22 exists to end. The round-trip test is the only witness.
    endingAt: d(r.ending_at),
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
  const [row] = await tx<Row[]>`select ${COLS} from fixture_stream_sessions where id = ${id} for update`;
  return row ?? null;
}
async function readRow(id: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`select ${COLS} from fixture_stream_sessions where id = ${id}`;
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
    const ram = ((f.guestMemoryMb / 1024) * FLY_RAM_MICROS_PER_GB_MONTH * f.machineSeconds) / FLY_BILLING_SECONDS_PER_MONTH;
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
  const outcome = (await sql.begin(async (tx) => {
    // A7 — LOCK ORDER. stream-credits.ts's rule is that every writer takes the org's money lock FIRST (`lockOrg`, before
    // any read), and its staff paths then take this session row (`staffRow`: lockOrg, then FOR KEY SHARE on the linked
    // session). `consumeForSession` below takes lockOrg itself, so locking the row first and consuming second is the
    // OPPOSITE order: an apply that goes live while a staff refund names this session deadlocks against it (Postgres
    // aborts one). So the org lock comes first here too, on every apply — which decisions consume is only known after
    // `decide`, and that needs the locked row. `org_id` is read without a lock because nothing ever changes it; it is
    // only the lock's key. consumeForSession's own lockOrg is then re-entrant. `recordEffect` and the projection's
    // writes take the row alone and never the org lock, so no cycle can form through them.
    // Witness: "A7 lock order: … the row stays free for a FOR UPDATE NOWAIT".
    const [owner] = await tx<{ org_id: string }[]>`select org_id from fixture_stream_sessions where id = ${sessionId}`;
    if (!owner) return null;
    await lockOrg(tx, owner.org_id);
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
      try {
        const c = await consumeForSession(tx, { orgId: before.orgId, fixtureId: before.fixtureId, sessionId }, now);
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
 *  the DELETE — nothing recorded the outcome, and that database fault is thrown on untouched (the route wrapper reports
 *  it). Told apart by identity: only the exact error the provider call threw is caught here.
 *
 *  THIRD site, `sweep` (Task 12, A22(b)): the daily sweep's orphan pass destroys a listed Machine its session no longer
 *  owns through THIS helper — the retry owner of every forced destroy that failed at the other two sites — so its row is
 *  the same `force_destroy` effect (source `sweep`) and its failure the same alarm. The alarm names the LISTED Machine
 *  (`payload.machineName`) when the caller knows it: the row's own `runner.name` is a different attempt's there.
 *
 *  A FAILED destroy also CLEARS the session's `runner_gone_confirmed_at` (V422, A22(c)): that mark lets admission skip
 *  the provider for this session, and a Machine that survived a DELETE is exactly what admission must find again. */
async function forceDestroy(
  s: Session, machineId: string, site: "force_destroy" | "stale_create" | "sweep", payload: Record<string, unknown>, deps: SessionDeps,
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
    if (!("failure" in provider) || err !== provider.failure) throw err;   // the ledger failed, not the provider
    await sql`update fixture_stream_sessions set runner_gone_confirmed_at = null where id = ${s.id} and runner_gone_confirmed_at is not null`;
    const machineName = typeof payload.machineName === "string" ? payload.machineName : s.runner.name;
    const extra = { sessionId: s.id, machineId, machineName, attempt: s.runner.attempt, site };
    captureError(err, { orgId: s.orgId, route: "relay.force_destroy", extra });
    log.error({ ...extra, err: String(err) }, "stream session: forced Machine destroy failed — recorded and reported; the table retries it");
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

/** The lazy expiry path (recommendation B). */
export async function applyExpiry(sessionId: string, deps: SessionDeps): Promise<Session | null> {
  // `none` is the T5-a null command — write nothing, run nothing (post-2C-post plan sync). The committed domain REFUSES
  // `expire none` on a TERMINAL session (C27's negative pair: only `grace_expired` passes its guard), and `reconcileSession`
  // runs this on terminal rows by design — the sweep's backstop selects every terminal row whose runner is still alive, and
  // "the late create" reconciles a completed and a failed row. Handing `none` to those threw InvalidTransition out of the
  // reconcile and the whole daily sweep. On a non-terminal row `none` is `identity`, so dropping it moves nothing.
  return apply(sessionId, (s) => {
    const expiry = evaluate(s, deps.now());
    return expiry.kind === "none" ? null : { type: "expire", expiry };
  }, deps);
}

/** Expiry, then ONE observation of the Machine fed to the lifecycle table
 *  (plan §"Fly machine lifecycle" — the `observed` trigger). Every read,
 *  heartbeat, poll and admission calls this; the daily backstop too. */
export async function reconcileSession(sessionId: string, deps: SessionDeps): Promise<Session | null> {
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
          return { inputId: input?.ingestInputId ?? null, target: await readTargetSecret(tx, current.orgId, (await readRow(current.id))!.target_id) };
        })) as { inputId: string | null; target: { url: string; streamKey: string } };
        if (inputId) {
          const outputUid = await recordEffect(current, "add_output", "output", () => deps.drivers.ingest.addOutput(inputId, target), { inputUid: inputId });   // C9: exactly one, passthrough only
          // Dg: the slot-0 destination output's uid, beside ingest_input_uid (not a secret). The port
          // RETURNS it (Tasks 3/4); throwing that return away is what would leave the column inert.
          // coalesce so a re-run of an idempotent effect cannot move a recorded uid.
          await sql`update fixture_stream_sessions set output_uid = coalesce(output_uid, ${outputUid}) where id = ${current.id}`;
        }
        break;
      }
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
        // A3 (lane-b carry 2, owner-confirmed 2026-09-28): the PROOF is read off the error by the adapter's own classifier.
        // A plain `retryable` flag cannot say whether Fly holds a Machine under our name; `createFailedFrom` can — a
        // refusal status or a retryable error proves nothing was made, anything else (a timeout, a 5xx, an error shape it
        // does not know) is `outcomeUnknown`, which the table answers with a by-name teardown before any retry.
        const trigger = createFailedFrom(err);
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
  const jobToken = await mintRelayToken({ sid: s.id, scope: "relay-job", expiresAt: relayTokenExpiry(s) });
  // A2 (lane-b carry 1): the Machine's hard stop is `runnerDeadlineOf` — the session's wall clock PLUS
  // MAX_ANCHOR_DRIFT_SECONDS (whole-branch review I1). `deadlineOf` would let the Machine's own clock, which can run
  // ahead of ours, cut the broadcast before the session's wall-clock expiry ends it cleanly. Witness: "A2: …".
  return deps.drivers.runner.create({ sessionId: s.id, attempt: s.runner.attempt, jobToken, appUrl: deps.appUrl, guest: RUNNER_DEFAULT_GUEST, region: RUNNER_DEFAULT_REGION, deadlineAt: runnerDeadlineOf(s) });
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
  const rows = await exec<Row[]>`select ${COLS} from fixture_stream_sessions where state in ${sql([...ACTIVE_STATES])}`;
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

async function activeSessionIdFor(fixtureId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
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
async function targetHolderFor(
  targetId: string, orgId: string, fixtureId: string, deps: SessionDeps,
): Promise<{ sessionId: string; courtName: string | null; holderFixtureId: string | null; label: string } | null> {
  const holders = () => sql<{ id: string; court_name: string | null; fixture_id: string | null; label: string }[]>`
    select s.id, c.name as court_name, s.fixture_id, t.label
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      left join fixtures f on f.id = s.fixture_id
      left join courts c on c.id = f.court_id
     where s.target_id = ${targetId} and t.org_id = ${orgId}
       and s.fixture_id is distinct from ${fixtureId}
       and s.state in ${sql([...ACTIVE_STATES])}`;
  const first = await holders();
  if (first.length === 0) return null;
  for (const h of first) await applyExpiry(h.id, deps);      // B: this start attempt IS the tick for the holder too
  const [still] = await holders();
  return still ? { sessionId: still.id, courtName: still.court_name, holderFixtureId: still.fixture_id, label: still.label } : null;
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
  const prior = await sql<(Row & { holder_label: string; holder_court: string | null })[]>`
    select p.*, t.label as holder_label, c.name as holder_court
      from (select ${COLS} from fixture_stream_sessions
             where org_id = ${orgId} and (fixture_id = ${fixtureId} or target_id = ${targetId})
               and mode = 'composed' and runner_state <> 'none' and state in ${sql([...TERMINAL_STATES])}
               and not (runner_state = 'destroyed' and runner_gone_confirmed_at is not null)) p
      join org_stream_targets t on t.id = p.target_id
      left join fixtures f on f.id = p.fixture_id
      left join courts c on c.id = f.court_id`;
  if (prior.length === 0) return { sameFixture: null, otherFixture: null };
  const bySession = new Map(prior.map((r) => {
    const holder: Holder = { sessionId: r.id, label: r.holder_label, courtName: r.holder_court, holderFixtureId: r.fixture_id };
    return [r.id, { s: toSession(r), holder }] as const;
  }));
  const listed = (await deps.drivers.runner.list()).flatMap((m) => {
    const hit = m.sessionId ? bySession.get(m.sessionId) : undefined;
    return hit ? [{ m, ...hit }] : [];
  });
  for (const { m, s, holder } of listed) {
    try {
      await recordEffect(s, "force_destroy", "runner", () => deps.drivers.runner.destroy(m.runnerId), { machineId: m.runnerId, machineName: m.name, reason: "admission", fixtureId });
    } catch (err) {
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

/** The `target_in_use` refusal, ONE shape for both holders — an active session (`targetHolderFor`) and another fixture's
 *  ended session whose still-listed Machine admission could not destroy (I1). `code` is what the client acts on (Task
 *  13's `CreateErrorCode`, Task 14's dictionary key). The MESSAGE names the holder — the court when the fixture has one, else the fixture id — because
 *  "in use" alone sends an organiser hunting; it is the operator's line in the log and in Sentry. The client renders the
 *  DICTIONARY string keyed by `code` and never `err.message` (the carry Task 4 left for the Cloudflare refusal).
 *  Task 11 (controller ruling): the holder also rides as the machine-readable `extra` `{ holder: { fixtureId, courtName,
 *  label } }`, so that dictionary string can name the court. SAME-ORG BY CONSTRUCTION: both producers read only the
 *  caller's org (`targetHolderFor`: `t.org_id = $org`; `tearDownPriorMachines`: `org_id = $org`), and a session can only
 *  reference a target `admit` proved is the org's — so the extra never names another organisation's fixture. The
 *  holder's SESSION id is deliberately not in it: nothing a client does with it. */
interface Holder { sessionId: string; label: string; courtName: string | null; holderFixtureId: string | null }

function targetInUse(h: Holder): HttpError {
  return new HttpError(
    409,
    `the destination "${h.label}" is already streaming for ${h.courtName ? `court ${h.courtName}` : `fixture ${h.holderFixtureId ?? "(deleted)"}`}`,
    "target_in_use",
    { holder: { fixtureId: h.holderFixtureId, courtName: h.courtName, label: h.label } },
  );
}

function refuse(refusal: Exclude<ReturnType<typeof admit>, { ok: true }>, headroom: number): never {
  switch (refusal.refusal) {
    case "plan_lacks_overlay": throw new PaymentRequiredError("streaming.overlay");
    case "overlay_required": throw new HttpError(409, "phone streaming needs the overlay tier", "overlay_required");
    case "plan_lacks_relay": throw new PaymentRequiredError("streaming.relay");
    case "no_credits": throw new HttpError(402, "This organisation has no match credits", "no_credits", { featureKey: "streaming.relay" });
    case "target_not_found": throw new HttpError(404, "stream target not found");
    case "storage_exhausted": throw new HttpError(503, "recording storage is exhausted; no new stream can start", "storage_exhausted", { headroomMinutes: headroom });
    case "active_session": throw new HttpError(409, "a session is already running for this fixture", "active_session", { sessionId: refusal.activeSessionId ?? null });
  }
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
  // B: the fixture's own stuck session is expired here, not on a tick.
  const existing = await activeSessionIdFor(fixtureId);
  if (existing) await applyExpiry(existing, deps);
  // The DESTINATION guard (gap 4), placed BEFORE the storage read and before `tearDownPriorMachines` — i.e. before any
  // provider call this create would make FOR THE NEW SESSION, so a refused start leaves no Cloudflare live input, no Fly
  // Machine and nothing to clean up. That early placement is the whole point of refusing in code at all (the index alone
  // would refuse only at the insert, after `ingest.storageUsage()` had already been called), and it is what G-T1's
  // zero-provider-call assertions witness. It sits AFTER this fixture's own lazy expiry on purpose: that expiry can
  // RELEASE this very target. The one provider call that can precede it belongs to that OLD session's teardown.
  const holder = await targetHolderFor(body.targetId, orgId, fixtureId, deps);
  if (holder) {
    log.warn({ fixtureId, targetId: body.targetId, holder: holder.sessionId, court: holder.courtName }, "stream session: the destination is already held by another fixture — start refused");
    throw targetInUse(holder);
  }
  // 2C-post m5: a PREVIOUS session's Machine the provider still lists is destroyed before this one may start; while that
  // destroy fails, admission answers `active_session` naming its session (outside the transaction: it calls the provider).
  // I1: ANOTHER fixture's ended session with a Machine still listed on this destination is destroyed the same way; only
  // when that destroy fails is the start `target_in_use`, naming its court, like an active holder.
  const prior = await tearDownPriorMachines(fixtureId, body.targetId, orgId, deps);
  if (prior.otherFixture) throw targetInUse(prior.otherFixture);
  const priorMachineSessionId = prior.sameFixture;

  const [overlay, relay, balance, restartWithinReuseWindow, target, usage, relayOverride] = await Promise.all([
    hasFeature(orgId, "streaming.overlay", competitionId),
    hasFeature(orgId, "streaming.relay", competitionId),
    creditBalance(sql, orgId),
    // I2 (§5.2): a restart of THIS fixture inside the reuse window costs nothing, so `admit` waives the balance gate for
    // it. The same authority consumeForSession asks at go-live, on the same clock (deps.now()).
    reuseWindowOpen(sql, { orgId, fixtureId }, deps.now()),
    sql<{ id: string }[]>`select id from org_stream_targets where id = ${body.targetId} and org_id = ${orgId}`,
    deps.drivers.ingest.storageUsage().then(storageUsageForColumns),   // outside the transaction; G7: fitted to the integer columns
    // Dc: HOW the org got `streaming.relay` — a live staff override, or the plan. `overrideRow` is the
    // existing single authority (it already filters expired overrides); no resolver edit. Under V402
    // every R1 admission is an override, so the FALSE branch is exercised as a unit-level assertion on
    // this mapping rather than through a plan-granted org that does not exist yet.
    overrideRow(orgId, "streaming.relay"),
  ]);
  const viaOverride = relayOverride?.bool_value === true;

  const sessionId = await (sql.begin(async (tx) => {
    const headroom = await storageHeadroomMinutes(tx, usage, deps.now());
    const snapshot = { source: "admission" as const, usedMinutes: usage.totalStorageMinutes, limitMinutes: usage.totalStorageMinutesLimit,
      reservedMinutes: usage.totalStorageMinutesLimit - usage.totalStorageMinutes - headroom, headroomMinutes: headroom, takenAt: deps.now() };
    const verdict = admit({
      overlay, relay, balance, restartWithinReuseWindow, targetBelongsToOrg: target.length === 1, headroomMinutes: headroom,
      maxDurationMinutes: MAX_DURATION_MINUTES, activeSessionId: (await activeSessionIdFor(fixtureId)) ?? priorMachineSessionId,
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
    const destination = checkDestination((await readTargetSecret(tx, orgId, body.targetId)).url);
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
  const [row] = await sql<Row[]>`select ${COLS} from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at desc limit 1`;
  return row ?? null;
}

/** C1: the org's balance, with NO session row required. `currentSession` returns
 *  `null` until a session exists and `balance` rides inside that projection, so the
 *  idle Phone tab had no source for it at all and read 0 for every credited org.
 *  One authority — `creditBalance` (Task 7). Tenancy is checked the same way the
 *  projection checks it: a mismatch is 404, never 403 (404 ≡ missing). */
export async function relayBalance(auth: AuthCtx, orgId: string): Promise<number> {
  if (orgId !== auth.orgId) throw new HttpError(404, "organisation not found");
  return creditBalance(sql, orgId);
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
  if (row.mode === "passthrough" && (row.state === "warming" || row.state === "live")) {
    const input = (await sql.begin((tx) => readFirstInput(tx, row!.id))) as Awaited<ReturnType<typeof readFirstInput>>;
    const inputId = input?.ingestInputId ?? null;
    if (inputId) {
      const status = await deps.drivers.ingest.inputStatus(inputId);
      const output = await deps.drivers.ingest.outputState(inputId);
      ingestState = { state: status.state, protocol: status.protocol };
      // Ruling 13: the poll is a SAMPLE every time and an OBSERVED event only when the state word changed.
      const [prev] = await sql<{ ingest_state: string | null; output_state: string | null }[]>`
        select ingest_state, output_state from fixture_stream_samples where session_id = ${row.id} and source = 'poll' order by id desc limit 1`;
      // Dh: `ingest_reason` is Cloudflare's own `status.current.reason`, verbatim (Task 4 exposes it
      // on the status read). It is the one field that says WHY an input is disconnected, so a poll
      // sample without it records that something was wrong and drops the only explanation.
      await recordSample(sql, { sessionId: row.id, source: "poll", ingestState: status.state, outputState: output,
        ingestReason: status.reason, sampledAt: deps.now(), raw: status });
      if (!prev || prev.ingest_state !== status.state || prev.output_state !== output) {
        const sid = row.id, orgId = row.org_id;
        await sql.begin(async (tx) => {
          await lockRow(tx, sid);
          await recordEvent(tx, { sessionId: sid, orgId, source: "ingest", kind: "observed", type: "ingest_status", from: prev?.ingest_state ?? null, to: status.state, occurredAt: deps.now(),
            payload: { protocol: status.protocol, outputState: output, connected: status.state === "connected" } });
        });
      }
      if (status.state === "connected") {
        await sql`update fixture_stream_sessions set first_ingest_at = coalesce(first_ingest_at, ${deps.now()}), ingest_protocol = coalesce(ingest_protocol, ${status.protocol}) where id = ${row.id}`;
      }
      if (output === "rejected") await apply(row.id, { type: "target_rejected" }, deps);
      else if (row.state === "warming" && status.state === "connected") await apply(row.id, { type: "ingest_connected" }, deps);
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
  return {
    id: row.id, fixtureId, mode: row.mode, state: row.state, desiredState: row.desired_state, failReason: row.fail_reason,
    health: row.heartbeat_at ? { fps: hb?.fps ?? null, bitrateKbps: hb?.bitrateKbps ?? null, lastBeatAt: new Date(row.heartbeat_at).toISOString() } : null,
    ingest: ingestState, qr,
    balance: await creditBalance(sql, row.org_id),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    replayUrl: fx?.stream_url ?? null,
    target: { id: target!.id, kind: target!.kind, label: target!.label },
    fixtureDecided: fx?.status === "decided" || fx?.status === "finalized",
    endReason: row.end_reason,
  };
}

export async function stopSession(auth: AuthCtx, fixtureId: string, sessionId: string, deps: SessionDeps): Promise<StreamSessionCurrent> {
  const row = await readRow(sessionId);
  if (!row || row.fixture_id !== fixtureId || row.org_id !== auth.orgId) throw new HttpError(404, "session not found");
  // m7 (fix round 1): a REPEATED stop — a double tap, or a retry after a lost response — is idempotent. A session already
  // stopping (`ending`) or stopped is answered with the same projection the first stop returned, and nothing is written:
  // no action row, no decision, no provider call. A stop naming a session the fixture has since SUPERSEDED stays 409
  // not_active: the fixture's projection would describe a DIFFERENT session.
  if (row.state === "ending" || isTerminal(row.state)) {
    if ((await latestRow(fixtureId))?.id !== sessionId) throw new HttpError(409, "session is not running", "not_active");
    return (await currentSession(auth, fixtureId, deps))!;
  }
  await apply(sessionId, { type: "stop" }, deps, { userId: auth.userId ?? null, source: "client" });   // passthrough: the complete_now effect finishes it; composed: runner session_stop → SIGINT → observed destroyed → completed. The actor lands as an `action` row (ruling 13); stop_requested_at is set by persistFacts.
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
  if (s.mode === "composed" && (s.runner.state === "booting" || s.runner.state === "playing") && body.state === "playing") {
    s = (await apply(sessionId, { type: "runner", trigger: { type: "callback_playing" } }, deps))!;
  }
  if (s.mode === "composed" && body.state === "stopped" && (s.runner.state === "stopping" || s.runner.state === "playing" || s.runner.state === "booting")) {
    s = (await apply(sessionId, { type: "runner", trigger: { type: "callback_stopped" } }, deps))!;
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
