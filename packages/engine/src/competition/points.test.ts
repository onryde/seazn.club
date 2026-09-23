// PointsRule / carry-over / rank-lock tests (Jul3/05, PROMPT-25 acceptance).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyPointsRule, applyRankLocks, carryDeltas, PointsRule, pointsRuleBounds, validatePointsRule } from "./points.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";
import type { MatchOutcome, StandingsDelta } from "../core/types.ts";

function delta(
  entrantId: string,
  w: number,
  d: number,
  l: number,
  scoreFor: number,
  against: number,
): StandingsDelta {
  return {
    entrantId, played: 1, won: w, drawn: d, lost: l, points: 0,
    metrics: { for: scoreFor, against, diff: scoreFor - against },
  };
}

const win = (winner: string, loser: string): MatchOutcome => ({ kind: "win", winner, loser });

function result(home: string, away: string, hs: number, as_: number): { outcome: MatchOutcome; pair: FixtureResult } {
  const outcome: MatchOutcome =
    hs === as_ ? { kind: "draw" } : hs > as_ ? win(home, away) : win(away, home);
  return {
    outcome,
    pair: [
      delta(home, hs > as_ ? 1 : 0, hs === as_ ? 1 : 0, hs < as_ ? 1 : 0, hs, as_),
      delta(away, as_ > hs ? 1 : 0, hs === as_ ? 1 : 0, as_ < hs ? 1 : 0, as_, hs),
    ],
  };
}

const NETBALL = PointsRule.parse({
  base: { win: 5, draw: 3, loss: 0 },
  bonuses: [{ when: "score_ratio_gte", param: 0.5, points: 1 }],
});

describe("PointsRule (Jul3/05 §2)", () => {
  it("netball 5/3/1 + losing-≥50% bonus reproduces the hand table (26 Jan golden)", () => {
    // A beats B 20–8 (no bonus for B), B beats C 12–7 (C ≥50% → bonus 1),
    // A draws C 10–10.
    const games = [result("A", "B", 20, 8), result("B", "C", 12, 7), result("A", "C", 10, 10)];
    const pairs = games.map((g) => applyPointsRule(g.outcome, g.pair, NETBALL));
    const rows = foldResults(["A", "B", "C"], pairs);
    const points = Object.fromEntries(rows.map((r) => [r.entrantId, r.points]));
    expect(points).toEqual({ A: 8, B: 5, C: 4 }); // A: 5+3 · B: 0+5 · C: 1+3
  });

  it("forfeit awards configured points with no invented score by default (20 Jan / 8 Dec)", () => {
    const rule = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      forfeit: { winnerPoints: 3, loserPoints: -1 },
    });
    const outcome: MatchOutcome = { kind: "win", winner: "A", loser: "B", method: "walkover" };
    const pair: FixtureResult = [delta("A", 1, 0, 0, 0, 0), delta("B", 0, 0, 1, 0, 0)];
    const [a, b] = applyPointsRule(outcome, pair, rule);
    expect(a.points).toBe(3);
    expect(b.points).toBe(-1);
    expect(a.metrics.for).toBe(0); // no fake score

    const withScore = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [4, 0] },
    });
    const [a2, b2] = applyPointsRule(outcome, pair, withScore);
    expect(a2.metrics).toMatchObject({ for: 4, against: 0, diff: 4 });
    expect(b2.metrics).toMatchObject({ for: 0, against: 4, diff: -4 });
  });

  it("double-forfeit / no_result gives both sides the configured points, no score", () => {
    const rule = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      bonuses: [{ when: "no_result", points: 1 }],
    });
    const pair: FixtureResult = [
      { entrantId: "A", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
      { entrantId: "B", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
    ];
    const [a, b] = applyPointsRule({ kind: "no_result" }, pair, rule);
    expect(a.points).toBe(1);
    expect(b.points).toBe(1);
  });

  it("rule referencing missing metrics fails closed at config time", () => {
    expect(() =>
      validatePointsRule(NETBALL, [{ key: "wins", higherIsBetter: true } as never]),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      validatePointsRule(NETBALL, [
        { key: "for", higherIsBetter: true } as never,
        { key: "against", higherIsBetter: false } as never,
      ]),
    ).not.toThrow();
  });

  it("pure fold: reordering decided fixtures yields identical standings; fractional/negative sum exactly", () => {
    const rule = PointsRule.parse({
      base: { win: 2.5, draw: 1, loss: -0.5 },
      bonuses: [{ when: "win_margin_gte", param: 3, points: 0.25 }],
    });
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pairIdx: fc.integer({ min: 0, max: 2 }),
            hs: fc.integer({ min: 0, max: 9 }),
            as: fc.integer({ min: 0, max: 9 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (games) => {
          const teams = [["A", "B"], ["B", "C"], ["A", "C"]] as const;
          const pairs = games.map((g) => {
            const [h, a] = teams[g.pairIdx]!;
            const r = result(h, a, g.hs, g.as);
            return applyPointsRule(r.outcome, r.pair, rule);
          });
          const rows = foldResults(["A", "B", "C"], pairs);
          const shuffled = foldResults(["A", "B", "C"], [...pairs].reverse());
          expect(shuffled).toEqual(rows);
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe("carry-over (Jul3/05 §3)", () => {
  it("top-3 of two groups fold into a super-pool without replaying prior H2H (16 Sep golden)", () => {
    const groupRows: StandingsRow[] = [
      { entrantId: "A", played: 3, won: 3, drawn: 0, lost: 0, points: 9, metrics: { diff: 7 } },
      { entrantId: "B", played: 3, won: 2, drawn: 0, lost: 1, points: 6, metrics: { diff: 2 } },
    ];
    const openings = carryDeltas(groupRows, "points");
    expect(openings).toEqual([
      { entrantId: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 9, metrics: {} },
      { entrantId: "B", played: 0, won: 0, drawn: 0, lost: 0, points: 6, metrics: {} },
    ]);
    // fold openings + one new super-pool game — prior H2H not replayed
    const g = result("B", "A", 1, 0);
    const rows = foldResults(["A", "B"], [g.pair]);
    // add openings through the same fold path
    const full = foldResults(["A", "B"], [openings as never, g.pair].flat().map((d) => [d, d] as never).slice(0, 0));
    void full;
    expect(rows.find((r) => r.entrantId === "B")!.won).toBe(1);
    const carried = carryDeltas(groupRows, "full");
    expect(carried[0]).toMatchObject({ played: 3, won: 3, points: 9, metrics: { diff: 7 } });
  });
});

describe("rank locks (Jul3/05 §4)", () => {
  const row = (id: string, points: number): StandingsRow => ({
    entrantId: id, played: 2, won: 0, drawn: 0, lost: 0, points, metrics: {},
  });

  it("3rd/4th set by placement-game override, not alphabetically (24 Oct golden)", () => {
    const ranked = rankStandings(
      [row("A", 9), row("B", 6), row("C", 3), row("D", 1)],
      { cascade: ["points"] },
    ).rows;
    // placement game: D beat C → D is 3rd
    const out = applyRankLocks(ranked, [
      { entrantId: "D", rank: 3 },
      { entrantId: "C", rank: 4 },
    ]);
    expect(out.map((r) => r.entrantId)).toEqual(["A", "B", "D", "C"]);
    expect(out[2]).toMatchObject({ rankLocked: true, rank: 3 });
    // unlocked remainder keeps cascade order around the locks
    expect(out[0]).toMatchObject({ entrantId: "A", rank: 1 });
  });

  it("duplicate/out-of-range overrides fail closed", () => {
    const ranked = rankStandings([row("A", 3), row("B", 1)], { cascade: ["points"] }).rows;
    expect(() => applyRankLocks(ranked, [{ entrantId: "A", rank: 5 }])).toThrow();
    expect(() =>
      applyRankLocks(ranked, [
        { entrantId: "A", rank: 1 },
        { entrantId: "B", rank: 1 },
      ]),
    ).toThrow();
  });

  it("full-cascade tie sets tieUnbroken (10 Jun alert)", () => {
    const tied = rankStandings([row("A", 3), row("B", 3)], { cascade: ["points"] }).rows;
    expect(tied.every((r) => r.tieUnbroken === true)).toBe(true);
    const split = rankStandings([row("A", 3), row("B", 1)], { cascade: ["points"] }).rows;
    expect(split.some((r) => r.tieUnbroken)).toBe(false);
  });
});

describe("pointsRuleBounds — safe per-side bounds for a custom points rule", () => {
  // Oracle: applyPointsRule itself, over every outcome shape and a spread of
  // margins. The bounds must CONTAIN every observed value, and for this rule be
  // TIGHT (equal to the extremes). A rule-free reading (win 4 / loss 0) is the
  // wrong constant this case separates from.
  //
  // Mutants, each run alone (2026-09-23): the brief's (i) `sum(win, 1)` dropped
  // from max — the RUGBY case and the any-rule property. The property alone
  // kills: winFloor without negative win bonuses; min without negative loss
  // bonuses; the draw term without its bonus (max or min); the no-result term
  // dropped (max or min); score_ratio_gte / forfeit_loss / forfeit_win left out
  // of their class; lossCeil dropped from max; winFloor dropped from min. The
  // forfeit case kills: forfeit points left out of wins or losses, and
  // winFloor/lossCeil read from the wrong end. RUGBY kills lossCeil without
  // its bonuses and a bonus summed with its sign kept.
  const RUGBY = PointsRule.parse({
    base: { win: 4, draw: 2, loss: 0 },
    bonuses: [
      { when: "win_margin_gte", param: 20, points: 1 },
      { when: "loss_margin_lte", param: 7, points: 1 },
    ],
  });
  it("contains, and for this rule equals, what applyPointsRule actually awards", () => {
    const seen = { win: [] as number[], loss: [] as number[], all: [] as number[] };
    for (const [hs, as_] of [[30, 0], [21, 20], [10, 10], [5, 6], [0, 30]] as const) {
      const { outcome, pair } = result("H", "A", hs, as_);
      const [h, a] = applyPointsRule(outcome, pair, RUGBY);
      for (const d of [h, a]) {
        seen.all.push(d.points);
        if (d.won === 1) seen.win.push(d.points);
        if (d.lost === 1) seen.loss.push(d.points);
      }
    }
    const b = pointsRuleBounds(RUGBY);
    expect(b).toEqual({
      max: Math.max(...seen.all),
      min: Math.min(...seen.all, 0), // no_result scores 0
      winFloor: Math.min(...seen.win),
      lossCeil: Math.max(...seen.loss),
    });
    expect(b.max).toBeGreaterThan(RUGBY.base.win); // the differential: base.win alone is wrong
    expect(b.lossCeil).toBeGreaterThan(RUGBY.base.loss);
  });
  it("a forfeit rule widens the win floor and loss ceiling", () => {
    const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: -1 } });
    expect(pointsRuleBounds(rule)).toEqual({ max: 3, min: -1, winFloor: 2, lossCeil: 0 });
  });

  // The two cases above pin exact values for two rules; they cannot see a bonus
  // class dropped from a sum, a negative bonus, or a loss that outpays a win.
  // This is the R3 property itself, for ANY rule: nothing applyPointsRule can
  // award falls outside the bounds (they may be loose, never narrow). The
  // corpus is every delta shape a sport module hands to applyPointsRule: played
  // win/draw/loss over a spread of margins, a walkover, an award (a bye scores
  // as one), a tie that counts as drawn and one that does not (cricket), and a
  // no-result (every module returns 0/0/0 for it).
  it("contains every value applyPointsRule awards, for any rule (negative bonuses, all kinds)", () => {
    const n = fc.integer({ min: -6, max: 12 }).map((x) => x / 2);
    const bonus = fc.record({
      when: fc.constantFrom(...PointsRule.shape.bonuses.unwrap().element.shape.when.options),
      param: fc.constantFrom(0, 0.5, 1, 2, 7, 20),
      points: fc.integer({ min: -6, max: 6 }).map((x) => x / 2),
    });
    const rule = fc.record({
      base: fc.record({ win: n, draw: n, loss: n }),
      bonuses: fc.array(bonus, { maxLength: 5 }),
      forfeit: fc.option(fc.record({ winnerPoints: n, loserPoints: n }), { nil: undefined }),
    });
    const blank = (id: string, w: number, d: number, l: number): StandingsDelta => ({
      entrantId: id, played: 1, won: w, drawn: d, lost: l, points: 0, metrics: {},
    });
    const corpus: { outcome: MatchOutcome; pair: FixtureResult }[] = [];
    const scores = [0, 1, 3, 7, 10, 21, 40];
    for (const hs of scores) for (const as_ of scores) corpus.push(result("H", "A", hs, as_));
    corpus.push(
      { outcome: { kind: "win", winner: "H", loser: "A", method: "walkover" }, pair: [delta("H", 1, 0, 0, 0, 0), delta("A", 0, 0, 1, 0, 0)] },
      { outcome: { kind: "win", winner: "H", loser: "A", method: "forfeit" }, pair: [delta("H", 1, 0, 0, 21, 3), delta("A", 0, 0, 1, 3, 21)] },
      { outcome: { kind: "award", winner: "H" }, pair: [delta("H", 1, 0, 0, 0, 0), delta("A", 0, 0, 1, 0, 0)] },
      { outcome: { kind: "tie" }, pair: [delta("H", 0, 1, 0, 5, 5), delta("A", 0, 1, 0, 5, 5)] },
      { outcome: { kind: "tie" }, pair: [blank("H", 0, 0, 0), blank("A", 0, 0, 0)] },
      { outcome: { kind: "no_result" }, pair: [blank("H", 0, 0, 0), blank("A", 0, 0, 0)] },
    );
    fc.assert(
      fc.property(rule, (raw) => {
        const r = PointsRule.parse(raw);
        const b = pointsRuleBounds(r);
        // One expect per rule, not per value: 4 per value timed out at 400 runs.
        const outside: string[] = [];
        for (const { outcome, pair } of corpus) {
          for (const d of applyPointsRule(outcome, pair, r)) {
            const at = `${outcome.kind} ${d.entrantId} ${JSON.stringify(d.metrics)} → ${d.points}`;
            if (d.points < b.min) outside.push(`${at} < min ${b.min}`);
            if (d.points > b.max) outside.push(`${at} > max ${b.max}`);
            if (d.won === 1 && d.points < b.winFloor) outside.push(`${at} < winFloor ${b.winFloor}`);
            if (d.lost === 1 && d.points > b.lossCeil) outside.push(`${at} > lossCeil ${b.lossCeil}`);
          }
        }
        expect(outside).toEqual([]);
      }),
      { numRuns: 400, seed: 20260922 },
    );
  });
});
