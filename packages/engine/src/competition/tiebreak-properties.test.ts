// W2d Task 4 — properties of the tie-break cascade (TEST-STRATEGY rule 10). Each property counts what it checked and a
// count of zero fails: a generator that silently stopped producing ties would otherwise pass every property vacuously.
//
// The generator is sport-neutral on purpose: one delta pair carries every ledger the cascade reads (sets, rally points,
// goals, penalty-corner goals, overtime wins), so a random cascade drawn from EVERY key — the plain keys, h2h blocks with
// and without a modifier, `direct`, `h2h_two` — always has data to read. The sport-specific readings are pinned in
// tiebreak-keys-w2d.test.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EntrantId, StandingsDelta } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { rankStandings, type RankContext, type RankingResult } from "./tiebreakers.ts";

const PLAIN: readonly TiebreakerKey[] = [
  "points", "wins", "diff", "for", "nrr", "set_ratio", "game_ratio", "board_ratio", "point_ratio", "buchholz",
  "buchholz_cut1", "sberger", "fair_play", "seed", "set_diff", "point_diff", "matches_played", "field_goals", "direct",
  "h2h_two",
];
const BLOCK: readonly TiebreakerKey[] = ["h2h_points", "h2h_diff", "h2h_for", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio"];
const MODIFIERS = ["h2h_reapply", "h2h_exclusion"] as const;
const IDS: readonly EntrantId[] = ["E0", "E1", "E2", "E3", "E4", "E5", "E6"];

interface Meeting { a: number; b: number; hs: number; as: number; hp: number; ap: number; hpc: number; apc: number; ot: boolean }

function side(id: EntrantId, won: number, drawn: number, lost: number, f: number, g: number, p: number, q: number, pc: number, ot: boolean): StandingsDelta {
  return {
    entrantId: id, played: 1, won, drawn, lost, points: 3 * won + drawn,
    metrics: { sets_won: f, sets_lost: g, points_won: p, points_lost: q, gf: f, ga: g, gd: f - g, goals_pc: Math.min(pc, f), ...(won === 1 && ot ? { won_ot: 1 } : {}) },
  };
}
function resultOf(m: Meeting): FixtureResult {
  const [hw, d, aw] = [m.hs > m.as ? 1 : 0, m.hs === m.as ? 1 : 0, m.as > m.hs ? 1 : 0];
  return [
    side(IDS[m.a] as EntrantId, hw, d, aw, m.hs, m.as, m.hp, m.ap, m.hpc, m.ot),
    side(IDS[m.b] as EntrantId, aw, d, hw, m.as, m.hs, m.ap, m.hp, m.apc, m.ot),
  ];
}

interface Scenario { n: number; meetings: Meeting[]; seeded: boolean[]; gamePoints: boolean; regulation: boolean }
const scenario: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: 7 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    meetings: fc.array(
      fc.record({
        a: fc.nat(n - 1), b: fc.nat(n - 1), hs: fc.integer({ min: 0, max: 3 }), as: fc.integer({ min: 0, max: 3 }),
        hp: fc.integer({ min: 0, max: 40 }), ap: fc.integer({ min: 0, max: 40 }), hpc: fc.nat(2), apc: fc.nat(2), ot: fc.boolean(),
      }).filter((m) => m.a !== m.b),
      { maxLength: n * (n - 1) },
    ),
    seeded: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    gamePoints: fc.boolean(),
    regulation: fc.boolean(),
  }),
);
/** Any valid order: plain keys, and h2h blocks each optionally closed by ONE modifier. No `lots` (its draw is Task 5's). */
const cascadeArb: fc.Arbitrary<TiebreakerKey[]> = fc
  .array(
    fc.oneof(
      fc.constantFrom(...PLAIN).map((k) => [k]),
      fc.record({ keys: fc.array(fc.constantFrom(...BLOCK), { minLength: 1, maxLength: 3 }), mod: fc.constantFrom(null, ...MODIFIERS) })
        .map(({ keys, mod }): TiebreakerKey[] => (mod === null ? keys : [...keys, mod])),
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((tokens) => tokens.flat());

const gamePointOf = (d: StandingsDelta): number => (d.won === 1 ? 2 : d.drawn === 1 ? 1 : 0);

function rank(s: Scenario, cascade: readonly TiebreakerKey[], results: readonly FixtureResult[], rowOrder?: readonly number[]): RankingResult {
  const ids = IDS.slice(0, s.n);
  const rows = foldResults(ids, results);
  const ordered = rowOrder === undefined ? rows : rowOrder.map((i) => rows[i] as StandingsRow);
  const ctx: RankContext = {
    cascade, results, rngSeed: 7,
    seeds: new Map(ids.flatMap((id, i) => (s.seeded[i] === true ? [[id, i + 1] as const] : []))),
    ...(s.gamePoints ? { gamePoints: (r: FixtureResult) => [gamePointOf(r[0]), gamePointOf(r[1])] as const } : {}),
    ...(s.regulation ? { winsCount: "regulation" as const } : {}),
  };
  return rankStandings(ordered, ctx);
}

/** Order-insensitive view of a ranking: everything a reader sees, with each `with` list sorted. */
function view(r: RankingResult): unknown {
  return {
    rows: r.rows.map((x) => [x.entrantId, x.rank, x.tieBreak?.key ?? null, [...(x.tieBreak?.with ?? [])].sort(), x.tieBreak?.note ?? null, x.tieUnbroken === true, x.metrics["sberger"] ?? null]),
    lots: r.lotsGroups,
  };
}

/** A permutation of 0..n-1 driven by fast-check's own keys (stable sort on random keys). */
const permutation = (keys: readonly number[], n: number): number[] =>
  Array.from({ length: n }, (_, i) => i).sort((i, j) => (keys[i] ?? 0) - (keys[j] ?? 0) || i - j);

describe("W2d T4 — tie-break cascade properties (rule 10)", () => {
  it("permutation invariance: shuffled rows and fixtures, either side at home, give the same ranking", () => {
    let checked = 0;
    let tied = 0;
    fc.assert(
      fc.property(scenario, cascadeArb, fc.array(fc.nat(), { minLength: 64, maxLength: 64 }), fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }), (s, cascade, keys, flips) => {
        const results = s.meetings.map(resultOf);
        const base = rank(s, cascade, results);
        const fixtureOrder = permutation(keys.slice(7), results.length);
        const shuffled = fixtureOrder.map((i, k) => {
          const r = results[i] as FixtureResult;
          return flips[k] === true ? ([r[1], r[0]] as FixtureResult) : r;
        });
        const again = rank(s, cascade, shuffled, permutation(keys.slice(0, 7), s.n));
        expect(view(again)).toEqual(view(base));
        checked++;
        if (base.rows.some((x) => x.tieBreak !== undefined)) tied++;
      }),
      { numRuns: 300, seed: 20261024 },
    );
    expect(checked).toBe(300);
    // The property saw real ties, not only tables the first key already ordered.
    expect(tied).toBeGreaterThan(100);
  });

  it("appending a key never reorders entrants the prefix already separated", () => {
    // Every key is appended to every prefix. Half the prefixes end in a modifier-free h2h block, so an appended h2h key
    // EXTENDS that block (one pass over a longer block) — the case a single random draw would rarely reach.
    const EXTRAS: readonly TiebreakerKey[] = [...PLAIN, ...BLOCK, "lots"];
    const openBlock = fc.array(fc.constantFrom(...BLOCK), { minLength: 1, maxLength: 2 });
    const prefixArb = fc.oneof(cascadeArb, fc.tuple(fc.array(fc.constantFrom(...PLAIN), { maxLength: 2 }), openBlock).map(([head, block]) => [...head, ...block]));
    let checked = 0;
    let pairs = 0;
    let extended = 0;
    fc.assert(
      fc.property(scenario, prefixArb, (s, prefix) => {
        const results = s.meetings.map(resultOf);
        const p = rank(s, prefix, results);
        for (const extra of EXTRAS) {
          const q = rank(s, [...prefix, extra], results);
          const rankInQ = new Map(q.rows.map((x) => [x.entrantId, x.rank ?? 0]));
          p.rows.forEach((a, i) => {
            for (const b of p.rows.slice(i + 1)) {
              const residual = a.tieUnbroken === true && b.tieUnbroken === true && (a.tieBreak?.with ?? []).includes(b.entrantId);
              if (residual) continue;
              expect((rankInQ.get(a.entrantId) ?? 0) < (rankInQ.get(b.entrantId) ?? 0), `${prefix.join(",")} + ${extra}: ${a.entrantId} over ${b.entrantId}`).toBe(true);
              pairs++;
              if (BLOCK.includes(extra) && BLOCK.includes(prefix[prefix.length - 1] as TiebreakerKey)) extended++;
            }
          });
          checked++;
        }
      }),
      { numRuns: 150, seed: 20261025 },
    );
    expect(checked).toBe(150 * EXTRAS.length);
    expect(pairs).toBeGreaterThan(150 * EXTRAS.length);
    // Pairs checked where the appended key extended the prefix's own trailing block.
    expect(extended).toBeGreaterThan(50);
    // 150 runs × 28 appended keys: well past vitest's 5 s default on a loaded runner.
  }, 60_000);

  it("re-application and exclusion terminate: one mini-table per class at most n − 1 times per step (random classes)", () => {
    // A head-to-head step visits a laminar family of tied classes (each restart is on a strictly smaller set, siblings
    // are disjoint), and a laminar family of sets of size ≥ 2 over n entrants has at most n − 1 members. Each visit
    // reads the fixtures once. So a cascade of k steps reads them at most k·(n − 1) times, plus once for an SB ledger.
    let checked = 0;
    let deep = 0;
    const blockFirst = fc.record({ keys: fc.array(fc.constantFrom(...BLOCK), { minLength: 1, maxLength: 3 }), mod: fc.constantFrom(...MODIFIERS) });
    fc.assert(
      fc.property(scenario, fc.oneof(blockFirst.map(({ keys, mod }): TiebreakerKey[] => [...keys, mod, "lots"]), cascadeArb), (s, cascade) => {
        const results = s.meetings.map(resultOf);
        let reads = 0;
        const counted = new Proxy(results, {
          get(target, prop, receiver) {
            if (prop === "filter") reads++;
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });
        const ranked = rank(s, cascade, counted);
        expect(ranked.rows.map((x) => x.rank)).toEqual(Array.from({ length: s.n }, (_, i) => i + 1));
        expect(reads, `${cascade.join(",")} n=${s.n}`).toBeLessThanOrEqual(cascade.length * (s.n - 1) + 1);
        if (reads > 1) deep++;
        checked++;
      }),
      { numRuns: 400, seed: 20261026 },
    );
    expect(checked).toBe(400);
    // Some runs restarted on a sub-class (more than one read), so the bound was exercised, not only the root pass.
    expect(deep).toBeGreaterThan(20);
  });
});
