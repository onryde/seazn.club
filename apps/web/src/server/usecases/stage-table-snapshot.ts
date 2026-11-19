import "server-only";
// W5 app PR A, Task 3 (X-BD-7; RB5-E5, Review Focus 5): the ONE reader of "this stage's single table" for the surfaces that name a
// stage and not a pool (the news drafts, the weekly digest, the quick-match league's read).
//
// A league's table is stored under no pool (`pool_id is null`); so was a one-pool group's, because it had no pool. Since W5 T3 a
// group of one pool carries pool A's id, and its table is stored under it. A reader that still asked `pool_id is null` would find
// NOTHING for such a group and drop its section without a word (the digest, the recap's standings, the climber line): the absent
// symptom reads as "no standings yet". This is the one place that knows both shapes:
//   - a table stored under no pool (a league, a Swiss stage, a group drawn before W5 T3), else
//   - the table of the stage's ONLY pool.
// A stage with several pools has no single table: undefined, as before (each pool is a table of its own) - `readPoolTables` below is
// the reader of those, for the surfaces that print every pool (the news recap and digest, W5 T21).
import type postgres from "postgres";
import type { Tx } from "@/lib/db";
import { comparePools } from "@/lib/pool-order";

export async function readSingleTableSnapshot<Rows = unknown>(
  tx: Tx,
  stageId: string,
): Promise<{ rows: Rows; previous_rows: Rows | null } | undefined> {
  const [snap] = await tx<{ rows: Rows; previous_rows: Rows | null }[]>`
    select ss.rows, ss.previous_rows from standings_snapshots ss
     where ss.stage_id = ${stageId}
       and (ss.pool_id is null or (select count(*) from pools p where p.stage_id = ss.stage_id) = 1)
     order by (ss.pool_id is null) desc
     limit 1`;
  return snap;
}

/**
 * W5 app PR A, Task 21 (X-SF-2; ST-G6): the tables of a stage that has SEVERAL pools, one per pool, in the stage's pool order
 * (`comparePools` - the one authority the public pages, the export and the console share: the pool KEY, never insertion, `updated_at`
 * or id). Empty for a stage with no pool or one pool: that stage's table is `readSingleTableSnapshot`'s. A pool with no stored table
 * yet is simply absent (nothing was decided in it); a pool whose stored table is empty is returned with no rows, and the caller
 * decides what an empty or level table prints.
 */
export async function readPoolTables<Rows = unknown>(
  tx: Tx,
  stageId: string,
): Promise<{ poolId: string; key: string; rows: Rows; previous_rows: Rows | null }[]> {
  const pools = await tx<{ id: string; key: string; name: string }[]>`select id, key, name from pools where stage_id = ${stageId}`;
  if (pools.length < 2) return [];
  const snaps = await tx<{ pool_id: string; rows: Rows; previous_rows: Rows | null }[]>`
    select pool_id, rows, previous_rows from standings_snapshots where stage_id = ${stageId} and pool_id = any(${pools.map((p) => p.id)})`;
  const byPool = new Map(snaps.map((x) => [x.pool_id, x]));
  return [...pools]
    .sort(comparePools)
    .flatMap((p) => {
      const snap = byPool.get(p.id);
      return snap ? [{ poolId: p.id, key: p.key, rows: snap.rows, previous_rows: snap.previous_rows }] : [];
    });
}

/**
 * W5 app PR A, Task 21 fix round 1 (X-SF-2): the table a FIXTURE sits in - its own pool's when it has a pool (`fixtures.pool_id`), else
 * the stage's single table. A pooled fixture's movement ("moves up to 1st", the recap's climber) is measured against ITS pool's table and
 * previous table only: rank 2 in pool B is not rank 2 in pool A. A fixture with no pool (a league, a Swiss stage), or whose pool has no
 * stored table yet, falls back to `readSingleTableSnapshot` (which answers undefined for a several-pool stage).
 */
export async function readFixtureTable<Rows = unknown>(
  tx: Tx,
  stageId: string,
  poolId: string | null | undefined,
): Promise<{ rows: Rows; previous_rows: Rows | null } | undefined> {
  if (poolId) {
    const [snap] = await tx<{ rows: Rows; previous_rows: Rows | null }[]>`
      select rows, previous_rows from standings_snapshots where stage_id = ${stageId} and pool_id = ${poolId}`;
    if (snap) return snap;
  }
  return readSingleTableSnapshot<Rows>(tx, stageId);
}

/** The pool a stage's single table sits under: the stage's only pool, or null when it has none or several (the no-pool table). */
export async function onlyPoolOf(tx: Tx, stageId: string): Promise<string | null> {
  const pools = await tx<{ id: string }[]>`select id from pools where stage_id = ${stageId} limit 2`;
  return pools.length === 1 ? pools[0]!.id : null;
}

/**
 * The SQL half of `poolNaming` (lib/pool-label.ts): true for a pool `on` (an alias of `pools`, or of anything with a `stage_id`) whose
 * stage has SEVERAL pools. A group of one pool has a pool row but reads as a league (X-BD-7), so a surface that names pools (the board's
 * pool letter, the desk's pool chip, the capture stage label) asks this, in one place.
 */
export function inSeveralPoolsSql(tx: postgres.Sql | Tx, on: string) {
  return tx`(select count(*) from pools _sp where _sp.stage_id = ${tx(on)}.stage_id) > 1`;
}

/** The pools of `stageIds` a surface may name: those of a stage with several pools (the desk's chip list, `fixturePools`). */
export async function listNamedPools(tx: Tx, stageIds: readonly string[]): Promise<{ id: string; key: string; name: string }[]> {
  if (stageIds.length === 0) return [];
  return tx<{ id: string; key: string; name: string }[]>`
    select p.id, p.key, p.name from pools p
    where p.stage_id in ${tx(stageIds)} and ${inSeveralPoolsSql(tx, "p")}`;
}
