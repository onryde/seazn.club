// The USAGE METER for `dashboard.public.max`, against the cap it reports on.
//
// A quota has two faces: the one that refuses, and the one that tells the
// organiser how much room is left. They were the same number until the cap
// started counting `unlisted` (owner ruling 2026-09-05) — after which a meter
// still filtering `visibility = 'public'` would have shown 0/2 in the very
// moment the create path stopped publishing for them. That is not a rounding
// difference between two screens; it is the product contradicting itself about
// a number the customer is being sold.
//
// So the meter reads `PUBLICLY_READABLE_VISIBILITIES`, the same authority the
// count in `withinPublicQuota` reads, and this suite pins the two TOGETHER:
// what the panel reports and what the create path then does, in one test, from
// one seeded org. Either assertion alone passes with the other side broken.
//
// The org-settings billing page carries a THIRD copy of the same subquery
// (app/o/[orgSlug]/settings/billing/page.tsx) and now reads the same constant;
// it is a server component with no importable query, so it is covered by the
// shared constant rather than by an assertion here.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Route-level auth is stubbed — there is no cookie in a unit test. Everything
// the route actually computes runs for real. `importOriginal` is load-bearing:
// the rest of `@/lib/auth` must stay real. Same double as
// lib/__tests__/entitlements-duplicate-resolvers.test.ts.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireOrgRole: vi.fn(async () => ({
    user: { id: "d0d0d0d0-0000-4000-8000-000000000009" },
    role: "owner" as const,
  })),
}));

import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { GET as entitlementsGET } from "@/app/api/orgs/[id]/entitlements/route";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Meter " + suffix}, ${"meter-" + suffix})
    returning id`;
  // The ACTIVE-competition cap would fire first and mask the axis under test.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'usage-meter test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/**
 * A dashboard that actually METERS — created, then PUBLISHED.
 *
 * Competitions are born `draft`, and since `PUBLIC_DASHBOARD_STATUSES` a draft
 * holds no `dashboard.public.max` slot: it shows the world nothing, so it is
 * not a public dashboard. Every "fill the cap" below means a LIVE dashboard —
 * which is the whole subject of this file, since the meter and the cap must
 * agree about the same set — so filling with bare creates would fill it with
 * zero and every count here would read 0.
 *
 * Published by raw SQL rather than `patchCompetition`, because publishing past
 * the cap now 402s: routing SETUP through the guard would refuse the last
 * filler. Same reason the archived seasons below are staged with an UPDATE.
 */
const make = async (
  auth: AuthCtx,
  name: string,
  visibility: "public" | "unlisted" | "private",
) => {
  const row = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name,
    visibility,
    branding: {},
  });
  await sql`update competitions set status = 'published' where id = ${row.id}`;
  return row;
};

interface Usage {
  dashboards_public_count: number;
  competitions_active_count: number;
}

async function usage(orgId: string): Promise<Usage> {
  await invalidateOrgEntitlements(orgId);
  const res = await entitlementsGET(new Request("http://t/x"), {
    params: Promise.resolve({ id: orgId }),
  });
  const body = (await res.json()) as { ok: boolean; data: { usage: Usage } };
  expect(body.ok).toBe(true);
  return body.data.usage;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)(
  "the public-dashboard meter agrees with the cap it reports on",
  () => {
    it("counts an unlisted dashboard, and the create path degrades on the same org", async () => {
      const auth = await seedOrg();
      const cap = await getLimit(auth.orgId, "dashboard.public.max");
      expect(cap, "a finite cap is the premise of this test").not.toBeNull();

      // Fill the cap with LINK-ONLY dashboards. Every one of them is served in
      // full to an anonymous visitor holding the URL.
      for (let i = 1; i <= cap!; i += 1)
        await make(auth, `Link-only ${i}`, "unlisted");

      // The panel says the org is at its cap…
      expect((await usage(auth.orgId)).dashboards_public_count).toBe(cap);
      // …and enforcement agrees, on the same org, in the same test.
      const next = await make(auth, "One over the cap", "public");
      expect(next.visibility).toBe("private");
    });

    it("stops counting a dashboard once the season is archived, on BOTH sides", async () => {
      // The first of the two divergences. Enforcement filters on the LIVE
      // statuses (`liveUnpassedCompetition`), so a club three seasons in counts
      // ZERO and is allowed to publish. The meter had no status clause at all,
      // so it metered HISTORY: the same org read `cap`/`cap` in red while the
      // create path was still happily publishing for it. Nothing in the product
      // told the organiser which of the two screens to believe.
      const auth = await seedOrg();
      const cap = await getLimit(auth.orgId, "dashboard.public.max");
      expect(cap, "a finite cap is the premise of this test").not.toBeNull();

      for (let i = 1; i <= cap!; i += 1)
        await make(auth, `Season ${i}`, "public");
      // The premise: while they are live they DO hold their slots.
      expect((await usage(auth.orgId)).dashboards_public_count).toBe(cap);

      await sql`update competitions set status = 'archived' where org_id = ${auth.orgId}`;

      // The number is derived from the matrix, not typed: an archived season
      // holds no slot, so every one of the org's `cap` slots is free again.
      expect((await usage(auth.orgId)).dashboards_public_count).toBe(0);
      // …and that is enforcement's own answer, on the same org, in the same
      // test — the whole cap is available, every create publishes.
      for (let i = 1; i <= cap!; i += 1) {
        const next = await make(auth, `This season ${i}`, "public");
        expect(next.visibility, `create ${i} of ${cap} after archiving`).toBe(
          "public",
        );
      }
    });

    it("stops counting a dashboard an Event Pass bought out, on BOTH sides", async () => {
      // The second divergence. A pass buys its competition out of the quota for
      // as long as the pass APPLIES (v3/07 §3, `pass_applies`) — enforcement
      // stops counting it; the meter counted it anyway and read the org full.
      const auth = await seedOrg();
      const cap = await getLimit(auth.orgId, "dashboard.public.max");
      expect(cap).not.toBeNull();

      const passed = await make(auth, "Passed event", "public");
      expect((await usage(auth.orgId)).dashboards_public_count).toBe(1);

      await sql`insert into competition_passes (competition_id, org_id, pass_key)
              values (${passed.id}, ${auth.orgId}, 'event_pass')`;

      expect((await usage(auth.orgId)).dashboards_public_count).toBe(0);
      // So the org still holds its WHOLE cap, and enforcement proves it by
      // publishing all of it.
      for (let i = 1; i <= cap!; i += 1) {
        const next = await make(auth, `Still room ${i}`, "public");
        expect(
          next.visibility,
          `create ${i} of ${cap} beside a passed event`,
        ).toBe("public");
      }
    });

    it("does not count a private competition", async () => {
      // The negative pair: without it the assertion above is satisfied by a
      // meter that counts every competition the org has ever made.
      const auth = await seedOrg();
      await make(auth, "Nobody's business", "private");
      expect((await usage(auth.orgId)).dashboards_public_count).toBe(0);
    });
  },
);
