import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  TAG,
  apiJson,
  planCapSql,
  planFlagSql,
  communityLimit,
  mintLoginPathBySql,
  grantCompetitionPassSql,
  setOwnerStaffSql,
} from "./helpers";
// Type-only — erased at build, so it never triggers `@/` alias resolution or
// currency.ts's runtime import chain (same discipline as event-pass.spec.ts's
// header comment on `PassKey`/`PassLockReason`).
import type { PassKey } from "../src/lib/currency";

// W4 Task 5 (N1) — the enterprise tier and V393's moved caps had no browser
// proof. Five mechanisms are asserted here:
//
//   C1  schedule.checkpoints.max ROLLS a window rather than 402ing at the cap
//       (#382) — enumerated across the whole plan table, because this is
//       exactly the number (pro 5 -> 10, V393) a deleted spec once hardcoded
//       and never noticed move.
//   C2  api.write is the enterprise-only scope on api key minting, both
//       directions (a plan with api.access but not api.write; a plan with
//       neither).
//   C3  dashboard.branding's real surface (see note below — NOT a settings
//       paywall, which this key does not have).
//   C4  SKIPPED. `officials.auto` competition-scoping already has full,
//       both-direction, three-route HTTP coverage in
//       `e2e/pass-scope-officials.spec.ts` (W2 T6, merged). Re-writing it here
//       would assert nothing new and cost a slow duplicate browser test — the
//       same call the brief itself made for the enterprise-ceiling ladder
//       (already covered by entitlements-v18-enterprise-ceiling.test.ts).
//   C5  /admin/entitlements renders one column per plan, enterprise included.
//
// ── Why C3 is not what the plan brief described ─────────────────────────────
// The brief's premise was a `settings?tab=branding` panel gated by
// `[data-feature="dashboard.branding"]`, offering "Contact us" instead of
// "Go Pro". That surface does not exist. `dashboard.branding` was split from
// the org brand-COLOUR picker in V397 (entitlements v18 W2 T17) and is now
// "badge removal, alone" (server/public-site/data.ts:354) — there is no
// settings tab, no write action, and therefore no `requireFeature` call and no
// PaymentRequiredError for this key anywhere in the app (grepped exhaustively:
// its only runtime consumer is `org_has_feature(o.id, 'dashboard.branding')`
// in loadOrg). There is also no "Contact us" CTA anywhere in the product for
// enterprise at all — `/pricing` and the org settings billing upgrade grid
// both omit the enterprise card entirely (grepped; zero hits for "Contact
// us"). So the real, and previously undriven, surface of this key is the
// PUBLIC "Powered by Seazn Club" attribution footer
// (`(public)/shared/[orgSlug]/layout.tsx:110`, `{org.branded ? null : (...)}`)
// — unauthenticated, and exactly the mechanism V396 made enterprise-only.
//
// ── Why C5 reads entitlement-admin.ts as TEXT, not as a module ──────────────
// `entitlement-admin.ts` re-exports `lib/currency.ts`'s `ALL_PLAN_KEYS`, and
// currency.ts pulls in `@/config/stripe-plans.json` with a bare (unattributed)
// import. apps/web is "type": "module", so under Node's ESM loader that import
// is refused — the exact trap `e2e/price-kit.ts`'s header documents for the
// same file, and it fires whether the import is static or dynamic (only the
// TIMING differs — collection vs. this one test). Reading the source text and
// pulling out the `ADMIN_PLAN_LABEL` object keeps the assertion driven by the
// live file rather than a number retyped here, without ever loading the
// poisoned module graph.
//
// Seeds are run-unique; every block seeds its own org and owner (never
// AUTH_STATE's shared Pro org, never setOrgPlanBySql on it) — W4 Task 3's
// context note and event-pass.spec.ts's `seedRig` precedent.

const CHECKPOINTS = "schedule.checkpoints.max";

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

type PlanArg = "community" | "pro" | "event_pass" | "event_pass_l" | "enterprise";

interface Rig {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
  competitionId: string;
  divisionId: string;
}

/** A fresh org + owner on `plan`, with one open competition and one generic
 *  division. Pass rungs (`event_pass`/`event_pass_l`) seed the SUBSCRIPTION at
 *  community and grant the pass on the competition — the resolver's pass arm
 *  only fires while the resolved plan is community (V393). Never touches
 *  AUTH_STATE's shared Pro org or its budget. */
async function seedOrgOnPlan(plan: PlanArg): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `eg-${plan}-${tag}@example.com`;
  const orgSlug = `eg-${plan}-org-${tag}`;
  const compSlug = `eg-${plan}-cup-${tag}`;
  const subscriptionPlan = plan === "event_pass" || plan === "event_pass_l" ? "community" : plan;

  const rig = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"EG Owner " + tag}, true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"EG Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, ${subscriptionPlan}, 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${orgId}`;
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
      on conflict do nothing`;
    const [{ module_version: moduleVersion }] = await sql<{ module_version: string }[]>`
      select module_version from sports where key = 'generic'`;
    const [{ id: competitionId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, branding, ends_on)
      values (${orgId}, ${"EG Cup " + tag}, ${compSlug}, 'unlisted', ${sql.json({})}, '2099-12-31')
      returning id`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions
        (competition_id, name, slug, sport_key, variant_key, config, module_version, tiebreakers, youth)
      values (${competitionId}, 'Open', ${"open-" + tag}, 'generic', 'score',
              ${sql.json(GENERIC_CONFIG)}, ${moduleVersion}, null, false)
      returning id`;
    return { orgId, orgSlug, ownerEmail, competitionId, divisionId };
  });

  if (plan === "event_pass" || plan === "event_pass_l") {
    await grantCompetitionPassSql(rig.orgId, rig.competitionId, plan as PassKey);
  }
  return rig;
}

/** Sign in as a seeded owner (mints the login token directly in the DB — no
 *  magic-link rate limit to trip). API calls after this MUST go through
 *  `page.request`, never the bare `request` fixture: `request` picks up the
 *  project's `storageState` (AUTH_STATE, the shared Pro org's session), so a
 *  bare `request` call here would authenticate as a DIFFERENT org entirely and
 *  404/401 against this rig's resources. Same rule event-pass.spec.ts's
 *  `passCheckoutProbeStatus` states for the same reason. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(await mintLoginPathBySql(email));
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/magic-link") && !u.pathname.startsWith("/login"),
    { timeout: 30_000 },
  );
}

// ===========================================================================
// C1 — schedule.checkpoints.max rolls a window rather than refusing (#382)
// ===========================================================================

test.describe("save points roll a window rather than refusing", () => {
  // Enumerate the TABLE, not a sample: the pro rung moved 5 -> 10 under V393
  // right next to three plans that did not, and that is exactly the kind of
  // drift a single-sample test cannot see.
  for (const plan of ["community", "pro", "event_pass", "event_pass_l", "enterprise"] as const) {
    test(`${plan}: the cap+1th save point evicts the oldest, and nothing 402s`, async ({ page }) => {
      const cap = await planCapSql(CHECKPOINTS, plan);
      if (cap == null) {
        // enterprise is unlimited (null cap). Assert that fact rather than
        // skip it — a skipped row proves nothing, and "unlimited" is a real
        // claim about the plan.
        expect(plan, `${plan} has a null ${CHECKPOINTS} cap — only enterprise may`).toBe(
          "enterprise",
        );
        return;
      }

      const rig = await seedOrgOnPlan(plan);
      await signIn(page, rig.ownerEmail);

      for (let i = 0; i < cap + 1; i++) {
        const res = await apiJson(
          page.request,
          `/api/v1/divisions/${rig.divisionId}/checkpoints`,
          "POST",
          { label: `${TAG}-cp-${i}` },
        );
        expect(res.status, `save point ${i + 1} of ${cap + 1} on ${plan}`).toBeLessThan(400);
      }

      const list = await apiJson<{ label: string }[]>(
        page.request,
        `/api/v1/divisions/${rig.divisionId}/checkpoints`,
        "GET",
      );
      expect(list.data).toHaveLength(cap);
      // The ROLL, not merely the count: the first one written is the one gone.
      expect((list.data ?? []).map((c) => c.label)).not.toContain(`${TAG}-cp-0`);
    });
  }

  // The differential row: if these two ever read equal, the matrix read above
  // has collapsed and every row above is asserting nothing.
  test("the plans do not all share one ceiling", async () => {
    const [community, pro] = await Promise.all([
      communityLimit(CHECKPOINTS),
      planCapSql(CHECKPOINTS, "pro"),
    ]);
    expect(pro).not.toBe(community);
  });
});

// ===========================================================================
// C2 — api.write is the enterprise-only scope (api-keys.ts:42, :47)
// ===========================================================================

test.describe("api.write is the enterprise-only scope", () => {
  test("refuses a write-scoped key on pro, and STILL mints a read-only one", async ({ page }) => {
    const rig = await seedOrgOnPlan("pro");
    await signIn(page, rig.ownerEmail);

    const refused = await apiJson(page.request, `/api/v1/orgs/${rig.orgId}/api-keys`, "POST", {
      name: `${TAG}-write`,
      scopes: ["read", "write"],
    });
    expect(refused.status, "a write scope on pro must be refused").toBe(402);
    expect(
      ((refused.error as Record<string, unknown> | undefined)?.feature as string | undefined) ??
        refused.error?.message ??
        "",
      "must name api.write, not just refuse",
    ).toContain("api.write");

    // The positive pair. Without it, a build that refused ALL key minting
    // would pass the row above and look correct.
    const minted = await apiJson<{ secret: string }>(
      page.request,
      `/api/v1/orgs/${rig.orgId}/api-keys`,
      "POST",
      { name: `${TAG}-read`, scopes: ["read"] },
    );
    expect(minted.status, "a read-only key must still mint on pro").toBeLessThan(400);
    expect(minted.data?.secret).toBeTruthy();
  });

  // api.access is checked FIRST (api-keys.ts:42) and api.write second (:47).
  // Two guards covering for each other are each untested, so one row has to
  // separate them: a plan without api.access must fail differently.
  test("an api.access refusal is not an api.write refusal", async ({ page }) => {
    const rig = await seedOrgOnPlan("community");
    await signIn(page, rig.ownerEmail);

    const res = await apiJson(page.request, `/api/v1/orgs/${rig.orgId}/api-keys`, "POST", {
      name: `${TAG}-none`,
      scopes: ["read"],
    });
    expect(res.status).toBe(402);
    expect(
      ((res.error as Record<string, unknown> | undefined)?.feature as string | undefined) ??
        res.error?.message ??
        "",
    ).toContain("api.access");
  });
});

// ===========================================================================
// C3 — dashboard.branding: the public attribution footer, enterprise-only
// ===========================================================================

test.describe("dashboard.branding gates the public attribution footer", () => {
  test("an Enterprise org's public page hides it; a Pro org's still carries it", async ({
    page,
  }) => {
    const pro = await seedOrgOnPlan("pro");
    const enterprise = await seedOrgOnPlan("enterprise");

    // No auth anywhere under (public)/shared — a bare page.goto is enough.
    await page.goto(`/shared/${pro.orgSlug}`);
    await expect(
      page.getByText("Powered by", { exact: false }),
      "pro has not paid for badge removal (enterprise-only since V396)",
    ).toBeVisible();

    await page.goto(`/shared/${enterprise.orgSlug}`);
    await expect(
      page.getByText("Powered by", { exact: false }),
      "enterprise is the one plan that may remove it",
    ).toHaveCount(0);

    // The matrix side of the same fact, so a passing browser check above is
    // never mistaken for a coincidence of what happened to render.
    expect(await planFlagSql("dashboard.branding", "pro")).not.toBe(true);
    expect(await planFlagSql("dashboard.branding", "enterprise")).toBe(true);
  });
});

// ===========================================================================
// C5 — /admin/entitlements renders one column per plan, enterprise included
// ===========================================================================

/** `ADMIN_PLAN_LABEL` read from the live source file — see the file header for
 *  why this cannot be a module import. Values are plain string literals, so
 *  evaluating the captured object expression is safe. */
function readAdminPlanLabel(): Record<string, string> {
  const url = new URL("../src/lib/entitlement-admin.ts", import.meta.url);
  const src = readFileSync(url, "utf8");
  const m = src.match(/export const ADMIN_PLAN_LABEL:[^=]*=\s*(\{[\s\S]*?\});/);
  if (!m) {
    throw new Error(
      "ADMIN_PLAN_LABEL's declaration shape changed in entitlement-admin.ts — update this reader",
    );
  }
  // Captured group is a literal object of string values from a file this
  // repo owns (no-implied-eval is not configured against this project).
  return new Function(`"use strict"; return (${m[1]});`)() as Record<string, string>;
}

test.describe("/admin/entitlements", () => {
  test("renders one column per plan, enterprise included", async ({ page }) => {
    const labelByKey = readAdminPlanLabel();
    const expectedLabels = Object.values(labelByKey);
    expect(expectedLabels.length).toBeGreaterThan(0);

    const rig = await seedOrgOnPlan("community");
    await setOwnerStaffSql(rig.orgId, true); // a fresh throwaway owner — no restore owed
    await signIn(page, rig.ownerEmail);
    await page.goto("/admin/entitlements");

    // The page renders ONE <table> per domain section (groupForAdmin) — every
    // one repeats the same header row, so scoping to the first table is what
    // keeps this a set check rather than counting each label once per section.
    const headers = await page.locator("table").first().locator("thead th").allInnerTexts();
    expect(headers.length, "no columns rendered — a set assertion would be vacuous").toBeGreaterThan(
      0,
    );

    for (const label of expectedLabels) {
      expect(headers, `${label} column`).toContain(label);
    }
    // Set, not subset: an EXTRA column is as wrong as a missing one, and a
    // `toContain` ladder alone cannot see one.
    const planHeaderCount = headers.filter((h) => expectedLabels.includes(h)).length;
    expect(planHeaderCount, "no extra or missing plan column").toBe(expectedLabels.length);
  });
});

// ===========================================================================
// C6 (fix round 1 finding) — the org settings billing upgrade grid is hidden
// from a paid org and shown to a community one (billing/page.tsx:594-595:
// `{(!isPaid || planLapsed) && isPayer}` wrapping `<section id="upgrade">`)
// ===========================================================================
//
// `apps/web/e2e/billing.spec.ts` already proves the COMMUNITY half (its
// "an org that has already had Pro is not offered the trial again" test, and
// others, all run against a community org and assert something inside
// `#upgrade` is visible) — but nothing anywhere in `apps/web/e2e/` seeds a
// genuinely non-lapsed PAID org and confirms the grid is ABSENT. A build that
// rendered `#upgrade` unconditionally would pass every existing check.
//
// "Genuinely non-lapsed" is the load-bearing word: `isPaid` alone
// (`planKey !== "community"`) is not the real gate — `planLapsed` also
// participates (`(!isPaid || planLapsed) && isPayer`), so a paid-but-lapsed
// org (a stale trial, a 14-day-dunning past_due, an expired comp) still SEES
// the grid by design (the resolver has already degraded it to community) and
// would make an assertion of absence pass for the wrong reason. `pro` +
// `status: 'active'` with no trial/comp/past_due fields set — exactly what
// `seedOrgOnPlan("pro")` seeds — resolves through `orgPlanKey` to `pro` with
// nothing degrading it, so `planLapsed` is false and `isPaid` is true: the
// one combination that actually reaches the hidden branch of the gate.
test.describe("the org settings billing upgrade grid", () => {
  test("is absent for a non-lapsed paid org, and present for a community org", async ({
    page,
  }) => {
    const pro = await seedOrgOnPlan("pro");
    await signIn(page, pro.ownerEmail);
    await page.goto(`/o/${pro.orgSlug}/settings/billing`);

    // Prove we are on the FULLY RENDERED billing page for THIS org before
    // asserting anything is absent. `page.goto` does not throw on a non-2xx,
    // and `requireBillingPage` (server/page-auth.ts) has a silent `notFound()`
    // path — so a 404, a failed seed, or a blank render would ALSO leave
    // `#upgrade` absent and pass the check below for the wrong reason. The
    // "Current plan" card (`data-tour="billing-plan"`) is mounted
    // unconditionally (no isPayer/guest branch above it in the page), and it
    // names the resolved plan, so it also confirms this is the PRO org's own
    // page, not merely a page.
    const planCard = page.locator('[data-tour="billing-plan"]');
    await expect(planCard, "billing page failed to render for the pro org").toBeVisible();
    await expect(planCard, "must show the seeded org's own Pro plan").toContainText("Pro");

    await expect(
      page.locator("#upgrade"),
      "a non-lapsed paid org must not be sold a plan it already has",
    ).toHaveCount(0);

    // The positive pair, on an independent org: without it, a build that
    // hid the grid from EVERYONE would pass the row above and look correct.
    // No separate render-anchor is needed for this half: `toBeVisible()` is
    // already self-anchoring — an element cannot be visible on a 404 or an
    // empty render, so a false pass here isn't reachable the way it was for
    // the absence check above.
    const community = await seedOrgOnPlan("community");
    await signIn(page, community.ownerEmail);
    await page.goto(`/o/${community.orgSlug}/settings/billing`);
    await expect(
      page.locator("#upgrade"),
      "a community org must still see the upgrade grid",
    ).toBeVisible();
  });
});
