// The "Powered by seazn.club" badge, after V395 (entitlements v18 W2 T15,
// owner ruling 2026-09-03): **shown on every plan except enterprise.**
//
// `dashboard.branding` is inverted copy — TRUE means the badge is REMOVED — so
// the product statement and the matrix cell read opposite ways round, which is
// exactly why this suite asserts the STATEMENT ("does a visitor see the
// badge?") rather than the row. A test that pinned `bool_value` would pass just
// as happily with the meaning flipped.
//
// This overturns design §2's own note on that cell, "D7, never moves". It has
// moved, deliberately: badge removal becomes an ENTERPRISE-only feature, which
// is where R3 already puts white label. Do not restore Pro's true on the
// strength of that note — it is the older decision.
//
// The predicate under test is the SQL one, `org_has_feature` (V344), because
// that is what the public tree actually reads: `loadOrg` in
// server/public-site/data.ts selects `org_has_feature(o.id,
// 'dashboard.branding') as branded`, and `shared/[orgSlug]/layout.tsx` renders
// the attribution rail with `{org.branded ? null : …}`. The TS resolver is
// asserted alongside it so the two cannot answer differently for this key.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: string): Promise<{ orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`badge-${suffix}@test.local`}, 'Badge', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Badge " + suffix}, ${"badge-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return { orgId };
}

/** What a visitor sees, through the predicate the public tree really uses. */
async function badgeShown(orgId: string): Promise<boolean> {
  const [row] = await sql<{ branded: boolean }[]>`
    select org_has_feature(${orgId}, 'dashboard.branding') as branded`;
  return !row!.branded;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the seazn badge (V395: every plan except enterprise)", () => {
  it("is shown to a Free org's visitors", async () => {
    const { orgId } = await seedOrg("community");
    expect(await badgeShown(orgId)).toBe(true);
    expect(await hasFeature(orgId, "dashboard.branding")).toBe(false);
  });

  it("is shown to a PRO org's visitors — the cell V395 moved", async () => {
    // Pro carried `dashboard.branding` true from V112 all the way to V394, so
    // this is the assertion that fails if the migration is reverted. Read
    // through the resolver, not off the row: `plan_entitlements` could hold
    // false and this could still come out true through an override or an
    // add-on, and it is the resolved answer a visitor sees.
    const { orgId } = await seedOrg("pro");
    expect(await badgeShown(orgId)).toBe(true);
    expect(await hasFeature(orgId, "dashboard.branding")).toBe(false);
  });

  it("is removed for an enterprise org — the only plan that buys it", async () => {
    const { orgId } = await seedOrg("enterprise");
    expect(await badgeShown(orgId)).toBe(false);
    expect(await hasFeature(orgId, "dashboard.branding")).toBe(true);
  });

  it("stays shown for a Free org holding an Event Pass, on the passed competition too", async () => {
    // Badge removal is org-level and a pass cannot lift it — the pass rows are
    // false on both rungs, and even the competition-scoped resolve (which is
    // what would pick a pass row up) answers false. An intermediate ruling on
    // 2026-09-03 set the pass rungs TRUE; it was never built, and this case is
    // what would catch it being built by mistake later.
    const { orgId } = await seedOrg("community");
    const suffix = randomUUID().slice(0, 8);
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility)
      values (${orgId}, ${"Cup " + suffix}, ${"cup-" + suffix}, 'public') returning id`;
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${compId}, ${orgId}, 'event_pass')`;
    await invalidateOrgEntitlements(orgId);
    expect(await badgeShown(orgId)).toBe(true);
    expect(await hasFeature(orgId, "dashboard.branding", compId)).toBe(false);
  });
});
