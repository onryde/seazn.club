// The Fly machine lifecycle as a pure sub-machine (plan §"Fly machine
// lifecycle" — the table is the authority). Four parts: (a) a PARITY SWEEP
// over every RUNNER_STATES × RUNNER_TRIGGER_TYPES cell, read from the
// exported table; (b) the stale_beat COLUMN (Task 2C carry C1), walked from
// RUNNER_STATES against a per-state ruling; (c) the named invariants; (d) the
// specific edges the mutants target. Killers: allow a retry while not destroyed
// → "invariant 1"; skip SIGINT and destroy directly → "the stop sequence"; treat
// unknown as running → "unknown Fly state"; drop the grace force-destroy →
// "grace_expired"; drop persist-before-create → "invariant 4"; the retry cap
// `<` → `<=` → "lost → destroyed …", "create_failed …" and "the stale_beat
// column … destroyed" (C2); any stale_beat cell set back to null → "the
// stale_beat column" (C1).
import { describe, expect, it } from "vitest";
import { MAX_DURATION_MINUTES, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, RUNNER_STOP_SIGNAL, WARMING_TIMEOUT_MINUTES } from "../../config";
import {
  InvalidRunnerTransition, MACHINE_MINUTES_BOUND, OBSERVED_STATES, RUNNER_NONE, RUNNER_STATES, RUNNER_TABLE,
  RUNNER_TRIGGER_TYPES, failReasonFromExit, machineNameFor, stepRunner,
  type Runner, type RunnerEffect, type RunnerState, type RunnerTrigger, type SessionSignal,
} from "../runner";

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
  create_failed: { type: "create_failed", retryable: false },
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
    expect(stepRunner(lost.next, { type: "create_failed", retryable: true }, T0)).toEqual({ next: lost.next, effects: [], signal: null });
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
  it("grace_expired in stopping/exited → force_destroy → destroyed (mutant: drop the force → red)", () => {
    for (const s of ["stopping", "exited"] as const) {
      const step = stepRunner(inState(s), { type: "grace_expired" }, T0);
      expect(step.effects, s).toEqual([{ type: "force_destroy" }]);
      expect(step.next.state, s).toBe("destroyed");
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
    const retry = stepRunner(inState("creating"), { type: "create_failed", retryable: true }, T0);
    expect(retry.next.state).toBe("destroyed");
    expect(retry.signal).toEqual({ type: "retry" });
    const fail = stepRunner(inState("creating"), { type: "create_failed", retryable: false }, T0);
    expect(fail.signal).toEqual({ type: "failed", reason: "machine_create_failed" });
    const exhausted = stepRunner(R({ state: "creating", attempt: RUNNER_MAX_ATTEMPTS, name: "relay-s1-r2" }), { type: "create_failed", retryable: true }, T0);
    expect(exhausted.signal).toEqual({ type: "failed", reason: "machine_create_failed" });
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
  it("invariant 3: MACHINE_MINUTES_BOUND covers the longest timed path the table itself can walk (walked, never re-derived — C12)", () => {
    // The minutes the walk CREDITS a Machine in each state — the timer that forces it out of that state:
    //   booting  — the warming timeout (a replacement booting in a LIVE session is cut shorter, by the stale beat);
    //   playing  — the deadline, credited IN FULL on every attempt, although both attempts share ONE wall clock
    //              measured from startedAt: an over-credit of up to MAX_DURATION_MINUTES on the second attempt;
    //   stopping — grace + observation slack (evaluate's grace_expired);
    //   exited   — 0: it shares stopping's window (stopRequestedAt is not reset on the way in).
    // NOT credited (0), each a window of minutes against that over-credit:
    //   creating — the provision timeout while the session provisions, the stale beat as a live replacement (C1), and
    //              the grace once a stop is MARKED; the mark keeps the same (state, attempt), so the walk never re-enters it;
    //   lost     — its entry issues force_destroy, and a stale beat re-issues it once per STALE_HEARTBEAT_SECONDS until
    //              destroy_ok / observed destroyed moves it on (C1) — no table timer forces it out;
    //   none, destroyed — no Machine of ours (a create returning into destroyed is force-destroyed on arrival).
    const DWELL: Record<RunnerState, number> = {
      none: 0, creating: 0, booting: WARMING_TIMEOUT_MINUTES, playing: MAX_DURATION_MINUTES,
      stopping: (RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS) / 60, exited: 0, lost: 0, destroyed: 0,
    };
    // Every trigger the table can be fed from a runner: each observed state, both create_failed flavours, the derived create_started.
    const triggersFor = (r: Runner): RunnerTrigger[] => RUNNER_TRIGGER_TYPES.flatMap((t): RunnerTrigger[] =>
      t === "observed" ? OBSERVED_STATES.map((state) => ({ type: "observed" as const, state }))
      : t === "create_failed" ? [{ type: "create_failed", retryable: true }, { type: "create_failed", retryable: false }]
      : t === "create_started" ? [{ type: "create_started", name: machineNameFor("s1", r.attempt + 1), attempt: r.attempt + 1 }]
      : [SAMPLE[t]]);
    // Longest simple path over (state, attempt) nodes; a stay never re-enters a node already on the path.
    // Successors are walked once per NODE, not once per trigger: `lost → destroyed` alone is six triggers, and walking
    // each parallel edge re-walked the whole second attempt beneath it (18 s, and a timeout under load). The dwell is a
    // function of the state alone, so which trigger reached a node cannot change the longest path through it.
    const longestFrom = (r: Runner, onPath: ReadonlySet<string>): number => {
      const successors = new Map<string, Runner>();
      for (const t of triggersFor(r)) {
        let next: Runner;
        try { next = stepRunner(r, t, T0).next; } catch (e) { expect(e).toBeInstanceOf(InvalidRunnerTransition); continue; }
        const key = `${next.state}:${next.attempt}`;
        if (!onPath.has(key) && !successors.has(key)) successors.set(key, next);
      }
      let best = 0;
      for (const [key, next] of successors) best = Math.max(best, DWELL[next.state] + longestFrom(next, new Set([...onPath, key])));
      return best;
    };
    const longest = longestFrom(RUNNER_NONE, new Set(["none:0"]));
    expect(longest).toBeGreaterThan(MAX_DURATION_MINUTES);            // not vacuous: the walk reaches playing
    expect(MACHINE_MINUTES_BOUND).toBeGreaterThanOrEqual(longest);
    expect(RUNNER_MAX_ATTEMPTS).toBe(2); // ONE retry (design §6.4) — a third attempt would need this line and the table's `destroyed` row to change together
  });
  it("invariant 4: create_started persists the intent BEFORE creating (effect order), with the name and attempt on the runner (mutant: drop persist_intent or reorder → red)", () => {
    const step = stepRunner(inState("none"), { type: "create_started", name: machineNameFor("s1", 1), attempt: 1 }, T0);
    expect(step.effects.map((e) => e.type)).toEqual(["persist_intent", "create_machine"]);
    expect(step.next).toMatchObject({ state: "creating", attempt: 1, name: "relay-s1-r1", machineId: null });
    // crash-safe reconcile: a creating runner observed pending/running (found by name) becomes booting without a second create
    const found = stepRunner(step.next, { type: "observed", state: "running" }, T0);
    expect(found.next.state).toBe("booting");
    expect(found.effects).toEqual([]);
  });
  it("machineNameFor carries the attempt so a destroyed name is never reused", () => {
    expect(machineNameFor("s1", 1)).toBe("relay-s1-r1");
    expect(machineNameFor("s1", 2)).toBe("relay-s1-r2");
    expect(machineNameFor("s1", 1)).not.toBe(machineNameFor("s1", 2));
  });
  it("orphan_listed is legal only for lost/destroyed (the sweep never tears down a runner the session still owns through the table)", () => {
    expect(stepRunner(inState("lost"), { type: "orphan_listed" }, T0).effects).toEqual([{ type: "force_destroy" }]);
    expect(stepRunner(inState("destroyed"), { type: "orphan_listed" }, T0).effects).toEqual([]);
    for (const s of ["creating", "booting", "playing", "stopping", "exited"] as const) {
      expect(() => stepRunner(inState(s), { type: "orphan_listed" }, T0), s).toThrow(InvalidRunnerTransition);
    }
  });
  it("OBSERVED_STATES is the whole vocabulary Task 5's fromFlyState may emit", () => {
    expect([...OBSERVED_STATES].sort()).toEqual(["destroyed", "destroying", "failed", "pending", "running", "stopped", "stopping", "unknown"]);
  });
});
