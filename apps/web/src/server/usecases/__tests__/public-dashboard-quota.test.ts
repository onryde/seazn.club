// `dashboard.public.max` — the cap on LIVE public dashboards, after V395
// (entitlements v18 W2 T15, owner rulings 2026-09-03).
//
// Two rulings land on one function. The cap counts **active** public
// dashboards only, and a **passed** competition does not count against it.
// `assertPublicQuota` had neither clause: it was a flat
//
//     select count(*) from competitions where visibility = 'public'
//
// so a club that had run three seasons carried three public dashboards for
// ever and was refused a fourth while nothing at all was running. That is not
// a policy gap, it is a leak — the cap counted HISTORY rather than live
// surfaces, which is why 3 felt tight and the ruled-down 2 would have felt
// broken. `assertActiveQuota` twenty lines above had solved both halves
// already, and its own comment says why ("a competition past that boundary was
// keeping a free slot for ever"); the predicate is now shared rather than
// copied, so there is no fourth place for it to drift.
//
// Every number here is READ FROM THE MATRIX, never typed: the cap moved 1 -> 3
// -> 2 across three migrations, and a test carrying a literal would have had
// to be edited each time (and would have been wrong in between).
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "../competitions";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pub " + suffix}, ${"pub-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      with _owner as (
        insert into users (email, display_name, email_verified)
        values ('pubowner-' || gen_random_uuid() || '@test.local', 'Pub Owner', true)
        returning id
      ),
      _seed_sub as (
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce(o.created_by, (select id from _owner)), ${plan}, 'active'
        from organizations o where o.id = ${orgId}
        returning id
      )
      update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  }
  // The ACTIVE-competition cap would fire first and mask everything here, so
  // lift that one axis for this org only. Same isolation the sibling probe in
  // entitlements-v2.test.ts uses.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'public-quota test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

const make = (auth: AuthCtx, name: string, visibility: "public" | "private" = "public") =>
  createCompetition(auth, { ends_on: "2030-12-31", name, visibility, branding: {} });

/** The cap the plan actually resolves — never a literal. */
const publicCap = async (auth: AuthCtx): Promise<number> => {
  const limit = await getLimit(auth.orgId, "dashboard.public.max");
  expect(limit, "dashboard.public.max must be a finite cap for this test to mean anything").not.toBeNull();
  return limit!;
};

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("assertPublicQuota counts LIVE public dashboards", () => {
  it("archived seasons do not hold a slot for ever", async () => {
    // THE REGRESSION THIS EXISTS FOR. Fill to one under the cap with live
    // competitions, then archive three more public ones — under the old flat
    // count those three still occupied slots and the next create was refused
    // (or, since the degrade below, silently turned private).
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i < cap; i += 1) await make(auth, `Live ${i}`);
    for (let i = 1; i <= 3; i += 1) {
      const past = await make(auth, `Season ${i}`);
      await sql`update competitions set status = 'archived' where id = ${past.id}`;
    }
    const next = await make(auth, "This season");
    expect(next.visibility).toBe("public");
  });

  it("still refuses once the LIVE public dashboards reach the cap", async () => {
    // The other direction, so the clause above cannot be satisfied by simply
    // deleting the cap. Enforced on the PATCH path, which still 402s — only
    // the CREATE path degrades (T15/F: never block a create).
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const extra = await make(auth, "One too many", "private");
    await expect(patchCompetition(auth, extra.id, { visibility: "public" } as never)).rejects.toMatchObject({
      status: 402,
      featureKey: "dashboard.public.max",
    });
  });

  it("a passed competition's public dashboard does not count against the cap", async () => {
    // v3/07 §3: an Event Pass buys its competition out of the quota, exactly as
    // `competitions.max_active` already treated it — for as long as the pass
    // APPLIES (V343's pass_applies), which is the shared predicate.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) {
      const comp = await make(auth, `Live ${i}`);
      if (i === 1) {
        await sql`
          insert into competition_passes (competition_id, org_id, pass_key)
          values (${comp.id}, ${auth.orgId}, 'event_pass')`;
      }
    }
    await invalidateOrgEntitlements(auth.orgId);
    // The org sits AT the cap by raw row count; one of those rows is passed, so
    // the live count is cap - 1 and there is room.
    const next = await make(auth, "Room because of the pass");
    expect(next.visibility).toBe("public");
  });

  it("Pro's cap is finite and larger than Free's (V395 retired 'unlimited public dashboards')", async () => {
    // Read from the matrix on both sides — the point is the ORDERING and the
    // finiteness, which is what the Pro card's old "unlimited" claim broke.
    const free = await seedOrg("community");
    const pro = await seedOrg("pro");
    const freeCap = await publicCap(free);
    const proCap = await publicCap(pro);
    expect(proCap).toBeGreaterThan(freeCap);
  });
});
