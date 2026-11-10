import "server-only";
// The fixture_stream_sessions row: shape, columns, Row <-> Session, loaders by id, the state sets (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { ACTIVE_STATES, TERMINAL_STATES, type Session } from "@/server/relay/domain/session";
import type { ExitInfo } from "@/server/relay/domain/runner";

export { ACTIVE_STATES, TERMINAL_STATES };

// ---------------------------------------------------------------------------
// Persistence — the only SQL over fixture_stream_sessions' mutable columns.
// ---------------------------------------------------------------------------
export interface Row {
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
export const cols = () => sql`id, fixture_id, org_id, mode, state, desired_state, fail_reason, end_reason, theme_id, overlay_delay_ms,
  target_id, machine_id, last_heartbeat, heartbeat_at, beat_window_at, started_at, ended_at, ending_at, max_duration_minutes,
  runner_retries, runner_attempts, runner_state, runner_name, runner_stop_requested_at,
  runner_exit_code, runner_oom_killed, runner_requested_stop, created_by, created_at, output_uid, start_cause, warming_at,
  ingest_read_failed, runner_crash_count, runner_crash_beats, runner_crash_exits, runner_crash_exit_at, runner_crash_restart_seen,
  runner_restart_count, runner_restart_beats, runner_restart_exits, runner_restart_exit_at`;

export const d = (s: string | null): Date | null => (s ? new Date(s) : null);

/** A5 (lane-b carry 4): the runner's last exit lives in V410's three runner_exit_* columns — never in last_heartbeat's
 *  JSON, which every beat REPLACES (a beat landing between an observed OOM and its confirmed teardown turned machine_oom
 *  into machine_crash). All three null = no exit observed, read as `null`, which `failReasonFromExit` treats exactly as
 *  it treats an observed exit whose three facts are all null — so the mapping loses nothing. */
function exitOf(r: Pick<Row, "runner_exit_code" | "runner_oom_killed" | "runner_requested_stop">): ExitInfo | null {
  if (r.runner_exit_code === null && r.runner_oom_killed === null && r.runner_requested_stop === null) return null;
  return { exitCode: r.runner_exit_code, oomKilled: r.runner_oom_killed, requestedStop: r.runner_requested_stop };
}

export function toSession(r: Row): Session {
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

export async function lockRow(tx: Tx, id: string): Promise<Row | null> {
  const [row] = await tx<Row[]>`select ${cols()} from fixture_stream_sessions where id = ${id} for update`;
  return row ?? null;
}
/** `exec` defaults to the pool. Inside a transaction pass the tx (m2): a pooled read nested in `sql.begin` holds the
 *  tx's connection AND takes a second one, the self-deadlock shape lib/db.ts warns about. */
export async function readRow(id: string, exec: Tx | typeof sql = sql): Promise<Row | null> {
  const [row] = await exec<Row[]>`select ${cols()} from fixture_stream_sessions where id = ${id}`;
  return row ?? null;
}

/** The programme phase the STORED beat carries (whatever attempt wrote it), null when it carries none. */
export const storedPhaseOf = (row: Row): string | null =>
  typeof row.last_heartbeat?.programmePhase === "string" ? row.last_heartbeat.programmePhase : null;
