import "server-only";
// Sponsor deals — per-org invoice numbers (plan 2026-11-07-sponsor-deals D11, Task 20; spec §7: "Invoice numbers run per org,
// in sequence, and are never reused"). The org's row in sponsor_invoice_counters (the sponsor-invoices delta) holds the last
// number it handed out; no row means none yet, so the first number is 1. Shown as `formatInvoiceNumber` (lib/sponsor-deals.ts).
import type { Tx } from "@/lib/db";

/**
 * The org's next invoice number, taken inside the CALLER's transaction: one upsert that inserts 1 or bumps the row, so a
 * transaction that rolls back hands its number back, and a concurrent allocation waits on the org's row until this one
 * commits and then reads the number after it (no repeat, no gap). The row stays locked until the caller commits, so take it
 * as late in the transaction as possible, after any other lock the caller holds (createDeal: the sponsor, then its deals,
 * then this row). Under the tenant role, another org's counter is refused by RLS (42501).
 */
export async function allocateInvoiceNumber(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx<{ last_number: number }[]>`
    insert into sponsor_invoice_counters as c (org_id, last_number) values (${orgId}, 1)
    on conflict (org_id) do update set last_number = c.last_number + 1
    returning c.last_number`;
  // `returning` answers exactly one row for an insert or a conflict update: no row is a broken statement, never a number.
  if (!row) throw new Error(`allocating an invoice number for org ${orgId} returned no row`);
  return row.last_number;
}
