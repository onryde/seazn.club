import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  settingsUrl,
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

  // Finding B: the slot came back — the owned count is what it was.
  const after = await apiJson<{ id: string }[]>(page.request, "/api/orgs");
  expect(after.data?.length ?? 0).toBe(before.data?.length ?? 0);
});
