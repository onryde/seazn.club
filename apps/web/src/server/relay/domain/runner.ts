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
import { MAX_DURATION_MINUTES, RELAY_EXIT_REFUSED, RUNNER_CRASH_CAP, RUNNER_MAX_ATTEMPTS, RUNNER_RESTART_STUCK_SECONDS, RUNNER_STOP_GRACE_SECONDS, RUNNER_STOP_SIGNAL, WARMING_TIMEOUT_MINUTES } from "../config";

export const RUNNER_STATES = ["none", "creating", "booting", "playing", "stopping", "exited", "destroyed", "lost"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];
export const OBSERVED_STATES = ["pending", "running", "stopping", "stopped", "failed", "destroying", "destroyed", "unknown"] as const;
export type ObservedRunnerState = (typeof OBSERVED_STATES)[number];

export interface ExitInfo { exitCode: number | null; oomKilled: boolean | null; requestedStop: boolean | null }

/** R2003b (owner approval 2026-10-16): the crashes RUNNER_CRASH_CAP reads. A crash leaves up to two pieces of evidence —
 *  its final beat (`exitReason: fatal`; C07: one per run, best-effort, never retried) and its exit as the provider recorded
 *  it (an instant, and Fly's per-window restart count, F-007) — and either, both or neither may reach us, in either order.
 *  So each is kept as its own LOWER BOUND on this attempt's crashes and the attempt counts their MAX, never their sum: one
 *  crash seen both ways is one crash, by construction, whichever arrives first. Mixed evidence (one crash seen only by its
 *  beat, another only by its exit) can undercount — the safe direction: the cap then fires a few crashes late, never early.
 *  Persisted in V449's four runner_crash_* columns (stream-sessions.ts `persist`). */
export interface CrashTally {
  /** The SESSION's crashes, summed over its attempts (it spans the ONE retry) — what the cap reads. */
  count: number;
  /** THIS attempt's fatal final beats. */
  beats: number;
  /** THIS attempt's crash exits: +1 per exit whose instant is newer than `exitAt`, never below the provider's restart count. */
  exits: number;
  /** The provider's instant of the newest crash exit counted — the identity a re-read of the same exit is matched on. */
  exitAt: Date | null;
}
export const CRASHES_NONE: CrashTally = { count: 0, beats: 0, exits: 0, exitAt: null };

export interface Runner {
  state: RunnerState;
  /** Create calls made for this session (0 before any). Task 10 LOADS it from the persisted
   *  `runner_attempts` column — the ONE authority (C3) — and `create_started` must carry exactly `attempt + 1`. */
  attempt: number;
  name: string | null; machineId: string | null;
  stopRequestedAt: Date | null; lastExit: ExitInfo | null;
  /** R2003b. REQUIRED, not optional: every producer of a Runner must say what it has counted (tsc is the guard). */
  crashes: CrashTally;
}
export const RUNNER_NONE: Runner = { state: "none", attempt: 0, name: null, machineId: null, stopRequestedAt: null, lastExit: null, crashes: CRASHES_NONE };

export const RUNNER_TRIGGER_TYPES = [
  "create_started", "create_ok", "create_failed", "callback_playing", "callback_stopped", "callback_crashed", "observed",
  "stale_beat", "deadline", "session_stop", "grace_expired", "destroy_ok", "orphan_listed",
] as const;
export type RunnerTrigger =
  | { type: "create_started"; name: string; attempt: number } | { type: "create_ok"; machineId: string }
  // `outcomeUnknown` (whole-branch review I2, money): the create call failed and we do NOT know whether Fly holds a
  // Machine under our name. It is REQUIRED, not optional, on purpose — absent would default to "nothing was made",
  // which is the unsafe half, and tsc is the only guard that survives a second producer. The producer is the port's
  // `RunnerCreateError` (ports.ts, A23): each adapter fills it from its own evidence (`runner-fly.ts`
  // `runnerCreateErrorFrom` reads Fly's error FIELDS), and a rejection that is not one is read as unknown rather than
  // assumed-clean (`createFailureOf`). false and `retryable: true` are consistent by
  // construction — T5-b downgrades a create it could not settle to `retryable: false`, so an ambiguous outcome can
  // never arrive with the domain's licence to create attempt + 1 under a different name.
  | { type: "create_failed"; retryable: boolean; outcomeUnknown: boolean } | { type: "callback_playing" }
  // R2003: what the compositor's final beat said (`stoppedBeatTrigger`). `refused` — its run was refused; `endReason` —
  // it ENDED the run (I2, PR #967 review), and the session ends with this reason. Both optional on purpose: absent is
  // every stopped beat before R2003, and the one other producer (a legacy runner's beat, no exit reason).
  | { type: "callback_stopped"; refused?: true; endReason?: RunnerEndReason }
  // R2003b: the compositor's final beat said `fatal` — one crash of this attempt's run (`stoppedBeatTrigger`).
  | { type: "callback_crashed" }
  // R2003 / F-007: `restarting` — the provider is restarting this Machine in place (ports.ts RunnerObservation), since
  // `restartingSince`; `null` — down, but the provider has not recorded that exit yet (no claim). Optional: absent is
  // every observation before F-007, read as "not restarting" (today's rule) — so absent and null are NOT the same.
  // R2003b: `exitAt` — the instant of the exit `exit` describes (its identity: a second read of it is the same exit);
  // `restartCount` — the provider's in-place restarts in its current window (F-007: a floor on this Machine's crashes).
  // Both optional: absent is every observation before R2003b, and it counts nothing it cannot identify.
  | { type: "observed"; state: ObservedRunnerState; exit?: ExitInfo | null; restarting?: boolean | null; restartingSince?: Date | null; exitAt?: Date | null; restartCount?: number | null }
  | { type: "stale_beat" } | { type: "deadline" }
  // Capture QR v2 §5.3: the stop's reason. Optional on purpose: the teardown producers (a timeout or a credit refusal
  // tearing a Machine down before `fail`) drop the stop's ending, or keep the session's own reason (M2), so for them the
  // reason is never read; absent reads "stopped" — the reason every session_stop carried before §5.3.
  | { type: "session_stop"; reason?: StopEndReason } | { type: "grace_expired" } | { type: "destroy_ok" } | { type: "orphan_listed" };

export type RunnerEffect =
  | { type: "persist_intent" } | { type: "create_machine" }
  | { type: "stop_machine"; signal: "SIGINT"; timeoutSeconds: number } | { type: "force_destroy" };

/** `machine_refused` (R2003): the compositor's refusal — exit RELAY_EXIT_REFUSED observed, or a final beat saying `refused`. */
export type RunnerFailReason = "machine_create_failed" | "machine_boot_timeout" | "machine_exit_nonzero" | "machine_oom" | "machine_crash" | "machine_refused";
/** The reasons a runner signal can carry: a stop's (§5.3) or the wall clock's. */
export type StopEndReason = "stopped" | "operator_stopped" | "auto_stopped" | "phone_lost";
export type RunnerEndReason = StopEndReason | "max_duration";
const stopReasonOf = (t: RunnerTrigger): StopEndReason => (t.type === "session_stop" ? t.reason ?? "stopped" : "stopped");
export type SessionSignal =
  | { type: "went_live" } | { type: "ending"; endReason: RunnerEndReason }
  // F17: `completed` carries the reason when the completion IS the ending — a LOST runner the deadline or
  // the organiser's stop tore down never passes through `ending`, so the reason has nowhere else to ride.
  | { type: "completed"; endReason?: RunnerEndReason }
  | { type: "retry" } | { type: "failed"; reason: RunnerFailReason };

export interface RunnerStep { next: Runner; effects: RunnerEffect[]; signal: SessionSignal | null }

/** R2002's `RelayHeartbeat.exitReason` (C06's exit reason, snake_case): WHY the compositor sent its one final
 *  `state: stopped` beat. The domain's own declaration — it imports nothing but ../config — and runner.test.ts pins it
 *  equal to the schema's enum, so the two cannot drift. */
export const BEAT_EXIT_REASONS = ["ended", "deadline", "signalled", "session_gone", "refused", "fatal"] as const;
export type BeatExitReason = (typeof BEAT_EXIT_REASONS)[number];

/** R2003 (controller ruling, 2026-10-15; R2003b, owner approval 2026-10-16): what a COMPOSED runner's stopped beat asks of
 *  the lifecycle, by the reason it gave. null = RECORD ONLY: the beat is in its two stores (last_heartbeat, the sample) and
 *  the lifecycle hears nothing.
 *  - none given (a legacy runner) → `callback_stopped`, exactly as before R2003 (lost → destroyed → the ONE retry).
 *  - `ended` / `deadline` → `callback_stopped` carrying an end reason: the session ENDS (`stopped` / `max_duration`) and
 *    is never retried (I2, orchestrator decision on the PR #967 review). A deadline retry would boot a Machine past
 *    RELAY_DEADLINE_AT — the wall clock's own instant, hence max_duration — and an unsolicited `ended` is the
 *    compositor's to make.
 *  - `fatal` → `callback_crashed`: a CRASH, counted (CrashTally). Below RUNNER_CRASH_CAP the lifecycle still only records
 *    it: Fly restarts a crashed compositor IN PLACE (`on-failure`, RUNNER_INPLACE_RESTARTS) and the restarted process beats
 *    again on the SAME attempt; if it does not, the composed stale window takes it `lost` → force_destroy → destroyed →
 *    the ONE retry. A stop here force-destroyed the Machine Fly was restarting and spent the retry on a cold start that
 *    splits the organiser's YouTube broadcast (F-004 addendum: 15–30 s). AT the cap the session fails machine_crash.
 *  - `signalled` → record only, and NEVER a crash: the run drained on a stop someone else asked for (C06: SIGTERM, exit 0)
 *    — Fly does not restart exit 0, so it cannot loop, and counting it would let host maintenance fail a session.
 *  - `session_gone` → record only: web said 410, so the session is already over and its own path ends the runner.
 *  - `refused` → `callback_stopped` marked refused: the exit-78 outcome, failed(machine_refused), never a retry. */
export function stoppedBeatTrigger(exitReason: BeatExitReason | null | undefined): RunnerTrigger | null {
  switch (exitReason) {
    case undefined: case null: return { type: "callback_stopped" };
    case "ended": return { type: "callback_stopped", endReason: "stopped" };
    case "deadline": return { type: "callback_stopped", endReason: "max_duration" };
    case "refused": return { type: "callback_stopped", refused: true };
    case "fatal": return { type: "callback_crashed" };
    case "signalled": case "session_gone": return null;
  }
}

export class InvalidRunnerTransition extends Error {
  constructor(readonly from: RunnerState, readonly trigger: RunnerTrigger["type"]) {
    super(`relay runner: ${trigger} is not legal from ${from}`);
  }
}

export function machineNameFor(sessionId: string, attempt: number): string {
  return `relay-${sessionId}-r${attempt}`;
}

/** R2003: the compositor's refusal exit (RELAY_EXIT_REFUSED). Its bootstrap read was refused or did not decode, so a
 *  replacement would be refused the same way — it never earns the retry. */
const refusedExit = (exit: ExitInfo | null): boolean => exit?.exitCode === RELAY_EXIT_REFUSED;

export function failReasonFromExit(exit: ExitInfo | null): RunnerFailReason {
  if (exit?.oomKilled) return "machine_oom";
  if (refusedExit(exit)) return "machine_refused";
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

// ---- R2003b: the crash tally (CrashTally). Pure arithmetic over the evidence; the cells below decide what the cap does.
/** An attempt's crashes: the larger of its two lower bounds — never their sum. */
const attemptCrashes = (c: CrashTally): number => Math.max(c.beats, c.exits);
/** The tally with this attempt's bounds moved: the session's count moves by exactly what the attempt's max moved. */
const recount = (c: CrashTally, beats: number, exits: number, exitAt: Date | null): CrashTally =>
  ({ count: c.count + Math.max(beats, exits) - attemptCrashes(c), beats, exits, exitAt });
const crashCapped = (r: Runner): boolean => r.crashes.count >= RUNNER_CRASH_CAP;
/** A fatal final beat: one more crash seen by its beat. */
const withCrashBeat = (r: Runner): Runner => ({ ...r, crashes: recount(r.crashes, r.crashes.beats + 1, r.crashes.exits, r.crashes.exitAt) });
/** Does this observation show a CRASH exit — a run Fly restarts in place? Restarting says so (Fly restarts only a failure);
 *  otherwise the exit itself: OOM-killed or non-zero, and not a stop that was asked for. Never the refusal (78, its own
 *  path) and never exit 0 — every clean ending, `signalled` included, exits 0 (C06). */
function crashExitSeen(t: Extract<RunnerTrigger, { type: "observed" }>): boolean {
  const exit = t.exit ?? null;
  if (refusedExit(exit)) return false;
  if (t.restarting === true) return true;
  return exit !== null && exit.requestedStop !== true && (exit.oomKilled === true || (exit.exitCode !== null && exit.exitCode !== 0));
}
/** One more crash seen by its exit, when the exit is a NEW one (its instant is newer than the newest counted — a re-read
 *  of the same exit is the same crash); and never below the provider's restart count, which is a true floor on this
 *  Machine's crashes in its window (F-007: restarting exit k carries restart_count k). Nothing it cannot identify counts. */
function withCrashExit(r: Runner, t: RunnerTrigger): Runner {
  if (t.type !== "observed" || !crashExitSeen(t)) return r;
  const c = r.crashes;
  const fresh = t.exitAt != null && (c.exitAt === null || t.exitAt.getTime() > c.exitAt.getTime());
  const floor = typeof t.restartCount === "number" && Number.isInteger(t.restartCount) && t.restartCount > 0 ? t.restartCount : 0;
  const exits = Math.max(fresh ? c.exits + 1 : c.exits, floor);
  return { ...r, crashes: recount(c, c.beats, exits, fresh ? t.exitAt! : c.exitAt) };
}
/** R2003b: the crash that reaches RUNNER_CRASH_CAP. The session FAILS machine_crash and the Machine is torn down NOW — Fly
 *  would restart it in place again (and refill its window after ~330 s, F-007) — with no retry: a replacement boots the
 *  same image into the same session. C27 drops the retry `lost × destroy_ok` would signal later (`afterLostDestroyed`). */
const crashCappedNow = (r: Runner): RunnerStep => ({ next: { ...r, state: "lost" }, effects: [FORCE_DESTROY], signal: { type: "failed", reason: "machine_crash" } });

/** Leaving `lost` for `destroyed` — or a `destroyed` runner a stale beat finds still awaiting its retry (C1):
 *  the ONE retry, or the failure the exit explains. R2003: a refused exit (78) never spends the retry — Fly's on-failure
 *  restarted it in place already, each run refused in about a second, and attempt + 1 reads the same session.
 *  R2003b: nor does a session at RUNNER_CRASH_CAP — it fails machine_crash, whatever retry is left. */
function afterLostDestroyed(r: Runner): RunnerStep {
  const next: Runner = { ...r, state: "destroyed" };
  const signal: SessionSignal =
    refusedExit(r.lastExit) ? { type: "failed", reason: "machine_refused" }
    : crashCapped(r) ? { type: "failed", reason: "machine_crash" }
    : retryLeft(r) ? { type: "retry" }
    : { type: "failed", reason: failReasonFromExit(r.lastExit) };
  return { next, effects: [], signal };
}

function toStopping(r: Runner, endReason: RunnerEndReason, now: Date): RunnerStep {
  return { next: { ...r, state: "stopping", stopRequestedAt: now }, effects: [STOP], signal: { type: "ending", endReason } };
}

const toLost = (r: Runner, t: RunnerTrigger): RunnerStep => ({ next: { ...withExit(r, t), state: "lost" }, effects: [FORCE_DESTROY], signal: null });
/** R2003: a booting/playing runner's final beat said `refused` (stoppedBeatTrigger). The session FAILS now — waiting for an
 *  observed exit 78 would let the stopped beat's ordinary `lost` path spend the retry first — and the Machine Fly would
 *  restart into the same refusal is torn down. The session is terminal by the time `lost × destroy_ok` confirms the
 *  destroy, so C27 drops the retry that cell signals. No exit is written: a beat never writes the exit facts (A5). */
/** The run was refused (the final beat said so, or an observed exit 78): failed, and the Machine torn down NOW — Fly
 *  restarts exit 78 like any crash (F-007 result 2), so waiting for it to die would watch it refuse again. */
const refusedNow = (r: Runner): RunnerStep => ({ next: { ...r, state: "lost" }, effects: [FORCE_DESTROY], signal: { type: "failed", reason: "machine_refused" } });
/** booting/playing × a stopped beat: refused → fail now; an end reason → the session-ending teardown (`lostTornDown`, the
 *  F17 shape: destroyed + force_destroy + completed — nothing after a completed session can retry); otherwise today's lost. */
const stoppedWhileActive: Cell = (r, t) =>
  t.type !== "callback_stopped" ? toLost(r, t)
  : t.refused ? refusedNow(r)
  : t.endReason !== undefined ? lostTornDown(r, t.endReason)
  : toLost(r, t);
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
const lostTornDown = (r: Runner, endReason: RunnerEndReason): RunnerStep =>
  ({ next: { ...r, state: "destroyed" }, effects: [FORCE_DESTROY], signal: { type: "completed", endReason } });

/** P1-F-a: the organiser stopped while the create call was in flight. Whatever the call returns,
 *  the next step is teardown — no boot wait, no retry, no create failure — and the session completes. */
const stoppedDuringCreate = (r: Runner, machineId: string | null, destroy: boolean): RunnerStep =>
  ({ next: { ...r, state: "destroyed", machineId: machineId ?? r.machineId }, effects: destroy ? [FORCE_DESTROY] : [], signal: { type: "completed" } });

/** P1-F-a / F14: a stop or a deadline while the create call is in flight. Marking IS the whole step —
 *  no effect can be sent at a Machine we have no id for. The mark also starts the F15 grace clock
 *  (`evaluate` reads `stopRequestedAt` in stopping, exited and creating). */
const markedDuringCreate = (r: Runner, now: Date, endReason: RunnerEndReason): RunnerStep =>
  ({ next: { ...r, stopRequestedAt: r.stopRequestedAt ?? now }, effects: [], signal: { type: "ending", endReason } });

/** A create call that returns AFTER the runner moved on — we gave up (F15's grace, a teardown another reader
 *  already ran) or a stale beat declared the hung create lost (C1): destroy what it made and tell the session
 *  nothing. Never a throw on a call we ourselves started.
 *  Fix round 4 (ruling): the returned id is a Machine whose destroy is NOT confirmed, so the runner is `lost` —
 *  from `destroyed` too. Only destroy_ok / observed destroyed then lead to a retry (invariant 1); a destroyed
 *  runner that stayed destroyed here let the next stale beat re-signal the retry beside a live Machine. */
const destroyLateCreate: Cell = (r, t) =>
  (t.type === "create_ok" ? { next: { ...r, state: "lost", machineId: t.machineId }, effects: [FORCE_DESTROY], signal: null } : stay(r));

/** F-007: the observation is an in-place restart still inside its bound. A restart with no instant (a provider that gave
 *  none) cannot be timed here; the composed stale window is its backstop. */
function restartInFlight(t: Extract<RunnerTrigger, { type: "observed" }>, now: Date): boolean {
  if (t.restarting !== true) return false;
  return !t.restartingSince || now.getTime() - t.restartingSince.getTime() <= RUNNER_RESTART_STUCK_SECONDS * 1000;
}

function observedFrom(active: "booting" | "playing"): Cell {
  return (r, t, now) => {
    if (t.type !== "observed") throw new InvalidRunnerTransition(active, t.type);
    switch (t.state) {
      case "stopped": case "failed": {
        // F-007 result 2: Fly restarts exit 78 like any crash, so a refusal is never waited out — the session fails and
        // the Machine is torn down NOW, restarting or not (the refused beat's own path, with the observed exit kept).
        if (refusedExit(t.exit ?? null)) return refusedNow(withExit(r, t));
        // F-007 race: read STOPPED before the provider recorded the exit — restart or loss is not knowable yet. No claim:
        // the stale window (composed, or the boot allowance) decides if no beat and no recorded exit follow. Never for
        // `failed`: a launch that failed has no exit to wait for (pass-3 review), so it is lost below, as it always was.
        if (t.restarting === null && t.state === "stopped") return stay(r);
        // R2003b: a crash exit is counted first — the one that reaches the cap is never waited out.
        const c = withCrashExit(withExit(r, t), t);
        if (crashCapped(c)) return crashCappedNow(c);
        // F-007 result 1: mid-restart the Machine reads `stopped` for ~110 ms. Only the restarting flag tells that from
        // a loss; past RUNNER_RESTART_STUCK_SECONDS it is a loss after all.
        return restartInFlight(t, now) ? stay(c) : toLost(c, t);
      }
      // gone without our stop: retry or fail. A restarting flag does not exempt it — a destroyed Machine is not coming back.
      case "destroyed": return afterLostDestroyed(withCrashExit(withExit(r, t), t));
      // `starting` mid-restart (~1.3 s): still the same Machine — unless the restart is stuck past its bound, or it is
      // restarting a REFUSAL (the stopped instant fell between two polls; a refusal is never waited out).
      case "pending": {
        if (refusedExit(t.exit ?? null)) return refusedNow(withExit(r, t));
        const c = withCrashExit(withExit(r, t), t);
        if (crashCapped(c)) return crashCappedNow(c);
        return t.restarting === true && !restartInFlight(t, now) ? toLost(c, t) : stay(c);
      }
      default: {                                                       // running / stopping / destroying / unknown: no claim
        const c = withCrashExit(withExit(r, t), t);
        return crashCapped(c) ? crashCappedNow(c) : stay(c);
      }
    }
  };
}

/** R2003b: booting/playing × a fatal final beat — counted. Below the cap it is record only (R2003: Fly restarts it in place
 *  on the SAME attempt); the beat that reaches the cap fails the session and tears the Machine down. */
const crashedWhileActive: Cell = (r) => {
  const c = withCrashBeat(r);
  return crashCapped(c) ? crashCappedNow(c) : stay(c);
};

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
  // R2003b: no Machine for a session at the cap — a guard, not a comment: every signal there is failed, so only a late or
  // stray retry_runner can ask, and `decide` already refuses it on the failed session. This holds if that ever changes.
  if (crashCapped(r)) throw new InvalidRunnerTransition(r.state, t.type);
  // The new attempt's evidence starts empty; the session's count (and the newest exit identity) carry.
  const crashes: CrashTally = { ...r.crashes, beats: 0, exits: 0 };
  return { next: { ...r, state: "creating", attempt: t.attempt, name: t.name, machineId: null, stopRequestedAt: null, crashes }, effects: [{ type: "persist_intent" }, { type: "create_machine" }], signal: null };
};

export const RUNNER_TABLE: Record<RunnerState, Record<RunnerTrigger["type"], RunnerCell>> = {
  none: {
    create_started: createStarted, create_ok: null, create_failed: null, callback_playing: null, callback_stopped: null,
    callback_crashed: null, observed: null,
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
      // Review I2 (money): the call failed with its outcome UNKNOWN — Fly may hold a Machine under our name, which will
      // run to RELAY_DEADLINE_AT (up to MAX_DURATION_MINUTES), billing and pushing to the organiser's destination, until
      // the daily orphan sweep. This is the same uncertainty the two cells below already model (grace_expired ":may still
      // have made", stale_beat "it may still make one"), so it gets the same answer: tear down BY NAME now. Marked, the
      // organiser's stop still completes the session (grace_expired's exact shape); unmarked it is `lost`, whose entry
      // issues the force_destroy and whose exit to the ONE retry waits for a CONFIRMED destroy (invariant 1).
      if (t.outcomeUnknown) return r.stopRequestedAt ? stoppedDuringCreate(r, null, true) : toLost(r, t);
      if (r.stopRequestedAt) return stoppedDuringCreate(r, null, false);             // P1-F-a: nothing was created, nothing to retry
      const canRetry = t.retryable && retryLeft(r);
      return { next: { ...r, state: "destroyed" }, effects: [], signal: canRetry ? { type: "retry" } : { type: "failed", reason: "machine_create_failed" } };
    },
    callback_playing: null, callback_stopped: null, callback_crashed: null,
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
    session_stop: (r, t, now) => markedDuringCreate(r, now, stopReasonOf(t)),
    // F15: marked, and nothing ever came back. The lazy grace check ends it; force_destroy is the
    // by-name teardown for a Machine the call may still have made (Task 10 resolves the name).
    grace_expired: (r) => stoppedDuringCreate(r, null, true),
    destroy_ok: null, orphan_listed: null,
  },
  booting: {
    create_started: null, create_ok: null, create_failed: null,
    callback_playing: (r) => ({ next: { ...r, state: "playing" }, effects: [], signal: { type: "went_live" } }),
    callback_stopped: stoppedWhileActive,
    callback_crashed: crashedWhileActive,
    observed: observedFrom("booting"),
    stale_beat: (r, t) => toLost(r, t),                            // only reachable for a replacement booting in a LIVE session (expiry.ts)
    deadline: (r, _t, now) => toStopping(r, "max_duration", now),
    session_stop: (r, t, now) => toStopping(r, stopReasonOf(t), now),
    grace_expired: null, destroy_ok: null, orphan_listed: null,
  },
  playing: {
    create_started: null, create_ok: null, create_failed: null,
    // F16: idempotent, and the RECOVERY for a beat the session had to ignore (one that arrived before
    // `provisioned`). went_live is a no-op on a live session and takes a warming one live, once.
    callback_playing: (r) => ({ next: r, effects: [], signal: { type: "went_live" } }),
    callback_stopped: stoppedWhileActive,
    callback_crashed: crashedWhileActive,
    observed: observedFrom("playing"),
    stale_beat: (r, t) => toLost(r, t),
    deadline: (r, _t, now) => toStopping(r, "max_duration", now),
    session_stop: (r, t, now) => toStopping(r, stopReasonOf(t), now),
    grace_expired: null, destroy_ok: null, orphan_listed: null,
  },
  stopping: {
    create_started: null, create_ok: null, create_failed: null,
    callback_playing: (r) => stay(r),
    callback_stopped: (r) => ({ next: { ...r, state: "exited" }, effects: [], signal: null }),
    callback_crashed: (r) => stay(r),                              // R2003: our stop is ending it — record only, never counted
    observed: observedWhileStopping,
    stale_beat: (r) => stay(r), deadline: (r) => stay(r), session_stop: (r) => stay(r),
    grace_expired: (r) => forceDestroyed(r),
    destroy_ok: (r) => ({ next: { ...r, state: "destroyed" }, effects: [], signal: { type: "completed" } }),
    orphan_listed: null,
  },
  exited: {
    create_started: null, create_ok: null, create_failed: null, callback_playing: null,
    callback_stopped: (r) => stay(r), callback_crashed: (r) => stay(r),
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
    // The teardown is already out. The heartbeat route never hands a crash beat to a lost runner; a stray one records nothing.
    callback_stopped: (r) => stay(r), callback_crashed: (r) => stay(r),
    // R2003b: a crash exit read here is still this attempt's crash (Fly restarts the Machine our DELETE has not reached yet):
    // counted, and the observation that CROSSES the cap fails the session — once; the teardown is already issued.
    observed: (r, t) => {
      const c = withCrashExit(withExit(r, t), t);
      if (t.type === "observed" && t.state === "destroyed") return afterLostDestroyed(c);
      return crashCapped(c) && !crashCapped(r) ? { next: c, effects: [], signal: { type: "failed", reason: "machine_crash" } } : stay(c);
    },
    // C1: the teardown this state's entry issued has not been seen to land. Re-issue it — NEVER a retry signal, which
    // waits for destroyed (invariant 1). The once-per-STALE_HEARTBEAT_SECONDS bound is the session's: `decide`'s
    // stale_beat arm restarts the beat window (the session's beatWindowAt), since no beat arrives from a lost runner.
    stale_beat: (r) => reissueDestroy(r),
    // F17 — a deadline or a stop here ENDS the session (completed: no retry can follow on a session that stopped wanting live).
    deadline: (r) => lostTornDown(r, "max_duration"), session_stop: (r, t) => lostTornDown(r, stopReasonOf(t)),
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
    callback_playing: null, callback_stopped: null, callback_crashed: null,
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
