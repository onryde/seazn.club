// W5 app PR B Task 5 (G3, N6/K23): `pooledSeeds` - which seeds of a knockout fed from groups are `tied` across pools. "Level" is
// the rulebook's (RB5-D3, design §5.3): equal on EVERY key of the source's cross-group order, the same `played`. The rows here are
// built level or split BY CONSTRUCTION on those keys; the group_rank cases drive the engine's own `crossGroupOrder` (never a stub
// that hands back `tieBreak.with`). Single-sport on purpose: the rows are sport-free table rows (points, diff, for, wins).
import { describe, expect, it } from "vitest";
import { PRE_W2D_CROSS_GROUP, type CrossGroupRules, type SourceTables, type StandingsRow } from "@seazn/engine/competition";
import { crossPoolDraw } from "@seazn/engine/scheduling";
import { pooledSeeds, type CrossPoolEntry } from "@/lib/cross-pool-ties";

const row = (entrantId: string, points: number, o: { diff?: number; for?: number; played?: number; won?: number } & Partial<StandingsRow> = {}): StandingsRow => {
  const { diff = 0, for: f = 0, played = 3, won = Math.floor(points / 3), ...rest } = o;
  return { entrantId, played, won, drawn: 0, lost: played - won, points, metrics: { diff, for: f }, ...rest };
};
const gr = (entrantId: string, pool: string, rank: number, sourceIndex = 0): CrossPoolEntry => ({ entrantId, sourceIndex, pool, descriptor: { kind: "group_rank", rank } });
const bn = (entrantId: string, pool: string, nth: number, levelWith: string[] = []): CrossPoolEntry => ({ entrantId, sourceIndex: 0, pool, descriptor: { kind: "best_nth", nth }, basis: { levelWith } });
const tables = (pools: Record<string, StandingsRow[]>, order?: CrossGroupRules["order"]): SourceTables[] => [
  { pools: Object.entries(pools).map(([pool, rows]) => ({ pool, rows: rows.map((r, i) => ({ ...r, rank: i + 1 })) })), ...(order ? { crossGroup: { order } } : {}) },
];
const tiedOf = (seeds: ReturnType<typeof pooledSeeds>) => seeds?.filter((s) => s.tied === true).map((s) => s.entrantId);

describe("pooledSeeds: the field crossPoolDraw is handed (N6/K23)", () => {
  it("not a pooled field -> null, so the caller keeps today's placement and never calls crossPoolDraw", () => {
    const t = tables({ A: [row("a1", 9), row("a2", 6)], B: [row("b1", 9), row("b2", 6)] });
    const cases: [string, CrossPoolEntry[]][] = [
      ["empty field", []],
      ["one pool (a one-pool group writes its pool id, K23)", [gr("a1", "A", 1), gr("a2", "A", 2)]],
      ["a league source: rank-range entries carry no pool", [{ entrantId: "a1", sourceIndex: 0, descriptor: { kind: "rank_range", rank: 1 } }, { entrantId: "b1", sourceIndex: 0, descriptor: { kind: "rank_range", rank: 2 } }]],
      ["an entry with no pool", [gr("a1", "A", 1), { entrantId: "b1", sourceIndex: 0, descriptor: { kind: "group_rank", rank: 1 } }]],
      ["two sources", [gr("a1", "A", 1), gr("b1", "B", 1, 1)]],
    ];
    for (const [name, entries] of cases) expect(pooledSeeds(entries, t), name).toBeNull();
    expect(cases.length, "anti-vacuity").toBe(5);
  });

  it("two pools: pool and tier per seed, nothing tied when a key splits every tier", () => {
    const t = tables({ A: [row("a1", 9), row("a2", 6)], B: [row("b1", 7), row("b2", 4)] });
    expect(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), gr("a2", "A", 2), gr("b2", "B", 2)], t)).toEqual([
      { entrantId: "a1", pool: "A", tier: 1 },
      { entrantId: "b1", pool: "B", tier: 1 },
      { entrantId: "a2", pool: "A", tier: 2 },
      { entrantId: "b2", pool: "B", tier: 2 },
    ]);
  });
});

describe("pooledSeeds: tied = level across pools (G3), group_rank tiers by the engine's crossGroupOrder", () => {
  it("a level pair: the SECOND seed is tied, the first never", () => {
    const t = tables({ A: [row("a1", 9, { diff: 4, for: 6 })], B: [row("b1", 9, { diff: 4, for: 6 })] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], t))).toEqual(["b1"]);
  });

  it("a pair split by ANY key of the order is not tied (points level, diff splits; then for splits)", () => {
    const byDiff = tables({ A: [row("a1", 9, { diff: 4, for: 6 })], B: [row("b1", 9, { diff: 3, for: 6 })] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], byDiff))).toEqual([]);
    const byFor = tables({ A: [row("a1", 9, { diff: 4, for: 6 })], B: [row("b1", 9, { diff: 4, for: 5 })] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], byFor))).toEqual([]);
  });

  it("level on every key IS tied even when the source's order ends in lots (lots decide who qualifies, the seed where they sit)", () => {
    const t = tables({ A: [row("a1", 9, { diff: 4, for: 6 })], B: [row("b1", 9, { diff: 4, for: 6 })] }, ["points", "diff", "lots"]);
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], t))).toEqual(["b1"]);
  });

  it("rows whose played differ are never level, whatever the keys say", () => {
    const t = tables({ A: [row("a1", 9, { diff: 4, for: 6, played: 4 })], B: [row("b1", 9, { diff: 4, for: 6, played: 3 })] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], t))).toEqual([]);
  });

  it("only ADJACENT level seeds link: A1 and C1 level, B1 between them not -> nobody tied", () => {
    const t = tables({ A: [row("a1", 9)], B: [row("b1", 12)], C: [row("c1", 9)] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), gr("c1", "C", 1)], t))).toEqual([]);
    // differential: B1 level too -> the whole tier is one run
    const all = tables({ A: [row("a1", 9)], B: [row("b1", 9)], C: [row("c1", 9)] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), gr("c1", "C", 1)], all))).toEqual(["b1", "c1"]);
  });

  it("a pool's own trace (its lots-locked, flagged rows) is stripped before the cross-pool ranking", () => {
    // Each winner won her pool on lots: the pool fold left `rankLocked`, `tieUnbroken` and `tieBreak` (naming her POOL-mate).
    const trace = (mate: string) => ({ rankLocked: true, tieUnbroken: true, tieBreak: { key: "lots", with: [mate] } });
    const t = tables({ A: [row("a1", 9, trace("a2")), row("a2", 9, trace("a1"))], B: [row("b1", 9, trace("b2")), row("b2", 9, trace("b1"))] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], t)), "level across pools").toEqual(["b1"]);
    const split = tables({ A: [row("a1", 12, trace("a2")), row("a2", 12, trace("a1"))], B: [row("b1", 9, trace("b2")), row("b2", 9, trace("b1"))] });
    expect(tiedOf(pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1)], split)), "split by points across pools").toEqual([]);
  });

  it("a tier's first seed is never tied to the tier before it, and the engine accepts every link made (no tie_link_invalid)", () => {
    // Everyone level on every key: winners tier links, runners-up tier links, but A2 (tier 2's first) does not link back to B1.
    const t = tables({ A: [row("a1", 6), row("a2", 6)], B: [row("b1", 6), row("b2", 6)] });
    const seeds = pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), gr("a2", "A", 2), gr("b2", "B", 2)], t)!;
    expect(tiedOf(seeds)).toEqual(["b1", "b2"]);
    expect(seeds[0]!.tied, "the first seed").toBeUndefined();
    expect(seeds[2]!.tied, "tier 2's first seed").toBeUndefined();
    let drawn = 0;
    for (const seed of [1, 2, 3, 99]) {
      expect(() => crossPoolDraw(seeds, "single_elim", seed)).not.toThrow();
      drawn++;
    }
    expect(drawn).toBe(4);
    // two best-Nth tiers: a levelWith naming the previous TIER's seed never links across it (the engine would refuse the link)
    // (winners split by points here: a tied winners' run could put B1 first, and B1 v B3 in round one has no way out - refused)
    const split = tables({ A: [row("a1", 9), row("a2", 6)], B: [row("b1", 6), row("b2", 6)] });
    const two = pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), bn("a2", "A", 2), bn("b3", "B", 3, ["a2"])], split)!;
    expect(two.map((s) => s.tier)).toEqual([1, 1, 2, 3]);
    expect(two[3]!.tied, "tier 3's first seed").toBeUndefined();
    expect(() => crossPoolDraw(two, "single_elim", 7)).not.toThrow();
  });

  it("a single-entrant tier has nothing to link", () => {
    const t = tables({ A: [row("a1", 9), row("a2", 6)], B: [row("b1", 9), row("b2", 3)] });
    const seeds = pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), bn("a2", "A", 2, ["b1"])], t)!;
    expect(seeds.map((s) => s.tier)).toEqual([1, 1, 2]);
    expect(seeds[2]!.tied, "tier 2 has one seed; b1 named in levelWith sits in tier 1").toBeUndefined();
  });
});

describe("pooledSeeds: best_nth tiers read the engine's basis.levelWith", () => {
  const t = tables({ A: [row("a1", 9), row("a2", 6)], B: [row("b1", 9), row("b2", 6)], C: [row("c1", 9), row("c2", 6)] });
  it("seed i is tied iff seed i-1 is in its levelWith", () => {
    const seeds = pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), gr("c1", "C", 1), bn("a2", "A", 2, ["b2"]), bn("b2", "B", 2, ["a2"])], t)!;
    // C1 is level with B1 by construction (9 v 9, same played): the group_rank tier links too.
    expect(tiedOf(seeds)).toEqual(["b1", "c1", "b2"]);
    const none = pooledSeeds([gr("a1", "A", 1), gr("b1", "B", 1), bn("a2", "A", 2, []), bn("b2", "B", 2, [])], t)!;
    expect(none[3]!.tied, "an empty levelWith: a key decided it").toBeUndefined();
  });

  it("the within-pool flag is not read: a best_nth entry the resolver called tieUnbroken, with an empty levelWith, is not tied", () => {
    const entries = [gr("a1", "A", 1), gr("b1", "B", 1), { ...bn("a2", "A", 2, []), tieUnbroken: true }, { ...bn("b2", "B", 2, []), tieUnbroken: true }];
    expect(pooledSeeds(entries, tables({ A: [row("a1", 12), row("a2", 6)], B: [row("b1", 9), row("b2", 6)] }))!.some((s) => s.tied === true)).toBe(false);
  });
});

describe("the order constant the module falls back to is the engine's own", () => {
  it("PRE_W2D_CROSS_GROUP is points, diff, for, wins (no head-to-head key)", () => {
    expect([...PRE_W2D_CROSS_GROUP]).toEqual(["points", "diff", "for", "wins"]);
  });
});
