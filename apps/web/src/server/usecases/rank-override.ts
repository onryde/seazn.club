import "server-only";
// W5 app PR A, Task 13 (X-PO-3, RB5-P5, ruling 288's storage condition G7): the SQL half of the manual rank override - the stage's
// seating the write is checked against, and every cleanup of a stored pin (`stages.config.rank_overrides`). The decisions are the pure
// `lib/rank-override.ts`. Every function here runs in the CALLER's transaction and holds nothing of its own: the callers take the
// division advisory lock (a write that read `config` before the lock would revert another writer's key, design section T2), and the
// writes are server-side jsonb merges for the same reason.
import type { Tx } from "@/lib/db";
import { changedPools, pinsSurvivingRedraw, type RankPin, type StageSeating } from "@/lib/rank-override";

/** Where a stage's entrants sit, read off its stored lines (every status: a voided or walked-over line still seats both sides). */
export async function readStageSeating(tx: Tx, stageId: string): Promise<StageSeating> {
  const lines = await tx<{ pool_id: string | null; home: string | null; away: string | null }[]>`
    select pool_id, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId}`;
  const poolOf = new Map<string, string | null>();
  const members = new Map<string | null, Set<string>>();
  for (const l of lines) {
    for (const id of [l.home, l.away]) {
      if (id === null) continue;
      poolOf.set(id, l.pool_id);
      const set = members.get(l.pool_id) ?? new Set<string>();
      set.add(id);
      members.set(l.pool_id, set);
    }
  }
  return { seated: lines.length > 0, poolOf, sizeOf: new Map([...members].map(([pool, set]) => [pool, set.size])) };
}

/** The same seating as membership sets: the shape `changedPools` compares across a redraw. */
export async function readPoolMembers(tx: Tx, stageId: string): Promise<{ members: Map<string | null, Set<string>>; poolOf: Map<string, string | null> }> {
  const seating = await readStageSeating(tx, stageId);
  const members = new Map<string | null, Set<string>>();
  for (const [id, pool] of seating.poolOf) members.set(pool, (members.get(pool) ?? new Set<string>()).add(id));
  return { members, poolOf: new Map(seating.poolOf) };
}

export async function readStagePins(tx: Tx, stageId: string): Promise<RankPin[]> {
  const [row] = await tx<{ pins: unknown }[]>`select config -> 'rank_overrides' as pins from stages where id = ${stageId}`;
  return Array.isArray(row?.pins) ? (row!.pins as RankPin[]) : [];
}

/**
 * RB5-P5 / G7: a pre-Start Generate that DREW the stage again moves entrants between pools, and a pin names a place in one pool's table.
 * Every pool whose membership changed loses its pins; a pool that came out the same keeps them. `before` is the seating read before the
 * redraw, the caller reads the stage again after it.
 */
export async function dropPinsOfChangedPools(
  tx: Tx,
  stageId: string,
  before: { members: ReadonlyMap<string | null, ReadonlySet<string>>; poolOf: ReadonlyMap<string, string | null> },
): Promise<number> {
  const pins = await readStagePins(tx, stageId);
  if (pins.length === 0) return 0;
  const after = await readPoolMembers(tx, stageId);
  const kept = pinsSurvivingRedraw(pins, changedPools(before.members, after.members), before.poolOf);
  if (kept.length === pins.length) return 0;
  await tx`update stages set config = config || ${tx.json({ rank_overrides: kept } as never)} where id = ${stageId}`;
  return pins.length - kept.length;
}

/**
 * G7: a pin names an entrant, and an entrant who leaves takes it with her. In every league and group of the division that is still
 * OPEN: a finished table stands as it finished (RB5-L8, the same rule the withdrawal cascade applies to its lines), and a Swiss table
 * keeps its own order and her pin with it. Reinstate does not bring a pin back; the organiser pins again. Returns the stages changed.
 */
export async function dropPinsOfEntrant(tx: Tx, divisionId: string, entrantId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    update stages set config = config || jsonb_build_object('rank_overrides',
      coalesce((select jsonb_agg(p) from jsonb_array_elements(config -> 'rank_overrides') p where p ->> 'entrant_id' <> ${entrantId}), '[]'::jsonb))
     where division_id = ${divisionId} and kind in ('league', 'group') and status <> 'complete'
       and jsonb_typeof(config -> 'rank_overrides') = 'array'
       and exists (select 1 from jsonb_array_elements(config -> 'rank_overrides') p where p ->> 'entrant_id' = ${entrantId})
     returning id`;
  return rows.map((r) => r.id);
}
