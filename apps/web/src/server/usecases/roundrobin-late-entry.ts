import "server-only";
// W5 app-A Task 4 (X-CU-9; RB5-L1, L2, L12; design 2026-11-05 §4.1): which stage a late player can join in a started
// league or group stage. This file holds the Start lock's half: the division's ROOT table stages. Task 5 adds the
// admission beside it (catch-up fixtures, Rebuild offered, a named refusal).
//
// The predicate is `isRootTableStage` (lib/open-entry-stages.ts): the ONE rule the Start lock, the admission and the
// desk's client mirror all read, so they cannot disagree. A group stage fed by an earlier one (a two-tier format's
// second tier) and a bracket behind a table take nobody late (X-LE-2).
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

/** The division's root table stages in `seq` order, the first still running ahead of a finished one (the stage a late
 *  player joins comes first; a finished table is last, where the admission refuses it by name). */
export async function rootTableStages(tx: Tx, divisionId: string): Promise<TableEntryStage[]> {
  const rows = await tx<TableEntryStage[]>`
    select id, seq, status, kind, progression, config from stages
    where division_id = ${divisionId} and kind in ('league', 'group')
    order by (status = 'complete'), seq`;
  return rows.filter(isRootTableStage);
}

/** Whether the division holds a league or group stage a late player can join — the Start lock's exemption
 *  (`createEntrants`), the neighbour of `hasRootSwissStage` and `hasRootKnockoutStage`. */
export async function hasRootTableStage(tx: Tx, divisionId: string): Promise<boolean> {
  return (await rootTableStages(tx, divisionId)).length > 0;
}
