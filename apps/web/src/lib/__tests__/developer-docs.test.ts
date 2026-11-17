// The developer docs are OFF for everyone by default (owner, 2026-11-16) and staff switch them on per organisation with
// an entitlement override on `developers.docs`. No plan carries the key, so a plan change can never open the docs.
//
// DB-backed on purpose: "off with no row, on with an override, off again when it lapses" is a claim about the real
// resolver, not about a constant.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { DEVELOPER_DOCS_FEATURE, developerDocsEnabledFor } from "@/lib/developer-docs";
import { seedOrg } from "@/server/usecases/__tests__/_rig";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

async function setSwitch(orgId: string, value: boolean, expiresAt: Date | null = null): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, expires_at, reason)
    values (${orgId}, ${DEVELOPER_DOCS_FEATURE}, ${value}, ${expiresAt}, 'unit: developer docs')
    on conflict (org_id, feature_key) do update set bool_value = ${value}, expires_at = ${expiresAt}`;
  await invalidateOrgEntitlements(orgId);
}

describe.skipIf(!HAS_DB)("developer docs: off by default, on per organisation", () => {
  it("no plan grants the key — the switch is the only way in", async () => {
    const rows = await sql<{ plan_key: string }[]>`
      select plan_key from plan_entitlements where feature_key = ${DEVELOPER_DOCS_FEATURE}`;
    expect(rows).toEqual([]);
    // Anti-vacuity: the table this looked in is the live matrix.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from plan_entitlements`;
    expect(n).toBeGreaterThan(100);
  });

  it("is off for nobody, off for a fresh organisation, and off for a Pro one", async () => {
    expect(await developerDocsEnabledFor([])).toBe(false);
    const free = await seedOrg();
    expect(await developerDocsEnabledFor([free.auth.orgId])).toBe(false);
    const pro = await seedOrg();
    await setOrgPlan(pro.auth.orgId, "pro");
    expect(await developerDocsEnabledFor([pro.auth.orgId]), "API access on Pro does not open the docs").toBe(false);
  });

  it("the sequence: switched on, switched off, on with a lapsed date, removed", async () => {
    const { auth } = await seedOrg();
    await setSwitch(auth.orgId, true);
    expect(await developerDocsEnabledFor([auth.orgId])).toBe(true);
    await setSwitch(auth.orgId, false);
    expect(await developerDocsEnabledFor([auth.orgId])).toBe(false);
    await setSwitch(auth.orgId, true, new Date(Date.now() - 60_000));
    expect(await developerDocsEnabledFor([auth.orgId]), "a lapsed switch is off").toBe(false);
    await setSwitch(auth.orgId, true);
    await sql`delete from org_entitlement_overrides where org_id = ${auth.orgId} and feature_key = ${DEVELOPER_DOCS_FEATURE}`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await developerDocsEnabledFor([auth.orgId])).toBe(false);
  });

  it("one switched-on organisation among a member's several is enough, and it does not leak to another member's", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const c = await seedOrg();
    await setSwitch(b.auth.orgId, true);
    expect(await developerDocsEnabledFor([a.auth.orgId, b.auth.orgId])).toBe(true);
    expect(await developerDocsEnabledFor([a.auth.orgId, c.auth.orgId])).toBe(false);
  });
});
