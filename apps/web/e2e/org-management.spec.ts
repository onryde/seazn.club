import { test, expect } from "@playwright/test";
import { TAG, activeOrg, apiJson, type OrgInfo } from "./helpers";

// Org administration: rename the active org, create a second org, and switch
// between orgs. Runs on the Pro account (community owns
// at most 1 org — orgs.max_owned). The active org lives in the `seazn_org`
// cookie, and every test starts from the storageState snapshot — so activation
// never leaks between tests; only the rename (a DB write) persists.
test.describe.serial("org management", () => {
  let original: OrgInfo;
  let secondOrgName: string;

  test("rename the active org from settings", async ({ page }) => {
    original = await activeOrg(page);
    const newName = `Renamed ${TAG}`;

    await page.goto("/settings");
    // Settings C8 (owner 2026-11-11): the name is a field of the Organisation
    // card, saved by the card's one "Save changes" (scoped to the card — the
    // org defaults beside it keep Save buttons of their own).
    await page.getByLabel("Organization name").fill(newName);
    await page.getByTestId("org-profile-card").getByRole("button", { name: "Save changes" }).click();
    // PROMPT-30: renaming regenerates the slug and lands on the new URL —
    // wait for the NEW slug (the old settings URL matches the pattern too).
    await page.waitForURL(
      (u) => u.pathname.endsWith("/settings") && !u.pathname.includes(`/o/${original.slug}`),
      { timeout: 20_000 },
    );

    // Persisted, not just optimistic UI.
    await page.reload();
    await expect(page.getByLabel("Organization name")).toHaveValue(newName, { timeout: 20_000 });
    original = { ...original, name: newName };
  });

  test("create a second org", async ({ page }) => {
    secondOrgName = `Second Org ${TAG}`;

    // Settings C8 (owner 2026-11-11) took the OrgSwitcher off the settings
    // page; its "New organisation" entry moves to the account menu, which
    // ships separately. The create form itself is what this test proves.
    await page.goto("/orgs/new");

    await page.getByPlaceholder("My Sports Club").fill(secondOrgName);
    await page.getByRole("button", { name: /create organi[sz]ation/i }).click();

    // Creation activates the new org (POST /api/orgs calls setActiveOrgId).
    await expect
      .poll(async () => (await activeOrg(page)).name, { timeout: 20_000 })
      .toBe(secondOrgName);
  });

  test("switch to the second org and back", async ({ page }) => {
    // Fresh context → the setup org is active again (cookie from storageState).
    expect((await activeOrg(page)).id).toBe(original.id);

    // Over to the second org — through the account menu, the one place
    // organisations are switched now (settings C8 took the settings-header
    // OrgSwitcher away; the breadcrumb org crumb is text, not a picker).
    const { data: orgs } = await apiJson<{ id: string; slug: string; name: string }[]>(
      page.request,
      "/api/orgs",
    );
    const slugOf = (name: string) => orgs?.find((o) => o.name === name)?.slug ?? "";
    await page.goto("/settings");
    let beforeSwitch = new URL(page.url()).pathname;
    await page.getByTestId("account-menu-trigger").click();
    await page.getByTestId(`account-menu-org-${slugOf(secondOrgName)}`).click();
    // The cookie follows a beat later (ActiveOrgSync POSTs from the org layout).
    // Wait for the navigation to land before driving the page again — a
    // page.goto issued into it is cancelled with net::ERR_ABORTED.
    await page.waitForURL((u) => u.pathname !== beforeSwitch, { timeout: 20_000 });
    await expect
      .poll(async () => (await activeOrg(page)).name, { timeout: 20_000 })
      .toBe(secondOrgName);
    // Re-enter through the legacy cookie-following entry point (PROMPT-30:
    // the /o URL owns the page; reloading the old org's URL would show it).
    await page.goto("/settings");
    await expect(page.getByLabel("Organization name")).toHaveValue(secondOrgName, {
      timeout: 20_000,
    });

    // …and back to the original.
    beforeSwitch = new URL(page.url()).pathname;
    await page.getByTestId("account-menu-trigger").click();
    await page.getByTestId(`account-menu-org-${slugOf(original.name)}`).click();
    await page.waitForURL((u) => u.pathname !== beforeSwitch, { timeout: 20_000 });
    await expect
      .poll(async () => (await activeOrg(page)).id, { timeout: 20_000 })
      .toBe(original.id);
    await page.goto("/settings");
    await expect(page.getByLabel("Organization name")).toHaveValue(original.name, {
      timeout: 20_000,
    });
  });

  // The scheduling timezone picker searches, and files zones under human
  // regions rather than IANA prefixes — Dubai belongs under Middle East, not
  // beside Tokyo under "Asia" because that is how the tz database spells it.
  test("scheduling timezone is searchable and grouped by real region", async ({ page }) => {
    const org = await activeOrg(page);
    const { data: orgs } = await apiJson<{ id: string; timezone: string | null }[]>(
      page.request,
      "/api/orgs",
    );
    const originalTz = orgs?.find((o) => o.id === org.id)?.timezone ?? null;
    // The Organisation tab: settings C8 (owner 2026-11-11) moved the org
    // defaults (timezone, public language, currency) into the Organisation
    // card under brand colour, each keeping its own Save.
    await page.goto("/settings?tab=organization");

    const tz = page.getByRole("combobox", { name: "Organisation scheduling timezone" });
    await expect(tz).toBeVisible();
    await tz.click();
    await tz.fill("dub");

    // Two cities match "dub", and they sort into two different regions.
    const middleEast = page.getByRole("group", { name: "Middle East" });
    await expect(middleEast.getByRole("option", { name: /Dubai/ })).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Europe" }).getByRole("option", { name: /Dublin/ }),
    ).toBeVisible();
    // The complaint, pinned: Dubai is not filed under an "Asia" heading.
    await expect(page.getByRole("group", { name: "Asia" })).toHaveCount(0);

    await middleEast.getByRole("option", { name: /Dubai/ }).click();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/orgs/${org.id}`) && r.request().method() === "PATCH" && r.ok(),
      ),
      page
        .locator("div")
        .filter({ has: tz })
        .filter({ has: page.getByRole("button", { name: /^Sav/ }) })
        .last()
        .getByRole("button", { name: /^Sav/ })
        .click(),
    ]);

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Organisation scheduling timezone" }),
    ).toContainText("Dubai", { timeout: 20_000 });

    // Restore the zone this org actually had: it feeds every division's
    // schedule rendering, so leaving it on Dubai would shift times for the rest
    // of the suite.
    const restore = await page.request.patch(`/api/orgs/${org.id}`, {
      headers: { "Content-Type": "application/json" },
      data: { timezone: originalTz },
    });
    expect(restore.ok()).toBe(true);
  });
});
