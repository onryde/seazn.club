// W2e Task 15 (A2) - the proving tests for football.md's W2e rows. Every describe/it title carries its row id as a whole
// token, which is what packages/engine/test/rules-reference.ts reads. Expected values come from the rulebook (IFAB Laws of the
// Game 2025/26: Law 3 substitutions, Law 7 duration, Law 10 outcome, the sin-bin guidelines) written into each test as
// literals - never from the code under test.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path, where the cfg-derived refusals (the substitution cap) are live.
//
// FB-RO-1 is a deviation row (record-only): its test shows each record is accepted and moves no score.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import { football, type FootballCfg, type FootballState } from "./football.ts";

const STRICT = { strictFromSeq: 0 } as const;

/** A catalog-valid XI (H-p1..H-p11) plus a six-man bench (H-b1..H-b6). */
function lineup(entrantId: string) {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      ...Array.from({ length: 6 }, (_, i) => ({ personId: `${entrantId}-b${i + 1}`, slot: "bench" as const, orderNo: 12 + i })),
    ],
  };
}
const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };

const cfgOf = (raw: unknown): FootballCfg => football.configSchema.parse(raw);
const youth = (extra: Record<string, unknown> = {}): FootballCfg => cfgOf({ ...football.variants.youth, ...extra });
const elevenASide = (extra: Record<string, unknown> = {}): FootballCfg => cfgOf({ ...football.variants["11-a-side"], ...extra });

type Spec = [type: string, payload?: unknown, voids?: string];
const stream = (...specs: Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const fold = (cfg: FootballCfg, ...specs: Spec[]): FootballState => foldMatch(football, cfg, lineups, stream(...specs), STRICT);
const at = (period: string, elapsed: number) => ({ period, elapsed });

/** The code (and the kernel's `reason`, where it names one) of the EngineError a fold throws, or null when it folds. */
function refusal(run: () => unknown): { code: string; reason?: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    const reason = (error.data as { reason?: string } | undefined)?.reason;
    return reason === undefined ? { code: error.code } : { code: error.code, reason };
  }
}

const goal = (by: string, extra: Record<string, unknown> = {}): Spec => ["football.goal", { by, ...extra }];
const legacySub = (by: string, off: string, on: string, extra: Record<string, unknown> = {}): Spec => [
  "football.sub",
  { by, off, on, ...extra },
];
const kernelSub = (off: string, on: string): Spec => [
  "core.lineup.substitution",
  { side: "H", off, on: { personId: on, slot: "bench", orderNo: 30 } },
];
const sinBin = (person: string, elapsed: number, extra: Record<string, unknown> = {}, period = "H1"): Spec => [
  "football.sinbin.start",
  { by: "H", person, at: at(period, elapsed), ...extra },
];

// ---------------------------------------------------------------------------------------------------------------------
// FB-OG-1 (A12) - own goal
// ---------------------------------------------------------------------------------------------------------------------

describe("FB-OG-1 an own goal is credited to the opposing side and the event's by names the side whose player struck it", () => {
  it("FB-OG-1 credits the opponent of by, whichever side struck it, and the flag is what moves the credit", () => {
    // Law 10.1/10.2: the whole ball over the line is a goal for the team whose goal it did NOT enter; the greater number of goals wins.
    let checked = 0;
    for (const [by, credited, conceded] of [["H", "away", "home"], ["A", "home", "away"]] as const) {
      const own = fold(cfgOf({}), ["core.start"], goal(by, { ownGoal: true }));
      expect(own.goals[credited], `${by} own goal credits ${credited}`).toBe(1);
      expect(own.goals[conceded], `${by} own goal conceded side keeps nothing`).toBe(0);
      // The period row the goal landed in carries the same credit.
      expect(own.periods.at(-1), `${by} period row`).toMatchObject({ phase: "H1", [credited]: 1, [conceded]: 0 });
      // The contrast: the SAME event without the flag (and with it explicitly false) is the striker's own goal.
      for (const flag of [{}, { ownGoal: false }]) {
        const ordinary = fold(cfgOf({}), ["core.start"], goal(by, flag));
        expect(ordinary.goals[conceded], `${by} ordinary goal ${JSON.stringify(flag)}`).toBe(1);
        expect(ordinary.goals[credited]).toBe(0);
        checked++;
      }
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("FB-OG-1 an own goal alone decides a match for the side it was credited to, and two own goals (one each) draw", () => {
    const decided = fold(cfgOf({}), ["core.start"], goal("H", { ownGoal: true }), ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]);
    expect(decided.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    const level = fold(cfgOf({}), ["core.start"], goal("H", { ownGoal: true }), goal("A", { ownGoal: true }), ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]);
    expect(level.outcome).toEqual({ kind: "draw" });
    // The table reads the credited score: A won 1-0, so A's goals for is 1 and H's goals against is 1.
    const [home, away] = football.standingsDelta(decided.outcome!, cfgOf({}), { kind: "league" }, decided);
    expect([home.metrics.gf, home.metrics.ga, away.metrics.gf, away.metrics.ga]).toEqual([0, 1, 1, 0]);
  });

  it("FB-OG-1 the scorer on an own goal is a player of the side named by by, never of the side credited", () => {
    // by names the side whose player struck it: H-p3 striking H's own goal is legal, A-p3 is not a player of H.
    expect(refusal(() => fold(cfgOf({}), ["core.start"], goal("H", { ownGoal: true, scorer: "H-p3" })))).toBeNull();
    expect(refusal(() => fold(cfgOf({}), ["core.start"], goal("H", { ownGoal: true, scorer: "A-p3" })))).toEqual({ code: "INVALID_EVENT" });
    // And the same scorer on an ordinary goal by H is judged against H's pitch the same way (the rule is by, not the flag).
    expect(refusal(() => fold(cfgOf({}), ["core.start"], goal("H", { scorer: "A-p3" })))).toEqual({ code: "INVALID_EVENT" });
  });

  it("FB-OG-1 voiding the own goal takes the credit away again", () => {
    // Undo is a void: the ledger is [start, own goal, void(own goal)] and the score is 0-0.
    const state = fold(cfgOf({}), ["core.start"], goal("H", { ownGoal: true }), ["core.void", {}, "e-1"]);
    expect(state.goals).toEqual({ home: 0, away: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// FB-YT-1 (P5) - youth
// ---------------------------------------------------------------------------------------------------------------------

describe("FB-YT-1 the youth variant plays 30-minute halves with rolling substitutions; 11-a-side keeps no-return substitutions and its cap", () => {
  it("FB-YT-1 the youth variant is halves of 30 minutes with rolling substitutions, the 11-a-side variant 45 and none", () => {
    const y = youth();
    expect([y.halfMinutes, y.halves, y.rollingSubs]).toEqual([30, 2, true]);
    const base = elevenASide();
    expect([base.halfMinutes, base.halves, base.rollingSubs]).toEqual([45, 2, undefined]);
    // The youth preset sets no cap of its own: rolling substitution is uncapped (FB-SU-1).
    expect(y.maxSubs).toBeUndefined();
  });

  it("FB-YT-1 the 30-minute half reaches the clock: a sin bin served across the half whistle carries 30 minutes' worth, not 45", () => {
    // 10-minute sin bin started at H1 elapsed 1700 s. A 1800 s half leaves 100 s to serve: 600 - 100 = 500 s carried into H2.
    const carried = fold(youth({ sinBinMinutes: 10 }), ["core.start"], sinBin("H-p5", 1700));
    expect(carried.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H2", 500));
    // The 11-a-side half is 2700 s, so the same bin ends inside the first half at 1700 + 600.
    const senior = fold(elevenASide({ sinBinMinutes: 10 }), ["core.start"], sinBin("H-p5", 1700));
    expect(senior.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H1", 2300));
  });

  it("FB-YT-1 a substituted player may come back on youth and may not on 11-a-side", () => {
    const off = legacySub("H", "H-p2", "H-b1");
    const back = legacySub("H", "H-b1", "H-p2");
    const state = fold(youth(), ["core.start"], off, back);
    expect(state.squads.home.onPitch).toContain("H-p2");
    expect(state.squads.home.offUsed).toEqual([]);
    expect(refusal(() => fold(elevenASide(), ["core.start"], off, back))).toEqual({ code: "INVALID_EVENT", reason: "reentry-forbidden" });
  });

  it("FB-YT-1 11-a-side keeps its substitution cap where the competition sets one, and youth does not", () => {
    // Two substitutions against a cap of one: 11-a-side refuses the second, youth (rolling) takes it.
    const two: Spec[] = [["core.start"], legacySub("H", "H-p2", "H-b1"), legacySub("H", "H-p3", "H-b2")];
    expect(refusal(() => fold(elevenASide({ maxSubs: 1 }), ...two))).toEqual({ code: "INVALID_EVENT", reason: "sub-cap-reached" });
    expect(refusal(() => fold(youth({ maxSubs: 1 }), ...two))).toBeNull();
    // The cap is the competition's: 11-a-side with none set takes both.
    expect(refusal(() => fold(elevenASide(), ...two))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// FB-SB-1 (M11) - sin bin
// ---------------------------------------------------------------------------------------------------------------------

describe("FB-SB-1 a sin bin takes a player off for sinBinMinutes of game time and the engine sweeps it once that time has elapsed", () => {
  // IFAB guidelines for temporary dismissals: 10 minutes in a 90-minute match; the remainder carries into the next half.
  const base = cfgOf({ sinBinMinutes: 10 });
  const home = (state: FootballState) => state.squads.home;

  it("FB-SB-1 takes the player off the pitch for the length from the cfg, with the expiry 600 s on", () => {
    const state = fold(base, ["core.start"], sinBin("H-p5", 600));
    expect(home(state).onPitch).not.toContain("H-p5");
    expect(home(state).sinBin).toEqual([{ person: "H-p5", minutes: 10, startedAt: at("H1", 600), expiresAt: at("H1", 1200) }]);
  });

  it("FB-SB-1 the sweep is lazy and exact: still off at 1199 s, back at the first stamped event at 1200 s", () => {
    for (const [elapsed, back] of [[1199, false], [1200, true], [1500, true]] as const) {
      const state = fold(base, ["core.start"], sinBin("H-p5", 600), goal("A", { at: at("H1", elapsed) }));
      expect(home(state).onPitch.includes("H-p5"), `stamped event at ${elapsed}`).toBe(back);
      expect(home(state).sinBin?.length, `bin at ${elapsed}`).toBe(back ? 0 : 1);
    }
  });

  it("FB-SB-1 an unstamped event sweeps nothing, so the player stays off", () => {
    const state = fold(base, ["core.start"], sinBin("H-p5", 600), goal("A"));
    expect(home(state).onPitch).not.toContain("H-p5");
    expect(home(state).sinBin?.length).toBe(1);
  });

  it("FB-SB-1 an award of its own (payload minutes) beats the competition's length", () => {
    const state = fold(base, ["core.start"], sinBin("H-p5", 600, { minutes: 5 }));
    expect(home(state).sinBin?.[0]).toMatchObject({ minutes: 5, expiresAt: at("H1", 900) });
    // A competition with no length and no award has nothing to sweep: the bin ends only on football.sinbin.end.
    const none = fold(cfgOf({}), ["core.start"], sinBin("H-p5", 600));
    expect(home(none).sinBin?.[0]?.expiresAt).toBeUndefined();
    const later = fold(cfgOf({}), ["core.start"], sinBin("H-p5", 600), goal("A", { at: at("H1", 2000) }));
    expect(home(later).onPitch).not.toContain("H-p5");
    const ended = fold(cfgOf({}), ["core.start"], sinBin("H-p5", 600), ["football.sinbin.end", { by: "H", person: "H-p5" }]);
    expect(home(ended).onPitch).toContain("H-p5");
  });

  it("FB-SB-1 the unserved remainder carries into the next half and the half-time whistle sweeps what ends inside the half", () => {
    // 90-minute match, halves of 2700 s: a bin at 2600 s has 100 s left in H1 and 500 s to serve in H2.
    const carried = fold(base, ["core.start"], sinBin("H-p5", 2600));
    expect(home(carried).sinBin?.[0]?.expiresAt).toEqual(at("H2", 500));
    const midSecondHalf = fold(base, ["core.start"], sinBin("H-p5", 2600), ["football.period", { phase: "HT" }], goal("A", { at: at("H2", 499) }));
    expect(home(midSecondHalf).onPitch).not.toContain("H-p5");
    const served = fold(base, ["core.start"], sinBin("H-p5", 2600), ["football.period", { phase: "HT" }], goal("A", { at: at("H2", 500) }));
    expect(home(served).onPitch).toContain("H-p5");
    // A bin that ends inside the first half is over at the half-time whistle, with no stamped event after it.
    const swept = fold(base, ["core.start"], sinBin("H-p5", 2100), ["football.period", { phase: "HT" }]);
    expect(home(swept).onPitch).toContain("H-p5");
    expect(home(swept).sinBin).toEqual([]);
  });

  it("FB-SB-1 a player cannot be put in the bin twice, and voiding the sin bin brings him back", () => {
    expect(refusal(() => fold(base, ["core.start"], sinBin("H-p5", 600), sinBin("H-p5", 700)))).toEqual({ code: "INVALID_EVENT" });
    const state = fold(base, ["core.start"], sinBin("H-p5", 600), ["core.void", {}, "e-1"]);
    expect(home(state).onPitch).toContain("H-p5");
    expect(home(state).sinBin ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// FB-SU-1 (M13) - substitutions
// ---------------------------------------------------------------------------------------------------------------------

describe("FB-SU-1 substitutions follow Law 3: maxSubs caps them per side except under rollingSubs, repeat substitutions need rollingSubs, concussion substitutions sit outside the cap", () => {
  // IFAB Law 3.2: the competition sets the number (up to five in an official competition); return substitutions only where
  // youth/veterans/grassroots competition rules allow them; the concussion substitution is separate from the normal limit.
  const subs = (n: number, vocabulary: "football.sub" | "core.lineup.substitution"): Spec[] =>
    Array.from({ length: n }, (_, i) => (vocabulary === "football.sub" ? legacySub("H", `H-p${i + 2}`, `H-b${i + 1}`) : kernelSub(`H-p${i + 2}`, `H-b${i + 1}`)));
  const VOCABULARIES = ["football.sub", "core.lineup.substitution"] as const;

  it("FB-SU-1 maxSubs caps the substitutions per side in both vocabularies: the cap's worth fold, the next is refused", () => {
    let checked = 0;
    for (const vocabulary of VOCABULARIES) {
      for (const cap of [0, 1, 3, 5]) {
        const atCap = [["core.start"] as Spec, ...subs(cap, vocabulary)];
        expect(refusal(() => fold(cfgOf({ maxSubs: cap }), ...atCap)), `${vocabulary} cap ${cap} at the cap`).toBeNull();
        const over = [["core.start"] as Spec, ...subs(cap + 1, vocabulary)];
        const refused = refusal(() => fold(cfgOf({ maxSubs: cap }), ...over));
        expect(refused, `${vocabulary} cap ${cap} one over`).toMatchObject({ code: vocabulary === "football.sub" ? "INVALID_EVENT" : "LINEUP_INVALID", reason: "sub-cap-reached" });
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("FB-SU-1 an absent maxSubs is uncapped", () => {
    // Six players on the bench, all six come on: no cap to reach.
    expect(refusal(() => fold(cfgOf({}), ["core.start"], ...subs(6, "football.sub")))).toBeNull();
    expect(refusal(() => fold(cfgOf({}), ["core.start"], ...subs(6, "core.lineup.substitution")))).toBeNull();
  });

  it("FB-SU-1 rollingSubs drops the cap: maxSubs is ignored while the competition plays rolling substitutions", () => {
    // maxSubs 1 with rollingSubs on: six substitutions fold in both vocabularies (football.ts lineupPolicy leaves maxSubs out).
    for (const vocabulary of VOCABULARIES) {
      expect(refusal(() => fold(cfgOf({ maxSubs: 1, rollingSubs: true }), ["core.start"], ...subs(6, vocabulary))), vocabulary).toBeNull();
      // The contrast: the same maxSubs 1 without rollingSubs refuses the second.
      expect(refusal(() => fold(cfgOf({ maxSubs: 1 }), ["core.start"], ...subs(2, vocabulary))), `${vocabulary} without rolling`).toMatchObject({ reason: "sub-cap-reached" });
    }
  });

  it("FB-SU-1 a repeat substitution (the player who came off returns) needs rollingSubs", () => {
    const off: Spec = legacySub("H", "H-p2", "H-b1");
    const back: Spec = legacySub("H", "H-b1", "H-p2");
    expect(refusal(() => fold(cfgOf({}), ["core.start"], off, back))).toEqual({ code: "INVALID_EVENT", reason: "reentry-forbidden" });
    const state = fold(cfgOf({ rollingSubs: true }), ["core.start"], off, back);
    expect(state.squads.home.onPitch).toContain("H-p2");
    // The same through the kernel vocabulary: a player who came off returns only under rollingSubs.
    const kernelOff: Spec = kernelSub("H-p2", "H-b1");
    const kernelBack: Spec = kernelSub("H-b1", "H-p2");
    expect(refusal(() => fold(cfgOf({}), ["core.start"], kernelOff, kernelBack))).toMatchObject({ reason: "reentry-forbidden" });
    const kernelRolling = fold(cfgOf({ rollingSubs: true }), ["core.start"], kernelOff, kernelBack);
    expect(kernelRolling.squads.home.onPitch).toContain("H-p2");
    // A player who came off and never returned is refused as the substitute of a later substitution just the same.
    const cameOff: Spec = legacySub("H", "H-p3", "H-p2");
    expect(refusal(() => fold(cfgOf({}), ["core.start"], off, cameOff))).toEqual({ code: "INVALID_EVENT", reason: "reentry-forbidden" });
  });

  describe("FB-SU-1 concussion substitutions", () => {
    const concussion = (off: string, on: string): Spec => [
      "core.lineup.replacement",
      { side: "H", off, on: { personId: on, slot: "bench", orderNo: 40 }, exemption: "concussion" },
    ];
    const atCap: Spec[] = [["core.start"], kernelSub("H-p2", "H-b1")]; // cap 1 spent

    it("FB-SU-1 sit outside the cap where the competition adopts the protocol, and do not refund the cap", () => {
      const cfg = cfgOf({ maxSubs: 1, concussionSubs: 1 });
      expect(refusal(() => fold(cfg, ...atCap, kernelSub("H-p3", "H-b2")))).toMatchObject({ reason: "sub-cap-reached" });
      const replaced = fold(cfg, ...atCap, concussion("H-p3", "H-b2"));
      expect(replaced.squads.home.onPitch).toContain("H-b2");
      expect(replaced.squads.home.exemptUsed).toEqual({ concussion: 1 });
      // The exemption is permanent and does not give an ordinary substitution back.
      expect(refusal(() => fold(cfg, ...atCap, concussion("H-p3", "H-b2"), kernelSub("H-p4", "H-b3")))).toMatchObject({ reason: "sub-cap-reached" });
    });

    it("FB-SU-1 are refused where the competition has not adopted the protocol, and bounded by its own allowance where it has", () => {
      expect(refusal(() => fold(cfgOf({ maxSubs: 1 }), ...atCap, concussion("H-p3", "H-b2")))).toMatchObject({ code: "LINEUP_INVALID", reason: "exemption-not-declared" });
      const cfg = cfgOf({ maxSubs: 1, concussionSubs: 1 });
      expect(refusal(() => fold(cfg, ...atCap, concussion("H-p3", "H-b2"), concussion("H-p4", "H-b3")))).toMatchObject({ code: "LINEUP_INVALID", reason: "exemption-cap-reached" });
      // The allowance is the competition's number, not the protocol's one-per-team: two are honoured when it says two.
      expect(refusal(() => fold(cfgOf({ maxSubs: 1, concussionSubs: 2 }), ...atCap, concussion("H-p3", "H-b2"), concussion("H-p4", "H-b3")))).toBeNull();
    });
  });

  it("FB-SU-1 voiding a substitution gives its place in the cap back", () => {
    // [start, sub, void(sub), sub] on a cap of one folds: the voided substitution never counted.
    const state = fold(cfgOf({ maxSubs: 1 }), ["core.start"], legacySub("H", "H-p2", "H-b1"), ["core.void", {}, "e-1"], legacySub("H", "H-p3", "H-b2"));
    expect(state.squads.home.onPitch).toContain("H-b2");
    expect(state.squads.home.onPitch).toContain("H-p2");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// FB-RO-1 (M12, M14) - record-only
// ---------------------------------------------------------------------------------------------------------------------

describe("FB-RO-1 record-only: an in-play penalty kick on its goal, added time and the period-length override are recorded and move no score", () => {
  /** What the result is: goals, outcome and the headline - every field a record-only item must leave alone. */
  const result = (state: FootballState) => ({ goals: state.goals, outcome: state.outcome, headline: football.summary(state).headline });
  const match = (goalExtra: Record<string, unknown>, periodExtra: Record<string, unknown>, cfg: FootballCfg = cfgOf({})) =>
    fold(cfg, ["core.start"], goal("H", { ...goalExtra }), goal("A"), ["football.period", { phase: "HT", ...periodExtra }], goal("H"), ["football.period", { phase: "FT" }]);

  it("FB-RO-1 an in-play penalty goal counts exactly one goal, the same result as the goal without the flag", () => {
    const plain = match({}, {});
    const penalty = match({ penalty: true }, {});
    expect(result(plain)).toEqual({ goals: { home: 2, away: 1 }, outcome: { kind: "win", winner: "H", loser: "A", method: "regulation" }, headline: "2 — 1" });
    expect(result(penalty)).toEqual(result(plain));
    // The state keeps no trace of the flag: it is a record on the event.
    expect(JSON.stringify(penalty)).not.toContain("penalty");
  });

  it("FB-RO-1 added time is recorded on the period it closes and changes nothing else", () => {
    const plain = match({}, {});
    const added = match({}, { addedMinutes: 4 });
    expect(added.periods[0]).toMatchObject({ phase: "H1", addedMinutes: 4 });
    expect(plain.periods[0]).not.toHaveProperty("addedMinutes");
    expect(result(added)).toEqual(result(plain));
    expect(added.periods.map((p) => [p.phase, p.home, p.away])).toEqual(plain.periods.map((p) => [p.phase, p.home, p.away]));
  });

  it("FB-RO-1 periodSeconds moves no score, and reaches only the length a sin bin carries across a half", () => {
    const plain = match({}, {});
    const override = match({}, {}, cfgOf({ periodSeconds: { H1: 2400, H2: 2700 } }));
    expect(result(override)).toEqual(result(plain));
    // The one thing it does read: the first half is 2400 s, so a 10-minute bin at 2300 s carries 500 s (not 200 s) into H2.
    const bin = (cfg: FootballCfg) => fold(cfg, ["core.start"], sinBin("H-p5", 2300)).squads.home.sinBin?.[0]?.expiresAt;
    expect(bin(cfgOf({ sinBinMinutes: 10, periodSeconds: { H1: 2400, H2: 2700 } }))).toEqual(at("H2", 500));
    expect(bin(cfgOf({ sinBinMinutes: 10 }))).toEqual(at("H2", 200));
  });
});
