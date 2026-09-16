// server/relay/domain/runner.ts — the Fly machine lifecycle, the runner SUB-STATE
// of the session aggregate (plan §"Fly machine lifecycle"). PURE, like
// session.ts: no I/O, no clock — `now` is an argument.
//
// Task 2A: TYPES plus a `stepRunner` stub that refuses every input. The type block
// below is Task 2C's Interfaces block copied VERBATIM (orchestrator ruling I1 on the
// Task 2A review), so Task 2B — which lands between 2A and 2C and builds typed
// `Runner` literals — compiles against the final shapes. The TABLE (`RunnerCell`,
// `RUNNER_TABLE`, `machineNameFor`, `failReasonFromExit`, `MACHINE_MINUTES_BOUND`)
// and `stepRunner`'s real body are Task 2C's.

export const RUNNER_STATES = ["none", "creating", "booting", "playing", "stopping", "exited", "destroyed", "lost"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];
export const OBSERVED_STATES = ["pending", "running", "stopping", "stopped", "failed", "destroying", "destroyed", "unknown"] as const;
export type ObservedRunnerState = (typeof OBSERVED_STATES)[number];
export interface ExitInfo { exitCode: number | null; oomKilled: boolean | null; requestedStop: boolean | null }
export interface Runner { state: RunnerState; attempt: number /* create calls made — Task 10 loads it from the persisted runner_attempts, the ONE authority (C3) */; name: string | null; machineId: string | null; stopRequestedAt: Date | null; lastExit: ExitInfo | null }
export const RUNNER_NONE: Runner = { state: "none", attempt: 0, name: null, machineId: null, stopRequestedAt: null, lastExit: null };
export const RUNNER_TRIGGER_TYPES = ["create_started", "create_ok", "create_failed", "callback_playing", "callback_stopped", "observed", "stale_beat", "deadline", "session_stop", "grace_expired", "destroy_ok", "orphan_listed"] as const;
export type RunnerTrigger =
  | { type: "create_started"; name: string; attempt: number } | { type: "create_ok"; machineId: string }
  | { type: "create_failed"; retryable: boolean } | { type: "callback_playing" } | { type: "callback_stopped" }
  | { type: "observed"; state: ObservedRunnerState; exit?: ExitInfo | null } | { type: "stale_beat" } | { type: "deadline" }
  | { type: "session_stop" } | { type: "grace_expired" } | { type: "destroy_ok" } | { type: "orphan_listed" };
export type RunnerEffect =
  | { type: "persist_intent" } | { type: "create_machine" }
  | { type: "stop_machine"; signal: "SIGINT"; timeoutSeconds: number } | { type: "force_destroy" };
export type RunnerFailReason = "machine_create_failed" | "machine_boot_timeout" | "machine_exit_nonzero" | "machine_oom" | "machine_crash";
export type SessionSignal =
  | { type: "went_live" } | { type: "ending"; endReason: "stopped" | "max_duration" }
  | { type: "completed"; endReason?: "stopped" | "max_duration" }   // F17 carries it when the completion IS the ending (a lost runner torn down by the deadline or the stop)
  | { type: "retry" } | { type: "failed"; reason: RunnerFailReason };
export interface RunnerStep { next: Runner; effects: RunnerEffect[]; signal: SessionSignal | null }
export class InvalidRunnerTransition extends Error {
  constructor(readonly from: RunnerState, readonly trigger: RunnerTrigger["type"]) {
    super(`relay runner: ${trigger} is not legal from ${from}`);
  }
}

/** Task 2A stub: there is no table yet, so every (state, trigger) cell is illegal. Task 2C replaces the body
 *  (and this disable with it — the table reads `now`). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function stepRunner(runner: Runner, trigger: RunnerTrigger, _now: Date): RunnerStep {
  throw new InvalidRunnerTransition(runner.state, trigger.type);
}
