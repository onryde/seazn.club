// Match Day PB3 item 6 - `publicSlotsLeft`: how many public dashboards the org can still open, for the New competition form's
// cap-aware "Who will find it". Its whole job is to agree with what the create will DO, so the heart of this file is a differential
// against the real `resolveCreateVisibility` at every point of a filling cap, for every visibility, and the form's own client rule
// (`createdPrivateOverCap`) is asked the same question beside them: three authorities that must never disagree.
//
// Every number is READ FROM THE MATRIX (`getLimit`), never typed: the cap has moved 1 -> 3 -> 2. Real Postgres required; skipped
// without DATABASE_URL.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` has no incrementalCache outside a real request (same double as public-dashboard-quota.test.ts).
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { createdPrivateOverCap } from "@/lib/competition-listing";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, publicSlotsLeft, resolveCreateVisibility } from "../competitions";
import { countPublicDashboards } from "../entitlement-freeze";

const HAS_DB = !!process.env.DATABASE_URL;
const VISIBILITIES = ["private", "unlisted", "public"] as const;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Slots " + suffix}, ${"slots-" + suffix})
    returning id`;
  // The ACTIVE-competition cap would fire first and mask the public one; lift that one axis for this org only.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'public-slots-left test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A competition that actually METERS: created PRIVATE, then given its visibility and published by raw SQL. Two reasons for the detour:
 *  a draft holds no slot and the PATCH guard would refuse the last filler, and - the one that matters - `createCompetition` itself
 *  DEGRADES a public create once the cap is full, so going through it could never put an org PAST the cap (a plan downgrade, an Event
 *  Pass lapsing, which is exactly where `left` must clamp at 0). */
async function make(auth: AuthCtx, visibility: (typeof VISIBILITIES)[number], status = "published") {
  const row = await createCompetition(auth, { ends_on: "2030-12-31", name: `c-${randomUUID().slice(0, 6)}`, visibility: "private", branding: {} });
  await sql`update competitions set status = ${status}, visibility = ${visibility} where id = ${row.id}`;
  return row;
}

describe.skipIf(!HAS_DB)("publicSlotsLeft", () => {
  it("agrees with the create at every point of a filling cap, for every visibility (and with the form's rule)", async () => {
    const auth = await seedOrg();
    const limit = await getLimit(auth.orgId, "dashboard.public.max");
    expect(limit, "premise: a community org is capped (read from the matrix)").not.toBeNull();
    const cap = limit as number;
    expect(cap).toBeGreaterThanOrEqual(1);
    let checked = 0;
    // 0 .. cap + 1 metered competitions: one PAST the cap too, because setup bypasses the guard and `left` must clamp at 0.
    for (let used = 0; used <= cap + 1; used++) {
      const slots = await publicSlotsLeft(auth.orgId);
      expect(slots, `used ${used}`).toEqual({ limit: cap, left: Math.max(0, cap - used) });
      for (const v of VISIBILITIES) {
        const degraded = (await resolveCreateVisibility(auth, v)).degraded !== null;
        expect(createdPrivateOverCap(v, slots!.left), `used ${used} / ${v}: the form's rule vs the create`).toBe(degraded);
        checked++;
      }
      await make(auth, "public");
    }
    expect(checked, "anti-vacuity").toBe((cap + 2) * VISIBILITIES.length);
    // The sequence's last state really was PAST the cap (a count above the limit, read from the same counter the create uses), or the
    // clamp at 0 was never witnessed: without it `limit - count` would read -1 and the loop above could not tell.
    expect(await countPublicDashboards(auth.orgId), "setup must have put the org past its cap").toBeGreaterThan(cap);
    expect((await publicSlotsLeft(auth.orgId))!.left).toBe(0);
  });

  it("only what the cap meters takes a slot: a private competition, a draft and a finished one leave it alone", async () => {
    const auth = await seedOrg();
    const cap = (await getLimit(auth.orgId, "dashboard.public.max")) as number;
    await make(auth, "private");
    await make(auth, "public", "draft");
    await make(auth, "unlisted", "completed");
    await make(auth, "public", "archived");
    expect((await publicSlotsLeft(auth.orgId))!.left, "none of the four is metered").toBe(cap);
    // Positive pair: a published link-only competition IS metered (the one-word bypass the owner closed on 2026-09-05).
    await make(auth, "unlisted");
    expect((await publicSlotsLeft(auth.orgId))!.left).toBe(cap - 1);
  });

  it("a finished competition gives its slot back (the sequence after a withdrawal)", async () => {
    const auth = await seedOrg();
    const cap = (await getLimit(auth.orgId, "dashboard.public.max")) as number;
    const rows = [];
    for (let i = 0; i < cap; i++) rows.push(await make(auth, "public"));
    expect((await publicSlotsLeft(auth.orgId))!.left).toBe(0);
    await sql`update competitions set status = 'completed' where id = ${rows[0]!.id}`;
    expect((await publicSlotsLeft(auth.orgId))!.left).toBe(1);
  });

  it("no cap means no number: an org whose limit is unlimited reads null, not Infinity or a huge count", async () => {
    const auth = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${auth.orgId}, 'dashboard.public.max', null, 'public-slots-left test: unlimited')`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await getLimit(auth.orgId, "dashboard.public.max"), "premise: the override made it unlimited").toBeNull();
    await make(auth, "public");
    expect(await publicSlotsLeft(auth.orgId)).toBeNull();
    expect(createdPrivateOverCap("public", null)).toBe(false);
  });
});
