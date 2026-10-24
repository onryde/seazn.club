// W2d Task 2 — properties of `payout` (rule 10, fast-check) over every sport's REAL recorded folds (the golden corpora:
// the recorded outcome and the module's own league delta pair), under random outcome-keyed rules.
//  - points conservation: Σ row points of the folded table == Σ per-fixture payouts; a double walkover adds 0.
//  - payout symmetry: swapping home and away swaps the paid pair.
//  - per-fixture total (review M4): each fixture pays both sides what SPEC §5.3 types for its outcome class, read off the
//    rule's own fields — a payout mutant moves a fixture's total, which conservation alone (a sum of sums) cannot see.
// Anti-vacuity: every property reports how many fixtures it checked, and zero checked is a failure.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MatchOutcome } from "../core/types.ts";
import { FOLD_EPOCH } from "../sport/fold-epoch.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { readCorpus } from "../testkit/golden.ts";
import { PointsRule, decidedInFor, foldResults, payout, setsToWinOf, type DecidedIn, type FixtureResult } from "./index.ts";

const SPORTS = Object.keys(FOLD_EPOCH).length;
type Fixture = { outcome: MatchOutcome; pair: FixtureResult; cfg: unknown };

/** Each sport's decided corpus fixtures with a league pair (an undecided stream has no pair and is never paid). */
const FIXTURES: ReadonlyMap<string, readonly Fixture[]> = new Map(
  builtinModules.map((m) => [
    m.key,
    readCorpus(m.key).streams.flatMap((s) => {
      const raw: unknown = JSON.parse(s.outcome);
      const deltas = JSON.parse(s.deltas) as { league?: FixtureResult | null };
      const cfg = readCorpus(m.key).configs[s.config];
      return raw === null || deltas.league == null ? [] : [{ outcome: MatchOutcome.parse(raw), pair: deltas.league, cfg }];
    }),
  ]),
);

const half = fc.integer({ min: -6, max: 12 }).map((x) => x / 2);
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
/** A random rule a sport's table can pay every recorded outcome of: a draw and a tie always paid (a rule without them is
 *  refused at save, `coverage`), the shoot-out field its booking reads, and a set-score map — always with "*", so every
 *  score resolves — only for a set sport. */
const ruleFor = (m: AnySportModule): fc.Arbitrary<PointsRule> =>
  fc
    .record({
      win: fc.record({ regulation: half, ot: opt(half), so: opt(half) }),
      loss: fc.record({ regulation: half, ot: opt(half), so: opt(half), unplayed: opt(half) }),
      draw: half,
      tie: half,
      noResult: opt(half),
      soBonus: opt(half),
      star: fc.tuple(half, half),
      exact: fc.dictionary(fc.constantFrom("2-0", "2-1", "3-0", "3-1", "3-2"), fc.tuple(half, half)),
      unit: fc.constantFrom("whole" as const, "half" as const),
      bonuses: fc.array(
        fc.record({
          when: fc.constantFrom(...PointsRule.shape.bonuses.unwrap().element.shape.when.options),
          param: fc.constantFrom(0, 0.5, 1, 2, 7, 20),
          points: half,
        }),
        { maxLength: 4 },
      ),
      forfeit: opt(fc.record({ winnerPoints: half, loserPoints: half, awardScore: opt(fc.tuple(fc.nat(9), fc.nat(9))) })),
    })
    .map(({ star, exact, soBonus, win, loss, ...r }) => {
      const dpb = m.shootoutAs === "draw_plus_bonus";
      const strip = <S extends { so?: number }>(s: S) => (dpb ? { ...s, so: undefined } : s);
      return PointsRule.parse({
        ...r,
        win: strip(win),
        loss: strip(loss),
        shootoutAs: m.shootoutAs,
        ...(dpb ? { soBonus } : {}),
        ...(m.reachableSetScores !== undefined ? { bySetScore: { ...exact, "*": star } } : {}),
      });
    });

/**
 * SPEC §5.3's total for one fixture (both sides), by outcome class, from the rule's own fields — a reference model typed
 * from the spec's text, never from `payout`'s code. Bonuses are left out (the property draws rules without them). The
 * set key is FIVB 6.4.3's (ruling I2): the winner's count completed to ⌈bestOf/2⌉, the loser's kept.
 */
function typedTotal(m: AnySportModule, f: Fixture, played: boolean, rule: PointsRule): [string, number] {
  const o = f.outcome;
  if (o.kind === "double_walkover") return ["double_walkover", 0];
  if (o.kind === "draw") return ["draw", 2 * rule.draw!];
  if (o.kind === "tie") return ["tie", 2 * rule.tie!];
  if (o.kind === "no_result") return ["no_result", 2 * (rule.noResult ?? 0)];
  const reason = o.kind === "award" ? (o as { reason?: string }).reason : undefined;
  const bye = o.kind === "award" && o.loser === null;
  const awardShaped = o.kind === "award" || o.method === "walkover" || o.method === "forfeit";
  const walkover = reason === "walkover" || (o.kind === "win" && o.method === "walkover");
  // P-3 "A": a walkover is never played; any other forfeit is one only while nothing is played; a bye keeps the row too.
  if ((walkover || bye || (awardShaped && !played)) && rule.forfeit !== undefined) {
    return ["forfeit_row", rule.forfeit.winnerPoints + rule.forfeit.loserPoints];
  }
  const map = rule.bySetScore;
  const setPair = (): readonly [number, number] => {
    const winner = f.pair.find((d) => d.won === 1)!;
    const key = `${Math.ceil((m.configSchema.parse(f.cfg) as { bestOf: number }).bestOf / 2)}-${winner.metrics.sets_lost!}`;
    return map![key] ?? map!["*"]!;
  };
  if (awardShaped) {
    const win = map === undefined ? rule.win.regulation : setPair()[0];
    const loss = !bye && rule.loss.unplayed !== undefined ? rule.loss.unplayed : map === undefined ? rule.loss.regulation : setPair()[1];
    return ["award", win + loss];
  }
  if (map !== undefined) return ["set", setPair()[0] + setPair()[1]];
  const d: DecidedIn = decidedInFor(m, o)!;
  // B2: a shoot-out booked draw-plus-bonus is a draw each, plus the winner's bonus (absent ⇒ 1)
  if (d === "so" && rule.shootoutAs === "draw_plus_bonus") return ["so_draw", 2 * rule.draw! + (rule.soBonus ?? 1)];
  // D9: an absent so falls back to ot, an absent ot to regulation
  const at = (side: { regulation: number; ot?: number; so?: number }): number =>
    d === "so" ? (side.so ?? side.ot ?? side.regulation) : d === "ot" ? (side.ot ?? side.regulation) : side.regulation;
  return [`win.${d}`, at(rule.win) + at(rule.loss)];
}

const sportArb = fc.constantFrom(...builtinModules);
const caseArb = sportArb.chain((m) =>
  fc.record({
    m: fc.constant(m),
    rule: ruleFor(m),
    picks: fc.array(fc.record({ i: fc.nat(), played: fc.boolean() }), { minLength: 1, maxLength: 12 }),
  }),
);

describe("payout properties (rule 10)", () => {
  it("premise: every sport's corpus records decided fixtures with league pairs (counted)", () => {
    expect(FIXTURES.size).toBe(SPORTS);
    for (const [key, fixtures] of FIXTURES) expect(fixtures.length, key).toBeGreaterThan(0);
  });

  it("points conservation: Σ row points == Σ per-fixture payouts, and a double walkover adds 0 (random rules × real folds, counted)", () => {
    let checked = 0;
    let doubleWalkovers = 0;
    fc.assert(
      fc.property(caseArb, ({ m, rule, picks }) => {
        const fixtures = FIXTURES.get(m.key)!;
        const paid = picks.map(({ i, played }) => {
          const f = fixtures[i % fixtures.length]!;
          const out = payout(f.outcome, decidedInFor(m, f.outcome), f.pair, played, rule, m.awardScoreKeys, setsToWinOf(m, f.cfg));
          if (f.outcome.kind === "double_walkover") {
            expect(out[0].points + out[1].points).toBe(0);
            doubleWalkovers++;
          }
          checked++;
          return out;
        });
        const entrants = [...new Set(paid.flatMap(([h, a]) => [h.entrantId, a.entrantId]))];
        const rows = foldResults(entrants, paid);
        const perFixture = paid.reduce((s, [h, a]) => s + h.points + a.points, 0);
        expect(rows.reduce((s, r) => s + r.points, 0)).toBeCloseTo(perFixture, 9);
      }),
      { numRuns: 300, seed: 20261024 },
    );
    expect(checked).toBeGreaterThan(0);
    expect(doubleWalkovers).toBeGreaterThan(0);
  });

  it("per-fixture total: each fixture pays both sides what SPEC §5.3 types for its outcome class, from the rule's own fields (random rules × real folds, every class reached, counted)", () => {
    const classes = new Map<string, number>();
    fc.assert(
      fc.property(caseArb, ({ m, rule: drawn, picks }) => {
        const rule = PointsRule.parse({ ...drawn, bonuses: [] });
        const fixtures = FIXTURES.get(m.key)!;
        for (const { i, played } of picks) {
          const f = fixtures[i % fixtures.length]!;
          const out = payout(f.outcome, decidedInFor(m, f.outcome), f.pair, played, rule, m.awardScoreKeys, setsToWinOf(m, f.cfg));
          const [cls, want] = typedTotal(m, f, played, rule);
          expect(out[0].points + out[1].points, `${m.key} ${cls} ${JSON.stringify(f.outcome)}`).toBe(want);
          classes.set(cls, (classes.get(cls) ?? 0) + 1);
        }
      }),
      { numRuns: 300, seed: 20261026 },
    );
    // Anti-vacuity: every outcome class SPEC §5.3 types, each met on a real fold. The corpora hold no bye and no win
    // decided in overtime (W2d T1's deferred real-fold witness; payout-decided-in-db.test.ts drives one through the fold).
    expect([...classes.keys()].sort()).toEqual(["award", "double_walkover", "draw", "forfeit_row", "no_result", "set", "so_draw", "tie", "win.regulation", "win.so"]);
    for (const [cls, n] of classes) expect(n, cls).toBeGreaterThan(0);
  });

  it("payout symmetry: swapping home and away swaps the paid pair (random rules × real folds, counted)", () => {
    let checked = 0;
    fc.assert(
      fc.property(caseArb, ({ m, rule, picks }) => {
        const fixtures = FIXTURES.get(m.key)!;
        for (const { i, played } of picks) {
          const f = fixtures[i % fixtures.length]!;
          const d = decidedInFor(m, f.outcome);
          const [h, a] = payout(f.outcome, d, f.pair, played, rule, m.awardScoreKeys, setsToWinOf(m, f.cfg));
          const swapped = payout(f.outcome, d, [f.pair[1], f.pair[0]], played, rule, m.awardScoreKeys, setsToWinOf(m, f.cfg));
          expect(swapped).toEqual([a, h]);
          checked++;
        }
      }),
      { numRuns: 300, seed: 20261025 },
    );
    expect(checked).toBeGreaterThan(0);
  });
});
