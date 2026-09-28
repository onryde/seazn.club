import "server-only";
// server/usecases/admin-stream-credits.ts — the READ behind the staff "Match credits" panel on
// /admin/orgs/[id] (Task 7A, owner ruling 15). Writes are NOT here: the admin route calls
// Task 7's grantCredits / refundCredits / revokeCredits, which own the lock, the key check,
// the floor, the cap, the row and its staff_audit_log row.
import { sql } from "@/lib/db";
import { creditBalance } from "@/server/usecases/stream-credits";

/** The largest single staff adjustment, for EVERY staff role, under the name the panel and the
 *  page use for it. A RE-EXPORT of stream-credits.ts's `STAFF_CREDIT_MAX` — never a second 50:
 *  that constant is the bound `staffRow` itself refuses on (422 delta_out_of_range), and the
 *  route's zod ceiling, the modal's input `max` and the writer's own guard have to be ONE number
 *  or a staff member meets a 422 where the form promised a 400. (The ruled bound is 1..50 for
 *  every staff role with no superadmin bypass — the orchestrator's ruling 4, 2026-09-16; the
 *  reasoning for the value lives with the constant.) */
export { STAFF_CREDIT_MAX as STREAM_CREDIT_ADJUST_MAX } from "@/server/usecases/stream-credits";

/** Ledger rows the panel shows, newest first. 20 is the page's own recent-history depth
 *  (Staff history, page.tsx `limit 20`); one match credit is one streamed match, so 20 rows
 *  cover a busy weekend plus the purchase that funded it. Older rows are a SQL read — no
 *  pager until someone needs one. */
export const STREAM_CREDIT_LEDGER_LIMIT = 20;

export interface StreamCreditLedgerRow {
  id: string;
  /** The DDL CHECK owns the set of reasons; the panel prints the value, so no second union here. */
  reason: string;
  delta: number;
  /** The per-row SNAPSHOT — shown, never read as the balance. */
  balanceAfter: number;
  note: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
  sessionId: string | null;
  /** ISO-8601, UTC. */
  createdAt: string;
}

export async function streamCreditsForOrg(orgId: string): Promise<{ balance: number; rows: StreamCreditLedgerRow[] }> {
  const rows = await sql<{
    id: string; reason: string; delta: number; balance_after: number; note: string | null;
    created_by: string | null; email: string | null; session_id: string | null; created_at: Date | string;
  }[]>`
    select c.id, c.reason, c.delta, c.balance_after, c.note, c.created_by, u.email, c.session_id, c.created_at
      from org_stream_credits c
      left join users u on u.id = c.created_by
     where c.org_id = ${orgId}
     order by c.created_at desc, c.id desc
     limit ${STREAM_CREDIT_LEDGER_LIMIT}`;
  return {
    balance: await creditBalance(sql, orgId),   // ONE authority: sum(delta), never rows[0].balance_after
    rows: rows.map((r) => ({
      id: r.id, reason: r.reason, delta: r.delta, balanceAfter: r.balance_after, note: r.note,
      createdBy: r.created_by, createdByEmail: r.email, sessionId: r.session_id,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}
