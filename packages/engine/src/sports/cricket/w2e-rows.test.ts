// W2e Task 14 (A2) — the proving tests for cricket.md's W2e rows. Every describe/it title carries its row id as a whole token,
// which is what packages/engine/test/rules-reference.ts reads. The expected values come from the rulebook (MCC Laws of Cricket;
// ICC Men's T20 World Cup 2026 Playing Conditions), written into each test as literals - never from the code under test.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path, where the cfg-derived refusals (the bowler quota) are live.
//
// CK-FH-1 is a deviation row: its test pins what the engine does (the refusal of hit-the-ball-twice on a free hit), not what the
// rulebook would have. CK-DV-1 keeps its deviation status only for the Hundred's ten-ball bowling changes, which the engine does not
// model (SC-C7); its net run rate follows the variant's over since D19 (CK-BO-2).
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { derivedMetricText } from "../../competition/display.ts";
import type { StandingsRow } from "../../competition/standings.ts";
import { makeEnvelope } from "../../testkit/index.ts";
import { CRICKET_EVENT_SCHEMAS, CricketWicket, cricket, type CricketCfg } from "./cricket.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const league: StageCtx = { kind: "league" };

/** Eleven starters (batting order = orderNo) plus an optional bench of named substitutes. */
function lineup(prefix: string, bench = 0): LineupPair["home"] {
  return {
    entrantId: prefix,
    slots: [
      ...Array.from({ length: 11 }, (_, i) => ({
        personId: `${prefix}-${i + 1}`,
        slot: "starting" as const,
        orderNo: i + 1,
        ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
      })),
      ...Array.from({ length: bench }, (_, i) => ({
        personId: `${prefix}-b${i + 1}`,
        slot: "bench" as const,
        orderNo: 12 + i,
      })),
    ],
  };
}
const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };
const benched: LineupPair = { home: lineup("H", 2), away: lineup("A", 2) };

const parse = (raw: unknown): CricketCfg => cricket.configSchema.parse(raw);
const t20 = parse(cricket.variants.t20);
const odi = parse(cricket.variants.odi);
const timeless = parse(cricket.variants.test);

type Spec = [type: string, payload?: unknown, voids?: string];
const stream = (...specs: Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const fold = (cfg: CricketCfg, specs: Spec[], pair: LineupPair = lineups) =>
  foldMatch(cricket, cfg, pair, stream(...specs), STRICT_ALL);
const summary = (runs: number, wickets: number, legalBalls: number, more: Record<string, unknown> = {}): Spec => [
  "cricket.innings.summary",
  { runs, wickets, legalBalls, ...more },
];
/** The code of the EngineError a fold throws, or null when it folds. Anything else rethrows. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}
/** The kernel's `reason` for a refused lineup event (`LINEUP_INVALID`), or null when it folds. */
function lineupRefusal(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (EngineError.is(error, "LINEUP_INVALID")) return (error.data as { reason: string }).reason;
    throw error;
  }
}

/** A delivery at legal-ball index `n` (six-ball overs), so over/ballInOver match what the fold derives. */
function ball(n: number, striker: string, nonStriker: string, bowler: string, more: Record<string, unknown> = {}): Spec {
  return [
    "cricket.ball",
    { over: Math.floor(n / 6), ballInOver: (n % 6) + 1, striker, nonStriker, bowler, runs: { bat: 0 }, ...more },
  ];
}
/** The same delivery as a super-over ball. */
const superBall = (spec: Spec): Spec => ["cricket.superover.ball", spec[1]];
/** Whole dot-ball overs: `plan[k]` bowls over k; the fold swaps ends at each over, so the pair alternates. */
function dotOvers(plan: readonly string[]): Spec[] {
  return plan.flatMap((bowler, k) => {
    const [striker, nonStriker] = k % 2 === 0 ? ["H-1", "H-2"] : ["H-2", "H-1"];
    return Array.from({ length: 6 }, (_, b) => ball(k * 6 + b, striker, nonStriker, bowler));
  });
}

type Side = "home" | "away";
const NAME: Record<Side, string> = { home: "H", away: "A" };
const other = (side: Side): Side => (side === "home" ? "away" : "home");
/** Having the first innings is the toss's to give: an away side that bats first is the toss going the other way. */
const tossFor = (first: Side): Spec[] => (first === "home" ? [] : [["cricket.toss", { wonBy: "A", elected: "bat" }]]);

// ---------------------------------------------------------------------------------------------------------------------
// CK-IV-1 (A7) - innings victory
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-IV-1 innings victory: a side that finished two innings still below the other side's one innings loses by an innings and the difference", () => {
  const followOn = parse({ ...cricket.variants.test, followOn: { enabled: true, lead: 150 } });
  // Both routes start with F's 400 declared. The side that batted ONCE wins: F on the follow-on route (F, S, S, F), S on the
  // natural route (F, S, F, S).
  interface Case {
    name: string;
    route: "follow-on" | "natural";
    rest: Spec[];
    margin: number | null; // the innings-and-runs margin, or null where nothing is decided yet
  }
  const cases: Case[] = [
    // Follow-on: F 400, S 250 (lead 150 = the follow-on lead), S follows on and adds X.
    { name: "S ends 1 short of F's 400 (250 + 149)", route: "follow-on", rest: [summary(250, 10, 480), ["cricket.followon"], summary(149, 10, 300)], margin: 1 },
    { name: "S ends 91 short (250 + 59)", route: "follow-on", rest: [summary(250, 10, 480), ["cricket.followon"], summary(59, 10, 300)], margin: 91 },
    { name: "totals level (250 + 150 = 400) is not an innings victory", route: "follow-on", rest: [summary(250, 10, 480), ["cricket.followon"], summary(150, 10, 300)], margin: null },
    { name: "S ahead (250 + 151) is not an innings victory", route: "follow-on", rest: [summary(250, 10, 480), ["cricket.followon"], summary(151, 10, 300)], margin: null },
    // Natural order: F 400, S 600, F bats again and finishes below S's one innings.
    { name: "F's second innings leaves F 100 short (400 + 100 vs 600)", route: "natural", rest: [summary(600, 10, 700), summary(100, 10, 200)], margin: 100 },
    { name: "totals level (400 + 200 vs 600) is not an innings victory", route: "natural", rest: [summary(600, 10, 700), summary(200, 10, 200)], margin: null },
    { name: "F ahead (400 + 201 vs 600) is not an innings victory", route: "natural", rest: [summary(600, 10, 700), summary(201, 10, 200)], margin: null },
  ];

  it("CK-IV-1 decides by an innings and the exact run difference at every boundary, whichever side bats first", () => {
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      for (const { name, route, rest, margin } of cases) {
        const label = `${first} bats first, ${route}: ${name}`;
        const state = fold(followOn, [...tossFor(first), ["core.start"], summary(400, 6, 540, { declared: true }), ...rest]);
        if (margin === null) {
          expect(state.outcome, label).toBeNull();
          expect(state.phase, label).toBe("live");
        } else {
          const winner = route === "follow-on" ? first : other(first);
          expect(state.outcome, label).toEqual({ kind: "win", winner: NAME[winner], loser: NAME[other(winner)], method: "innings" });
          expect(state.margin, label).toEqual({ kind: "innings_and_runs", value: margin });
          expect(state.phase, label).toBe("done");
        }
        checked++;
      }
    }
    expect(checked).toBe(cases.length * 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-FO-1 (A8) - follow-on
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-FO-1 follow-on: two innings a side, only at the configured lead, and the order becomes F, S, S, F", () => {
  const followOn = parse({ ...cricket.variants.test, followOn: { enabled: true, lead: 150 } });
  const firstTwo = (secondRuns: number): Spec[] => [
    ["core.start"],
    summary(400, 6, 540, { declared: true }),
    summary(secondRuns, 10, 480),
  ];

  it("CK-FO-1 a config that enables it with one innings a side is refused, and the same config disabled parses", () => {
    const oneInnings = { ...cricket.variants.t20, followOn: { enabled: true, lead: 150 } };
    const refused = cricket.configSchema.safeParse(oneInnings);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.message).join("|")).toContain("followOn");
    expect(cricket.configSchema.safeParse({ ...oneInnings, followOn: { enabled: false, lead: 150 } }).success).toBe(true);
  });

  it("CK-FO-1 the event is refused where the match does not enable it", () => {
    const disabled = parse({ ...cricket.variants.test, followOn: { enabled: false, lead: 150 } });
    expect(codeOf(() => fold(disabled, [...firstTwo(250), ["cricket.followon"]]))).toBe("INVALID_EVENT");
    // A one-innings match, innings break reached (still live, so the refusal is the follow-on's own and not a finished match's).
    const breakState = fold(t20, [["core.start"], summary(150, 5, 120)]);
    expect(breakState.phase).toBe("live");
    expect(codeOf(() => fold(t20, [["core.start"], summary(150, 5, 120), ["cricket.followon"]]))).toBe("INVALID_EVENT");
  });

  it("CK-FO-1 a lead one run short of followOn.lead is refused and a lead that meets it is accepted, whichever side bats first", () => {
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      // 400 - 251 = 149 short of 150; 400 - 250 = 150 meets it.
      expect(codeOf(() => fold(followOn, [...tossFor(first), ...firstTwo(251), ["cricket.followon"]])), `${first}: lead 149`).toBe("INVALID_EVENT");
      const met = fold(followOn, [...tossFor(first), ...firstTwo(250), ["cricket.followon"]]);
      expect(met.followOnEnforced, `${first}: lead 150`).toBe(true);
      checked += 2;
    }
    expect(checked).toBe(4);
  });

  it("CK-FO-1 an enforced follow-on orders the innings first, second, second, first; without it, first, second, first, second", () => {
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      const second = other(first);
      // F 400, S 250, S follows on and makes 200 (450 in all, so the match is open), F chases 51 and is 50 for 3.
      const enforced = fold(followOn, [...tossFor(first), ...firstTwo(250), ["cricket.followon"], summary(200, 10, 300), summary(50, 3, 60, { partial: true })]);
      expect(enforced.innings.map((i) => i.battingSide), `${first}: enforced`).toEqual([first, second, second, first]);
      const natural = fold(followOn, [...tossFor(first), ...firstTwo(250), summary(100, 10, 200), summary(50, 3, 60)]);
      expect(natural.innings.map((i) => i.battingSide), `${first}: natural`).toEqual([first, second, first, second]);
      checked += 2;
    }
    expect(checked).toBe(4);
  });

  it("CK-FO-1 a voided follow-on restores the natural order (after a void)", () => {
    // Events: 0 start, 1 first innings, 2 second innings, 3 followon, 4 void of 3, then the third innings.
    const voided = fold(followOn, [
      ...firstTwo(250),
      ["cricket.followon"],
      ["core.void", {}, "e-3"],
      summary(100, 10, 200),
    ]);
    expect(voided.followOnEnforced).toBe(false);
    expect(voided.innings.map((i) => i.battingSide)).toEqual(["home", "away", "home"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-IF-1 (A9) - innings forfeiture
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-IF-1 innings forfeiture: the innings is closed with the reason forfeited and counts as a completed innings", () => {
  /** A forfeited innings: opened at nil and closed with the reason. */
  const forfeit: Spec[] = [summary(0, 0, 0, { partial: true }), ["cricket.innings.close", { reason: "forfeited" }]];
  const config = parse({ ...cricket.variants.test, followOn: { enabled: true, lead: 150 } });

  it("CK-IF-1 closes the innings with the reason forfeited at nil, and it counts as completed for the next innings' target", () => {
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      const second = other(first);
      // F 300, S 100, F forfeits its second innings: S chases 300 - 100 + 1 = 201 (Law 16, the result).
      const prefix: Spec[] = [...tossFor(first), ["core.start"], summary(300, 10, 400), summary(100, 10, 200), ...forfeit];
      const afterForfeit = fold(config, prefix);
      const forfeited = afterForfeit.innings[2];
      expect(forfeited, `${first}: third innings exists`).toBeDefined();
      expect(forfeited).toMatchObject({ battingSide: first, closed: true, runs: 0, closeReason: "forfeited" });
      expect(afterForfeit.outcome, `${first}: not yet decided`).toBeNull();
      // 199 -> F by 1 run; 200 -> level (tie); 201 -> S by wickets in hand.
      const lose = fold(config, [...prefix, summary(199, 10, 300)]);
      expect(lose.outcome, `${first}: 199`).toMatchObject({ kind: "win", winner: NAME[first] });
      expect(lose.margin, `${first}: 199`).toEqual({ kind: "runs", value: 1 });
      expect(fold(config, [...prefix, summary(200, 10, 300)]).outcome, `${first}: 200`).toEqual({ kind: "tie" });
      const win = fold(config, [...prefix, summary(201, 5, 240)]);
      expect(win.outcome, `${first}: 201`).toMatchObject({ kind: "win", winner: NAME[second] });
      expect(win.margin, `${first}: 201`).toEqual({ kind: "wickets", value: 5 });
      checked += 5;
    }
    expect(checked).toBe(10);
  });

  it("CK-IF-1 a forfeited second innings after a follow-on is what completes the match: an innings victory", () => {
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      const state = fold(config, [
        ...tossFor(first),
        ["core.start"],
        summary(350, 7, 500, { declared: true }),
        summary(100, 10, 200),
        ["cricket.followon"],
        ...forfeit,
      ]);
      expect(state.innings.map((i) => [i.battingSide, i.closeReason])).toEqual([
        [first, undefined],
        [other(first), undefined],
        [other(first), "forfeited"],
      ]);
      expect(state.outcome).toEqual({ kind: "win", winner: NAME[first], loser: NAME[other(first)], method: "innings" });
      expect(state.margin).toEqual({ kind: "innings_and_runs", value: 250 });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-RR-2 (A10) - timeless innings: net run rate on the overs actually faced
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-RR-2 timeless innings: net run rate counts the overs actually faced, where a limited innings is charged its quota", () => {
  it("CK-RR-2 a played timeless match charges every innings its legal balls, all out or not", () => {
    // H 300 all out in 400 balls, A 250 all out in 380, H 150 all out in 200, A 201/5 in 240: A wins by 5 wickets.
    const state = fold(timeless, [
      ["core.start"],
      summary(300, 10, 400),
      summary(250, 10, 380),
      summary(150, 10, 200),
      summary(201, 5, 240),
    ]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A" });
    const [home, away] = cricket.standingsDelta(state.outcome!, timeless, league, state);
    // ICC 16.10.7 charges an all-out side its full QUOTA; a timeless innings has none, so the balls it faced stand.
    expect(home.metrics).toMatchObject({ runs_for: 450, balls_faced_eff: 400 + 200, runs_against: 451, balls_bowled_eff: 380 + 240 });
    expect(away.metrics).toMatchObject({ runs_for: 451, balls_faced_eff: 380 + 240, runs_against: 450, balls_bowled_eff: 400 + 200 });
  });

  it("CK-RR-2 the same all-out innings in a limited match is charged the full quota (the contrast the timeless rule differs from)", () => {
    // A 150 all out in 100 balls of a 120-ball (20-over) innings: charged 120, not 100 (ICC 16.10.7).
    const state = fold(t20, [["core.start"], summary(180, 4, 120), summary(150, 10, 100)]);
    const [home, away] = cricket.standingsDelta(state.outcome!, t20, league, state);
    expect(away.metrics.balls_faced_eff).toBe(20 * 6);
    expect(home.metrics.balls_bowled_eff).toBe(20 * 6);
  });

  it("CK-RR-2 a timeless walkover stays out of net run rate: nothing credited and no quota charged (CK-WO-2)", () => {
    const state = fold(timeless, [["core.forfeit", { by: "A", reason: "walkover" }]]);
    for (const side of cricket.standingsDelta(state.outcome!, timeless, league, state)) {
      expect(side.metrics).toMatchObject({ runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0 });
    }
    // The limited-overs contrast: the defaulter IS charged its full quota there (CK-WO-1).
    const limited = fold(t20, [["core.forfeit", { by: "A", reason: "walkover" }]]);
    const [, away] = cricket.standingsDelta(limited.outcome!, t20, league, limited);
    expect(away.metrics.balls_faced_eff).toBe(20 * 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-PR-1 (A11) - penalty runs
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-PR-1 penalty runs: added to the batting side's total as extras, never run, so the striker does not change", () => {
  it("CK-PR-1 five penalty runs add five to the total and to extras and leave the striker where he was", () => {
    const state = fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-11", { runs: { bat: 0, extras: { kind: "penalty", runs: 5 } } })]);
    const innings = state.innings[0]!;
    expect(innings.runs).toBe(5);
    expect(innings.fine?.extras).toBe(5);
    expect([innings.fine?.striker, innings.fine?.nonStriker]).toEqual(["H-1", "H-2"]);
    // The bowler is not charged with a side's penalty (ICC 41.17.3: awarded when the ball is dead).
    expect(innings.fine?.bowlerRuns["A-11"]).toBe(0);
  });

  it("CK-PR-1 the same five as byes WERE run, so they change the striker (the contrast a never-run penalty differs from)", () => {
    const state = fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-11", { runs: { bat: 0, extras: { kind: "bye", runs: 5 } } })]);
    expect([state.innings[0]!.fine?.striker, state.innings[0]!.fine?.nonStriker]).toEqual(["H-2", "H-1"]);
    expect(state.innings[0]!.runs).toBe(5);
  });

  it("CK-PR-1 penalty runs ride beside the bat's runs: a four off the bat plus five penalty is nine, extras five", () => {
    const state = fold(t20, [
      ["core.start"],
      ball(0, "H-1", "H-2", "A-11", { runs: { bat: 4, extras: { kind: "penalty", runs: 5 } }, boundary: 4 }),
    ]);
    expect(state.innings[0]!.runs).toBe(9);
    expect(state.innings[0]!.fine?.extras).toBe(5);
    expect(state.innings[0]!.fine?.batterRuns["H-1"]).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-MO-1 (P1) - the minimum overs for a result
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-MO-1 minimum overs: 5 in the t20 preset and 20 in the odi preset; abandoned below it, no result", () => {
  // ICC T20 WC PC 13.7.2.2.3 (5 overs); the odi preset's 20 (ICC ODI playing conditions).
  const presets: Array<[string, CricketCfg, number, number, number]> = [
    // [name, base cfg, rulebook minimum overs, innings quota in balls, first innings runs]
    ["t20", t20, 5, 120, 150],
    ["odi", odi, 20, 300, 250],
  ];

  it("CK-MO-1 the presets carry the rulebook's minimum", () => {
    for (const [name, cfg, minOvers] of presets) {
      expect(cfg.minOversForResult, name).toBe(minOvers);
    }
    expect(presets).toHaveLength(2);
  });

  it("CK-MO-1 an abandon one ball short of the minimum is a no result, and at the minimum a Duckworth/Lewis/Stern result", () => {
    let checked = 0;
    for (const [name, base, minOvers, quota, firstRuns] of presets) {
      const cfg = parse({ ...base, dls: { enabled: true, edition: "standard" } });
      const minBalls = minOvers * 6;
      const abandonAt = (chaseBalls: number) =>
        fold(cfg, [
          ["core.start"],
          summary(firstRuns, 5, quota),
          // The chase is far ahead of any par score, so the only thing that can stop it winning is the minimum.
          summary(firstRuns - 50, 2, chaseBalls, { partial: true }),
          ["core.abandon", { reason: "rain" }],
        ]);
      expect(abandonAt(minBalls - 1).outcome, `${name}: ${minBalls - 1} balls`).toEqual({ kind: "no_result" });
      expect(abandonAt(minBalls).outcome, `${name}: ${minBalls} balls`).toMatchObject({ kind: "win", winner: "A", method: "dls" });
      checked += 2;
    }
    expect(checked).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-SO-2 (P2) - an abandoned super over is a tie
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-SO-2 a match abandoned during a super over is a tie: the tied main match stands and no side wins the super over", () => {
  const knockout = parse({ ...cricket.variants.t20, superOver: true });
  const tiedMain: Spec[] = [["core.start"], summary(150, 5, 120), summary(150, 8, 120)];

  it("CK-SO-2 the main match tied with a super over owed is not yet an outcome", () => {
    const state = fold(knockout, tiedMain);
    expect(state.phase).toBe("super_over");
    expect(state.outcome).toBeNull();
  });

  it("CK-SO-2 an abandon at the start of the super over, and one a ball in, both leave a tie and pay tie points", () => {
    let checked = 0;
    const played: Array<[string, Spec[]]> = [
      ["no ball bowled", []],
      ["one ball bowled", [superBall(ball(0, "A-1", "A-2", "H-11", { runs: { bat: 1 } }))]],
    ];
    for (const [name, specs] of played) {
      const state = fold(knockout, [...tiedMain, ...specs, ["core.abandon", { reason: "rain" }]]);
      expect(state.outcome, name).toEqual({ kind: "tie" });
      expect(state.margin, name).toBeNull();
      expect(state.phase, name).toBe("done");
      const [home, away] = cricket.standingsDelta(state.outcome!, knockout, league, state);
      expect([home.points, away.points], name).toEqual([1, 1]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("CK-SO-2 a super over played to a result is a win, so the abandon is what makes the tie (the contrast)", () => {
    // Away bats first in the super over: 6 off the first ball, then home is dismissed twice with no runs.
    const state = fold(knockout, [
      ...tiedMain,
      superBall(ball(0, "A-1", "A-2", "H-11", { runs: { bat: 6 }, boundary: 6 })),
      ...[1, 2, 3, 4, 5].map((n) => superBall(ball(n, "A-1", "A-2", "H-11"))),
      superBall(ball(0, "H-1", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } })),
      superBall(ball(1, "H-3", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-3", bowlerCredited: true } })),
    ]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "super_over" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-RT-2 (P3) - a manual revised target
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-RT-2 a revised target may be entered by hand and, once manual, is not recomputed", () => {
  const withDls = parse({ ...cricket.variants.t20, dls: { enabled: true, edition: "standard" } });
  const firstInnings: Spec[] = [["core.start"], summary(150, 6, 120)];

  it("CK-RT-2 a manual target stands through a later revision of the overs, where a computed target moves with it", () => {
    const manual = fold(withDls, [...firstInnings, ["cricket.revise", { oversPerSide: 15, target: 97 }], ["cricket.revise", { oversPerSide: 14 }]]);
    expect(manual.targetSource).toBe("manual");
    expect(manual.revisedTarget).toBe(97);
    expect(manual.quota).toBe(14 * 6);

    // The contrast: with no hand-entered target the engine computes one and recomputes it on the next revision.
    const afterFifteen = fold(withDls, [...firstInnings, ["cricket.revise", { oversPerSide: 15 }]]);
    const afterFourteen = fold(withDls, [...firstInnings, ["cricket.revise", { oversPerSide: 15 }], ["cricket.revise", { oversPerSide: 14 }]]);
    expect(afterFifteen.targetSource).toBe("dls");
    expect(afterFourteen.targetSource).toBe("dls");
    expect(afterFifteen.revisedTarget).not.toBeNull();
    expect(afterFourteen.revisedTarget).not.toBe(afterFifteen.revisedTarget);
  });

  it("CK-RT-2 a manual target needs no Duckworth/Lewis/Stern and is the chase's target: reaching it wins, one short does not", () => {
    // t20 with DLS off: a hand-entered target of 100 against a first innings of 150 (rain, umpires' figure).
    const base: Spec[] = [...firstInnings, ["cricket.revise", { target: 100 }]];
    const short = fold(t20, [...base, summary(99, 4, 90, { partial: true })]);
    expect(short.targetSource).toBe("manual");
    expect(short.outcome).toBeNull();
    const reached = fold(t20, [...base, summary(100, 4, 90, { partial: true })]);
    expect(reached.outcome).toMatchObject({ kind: "win", winner: "A" });
    expect(reached.margin).toEqual({ kind: "wickets", value: 6 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-AB-3 (P4) - a two-innings abandon is a draw
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-AB-3 a two-innings cricket match that is abandoned is a draw; a one-innings match is not", () => {
  const abandon: Spec = ["core.abandon", { reason: "rain" }];
  const states: Array<[string, Spec[]]> = [
    ["before the first ball", [["core.start"]]],
    ["mid first innings", [["core.start"], summary(120, 3, 200, { partial: true })]],
    ["after three innings", [["core.start"], summary(300, 10, 400), summary(250, 10, 380), summary(100, 3, 150, { declared: true })]],
  ];

  it("CK-AB-3 draws at every stage of a two-innings match, and the draw pays the draw points to each side", () => {
    let checked = 0;
    for (const [name, specs] of states) {
      const state = fold(timeless, [...specs, abandon]);
      expect(state.outcome, name).toEqual({ kind: "draw" });
      expect(state.margin, name).toBeNull();
      const [home, away] = cricket.standingsDelta(state.outcome!, timeless, league, state);
      expect([home.drawn, away.drawn, home.points, away.points], name).toEqual([1, 1, 1, 1]);
      checked++;
    }
    expect(checked).toBe(states.length);
  });

  it("CK-AB-3 an abandoned one-innings match mid-chase is a no result (not a draw) when Duckworth/Lewis/Stern is off", () => {
    const state = fold(t20, [["core.start"], summary(150, 5, 120), summary(60, 2, 60, { partial: true }), abandon]);
    expect(state.outcome).toEqual({ kind: "no_result" });
    const [home, away] = cricket.standingsDelta(state.outcome!, t20, league, state);
    expect([home.points, away.points, home.drawn]).toEqual([1, 1, 0]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-RH-1 (M5) - retiring
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-RH-1 retiring: unavoidable-cause retirements are not out and may resume; any other is retired out, a wicket with no bowler credited", () => {
  const afterOneBall: Spec[] = [["core.start"], ball(0, "H-1", "H-2", "A-11", { runs: { bat: 2 } })];
  const retire = (reason: string, more: Record<string, unknown> = {}): Spec => ["cricket.retire", { person: "H-1", reason, ...more }];

  it("CK-RH-1 hurt and other leave the batter not out and available; out is a wicket with no bowler credit", () => {
    let checked = 0;
    for (const reason of ["hurt", "other"]) {
      const innings = fold(t20, [...afterOneBall, retire(reason, { incoming: "H-3" })]).innings[0]!;
      expect(innings.wickets, reason).toBe(0);
      expect(innings.fine?.dismissed, reason).toEqual([]);
      expect(innings.fine?.retiredNotOut, reason).toEqual(["H-1"]);
      expect(innings.fine?.striker, reason).toBe("H-3");
      checked++;
    }
    const out = fold(t20, [...afterOneBall, retire("out")]).innings[0]!;
    expect(out.wickets).toBe(1);
    expect(out.fine?.dismissed).toEqual(["H-1"]);
    expect(out.fine?.bowlerWickets).toEqual({});
    expect(out.fine?.retiredNotOut).toBeUndefined();
    expect(out.runs).toBe(2);
    checked++;
    expect(checked).toBe(3);
  });

  it("CK-RH-1 a batter retired not out may resume the innings, a batter retired out may not", () => {
    const resumed = fold(t20, [
      ...afterOneBall,
      retire("hurt", { incoming: "H-3" }),
      ball(1, "H-3", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-3", bowlerCredited: true, incoming: "H-1" } }),
    ]).innings[0]!.fine!;
    expect(resumed.striker).toBe("H-1");
    expect(resumed.retiredNotOut).toBeUndefined();
    // Retired out is a dismissal: bringing him back is the "already out" refusal.
    expect(
      codeOf(() =>
        fold(t20, [
          ...afterOneBall,
          retire("out"),
          ball(1, "H-3", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-3", bowlerCredited: true, incoming: "H-1" } }),
        ]),
      ),
    ).toBe("INVALID_EVENT");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-BO-1 (M7) - the bowler's over limit
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-BO-1 no bowler bowls more than maxOversPerBowler overs in an innings: 4 in the t20 preset, 10 in the odi preset", () => {
  it("CK-BO-1 the presets carry the rulebook's limit", () => {
    expect(t20.maxOversPerBowler).toBe(4);
    expect(odi.maxOversPerBowler).toBe(10);
  });

  it("CK-BO-1 a bowler's full quota is accepted and his next over is refused, on both presets", () => {
    let checked = 0;
    for (const [name, cfg, quota] of [["t20", t20, 4], ["odi", odi, 10]] as const) {
      // A-11 and A-10 share the bowling, alternating, each reaching exactly the quota.
      const plan = Array.from({ length: quota * 2 }, (_, k) => (k % 2 === 0 ? "A-11" : "A-10"));
      const full = [["core.start"] as Spec, ...dotOvers(plan)];
      expect(codeOf(() => fold(cfg, full)), `${name}: ${quota} overs each`).toBeNull();
      // His (quota + 1)th over is refused; a fresh bowler's first over is not.
      const nextOver = (bowler: string): Spec[] => dotOvers([...plan, bowler]).slice(plan.length * 6);
      expect(codeOf(() => fold(cfg, [...full, ...nextOver("A-11")])), `${name}: over ${quota + 1}`).toBe("INVALID_EVENT");
      expect(codeOf(() => fold(cfg, [...full, ...nextOver("A-9")])), `${name}: a fresh bowler`).toBeNull();
      checked += 3;
    }
    expect(checked).toBe(6);
  });

  it("CK-BO-1 a recorded ledger that exceeds a quota re-cut later still replays (the read path refuses nothing)", () => {
    const overQuota = [["core.start"] as Spec, ...dotOvers(["A-11", "A-10", "A-11", "A-10", "A-11", "A-10", "A-11", "A-10", "A-11"])];
    expect(codeOf(() => fold(t20, overQuota))).toBe("INVALID_EVENT");
    expect(codeOf(() => foldMatch(cricket, t20, lineups, stream(...overQuota)))).toBeNull();
  });

  it("CK-BO-1 the limit may not exceed the innings length", () => {
    // 120 balls is 20 overs: a 20-over limit is the whole innings and allowed, a 21-over limit is refused.
    expect(cricket.configSchema.safeParse({ ...cricket.variants.t20, maxOversPerBowler: 20 }).success).toBe(true);
    expect(cricket.configSchema.safeParse({ ...cricket.variants.t20, maxOversPerBowler: 21 }).success).toBe(false);
    // A timeless innings has no length to exceed.
    expect(cricket.configSchema.safeParse({ ...cricket.variants.test, maxOversPerBowler: 500 }).success).toBe(true);
  });
});

/** The Laws: the bowler is credited with bowled, caught, lbw, stumped and hit wicket - and with no other mode. */
const MODES: Record<string, boolean> = {
  bowled: true,
  caught: true,
  lbw: true,
  runout: false,
  stumped: true,
  hitwicket: true,
  retired: false,
  obstructed: false,
  timedout: false,
  hitballtwice: false,
};

// ---------------------------------------------------------------------------------------------------------------------
// CK-FH-1 (M8, free hit only) - a deviation row: ICC 21.18 lets hit-the-ball-twice stand on a free hit, and the engine refuses it.
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-FH-1 the delivery after a no ball is a free hit: the striker can be dismissed only by run out or obstructing the field", () => {
  const noBall: Spec = ball(0, "H-1", "H-2", "A-11", { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } });
  const freeHit = (wicket: Record<string, unknown>): Spec =>
    ball(0, "H-1", "H-2", "A-11", { wicket, freeHit: true });

  it("CK-FH-1 every mode but run out and obstructing the field is refused on the free hit, and each is recorded on a normal ball", () => {
    // The exemptions are the row's; the refused set is every OTHER mode the engine declares, so a mode added to (or renamed in)
    // the schema is swept without this test being edited.
    const stands: Array<[string, string]> = [["runout", "H-2"], ["obstructed", "H-1"]];
    const exempt = new Set(stands.map(([kind]) => kind));
    const options: readonly string[] = CricketWicket.shape.kind.options;
    for (const kind of exempt) expect(options, `${kind} is a declared mode`).toContain(kind);
    let refused = 0;
    for (const kind of options.filter((k) => !exempt.has(k))) {
      const credited = MODES[kind] as boolean;
      expect(codeOf(() => fold(t20, [["core.start"], noBall, freeHit({ kind, out: "H-1", bowlerCredited: credited })])), `${kind} on a free hit`).toBe("INVALID_EVENT");
      // The pair: the same wicket on an ordinary delivery is recorded, so the refusal is the free hit's.
      const plain = fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-11", { wicket: { kind, out: "H-1", bowlerCredited: credited } })]);
      expect(plain.innings[0]!.wickets, `${kind} on a normal ball`).toBe(1);
      refused++;
    }
    expect(refused).toBe(options.length - exempt.size);
    expect(refused).toBeGreaterThan(0);
    let stood = 0;
    for (const [kind, out] of stands) {
      const state = fold(t20, [["core.start"], noBall, freeHit({ kind, out, bowlerCredited: false })]);
      expect(state.innings[0]!.wickets, kind).toBe(1);
      stood++;
    }
    expect(stood).toBe(2);
  });

  it("CK-FH-1 the deviation: hit the ball twice, which ICC 21.18 lets stand on a free hit, is refused, so it cannot be recorded", () => {
    // Pinned as what the engine does, not what the rulebook says: if the engine ever records it this goes red and the row is
    // reworded (the deviation retired) rather than the test quietly loosened.
    const hitTwice = { kind: "hitballtwice", out: "H-1", bowlerCredited: false };
    expect(codeOf(() => fold(t20, [["core.start"], noBall, freeHit(hitTwice)]))).toBe("INVALID_EVENT");
    // The same dismissal on a normal delivery is recorded, so the refusal belongs to the free hit and not to the mode.
    expect(fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-11", { wicket: hitTwice })]).innings[0]!.wickets).toBe(1);
  });

  it("CK-FH-1 the free hit is used up by the next legal delivery, after which a bowled wicket stands again", () => {
    const state = fold(t20, [
      ["core.start"],
      noBall,
      ball(0, "H-1", "H-2", "A-11", { freeHit: true }),
      ball(1, "H-1", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } }),
    ]);
    expect(state.innings[0]!.wickets).toBe(1);
  });

  it("CK-FH-1 a wide on the free hit does not use it up: the next ball is still a free hit, a run out stands and a bowled is refused", () => {
    const wide: Spec = ball(0, "H-1", "H-2", "A-11", { runs: { bat: 0, extras: { kind: "wide", runs: 1 } }, freeHit: true });
    // Still pending: a FLAGGED free-hit run out folds (a consumed free hit would refuse the flag: "no free hit is pending")...
    const stillPending = fold(t20, [["core.start"], noBall, wide, freeHit({ kind: "runout", out: "H-2", bowlerCredited: false })]);
    expect(stillPending.innings[0]!.wickets).toBe(1);
    // ...and an UNFLAGGED bowled is refused by the free-hit rule itself (a consumed free hit would let it stand).
    const bowled = ball(0, "H-1", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } });
    expect(codeOf(() => fold(t20, [["core.start"], noBall, wide, bowled]))).toBe("INVALID_EVENT");
    // The pair: the first legal ball after the wide uses the free hit up, so then the same bowled stands.
    const used = fold(t20, [
      ["core.start"],
      noBall,
      wide,
      ball(0, "H-1", "H-2", "A-11", { freeHit: true }),
      ball(1, "H-1", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } }),
    ]);
    expect(used.innings[0]!.wickets).toBe(1);
  });

  it("CK-FH-1 a free-hit flag with no no ball before it is refused", () => {
    expect(codeOf(() => fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-11", { freeHit: true })]))).toBe("INVALID_EVENT");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-WK-1 (M9) - the ten modes of dismissal
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-WK-1 a wicket is one of ten modes; the event says whether the bowler is credited and the fielder is credited with the dismissal", () => {
  it("CK-WK-1 the engine knows exactly these ten modes", () => {
    expect([...CricketWicket.shape.kind.options].sort()).toEqual(Object.keys(MODES).sort());
    expect(Object.keys(MODES)).toHaveLength(10);
  });

  it("CK-WK-1 each mode takes a wicket, credits the bowler only where the Laws do, and refuses the opposite credit flag", () => {
    let checked = 0;
    for (const [kind, credited] of Object.entries(MODES)) {
      const wicket = (bowlerCredited: boolean) => ball(0, "H-1", "H-2", "A-11", { wicket: { kind, out: "H-1", bowlerCredited } });
      const innings = fold(t20, [["core.start"], wicket(credited)]).innings[0]!;
      expect(innings.wickets, kind).toBe(1);
      expect(innings.fine?.dismissed, kind).toEqual(["H-1"]);
      expect(innings.fine?.bowlerWickets["A-11"] ?? 0, kind).toBe(credited ? 1 : 0);
      expect(codeOf(() => fold(t20, [["core.start"], wicket(!credited)])), `${kind}: flipped flag`).toBe("INVALID_EVENT");
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("CK-WK-1 the fielder who took the catch, broke the wicket or stumped is credited with the dismissal", () => {
    const credit = (wicket: Record<string, unknown>) =>
      fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-11", { wicket })]).innings[0]!.fine?.fielding;
    expect(credit({ kind: "caught", out: "H-1", bowlerCredited: true, fielder: "A-5" })).toEqual({ "A-5": { catches: 1, runOuts: 0, stumpings: 0 } });
    expect(credit({ kind: "stumped", out: "H-1", bowlerCredited: true, fielder: "A-2" })).toEqual({ "A-2": { catches: 0, runOuts: 0, stumpings: 1 } });
    expect(credit({ kind: "runout", out: "H-2", bowlerCredited: false, fielder: "A-6" })).toEqual({ "A-6": { catches: 0, runOuts: 1, stumpings: 0 } });
    // A fielder who is not in the fielding side is refused, whatever the mode.
    expect(codeOf(() => credit({ kind: "caught", out: "H-1", bowlerCredited: true, fielder: "H-5" }))).toBe("INVALID_EVENT");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-CR-1 (M10) - concussion replacements
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-CR-1 concussion replacement: up to lineupChanges.concussionReplacements per side (1 in t20), who may bat, bowl and be credited as a fielder; an ordinary substitute is not offered and a bench name may do none of them", () => {
  const replace = (side: "H" | "A", off: string, on: string, orderNo: number): Spec => [
    "core.lineup.replacement",
    { side, off, on: { personId: on, slot: "bench", orderNo }, exemption: "concussion" },
  ];

  it("CK-CR-1 the t20 preset allows one replacement a side: the first is accepted, the second refused", () => {
    expect(lineupRefusal(() => fold(t20, [["core.start"], replace("H", "H-3", "H-12", 3)]))).toBeNull();
    expect(lineupRefusal(() => fold(t20, [["core.start"], replace("H", "H-3", "H-12", 3), replace("H", "H-4", "H-13", 4)]))).toBe("exemption-cap-reached");
    // The allowance is per side: the other side has its own.
    expect(
      lineupRefusal(() => fold(t20, [["core.start"], replace("H", "H-3", "H-12", 3), replace("A", "A-3", "A-12", 3)])),
    ).toBeNull();
  });

  it("CK-CR-1 a replacement may bat and bowl: named as the incoming batter, and as the bowler", () => {
    const batting = fold(t20, [
      ["core.start"],
      replace("H", "H-3", "H-12", 3),
      ball(0, "H-1", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-1", bowlerCredited: true, incoming: "H-12" } }),
    ]);
    expect(batting.innings[0]!.fine?.striker).toBe("H-12");
    // Bowling: the fielding side's concussed A-11 is replaced by A-12, who bowls.
    const bowling = fold(t20, [["core.start"], replace("A", "A-11", "A-12", 11), ball(0, "H-1", "H-2", "A-12")]);
    expect(bowling.innings[0]!.fine?.currentBowler).toBe("A-12");
    // Without the replacement event the same name is not in the fielding side.
    expect(codeOf(() => fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-12")]))).toBe("INVALID_EVENT");
  });

  it("CK-CR-1 an ordinary substitute (a bench name, no replacement) may not bat or bowl, and a substitution is not offered", () => {
    expect(codeOf(() => fold(t20, [["core.start"], ball(0, "H-1", "H-2", "A-b1")], benched))).toBe("INVALID_EVENT");
    expect(
      codeOf(() =>
        fold(
          t20,
          [["core.start"], ball(0, "H-1", "H-2", "A-11", { wicket: { kind: "bowled", out: "H-1", bowlerCredited: true, incoming: "H-b1" } })],
          benched,
        ),
      ),
    ).toBe("INVALID_EVENT");
    expect(
      lineupRefusal(() =>
        fold(t20, [["core.start"], ["core.lineup.substitution", { side: "H", off: "H-3", on: { personId: "H-b1", slot: "bench", orderNo: 12 } }]], benched),
      ),
    ).toBe("sub-cap-reached");
  });

  it("CK-CR-1 a replacement is credited as a fielder and a bench name that is not a replacement is refused as one", () => {
    const caught = (fielder: string): Spec =>
      ball(0, "H-1", "H-2", "A-11", { wicket: { kind: "caught", out: "H-1", bowlerCredited: true, fielder } });
    const credit = (specs: Spec[], pair: LineupPair = lineups) => fold(t20, specs, pair).innings[0]!.fine?.fielding;
    // The replacement A-12 (for the concussed A-3) takes the catch...
    expect(credit([["core.start"], replace("A", "A-3", "A-12", 3), caught("A-12")])).toEqual({ "A-12": { catches: 1, runOuts: 0, stumpings: 0 } });
    // ...and without the replacement event the same name is not in the fielding side, nor is a bench name on a sheet that has one.
    expect(codeOf(() => credit([["core.start"], caught("A-12")]))).toBe("INVALID_EVENT");
    expect(codeOf(() => credit([["core.start"], caught("A-b1")], benched))).toBe("INVALID_EVENT");
    // The pair: a named starter on the same sheet is credited.
    expect(credit([["core.start"], caught("A-5")], benched)).toEqual({ "A-5": { catches: 1, runOuts: 0, stumpings: 0 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-RO-1 (M6, M8 powerplay, new ball and toss) - record-only
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-RO-1 reviews (with no allowance set), powerplay blocks, new-ball records and the toss are recorded and move no score", () => {
  // One over a side: H score 1, A score 0, so H win by one run.
  const oneOver = parse({ ballsPerInnings: 6, minOversForResult: 1 });
  // After the first ball (one run) the batters have crossed, so H-2 faces the rest of the over.
  const homeInnings = (extra: Spec[]): Spec[] => [
    ball(0, "H-1", "H-2", "A-11", { runs: { bat: 1 } }),
    ...extra,
    ...[1, 2, 3, 4, 5].map((n) => ball(n, "H-2", "H-1", "A-11")),
  ];
  const awayInnings: Spec[] = [0, 1, 2, 3, 4, 5].map((n) => ball(n, "A-1", "A-2", "H-11"));
  const records: Spec[] = [
    ["cricket.review", { by: "H", kind: "player", outcome: "struck_down" }],
    ["cricket.review", { by: "A", kind: "umpire", outcome: "upheld" }],
    ["cricket.powerplay", { kind: "mandatory", phase: "start" }],
    ["cricket.powerplay", { kind: "mandatory", phase: "end" }],
    ["cricket.newball", {}],
  ];

  it("CK-RO-1 the same match with and without the records has the same innings, outcome, margin and summary", () => {
    const plain = fold(oneOver, [["core.start"], ...homeInnings([]), ...awayInnings]);
    const recorded = fold(oneOver, [["core.start"], ...homeInnings(records), ...awayInnings]);
    // Preconditions: a real result, a real difference between the two streams.
    expect(plain.outcome).toMatchObject({ kind: "win", winner: "H" });
    expect(plain.margin).toEqual({ kind: "runs", value: 1 });
    expect(recorded.innings[0]!.reviews).toBeDefined();
    expect(recorded.innings[0]!.powerplays).toHaveLength(1);
    expect(recorded.innings[0]!.newBallAt).toEqual([1]);
    // The records are in the state; nothing the score depends on moved.
    expect(recorded.outcome).toEqual(plain.outcome);
    expect(recorded.margin).toEqual(plain.margin);
    expect(recorded.innings.map((i) => [i.battingSide, i.runs, i.wickets, i.legalBalls])).toEqual(
      plain.innings.map((i) => [i.battingSide, i.runs, i.wickets, i.legalBalls]),
    );
    expect(cricket.summary(recorded).perSide).toEqual(cricket.summary(plain).perSide);
    expect(cricket.summary(recorded).headline).toBe(cricket.summary(plain).headline);
  });

  it("CK-RO-1 the toss is recorded and decides only who bats first: no runs, no outcome", () => {
    const home = fold(t20, [["cricket.toss", { wonBy: "H", elected: "bat" }], ["core.start"]]);
    const away = fold(t20, [["cricket.toss", { wonBy: "H", elected: "bowl" }], ["core.start"]]);
    expect(home.tossTaken).toBe(true);
    expect([home.battingFirst, away.battingFirst]).toEqual(["home", "away"]);
    for (const state of [home, away]) {
      expect(state.innings).toHaveLength(0);
      expect(state.outcome).toBeNull();
    }
    // A toss in an otherwise identical match changes nothing the score reads.
    const withToss = fold(oneOver, [["cricket.toss", { wonBy: "H", elected: "bat" }], ["core.start"], ...homeInnings([]), ...awayInnings]);
    const without = fold(oneOver, [["core.start"], ...homeInnings([]), ...awayInnings]);
    expect(withToss.outcome).toEqual(without.outcome);
    expect(withToss.margin).toEqual(without.margin);
    expect(withToss.innings.map((i) => i.runs)).toEqual(without.innings.map((i) => i.runs));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-DR-1 (M6, split from CK-RO-1) - the player-review allowance is a refusal, not a record
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-DR-1 a player review is refused once the innings' allowance is spent; upheld and umpire's-call reviews and umpire reviews do not spend it", () => {
  // ICC T20 WC PC Appendix D 3.6.1 (two unsuccessful player reviews a side an innings), 3.6.2 (a successful one is not counted)
  // and 3.6.4 (nor is an Umpire's Call). No shipped preset configures an allowance, so the cfg here says two.
  const allowance = 2;
  const withAllowance = parse({ ...cricket.variants.t20, reviews: { perInnings: allowance } });
  const open: Spec[] = [["core.start"], ball(0, "H-1", "H-2", "A-11")];
  const review = (by: string, kind: string, outcome: string): Spec => ["cricket.review", { by, kind, outcome }];
  const lost = (by: string): Spec => review(by, "player", "struck_down");

  it("CK-DR-1 two struck-down player reviews spend a side's allowance and the third is refused, the other side keeping its own", () => {
    expect(codeOf(() => fold(withAllowance, [...open, lost("H"), lost("H")]))).toBeNull();
    expect(codeOf(() => fold(withAllowance, [...open, lost("H"), lost("H"), lost("H")]))).toBe("INVALID_EVENT");
    // The allowance is per side: A has its own two after H spent H's.
    expect(codeOf(() => fold(withAllowance, [...open, lost("H"), lost("H"), lost("A"), lost("A")]))).toBeNull();
  });

  it("CK-DR-1 a player review with none left is refused whatever its outcome, while an umpire review is still recorded", () => {
    const spent = [...open, lost("H"), lost("H")];
    let checked = 0;
    for (const outcome of ["upheld", "struck_down", "umpires_call"]) {
      expect(codeOf(() => fold(withAllowance, [...spent, review("H", "player", outcome)])), `player ${outcome}`).toBe("INVALID_EVENT");
      checked++;
    }
    expect(codeOf(() => fold(withAllowance, [...spent, review("H", "umpire", "struck_down")]))).toBeNull();
    expect(checked).toBe(3);
  });

  it("CK-DR-1 upheld, umpire's-call and umpire reviews do not spend the allowance: after nine of them two losses still stand", () => {
    const free: Spec[] = [
      ...[1, 2, 3].map(() => review("H", "player", "upheld")),
      ...[1, 2, 3].map(() => review("H", "player", "umpires_call")),
      ...[1, 2, 3].map(() => review("H", "umpire", "struck_down")),
    ];
    expect(free).toHaveLength(9);
    const state = fold(withAllowance, [...open, ...free, lost("H"), lost("H")]);
    expect(state.innings[0]!.reviews?.home).toEqual({ taken: 11, lost: 2 });
    // ...and only then is a third loss refused.
    expect(codeOf(() => fold(withAllowance, [...open, ...free, lost("H"), lost("H"), lost("H")]))).toBe("INVALID_EVENT");
  });

  it("CK-DR-1 voiding a spent review gives the allowance back (after a void)", () => {
    // Events: 0 start, 1 ball, 2 first loss, 3 second loss, 4 void of 3, 5 another loss.
    const voided = fold(withAllowance, [...open, lost("H"), lost("H"), ["core.void", {}, "e-3"], lost("H")]);
    expect(voided.innings[0]!.reviews?.home).toEqual({ taken: 2, lost: 2 });
    expect(codeOf(() => fold(withAllowance, [...open, lost("H"), lost("H"), ["core.void", {}, "e-3"], lost("H"), lost("H")]))).toBe("INVALID_EVENT");
  });

  it("CK-DR-1 the allowance is per innings: a side that spent it in the first innings has it again in the second", () => {
    const oneOver = parse({ ballsPerInnings: 6, minOversForResult: 1, reviews: { perInnings: 1 } });
    const firstBall = ball(0, "H-1", "H-2", "A-11", { runs: { bat: 1 } });
    // Within the first innings the second loss is refused (the guard is live in this cfg).
    expect(codeOf(() => fold(oneOver, [["core.start"], firstBall, lost("H"), lost("H")]))).toBe("INVALID_EVENT");
    const firstInnings: Spec[] = [firstBall, lost("H"), ...[1, 2, 3, 4, 5].map((n) => ball(n, "H-2", "H-1", "A-11"))];
    const second = fold(oneOver, [["core.start"], ...firstInnings, ball(0, "A-1", "A-2", "H-11"), lost("H")]);
    expect(second.innings[1]!.reviews?.home).toEqual({ taken: 1, lost: 1 });
  });

  it("CK-DR-1 with no allowance configured reviews are recorded uncapped (the contrast), and no shipped preset sets one", () => {
    const many: Spec[] = Array.from({ length: 5 }, () => lost("H"));
    expect(fold(t20, [...open, ...many]).innings[0]!.reviews?.home).toEqual({ taken: 5, lost: 5 });
    const presets = Object.entries(cricket.variants).map(([name, raw]) => [name, parse(raw).reviews] as const);
    expect(presets).toHaveLength(4);
    for (const [name, reviews] of presets) expect(reviews, name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-DV-1 - the Hundred (deviation, pending an owner question)
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-DV-1 The Hundred ships as a preset and the net-run-rate display follows its five-ball over (the ten-ball bowling changes stay unmodelled, SC-C7)", () => {
  it("CK-DV-1 the hundred preset is a 100-ball innings of five-ball sets with four sets a bowler", () => {
    const hundred = parse(cricket.variants.hundred);
    expect([hundred.ballsPerInnings, hundred.ballsPerOver, hundred.maxOversPerBowler]).toEqual([100, 5, 4]);
  });

  it("CK-DV-1 the table prints net run rate per the variant's over: +1.000 on the hundred's five-ball sets, +1.200 on the six-ball default", () => {
    // 100 runs off 100 balls for and 80 off 100 against. Per five-ball set (20 sets each): 100/20 - 80/20 = +1.000. The six-ball
    // default (T20, ODI, and a stage that names no over length) gives 6 - 4.8 = +1.200: the pair that tells the two scales apart.
    const row: StandingsRow = {
      entrantId: "H",
      played: 1,
      won: 1,
      drawn: 0,
      lost: 0,
      points: 2,
      metrics: { runs_for: 100, balls_faced_eff: 100, runs_against: 80, balls_bowled_eff: 100 },
    };
    const hundred = parse(cricket.variants.hundred);
    expect(hundred.ballsPerOver).toBe(5);
    expect(derivedMetricText(row, "nrr", hundred.ballsPerOver)).toBe("+1.000");
    expect(derivedMetricText(row, "nrr")).toBe("+1.200");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-DV-2, CK-DV-3 - dispositions
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-DV-2 a super over cannot be entered as a coarse total: it is scored ball by ball", () => {
  const knockout = parse({ ...cricket.variants.t20, superOver: true });
  const tiedMain: Spec[] = [["core.start"], summary(150, 5, 120), summary(150, 8, 120)];

  it("CK-DV-2 the only super-over event is the ball", () => {
    const types = Object.keys(CRICKET_EVENT_SCHEMAS).filter((type) => type.includes("superover"));
    expect(types).toEqual(["cricket.superover.ball"]);
  });

  it("CK-DV-2 an innings total is refused in the super over, and a ball is accepted (the positive pair)", () => {
    expect(fold(knockout, tiedMain).phase).toBe("super_over");
    expect(codeOf(() => fold(knockout, [...tiedMain, summary(10, 0, 6)]))).toBe("WRONG_PHASE");
    expect(codeOf(() => fold(knockout, [...tiedMain, superBall(ball(0, "A-1", "A-2", "H-11"))]))).toBeNull();
  });
});

describe("CK-DV-3 a player who leaves for good does not lower the all-out count: the innings still ends at the configured number of wickets", () => {
  /** Nine wickets then the tenth, each a bowled dismissal of the striker; `incoming` follows the lineup order. */
  const wicketsFor = (count: number): Spec[] => {
    const specs: Spec[] = [];
    let striker = "H-1";
    let nonStriker = "H-2";
    let next = 3;
    for (let k = 0; k < count; k++) {
      specs.push(ball(k, striker, nonStriker, k % 12 < 6 ? "A-11" : "A-10", { wicket: { kind: "bowled", out: striker, bowlerCredited: true } }));
      striker = `H-${next++}`;
      if ((k + 1) % 6 === 0) [striker, nonStriker] = [nonStriker, striker];
    }
    return specs;
  };

  it("CK-DV-3 with the unbeaten partner retired from the squad, nine wickets leave the innings open and the tenth closes it", () => {
    // In wicketsFor the ten dismissed are H-1 to H-7 and H-9 to H-11; H-8 walks in at the sixth wicket and is the unbeaten
    // partner to the end. He leaves the squad for good once at the crease (after the sixth wicket), so the ten that fall are
    // every player who is left, and 10 wickets is the whole of them: the count has to stay at players - 1 for that to close.
    const retired: Spec = ["core.lineup.retirement", { side: "H", personId: "H-8" }];
    const withRetirement = (count: number): Spec[] => {
      const wickets = wicketsFor(count);
      return [["core.start"], ...wickets.slice(0, 6), retired, ...wickets.slice(6)];
    };
    const nine = fold(t20, withRetirement(9)).innings[0]!;
    expect(nine.wickets).toBe(9);
    expect(nine.closed).toBe(false);
    const ten = fold(t20, withRetirement(10)).innings[0]!;
    expect(ten.wickets).toBe(10);
    expect(ten.closed).toBe(true);
    expect(ten.fine?.dismissed).not.toContain("H-8");
  });

  it("CK-DV-3 a team sheet that NAMES ten players is the other case: all out at nine (the contrast the retirement differs from)", () => {
    const short: LineupPair = { home: { ...lineup("H"), slots: lineup("H").slots.slice(0, 10) }, away: lineups.away };
    const nine = foldMatch(cricket, t20, short, stream(["core.start"], ...wicketsFor(9)), STRICT_ALL).innings[0]!;
    expect(nine.wickets).toBe(9);
    expect(nine.closed).toBe(true);
  });
});
