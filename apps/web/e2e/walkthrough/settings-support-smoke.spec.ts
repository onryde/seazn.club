import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedMemberIdentity,
  expectGate,
  settingsUrl,
  TABS,
  type SeededOrg,
} from "../settings-support";
import { apiJson } from "../helpers";

test.describe.configure({ mode: "default" });

/**
 * Safety net for the five-org cap. The test below releases in a `finally`
 * because the assertion that the SLOT came back has to run after the release —
 * but Global Constraint 6 is real: a Playwright `test.setTimeout` skips
 * `finally`, and a leaked seed here spends one of the shared Pro user's five
 * owner slots for the rest of the leg. `releaseSettingsOrg` is idempotent, so
 * this runs unconditionally against whatever the test managed to seed.
 */
let seededForCleanup: SeededOrg | null = null;

test.afterAll(async ({ browser }) => {
  if (!seededForCleanup) return;
  const ctx = await browser.newContext();
  try {
    await releaseSettingsOrg(ctx.request, seededForCleanup);
  } finally {
    seededForCleanup = null;
    await ctx.close();
  }
});

test("a seeded settings org is Pro, reachable, and returns its slot", async ({ page }) => {
  const before = await apiJson<{ id: string }[]>(page.request, "/api/orgs");
  const seeded = await seedSettingsOrg(page.request, { plan: "pro" });
  seededForCleanup = seeded;
  try {
    // It exists, and the settings page renders it under its own slug.
    await page.goto(settingsUrl(seeded.slug, "organization"));
    await expect(page.getByText(seeded.name, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Finding A: a fresh org is community by default (createOrgForUser opens
    // every org on its own `plan_key = 'community'` subscription,
    // src/lib/auth.ts). Prove the flip took by asking for a Pro-gated surface
    // — `?tab=api` renders ApiKeysPanel only when `hasFeature(org,
    // "api.access")`, otherwise an upsell with no Create control at all.
    await page.goto(settingsUrl(seeded.slug, "api"));
    await expect(page.getByRole("button", { name: /create/i }).first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await releaseSettingsOrg(page.request, seeded);
    seededForCleanup = null;
  }

  // Finding B: the slot came back.
  //
  // Asserted against THIS org's id, never against a count. The first version
  // of this compared `after.length` to `before.length` and was green alone and
  // red in company: `/api/orgs` is the SHARED Pro user's whole membership
  // list, and settings-org-tabs.spec.ts and settings-people-tabs.spec.ts each
  // seed an org of their own — so the total moves under this test through no
  // fault of the code it is testing. That is exactly what `_RULES.md` §1
  // forbids ("every count counts the whole run; scope counts to the per-spec
  // TAG, never to a global total"), and it made a shared-state artifact look
  // like a released-slot failure.
  //
  // Both directions, because a negative assertion needs its positive pair: a
  // `releaseSeededOrgSql` that deleted every membership row would satisfy the
  // first expectation on its own.
  const after = await apiJson<{ id: string }[]>(page.request, "/api/orgs");
  const ids = (after.data ?? []).map((o) => o.id);
  expect(ids).not.toContain(seeded.orgId);
  expect(ids.length).toBeGreaterThan(0);
});

test("a seeded member really holds the role, from the app's own answer", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-ident" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    // The app's answer, not our own bookkeeping: GET /api/orgs/{id}/members is
    // open to every ORG_ROLE, so the member can read its own row back.
    const seen = await apiJson<{ user_id: string; role: string }[]>(
      member.request,
      `/api/orgs/${org.orgId}/members`,
    );
    expect(seen.status, "the seeded member cannot read the member list").toBe(200);
    const mine = (seen.data ?? []).find((m) => m.user_id === member.userId);
    expect(mine?.role, "the invite was accepted but the role did not stick").toBe(
      "viewer",
    );
    // And that it is NOT the owner — the failure mode this helper exists to
    // avoid is silently handing back the shared Pro session, which would make
    // every gate assertion below pass for the wrong reason.
    const whoami = await apiJson<{ id: string }>(request, "/api/users/me");
    expect(member.userId).not.toBe(whoami.data?.id);
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});

test("expectGate asserts the route's own exact status, not just 'some kind of refusal'", async ({
  browser,
  request,
}) => {
  // Real gate, verified against _INDEX.md's route table: `PATCH
  // /api/orgs/{id}` is `requireOrgRole(EDITOR_ROLES)`, and a viewer (below
  // EDITOR) is refused with 401 — the `/api/orgs/**` family's AuthError
  // status for both "not a member" and "insufficient permissions".
  const org = await seedSettingsOrg(request, { label: "w3-gate" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    await expectGate({
      label: "viewer PATCH org",
      request: member.request,
      method: "PATCH",
      path: `/api/orgs/${org.orgId}`,
      body: { name: "should not persist" },
      expectStatus: 401,
    });
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});

test("TABS mirrors the app's own SETTINGS_TABS, not a retyped copy", () => {
  // A change to the app's tab set (add, remove, rename) must move this
  // constant with it — see settings-support.ts for how TABS is derived.
  expect(TABS).toEqual([
    "organization",
    "news",
    "sponsors",
    "team",
    "api",
    "preferences",
    "account",
  ]);
  expect(TABS.length).toBe(7);
});
