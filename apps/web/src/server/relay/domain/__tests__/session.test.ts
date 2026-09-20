// The session aggregate (design §6.3 gates, §6.4 transitions), PURE. Fast:
// no DB, no fakes, milliseconds. Every edge is its own `it`; the domain
// mutant killers are recorded per edge in the PR table.
import { describe, expect, it } from "vitest";
import {
  ENDING_TIMEOUT_SECONDS, MAX_DURATION_MINUTES, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, STALE_HEARTBEAT_SECONDS,
} from "../../config";
import { evaluate, type Expiry } from "../expiry";
import {
  ACTIVE_STATES, InvalidTransition, TERMINAL_STATES, admit, decide, eventRowsOf, isActive, isTerminal,
  type Command, type Effect, type Session, type SessionState,
} from "../session";
import { InvalidRunnerTransition, OBSERVED_STATES, RUNNER_NONE, RUNNER_STATES, RUNNER_TRIGGER_TYPES, type Runner, type RunnerTrigger } from "../runner";

const T0 = new Date("2026-09-14T10:00:00Z");
const S = (over: Partial<Session> = {}): Session => ({
  id: "s1", fixtureId: "f1", orgId: "o1", mode: "passthrough", state: "requested", desiredState: "live",
  failReason: null, endReason: null, runner: RUNNER_NONE, runnerRetries: 0, createdAt: T0, startedAt: null, endedAt: null,
  heartbeatAt: null, beatWindowAt: null, endingAt: null, maxDurationMinutes: 300, ...over,
});
const OK = { overlay: true, relay: true, balance: 1, targetBelongsToOrg: true, headroomMinutes: 300, maxDurationMinutes: 300, activeSessionId: null };

// The §6.3 gates IN ORDER — one row per gate: the fields that trip it, and the refusal it yields. Shared by the
// per-gate `it.each` and the whole-ladder ORDER test, so the order is typed once.
const REFUSAL_LADDER = [
  [{ overlay: false, relay: false }, "plan_lacks_overlay"],
  [{ overlay: false, relay: true }, "overlay_required"],       // r5: relay without overlay is the implication check
  [{ relay: false }, "plan_lacks_relay"],
  [{ balance: 0 }, "no_credits"],
  [{ targetBelongsToOrg: false }, "target_not_found"],
  [{ headroomMinutes: 299 }, "storage_exhausted"],           // C3: headroom < max_duration refuses
  [{ activeSessionId: "s0" }, "active_session"],
] as const;

describe("admit — the §6.3 gates, in order", () => {
  it("everything satisfied → ok (the empty case: no refusal)", () => {
    expect(admit(OK)).toEqual({ ok: true });
  });
  it.each(REFUSAL_LADDER)("%o → %s, and fixing that one field → ok", (over, refusal) => {
    expect(admit({ ...OK, ...over })).toMatchObject({ ok: false, refusal });
    // The positive pair (C24): restore exactly the row's fields from OK — nothing else — and the refusal is gone.
    const fixed = Object.fromEntries(Object.keys(over).map((k) => [k, OK[k as keyof typeof OK]]));
    expect(admit({ ...OK, ...over, ...fixed })).toEqual({ ok: true });
  });
  it("headroom EXACTLY max_duration admits (boundary)", () => {
    expect(admit({ ...OK, headroomMinutes: 300 })).toEqual({ ok: true });
  });
  it("ORDER: two refusals true at once yield the earlier — balance 0 AND no headroom → no_credits, not storage_exhausted", () => {
    expect(admit({ ...OK, balance: 0, headroomMinutes: 0 })).toMatchObject({ refusal: "no_credits" });
    expect(admit({ ...OK, relay: false, balance: 0 })).toMatchObject({ refusal: "plan_lacks_relay" });
  });
  it("ORDER, the whole ladder: for EVERY pair of gates that can trip together, the earlier one wins — swapping any two gates reds here", () => {
    let pairs = 0;
    for (const [i, [a, earlier]] of REFUSAL_LADDER.entries()) {
      for (const [b, later] of REFUSAL_LADDER.slice(i + 1)) {
        // A pair that contradicts on a shared field cannot hold at once (overlay_required needs relay true; the gates beside it need it false).
        if (Object.entries(a).some(([k, v]) => k in b && (b as Record<string, unknown>)[k] !== v)) continue;
        pairs++;
        expect(admit({ ...OK, ...a, ...b }), `${earlier} beside ${later}`).toMatchObject({ ok: false, refusal: earlier });
      }
    }
    expect(pairs).toBe(19);   // C(7,2) = 21, minus overlay_required beside plan_lacks_overlay and beside plan_lacks_relay
  });
  it("active_session carries the running id", () => {
    expect(admit({ ...OK, activeSessionId: "s0" })).toEqual({ ok: false, refusal: "active_session", activeSessionId: "s0" });
  });
});

describe("decide — legal edges", () => {
  it("requested → provisioning", () => {
    const d = decide(S(), { type: "provision" }, T0);
    expect(d.next.state).toBe("provisioning");
    expect(d.events).toEqual([{ type: "SessionProvisioning" }]);
    expect(d.effects).toEqual([]);
  });
  it("provisioning → warming: passthrough adds ONE output (C9); composed adds none — its Machine is the runner sub-machine's (Task 2C)", () => {
    const p = decide(S({ state: "provisioning" }), { type: "provisioned" }, T0);
    expect(p.next.state).toBe("warming");
    expect(p.effects).toEqual([{ type: "add_output" }]);
    const c = decide(S({ state: "provisioning", mode: "composed" }), { type: "provisioned" }, T0);
    expect(c.next.state).toBe("warming");
    expect(c.effects).toEqual([]);
    expect(c.events).toEqual([{ type: "SessionWarming" }]);
  });
  it("warming → live on ingest_connected (passthrough) with the consume effect (m1's domain twin); composed goes live only through the runner's callback (Task 2C)", () => {
    const p = decide(S({ state: "warming" }), { type: "ingest_connected" }, T0);
    expect(p.next).toMatchObject({ state: "live", startedAt: T0 });
    expect(p.effects).toEqual([{ type: "consume_credit" }]);
    expect(p.events).toEqual([{ type: "SessionWentLive" }]);
  });
  it("ingest_connected on a COMPOSED session is illegal (the wrong signal cannot go live)", () => {
    expect(() => decide(S({ state: "warming", mode: "composed" }), { type: "ingest_connected" }, T0)).toThrow(InvalidTransition);
  });
  it("warming → failed(no_credits) on credit_refused; ended_at set", () => {
    const d = decide(S({ state: "warming" }), { type: "credit_refused" }, T0);
    expect(d.next).toMatchObject({ state: "failed", failReason: "no_credits", endedAt: T0 });
    expect(d.events).toEqual([{ type: "SessionEnded", reason: "no_credits" }]);
  });
  it("target_rejected fails from warming and from live (passthrough — the destination refused the key)", () => {
    expect(decide(S({ state: "warming" }), { type: "target_rejected" }, T0).next.failReason).toBe("target_rejected");
    const l = decide(S({ state: "live", startedAt: T0 }), { type: "target_rejected" }, T0);
    expect(l.next).toMatchObject({ state: "failed", failReason: "target_rejected", endedAt: T0 });
  });
  it("stop: passthrough live/warming → ending with desired_state ending and end_reason stopped, completing NOW; a composed stop WITH a Machine is the runner's (Task 2C's tests)", () => {
    const p = decide(S({ state: "live", startedAt: T0 }), { type: "stop" }, T0);
    expect(p.next).toMatchObject({ state: "ending", desiredState: "ending", endReason: "stopped" });
    expect(p.effects).toEqual([{ type: "complete_now" }]);
    expect(decide(S({ state: "warming" }), { type: "stop" }, T0).next.state).toBe("ending");
  });
  it("stop: a composed session with NO live Machine — runner none (stopped before any create) or destroyed (between attempts) — completes NOW with end_reason stopped, no runner step (P1-F-a; mutant: delete the no-Machine branch → red)", () => {
    // The third column is the replay fill: only a session that went live (startedAt set) has a broadcast to replay (I3).
    const cases: [string, Session, Effect[]][] = [
      ["none", S({ state: "provisioning", mode: "composed" }), []],
      ["destroyed", S({ state: "live", mode: "composed", startedAt: T0, runner: { ...RUNNER_NONE, state: "destroyed", attempt: 1, name: "relay-s1-r1", machineId: "m1", lastExit: { exitCode: 1, oomKilled: false, requestedStop: false } } }), [{ type: "fill_replay" }]],
    ];
    for (const [label, s, effects] of cases) {
      const d = decide(s, { type: "stop" }, T0);
      expect(d.next, label).toMatchObject({ state: "completed", desiredState: "ending", endReason: "stopped", failReason: null, endedAt: T0, runner: { state: s.runner.state } });
      expect(d.events, label).toEqual([{ type: "SessionEnded", reason: "completed" }]);
      expect(d.effects, label).toEqual(effects);
    }
  });
  it("stop on ending is a benign repeat (identity, no events); stop on completed is illegal", () => {
    const again = decide(S({ state: "ending", desiredState: "ending" }), { type: "stop" }, T0);
    expect(again.events).toEqual([]);
    expect(again.next.state).toBe("ending");
    expect(() => decide(S({ state: "completed" }), { type: "stop" }, T0)).toThrow(InvalidTransition);
  });
  it("ending → completed on complete: ended_at, SessionEnded, the replay-fill effect", () => {
    const d = decide(S({ state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0 }), { type: "complete" }, T0);
    expect(d.next).toMatchObject({ state: "completed", endedAt: T0, endReason: "stopped" });
    expect(d.events).toEqual([{ type: "SessionEnded", reason: "completed" }]);
    expect(d.effects).toEqual([{ type: "fill_replay" }]);
  });
  it("fill_replay only for a session that actually WENT LIVE (I3): a passthrough stop → complete from requested, provisioning or warming emits none; from live emits exactly one", () => {
    const replaysAcrossStopAndComplete = (from: Session): number => {
      const e = decide(from, { type: "stop" }, T0);
      const c = decide(e.next, { type: "complete" }, T0);
      expect(c.next.state, from.state).toBe("completed");
      return [...e.effects, ...c.effects].filter((x) => x.type === "fill_replay").length;
    };
    for (const state of ["requested", "provisioning", "warming"] as const) {
      expect(replaysAcrossStopAndComplete(S({ state })), `${state}: never went live`).toBe(0);
    }
    expect(replaysAcrossStopAndComplete(S({ state: "live", startedAt: T0 })), "live").toBe(1);
  });
  it("a terminal session accepts no command (both terminal states, every command)", () => {
    const commands: Command[] = [{ type: "provision" }, { type: "ingest_connected" }, { type: "stop" }, { type: "complete" }, { type: "target_rejected" }];
    for (const state of TERMINAL_STATES) for (const c of commands) {
      expect(() => decide(S({ state }), c, T0), `${state} ${c.type}`).toThrow(InvalidTransition);
    }
  });
  it("InvalidTransition names the edge", () => {
    try { decide(S({ state: "live" }), { type: "provision" }, T0); } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransition);
      expect((e as InvalidTransition).from).toBe("live");
      expect((e as InvalidTransition).command).toBe("provision");
      return;
    }
    throw new Error("did not throw");
  });
  it("decide never mutates its input and never reads the clock (now is the only time)", () => {
    const s = S({ state: "warming" });
    const frozen = structuredClone(s);
    const d = decide(s, { type: "ingest_connected" }, new Date("2030-01-01T00:00:00Z"));
    expect(s).toEqual(frozen);
    expect(d.next.startedAt?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
  it("ACTIVE_STATES ∪ TERMINAL_STATES is the whole enum; isActive/isTerminal agree", () => {
    const all: SessionState[] = ["requested", "provisioning", "warming", "live", "ending", "completed", "failed"];
    expect([...ACTIVE_STATES, ...TERMINAL_STATES].sort()).toEqual([...all].sort());
    for (const s of all) expect(isActive(s)).toBe(!isTerminal(s));
  });
});

// Orchestrator ruling (Task 1 review, V410 amended): fixture_stream_sessions.fixture_id is NULLABLE,
// `on delete set null` — a deleted fixture must not destroy money, paid-resource and history rows. A
// session whose fixture was deleted keeps running until its normal end; the domain never reads fixtureId.
describe("a session whose fixture was deleted (fixtureId null)", () => {
  it("still ends through the normal commands — passthrough stop → ending → complete → completed, composed no-Machine stop → completed, warming credit refusal → failed — and fixtureId stays null", () => {
    const live = S({ state: "live", startedAt: T0, fixtureId: null });
    const e = decide(live, { type: "stop" }, T0);
    expect(e.next).toMatchObject({ state: "ending", desiredState: "ending", endReason: "stopped", endingAt: T0, fixtureId: null });
    expect(e.effects).toEqual([{ type: "complete_now" }]);
    const c = decide(e.next, { type: "complete" }, T0);
    expect(c.next).toMatchObject({ state: "completed", endedAt: T0, endReason: "stopped", fixtureId: null });
    expect(c.events).toEqual([{ type: "SessionEnded", reason: "completed" }]);

    const composed = decide(S({ state: "provisioning", mode: "composed", fixtureId: null }), { type: "stop" }, T0);
    expect(composed.next).toMatchObject({ state: "completed", endReason: "stopped", endedAt: T0, fixtureId: null });

    const refused = decide(S({ state: "warming", fixtureId: null }), { type: "credit_refused" }, T0);
    expect(refused.next).toMatchObject({ state: "failed", failReason: "no_credits", endedAt: T0, fixtureId: null });
  });
});

const PASSTHROUGH_COMMANDS: Command[] = [
  { type: "provision" }, { type: "provisioned" }, { type: "ingest_connected" }, { type: "credit_refused" },
  { type: "target_rejected" }, { type: "stop" }, { type: "complete" },
];
const ALL_STATES: SessionState[] = [...ACTIVE_STATES, ...TERMINAL_STATES];

// The passthrough half of the §6.4 table, typed HERE as the oracle — never derived from `decide` — so a deleted
// state guard (an illegal cell quietly made legal) reds. Every cell not listed must throw.
const PASSTHROUGH_LEGAL: Record<string, SessionState> = {
  "requested × provision": "provisioning",
  "requested × stop": "ending",
  "provisioning × provisioned": "warming",
  "provisioning × stop": "ending",
  "warming × ingest_connected": "live",
  "warming × credit_refused": "failed",
  "warming × target_rejected": "failed",
  "warming × stop": "ending",
  "live × target_rejected": "failed",
  "live × stop": "ending",
  "live × complete": "completed",
  "ending × stop": "ending",                                   // the benign repeat (identity)
  "ending × complete": "completed",
};

describe("decide — WHICH passthrough cells are legal (every state × every passthrough command)", () => {
  it("each listed cell lands on its state; every other cell throws InvalidTransition", () => {
    let legal = 0;
    for (const state of ALL_STATES) {
      for (const c of PASSTHROUGH_COMMANDS) {
        const cell = `${state} × ${c.type}`;
        const to = PASSTHROUGH_LEGAL[cell];
        if (to) { legal++; expect(decide(S({ state }), c, T0).next.state, cell).toBe(to); }
        else expect(() => decide(S({ state }), c, T0), cell).toThrow(InvalidTransition);
      }
    }
    expect(legal, "every oracle key names a real cell").toBe(Object.keys(PASSTHROUGH_LEGAL).length);
  });
});

describe("eventRowsOf — parity with the session table (every state × every passthrough command)", () => {
  it("every legal cell that changes state yields EXACTLY ONE transition row with from/to = the cell; a legal no-op yields none; an illegal cell throws before any row exists", () => {
    let legal = 0, changed = 0, illegal = 0;
    for (const state of ALL_STATES) {
      for (const c of PASSTHROUGH_COMMANDS) {
        const before = S({ state });
        let d;
        try { d = decide(before, c, T0); } catch (e) { expect(e).toBeInstanceOf(InvalidTransition); illegal++; continue; }
        legal++;
        const rows = eventRowsOf(before, d, c);
        const transitions = rows.filter((r) => r.kind === "transition");
        if (d.next.state !== state) {
          changed++;
          expect(transitions, `${state} × ${c.type}`).toHaveLength(1);
          expect(transitions[0]).toMatchObject({ source: "domain", type: c.type, from: state, to: d.next.state });
        } else {
          expect(transitions, `${state} × ${c.type}`).toHaveLength(0);
        }
        // Every DomainEvent that is not a state change is an `event` row, one each; nothing is dropped.
        expect(rows.filter((r) => r.kind === "event")).toHaveLength(d.events.filter((e) => !["RunnerChanged"].includes(e.type)).length);
        expect(rows.some((r) => r.kind === "runner_transition")).toBe(false);   // passthrough never touches the runner
      }
    }
    // The sweep is not vacuous: the table has legal cells, changed cells and illegal cells.
    expect(legal).toBeGreaterThan(0); expect(changed).toBeGreaterThan(0); expect(illegal).toBeGreaterThan(0);
    expect(legal + illegal).toBe(ALL_STATES.length * PASSTHROUGH_COMMANDS.length);
  });
  it("a terminal-state payload carries WHY: failReason on failed, endReason on ending (the chip and the inventory read these)", () => {
    const f = decide(S({ state: "warming" }), { type: "credit_refused" }, T0);
    expect(eventRowsOf(S({ state: "warming" }), f, { type: "credit_refused" })[0]!.payload).toEqual({ failReason: "no_credits" });
    const e = decide(S({ state: "live" }), { type: "stop" }, T0);
    expect(eventRowsOf(S({ state: "live" }), e, { type: "stop" })[0]!.payload).toEqual({ endReason: "stopped" });
  });
});

describe("decide — a composed session's Machine events go through the runner table (Task 2C)", () => {
  const BOOTING: Runner = { state: "booting", attempt: 1, name: "relay-s1-r1", machineId: "m1", stopRequestedAt: null, lastExit: null };
  const C = (over: Partial<Session> = {}): Session => S({ mode: "composed", state: "warming", runner: BOOTING, ...over });
  const STOP_EFFECT = { type: "runner", effect: { type: "stop_machine", signal: "SIGINT", timeoutSeconds: RUNNER_STOP_GRACE_SECONDS } };
  const FORCE = { type: "runner", effect: { type: "force_destroy" } };

  it("a composed stop routes through the runner: stop_machine SIGINT, ending(stopped), no complete_now", () => {
    const d = decide(C({ state: "live", startedAt: T0, runner: { ...BOOTING, state: "playing" } }), { type: "stop" }, T0);
    expect(d.next).toMatchObject({ state: "ending", desiredState: "ending", endReason: "stopped", runner: { state: "stopping", stopRequestedAt: T0 } });
    expect(d.effects).toEqual([STOP_EFFECT]);
    expect(d.events).toContainEqual({ type: "SessionEnding", endReason: "stopped" });
  });

  it("a composed warming timeout is failed(machine_boot_timeout) with the runner left stopping and NO end reason — in the row or the events (P1-F-b); passthrough's is failed(no_inbound_timeout)", () => {
    const c = decide(C(), { type: "expire", expiry: { kind: "warming_timeout" } }, T0);
    expect(c.next).toMatchObject({ state: "failed", failReason: "machine_boot_timeout", endReason: null, endedAt: T0, runner: { state: "stopping" } });
    expect(c.effects).toEqual([STOP_EFFECT]);
    expect(c.events).toEqual([{ type: "RunnerChanged", from: "booting", to: "stopping", trigger: "session_stop" }, { type: "SessionEnded", reason: "machine_boot_timeout" }]);
    const p = decide(S({ state: "warming" }), { type: "expire", expiry: { kind: "warming_timeout" } }, T0);
    expect(p.next).toMatchObject({ state: "failed", failReason: "no_inbound_timeout", endReason: null, runner: RUNNER_NONE });
    expect(p.effects).toEqual([]);
  });

  it("a composed session goes live ONLY through callback_playing (one consume); a replacement's callback_playing on a LIVE session consumes nothing", () => {
    const d = decide(C(), { type: "runner", trigger: { type: "callback_playing" } }, T0);
    expect(d.next).toMatchObject({ state: "live", startedAt: T0, runner: { state: "playing" } });
    expect(d.effects).toEqual([{ type: "consume_credit" }]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "booting", to: "playing", trigger: "callback_playing" }, { type: "SessionWentLive" }]);
    const replacement = decide(C({ state: "live", startedAt: T0, runner: { ...BOOTING, attempt: 2, name: "relay-s1-r2" } }), { type: "runner", trigger: { type: "callback_playing" } }, T0);
    expect(replacement.next).toMatchObject({ state: "live", startedAt: T0, runner: { state: "playing", attempt: 2 } });
    expect(replacement.effects).toEqual([]);
    expect(replacement.events).toEqual([{ type: "RunnerChanged", from: "booting", to: "playing", trigger: "callback_playing" }]);
  });

  it("C27: a TERMINAL composed session still accepts the runner's cleanup triggers — the runner advances, the session stays failed; any other command still throws", () => {
    const failed = decide(C(), { type: "expire", expiry: { kind: "warming_timeout" } }, T0).next;   // failed, runner stopping
    const exited = decide(failed, { type: "runner", trigger: { type: "callback_stopped" } }, T0);
    expect(exited.next).toMatchObject({ state: "failed", failReason: "machine_boot_timeout", runner: { state: "exited" } });
    const gone = decide(exited.next, { type: "runner", trigger: { type: "observed", state: "destroyed" } }, T0);
    expect(gone.next).toMatchObject({ state: "failed", failReason: "machine_boot_timeout", runner: { state: "destroyed" } });
    // The table's `completed` signal is IGNORED here: no second SessionEnded, no replay fill.
    expect(gone.events).toEqual([{ type: "RunnerChanged", from: "exited", to: "destroyed", trigger: "observed" }]);
    expect(gone.effects).toEqual([]);
    // A lost runner destroyed on attempt 1 signals retry — ignored: a failed session is never re-created.
    const lost = decide({ ...failed, runner: { ...BOOTING, state: "lost" } }, { type: "runner", trigger: { type: "destroy_ok" } }, T0);
    expect(lost.next).toMatchObject({ state: "failed", runnerRetries: 0, runner: { state: "destroyed" } });
    expect(lost.effects).toEqual([]);
    // The policy's grace_expired is cleanup too: stopping → force_destroy.
    const forced = decide(failed, { type: "expire", expiry: { kind: "grace_expired" } }, T0);
    expect(forced.next).toMatchObject({ state: "failed", runner: { state: "destroyed" } });
    expect(forced.effects).toEqual([FORCE]);
    // …and so is the same trigger arriving as a RUNNER command (the RUNNER_CLEANUP_TRIGGERS member, not the expire clause).
    const forcedByTrigger = decide(failed, { type: "runner", trigger: { type: "grace_expired" } }, T0);
    expect(forcedByTrigger.next).toMatchObject({ state: "failed", runner: { state: "destroyed" } });
    expect(forcedByTrigger.effects).toEqual([FORCE]);
    // P1-F-a: a warming timeout while a create is in flight fails the session with the stop MARKED; the create's return is cleanup too.
    const midCreate = decide(C({ runner: { ...BOOTING, state: "creating", machineId: null } }), { type: "expire", expiry: { kind: "warming_timeout" } }, T0).next;
    expect(midCreate).toMatchObject({ state: "failed", failReason: "machine_boot_timeout", endReason: null, runner: { state: "creating", stopRequestedAt: T0 } });
    const late = decide(midCreate, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, T0);
    expect(late.next).toMatchObject({ state: "failed", runner: { state: "destroyed", machineId: "m9" } });
    expect(late.effects).toEqual([FORCE]);   // no fill_replay: the completed signal is ignored
    expect(decide(midCreate, { type: "runner", trigger: { type: "create_failed", retryable: true } }, T0).next).toMatchObject({ state: "failed", runnerRetries: 0, runner: { state: "destroyed" } });
    // The negative pair: a non-cleanup trigger, a session command, and an expiry other than grace_expired still throw on a terminal session.
    expect(() => decide(failed, { type: "runner", trigger: { type: "session_stop" } }, T0)).toThrow(InvalidTransition);
    expect(() => decide(failed, { type: "stop" }, T0)).toThrow(InvalidTransition);
    expect(() => decide(failed, { type: "expire", expiry: { kind: "none" } }, T0)).toThrow(InvalidTransition);
  });

  it("P1-F-a: a composed stop while the runner is CREATING → ending(stopped) with the stop marked and no effect; the create's return then tears down at once → completed(stopped), never booting, retried or failed", () => {
    const CREATING: Runner = { ...BOOTING, state: "creating", machineId: null };
    const T1 = new Date(T0.getTime() + 60_000);
    // provisioning: the FIRST create is in flight (Task 10's provisionSession issues create_started before provisioned)
    const stopped = decide(S({ mode: "composed", state: "provisioning", runner: CREATING }), { type: "stop" }, T0);
    expect(stopped.next).toMatchObject({ state: "ending", desiredState: "ending", endReason: "stopped", endedAt: null, runner: { state: "creating", stopRequestedAt: T0 } });
    expect(stopped.effects).toEqual([]);
    expect(stopped.events).toEqual([{ type: "RunnerChanged", from: "creating", to: "creating", trigger: "session_stop" }, { type: "SessionEnding", endReason: "stopped" }]);
    // create_ok: no boot wait — force_destroy the id the call returned; the session completes. It never went live, so NO
    // replay fill (C4 — I3: fill_replay only for a session with startedAt; the brief's row expected one).
    const ok = decide(stopped.next, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, T1);
    expect(ok.next).toMatchObject({ state: "completed", endReason: "stopped", failReason: null, endedAt: T1, runner: { state: "destroyed", machineId: "m9" } });
    expect(ok.effects).toEqual([FORCE]);
    // create_failed, even retryable on attempt 1: no retry, no machine_create_failed — nothing was created
    const refused = decide(stopped.next, { type: "runner", trigger: { type: "create_failed", retryable: true } }, T1);
    expect(refused.next).toMatchObject({ state: "completed", endReason: "stopped", failReason: null, runnerRetries: 0, runner: { state: "destroyed" } });
    expect(refused.effects).toEqual([]);
    // …and a NON-retryable refusal is not machine_create_failed either: the organiser's stop, not the create, ended this
    // session. (The retryable row above cannot tell the mark check from its absence — the retry arm refuses a retry on
    // an ending session and completes it anyway — so this is the row that witnesses the check.)
    const refusedHard = decide(stopped.next, { type: "runner", trigger: { type: "create_failed", retryable: false } }, T1);
    expect(refusedHard.next).toMatchObject({ state: "completed", endReason: "stopped", failReason: null, runner: { state: "destroyed" } });
    expect(refusedHard.effects).toEqual([]);
    // the crash-safe reconcile finds the Machine by name after the stop: destroy it, never boot it
    const found = decide(stopped.next, { type: "runner", trigger: { type: "observed", state: "running" } }, T1);
    expect(found.next).toMatchObject({ state: "completed", endReason: "stopped", runner: { state: "destroyed" } });
    expect(found.effects).toEqual([FORCE]);
    // a replacement's create in flight in a LIVE session takes the same edge
    expect(decide(C({ state: "live", startedAt: T0, runner: { ...CREATING, attempt: 2, name: "relay-s1-r2" } }), { type: "stop" }, T0).next)
      .toMatchObject({ state: "ending", endReason: "stopped", runner: { state: "creating", stopRequestedAt: T0 } });
  });

  it("F14: the DEADLINE takes the stop's shape — no live Machine completes now with max_duration; a creating runner is marked and ends, and the create's return tears down; booting/playing keep the SIGINT. It never throws", () => {
    const CREATING: Runner = { ...BOOTING, state: "creating", machineId: null };
    const T1 = new Date(T0.getTime() + 60_000);
    const wall = { type: "expire", expiry: { kind: "wall_clock" } } as const;
    for (const runner of [RUNNER_NONE, { ...BOOTING, state: "destroyed" as const }]) {
      const d = decide(C({ state: "live", startedAt: T0, runner }), wall, T1);
      expect(d.next, runner.state).toMatchObject({ state: "completed", desiredState: "ending", endReason: "max_duration", failReason: null, endedAt: T1 });
      expect(d.effects, runner.state).toEqual([{ type: "fill_replay" }]);
    }
    const marked = decide(C({ state: "live", startedAt: T0, runner: CREATING }), wall, T0);
    expect(marked.next).toMatchObject({ state: "ending", desiredState: "ending", endReason: "max_duration", runner: { state: "creating", stopRequestedAt: T0 } });
    expect(marked.effects).toEqual([]);
    const ok = decide(marked.next, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, T1);
    expect(ok.next).toMatchObject({ state: "completed", endReason: "max_duration", failReason: null, runner: { state: "destroyed", machineId: "m9" } });
    expect(ok.effects).toEqual([FORCE, { type: "fill_replay" }]);   // this one WENT live (startedAt T0): the runner path fills
    const playing = decide(C({ state: "live", startedAt: T0, runner: { ...BOOTING, state: "playing" } }), wall, T0);
    expect(playing.next).toMatchObject({ state: "ending", endReason: "max_duration", runner: { state: "stopping" } });
    expect(playing.effects).toEqual([STOP_EFFECT]);
  });

  it("F15: a create that never returns after the mark is ended by the LAZY grace check (evaluate on every read, not the daily sweep); a late create_ok still destroys what it made", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const marked = C({ state: "ending", desiredState: "ending", endReason: "stopped", runner: { ...BOOTING, state: "creating", machineId: null, stopRequestedAt: T0 } });
    const late = new Date(T0.getTime() + grace * 1000);
    expect(evaluate(marked, late)).toEqual({ kind: "grace_expired" });           // the witness is the lazy read
    const done = decide(marked, { type: "expire", expiry: evaluate(marked, late) }, late);
    expect(done.next).toMatchObject({ state: "completed", endReason: "stopped", failReason: null, endedAt: late, runner: { state: "destroyed" } });
    expect(done.effects).toEqual([FORCE]);                                        // never went live (C4): no replay fill
    // The call finally returns on a COMPLETED session: destroy what it made, change nothing else, never throw.
    // Fix round 4: a Machine now exists whose destroy is unconfirmed, so the runner goes LOST (it was destroyed) — and on
    // this terminal row the confirmation then moves it to destroyed with nothing else (C27: no retry, no second ending).
    const stray = decide(done.next, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, late);
    expect(stray.next).toMatchObject({ state: "completed", endReason: "stopped", endedAt: late, runner: { state: "lost", machineId: "m9" } });
    expect(stray.effects).toEqual([FORCE]);
    const confirmed = decide(stray.next, { type: "runner", trigger: { type: "destroy_ok" } }, late);
    expect(confirmed.next).toMatchObject({ state: "completed", endReason: "stopped", runner: { state: "destroyed", machineId: "m9" } });
    expect(confirmed.effects).toEqual([]);
    expect(confirmed.events.map((e) => e.type)).toEqual(["RunnerChanged"]);
    expect(() => decide(done.next, { type: "runner", trigger: { type: "create_failed", retryable: true } }, late)).not.toThrow();
  });

  it("F16: a heartbeat landing BEFORE provisioned is ignored, never thrown (its carrier is a route the Machine retries); the next beat takes the session live with exactly one consume", () => {
    const beat = { type: "runner", trigger: { type: "callback_playing" } } as const;
    const ignored = decide(C({ state: "provisioning" }), beat, T0);
    expect(ignored.next).toMatchObject({ state: "provisioning", startedAt: null, runner: { state: "playing" } });
    expect(ignored.effects).toEqual([]);                                         // no consume: the session is not warming
    expect(ignored.events).toEqual([{ type: "RunnerChanged", from: "booting", to: "playing", trigger: "callback_playing" }]);
    const warming = decide(ignored.next, { type: "provisioned" }, T0);           // the ordinary next step still works
    expect(warming.next).toMatchObject({ state: "warming", runner: { state: "playing" } });
    const live = decide(warming.next, beat, T0);                                 // the Machine beats again: NOW it goes live
    expect(live.next).toMatchObject({ state: "live", startedAt: T0, runner: { state: "playing" } });
    expect(live.effects).toEqual([{ type: "consume_credit" }]);
    expect(decide(live.next, beat, T0).effects).toEqual([]);                     // and never a second consume
  });

  it("F17: a LOST runner is retried only while the session still wants to be live — the deadline and the stop destroy it and COMPLETE the session, and an ending one never boots a replacement into overtime", () => {
    const T1 = new Date(T0.getTime() + 60_000);
    const lost = { ...BOOTING, state: "lost" as const, attempt: 1 };
    // LIVE: the crash path's ONE retry is untouched.
    const live = decide(C({ state: "live", startedAt: T0, runner: lost }), { type: "runner", trigger: { type: "destroy_ok" } }, T1);
    // I4 (fix round 1): the retry restarts the beat WINDOW (beatWindowAt); heartbeatAt stays "last beat received" (none here)
    expect(live.next).toMatchObject({ state: "live", runnerRetries: 1, heartbeatAt: null, beatWindowAt: T1, runner: { state: "destroyed" } });
    expect(live.effects).toEqual([{ type: "retry_runner" }]);
    // The DEADLINE reaching the same runner ends it THERE — it never reaches destroy_ok's retry.
    const dead = decide(C({ state: "live", startedAt: T0, runner: lost }), { type: "expire", expiry: { kind: "wall_clock" } }, T1);
    expect(dead.next).toMatchObject({ state: "completed", endReason: "max_duration", endedAt: T1, runnerRetries: 0, runner: { state: "destroyed" } });
    expect(dead.effects).toEqual([FORCE, { type: "fill_replay" }]);
    const stopped = decide(C({ state: "live", startedAt: T0, runner: lost }), { type: "stop" }, T1);
    expect(stopped.next).toMatchObject({ state: "completed", endReason: "stopped", runnerRetries: 0 });
    // and a session already ENDING refuses the retry outright, however its lost runner got there: it completes.
    // (C4: the fixture WENT live — startedAt T0 — so the replay fill below is owed; without it the row would expect none.)
    const ending = decide(C({ state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0, runner: lost }), { type: "runner", trigger: { type: "destroy_ok" } }, T1);
    expect(ending.next).toMatchObject({ state: "completed", endReason: "stopped", endedAt: T1, runnerRetries: 0 });
    expect(ending.effects).toEqual([{ type: "fill_replay" }]);                   // no retry_runner, and nothing to destroy
    expect(ending.events).toEqual([{ type: "RunnerChanged", from: "lost", to: "destroyed", trigger: "destroy_ok" }, { type: "SessionEnded", reason: "completed" }]);
  });

  it("F20: once the wall clock is APPLIED, no route acquires a replacement runner — every runner state stops wanting to be live, and no trigger then retries", () => {
    const past = new Date(T0.getTime() + (MAX_DURATION_MINUTES + 1) * 60_000);
    const sample = (t: RunnerTrigger["type"]): RunnerTrigger =>
      t === "create_started" ? { type: "create_started", name: "relay-s1-r2", attempt: 2 }
      : t === "create_ok" ? { type: "create_ok", machineId: "m9" }
      : t === "create_failed" ? { type: "create_failed", retryable: true }
      : t === "observed" ? { type: "observed", state: "destroyed" }
      : ({ type: t } as RunnerTrigger);
    let swept = 0, retryablePositions = 0;
    for (const rs of RUNNER_STATES) {
      // stopping/exited exist ONLY after a stop, so those rows start where the deadline would have put them.
      const stopped = rs === "stopping" || rs === "exited";
      const before = C({
        state: stopped ? "ending" : "live", desiredState: stopped ? "ending" : "live",
        endReason: stopped ? "stopped" : null, startedAt: T0,
        runner: { ...BOOTING, state: rs, attempt: 1, stopRequestedAt: stopped ? T0 : null },
      });
      const after = stopped ? before : decide(before, { type: "expire", expiry: { kind: "wall_clock" } }, past).next;
      swept++;
      // THIS is what runner()'s retry arm reads: a session past its deadline never wants to be live again.
      expect(after.desiredState, rs).toBe("ending");
      for (const t of RUNNER_TRIGGER_TYPES) {
        let d;
        try { d = decide(after, { type: "runner", trigger: sample(t) }, past); } catch { continue; }
        expect(d.effects, `${rs} × ${t}`).not.toContainEqual({ type: "retry_runner" });
        expect(d.events.map((e) => e.type), `${rs} × ${t}`).not.toContain("RunnerRetried");
        // One trigger deeper (Task 2C): a single trigger never reaches a retry signal here, so a one-step walk could not
        // witness the retry arm's ending guard at all. A step that leaves a still-running session's runner `lost` (a marked
        // create declared lost by a stale beat) is where the next destroy WOULD retry — it must complete instead.
        if (!["completed", "failed"].includes(d.next.state) && d.next.runner.state === "lost") retryablePositions++;
        for (const t2 of RUNNER_TRIGGER_TYPES) {
          let d2;
          try { d2 = decide(d.next, { type: "runner", trigger: sample(t2) }, past); } catch { continue; }
          expect(d2.effects, `${rs} × ${t} × ${t2}`).not.toContainEqual({ type: "retry_runner" });
          expect(d2.events.map((e) => e.type), `${rs} × ${t} × ${t2}`).not.toContain("RunnerRetried");
        }
      }
    }
    expect(swept).toBe(RUNNER_STATES.length);                                    // not vacuous: every row was walked
    expect(retryablePositions).toBeGreaterThan(0);                               // …and the second step starts from a retryable runner
  });

  // Task 2C carry C3 — the killer Task 2A's I2 ruling owed: the composed branch of `credit_refused` always reached the
  // throwing stepRunner stub, so no 2A test could see it. Mutant: delete the composed branch → red here.
  it("C3 (I2): a COMPOSED credit refusal tears the Machine down like the warming timeout — the SIGINT stop, desiredState ending, failed(no_credits) with no end reason; the teardown then finishes on the failed row; passthrough and a composed row with no runner just fail", () => {
    const d = decide(C(), { type: "credit_refused" }, T0);
    expect(d.next).toMatchObject({ state: "failed", failReason: "no_credits", desiredState: "ending", endReason: null, endedAt: T0, runner: { state: "stopping", stopRequestedAt: T0 } });
    expect(d.effects).toEqual([STOP_EFFECT]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "booting", to: "stopping", trigger: "session_stop" }, { type: "SessionEnded", reason: "no_credits" }]);
    // the SIGINT's confirmation lands on the FAILED session (C27) and the Machine goes on to destroyed
    const exited = decide(d.next, { type: "runner", trigger: { type: "callback_stopped" } }, T0);
    expect(exited.next).toMatchObject({ state: "failed", failReason: "no_credits", runner: { state: "exited" } });
    // no Machine asked for: nothing to tear down
    const bare = decide(C({ runner: RUNNER_NONE }), { type: "credit_refused" }, T0);
    expect(bare.next).toMatchObject({ state: "failed", failReason: "no_credits", runner: RUNNER_NONE });
    expect(bare.effects).toEqual([]);
    const passthrough = decide(S({ state: "warming" }), { type: "credit_refused" }, T0);
    expect(passthrough.effects).toEqual([]);
    expect(passthrough.events).toEqual([{ type: "SessionEnded", reason: "no_credits" }]);
  });

  // Task 2C carry C5 (M6 from the Task 2B review): F19's backstop completed an `ending` session over an UNMARKED creating
  // runner — a create still in flight — so the Machine it later made was caught only by the daily orphan sweep.
  it("C5 (M6): an ending_timeout over an UNMARKED creating runner MARKS the stop instead of completing blind — the grace then ends it on a lazy read, and a late create_ok is destroyed, never booted", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const unmarked = C({
      state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0, endingAt: T0,
      runner: { ...BOOTING, state: "creating", attempt: 2, name: "relay-s1-r2", machineId: null },
    });
    const timeout = at(ENDING_TIMEOUT_SECONDS);
    expect(evaluate(unmarked, timeout)).toEqual({ kind: "ending_timeout" });
    const marked = decide(unmarked, { type: "expire", expiry: evaluate(unmarked, timeout) }, timeout);
    expect(marked.next).toMatchObject({ state: "ending", endReason: "stopped", endedAt: null, runner: { state: "creating", stopRequestedAt: timeout } });
    expect(marked.effects).toEqual([]);
    // the create returns: destroy the Machine it made, complete
    const ok = decide(marked.next, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, timeout);
    expect(ok.next).toMatchObject({ state: "completed", endReason: "stopped", runner: { state: "destroyed", machineId: "m9" } });
    expect(ok.effects).toEqual([FORCE, { type: "fill_replay" }]);
    // or nothing ever returns. Inside the grace window the ending timer still answers (the grace clause speaks only once
    // past it), so a read there re-decides ending_timeout — and must KEEP the first mark: a mark moved to every read's
    // `now` would restart the grace clock on each 5 s poll and the session would never end.
    const inside = at(ENDING_TIMEOUT_SECONDS + grace - 1);
    expect(evaluate(marked.next, inside)).toEqual({ kind: "ending_timeout" });
    const reread = decide(marked.next, { type: "expire", expiry: evaluate(marked.next, inside) }, inside);
    expect(reread.next).toMatchObject({ state: "ending", runner: { state: "creating", stopRequestedAt: timeout } });
    expect(reread.effects).toEqual([]);
    // …so the next lazy read past the grace ends it
    const graceAt = at(ENDING_TIMEOUT_SECONDS + grace);
    expect(evaluate(reread.next, graceAt)).toEqual({ kind: "grace_expired" });
    const done = decide(reread.next, { type: "expire", expiry: evaluate(reread.next, graceAt) }, graceAt);
    expect(done.next).toMatchObject({ state: "completed", endReason: "stopped", endedAt: graceAt, runner: { state: "destroyed" } });
    expect(done.effects).toEqual([FORCE, { type: "fill_replay" }]);
    // the positive pair: with no Machine in flight the timeout still completes at once
    const idle = { ...unmarked, runner: { ...unmarked.runner, state: "destroyed" as const, machineId: "m1" } };
    expect(decide(idle, { type: "expire", expiry: { kind: "ending_timeout" } }, timeout).next).toMatchObject({ state: "completed", endReason: "stopped" });
  });

  // Task 2C review M2 (fix round 1): F19's backstop completed an `ending` session over a LOST runner with nothing re-issued,
  // leaving the Machine to the orphan sweep. It now routes through `session_stop` like C5 — and the stop it routes through
  // must never overwrite the reason the session ended for: a deadline's max_duration stays max_duration.
  it("M2: an ending_timeout over a LOST runner re-issues the teardown and completes with the session's OWN end reason (max_duration is never overwritten by the stop it routes through)", () => {
    const timeout = new Date(T0.getTime() + ENDING_TIMEOUT_SECONDS * 1000);
    for (const endReason of ["max_duration", "stopped"] as const) {
      const lostEnding = C({ state: "ending", desiredState: "ending", endReason, startedAt: T0, endingAt: T0, runner: { ...BOOTING, state: "lost" } });
      expect(evaluate(lostEnding, timeout), endReason).toEqual({ kind: "ending_timeout" });
      const d = decide(lostEnding, { type: "expire", expiry: evaluate(lostEnding, timeout) }, timeout);
      expect(d.next, endReason).toMatchObject({ state: "completed", endReason, endedAt: timeout, runner: { state: "destroyed", machineId: "m1" } });
      expect(d.effects, endReason).toEqual([FORCE, { type: "fill_replay" }]);
      expect(d.events, endReason).toEqual([{ type: "RunnerChanged", from: "lost", to: "destroyed", trigger: "session_stop" }, { type: "SessionEnded", reason: "completed" }]);
    }
  });

  // Fix round 3, ruling (a) — `lost × grace_expired / orphan_listed` STAY lost, re-issuing force_destroy (destroyed means
  // CONFIRMED gone). Round 2 measured the defect through decide → evaluate → decide: those two cells moved a live session's
  // runner to destroyed with nothing confirmed, and the next stale beat answered [retry_runner]. These three tests are the
  // session-level safety twin and the LIVENESS guard the ruling asked for: a lost runner that no longer leaves on a force
  // must still let every ending and terminal session finish.
  it("R3 (a), safety: on a LIVE session a lost runner's grace_expired / orphan_listed re-issues the teardown and stays lost — the next stale beat re-issues it again and NEVER retries; only the confirmed destroy retries, once", () => {
    const t1 = new Date(T0.getTime() + 60_000);
    const beat = new Date(T0.getTime() + STALE_HEARTBEAT_SECONDS * 1000);
    for (const type of ["grace_expired", "orphan_listed"] as const) {
      const s = C({ state: "live", startedAt: T0, heartbeatAt: T0, runner: { ...BOOTING, state: "lost" } });
      const forced = decide(s, { type: "runner", trigger: { type } }, t1);
      expect(forced.next, type).toMatchObject({ state: "live", runnerRetries: 0, runner: { state: "lost", attempt: 1, machineId: "m1" } });
      expect(forced.effects, type).toEqual([FORCE]);
      expect(evaluate(forced.next, beat), type).toEqual({ kind: "stale_beat" });
      const stale = decide(forced.next, { type: "expire", expiry: evaluate(forced.next, beat) }, beat);
      expect(stale.effects, type).toEqual([FORCE]);                              // round 2 measured [retry_runner] here
      expect(stale.next, type).toMatchObject({ state: "live", runnerRetries: 0, runner: { state: "lost" } });
      const gone = decide(stale.next, { type: "runner", trigger: { type: "destroy_ok" } }, beat);
      expect(gone.effects, type).toEqual([{ type: "retry_runner" }]);
      expect(gone.next, type).toMatchObject({ state: "live", runnerRetries: 1, runner: { state: "destroyed" } });
    }
  });

  it("R3 (a), liveness — ENDING: a lost runner (marked or not) whose grace_expired / orphan_listed only re-issued the teardown still COMPLETES at the ending timeout, with its own end reason — none one second before", () => {
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    for (const stopRequestedAt of [null, T0]) {
      for (const endReason of ["stopped", "max_duration"] as const) {
        const label = `${stopRequestedAt ? "marked" : "unmarked"} ${endReason}`;
        const s = C({ state: "ending", desiredState: "ending", endReason, startedAt: T0, endingAt: T0, runner: { ...BOOTING, state: "lost", stopRequestedAt } });
        const graced = decide(s, { type: "expire", expiry: { kind: "grace_expired" } }, at(1));
        expect(graced.next, label).toMatchObject({ state: "ending", endReason, endedAt: null, runner: { state: "lost" } });
        expect(graced.effects, label).toEqual([FORCE]);
        const listed = decide(graced.next, { type: "runner", trigger: { type: "orphan_listed" } }, at(2));
        expect(listed.next, label).toMatchObject({ state: "ending", runner: { state: "lost" } });
        expect(listed.effects, label).toEqual([FORCE]);
        // the bound: a lost runner is never grace-timed (evaluate times stopping / exited / creating), so the ENDING timeout is
        // what finishes it — measured from endingAt, exactly as for any other ending session
        expect(evaluate(listed.next, at(ENDING_TIMEOUT_SECONDS - 1)), label).toEqual({ kind: "none" });
        expect(evaluate(listed.next, at(ENDING_TIMEOUT_SECONDS)), label).toEqual({ kind: "ending_timeout" });
        const done = decide(listed.next, { type: "expire", expiry: evaluate(listed.next, at(ENDING_TIMEOUT_SECONDS)) }, at(ENDING_TIMEOUT_SECONDS));
        expect(done.next, label).toMatchObject({ state: "completed", endReason, endedAt: at(ENDING_TIMEOUT_SECONDS), runner: { state: "destroyed" } });
        expect(done.effects, label).toEqual([FORCE, { type: "fill_replay" }]);
        expect(evaluate(done.next, at(10 * ENDING_TIMEOUT_SECONDS)), label).toEqual({ kind: "none" });
      }
    }
  });

  it("R3 (a), liveness — TERMINAL (C27): a completed or failed session whose runner is lost accepts the re-issued teardown (grace_expired, by expiry or trigger) without throwing and without touching the session; the confirmed destroy then moves the runner and signals nothing", () => {
    const rows: Session[] = [
      C({ state: "completed", desiredState: "ending", endReason: "stopped", startedAt: T0, endedAt: T0, runner: { ...BOOTING, state: "lost" } }),
      C({ state: "failed", failReason: "target_rejected", endedAt: T0, runner: { ...BOOTING, state: "lost" } }),
    ];
    for (const s of rows) {
      const commands: Command[] = [{ type: "expire", expiry: { kind: "grace_expired" } }, { type: "runner", trigger: { type: "grace_expired" } }];
      for (const command of commands) {
        const label = `${s.state} × ${command.type}`;
        let d: ReturnType<typeof decide> | undefined;
        expect(() => { d = decide(s, command, T0); }, label).not.toThrow();
        expect(d!.next, label).toEqual({ ...s, runner: s.runner });
        expect(d!.effects, label).toEqual([FORCE]);
        expect(d!.events, label).toEqual([{ type: "RunnerChanged", from: "lost", to: "lost", trigger: "grace_expired" }]);
      }
      const gone = decide(s, { type: "runner", trigger: { type: "destroy_ok" } }, T0);
      expect(gone.next, s.state).toEqual({ ...s, runner: { ...s.runner, state: "destroyed" } });
      expect(gone.effects, s.state).toEqual([]);                                  // C27: no retry_runner, no second ending
      expect(gone.events.map((e) => e.type), s.state).toEqual(["RunnerChanged"]);
    }
  });

  // Fix round 4 (ruling on round 3's residual): a LATE create_ok into a DESTROYED runner is a Machine whose destroy is not
  // confirmed. It goes lost, so the retry waits for destroy_ok / observed destroyed exactly as the crash path does.
  it("R4, safety: a LIVE session whose destroyed runner awaits its retry gets a late create_ok → lost + force_destroy on that id, no retry; the next stale beat re-issues it and still never retries; the confirmed destroy then retries ONCE (runnerRetries stays 1)", () => {
    const beat = new Date(T0.getTime() + STALE_HEARTBEAT_SECONDS * 1000);
    const waiting = C({ state: "live", startedAt: T0, heartbeatAt: T0, runnerRetries: 1, runner: { ...BOOTING, state: "destroyed" } });
    const late = decide(waiting, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, T0);
    expect(late.next).toMatchObject({ state: "live", runnerRetries: 1, runner: { state: "lost", attempt: 1, machineId: "m9" } });
    expect(late.effects).toEqual([FORCE]);
    expect(late.events).toEqual([{ type: "RunnerChanged", from: "destroyed", to: "lost", trigger: "create_ok" }]);
    expect(evaluate(late.next, beat)).toEqual({ kind: "stale_beat" });
    const stale = decide(late.next, { type: "expire", expiry: evaluate(late.next, beat) }, beat);
    expect(stale.effects).toEqual([FORCE]);                                      // round 3's residual answered [retry_runner] here
    expect(stale.next).toMatchObject({ state: "live", runner: { state: "lost", machineId: "m9" } });
    const gone = decide(stale.next, { type: "runner", trigger: { type: "destroy_ok" } }, beat);
    expect(gone.effects).toEqual([{ type: "retry_runner" }]);
    expect(gone.next).toMatchObject({ state: "live", runnerRetries: 1, runner: { state: "destroyed", attempt: 1 } });
  });

  // SEEDED, and unreachable by any planned caller since F-A (lane-A minors, Task 2C
  // post-review m3 — the sibling at fix5-I1 says so about its own seed and this one
  // did not). F-A completes the row at the stop grace, so an ending session no longer
  // survives to its ending timeout on this path. The guard is defence in depth and the
  // walk below owns the reachable set; this `it` pins the arm itself.
  it("R4, liveness — ENDING (seeded): an ending session whose destroyed runner gets a late create_ok (now lost) still COMPLETES at its ending timeout with its own end reason, re-issuing the teardown", () => {
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    for (const endReason of ["stopped", "max_duration"] as const) {
      const s = C({ state: "ending", desiredState: "ending", endReason, startedAt: T0, endingAt: T0, runner: { ...BOOTING, state: "destroyed" } });
      const late = decide(s, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, at(1));
      expect(late.next, endReason).toMatchObject({ state: "ending", endReason, runner: { state: "lost", machineId: "m9" } });
      expect(late.effects, endReason).toEqual([FORCE]);
      expect(evaluate(late.next, at(ENDING_TIMEOUT_SECONDS - 1)), endReason).toEqual({ kind: "none" });
      const done = decide(late.next, { type: "expire", expiry: evaluate(late.next, at(ENDING_TIMEOUT_SECONDS)) }, at(ENDING_TIMEOUT_SECONDS));
      expect(done.next, endReason).toMatchObject({ state: "completed", endReason, endedAt: at(ENDING_TIMEOUT_SECONDS), runner: { state: "destroyed", machineId: "m9" } });
      expect(done.effects, endReason).toEqual([FORCE, { type: "fill_replay" }]);
    }
  });

  // Fix round 5, re-review 2 I1: round 4 made `ending + lost` reachable (a late create_ok after the stop grace destroyed the
  // runner), and a CONFIRMED destroy of a lost runner on the LAST attempt signals `failed` — whose arm had no ending guard, so
  // the organiser's stopped (or max_duration) stream became failed(machine_crash) with no replay. Attempt 1 signals `retry`,
  // whose arm already completes an ending session (F17). Both must complete with the session's own reason and the fill.
  // Task 2C-post, F-A: the stop grace's forced destroy now COMPLETES the session, so the route this row was found on lands the
  // late create_ok on a COMPLETED row (C27: torn down, session untouched) — pinned first below. No stop reaches `ending` with a
  // destroyed runner any more, so the guard itself is witnessed from that position SEEDED as the no-signal cell left it (the
  // R4 / R3 liveness rows seed theirs the same way): the arms keep their ending guards as defence in depth.
  it("fix5-I1: an ENDING session whose late create_ok (now lost) is then CONFIRMED destroyed completes with its OWN end reason and the replay fill — at attempt 1 (retry signal) and at the LAST attempt (failed signal), by destroy_ok or observed destroyed; since F-A the stop grace completes first, and the same late create_ok and confirmation on that COMPLETED row change nothing but the runner", () => {
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const confirms: RunnerTrigger[] = [{ type: "destroy_ok" }, { type: "observed", state: "destroyed" }];
    for (const attempt of [1, RUNNER_MAX_ATTEMPTS]) {
      for (const endReason of ["stopped", "max_duration"] as const) {
        for (const confirm of confirms) {
          const label = `attempt ${attempt} / ${endReason} / ${confirm.type}`;
          const playing: Runner = { ...BOOTING, state: "playing", attempt, name: `relay-s1-r${attempt}` };
          const live = C({ state: "live", startedAt: T0, heartbeatAt: T0, runnerRetries: attempt - 1, runner: playing });
          const end: Command = endReason === "stopped" ? { type: "stop" } : { type: "expire", expiry: { kind: "wall_clock" } };
          const stopping = decide(live, end, at(0));
          expect(stopping.next, label).toMatchObject({ state: "ending", endReason, runner: { state: "stopping" } });
          expect(evaluate(stopping.next, at(grace)), label).toEqual({ kind: "grace_expired" });
          const forced = decide(stopping.next, { type: "expire", expiry: evaluate(stopping.next, at(grace)) }, at(grace));
          expect(forced.next, label).toMatchObject({ state: "completed", endReason, endedAt: at(grace), runner: { state: "destroyed" } });
          expect(forced.effects, label).toEqual([FORCE, { type: "fill_replay" }]);
          // F-A: the late create_ok and its confirmation land on the COMPLETED row — the new Machine is destroyed, nothing else moves
          const lateOnCompleted = decide(forced.next, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, at(grace + 1));
          expect(lateOnCompleted.next, label).toEqual({ ...forced.next, runner: { ...forced.next.runner, state: "lost", machineId: "m9" } });
          expect(lateOnCompleted.effects, label).toEqual([FORCE]);
          const confirmedOnCompleted = decide(lateOnCompleted.next, { type: "runner", trigger: confirm }, at(grace + 2));
          expect(confirmedOnCompleted.next, label).toEqual({ ...lateOnCompleted.next, runner: { ...lateOnCompleted.next.runner, state: "destroyed" } });
          expect(confirmedOnCompleted.effects, label).toEqual([]);                  // no retry_runner, no second fill
          expect(confirmedOnCompleted.events.map((e) => e.type), label).toEqual(["RunnerChanged"]);
          // the guard: the ENDING row the pre-F-A no-signal cell left behind (runner destroyed, session still ending), seeded
          const endingDestroyed: Session = { ...stopping.next, runner: { ...stopping.next.runner, state: "destroyed" } };
          const late = decide(endingDestroyed, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, at(grace + 1));
          expect(late.next, label).toMatchObject({ state: "ending", endReason, runner: { state: "lost", attempt, machineId: "m9" } });
          expect(late.effects, label).toEqual([FORCE]);
          const done = decide(late.next, { type: "runner", trigger: confirm }, at(grace + 2));
          expect(done.next, label).toMatchObject({
            state: "completed", desiredState: "ending", endReason, failReason: null, endedAt: at(grace + 2), runnerRetries: attempt - 1,
            runner: { state: "destroyed", attempt, machineId: "m9" },
          });
          expect(done.effects, label).toEqual([{ type: "fill_replay" }]);
          expect(done.events, label).toEqual([{ type: "RunnerChanged", from: "lost", to: "destroyed", trigger: confirm.type }, { type: "SessionEnded", reason: "completed" }]);
        }
      }
    }
  });

  // Fix round 5, re-review 2 G1: the organiser's stop on a PROVISIONING session whose runner is LOST (F16: create_ok, then an
  // observed failure, before `provisioned`) goes through lost's session_stop — force_destroy + `completed` — and the completed
  // arm dropped the signal for provisioning: the stop was swallowed (still provisioning, desiredState live) and the session
  // later failed provision_timeout. It completes stopped, like the same stop on a live or warming session (F17).
  it("G1: the organiser's stop on a PROVISIONING session whose runner is lost completes it stopped (no replay: it never went live) — never swallowed into a later provision_timeout", () => {
    const provisioning = C({ state: "provisioning", runner: { ...BOOTING, state: "lost" } });
    const d = decide(provisioning, { type: "stop" }, T0);
    expect(d.next).toMatchObject({ state: "completed", desiredState: "ending", endReason: "stopped", failReason: null, endedAt: T0, runner: { state: "destroyed", machineId: "m1" } });
    expect(d.effects).toEqual([FORCE]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "lost", to: "destroyed", trigger: "session_stop" }, { type: "SessionEnded", reason: "completed" }]);
    expect(evaluate(d.next, new Date(T0.getTime() + 24 * 3600 * 1000))).toEqual({ kind: "none" });
  });

  // The whole command vocabulary `decide` accepts — each Machine trigger and payload, every expiry kind, every session command —
  // and the walk node key. Shared by the full-depth decide walks below (R4, F-A).
  const triggers = (r: Runner): RunnerTrigger[] => RUNNER_TRIGGER_TYPES.flatMap((t): RunnerTrigger[] =>
    t === "observed" ? OBSERVED_STATES.map((state) => ({ type: "observed" as const, state }))
    : t === "create_failed" ? [{ type: "create_failed", retryable: true }, { type: "create_failed", retryable: false }]
    : t === "create_started" ? [{ type: "create_started", name: `relay-s1-r${r.attempt + 1}`, attempt: r.attempt + 1 }]
    : t === "create_ok" ? [{ type: "create_ok", machineId: "m9" }]
    : [{ type: t } as RunnerTrigger]);
  const EXPIRIES: Expiry["kind"][] = ["none", "requested_timeout", "provision_timeout", "warming_timeout", "wall_clock", "stale_beat", "grace_expired", "ending_timeout"];
  const SESSION_COMMANDS: Command[] = [{ type: "provision" }, { type: "provisioned" }, { type: "ingest_connected" }, { type: "credit_refused" }, { type: "target_rejected" }, { type: "stop" }, { type: "complete" }];
  const commandsFor = (s: Session): Command[] => [
    ...triggers(s.runner).map((trigger): Command => ({ type: "runner", trigger })),
    ...EXPIRIES.map((kind): Command => ({ type: "expire", expiry: { kind } } as Command)),
    ...SESSION_COMMANDS,
  ];
  const key = (s: Session): string =>
    [s.state, s.desiredState, s.startedAt ? "started" : "unstarted", s.runner.state, s.runner.attempt, s.runner.stopRequestedAt ? "marked" : "unmarked"].join(":");

  // Fix round 4: the MARKED creating cells (create_ok, observed found, grace_expired) KEEP destroyed + force_destroy + completed.
  // The ruling allows that only if no retry is reachable afterwards — so this proves it through the real `decide`, not the
  // runner walk's path cut: from every session that can hold a marked creating runner (a stop or the deadline in
  // provisioning / warming / live, F19's ending_timeout, and the three failures that tear a create down), walk EVERY command
  // decide accepts — each Machine trigger and payload, every expiry kind, every session command — and no decision anywhere
  // emits retry_runner.
  it("R4: a marked creating runner's force-only destroyed can never be followed by retry_runner — walked through decide from every session that can mark a create", () => {
    const CREATING: Runner = { ...BOOTING, state: "creating", machineId: null };
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const seeds: [string, Session, Command][] = [
      ["provisioning × stop", C({ state: "provisioning", runner: CREATING }), { type: "stop" }],
      ["warming × stop", C({ state: "warming", runner: CREATING }), { type: "stop" }],
      ["live replacement × stop", C({ state: "live", startedAt: T0, runner: { ...CREATING, attempt: 2, name: "relay-s1-r2" } }), { type: "stop" }],
      ["live replacement × wall_clock", C({ state: "live", startedAt: T0, runner: { ...CREATING, attempt: 2, name: "relay-s1-r2" } }), { type: "expire", expiry: { kind: "wall_clock" } }],
      ["ending × ending_timeout (C5)", C({ state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0, endingAt: T0, runner: CREATING }), { type: "expire", expiry: { kind: "ending_timeout" } }],
      ["warming × warming_timeout", C({ state: "warming", runner: CREATING }), { type: "expire", expiry: { kind: "warming_timeout" } }],
      ["warming × credit_refused", C({ state: "warming", runner: CREATING }), { type: "credit_refused" }],
      ["provisioning × provision_timeout", C({ state: "provisioning", runner: CREATING }), { type: "expire", expiry: { kind: "provision_timeout" } }],
    ];
    let decisions = 0, keptCellsTaken = 0;
    const retried: string[] = [];
    for (const [label, before, command] of seeds) {
      const seeded = decide(before, command, at(1)).next;
      expect(seeded.runner, label).toMatchObject({ state: "creating", stopRequestedAt: at(1) });   // not vacuous: the seed MARKED the create
      expect(["ending", "failed"], label).toContain(seeded.state);
      const seen = new Set<string>();
      const stack: [Session, string[]][] = [[seeded, [label]]];
      while (stack.length > 0) {
        const [s, path] = stack.pop()!;
        if (seen.has(key(s))) continue;
        seen.add(key(s));
        for (const c of commandsFor(s)) {
          let d: ReturnType<typeof decide>;
          try { d = decide(s, c, at(2)); } catch (e) {
            expect(e instanceof InvalidTransition || e instanceof InvalidRunnerTransition, [...path, JSON.stringify(c)].join(" → ")).toBe(true);
            continue;
          }
          decisions++;
          const here = [...path, `${s.state}/${s.runner.state} × ${c.type === "runner" ? c.trigger.type : c.type === "expire" ? c.expiry.kind : c.type}`];
          if (s.runner.state === "creating" && s.runner.stopRequestedAt && d.next.runner.state === "destroyed" && d.effects.some((e) => e.type === "runner" && e.effect.type === "force_destroy")) keptCellsTaken++;
          if (d.effects.some((e) => e.type === "retry_runner")) retried.push(here.join(" → "));
          stack.push([d.next, here]);
        }
      }
    }
    expect(retried, `retry_runner after a marked create: ${retried.slice(0, 3).join(" ;; ")}`).toEqual([]);
    expect(decisions).toBeGreaterThan(seeds.length);
    expect(keptCellsTaken).toBeGreaterThan(0);                                     // the kept cells WERE walked through
  });

  // Task 2C-post, ruling F-A (a): the grace force-destroy out of `stopping` / `exited` signalled NOTHING, so an organiser stop
  // (or the deadline) whose Machine never auto-destroys sat `ending` until ENDING_TIMEOUT_SECONDS from endingAt — 300 s —
  // while Task 10's "a Machine that never auto-destroys is FORCED after grace + slack" and Task 12's BACKSTOP expect
  // `completed` on the read that forces it. The forced destroy now signals `completed`, and the session completes THERE.
  it("F-A: an organiser stop whose Machine never auto-destroys COMPLETES on the lazy read that forces it at grace + slack — stopped, force_destroy, the replay fill only if it went live — from stopping AND exited; the destroy's confirmation then lands on the completed row (C27) and changes nothing", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const confirms: RunnerTrigger[] = [{ type: "destroy_ok" }, { type: "observed", state: "destroyed" }];
    const cases: [string, Session][] = [
      ["live, went live", C({ state: "live", startedAt: T0, heartbeatAt: T0, runner: { ...BOOTING, state: "playing" } })],
      ["warming, never went live", C({ state: "warming", runner: BOOTING })],
    ];
    for (const [name, before] of cases) {
      const stopping = decide(before, { type: "stop" }, at(0));
      expect(stopping.next, name).toMatchObject({ state: "ending", endReason: "stopped", endingAt: at(0), runner: { state: "stopping", stopRequestedAt: at(0) } });
      for (const via of ["stopping", "exited"] as const) {
        const label = `${name} / ${via}`;
        const held = via === "stopping" ? stopping.next : decide(stopping.next, { type: "runner", trigger: { type: "callback_stopped" } }, at(1)).next;
        expect(held.runner.state, label).toBe(via);
        expect(evaluate(held, at(grace - 1)), label).toEqual({ kind: "none" });
        expect(evaluate(held, at(grace)), label).toEqual({ kind: "grace_expired" });
        const done = decide(held, { type: "expire", expiry: evaluate(held, at(grace)) }, at(grace));
        expect(done.next, label).toEqual({ ...held, state: "completed", desiredState: "ending", endReason: "stopped", failReason: null, endedAt: at(grace), runner: { ...held.runner, state: "destroyed" } });
        expect(done.effects, label).toEqual(before.startedAt ? [FORCE, { type: "fill_replay" }] : [FORCE]);
        expect(done.events, label).toEqual([{ type: "RunnerChanged", from: via, to: "destroyed", trigger: "grace_expired" }, { type: "SessionEnded", reason: "completed" }]);
        expect(evaluate(done.next, at(10 * ENDING_TIMEOUT_SECONDS)), label).toEqual({ kind: "none" });   // nothing left to time
        // Task 10 follows the force_destroy with destroy_ok, and Fly may report the Machine destroyed: both are C27 cleanup.
        for (const confirm of confirms) {
          let after: ReturnType<typeof decide> | undefined;
          expect(() => { after = decide(done.next, { type: "runner", trigger: confirm }, at(grace + 1)); }, `${label} × ${confirm.type}`).not.toThrow();
          expect(after!.next, `${label} × ${confirm.type}`).toEqual(done.next);
          expect(after!.effects, `${label} × ${confirm.type}`).toEqual([]);                  // no second fill, no retry
          expect(after!.events, `${label} × ${confirm.type}`).toEqual([{ type: "RunnerChanged", from: "destroyed", to: "destroyed", trigger: confirm.type }]);
        }
      }
    }
  });

  it("F-A: the DEADLINE's forced destroy completes with max_duration — the session's own end reason is never overwritten — from stopping and exited, went live or not", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const deadline = MAX_DURATION_MINUTES * 60;
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const cases: [string, Session][] = [
      ["live, went live", C({ state: "live", startedAt: T0, heartbeatAt: T0, runner: { ...BOOTING, state: "playing" } })],
      // SEEDED past its own earlier exit (lane-A minors, Task 2C post-review m4): a
      // warming row fails `warming_timeout` at 10 minutes, so it cannot really still
      // be warming at MAX_DURATION. It is kept because it is the "never went live"
      // half of the replay-fill claim and it stays consistent with `evaluate`'s
      // ordering; the live row above carries the reachable version of the claim.
      ["warming, never went live (seeded: warming_timeout would have failed it first)", C({ state: "warming", runner: BOOTING })],
    ];
    for (const [name, before] of cases) {
      expect(evaluate(before, at(deadline)), name).toEqual({ kind: "wall_clock" });
      const stopping = decide(before, { type: "expire", expiry: evaluate(before, at(deadline)) }, at(deadline));
      expect(stopping.next, name).toMatchObject({ state: "ending", endReason: "max_duration", runner: { state: "stopping", stopRequestedAt: at(deadline) } });
      for (const via of ["stopping", "exited"] as const) {
        const label = `${name} / ${via}`;
        const held = via === "stopping" ? stopping.next : decide(stopping.next, { type: "runner", trigger: { type: "callback_stopped" } }, at(deadline + 1)).next;
        expect(evaluate(held, at(deadline + grace)), label).toEqual({ kind: "grace_expired" });
        const done = decide(held, { type: "expire", expiry: evaluate(held, at(deadline + grace)) }, at(deadline + grace));
        expect(done.next, label).toMatchObject({ state: "completed", desiredState: "ending", endReason: "max_duration", failReason: null, endedAt: at(deadline + grace), runner: { state: "destroyed" } });
        expect(done.effects, label).toEqual(before.startedAt ? [FORCE, { type: "fill_replay" }] : [FORCE]);
        expect(done.events, label).toEqual([{ type: "RunnerChanged", from: via, to: "destroyed", trigger: "grace_expired" }, { type: "SessionEnded", reason: "completed" }]);
      }
    }
  });

  it("F-A × C27: a composed credit refusal (already failed, its Machine stopping) whose grace then expires force-destroys and STAYS failed(no_credits) — no second SessionEnded, no end reason — from stopping and exited", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const refused = decide(C(), { type: "credit_refused" }, T0).next;
    expect(refused).toMatchObject({ state: "failed", failReason: "no_credits", endReason: null, endedAt: T0, runner: { state: "stopping", stopRequestedAt: T0 } });
    for (const via of ["stopping", "exited"] as const) {
      const held = via === "stopping" ? refused : decide(refused, { type: "runner", trigger: { type: "callback_stopped" } }, at(1)).next;
      expect(evaluate(held, at(grace)), via).toEqual({ kind: "grace_expired" });
      const forced = decide(held, { type: "expire", expiry: evaluate(held, at(grace)) }, at(grace));
      expect(forced.next, via).toEqual({ ...held, runner: { ...held.runner, state: "destroyed" } });
      expect(forced.effects, via).toEqual([FORCE]);
      expect(forced.events, via).toEqual([{ type: "RunnerChanged", from: via, to: "destroyed", trigger: "grace_expired" }]);
    }
  });

  // F-A is a new `completed` signal, so every signal arm of runner() is re-checked against the (session × runner) pairs it can
  // now meet — through the real decide, because the runner walk's path cut ends at every ending signal and never reaches
  // stopping / exited at all. From every session that can put a runner into stopping (a stop or the deadline on a booting or
  // playing runner in provisioning / warming / live, F19's ending_timeout, and the three failures that tear a Machine down),
  // at both attempts, walk EVERY command decide accepts: no decision anywhere emits retry_runner, and each forced destroy of a
  // still-ending row completes it with the reason it already had.
  // Lane-A minors, Task 2C post-review m4: the title said "every session that can stop
  // a Machine" and the seeds below omit F16's provisioning/playing and warming/playing
  // origins, which a plan-gated walk does reach. Nothing is lost — they land on the
  // same (ending|failed, stopping) walk keys as the booting seeds already here — but
  // the title is narrowed to what the seeds actually enumerate rather than over-claiming.
  it("F-A: a grace-forced destroy is never followed by retry_runner — walked through decide from every BOOTING-or-PLAYING seed that can stop a Machine; each forced destroy on an ending row completes it with its own end reason", () => {
    const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
    const seeds: [string, Session, Command][] = [];
    for (const attempt of [1, RUNNER_MAX_ATTEMPTS]) {
      const booting: Runner = { ...BOOTING, attempt, name: `relay-s1-r${attempt}` };
      const playing: Runner = { ...booting, state: "playing" };
      seeds.push(
        [`live/playing r${attempt} × stop`, C({ state: "live", startedAt: T0, runner: playing }), { type: "stop" }],
        [`live/playing r${attempt} × wall_clock`, C({ state: "live", startedAt: T0, runner: playing }), { type: "expire", expiry: { kind: "wall_clock" } }],
        [`live/booting r${attempt} × stop`, C({ state: "live", startedAt: T0, runner: booting }), { type: "stop" }],
        [`live/booting r${attempt} × wall_clock`, C({ state: "live", startedAt: T0, runner: booting }), { type: "expire", expiry: { kind: "wall_clock" } }],
        [`warming/booting r${attempt} × stop`, C({ state: "warming", runner: booting }), { type: "stop" }],
        [`warming/booting r${attempt} × wall_clock`, C({ state: "warming", runner: booting }), { type: "expire", expiry: { kind: "wall_clock" } }],
        [`provisioning/booting r${attempt} × stop`, C({ state: "provisioning", runner: booting }), { type: "stop" }],
        [`ending/playing r${attempt} × ending_timeout`, C({ state: "ending", desiredState: "ending", endReason: "max_duration", startedAt: T0, endingAt: T0, runner: playing }), { type: "expire", expiry: { kind: "ending_timeout" } }],
        [`warming/booting r${attempt} × warming_timeout`, C({ state: "warming", runner: booting }), { type: "expire", expiry: { kind: "warming_timeout" } }],
        [`warming/booting r${attempt} × credit_refused`, C({ state: "warming", runner: booting }), { type: "credit_refused" }],
        [`provisioning/booting r${attempt} × provision_timeout`, C({ state: "provisioning", runner: booting }), { type: "expire", expiry: { kind: "provision_timeout" } }],
      );
    }
    let decisions = 0, forcedCompletions = 0;
    const retried: string[] = [];
    for (const [label, before, command] of seeds) {
      const seeded = decide(before, command, at(1)).next;
      expect(seeded.runner, label).toMatchObject({ state: "stopping", stopRequestedAt: at(1) });   // not vacuous: the seed STOPPED a Machine
      expect(["ending", "failed"], label).toContain(seeded.state);
      const seen = new Set<string>();
      const stack: [Session, string[]][] = [[seeded, [label]]];
      while (stack.length > 0) {
        const [s, path] = stack.pop()!;
        if (seen.has(key(s))) continue;
        seen.add(key(s));
        for (const c of commandsFor(s)) {
          let d: ReturnType<typeof decide>;
          try { d = decide(s, c, at(2)); } catch (e) {
            expect(e instanceof InvalidTransition || e instanceof InvalidRunnerTransition, [...path, JSON.stringify(c)].join(" → ")).toBe(true);
            continue;
          }
          decisions++;
          const here = [...path, `${s.state}/${s.runner.state} × ${c.type === "runner" ? c.trigger.type : c.type === "expire" ? c.expiry.kind : c.type}`];
          const graceForced = (c.type === "runner" ? c.trigger.type === "grace_expired" : c.type === "expire" && c.expiry.kind === "grace_expired")
            && (s.runner.state === "stopping" || s.runner.state === "exited");
          if (graceForced && s.state === "ending") {
            forcedCompletions++;
            expect(d.next, here.join(" → ")).toMatchObject({ state: "completed", endReason: s.endReason, runner: { state: "destroyed" } });
          }
          if (d.effects.some((e) => e.type === "retry_runner")) retried.push(here.join(" → "));
          stack.push([d.next, here]);
        }
      }
    }
    expect(retried, `retry_runner after a stopped Machine: ${retried.slice(0, 3).join(" ;; ")}`).toEqual([]);
    expect(decisions).toBeGreaterThan(seeds.length);
    expect(forcedCompletions).toBeGreaterThan(0);                                  // the F-A cells WERE walked through, on ending rows
  });

  // Task 2C carry C6 (minor, fixed): the shared teardown on the way to `failed` dropped the stop step's SessionEnding but
  // not a SessionEnded — and a LOST runner's session_stop COMPLETES the session (F17), so the row logged two endings.
  it("C6: tearing down a LOST runner on the way to failed reports exactly ONE SessionEnded — warming timeout, credit refusal and provisioning timeout alike", () => {
    const lost: Runner = { ...BOOTING, state: "lost" };
    const cases: [Session, Command, string][] = [
      [C({ runner: lost }), { type: "expire", expiry: { kind: "warming_timeout" } }, "machine_boot_timeout"],
      [C({ runner: lost }), { type: "credit_refused" }, "no_credits"],
      // Review M4 found this row NOT a killer for the provision_timeout site's own filter: provisioning then ignored the
      // completed signal the lost runner's session_stop emits. Fix round 5 (re-review 2 G1) made runner()'s `completed` arm
      // honour it on provisioning, so the teardown now carries a SessionEnded(completed) and narrowing THAT site's filter back
      // to SessionEnding-only reds this row (mutant F5 provision_timeout-filter). Each site's row is now its own killer.
      [C({ state: "provisioning", runner: lost }), { type: "expire", expiry: { kind: "provision_timeout" } }, "provision_timeout"],
    ];
    for (const [s, command, reason] of cases) {
      const d = decide(s, command, T0);
      // `desiredState` is pinned too (lane-A minors, Task 2C re-review 3 m3): without
      // it, reverting provisioning/lost's failed row to `desiredState: "live"` left
      // this row green (mutant G1p), and the heartbeat reply is the one reader — a
      // failed session still answering "live" tells its Machine to carry on. The three
      // rows reach "ending" by THREE different routes: credit_refused sets it
      // explicitly, and the two timeouts inherit it from the lost runner's own
      // `completed` signal through the teardown step.
      expect(d.next, reason).toMatchObject({ state: "failed", failReason: reason, endReason: null, desiredState: "ending", runner: { state: "destroyed" } });
      expect(d.events, reason).toEqual([{ type: "RunnerChanged", from: "lost", to: "destroyed", trigger: "session_stop" }, { type: "SessionEnded", reason }]);
      expect(d.effects, reason).toEqual([FORCE]);
    }
  });
});

// Task 2C carry C1, at the SESSION level: `evaluate` hands `stale_beat` to a live composed session wanting live whose runner
// is in ANY unmarked state (Task 2B's I2 clause). What each runner state does with it is the table's; what the session does
// with the signal — and how often the lazy read may act again — is proven here, through the real policy.
describe("C1 — a live composed session's stale beat, evaluate → decide, for every runner state", () => {
  const T = (sec: number) => new Date(T0.getTime() + sec * 1000);
  const stale = T(STALE_HEARTBEAT_SECONDS);
  const FORCE = { type: "runner", effect: { type: "force_destroy" } };
  const R1: Runner = { state: "playing", attempt: 1, name: "relay-s1-r1", machineId: "m1", stopRequestedAt: null, lastExit: null };
  const live = (runner: Runner, over: Partial<Session> = {}): Session => S({ mode: "composed", state: "live", startedAt: T0, heartbeatAt: T0, runner, ...over });
  const read = (s: Session, now: Date) => decide(s, { type: "expire", expiry: evaluate(s, now) }, now);

  it("walked from RUNNER_STATES: every unmarked runner state reads stale_beat at the threshold, and the decision on it never throws", () => {
    for (const rs of RUNNER_STATES) {
      const s = live({ ...R1, state: rs });
      expect(evaluate(s, stale), rs).toEqual({ kind: "stale_beat" });
      expect(() => read(s, stale), rs).not.toThrow();
    }
  });

  it("lost: the teardown is re-issued at most ONCE per STALE_HEARTBEAT_SECONDS (the stale-beat arm restarts the beat window, beatWindowAt) and never retries; the playing → lost entry restarts it too", () => {
    const lost = live({ ...R1, state: "lost" });
    const d = read(lost, stale);
    expect(d.next).toMatchObject({ state: "live", runnerRetries: 0, heartbeatAt: T0, beatWindowAt: stale, runner: { state: "lost", attempt: 1 } });
    expect(d.effects).toEqual([FORCE]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "lost", to: "lost", trigger: "stale_beat" }]);
    // the next 5 s poll does NOT call Fly again, nor does any read inside the new window…
    expect(evaluate(d.next, T(STALE_HEARTBEAT_SECONDS + 5))).toEqual({ kind: "none" });
    expect(evaluate(d.next, T(2 * STALE_HEARTBEAT_SECONDS - 1))).toEqual({ kind: "none" });
    // …one window later it does, once more
    expect(evaluate(d.next, T(2 * STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
    const first = read(live(R1), stale);                                          // playing → lost, force_destroy
    expect(first.next).toMatchObject({ state: "live", heartbeatAt: T0, beatWindowAt: stale, runner: { state: "lost" } });
    expect(first.effects).toEqual([FORCE]);
    expect(evaluate(first.next, T(STALE_HEARTBEAT_SECONDS + 5))).toEqual({ kind: "none" });
  });

  it("destroyed awaiting its retry (the process died before retry_runner ran): the read re-signals the ONE retry; at the attempt cap it fails", () => {
    // The REALISTIC row (review I1): the destroy that first signalled this retry already recorded runnerRetries = 1.
    const waiting = live({ ...R1, state: "destroyed" }, { runnerRetries: 1 });
    const d = read(waiting, stale);
    expect(d.next).toMatchObject({ state: "live", runnerRetries: 1, heartbeatAt: T0, beatWindowAt: stale, runner: { state: "destroyed", attempt: 1 } });
    expect(d.effects).toEqual([{ type: "retry_runner" }]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "destroyed", to: "destroyed", trigger: "stale_beat" }, { type: "RunnerRetried", attempt: 2 }]);
    const spent = live({ ...R1, state: "destroyed", attempt: RUNNER_MAX_ATTEMPTS, name: "relay-s1-r2" }, { runnerRetries: 1 });
    const f = read(spent, stale);
    expect(f.next).toMatchObject({ state: "failed", failReason: "machine_crash", endReason: null, endedAt: stale, runnerRetries: 1 });
    expect(f.effects).toEqual([]);
  });

  it("creating (a replacement's create hung): lost with the by-name teardown, still live, no retry yet; the late create_ok is destroyed; its destroy on the last attempt fails the session", () => {
    const creating = live({ ...R1, state: "creating", attempt: RUNNER_MAX_ATTEMPTS, name: "relay-s1-r2", machineId: null }, { runnerRetries: 1 });
    const d = read(creating, stale);
    expect(d.next).toMatchObject({ state: "live", runnerRetries: 1, heartbeatAt: T0, beatWindowAt: stale, runner: { state: "lost", attempt: RUNNER_MAX_ATTEMPTS, machineId: null } });
    expect(d.effects).toEqual([FORCE]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "creating", to: "lost", trigger: "stale_beat" }]);
    const late = decide(d.next, { type: "runner", trigger: { type: "create_ok", machineId: "m9" } }, stale);
    expect(late.next).toMatchObject({ state: "live", runner: { state: "lost", machineId: "m9" } });
    expect(late.effects).toEqual([FORCE]);
    const gone = decide(late.next, { type: "runner", trigger: { type: "destroy_ok" } }, stale);
    expect(gone.next).toMatchObject({ state: "failed", failReason: "machine_crash", runnerRetries: 1, runner: { state: "destroyed" } });
    expect(gone.effects).toEqual([]);
  });

  // Task 2C review I1 (fix round 1): the retry arm ADDED one per signal, and `destroyed × stale_beat` re-signals the retry once
  // per window while the process that should run `retry_runner` keeps dying — 21 after 30 min, 199 over 5 h. The count is the
  // runner's attempt (the create calls made, C3), so a re-signal records the same number again.
  it("I1: runnerRetries is IDEMPOTENT — a destroyed row re-signalled by stale beat after stale beat, window after window, stays at 1 and never reaches the attempt cap", () => {
    let s = live({ ...R1, state: "destroyed" }, { runnerRetries: 1 });
    const windows = 5;
    for (let k = 1; k <= windows; k++) {
      const now = T(k * STALE_HEARTBEAT_SECONDS);
      expect(evaluate(s, T(k * STALE_HEARTBEAT_SECONDS - 1)), `window ${k} T−1`).toEqual({ kind: "none" });
      const d = read(s, now);
      expect(d.effects, `window ${k}`).toEqual([{ type: "retry_runner" }]);
      expect(d.next, `window ${k}`).toMatchObject({ state: "live", runnerRetries: 1, beatWindowAt: now, runner: { state: "destroyed", attempt: 1 } });
      expect(d.next.runnerRetries, `window ${k}`).toBeLessThan(RUNNER_MAX_ATTEMPTS);
      s = d.next;
    }
    // the FIRST retry out of lost, from a row that had none yet, records the same count — and its re-signal keeps it
    const fromLost = decide(live({ ...R1, state: "lost" }), { type: "runner", trigger: { type: "destroy_ok" } }, stale);
    expect(fromLost.next).toMatchObject({ runnerRetries: 1, runner: { state: "destroyed", attempt: 1 } });
    expect(fromLost.effects).toEqual([{ type: "retry_runner" }]);
    const again = decide(fromLost.next, { type: "expire", expiry: { kind: "stale_beat" } }, T(2 * STALE_HEARTBEAT_SECONDS));
    expect(again.next).toMatchObject({ runnerRetries: 1 });
    expect(again.effects).toEqual([{ type: "retry_runner" }]);
  });

  // Task 2C review I4, orchestrator RULING option A (fix round 1): one authority per fact. `heartbeatAt` is the last beat
  // RECEIVED — Task 10 serves it as the organiser panel's lastBeatAt — so a decision about a MISSING beat must never write it,
  // or a dead stream's chip reads "beat 0 s" for half of every window. The window anchor is its own field, `beatWindowAt`.
  it("I4: a stale-beat decision and a retry move ONLY the beat-window anchor — heartbeatAt (the last beat RECEIVED) is byte-identical; a real beat after the anchor still restarts the window", () => {
    for (const rs of RUNNER_STATES) {
      const s = live({ ...R1, state: rs });
      const d = read(s, stale);
      expect(d.next.heartbeatAt, rs).toBe(s.heartbeatAt);
    }
    const retries: [Runner, RunnerTrigger][] = [
      [{ ...R1, state: "lost" }, { type: "destroy_ok" }],
      [{ ...R1, state: "creating", machineId: null }, { type: "create_failed", retryable: true }],
    ];
    for (const [runner, trigger] of retries) {
      const s = live(runner);
      const d = decide(s, { type: "runner", trigger }, stale);
      expect(d.effects, trigger.type).toEqual([{ type: "retry_runner" }]);
      expect(d.next.heartbeatAt, trigger.type).toBe(s.heartbeatAt);
      expect(d.next.beatWindowAt, trigger.type).toEqual(stale);
    }
    // The replacement comes up and BEATS 30 s after the anchor (Task 10 records heartbeatAt on receipt): the window now runs
    // from that beat. The anchor alone would read stale one window after itself; the beat holds it off for another 30 s.
    const anchored = read(live({ ...R1, state: "destroyed" }, { runnerRetries: 1 }), stale).next;
    const beaten: Session = { ...anchored, heartbeatAt: T(STALE_HEARTBEAT_SECONDS + 30), runner: { ...R1, attempt: 2, name: "relay-s1-r2", machineId: "m2" } };
    expect(evaluate(anchored, T(2 * STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
    expect(evaluate(beaten, T(2 * STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "none" });
    expect(evaluate(beaten, T(2 * STALE_HEARTBEAT_SECONDS + 30 - 1))).toEqual({ kind: "none" });
    expect(evaluate(beaten, T(2 * STALE_HEARTBEAT_SECONDS + 30))).toEqual({ kind: "stale_beat" });
  });

  it("none (a corrupt live composed row with no runner): the read FAILS it with machine_crash instead of throwing on every read forever", () => {
    const corrupt = live(RUNNER_NONE);
    const d = read(corrupt, stale);
    expect(d.next).toMatchObject({ state: "failed", failReason: "machine_crash", endReason: null, endedAt: stale, runner: RUNNER_NONE });
    expect(d.effects).toEqual([]);
    expect(d.events).toEqual([{ type: "RunnerChanged", from: "none", to: "none", trigger: "stale_beat" }, { type: "SessionEnded", reason: "machine_crash" }]);
    expect(evaluate(d.next, T(10 * STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "none" });
  });
});
