// Owed 108 fix (b), web half — the phone-live EDGE rule, pure (domain/phone-live.ts). The relay acts once per INCREASE of the
// per-session counter, so every way the counter could move when it should not (a flap, a repeat, a late delivery, the first
// live) or fail to move when it should (an outage the phone's beats never saw) is a defect with a customer's frozen picture
// behind it.
//
// The expected values come from the rule as the owner stated it (2026-10-26) and from the phone contract's own state
// vocabulary (`CapturePhoneState`, the zod twin) — never read off the function under test:
//   * the counter is bumped on each not-live → live edge AFTER the phone had been live once; the first live does not count;
//   * a flap live → live, a duplicate, a late delivery: no change;
//   * `reconnecting` is the one state that is an outage in the phone's own words ("degraded" and "reconnecting" both only
//     warn — capture spec W12 — but only `reconnecting` has lost the video).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the inputs are a phone's own report; no sport is involved.
import { describe, expect, it } from "vitest";
import { CapturePhoneState } from "@/server/api-v1/capture-schemas";
import { NO_PHONE_LIVE, PHONE_LIVE_STATES, isPhoneLive, phoneLiveTracked, stepPhoneLive, type PhoneLiveTracker } from "../phone-live";
import { ACTIVE_STATES, TERMINAL_STATES } from "../session";

const T0 = Date.parse("2026-10-26T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000);

/** The phone's own vocabulary, from the contract's zod twin. */
const ALL_STATES: readonly string[] = CapturePhoneState.options;
const LIVE: readonly string[] = ["publishing", "degraded"];
const NOT_LIVE: readonly string[] = ["paired", "arming", "armed", "connecting", "reconnecting", "ended"];

type Step = { state: (typeof CapturePhoneState.options)[number]; s: number; silent?: boolean };
/** Folds a run of beats through the rule and returns the counter after EACH one (the sequence, not the last value). */
function run(steps: Step[], from: PhoneLiveTracker = NO_PHONE_LIVE): { edges: (number | null)[]; end: PhoneLiveTracker } {
  let t = from;
  const edges: (number | null)[] = [];
  for (const b of steps) {
    t = stepPhoneLive(t, { state: b.state, at: at(b.s) }, b.silent ?? false);
    edges.push(t.edge);
  }
  return { edges, end: t };
}

describe("the phone's vocabulary", () => {
  it("every contract state is classified live or not — none unclassified, none both (anti-vacuity: 8 states)", () => {
    expect(ALL_STATES).toHaveLength(8);
    expect([...LIVE, ...NOT_LIVE].sort()).toEqual([...ALL_STATES].sort());
    let checked = 0;
    for (const s of CapturePhoneState.options) {
      expect(isPhoneLive(s), s).toBe(LIVE.includes(s));
      checked++;
    }
    expect(checked).toBe(ALL_STATES.length);
    expect([...PHONE_LIVE_STATES].sort()).toEqual([...LIVE].sort());
  });
});

describe("phoneLiveTracked — which sessions the counter follows", () => {
  it("every session state is classified: the four that carry on are tracked; ending (the relay is being stopped) and the two terminal ones are not", () => {
    // The session domain's own declarations: ACTIVE_STATES and TERMINAL_STATES together are every state there is.
    const every = [...ACTIVE_STATES, ...TERMINAL_STATES];
    expect(every, "anti-vacuity: seven session states").toHaveLength(7);
    const tracked: readonly string[] = ["requested", "provisioning", "warming", "live"];
    const untracked: readonly string[] = ["ending", "completed", "failed"];
    expect([...tracked, ...untracked].sort()).toEqual([...every].sort());
    let checked = 0;
    for (const state of every) {
      expect(phoneLiveTracked(state), state).toBe(tracked.includes(state));
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("stepPhoneLive — the edge", () => {
  it("EMPTY CASE: a session with no phone history has no counter, no last beat", () => {
    expect(NO_PHONE_LIVE).toEqual({ edge: null, live: null, beatAt: null });
  });

  it("a phone that has not published yet has no counter — arming, armed, connecting leave it null but record the beat", () => {
    const { edges, end } = run([{ state: "paired", s: 0 }, { state: "arming", s: 5 }, { state: "armed", s: 10 }, { state: "connecting", s: 15 }]);
    expect(edges).toEqual([null, null, null, null]);
    expect(end).toEqual({ edge: null, live: false, beatAt: at(15) });
  });

  it("the FIRST live does not count: it sets the counter to 0 (the field exists from then on, no outage to recover from)", () => {
    const { edges } = run([{ state: "connecting", s: 0 }, { state: "publishing", s: 5 }]);
    expect(edges).toEqual([null, 0]);
  });

  it("a first beat that is already live is also 0, never 1", () => {
    for (const live of LIVE) expect(run([{ state: live as Step["state"], s: 0 }]).edges, live).toEqual([0]);
  });

  it("live → lost → live is ONE edge; a second outage is the second; a third the third", () => {
    const { edges } = run([
      { state: "publishing", s: 0 },      // first live → 0
      { state: "reconnecting", s: 5 },    // lost
      { state: "publishing", s: 10 },     // edge 1
      { state: "reconnecting", s: 15 },
      { state: "publishing", s: 20 },     // edge 2
      { state: "reconnecting", s: 25 },
      { state: "connecting", s: 30 },
      { state: "publishing", s: 35 },     // edge 3 (a longer outage is still one edge)
    ]);
    expect(edges).toEqual([0, 0, 1, 1, 2, 2, 2, 3]);
  });

  it("a flap live → live does not count — publishing/degraded/publishing is a weak signal, not an outage", () => {
    const { edges } = run([
      { state: "publishing", s: 0 }, { state: "publishing", s: 5 }, { state: "degraded", s: 10 }, { state: "publishing", s: 15 },
      { state: "degraded", s: 20 }, { state: "degraded", s: 25 },
    ]);
    expect(edges).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("a long not-live stretch is ONE edge on the way back, never one per not-live beat", () => {
    const lost: Step[] = Array.from({ length: 20 }, (_, i) => ({ state: "reconnecting" as const, s: 5 + i * 5 }));
    const { edges } = run([{ state: "publishing", s: 0 }, ...lost, { state: "publishing", s: 200 }, { state: "publishing", s: 205 }]);
    expect(edges.at(-1)).toBe(1);
    expect(edges.slice(0, 21).every((e) => e === 0), "no increase while lost").toBe(true);
  });

  it("an `ended` beat is not live; live after it (a fresh start in the same session cannot happen, but the rule stays total) is an edge", () => {
    expect(run([{ state: "publishing", s: 0 }, { state: "ended", s: 5 }, { state: "publishing", s: 10 }]).edges).toEqual([0, 0, 1]);
  });

  it("SILENCE is an outage: live, then no beat for the not-responding window, then live again — an edge, though the phone never reported a lost state", () => {
    // The phone's beats cannot cross its own dead network, so the outage the relay felt is a GAP, not a `reconnecting` beat.
    const { edges } = run([{ state: "publishing", s: 0 }, { state: "publishing", s: 120, silent: true }, { state: "publishing", s: 125 }]);
    expect(edges).toEqual([0, 1, 1]);
  });

  it("silence before a beat that is NOT live is no edge by itself; the live beat after it is exactly one", () => {
    const { edges } = run([{ state: "publishing", s: 0 }, { state: "reconnecting", s: 120, silent: true }, { state: "publishing", s: 125 }]);
    expect(edges).toEqual([0, 0, 1]);
  });

  it("silence before the FIRST live is still not an edge — there is nothing to recover from", () => {
    expect(run([{ state: "publishing", s: 0, silent: true }]).edges).toEqual([0]);
    expect(run([{ state: "connecting", s: 0 }, { state: "publishing", s: 120, silent: true }]).edges).toEqual([null, 0]);
  });
});

describe("stepPhoneLive — late and duplicate beats are not edges", () => {
  it("a DUPLICATE (the same beat again, same `at`) changes nothing — not the counter, not the recorded side", () => {
    const afterLost = run([{ state: "publishing", s: 0 }, { state: "reconnecting", s: 5 }]).end;
    const once = stepPhoneLive(afterLost, { state: "publishing", at: at(10) }, false);
    expect(once.edge).toBe(1);
    const twice = stepPhoneLive(once, { state: "publishing", at: at(10) }, false);
    expect(twice).toEqual(once);
    // …and a duplicate of the LOST beat, replayed after the recovery, must not push the tracker back to "lost".
    const replayed = stepPhoneLive(once, { state: "reconnecting", at: at(5) }, false);
    expect(replayed).toEqual(once);
  });

  it("two DIFFERENT beats may share an `at` (the phone's timestamp has whole-second resolution): both are applied in arrival order, so publishing then reconnecting in one second is still an outage", () => {
    const { edges, end } = run([{ state: "publishing", s: 10 }, { state: "reconnecting", s: 10 }, { state: "publishing", s: 10 }]);
    expect(edges).toEqual([0, 0, 1]);
    expect(end).toEqual({ edge: 1, live: true, beatAt: at(10) });
  });

  it("a LATE beat (an `at` before the last applied one) changes nothing, whatever it says", () => {
    const base = run([{ state: "publishing", s: 0 }, { state: "publishing", s: 20 }]).end;
    for (const state of ALL_STATES as Step["state"][]) {
      expect(stepPhoneLive(base, { state, at: at(10) }, false), state).toEqual(base);
      expect(stepPhoneLive(base, { state, at: at(10) }, true), `${state} (silent)`).toEqual(base);
    }
  });

  it("the sequence that a late `reconnecting` would corrupt: live(10), live(20), THEN reconnecting(15) arrives — no phantom outage, no phantom edge", () => {
    let t = run([{ state: "publishing", s: 10 }, { state: "publishing", s: 20 }]).end;
    t = stepPhoneLive(t, { state: "reconnecting", at: at(15) }, false);   // late: ignored
    t = stepPhoneLive(t, { state: "publishing", at: at(25) }, false);
    expect(t.edge, "no edge: the phone never reported a loss in order").toBe(0);
  });

  it("the NEXT in-order beat after a late one is judged against the last APPLIED beat", () => {
    let t = run([{ state: "publishing", s: 0 }, { state: "reconnecting", s: 10 }]).end;
    t = stepPhoneLive(t, { state: "publishing", at: at(5) }, false);   // late publishing: ignored, still lost
    expect(t.live).toBe(false);
    t = stepPhoneLive(t, { state: "publishing", at: at(15) }, false);
    expect(t.edge).toBe(1);
  });
});

describe("stepPhoneLive — guards", () => {
  it("the counter never goes down, over every state × every previous side (anti-vacuity: counts the cases)", () => {
    let checked = 0;
    for (const prevLive of [false, true]) {
      for (const state of CapturePhoneState.options) {
        for (const silent of [false, true]) {
          for (const edge of [0, 1, 7]) {
            const next = stepPhoneLive({ edge, live: prevLive, beatAt: at(0) }, { state, at: at(5) }, silent);
            expect(next.edge, `${prevLive} ${state} ${silent} ${edge}`).toBeGreaterThanOrEqual(edge);
            expect(next.edge! - edge, "at most one step per beat").toBeLessThanOrEqual(1);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(2 * 8 * 2 * 3);
  });

  it("the edge is exactly: live now AND (not live before OR silent before) — every cell of the table", () => {
    let checked = 0;
    for (const prevLive of [false, true]) {
      for (const state of CapturePhoneState.options) {
        for (const silent of [false, true]) {
          const expected = LIVE.includes(state) && (!prevLive || silent) ? 6 : 5;
          const next = stepPhoneLive({ edge: 5, live: prevLive, beatAt: at(0) }, { state, at: at(5) }, silent);
          expect(next.edge, `prev live=${prevLive} beat=${state} silent=${silent}`).toBe(expected);
          expect(next.live).toBe(LIVE.includes(state));
          expect(next.beatAt).toEqual(at(5));
          checked++;
        }
      }
    }
    expect(checked).toBe(32);
  });

  it("a tracker that has a counter but no side is a corrupted row: refused by name, never guessed", () => {
    expect(() => stepPhoneLive({ edge: 1, live: null, beatAt: null }, { state: "publishing", at: at(0) }, false)).toThrow(RangeError);
    expect(() => stepPhoneLive({ edge: 0, live: true, beatAt: null }, { state: "publishing", at: at(0) }, false)).toThrow(RangeError);
  });

  it("the input tracker is never mutated", () => {
    const prev: PhoneLiveTracker = { edge: 0, live: false, beatAt: at(0) };
    const frozen = Object.freeze({ ...prev });
    expect(stepPhoneLive(frozen, { state: "publishing", at: at(5) }, false)).toEqual({ edge: 1, live: true, beatAt: at(5) });
    expect(frozen).toEqual(prev);
  });
});
