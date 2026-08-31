import "server-only";
// The competition_events audit ledger writer (016 pattern) — split out of
// `registrations.ts` (RS011) so `registration-eligibility.ts` can call it
// too. `registration-eligibility.ts` is a deliberate LEAF: its own header
// says "it imports nothing from `registrations.ts` or any other usecase, so
// `registrations.ts` ... can import THIS module without a cycle" — and
// `registrations.ts` already imports `ageAt`/`isMinor`/`requiresDob`/
// `requiresGender` FROM `registration-eligibility.ts`. Importing `audit`
// the other way (eligibility → registrations) would make that a real
// circular import, undoing the leaf invariant the header documents. This
// tiny module breaks the cycle the same way `@/lib/registration-rules` does
// for the pure predicates: one shared leaf both sides import.
//
// `registrations.ts` re-exports `audit` verbatim so every existing importer
// (`registration-approval.ts`, `registration-assign.ts`, both of which do
// `import { audit } from "./registrations"`) keeps compiling unchanged.
import type postgres from "postgres";
import { sql } from "@/lib/db";

// Both the superuser client and a withTenant tx serve this helper
// (TransactionSql omits connection controls, so it isn't a plain Sql) —
// mirrors registrations.ts's own AnySql.
type AnySql = postgres.TransactionSql | postgres.Sql;

/** Append to the competition_events audit ledger (016 pattern). */
export async function audit(
  db: AnySql,
  competitionId: string,
  orgId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  await db`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${competitionId}, ${orgId}, ${type}, ${sql.json(payload as never)}, ${actorId})`;
}
