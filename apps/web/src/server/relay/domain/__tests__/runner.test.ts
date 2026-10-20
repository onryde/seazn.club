// The Fly machine lifecycle as a pure sub-machine (plan §"Fly machine
// lifecycle" — the table is the authority). Four parts: (a) a PARITY SWEEP
// over every RUNNER_STATES × RUNNER_TRIGGER_TYPES cell, read from the
// exported table; (b) the stale_beat COLUMN (Task 2C carry C1), walked from
// RUNNER_STATES against a per-state ruling; (c) the named invariants; (d) the
// specific edges the mutants target. Killers: allow a retry while not destroyed
// → "invariant 1"; skip SIGINT and destroy directly → "the stop sequence"; treat
// unknown as running → "unknown Fly state"; drop the grace force-destroy, or its
// `completed` signal (F-A) → "grace_expired"; drop persist-before-create → "invariant 4"; the retry cap
// `<` → `<=` → "lost → destroyed …", "create_failed …" and "the stale_beat
// column … destroyed" (C2); any stale_beat cell set back to null → "the
// stale_beat column" (C1).
import { describe, expect, it } from "vitest";
import { RelayHeartbeat } from "@/server/api-v1/schemas";
import {
  MAX_DURATION_MINUTES, RELAY_EXIT_REFUSED, RELAY_EXIT_RESTART, RELAY_HEARTBEAT_INTERVAL_MS, RUNNER_INPLACE_RESTARTS, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS,
  RUNNER_CRASH_CAP, RUNNER_RESTART_CAP, RUNNER_RESTART_STUCK_SECONDS,
  RUNNER_STOP_GRACE_SECONDS, RUNNER_STOP_SIGNAL, STALE_HEARTBEAT_SECONDS, STALE_HEARTBEAT_SECONDS_COMPOSED, WARMING_TIMEOUT_MINUTES,
} from "../../config";
import { evaluate } from "../expiry";
import {
  BEAT_EXIT_REASONS, CRASHES_NONE, InvalidRunnerTransition, MACHINE_MINUTES_BOUND, OBSERVED_STATES, RUNNER_NONE, RUNNER_STATES, RUNNER_TABLE,
  RUNNER_TRIGGER_TYPES, failReasonFromExit, machineNameFor, restartsInPlaceAfter, stepRunner, stoppedBeatTrigger,
  type BeatExitReason, type CrashTally, type ExitInfo, type Runner, type RunnerEffect, type RunnerState, type RunnerTrigger, type SessionSignal,
} from "../runner";
import { InvalidTransition, decide, isTerminal, type Command, type Session } from "../session";

const T0 = new Date("2026-09-14T10:00:00Z");
const R = (over: Partial<Runner> = {}): Runner => ({ ...RUNNER_NONE, ...over });
const inState = (state: RunnerState): Runner =>
  R({ state, attempt: state === "none" ? 0 : 1, name: state === "none" ? null : "relay-s1-r1", machineId: ["none", "creating"].includes(state) ? null : "m1",
      stopRequestedAt: ["stopping", "exited"].includes(state) ? T0 : null });

/** One representative trigger per type — the sweep varies the TYPE; the edges below vary the payloads.
 *  `create_started` is the one payload that depends on the state (the next attempt), so it is derived. */
const sampleFor = (s: RunnerState, t: RunnerTrigger["type"]): RunnerTrigger =>
  t === "create_started" ? { type: "create_started", name: `relay-s1-r${inState(s).attempt + 1}`, attempt: inState(s).attempt + 1 } : SAMPLE[t];
const SAMPLE: Record<Exclude<RunnerTrigger["type"], "create_started">, RunnerTrigger> = {
  create_ok: { type: "create_ok", machineId: "m1" },
  create_failed: { type: "create_failed", retryable: false, outcomeUnknown: false },
  callback_playing: { type: "callback_playing" },
  callback_stopped: { type: "callback_stopped" },
  callback_crashed: { type: "callback_crashed" },
  callback_restarted: { type: "callback_restarted" },
  observed: { type: "observed", state: "running" },
  stale_beat: { type: "stale_beat" },
  deadline: { type: "deadline" },
  session_stop: { type: "session_stop" },
  grace_expired: { type: "grace_expired" },
  destroy_ok: { type: "destroy_ok" },
  orphan_listed: { type: "orphan_listed" },
};
/** EVERY trigger the table can be fed from a runner: each observed state, ALL THREE create_failed flavours (review I2 —
 *  the third is the one the client cannot settle, and it is the one the walks below exist to catch), the derived
 *  create_started. The derived invariants walk this, never the one-sample-per-type sweep above. */
/** R2003: the compositor's refusal exit as Fly reports it — the one exit a cell branches on (`afterLostDestroyed`). */
const REFUSED_EXIT: ExitInfo = { exitCode: RELAY_EXIT_REFUSED, oomKilled: false, requestedStop: false };
/** A plain crash (F-007's probes exit 1). */
const CRASH_EXIT: ExitInfo = { exitCode: 1, oomKilled: false, requestedStop: false };
/** Owed 66: the compositor's in-place restart exit (C11b: `ExitReason::Restart`, EX_TEMPFAIL) — a non-zero exit Fly restarts
 *  like any failure, and the one exit that is NOT a crash. */
const RESTART_EXIT: ExitInfo = { exitCode: RELAY_EXIT_RESTART, oomKilled: false, requestedStop: false };
const triggersFor = (r: Runner): RunnerTrigger[] => RUNNER_TRIGGER_TYPES.flatMap((t): RunnerTrigger[] =>
  t === "observed" ? [
      ...OBSERVED_STATES.map((state) => ({ type: "observed" as const, state })),
      // R2003: an observed exit 78 — the refusal that must never earn the retry — on each state that carries an exit
      ...(["stopped", "failed", "destroyed"] as const).map((state) => ({ type: "observed" as const, state, exit: REFUSED_EXIT })),
      // F-007: Fly restarting the Machine in place — fresh (inside RUNNER_RESTART_STUCK_SECONDS) and stuck (past it).
      // `exit: null` on purpose: no cell branches on a crash exit's code, and a crash exit OVERWRITING a refused one is
      // a new walk node per edge — the longest-path walk went 4 s → 39 s on it. The refused-and-restarting case is
      // pinned by the F-007 describe below (refusal is read before the flag).
      ...(["stopped", "failed", "pending", "destroyed"] as const).flatMap((state) => [
        { type: "observed" as const, state, exit: null, restarting: true, restartingSince: T0 },
        { type: "observed" as const, state, exit: null, restarting: true, restartingSince: new Date(T0.getTime() - 3_600_000) },
      ]),
      // F-007 race: down, but the provider has not recorded that exit yet (`restarting: null`) — no claim
      ...(["stopped", "failed"] as const).map((state) => ({ type: "observed" as const, state, exit: null, restarting: null, restartingSince: null })),
      // R2003b: a crash exit WITH its identity (the provider's exit instant) and the provider's restart count — the one
      // observation that moves the crash tally. ONE fixed instant on purpose: a second read of it is the same crash, so the
      // walks see the dedupe; distinct crashes and the cap through exits are the R2003b sweep's (it mints fresh instants).
      { type: "observed" as const, state: "pending", exit: CRASH_EXIT, restarting: true, restartingSince: T0, exitAt: T0, restartCount: 1 },
      // Owed 66: the in-place restart's exit (75) — the one observation that sets `restartSeen` and counts no crash.
      { type: "observed" as const, state: "pending", exit: RESTART_EXIT, restarting: true, restartingSince: T0, exitAt: T0, restartCount: 1, exitRestarted: true },
    ]
  // R2003: both flavours of a stopped beat — a plain one, and the final beat that said its run was refused
  : t === "callback_stopped" ? [{ type: "callback_stopped" }, { type: "callback_stopped", refused: true },
      // I2 (PR #967 review): the beat that ENDS the session, with each reason it can carry
      { type: "callback_stopped", endReason: "stopped" }, { type: "callback_stopped", endReason: "max_duration" }]
  : t === "create_failed" ? [
      { type: "create_failed", retryable: true, outcomeUnknown: false },
      { type: "create_failed", retryable: false, outcomeUnknown: false },
      { type: "create_failed", retryable: false, outcomeUnknown: true },
    ]
  : t === "create_started" ? [{ type: "create_started", name: machineNameFor("s1", r.attempt + 1), attempt: r.attempt + 1 }]
  : [SAMPLE[t]]);
/** A walk's NODE: every payload field a cell BRANCHES on — the state, the attempt (retryLeft, createStarted) and whether a
 *  stop is marked (creating's create_ok / create_failed / observed). A future cell that branches on another field adds it
 *  here, or every walk that dedupes on this key silently under-walks. */
const nodeKey = (r: Runner): string =>
  `${r.state}:${r.attempt}:${r.stopRequestedAt !== null ? "marked" : "unmarked"}${r.lastExit?.exitCode === RELAY_EXIT_REFUSED ? ":refused-exit" : ""}` +   // R2003: afterLostDestroyed branches on it
  // R2003b: the cap reads the session's count, and the next count depends on this attempt's two bounds and on whether an
  // exit identity is held (the one fixed exit instant triggersFor carries is fresh only while none is).
  // Owed 66: and the restart-count floor branches on whether this attempt has read an in-place restart's exit.
  `:crashes ${r.crashes.count}/${r.crashes.beats}/${r.crashes.exits}${r.crashes.exitAt ? "@" : ""}${r.crashes.restartSeen ? ":restart-seen" : ""}` +
  // Owed 67: the restart tally enters the key as a CLASS (none / some / over the allowance), never as its count, bounds and exit
  // identity. The restart cap only ever turns what would be a retry into the session's end (never a retry out of nothing), so a node
  // with fewer restarts reaches every retry path a fuller one does — the walks below stay sound for "a retry follows a confirmed
  // destroy" — while the exact key (count 0..7 × beats × exits × identity) multiplied this walk's states ~20x (measured side by
  // side under the same load: 0.5s -> 10-18s, against a 30s test budget). The count itself is owned by the Owed 67 tests and `restart_cap_sweep`.
  `:restarts ${r.crashes.restarts.count > RUNNER_RESTART_CAP ? "over" : r.crashes.restarts.count > 0 ? "some" : "none"}`;
const confirmedDestroy = (t: RunnerTrigger): boolean => t.type === "destroy_ok" || (t.type === "observed" && t.state === "destroyed");

describe("RUNNER_TABLE — the parity sweep (every cell, from the exported tables)", () => {
  it("has a cell for every (state × trigger) and nothing else", () => {
    expect(Object.keys(RUNNER_TABLE).sort()).toEqual([...RUNNER_STATES].sort());
    for (const s of RUNNER_STATES) expect(Object.keys(RUNNER_TABLE[s]).sort(), s).toEqual([...RUNNER_TRIGGER_TYPES].sort());
  });
  for (const s of RUNNER_STATES) for (const t of RUNNER_TRIGGER_TYPES) {
    it(`${s} × ${t}: ${RUNNER_TABLE[s][t] === null ? "InvalidRunnerTransition" : "a legal step to a listed state"}`, () => {
      const cell = RUNNER_TABLE[s][t];
      if (cell === null) {
        expect(() => stepRunner(inState(s), sampleFor(s, t), T0)).toThrow(InvalidRunnerTransition);
      } else {
        const step = stepRunner(inState(s), sampleFor(s, t), T0);
        expect(RUNNER_STATES).toContain(step.next.state);
        expect(step.next.attempt).toBeGreaterThanOrEqual(inState(s).attempt);
        for (const e of step.effects) expect(["persist_intent", "create_machine", "stop_machine", "force_destroy"]).toContain(e.type);
      }
    });
  }
  it("at least one cell is legal and at least one is invalid per row (the sweep is not vacuous)", () => {
    for (const s of RUNNER_STATES) {
      const cells = Object.values(RUNNER_TABLE[s]);
      expect(cells.some((c) => c !== null), `${s} has a legal cell`).toBe(true);
      expect(cells.some((c) => c === null), `${s} has an invalid cell`).toBe(true);
    }
  });
});

// Task 2C carry C1 (orchestrator ruling on the Task 2B re-review). `evaluate` returns `stale_beat` for a live composed
// session whose runner is playing/booting, or ANY unmarked runner while the session still wants to be live — so every
// runner state can be handed `stale_beat` by a lazy read, and a null cell would 500 every read of that session forever.
// The per-state RULING is typed here as the oracle; the walk is over RUNNER_STATES, so a new state reds on the key check.
describe("the stale_beat column (C1 — every runner state answers it; a lazy read never throws)", () => {
  type Outcome = { next: RunnerState; effects: RunnerEffect["type"][]; signal: SessionSignal | null };
  const STALE_BEAT: Record<RunnerState, Outcome> = {
    none: { next: "none", effects: [], signal: { type: "failed", reason: "machine_crash" } },   // a corrupt row (live, composed, no runner): fail it
    creating: { next: "lost", effects: ["force_destroy"], signal: null },                      // a hung create may still make a Machine: tear down by name, no retry yet (invariant 1)
    booting: { next: "lost", effects: ["force_destroy"], signal: null },
    playing: { next: "lost", effects: ["force_destroy"], signal: null },
    stopping: { next: "stopping", effects: [], signal: null },                                 // our own stop: the grace/observe timers own it
    exited: { next: "exited", effects: [], signal: null },
    destroyed: { next: "destroyed", effects: [], signal: { type: "retry" } },                  // awaiting its ONE retry (attempt 1 < the cap)
    lost: { next: "lost", effects: ["force_destroy"], signal: null },                          // re-issue the teardown, NEVER a retry signal
  };
  it("every state has a non-null stale_beat cell, and each lands exactly where the ruling says", () => {
    expect(Object.keys(STALE_BEAT).sort()).toEqual([...RUNNER_STATES].sort());
    for (const s of RUNNER_STATES) {
      expect(RUNNER_TABLE[s].stale_beat, s).not.toBeNull();
      const step = stepRunner(inState(s), { type: "stale_beat" }, T0);
      expect({ next: step.next.state, effects: step.effects.map((e) => e.type), signal: step.signal }, s).toEqual(STALE_BEAT[s]);
      expect(step.next.attempt, `${s} never moves the attempt`).toBe(inState(s).attempt);
    }
  });
  it("destroyed: the retry is capped on ATTEMPT — at RUNNER_MAX_ATTEMPTS it fails with the reason the exit shows, never a third create (C2)", () => {
    const spent = R({ state: "destroyed", attempt: RUNNER_MAX_ATTEMPTS, name: "relay-s1-r2", machineId: "m2" });
    expect(stepRunner(spent, { type: "stale_beat" }, T0).signal).toEqual({ type: "failed", reason: "machine_crash" });
    const oom = stepRunner({ ...spent, lastExit: { exitCode: 137, oomKilled: true, requestedStop: false } }, { type: "stale_beat" }, T0);
    expect(oom.signal).toEqual({ type: "failed", reason: "machine_oom" });
    expect(oom.next.state).toBe("destroyed");
    // the positive pair: one below the cap still retries
    expect(stepRunner({ ...spent, attempt: RUNNER_MAX_ATTEMPTS - 1 }, { type: "stale_beat" }, T0).signal).toEqual({ type: "retry" });
  });
  it("lost: a stale beat re-issues force_destroy and never retries, on either attempt — the retry waits for destroyed (invariant 1)", () => {
    for (const attempt of [1, RUNNER_MAX_ATTEMPTS]) {
      const lost = R({ state: "lost", attempt, name: machineNameFor("s1", attempt), machineId: "m1" });
      const step = stepRunner(lost, { type: "stale_beat" }, T0);
      expect(step, `attempt ${attempt}`).toEqual({ next: lost, effects: [{ type: "force_destroy" }], signal: null });
    }
  });
  it("creating: a stale create goes lost with the by-name teardown, keeping its attempt and name; the call returning afterwards destroys what it made and never throws", () => {
    const creating = R({ state: "creating", attempt: 2, name: "relay-s1-r2" });
    const lost = stepRunner(creating, { type: "stale_beat" }, T0);
    expect(lost.next).toEqual({ ...creating, state: "lost" });
    // A hung create that finally returns lands on `lost`: destroy the id it made, stay lost (destroy_ok then decides retry vs fail).
    const late = stepRunner(lost.next, { type: "create_ok", machineId: "m9" }, T0);
    expect(late).toEqual({ next: { ...lost.next, machineId: "m9" }, effects: [{ type: "force_destroy" }], signal: null });
    expect(stepRunner(lost.next, { type: "create_failed", retryable: true, outcomeUnknown: false }, T0)).toEqual({ next: lost.next, effects: [], signal: null });
  });
});

describe("the stop sequence (R0-memo.md:279 — SIGINT, never a keystroke)", () => {
  it("session_stop from playing → stopping with stop_machine { SIGINT, grace }; stopRequestedAt set; the session signal is ending(stopped)", () => {
    const step = stepRunner(inState("playing"), { type: "session_stop" }, T0);
    expect(step.next.state).toBe("stopping");
    expect(step.next.stopRequestedAt).toEqual(T0);
    expect(step.effects).toEqual([{ type: "stop_machine", signal: "SIGINT", timeoutSeconds: RUNNER_STOP_GRACE_SECONDS }]);
    expect(step.signal).toEqual({ type: "ending", endReason: "stopped" });
    expect(RUNNER_STOP_SIGNAL).toBe("SIGINT");   // the config line the effect reads (R0-memo.md:346–354: `q` is discarded under -nostdin)
  });
  it("deadline from playing → stopping with the SAME stop, signal ending(max_duration) — not a failure", () => {
    const step = stepRunner(inState("playing"), { type: "deadline" }, T0);
    expect(step.next.state).toBe("stopping");
    expect(step.effects[0]).toMatchObject({ type: "stop_machine", signal: "SIGINT" });
    expect(step.signal).toEqual({ type: "ending", endReason: "max_duration" });
  });
  it("stopping → exited on callback_stopped / observed stopped; → destroyed on observed destroyed (signal completed) and on destroy_ok", () => {
    expect(stepRunner(inState("stopping"), { type: "callback_stopped" }, T0).next.state).toBe("exited");
    expect(stepRunner(inState("stopping"), { type: "observed", state: "stopped" }, T0).next.state).toBe("exited");
    // a non-zero exit after OUR stop is still ours: exited (recorded), never lost (plan table, stopping × observed failed)
    const failedExit = stepRunner(inState("stopping"), { type: "observed", state: "failed", exit: { exitCode: 255, oomKilled: false, requestedStop: true } }, T0);
    expect(failedExit.next).toMatchObject({ state: "exited", lastExit: { exitCode: 255 } });
    expect(failedExit.signal).toBeNull();
    const done = stepRunner(inState("stopping"), { type: "observed", state: "destroyed" }, T0);
    expect(done.next.state).toBe("destroyed");
    expect(done.signal).toEqual({ type: "completed" });
    expect(stepRunner(inState("exited"), { type: "destroy_ok" }, T0).signal).toEqual({ type: "completed" });
  });
  // Task 2C-post, ruling F-A (a): the forced destroy after grace ENDS the session — it signals `completed` in the shape the
  // other stopping/exited completion cells use (no endReason: the session's own, stored when ending began, is the one kept).
  // Without the signal an organiser stop whose Machine never auto-destroys stayed `ending` until ENDING_TIMEOUT_SECONDS.
  it("grace_expired in stopping/exited → force_destroy → destroyed, signalling completed with no end reason of its own (mutants: drop the force, drop the signal, signal failed, carry an endReason → red)", () => {
    for (const s of ["stopping", "exited"] as const) {
      const step = stepRunner(inState(s), { type: "grace_expired" }, T0);
      expect(step, s).toEqual({ next: { ...inState(s), state: "destroyed" }, effects: [{ type: "force_destroy" }], signal: { type: "completed" } });
    }
  });
  it("stopping never re-sends the stop, and a stale beat while stopping is expected quiet", () => {
    expect(stepRunner(inState("stopping"), { type: "session_stop" }, T0).effects).toEqual([]);
    expect(stepRunner(inState("stopping"), { type: "stale_beat" }, T0).next.state).toBe("stopping");
  });
});

describe("the crash path", () => {
  it("playing/booting → lost on stale_beat, callback_stopped, observed stopped|failed|destroyed; effects force_destroy (a lost Machine is torn down, not trusted)", () => {
    for (const from of ["booting", "playing"] as const) {
      for (const t of [{ type: "callback_stopped" } as const, { type: "observed", state: "stopped" } as const, { type: "observed", state: "failed" } as const, { type: "observed", state: "destroyed" } as const]) {
        const step = stepRunner(inState(from), t, T0);
        expect(step.next.state, `${from} ${JSON.stringify(t)}`).toBe(t.type === "observed" && t.state === "destroyed" ? "destroyed" : "lost");
      }
    }
    const stale = stepRunner(inState("playing"), { type: "stale_beat" }, T0);
    expect(stale.next.state).toBe("lost");
    expect(stale.effects).toEqual([{ type: "force_destroy" }]);
    // The policy only emits stale_beat for a booting runner when the SESSION is live (a replacement that never plays); the table treats it as lost too.
    expect(stepRunner(inState("booting"), { type: "stale_beat" }, T0).next.state).toBe("lost");
  });
  it("lost → destroyed on destroy_ok / observed destroyed; the signal is retry on attempt 1 and failed(reason from the exit) on attempt 2", () => {
    const first = stepRunner(inState("lost"), { type: "destroy_ok" }, T0);
    expect(first.next.state).toBe("destroyed");
    expect(first.signal).toEqual({ type: "retry" });
    const second = stepRunner(R({ state: "lost", attempt: 2, name: "relay-s1-r2", machineId: "m2", lastExit: { exitCode: 137, oomKilled: true, requestedStop: false } }), { type: "observed", state: "destroyed" }, T0);
    expect(second.signal).toEqual({ type: "failed", reason: "machine_oom" });
  });
  // Fix round 3, ruling (a): `destroyed` means CONFIRMED gone. Our own teardown timing out, or the sweep finding the Machine,
  // re-issues the force_destroy and keeps the runner lost — a force_destroy is a request, not a confirmation.
  it("lost STAYS lost on grace_expired / orphan_listed / stale_beat, each re-issuing force_destroy with no signal; it leaves for destroyed only on a CONFIRMED destroy (the crash-path signal) or a session-ENDING teardown (F17's deadline / session_stop → completed)", () => {
    for (const type of ["grace_expired", "orphan_listed", "stale_beat"] as const) {
      expect(stepRunner(inState("lost"), { type }, T0), type).toEqual({ next: inState("lost"), effects: [{ type: "force_destroy" }], signal: null });
    }
    let left = 0;
    for (const t of triggersFor(inState("lost"))) {
      let step: ReturnType<typeof stepRunner>;
      try { step = stepRunner(inState("lost"), t, T0); } catch (e) { expect(e).toBeInstanceOf(InvalidRunnerTransition); continue; }
      if (step.next.state === "lost") continue;
      left++;
      expect(step.next.state, JSON.stringify(t)).toBe("destroyed");
      expect(confirmedDestroy(t) || step.signal?.type === "completed", JSON.stringify(t)).toBe(true);
    }
    expect(left).toBe(7);   // destroy_ok, observed destroyed (plain, with the refusal exit — R2003, and the two F-007 restarting flavours), deadline, session_stop — and nothing else
  });
  // Fix round 4 (orchestrator ruling on round 3's residual): a create_ok that returns AFTER the runner moved on is a Machine
  // whose destroy is not yet confirmed. Into `destroyed` it goes LOST (the returned id force-destroyed), so only destroy_ok /
  // observed destroyed can lead to the next retry. The MARKED creating cells (P1-F-a / F14 / F15 / C5) keep destroyed: their
  // `completed` signal lands on a session that is already ending or terminal, which can never retry — session.test.ts
  // "R4 … walked through decide" proves it from every marked-creating seed.
  it("a LATE create_ok: into destroyed → LOST with force_destroy on the returned id (no signal); into lost → stays lost; a MARKED creating runner's create_ok / found / grace keep destroyed + force_destroy + completed", () => {
    const late = { type: "create_ok", machineId: "m9" } as const;
    expect(stepRunner(inState("destroyed"), late, T0)).toEqual({ next: { ...inState("destroyed"), state: "lost", machineId: "m9" }, effects: [{ type: "force_destroy" }], signal: null });
    expect(stepRunner(inState("lost"), late, T0)).toEqual({ next: { ...inState("lost"), machineId: "m9" }, effects: [{ type: "force_destroy" }], signal: null });
    const marked = R({ state: "creating", attempt: 1, name: "relay-s1-r1", stopRequestedAt: T0 });
    expect(stepRunner(marked, late, T0)).toEqual({ next: { ...marked, state: "destroyed", machineId: "m9" }, effects: [{ type: "force_destroy" }], signal: { type: "completed" } });
    for (const t of [{ type: "observed", state: "running" } as const, { type: "observed", state: "pending" } as const, { type: "grace_expired" } as const]) {
      expect(stepRunner(marked, t, T0), JSON.stringify(t)).toEqual({ next: { ...marked, state: "destroyed" }, effects: [{ type: "force_destroy" }], signal: { type: "completed" } });
    }
  });
  it("failReasonFromExit: oom → machine_oom; non-zero → machine_exit_nonzero; zero/none → machine_crash; the exit info is kept on the runner when observed", () => {
    expect(failReasonFromExit({ exitCode: 1, oomKilled: true, requestedStop: false })).toBe("machine_oom");
    expect(failReasonFromExit({ exitCode: 1, oomKilled: false, requestedStop: false })).toBe("machine_exit_nonzero");
    expect(failReasonFromExit({ exitCode: 0, oomKilled: false, requestedStop: false })).toBe("machine_crash");
    expect(failReasonFromExit(null)).toBe("machine_crash");
    const seen = stepRunner(inState("playing"), { type: "observed", state: "failed", exit: { exitCode: 2, oomKilled: false, requestedStop: false } }, T0);
    expect(seen.next.lastExit).toEqual({ exitCode: 2, oomKilled: false, requestedStop: false });
  });
  it("unknown Fly state is never treated as running: booting stays booting, playing stays playing, stopping stays stopping (mutant: unknown → running → red)", () => {
    expect(stepRunner(inState("booting"), { type: "observed", state: "unknown" }, T0).next.state).toBe("booting");
    expect(stepRunner(inState("playing"), { type: "observed", state: "unknown" }, T0).next.state).toBe("playing");
    expect(stepRunner(inState("stopping"), { type: "observed", state: "unknown" }, T0).next.state).toBe("stopping");
    // …nor is it the crash-safe reconcile's "found by name": a creating runner observed unknown stays creating, never adopted into booting
    expect(stepRunner(inState("creating"), { type: "observed", state: "unknown" }, T0).next.state).toBe("creating");
    // and unknown never produces the went_live signal
    expect(stepRunner(inState("booting"), { type: "observed", state: "unknown" }, T0).signal).toBeNull();
    expect(stepRunner(inState("booting"), { type: "observed", state: "running" }, T0).signal).toBeNull(); // running ≠ playing: only the callback goes live
  });
  it("create_failed: retryable on attempt 1 → destroyed with signal retry; not retryable → failed(machine_create_failed)", () => {
    const retry = stepRunner(inState("creating"), { type: "create_failed", retryable: true, outcomeUnknown: false }, T0);
    expect(retry.next.state).toBe("destroyed");
    expect(retry.signal).toEqual({ type: "retry" });
    const fail = stepRunner(inState("creating"), { type: "create_failed", retryable: false, outcomeUnknown: false }, T0);
    expect(fail.signal).toEqual({ type: "failed", reason: "machine_create_failed" });
    const exhausted = stepRunner(R({ state: "creating", attempt: RUNNER_MAX_ATTEMPTS, name: "relay-s1-r2" }), { type: "create_failed", retryable: true, outcomeUnknown: false }, T0);
    expect(exhausted.signal).toEqual({ type: "failed", reason: "machine_create_failed" });
  });
  // Review I2 (money). The three flavours side by side, so the difference between them is the assertion and not a
  // reader's inference. The KNOWN rows are the two above; this is the one the client cannot settle.
  it("create_failed with the outcome UNKNOWN never lands on `destroyed` without a teardown: unmarked it goes LOST with force_destroy and NO retry signal; marked (the organiser stopped mid-create) it completes the session AND forces the destroy — the same answer grace_expired already gives", () => {
    // UNMARKED: a Machine may exist under our name. `destroyed` would mean confirmed gone, and the session would spend
    // its ONE retry (or fail) beside a compositor still pushing to the organiser's destination until RELAY_DEADLINE_AT.
    const unknown: RunnerTrigger = { type: "create_failed", retryable: false, outcomeUnknown: true };
    const unmarked = stepRunner(inState("creating"), unknown, T0);
    expect(unmarked).toEqual({ next: { ...inState("creating"), state: "lost" }, effects: [{ type: "force_destroy" }], signal: null });
    // …and the retry is still owed, but only once the destroy is CONFIRMED (invariant 1).
    expect(stepRunner(unmarked.next, { type: "destroy_ok" }, T0)).toMatchObject({ next: { state: "destroyed" }, signal: { type: "retry" } });
    // MARKED: the organiser's stop ended this session, so it completes — but the teardown is owed all the same.
    const marked = R({ state: "creating", attempt: 1, name: "relay-s1-r1", stopRequestedAt: T0 });
    const markedStep = stepRunner(marked, unknown, T0);
    expect(markedStep).toEqual({ next: { ...marked, state: "destroyed" }, effects: [{ type: "force_destroy" }], signal: { type: "completed" } });
    // The named contrast: the SAME marked runner whose create failure IS settled emits no teardown (nothing was made).
    expect(stepRunner(marked, { type: "create_failed", retryable: false, outcomeUnknown: false }, T0).effects).toEqual([]);
    // and the neighbour this borrows its shape from, unchanged.
    expect(stepRunner(marked, { type: "grace_expired" }, T0)).toEqual(markedStep);
  });
});

describe("invariants", () => {
  it("invariant 1: a retry is refused while the previous Machine is not destroyed (create_started is legal ONLY from none and destroyed)", () => {
    for (const s of RUNNER_STATES) {
      const legal = s === "none" || s === "destroyed";
      // The NEXT attempt for that state — 1 from none, 2 from destroyed: attempt counts create calls made (C3).
      const t = sampleFor(s, "create_started");
      if (legal) expect(stepRunner(inState(s), t, T0).next, s).toMatchObject({ state: "creating", attempt: (t as { attempt: number }).attempt });
      else expect(() => stepRunner(inState(s), t, T0), s).toThrow(InvalidRunnerTransition);
    }
    // The attempt is the persisted count + 1, never a guess: skipping one is refused (C3).
    expect(() => stepRunner(inState("none"), { type: "create_started", name: "relay-s1-r2", attempt: 2 }, T0)).toThrow(InvalidRunnerTransition);
    // and a retry past RUNNER_MAX_ATTEMPTS is refused even from destroyed
    expect(() => stepRunner(R({ state: "destroyed", attempt: RUNNER_MAX_ATTEMPTS }), { type: "create_started", name: "relay-s1-r3", attempt: 3 }, T0)).toThrow(InvalidRunnerTransition);
  });
  // Review I2 (fix round 1): the plan's invariant 1 has a second half — `lost` must pass through destroy_ok / observed
  // destroyed before the retry — and the test above only checks where create_started is legal. A cell that took a crashed
  // Machine observed `stopped` (or `suspended`, which Task 5 maps to stopped) as GONE would retry while attempt 1 still
  // exists: two Machines pushing to one destination key. The parity sweep's oracle accepts any listed destination, so this
  // is DERIVED from RUNNER_TABLE over every state, every payload a cell branches on, and every trigger.
  // Re-review N1 (fix round 2): the retry rule once applied to `lost` alone, so a cell that force-destroys AND retries in one
  // step from any OTHER live state (creating × observed failed: Fly just said the Machine exists) passed — force_destroy is a
  // request, not a confirmation. Every non-destroyed source now needs the confirmed destroy, or a create that made nothing.
  it("invariant 1, the LOST half (derived): a runner reaches destroyed only on a CONFIRMED destroy, a create that made nothing, or a step that itself issues force_destroy; a retry signal lands only on destroyed — and out of EVERY non-destroyed state only on a confirmed destroy or a create that made nothing", () => {
    const runners: Runner[] = RUNNER_STATES.flatMap((state): Runner[] => (state === "none" ? [RUNNER_NONE]
      : [1, RUNNER_MAX_ATTEMPTS].flatMap((attempt) => [null, T0].map((stopRequestedAt): Runner =>
          ({ ...inState(state), attempt, name: machineNameFor("s1", attempt), stopRequestedAt })))));
    const confirmed = confirmedDestroy;
    let entries = 0;
    const retriesFrom = new Map<RunnerState, number>();
    for (const r of runners) {
      for (const t of triggersFor(r)) {
        let step: ReturnType<typeof stepRunner>;
        try { step = stepRunner(r, t, T0); } catch (e) { expect(e).toBeInstanceOf(InvalidRunnerTransition); continue; }
        const label = `${r.state} (attempt ${r.attempt}, ${r.stopRequestedAt ? "marked" : "unmarked"}) × ${JSON.stringify(t)}`;
        // Review I2: "the create made nothing" is exactly "its outcome is KNOWN". The predicate used to be
        // unconditional on the payload, which let `creating × create_failed` enter `destroyed` — the state whose
        // meaning is CONFIRMED gone — with no teardown, for a create whose absence nobody had established.
        const madeNothing = t.type === "create_failed" && r.state === "creating" && !t.outcomeUnknown;
        if (r.state !== "destroyed" && step.next.state === "destroyed") {
          entries++;
          expect(confirmed(t) || madeNothing || step.effects.some((e) => e.type === "force_destroy"), label).toBe(true);
        }
        if (step.signal?.type === "retry") {
          retriesFrom.set(r.state, (retriesFrom.get(r.state) ?? 0) + 1);
          expect(step.next.state, label).toBe("destroyed");
          // `destroyed` itself re-signals (C1: the retry_runner that never ran). This ONE-step rule cannot see how that row
          // entered destroyed — the entry rule above admits a force-only entry — so the TWO-STEP walk below owns that.
          if (r.state !== "destroyed") expect(confirmed(t) || madeNothing, label).toBe(true);
        }
      }
    }
    // not vacuous: destroyed IS entered, and retries ARE signalled out of every state the plan retries from
    expect(entries).toBeGreaterThan(0);
    expect([...retriesFrom.keys()].sort()).toEqual(["booting", "creating", "destroyed", "lost", "playing"]);
    // the reviewer's scenario, named: a lost runner observed stopped or failed is NOT gone — it stays lost, no signal
    for (const state of ["stopped", "failed"] as const) {
      expect(stepRunner(inState("lost"), { type: "observed", state }, T0), state).toMatchObject({ next: { state: "lost" }, signal: null });
    }
  });
  // Fix round 3 (orchestrator ruling (c), on the defect round 2 measured): the one-step rules above cannot see a retry spread
  // over TWO steps — `lost × orphan_listed` / `grace_expired` issued a force_destroy and moved to destroyed with nothing
  // confirmed, then `destroyed × stale_beat` re-signalled the retry: attempt 2 created while attempt 1 may still be up.
  // This walks EVERY path the table allows from RUNNER_NONE (two steps and deeper), carrying whether the CURRENT attempt's
  // Machine has been confirmed gone (destroy_ok / observed destroyed) or was never made (creating × create_failed);
  // create_started (a new attempt) and create_ok (a Machine that now exists, fix round 4) reset it. A path ENDS at a step
  // whose signal ends the session's wish to be live — ending / completed / failed. In `decide`, `ending` and `completed`
  // move a provisioning / warming / live session to ending or completed (provisioning's `completed` since fix round 5, G1),
  // `failed` fails it, the retry and failed arms complete a session that is already ending instead (F17; fix round 5, I1),
  // and C27 ignores every signal on a terminal one (session.test.ts F17, F20, C27, I1, G1 prove these). Only `requested`
  // ignores `ending` / `completed`, and no planned caller creates before `provision`.
  it("invariant 1, the TWO-STEP half (walked from none): every path that reaches a retry signal passes a confirmed destroy, or a create that made nothing, since its attempt began", () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    const reached = new Set<RunnerState>();
    let retriesReached = 0, pathsEnded = 0;
    const walk = (r: Runner, cleared: boolean, path: readonly string[]): void => {
      const key = `${nodeKey(r)}:${cleared ? "cleared" : "uncleared"}`;
      if (seen.has(key)) return;
      seen.add(key);
      reached.add(r.state);
      for (const t of triggersFor(r)) {
        let step: ReturnType<typeof stepRunner>;
        try { step = stepRunner(r, t, T0); } catch (e) { expect(e).toBeInstanceOf(InvalidRunnerTransition); continue; }
        const here = [...path, `${r.state} × ${t.type === "observed" ? `observed ${t.state}` : t.type}`];
        const madeNothing = r.state === "creating" && t.type === "create_failed" && !t.outcomeUnknown;   // review I2, as above
        // Fix round 4: a create_ok is a Machine that now EXISTS — a late one included — so it clears the confirmation just
        // like a new attempt does. Without this reset a late create_ok into an already-confirmed destroyed runner walked on
        // as `cleared`, and the stale beat after it re-signalled the retry while that Machine's destroy was unconfirmed.
        const nowCleared = t.type === "create_started" || t.type === "create_ok" ? false : cleared || confirmedDestroy(t) || madeNothing;
        const signal = step.signal?.type;
        if (signal === "retry") { retriesReached++; if (!nowCleared) violations.push(here.join(" → ")); }
        if (signal === "ending" || signal === "completed" || signal === "failed") { pathsEnded++; continue; }
        walk(step.next, nowCleared, here);
      }
    };
    walk(RUNNER_NONE, false, []);
    expect(violations, `retry with no confirmed destroy: ${violations.join(" ;; ")}`).toEqual([]);
    // not vacuous: retries ARE reached, paths DO end, and the walk covers every state a still-live session's runner can hold
    // (stopping / exited exist only past an `ending` signal, so no still-live path enters them)
    expect(retriesReached).toBeGreaterThan(0);
    expect(pathsEnded).toBeGreaterThan(0);
    expect([...reached].sort()).toEqual(["booting", "creating", "destroyed", "lost", "none", "playing"]);
  });
  it("invariant 3: MACHINE_MINUTES_BOUND covers the longest timed path the table itself can walk (walked, never re-derived — C12)", () => {
    // The minutes the walk CREDITS a Machine in each state — the timer that forces it out of that state:
    //   booting  — the warming timeout (a replacement booting in a LIVE session is cut shorter, by the stale beat);
    //   playing  — the deadline, credited IN FULL on every attempt, although both attempts share ONE wall clock
    //              measured from startedAt: an over-credit of up to MAX_DURATION_MINUTES on the second attempt;
    //   stopping — grace + observation slack (evaluate's grace_expired);
    //   exited   — 0: it shares stopping's window (stopRequestedAt is not reset on the way in).
    // NOT credited (0), each a window of minutes against that over-credit:
    //   creating — the provision timeout while the session provisions, the stale beat as a live replacement (C1), and
    //              the grace once a stop is MARKED (a marked creating runner is its own node below, also credited 0);
    //   lost     — its entry issues force_destroy, and a stale beat re-issues it once per STALE_HEARTBEAT_SECONDS until
    //              destroy_ok / observed destroyed moves it on (C1) — no table timer forces it out;
    //   none, destroyed — no Machine of ours (a create returning into destroyed moves the runner to lost with force_destroy,
    //              fix round 4 — lost is credited 0 above, so that re-entry adds no dwell).
    const DWELL: Record<RunnerState, number> = {
      none: 0, creating: 0, booting: WARMING_TIMEOUT_MINUTES, playing: MAX_DURATION_MINUTES,
      stopping: (RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS) / 60, exited: 0, lost: 0, destroyed: 0,
    };
    // Longest simple path over NODES (`nodeKey`); a stay never re-enters a node already on the path.
    // Successors are walked once per NODE, not once per trigger: `lost → destroyed` alone was six triggers, and walking
    // each parallel edge re-walked the whole second attempt beneath it (18 s, and a timeout under load). Deduping is sound
    // only if every trigger reaching a node leaves a Runner the rest of the walk cannot tell apart — which is what
    // `nodeKey` carries. The dwell itself is a function of the state alone, and it is credited on ENTERING a state: a step
    // that stays in its state (R2003b: a counted crash keeps a playing runner playing) moves no timer — the deadline and the
    // warming timeout run on, unreset — so crediting the dwell again would invent minutes no Machine can bill.
    // R2003b: the crash evidence (a fatal beat, an exit carrying its identity) is left out of THIS walk, and that is sound:
    // a counted crash below the cap is a stay (no dwell, above), and the one that reaches it ends the path early (failed,
    // then create_started refused) — so every path through crash evidence has a crash-free twin at least as long. Walking
    // it anyway multiplied the simple paths by the tally's values (> 10 min); the crash walks are the R2003b describe's.
    // Owed 67: the restart evidence (a `restart` beat, an exit 75 — it carries its identity too) is left out of this walk for the
    // same reason: a counted restart below its cap is a stay (no dwell), and the one that exceeds it ends the path early (failed,
    // then create_started refused), so every path through restart evidence has a restart-free twin at least as long.
    const timed = (t: RunnerTrigger): boolean => t.type !== "callback_crashed" && t.type !== "callback_restarted" && !(t.type === "observed" && t.exitAt !== undefined);
    const longestFrom = (r: Runner, onPath: ReadonlySet<string>): number => {
      const successors = new Map<string, Runner>();
      for (const t of triggersFor(r).filter(timed)) {
        let next: Runner;
        try { next = stepRunner(r, t, T0).next; } catch (e) { expect(e).toBeInstanceOf(InvalidRunnerTransition); continue; }
        const key = nodeKey(next);
        if (!onPath.has(key) && !successors.has(key)) successors.set(key, next);
      }
      let best = 0;
      for (const [key, next] of successors) best = Math.max(best, (next.state !== r.state ? DWELL[next.state] : 0) + longestFrom(next, new Set([...onPath, key])));
      return best;
    };
    const longest = longestFrom(RUNNER_NONE, new Set([nodeKey(RUNNER_NONE)]));
    expect(longest).toBeGreaterThan(MAX_DURATION_MINUTES);            // not vacuous: the walk reaches playing
    expect(MACHINE_MINUTES_BOUND).toBeGreaterThanOrEqual(longest);
    expect(RUNNER_MAX_ATTEMPTS).toBe(2); // ONE retry (design §6.4) — a third attempt would need this line and the table's `destroyed` row to change together
  });
  it("invariant 4: create_started persists the intent BEFORE creating (effect order), with the name and attempt on the runner (mutant: drop persist_intent or reorder → red)", () => {
    const step = stepRunner(inState("none"), { type: "create_started", name: machineNameFor("s1", 1), attempt: 1 }, T0);
    expect(step.effects.map((e) => e.type)).toEqual(["persist_intent", "create_machine"]);
    expect(step.next).toMatchObject({ state: "creating", attempt: 1, name: "relay-s1-r1", machineId: null });
    // the HAPPY path (review I3): an UNMARKED create returning its id boots THAT Machine — no effect, no signal. Every other
    // create_ok row in the suites is marked or lands on lost/destroyed, so without this a create_ok that stayed `creating`
    // would strand every composed session until provision_timeout, all green.
    expect(stepRunner(step.next, { type: "create_ok", machineId: "m1" }, T0)).toEqual({ next: { ...step.next, state: "booting", machineId: "m1" }, effects: [], signal: null });
    // crash-safe reconcile: a creating runner observed pending OR running (found by name) becomes booting without a second
    // create — both operands of `found`, each exactly
    for (const state of ["pending", "running"] as const) {
      expect(stepRunner(step.next, { type: "observed", state }, T0), state).toEqual({ next: { ...step.next, state: "booting" }, effects: [], signal: null });
    }
  });
  it("machineNameFor carries the attempt so a destroyed name is never reused", () => {
    expect(machineNameFor("s1", 1)).toBe("relay-s1-r1");
    expect(machineNameFor("s1", 2)).toBe("relay-s1-r2");
    expect(machineNameFor("s1", 1)).not.toBe(machineNameFor("s1", 2));
  });
  it("orphan_listed is legal only for lost/destroyed (the sweep never tears down a runner the session still owns through the table); on lost it re-issues force_destroy and STAYS lost (round 3: destroyed means confirmed gone)", () => {
    expect(stepRunner(inState("lost"), { type: "orphan_listed" }, T0)).toEqual({ next: inState("lost"), effects: [{ type: "force_destroy" }], signal: null });
    expect(stepRunner(inState("destroyed"), { type: "orphan_listed" }, T0).effects).toEqual([]);
    for (const s of ["creating", "booting", "playing", "stopping", "exited"] as const) {
      expect(() => stepRunner(inState(s), { type: "orphan_listed" }, T0), s).toThrow(InvalidRunnerTransition);
    }
  });
  it("OBSERVED_STATES is the whole vocabulary Task 5's fromFlyState may emit", () => {
    expect([...OBSERVED_STATES].sort()).toEqual(["destroyed", "destroying", "failed", "pending", "running", "stopped", "stopping", "unknown"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// R2003 — Fly restarts a crashed compositor IN PLACE (`on-failure`, ≤ RUNNER_INPLACE_RESTARTS), seen from web; the
// composed stale rule (STALE_HEARTBEAT_SECONDS_COMPOSED for a runner that has played, the STALE_HEARTBEAT_SECONDS boot
// allowance for one that has not — owner ruling 2026-10-15, option A); the final beat's exit reason; exit 78.
// Driven through `decide` with the REAL `evaluate`, never a hand-built expiry. The sim does what the usecase does after
// commit (stream-sessions.ts): a `retry_runner` effect becomes create_started at attempt + 1 (`retryRunner`), a
// `create_machine` effect becomes the provider's create_ok, and a beat writes heartbeat_at BEFORE its expiry tick and
// its callbacks (`heartbeat`). destroy_ok is never automatic: a test feeds it where the DELETE is confirmed.
// ONE SPORT is moot: the relay never reads the sport (relay-internal-routes.test.ts header).
// ---------------------------------------------------------------------------------------------------------------------
const SID = "s1";
const BEAT_S = RELAY_HEARTBEAT_INTERVAL_MS / 1000;
const sec = (n: number) => new Date(T0.getTime() + n * 1000);
const liveComposed = (over: Partial<Session> = {}): Session => ({
  id: SID, fixtureId: "f1", orgId: "o1", mode: "composed", state: "live", desiredState: "live",
  failReason: null, endReason: null, runner: inState("playing"), runnerRetries: 0, createdAt: T0, startedAt: T0, endedAt: null,
  heartbeatAt: T0, beatWindowAt: null, endingAt: null, maxDurationMinutes: MAX_DURATION_MINUTES, outputUid: null,
  startCause: "organiser", warmingAt: null, ...over,
});
interface Sim { s: Session; creates: { attempt: number; at: number }[]; effects: string[]; stale: number[] }
const sim = (s: Session = liveComposed()): Sim => ({ s, creates: [], effects: [], stale: [] });
function feed(w: Sim, c: Command, at: number): void {
  const d = decide(w.s, c, sec(at));
  w.s = d.next;
  for (const e of d.effects) {
    w.effects.push(e.type === "runner" ? e.effect.type : e.type);
    if (e.type === "runner" && e.effect.type === "create_machine") {
      w.creates.push({ attempt: w.s.runner.attempt, at });
      feed(w, { type: "runner", trigger: { type: "create_ok", machineId: `m${w.s.runner.attempt}` } }, at);
    }
    if (e.type === "retry_runner") {
      const attempt = w.s.runner.attempt + 1;
      feed(w, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, attempt), attempt } }, at);
    }
  }
}
/** The lazy expiry every read runs (applyExpiry): the REAL evaluate, its answer fed to decide. */
function tick(w: Sim, at: number): string {
  const x = evaluate(w.s, sec(at));
  if (x.kind === "stale_beat") w.stale.push(at);
  if (x.kind !== "none") feed(w, { type: "expire", expiry: x }, at);
  return x.kind;
}
const ACTIVE_RUNNER = (r: RunnerState) => r === "booting" || r === "playing";
/** A beat through the route's order: heartbeat_at first, then the expiry tick, then callback_playing for a playing beat. */
function beat(w: Sim, at: number, state: "starting" | "playing" = "playing"): void {
  w.s = { ...w.s, heartbeatAt: sec(at) };
  tick(w, at);
  if (state === "playing" && !isTerminal(w.s.state) && ACTIVE_RUNNER(w.s.runner.state)) feed(w, { type: "runner", trigger: { type: "callback_playing" } }, at);
}
/** The compositor's ONE final beat: `state: stopped` with its exit reason, routed exactly as the heartbeat route routes it. */
function finalBeat(w: Sim, at: number, exitReason: BeatExitReason | undefined): void {
  w.s = { ...w.s, heartbeatAt: sec(at) };
  tick(w, at);
  const t = stoppedBeatTrigger(exitReason);
  // R2003b: a crash (or restart) beat is not a teardown trigger — the route hands it to a session that is still running, never a terminal one
  if (t && (ACTIVE_RUNNER(w.s.runner.state) || w.s.runner.state === "stopping") && (t.type === "callback_stopped" || !isTerminal(w.s.state))) feed(w, { type: "runner", trigger: t }, at);
}
const observe = (w: Sim, at: number, state: (typeof OBSERVED_STATES)[number], exit: ExitInfo | null = null) =>
  feed(w, { type: "runner", trigger: { type: "observed", state, exit } }, at);

describe("R2003 — the final beat's exit reason (stoppedBeatTrigger): what each reason asks of the lifecycle", () => {
  // The oracle is the controller's ruling (2026-10-15) and the orchestrator's I2 decision (PR #967 review: an `ended` or
  // `deadline` beat ENDS the session — no retry), typed here — never read off the function under test.
  type Routed = "callback_stopped" | "ends:stopped" | "ends:max_duration" | "refused" | "crashed" | "restarted" | "record_only";
  const RULED: Record<BeatExitReason | "absent" | "null", Routed> = {
    absent: "callback_stopped", null: "callback_stopped",      // a legacy runner's beat: today's behaviour, unchanged
    ended: "ends:stopped",                                     // the compositor finished: a normal stop, respected
    deadline: "ends:max_duration",                             // RELAY_DEADLINE_AT is the wall clock's own instant
    // R2003b (owner approval 2026-10-16): a fatal run is a CRASH, counted toward RUNNER_CRASH_CAP — below it the lifecycle
    // still only records it (on-failure ≤ RUNNER_INPLACE_RESTARTS restarts it in place on the SAME attempt).
    fatal: "crashed",
    // Owed 66 (compositor C11b, the coordinator's dispatch): the in-place restart is NOT a crash — nothing is counted, like a
    // platform stop: Fly restarts the process on the SAME attempt and the restarted process beats again. Review m1: the
    // lifecycle hears it once, to NOTE it (`restartSeen`), under a trigger of its own — never `callback_crashed`.
    restart: "restarted",
    signalled: "record_only",                                  // a stop someone else asked for (exit 0): never a crash, never counted
    session_gone: "record_only",
    refused: "refused",                                        // the exit-78 outcome: failed, never a retry
  };
  it("BEAT_EXIT_REASONS is exactly RelayHeartbeat's exitReason enum (one vocabulary, two declarations)", () => {
    const schema = RelayHeartbeat.shape.exitReason.unwrap().unwrap().options;
    expect([...BEAT_EXIT_REASONS].sort()).toEqual([...schema].sort());
    expect(Object.keys(RULED).sort()).toEqual([...BEAT_EXIT_REASONS, "absent", "null"].sort());
  });
  it("each reason routes as ruled — the empty case (no reason) first; every input is checked, and the count is the vocabulary's", () => {
    let checked = 0;
    for (const [label, input] of [["absent", undefined], ["null", null], ...BEAT_EXIT_REASONS.map((r) => [r, r] as const)] as const) {
      const t = stoppedBeatTrigger(input);
      const got: Routed = t === null ? "record_only"
        : t.type === "callback_crashed" ? "crashed"
        : t.type === "callback_restarted" ? "restarted"
        : t.type !== "callback_stopped" ? (() => { throw new Error(`${label}: ${t.type} is not a stopped beat's trigger`); })()
        : t.refused === true ? "refused"
        : t.endReason !== undefined ? `ends:${t.endReason}` as Routed
        : "callback_stopped";
      expect(got, label).toBe(RULED[label]);
      if (t !== null) expect(t.type, label).toBe(got === "crashed" ? "callback_crashed" : got === "restarted" ? "callback_restarted" : "callback_stopped");
      checked++;
    }
    expect(checked).toBe(BEAT_EXIT_REASONS.length + 2);
  });
  it("refused from booting AND playing: lost + force_destroy + failed(machine_refused); the plain stopped beat (its positive pair) is today's lost with NO signal", () => {
    let checked = 0;
    for (const from of ["booting", "playing"] as const) {
      const refused = stepRunner(inState(from), { type: "callback_stopped", refused: true }, T0);
      expect(refused, from).toEqual({ next: { ...inState(from), state: "lost" }, effects: [{ type: "force_destroy" }], signal: { type: "failed", reason: "machine_refused" } });
      const plain = stepRunner(inState(from), { type: "callback_stopped" }, T0);
      expect(plain, `${from} plain`).toEqual({ next: { ...inState(from), state: "lost" }, effects: [{ type: "force_destroy" }], signal: null });
      checked++;
    }
    // stopping: our own stop is ending the session — any final beat is the teardown finishing, refused included
    expect(stepRunner(inState("stopping"), { type: "callback_stopped", refused: true }, T0).next.state).toBe("exited");
    expect(checked).toBe(2);
  });
  it("I2: ended / deadline from booting AND playing END the session — the runner is torn down (destroyed + force_destroy, the F17 session-ending shape) and the signal is completed with the reason; the plain stopped beat beside it is today's lost with NO signal", () => {
    let checked = 0;
    for (const from of ["booting", "playing"] as const) {
      for (const endReason of ["stopped", "max_duration"] as const) {
        const ends = stepRunner(inState(from), { type: "callback_stopped", endReason }, T0);
        expect(ends, `${from} ${endReason}`).toEqual({ next: { ...inState(from), state: "destroyed" }, effects: [{ type: "force_destroy" }], signal: { type: "completed", endReason } });
        checked++;
      }
    }
    // stopping: our own stop chose the reason already — the beat is the teardown finishing (exited), whatever it says
    expect(stepRunner(inState("stopping"), { type: "callback_stopped", endReason: "max_duration" }, T0)).toMatchObject({ next: { state: "exited" }, signal: null });
    expect(checked).toBe(4);
  });
  it("I2 through decide: an ended beat COMPLETES a live session `stopped` and a deadline beat a warming one `max_duration` — no retry_runner, no create, and the teardown's later confirmation changes nothing", () => {
    let checked = 0;
    for (const [label, s, reason, endReason] of [
      ["playing, live, ended", liveComposed(), "ended", "stopped"],
      ["booting, warming, ended", liveComposed({ state: "warming", startedAt: null, runner: inState("booting") }), "ended", "stopped"],
      ["playing, live, deadline", liveComposed(), "deadline", "max_duration"],
      ["booting, warming, deadline", liveComposed({ state: "warming", startedAt: null, runner: inState("booting") }), "deadline", "max_duration"],
    ] as const) {
      const w = sim(s);
      finalBeat(w, 1, reason);
      expect(w.s, label).toMatchObject({ state: "completed", desiredState: "ending", endReason, failReason: null, runner: { state: "destroyed", attempt: 1 } });
      feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, 2);
      expect(w.s, label).toMatchObject({ state: "completed", endReason, runner: { state: "destroyed", attempt: 1 } });
      expect(w.creates, `${label}: no create`).toEqual([]);
      expect(w.effects, label).not.toContain("retry_runner");
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("refused through decide: the session FAILS machine_refused at once, and the teardown's confirmation spends NO retry (C27 drops the signal on a terminal row)", () => {
    for (const [label, s] of [["playing, live", liveComposed()], ["booting, warming", liveComposed({ state: "warming", startedAt: null, runner: inState("booting") })]] as const) {
      const w = sim(s);
      finalBeat(w, 1, "refused");
      expect(w.s, label).toMatchObject({ state: "failed", failReason: "machine_refused", runner: { state: "lost", attempt: 1 } });
      feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, 2);
      expect(w.s.runner.state, label).toBe("destroyed");
      expect(w.creates, `${label}: no create_started`).toEqual([]);
      expect(w.effects, label).not.toContain("retry_runner");
    }
  });
});

describe("R2003 — in-place restarts are the SAME attempt; a lost runner retries ONCE, only after it is destroyed", () => {
  it("in_place_restart_keeps_attempt (plan review focus 5): crash → final fatal beat → observed pending (Fly `restarting`) → the restarted process beats at T+12 s: attempt 1 throughout, no stale beat, no create_machine — and the window then runs from the restarted Machine's beat", () => {
    const w = sim();
    finalBeat(w, 0, "fatal");
    observe(w, BEAT_S, "pending");                               // FLY_STATE_MAP: restarting → pending
    const restartedAt = STALE_HEARTBEAT_SECONDS_COMPOSED - 3;    // T+12: inside the window the final beat opened
    let ticked = 0;
    for (let t = 1; t < restartedAt; t++) { expect(tick(w, t), `T+${t}`).toBe("none"); ticked++; }
    beat(w, restartedAt, "starting");
    beat(w, restartedAt + BEAT_S, "playing");
    const last = restartedAt + BEAT_S;
    for (let t = last + 1; t < last + STALE_HEARTBEAT_SECONDS_COMPOSED; t++) { expect(tick(w, t), `T+${t}`).toBe("none"); ticked++; }
    expect(ticked).toBeGreaterThan(0);
    expect(w.stale).toEqual([]);
    expect(w.s.runner).toMatchObject({ state: "playing", attempt: 1, name: machineNameFor(SID, 1) });
    expect(w.s.runnerRetries).toBe(0);
    expect(w.effects).not.toContain("create_machine");
    expect(w.creates).toEqual([]);
    // the restarted Machine is timed like any played runner: lost one composed window after ITS last beat
    expect(tick(w, last + STALE_HEARTBEAT_SECONDS_COMPOSED)).toBe("stale_beat");
    expect(w.s.runner.state).toBe("lost");
  });

  it("crash_with_no_beat_within_15s_is_lost_then_one_retry_after_destroyed: lost at the composed window with force_destroy; observed pending keeps it lost and creates nothing; destroy_ok → destroyed → exactly ONE create_started, at attempt 2", () => {
    const w = sim();
    finalBeat(w, 0, "fatal");
    for (let t = 1; t < STALE_HEARTBEAT_SECONDS_COMPOSED; t++) expect(tick(w, t), `T+${t}`).toBe("none");
    expect(tick(w, STALE_HEARTBEAT_SECONDS_COMPOSED)).toBe("stale_beat");
    expect(w.s.runner).toMatchObject({ state: "lost", attempt: 1 });
    expect(w.effects).toEqual(["force_destroy"]);
    observe(w, STALE_HEARTBEAT_SECONDS_COMPOSED + 1, "pending");   // Fly still restarting it: NOT gone
    expect(w.s.runner.state).toBe("lost");
    expect(w.creates).toEqual([]);
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, STALE_HEARTBEAT_SECONDS_COMPOSED + 2);
    expect(w.creates).toEqual([{ attempt: 2, at: STALE_HEARTBEAT_SECONDS_COMPOSED + 2 }]);
    expect(w.s.runner).toMatchObject({ state: "booting", attempt: RUNNER_MAX_ATTEMPTS, name: machineNameFor(SID, 2) });
    expect(w.effects.filter((e) => e === "create_machine")).toHaveLength(1);
  });

  it("the ONE retry, end to end (owner ruling, option A): crash → lost at 15 s → destroyed → retry → booting with NO beat for 30 s → still alive (its boot allowance) → first beat → playing → a second crash → silence → lost at 15 s → failed. No third attempt", () => {
    const w = sim();
    finalBeat(w, 0, "fatal");
    expect(tick(w, STALE_HEARTBEAT_SECONDS_COMPOSED)).toBe("stale_beat");
    const retryAt = STALE_HEARTBEAT_SECONDS_COMPOSED + 1;
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, retryAt);
    expect(w.creates.map((c) => c.attempt)).toEqual([2]);
    expect(w.s.runner.state).toBe("booting");
    // The replacement cold-starts (~25 s on a fresh host): 30 s without a beat is NOT a lost runner.
    const coldStart = 2 * STALE_HEARTBEAT_SECONDS_COMPOSED;
    expect(coldStart).toBeLessThan(STALE_HEARTBEAT_SECONDS);     // premise: inside the boot allowance, past the played window
    for (let t = retryAt + 1; t <= retryAt + coldStart; t++) expect(tick(w, t), `retry+${t - retryAt}`).toBe("none");
    expect(w.s.runner).toMatchObject({ state: "booting", attempt: 2 });
    beat(w, retryAt + coldStart, "playing");
    expect(w.s.runner.state).toBe("playing");
    finalBeat(w, retryAt + coldStart + BEAT_S, "fatal");
    const crash2 = retryAt + coldStart + BEAT_S;
    expect(w.s.runner).toMatchObject({ state: "playing", attempt: 2 });
    for (let t = crash2 + 1; t < crash2 + STALE_HEARTBEAT_SECONDS_COMPOSED; t++) expect(tick(w, t)).toBe("none");
    expect(tick(w, crash2 + STALE_HEARTBEAT_SECONDS_COMPOSED)).toBe("stale_beat");
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, crash2 + STALE_HEARTBEAT_SECONDS_COMPOSED + 1);
    // The fatal beats never wrote an exit (A5): the reason is the no-exit default — named, not derived from the module.
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { state: "destroyed", attempt: RUNNER_MAX_ATTEMPTS } });
    expect(w.creates.map((c) => c.attempt), "exactly one create across the whole sequence").toEqual([2]);
    // a late retry_runner against the finished row is refused — there is no attempt 3
    expect(() => decide(w.s, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, 3), attempt: 3 } }, sec(crash2 + 99))).toThrow();
  });

  it("stale_beat_during_restart_never_runs_two_machines: every order of crash / beat / observe / wait / destroy_ok / late retry — no create_machine while a previous Machine is alive or not yet CONFIRMED destroyed (orders checked reported; zero is a failure)", () => {
    type Ev = "crash" | "beat" | "observe" | "wait_played" | "wait_boot" | "destroy_ok" | "late_retry";
    const ALPHABET: readonly Ev[] = ["crash", "beat", "observe", "wait_played", "wait_boot", "destroy_ok", "late_retry"];
    const DEPTH = 6;
    interface Machine { name: string; alive: boolean; restarting: boolean; crashes: number }
    interface World { s: Session; at: number; machines: Machine[]; confirmed: Set<string>; destroyFor: string | null; path: Ev[] }
    let orders = 0, createsChecked = 0, lateRetriesWhileAlive = 0, inPlaceRestarts = 0;
    const violations: string[] = [];
    const current = (w: World) => w.machines.find((m) => m.name === w.s.runner.name) ?? null;
    const clone = (w: World): World => ({ ...w, machines: w.machines.map((m) => ({ ...m })), confirmed: new Set(w.confirmed), path: [...w.path] });
    const step = (w: World, c: Command): void => {
      let d: ReturnType<typeof decide>;
      try { d = decide(w.s, c, sec(w.at)); } catch (e) {
        // a refusal is the answer for a command a moved row no longer accepts (retryRunner's M1 no-op)
        if (e instanceof InvalidRunnerTransition || e instanceof InvalidTransition) return;
        throw e;
      }
      w.s = d.next;
      for (const e of d.effects) {
        if (e.type === "runner" && e.effect.type === "force_destroy") w.destroyFor = w.s.runner.name;
        if (e.type === "runner" && e.effect.type === "create_machine") {
          createsChecked++;
          for (const m of w.machines) {
            if (m.alive || !w.confirmed.has(m.name)) violations.push(`${w.path.join(" → ")}: create ${w.s.runner.name} while ${m.name} ${m.alive ? "ALIVE" : "unconfirmed"}`);
          }
          w.machines.push({ name: w.s.runner.name!, alive: true, restarting: false, crashes: 0 });
          step(w, { type: "runner", trigger: { type: "create_ok", machineId: `m-${w.s.runner.name}` } });
        }
        if (e.type === "retry_runner") step(w, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, w.s.runner.attempt + 1), attempt: w.s.runner.attempt + 1 } });
      }
    };
    const expire = (w: World) => { const x = evaluate(w.s, sec(w.at)); if (x.kind !== "none") step(w, { type: "expire", expiry: x }); };
    const apply = (w0: World, ev: Ev): World => {
      const w = clone(w0);
      w.path.push(ev);
      const m = current(w);
      switch (ev) {
        case "crash":   // the compositor dies: Fly restarts it in place up to RUNNER_INPLACE_RESTARTS times, then auto_destroys it
          w.at += 1;
          if (m?.alive) {
            m.crashes++;
            if (m.crashes <= RUNNER_INPLACE_RESTARTS) { m.restarting = true; inPlaceRestarts++; } else m.alive = false;
            if (!isTerminal(w.s.state)) {
              w.s = { ...w.s, heartbeatAt: sec(w.at) };
              expire(w);
              const t = stoppedBeatTrigger("fatal");
              if (t && (ACTIVE_RUNNER(w.s.runner.state) || w.s.runner.state === "stopping")) step(w, { type: "runner", trigger: t });
            }
          }
          break;
        case "beat":
          w.at += BEAT_S;
          if (m?.alive && !isTerminal(w.s.state)) {
            m.restarting = false;
            w.s = { ...w.s, heartbeatAt: sec(w.at) };
            expire(w);
            if (!isTerminal(w.s.state) && ACTIVE_RUNNER(w.s.runner.state)) step(w, { type: "runner", trigger: { type: "callback_playing" } });
          }
          break;
        case "observe": {   // reconcileSession: the expiry, then ONE observation of the Machine the row names
          w.at += 1;
          expire(w);
          const r = w.s.runner;
          if (r.state === "none" || r.state === "destroyed" || r.state === "creating" || !r.machineId) break;
          const seen = current(w);
          const state = seen?.alive ? (seen.restarting ? "pending" : "running") : "destroyed";
          if (state === "destroyed" && r.name) w.confirmed.add(r.name);
          step(w, { type: "runner", trigger: { type: "observed", state } });
          break;
        }
        case "wait_played": w.at += STALE_HEARTBEAT_SECONDS_COMPOSED; expire(w); break;
        case "wait_boot": w.at += STALE_HEARTBEAT_SECONDS; expire(w); break;
        case "destroy_ok":   // the force_destroy's DELETE lands — fed only while the row still names that Machine (stillOurs)
          w.at += 1;
          if (w.destroyFor !== null && w.destroyFor === w.s.runner.name) {
            const target = w.machines.find((x) => x.name === w.destroyFor);
            if (target) target.alive = false;
            w.confirmed.add(w.destroyFor);
            w.destroyFor = null;
            step(w, { type: "runner", trigger: { type: "destroy_ok" } });
          }
          break;
        case "late_retry":   // a retry_runner effect running after the row moved on (retryRunner's M1 race)
          w.at += 1;
          if (w.machines.some((x) => x.alive)) lateRetriesWhileAlive++;
          step(w, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, w.s.runner.attempt + 1), attempt: w.s.runner.attempt + 1 } });
          break;
      }
      return w;
    };
    const walk = (w: World, depth: number): void => {
      if (depth === DEPTH) { orders++; return; }
      for (const ev of ALPHABET) walk(apply(w, ev), depth + 1);
    };
    walk({ s: liveComposed(), at: 0, machines: [{ name: machineNameFor(SID, 1), alive: true, restarting: false, crashes: 0 }], confirmed: new Set(), destroyFor: null, path: [] }, 0);
    console.info(`R2003 stale_beat_during_restart_never_runs_two_machines — orders checked: ${orders}, creates checked: ${createsChecked}`);
    expect(violations.slice(0, 5), `${violations.length} violations`).toEqual([]);
    expect(orders, "anti-vacuity: every order of the alphabet was walked").toBe(ALPHABET.length ** DEPTH);
    expect(createsChecked, "a create was reached and checked").toBeGreaterThan(0);
    expect(lateRetriesWhileAlive, "the hazard was offered: a retry while a Machine was alive").toBeGreaterThan(0);
    expect(inPlaceRestarts, "in-place restarts were exercised").toBeGreaterThan(0);
  });
});

describe("R2003 — exit 78 (refused) never retries", () => {
  it("exit_78_fails_refused_without_retry: playing → observed destroyed with exit 78 → failed(machine_refused), no retry; the positive pair (exit 1) still takes the ONE retry", () => {
    const refused = stepRunner(inState("playing"), { type: "observed", state: "destroyed", exit: REFUSED_EXIT }, T0);
    expect(refused).toMatchObject({ next: { state: "destroyed", lastExit: REFUSED_EXIT }, signal: { type: "failed", reason: "machine_refused" } });
    const crashed = stepRunner(inState("playing"), { type: "observed", state: "destroyed", exit: { exitCode: 1, oomKilled: false, requestedStop: false } }, T0);
    expect(crashed.signal).toEqual({ type: "retry" });
    // through decide: no create_started on the refusal; exactly one on the pair
    const w = sim();
    observe(w, 1, "destroyed", REFUSED_EXIT);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_refused" });
    expect(w.creates).toEqual([]);
    const pair = sim();
    observe(pair, 1, "destroyed", { exitCode: 1, oomKilled: false, requestedStop: false });
    expect(pair.creates.map((c) => c.attempt)).toEqual([2]);
    expect(pair.s.state).toBe("live");
  });
  it("exit 78 on every road to destroyed: observed stopped/failed (→ lost) then destroy_ok or observed destroyed; destroyed × stale_beat (the retry that never ran) — each fails machine_refused, never retries; failReasonFromExit names it", () => {
    let checked = 0;
    for (const first of ["stopped", "failed"] as const) {
      const lost = stepRunner(inState("playing"), { type: "observed", state: first, exit: REFUSED_EXIT }, T0);
      expect(lost.next.state, first).toBe("lost");
      for (const confirm of [{ type: "destroy_ok" }, { type: "observed", state: "destroyed" }] as const) {
        expect(stepRunner(lost.next, confirm, T0).signal, `${first} → ${JSON.stringify(confirm)}`).toEqual({ type: "failed", reason: "machine_refused" });
        checked++;
      }
    }
    const awaiting = R({ state: "destroyed", attempt: 1, name: "relay-s1-r1", machineId: "m1", lastExit: REFUSED_EXIT });
    expect(stepRunner(awaiting, { type: "stale_beat" }, T0).signal).toEqual({ type: "failed", reason: "machine_refused" });
    // its pair: the same row with a crash exit re-signals the retry
    expect(stepRunner({ ...awaiting, lastExit: { exitCode: 1, oomKilled: false, requestedStop: false } }, { type: "stale_beat" }, T0).signal).toEqual({ type: "retry" });
    checked++;
    expect(checked).toBe(5);
    expect(failReasonFromExit(REFUSED_EXIT)).toBe("machine_refused");
    expect(failReasonFromExit({ ...REFUSED_EXIT, exitCode: 1 })).toBe("machine_exit_nonzero");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// F-007 (live Fly probe, compositor `_FINDINGS.md`, 2026-10-15): during an on-failure restart the Machine reads `stopped`
// for ~110 ms, then `starting` (`pending` here) for ~1.3 s, then `started`; never `failed`. Only the latest exit event's
// `restarting` flag tells a restart from a loss — the adapter reports it as the neutral `restarting` (ADR 0007). Rule:
// lost = stopped/failed AND NOT restarting; a restart that has not come back within RUNNER_RESTART_STUCK_SECONDS is lost.
// And Fly restarts exit 78 too, so a refusal is failed AND force-destroyed the moment it is seen.
// ---------------------------------------------------------------------------------------------------------------------
const ms = (n: number) => new Date(T0.getTime() + n);
const obs = (state: (typeof OBSERVED_STATES)[number], exit: ExitInfo | null, restartingSince: Date | null): RunnerTrigger =>
  ({ type: "observed", state, exit, restarting: restartingSince !== null, restartingSince });
/** F-007 race: the provider reports the Machine down before it has recorded that exit (`restarting: null`, exit unknown). */
const unrecorded = (state: "stopped" | "failed"): RunnerTrigger => ({ type: "observed", state, exit: null, restarting: null, restartingSince: null });

describe("F-007 — an in-place restart as the Machines API shows it", () => {
  // F-007 appendix, M1 crash #1: exit (stopped, restarting: true) at 18:12:41.655, restart (starting) +109 ms, start
  // (started) +1407 ms. The polled states, in order, with the latest exit event's flag on each.
  const M1_CRASH_1: [number, (typeof OBSERVED_STATES)[number]][] = [[0, "stopped"], [109, "pending"], [1407, "running"]];

  it("the probe's sequence (stopped+restarting → starting → started) leaves a PLAYING runner and a BOOTING one exactly as they were — no effect, no signal, no retry; through decide, no create and no force_destroy", () => {
    let checked = 0;
    for (const from of ["playing", "booting"] as const) {
      let r = inState(from);
      for (const [at, state] of M1_CRASH_1) {
        const step = stepRunner(r, obs(state, state === "running" ? null : CRASH_EXIT, state === "running" ? null : T0), ms(at));
        expect(step.effects, `${from} ${state} +${at} ms`).toEqual([]);
        expect(step.signal, `${from} ${state} +${at} ms`).toBeNull();
        expect(step.next.state, `${from} ${state} +${at} ms`).toBe(from);
        r = step.next;
        checked++;
      }
    }
    expect(checked).toBe(2 * M1_CRASH_1.length);
    const w = sim();
    for (const [at, state] of M1_CRASH_1) feed(w, { type: "runner", trigger: obs(state, state === "running" ? null : CRASH_EXIT, state === "running" ? null : T0) }, at / 1000);
    expect(w.s).toMatchObject({ state: "live", runnerRetries: 0, runner: { state: "playing", attempt: 1 } });
    expect(w.effects).toEqual([]);
    expect(w.creates).toEqual([]);
  });

  it("the positive pair: stopped (or failed) with restarting FALSE — Fly's final exit once max_retries is spent — is lost with force_destroy, as before", () => {
    let checked = 0;
    for (const state of ["stopped", "failed"] as const) for (const from of ["playing", "booting"] as const) {
      expect(stepRunner(inState(from), obs(state, CRASH_EXIT, null), T0), `${from} ${state}`).toEqual({ next: { ...inState(from), state: "lost", lastExit: CRASH_EXIT }, effects: [{ type: "force_destroy" }], signal: null });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("stuck: a restart not back within RUNNER_RESTART_STUCK_SECONDS — still starting (pending) or still stopped — is lost; at the bound it is still a restart", () => {
    expect(RUNNER_RESTART_STUCK_SECONDS, "F-007: exit → started is ~1.4 s").toBeGreaterThan(2);
    let checked = 0;
    for (const state of ["pending", "stopped"] as const) for (const from of ["playing", "booting"] as const) {
      const atBound = stepRunner(inState(from), obs(state, CRASH_EXIT, T0), ms(RUNNER_RESTART_STUCK_SECONDS * 1000));
      expect(atBound.next.state, `${from} ${state} at the bound`).toBe(from);
      expect(atBound.effects).toEqual([]);
      const stuck = stepRunner(inState(from), obs(state, CRASH_EXIT, T0), ms(RUNNER_RESTART_STUCK_SECONDS * 1000 + 1));
      expect(stuck, `${from} ${state} stuck`).toMatchObject({ next: { state: "lost" }, effects: [{ type: "force_destroy" }], signal: null });
      checked++;
    }
    expect(checked).toBe(4);
    // a plain pending (a cold boot: no restart in flight) is never timed by this rule
    expect(stepRunner(inState("booting"), obs("pending", null, null), ms(3_600_000)).next.state).toBe("booting");
  });

  it("destroyed is gone whatever the last exit said: a destroyed observation carrying restarting is NOT exempt (it signals the retry, as before)", () => {
    expect(stepRunner(inState("playing"), obs("destroyed", CRASH_EXIT, T0), T0)).toMatchObject({ next: { state: "destroyed" }, signal: { type: "retry" } });
  });

  it("exit 78 is restarted by Fly (F-007 result 2), so it is never waited out: stopped/failed/starting with exit 78 — restarting or not — FAILS the session machine_refused and force-destroys the Machine at once", () => {
    let checked = 0;
    for (const state of ["stopped", "failed", "pending"] as const) for (const since of [T0, null]) for (const from of ["playing", "booting"] as const) {
      expect(stepRunner(inState(from), obs(state, REFUSED_EXIT, since), T0), `${from} ${state} restarting=${since !== null}`).toEqual({
        next: { ...inState(from), state: "lost", lastExit: REFUSED_EXIT }, effects: [{ type: "force_destroy" }], signal: { type: "failed", reason: "machine_refused" },
      });
      checked++;
    }
    expect(checked).toBe(12);
  });

  it("the reviewer's trace (confirm pass on f9034f575): a playing runner first SEEN mid-restart of a refusal — starting, restarting, exit 78 — fails machine_refused NOW: one teardown, no create, no retry, and the restart's `started` changes nothing", () => {
    // F-007 appendix, M2 (exits 78): the stopped instant can fall between two polls, so the first sight is `starting`.
    const w = sim();
    feed(w, { type: "runner", trigger: obs("pending", REFUSED_EXIT, T0) }, 1);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_refused", runnerRetries: 0, runner: { state: "lost", attempt: 1 } });
    expect(w.effects).toEqual(["force_destroy"]);
    feed(w, { type: "runner", trigger: obs("running", null, null) }, 2);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_refused", runner: { state: "lost", attempt: 1 } });
    expect(w.creates).toEqual([]);
  });

  it("the stopped-before-the-exit-event race (F-007 appendix, M2: `stopped` polled 90 ms and 320 ms BEFORE its exit event): STOPPED with the exit UNRECORDED makes no claim — not lost, not a restart — for a playing and a booting runner; FAILED never does (pass 3: a failed launch writes no exit at all, so 'unrecorded' would be forever) — it is lost at once", () => {
    let checked = 0;
    for (const from of ["playing", "booting"] as const) {
      expect(stepRunner(inState(from), unrecorded("stopped"), T0), `${from} stopped`).toEqual({ next: inState(from), effects: [], signal: null });
      expect(stepRunner(inState(from), unrecorded("failed"), T0), `${from} failed`).toEqual({ next: { ...inState(from), state: "lost" }, effects: [{ type: "force_destroy" }], signal: null });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("…and the window decides: after an unrecorded stop and NO beat, a playing runner is alive through the composed window and lost AT it; a booting one through the boot allowance", () => {
    let checked = 0;
    for (const [from, window] of [["playing", STALE_HEARTBEAT_SECONDS_COMPOSED], ["booting", STALE_HEARTBEAT_SECONDS]] as const) {
      const w = sim(liveComposed({ runner: inState(from) }));
      feed(w, { type: "runner", trigger: unrecorded("stopped") }, 0);
      for (let t = 1; t < window; t++) {
        expect(tick(w, t), `${from} T+${t}`).toBe("none");
        feed(w, { type: "runner", trigger: unrecorded("stopped") }, t);   // every read sees the same unrecorded stop
        expect(w.s.runner.state, `${from} T+${t}`).toBe(from);
        checked++;
      }
      expect(w.effects, `${from}: nothing before the window`).toEqual([]);
      expect(tick(w, window), `${from} at the window`).toBe("stale_beat");
      expect(w.s, from).toMatchObject({ state: "live", runner: { state: "lost", attempt: 1 } });
      expect(w.effects, from).toContain("force_destroy");
    }
    expect(checked).toBe(STALE_HEARTBEAT_SECONDS_COMPOSED - 1 + STALE_HEARTBEAT_SECONDS - 1);
  });

  it("a refusal stays refused while Fly restarts it: after the refused beat (and after an observed exit 78), the teardown is issued ONCE and every later observation of that Machine — stopped+restarting, starting, started — leaves the session failed, the runner lost, no create, no retry", () => {
    const later: RunnerTrigger[] = [obs("stopped", REFUSED_EXIT, T0), obs("pending", REFUSED_EXIT, T0), obs("running", null, null), obs("stopped", REFUSED_EXIT, null)];
    let checked = 0;
    for (const [label, first] of [["refused beat", (w: Sim) => finalBeat(w, 1, "refused")], ["observed exit 78", (w: Sim) => observe(w, 1, "stopped", REFUSED_EXIT)]] as const) {
      const w = sim();
      first(w);
      expect(w.s, label).toMatchObject({ state: "failed", failReason: "machine_refused", runner: { state: "lost" } });
      expect(w.effects.filter((e) => e === "force_destroy"), `${label}: the teardown, once`).toHaveLength(1);
      for (const [i, t] of later.entries()) {
        feed(w, { type: "runner", trigger: t }, 2 + i);
        expect(w.s, `${label} after ${i}`).toMatchObject({ state: "failed", failReason: "machine_refused", runner: { state: "lost", attempt: 1 } });
        checked++;
      }
      expect(w.effects.filter((e) => e === "force_destroy"), `${label}: never re-issued by an observation`).toHaveLength(1);
      expect(w.creates, label).toEqual([]);
      expect(w.effects, label).not.toContain("retry_runner");
      // the destroy finally lands: still failed, still no retry (C27)
      feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, 9);
      expect(w.s, label).toMatchObject({ state: "failed", failReason: "machine_refused", runner: { state: "destroyed" } });
      expect(w.creates, label).toEqual([]);
    }
    expect(checked).toBe(2 * later.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// R2003b — the crash-loop cap (owner approval 2026-10-16). F-007: Fly's `max_retries` is per 5-minute window and refills
// after ~330 s of healthy run, so a compositor crashing more slowly than that was restarted in place forever. A session
// whose runner has crashed RUNNER_CRASH_CAP times fails `machine_crash`, its Machine is torn down, and no retry is spent.
// Every expected count below is the number of DISTINCT crashes the scenario makes — never read off the tally under test.
// The evidence of one crash: its final beat (`exitReason: fatal`, C07 — one per run, best-effort) and its exit as the
// provider recorded it (instant + restart count, F-007). Either, both, or neither may arrive, in either order.
// ---------------------------------------------------------------------------------------------------------------------
/** A distinct crash's exit instant — one minute apart, so no two crashes share one (F-007: each exit has its own). */
const crashAt = (n: number) => new Date(T0.getTime() + n * 60_000);
/** The provider's view of a crash exit: `restarting` (Fly restarting it in place) with the exit's instant and Fly's
 *  per-window restart count (F-007: restarting exit k carries restart_count k; the final one restarting false).
 *  `exitRestarted` is the exit's own record, by default the same as `restarting`; a read after the restart COMPLETED
 *  (running, or a Machine torn down after it) passes restarting false with exitRestarted true. */
const crashExit = (state: (typeof OBSERVED_STATES)[number], exitAt: Date, restartCount: number | null, restarting: boolean | null = true, exit: ExitInfo = CRASH_EXIT, exitRestarted: boolean | null = restarting): RunnerTrigger =>
  ({ type: "observed", state, exit, restarting, restartingSince: restarting ? exitAt : null, exitAt, restartCount, exitRestarted });
const CRASHED: RunnerTrigger = { type: "callback_crashed" };
const tally = (over: Partial<CrashTally>): CrashTally => ({ ...CRASHES_NONE, ...over });
/** Owed 67: the restart tally's empty value, typed here from the declaration (RestartTally's four fields) — what a runner that has
 *  seen no restart holds, and what every crash test below leaves untouched (the two caps are independent). */
const NO_RESTARTS = { count: 0, beats: 0, exits: 0, exitAt: null };

describe("R2003b — the crash-loop cap: RUNNER_CRASH_CAP fatal crashes per SESSION fail it machine_crash", () => {
  it("the cap is the owner's 3 (2026-10-16), and a final beat saying `fatal` is a crash trigger while `signalled` and `session_gone` stay record only", () => {
    expect(RUNNER_CRASH_CAP, "owner approval 2026-10-16").toBe(3);
    expect(stoppedBeatTrigger("fatal")).toEqual({ type: "callback_crashed" });
    expect(stoppedBeatTrigger("signalled"), "a stop someone else asked for is never a crash").toBeNull();
    expect(stoppedBeatTrigger("session_gone")).toBeNull();
    expect(RUNNER_NONE.crashes, "a runner starts with nothing counted").toEqual({ count: 0, beats: 0, exits: 0, exitAt: null, restartSeen: false, restarts: { count: 0, beats: 0, exits: 0, exitAt: null } });
  });

  it("the SEQUENCE through decide: crash 1 → in-place restart → crash 2 → restart → crash 3 → failed machine_crash; the Machine is force-destroyed at the cap and NO retry is spent, though attempt 1 still had one", () => {
    expect(RUNNER_MAX_ATTEMPTS, "premise: attempt 1 has a retry the cap must not spend").toBeGreaterThan(1);
    const w = sim();
    let at = 0;
    for (let k = 1; k < RUNNER_CRASH_CAP; k++) {
      at += 1;
      finalBeat(w, at, "fatal");                                               // crash k's final beat…
      feed(w, { type: "runner", trigger: crashExit("pending", sec(at), k) }, at);   // …and the SAME crash's exit, mid-restart
      beat(w, at += BEAT_S, "starting");                                      // the restarted process comes back
      beat(w, at += BEAT_S, "playing");
      expect(w.s, `after crash ${k}`).toMatchObject({ state: "live", failReason: null, runner: { state: "playing", attempt: 1, crashes: { count: k } } });
      expect(w.effects, `after crash ${k}: nothing torn down`).toEqual([]);
    }
    at += 1;
    finalBeat(w, at, "fatal");                                                 // crash RUNNER_CRASH_CAP
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { state: "lost", attempt: 1, crashes: { count: RUNNER_CRASH_CAP } } });
    expect(w.effects, "the Machine Fly would restart again is torn down, once").toEqual(["force_destroy"]);
    // crash 3's own exit, read afterwards — Fly's final one for its window (F-007: restarting false, restart_count
    // RUNNER_INPLACE_RESTARTS, then auto_destroy): the SAME crash, so still RUNNER_CRASH_CAP; then the DELETE lands
    feed(w, { type: "runner", trigger: crashExit("destroyed", sec(at), RUNNER_INPLACE_RESTARTS, false) }, at + 1);
    expect(w.s.runner.crashes.count, "crash 3's exit is crash 3").toBe(RUNNER_CRASH_CAP);
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, at + 2);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runnerRetries: 0, runner: { state: "destroyed", attempt: 1 } });
    expect(w.creates, "no retry, ever").toEqual([]);
    expect(w.effects).not.toContain("retry_runner");
    expect(() => decide(w.s, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, 2), attempt: 2 } }, sec(at + 3)), "a late retry_runner is refused").toThrow();
  });

  it("ONE crash seen BOTH ways counts once — its beat then its exit, and its exit then its beat — and re-reading that exit never counts it again; the next crash (a NEWER exit) does", () => {
    let checked = 0;
    for (const order of ["beat first", "exit first"] as const) {
      let r = inState("playing");
      const first = crashExit("stopped", crashAt(1), 1);
      const reread = crashExit("pending", crashAt(1), 1);
      const steps: RunnerTrigger[] = order === "beat first" ? [CRASHED, first, reread, first] : [first, reread, CRASHED, reread];
      for (const [i, t] of steps.entries()) {
        r = stepRunner(r, t, crashAt(1)).next;
        expect(r.crashes.count, `${order}, step ${i}`).toBe(1);
        expect(r.state, `${order}, step ${i}: an in-place restart, not a loss`).toBe("playing");
        checked++;
      }
      // crash 2: a newer exit (the provider's count moves to 2) and its own beat — two distinct crashes, never three
      r = stepRunner(r, crashExit("stopped", crashAt(2), 2), crashAt(2)).next;
      r = stepRunner(r, CRASHED, crashAt(2)).next;
      r = stepRunner(r, crashExit("pending", crashAt(2), 2), crashAt(2)).next;
      expect(r.crashes.count, `${order}: two crashes`).toBe(2);
      checked++;
    }
    expect(checked).toBe(2 * 4 + 2);
  });

  it("crashes ACROSS the retry count cumulatively (per session, not per attempt): crash 1 → lost at the window → the ONE retry carries the count → crash 2 → crash 3 fails machine_crash, with exactly one replacement created", () => {
    const w = sim();
    finalBeat(w, 0, "fatal");                                                  // attempt 1's only crash: the restart never beats
    expect(tick(w, STALE_HEARTBEAT_SECONDS_COMPOSED)).toBe("stale_beat");
    const retryAt = STALE_HEARTBEAT_SECONDS_COMPOSED + 1;
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, retryAt);
    expect(w.creates.map((c) => c.attempt)).toEqual([2]);
    expect(w.s.runner, "the replacement starts from the crash already seen").toMatchObject({ state: "booting", attempt: 2, crashes: { count: 1, beats: 0, exits: 0 } });
    let at = retryAt + BEAT_S;
    beat(w, at, "playing");
    for (let k = 2; k < RUNNER_CRASH_CAP; k++) {
      finalBeat(w, at += 1, "fatal");
      beat(w, at += BEAT_S, "playing");
      expect(w.s, `crash ${k}`).toMatchObject({ state: "live", runner: { state: "playing", attempt: 2, crashes: { count: k } } });
    }
    finalBeat(w, at += 1, "fatal");
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { state: "lost", attempt: 2, crashes: { count: RUNNER_CRASH_CAP } } });
    expect(w.creates.map((c) => c.attempt), "exactly one replacement").toEqual([2]);
  });

  it("only a CRASH exit counts: non-zero or OOM, not requested — never exit 0 (a `signalled` drain, a requested stop), never a requested kill past the grace, never the refusal (exit 78); each read with a fresh exit instant", () => {
    // The table is the compositor's exit codes (C06: Fatal 70, Refused 78, every clean reason 0) and Fly's exit fields.
    const CASES: [string, ExitInfo, boolean][] = [
      ["compositor Fatal (70)", { exitCode: 70, oomKilled: false, requestedStop: false }, true],
      ["native crash (SIGSEGV, 139)", { exitCode: 139, oomKilled: false, requestedStop: false }, true],
      ["OOM-killed (137)", { exitCode: 137, oomKilled: true, requestedStop: false }, true],
      ["signalled drain on a platform SIGTERM (0)", { exitCode: 0, oomKilled: false, requestedStop: false }, false],
      ["a requested stop (0)", { exitCode: 0, oomKilled: false, requestedStop: true }, false],
      ["a requested stop killed past its grace (143)", { exitCode: 143, oomKilled: false, requestedStop: true }, false],
      ["the refusal (78)", REFUSED_EXIT, false],
      // Owed 66: the in-place restart (C11b, exit 75) is not a crash; its neighbours are (the exact code, not a range)
      ["the in-place restart (75)", RESTART_EXIT, false],
      ["a code just below the restart's (74)", { exitCode: RELAY_EXIT_RESTART - 1, oomKilled: false, requestedStop: false }, true],
      ["a code just above the restart's (76)", { exitCode: RELAY_EXIT_RESTART + 1, oomKilled: false, requestedStop: false }, true],
    ];
    let counted = 0, notCounted = 0;
    for (const [label, exit, isCrash] of CASES) {
      // restarting false: Fly restarts only failures, so a non-crash exit is never `restarting` (F-007)
      const step = stepRunner(inState("playing"), crashExit("stopped", crashAt(1), null, false, exit), crashAt(1));
      expect(step.next.crashes.count, label).toBe(isCrash ? 1 : 0);
      if (isCrash) counted++; else notCounted++;
    }
    expect(counted).toBe(5);
    expect(notCounted).toBe(5);
  });

  it("a platform stop is never a crash: RUNNER_CRASH_CAP + 1 `signalled` final beats leave a live session live, its count 0; the same number of `fatal` ones fails it (the differential)", () => {
    const signalled = sim();
    const fatal = sim();
    for (let k = 1; k <= RUNNER_CRASH_CAP + 1; k++) {
      finalBeat(signalled, k, "signalled");
      finalBeat(fatal, k, "fatal");
    }
    expect(signalled.s).toMatchObject({ state: "live", runner: { state: "playing", crashes: { count: 0 } } });
    expect(signalled.effects).toEqual([]);
    expect(fatal.s).toMatchObject({ state: "failed", failReason: "machine_crash" });
  });

  it("the refusal keeps its own path: one crash short of the cap, a refused exit (restarting, with its instant and count) or a refused final beat fails machine_refused — never machine_crash — and adds nothing to the count", () => {
    const short = R({ ...inState("playing"), crashes: tally({ count: RUNNER_CRASH_CAP - 1, beats: RUNNER_CRASH_CAP - 1 }) });
    const viaExit = stepRunner(short, crashExit("pending", crashAt(9), 1, true, REFUSED_EXIT), crashAt(9));
    expect(viaExit).toMatchObject({ next: { state: "lost", crashes: { count: RUNNER_CRASH_CAP - 1 } }, signal: { type: "failed", reason: "machine_refused" } });
    const viaBeat = stepRunner(short, { type: "callback_stopped", refused: true }, crashAt(9));
    expect(viaBeat).toMatchObject({ next: { state: "lost", crashes: { count: RUNNER_CRASH_CAP - 1 } }, signal: { type: "failed", reason: "machine_refused" } });
  });

  // The roads above refuse BEFORE anything is counted. These two reach the tally first, so only crashExitSeen's own
  // refusal guard keeps exit 78 out of the count there.
  it("a refusal is never counted on the roads that DO count: one short of the cap, an observed `destroyed` exit 78 fails machine_refused with the count unmoved, and a LOST runner (the refusal's teardown out, Fly restarting it again) reading a NEWER exit 78 signals nothing and counts nothing", () => {
    let checked = 0;
    const counted = tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) });
    for (const from of ["playing", "booting"] as const) {
      const destroyed = stepRunner(R({ ...inState(from), crashes: counted }), crashExit("destroyed", crashAt(5), RUNNER_INPLACE_RESTARTS, false, REFUSED_EXIT), crashAt(5));
      expect(destroyed, from).toMatchObject({ next: { state: "destroyed", crashes: { count: RUNNER_CRASH_CAP - 1 } }, signal: { type: "failed", reason: "machine_refused" } });
      checked++;
    }
    const lost = stepRunner(R({ ...inState("lost"), crashes: counted }), crashExit("pending", crashAt(5), 1, true, REFUSED_EXIT), crashAt(5));
    expect(lost).toMatchObject({ next: { state: "lost", crashes: { count: RUNNER_CRASH_CAP - 1 } }, signal: null });
    checked++;
    expect(checked).toBe(3);
  });

  it("Fly restarting an exit is crash evidence on its own: an exit Fly is RESTARTING whose exit_event carries no code counts one crash (Fly restarts only a failure); the same codeless exit NOT restarting counts nothing (the differential)", () => {
    const CODELESS: ExitInfo = { exitCode: null, oomKilled: null, requestedStop: null };
    let checked = 0;
    for (const state of ["stopped", "pending"] as const) {
      const restarting = stepRunner(inState("playing"), crashExit(state, crashAt(1), null, true, CODELESS), crashAt(1));
      expect(restarting.next.crashes, `${state}, restarting`).toEqual({ count: 1, beats: 0, exits: 1, exitAt: crashAt(1), restartSeen: false, restarts: NO_RESTARTS });
      const notRestarting = stepRunner(inState("playing"), crashExit(state, crashAt(1), null, false, CODELESS), crashAt(1));
      expect(notRestarting.next.crashes, `${state}, not restarting`).toEqual(CRASHES_NONE);
      checked++;
    }
    expect(checked).toBe(2);
  });

  // R2003b review m1. F-007 MEASURED (M1, exit 1; M3, exit 78): crashes #1 and #2 were restarted in place with
  // restart_count 1 and 2; crash #3, Fly's FINAL exit for the window (restarting false), carried restart_count 2. So a
  // final exit proves its count PLUS ONE crashes. The +1 reads the exit's own record, never the in-flight flag: a Machine
  // read after its restart completed (running) or torn down after it shows restarting false on an exit Fly DID restart.
  it("F-007's final exit is one more crash than its count: first sight of Fly's final exit (restart_count 2, not restarted) counts the 3 crashes F-007 measured and caps; the same count on an exit Fly restarted, read mid-restart or after it completed, counts 2", () => {
    const MEASURED = { finalCount: 2, crashes: 3, restartedCount: 2 };   // F-007 M1/M3: restart_count 2 on the final exit after 3 crashes
    let checked = 0;
    for (const state of ["stopped", "destroying", "destroyed"] as const) {
      const step = stepRunner(inState("playing"), crashExit(state, crashAt(1), MEASURED.finalCount, false, CRASH_EXIT, false), crashAt(1));
      expect(step.next.crashes.count, `final exit, ${state}`).toBe(MEASURED.crashes);
      expect(step.signal, `final exit, ${state}`).toEqual({ type: "failed", reason: "machine_crash" });
      checked++;
    }
    for (const [label, t] of [
      ["restarting now", crashExit("pending", crashAt(1), MEASURED.restartedCount)],
      ["restart completed, read running", crashExit("running", crashAt(1), MEASURED.restartedCount, false, CRASH_EXIT, true)],
      ["no record either way", crashExit("running", crashAt(1), MEASURED.restartedCount, false, CRASH_EXIT, null)],
    ] as const) {
      const step = stepRunner(inState("playing"), t, crashAt(1));
      expect(step.next.crashes.count, label).toBe(MEASURED.restartedCount);
      expect(step.signal, label).toBeNull();
      checked++;
    }
    expect(checked).toBe(6);
  });

  // R2003b review m3: the order of the checks matters for one exit, a stop that was ASKED for which Fly also marks
  // restarting (unmeasured whether Fly ever does). A stop someone asked for is never a crash, so it is read first.
  it("a stop that was ASKED for is never a crash, even when the provider marks it restarting (in flight or by the exit's own record); the same exit not asked for is one crash (the differential)", () => {
    let checked = 0;
    for (const [state, restarting, exitRestarted] of [["pending", true, true], ["stopped", true, true], ["running", false, true]] as const) {
      for (const exitCode of [0, 143]) {
        const asked: ExitInfo = { exitCode, oomKilled: false, requestedStop: true };
        const step = stepRunner(inState("playing"), crashExit(state, crashAt(1), 1, restarting, asked, exitRestarted), crashAt(1));
        expect(step.next.crashes, `${state}, asked, ${exitCode}`).toEqual(CRASHES_NONE);
        const notAsked = stepRunner(inState("playing"), crashExit(state, crashAt(1), 1, restarting, { ...asked, requestedStop: false }, exitRestarted), crashAt(1));
        expect(notAsked.next.crashes.count, `${state}, not asked, ${exitCode}`).toBe(1);
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  // R2003b review I2: a running read's exit belongs to the run BEFORE this one. It is tally evidence only; as the runner's
  // lastExit it would decide a later loss with a stale run's reason.
  it("a running read's exit never becomes the runner's lastExit: a refusal Fly restarted and that then RAN (78 read while running) counts nothing and leaves the later loss its retry; the same 78 read mid-restart fails machine_refused (the differential)", () => {
    const running = stepRunner(inState("playing"), crashExit("running", crashAt(1), 1, false, REFUSED_EXIT, true), crashAt(1));
    expect(running).toEqual({ next: inState("playing"), effects: [], signal: null });
    expect(stepRunner({ ...running.next, state: "lost" }, { type: "destroy_ok" }, crashAt(2)).signal, "the loss keeps its retry").toEqual({ type: "retry" });
    const pending = stepRunner(inState("playing"), crashExit("pending", crashAt(1), 1, true, REFUSED_EXIT), crashAt(1));
    expect(pending.signal).toEqual({ type: "failed", reason: "machine_refused" });
  });

  // R2003b review m4: the organiser reads the fail reason (stream-session-view.ts → stream.fail.*). An OOM loop at the cap
  // says "ran out of memory" (machine_oom, existing copy in all four locales), not the generic "stopped unexpectedly".
  it("the cap fails with the CAPPING crash's reason: an OOM-killed exit reads machine_oom, any other crash exit machine_crash, on every road the cap fires; a crash capped by its BEAT is machine_crash even after an earlier OOM exit", () => {
    const OOM: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };
    const ROADS = [["playing", "stopped"], ["playing", "pending"], ["playing", "running"], ["playing", "destroying"], ["playing", "destroyed"], ["booting", "pending"], ["lost", "pending"], ["lost", "destroyed"]] as const;
    let checked = 0;
    for (const [from, state] of ROADS) {
      for (const [exit, reason] of [[OOM, "machine_oom"], [CRASH_EXIT, "machine_crash"]] as const) {
        const short = R({ ...inState(from), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
        const t = state === "running" ? crashExit(state, crashAt(2), 1, false, exit, true) : crashExit(state, crashAt(2), 1, true, exit);
        expect(stepRunner(short, t, crashAt(2)).signal, `${from} × ${state} × ${reason}`).toEqual({ type: "failed", reason });
        checked++;
      }
    }
    const afterOom = R({ ...inState("playing"), lastExit: OOM, crashes: tally({ count: RUNNER_CRASH_CAP - 1, beats: RUNNER_CRASH_CAP - 1 }) });
    expect(stepRunner(afterOom, CRASHED, T0).signal, "capped by a fatal beat").toEqual({ type: "failed", reason: "machine_crash" });
    checked++;
    expect(checked).toBe(ROADS.length * 2 + 1);
  });

  it("the provider's restart count is a FLOOR: first sight of a crash Fly already restarted twice counts 2 (F-007: restart_count k on restarting exit k), re-reading it stays 2, its own late beat stays 2; after the window refills, a newer exit with count 1 is the 3rd and caps", () => {
    let r = inState("playing");
    r = stepRunner(r, crashExit("pending", crashAt(1), 2), crashAt(1)).next;
    expect(r.crashes.count, "two crashes in Fly's window").toBe(2);
    r = stepRunner(r, crashExit("pending", crashAt(1), 2), crashAt(1)).next;
    r = stepRunner(r, CRASHED, crashAt(1)).next;
    expect(r.crashes.count, "the same crash, read again and beaten late").toBe(2);
    expect(r.state).toBe("playing");
    const third = stepRunner(r, crashExit("stopped", crashAt(7), 1), crashAt(7));   // F-007 M2: a refilled window reads count 1 again
    expect(third).toMatchObject({ next: { state: "lost", crashes: { count: RUNNER_CRASH_CAP } }, effects: [{ type: "force_destroy" }], signal: { type: "failed", reason: "machine_crash" } });
  });

  it("at the cap on every road out: an observed exit reaching it (stopped / pending / running / stopping / destroying / unknown / destroyed), a LOST runner's observation crossing it, a confirmed destroy, the C1 stale beat on destroyed — failed machine_crash, never the retry; one short of it, each road is today's", () => {
    let checked = 0;
    for (const state of ["stopped", "pending"] as const) for (const from of ["playing", "booting"] as const) {
      const short = R({ ...inState(from), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
      expect(stepRunner(short, crashExit(state, crashAt(2), 1), crashAt(2)), `${from} × ${state}`).toEqual({
        next: { ...short, state: "lost", lastExit: CRASH_EXIT, crashes: { count: RUNNER_CRASH_CAP, beats: 0, exits: RUNNER_CRASH_CAP, exitAt: crashAt(2), restartSeen: false, restarts: NO_RESTARTS } },
        effects: [{ type: "force_destroy" }], signal: { type: "failed", reason: "machine_crash" },
      });
      checked++;
    }
    // R2003b review I3: the reads that make no claim on the runner's state still carry a crash exit — `running` the run
    // before this one (I2: a crash Fly already restarted), `stopping` / `destroying` / `unknown` the newest exit on the
    // way down (auto_destroy after Fly's final exit passes through destroying). A NEWER one reaching the cap fails it on
    // that read, never one read later. A running read's exit is the previous run's, so it is never the runner's lastExit.
    for (const state of ["running", "stopping", "destroying", "unknown"] as const) for (const from of ["playing", "booting"] as const) {
      const short = R({ ...inState(from), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
      expect(stepRunner(short, crashExit(state, crashAt(2), 1, false, CRASH_EXIT, true), crashAt(2)), `${from} × ${state}`).toEqual({
        next: { ...short, state: "lost", lastExit: state === "running" ? short.lastExit : CRASH_EXIT, crashes: { count: RUNNER_CRASH_CAP, beats: 0, exits: RUNNER_CRASH_CAP, exitAt: crashAt(2), restartSeen: false, restarts: NO_RESTARTS } },
        effects: [{ type: "force_destroy" }], signal: { type: "failed", reason: "machine_crash" },
      });
      checked++;
    }
    // destroyed (Fly gave up and auto-destroyed it): a NEWER crash exit reaches the cap; the one already counted does not
    const shortPlaying = R({ ...inState("playing"), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
    expect(stepRunner(shortPlaying, crashExit("destroyed", crashAt(3), RUNNER_INPLACE_RESTARTS, false), crashAt(3))).toMatchObject({ next: { state: "destroyed", crashes: { count: RUNNER_CRASH_CAP } }, signal: { type: "failed", reason: "machine_crash" } });
    // the exit already counted, read on the destroyed Machine (torn down after Fly restarted it: its own record says
    // restarted, count 2 = the two crashes counted): nothing new, the retry. Its F-007 counterpart, the same instant as
    // Fly's FINAL exit (count 2, not restarted), proves a 3rd crash: that is the m1 test below.
    expect(stepRunner(shortPlaying, crashExit("destroyed", crashAt(1), RUNNER_INPLACE_RESTARTS, false, CRASH_EXIT, true), crashAt(3)).signal, "the exit already counted: the retry").toEqual({ type: "retry" });
    checked++;
    // lost: an observation that CROSSES the cap fails the session once; a re-read of it signals nothing more
    const lostShort = R({ ...inState("lost"), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
    const crossing = stepRunner(lostShort, crashExit("pending", crashAt(4), 1), crashAt(4));
    expect(crossing).toMatchObject({ next: { state: "lost", crashes: { count: RUNNER_CRASH_CAP } }, signal: { type: "failed", reason: "machine_crash" } });
    expect(stepRunner(crossing.next, crashExit("pending", crashAt(4), 1), crashAt(4)).signal, "the same exit again").toBeNull();
    checked++;
    // a confirmed destroy at the cap, with a retry still left; and one short of it, the retry
    for (const confirm of [{ type: "destroy_ok" }, { type: "observed", state: "destroyed" }] as const) {
      const lostAt = R({ ...inState("lost"), crashes: tally({ count: RUNNER_CRASH_CAP, beats: RUNNER_CRASH_CAP }) });
      expect(stepRunner(lostAt, confirm, T0).signal, JSON.stringify(confirm)).toEqual({ type: "failed", reason: "machine_crash" });
      expect(stepRunner(lostShort, confirm, T0).signal, `${JSON.stringify(confirm)}, one short`).toEqual({ type: "retry" });
      checked++;
    }
    // C1: destroyed and still wanted live — the retry that never ran is not re-signalled at the cap
    const awaiting = R({ state: "destroyed", attempt: 1, name: "relay-s1-r1", machineId: "m1", crashes: tally({ count: RUNNER_CRASH_CAP, beats: 1 }) });
    expect(stepRunner(awaiting, { type: "stale_beat" }, T0).signal).toEqual({ type: "failed", reason: "machine_crash" });
    expect(stepRunner({ ...awaiting, crashes: tally({ count: RUNNER_CRASH_CAP - 1, beats: 1 }) }, { type: "stale_beat" }, T0).signal).toEqual({ type: "retry" });
    checked++;
    expect(checked).toBe(4 + 8 + 1 + 1 + 2 + 1);
  });

  it("the guard: create_started is REFUSED at the cap even from destroyed with a retry left (a late retry_runner); one short of it the replacement starts with THIS attempt's evidence cleared and the session's count carried", () => {
    const atCap = R({ state: "destroyed", attempt: 1, name: "relay-s1-r1", machineId: "m1", crashes: tally({ count: RUNNER_CRASH_CAP, beats: 2, exits: 1, exitAt: crashAt(1) }) });
    const t: RunnerTrigger = { type: "create_started", name: machineNameFor("s1", 2), attempt: 2 };
    expect(() => stepRunner(atCap, t, T0)).toThrow(InvalidRunnerTransition);
    const short = { ...atCap, crashes: tally({ count: RUNNER_CRASH_CAP - 1, beats: 2, exits: 1, exitAt: crashAt(1) }) };
    expect(stepRunner(short, t, T0).next).toMatchObject({ state: "creating", attempt: 2, crashes: { count: RUNNER_CRASH_CAP - 1, beats: 0, exits: 0, exitAt: crashAt(1) } });
  });

  it("stopping / exited / lost take a crash beat as record only (our stop is ending it, or the teardown is already out); none / creating / destroyed refuse it", () => {
    let checked = 0;
    for (const s of ["stopping", "exited", "lost"] as const) {
      expect(stepRunner(inState(s), CRASHED, T0), s).toEqual({ next: inState(s), effects: [], signal: null });
      checked++;
    }
    for (const s of ["none", "creating", "destroyed"] as const) {
      expect(() => stepRunner(inState(s), CRASHED, T0), s).toThrow(InvalidRunnerTransition);
      checked++;
    }
    expect(checked).toBe(6);
  });

  // The R2003 order sweep's sibling (stale_beat_during_restart_never_runs_two_machines), over the crash evidence: a crash
  // that beats and one that does not, a platform stop (signalled, exit 0), the observation that reads the latest exit
  // (fresh or re-read, with Fly's restart count), the stale window, the confirmed destroy and a late retry_runner.
  // Oracles, none read off the tally: no create once the cap is counted; the cap fails the session the moment it is
  // counted; never more counted than the crashes the world MADE (no double count — signalled made none); never fewer than
  // the beats, or the distinct crash exits, the lifecycle was handed (no evidence dropped).
  it("crash_cap_sweep: every order of crash+beat / silent crash / signalled stop / restart done / observe / wait / destroy_ok / late retry — no create at the cap, the cap fails at once, nothing counted twice or dropped (orders checked reported; zero is a failure)", () => {
    // Owed 66: `restart_polled` is the compositor's in-place restart — its `restart` beat (noted, never counted), exit 75 (which
    // Fly counts in its window like any non-zero exit) and the read that follows it before the next exit. `restart_unread`
    // is the same restart WITHOUT that read (review m1): the exit is there for the next exit to overwrite as the newest, and
    // only the beat has noted it. A restart MAKES no crash, so `made` does not move; the oracles below then say a restart is
    // never counted, in any order.
    type Ev = "crash_beat" | "crash_silent" | "restart_polled" | "restart_unread" | "signalled" | "restart_done" | "observe" | "wait_played" | "destroy_ok" | "late_retry";
    const ALPHABET: readonly Ev[] = ["crash_beat", "crash_silent", "restart_polled", "restart_unread", "signalled", "restart_done", "observe", "wait_played", "destroy_ok", "late_retry"];
    const DEPTH = 6;
    // `restartCount` / `exitRestarted`: the newest exit's own record, as F-007 measured it (restarting exit k: k, true; the
    // window's final exit: max_retries, false — 2 after 3 crashes)
    interface Machine { name: string; alive: boolean; restarting: boolean; windowCrashes: number; restarts: number; unread?: boolean; exit: ExitInfo | null; exitAt: number | null; restartCount: number | null; exitRestarted: boolean | null }
    interface World { s: Session; at: number; machines: Machine[]; destroyFor: string | null; made: number; beats: number; beaten: Set<string>; exits: Set<string>; path: Ev[] }
    let orders = 0, createsChecked = 0, capped = 0, cappedOnRetry = 0, dedupes = 0, signalledStops = 0, runningExits = 0, checks = 0, restartsPolled = 0, restartsUnread = 0, crashesAfterRestart = 0, cappedAfterRestart = 0, crashesAfterUnread = 0;
    const violations: string[] = [];
    const current = (w: World) => w.machines.find((m) => m.name === w.s.runner.name) ?? null;
    const clone = (w: World): World => ({ ...w, machines: w.machines.map((m) => ({ ...m })), beaten: new Set(w.beaten), exits: new Set(w.exits), path: [...w.path] });
    const step = (w: World, c: Command): void => {
      let d: ReturnType<typeof decide>;
      try { d = decide(w.s, c, sec(w.at)); } catch (e) {
        if (e instanceof InvalidRunnerTransition || e instanceof InvalidTransition) return;
        throw e;
      }
      const countBefore = w.s.runner.crashes.count;
      w.s = d.next;
      for (const e of d.effects) {
        if (e.type === "runner" && e.effect.type === "force_destroy") w.destroyFor = w.s.runner.name;
        if (e.type === "runner" && e.effect.type === "create_machine") {
          createsChecked++;
          if (countBefore >= RUNNER_CRASH_CAP || w.s.runner.crashes.count >= RUNNER_CRASH_CAP) violations.push(`${w.path.join(" → ")}: create ${w.s.runner.name} at ${w.s.runner.crashes.count} crashes`);
          w.machines.push({ name: w.s.runner.name!, alive: true, restarting: false, windowCrashes: 0, restarts: 0, exit: null, exitAt: null, restartCount: null, exitRestarted: null });
          step(w, { type: "runner", trigger: { type: "create_ok", machineId: `m-${w.s.runner.name}` } });
        }
        if (e.type === "retry_runner") step(w, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, w.s.runner.attempt + 1), attempt: w.s.runner.attempt + 1 } });
      }
    };
    const expire = (w: World) => { const x = evaluate(w.s, sec(w.at)); if (x.kind !== "none") step(w, { type: "expire", expiry: x }); };
    /** The route: a beat on a terminal row is 410 and writes nothing; otherwise heartbeat_at, the expiry, then the trigger. */
    const finalBeatOf = (w: World, reason: BeatExitReason): boolean => {
      if (isTerminal(w.s.state)) return false;
      w.s = { ...w.s, heartbeatAt: sec(w.at) };
      expire(w);
      const t = stoppedBeatTrigger(reason);
      if (!t || isTerminal(w.s.state) || !(ACTIVE_RUNNER(w.s.runner.state) || w.s.runner.state === "stopping")) return false;
      const handed = ACTIVE_RUNNER(w.s.runner.state);   // a booting/playing runner is the one that counts (or notes) the beat
      if (t.type === "callback_crashed" && handed) w.beats++;
      step(w, { type: "runner", trigger: t });
      return handed;
    };
    const crash = (w: World, m: Machine, beats: boolean) => {
      const handed = w.beats;
      if (beats) finalBeatOf(w, "fatal");        // C07: the final beat goes out BEFORE the process exits
      if (w.beats > handed) w.beaten.add(`${m.name}@${w.at}`);
      m.windowCrashes++;
      w.made++;
      m.exit = CRASH_EXIT;
      m.exitAt = w.at;
      // F-007: restarted in place up to RUNNER_INPLACE_RESTARTS per window (exit k carries restart_count k); the next is
      // Fly's final exit, carrying restart_count max_retries (M1/M3: 2 after 3 crashes), then auto_destroy
      if (m.windowCrashes <= RUNNER_INPLACE_RESTARTS) Object.assign(m, { restarting: true, restartCount: m.windowCrashes, exitRestarted: true });
      else Object.assign(m, { alive: false, restarting: false, restartCount: RUNNER_INPLACE_RESTARTS, exitRestarted: false });
    };
    /** reconcileSession: the expiry, then ONE observation of the Machine the row names (runner-fly.ts observe). */
    const observeOnce = (w: World): void => {
      expire(w);
      const r = w.s.runner;
      if (r.state === "none" || r.state === "destroyed" || r.state === "creating" || !r.machineId) return;
      const seen = current(w);
      const trigger: RunnerTrigger = !seen ? { type: "observed", state: "destroyed", exit: null, restarting: false, restartingSince: null, exitAt: null, restartCount: null }
        // R2003b review I2: a running Machine reports its newest exit too (the run before this one)
        : seen.alive && !seen.restarting ? { type: "observed", state: "running", exit: seen.exit, restarting: false, restartingSince: null,
            exitAt: seen.exitAt === null ? null : sec(seen.exitAt), restartCount: seen.restartCount, exitRestarted: seen.exitRestarted }
        : { type: "observed", state: seen.alive ? "pending" : "destroyed", exit: seen.exit, restarting: seen.restarting,
            restartingSince: seen.restarting ? sec(seen.exitAt!) : null, exitAt: seen.exitAt === null ? null : sec(seen.exitAt), restartCount: seen.restartCount, exitRestarted: seen.exitRestarted };
      const counts = r.state === "booting" || r.state === "playing" || r.state === "lost";
      if (counts && seen && seen.exit === CRASH_EXIT && seen.exitAt !== null) {
        const id = `${seen.name}@${seen.exitAt}`;
        if (w.exits.has(id) || w.beaten.has(id)) dedupes++;   // this crash was handed over already: by its beat, or this exit
        if (seen.alive && !seen.restarting) runningExits++;   // I2: handed over by a read after its restart completed
        if (seen.restarts > 0) crashesAfterRestart++;           // Owed 66: a crash read in a window that held a restart
        if (seen.unread) crashesAfterUnread++;                  // …and one that held a restart whose exit no read ever saw (review m1: only its beat noted it)
        w.exits.add(id);
      }
      step(w, { type: "runner", trigger });
    };
    const apply = (w0: World, ev: Ev): World => {
      const w = clone(w0);
      w.path.push(ev);
      const m = current(w);
      w.at += ev === "wait_played" ? STALE_HEARTBEAT_SECONDS_COMPOSED : 1;
      switch (ev) {
        case "crash_beat": case "crash_silent":
          if (m?.alive) { m.restarting = false; crash(w, m, ev === "crash_beat"); }   // a restarting Machine came back, then died again
          break;
        case "restart_polled": case "restart_unread":   // Owed 66: `restart` final beat (noted), exit 75 as Fly records it, and (polled) the read that follows
          if (m?.alive) {
            m.restarting = false;
            const handed = finalBeatOf(w, "restart");
            // The RESIDUAL (review m3), not this sweep's claim: a `restart` beat no booting/playing runner was handed (the stale
            // window had already taken it `lost`) notes nothing, and with its exit never read that is the pre-fix over-count.
            // The polled restart is read straight after, so its exit notes it either way; the unread one is skipped.
            if (ev === "restart_unread" && !handed) break;
            m.windowCrashes++;   // Fly counts every non-zero exit in its window, 75 included
            m.restarts++;
            if (ev === "restart_polled") restartsPolled++; else { restartsUnread++; m.unread = true; }
            m.exit = RESTART_EXIT;
            m.exitAt = w.at;
            if (m.windowCrashes <= RUNNER_INPLACE_RESTARTS) Object.assign(m, { restarting: true, restartCount: m.windowCrashes, exitRestarted: true });
            else Object.assign(m, { alive: false, restarting: false, restartCount: RUNNER_INPLACE_RESTARTS, exitRestarted: false });
            if (ev === "restart_polled") observeOnce(w);
          }
          break;
        case "signalled":   // a platform stop: SIGTERM → the `signalled` drain → exit 0, which Fly never restarts
          if (m?.alive) {
            signalledStops++;
            finalBeatOf(w, "signalled");
            Object.assign(m, { alive: false, restarting: false, exit: { exitCode: 0, oomKilled: false, requestedStop: false }, exitAt: w.at, restartCount: null, exitRestarted: false });
          }
          break;
        case "restart_done":   // F-007: ~1.4 s after the exit Fly has the process running again; the exit stays its newest
          if (m?.alive && m.restarting) m.restarting = false;
          break;
        case "observe": observeOnce(w); break;
        case "wait_played": expire(w); break;
        case "destroy_ok":
          if (w.destroyFor !== null && w.destroyFor === w.s.runner.name) {
            const target = w.machines.find((x) => x.name === w.destroyFor);
            if (target) Object.assign(target, { alive: false, restarting: false });
            w.destroyFor = null;
            step(w, { type: "runner", trigger: { type: "destroy_ok" } });
          }
          break;
        case "late_retry":
          step(w, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, w.s.runner.attempt + 1), attempt: w.s.runner.attempt + 1 } });
          break;
      }
      // the oracles, after every event
      const n = w.s.runner.crashes.count;
      checks++;
      const at = w.path.join(" → ");
      if (n > w.made) violations.push(`${at}: ${n} counted of ${w.made} crashes made (double count)`);
      if (n < Math.max(w.beats, w.exits.size)) violations.push(`${at}: ${n} counted, but ${w.beats} crash beats and ${w.exits.size} crash exits were handed over`);
      if (n >= RUNNER_CRASH_CAP && !isTerminal(w.s.state)) violations.push(`${at}: ${n} crashes and the session is still ${w.s.state}`);
      return w;
    };
    const walk = (w: World, depth: number): void => {
      if (depth === DEPTH) {
        orders++;
        if (w.s.runner.crashes.count >= RUNNER_CRASH_CAP) { capped++; if (w.s.runner.attempt > 1) cappedOnRetry++; if (w.path.includes("restart_polled")) cappedAfterRestart++; }
        return;
      }
      for (const ev of ALPHABET) walk(apply(w, ev), depth + 1);
    };
    walk({ s: liveComposed(), at: 0, machines: [{ name: machineNameFor(SID, 1), alive: true, restarting: false, windowCrashes: 0, restarts: 0, exit: null, exitAt: null, restartCount: null, exitRestarted: null }], destroyFor: null, made: 0, beats: 0, beaten: new Set(), exits: new Set(), path: [] }, 0);
    console.info(`R2003b crash_cap_sweep — orders checked: ${orders}, oracle checks: ${checks}, creates checked: ${createsChecked}, orders ending capped: ${capped} (${cappedOnRetry} on the retry, ${cappedAfterRestart} with a restart), dedupe chances: ${dedupes}, signalled stops: ${signalledStops}, crash exits read while running: ${runningExits}, restarts polled: ${restartsPolled}, restarts unread: ${restartsUnread}, crashes read after a restart: ${crashesAfterRestart}, after an unread one: ${crashesAfterUnread}`);
    expect(violations.slice(0, 5), `${violations.length} violations`).toEqual([]);
    expect(orders, "anti-vacuity: every order of the alphabet was walked").toBe(ALPHABET.length ** DEPTH);
    expect(createsChecked, "a create was reached and checked").toBeGreaterThan(0);
    expect(capped, "the cap was reached").toBeGreaterThan(0);
    expect(cappedOnRetry, "…on the retry too (the count spans attempts)").toBeGreaterThan(0);
    expect(dedupes, "one crash was handed over twice").toBeGreaterThan(0);
    expect(signalledStops, "a platform stop was exercised").toBeGreaterThan(0);
    expect(runningExits, "a crash was read only after its restart completed (I2)").toBeGreaterThan(0);
    expect(restartsPolled, "Owed 66: an in-place restart was exercised").toBeGreaterThan(0);
    expect(restartsUnread, "Owed 66 review m1: …and one whose exit no read saw before the next exit").toBeGreaterThan(0);
    expect(crashesAfterUnread, "…and a crash exit was read in such a window (only the restart's BEAT could have dropped the floor there)").toBeGreaterThan(0);
    expect(crashesAfterRestart, "Owed 66: …and a crash was read in a window that held one (the restart-count floor's case)").toBeGreaterThan(0);
    expect(cappedAfterRestart, "Owed 66: …and the cap is still reached in orders that held a restart").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Owed 66 (compositor `docs/_INDEX.md`, C11b "as built" decision (2) and (5)): the compositor RESTARTS ITSELF IN PLACE on a
// dead CEF zygote, repeated GPU-process deaths or 3 leaked teardowns. It sends a final beat (`exitReason: restart`) and
// exits 75; Fly's `on-failure` restarts the process on the SAME Machine. That is not a crash, but R2003b counted it three
// ways — the `fatal` beat, the non-zero exit, and Fly's `restart_count` floor — so RUNNER_CRASH_CAP failed the session at the
// third restart-or-crash. Expected counts below are the crashes each scenario MAKES (a restart makes none); the exit codes
// are the compositor's (C06: Fatal 70, Refused 78; C11b: Restart 75), never read off the code under test.
// What it deliberately does NOT do: cap the restarts. A slow loop of them has no cap (the row's owner question).
// ---------------------------------------------------------------------------------------------------------------------
describe("Owed 66 — the in-place restart (final beat `restart`, exit 75) is recorded and never counted as a crash", () => {
  /** An observation of the in-place restart's exit: Fly restarting it (k-th exit of the window carries restart_count k). */
  const restartExit = (state: (typeof OBSERVED_STATES)[number], exitAt: Date, restartCount: number | null, restarting = true, exitRestarted: boolean | null = restarting): RunnerTrigger =>
    crashExit(state, exitAt, restartCount, restarting, RESTART_EXIT, exitRestarted);

  it("the word: `restart` is in the beat vocabulary and routes to its OWN trigger (never a crash, never a stop — the ledger names what happened); `signalled` stays record only and `fatal` keeps counting — the empty case (no reason) and every reason are checked", () => {
    expect(BEAT_EXIT_REASONS).toContain("restart");
    expect(stoppedBeatTrigger("restart"), "noted, never counted: not `callback_crashed`").toEqual({ type: "callback_restarted" });
    expect(stoppedBeatTrigger("signalled"), "the differential: a platform stop is still record only").toBeNull();
    expect(stoppedBeatTrigger("fatal"), "the differential: a fatal run is still one crash").toEqual({ type: "callback_crashed" });
    expect(stoppedBeatTrigger(undefined), "the empty case: no reason is today's lost → retry").toEqual({ type: "callback_stopped" });
    // The Owed 37 guard (`closesAttempt`) asks one more question of the word: does a process of THIS attempt come back to
    // beat? The rulings, typed: Fly restarts a fatal run AND a restart IN PLACE on the same attempt; every other reason
    // ends the run, the attempt or the session (R2003 / R2003b / this row).
    const COMES_BACK: Record<BeatExitReason | "absent" | "null", boolean> = {
      absent: false, null: false, ended: false, deadline: false, signalled: false, session_gone: false, refused: false,
      fatal: true, restart: true,
    };
    expect(Object.keys(COMES_BACK).sort(), "every reason is decided").toEqual([...BEAT_EXIT_REASONS, "absent", "null"].sort());
    let checked = 0;
    for (const [label, want] of Object.entries(COMES_BACK)) {
      const reason = label === "absent" ? undefined : label === "null" ? null : label as BeatExitReason;
      expect(restartsInPlaceAfter(reason), label).toBe(want);
      checked++;
    }
    expect(checked).toBe(BEAT_EXIT_REASONS.length + 2);
  });

  it("the row's sequence: restart, restart, crash in ONE Fly window is ONE crash, and the session LIVES — lost → destroyed → the ONE retry (the replacement carries the 1, not 3); without the restarts' evidence the same final exit is the 3 crashes F-007 measured", () => {
    const w = sim();
    let at = 0;
    for (let k = 1; k <= RUNNER_INPLACE_RESTARTS; k++) {
      at += 20;
      finalBeat(w, at, "restart");                                                      // the compositor's own word: noted, never counted
      feed(w, { type: "runner", trigger: restartExit("pending", sec(at), k) }, at);     // F-007: exit k of the window carries restart_count k
      feed(w, { type: "runner", trigger: restartExit("pending", sec(at), k) }, at);     // …read again: the same exit
      beat(w, at += BEAT_S, "starting");
      beat(w, at += BEAT_S, "playing");
      expect(w.s, `after restart ${k}`).toMatchObject({ state: "live", failReason: null, runner: { state: "playing", attempt: 1, crashes: { count: 0, beats: 0, exits: 0, restartSeen: true } } });
      expect(w.effects, `after restart ${k}: nothing torn down`).toEqual([]);
    }
    // the crash: Fly's FINAL exit for the window (restarting false, restart_count max_retries — F-007 M1/M3)
    at += 20;
    feed(w, { type: "runner", trigger: crashExit("stopped", sec(at), RUNNER_INPLACE_RESTARTS, false, CRASH_EXIT, false) }, at);
    expect(w.s, "ONE crash — not RUNNER_CRASH_CAP").toMatchObject({ state: "live", failReason: null, runner: { state: "lost", attempt: 1, crashes: { count: 1, exits: 1 } } });
    expect(w.effects, "Fly will not restart it: the lost Machine is torn down").toEqual(["force_destroy"]);
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, at + 1);
    expect(w.creates.map((c) => c.attempt), "the ONE retry").toEqual([2]);
    expect(w.s, "the session lives; the replacement starts from 1 crash with its own (empty) evidence").toMatchObject({
      state: "live", failReason: null, runner: { state: "booting", attempt: 2, crashes: { count: 1, beats: 0, exits: 0, restartSeen: false } },
    });
    // the differential: the SAME final exit with no restart evidence is the 3 crashes (the floor still protects a beat-less loop)
    const noEvidence = stepRunner(inState("playing"), crashExit("stopped", sec(at), RUNNER_INPLACE_RESTARTS, false, CRASH_EXIT, false), sec(at));
    expect(noEvidence.next.crashes.count, "F-007: restart_count 2 on the final exit after 3 crashes").toBe(RUNNER_INPLACE_RESTARTS + 1);
    expect(noEvidence.signal).toEqual({ type: "failed", reason: "machine_crash" });
  });

  it("three REAL crashes still reach the cap with restarts between them — counts 0,1,1,2,2,3 over restart, crash, restart, crash, restart, crash — and the third crash fails machine_crash, torn down, no retry (each crash seen by its beat AND its exit, each restart by its beat AND its exit)", () => {
    const w = sim();
    let at = 0;
    const counts: number[] = [];
    const cycle = (kind: "restart" | "crash", n: number) => {
      at += 20;
      if (kind === "restart") {
        finalBeat(w, at, "restart");
        feed(w, { type: "runner", trigger: restartExit("pending", sec(at), 1) }, at);   // a SLOW loop: Fly's window refilled, restart_count 1 each time
      } else {
        finalBeat(w, at, "fatal");
        if (n < RUNNER_CRASH_CAP) feed(w, { type: "runner", trigger: crashExit("pending", sec(at), 1) }, at);   // the same crash's exit
      }
      counts.push(w.s.runner.crashes.count);
      if (!isTerminal(w.s.state)) { beat(w, at += BEAT_S, "starting"); beat(w, at += BEAT_S, "playing"); }
    };
    cycle("restart", 0); cycle("crash", 1); cycle("restart", 1); cycle("crash", 2); cycle("restart", 2); cycle("crash", RUNNER_CRASH_CAP);
    expect(counts, "a restart moves nothing; each crash moves the count by exactly one").toEqual([0, 1, 1, 2, 2, RUNNER_CRASH_CAP]);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { state: "lost", attempt: 1, crashes: { count: RUNNER_CRASH_CAP, restartSeen: true } } });
    expect(w.effects, "torn down at the cap, once").toEqual(["force_destroy"]);
    expect(w.creates, "no retry, though attempt 1 had one").toEqual([]);
  });

  it("a SLOW beat-less crash loop that has seen a restart is still counted by its exits, one per distinct exit (the floor is dropped, the identity count is not): restart, then 3 silent crashes fail machine_crash on the third", () => {
    let r = inState("playing");
    r = stepRunner(r, restartExit("running", crashAt(1), 1, false, true), crashAt(1)).next;
    expect(r.crashes, "premise: a restart was read").toMatchObject({ count: 0, restartSeen: true });
    const counts: number[] = [];
    let last: ReturnType<typeof stepRunner> | null = null;
    for (let k = 2; k <= RUNNER_CRASH_CAP + 1; k++) {
      // a runtime crash Fly restarted at once, read by the restarted process's own GET: running, the previous run's exit
      last = stepRunner(r, crashExit("running", crashAt(k), 1, false, CRASH_EXIT, true), crashAt(k));
      r = last.next;
      counts.push(r.crashes.count);
      expect(last.signal === null, `crash ${k - 1}`).toBe(k - 1 < RUNNER_CRASH_CAP);
      if (last.signal) break;
    }
    expect(counts).toEqual([1, 2, RUNNER_CRASH_CAP]);
    expect(last!.signal).toEqual({ type: "failed", reason: "machine_crash" });
  });

  it("the INTERIM beat (`fatal` + exit 75 — what the compositor sends until it re-vendors the contract) counts as a crash by its BEAT exactly as before, the exit 75 beside it adds no second crash, and an exit 75 whose beat never arrived counts nothing; so interim restarts still reach the cap, one each", () => {
    const w = sim();
    let at = 0;
    for (let k = 1; k < RUNNER_CRASH_CAP; k++) {
      at += 20;
      finalBeat(w, at, "fatal");                                                           // interim: `fatal`, exitDetail `restart in place: …`
      feed(w, { type: "runner", trigger: restartExit("pending", sec(at), k) }, at);       // …and the exit is 75
      feed(w, { type: "runner", trigger: restartExit("pending", sec(at), k) }, at);
      beat(w, at += BEAT_S, "starting");
      beat(w, at += BEAT_S, "playing");
      expect(w.s.runner.crashes, `interim restart ${k}`).toMatchObject({ count: k, beats: k, exits: 0, restartSeen: true });
    }
    at += 20;
    finalBeat(w, at, "fatal");
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { crashes: { count: RUNNER_CRASH_CAP } } });
    // the beat lost (best-effort, never retried): the exit 75 alone is no crash, where before this row it was one
    const beatless = stepRunner(inState("playing"), restartExit("pending", sec(1), 1), sec(1));
    expect(beatless.next.crashes.count).toBe(0);
    expect(stepRunner(inState("playing"), crashExit("pending", sec(1), 1), sec(1)).next.crashes.count, "the differential: a crash exit is one").toBe(1);
  });

  it("exit 75 is exempted BEFORE the provider's restart flags are read: restarting now, restarted and read running, Fly's final exit, no record either way — none counts, and the same flags on a crash exit do (the differential); the unrecorded read (stopped, restarting null) makes no claim on EITHER exit: the runner stays, nothing is counted, nothing is noted", () => {
    // claims: does the read say anything about the exit? F-007 race: `stopped` read before the provider recorded the exit
    // (restarting null) is not knowable yet — the stale window decides — so it claims nothing, a 75 or a crash alike.
    const FLAGS: [state: (typeof OBSERVED_STATES)[number], restarting: boolean | null, exitRestarted: boolean | null, claims: boolean][] = [
      ["pending", true, true, true], ["stopped", true, true, true], ["running", false, true, true], ["stopped", false, false, true], ["destroyed", false, false, true],
      ["destroying", false, null, true], ["stopping", false, null, true],
      ["stopped", null, null, false],   // review m2: the unrecorded read
    ];
    let checked = 0, claimed = 0;
    for (const [state, restarting, exitRestarted, claims] of FLAGS) {
      const label = `${state}/${restarting}/${exitRestarted}`;
      const restart = stepRunner(inState("playing"), crashExit(state, crashAt(1), null, restarting, RESTART_EXIT, exitRestarted), crashAt(1));
      expect(restart.next.crashes.count, `${label}: restart`).toBe(0);
      expect(restart.next.crashes.exits, `${label}: restart`).toBe(0);
      expect(restart.next.crashes.restartSeen, `${label}: restart — noted only when the read claims the exit`).toBe(claims);
      const crash = stepRunner(inState("playing"), crashExit(state, crashAt(1), null, restarting, CRASH_EXIT, exitRestarted), crashAt(1));
      expect(crash.next.crashes.count, `${label}: crash`).toBe(claims ? 1 : 0);
      if (!claims) {
        expect(restart.next.state, `${label}: restart — no claim, the runner stays`).toBe("playing");
        expect(crash.next.state, `${label}: crash — no claim, the runner stays`).toBe("playing");
        claimed++;
      }
      checked++;
    }
    expect(checked).toBe(FLAGS.length);
    expect(claimed, "the unrecorded read was exercised").toBe(1);
  });

  it("the restart-count FLOOR counts crash restarts only: once this attempt has read a restart, a final exit with F-007's restart_count 2 is ONE crash (its own exit), a restarting one is one, an exit with no identity is none; with no restart read it is 3 / 2 / 2 as before", () => {
    const MEASURED = { final: RUNNER_INPLACE_RESTARTS };   // F-007 M1/M3: restart_count 2 on the final exit after 3 crashes
    const CASES: [label: string, trigger: RunnerTrigger, withoutRestart: number, withRestart: number][] = [
      ["Fly's final exit (restart_count 2, not restarted)", crashExit("stopped", crashAt(5), MEASURED.final, false, CRASH_EXIT, false), MEASURED.final + 1, 1],
      ["a restarting exit (restart_count 2)", crashExit("pending", crashAt(5), MEASURED.final), MEASURED.final, 1],
      ["a restarting exit (restart_count 1)", crashExit("pending", crashAt(5), 1), 1, 1],
      ["an exit with no identity (restart_count 2, no instant)", { ...(crashExit("pending", crashAt(5), MEASURED.final) as Extract<RunnerTrigger, { type: "observed" }>), exitAt: null }, MEASURED.final, 0],
    ];
    let checked = 0;
    for (const [label, trigger, without, withIt] of CASES) {
      for (const from of ["playing", "booting"] as const) {
        const none = stepRunner(R({ ...inState(from), crashes: tally({ restartSeen: false }) }), trigger, crashAt(5)).next.crashes;
        const seen = stepRunner(R({ ...inState(from), crashes: tally({ restartSeen: true }) }), trigger, crashAt(5)).next.crashes;
        expect(none.count, `${from}: ${label}: no restart read`).toBe(without);
        expect(seen.count, `${from}: ${label}: a restart read`).toBe(withIt);
        expect(seen.restartSeen, `${from}: ${label}: the bit stays`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(CASES.length * 2);
    expect(RUNNER_INPLACE_RESTARTS + 1, "premise: the cap is one more than Fly's restarts, so the unfixed floor caps on ONE crash").toBe(RUNNER_CRASH_CAP);
  });

  it("review m1 — the `restart` BEAT notes the restart on its own: booting and playing set `restartSeen`, never move the CRASH tally, and (Owed 67) count ONE restart each — a second beat is a second restart; stopping, exited and lost take it as a no-op; none/creating/destroyed refuse it — every state is checked", () => {
    const BEAT: RunnerTrigger = { type: "callback_restarted" };
    const held = tally({ count: 1, beats: 1, exits: 0, exitAt: crashAt(1) });   // a non-trivial tally: one crash already counted
    const states = ["booting", "playing", "stopping", "exited", "lost", "none", "creating", "destroyed"] as const;
    expect([...states].sort(), "every runner state is decided").toEqual([...RUNNER_STATES].sort());
    let noted = 0, noop = 0, refused = 0;
    for (const from of states) {
      const before = R({ ...inState(from), crashes: held });
      if (from === "booting" || from === "playing") {
        const step = stepRunner(before, BEAT, T0);
        expect(step.next, from).toEqual({ ...before, crashes: { ...held, restartSeen: true, restarts: { count: 1, beats: 1, exits: 0, exitAt: null } } });
        expect(step.effects, `${from}: nothing torn down or created`).toEqual([]);
        expect(step.signal, `${from}: the session hears nothing`).toBeNull();
        // Owed 67: each beat is one restart — the beat of the NEXT restart is not a re-send of this one
        expect(stepRunner(step.next, BEAT, T0).next.crashes.restarts, `${from}: a second beat is a second restart`).toEqual({ count: 2, beats: 2, exits: 0, exitAt: null });
        noted++;
      } else if (from === "stopping" || from === "exited" || from === "lost") {
        expect(stepRunner(before, BEAT, T0), `${from}: a no-op`).toEqual({ next: before, effects: [], signal: null });
        noop++;
      } else {
        expect(() => stepRunner(before, BEAT, T0), from).toThrow(InvalidRunnerTransition);
        refused++;
      }
    }
    expect([noted, noop, refused]).toEqual([2, 3, 3]);
    // the differential: a CRASH beat from the same state moves the crash count and not the restart count — the restart beat is the converse
    expect(stepRunner(R({ ...inState("playing"), crashes: held }), CRASHED, T0).next.crashes, "a fatal beat is a second crash, no restart").toMatchObject({ count: 2, restarts: NO_RESTARTS });
    expect(stepRunner(R({ ...inState("playing"), crashes: held }), BEAT, T0).next.crashes.count, "a restart beat is no crash").toBe(1);
  });

  it("review m1/m3 — a restart whose exit 75 NO read ever saw is noted by its BEAT: restart, restart (beats only), then the crash's final exit (restart_count 2, not restarted) before any read is ONE crash and the session lives on the ONE retry; with the beat lost as well the same exit is the 3 crashes (the residual, pinned, for that window only)", () => {
    const w = sim();
    let at = 0;
    for (let k = 1; k <= RUNNER_INPLACE_RESTARTS; k++) {
      at += 20;
      finalBeat(w, at, "restart");                      // the beat goes out before the exit; the exit is never read
      beat(w, at += BEAT_S, "starting");
      beat(w, at += BEAT_S, "playing");
      expect(w.s.runner.crashes, `after restart ${k}`).toEqual({ ...CRASHES_NONE, restartSeen: true, restarts: { count: k, beats: k, exits: 0, exitAt: null } });   // Owed 67: counted by its beat, once each
    }
    at += 20;
    feed(w, { type: "runner", trigger: crashExit("stopped", sec(at), RUNNER_INPLACE_RESTARTS, false, CRASH_EXIT, false) }, at);   // the FIRST exit anyone reads
    expect(w.s, "ONE crash — not the 3 the unnoted floor reads").toMatchObject({ state: "live", failReason: null, runner: { state: "lost", attempt: 1, crashes: { count: 1, exits: 1 } } });
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, at + 1);
    expect(w.creates.map((c) => c.attempt), "the ONE retry").toEqual([2]);
    // the residual: no beat (lost, best-effort) and no read — nothing noted the restarts, so the floor stands
    const residual = stepRunner(inState("playing"), crashExit("stopped", sec(at), RUNNER_INPLACE_RESTARTS, false, CRASH_EXIT, false), sec(at));
    expect(residual.next.crashes.count, "the pre-fix over-count, for that window only").toBe(RUNNER_INPLACE_RESTARTS + 1);
    expect(residual.signal).toEqual({ type: "failed", reason: "machine_crash" });
  });

  it("an exit 75 read on any state that carries an exit sets `restartSeen`, counts NO crash and (Owed 67) ONE restart — from playing, booting and lost, each state, a re-read changing nothing; no other exit sets or counts it (clean 0, a crash, OOM, the refusal 78, 74, 76, no exit) and a stop in flight ignores it", () => {
    const NOT_RESTARTS: [string, ExitInfo | null][] = [
      ["no exit", null], ["clean (0)", { exitCode: 0, oomKilled: false, requestedStop: false }], ["a crash (1)", CRASH_EXIT],
      ["OOM-killed (137)", { exitCode: 137, oomKilled: true, requestedStop: false }], ["the refusal (78)", REFUSED_EXIT],
      ["74", { exitCode: RELAY_EXIT_RESTART - 1, oomKilled: false, requestedStop: false }], ["76", { exitCode: RELAY_EXIT_RESTART + 1, oomKilled: false, requestedStop: false }],
    ];
    let seen = 0, unset = 0;
    for (const from of ["playing", "booting", "lost"] as const) {
      for (const [state, restarting] of [["pending", true], ["stopped", true], ["running", false], ["destroying", false], ["unknown", false], ["failed", false], ["destroyed", false]] as const) {
        const t = crashExit(state, crashAt(1), 1, restarting, RESTART_EXIT, restarting || state === "running");
        const first = stepRunner(inState(from), t, crashAt(1));
        const COUNTED = { ...CRASHES_NONE, restartSeen: true, restarts: { count: 1, beats: 0, exits: 1, exitAt: crashAt(1) } };
        expect(first.next.crashes, `${from} × ${state}`).toEqual(COUNTED);
        const again = stepRunner(first.next, t, crashAt(1));
        expect(again.next.crashes, `${from} × ${state}: read again`).toEqual(COUNTED);
        seen++;
      }
      for (const [label, exit] of NOT_RESTARTS) {
        const step = stepRunner(inState(from), crashExit("pending", crashAt(1), 1, true, exit as ExitInfo, true), crashAt(1));
        expect(step.next.crashes.restartSeen, `${from} × ${label}`).toBe(false);
        expect(step.next.crashes.restarts, `${from} × ${label}: no restart counted`).toEqual(NO_RESTARTS);
        unset++;
      }
    }
    for (const stop of ["stopping", "exited"] as const) {   // after OUR stop: nothing on this runner is tallied
      expect(stepRunner(inState(stop), restartExit("stopped", crashAt(1), 1, false, false), crashAt(1)).next.crashes, stop).toEqual(CRASHES_NONE);
    }
    expect(seen).toBe(3 * 7);
    expect(unset).toBe(3 * NOT_RESTARTS.length);
  });

  it("a restart Fly will NOT restart (its window's third exit is a 75 — the row's Owed 67) is a LOSS, not a crash: lost → torn down → the ONE retry, nothing counted; the replacement's tally starts clean (restartSeen reset) with the session's count carried", () => {
    const w = sim();
    feed(w, { type: "runner", trigger: restartExit("stopped", sec(10), RUNNER_INPLACE_RESTARTS, false, false) }, 10);
    expect(w.s.runner, "a loss, uncounted").toMatchObject({ state: "lost", crashes: { count: 0, exits: 0, restartSeen: true } });
    expect(w.effects).toEqual(["force_destroy"]);
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, 11);
    expect(w.creates.map((c) => c.attempt), "the ONE retry").toEqual([2]);
    expect(w.s).toMatchObject({ state: "live", failReason: null, runner: { state: "booting", attempt: 2, crashes: { count: 0, beats: 0, exits: 0, restartSeen: false } } });
    // the reset is the new attempt's: its floor is back, so the 3-crash final exit (F-007) caps it again
    const capped = stepRunner(R({ ...inState("playing"), attempt: 2, crashes: w.s.runner.crashes }), crashExit("stopped", sec(30), RUNNER_INPLACE_RESTARTS, false, CRASH_EXIT, false), sec(30));
    expect(capped.signal).toEqual({ type: "failed", reason: "machine_crash" });
  });

  it("create_started clears THIS attempt's restart evidence and keeps the session's crash AND restart counts (and both exit identities) — a retry boots a new Machine with its own Fly window", () => {
    const destroyed = R({ state: "destroyed", attempt: 1, name: "relay-s1-r1", machineId: "m1", crashes: tally({ count: 1, beats: 1, exits: 1, exitAt: crashAt(1), restartSeen: true, restarts: { count: 2, beats: 2, exits: 1, exitAt: crashAt(3) } }) });
    const next = stepRunner(destroyed, { type: "create_started", name: machineNameFor(SID, 2), attempt: 2 }, T0).next;
    expect(next.crashes).toEqual({ count: 1, beats: 0, exits: 0, exitAt: crashAt(1), restartSeen: false, restarts: { count: 2, beats: 0, exits: 0, exitAt: crashAt(3) } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Owed 67 (OWNER RULING 2026-10-20): "cap the compositor's in-place self-restarts at 6 per stream session. When the 7th restart
// arrives, the session ends." A restart is not a crash (Owed 66), so RUNNER_CRASH_CAP never saw a compositor stuck restarting
// itself every ~165 s: viewers got a ~15 s outage every few minutes for the rest of the stream. The tally counts a restart the
// way the crash tally counts a crash — its final beat and its exit 75 are two lower bounds on the attempt, counted by their MAX —
// and the session ends through the crash cap's own path (failed machine_crash, the Machine force-destroyed, no retry).
// Every expected count below is the number of restarts the scenario MAKES (never read off the tally under test); the numbers
// 6 and 7 are the ruling's, via RUNNER_RESTART_CAP (config.test.ts pins the constant to the ruling's words).
// ---------------------------------------------------------------------------------------------------------------------
describe("Owed 67 — the restart cap: a SESSION survives RUNNER_RESTART_CAP in-place restarts and the next one ends it", () => {
  const RESTARTED: RunnerTrigger = { type: "callback_restarted" };
  const CAP_ENDS: SessionSignal = { type: "failed", reason: "machine_crash" };
  /** A restart's exit as the provider records it, at its own instant: mid-restart (`pending`, Fly restarting it) or read after the
   *  restart completed (`running`: the restarted process's own GET reads the previous run's exit — how a restart is witnessed). */
  const exit75 = (state: (typeof OBSERVED_STATES)[number], exitAt: Date, restartCount = 1): RunnerTrigger =>
    state === "running" ? crashExit(state, exitAt, restartCount, false, RESTART_EXIT, true) : crashExit(state, exitAt, restartCount, true, RESTART_EXIT);
  const heldRestarts = (count: number, over: Partial<CrashTally["restarts"]> = {}): CrashTally =>
    tally({ restarts: { count, beats: 0, exits: count, exitAt: count > 0 ? crashAt(count) : null, ...over } });

  it("the SEQUENCE through decide, restart BEATS alone: RUNNER_RESTART_CAP restarts leave the session live with nothing torn down; the next fails machine_crash, force-destroys the Machine once and spends NO retry, though attempt 1 had one", () => {
    expect(RUNNER_MAX_ATTEMPTS, "premise: attempt 1 has a retry the cap must not spend").toBeGreaterThan(1);
    const w = sim();
    let at = 0;
    for (let k = 1; k <= RUNNER_RESTART_CAP; k++) {
      at += 20;
      finalBeat(w, at, "restart");                                         // restart k's final beat…
      beat(w, at += BEAT_S, "starting");                                   // …and the restarted process comes back
      beat(w, at += BEAT_S, "playing");
      expect(w.s, `after restart ${k}`).toMatchObject({ state: "live", failReason: null, runner: { state: "playing", attempt: 1, crashes: { count: 0, restarts: { count: k, beats: k, exits: 0 } } } });
      expect(w.effects, `after restart ${k}: nothing torn down`).toEqual([]);
    }
    at += 20;
    finalBeat(w, at, "restart");                                           // restart RUNNER_RESTART_CAP + 1
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", endReason: null, runner: { state: "lost", attempt: 1, crashes: { count: 0, restarts: { count: RUNNER_RESTART_CAP + 1 } } } });
    expect(w.effects, "the Machine Fly would restart again is torn down, once").toEqual(["force_destroy"]);
    // its own exit, read afterwards: the SAME restart — nothing moves, nothing is signalled again
    const ended = w.s;
    feed(w, { type: "runner", trigger: exit75("pending", sec(at)) }, at + 1);
    expect(w.s.runner.crashes.restarts.count, "the exit of the restart already counted by its beat").toBe(RUNNER_RESTART_CAP + 1);
    expect(w.s.state).toBe(ended.state);
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, at + 2);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runnerRetries: 0, runner: { state: "destroyed", attempt: 1 } });
    expect(w.creates, "no retry, ever").toEqual([]);
    expect(w.effects).not.toContain("retry_runner");
    expect(w.effects.filter((e) => e === "force_destroy"), "torn down once").toHaveLength(1);
    expect(() => decide(w.s, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, 2), attempt: 2 } }, sec(at + 3)), "a late retry_runner is refused").toThrow();
    expect(() => decide(w.s, { type: "runner", trigger: RESTARTED }, sec(at + 4)), "a restart beat on the ended session is refused — the route answers it 200 and writes nothing").toThrow(InvalidTransition);
  });

  it("ONE restart seen BOTH ways counts once — its beat then its exit, and its exit then its beat — and re-reading that exit never counts it again, at EVERY restart up to and including the one that ends the session", () => {
    let checked = 0;
    for (const order of ["beat first", "exit first"] as const) {
      let r = inState("playing");
      for (let k = 1; k <= RUNNER_RESTART_CAP + 1; k++) {
        const exit = exit75("pending", crashAt(k));
        const steps: RunnerTrigger[] = order === "beat first" ? [RESTARTED, exit, exit] : [exit, exit, RESTARTED];
        for (const [i, t] of steps.entries()) {
          const step = stepRunner(r, t, crashAt(k));
          r = step.next;
          expect(r.crashes.restarts.count, `${order}, restart ${k}, step ${i}: restarts made so far`).toBe(k);
          // the restart that exceeds the cap ends the session at the FIRST evidence of it, whichever kind that is, and never again
          expect(step.signal, `${order}, restart ${k}, step ${i}`).toEqual(k > RUNNER_RESTART_CAP && i === 0 ? CAP_ENDS : null);
          checked++;
        }
        if (k <= RUNNER_RESTART_CAP) expect(r.state, `${order}, restart ${k}: an in-place restart, not a loss`).toBe("playing");
      }
      expect(r.state, `${order}: the session's runner is torn down at the cap`).toBe("lost");
    }
    expect(checked).toBe(2 * 3 * (RUNNER_RESTART_CAP + 1));
  });

  it("each restart seen by only ONE kind of evidence is counted once too — beats alone (their exits never read), exits alone (their beats lost) mid-restart, stopped, or read after the restart completed: RUNNER_RESTART_CAP are survived on every road and the next ends the session, its Machine force-destroyed", () => {
    const ROADS: [label: string, evidence: (k: number) => RunnerTrigger][] = [
      ["beats alone", () => RESTARTED],
      ["exits alone, mid-restart", (k) => exit75("pending", crashAt(k))],
      ["exits alone, stopped mid-restart", (k) => exit75("stopped", crashAt(k))],
      ["exits alone, read after the restart completed", (k) => exit75("running", crashAt(k))],
    ];
    let checked = 0;
    for (const [label, evidence] of ROADS) for (const from of ["playing", "booting"] as const) {
      let r = inState(from);
      for (let k = 1; k <= RUNNER_RESTART_CAP; k++) {
        const step = stepRunner(r, evidence(k), crashAt(k));
        r = step.next;
        expect(step.signal, `${label} from ${from}: restart ${k} is survived`).toBeNull();
        expect(r.state, `${label} from ${from}: restart ${k}`).toBe(from);
        expect(r.crashes.restarts.count, `${label} from ${from}: restart ${k}`).toBe(k);
        expect(r.crashes.count, `${label} from ${from}: a restart is no crash`).toBe(0);
        checked++;
      }
      const last = stepRunner(r, evidence(RUNNER_RESTART_CAP + 1), crashAt(RUNNER_RESTART_CAP + 1));
      expect(last, `${label} from ${from}: the next restart`).toMatchObject({ next: { state: "lost" }, effects: [{ type: "force_destroy" }], signal: CAP_ENDS });
      checked++;
    }
    expect(checked).toBe(ROADS.length * 2 * (RUNNER_RESTART_CAP + 1));
  });

  // TEST-STRATEGY rule 4: a known gap is a pinned test, not a comment. The two bounds are counted by their MAX (the crash tally's
  // rule), so mixed evidence can undercount — in the safe direction: the session ends a restart LATE, never early.
  it("the KNOWN residual, pinned: mixed evidence undercounts — restart 1 seen only by its beat and restart 2 only by its exit are 2 restarts made and 1 counted; a count can only ever be at or BELOW the restarts made", () => {
    let r = inState("playing");
    r = stepRunner(r, RESTARTED, crashAt(1)).next;                          // restart 1: its beat; its exit is overwritten before any read
    r = stepRunner(r, exit75("running", crashAt(2)), crashAt(2)).next;      // restart 2: its beat was lost; its exit is read
    const made = 2;
    expect(r.crashes.restarts, "max(1 beat, 1 exit), not 2").toMatchObject({ count: 1, beats: 1, exits: 1 });
    expect(r.crashes.restarts.count, "never more than the world made").toBeLessThanOrEqual(made);
  });

  it("restarts ACROSS the retry accumulate — per SESSION, not per attempt: restarts (seen by their beats) → lost at the window → the ONE retry carries them with its own evidence cleared → the rest of the allowance is survived on the replacement (seen by exits alone) → the next ends the session THERE, with exactly one replacement created", () => {
    const before = Math.floor(RUNNER_RESTART_CAP / 2);
    const w = sim();
    let at = 0;
    for (let k = 1; k <= before; k++) { at += 20; finalBeat(w, at, "restart"); beat(w, at += BEAT_S, "playing"); }
    expect(tick(w, at + STALE_HEARTBEAT_SECONDS_COMPOSED), "the restarted process never beats again").toBe("stale_beat");
    const retryAt = at + STALE_HEARTBEAT_SECONDS_COMPOSED + 1;
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, retryAt);
    expect(w.creates.map((c) => c.attempt)).toEqual([2]);
    expect(w.s.runner, "the replacement starts from the restarts already seen, with its own (empty) evidence").toMatchObject({ state: "booting", attempt: 2, crashes: { count: 0, restarts: { count: before, beats: 0, exits: 0 } } });
    at = retryAt + BEAT_S;
    beat(w, at, "playing");
    // the replacement's restarts are seen by their EXITS alone: a beats-bound left over from attempt 1 would hide every one of them
    for (let k = before + 1; k <= RUNNER_RESTART_CAP; k++) {
      at += 20;
      feed(w, { type: "runner", trigger: exit75("running", sec(at)) }, at);
      beat(w, at += BEAT_S, "playing");
      expect(w.s, `restart ${k} (the session's ${k}th)`).toMatchObject({ state: "live", failReason: null, runner: { state: "playing", attempt: 2, crashes: { restarts: { count: k, beats: 0, exits: k - before } } } });
    }
    expect(RUNNER_RESTART_CAP + 1 - before, "premise: the replacement ALONE sees no more than the allowance — a per-attempt cap would never end this session").toBeLessThanOrEqual(RUNNER_RESTART_CAP);
    at += 20;
    feed(w, { type: "runner", trigger: exit75("running", sec(at)) }, at);
    expect(w.s).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { state: "lost", attempt: 2, crashes: { restarts: { count: RUNNER_RESTART_CAP + 1 } } } });
    expect(w.creates.map((c) => c.attempt), "exactly one replacement").toEqual([2]);
  });

  it("the two caps are INDEPENDENT: RUNNER_CRASH_CAP - 1 crashes and RUNNER_RESTART_CAP restarts, in any order, leave the session live and neither moves the other's count — then the NEXT crash ends it, and (a fresh run) so does the next restart", () => {
    const crashesAllowed = RUNNER_CRASH_CAP - 1;
    type Ev = "crash" | "restart";
    const run = (n: number, kind: Ev): Ev[] => Array<Ev>(n).fill(kind);
    const alternating: Ev[] = [];
    for (let i = 0, c = crashesAllowed, r = RUNNER_RESTART_CAP; c + r > 0; i++) { if ((i % 2 === 0 && r > 0) || c === 0) { alternating.push("restart"); r--; } else { alternating.push("crash"); c--; } }
    const ORDERS: [string, Ev[]][] = [
      ["restarts first", [...run(RUNNER_RESTART_CAP, "restart"), ...run(crashesAllowed, "crash")]],
      ["crashes first", [...run(crashesAllowed, "crash"), ...run(RUNNER_RESTART_CAP, "restart")]],
      ["alternating", alternating],
    ];
    let checked = 0;
    for (const [label, events] of ORDERS) for (const ender of ["crash", "restart"] as const) {
      expect(events.filter((e) => e === "crash"), `${label}: premise`).toHaveLength(crashesAllowed);
      expect(events.filter((e) => e === "restart"), `${label}: premise`).toHaveLength(RUNNER_RESTART_CAP);
      const w = sim();
      let at = 0, crashes = 0, restarts = 0;
      for (const ev of [...events, ender]) {
        at += 20;
        finalBeat(w, at, ev === "crash" ? "fatal" : "restart");
        if (ev === "crash") crashes++; else restarts++;
        const tag = `${label} + ${ender}: ${ev} #${ev === "crash" ? crashes : restarts}`;
        const over = crashes >= RUNNER_CRASH_CAP || restarts > RUNNER_RESTART_CAP;
        expect(w.s.runner.crashes.count, `${tag}: crashes made`).toBe(crashes);
        expect(w.s.runner.crashes.restarts.count, `${tag}: restarts made`).toBe(restarts);
        expect(w.s.state, tag).toBe(over ? "failed" : "live");
        if (!over) beat(w, at += BEAT_S, "playing");
        checked++;
      }
      expect(w.s, `${label} + ${ender}`).toMatchObject({ state: "failed", failReason: "machine_crash", runner: { state: "lost", attempt: 1 } });
      expect(w.creates, `${label} + ${ender}: no retry`).toEqual([]);
    }
    expect(checked).toBe(ORDERS.length * 2 * (crashesAllowed + RUNNER_RESTART_CAP + 1));
  });

  it("a restart arriving after the session is STOPPING or ENDED is a no-op: during our own stop the restart that would exceed the allowance changes nothing and the stop COMPLETES (not fails); after the cap ended it, newer restart exits move no count and signal nothing; after a crash-cap end likewise; a destroyed Machine ignores one", () => {
    const atCap = heldRestarts(RUNNER_RESTART_CAP);
    // — stopping / exited runner at the allowance's edge: the beat and every read of a restart exit are record-only
    let checked = 0;
    for (const s of ["stopping", "exited"] as const) {
      const before = R({ ...inState(s), crashes: atCap });
      expect(stepRunner(before, RESTARTED, T0), `${s}: the restart beat`).toEqual({ next: before, effects: [], signal: null });
      for (const state of ["pending", "stopped", "running", "stopping"] as const) {
        const step = stepRunner(before, exit75(state, crashAt(RUNNER_RESTART_CAP + 1)), crashAt(RUNNER_RESTART_CAP + 1));
        expect(step.signal, `${s} × ${state}`).toBeNull();
        expect(step.next.crashes.restarts, `${s} × ${state}: not counted`).toEqual(atCap.restarts);
        checked++;
      }
    }
    // — the same through decide: a live session at the allowance's edge, the organiser stops it, the 7th restart arrives mid-stop
    const w = sim();
    let at = 0;
    for (let k = 1; k <= RUNNER_RESTART_CAP; k++) { at += 20; finalBeat(w, at, "restart"); beat(w, at += BEAT_S, "playing"); }
    expect(w.s.runner.crashes.restarts.count, "premise: at the allowance's edge").toBe(RUNNER_RESTART_CAP);
    feed(w, { type: "stop", reason: "stopped" }, at += 1);
    expect(w.s, "premise: our stop is in flight").toMatchObject({ state: "ending", runner: { state: "stopping" } });
    finalBeat(w, at += 1, "restart");
    feed(w, { type: "runner", trigger: exit75("running", sec(at)) }, at);
    expect(w.s, "the restart that would have exceeded the allowance, during our stop").toMatchObject({ state: "ending", failReason: null, runner: { state: "stopping", crashes: { restarts: { count: RUNNER_RESTART_CAP } } } });
    feed(w, { type: "runner", trigger: { type: "destroy_ok" } }, at += 1);
    expect(w.s, "the stop completes; it is not turned into a failure").toMatchObject({ state: "completed", failReason: null, endReason: "stopped" });
    checked++;
    // — ended by the restart cap: a NEWER restart exit read on the lost runner moves nothing (and no second `failed`)
    const over = R({ ...inState("lost"), crashes: heldRestarts(RUNNER_RESTART_CAP + 1) });
    const later = stepRunner(over, exit75("pending", crashAt(RUNNER_RESTART_CAP + 5)), crashAt(RUNNER_RESTART_CAP + 5));
    expect(later.signal, "ended once").toBeNull();
    expect(later.next.crashes.restarts, "frozen at the restart that ended it").toEqual(over.crashes.restarts);
    checked++;
    // — ended by the CRASH cap: a restart read afterwards is not tallied either (the same freeze, the other cap)
    const crashEnded = R({ ...inState("lost"), crashes: tally({ count: RUNNER_CRASH_CAP, beats: RUNNER_CRASH_CAP }) });
    const afterCrashCap = stepRunner(crashEnded, exit75("pending", crashAt(9)), crashAt(9));
    expect(afterCrashCap.signal).toBeNull();
    expect(afterCrashCap.next.crashes.restarts, "no restart counted after the crash cap ended the session").toEqual(NO_RESTARTS);
    checked++;
    // — a destroyed Machine ignores one
    const destroyed = R({ ...inState("destroyed"), crashes: atCap });
    expect(stepRunner(destroyed, exit75("running", crashAt(RUNNER_RESTART_CAP + 1)), crashAt(RUNNER_RESTART_CAP + 1)), "destroyed").toEqual({ next: destroyed, effects: [], signal: null });
    checked++;
    expect(checked).toBe(2 * 4 + 4);
  });

  it("at the cap on every road out: an exit reaching it (stopped / pending / running / stopping / destroying / unknown / destroyed), a LOST runner's observation crossing it, a confirmed destroy, the C1 stale beat on destroyed — failed machine_crash, never the retry; one short of it each road is today's", () => {
    const short = (from: RunnerState) => R({ ...inState(from), crashes: heldRestarts(RUNNER_RESTART_CAP) });   // RUNNER_RESTART_CAP counted: the next ends it
    const lastOfAllowance = (from: RunnerState) => R({ ...inState(from), crashes: heldRestarts(RUNNER_RESTART_CAP - 1) });
    const next = RUNNER_RESTART_CAP + 1;
    let checked = 0;
    // exits that claim the runner's state (stopped / pending), from a playing and a booting runner
    for (const state of ["stopped", "pending"] as const) for (const from of ["playing", "booting"] as const) {
      const step = stepRunner(short(from), exit75(state, crashAt(next)), crashAt(next));
      expect(step, `${from} × ${state}`).toMatchObject({
        next: { state: "lost", lastExit: RESTART_EXIT, crashes: { count: 0, restarts: { count: next, exits: next, exitAt: crashAt(next) } } },
        effects: [{ type: "force_destroy" }], signal: CAP_ENDS,
      });
      const one = stepRunner(lastOfAllowance(from), exit75(state, crashAt(next)), crashAt(next));
      expect(one, `${from} × ${state}, one short`).toMatchObject({ next: { state: from, crashes: { restarts: { count: RUNNER_RESTART_CAP } } }, effects: [], signal: null });
      checked += 2;
    }
    // reads that make no claim on the runner's state still carry the newest exit (`running`: the run before this one)
    for (const state of ["running", "stopping", "destroying", "unknown"] as const) for (const from of ["playing", "booting"] as const) {
      const t = state === "running" ? exit75("running", crashAt(next)) : crashExit(state, crashAt(next), 1, false, RESTART_EXIT, true);
      const step = stepRunner(short(from), t, crashAt(next));
      expect(step, `${from} × ${state}`).toMatchObject({
        next: { state: "lost", lastExit: state === "running" ? short(from).lastExit : RESTART_EXIT, crashes: { restarts: { count: next } } },
        effects: [{ type: "force_destroy" }], signal: CAP_ENDS,
      });
      expect(stepRunner(lastOfAllowance(from), t, crashAt(next)).signal, `${from} × ${state}, one short`).toBeNull();
      checked += 2;
    }
    // destroyed (Fly gave up and auto-destroyed it): a NEWER restart exit exceeds the allowance; the one already counted does not
    expect(stepRunner(short("playing"), exit75("destroyed", crashAt(next)), crashAt(next))).toMatchObject({ next: { state: "destroyed", crashes: { restarts: { count: next } } }, signal: CAP_ENDS });
    expect(stepRunner(short("playing"), crashExit("destroyed", crashAt(RUNNER_RESTART_CAP), RUNNER_INPLACE_RESTARTS, false, RESTART_EXIT, true), crashAt(next)).signal, "the exit already counted: the retry").toEqual({ type: "retry" });
    checked += 2;
    // lost: an observation that CROSSES the allowance fails the session once; a re-read of it signals nothing more
    const crossing = stepRunner(short("lost"), exit75("pending", crashAt(next)), crashAt(next));
    expect(crossing).toMatchObject({ next: { state: "lost", crashes: { restarts: { count: next } } }, signal: CAP_ENDS });
    expect(stepRunner(crossing.next, exit75("pending", crashAt(next)), crashAt(next)).signal, "the same exit again").toBeNull();
    expect(stepRunner(lastOfAllowance("lost"), exit75("pending", crashAt(next)), crashAt(next)).signal, "one short: nothing").toBeNull();
    checked += 3;
    // a confirmed destroy at the cap, with a retry still left; and one short of it, the retry
    for (const confirm of [{ type: "destroy_ok" }, { type: "observed", state: "destroyed" }] as const) {
      const lostOver = R({ ...inState("lost"), crashes: heldRestarts(next) });
      expect(stepRunner(lostOver, confirm, T0).signal, JSON.stringify(confirm)).toEqual(CAP_ENDS);
      expect(stepRunner(short("lost"), confirm, T0).signal, `${JSON.stringify(confirm)}, one short`).toEqual({ type: "retry" });
      checked += 2;
    }
    // C1: destroyed and still wanted live — the retry that never ran is not re-signalled over the allowance
    const awaiting = R({ state: "destroyed", attempt: 1, name: "relay-s1-r1", machineId: "m1", crashes: heldRestarts(next) });
    expect(stepRunner(awaiting, { type: "stale_beat" }, T0).signal).toEqual(CAP_ENDS);
    expect(stepRunner({ ...awaiting, crashes: heldRestarts(RUNNER_RESTART_CAP) }, { type: "stale_beat" }, T0).signal).toEqual({ type: "retry" });
    checked += 2;
    // the guard: create_started is REFUSED over the allowance even from destroyed with a retry left; at it, the replacement starts
    const t: RunnerTrigger = { type: "create_started", name: machineNameFor("s1", 2), attempt: 2 };
    expect(() => stepRunner({ ...awaiting }, t, T0), "a late retry_runner").toThrow(InvalidRunnerTransition);
    expect(stepRunner({ ...awaiting, crashes: heldRestarts(RUNNER_RESTART_CAP, { beats: 2 }) }, t, T0).next, "at the allowance").toMatchObject({ state: "creating", attempt: 2, crashes: { restarts: { count: RUNNER_RESTART_CAP, beats: 0, exits: 0 } } });
    checked += 2;
    // a fatal beat on an active runner somehow over the allowance ends it too: ONE predicate for both caps
    expect(stepRunner(short("playing"), CRASHED, T0).signal, "at the allowance a fatal beat is a crash, not an ending").toBeNull();
    expect(stepRunner(R({ ...inState("playing"), crashes: heldRestarts(next) }), CRASHED, T0).signal, "…over it, it ends the session").toEqual(CAP_ENDS);
    checked += 2;
    expect(checked).toBe(2 * 2 * 2 + 4 * 2 * 2 + 2 + 3 + 4 + 2 + 2 + 2);
  });

  it("the reason is machine_crash — never machine_oom, even when the runner's last exit was an OOM kill: the restart cap's end says the relay stopped unexpectedly, and the crash cap's capping-OOM end still says machine_oom (the differential)", () => {
    const OOM: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };
    const lostAfterOom = (c: CrashTally) => R({ ...inState("lost"), lastExit: OOM, crashes: c });
    expect(stepRunner(lostAfterOom(heldRestarts(RUNNER_RESTART_CAP + 1)), { type: "destroy_ok" }, T0).signal, "restart cap, last exit OOM").toEqual(CAP_ENDS);
    expect(stepRunner(lostAfterOom(tally({ count: RUNNER_CRASH_CAP, exits: RUNNER_CRASH_CAP, exitAt: crashAt(1) })), { type: "destroy_ok" }, T0).signal, "crash cap, last exit OOM").toEqual({ type: "failed", reason: "machine_oom" });
    // …and through the exit that exceeds the allowance on a runner whose previous exit was the OOM
    const afterOom = R({ ...inState("playing"), lastExit: OOM, crashes: heldRestarts(RUNNER_RESTART_CAP) });
    expect(stepRunner(afterOom, exit75("pending", crashAt(RUNNER_RESTART_CAP + 1)), crashAt(RUNNER_RESTART_CAP + 1)).signal).toEqual(CAP_ENDS);
    // …and through the restart's BEAT, which carries no exit at all (the allowance's six seen by beats, so the next beat is the 7th)
    const afterOomByBeats = R({ ...inState("playing"), lastExit: OOM, crashes: heldRestarts(RUNNER_RESTART_CAP, { beats: RUNNER_RESTART_CAP, exits: 0, exitAt: null }) });
    expect(stepRunner(afterOomByBeats, RESTARTED, T0).signal).toEqual(CAP_ENDS);
    // …and through a LOST runner's observation that crosses the allowance with an exit code 75 that ALSO says it was OOM-killed
    // (the type allows the combination): it is still the restart cap that ends the session, so still machine_crash
    const oomRestartExit = { ...RESTART_EXIT, oomKilled: true };
    const lostShort = R({ ...inState("lost"), crashes: heldRestarts(RUNNER_RESTART_CAP) });
    const crossing = stepRunner(lostShort, crashExit("pending", crashAt(RUNNER_RESTART_CAP + 1), 1, true, oomRestartExit), crashAt(RUNNER_RESTART_CAP + 1));
    expect(crossing.signal, "the restart allowance crossed in `lost` by an OOM-flagged exit 75").toEqual(CAP_ENDS);
    expect(crossing.next.crashes.restarts.count, "premise: that observation is what crossed it").toBe(RUNNER_RESTART_CAP + 1);
  });

  it("the tally's guards: a re-read of an exit and an OLDER one never count; an exit with no instant counts nothing (it still NOTES the restart); a restart exit of a stop someone ASKED for counts nothing — each beside its counted twin", () => {
    let r = inState("playing");
    r = stepRunner(r, exit75("running", crashAt(5)), crashAt(5)).next;
    expect(r.crashes.restarts, "the first sight counts").toMatchObject({ count: 1, exits: 1, exitAt: crashAt(5) });
    r = stepRunner(r, exit75("running", crashAt(5)), crashAt(5)).next;
    expect(r.crashes.restarts.count, "the same instant: a re-read").toBe(1);
    r = stepRunner(r, exit75("running", crashAt(4)), crashAt(5)).next;
    expect(r.crashes.restarts, "an older instant is not new").toMatchObject({ count: 1, exitAt: crashAt(5) });
    r = stepRunner(r, exit75("running", crashAt(6)), crashAt(6)).next;
    expect(r.crashes.restarts.count, "a newer instant is the next restart").toBe(2);
    // no identity: noted, never counted
    const noInstant = stepRunner(inState("playing"), { ...(exit75("running", crashAt(1)) as Extract<RunnerTrigger, { type: "observed" }>), exitAt: null }, crashAt(1));
    expect(noInstant.next.crashes, "noted, not counted").toEqual({ ...CRASHES_NONE, restartSeen: true, restarts: NO_RESTARTS });
    // a stop someone asked for
    const asked = { ...(exit75("running", crashAt(1)) as Extract<RunnerTrigger, { type: "observed" }>), exit: { ...RESTART_EXIT, requestedStop: true } };
    expect(stepRunner(inState("playing"), asked, crashAt(1)).next.crashes.restarts, "asked for").toEqual(NO_RESTARTS);
    expect(stepRunner(inState("playing"), { ...asked, exit: RESTART_EXIT }, crashAt(1)).next.crashes.restarts.count, "the same exit not asked for").toBe(1);
  });

  // The R2003b order sweep's sibling, over the restart evidence. Oracles, none read off the tally: never more restarts counted than
  // the world MADE (no double count — each restart leaves one beat and one exit, and a re-read is not a restart); never fewer than
  // the beats, or the distinct restart exits, the lifecycle was handed (no evidence dropped) — up to the point the cap ends it,
  // after which the count is frozen; past RUNNER_RESTART_CAP the session is terminal at once; no Machine is created over either
  // cap; and the crash tally is never moved by a restart (crashes counted never exceed the crashes made).
  it("restart_cap_sweep: every order of restart (beat + exit read twice / beat only / exit only) / crash / lost-and-retried — nothing counted twice or dropped, the cap ends the session at once, no create over it, the crash count untouched by restarts (orders checked reported; zero is a failure)", () => {
    type Ev = "restart_both" | "restart_beat" | "restart_exit" | "crash_beat" | "lose_and_retry";
    const ALPHABET: readonly Ev[] = ["restart_both", "restart_beat", "restart_exit", "crash_beat", "lose_and_retry"];
    const DEPTH = 8;   // RUNNER_RESTART_CAP + 2: the allowance and the ending restart are both reachable by restarts alone
    interface World { w: Sim; at: number; made: number; crashesMade: number; beatsHanded: number; exitsRead: Set<number>; newestExit: number | null; path: Ev[] }
    let orders = 0, checks = 0, capped = 0, cappedOnRetry = 0, bothWays = 0, undercounts = 0, mixedWithCrash = 0, retries = 0, createsChecked = 0, restartCapBeforeCrashCap = 0;
    const violations: string[] = [];
    const clone = (x: World): World => ({ ...x, w: { s: x.w.s, creates: [...x.w.creates], effects: [...x.w.effects], stale: [...x.w.stale] }, exitsRead: new Set(x.exitsRead), path: [...x.path] });
    const restarts = (x: World) => x.w.s.runner.crashes.restarts.count;
    const sessionOver = (x: World) => restarts(x) > RUNNER_RESTART_CAP || x.w.s.runner.crashes.count >= RUNNER_CRASH_CAP;
    /** The route: heartbeat_at, the expiry, then the trigger — handed only to a booting/playing runner of a session still running. */
    const sendBeat = (x: World, reason: BeatExitReason): boolean => {
      x.w.s = { ...x.w.s, heartbeatAt: sec(x.at) };
      tick(x.w, x.at);
      const t = stoppedBeatTrigger(reason)!;
      if (!ACTIVE_RUNNER(x.w.s.runner.state) || isTerminal(x.w.s.state)) return false;
      feed(x.w, { type: "runner", trigger: t }, x.at);
      return true;
    };
    /** reconcileSession's read of the Machine's newest exit — the restarted process's own GET: `running`, the previous run's exit. */
    const readExit = (x: World): void => {
      const r = x.w.s.runner;
      if (x.newestExit === null || !r.machineId || !(r.state === "booting" || r.state === "playing" || r.state === "lost")) return;
      x.exitsRead.add(x.newestExit);
      feed(x.w, { type: "runner", trigger: exit75("running", sec(x.newestExit)) }, x.at);
    };
    const apply = (x0: World, ev: Ev): World => {
      const x = clone(x0);
      x.path.push(ev);
      x.at += 1;
      const cappedBefore = sessionOver(x);
      const createsBefore = x.w.creates.length;
      const attemptBefore = x.w.s.runner.attempt;
      switch (ev) {
        case "restart_both": {
          const handed = sendBeat(x, "restart"); if (handed) x.beatsHanded++;
          x.made++; x.newestExit = x.at;
          const before = restarts(x);
          readExit(x);
          if (handed && restarts(x) === before) bothWays++;   // the exit of a restart its beat had counted moved nothing
          readExit(x);                                         // …and a re-read moves nothing either
          break;
        }
        case "restart_beat": { if (sendBeat(x, "restart")) x.beatsHanded++; x.made++; x.newestExit = x.at; break; }   // its exit overwritten before any read
        case "restart_exit": x.made++; x.newestExit = x.at; readExit(x); break;                                          // its beat lost
        case "crash_beat": { x.crashesMade++; sendBeat(x, "fatal"); break; }
        case "lose_and_retry": {
          // the restarted process stops beating: the composed stale window takes it lost, the destroy lands, the ONE retry boots
          x.at += STALE_HEARTBEAT_SECONDS_COMPOSED;
          tick(x.w, x.at);
          if (x.w.s.runner.state === "lost") feed(x.w, { type: "runner", trigger: { type: "destroy_ok" } }, x.at);
          if (x.w.s.runner.attempt > attemptBefore) { retries++; x.newestExit = null; x.at += 1; x.w.s = { ...x.w.s, heartbeatAt: sec(x.at) }; feed(x.w, { type: "runner", trigger: { type: "callback_playing" } }, x.at); }
          break;
        }
      }
      // the oracles, after every event
      checks++;
      const at = x.path.join(" → ");
      const n = restarts(x);
      const handedOver = Math.max(x.beatsHanded, x.exitsRead.size);
      if (n > x.made) violations.push(`${at}: ${n} restarts counted of ${x.made} made (double count)`);
      if (!cappedBefore && n < Math.min(handedOver, RUNNER_RESTART_CAP + 1)) violations.push(`${at}: ${n} counted, but ${x.beatsHanded} restart beats and ${x.exitsRead.size} restart exits were handed over`);
      if (n > RUNNER_RESTART_CAP && !isTerminal(x.w.s.state)) violations.push(`${at}: ${n} restarts and the session is still ${x.w.s.state}`);
      if (n > RUNNER_RESTART_CAP + 1) violations.push(`${at}: ${n} restarts counted — the count must freeze at the restart that ended the session`);
      if (x.w.s.runner.crashes.count > x.crashesMade) violations.push(`${at}: ${x.w.s.runner.crashes.count} crashes counted of ${x.crashesMade} made — a restart moved the crash tally`);
      if (x.w.creates.length > createsBefore) { createsChecked++; if (cappedBefore) violations.push(`${at}: a Machine was created for a session already over a cap`); }
      return x;
    };
    const walk = (x: World, depth: number): void => {
      if (depth === DEPTH) {
        orders++;
        if (restarts(x) > RUNNER_RESTART_CAP) { capped++; if (x.w.s.runner.attempt > 1) cappedOnRetry++; if (x.w.s.runner.crashes.count > 0) restartCapBeforeCrashCap++; }
        if (!sessionOver(x) && restarts(x) < x.made) undercounts++;   // a still-running session that counted fewer than the world made
        if (restarts(x) > 0 && x.w.s.runner.crashes.count > 0) mixedWithCrash++;
        return;
      }
      for (const ev of ALPHABET) walk(apply(x, ev), depth + 1);
    };
    walk({ w: sim(), at: 0, made: 0, crashesMade: 0, beatsHanded: 0, exitsRead: new Set(), newestExit: null, path: [] }, 0);
    console.info(`Owed 67 restart_cap_sweep — orders checked: ${orders}, oracle checks: ${checks}, creates checked: ${createsChecked}, orders ending restart-capped: ${capped} (${cappedOnRetry} on the retry, ${restartCapBeforeCrashCap} with crashes counted), restarts seen both ways: ${bothWays}, live orders that undercount (mixed evidence, the safe direction): ${undercounts}, retries: ${retries}, orders holding restarts and crashes: ${mixedWithCrash}`);
    expect(violations.slice(0, 5), `${violations.length} violations`).toEqual([]);
    expect(orders, "anti-vacuity: every order of the alphabet was walked").toBe(ALPHABET.length ** DEPTH);
    expect(capped, "the restart cap was reached").toBeGreaterThan(0);
    expect(cappedOnRetry, "…on the retry too (the count spans attempts)").toBeGreaterThan(0);
    expect(bothWays, "one restart was handed over by its beat AND its exit").toBeGreaterThan(0);
    expect(undercounts, "mixed evidence was exercised (the residual)").toBeGreaterThan(0);
    expect(retries, "the ONE retry was exercised").toBeGreaterThan(0);
    expect(createsChecked, "a replacement was created and checked").toBeGreaterThan(0);
    expect(mixedWithCrash, "restarts and crashes were counted side by side").toBeGreaterThan(0);
    expect(checks, "oracle checks ran after every event").toBeGreaterThan(orders);
  });
});
