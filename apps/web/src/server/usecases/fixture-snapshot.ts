import "server-only";
// The one fixture-snapshot read (moved verbatim out of history.ts, W5 T2 fix round 1): history.ts records it before
// its two destructive writes (`fixtures_cleared`, `pool_entrants_cleared`), and a round-robin Generate that deletes lines
// records it the same way, so the ledger's inverse can put them back. history.ts's long note on what a snapshot keeps and drops
// stays beside `restoreFixtures`, its one writer.
import type { FixtureSnapshot } from "@seazn/engine/history";
import type { Tx } from "@/lib/db";

/** What `snapshotFixtures` returns: every field present (the SQL selects them
 *  all), which a snapshot read back from an older ledger row cannot promise. */
export interface SnapshotRow extends FixtureSnapshot {
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  at: string | null;
  court: string | null;
  locked: boolean;
  status: string;
  finished_at: string | null;
}

/** The one snapshot read. Unordered: `restoreFixtures` owns the order. */
export async function snapshotFixtures(
  tx: Tx,
  by: { ids: readonly string[] } | { poolId: string },
): Promise<SnapshotRow[]> {
  if ("ids" in by && by.ids.length === 0) return [];
  const where = "ids" in by ? tx`f.id in ${tx(by.ids as string[])}` : tx`f.pool_id = ${by.poolId}`;
  // `court` is a courts.id (P9 pass 3a — aliased off court_id, never the
  // legacy court_label): the restore writes it straight back into an id
  // column, so a label here would be a display string in a uuid.
  return tx<SnapshotRow[]>`
    select f.id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
           f.home_entrant_id, f.away_entrant_id,
           f.scheduled_at::text as at, f.court_id as court,
           f.schedule_locked as locked, f.schedule_source, f.fixture_no,
           f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
           f.home_slot_label, f.away_slot_label,
           f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot,
           f.status, f.outcome, f.finished_at::text as finished_at,
           exists (select 1 from score_events se where se.fixture_id = f.id) as scored
    from fixtures f where ${where}`;
}

/** A stage's recorded byes (`config.round_byes`) as the ledger keeps them beside a delete: the array, or null when the stage has
 *  none recorded (a redraw that writes them then has something to put back, and a stage drawn before they existed stays that way). */
export async function readStageRoundByes(tx: Tx, stageId: string): Promise<unknown[] | null> {
  const [row] = await tx<{ byes: unknown }[]>`select config -> 'round_byes' as byes from stages where id = ${stageId}`;
  return Array.isArray(row?.byes) ? (row!.byes as unknown[]) : null;
}

/** The inverse of `readStageRoundByes`: put a stage's recorded byes back (null removes the key). */
export async function writeStageRoundByes(tx: Tx, stageId: string, byes: unknown[] | null): Promise<void> {
  if (byes === null) await tx`update stages set config = config - 'round_byes' where id = ${stageId}`;
  else await tx`update stages set config = config || ${tx.json({ round_byes: byes } as never)} where id = ${stageId}`;
}
