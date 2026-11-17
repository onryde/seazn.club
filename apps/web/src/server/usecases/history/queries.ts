import "server-only";
import { fold, isReversible } from "@seazn/engine/history";
import { withTenant } from "@/lib/db";
import {
  PAIR_DISSOLVE_OWED_ROW,
  TABLE_WITHDRAWAL_LINE_ROW,
  TABLE_WITHDRAWAL_LINE_VOIDED_ROW,
  WITHDRAWAL_REINSTATED_ROW,
} from "@/lib/table-withdrawal-note";
import type { AuthCtx } from "@/server/api-v1/auth";
import { divisionMeta, loadLedger } from "./ledger";

export interface HistoryRow {
  seq: number;
  type: string;
  undoable: boolean;
  actor_id: string | null;
  created_at: string;
  undone: boolean;
}

/** Ledger rows that are bookkeeping, never an edit a person made: the withdrawal cascade's per-line write-ahead rows and their
 *  retirements (Task 8b re-review 2). Left out of every history surface (the panel's Recent edits, API v1 history) — the
 *  withdrawal and its Reinstate are each listed once, by their `table_withdrawal` / `table_withdrawal_voided` rows. */
const INTERNAL_LEDGER_TYPES: readonly string[] = [TABLE_WITHDRAWAL_LINE_ROW, TABLE_WITHDRAWAL_LINE_VOIDED_ROW, PAIR_DISSOLVE_OWED_ROW, WITHDRAWAL_REINSTATED_ROW];

/** GET /divisions/{id}/history — ledger slice, newest first. */
export async function divisionHistory(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ watermark: number | null; seq: number; events: HistoryRow[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const rows = await tx<{ seq: number; type: string; actor_id: string | null; created_at: string }[]>`
      select seq, type, actor_id, created_at from division_events
      where division_id = ${divisionId} and type <> all(${INTERNAL_LEDGER_TYPES as string[]}) order by seq desc limit 100`;
    const wm = meta.edit_watermark;
    return {
      watermark: wm,
      seq: meta.seq,
      events: rows.map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        undoable: isReversible(r.type),
        actor_id: r.actor_id,
        created_at: r.created_at,
        undone: wm !== null && isReversible(r.type) && Number(r.seq) > wm,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Checkpoints (Jul3/03 §2) — named save points; restore = undo to watermark.
// ---------------------------------------------------------------------------

/** State the console renders after undo/redo: the fold at the watermark.
 *
 *  `court` (P9 pass 3a) is a courts.id now, purely by construction — `fold`
 *  is a pure engine replay over whatever the ledger's own `court` fields
 *  hold, and every writer of those (`execute()` above) writes an id since
 *  this pass. Field NAME unchanged (`court`, not `court_id`) — this is
 *  outside pass 3a's file scope (a console/UI concern, pass 4) and a rename
 *  here with no consumer updated to match would be a pointless wire break;
 *  a caller wanting a display name resolves `court` the same way any other
 *  P9 caller does (`courtNamesById` in schedule/board.ts). */
export async function scheduleStateAt(
  auth: AuthCtx,
  divisionId: string,
): Promise<Record<string, { at: string | null; court: string | null }>> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const ledger = await loadLedger(tx, divisionId);
    const state = fold(ledger, meta.edit_watermark);
    const out: Record<string, { at: string | null; court: string | null }> = {};
    for (const [id, f] of Object.entries(state.fixtures)) {
      if (f.exists) out[id] = { at: f.at, court: f.court };
    }
    return out;
  });
}
