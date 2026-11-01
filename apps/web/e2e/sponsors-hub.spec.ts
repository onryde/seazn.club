// R4 sponsors-on-stream S11 - the top-level Sponsors hub at `/o/{org}/sponsors` (owner nav ruling §6.1 "a", 2026-10-31).
// Run by CI only (e2e.yml, `parallel` project - it joins by the default testMatch; never locally).
//
// What the vitest seams (node environment, no browser, no router) cannot see:
//   1. The four tabs in a real browser, in the declared order, each opening ITS panel and marking itself current - the tab names
//      read from the dictionary and the order from `SPONSORS_TABS`, never typed here.
//   2. Settings' retired tab: `/o/{org}/settings?tab=sponsors` (and the account-level `/settings?tab=sponsors` shim in front of it) LANDS
//      on the hub's Sponsors tab, with a second query param carried through, and Settings itself no longer lists Sponsors.
//   3. A viewer (a non-editor) gets the same read-only view Settings gave: the Sponsors tab renders, with no add form; the editor-only
//      tabs are not offered, and `?tab=packages` falls back to Overview instead of refusing.
//   4. The Dashboard's Sponsors entry - the way in at EVERY width, the top-bar icon being hidden under 350px - works from 320.
//   5. On stream (S12): the tab, driven as an editor drives it - the first tick turns the rotation on at Normal (R12) and the page shows
//      it; the dial and a competition's own scope persist across a reload; the preview names a sport's breaks when it has no finished
//      match; and a viewer is refused the settings write (R19). Default viewport only (R17).
// Width checks for the hub live in mobile.spec.ts (ruling R17: only that file runs in the seven width projects); this file holds its own
// default viewport, plus the 320 pass the Dashboard entry exists for.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers";
import { apiJson } from "./helpers";
import { releaseSettingsOrg, seedCompetition, seedMemberIdentity, seedSettingsOrg, settingsUrl, sponsorsUrl, type SeededOrg } from "./settings-support";
import { SPONSORS_TABS, sponsorsTabsFor, type SponsorsTab } from "../src/lib/sponsors-hub";

/** Copy read from the dictionary the page renders from, never retyped (this folder's idiom: settings-org-tabs.spec.ts). */
const UI: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
const label = (tab: SponsorsTab): string => {
  const v = UI[`sponsors.hub.tab.${tab}`];
  if (v === undefined) throw new Error(`en/ui.json has no sponsors.hub.tab.${tab}`);
  return v;
};

// One seeded org, shared by the owner's tests (mode default: each test is its own page, the org is created once per worker).
let org: SeededOrg;
test.beforeAll(async ({ request }) => {
  org = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-hub" });
});
test.afterAll(async ({ request }) => {
  await releaseSettingsOrg(request, org);
});

test("tabs: the hub opens on Overview and each tab opens its own panel, in the declared order", async ({ page }) => {
  await page.goto(`/o/${org.slug}/sponsors`);
  const bar = page.getByRole("navigation", { name: UI["sponsors.hub.tabsLabel"] });
  await expect(bar, "the tab bar").toBeVisible();

  // Order and names from the declarations: the links in the bar are exactly SPONSORS_TABS, labelled from the dictionary.
  const links = bar.locator("a");
  await expect(links).toHaveCount(SPONSORS_TABS.length);
  expect(SPONSORS_TABS.length, "anti-vacuity: the hub declares tabs").toBeGreaterThan(0);
  for (const [i, tab] of SPONSORS_TABS.entries()) {
    await expect(links.nth(i), `tab ${i} is ${tab}`).toHaveText(label(tab));
    await expect(links.nth(i)).toHaveAttribute("data-testid", `sponsors-tab-link-${tab}`);
  }

  // Default: Overview is current and its panel is the one on the page.
  await expect(page.getByTestId("sponsors-tab-link-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();

  // Each tab by CLICK (a real navigation), exactly one panel at a time, exactly one tab current.
  let opened = 0;
  for (const tab of SPONSORS_TABS) {
    await page.getByTestId(`sponsors-tab-link-${tab}`).click();
    await expect(page, `${tab}: the URL names the tab`).toHaveURL(new RegExp(`/o/${org.slug}/sponsors\\?tab=${tab}$`));
    await expect(page.getByTestId(`sponsors-tab-${tab}`), `${tab}: its panel`).toBeVisible();
    await expect(bar.locator('[aria-current="page"]'), `${tab}: one current tab`).toHaveCount(1);
    await expect(page.getByTestId(`sponsors-tab-link-${tab}`)).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-testid^="sponsors-tab-"]:not([data-testid^="sponsors-tab-link-"])'), `${tab}: only its own panel`).toHaveCount(1);
    opened++;
  }
  expect(opened, "every declared tab was opened").toBe(SPONSORS_TABS.length);

  // The moved bodies, in place: the add form on Sponsors, the sell console on Packages and orders.
  await page.goto(sponsorsUrl(org.slug, "packages"));
  await expect(page.getByTestId("sponsor-packages"), "the sell console moved to Packages and orders").toBeVisible();
  await page.goto(sponsorsUrl(org.slug, "sponsors"));
  await expect(page.getByTestId("sponsor-packages"), "Sponsors no longer carries the sell console").toHaveCount(0);
  await expect(page.getByRole("button", { name: UI["settings.org.sponsors.add"] ?? "", exact: true }), "the add form moved to the Sponsors tab").toBeVisible();
});

test("an unknown tab falls back to Overview, and the page does not scroll sideways at the default viewport", async ({ page }) => {
  await page.goto(`/o/${org.slug}/sponsors?tab=nonsense`);
  await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
  await expect(page.getByTestId("sponsors-tab-link-overview")).toHaveAttribute("aria-current", "page");
  await expectNoHorizontalScroll(page);
});

test("settings?tab=sponsors lands on the hub's Sponsors tab, keeps a second param, and Settings drops the tab", async ({ page }) => {
  // The org-scoped page, with a second param that must survive the redirect.
  await page.goto(`${settingsUrl(org.slug, "sponsors")}&x=1`);
  await expect(page, "redirected to the hub").toHaveURL(new RegExp(`/o/${org.slug}/sponsors\\?tab=sponsors&x=1$`));
  await expect(page.getByTestId("sponsors-tab-sponsors")).toBeVisible();

  // The account-level shim (what mobile.spec.ts and old emails link to) forwards the query to the org page, which redirects on.
  await page.goto("/settings?tab=sponsors");
  await expect(page).toHaveURL(/\/o\/[^/]+\/sponsors\?tab=sponsors$/);
  await expect(page.getByTestId("sponsors-tab-sponsors")).toBeVisible();

  // Settings itself: no Sponsors tab link, and other tabs are NOT redirected.
  await page.goto(settingsUrl(org.slug, "organization"));
  await expect(page).toHaveURL(new RegExp(`/o/${org.slug}/settings\\?tab=organization$`));
  await expect(page.locator(`a[href*="tab=sponsors"]`), "Settings no longer links to a Sponsors tab").toHaveCount(0);
});

test("a viewer gets the read-only view Settings gave: Sponsors without the add form, no editor-only tabs, packages falls back", async ({ browser, request }) => {
  const seeded = await seedSettingsOrg(request, { label: "sponsors-hub-viewer" });
  const member = await seedMemberIdentity(browser, request, seeded.orgId, "viewer");
  try {
    const page = await member.ctx.newPage();
    // The tabs this reader is offered, from the declaration (viewer = canEdit false).
    const offered = sponsorsTabsFor(false);
    expect(offered.length, "anti-vacuity: a viewer is offered some tabs").toBeGreaterThan(0);
    expect(offered.length, "...but fewer than an editor").toBeLessThan(SPONSORS_TABS.length);

    await page.goto(sponsorsUrl(seeded.slug, "overview"));
    const bar = page.getByRole("navigation", { name: UI["sponsors.hub.tabsLabel"] });
    await expect(bar.locator("a")).toHaveCount(offered.length);
    for (const tab of SPONSORS_TABS) {
      await expect(page.getByTestId(`sponsors-tab-link-${tab}`), `${tab} link`).toHaveCount(offered.includes(tab) ? 1 : 0);
    }

    // Sponsors renders read-only: the panel is there, the add form is not.
    await page.goto(sponsorsUrl(seeded.slug, "sponsors"));
    await expect(page.getByTestId("sponsors-tab-sponsors")).toBeVisible();
    await expect(page.getByRole("button", { name: UI["settings.org.sponsors.add"] ?? "", exact: true }), "a viewer cannot add a sponsor").toHaveCount(0);

    // The editor-only tabs are not refused with an error page: they fall back to Overview.
    await page.goto(sponsorsUrl(seeded.slug, "packages"));
    await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
    await expect(page.getByTestId("sponsor-packages"), "a viewer is never shown the sell console").toHaveCount(0);
    await page.goto(sponsorsUrl(seeded.slug, "on_stream"));
    await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
  } finally {
    await member.release();
    await releaseSettingsOrg(request, seeded);
  }
});

test("the Dashboard's Sponsors entry opens the hub at 320, where the top-bar icon is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/o/${org.slug}`);
  // Under 350px the top-bar Sponsors icon is `display: none`; the Dashboard's own entry is the way in.
  await expect(page.getByTestId("nav-sponsors"), "the top-bar icon is hidden at 320").toBeHidden();
  const entry = page.getByTestId("org-home-sponsors");
  await expect(entry, "the Dashboard entry is visible at 320").toBeVisible();
  await expectNoHorizontalScroll(page);
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`/o/${org.slug}/sponsors$`));
  await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // From 350 the top-bar icon is there too (the Player-home precedent), pointing at the same place.
  await page.setViewportSize({ width: 350, height: 800 });
  await expect(page.getByTestId("nav-sponsors")).toBeVisible();
  await expect(page.getByTestId("nav-sponsors")).toHaveAttribute("href", `/o/${org.slug}/sponsors`);
});

test("on stream: the first tick turns the rotation on at Normal, the dial and a competition's own scope persist, and the preview names the sport's breaks", async ({ page, request }) => {
  const seeded = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-on-stream" });
  try {
    const comp = await seedCompetition(request, seeded.orgId, { name: "Spring Cup" });
    const division = await apiJson(request, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "T20", sport_key: "cricket", variant_key: "t20", config: {} });
    expect(division.status, JSON.stringify(division.error)).toBe(201);
    const mk = async (name: string, tier: "title" | "gold") => {
      const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${seeded.orgId}/sponsors`, "POST", { name, tier, url: `https://example.com/${tier}` });
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data!.id;
    };
    const harbour = await mk("Harbour Bank", "title");
    const ridge = await mk("Ridge Cycles", "gold");

    // A fresh org has no settings row: the rotation is OFF, the dial reads Normal (D12), nobody is ticked, and the sport has no
    // finished match - so the preview lists cricket's breaks by size and counts nothing.
    await page.goto(sponsorsUrl(seeded.slug, "on_stream"));
    await expect(page.getByTestId("sponsors-tab-on_stream")).toBeVisible();
    await expect(page.getByTestId("on-stream-switch"), "no row: off").toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("on-stream-dial-normal"), "no row: the dial opens at Normal").toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId(`on-stream-tick-${harbour}`)).not.toBeChecked();
    await expect(page.getByTestId(`on-stream-tick-${ridge}`)).not.toBeChecked();
    const kinds = page.getByTestId("on-stream-preview-kinds-cricket");
    await expect(kinds).toContainText(UI["sponsors.onStream.break.over_end"] ?? "");
    await expect(kinds).toContainText(UI["sponsors.onStream.break.innings_break"] ?? "");
    await expect(kinds, "nothing was counted: no numbers").not.toContainText(/\d/);
    await expect(page.getByTestId("on-stream-strip-cricket")).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // R12: ticking the FIRST sponsor switches the rotation on at Normal - the page shows it once the write lands.
    await page.getByTestId(`on-stream-tick-${harbour}`).check();
    await expect(page.getByTestId("on-stream-switch"), "the first tick created the org row, enabled").toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("on-stream-dial-normal")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId(`on-stream-tick-${harbour}`)).toBeChecked();

    // The dial persists: Busy, then a reload reads it back from the server.
    await page.getByTestId("on-stream-dial-busy").click();
    await expect(page.getByTestId("on-stream-dial-busy")).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(page.getByTestId("on-stream-dial-busy"), "persisted").toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("on-stream-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId(`on-stream-tick-${harbour}`), "the tick persisted").toBeChecked();
    await expect(page.getByTestId("on-stream-where"), "where it shows: lower third and banner, with their seconds").toContainText(/lower third for \d+ seconds/);

    // A competition's own scope: it starts from the org's setting (and says so), then keeps its own after a change.
    await page.getByTestId("on-stream-scope").selectOption(comp.id);
    await expect(page).toHaveURL(new RegExp(`/sponsors\\?tab=on_stream&scope=${comp.id}$`));
    await expect(page.getByTestId("on-stream-inherited")).toBeVisible();
    await expect(page.getByTestId("on-stream-dial-busy"), "inherited from the org").toHaveAttribute("aria-checked", "true");
    await page.getByTestId("on-stream-dial-light").click();
    await expect(page.getByTestId("on-stream-inherited"), "its own row now").toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("on-stream-dial-light"), "the competition keeps Light").toHaveAttribute("aria-checked", "true");
    await page.getByTestId("on-stream-scope").selectOption("");
    await expect(page.getByTestId("on-stream-dial-busy"), "the organisation is still Busy").toHaveAttribute("aria-checked", "true");
    await expectNoHorizontalScroll(page);
  } finally {
    await releaseSettingsOrg(request, seeded);
  }
});

test("on stream: a viewer cannot write the settings (R19) - the route refuses with 403 and nothing changes", async ({ browser, request }) => {
  const seeded = await seedSettingsOrg(request, { label: "sponsors-on-stream-viewer" });
  const member = await seedMemberIdentity(browser, request, seeded.orgId, "viewer");
  try {
    const res = await member.ctx.request.put(`/api/v1/orgs/${seeded.orgId}/sponsor-stream-settings`, {
      data: { competitionId: null, enabled: true, frequency: "busy" },
    });
    expect(res.status(), "a viewer is not an editor").toBe(403);
    const page = await member.ctx.newPage();
    await page.goto(sponsorsUrl(seeded.slug, "on_stream"));
    await expect(page.getByTestId("sponsors-tab-overview"), "and the tab itself falls back").toBeVisible();
    await expect(page.getByTestId("on-stream-tab")).toHaveCount(0);
  } finally {
    await member.release();
    await releaseSettingsOrg(request, seeded);
  }
});
