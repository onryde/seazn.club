// `streaming.overlay` (R1): granted by NO plan, hidden from /pricing by being
// absent from ENTITLEMENT_DOMAINS, lifted for one org by an override row.
//
// Two halves on purpose. The catalogue half is a pure unit — it is the thing a
// later "tidy the domains list" edit would break silently. The resolver half is
// DB-backed, because "false for a fresh org, true after an override" is a claim
// about the real resolver's precedence (entitlements.ts:441 override first),
// not about a constant.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = "streaming.overlay";
/** What the test org's override row grants — owner answer 14 (Q3). Both, always:
 *  the overlay's whole promise is a score that keeps up with the picture. */
const GRANTED = [KEY, "realtime"] as const;

describe("streaming.overlay is unadvertised", () => {
  it("is in NO ENTITLEMENT_DOMAINS section — that omission is what keeps it off /pricing", () => {
    const listed = ENTITLEMENT_DOMAINS.flatMap((d) => d.features);
    expect(listed).not.toContain(KEY);
  });

  it("the domains list is otherwise untouched by this wave", () => {
    // A positive pair for the negative above: if a future edit deleted the
    // whole list, the assertion above would pass vacuously.
    expect(ENTITLEMENT_DOMAINS.length).toBeGreaterThanOrEqual(5);
    expect(ENTITLEMENT_DOMAINS.flatMap((d) => d.features)).toContain("embeds.enabled");
  });
});

describe.skipIf(!HAS_DB)("streaming.overlay resolves", () => {
  // Amended 2026-09-07 (design §5.1): V402 seeds BOTH keys, so the catalogue
  // claim is made for both — a migration that forgot `streaming.relay` would
  // leave the Phone tab's gate with no row to flip at GA.
  it.each(["streaming.overlay", "streaming.relay"] as const)("carries a catalogue row for every plan for %s, all false", async (key) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements where feature_key = ${key}`;
    const plans = await sql<{ key: string }[]>`select key from plans`;
    expect(rows.length, "a missing row already denies, but /admin needs the key visible under \"other\"")
      .toBe(plans.length);
    expect(plans.length, "the v18 plan set (V393): community, pro, event_pass, event_pass_l, enterprise").toBe(5);
    for (const row of rows) expect(row.bool_value, `${key} on ${row.plan_key}`).toBe(false);
  });

  it("is false for a fresh org and true after an org_entitlement_overrides row", async () => {
    const { auth } = await seedOrg();
    expect(await hasFeature(auth.orgId, KEY), "no plan grants it").toBe(false);

    // Owner answer 14 (Q3), "we are using supabase realtime": the test org's
    // override grants BOTH keys. `/api/v1/public/fixtures/[id]/realtime-token`
    // 403s without `realtime`, and the client then falls back to a 15 s poll —
    // a score that lags the picture by up to fifteen seconds on a live
    // broadcast, which viewers read as our bug. Granting only `streaming.overlay`
    // ships the feature in its broken form. Whether every PLAN that grants one
    // must grant the other is deferred to pricing (Q4) and is deliberately not
    // encoded anywhere in code.
    for (const key of GRANTED) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${auth.orgId}, ${key}, true, 'unit: stream overlay W1')
        on conflict (org_id, feature_key) do update set bool_value = true, expires_at = null`;
    }
    await invalidateOrgEntitlements(auth.orgId);
    expect(await hasFeature(auth.orgId, KEY), "the resolver ranks the override first").toBe(true);
    expect(
      await hasFeature(auth.orgId, "realtime"),
      "without this the overlay polls, and a 15 s-stale score goes out on air",
    ).toBe(true);

    await sql`
      update org_entitlement_overrides set bool_value = false
       where org_id = ${auth.orgId} and feature_key = ${KEY}`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await hasFeature(auth.orgId, KEY), "and the other direction, so the flip is real").toBe(false);
  });

  it("does not leak into another org", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${a.auth.orgId}, ${KEY}, true, ${"unit " + randomUUID().slice(0, 6)})
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(a.auth.orgId);
    expect(await hasFeature(b.auth.orgId, KEY)).toBe(false);
  });
});
