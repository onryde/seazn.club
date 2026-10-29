// P1.2 (pad wave) - footballPadRules: the football facts the v3 football skin used to copy, declared once in football.ts and read by
// the fold and by the skin.
//
// Three kinds of check, because a declaration that the fold also reads can agree with the fold by construction:
//   1. IDENTITY - the record's values ARE the engine's declarations (toBe / the zod enum's own options / padSpec's own enum).
//   2. BEHAVIOUR - eventAllowedInPhase / legalPeriodMarkers / subWindowsCap / reentryAllowed are compared with what the REAL fold does
//      (football.apply, strict, the scorer's path) in REAL folded states, never a hand-built state.
//   3. RULEBOOK - the phase table, typed here from the Laws and football.md section 9 (a goal is only scored while the ball is in play,
//      a card is legal from the whistle before kick-off until the match is decided, ...), so that dropping a phase from the engine's
//      table reds even though the fold and the declaration would then agree with each other.
// Every sweep reports how many items it compared and fails on zero.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { padEnumValues } from "./index.ts";
import {
  CardColor,
  CardReason,
  EVENT_PHASES,
  FOOTBALL_EVENT_SCHEMAS,
  FootballCfg,
  PLAY_PHASES,
  PenaltyOffence,
  PenaltyOutcome,
  football,
  padSpec,
  type FootballState,
} from "../sports/football/football.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { lineupFromCatalog, makeEnvelope } from "../testkit/index.ts";
import { footballPadRules } from "./index.ts";

type Step = readonly [type: string, payload?: unknown];

const cfgOf = (over: Record<string, unknown> = {}): FootballCfg => football.configSchema.parse(over);

function lineupsFor(cfg: FootballCfg): LineupPair {
  const side = (entrantId: string): LineupPair["home"] => {
    const base = lineupFromCatalog(resolvePositions(football, cfg), entrantId);
    return {
      ...base,
      slots: [
        ...base.slots,
        { personId: `${entrantId}-b1`, slot: "bench", orderNo: base.slots.length + 1 },
        { personId: `${entrantId}-b2`, slot: "bench", orderNo: base.slots.length + 2 },
      ],
    };
  };
  return { home: side("H"), away: side("A") };
}

const envelopes = (steps: readonly Step[]): EventEnvelope[] => steps.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
const foldSteps = (cfg: FootballCfg, steps: readonly Step[]): FootballState => foldMatch(football, cfg, lineupsFor(cfg), envelopes(steps));

/** What the REAL fold says about one event in one state: the scorer's path (strict), as the pad's offer is judged. */
type Verdict = "accepted" | "wrong-phase" | "other";
function verdictOf(state: FootballState, type: string, payload: unknown): Verdict {
  try {
    football.apply(state, makeEnvelope(999, { type, payload }) as never, { strict: true });
    return "accepted";
  } catch (error) {
    return EngineError.is(error, "WRONG_PHASE") ? "wrong-phase" : "other";
  }
}

/** A schema-valid payload per football.* type, built from the state's own entrants and squad, so a refusal is the phase's and not a
 *  made-up person's. football.period is probed marker by marker, so it has none here. */
function probeOf(type: string, state: FootballState): unknown {
  const by = state.entrants.home;
  const person = state.squads.home.onPitch[0] ?? `${by}-p1`;
  switch (type) {
    case "football.goal":
      return { by };
    case "football.card":
      return { by, color: "yellow" };
    case "football.sub":
      return { by, off: person, on: state.squads.home.bench[0] ?? `${by}-b1` };
    case "football.penalty":
      return { by, outcome: "saved" };
    case "football.shot":
      return { by, outcome: "saved" };
    case "football.sinbin.start":
    case "football.sinbin.end":
      return { by, person };
    case "football.shootout.kick":
      return { by, scored: true };
    case "football.clock":
      return { running: false };
    default:
      throw new Error(`no probe for "${type}": football's event vocabulary grew, extend probeOf and the RULEBOOK table`);
  }
}

// Every phase football can be in, each reached by FOLDING events (the phase is read off the folded state, never typed in a case).
const LEVEL: Step[] = [["football.goal", { by: "H" }], ["football.goal", { by: "A" }]];
const REACH: { label: string; cfg: FootballCfg; steps: Step[] }[] = [
  { label: "halves: pre", cfg: cfgOf(), steps: [] },
  { label: "halves: first half", cfg: cfgOf(), steps: [["core.start"]] },
  { label: "halves: second half", cfg: cfgOf(), steps: [["core.start"], ["football.period", { phase: "HT" }]] },
  { label: "halves: decided", cfg: cfgOf(), steps: [["core.start"], ["football.goal", { by: "H" }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]] },
  { label: "halves: final", cfg: cfgOf(), steps: [["core.start"], ["football.goal", { by: "H" }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["core.finalize"]] },
  { label: "halves: abandoned", cfg: cfgOf(), steps: [["core.start"], ["core.abandon", { reason: "floodlights" }]] },
  { label: "quarters: Q1 (H1 reused)", cfg: cfgOf({ halves: 4 }), steps: [["core.start"]] },
  { label: "quarters: Q2", cfg: cfgOf({ halves: 4 }), steps: [["core.start"], ["football.period", { phase: "QT" }]] },
  { label: "quarters: Q3", cfg: cfgOf({ halves: 4 }), steps: [["core.start"], ["football.period", { phase: "QT" }], ["football.period", { phase: "HT" }]] },
  { label: "quarters: Q4", cfg: cfgOf({ halves: 4 }), steps: [["core.start"], ["football.period", { phase: "QT" }], ["football.period", { phase: "HT" }], ["football.period", { phase: "3QT" }]] },
  { label: "knockout: extra time 1", cfg: cfgOf({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true }), steps: [["core.start"], ...LEVEL, ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]] },
  { label: "knockout: extra time 2", cfg: cfgOf({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true }), steps: [["core.start"], ...LEVEL, ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["football.period", { phase: "ET_HT" }]] },
  { label: "knockout: shoot-out after extra time", cfg: cfgOf({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true }), steps: [["core.start"], ...LEVEL, ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["football.period", { phase: "ET_HT" }], ["football.period", { phase: "ET_FT" }]] },
  { label: "kicks: shoot-out without extra time", cfg: cfgOf({ shootout: true }), steps: [["core.start"], ...LEVEL, ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]] },
];

// The Laws, typed once (IFAB Laws of the Game, Law 7 "The duration of the match" and Law 8 for the periods of play and the shoot-out;
// football.md section 9 for "a red card is legal before kick-off"). Deliberately NOT built from PLAY_PHASES or EVENT_PHASES.
const IN_PLAY = ["H1", "H2", "Q2", "Q3", "Q4", "ET_H1", "ET_H2"];
const ALL_PHASES = ["pre", ...IN_PLAY, "SHOOTOUT", "done", "final", "abandoned"];
const RULEBOOK: Readonly<Record<string, readonly string[]>> = {
  "football.goal": IN_PLAY,
  "football.sub": IN_PLAY,
  "football.penalty": IN_PLAY,
  "football.shot": IN_PLAY,
  "football.sinbin.start": IN_PLAY,
  "football.sinbin.end": IN_PLAY,
  "football.clock": IN_PLAY,
  "football.card": ["pre", ...IN_PLAY, "SHOOTOUT"],
  "football.shootout.kick": ["SHOOTOUT"],
};
/** The one marker each in-play phase ends with, per mode (DOMAIN.md "Quarters instead of halves": Q1 is H1 reused, the real half-time is HT). */
const MARKER_AT: Readonly<Record<"halves" | "quarters", Readonly<Record<string, string>>>> = {
  halves: { H1: "HT", H2: "FT", ET_H1: "ET_HT", ET_H2: "ET_FT" },
  quarters: { H1: "QT", Q2: "HT", Q3: "3QT", Q4: "FT", ET_H1: "ET_HT", ET_H2: "ET_FT" },
};
const ALL_MARKERS = ["QT", "HT", "3QT", "FT", "ET_HT", "ET_FT"];
/** The S6 owner ruling (scoringpad-v2 _INDEX.md, "redesign the fidelity model, in S6"): two real levels - the bare score (band 0) and the
 *  full timeline (band 2) - plus the one detail event, the shot (band 3). Band 1 is deliberately unused. */
const S6_BANDS: Readonly<Record<string, number>> = {
  "football.goal": 0,
  "football.period": 0,
  "football.clock": 0,
  "football.shootout.kick": 0,
  "football.card": 2,
  "football.sub": 2,
  "football.penalty": 2,
  "football.sinbin.start": 2,
  "football.sinbin.end": 2,
  "football.shot": 3,
};

describe("the folded states the sweeps run over", () => {
  it("reach every phase football has, each read off a real fold (anti-vacuity for the sweeps below)", () => {
    const seen = new Set(REACH.map(({ cfg, steps }) => foldSteps(cfg, steps).phase));
    expect([...seen].sort()).toEqual([...ALL_PHASES].sort());
  });
});

describe("footballPadRules: the vocabularies are the engine's own", () => {
  it("cardColors / cardReasons / penaltyOutcomes / penaltyOffences are the zod enums' options", () => {
    expect(footballPadRules.cardColors).toEqual(CardColor.options);
    expect(footballPadRules.cardReasons).toEqual(CardReason.options);
    expect(footballPadRules.penaltyOutcomes).toEqual(PenaltyOutcome.options);
    expect(footballPadRules.penaltyOffences).toEqual(PenaltyOffence.options);
    // not vacuous: a shoot-out outcome ("scored") is NOT a penalty outcome (the kick that scores is a football.goal)
    expect(footballPadRules.cardColors).toHaveLength(3);
    expect(footballPadRules.cardReasons.length).toBeGreaterThanOrEqual(13);
    expect(footballPadRules.penaltyOutcomes).not.toContain("scored");
    expect(footballPadRules.penaltyOffences.length).toBeGreaterThanOrEqual(8);
  });

  it("agree with what padSpec offers, for every cfg football declares", () => {
    const cfgs = declaredCfgs(football);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    let compared = 0;
    for (const { name, cfg } of cfgs) {
      const spec = padSpec(cfg);
      expect(padEnumValues(spec, "football.card", "color"), `${name} card color`).toEqual(footballPadRules.cardColors);
      expect(padEnumValues(spec, "football.card", "reason"), `${name} card reason`).toEqual(footballPadRules.cardReasons);
      expect(padEnumValues(spec, "football.sinbin.start", "reason"), `${name} sin bin reason`).toEqual(footballPadRules.cardReasons);
      expect(padEnumValues(spec, "football.penalty", "outcome"), `${name} penalty outcome`).toEqual(footballPadRules.penaltyOutcomes);
      expect(padEnumValues(spec, "football.penalty", "offence"), `${name} penalty offence`).toEqual(footballPadRules.penaltyOffences);
      compared += 5;
    }
    expect(compared).toBeGreaterThanOrEqual(10);
  });

  it("eventBands is the one fidelity map padSpec returns (toBe), for every cfg, and banding every football event type", () => {
    const cfgs = declaredCfgs(football);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
    for (const { name, cfg } of cfgs) expect(padSpec(cfg).fidelity, name).toBe(footballPadRules.eventBands);
    expect(Object.keys(footballPadRules.eventBands).sort()).toEqual(Object.keys(FOOTBALL_EVENT_SCHEMAS).sort());
    for (const band of Object.values(footballPadRules.eventBands)) expect([0, 1, 2, 3]).toContain(band);
  });

  it("eventBands carry the S6 ruling (typed from the ruling, so changing a band in football.ts reds here)", () => {
    expect(footballPadRules.eventBands).toEqual(S6_BANDS);
  });

  it("playPhases is the fold's PLAY_PHASES (toBe), and is the rulebook's in-play set", () => {
    expect(footballPadRules.playPhases).toBe(PLAY_PHASES);
    expect([...footballPadRules.playPhases].sort()).toEqual([...IN_PLAY].sort());
  });

  it("teamSizeDefault is the schema's own teamSize maximum, and the size an absent teamSize fields", () => {
    const schemaMax = FootballCfg.shape.teamSize.unwrap().maxValue;
    expect(schemaMax).not.toBeNull();
    expect(footballPadRules.teamSizeDefault).toBe(schemaMax);
    // Law 3 section 1: "not more than eleven players" a side - typed from the Laws, so the declaration moving reds even if the schema moves with it
    expect(footballPadRules.teamSizeDefault).toBe(11);
    expect(resolvePositions(football, cfgOf()).lineup.size).toBe(footballPadRules.teamSizeDefault);
    // the case where the right answer differs from the default: a 7-a-side cfg fields 7, not the default
    expect(resolvePositions(football, cfgOf({ teamSize: 7 })).lineup.size).toBe(7);
    expect(footballPadRules.teamSizeDefault).not.toBe(7);
  });
});

describe("footballPadRules.eventAllowedInPhase", () => {
  it("classifies every football event type: EVENT_PHASES has an entry for each, and football.period is the one cfg-dependent type", () => {
    const types = Object.keys(FOOTBALL_EVENT_SCHEMAS);
    expect(types.length).toBeGreaterThanOrEqual(10);
    const unclassified = types.filter((type) => type !== "football.period" && !Object.hasOwn(EVENT_PHASES, type));
    expect(unclassified).toEqual([]);
    expect(Object.keys(EVENT_PHASES).filter((type) => !types.includes(type))).toEqual([]);
    expect(Object.hasOwn(EVENT_PHASES, "football.period")).toBe(false);
  });

  it("agrees with the rulebook for every non-period type in every phase", () => {
    let compared = 0;
    for (const [type, phases] of Object.entries(RULEBOOK)) {
      for (const phase of ALL_PHASES) {
        expect(footballPadRules.eventAllowedInPhase(type, phase, cfgOf()), `${type} in ${phase}`).toBe(phases.includes(phase));
        compared++;
      }
    }
    expect(compared).toBe(9 * ALL_PHASES.length);
    expect(Object.keys(RULEBOOK).sort()).toEqual(Object.keys(FOOTBALL_EVENT_SCHEMAS).filter((type) => type !== "football.period").sort());
  });

  it("agrees with the rulebook for football.period: one marker per in-play phase, per mode, and none anywhere else", () => {
    let compared = 0;
    for (const [mode, cfg] of [["halves", cfgOf({ extraTime: { enabled: true, halfMinutes: 15 } })], ["quarters", cfgOf({ halves: 4, extraTime: { enabled: true, halfMinutes: 15 } })]] as const) {
      for (const phase of ALL_PHASES) {
        const expected = MARKER_AT[mode][phase];
        expect(footballPadRules.legalPeriodMarkers(phase, cfg), `${mode} ${phase}`).toEqual(expected === undefined ? [] : [expected]);
        expect(footballPadRules.eventAllowedInPhase("football.period", phase, cfg), `${mode} ${phase}`).toBe(expected !== undefined);
        compared++;
      }
    }
    expect(compared).toBe(2 * ALL_PHASES.length);
  });

  it("agrees with the REAL fold, event type by event type, in every folded phase", () => {
    let compared = 0;
    let refusedByPhase = 0;
    let accepted = 0;
    for (const { label, cfg, steps } of REACH) {
      const state = foldSteps(cfg, steps);
      for (const type of Object.keys(FOOTBALL_EVENT_SCHEMAS).filter((t) => t !== "football.period")) {
        const payload = probeOf(type, state);
        expect(FOOTBALL_EVENT_SCHEMAS[type]!.safeParse(payload).success, `the ${type} probe must parse, or the fold refuses it before the phase check`).toBe(true);
        const verdict = verdictOf(state, type, payload);
        expect(footballPadRules.eventAllowedInPhase(type, state.phase, cfg), `${label}: ${type} in ${state.phase}`).toBe(verdict !== "wrong-phase");
        compared++;
        if (verdict === "wrong-phase") refusedByPhase++;
        if (verdict === "accepted") accepted++;
      }
    }
    // both directions were exercised: a sweep where nothing is ever refused (or nothing accepted) proves nothing
    expect(compared).toBe(REACH.length * 9);
    expect(refusedByPhase).toBeGreaterThan(20);
    expect(accepted).toBeGreaterThan(20);
  });

  it("agrees with the REAL fold for football.period, marker by marker: legalPeriodMarkers is exactly what applyPeriod accepts under this cfg", () => {
    let compared = 0;
    let legalSeen = 0;
    for (const { label, cfg, steps } of REACH) {
      const state = foldSteps(cfg, steps);
      const offered = footballPadRules.periodMarkers(cfg);
      const accepts = ALL_MARKERS.filter((marker) => offered.includes(marker) && verdictOf(state, "football.period", { phase: marker }) !== "wrong-phase");
      expect(footballPadRules.legalPeriodMarkers(state.phase, cfg), `${label}: markers legal in ${state.phase}`).toEqual(accepts);
      expect(footballPadRules.eventAllowedInPhase("football.period", state.phase, cfg), label).toBe(accepts.length > 0);
      compared++;
      legalSeen += accepts.length;
    }
    expect(compared).toBe(REACH.length);
    // every in-play state has exactly one legal marker and every other state (pre, shoot-outs, decided, final, abandoned) has none
    const inPlayStates = REACH.filter(({ cfg, steps }) => IN_PLAY.includes(foldSteps(cfg, steps).phase)).length;
    expect(inPlayStates).toBeGreaterThanOrEqual(8);
    expect(legalSeen).toBe(inPlayStates);
  });

  it("fails open for a type it does not declare, never throws on a prototype key, and degrades a missing cfg to the halves mode", () => {
    expect(footballPadRules.eventAllowedInPhase("football.var.review", "SHOOTOUT", cfgOf())).toBe(true);
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(footballPadRules.eventAllowedInPhase(key, "H1", {}), key).toBe(true);
    }
    expect(footballPadRules.eventAllowedInPhase("football.goal", "H1", undefined)).toBe(true);
    expect(footballPadRules.eventAllowedInPhase("football.period", "H1", undefined)).toBe(true); // halves: H1 -> HT
    expect(footballPadRules.eventAllowedInPhase("football.period", "Q2", undefined)).toBe(false); // quarters-only phase
    expect(footballPadRules.eventAllowedInPhase("football.goal", "", {})).toBe(false);
  });
});

describe("footballPadRules.periodMarkers", () => {
  it("is the marker enum padSpec offers for football.period, for every cfg football declares and for ET on and off", () => {
    const cfgs = [
      ...declaredCfgs(football).map(({ name, cfg }) => ({ name, cfg })),
      { name: "halves + extra time", cfg: cfgOf({ extraTime: { enabled: true, halfMinutes: 15 } }) },
      { name: "quarters + extra time", cfg: cfgOf({ halves: 4, extraTime: { enabled: true, halfMinutes: 15 } }) },
    ];
    let compared = 0;
    const lists = new Set<string>();
    for (const { name, cfg } of cfgs) {
      const markers = footballPadRules.periodMarkers(cfg);
      expect(markers, name).toEqual(padEnumValues(padSpec(cfg), "football.period", "phase"));
      lists.add(markers.join(","));
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(6);
    // the lists differ across cfgs (halves vs quarters vs extra time), so an implementation ignoring cfg cannot pass
    expect(lists.size).toBeGreaterThanOrEqual(4);
  });

  it("reads a partial cfg the way the skin does: an absent halves is halves, an absent extraTime is no extra time", () => {
    expect(footballPadRules.periodMarkers({})).toEqual(["HT", "FT"]);
    expect(footballPadRules.periodMarkers(null)).toEqual(["HT", "FT"]);
    expect(footballPadRules.periodMarkers({ halves: 4 })).toEqual(["QT", "HT", "3QT", "FT"]);
    expect(footballPadRules.periodMarkers({ extraTime: { enabled: true } })).toEqual(["HT", "FT", "ET_HT", "ET_FT"]);
    expect(footballPadRules.periodMarkers({ extraTime: { enabled: false } })).toEqual(["HT", "FT"]);
  });
});

describe("footballPadRules.subWindowsCap", () => {
  // A window is the set of substitutions sharing one stamp. The cap is what the fold enforces: it accepts exactly `cap` windows and
  // refuses the next with SUB_WINDOW_EXCEEDED. Rolling subs, so the same two players can swap back and forth in the fold.
  function windowsAccepted(cfg: FootballCfg, attempts: number): { accepted: number; refusal: unknown } {
    let state = foldSteps(cfg, [["core.start"]]);
    const x = state.squads.home.onPitch[0]!;
    const b = state.squads.home.bench[0]!;
    for (let k = 1; k <= attempts; k++) {
      const [off, on] = k % 2 === 1 ? [x, b] : [b, x];
      const event = makeEnvelope(k + 10, { type: "football.sub", payload: { by: "H", off, on, at: { period: "H1", elapsed: 60 * k } } });
      try {
        state = football.apply(state, event as never, { strict: true });
      } catch (error) {
        return { accepted: k - 1, refusal: error };
      }
    }
    return { accepted: attempts, refusal: undefined };
  }

  it("is the cap the fold enforces, for more than one cap", () => {
    for (const cap of [2, 3]) {
      const cfg = cfgOf({ rollingSubs: true, subWindows: cap });
      expect(footballPadRules.subWindowsCap(cfg), `cap ${cap}`).toBe(cap);
      const { accepted, refusal } = windowsAccepted(cfg, cap + 2);
      expect(accepted, `windows accepted under a cap of ${cap}`).toBe(cap);
      expect(EngineError.is(refusal, "SUB_WINDOW_EXCEEDED"), `the ${cap + 1}th window is refused for the window cap`).toBe(true);
    }
  });

  it("is undefined when the competition declared none, and the fold then accepts every window", () => {
    const cfg = cfgOf({ rollingSubs: true });
    expect(footballPadRules.subWindowsCap(cfg)).toBeUndefined();
    expect(footballPadRules.subWindowsCap({})).toBeUndefined();
    expect(footballPadRules.subWindowsCap(null)).toBeUndefined();
    expect(windowsAccepted(cfg, 6)).toEqual({ accepted: 6, refusal: undefined });
  });

  it("keeps a declared zero (no windows at all) distinct from none", () => {
    expect(footballPadRules.subWindowsCap(cfgOf({ rollingSubs: true, subWindows: 0 }))).toBe(0);
    expect(windowsAccepted(cfgOf({ rollingSubs: true, subWindows: 0 }), 2).accepted).toBe(0);
  });
});

describe("footballPadRules.reentryAllowed", () => {
  // The kernel refuses a return when football's lineupPolicy says reentry is "none". Drive it: X comes off for B, then B tries to go off for X.
  function returnVerdict(cfg: FootballCfg): "returned" | "refused" {
    let state = foldSteps(cfg, [["core.start"]]);
    const x = state.squads.home.onPitch[0]!;
    const b = state.squads.home.bench[0]!;
    state = football.apply(state, makeEnvelope(20, { type: "football.sub", payload: { by: "H", off: x, on: b } }) as never, { strict: true });
    try {
      football.apply(state, makeEnvelope(21, { type: "football.sub", payload: { by: "H", off: b, on: x } }) as never, { strict: true });
      return "returned";
    } catch (error) {
      if (!EngineError.is(error, "INVALID_EVENT")) throw error;
      return "refused";
    }
  }

  it("is what the fold does when a substituted-off player is sent back on, for 11-a-side, rolling and the shipped variants", () => {
    const cfgs = [
      { name: "11-a-side (default)", cfg: cfgOf() },
      { name: "rollingSubs", cfg: cfgOf({ rollingSubs: true }) },
      ...declaredCfgs(football).map(({ name, cfg }) => ({ name, cfg })),
    ];
    const outcomes = new Set<string>();
    for (const { name, cfg } of cfgs) {
      const verdict = returnVerdict(cfg);
      expect(footballPadRules.reentryAllowed(cfg), name).toBe(verdict === "returned");
      outcomes.add(verdict);
    }
    expect(cfgs.length).toBeGreaterThanOrEqual(4);
    // both answers occur among the cfgs, so a constant cannot pass
    expect([...outcomes].sort()).toEqual(["refused", "returned"]);
  });

  it("reads an absent rollingSubs as no return (the 11-a-side Law), and a partial cfg as such", () => {
    expect(footballPadRules.reentryAllowed({})).toBe(false);
    expect(footballPadRules.reentryAllowed(null)).toBe(false);
    expect(footballPadRules.reentryAllowed({ rollingSubs: true })).toBe(true);
    expect(footballPadRules.reentryAllowed({ rollingSubs: false })).toBe(false);
  });
});
