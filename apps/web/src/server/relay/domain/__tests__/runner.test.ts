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
/** EVERY trigger the table can be fed from a runner: each observed state, both create_failed flavours, the derived
 *  create_started. The derived invariants walk this, never the one-sample-per-type sweep above. */
const triggersFor = (r: Runner): RunnerTrigger[] => RUNNER_TRIGGER_TYPES.flatMap((t): RunnerTrigger[] =>
  t === "observed" ? OBSERVED_STATES.map((state) => ({ type: "observed" as const, state }))
  : t === "create_failed" ? [{ type: "create_failed", retryable: true }, { type: "create_failed", retryable: false }]
  : t === "create_started" ? [{ type: "create_started", name: machineNameFor("s1", r.attempt + 1), attempt: r.attempt + 1 }]
  : [SAMPLE[t]]);
/** A walk's NODE: every payload field a cell BRANCHES on — the state, the attempt (retryLeft, createStarted) and whether a
 *  stop is marked (creating's create_ok / create_failed / observed). A future cell that branches on another field adds it
 *  here, or every walk that dedupes on this key silently under-walks. */
const nodeKey = (r: Runner): string => `${r.state}:${r.attempt}:${r.stopRequestedAt !== null ? "marked" : "unmarked"}`;
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
    expect(left).toBe(4);   // destroy_ok, observed destroyed, deadline, session_stop — and nothing else
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
        const madeNothing = t.type === "create_failed" && r.state === "creating";
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
        const madeNothing = r.state === "creating" && t.type === "create_failed";
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
