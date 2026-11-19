import "server-only";
// W5 app PR A, Task 22 (X-SF-6; ST-G23, ST-G28): the two reads behind `GET /stages/{id}/standings` and `GET /stages/{id}/pools`.
//
// `getStandings` (stages/completion.ts) stays what the division page and the slideshow read: ONE stored table. This module is the API's
// door over it: it names every row (`name`, `status`, `pool` - `api-v1/standings-wire.ts`) and, asked for no `pool_id` on a stage with
// SEVERAL pools, answers every pool instead of the empty list it used to (a several-pool stage has no single table to default to).
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { comparePools } from "@/lib/pool-order";
import type { AuthCtx } from "@/server/api-v1/auth";
import { wireStandingsRows, type WireEntrant } from "@/server/api-v1/standings-wire";
import { recomputeStandings } from "@/server/engine-db";
import { getStandings } from "./stages";

type WireRow = ReturnType<typeof wireStandingsRows<{ entrantId: string }>>[number];

export interface StandingsWire {
  stage_id: string;
  pool_id: string | null;
  rows: (WireRow & Record<string, unknown>)[];
  computed_through_seq: string | 0;
  updated_at: string | null;
}

interface PoolRef {
  id: string;
  key: string;
  name: string;
}

/** The stage's pools in the product's order, and the division's entrants as the organiser sees them (every status). */
async function readStageContext(auth: AuthCtx, stageId: string): Promise<{ pools: PoolRef[]; entrants: Map<string, WireEntrant> }> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const pools = await tx<PoolRef[]>`select id, key, name from pools where stage_id = ${stageId}`;
    const entrants = await tx<{ id: string; display_name: string; status: string }[]>`
      select id, display_name, status from entrants where division_id = ${stage.division_id}`;
    return {
      pools: [...pools].sort(comparePools),
      entrants: new Map(entrants.map((e) => [e.id, { name: e.display_name, status: e.status }])),
    };
  });
}

/** `GET /stages/{id}/pools`: the pools of a stage with SEVERAL pools, in pool order; none for a stage whose table names no pool (a league,
 *  a knockout, a group of one pool - it reads as a league, X-BD-7). */
export async function listStagePools(auth: AuthCtx, stageId: string): Promise<{ stage_id: string; pools: PoolRef[] }> {
  const { pools } = await readStageContext(auth, stageId);
  return { stage_id: stageId, pools: pools.length > 1 ? pools : [] };
}

interface PoolSnapshot {
  pool_id: string;
  rows: { entrantId: string }[];
  computed_through_seq: string;
  updated_at: string | Date | null;
}

async function readPoolSnapshots(auth: AuthCtx, stageId: string, pools: readonly PoolRef[]): Promise<PoolSnapshot[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<PoolSnapshot[]>`
      select pool_id, rows, computed_through_seq, updated_at from standings_snapshots
       where stage_id = ${stageId} and pool_id = any(${pools.map((p) => p.id)})`,
  );
}

/**
 * `GET /stages/{id}/standings`, named. One pool's table (`poolId`), the stage's own table (a league; the only pool of a one-pool group),
 * or - no `poolId` on a stage with several pools - every pool's rows in pool order, each row tagged with the key it is ranked within.
 * Rank-null on a level table is the ROUTE's (`serialiseLevelRanksPerPool`, E24): the stored places stay here.
 */
export async function getStageStandings(auth: AuthCtx, stageId: string, requestedPoolId?: string): Promise<StandingsWire> {
  const { pools, entrants } = await readStageContext(auth, stageId);
  const several = pools.length > 1;
  if (requestedPoolId !== undefined || !several) {
    const snap = await getStandings(auth, stageId, requestedPoolId);
    // A pool is named only on a stage with several (X-BD-7): a one-pool group's table reads as a league's.
    const key = several && snap.pool_id !== null ? (pools.find((p) => p.id === snap.pool_id)?.key ?? null) : null;
    return { ...snap, rows: wireStandingsRows(snap.rows as { entrantId: string }[], entrants, key) as StandingsWire["rows"] };
  }
  let snaps = await readPoolSnapshots(auth, stageId, pools);
  if (snaps.length === 0) {
    // Never folded: the same lazy fold `getStandings` does on a miss; it writes every pool's table, so one fold fills them all.
    await recomputeStandings(auth.orgId, stageId);
    snaps = await readPoolSnapshots(auth, stageId, pools);
  }
  const byPool = new Map(snaps.map((s) => [s.pool_id, s]));
  const listed = pools.filter((p) => byPool.has(p.id));
  const seqs = listed.map((p) => BigInt(byPool.get(p.id)!.computed_through_seq));
  const times = listed.map((p) => byPool.get(p.id)!.updated_at).filter((t): t is string | Date => t !== null);
  const newest = times.length === 0 ? null : times.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b));
  return {
    stage_id: stageId,
    pool_id: null,
    rows: listed.flatMap((p) => wireStandingsRows(byPool.get(p.id)!.rows, entrants, p.key)) as StandingsWire["rows"],
    // The oldest watermark: the point EVERY listed pool is folded through. 0 where nothing is stored (a fold that wrote no pool).
    computed_through_seq: seqs.length === 0 ? 0 : seqs.reduce((a, b) => (a <= b ? a : b)).toString(),
    updated_at: newest === null ? null : (newest as unknown as string),
  };
}
