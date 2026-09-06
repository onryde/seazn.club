import "server-only";
import { sql } from "@/lib/db";
import { PRICING_PLAN_KEYS, type MatrixData } from "@/lib/pricing-matrix";

/**
 * The `plan_entitlements` slice every purchasable-plan marketing surface reads.
 *
 * Lifted out of `/[lang]/pricing/page.tsx`, where it lived as a local
 * `loadMatrix`, when the plan-card bullets moved into the dictionaries: their
 * numbers are interpolated from these rows, and the home page's ticket stubs
 * render the same bullets. Two copies of this query would be two chances for
 * the two surfaces to quote different caps for the same plan — the exact drift
 * `PRICING_PLAN_KEYS` was made a single list to prevent.
 *
 * Callers fail soft (`.catch(() => ({}))`): the DB may be unreachable at build,
 * and a marketing page must still render. `cardBullets` drops a bullet whose
 * figures it cannot read rather than printing a hole.
 */
export async function loadPricingMatrix(): Promise<MatrixData> {
  const rows = await sql<
    { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
  >`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements
    where plan_key = any(${[...PRICING_PLAN_KEYS]})`;
  const data: MatrixData = {};
  for (const r of rows) {
    (data[r.feature_key] ??= {})[r.plan_key] = {
      bool_value: r.bool_value,
      int_value: r.int_value,
    };
  }
  return data;
}
