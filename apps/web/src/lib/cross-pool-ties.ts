// W5 app PR B Task 5 (FX-G5; ruling 281; RB5-D1..D3, RB5-D10; fix rounds G3 and N6, preflight K23): what the engine's
// `crossPoolDraw(seeded, shape, drawSeed)` is handed for a knockout fed from groups - one `PooledSeed` per qualifier, in seed
// order, its source pool, its tier (a group_rank entry's place, a best_nth entry's nth) and whether it is `tied` to the seed
// before it.
//
// `tied` means EQUAL ON THE CROSS-POOL COMPARISON (G3), never the resolver's `tieUnbroken` - that flag marks a shared place
// INSIDE one pool, which the organiser resolves before confirm, so it never says two pools' entrants are level:
// - a best_nth tier: the engine's own cross-pool ranking reports it - seed i is tied iff seed i-1 is in seed i's
//   `basis.levelWith` (a best-Nth tier arrives in cross-pool rank order, so a level class is contiguous);
// - a group_rank tier: nothing ranks it across pools, so it is ranked here with the engine's `crossGroupOrder` over the tier's
//   rows (each pool's row at that place, from the SAME `SourceTables` the resolver read), their pool trace (`tieUnbroken`,
//   `tieBreak`, `rank`, `rankLocked`) stripped first; two rows are level only when both land in one RESIDUAL class
//   (`tieUnbroken` with the other in `tieBreak.with` - a key that splits them fills `tieBreak.with` too, so `with` alone is not
//   "level"). The returned order and any lots it draws are ignored: lots decide who qualifies, the stored draw seed decides where
//   they sit. Rows whose `played` differ are never level. The tier stays in pool order, so only ADJACENT level seeds link.
// The first seed, and a tier's first seed, are never tied (the engine refuses that link as `tie_link_invalid`).
//
// N6/K23: the draw serves only a field seated from ONE source's pools, with at least two DISTINCT pools. A league source
// (`group_stepladder`, `group_playoffs`) has no pool on its entries, and a one-pool group writes its one pool id (designer's call
// 15) - both answer null here and keep today's placement; `crossPoolDraw` over one pool would refuse.
//
// Pure and client-safe: no DB, no server import.
import { crossGroupOrder, PRE_W2D_CROSS_GROUP, type SourceTables, type StandingsRow } from "@seazn/engine/competition";
import type { FirstRoundShape, PooledSeed } from "@seazn/engine/scheduling";

/** The first-round shape a destination kind draws in across pools; a kind absent here is not drawn. One authority: the server's draw
 *  (`usecases/stages/cross-pool-draw.ts`) and the builder's warning (`lib/cross-pool-draw-risk.ts`) both read it. */
export const CROSS_POOL_SHAPES: Readonly<Record<string, FirstRoundShape>> = { knockout: "single_elim", stepladder: "stepladder", page_playoff: "page_playoff" };

/** The resolver's entry, as far as the draw reads it (`ResolvedProgressionEntry`, stored descriptor). */
export interface CrossPoolEntry {
  readonly entrantId: string;
  readonly sourceIndex: number;
  readonly descriptor: { readonly kind: string; readonly rank?: number; readonly nth?: number };
  readonly pool?: string;
  readonly basis?: { readonly levelWith: readonly string[] };
}

function tierOf(e: CrossPoolEntry): number | null {
  if (e.descriptor.kind === "group_rank") return e.descriptor.rank ?? null;
  if (e.descriptor.kind === "best_nth") return e.descriptor.nth ?? null;
  return null;
}

/** The `PooledSeed[]` for `entries` (in seed order), or null when the field is not a pooled one (N6/K23): an empty field, more
 *  than one source, an entry of another kind (a rank range, a bracket loser), an entry with no pool, or fewer than two distinct
 *  pools. Null means the caller keeps today's placement and never calls `crossPoolDraw`. */
export function pooledSeeds(entries: readonly CrossPoolEntry[], tables: readonly SourceTables[]): PooledSeed[] | null {
  const first = entries[0];
  if (first === undefined) return null;
  const seeds: PooledSeed[] = [];
  for (const e of entries) {
    const tier = tierOf(e);
    if (e.sourceIndex !== first.sourceIndex || e.pool === undefined || tier === null) return null;
    seeds.push({ entrantId: e.entrantId, pool: e.pool, tier });
  }
  if (new Set(seeds.map((s) => s.pool)).size < 2) return null;
  const level = groupRankLevel(entries, seeds, tables[first.sourceIndex]);
  return seeds.map((s, i) => {
    const prev = seeds[i - 1];
    if (prev === undefined || prev.tier !== s.tier) return s;
    const e = entries[i]!;
    const p = entries[i - 1]!;
    const tied =
      e.descriptor.kind === "best_nth" && p.descriptor.kind === "best_nth"
        ? (e.basis?.levelWith.includes(p.entrantId) ?? false)
        : e.descriptor.kind === "group_rank" && p.descriptor.kind === "group_rank"
          ? (level.get(e.entrantId)?.has(p.entrantId) ?? false)
          : false;
    return tied ? { ...s, tied: true } : s;
  });
}

/** Each group_rank seed's level partners: per tier, the tier's rows ranked with the source's cross-group order, pool trace
 *  stripped; a partner is in the same residual class and has the same `played`. */
function groupRankLevel(entries: readonly CrossPoolEntry[], seeds: readonly PooledSeed[], source: SourceTables | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const tiers = new Map<number, StandingsRow[]>();
  entries.forEach((e, i) => {
    if (e.descriptor.kind !== "group_rank") return;
    const row = source?.pools.find((p) => p.pool === e.pool)?.rows.find((r) => r.entrantId === e.entrantId);
    // The resolver seated this entry from these tables; a row they do not hold is a wiring fault, refused by name.
    if (row === undefined) throw new Error(`cross-pool ties: ${e.entrantId} seated from pool ${e.pool} has no row in that pool`);
    const tier = seeds[i]!.tier;
    tiers.set(tier, [...(tiers.get(tier) ?? []), row]);
  });
  const order = source?.crossGroup?.order ?? PRE_W2D_CROSS_GROUP;
  const ctx = {
    ...(source?.crossGroup?.seeds === undefined ? {} : { seeds: source.crossGroup.seeds }),
    ...(source?.crossGroup?.winsCount === undefined ? {} : { winsCount: source.crossGroup.winsCount }),
  };
  for (const rows of tiers.values()) {
    if (rows.length < 2) continue;
    const played = new Map(rows.map((r) => [r.entrantId, r.played]));
    const stripped = rows.map((r): StandingsRow => {
      const rest: StandingsRow = { ...r };
      delete rest.tieUnbroken;
      delete rest.tieBreak;
      delete rest.rank;
      delete rest.rankLocked;
      return rest;
    });
    for (const r of crossGroupOrder(stripped, order, undefined, ctx).rows) {
      if (r.tieUnbroken !== true || r.tieBreak === undefined) continue;
      const mates = r.tieBreak.with.filter((id) => played.get(id) === played.get(r.entrantId));
      if (mates.length > 0) out.set(r.entrantId, new Set(mates));
    }
  }
  return out;
}
