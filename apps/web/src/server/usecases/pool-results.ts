import "server-only";
// W5 app PR B Task 0 (G4; ST-G3 seam, app PR A's former Task 11b; RB5-U1, X-UP-1): the pool `results` best-Nth reads, attached
// to every pool of a table source by BOTH seeding builders — `sourcesToTables` (stage-seeding.ts, the setup path's proposal and
// every reader of it) and `tablesForCompletedStage` (stages/carry-over.ts, the on_complete path's seed). Since engine 10
// (ruling 286) best-Nth across unequal pools is always normalised: a larger pool's candidate is compared without its results
// against the pool's bottom k = size - min, and a pool with k > 0 and no results is STAGE_NOT_READY `pool_results_missing`.
// Equal pools have k = 0 and read no results, so attaching them to every pool is exact; there is no sizes-differ condition.
import type postgres from "postgres";
import type { CrossGroupRules, FixtureResult } from "@seazn/engine/competition";
import { loadBestNthSource } from "@/server/engine-db/competition";

type Tx = postgres.TransactionSql;

/** What best-Nth reads of one table source: its cross-group rules and each pool's counted results by the pool's KEY. */
export interface BestNthSource {
  crossGroup: CrossGroupRules;
  /** Pool key ('A'…, "" for a table with no pools) -> the pool's counted results, as the stage's own fold made them. */
  results: ReadonlyMap<string, readonly FixtureResult[]>;
}

/** A table source's cross-group rules and pool results, from one load of the stage (`loadBestNthSource`: the rules' game-points
 *  reader pays exactly these results). The fold keys a pool by its uuid; this translates it to the spec-facing key with the
 *  caller's own `keyOf` (pool uuid -> key, read once by the builder for its snapshots: `sourcePoolKeys`), exactly as the
 *  snapshot's `pool_id` is translated (a uuid with no `pools` row keeps the uuid), so a table's pools and their results meet on
 *  one key. */
export async function bestNthSourceOf(tx: Tx, stageId: string, keyOf: ReadonlyMap<string, string>): Promise<BestNthSource> {
  const { crossGroup, poolResults } = await loadBestNthSource(tx, stageId);
  return {
    crossGroup,
    results: new Map([...poolResults].map(([pool, results]) => [pool === "" ? "" : (keyOf.get(pool) ?? pool), results])),
  };
}

/** Every pool of a table source with its counted results (`[]` for a pool the fold holds none for: a pool with k > 0 and none is
 *  the engine's named `pool_results_missing`, never a silent raw-row comparison). Everything else of each pool is kept. */
export function withPoolResults<P extends { pool: string }>(
  pools: readonly P[],
  results: ReadonlyMap<string, readonly FixtureResult[]>,
): (P & { results: readonly FixtureResult[] })[] {
  return pools.map((p) => ({ ...p, results: results.get(p.pool) ?? [] }));
}
