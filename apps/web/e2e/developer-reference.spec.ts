import { test, expect } from "@playwright/test";
import { activeOrg, invalidateOrgEntitlements, loginUi, setBoolEntitlementOverrideSql, TAG } from "./helpers";

// The developer docs are OFF for everyone by default (owner, 2026-11-16) and staff switch them on per organisation with
// an entitlement override on `developers.docs` (lib/developer-docs.ts). To anyone else the pages are not found.
// The API map those pages render sits behind the same switch (owner, 2026-11-17), in both its forms.
const DOCS_PAGES = [
  "/developers",
  "/developers/reference",
  "/developers/guides",
  "/developers/changelog",
  "/api/v1/openapi.json",
  "/api/v1/openapi.json?published=1",
];

test("developer docs are not found for a signed-out visitor, on every docs page", async ({ browser }) => {
  const ctx = await browser.newContext(); // no auth
  try {
    let checked = 0;
    for (const path of DOCS_PAGES) {
      const res = await ctx.request.get(path);
      expect(res.status(), path).toBe(404);
      checked++;
    }
    expect(checked).toBe(DOCS_PAGES.length);
  } finally {
    await ctx.close();
  }
});

// The Scalar API reference (v3/08 §3) must render STYLED — the stylesheet is
// a separate package export and shipping without it produces a bare unstyled
// document that reads as "not loading" (bitten 2026-07-11). Asserting on the
// sidebar catches that: Scalar's sidebar only exists as a distinct visible
// column when its CSS is applied.
test("an organisation without the switch gets not found; with it, the API reference renders the styled Scalar app with a sidebar", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `delivered+e2e-devdocs-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`;
  await loginUi(page, email);
  // requirePageAuth on a server page is what provisions "My organization" for a member of none.
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);

  // Signed in, a member of an organisation, and still not found: membership alone opens nothing.
  expect((await page.request.get("/developers/reference")).status(), "before the switch").toBe(404);
  expect((await page.request.get("/api/v1/openapi.json")).status(), "the API map before the switch").toBe(404);

  await setBoolEntitlementOverrideSql(org.id, "developers.docs", true);
  await invalidateOrgEntitlements(page.request, org.id);

  await page.goto("/developers/reference");

  // Content loaded from /api/v1/openapi.json…
  await expect(page.getByRole("heading", { name: "seazn.club platform API" })).toBeVisible({
    timeout: 30_000,
  });

  // …and the CSS is live: the sidebar nav entry for a tag group exists and
  // occupies a real side column (a nonzero-width element left of the
  // content), which the unstyled fallback never produces.
  const sidebarLink = page
    .locator(".scalar-app aside, .scalar-app .sidebar, [class*=sidebar]")
    .getByText("competitions", { exact: true })
    .first();
  await expect(sidebarLink).toBeVisible();
  const box = await sidebarLink.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.x).toBeLessThan(300); // pinned in the left column, not inline prose

  // Switched off again, the same signed-in reader is back to not found.
  await setBoolEntitlementOverrideSql(org.id, "developers.docs", false);
  await invalidateOrgEntitlements(page.request, org.id);
  expect((await page.request.get("/developers/reference")).status(), "after the switch is turned off").toBe(404);
});
