// W2e Task 6 (A1c-1, SC-C4 / RB2A-22) — CK-CH-1: a coarse chase total may not pass the winning run.
//
// The bound is the rulebook's, never the engine's. ICC Men's T20 World Cup 2026 Playing Conditions 16.5.1/16.5.3 (MCC Law
// 16.5) end a chase AT the winning run and count a boundary in full, so from one run short the most a single delivery can
// add is a no-ball (1) hit for six (6): the final chase total is at most target − 1 + 7 (rulebook RBS:433, RB2A-22).
// The target is the Laws' too: one run more than the other side's total, or in a two-innings match one more than its
// aggregate lead; a DLS target is the engine's own Standard Edition declaration (`state.revisedTarget`, not under test).
//
// single-sport: a chase and its target exist only in cricket's innings model; no other sport records a coarse total to bound.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { cricket, type CricketCfg, type CricketState } from "./cricket.ts";

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
