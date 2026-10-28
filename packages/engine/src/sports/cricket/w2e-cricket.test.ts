// W2e Task 6 (A1c-1, SC-C4 / RB2A-22) — CK-CH-1: a coarse chase total may not pass the winning run.
//
// The bound is the rulebook's, never the engine's. ICC Men's T20 World Cup 2026 Playing Conditions 16.5.1/16.5.3 (MCC Law
// 16.5) end a chase AT the winning run and count a boundary in full, so from one run short the most a single delivery can
// add is a no-ball (1) hit for six (6): the final chase total is at most target − 1 + 7 (rulebook RBS:433, RB2A-22).
// The target is the Laws' too: one run more than the other side's total, or in a two-innings match one more than its
// aggregate lead; a DLS target is the engine's own Standard Edition declaration (`state.revisedTarget`, not under test).
//
// single-sport: a chase and its target exist only in cricket's innings model; no other sport records a coarse total to bound.
//
// W2e Task 8 (A1c-3, SC-C5 / RB2A-20, D18) — CK-RR-1: net run rate for a DLS or revised-overs match follows ICC 16.10.7,
// for every cricket match (the last describe below).
import { describe, expect, it } from "vitest";
import { derivedMetricText } from "../../competition/display.ts";
import { foldResults } from "../../competition/standings.ts";
import { rankStandings } from "../../competition/tiebreakers.ts";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StandingsDelta } from "../../core/types.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { buildWalk, defaultLineupPair, lineupFromCatalog, makeEnvelope } from "../../testkit/helpers.ts";
import { cricket, CricketWicket, type CricketCfg, type CricketState } from "./cricket.ts";
import { dlsPar, dlsTarget } from "./dls.ts";

/** RBS:433 — a no-ball (1) plus a six (6) off the last needed run. */
const LAST_BALL_MAX = 1 + 6;
const boundOf = (target: number): number => target - 1 + LAST_BALL_MAX;

/** Every write below is PAD-SHAPED: the whole stream is new (`strictFromSeq: 0`), the write path. */
const STRICT_ALL = { strictFromSeq: 0 } as const;

const parse = (raw: unknown): CricketCfg => cricket.configSchema.parse(raw);
const lineupsFor = (cfg: CricketCfg): LineupPair => defaultLineupPair(resolvePositions(cricket, cfg));

type Spec = [type: string, payload?: unknown, voids?: string];
const ledger = (specs: readonly Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
}

const summary = (runs: number, wickets: number, legalBalls: number, partial = false): Spec => [
  "cricket.innings.summary",
  { runs, wickets, legalBalls, ...(partial ? { partial: true } : {}) },
];

const ONE_INNINGS = parse({});
const TWO_INNINGS = parse(cricket.variants.test);
const DLS = parse({ dls: { enabled: true, edition: "standard" } });

describe("CK-CH-1 chase overshoot (RB2A-22, SC-C4)", () => {
  it("CK-CH-1 a coarse chase total of target−1+8 is refused CHASE_OVERSHOOT; target−1+7 is accepted", () => {
    // Each case: the ledger before the chase, and the target the Laws give it. A first innings of 0 is the empty case
    // (target 1); 18 and 100 are the brief's; the fourth innings of a two-innings match is the other chase index.
    const cases: { name: string; cfg: CricketCfg; before: Spec[]; target: number }[] = [
      { name: "target 1", cfg: ONE_INNINGS, before: [["core.start"], summary(0, 10, 30)], target: 0 + 1 },
      { name: "target 18", cfg: ONE_INNINGS, before: [["core.start"], summary(17, 10, 60)], target: 17 + 1 },
      { name: "target 100", cfg: ONE_INNINGS, before: [["core.start"], summary(99, 10, 90)], target: 99 + 1 },
      {
        // H 200 and 100, A 150: A needs its aggregate to pass H's, 300 − 150 + 1.
        name: "fourth innings, target 151",
        cfg: TWO_INNINGS,
        before: [["core.start"], summary(200, 10, 400), summary(150, 10, 300), summary(100, 10, 200)],
        target: 200 + 100 - 150 + 1,
      },
    ];
    let checked = 0;
    for (const { name, cfg, before, target } of cases) {
      const lineups = lineupsFor(cfg);
      const fold = (specs: readonly Spec[]) => foldMatch(cricket, cfg, lineups, ledger(specs), STRICT_ALL);
      const bound = boundOf(target);
      // One summary closing the chase, and the same chase entered progressively (a partial total first, then the final one).
      const opening: Spec[] = [summary(Math.max(0, target - 2), 1, 12, true)];
      for (const lead of [[], opening]) {
        const atBound = fold([...before, ...lead, summary(bound, 2, 30)]);
        const chase = atBound.innings.at(-1);
        expect(chase?.runs, `${name}: the chase holds the total`).toBe(bound);
        expect(cricket.outcome(atBound)?.kind, `${name}: the winning run ends the match`).toBe("win");
        expect(codeOf(() => fold([...before, ...lead, summary(bound + 1, 2, 30)])), `${name}${lead.length ? " (progressive)" : ""}`).toBe(
          "CHASE_OVERSHOOT",
        );
        checked++;
      }
    }
    expect(checked).toBe(8);
    // What the scorer is shown: the sentence, and the target with the largest total it allows (Laws above: 17 + 1, 18 − 1 + 7).
    let refusal: unknown = null;
    try {
      foldMatch(cricket, ONE_INNINGS, lineupsFor(ONE_INNINGS), ledger([["core.start"], summary(17, 10, 60), summary(25, 2, 30)]), STRICT_ALL);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(EngineError);
    expect(refusal).toMatchObject({
      code: "CHASE_OVERSHOOT",
      message: "a chase ends at the winning run — check the total",
      data: { runs: 25, target: 18, max: 24 },
    });
  });

  it("CK-CH-1 a DLS revisedTarget bounds the chase, not the first innings + 1", () => {
    // 180 off 20 overs, then the chase is cut to 10 overs between the innings: the Standard Edition revises the target
    // down. The case one run past the REVISED bound sits inside the un-revised one, so a check against `first + 1` passes it.
    const before: Spec[] = [["core.start"], summary(180, 5, 120), ["cricket.revise", { oversPerSide: 10 }]];
    const lineups = lineupsFor(DLS);
    const fold = (specs: readonly Spec[]) => foldMatch(cricket, DLS, lineups, ledger(specs), STRICT_ALL);
    const revised = fold(before).revisedTarget;
    expect(revised, "the revise produced a DLS target").not.toBeNull();
    const target = revised as number;
    expect(target, "the DLS target is below the un-revised target").toBeLessThan(180 + 1);
    expect(boundOf(target) + 1, "premise: the refused total is inside the un-revised bound").toBeLessThanOrEqual(boundOf(180 + 1));
    expect(fold([...before, summary(boundOf(target), 2, 30)]).innings[1]?.runs).toBe(boundOf(target));
    expect(codeOf(() => fold([...before, summary(boundOf(target) + 1, 2, 30)]))).toBe("CHASE_OVERSHOOT");
  });

  it("CK-CH-1 first innings totals are unbounded", () => {
    const one = lineupsFor(ONE_INNINGS);
    // No target exists yet: a first innings of any size is a fact the scorer reports, entered at once or progressively.
    const once = foldMatch(cricket, ONE_INNINGS, one, ledger([["core.start"], summary(999, 3, 120)]), STRICT_ALL);
    expect(once.innings[0]?.runs).toBe(999);
    const grown = foldMatch(
      cricket,
      ONE_INNINGS,
      one,
      ledger([["core.start"], summary(500, 2, 60, true), summary(999, 3, 120)]),
      STRICT_ALL,
    );
    expect(grown.innings[0]?.runs).toBe(999);
    // Two innings: the first three innings are not a chase, so a third innings far past any target the first two set is
    // accepted; only the fourth is bounded (target 900 + 900 − 50 + 1).
    const two = lineupsFor(TWO_INNINGS);
    const before: Spec[] = [["core.start"], summary(900, 10, 900), summary(50, 10, 100), summary(900, 4, 900, true), summary(900, 10, 900)];
    const third = foldMatch(cricket, TWO_INNINGS, two, ledger(before), STRICT_ALL);
    expect(third.innings.map((innings) => innings.runs)).toEqual([900, 50, 900]);
    const target = 900 + 900 - 50 + 1;
    expect(codeOf(() => foldMatch(cricket, TWO_INNINGS, two, ledger([...before, summary(boundOf(target) + 1, 2, 300)]), STRICT_ALL))).toBe(
      "CHASE_OVERSHOOT",
    );
  });

  // Golden stream 29 (`default#102`) as recorded at W2e BASE efa867c0d3: a first innings of 17 closed for weather, then a
  // coarse chase of 30 against a target of 18 (bound 24). Its recorded result is what the read path must keep folding.
  const STREAM_29: Spec[] = [
    ["core.start", {}],
    ["cricket.ball", { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", runs: { bat: 2 } }],
    ["cricket.ball", { over: 0, ballInOver: 2, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", runs: { bat: 1 } }],
    ["cricket.ball", { over: 0, ballInOver: 3, striker: "H-p2", nonStriker: "H-p1", bowler: "A-p11", runs: { bat: 3 } }],
    ["cricket.ball", { over: 0, ballInOver: 4, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", runs: { bat: 2 } }],
    ["cricket.ball", { over: 0, ballInOver: 5, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11", runs: { bat: 1 } }],
    ["cricket.ball", { over: 0, ballInOver: 6, striker: "H-p2", nonStriker: "H-p1", bowler: "A-p11", runs: { bat: 1 } }],
    ["cricket.ball", { over: 1, ballInOver: 1, striker: "H-p2", nonStriker: "H-p1", bowler: "A-p5", runs: { bat: 3 } }],
    ["cricket.ball", { over: 1, ballInOver: 2, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p5", runs: { bat: 4 }, boundary: 4 }],
    ["cricket.ball", { over: 1, ballInOver: 3, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p5", runs: { bat: 0 } }],
    ["cricket.innings.close", { reason: "weather" }],
    ["cricket.player.line", { innings: 1, person: "A-p11", bowling: { legalBalls: 6, runs: 10, wickets: 0, wides: 2, noBalls: 1 } }],
    ["cricket.player.line", { innings: 1, person: "A-p5", bowling: { legalBalls: 3, runs: 7, wickets: 0, wides: 4, noBalls: 2 } }],
    ["cricket.innings.summary", { runs: 30, wickets: 4, legalBalls: 60, boundaries: 3, partial: true }],
  ];

  it("CK-CH-1 replay folds golden stream 29's pre-W2e overshoot leniently", () => {
    const lineups = lineupsFor(ONE_INNINGS);
    const overshoot = STREAM_29.length - 1;
    // The read path (no options): the recorded result, as the corpus held it.
    const read = foldMatch(cricket, ONE_INNINGS, lineups, ledger(STREAM_29));
    expect(read.innings.map((innings) => innings.runs)).toEqual([17, 30]);
    expect(cricket.outcome(read)).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(read.margin).toEqual({ kind: "wickets", value: 6 });
    // The same summary as a NEW write is refused: the boundary between replay and write is the event's seq.
    expect(codeOf(() => foldMatch(cricket, ONE_INNINGS, lineups, ledger(STREAM_29), { strictFromSeq: overshoot }))).toBe("CHASE_OVERSHOOT");
    expect(codeOf(() => foldMatch(cricket, ONE_INNINGS, lineups, ledger(STREAM_29), { strictFromSeq: overshoot + 1 }))).toBeNull();
    // After a void of the recorded overshoot (a later write), the chase reopens and is bounded like any other.
    const voided: Spec[] = [...STREAM_29, ["core.void", {}, `e-${overshoot}`]];
    const reopened = foldMatch(cricket, ONE_INNINGS, lineups, ledger(voided), { strictFromSeq: overshoot + 1 });
    expect(reopened.innings.map((innings) => innings.runs)).toEqual([17]);
    expect(cricket.outcome(reopened)).toBeNull();
    const strictTail = { strictFromSeq: overshoot + 2 };
    expect(foldMatch(cricket, ONE_INNINGS, lineups, ledger([...voided, summary(boundOf(18), 4, 60)]), strictTail).innings[1]?.runs).toBe(
      boundOf(18),
    );
    expect(codeOf(() => foldMatch(cricket, ONE_INNINGS, lineups, ledger([...voided, summary(boundOf(18) + 1, 4, 60)]), strictTail))).toBe(
      "CHASE_OVERSHOOT",
    );
  });

  it("CK-CH-1 replay folds golden stream 24's pre-W2e fourth-innings overshoot leniently", () => {
    // Golden stream 24 (`test#40`) at BASE efa867c0d3: H 141 & 65, A 86/5d & 188/6d, a fourth-innings chase of 188 against
    // a target of 141 + 65 − 86 + 1 = 121 (bound 127). Its four totals as summaries; the result is the one it recorded.
    const declared = (runs: number, wickets: number, legalBalls: number): Spec => [
      "cricket.innings.summary",
      { runs, wickets, legalBalls, declared: true },
    ];
    const test40: Spec[] = [["core.start"], summary(141, 3, 364), declared(86, 5, 53), summary(65, 3, 428), declared(188, 6, 135)];
    const lineups = lineupsFor(TWO_INNINGS);
    const read = foldMatch(cricket, TWO_INNINGS, lineups, ledger(test40));
    expect(read.innings.map((innings) => innings.runs)).toEqual([141, 86, 65, 188]);
    expect(cricket.outcome(read)).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(read.margin).toEqual({ kind: "wickets", value: 4 });
    expect(codeOf(() => foldMatch(cricket, TWO_INNINGS, lineups, ledger(test40), { strictFromSeq: test40.length - 1 }))).toBe(
      "CHASE_OVERSHOOT",
    );
  });

  it("CK-CH-1 the generator's coarse chase never exceeds the bound (500 seeds, count asserted)", () => {
    const SEEDS = 500;
    // Every cfg cricket declares, plus DLS on (the only way a coarse chase carries a revised target in a walk).
    const cfgs = [...declaredCfgs(cricket), { name: "dls", cfg: DLS }];
    let walks = 0;
    let checked = 0;
    let reachedTarget = 0;
    let dlsTargets = 0;
    const over: string[] = [];
    for (const { name, cfg } of cfgs) {
      const lineups = lineupsFor(cfg);
      const chaseIndex = cfg.inningsPerSide * 2 - 1;
      for (let seed = 1; seed <= SEEDS; seed++) {
        // `buildWalk` applies each event on the write path, so a generated overshoot would also throw here.
        const { events, states } = buildWalk(cricket, cfg, lineups, seed, 120);
        walks++;
        events.forEach((event, i) => {
          if (event.type !== "cricket.innings.summary") return;
          const after = states[i] as CricketState;
          const index = after.innings.length - 1;
          if (index !== chaseIndex) return;
          const chaseSide = after.innings[index]!.battingSide;
          const earlier = after.innings.slice(0, index);
          const own = earlier.filter((innings) => innings.battingSide === chaseSide).reduce((sum, innings) => sum + innings.runs, 0);
          const other = earlier.filter((innings) => innings.battingSide !== chaseSide).reduce((sum, innings) => sum + innings.runs, 0);
          const target = after.revisedTarget ?? other - own + 1;
          if (after.targetSource === "dls") dlsTargets++;
          const runs = (event.payload as { runs: number }).runs;
          checked++;
          if (runs >= target) reachedTarget++;
          if (runs > boundOf(target)) over.push(`${name}#${seed} event ${i}: ${runs} > ${boundOf(target)}`);
        });
      }
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(
      `CK-CH-1 generator: ${walks} walks over ${cfgs.length} cfgs, ${checked} coarse chase summaries checked, ` +
        `${reachedTarget} reached the target, ${dlsTargets} against a DLS target`,
    );
    expect(walks).toBe(cfgs.length * SEEDS);
    expect(over).toEqual([]);
    expect(checked, "coarse chase summaries checked").toBeGreaterThan(0);
    expect(reachedTarget, "coarse chases that reached the target (the bound's edge)").toBeGreaterThan(0);
    expect(dlsTargets, "coarse chases against a DLS target").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// W2e Task 8 (A1c-3; RB2A-20, SC-C5; D18) — CK-RR-1: NRR for a DLS or revised-overs match follows ICC 16.10.7.
//
// ICC Men's T20 World Cup 2026 Playing Conditions 16.10.7 (a0-findings A0.3, verbatim): "Where a match is abandoned but a
// result is achieved under Duckworth/Lewis/Stern, for net run rate purposes Team 1 will be credited with Team 2's Par Score
// on abandonment off the same number of overs faced by Team 2. Where a match is concluded with Duckworth/Lewis/Stern having
// been applied at an earlier point in the match, Team 1 will be credited with 1 run less than the final Target Score for
// Team 2 off the total number of overs allocated to Team 2 to reach the target." And of every innings: "In the event of a
// team being all out in less than its full quota of overs, the calculation of its net run rate shall be based on the full
// quota of overs to which it would have been entitled". A0.3's table reads "DLS or revised overs applied earlier" as one case.
//
// The four operands (A0.3), per side: runs for and balls faced are the side's own credit; runs against and balls bowled are
// the opponent's. Every expected credit below is typed from that text with its arithmetic beside it. Targets and pars come
// from the published D/L Standard Edition resource table (dls.ts; cricket.test.ts "reads the published resource table
// exactly" pins the reads used here), cross-checked against the engine's own declarations `dlsTarget` / `dlsPar`. Nothing is
// read back from `standingsDelta`.
//
// single-sport: net run rate, DLS and revised overs exist only in cricket.
// ---------------------------------------------------------------------------

const T20 = parse(cricket.variants.t20);
const T20_DLS = parse({ ...cricket.variants.t20, dls: { enabled: true, edition: "standard" } });
const ODI_DLS = parse({ ...cricket.variants.odi, dls: { enabled: true, edition: "standard" } });
const LEAGUE = { kind: "league" } as const;

/** One side's NRR credit for the match: the runs it is credited with, and the balls it is credited off. */
interface Credit {
  readonly runs: number;
  readonly balls: number;
}
/** A0.3: a side's runs for / balls faced are its own credit; its runs against / balls bowled are the opponent's. */
function operands(home: Credit, away: Credit): [Record<string, number>, Record<string, number>] {
  return [
    { runs_for: home.runs, balls_faced_eff: home.balls, runs_against: away.runs, balls_bowled_eff: away.balls, run_diff: home.runs - away.runs },
    { runs_for: away.runs, balls_faced_eff: away.balls, runs_against: home.runs, balls_bowled_eff: home.balls, run_diff: away.runs - home.runs },
  ];
}

interface NrrCase {
  readonly name: string;
  readonly cfg: CricketCfg;
  readonly events: readonly Spec[];
  /** Premise: what the fold decided, so the case is the scenario its comment describes. */
  readonly outcome: { readonly kind: string; readonly winner?: string; readonly method?: string };
  readonly margin?: { readonly kind: string; readonly value: number } | null;
  /** ICC 16.10.7's credit, [home, away]. */
  readonly credit: readonly [Credit, Credit];
  /** The innings as played (the pre-W2e ledger), typed: a case whose ICC credit equals it witnesses nothing. */
  readonly played?: readonly [Credit, Credit];
}

/** Folds the case on the write path and returns its outcome and the module's own delta pair (the real producer). */
function foldCase(c: Pick<NrrCase, "cfg" | "events">): { state: CricketState; pair: readonly [StandingsDelta, StandingsDelta] } {
  const state = foldMatch(cricket, c.cfg, lineupsFor(c.cfg), ledger(c.events), STRICT_ALL);
  const outcome = cricket.outcome(state);
  if (outcome === null) throw new Error("the case decided nothing");
  return { state, pair: cricket.standingsDelta(outcome, c.cfg, LEAGUE, state) };
}

function checkCases(cases: readonly NrrCase[]): number {
  let checked = 0;
  for (const c of cases) {
    const { state, pair } = foldCase(c);
    expect(cricket.outcome(state), `${c.name}: premise, the result`).toMatchObject(c.outcome);
    if (c.margin !== undefined) expect(state.margin, `${c.name}: premise, the margin`).toEqual(c.margin);
    const [home, away] = operands(...c.credit);
    expect(pair[0].metrics, `${c.name}: home`).toMatchObject(home);
    expect(pair[1].metrics, `${c.name}: away`).toMatchObject(away);
    if (c.played !== undefined) {
      expect(operands(...c.played), `${c.name}: premise, ICC's credit is not the innings as played`).not.toEqual(operands(...c.credit));
    }
    checked++;
  }
  return checked;
}

/** ODI, DLS on: Team 1 (whoever bats first) 250/5 off its 50 overs. R1 = res(50 overs, 0 down) = 100. */
const ODI_250: Spec[] = [["core.start"], summary(250, 5, 300)];
/** Between the innings the chase is cut to 25 overs: R2 = res(25, 0) = 66.5, T = ⌊250 × 66.5/100⌋ + 1 = ⌊166.25⌋ + 1 = 167. */
const CUT_TO_25: Spec = ["cricket.revise", { oversPerSide: 25 }];
const TARGET_25 = 167;
/** T20, DLS on, no revision: Team 1 160/7 off its 20 overs. R1 = R2 = res(20, 0) = 56.6. */
const T20_160: Spec[] = [["core.start"], summary(160, 7, 120)];
const R20 = 56.6;
const ABANDON: Spec = ["core.abandon", { reason: "rain" }];
const AWAY_BATS: Spec = ["cricket.toss", { wonBy: "A", elected: "bat" }];

describe("CK-RR-1 net run rate under DLS or revised overs (ICC 16.10.7, RB2A-20, SC-C5)", () => {
  it("CK-RR-1 DLS applied earlier: Team 1 is credited target−1 off Team 2's allocated overs", () => {
    // The engine's declaration agrees with the table arithmetic for every target typed below.
    expect(dlsTarget(250, 100, 66.5)).toBe(TARGET_25);
    expect(dlsTarget(250, 100, 89.3), "the first revision of the second-revision case").toBe(224);
    expect(dlsTarget(250, 100, 67.7), "its final target").toBe(170);
    const cases: NrrCase[] = [
      {
        // A chases 167 in 25 overs and gets there off 140 balls. H is credited 167 − 1 = 166 off 25 overs (150 balls).
        name: "chase cut to 25 overs, target reached",
        cfg: ODI_DLS,
        events: [...ODI_250, CUT_TO_25, summary(167, 3, 140)],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "wickets", value: 7 },
        credit: [{ runs: TARGET_25 - 1, balls: 25 * 6 }, { runs: 167, balls: 140 }],
        played: [{ runs: 250, balls: 300 }, { runs: 167, balls: 140 }],
      },
      {
        // A is all out for 120 off 130 balls: it is charged its full ALLOCATED quota, the revised 25 overs (150 balls).
        // H wins by 167 − 1 − 120 = 46 runs.
        name: "the chase all out short of a revised target",
        cfg: ODI_DLS,
        events: [...ODI_250, CUT_TO_25, summary(120, 10, 130)],
        outcome: { kind: "win", winner: "H", method: "dls" },
        margin: { kind: "runs", value: 46 },
        credit: [{ runs: TARGET_25 - 1, balls: 150 }, { runs: 120, balls: 150 }],
        played: [{ runs: 250, balls: 300 }, { runs: 120, balls: 150 }],
      },
      {
        // A ends its 25 overs on 166 = target − 1: a tie, which is a result. Both credited 166 off 150.
        name: "a tie on a revised target",
        cfg: ODI_DLS,
        events: [...ODI_250, CUT_TO_25, summary(166, 5, 150)],
        outcome: { kind: "tie" },
        credit: [{ runs: TARGET_25 - 1, balls: 150 }, { runs: 166, balls: 150 }],
        played: [{ runs: 250, balls: 300 }, { runs: 166, balls: 150 }],
      },
      {
        // A second revision, mid-chase. First: chase cut to 40 overs, R2 = res(40, 0) = 89.3, T = ⌊250 × 0.893⌋ + 1 = 224.
        // At 100/2 after 20 overs it is cut to 30: R2 loses res(20 left, 2 down) − res(10 left, 2 down) = 52.4 − 30.8 = 21.6,
        // so R2 = 67.7 and T = ⌊250 × 0.677⌋ + 1 = ⌊169.25⌋ + 1 = 170. The FINAL target and allocation count: H is credited
        // 169 off 30 overs (180 balls), not the first revision's 223 off 240.
        name: "a second DLS revision mid-chase",
        cfg: ODI_DLS,
        events: [
          ...ODI_250,
          ["cricket.revise", { oversPerSide: 40 }],
          summary(100, 2, 120, true),
          ["cricket.revise", { oversPerSide: 30 }],
          summary(170, 4, 170),
        ],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "wickets", value: 6 },
        credit: [{ runs: 170 - 1, balls: 30 * 6 }, { runs: 170, balls: 170 }],
        played: [{ runs: 250, balls: 300 }, { runs: 170, balls: 170 }],
      },
      {
        // The other chase side: A wins the toss and bats, so A is Team 1 and H chases the same 167 in 25 overs.
        name: "home chases (away bats first)",
        cfg: ODI_DLS,
        events: [AWAY_BATS, ...ODI_250, CUT_TO_25, summary(167, 3, 140)],
        outcome: { kind: "win", winner: "H", method: "dls" },
        margin: { kind: "wickets", value: 7 },
        credit: [{ runs: 167, balls: 140 }, { runs: TARGET_25 - 1, balls: 150 }],
        played: [{ runs: 167, balls: 140 }, { runs: 250, balls: 300 }],
      },
      {
        // The umpire's number is the final target (`revise.target`, method "dls"): T = 180 in 25 overs. H: 179 off 150.
        name: "an umpire's manual target",
        cfg: ODI_DLS,
        events: [...ODI_250, ["cricket.revise", { oversPerSide: 25, target: 180 }], summary(181, 4, 140)],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "wickets", value: 6 },
        credit: [{ runs: 180 - 1, balls: 150 }, { runs: 181, balls: 140 }],
        played: [{ runs: 250, balls: 300 }, { runs: 181, balls: 140 }],
      },
      {
        // The umpire revises the target alone (240), A's 50 overs untouched: H is credited 239 off A's 300 allocated balls.
        // The one case here whose allocation is NOT revised, so only the revised target says DLS was applied.
        name: "an umpire's target, overs unchanged",
        cfg: ODI_DLS,
        events: [...ODI_250, ["cricket.revise", { target: 240 }], summary(240, 5, 280)],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "wickets", value: 5 },
        credit: [{ runs: 240 - 1, balls: 50 * 6 }, { runs: 240, balls: 280 }],
        played: [{ runs: 250, balls: 300 }, { runs: 240, balls: 280 }],
      },
      {
        // Revised overs with DLS off (A0.3: "DLS or revised overs applied earlier"): the target stays 160 + 1, and A's
        // allocation is the revised 15 overs (90 balls). A is all out for 150 off 80: charged its 90. H wins by 10 runs and
        // is credited 161 − 1 = 160 off A's 90 balls, not its own 120.
        name: "revised overs with DLS off",
        cfg: T20,
        events: [["core.start"], summary(160, 6, 120), ["cricket.revise", { oversPerSide: 15 }], summary(150, 10, 80)],
        outcome: { kind: "win", winner: "H", method: "regulation" },
        margin: { kind: "runs", value: 10 },
        credit: [{ runs: 161 - 1, balls: 15 * 6 }, { runs: 150, balls: 90 }],
        played: [{ runs: 160, balls: 120 }, { runs: 150, balls: 90 }],
      },
    ];
    const checked = checkCases(cases);
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`CK-RR-1 DLS applied earlier: ${checked} matches checked`);
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("CK-RR-1 DLS at abandonment: Team 1 is credited Team 2's par off Team 2's overs faced", () => {
    // Pars, from the table: at 10 overs (60 balls) faced with 2 down res(10 left, 2) = 30.8 remains, so 56.6 − 30.8 = 25.8 is
    // used and par = ⌊160 × 25.8/56.6⌋ = ⌊72.93⌋ = 72; with 3 down res(10, 3) = 29.8 remains, 26.8 used, par = ⌊75.76⌋ = 75.
    // ODI (the R2 > R1 case of cricket.test.ts): R1 = 100 − (res(20, 2) − res(10, 2)) = 78.4, R2 = res(40, 0) = 89.3; at 22 overs
    // with 3 down res(18, 3) = 45.9 remains, 43.4 used, par = ⌊(217 − 1) × 43.4/89.3⌋ = ⌊104.98⌋ = 104.
    expect(dlsPar(160, R20, R20, R20 - 30.8)).toBe(72);
    expect(dlsPar(160, R20, R20, R20 - 29.8)).toBe(75);
    expect(dlsPar(190, 78.4, 89.3, 89.3 - 45.9)).toBe(104);
    const cases: NrrCase[] = [
      {
        // A 80/2 off 60 balls when play ends, par 72: A wins by 8 runs. H is credited 72 off the 60 balls A faced.
        name: "chase ahead of par",
        cfg: T20_DLS,
        events: [...T20_160, summary(80, 2, 60, true), ABANDON],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "runs", value: 80 - 72 },
        credit: [{ runs: 72, balls: 60 }, { runs: 80, balls: 60 }],
        played: [{ runs: 160, balls: 120 }, { runs: 80, balls: 60 }],
      },
      {
        // The other chase side, and Team 1 winning: A bats first; H is 60/3 off 60 balls against a par of 75, so A wins by 15.
        name: "home chase behind par (away bats first)",
        cfg: T20_DLS,
        events: [AWAY_BATS, ...T20_160, summary(60, 3, 60, true), ABANDON],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "runs", value: 75 - 60 },
        credit: [{ runs: 60, balls: 60 }, { runs: 75, balls: 60 }],
        played: [{ runs: 60, balls: 60 }, { runs: 160, balls: 120 }],
      },
      {
        // Level with par (72/2 off 60): a tie is a result, so it counts, both credited 72 off 60.
        name: "level with par",
        cfg: T20_DLS,
        events: [...T20_160, summary(72, 2, 60, true), ABANDON],
        outcome: { kind: "tie" },
        credit: [{ runs: 72, balls: 60 }, { runs: 72, balls: 60 }],
        played: [{ runs: 160, balls: 120 }, { runs: 72, balls: 60 }],
      },
      {
        // DLS applied earlier AND abandoned: the abandonment clause governs. A 150/3 off 132 balls against par 104 wins by 46;
        // H is credited 104 off 132, not the earlier-application credit of 217 − 1 = 216 off A's 40 overs (240 balls).
        name: "abandoned after an earlier revision",
        cfg: ODI_DLS,
        events: [
          ["core.start"],
          summary(120, 2, 180, true),
          ["cricket.revise", { oversPerSide: 40 }],
          summary(190, 6, 240),
          summary(150, 3, 132, true),
          ABANDON,
        ],
        outcome: { kind: "win", winner: "A", method: "dls" },
        margin: { kind: "runs", value: 150 - 104 },
        credit: [{ runs: 104, balls: 132 }, { runs: 150, balls: 132 }],
        played: [{ runs: 190, balls: 240 }, { runs: 150, balls: 132 }],
      },
    ];
    const checked = checkCases(cases);
    // The earlier-application credit is not what the abandoned match gets (the case above would pass it otherwise).
    expect(operands({ runs: 216, balls: 240 }, { runs: 150, balls: 132 })).not.toEqual(operands(...cases[3]!.credit));
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`CK-RR-1 DLS at abandonment: ${checked} matches checked`);
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("CK-RR-1 a non-DLS match's ledger is unchanged", () => {
    // The positive pair: no DLS result and no revision in force, so every innings counts as played (an all-out side charged
    // its full quota). Includes a revision and an abandonment that were VOIDED, and the empty case (no result: nothing).
    const cases: NrrCase[] = [
      {
        // 180/4 off 20 overs beats 150 all out off 100 balls (charged its 120): cricket.test.ts golden (b).
        name: "uninterrupted, DLS off",
        cfg: T20,
        events: [["core.start"], summary(180, 4, 120), summary(150, 10, 100)],
        outcome: { kind: "win", winner: "H", method: "regulation" },
        margin: { kind: "runs", value: 30 },
        credit: [{ runs: 180, balls: 120 }, { runs: 150, balls: 120 }],
      },
      {
        name: "uninterrupted, DLS on but never applied",
        cfg: T20_DLS,
        events: [["core.start"], summary(180, 4, 120), summary(150, 10, 100)],
        outcome: { kind: "win", winner: "H", method: "regulation" },
        margin: { kind: "runs", value: 30 },
        credit: [{ runs: 180, balls: 120 }, { runs: 150, balls: 120 }],
      },
      {
        // The cut to 25 overs is voided: the target is 251 in 50 overs again, A all out for 200 off 280 (charged 300).
        name: "the revision voided",
        cfg: ODI_DLS,
        events: [...ODI_250, CUT_TO_25, ["core.void", {}, "e-2"], summary(200, 10, 280)],
        outcome: { kind: "win", winner: "H", method: "regulation" },
        margin: { kind: "runs", value: 50 },
        credit: [{ runs: 250, balls: 300 }, { runs: 200, balls: 300 }],
      },
      {
        // The abandonment is voided and play resumes: A finishes 150/8 off its 20 overs, H wins by 10.
        name: "the abandonment voided",
        cfg: T20_DLS,
        events: [...T20_160, summary(80, 2, 60, true), ABANDON, ["core.void", {}, "e-3"], summary(150, 8, 120)],
        outcome: { kind: "win", winner: "H", method: "regulation" },
        margin: { kind: "runs", value: 10 },
        credit: [{ runs: 160, balls: 120 }, { runs: 150, balls: 120 }],
      },
      {
        // Two innings a side, no over limit (CK-RR-2's timeless innings): balls as faced. H 141 & 65, A 86 & 100.
        name: "two innings a side",
        cfg: TWO_INNINGS,
        events: [["core.start"], summary(141, 10, 364), summary(86, 10, 53), summary(65, 10, 428), summary(100, 10, 135)],
        outcome: { kind: "win", winner: "H", method: "regulation" },
        credit: [{ runs: 141 + 65, balls: 364 + 428 }, { runs: 86 + 100, balls: 53 + 135 }],
      },
    ];
    const checked = checkCases(cases);
    // The empty case: abandoned below the 5-over minimum is no result, which counts for nothing (16.10.7: "Only those
    // matches where results are achieved will count").
    const washout = foldCase({ cfg: T20_DLS, events: [...T20_160, summary(20, 1, 24, true), ABANDON] });
    expect(cricket.outcome(washout.state)).toEqual({ kind: "no_result" });
    for (const side of washout.pair) expect(side.metrics).toMatchObject({ ...operands({ runs: 0, balls: 0 }, { runs: 0, balls: 0 })[0], no_results: 1 });
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`CK-RR-1 non-DLS: ${checked} matches checked, plus the no-result`);
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("CK-RR-1 an open chase the DLS par did not decide is credited as played", () => {
    // The abandonment credit needs a par: DLS on, a quota, and the minimum overs faced (the same premises the fold decides
    // by). A chase still open with none of that was not decided by DLS, so its innings count as played. The fold never hands
    // such a state a result; the delta is asked directly, with a tie, to reach the branch.
    const states: { name: string; cfg: CricketCfg; events: Spec[]; credit: [Credit, Credit] }[] = [
      { name: "DLS off", cfg: T20, events: [...T20_160, summary(80, 2, 60, true)], credit: [{ runs: 160, balls: 120 }, { runs: 80, balls: 60 }] },
      {
        name: "below the minimum overs",
        cfg: T20_DLS,
        events: [...T20_160, summary(20, 1, 24, true)],
        credit: [{ runs: 160, balls: 120 }, { runs: 20, balls: 24 }],
      },
    ];
    let checked = 0;
    for (const { name, cfg, events, credit } of states) {
      const state = foldMatch(cricket, cfg, lineupsFor(cfg), ledger(events), STRICT_ALL);
      expect(state.innings[1]?.closed, `${name}: premise, the chase is open`).toBe(false);
      const [home, away] = cricket.standingsDelta({ kind: "tie" }, cfg, LEAGUE, state);
      const [wantHome, wantAway] = operands(...credit);
      expect(home.metrics, `${name}: home`).toMatchObject(wantHome);
      expect(away.metrics, `${name}: away`).toMatchObject(wantAway);
      checked++;
    }
    expect(checked).toBe(states.length);
  });

  it("CK-RR-1 a table with a DLS match orders by the ICC NRR", () => {
    // ODI, DLS on. Q (home) 250/5 v P: the chase is cut to 25 overs (target 167) and P gets there, 167/3 off 140 balls.
    // R (home) 200/7 off 50 overs v S, all out for 150 off 280 balls (charged 300): R by 50 runs.
    // ICC NRR per over (runs × 6 / balls):
    //   P: 167×6/140 − 166×6/150 = 7.157 − 6.640 = +0.517     R: 200×6/300 − 150×6/300 = +1.000
    //   Q: 166×6/150 − 167×6/140 = −0.517                      S: −1.000
    // Points (2 a win) and wins put P level with R and Q level with S, so NRR orders R, P, Q, S.
    // Credited as played (Q 250 off 300): P 7.157 − 5.000 = +2.157 passes R, and S passes Q — P, R, S, Q, the wrong table.
    const positions = resolvePositions(cricket, ODI_DLS);
    const fixture = (home: string, away: string, events: readonly Spec[]): readonly [StandingsDelta, StandingsDelta] => {
      const lineups: LineupPair = { home: lineupFromCatalog(positions, home), away: lineupFromCatalog(positions, away) };
      const state = foldMatch(cricket, ODI_DLS, lineups, ledger(events), STRICT_ALL);
      const outcome = cricket.outcome(state);
      if (outcome === null) throw new Error(`${home} v ${away} decided nothing`);
      return cricket.standingsDelta(outcome, ODI_DLS, LEAGUE, state);
    };
    const results = [
      fixture("Q", "P", [...ODI_250, CUT_TO_25, summary(167, 3, 140)]),
      fixture("R", "S", [["core.start"], summary(200, 7, 300), summary(150, 10, 280)]),
    ];
    const cascade = cricket.defaultTiebreakers("league", ODI_DLS);
    expect(cascade.slice(0, 3), "premise: cricket's league order reaches NRR third").toEqual(["points", "wins", "nrr"]);
    const ranked = rankStandings(foldResults(["P", "Q", "R", "S"], results), { cascade, results }).rows;
    expect(ranked.map((row) => [row.entrantId, row.points, row.won, row.tieBreak?.key])).toEqual([
      ["R", 2, 1, "nrr"],
      ["P", 2, 1, "nrr"],
      ["Q", 0, 0, "nrr"],
      ["S", 0, 0, "nrr"],
    ]);
    // What the table prints (display.ts, per six-ball over).
    expect(ranked.map((row) => derivedMetricText(row, "nrr"))).toEqual(["+1.000", "+0.517", "-0.517", "-1.000"]);
    // The wrong one's constant: the same two matches with Q credited its innings as played rank P, R, S, Q.
    const row = (id: string, won: number, credit: [Credit, Credit]): StandingsDelta => ({
      entrantId: id,
      played: 1,
      won,
      drawn: 0,
      lost: 1 - won,
      points: 2 * won,
      metrics: operands(...credit)[0],
    });
    const asPlayed = [
      [row("Q", 0, [{ runs: 250, balls: 300 }, { runs: 167, balls: 140 }]), row("P", 1, [{ runs: 167, balls: 140 }, { runs: 250, balls: 300 }])],
      [row("R", 1, [{ runs: 200, balls: 300 }, { runs: 150, balls: 300 }]), row("S", 0, [{ runs: 150, balls: 300 }, { runs: 200, balls: 300 }])],
    ] as const;
    const wrong = rankStandings(foldResults(["P", "Q", "R", "S"], asPlayed), { cascade, results: asPlayed }).rows;
    expect(wrong.map((r) => r.entrantId)).toEqual(["P", "R", "S", "Q"]);
  });
});

// ---------------------------------------------------------------------------
// W2e Task 8b (A1c-3b; D8) — CK-NB-1: on a no ball only three modes of dismissal stand.
//
// ICC Men's T20 World Cup 2026 Playing Conditions 21.18 (verbatim, the PC PDF of a0-findings #18): "When No ball has been
// called, neither batter shall be out under any of the Playing Conditions except clause 34 (Hit the ball twice), clause 37
// (Obstructing the field) or clause 38 (Run out)." MCC Law 21.18 reads the same with "Laws" for "Playing Conditions".
// 21.19.2, the free hit that follows: "the striker can be dismissed only under the circumstances that apply for a No ball,
// even if the delivery for the free hit is called Wide." 22.9, a wide: "neither batter shall be out under any of the
// Playing Conditions except clause 35 (Hit wicket), clause 37 (Obstructing the field), clause 38 (Run out) or clause 39
// (Stumped)."
//
// The refusal is the write path's only (a new rule over a ledger that may already hold such a ball): a stored one keeps
// folding to what it recorded. Every expected set below is typed from those clauses; the modes swept are the schema's own.
//
// single-sport: a no ball, a free hit and a wide are cricket's deliveries; no other sport restricts a dismissal by delivery.
// ---------------------------------------------------------------------------

type WicketKind = (typeof CricketWicket.shape.kind.options)[number];
/** ICC PC 21.18: clauses 34 (hit the ball twice), 37 (obstructing the field), 38 (run out). */
const ICC_21_18: readonly WicketKind[] = ["hitballtwice", "obstructed", "runout"];
/** ICC PC 22.9: clauses 35 (hit wicket), 37 (obstructing the field), 38 (run out), 39 (stumped). */
const ICC_22_9: readonly WicketKind[] = ["hitwicket", "obstructed", "runout", "stumped"];
/** CK-FH-1 as the engine holds it: run out and obstructing only. ICC 21.19.2 adds hit the ball twice; the engine refuses it
 *  on a free hit, the row's recorded deviation (W2e ruling I-2, owner 10-26 "skip rare cases"). */
const FREE_HIT_ENGINE: readonly WicketKind[] = ["obstructed", "runout"];
/** MCC Laws 32, 33, 35, 36, 39: the bowler is credited with bowled, caught, hit wicket, lbw and stumped, and nothing else. */
const BOWLER_CREDITED: readonly WicketKind[] = ["bowled", "caught", "hitwicket", "lbw", "stumped"];
const MODES: readonly WicketKind[] = CricketWicket.shape.kind.options;

const NO_BALL = { kind: "noball", runs: 1 } as const;
const WIDE = { kind: "wide", runs: 1 } as const;
interface Crease {
  readonly striker: string;
  readonly nonStriker: string;
  readonly bowler: string;
}
const OPENERS: Crease = { striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11" };
const wicketOf = (kind: WicketKind, out: string) => ({ kind, out, bowlerCredited: BOWLER_CREDITED.includes(kind) });

/** One delivery of the open innings, no bat runs. */
function delivery(
  over: number,
  ballInOver: number,
  opts: { extras?: typeof NO_BALL | typeof WIDE; wicket?: ReturnType<typeof wicketOf>; crease?: Crease; type?: string } = {},
): Spec {
  return [
    opts.type ?? "cricket.ball",
    {
      over,
      ballInOver,
      ...(opts.crease ?? OPENERS),
      runs: { bat: 0, ...(opts.extras === undefined ? {} : { extras: opts.extras }) },
      ...(opts.wicket === undefined ? {} : { wicket: opts.wicket }),
    },
  ];
}

function refusalOf(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return { code: err.code, message: err.message };
    throw err;
  }
}

describe("CK-NB-1 dismissals off a no ball (ICC 21.18, D8)", () => {
  const lineups = lineupsFor(T20);
  const strict = (specs: readonly Spec[]) => foldMatch(cricket, T20, lineups, ledger(specs), STRICT_ALL);
  const openInnings = (state: CricketState) => {
    const innings = state.innings.at(-1);
    if (innings?.fine == null) throw new Error("premise: a ball-by-ball innings is open");
    return { ...innings, fine: innings.fine };
  };

  it("CK-NB-1 on a no ball only hit the ball twice, obstructing the field and run out stand; every other mode is refused on the write path", () => {
    for (const kind of [...ICC_21_18, ...ICC_22_9, ...FREE_HIT_ENGINE, ...BOWLER_CREDITED]) {
      expect(MODES, `${kind} is a declared mode of dismissal`).toContain(kind);
    }
    let stood = 0;
    let refused = 0;
    let legalPair = 0;
    for (const kind of MODES) {
      const onNoBall: Spec[] = [["core.start"], delivery(0, 1, { extras: NO_BALL, wicket: wicketOf(kind, "H-p1") })];
      if (ICC_21_18.includes(kind)) {
        const innings = openInnings(strict(onNoBall));
        expect(innings.wickets, `${kind} stands on a no ball`).toBe(1);
        expect(innings.fine.dismissed, `${kind}: the striker is out`).toEqual(["H-p1"]);
        stood++;
      } else {
        expect(refusalOf(() => strict(onNoBall)), `${kind} on a no ball`).toEqual({
          code: "INVALID_EVENT",
          message: `"${kind}" cannot dismiss on a no ball`,
        });
        refused++;
      }
      // The positive pair: the same mode on a legal ball is recorded.
      const legal = openInnings(strict([["core.start"], delivery(0, 1, { wicket: wicketOf(kind, "H-p1") })]));
      expect(legal.wickets, `${kind} on a legal ball`).toBe(1);
      legalPair++;
    }
    // The non-striker can be out off a no ball too, by run out or obstructing the field (21.18's clauses 37 and 38).
    for (const kind of ["obstructed", "runout"] as const) {
      const innings = openInnings(strict([["core.start"], delivery(0, 1, { extras: NO_BALL, wicket: wicketOf(kind, "H-p2") })]));
      expect(innings.fine.dismissed, `${kind} of the non-striker on a no ball`).toEqual(["H-p2"]);
      stood++;
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`CK-NB-1 no ball: ${MODES.length} modes swept, ${stood} dismissals stood, ${refused} refused, ${legalPair} legal-ball pairs`);
    expect(stood).toBe(ICC_21_18.length + 2);
    expect(refused).toBe(MODES.length - ICC_21_18.length);
    expect(refused).toBeGreaterThan(0);
    expect(legalPair).toBe(MODES.length);
  });

  it("CK-NB-1 a stored bowled off a no ball (a pre-W2e ledger) still folds on the read path", () => {
    // H-p1 bowled off a no ball, then H-p3 (next in the order) faces the free hit for a dot ball.
    const stored: Spec[] = [
      ["core.start"],
      delivery(0, 1, { extras: NO_BALL, wicket: wicketOf("bowled", "H-p1") }),
      delivery(0, 1, { crease: { striker: "H-p3", nonStriker: "H-p2", bowler: "A-p11" } }),
    ];
    const read = openInnings(foldMatch(cricket, T20, lineups, ledger(stored)));
    expect(read.wickets).toBe(1);
    expect(read.runs, "the no ball's one run").toBe(1);
    expect(read.fine.dismissed).toEqual(["H-p1"]);
    expect(read.legalBalls).toBe(1);
    // The same ball as a NEW write is refused; a write after it folds with it in the ledger.
    expect(refusalOf(() => foldMatch(cricket, T20, lineups, ledger(stored), { strictFromSeq: 1 }))?.code).toBe("INVALID_EVENT");
    expect(openInnings(foldMatch(cricket, T20, lineups, ledger(stored), { strictFromSeq: 2 })).wickets).toBe(1);
  });

  it("CK-NB-1 then CK-FH-1: the no ball's own rule binds it, then the free hit's binds the next legal ball", () => {
    // A no ball with the non-striker run out (21.18 lets it stand); H-p3 comes in at that end, and the free hit is armed.
    const noBallRunOut = delivery(0, 1, { extras: NO_BALL, wicket: wicketOf("runout", "H-p2") });
    const armed: Spec[] = [["core.start"], noBallRunOut];
    const after = openInnings(strict(armed));
    expect(after.wickets).toBe(1);
    expect(after.fine.freeHitPending, "21.19.1: the next delivery is a free hit").toBe(true);
    const freeHitCrease: Crease = { striker: "H-p1", nonStriker: "H-p3", bowler: "A-p11" };
    // The free hit (a legal ball): the engine's free-hit rule, every mode swept.
    let stood = 0;
    let refused = 0;
    for (const kind of MODES) {
      const onFreeHit = [...armed, delivery(0, 1, { crease: freeHitCrease, wicket: wicketOf(kind, "H-p1") })];
      if (FREE_HIT_ENGINE.includes(kind)) {
        expect(openInnings(strict(onFreeHit)).wickets, `${kind} on the free hit`).toBe(2);
        stood++;
      } else {
        expect(refusalOf(() => strict(onFreeHit)), `${kind} on the free hit`).toEqual({
          code: "INVALID_EVENT",
          message: `"${kind}" cannot dismiss on a free hit`,
        });
        refused++;
      }
    }
    // Hit the ball twice stands on the no ball (21.18) and is refused on the free hit after it: CK-FH-1's deviation.
    expect(ICC_21_18).toContain("hitballtwice");
    expect(FREE_HIT_ENGINE).not.toContain("hitballtwice");
    // A dot ball uses the free hit up; the next legal ball takes any mode again.
    const used: Spec[] = [...armed, delivery(0, 1, { crease: freeHitCrease })];
    expect(openInnings(strict(used)).fine.freeHitPending).toBe(false);
    expect(openInnings(strict([...used, delivery(0, 2, { crease: freeHitCrease, wicket: wicketOf("bowled", "H-p1") })])).wickets).toBe(2);
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`CK-NB-1 then CK-FH-1: ${MODES.length} modes on the free hit, ${stood} stood, ${refused} refused`);
    expect(stood).toBe(FREE_HIT_ENGINE.length);
    expect(refused).toBe(MODES.length - FREE_HIT_ENGINE.length);
    expect(refused).toBeGreaterThan(0);
  });

  it("CK-NB-1 a void of the no ball takes its dismissal and its free hit with it; the rule still binds the next no ball", () => {
    // A dot ball opens the innings, then the no ball (the non-striker run out) at the second ball, then its void.
    const noBallRunOut = delivery(0, 2, { extras: NO_BALL, wicket: wicketOf("runout", "H-p2") });
    const played: Spec[] = [["core.start"], delivery(0, 1), noBallRunOut];
    const voided: Spec[] = [...played, ["core.void", {}, "e-2"]];
    const before = openInnings(strict(played));
    expect([before.wickets, before.runs, before.fine.freeHitPending], "premise: the no ball stood and armed the free hit").toEqual([1, 1, true]);
    const after = openInnings(strict(voided));
    expect([after.wickets, after.runs, after.legalBalls, after.fine.freeHitPending]).toEqual([0, 0, 1, false]);
    expect(after.fine.dismissed).toEqual([]);
    // No free hit any more: a bowled on the next legal ball stands. Its pair: with the no ball in place, the free hit refuses it.
    const bowled = (crease: Crease) => delivery(0, 2, { crease, wicket: wicketOf("bowled", "H-p1") });
    expect(openInnings(strict([...voided, bowled(OPENERS)])).wickets).toBe(1);
    expect(refusalOf(() => strict([...played, bowled({ ...OPENERS, nonStriker: "H-p3" })]))?.message).toBe(
      '"bowled" cannot dismiss on a free hit',
    );
    // The second call: a no ball written after the void is bound like the first.
    expect(refusalOf(() => strict([...voided, delivery(0, 2, { extras: NO_BALL, wicket: wicketOf("bowled", "H-p1") })]))).toEqual({
      code: "INVALID_EVENT",
      message: '"bowled" cannot dismiss on a no ball',
    });
  });

  it("CK-NB-1 the super over's no ball is bound the same", () => {
    // A tied T20 goes to a super over; A batted second, so A bats first in it (ICC Appendix F).
    const cfg = parse({ ...cricket.variants.t20, superOver: true });
    const soLineups = lineupsFor(cfg);
    const tied: Spec[] = [["core.start"], summary(150, 5, 120), summary(150, 7, 120)];
    const soCrease: Crease = { striker: "A-p1", nonStriker: "A-p2", bowler: "H-p11" };
    const soBall = (kind: WicketKind) =>
      delivery(0, 1, { type: "cricket.superover.ball", crease: soCrease, extras: NO_BALL, wicket: wicketOf(kind, "A-p1") });
    const write = (specs: readonly Spec[]) => foldMatch(cricket, cfg, soLineups, ledger(specs), STRICT_ALL);
    expect(write(tied).phase, "premise: the tie opens the super over").toBe("super_over");
    expect(refusalOf(() => write([...tied, soBall("bowled")]))).toEqual({ code: "INVALID_EVENT", message: '"bowled" cannot dismiss on a no ball' });
    expect(refusalOf(() => write([...tied, soBall("runout")]))).toBeNull();
    // And a stored one replays.
    expect(refusalOf(() => foldMatch(cricket, cfg, soLineups, ledger([...tied, soBall("bowled")])))).toBeNull();
  });

  it("CK-NB-1 engine fact: a wide restricts no mode of dismissal, though ICC 22.9 allows only hit wicket, obstructing, run out and stumped", () => {
    // The no-ball rule does not reach a wide: stumped (22.9 allows it, 21.18 does not) stands. The engine also lets the six
    // modes 22.9 refuses stand on a wide — a departure recorded here, not changed (the brief keeps wide handling as it is).
    let stood = 0;
    let departures = 0;
    for (const kind of MODES) {
      const innings = openInnings(strict([["core.start"], delivery(0, 1, { extras: WIDE, wicket: wicketOf(kind, "H-p1") })]));
      expect(innings.wickets, `${kind} on a wide`).toBe(1);
      expect(innings.legalBalls, `${kind}: a wide is not a ball of the over`).toBe(0);
      stood++;
      if (!ICC_22_9.includes(kind)) departures++;
    }
    expect(ICC_21_18, "premise: stumped is the differential").not.toContain("stumped");
    expect(ICC_22_9).toContain("stumped");
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`CK-NB-1 wide (engine fact): ${stood} modes stood on a wide, ${departures} of them outside ICC 22.9`);
    expect(stood).toBe(MODES.length);
    expect(departures).toBe(MODES.length - ICC_22_9.length);
    expect(departures).toBeGreaterThan(0);
  });
});
