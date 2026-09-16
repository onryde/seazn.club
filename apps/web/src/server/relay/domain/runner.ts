// server/relay/domain/runner.ts — the Fly machine lifecycle, the runner SUB-STATE
// of the session aggregate (plan §"Fly machine lifecycle"). PURE, like
// session.ts: no I/O, no clock — `now` is an argument.
//
// Task 2A: TYPES ONLY, plus a `stepRunner` that refuses every input. The session's
// `runner` command is wired against these names in session.ts; the lifecycle's
// TABLE (and the final member lists of the unions below) is Task 2C's. The members
// here are exactly the ones Task 2A's session.ts and its brief name — Task 2C
// reconciles them against its own brief, it does not have to preserve extras.

/** Mirrors V408's `runner_state` CHECK exactly. */
export type RunnerState = "none" | "creating" | "booting" | "playing" | "stopping" | "exited" | "destroyed" | "lost";

/** The runner as the aggregate carries it. `attempt` is loaded from `runner_attempts` (the create calls
 *  made); `name` is the intended Machine name, persisted BEFORE the create call (`runner_name`);
 *  `machineId` persists as `machine_id`; `stopRequestedAt` starts the stop grace clock
 *  (`runner_stop_requested_at`). */
export interface Runner {
  state: RunnerState;
  attempt: number;
  name: string | null;
  machineId: string | null;
  stopRequestedAt: Date | null;
}

/** A passthrough session's runner, and a composed session's before any create. */
export const RUNNER_NONE: Runner = { state: "none", attempt: 0, name: null, machineId: null, stopRequestedAt: null };

/** What a poll of the provider reported, in the PORT's vocabulary (the provider's own spelling stays in its adapter). Task 2C owns the member list. */
export type ObservedRunnerState = "starting" | "running" | "stopped" | "destroyed" | "not_found";

/** How a Machine's process exited, when the provider says. Task 2C owns the shape. */
export interface ExitInfo {
  code: number | null;
  oomKilled: boolean;
  requestedStop: boolean;
}

/** Every Machine event. Composed sessions never carry machine_playing/machine_stopped commands: the relay
 *  page's heartbeat arrives as callback_playing/callback_stopped, and a composed stop, deadline or stale
 *  beat routes through session_stop/deadline/stale_beat so the teardown is always the table's. */
export type RunnerTrigger =
  | { type: "create_started" }
  | { type: "create_ok"; machineId: string }
  | { type: "callback_playing" }
  | { type: "callback_stopped" }
  | { type: "observed"; state: ObservedRunnerState; exit?: ExitInfo }
  | { type: "session_stop" }
  | { type: "deadline" }
  | { type: "stale_beat" }
  | { type: "grace_expired" };

/** The side effects a runner step asks the application to perform through the runner port. */
export type RunnerEffect =
  | { type: "persist_intent" }
  | { type: "create_machine" }
  | { type: "stop_machine" }
  | { type: "force_destroy" };

/** Why the runner failed the session (joins the session's FailReason). Task 2C owns the member list. */
export type RunnerFailReason = "machine_boot_timeout";

/** What a runner step tells the session (session.ts's `runner()` switches on it). */
export type SessionSignal =
  | { type: "went_live" }
  | { type: "ending"; endReason: "stopped" | "max_duration" }
  | { type: "completed"; endReason?: "stopped" | "max_duration" }
  | { type: "retry" }
  | { type: "failed"; reason: RunnerFailReason };

export interface RunnerStep {
  next: Runner;
  effects: RunnerEffect[];
  signal: SessionSignal | null;
}

export class InvalidRunnerTransition extends Error {
  constructor(readonly from: RunnerState, readonly trigger: RunnerTrigger["type"]) {
    super(`stream runner: ${trigger} is not legal from ${from}`);
  }
}

/** Task 2A stub: there is no table yet, so every (state, trigger) cell is illegal. Task 2C replaces the body
 *  (and this disable with it — the table reads `now`). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function stepRunner(runner: Runner, trigger: RunnerTrigger, _now: Date): RunnerStep {
  throw new InvalidRunnerTransition(runner.state, trigger.type);
}
