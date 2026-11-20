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

/** What best-Nth reads of one table source: its cross-group rules, each pool's counted results by the pool's KEY, and the stage's
 *  expunged entrants. */
export interface BestNthSource {
  crossGroup: CrossGroupRules;
  /** Pool key ('A'…, "" for a table with no pools) -> the pool's counted results, as the stage's own fold made them. */
  results: ReadonlyMap<string, readonly FixtureResult[]>;
  /** W5 app PR B T4 (RB5-U5/U7): the entrants an ACTIVE expunge-policy `table_withdrawal` row names for this stage (a Reinstate
   *  voids the row, so a reinstated entrant is not here). Stage-wide; `withPoolResults` maps them to their pools. */
  expunged: ReadonlySet<string>;
}

/** A table source's cross-group rules and pool results, from one load of the stage (`loadBestNthSource`: the rules' game-points
 *  reader pays exactly these results). The fold keys a pool by its uuid; this translates it to the spec-facing key with the
 *  caller's own `keyOf` (pool uuid -> key, read once by the builder for its snapshots: `sourcePoolKeys`), exactly as the
 *  snapshot's `pool_id` is translated (a uuid with no `pools` row keeps the uuid), so a table's pools and their results meet on
 *  one key. */
export async function bestNthSourceOf(tx: Tx, stageId: string, keyOf: ReadonlyMap<string, string>): Promise<BestNthSource> {
  const { crossGroup, poolResults, expunged } = await loadBestNthSource(tx, stageId);
  return {
    crossGroup,
    results: new Map([...poolResults].map(([pool, results]) => [pool === "" ? "" : (keyOf.get(pool) ?? pool), results])),
    expunged,
  };
}

/** Every pool of a table source with its counted results (`[]` for a pool the fold holds none for: a pool with k > 0 and none is
 *  the engine's named `pool_results_missing`, never a silent raw-row comparison) and - W5 app PR B T4 (RB5-U5, RB5-U7; X-UP-5) -
 *  its `expunged` entrants: the stage's expunged leavers that are rows of THIS pool. Engine 10 counts an expunged row in no
 *  effective size (k = effective size - the smallest supplying one) and never takes her as a candidate, so nothing more is dropped
 *  for a leaver whose results are already gone. Mapped by the pool's own rows: the engine refuses an `expunged` id that is not one
 *  of `rows` (`expunged_not_in_pool`), and a leaver with no row (a stage held off its seating, C11) counts in no size anyway.
 *  Everything else of each pool is kept. */
export function withPoolResults<P extends { pool: string; rows: readonly { entrantId: string }[] }>(
  pools: readonly P[],
  results: ReadonlyMap<string, readonly FixtureResult[]>,
  expunged: ReadonlySet<string> = new Set(),
): (P & { results: readonly FixtureResult[]; expunged?: readonly string[] })[] {
  return pools.map((p) => {
    const out = p.rows.filter((r) => expunged.has(r.entrantId)).map((r) => r.entrantId);
    return { ...p, results: results.get(p.pool) ?? [], ...(out.length > 0 ? { expunged: out } : {}) };
  });
}
