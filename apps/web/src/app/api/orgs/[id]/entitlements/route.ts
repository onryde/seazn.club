import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import {
  countActiveCompetitions,
  countPublicDashboards,
} from "@/server/usecases/entitlement-freeze";
import { getLimit, hasFeature } from "@/lib/entitlements";
import { handler } from "@/lib/http";
import { ORG_ROLES } from "@/lib/types";

/** Key list only — the plan row says WHICH keys the panel shows and whether a
 *  key is a boolean feature or a numeric quota. The VALUES come from the
 *  resolver, never from this row. */
interface EntitlementKeyRow {
  feature_key: string;
  is_boolean: boolean;
}

/** Resolved entitlements + current usage for an org (any member may read). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id: orgId } = await params;
    await requireOrgRole(orgId, ORG_ROLES);

    const [sub] = await sql<{
      plan_key: string;
      status: string;
      trial_end: string | null;
      current_period_end: string | null;
    }[]>`
      select s.plan_key, s.status, s.trial_end, s.current_period_end
      from subscriptions s
      join organizations o on o.subscription_id = s.id
      where o.id = ${orgId}`;

    const planKey = sub?.plan_key ?? "community";
    const status = sub?.status ?? "active";

    // The panel must promise exactly what enforcement delivers, so this route
    // no longer resolves anything itself. It used to union overrides in raw SQL
    // with no expires_at filter, no comped_until degradation and no past_due
    // grace — and it coalesced int_value, which silently demoted every staff
    // "unlimited" grant to the plan's number. plan_entitlements is now read for
    // the KEY LIST only; every value comes from lib/entitlements.
    const rows = await sql<EntitlementKeyRow[]>`
      select feature_key, bool_value is not null as is_boolean
      from plan_entitlements
      where plan_key = ${planKey}
      order by feature_key`;

    // v2 usage (PROMPT-13): what the UI compares against the v2 quota keys.
    //
    // NOT this route's own SQL. Both numbers come from the functions
    // enforcement itself counts with (`server/usecases/entitlement-freeze.ts`),
    // because a meter and a cap are two faces of ONE fact and this route had
    // the other implementation of it. Its copy carried neither the status
    // filter nor the Event-Pass exclusion, so it metered HISTORY and it
    // metered competitions a pass had bought out: a Free org with 2 live
    // public competitions and 3 archived seasons read 5/2 in red while the
    // create path was still publishing for it. See `quotaCount` for the pair
    // of divergences and why an agreeing second copy is still the defect.
    const competitionsActiveCount = await countActiveCompetitions(orgId);
    const dashboardsPublicCount = await countPublicDashboards(orgId);

    // Org-level questions, so no competition id: an Event Pass lifts a single
    // competition, not the org, and the 2-arg call is what asks that question.
    //
    // Cost, stated plainly. hasFeature/getLimit are cache-aside (5-min TTL), so
    // a WARM cache is N cache reads and nothing else. A COLD cache is not: each
    // key falls through to resolveFromDb, which issues three queries (the
    // org-plan CASE, plan_entitlements, org_entitlement_overrides), so ~40 keys
    // is ~120 queries against a pool of max: 5 (lib/db.ts:48) — and the org-plan
    // query is byte-identical across all N keys, re-run N times. The known
    // optimisation is a `resolveMany` batch API on lib/entitlements (resolve the
    // org plan once, then fetch all keys in one plan_entitlements + one
    // overrides query); it is a deliberate follow-up, not an oversight. Until
    // then this route stays on the single resolver on purpose: for a
    // low-traffic panel read, matching enforcement exactly beats being fast,
    // and a second resolution path here is precisely the drift this route was
    // just cured of.
    const entitlements = Object.fromEntries(
      await Promise.all(
        rows.map(async (r) =>
          r.is_boolean
            ? ([r.feature_key, { enabled: await hasFeature(orgId, r.feature_key) }] as const)
            : ([r.feature_key, { limit: await getLimit(orgId, r.feature_key) }] as const),
        ),
      ),
    );

    return {
      plan_key: planKey,
      status,
      trial_end: sub?.trial_end ?? null,
      current_period_end: sub?.current_period_end ?? null,
      usage: {
        competitions_active_count: competitionsActiveCount,
        dashboards_public_count: dashboardsPublicCount,
      },
      entitlements,
    };
  });
}
