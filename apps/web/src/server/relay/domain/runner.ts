// server/relay/domain/runner.ts — the Fly machine lifecycle as a PURE
// sub-machine of the session aggregate (plan §"Fly machine lifecycle" — the
// table there is the authority; RUNNER_TABLE below is that table as code and
// runner.test.ts sweeps every cell). Owner 2026-09-14: "make sure that fly
// machine lifecycle is well defined". No I/O, no clock: `now` is an argument.
//
// The stop is a SIGNAL (SIGINT, R0-memo.md:279 — exit 0 in 114 ms), never a
// keystroke (`q` is discarded under -nostdin, :346–354). A stopped runner is
// expected to auto_destroy (both R0 soaks did, :565); the grace + slack window
// then FORCES a destroy, which completes the session (F-A). A runner observed gone WITHOUT our stop is `lost`:
// torn down, then retried ONCE (design §6.4) — only after it is destroyed
// (invariant 1) — else the session fails with the reason the exit info shows.
//
// Task 2C carry C1 (orchestrator ruling): EVERY state answers `stale_beat`. The
// expiry policy hands it to a live composed session whose runner is playing or
// booting, or carries no stop mark while the session still wants to be live —
// which is any state — and a null cell would throw on every lazy read of that row.
import { MAX_DURATION_MINUTES, RUNNER_MAX_ATTEMPTS, RUNNER_STOP_GRACE_SECONDS, RUNNER_STOP_SIGNAL, WARMING_TIMEOUT_MINUTES } from "../config";

export const RUNNER_STATES = ["none", "creating", "booting", "playing", "stopping", "exited", "destroyed", "lost"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];
export const OBSERVED_STATES = ["pending", "running", "stopping", "stopped", "failed", "destroying", "destroyed", "unknown"] as const;
export type ObservedRunnerState = (typeof OBSERVED_STATES)[number];

export interface ExitInfo { exitCode: number | null; oomKilled: boolean | null; requestedStop: boolean | null }
export interface Runner {
  state: RunnerState;
  /** Create calls made for this session (0 before any). Task 10 LOADS it from the persisted
   *  `runner_attempts` column — the ONE authority (C3) — and `create_started` must carry exactly `attempt + 1`. */
  attempt: number;
  name: string | null; machineId: string | null;
  stopRequestedAt: Date | null; lastExit: ExitInfo | null;
}
export const RUNNER_NONE: Runner = { state: "none", attempt: 0, name: null, machineId: null, stopRequestedAt: null, lastExit: null };

export const RUNNER_TRIGGER_TYPES = [
  "create_started", "create_ok", "create_failed", "callback_playing", "callback_stopped", "observed",
  "stale_beat", "deadline", "session_stop", "grace_expired", "destroy_ok", "orphan_listed",
] as const;
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
  // F17: `completed` carries the reason when the completion IS the ending — a LOST runner the deadline or
  // the organiser's stop tore down never passes through `ending`, so the reason has nowhere else to ride.
  | { type: "completed"; endReason?: "stopped" | "max_duration" }
  | { type: "retry" } | { type: "failed"; reason: RunnerFailReason };

export interface RunnerStep { next: Runner; effects: RunnerEffect[]; signal: SessionSignal | null }

export class InvalidRunnerTransition extends Error {
  constructor(readonly from: RunnerState, readonly trigger: RunnerTrigger["type"]) {
    super(`relay runner: ${trigger} is not legal from ${from}`);
  }
}

export function machineNameFor(sessionId: string, attempt: number): string {
  return `relay-${sessionId}-r${attempt}`;
}

export function failReasonFromExit(exit: ExitInfo | null): RunnerFailReason {
  if (exit?.oomKilled) return "machine_oom";
  if (exit && exit.exitCode !== null && exit.exitCode !== 0) return "machine_exit_nonzero";
  return "machine_crash";
}

/** Invariant 3 — derived, never typed: two attempts × (boot limit + play limit + stop grace).
 *  runner.test.ts WALKS the table for the longest timed path and asserts this covers it (C12). */
export const MACHINE_MINUTES_BOUND =
  RUNNER_MAX_ATTEMPTS * (WARMING_TIMEOUT_MINUTES + MAX_DURATION_MINUTES + Math.ceil(RUNNER_STOP_GRACE_SECONDS / 60));

// ---- cells
type Cell = RunnerCell;
export type RunnerCell = null | ((r: Runner, t: RunnerTrigger, now: Date) => RunnerStep);

const stay = (r: Runner): RunnerStep => ({ next: r, effects: [], signal: null });
const STOP: RunnerEffect = { type: "stop_machine", signal: RUNNER_STOP_SIGNAL, timeoutSeconds: RUNNER_STOP_GRACE_SECONDS };
const FORCE_DESTROY: RunnerEffect = { type: "force_destroy" };
const withExit = (r: Runner, t: RunnerTrigger): Runner => (t.type === "observed" && t.exit ? { ...r, lastExit: t.exit } : r);

/** C2: the ONE retry cap (`runner_retries ≤ 1`) — the create calls made (`attempt`, C3) against RUNNER_MAX_ATTEMPTS.
 *  Every retry signal in the table reads this, and `createStarted` refuses the attempt past it. */
const retryLeft = (r: Runner): boolean => r.attempt < RUNNER_MAX_ATTEMPTS;

/** Leaving `lost` for `destroyed` — or a `destroyed` runner a stale beat finds still awaiting its retry (C1):
 *  the ONE retry, or the failure the exit explains. */
function afterLostDestroyed(r: Runner): RunnerStep {
  const next: Runner = { ...r, state: "destroyed" };
  const signal: SessionSignal = retryLeft(r) ? { type: "retry" } : { type: "failed", reason: failReasonFromExit(r.lastExit) };
  return { next, effects: [], signal };
}

function toStopping(r: Runner, endReason: "stopped" | "max_duration", now: Date): RunnerStep {
  return { next: { ...r, state: "stopping", stopRequestedAt: now }, effects: [STOP], signal: { type: "ending", endReason } };
}

const toLost = (r: Runner, t: RunnerTrigger): RunnerStep => ({ next: { ...withExit(r, t), state: "lost" }, effects: [FORCE_DESTROY], signal: null });
/** Fix round 3, ruling (a): a `lost` runner's teardown has not been SEEN to land. Re-issue it and stay — `destroyed` means
 *  confirmed gone, and only destroy_ok / observed destroyed confirm it (invariant 1: a retry only after that). */
const reissueDestroy = (r: Runner): RunnerStep => ({ next: r, effects: [FORCE_DESTROY], signal: null });
/** Task 2C-post, ruling F-A (a): OUR stop's grace ran out with no destroy seen, so the destroy is forced — and that ENDS the
 *  session now, in the shape the other stopping/exited completion cells use (no endReason: the session stored its own when
 *  ending began, and keeps it). Signalling nothing left an organiser stop whose Machine never auto-destroys `ending` until
 *  ENDING_TIMEOUT_SECONDS. Safe past invariant 1: a stopping/exited runner only exists past an `ending` signal, so this lands
 *  on an ending session (it completes) or a terminal one (C27 ignores it) — nothing after it can retry. */
const forceDestroyed = (r: Runner): RunnerStep => ({ next: { ...r, state: "destroyed" }, effects: [FORCE_DESTROY], signal: { type: "completed" } });

/** F17: the deadline or the organiser's stop reaching a LOST runner. The teardown is the same force_destroy;
 *  what changes is that the SESSION is told, so this destroy COMPLETES it. Without the signal the session
 *  stayed live and the ONE retry `destroy_ok` still owes would boot a replacement past the wall clock —
 *  a retry belongs only to a session that still wants to be live (Task 2A's `runner()` retry arm). */
const lostTornDown = (r: Runner, endReason: "stopped" | "max_duration"): RunnerStep =>
  ({ next: { ...r, state: "destroyed" }, effects: [FORCE_DESTROY], signal: { type: "completed", endReason } });

/** P1-F-a: the organiser stopped while the create call was in flight. Whatever the call returns,
 *  the next step is teardown — no boot wait, no retry, no create failure — and the session completes. */
const stoppedDuringCreate = (r: Runner, machineId: string | null, destroy: boolean): RunnerStep =>
  ({ next: { ...r, state: "destroyed", machineId: machineId ?? r.machineId }, effects: destroy ? [FORCE_DESTROY] : [], signal: { type: "completed" } });

/** P1-F-a / F14: a stop or a deadline while the create call is in flight. Marking IS the whole step —
 *  no effect can be sent at a Machine we have no id for. The mark also starts the F15 grace clock
 *  (`evaluate` reads `stopRequestedAt` in stopping, exited and creating). */
const markedDuringCreate = (r: Runner, now: Date, endReason: "stopped" | "max_duration"): RunnerStep =>
  ({ next: { ...r, stopRequestedAt: r.stopRequestedAt ?? now }, effects: [], signal: { type: "ending", endReason } });

/** A create call that returns AFTER the runner moved on — we gave up (F15's grace, a teardown another reader
 *  already ran) or a stale beat declared the hung create lost (C1): destroy what it made and tell the session
 *  nothing. Never a throw on a call we ourselves started.
 *  Fix round 4 (ruling): the returned id is a Machine whose destroy is NOT confirmed, so the runner is `lost` —
 *  from `destroyed` too. Only destroy_ok / observed destroyed then lead to a retry (invariant 1); a destroyed
 *  runner that stayed destroyed here let the next stale beat re-signal the retry beside a live Machine. */
const destroyLateCreate: Cell = (r, t) =>
  (t.type === "create_ok" ? { next: { ...r, state: "lost", machineId: t.machineId }, effects: [FORCE_DESTROY], signal: null } : stay(r));

function observedFrom(active: "booting" | "playing"): Cell {
  return (r, t) => {
    if (t.type !== "observed") throw new InvalidRunnerTransition(active, t.type);
    switch (t.state) {
      case "stopped": case "failed": return toLost(r, t);
      case "destroyed": return afterLostDestroyed(withExit(r, t));   // gone without our stop: retry or fail
      default: return stay(withExit(r, t));                           // running / pending / stopping / destroying / unknown: no claim
    }
  };
}

function observedWhileStopping(r: Runner, t: RunnerTrigger): RunnerStep {
  if (t.type !== "observed") throw new InvalidRunnerTransition(r.state, t.type);
  switch (t.state) {
    case "stopped": case "failed": return { next: { ...withExit(r, t), state: "exited" }, effects: [], signal: null };
    case "destroyed": return { next: { ...withExit(r, t), state: "destroyed" }, effects: [], signal: { type: "completed" } };
    default: return stay(withExit(r, t));
  }
}

const createStarted: Cell = (r, t) => {
  if (t.type !== "create_started") throw new InvalidRunnerTransition(r.state, t.type);
  if (t.attempt > RUNNER_MAX_ATTEMPTS || t.attempt !== r.attempt + 1) throw new InvalidRunnerTransition(r.state, t.type);
  return { next: { ...r, state: "creating", attempt: t.attempt, name: t.name, machineId: null, stopRequestedAt: null }, effects: [{ type: "persist_intent" }, { type: "create_machine" }], signal: null };
};

export const RUNNER_TABLE: Record<RunnerState, Record<RunnerTrigger["type"], RunnerCell>> = {
  none: {
    create_started: createStarted, create_ok: null, create_failed: null, callback_playing: null, callback_stopped: null,
    observed: null,
    // C1: a live composed session with NO runner is a corrupt row. Fail it (a stale heartbeat is `machine_crash`) —
    // a throw here would 500 every read of it forever. There is no name to tear down.
    stale_beat: (r) => ({ next: r, effects: [], signal: { type: "failed", reason: "machine_crash" } }),
    deadline: null, session_stop: null, grace_expired: null, destroy_ok: null, orphan_listed: null,
  },
  creating: {
    create_started: null,
    create_ok: (r, t) => {
      if (t.type !== "create_ok") return stay(r);
      if (r.stopRequestedAt) return stoppedDuringCreate(r, t.machineId, true);      // P1-F-a: stopped mid-create → destroy the new Machine now
      return { next: { ...r, state: "booting", machineId: t.machineId }, effects: [], signal: null };
    },
    create_failed: (r, t) => {
      if (t.type !== "create_failed") return stay(r);
      if (r.stopRequestedAt) return stoppedDuringCreate(r, null, false);             // P1-F-a: nothing was created, nothing to retry
      const canRetry = t.retryable && retryLeft(r);
      return { next: { ...r, state: "destroyed" }, effects: [], signal: canRetry ? { type: "retry" } : { type: "failed", reason: "machine_create_failed" } };
    },
    callback_playing: null, callback_stopped: null,
    observed: (r, t) => {
      if (t.type !== "observed") return stay(r);
      // crash-safe reconcile (invariant 4): the Machine exists under our name → adopt it, no second create
      const found = t.state === "pending" || t.state === "running";
      if (found && r.stopRequestedAt) return stoppedDuringCreate(r, null, true);    // P1-F-a: found after a stop → destroy, never boot
      return found ? { next: { ...r, state: "booting" }, effects: [], signal: null } : stay(r);
    },
    // C1: a replacement's create that hangs past the beat window. It may still make a Machine, so it is LOST — the
    // by-name teardown now, the retry only once destroyed (invariant 1); a late create_ok is `lost`'s to destroy.
    stale_beat: (r, t) => toLost(r, t),
    // The call is in flight: mark and end the session — the call's return tears down (P1-F-a for the stop, F14 for the deadline).
    deadline: (r, _t, now) => markedDuringCreate(r, now, "max_duration"),
    session_stop: (r, _t, now) => markedDuringCreate(r, now, "stopped"),
    // F15: marked, and nothing ever came back. The lazy grace check ends it; force_destroy is the
    // by-name teardown for a Machine the call may still have made (Task 10 resolves the name).
    grace_expired: (r) => stoppedDuringCreate(r, null, true),
    destroy_ok: null, orphan_listed: null,
  },
  booting: {
    create_started: null, create_ok: null, create_failed: null,
    callback_playing: (r) => ({ next: { ...r, state: "playing" }, effects: [], signal: { type: "went_live" } }),
    callback_stopped: (r, t) => toLost(r, t),
    observed: observedFrom("booting"),
    stale_beat: (r, t) => toLost(r, t),                            // only reachable for a replacement booting in a LIVE session (expiry.ts)
    deadline: (r, _t, now) => toStopping(r, "max_duration", now),
    session_stop: (r, _t, now) => toStopping(r, "stopped", now),
    grace_expired: null, destroy_ok: null, orphan_listed: null,
  },
  playing: {
    create_started: null, create_ok: null, create_failed: null,
    // F16: idempotent, and the RECOVERY for a beat the session had to ignore (one that arrived before
    // `provisioned`). went_live is a no-op on a live session and takes a warming one live, once.
    callback_playing: (r) => ({ next: r, effects: [], signal: { type: "went_live" } }),
    callback_stopped: (r, t) => toLost(r, t),
    observed: observedFrom("playing"),
    stale_beat: (r, t) => toLost(r, t),
    deadline: (r, _t, now) => toStopping(r, "max_duration", now),
    session_stop: (r, _t, now) => toStopping(r, "stopped", now),
    grace_expired: null, destroy_ok: null, orphan_listed: null,
  },
  stopping: {
    create_started: null, create_ok: null, create_failed: null,
    callback_playing: (r) => stay(r),
    callback_stopped: (r) => ({ next: { ...r, state: "exited" }, effects: [], signal: null }),
    observed: observedWhileStopping,
    stale_beat: (r) => stay(r), deadline: (r) => stay(r), session_stop: (r) => stay(r),
    grace_expired: (r) => forceDestroyed(r),
    destroy_ok: (r) => ({ next: { ...r, state: "destroyed" }, effects: [], signal: { type: "completed" } }),
    orphan_listed: null,
  },
  exited: {
    create_started: null, create_ok: null, create_failed: null, callback_playing: null,
    callback_stopped: (r) => stay(r),
    observed: (r, t) => (t.type === "observed" && t.state === "destroyed" ? { next: { ...r, state: "destroyed" }, effects: [], signal: { type: "completed" } } : stay(withExit(r, t))),
    stale_beat: (r) => stay(r), deadline: (r) => stay(r), session_stop: (r) => stay(r),
    grace_expired: (r) => forceDestroyed(r),
    destroy_ok: (r) => ({ next: { ...r, state: "destroyed" }, effects: [], signal: { type: "completed" } }),
    orphan_listed: null,
  },
  lost: {
    create_started: null,
    // C1 made `creating → lost` reachable while the create call is still in flight: its return is not an error.
    create_ok: destroyLateCreate, create_failed: (r) => stay(r),
    callback_playing: null,
    callback_stopped: (r) => stay(r),
    observed: (r, t) => (t.type === "observed" && t.state === "destroyed" ? afterLostDestroyed(withExit(r, t)) : stay(withExit(r, t))),
    // C1: the teardown this state's entry issued has not been seen to land. Re-issue it — NEVER a retry signal, which
    // waits for destroyed (invariant 1). The once-per-STALE_HEARTBEAT_SECONDS bound is the session's: `decide`'s
    // stale_beat arm restarts the beat window (the session's beatWindowAt), since no beat arrives from a lost runner.
    stale_beat: (r) => reissueDestroy(r),
    // F17 — a deadline or a stop here ENDS the session (completed: no retry can follow on a session that stopped wanting live).
    deadline: (r) => lostTornDown(r, "max_duration"), session_stop: (r) => lostTornDown(r, "stopped"),
    // Fix round 3, ruling (a): our own teardown timing out, or the sweep finding the Machine, is NOT a confirmation — both
    // re-issue the force_destroy and stay lost. Round 2 measured the defect they closed: → destroyed on a force alone, then
    // the next stale beat re-signalled the retry while attempt 1 might still be up. Only destroy_ok leaves to the ONE retry.
    grace_expired: (r) => reissueDestroy(r),
    destroy_ok: (r) => afterLostDestroyed(r),
    orphan_listed: (r) => reissueDestroy(r),
  },
  destroyed: {
    create_started: createStarted,                                  // the retry — only from here (invariant 1)
    create_ok: destroyLateCreate,
    create_failed: (r) => stay(r),
    callback_playing: null, callback_stopped: null,
    observed: (r) => stay(r),
    // C1: destroyed and still wanted live — the process died before `retry_runner` ran. Re-signal the ONE retry
    // while the cap allows (the session's retry arm refuses it once the session is ending), else fail.
    stale_beat: (r) => afterLostDestroyed(r),
    deadline: null,
    session_stop: (r) => stay(r), grace_expired: null, destroy_ok: (r) => stay(r), orphan_listed: (r) => stay(r),
  },
};

export function stepRunner(r: Runner, t: RunnerTrigger, now: Date): RunnerStep {
  const cell = RUNNER_TABLE[r.state][t.type];
  if (cell === null) throw new InvalidRunnerTransition(r.state, t.type);
  return cell(r, t, now);
}
