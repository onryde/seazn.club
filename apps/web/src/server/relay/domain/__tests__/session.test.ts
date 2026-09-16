// The session aggregate (design §6.3 gates, §6.4 transitions), PURE. Fast:
// no DB, no fakes, milliseconds. Every edge is its own `it`; the domain
// mutant killers are recorded per edge in the PR table.
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATES, InvalidTransition, TERMINAL_STATES, admit, decide, eventRowsOf, isActive, isTerminal,
  type Command, type Effect, type Session, type SessionState,
} from "../session";
import { RUNNER_NONE } from "../runner";

const T0 = new Date("2026-09-14T10:00:00Z");
const S = (over: Partial<Session> = {}): Session => ({
  id: "s1", fixtureId: "f1", orgId: "o1", mode: "passthrough", state: "requested", desiredState: "live",
  failReason: null, endReason: null, runner: RUNNER_NONE, runnerRetries: 0, createdAt: T0, startedAt: null, endedAt: null,
  heartbeatAt: null, endingAt: null, maxDurationMinutes: 300, ...over,
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

// Orchestrator ruling (Task 1 review, V408 amended): fixture_stream_sessions.fixture_id is NULLABLE,
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
