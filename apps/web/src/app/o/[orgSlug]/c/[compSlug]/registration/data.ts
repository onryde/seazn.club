// The Settings tab's data layer. It lives beside page.tsx rather than inside
// it because Next tolerates only a fixed export surface from a page module
// (default, `metadata`, `dynamic`, `generateStaticParams`, …) — a helper
// exported from page.tsx is a build-time hazard, and src/__tests__/
// app-module-exports.test.ts is the sweep that says so. It caught these three
// on RS004's first full CI run; nothing local runs that suite.
import { withTenant } from "@/lib/db";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RegistrationHubRowData } from "@/components/registration-hub-division-row";

export interface RawDivisionRow {
  division_id: string;
  name: string;
  category: RegistrationHubRowData["category"];
  age_min: number | null;
  age_max: number | null;
  enabled: boolean;
  entrant_kind: RegistrationHubRowData["entrant_kind"];
  opens_at: Date | string | null;
  closes_at: Date | string | null;
  capacity: number | null;
  fee_cents: number;
  approval: RegistrationHubRowData["approval"];
  allow_free_agents: boolean;
  taken: number;
  /** Same value on every row (org-level, RS001b) — carried per-row rather
   *  than fetched separately so this stays a SINGLE query for the rows. */
  org_currency: string;
  /** Same value on every row (org-level) — non-null when the org's
   *  connected Stripe account settles outside the registration-currency
   *  allowlist, meaning card collection is not viable (RS004 W3c config
   *  panel). Read the same way app/o/[orgSlug]/settings/page.tsx derives
   *  it for its (owner-and-admin) audience — a raw column read, not through
   *  stripe-connect.ts's connectStatus(), which is owner-session-only and
   *  would 403 an admin opening this hub. */
  org_stripe_unsupported_currency: string | null;
}

/** The Settings tab's one query: every (non-archived) division of this
 *  competition, LEFT JOINed to its registration_settings (a division not yet
 *  configured has no row there at all), with the live spot-count and the
 *  org's registration currency riding along — no client fetch, no N+1. */
export async function fetchDivisionRows(
  auth: Pick<AuthCtx, "orgId">,
  competitionId: string,
): Promise<RawDivisionRow[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<RawDivisionRow[]>`
      select
        d.id as division_id,
        d.name,
        d.category,
        d.age_min,
        d.age_max,
        coalesce(rs.enabled, false) as enabled,
        rs.entrant_kind,
        rs.opens_at,
        rs.closes_at,
        rs.capacity,
        coalesce(rs.fee_cents, 0) as fee_cents,
        rs.approval,
        coalesce(rs.allow_free_agents, false) as allow_free_agents,
        (select count(*)::int from registrations r
           where r.division_id = d.id and r.status in ${tx([...SPOT_HOLDERS])}) as taken,
        (select currency from organizations where id = ${auth.orgId}) as org_currency,
        (select stripe_unsupported_currency from organizations where id = ${auth.orgId})
          as org_stripe_unsupported_currency
      from divisions d
      left join registration_settings rs on rs.division_id = d.id
      where d.competition_id = ${competitionId} and d.archived_at is null
      order by d.name, d.id`,
  );
}

/** Finding 6 fallback: `fetchDivisionRows`'s `org_currency` column rides on
 *  a DIVISION row, so a competition with zero (non-archived) divisions
 *  returns zero rows — nothing to read a currency off at all, and
 *  `asCurrency(rawRows[0]?.org_currency)` silently defaulted to "usd".
 *  Only called from that empty-rows branch below; the common case (rows
 *  exist) keeps reading org_currency off rawRows[0] at zero extra queries,
 *  so this never runs alongside a non-empty result and fetchDivisionRows
 *  itself still costs exactly one round trip. */
export async function fetchOrgCurrency(auth: Pick<AuthCtx, "orgId">): Promise<string> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ currency: string }[]>`
      select currency from organizations where id = ${auth.orgId}`;
    return row?.currency ?? "usd";
  });
}

/** The SAME finding-6 shape as `fetchOrgCurrency`, for the config panel's
 *  card-unsupported-currency message: `fetchDivisionRows`'s own column
 *  rides on a division row, so a Settings-tab competition with zero
 *  (non-archived) divisions has none to read it off. Only called from that
 *  empty-rows branch below — the common case reads it off `rawRows[0]` at
 *  zero extra queries, same as org_currency. */
export async function fetchOrgCardUnsupportedCurrency(
  auth: Pick<AuthCtx, "orgId">,
): Promise<string | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ stripe_unsupported_currency: string | null }[]>`
      select stripe_unsupported_currency from organizations where id = ${auth.orgId}`;
    return row?.stripe_unsupported_currency ?? null;
  });
}
