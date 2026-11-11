import { test, expect } from "@playwright/test";
import { loginUi, apiJson, TAG, setEntitlementOverrideSql } from "./helpers";

// Switching organisations must land on the SAME page under the new org, not
// bounce to the dashboard (`/o/<slug>`). The user has reported this 3× and it
// survived #274 — so this reproduces it end to end against the gantry's account
// menu, which is what a user reaches for on any page. (The settings-header
// `OrgSwitcher` #274 touched left the settings page with settings C8, owner
// 2026-11-11, so its own test went with it.)
//
// The wait after each switch MUST name org B's slug. `/\/o\/[^/]+(\/|$)/`
// matches the PRE-CLICK url (`/o/<A>/settings`) too, so it resolves instantly
// and `networkidle` then settles on the OLD page while the switch navigation
// is still in flight. Solo that races green; at 4 workers it read org A's url
// 12 times out of 16.
//
// Runs in its own context (own two-org user); no shared storageState.
test.use({ storageState: { cookies: [], origins: [] } });

async function seedTwoOrgUser(page: import("@playwright/test").Page) {
  const email = `delivered+e2e-switch-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`;
  await loginUi(page, email, "/dashboard");
  let orgsA = await apiJson<{ id: string; slug: string; name: string }[]>(page.request, "/api/orgs");
  if (!orgsA.data?.length) {
    const a = await apiJson<{ id: string; slug: string }>(page.request, "/api/orgs", "POST", {
      name: `Switch A ${TAG}`,
    });
    if (a.status >= 400) throw new Error(`create org A failed: ${a.status} ${a.error?.message}`);
    orgsA = await apiJson<{ id: string; slug: string; name: string }[]>(page.request, "/api/orgs");
  }
  const orgA = orgsA.data![0]!;
  // A community org may cap owned orgs below 2 — lift it so the second create
  // (and thus the two-org switcher) is reachable.
  await setEntitlementOverrideSql(orgA.id, "orgs.max_owned", 10);
  // Second org via the product path. Creating it flips the active-org cookie
  // to B, so we reset back to A afterwards.
  const created = await apiJson<{ id: string; slug: string; name: string }>(
    page.request,
    "/api/orgs",
    "POST",
    { name: `Switch B ${TAG}` },
  );
  if (created.status >= 400) throw new Error(`create org B failed: ${created.status} ${created.error?.message}`);
  const orgB = created.data!;
  // Reset active org to A so the test starts on A's settings.
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgA.id });
  return { orgA, orgB };
}

test("account menu org switch stays on the same page under the new org; the breadcrumb org crumb is no longer a picker", async ({ page }) => {
  const { orgA, orgB } = await seedTwoOrgUser(page);

  await page.goto(`/o/${orgA.slug}/settings`);
  // Settings C8 (owner 2026-11-11): the settings page carries no OrgSwitcher of its own. The account menu below is
  // the positive pair that makes this zero mean the page rendered without it.
  await expect(page.getByRole("button", { name: "Switch organisation" })).toHaveCount(0);
  // The strip under the gantry carries the trail only: the org crumb is text, with no button to open.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button")).toHaveCount(0);
  await page.getByTestId("account-menu-trigger").click();
  await page.getByTestId(`account-menu-org-${orgB.slug}`).click();

  await page.waitForURL((u) => u.pathname.startsWith(`/o/${orgB.slug}`), { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  expect(page.url(), "account menu switch from settings should stay on settings under org B").toContain(
    `/o/${orgB.slug}/settings`,
  );
});
