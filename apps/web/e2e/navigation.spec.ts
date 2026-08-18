import { test, expect } from "@playwright/test";

// Core navigation smoke: the authed shell + the Jul3 pages render.
test.describe("navigation shell", () => {
  test("dashboard loads with nav", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    // Header CTA is always present and — since the empty-state hero now uses a
    // distinct label ("Create your first competition") — resolves to exactly one
    // element in every board state (strict mode would throw on a collision).
    await expect(page.getByRole("link", { name: "+ New Competition" })).toBeVisible();
  });

  test("unified Directory renders People + Clubs tabs (Jul3/01)", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("heading", { name: "Directory", exact: true })).toBeVisible();
    // Nav collapses People + Clubs into a single Directory item.
    await expect(page.getByRole("link", { name: "Directory" })).toBeVisible();
    // Clubs & Teams tab exposes the New club affordance (clubs-teams-list).
    await page.getByRole("link", { name: "Clubs & Teams", exact: true }).click();
    await expect(page.getByRole("button", { name: "New club" })).toBeVisible();
  });

  test("import participants (Jul3/01) renders with a file input", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import participants" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});

// Settings de-duplication: the standalone /settings/account page was removed and
// folded into the tabbed settings; Plan & Billing keeps its own route.
test.describe("settings shell", () => {
  test("sidebar keeps Platform API and links billing to its own route", async ({ page }) => {
    await page.goto("/settings?tab=account");
    // Regression: the Platform API nav item once vanished during the dedup.
    await expect(page.getByRole("link", { name: "Platform API" })).toBeVisible();
    // Plan & Billing owns Stripe reconciliation, so it links out, not a ?tab=.
    // PROMPT-30: billing is org-scoped — /o/[slug]/settings/billing.
    await expect(page.getByRole("link", { name: "Plan & Billing", exact: true })).toHaveAttribute(
      "href",
      /\/o\/[^/]+\/settings\/billing$/,
    );
  });

  test("preferences tab carries the Privacy & cookies section", async ({ page }) => {
    // Merged off the old standalone page onto Account, then moved again to
    // Preferences with the rest of the "how the product reads" controls.
    await page.goto("/settings?tab=preferences");
    await expect(page.getByRole("heading", { name: "Privacy & cookies" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cookie settings" })).toBeVisible();
  });

  test("preferences gathers both timezones, language and currency", async ({ page }) => {
    await page.goto("/settings?tab=preferences");
    await expect(page.getByRole("combobox", { name: "Your timezone" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organisation defaults" })).toBeVisible();
    // …and the Account tab kept none of them.
    await page.goto("/settings?tab=account");
    await expect(page.getByRole("combobox", { name: "Your timezone" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cookie settings" })).toHaveCount(0);
  });

  // Both of these columns were read by entrant-facing surfaces long before
  // anything could write them: default_locale by every public page, embed,
  // calendar feed and registration email, and currency (V365) by every entry
  // fee. This is the first UI that reaches either.
  test("organisation defaults expose the public language and the entry-fee currency", async ({
    page,
  }) => {
    await page.goto("/settings?tab=preferences");

    const language = page.getByRole("combobox", { name: "Organisation public language" });
    await expect(language).toBeVisible();
    const currency = page.getByRole("combobox", { name: "Entry fee currency" });
    await expect(currency).toBeVisible();

    // Round-trip the language: pick a value, save, reload, it is still there.
    const original = await language.inputValue();
    const next = original === "fr" ? "es" : "fr";
    await language.selectOption(next);
    const languageRow = page
      .locator("div")
      .filter({ has: language })
      .filter({ has: page.getByRole("button", { name: /^Sav/ }) })
      .last();
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/orgs/") && r.request().method() === "PATCH",
      ),
      languageRow.getByRole("button", { name: /^Sav/ }).click(),
    ]);
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Organisation public language" }),
    ).toHaveValue(next, { timeout: 20_000 });

    // Restore so later specs see the org they expect.
    await page.getByRole("combobox", { name: "Organisation public language" }).selectOption(original);
    await page
      .locator("div")
      .filter({ has: page.getByRole("combobox", { name: "Organisation public language" }) })
      .filter({ has: page.getByRole("button", { name: /^Sav/ }) })
      .last()
      .getByRole("button", { name: /^Sav/ })
      .click();
  });

  test("the rail carries the plan and credit balance from any Settings page", async ({ page }) => {
    // Previously visible only from Billing and Credits — the two pages an
    // owner is not on when they run out of credits mid-schedule.
    await page.goto("/settings/billing");
    // Scoped to the rail's own landmark, and matched EXACTLY. Two other links
    // to the same route are in play — the billing page's own "Manage AI
    // credits" and the rail's own "AI Credits" nav item — and Playwright's
    // `name` is a substring match, so anything looser resolves to several.
    const rail = page.getByRole("complementary");
    // Anchored, because the balance is whatever this environment's org has.
    await expect(rail.getByRole("link", { name: /^\d+ AI credits$/ })).toBeVisible();
    await expect(rail).toContainText("Pro");
  });

  // The sidebar used to disappear the moment you left the tabbed index.
  test("the sidebar is present on the route-owning Settings pages", async ({ page }) => {
    // Only /settings/billing and /settings/connect have legacy redirects; the
    // other two are org-scoped only, so reach them through the sidebar itself.
    await page.goto("/settings?tab=organization");
    const orgSettings = new URL(page.url()).pathname.replace(/\/settings$/, "");
    for (const path of [
      "/settings/billing",
      `${orgSettings}/settings/credits`,
      `${orgSettings}/settings/add-ons`,
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("link", { name: "Preferences", exact: true }),
        `no sidebar on ${path}`,
      ).toBeVisible();
    }
  });

  test("old standalone /settings/account route is gone (404)", async ({ page }) => {
    const res = await page.goto("/settings/account");
    expect(res?.status()).toBe(404);
  });
});
