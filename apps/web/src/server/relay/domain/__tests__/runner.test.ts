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
  MAX_DURATION_MINUTES, RELAY_EXIT_REFUSED, RELAY_HEARTBEAT_INTERVAL_MS, RUNNER_INPLACE_RESTARTS, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS,
  RUNNER_STOP_GRACE_SECONDS, RUNNER_STOP_SIGNAL, STALE_HEARTBEAT_SECONDS, STALE_HEARTBEAT_SECONDS_COMPOSED, WARMING_TIMEOUT_MINUTES,
} from "../../config";
import { evaluate } from "../expiry";
import {
  BEAT_EXIT_REASONS, InvalidRunnerTransition, MACHINE_MINUTES_BOUND, OBSERVED_STATES, RUNNER_NONE, RUNNER_STATES, RUNNER_TABLE,
  RUNNER_TRIGGER_TYPES, failReasonFromExit, machineNameFor, stepRunner, stoppedBeatTrigger,
  type BeatExitReason, type ExitInfo, type Runner, type RunnerEffect, type RunnerState, type RunnerTrigger, type SessionSignal,
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
const triggersFor = (r: Runner): RunnerTrigger[] => RUNNER_TRIGGER_TYPES.flatMap((t): RunnerTrigger[] =>
  t === "observed" ? [
      ...OBSERVED_STATES.map((state) => ({ type: "observed" as const, state })),
      // R2003: an observed exit 78 — the refusal that must never earn the retry — on each state that carries an exit
      ...(["stopped", "failed", "destroyed"] as const).map((state) => ({ type: "observed" as const, state, exit: REFUSED_EXIT })),
    ]
  // R2003: both flavours of a stopped beat — a plain one, and the final beat that said its run was refused
  : t === "callback_stopped" ? [{ type: "callback_stopped" }, { type: "callback_stopped", refused: true }]
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
  `${r.state}:${r.attempt}:${r.stopRequestedAt !== null ? "marked" : "unmarked"}${r.lastExit?.exitCode === RELAY_EXIT_REFUSED ? ":refused-exit" : ""}`;   // R2003: afterLostDestroyed branches on it
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
    expect(left).toBe(5);   // destroy_ok, observed destroyed (plain, and with the refusal exit — R2003), deadline, session_stop — and nothing else
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
    // `nodeKey` carries. The dwell itself is a function of the state alone.
    const longestFrom = (r: Runner, onPath: ReadonlySet<string>): number => {
      const successors = new Map<string, Runner>();
      for (const t of triggersFor(r)) {
        let next: Runner;
        try { next = stepRunner(r, t, T0).next; } catch (e) { expect(e).toBeInstanceOf(InvalidRunnerTransition); continue; }
        const key = nodeKey(next);
        if (!onPath.has(key) && !successors.has(key)) successors.set(key, next);
      }
      let best = 0;
      for (const [key, next] of successors) best = Math.max(best, DWELL[next.state] + longestFrom(next, new Set([...onPath, key])));
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
  if (t && (ACTIVE_RUNNER(w.s.runner.state) || w.s.runner.state === "stopping")) feed(w, { type: "runner", trigger: t }, at);
}
const observe = (w: Sim, at: number, state: (typeof OBSERVED_STATES)[number], exit: ExitInfo | null = null) =>
  feed(w, { type: "runner", trigger: { type: "observed", state, exit } }, at);

describe("R2003 — the final beat's exit reason (stoppedBeatTrigger): what each reason asks of the lifecycle", () => {
  // The oracle is the controller's ruling (2026-10-15), typed here — never read off the function under test.
  type Routed = "callback_stopped" | "refused" | "record_only";
  const RULED: Record<BeatExitReason | "absent" | "null", Routed> = {
    absent: "callback_stopped", null: "callback_stopped",      // a legacy runner's beat: today's behaviour, unchanged
    ended: "callback_stopped", deadline: "callback_stopped",   // the normal ends
    fatal: "record_only", signalled: "record_only",            // on-failure ≤ RUNNER_INPLACE_RESTARTS, then lost → destroyed → the ONE retry decides
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
      const got: Routed = t === null ? "record_only" : t.type === "callback_stopped" && t.refused === true ? "refused" : "callback_stopped";
      expect(got, label).toBe(RULED[label]);
      if (t !== null) expect(t.type, label).toBe("callback_stopped");
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
