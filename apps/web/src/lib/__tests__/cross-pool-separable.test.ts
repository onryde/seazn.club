// W5 app PR B D-B2-2: `crossPoolSeparable` answers the engine's own question - does `crossPoolDraw` find an ordering, or refuse
// `pool_separation_impossible`? - before the engine's exhaustive search. Every expected answer here is the ENGINE's, read by calling
// `crossPoolDraw` on the same field (never the oracle's own reasoning), over the whole space the builder offers: pools 2-8, Top
// 2-32, every set of pools a partial tier can come from, on a single elimination and a stepladder, plus every page playoff of four.
// The six refused fields whose search outgrows 10^7 orderings are not asked of the engine here (it took 196 s on one); they are
// pinned by the rulebook's own arithmetic in usecases/__tests__/cross-pool-draw-time.test.ts. Single-sport on purpose: the draw
// reads pools, tiers and a seed only.
import { describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { crossPoolDraw, type FirstRoundShape, type PooledSeed } from "@seazn/engine/scheduling";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { crossPoolSeparable, firstRoundPairs } from "@/lib/cross-pool-separable";

const POOL_KEYS = "ABCDEFGH";

function subsets<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [head!, ...s]), ...subsets(rest, k)];
}

/** `pools` pools; `full` whole tiers (one place per pool), then one partial tier from `partial`. `tied` marks every seed after the
 *  first of each tier level with the one before it (a `tied` run the stored seed shuffles). */
function field(pools: number, full: number, partial: readonly string[], tied = false): PooledSeed[] {
  const keys = [...POOL_KEYS.slice(0, pools)];
  const tiers = Array.from({ length: full }, () => keys).concat(partial.length > 0 ? [[...partial]] : []);
  return tiers.flatMap((members, t) => members.map((pool, i) => ({ entrantId: `${pool}${t + 1}`, pool, tier: t + 1, ...(tied && i > 0 ? { tied: true } : {}) })));
}

/** The engine's answer: true (an ordering), false (refused pool_separation_impossible); anything else is rethrown. */
function engine(seeded: PooledSeed[], shape: FirstRoundShape, seed: number): boolean {
  try {
    crossPoolDraw(seeded, shape, seed);
    return true;
  } catch (e) {
    if (e instanceof EngineError && (e.data as { reason?: unknown } | undefined)?.reason === "pool_separation_impossible") return false;
    throw e;
  }
}

/** The search space the engine's step 2 walks: the product of every later tier's permutations. */
function searchSpace(seeded: readonly PooledSeed[]): number {
  const sizes = new Map<number, number>();
  for (const s of seeded) if (s.tier > 1) sizes.set(s.tier, (sizes.get(s.tier) ?? 0) + 1);
  let space = 1;
  for (const n of sizes.values()) for (let k = 2; k <= n; k++) space *= k;
  return space;
}

describe("crossPoolSeparable: the engine's own answer, before its search (D-B2-2)", () => {
  it("agrees with crossPoolDraw on every field the builder offers, single elimination and stepladder", () => {
    let agreed = 0;
    let refused = 0;
    let drawn = 0;
    let slowRefusals = 0;
    let maxNodes = 0;
    const disagreements: string[] = [];
    for (const shape of ["single_elim", "stepladder"] as const) {
      for (let pools = FORMAT_BOUNDS.pools.min; pools <= FORMAT_BOUNDS.pools.max; pools++) {
        for (let top = FORMAT_BOUNDS.qualify.min; top <= FORMAT_BOUNDS.qualify.max; top++) {
          const full = Math.floor(top / pools);
          if (full < 1) continue;
          for (const partial of subsets([...POOL_KEYS.slice(0, pools)], top % pools)) {
            const seeded = field(pools, full, partial);
            const oracle = crossPoolSeparable(seeded, shape, 7);
            maxNodes = Math.max(maxNodes, oracle.nodes);
            if (oracle.separable === false && searchSpace(seeded) > 10_000_000) {
              slowRefusals++;
              continue;
            }
            const answer = engine(seeded, shape, 7);
            if (answer) drawn++;
            else refused++;
            if (oracle.separable === answer) agreed++;
            else disagreements.push(`${shape} ${pools} pools Top ${top} [${partial.join("")}]: engine ${answer}, oracle ${oracle.separable}`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
    // anti-vacuity: both answers met, in numbers (3820 fields asked; 23 refused; 6 slow refusals left to the time test)
    expect({ agreed, refused: refused > 0, drawn: drawn > 0, slowRefusals }).toEqual({ agreed: refused + drawn, refused: true, drawn: true, slowRefusals: 6 });
    expect(agreed, "anti-vacuity: the whole space").toBeGreaterThan(3000);
    // The search behind each answer is a handful of places, never a tier's permutations (the engine's walks up to 10^9 here).
    expect(maxNodes, "the oracle's own search stays small").toBeLessThan(100);
  });

  it("agrees on two single-seat best-Nth tiers that can face each other (review m-2): winners, one best 2nd, one best 3rd", () => {
    // The builder offers one partial tier only, so its two tight tiers never meet in round one; an API field can: every pool's winner,
    // then a best 2nd from pool X and a best 3rd from pool Y. On a stepladder the last two seeds always meet (the 2nd's and the 3rd's
    // tiers face each other); in a single elimination they do at 3 pools (5 into 8 plays only 4 v 5). Each answer is the engine's.
    let checked = 0;
    let facing = 0;
    const facingAnswers = new Set<boolean>();
    for (const shape of ["single_elim", "stepladder"] as const) {
      for (let pools = 2; pools <= 8; pools++) {
        const keys = [...POOL_KEYS.slice(0, pools)];
        for (const x of keys) {
          for (const y of keys) {
            const seeded: PooledSeed[] = [...keys.map((pool) => ({ entrantId: `${pool}1`, pool, tier: 1 })), { entrantId: `${x}2`, pool: x, tier: 2 }, { entrantId: `${y}3`, pool: y, tier: 3 }];
            const answer = engine(seeded, shape, 7);
            const oracle = crossPoolSeparable(seeded, shape, 7);
            expect(oracle.separable, `${shape} ${pools} pools, best 2nd ${x}, best 3rd ${y}`).toBe(answer);
            const n = seeded.length;
            if (firstRoundPairs(shape, n).some(([a, b]) => Math.min(a, b) === n - 2 && Math.max(a, b) === n - 1)) {
              facing++;
              facingAnswers.add(answer);
              expect(oracle.places, `${shape} ${pools} pools: both tight places searched`).toBe(2);
            }
            checked++;
          }
        }
      }
    }
    expect(checked, "anti-vacuity: every pair of pools, both shapes").toBe(2 * [2, 3, 4, 5, 6, 7, 8].reduce((t, p) => t + p * p, 0));
    // The branch under test: two tight tiers facing each other, met with both answers (A2 v A3 refused; A2 v B3 drawn).
    expect(facing, "fields whose two tight tiers meet in round one").toBeGreaterThan(0);
    expect([...facingAnswers].sort(), "both answers met where they meet").toEqual([false, true]);
  });

  it("agrees where the stored seed decides it: tied runs, seeds 1-6, every field of up to 16 qualifiers", () => {
    let checked = 0;
    const bothAnswers = new Set<boolean>();
    for (const shape of ["single_elim", "stepladder"] as const) {
      for (let pools = 2; pools <= 8; pools++) {
        for (let top = 2; top <= 16; top++) {
          const full = Math.floor(top / pools);
          if (full < 1) continue;
          for (const partial of subsets([...POOL_KEYS.slice(0, pools)], top % pools)) {
            for (let seed = 1; seed <= 6; seed++) {
              const seeded = field(pools, full, partial, true);
              const answer = engine(seeded, shape, seed);
              expect(crossPoolSeparable(seeded, shape, seed).separable, `${shape} ${pools} pools Top ${top} [${partial.join("")}] seed ${seed}`).toBe(answer);
              bothAnswers.add(answer);
              checked++;
            }
          }
        }
      }
    }
    expect(checked, "anti-vacuity").toBeGreaterThan(1000);
    expect([...bothAnswers].sort(), "both answers met").toEqual([false, true]);
  });

  it("RB5-D10 turns on the seed: 2 pools Top 3 with the winners level - some seeds refuse, some draw, each as the engine says", () => {
    const answers = new Map<boolean, number>();
    for (let seed = 1; seed <= 40; seed++) {
      const seeded: PooledSeed[] = [
        { entrantId: "a1", pool: "A", tier: 1 },
        { entrantId: "b1", pool: "B", tier: 1, tied: true },
        { entrantId: "b2", pool: "B", tier: 2 },
      ];
      const answer = engine(seeded, "single_elim", seed);
      expect(crossPoolSeparable(seeded, "single_elim", seed).separable, `seed ${seed}`).toBe(answer);
      answers.set(answer, (answers.get(answer) ?? 0) + 1);
    }
    expect(answers.get(true), "some seeds put A1 on seed 2").toBeGreaterThan(0);
    expect(answers.get(false), "some seeds put B1 on seed 2").toBeGreaterThan(0);
  });

  it("every page playoff of four agrees (1v2 and 3v4), level winners or not", () => {
    const fields: PooledSeed[][] = [
      field(2, 2, []),
      field(4, 1, []),
      ...subsets([..."ABC"], 1).map((p) => field(3, 1, p)),
      field(2, 2, [], true),
      ...subsets([..."ABC"], 1).map((p) => field(3, 1, p, true)),
    ];
    let checked = 0;
    for (const seeded of fields) {
      for (let seed = 1; seed <= 4; seed++) {
        expect(crossPoolSeparable(seeded, "page_playoff", seed).separable, JSON.stringify(seeded.map((s) => s.entrantId))).toBe(engine(seeded, "page_playoff", seed));
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(fields.length * 4);
  });

  it("an input the engine refuses before searching is left to it (null): empty, a page playoff not of four, a tier out of order, a bad seed", () => {
    const cases: [string, PooledSeed[], FirstRoundShape, number][] = [
      ["no qualifiers", [], "single_elim", 1],
      ["a page playoff of three", field(3, 1, []), "page_playoff", 1],
      ["tiers out of order", [{ entrantId: "b2", pool: "B", tier: 2 }, { entrantId: "a1", pool: "A", tier: 1 }], "single_elim", 1],
      ["a tied seed opening its tier", [{ entrantId: "a1", pool: "A", tier: 1, tied: true }, { entrantId: "b1", pool: "B", tier: 1 }], "single_elim", 1],
      ["one entrant twice", [{ entrantId: "a1", pool: "A", tier: 1 }, { entrantId: "a1", pool: "B", tier: 1 }], "single_elim", 1],
      ["a draw seed that is no integer", field(2, 1, []), "single_elim", 1.5],
    ];
    for (const [name, seeded, shape, seed] of cases) {
      expect(crossPoolSeparable(seeded, shape, seed).separable, name).toBeNull();
      expect(() => crossPoolDraw(seeded, shape, seed), `${name}: the engine refuses it on input`).toThrow(EngineError);
    }
    expect(cases.length, "anti-vacuity").toBe(6);
  });

  it("a tier holding one pool twice breaks the reduction's premise and is named, never answered", () => {
    const seeded: PooledSeed[] = [
      { entrantId: "a1", pool: "A", tier: 1 },
      { entrantId: "b1", pool: "B", tier: 1 },
      { entrantId: "a2", pool: "A", tier: 2 },
      { entrantId: "a3", pool: "A", tier: 2 },
    ];
    expect(() => crossPoolSeparable(seeded, "single_elim", 1)).toThrow(/tier 2 holds pool A twice/);
  });

  it("firstRoundPairs are the engine's: a single elimination's real pairs from the fold (byes dropped), a stepladder's last two", () => {
    // As pairs of seeds, either order: a 4-draw is 1v4 and 2v3; a 3-draw gives seed 1 a bye; a 5-draw in 8 plays only 4v5.
    const pairs = (shape: FirstRoundShape, n: number) => firstRoundPairs(shape, n).map(([a, b]) => [Math.min(a, b) + 1, Math.max(a, b) + 1]).sort((x, y) => x[0]! - y[0]!);
    expect(pairs("single_elim", 4)).toEqual([[1, 4], [2, 3]]);
    expect(pairs("single_elim", 3)).toEqual([[2, 3]]);
    expect(pairs("single_elim", 5)).toEqual([[4, 5]]);
    expect(pairs("stepladder", 5)).toEqual([[4, 5]]);
    expect(pairs("page_playoff", 4)).toEqual([[1, 2], [3, 4]]);
  });
});
