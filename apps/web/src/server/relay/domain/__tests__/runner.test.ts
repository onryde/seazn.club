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
  RUNNER_CRASH_CAP, RUNNER_RESTART_STUCK_SECONDS,
  RUNNER_STOP_GRACE_SECONDS, RUNNER_STOP_SIGNAL, STALE_HEARTBEAT_SECONDS, STALE_HEARTBEAT_SECONDS_COMPOSED, WARMING_TIMEOUT_MINUTES,
} from "../../config";
import { evaluate } from "../expiry";
import {
  BEAT_EXIT_REASONS, CRASHES_NONE, InvalidRunnerTransition, MACHINE_MINUTES_BOUND, OBSERVED_STATES, RUNNER_NONE, RUNNER_STATES, RUNNER_TABLE,
  RUNNER_TRIGGER_TYPES, failReasonFromExit, machineNameFor, stepRunner, stoppedBeatTrigger,
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
  `:crashes ${r.crashes.count}/${r.crashes.beats}/${r.crashes.exits}${r.crashes.exitAt ? "@" : ""}`;
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
    const timed = (t: RunnerTrigger): boolean => t.type !== "callback_crashed" && !(t.type === "observed" && t.exitAt !== undefined);
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
  // R2003b: a crash beat is not a teardown trigger — the route hands it to a session that is still running, never a terminal one
  if (t && (ACTIVE_RUNNER(w.s.runner.state) || w.s.runner.state === "stopping") && (t.type !== "callback_crashed" || !isTerminal(w.s.state))) feed(w, { type: "runner", trigger: t }, at);
}
const observe = (w: Sim, at: number, state: (typeof OBSERVED_STATES)[number], exit: ExitInfo | null = null) =>
  feed(w, { type: "runner", trigger: { type: "observed", state, exit } }, at);

describe("R2003 — the final beat's exit reason (stoppedBeatTrigger): what each reason asks of the lifecycle", () => {
  // The oracle is the controller's ruling (2026-10-15) and the orchestrator's I2 decision (PR #967 review: an `ended` or
  // `deadline` beat ENDS the session — no retry), typed here — never read off the function under test.
  type Routed = "callback_stopped" | "ends:stopped" | "ends:max_duration" | "refused" | "crashed" | "record_only";
  const RULED: Record<BeatExitReason | "absent" | "null", Routed> = {
    absent: "callback_stopped", null: "callback_stopped",      // a legacy runner's beat: today's behaviour, unchanged
    ended: "ends:stopped",                                     // the compositor finished: a normal stop, respected
    deadline: "ends:max_duration",                             // RELAY_DEADLINE_AT is the wall clock's own instant
    // R2003b (owner approval 2026-10-16): a fatal run is a CRASH, counted toward RUNNER_CRASH_CAP — below it the lifecycle
    // still only records it (on-failure ≤ RUNNER_INPLACE_RESTARTS restarts it in place on the SAME attempt).
    fatal: "crashed",
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
        : t.type !== "callback_stopped" ? (() => { throw new Error(`${label}: ${t.type} is not a stopped beat's trigger`); })()
        : t.refused === true ? "refused"
        : t.endReason !== undefined ? `ends:${t.endReason}` as Routed
        : "callback_stopped";
      expect(got, label).toBe(RULED[label]);
      if (t !== null) expect(t.type, label).toBe(got === "crashed" ? "callback_crashed" : "callback_stopped");
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
 *  per-window restart count (F-007: restarting exit k carries restart_count k; the final one restarting false). */
const crashExit = (state: (typeof OBSERVED_STATES)[number], exitAt: Date, restartCount: number | null, restarting = true, exit: ExitInfo = CRASH_EXIT): RunnerTrigger =>
  ({ type: "observed", state, exit, restarting, restartingSince: restarting ? exitAt : null, exitAt, restartCount });
const CRASHED: RunnerTrigger = { type: "callback_crashed" };
const tally = (over: Partial<CrashTally>): CrashTally => ({ ...CRASHES_NONE, ...over });

describe("R2003b — the crash-loop cap: RUNNER_CRASH_CAP fatal crashes per SESSION fail it machine_crash", () => {
  it("the cap is the owner's 3 (2026-10-16), and a final beat saying `fatal` is a crash trigger while `signalled` and `session_gone` stay record only", () => {
    expect(RUNNER_CRASH_CAP, "owner approval 2026-10-16").toBe(3);
    expect(stoppedBeatTrigger("fatal")).toEqual({ type: "callback_crashed" });
    expect(stoppedBeatTrigger("signalled"), "a stop someone else asked for is never a crash").toBeNull();
    expect(stoppedBeatTrigger("session_gone")).toBeNull();
    expect(RUNNER_NONE.crashes, "a runner starts with nothing counted").toEqual({ count: 0, beats: 0, exits: 0, exitAt: null });
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
    ];
    let counted = 0, notCounted = 0;
    for (const [label, exit, isCrash] of CASES) {
      // restarting false: Fly restarts only failures, so a non-crash exit is never `restarting` (F-007)
      const step = stepRunner(inState("playing"), crashExit("stopped", crashAt(1), null, false, exit), crashAt(1));
      expect(step.next.crashes.count, label).toBe(isCrash ? 1 : 0);
      if (isCrash) counted++; else notCounted++;
    }
    expect(counted).toBe(3);
    expect(notCounted).toBe(4);
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
      expect(restarting.next.crashes, `${state}, restarting`).toEqual({ count: 1, beats: 0, exits: 1, exitAt: crashAt(1) });
      const notRestarting = stepRunner(inState("playing"), crashExit(state, crashAt(1), null, false, CODELESS), crashAt(1));
      expect(notRestarting.next.crashes, `${state}, not restarting`).toEqual(CRASHES_NONE);
      checked++;
    }
    expect(checked).toBe(2);
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

  it("at the cap on every road out: an observed exit reaching it (stopped / pending / destroyed), a LOST runner's observation crossing it, a confirmed destroy, the C1 stale beat on destroyed — failed machine_crash, never the retry; one short of it, each road is today's", () => {
    let checked = 0;
    for (const state of ["stopped", "pending"] as const) for (const from of ["playing", "booting"] as const) {
      const short = R({ ...inState(from), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
      expect(stepRunner(short, crashExit(state, crashAt(2), 1), crashAt(2)), `${from} × ${state}`).toEqual({
        next: { ...short, state: "lost", lastExit: CRASH_EXIT, crashes: { count: RUNNER_CRASH_CAP, beats: 0, exits: RUNNER_CRASH_CAP, exitAt: crashAt(2) } },
        effects: [{ type: "force_destroy" }], signal: { type: "failed", reason: "machine_crash" },
      });
      checked++;
    }
    // destroyed (Fly gave up and auto-destroyed it): a NEWER crash exit reaches the cap; the one already counted does not
    const shortPlaying = R({ ...inState("playing"), crashes: tally({ count: RUNNER_CRASH_CAP - 1, exits: RUNNER_CRASH_CAP - 1, exitAt: crashAt(1) }) });
    expect(stepRunner(shortPlaying, crashExit("destroyed", crashAt(3), RUNNER_INPLACE_RESTARTS, false), crashAt(3))).toMatchObject({ next: { state: "destroyed", crashes: { count: RUNNER_CRASH_CAP } }, signal: { type: "failed", reason: "machine_crash" } });
    expect(stepRunner(shortPlaying, crashExit("destroyed", crashAt(1), RUNNER_INPLACE_RESTARTS, false), crashAt(3)).signal, "the exit already counted: the retry").toEqual({ type: "retry" });
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
    expect(checked).toBe(4 + 1 + 1 + 2 + 1);
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
  it("crash_cap_sweep: every order of crash+beat / silent crash / signalled stop / observe / wait / destroy_ok / late retry — no create at the cap, the cap fails at once, nothing counted twice or dropped (orders checked reported; zero is a failure)", () => {
    type Ev = "crash_beat" | "crash_silent" | "signalled" | "observe" | "wait_played" | "destroy_ok" | "late_retry";
    const ALPHABET: readonly Ev[] = ["crash_beat", "crash_silent", "signalled", "observe", "wait_played", "destroy_ok", "late_retry"];
    const DEPTH = 6;
    interface Machine { name: string; alive: boolean; restarting: boolean; windowCrashes: number; exit: ExitInfo | null; exitAt: number | null }
    interface World { s: Session; at: number; machines: Machine[]; destroyFor: string | null; made: number; beats: number; beaten: Set<string>; exits: Set<string>; path: Ev[] }
    let orders = 0, createsChecked = 0, capped = 0, cappedOnRetry = 0, dedupes = 0, signalledStops = 0, checks = 0;
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
          w.machines.push({ name: w.s.runner.name!, alive: true, restarting: false, windowCrashes: 0, exit: null, exitAt: null });
          step(w, { type: "runner", trigger: { type: "create_ok", machineId: `m-${w.s.runner.name}` } });
        }
        if (e.type === "retry_runner") step(w, { type: "runner", trigger: { type: "create_started", name: machineNameFor(SID, w.s.runner.attempt + 1), attempt: w.s.runner.attempt + 1 } });
      }
    };
    const expire = (w: World) => { const x = evaluate(w.s, sec(w.at)); if (x.kind !== "none") step(w, { type: "expire", expiry: x }); };
    /** The route: a beat on a terminal row is 410 and writes nothing; otherwise heartbeat_at, the expiry, then the trigger. */
    const finalBeatOf = (w: World, reason: BeatExitReason) => {
      if (isTerminal(w.s.state)) return;
      w.s = { ...w.s, heartbeatAt: sec(w.at) };
      expire(w);
      const t = stoppedBeatTrigger(reason);
      if (!t || isTerminal(w.s.state) || !(ACTIVE_RUNNER(w.s.runner.state) || w.s.runner.state === "stopping")) return;
      if (t.type === "callback_crashed" && ACTIVE_RUNNER(w.s.runner.state)) w.beats++;   // handed to a runner that counts it
      step(w, { type: "runner", trigger: t });
    };
    const crash = (w: World, m: Machine, beats: boolean) => {
      const handed = w.beats;
      if (beats) finalBeatOf(w, "fatal");        // C07: the final beat goes out BEFORE the process exits
      if (w.beats > handed) w.beaten.add(`${m.name}@${w.at}`);
      m.windowCrashes++;
      w.made++;
      m.exit = CRASH_EXIT;
      m.exitAt = w.at;
      // F-007: restarted in place up to RUNNER_INPLACE_RESTARTS per window; the next is Fly's final exit, then auto_destroy
      if (m.windowCrashes <= RUNNER_INPLACE_RESTARTS) m.restarting = true; else { m.alive = false; m.restarting = false; }
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
        case "signalled":   // a platform stop: SIGTERM → the `signalled` drain → exit 0, which Fly never restarts
          if (m?.alive) {
            signalledStops++;
            finalBeatOf(w, "signalled");
            Object.assign(m, { alive: false, restarting: false, exit: { exitCode: 0, oomKilled: false, requestedStop: false }, exitAt: w.at });
          }
          break;
        case "observe": {   // reconcileSession: the expiry, then ONE observation of the Machine the row names (runner-fly.ts observe)
          expire(w);
          const r = w.s.runner;
          if (r.state === "none" || r.state === "destroyed" || r.state === "creating" || !r.machineId) break;
          const seen = current(w);
          const trigger: RunnerTrigger = !seen ? { type: "observed", state: "destroyed", exit: null, restarting: false, restartingSince: null, exitAt: null, restartCount: null }
            : seen.alive && !seen.restarting ? { type: "observed", state: "running", exit: null, restarting: false, restartingSince: null, exitAt: null, restartCount: null }
            : { type: "observed", state: seen.alive ? "pending" : "destroyed", exit: seen.exit, restarting: seen.restarting,
                restartingSince: seen.restarting ? sec(seen.exitAt!) : null, exitAt: seen.exitAt === null ? null : sec(seen.exitAt), restartCount: seen.windowCrashes };
          const counts = r.state === "booting" || r.state === "playing" || r.state === "lost";
          if (counts && seen && seen.exit === CRASH_EXIT && seen.exitAt !== null) {
            const id = `${seen.name}@${seen.exitAt}`;
            if (w.exits.has(id) || w.beaten.has(id)) dedupes++;   // this crash was handed over already: by its beat, or this exit
            w.exits.add(id);
          }
          step(w, { type: "runner", trigger });
          break;
        }
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
        if (w.s.runner.crashes.count >= RUNNER_CRASH_CAP) { capped++; if (w.s.runner.attempt > 1) cappedOnRetry++; }
        return;
      }
      for (const ev of ALPHABET) walk(apply(w, ev), depth + 1);
    };
    walk({ s: liveComposed(), at: 0, machines: [{ name: machineNameFor(SID, 1), alive: true, restarting: false, windowCrashes: 0, exit: null, exitAt: null }], destroyFor: null, made: 0, beats: 0, beaten: new Set(), exits: new Set(), path: [] }, 0);
    console.info(`R2003b crash_cap_sweep — orders checked: ${orders}, oracle checks: ${checks}, creates checked: ${createsChecked}, orders ending capped: ${capped} (${cappedOnRetry} on the retry), dedupe chances: ${dedupes}, signalled stops: ${signalledStops}`);
    expect(violations.slice(0, 5), `${violations.length} violations`).toEqual([]);
    expect(orders, "anti-vacuity: every order of the alphabet was walked").toBe(ALPHABET.length ** DEPTH);
    expect(createsChecked, "a create was reached and checked").toBeGreaterThan(0);
    expect(capped, "the cap was reached").toBeGreaterThan(0);
    expect(cappedOnRetry, "…on the retry too (the count spans attempts)").toBeGreaterThan(0);
    expect(dedupes, "one crash was handed over twice").toBeGreaterThan(0);
    expect(signalledStops, "a platform stop was exercised").toBeGreaterThan(0);
  });
});
