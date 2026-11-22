// The plan catalogue a test sweeps, never the raw `plans` table (PR #1283 review G1). Six billing tests
// (lib/__tests__/billing-*.test.ts) each insert a temporary `plans` row and run in parallel on the same database (the
// threads pool), so a bare `select key from plans` sees one of them now and then and reds a sweep that has nothing to
// do with billing (CI run 45051019151, `tmp_rc_plan_*`). openapi-plan-claims.test.ts is the first reader fixed this way.
import { expect } from "vitest";
import { ALL_PLAN_KEYS, type AnyPlanKey } from "@/lib/currency";
import type { sql as Sql } from "@/lib/db";

/** Every temporary `plans` key a test inserts starts with this. retired-matrix-keys.test.ts holds every test file that
 *  inserts into `plans` to it, so the exclusion below cannot quietly stop matching. */
export const TEMP_PLAN_KEY_PREFIX = "tmp_";

/** The plans the product declares (`ALL_PLAN_KEYS`, lib/currency.ts), each PROVEN a `plans` row: a key renamed on one
 *  side reds here instead of dropping out of the caller's sweep. */
export async function declaredPlanKeys(db: typeof Sql): Promise<AnyPlanKey[]> {
  const keys = [...ALL_PLAN_KEYS];
  const rows = new Set((await db<{ key: string }[]>`select key from plans where key = any(${keys})`).map((r) => r.key));
  expect(keys.filter((k) => !rows.has(k)), "every declared plan key is a row in `plans`").toEqual([]);
  expect(keys.length, "anti-vacuity: the catalogue has plans").toBeGreaterThan(2);
  return keys;
}

/** Every `plans` row but a test's temporary one: for the REVERSE-direction guards, which hold the table to exactly the
 *  plans the code knows (a retired plan back under a new name reds them), so they cannot filter by the declared keys. */
export async function livePlanRows(db: typeof Sql): Promise<{ key: string; name: string }[]> {
  return db<{ key: string; name: string }[]>`
    select key, name from plans where not starts_with(key, ${TEMP_PLAN_KEY_PREFIX}) order by key`;
}
