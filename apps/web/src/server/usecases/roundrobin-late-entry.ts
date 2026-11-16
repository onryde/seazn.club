import "server-only";
// W5 app-A Task 4 (X-CU-9; RB5-L1, L2, L12; design 2026-11-05 §4.1): which stage a late player can join in a started
// league or group stage. This file holds the Start lock's half: the division's ROOT table stages. Task 5 adds the
// admission beside it (catch-up fixtures, Rebuild offered, a named refusal).
//
// The predicate is `isRootTableStage` (lib/open-entry-stages.ts): the ONE rule the Start lock, the admission and the
// desk's client mirror all read, so they cannot disagree. Only the division's ENTRY stage is root: a group stage fed by an
// earlier one (a two-tier format's second tier, which carries no progression on stg) and a bracket behind a table take
// nobody late (X-LE-2).
import type postgres from "postgres";
import { isRootTableStage } from "@/lib/open-entry-stages";

type Tx = postgres.TransactionSql;

interface TableEntryStage {
  id: string;
  seq: number;
  status: string;
  kind: string;
  progression: unknown;
  config: Record<string, unknown>;
}

/** The division's whole stage list in `seq` order: a root table is the division's ENTRY stage (its lowest `seq`), which no
 *  per-stage read can answer (the same reason `knockout-late-entry.ts` reads the whole list). */
async function divisionStages(tx: Tx, divisionId: string): Promise<TableEntryStage[]> {
  return tx<TableEntryStage[]>`
    select id, seq, status, kind, progression, config from stages
    where division_id = ${divisionId} order by seq`;
}

/** The division's root table stages: its entry stage when that is a league or group drawing from the live roster (at most
 *  one). The kind test lives in the predicate (`TABLE_STAGE_KINDS`), not a second literal here. */
export async function rootTableStages(tx: Tx, divisionId: string): Promise<TableEntryStage[]> {
  const stages = await divisionStages(tx, divisionId);
  return stages.filter((s) => isRootTableStage(s, stages));
}

/** Whether the division holds a league or group stage a late player can join — the Start lock's exemption
 *  (`createEntrants`), the neighbour of `hasRootSwissStage` and `hasRootKnockoutStage`. */
export async function hasRootTableStage(tx: Tx, divisionId: string): Promise<boolean> {
  return (await rootTableStages(tx, divisionId)).length > 0;
}
