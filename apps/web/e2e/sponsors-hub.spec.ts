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
//   6. Overview (S13): a REAL stream click - the short code a viewer types, through the real `/s/` route - is what the Overview's
//      Link clicks reads (S10's owed e2e); an editor creates a report link, sees it ONCE, and revokes it, with the row's stored hash
//      checked against the url's token; a viewer reads the same numbers with no Share report, and both link routes refuse it (R19).
//      Default viewport only (R17): no width claims here.
// Width checks for the hub live in mobile.spec.ts (ruling R17: only that file runs in the seven width projects); this file holds its own
// default viewport, plus the 320 pass the Dashboard entry exists for.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
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

/** A realistic long sponsor name (AGENTS.md: a 43-character name is what found the last phone overflow). */
const LONG_SPONSOR = "Harbourside Building Supplies and Timber Co";

test("overview: a stream click - the code a viewer types, through the real /s/ route - counts once on the Overview's Link clicks", async ({ page, request }) => {
  const seeded = await seedSettingsOrg(request, { plan: "pro", label: "sponsors-overview-click" });
  try {
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${seeded.orgId}/sponsors`, "POST", { name: LONG_SPONSOR, tier: "gold", url: "https://harbourside.example/s13" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const sponsorId = made.data!.id;

    // Before any click: the row reads zeros (a real zero, not a dash) and viewers a dash.
    await page.goto(sponsorsUrl(seeded.slug, "overview"));
    const row = page.getByTestId(`sponsor-overview-row-${sponsorId}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("sponsor-overview-clicks")).toHaveText("0");
    // The dash is two parts: the mark on screen (hidden from screen readers) and the words a screen reader says instead.
    // `toHaveText` on the cell would read both, so each is asserted on its own.
    const viewers = row.getByTestId("sponsor-overview-viewers");
    await expect(viewers.locator('[aria-hidden="true"]')).toHaveText("—");
    await expect(viewers.locator(".sr-only")).toHaveText(UI["sponsors.overview.notMeasured"] ?? "");
    expect(UI["sponsors.overview.notMeasured"], "the dictionary has the spoken words").toBeTruthy();

    // The stream's short code (S5 mints it from a live overlay poll; written straight to its table here, as public-fixture.spec.ts
    // does). Drawn from the declared alphabet at the longest length so no other run collides.
    const pick = (from: readonly string[]) => from[Math.floor(Math.random() * from.length)]!;
    const code = Array.from({ length: SPONSOR_SHORT_CODE_MAX_LENGTH }, () => pick([...SPONSOR_SHORT_CODE_ALPHABET])).join("");
    await withDb((sql) => sql`insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id) values (${code}, ${seeded.orgId}, ${sponsorId}, null)`);
    const res = await page.request.get(`/s/${code}`, { maxRedirects: 0, headers: { "cf-connecting-ip": "198.51.100.77" } });
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
