// W2d Task 2 — properties of `payout` (rule 10, fast-check) over every sport's REAL recorded folds (the golden corpora:
// the recorded outcome and the module's own league delta pair), under random outcome-keyed rules.
//  - points conservation: Σ row points of the folded table == Σ per-fixture payouts; a double walkover adds 0.
//  - payout symmetry: swapping home and away swaps the paid pair.
// Anti-vacuity: every property reports how many fixtures it checked, and zero checked is a failure.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MatchOutcome } from "../core/types.ts";
import { FOLD_EPOCH } from "../sport/fold-epoch.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { readCorpus } from "../testkit/golden.ts";
import { PointsRule, decidedInFor, foldResults, payout, type FixtureResult } from "./index.ts";

const SPORTS = Object.keys(FOLD_EPOCH).length;
type Fixture = { outcome: MatchOutcome; pair: FixtureResult };

/** Each sport's decided corpus fixtures with a league pair (an undecided stream has no pair and is never paid). */
const FIXTURES: ReadonlyMap<string, readonly Fixture[]> = new Map(
  builtinModules.map((m) => [
    m.key,
    readCorpus(m.key).streams.flatMap((s) => {
      const raw: unknown = JSON.parse(s.outcome);
      const deltas = JSON.parse(s.deltas) as { league?: FixtureResult | null };
      return raw === null || deltas.league == null ? [] : [{ outcome: MatchOutcome.parse(raw), pair: deltas.league }];
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
          const out = payout(f.outcome, decidedInFor(m, f.outcome), f.pair, played, rule, m.awardScoreKeys);
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

  it("payout symmetry: swapping home and away swaps the paid pair (random rules × real folds, counted)", () => {
    let checked = 0;
    fc.assert(
      fc.property(caseArb, ({ m, rule, picks }) => {
        const fixtures = FIXTURES.get(m.key)!;
        for (const { i, played } of picks) {
          const f = fixtures[i % fixtures.length]!;
          const d = decidedInFor(m, f.outcome);
          const [h, a] = payout(f.outcome, d, f.pair, played, rule, m.awardScoreKeys);
          const swapped = payout(f.outcome, d, [f.pair[1], f.pair[0]], played, rule, m.awardScoreKeys);
          expect(swapped).toEqual([a, h]);
          checked++;
        }
      }),
      { numRuns: 300, seed: 20261025 },
    );
    expect(checked).toBeGreaterThan(0);
  });
});
