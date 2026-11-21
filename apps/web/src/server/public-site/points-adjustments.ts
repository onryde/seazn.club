// W5 app PR B, Task 7 (X-ADJ-4): the division's points-adjustment rows, for every page that prints a league, group or Swiss table
// (the division page, the live page, the embed, the hub) - with each carried table's copies (B3 ruling 3). The fold over them is `activePointsAdjustments`
// (lib/points-adjustment-note.ts), the same one the table fold reads; this is only the read. Reads both row types so an Undo is seen.
import "server-only";
import { sql } from "@/lib/db";
import {
  POINTS_ADJUSTMENT_ROW,
  POINTS_ADJUSTMENT_VOIDED_ROW,
  activePointsAdjustments,
  withCarriedAdjustments,
  type AdjustmentCarry,
  type AdjustmentLedgerRow,
  type PointsAdjustmentRecord,
} from "@/lib/points-adjustment-note";

export async function loadPointsAdjustments(divisionId: string): Promise<PointsAdjustmentRecord[]> {
  const rows = await sql<AdjustmentLedgerRow[]>`
    select seq::int as seq, type, payload, to_json(created_at) #>> '{}' as at from division_events
     where division_id = ${divisionId} and type in (${POINTS_ADJUSTMENT_ROW}, ${POINTS_ADJUSTMENT_VOIDED_ROW})
     order by seq`;
  const records = activePointsAdjustments(rows);
  if (records.length === 0) return records;
  // B3 ruling 3: each destination's NEWEST carry (a re-confirm appends another `standings_carried` row), with its source's name -
  // the adjustments it carried are named under the destination's table too (`withCarriedAdjustments`).
  const carries = await sql<{ into: string; from: string; from_name: string; mode: string; entrants: unknown }[]>`
    select distinct on (e.payload ->> 'stageId') e.payload ->> 'stageId' as into, e.payload ->> 'from' as from, s.name as from_name,
           e.payload ->> 'mode' as mode, e.payload -> 'entrants' as entrants
      from division_events e
      join stages s on s.id::text = e.payload ->> 'from'
     where e.division_id = ${divisionId} and e.type = 'standings_carried'
     order by e.payload ->> 'stageId', e.seq desc`;
  return withCarriedAdjustments(
    records,
    carries
      .filter((c) => (c.mode === "points" || c.mode === "full") && Array.isArray(c.entrants))
      .map((c): AdjustmentCarry => ({ into: c.into, from: c.from, fromName: c.from_name, mode: c.mode as AdjustmentCarry["mode"], entrants: (c.entrants as unknown[]).filter((x): x is string => typeof x === "string") })),
  );
}
