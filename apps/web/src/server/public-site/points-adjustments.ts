// W5 app PR B, Task 7 (X-ADJ-4): the division's points-adjustment rows, for every page that prints a league, group or Swiss table
// (the division page, the live page, the embed, the hub). The fold over them is `activePointsAdjustments`
// (lib/points-adjustment-note.ts), the same one the table fold reads; this is only the read. Reads both row types so an Undo is seen.
import "server-only";
import { sql } from "@/lib/db";
import {
  POINTS_ADJUSTMENT_ROW,
  POINTS_ADJUSTMENT_VOIDED_ROW,
  activePointsAdjustments,
  type AdjustmentLedgerRow,
  type PointsAdjustmentRecord,
} from "@/lib/points-adjustment-note";

export async function loadPointsAdjustments(divisionId: string): Promise<PointsAdjustmentRecord[]> {
  const rows = await sql<AdjustmentLedgerRow[]>`
    select seq::int as seq, type, payload, to_json(created_at) #>> '{}' as at from division_events
     where division_id = ${divisionId} and type in (${POINTS_ADJUSTMENT_ROW}, ${POINTS_ADJUSTMENT_VOIDED_ROW})
     order by seq`;
  return activePointsAdjustments(rows);
}
