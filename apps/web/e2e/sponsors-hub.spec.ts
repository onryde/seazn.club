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
//   4. The Competitions home's Sponsors entry - the way in at EVERY width, the top-bar Sponsors link being hidden under 350px - works from 320;
//      from 350 the top-bar link is there too, and on a desktop it is a LABELLED link while Settings is its gear alone (owner 2026-11-01).
//   5. On stream (S12): the tab, driven as an editor drives it - the first tick turns the rotation on at Normal (R12) and the page shows
//      it; the dial and a competition's own scope persist across a reload; the preview names a sport's breaks when it has no finished
//      match; and a viewer is refused the settings write (R19). Default viewport only (R17).
//   6. Overview (S13): a REAL stream click - the short code a viewer types, through the real `/s/` route - is what the Overview's
//      Link clicks reads (S10's owed e2e); an editor creates a report link, sees it ONCE, and revokes it, with the row's stored hash
//      checked against the url's token; a viewer reads the same numbers with no Share report, and both link routes refuse it (R19).
//      Default viewport only (R17): no width claims here.
// Width checks for the hub live in mobile.spec.ts (ruling R17: only that file runs in the seven width projects); this file holds its own
// default viewport, plus the 320 pass the Competitions home entry exists for.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers";
import { apiJson, withDb } from "./helpers";
import { releaseSettingsOrg, seedCompetition, seedMemberIdentity, seedSettingsOrg, settingsUrl, sponsorsUrl, type SeededOrg } from "./settings-support";
import { SPONSORS_TABS, sponsorsTabsFor, type SponsorsTab } from "../src/lib/sponsors-hub";
import { SPONSOR_SHORT_CODE_ALPHABET, SPONSOR_SHORT_CODE_MAX_LENGTH } from "../src/lib/sponsor-short-code";
import { overviewHref } from "../src/lib/sponsor-report";

/** Copy read from the dictionary the page renders from, never retyped (this folder's idiom: settings-org-tabs.spec.ts). */
const UI: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
/** The console chrome's copy (the gantry reads `console`, not `ui`). */
const CONSOLE: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/console.json", import.meta.url)), "utf8"),
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

/** Open the Packages tab's tier legend (it folds at EVERY width: owner, 2026-11-11) - and wait on the rows being attached, never visible:
 *  visibility is exactly what the fold denies until it is opened. The tap is gated on the toggle's own state, never on a width literal. */
async function openLegendFold(page: Page): Promise<void> {
  await expect(page.getByTestId("tier-legend-row").first(), "the legend's rows are in the one DOM").toBeAttached();
  const toggle = page.getByTestId("tier-legend-fold").locator('[data-role="phone-disclosure-toggle"]');
  await expect(toggle, "the fold's toggle is in the DOM at every width").toBeAttached();
  if (!(await toggle.isVisible())) return;
  // An empty price list starts open and a list with packages starts folded; a tap before hydration does nothing. So tap only a closed one and
  // re-check until it reads open (a tap that landed after hydration on an open one would fold it; the next pass opens it again).
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle, "the legend opens").toHaveAttribute("aria-expanded", "true", { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
}

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

  // The moved bodies, in place: the add form on Sponsors, the price list on Packages (orders are deals now: they are on each sponsor, on the Sponsors tab).
  await page.goto(sponsorsUrl(org.slug, "packages"));
  await expect(page.getByTestId("sponsor-package-list"), "Packages is the price list").toBeVisible();
  await expect(page.getByTestId("sponsors-tab-packages"), "headed with the tab's own name").toContainText(UI["sponsors.hub.tab.packages"] ?? "");
  // The legend under the price list (owner, 2026-11-11): its heading, and the four tiers highest first, each with its own chip words.
  // It folds at every width (one DOM: the rows are attached either way, and seen only once the toggle is opened), so this reads the rows as
  // ATTACHED and opens the fold when - and only when - its toggle reads closed (a width literal would rot with the breakpoint).
  const legend = page.getByTestId("tier-legend");
  await expect(legend, "the tier legend is under the price list").toBeAttached();
  await openLegendFold(page);
  await expect(legend, "the tier legend is under the price list").toBeVisible();
  // The heading lives in the fold's own toggle row now (it is the summary: the section has no heading of its own), and the section is
  // NAMED by it: `aria-labelledby` must point at an element whose text is the heading. Read from the dictionary, never typed: a missing
  // key is a loud failure here, not an empty string that every `toContainText` accepts.
  const heading = UI["sponsors.pkg.legend.heading"];
  if (heading === undefined || heading === "") throw new Error("en/ui.json has no sponsors.pkg.legend.heading");
  await expect(
    page.getByTestId("tier-legend-fold").locator('[data-role="phone-disclosure-toggle"]'),
    "headed 'What each tier gets': the fold's toggle carries the heading",
  ).toContainText(heading);
  const labelledBy = await legend.getAttribute("aria-labelledby");
  expect(labelledBy, "the legend section is named by an element").toBeTruthy();
  await expect(page.locator(`[id="${labelledBy}"]`), "...and that element's text is the heading").toHaveText(heading);
  const legendRows = page.getByTestId("tier-legend-row");
  await expect(legendRows, "one row per tier").toHaveCount(4);
  expect(await legendRows.evaluateAll((els) => els.map((el) => el.getAttribute("data-tier"))), "highest tier first").toEqual(["title", "gold", "silver", "partner"]);
  await expect(page.getByTestId("tier-legend-chip"), "each row names its tier").toHaveText([
    UI["sponsors.tier.titleTier"] ?? "",
    UI["sponsors.tier.gold"] ?? "",
    UI["sponsors.tier.silver"] ?? "",
    UI["sponsors.tier.partner"] ?? "",
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the legend adds no sideways scroll").toBe(true);
  await page.goto(sponsorsUrl(org.slug, "sponsors"));
  await expect(page.getByTestId("sponsor-package-list"), "Sponsors does not carry the price list").toHaveCount(0);
  await expect(page.getByRole("button", { name: UI["settings.org.sponsors.add"] ?? "", exact: true }), "the add form moved to the Sponsors tab").toBeVisible();
});

test("an unknown tab falls back to Overview, and the page does not scroll sideways at the default viewport", async ({ page }) => {
  await page.goto(`/o/${org.slug}/sponsors?tab=nonsense`);
  await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
  await expect(page.getByTestId("sponsors-tab-link-overview")).toHaveAttribute("aria-current", "page");
  await expectNoHorizontalScroll(page);
});

test("the hub carries no breadcrumb bar on any tab (owner, 2026-11-12: like Streaming and Directory); Settings still does", async ({ page }) => {
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  // The positive pair first: the same console shell, one page over, renders the trail - so a zero on the hub means the bar is
  // gone from THAT page, not that the selector matches nothing anywhere (the bar's desktop <nav> is `sm:flex`; the default viewport is wide).
  await page.goto(`/o/${org.slug}/settings`);
  await expect(trail, "premise: Settings keeps its breadcrumb trail").toBeVisible();
  await expect(page.locator(".app-crumbs"), "premise: ...inside the night apron").toHaveCount(1);

  let checked = 0;
  for (const tab of SPONSORS_TABS) {
    await page.goto(sponsorsUrl(org.slug, tab));
    await expect(page.getByTestId(`sponsors-tab-${tab}`), `${tab}: the hub rendered`).toBeVisible();
    await expect(trail, `${tab}: no breadcrumb trail`).toHaveCount(0);
    await expect(page.locator(".app-crumbs"), `${tab}: no night apron under the gantry`).toHaveCount(0);
    // The page's own return is the one back affordance left: the Streaming page's "<- Dashboard" link.
    // Scoped to <main>: the gantry's own "Dashboard" link (to the org home) shares the name, so a page-wide match is two elements.
    await expect(page.locator("main").getByRole("link", { name: UI["common.dashboard"] ?? "", exact: true }), `${tab}: the Dashboard back link`).toHaveAttribute("href", "/dashboard");
    checked++;
  }
  expect(checked, "every declared tab was checked").toBe(SPONSORS_TABS.length);
  expect(SPONSORS_TABS.length, "anti-vacuity: the hub declares tabs").toBeGreaterThan(0);
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
    await expect(page.getByTestId("sponsor-package-list"), "a viewer is never shown the price list").toHaveCount(0);
    await page.goto(sponsorsUrl(seeded.slug, "on_stream"));
    await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
  } finally {
    await member.release();
    await releaseSettingsOrg(request, seeded);
  }
});

test("the Competitions home's Sponsors entry opens the hub at 320, where the top-bar Sponsors link is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/o/${org.slug}`);
  // Under 350px the top-bar Sponsors link is `display: none`; the Competitions home's own entry is the way in.
  await expect(page.getByTestId("nav-sponsors"), "the top-bar link is hidden at 320").toBeHidden();
  const entry = page.getByTestId("org-home-sponsors");
  await expect(entry, "the Competitions home entry is visible at 320").toBeVisible();
  await expectNoHorizontalScroll(page);
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`/o/${org.slug}/sponsors$`));
  await expect(page.getByTestId("sponsors-tab-overview")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // From 350 the top-bar link is there too (the Player-home precedent), pointing at the same place - its icon alone on a phone.
  await page.setViewportSize({ width: 350, height: 800 });
  await expect(page.getByTestId("nav-sponsors")).toBeVisible();
  await expect(page.getByTestId("nav-sponsors")).toHaveAttribute("href", `/o/${org.slug}/sponsors`);

  // On a desktop (owner ruling 2026-11-01) Sponsors paints its word like Dashboard and Directory. Settings is no longer a bar icon
  // (the account menu, 2026-11-11): it is one tap into the menu, named, and still points at this org's Settings.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("nav-sponsors"), "a labelled link at 1280").toHaveText(CONSOLE["nav.sponsors"] ?? "");
  await expect(page.locator('header.app-gantry [data-testid="nav-settings"]'), "no Settings icon on the bar").toHaveCount(0);
  const trigger = page.locator("header.app-gantry").getByRole("button", { name: CONSOLE["nav.account.menu"] ?? "", exact: true });
  await expect(trigger, "the account menu is found by its accessible name").toBeVisible();
  await trigger.click();
  const settings = page.getByTestId("account-menu-settings");
  await expect(settings, "Organisation settings is in the menu").toBeVisible();
  await expect(settings).toHaveAttribute("href", `/o/${org.slug}/settings`);
  await expect(settings).toHaveText(CONSOLE["nav.account.orgSettings"] ?? "");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("account-menu")).toHaveCount(0);
});

test("packages at 320, 768 and 1280: the tier legend is open on an empty list, folds once there is a package, and a tap opens and hides it; the note sits higher while it is folded", async ({ page, request }) => {
  // Three widths, each with a page load or two and a few taps.
  test.setTimeout(120_000);
  // Its own org: a package written here must not leak into the shared one's other tests (an empty list is what opens the legend).
  const seeded = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-legend-fold" });
  const WIDTHS = [320, 768, 1280];
  try {
    const toggle = page.getByTestId("tier-legend-fold").locator('[data-role="phone-disclosure-toggle"]');
    const rows = page.getByTestId("tier-legend-row");
    const note = page.getByTestId("package-online-note");

    // Empty list: it starts open, at every width (a desktop folds it too now, so its toggle is on the screen there as well).
    let checkedOpen = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(sponsorsUrl(seeded.slug, "packages"));
      await expect(page.getByTestId("package-empty"), `${width}: premise: no packages yet`).toBeVisible();
      await expect(toggle, `${width}: the fold's toggle is on the screen`).toBeVisible();
      await expect(toggle, `${width}: an empty price list opens its legend`).toHaveAttribute("aria-expanded", "true");
      await expect(rows.first(), `${width}: its rows are shown`).toBeVisible();
      await expect(page.getByTestId("tier-legend-upgrade"), `${width}: an editor on a plan with tiers sees no upgrade link`).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      checkedOpen++;
    }
    expect(checkedOpen, "every width was looked at with an empty list").toBe(WIDTHS.length);

    // One package: the legend now starts folded, its rows still in the DOM and not on the screen, and the online note rises by its height.
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${seeded.orgId}/sponsor-packages`, "POST", { name: "Fold probe", price_cents: 12_000, currency: "gbp", tier: "partner" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    let checkedFolded = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(sponsorsUrl(seeded.slug, "packages"));
      await expect(page.getByTestId("package-card"), `${width}: premise: the package is listed`).toHaveCount(1);
      await expect(toggle, `${width}: the fold's toggle is on the screen`).toBeVisible();
      await expect(toggle, `${width}: with a package the legend starts folded`).toHaveAttribute("aria-expanded", "false");
      await expect(rows.first(), `${width}: folded: attached, not shown`).toBeAttached();
      await expect(rows.first()).toBeHidden();
      await expect(note).toBeVisible();
      // Page coordinates (a tap can scroll the viewport, and a viewport-relative y would then move for the wrong reason).
      const pageY = () => note.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
      const folded = await pageY();

      await expect(async () => {
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
      await expect(rows, `${width}: a tap opens all four`).toHaveCount(4);
      await expect(rows.first()).toBeVisible();
      await expect(rows.last()).toBeVisible();
      const open = await pageY();
      expect(folded, `${width}: the note sits higher while the legend is folded`).toBeLessThan(open);
      expect(open - folded, `${width}: by about the legend's height (four rows are well over 150px)`).toBeGreaterThan(150);
      await expectNoHorizontalScroll(page);

      // And a tap hides it again (the hide label): the second half of "open / hide".
      await toggle.click();
      await expect(toggle, `${width}: a second tap hides it`).toHaveAttribute("aria-expanded", "false");
      await expect(rows.first()).toBeHidden();
      checkedFolded++;
    }
    expect(checkedFolded, "every width was looked at with a package").toBe(WIDTHS.length);
  } finally {
    await releaseSettingsOrg(request, seeded);
  }
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
    // "why has big fat button?" (owner, stg): the switch is a slim track drawn inside a 44px tap target, not a 44px-tall pill. Measured and
    // hit-tested the way a finger meets it (a painted box says nothing about what a tap reaches; a rounded target loses its corners).
    const probe = await page.getByTestId("on-stream-switch").evaluate((el) => {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const track = el.querySelector('[data-testid="on-stream-switch-track"]')?.getBoundingClientRect() ?? null;
      // The visible track against the button's own rect: a track that overhangs its 44px target would paint a hit the button never takes.
      const inside =
        track === null
          ? null
          : {
              left: track.left - r.left,
              right: r.right - track.right,
              top: track.top - r.top,
              bottom: r.bottom - track.bottom,
              dx: Math.abs(track.left + track.width / 2 - (r.left + r.width / 2)),
              dy: Math.abs(track.top + track.height / 2 - (r.top + r.height / 2)),
            };
      const hits = (x: number, y: number): boolean => {
        const at = document.elementFromPoint(x, y);
        return at !== null && (at === el || el.contains(at));
      };
      return {
        width: r.width,
        height: r.height,
        trackHeight: track?.height ?? null,
        inside,
        corners: [hits(r.left + 3, r.top + 3), hits(r.right - 3, r.top + 3), hits(r.left + 3, r.bottom - 3), hits(r.right - 3, r.bottom - 3), hits(r.left + r.width / 2, r.top + r.height / 2)],
      };
    });
    expect(probe.width, "the switch's tap target is at least 44px wide").toBeGreaterThanOrEqual(44);
    expect(probe.height, "the switch's tap target is at least 44px tall").toBeGreaterThanOrEqual(44);
    expect(probe.corners, "a tap at each corner and the centre of the target lands on the switch").toEqual([true, true, true, true, true]);
    expect(probe.trackHeight, "the track is drawn (a slim one inside the target)").not.toBeNull();
    expect(probe.trackHeight!, "the drawn track is slim, not a 44px pill").toBeLessThanOrEqual(32);
    expect(probe.inside, "the track's rect was measured").not.toBeNull();
    const { left, right, top, bottom, dx, dy } = probe.inside!;
    expect(left, "the track starts inside the button (its left edge is not left of the button's)").toBeGreaterThanOrEqual(0);
    expect(right, "the track ends inside the button (its right edge is not right of the button's)").toBeGreaterThanOrEqual(0);
    expect(top, "the track's top is inside the button").toBeGreaterThanOrEqual(0);
    expect(bottom, "the track's bottom is inside the button").toBeGreaterThanOrEqual(0);
    expect(dx, "the track is centred across the button, to the pixel").toBeLessThanOrEqual(1);
    expect(dy, "the track is centred down the button, to the pixel").toBeLessThanOrEqual(1);
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

/** A realistic long sponsor name (AGENTS.md: a 43-character name is what found the last phone overflow). */
const LONG_SPONSOR = "Harbourside Building Supplies and Timber Co";

test("overview: a stream click - the code a viewer types, through the real /s/ route - counts once on the Overview's Link clicks", async ({ page, request }) => {
  const seeded = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-overview-click" });
  try {
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${seeded.orgId}/sponsors`, "POST", { name: LONG_SPONSOR, tier: "gold", url: "https://harbourside.example/s13" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const sponsorId = made.data!.id;

    // Before any click: the row reads zeros (a real zero, not a dash) and viewers - not measured yet (owner ruling 2026-11-01:
    // PR B deferred) - the "Coming soon" legend.
    await page.goto(sponsorsUrl(seeded.slug, "overview"));
    const row = page.getByTestId(`sponsor-overview-row-${sponsorId}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("sponsor-overview-clicks")).toHaveText("0");
    // The legend is real text a screen reader reads as shown: the whole cell is its words, and nothing in it is aria-hidden.
    expect(UI["sponsors.viewers.comingSoon"], "the dictionary has the legend").toBeTruthy();
    const viewers = row.getByTestId("sponsor-overview-viewers");
    await expect(viewers).toHaveText(UI["sponsors.viewers.comingSoon"] ?? "");
    await expect(viewers.getByTestId("viewers-coming-soon")).toBeVisible();
    await expect(viewers.locator('[aria-hidden="true"]')).toHaveCount(0);

    // The stream's short code (S5 mints it from a live overlay poll; written straight to its table here, as public-fixture.spec.ts
    // does). Drawn from the declared alphabet at the longest length so no other run collides.
    const pick = (from: readonly string[]) => from[Math.floor(Math.random() * from.length)]!;
    const code = Array.from({ length: SPONSOR_SHORT_CODE_MAX_LENGTH }, () => pick([...SPONSOR_SHORT_CODE_ALPHABET])).join("");
    await withDb((sql) => sql`insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id) values (${code}, ${seeded.orgId}, ${sponsorId}, null)`);
    const res = await page.request.get(`/s/${code}`, { maxRedirects: 0, headers: { "fly-client-ip": "198.51.100.77" } });
    expect(res.status(), "the code redirects").toBe(302);
    expect(res.headers()["location"]).toBe("https://harbourside.example/s13");

    // The Overview reads it: one link click, this year and in the last 30 days (the picker navigates).
    await expect
      .poll(async () => {
        await page.reload();
        return (await row.getByTestId("sponsor-overview-clicks").textContent())?.trim();
      }, { timeout: 15_000 })
      .toBe("1");
    await page.getByTestId("sponsor-overview-period").selectOption("last_30_days");
    await expect(page).toHaveURL(new RegExp(`${overviewHref(seeded.slug, { kind: "last_30_days" }).replace("?", "\\?")}$`));
    await expect(row.getByTestId("sponsor-overview-clicks"), "last 30 days").toHaveText("1");
    await expect(row.getByTestId("sponsor-overview-times"), "no stream aired it").toHaveText("0");
    await expect(page.getByTestId("sponsor-overview-notes")).toContainText(UI["sponsors.overview.clicksFootnote"] ?? "");
    await expectNoHorizontalScroll(page);
  } finally {
    await releaseSettingsOrg(request, seeded);
  }
});

test("overview + share: an editor creates a report link, sees it once, revokes it; a viewer reads the Overview with no Share report and both link routes refuse it (R19)", async ({ page, browser, request }) => {
  const seeded = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-overview-share" });
  const member = await seedMemberIdentity(browser, request, seeded.orgId, "viewer");
  try {
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${seeded.orgId}/sponsors`, "POST", { name: LONG_SPONSOR, tier: "title" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const sponsorId = made.data!.id;
    const linksOf = () => withDb((sql) => sql<{ id: string; token_hash: Buffer; revoked_at: Date | null }[]>`
      select id, token_hash, revoked_at from sponsor_report_links where org_id = ${seeded.orgId} order by created_at`);

    await page.goto(sponsorsUrl(seeded.slug, "overview"));
    const row = page.getByTestId(`sponsor-overview-row-${sponsorId}`);
    await expect(row.getByTestId("sponsor-overview-name")).toHaveText(LONG_SPONSOR);
    await row.getByTestId("sponsor-overview-share").click();
    const panel = row.getByTestId("sponsor-share");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("sponsor-share-none")).toBeVisible();

    // Create: the url appears once, absolute, and its token hashes to the stored row.
    await panel.getByTestId("sponsor-share-create").click();
    const url = panel.getByTestId("sponsor-share-url");
    await expect(url).toHaveValue(/\/r\/sponsor\/[A-Za-z0-9_-]{43}$/);
    const shown = await url.inputValue();
    expect(new URL(shown).origin, "absolute, on the origin the organiser is on").toBe(new URL(page.url()).origin);
    const token = new URL(shown).pathname.split("/").at(-1)!;
    const [stored] = await linksOf();
    expect(stored, "one row").toBeDefined();
    expect(Buffer.from(stored!.token_hash).equals(createHash("sha256").update(token, "utf8").digest()), "only the hash is stored").toBe(true);
    await expectNoHorizontalScroll(page);

    // Done: the url is gone for good; the live link is listed (without its token).
    await panel.getByTestId("sponsor-share-done").click();
    await expect(panel.getByTestId("sponsor-share-url")).toHaveCount(0);
    const listed = panel.getByTestId(`sponsor-share-link-${stored!.id}`);
    await expect(listed).toBeVisible();
    expect(await panel.textContent(), "the token is nowhere in the panel").not.toContain(token);

    // A second link, made through the route, for the viewer's DELETE below.
    const second = await apiJson<{ id: string }>(request, `/api/v1/orgs/${seeded.orgId}/sponsors/${sponsorId}/report-links`, "POST", { competitionId: null, from: "2026-01-01", to: "2026-12-31" });
    expect(second.status, JSON.stringify(second.error)).toBe(201);

    // Revoke asks first, then the row goes and the table says revoked.
    await listed.getByTestId(`sponsor-share-revoke-${stored!.id}`).click();
    await listed.getByTestId(`sponsor-share-revoke-yes-${stored!.id}`).click();
    await expect(panel.getByTestId(`sponsor-share-link-${stored!.id}`)).toHaveCount(0);
    await expect.poll(async () => (await linksOf()).find((l) => l.id === stored!.id)?.revoked_at !== null).toBe(true);

    // The viewer: the same row and numbers, no Share report; both link routes refuse it, and nothing changes.
    const vp = await member.ctx.newPage();
    await vp.goto(sponsorsUrl(seeded.slug, "overview"));
    await expect(vp.getByTestId(`sponsor-overview-row-${sponsorId}`)).toBeVisible();
    await expect(vp.getByTestId(`sponsor-overview-row-${sponsorId}`).getByTestId("sponsor-overview-clicks")).toHaveText("0");
    await expect(vp.getByTestId("sponsor-overview-share"), "a viewer is never offered Share report").toHaveCount(0);
    const post = await member.ctx.request.post(`/api/v1/orgs/${seeded.orgId}/sponsors/${sponsorId}/report-links`, { data: { competitionId: null, from: "2026-01-01", to: "2026-12-31" } });
    expect(post.status(), "a viewer cannot create a link").toBe(403);
    const del = await member.ctx.request.delete(`/api/v1/orgs/${seeded.orgId}/sponsor-report-links/${second.data!.id}`);
    expect(del.status(), "a viewer cannot revoke one").toBe(403);
    const after = await linksOf();
    expect(after.map((l) => [l.id, l.revoked_at === null]), "the viewer changed nothing").toEqual([[stored!.id, false], [second.data!.id, true]]);
  } finally {
    await member.release();
    await releaseSettingsOrg(request, seeded);
  }
});
