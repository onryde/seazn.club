// W5 app PR A, Task 8 (RB5-W7): the division's table-withdrawal footnote rows, for the pages that print a league or group
// table (the division page, the live page, the embed, the hub). The fold over them is `activeTableWithdrawals`
// (lib/table-withdrawal-note.ts); this is only the read. Reads both row types so a Reinstate's void is seen.
import "server-only";
import { sql } from "@/lib/db";
import {
  TABLE_WITHDRAWAL_ROW,
  TABLE_WITHDRAWAL_VOIDED_ROW,
  activeTableWithdrawals,
  type TableWithdrawalRecord,
} from "@/lib/table-withdrawal-note";

export async function loadTableWithdrawals(divisionId: string): Promise<TableWithdrawalRecord[]> {
  const rows = await sql<{ seq: number; type: string; payload: unknown }[]>`
    select seq::int as seq, type, payload from division_events
     where division_id = ${divisionId} and type in (${TABLE_WITHDRAWAL_ROW}, ${TABLE_WITHDRAWAL_VOIDED_ROW})
     order by seq`;
  return activeTableWithdrawals(rows);
}
