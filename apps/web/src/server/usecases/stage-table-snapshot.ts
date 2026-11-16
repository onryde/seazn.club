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
// A stage with several pools has no single table: undefined, as before (each pool is a table of its own).
import type { Tx } from "@/lib/db";

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

/** The pool a stage's single table sits under: the stage's only pool, or null when it has none or several (the no-pool table). */
export async function onlyPoolOf(tx: Tx, stageId: string): Promise<string | null> {
  const pools = await tx<{ id: string }[]>`select id from pools where stage_id = ${stageId} limit 2`;
  return pools.length === 1 ? pools[0]!.id : null;
}
