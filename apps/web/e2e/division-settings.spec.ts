import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, activeOrg, expectNoHorizontalScroll } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import { dictString, publicJson, spectator, uiString } from "./spectator-w2-kit";

// v8 acceptance (spec 2026-07-13): the division Settings tab collects
// general/format/sharing/danger; the format locks once fixtures exist (UI
// read-only + PATCH 409 FORMAT_LOCKED); cards wear their identity — sport
// banner on competitions. Divisions on the competition page moved off that
// card grid onto DivisionLedger in W1 (competition-desk, 2026-09-02): logo
// or the sport emoji, never a letter monogram — see the test below.

async function seedRig(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `V8 Settings ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Tile Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  return { compSlug: comp.data!.slug, divisionId: div.data!.id, divSlug: div.data!.slug };
}

test.afterEach(async () => {
  await closeOpenContexts();
});

test("settings tab: sections render, rename works, format locks with fixtures", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRig(request);
  const base = `/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}`;

  await page.goto(`${base}?tab=settings`);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });
  for (const section of ["General", "Format", "Sharing & embed", "Danger zone"]) {
    await expect(page.getByRole("button", { name: new RegExp(section) })).toBeVisible();
  }

  // Rename from General persists — and the client follows the regenerated
  // slug WITHOUT losing the settings tab (demo-caught regression).
  await page.getByLabel("Division name").fill("Tile Open Renamed");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.waitForURL(/\/d\/tile-open-renamed\?tab=settings/, { timeout: 15_000 });
  await expect(page.getByTestId("division-settings")).toBeVisible();

  // Format editor is live pre-fixtures — structured fields, no JSON needed.
  await page.getByRole("button", { name: /Format/ }).click();

  // Competition format: pick Groups + Knockout, apply, structure rebuilds.
  await page.getByTestId("format-template").selectOption("groups_ko");
  await page.getByRole("spinbutton", { name: "Top N advance" }).fill("2");
  await page.getByTestId("apply-structure").click();
  await expect(page.getByText("Format changed — stages rebuilt.")).toBeVisible();
  await expect(page.getByTestId("stage-structure")).toContainText("Group stage");
  await expect(page.getByTestId("stage-structure")).toContainText("Knockout");

  // Match rules still apply independently.
  await page.getByRole("spinbutton", { name: "Win" }).fill("5");
  await page.getByRole("button", { name: "Save match rules" }).click();
  await expect(page.getByText("Match rules saved.")).toBeVisible();

  // The strays moved: no embed snippet / danger zone under other tabs.
  await page.goto(`${base}?tab=entrants`);
  await expect(page.getByTestId("division-settings")).toHaveCount(0);
  await expect(page.getByText("Danger zone")).toHaveCount(0);

  // Generate fixtures on the new structure → the format is history.
  await apiJson(
    request,
    `/api/v1/divisions/${rig.divisionId}/entrants`,
    "POST",
    ["Alpha", "Bravo", "Cara", "Drew"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stagesNow = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${rig.divisionId}/stages`);
  await apiJson(request, `/api/v1/stages/${stagesNow.data![0]!.id}/generate`, "POST");

  // Renames regenerate the slug — resolve the current one before navigating.
  const fresh = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${rig.divisionId}`);
  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${fresh.data!.slug}?tab=settings`);
  await page.getByRole("button", { name: /Format/ }).click();
  await expect(page.getByTestId("format-locked")).toBeVisible();
  await expect(page.getByText("Format is locked — fixtures exist")).toBeVisible();

  const res = await page.request.patch(`/api/v1/divisions/${rig.divisionId}`, {
    data: { variant_key: "score" },
  });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("FORMAT_LOCKED");

  const swap = await page.request.put(`/api/v1/divisions/${rig.divisionId}/stages`, {
    data: [{ seq: 1, kind: "league", name: "L", config: {}, progression: null }],
  });
  expect(swap.status()).toBe(409);
  expect(((await swap.json()) as { error?: { code?: string } }).error?.code).toBe("FORMAT_LOCKED");
});

test("cards wear their identity: sport banner on comps, sport-emoji avatar on division ledger rows", async ({
  page,
  request,
}) => {
  // W1 (competition-desk design, 2026-09-02 §"Divisions ledger rows") retired
  // the EntityCard tile grid for divisions on THIS page in favour of
  // DivisionLedger: "logo, otherwise the sport emoji … never a letter
  // monogram." The org page's own EntityCard grid (competitions, elsewhere)
  // is unchanged and still asserted below.
  const org = await activeOrg(page);
  const rig = await seedRig(request);

  await page.goto(`/o/${org.slug}`);
  await expect(page.getByTestId("card-banner").first()).toBeVisible({ timeout: 20_000 });

  await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
  const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Tile Open" }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // DivisionLedger renders BOTH responsive compositions into one row (mobile
  // card, then the desktop grid, `md:hidden`/`hidden md:grid`) — this spec's
  // "parallel" project runs at the default desktop viewport, so the mobile
  // copy (DOM-first) is present but hidden; the desktop one (DOM-last) is
  // the one actually on screen. `.last()`, not `.first()`.
  const avatar = row.getByTestId("desk-ledger-avatar").last();
  await expect(avatar).toBeVisible();
  await expect(avatar).not.toHaveText("T"); // never a letter monogram
  await expect(avatar.locator("img")).toHaveCount(0); // no logo uploaded — falls to the sport emoji, not a broken <img>
});

// V416 — `divisions.show_seeds`. An organiser turns "Show seed numbers on the
// public page" OFF in the division's Settings tab, and an anonymous spectator
// then sees no seed chip on the competition hub's Teams tab or the division
// page's Entrants tab, and the entrants come back in NAME order — the seed
// order would publish the seeding without a single number. The anonymous
// entrants document is read too: the redaction is a server one, not CSS.
//
// Seed order is the REVERSE of alphabetical, so the order assertion cannot
// pass on the seed sort. The positive pair runs first on the SAME pages: the
// chips are really there while the setting is on, so "no chip" afterwards is
// the setting and not a page that never drew one.
test("show seeds OFF: no seed chip on the public Teams and Entrants tabs, and the field reads alphabetically", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const org = await activeOrg(page);
  const rig = await seedRig(request);
  const SEEDED = [
    { name: "Zara Top", seed: 1 },
    { name: "Mo Middle", seed: 2 },
    { name: "Abe Bottom", seed: 3 },
  ];
  const created = await apiJson(
    request,
    `/api/v1/divisions/${rig.divisionId}/entrants`,
    "POST",
    SEEDED.map((e) => ({ kind: "individual", display_name: e.name, seed: e.seed })),
  );
  expect(created.status, JSON.stringify(created.error)).toBeLessThan(300);
  const bySeed = SEEDED.map((e) => e.name);
  const byName = [...bySeed].sort();
  expect(byName, "premise: the two orders disagree").not.toEqual(bySeed);

  const hubUrl = `/shared/${org.slug}/${rig.compSlug}?tab=teams`;
  const entrantsUrl = `/shared/${org.slug}/${rig.compSlug}/${rig.divSlug}?tab=entrants`;
  const apiPath = `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/divisions/${rig.divSlug}/entrants`;
  /** A spectator's view of both pages: which of OUR names appear, in DOM
   *  order, and every seed chip the org's own dictionary would print. */
  const spectate = async () => {
    const viewer = await spectator(browser, { width: 1280 });
    await viewer.goto(hubUrl);
    const cards = viewer.locator('[data-testid^="mh-team-"]');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    const hubTexts = await cards.allInnerTexts();
    await viewer.goto(entrantsUrl);
    const panel = viewer.locator("#panel-entrants");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const pageTexts = await panel.locator("li").allInnerTexts();
    const namesIn = (texts: string[]) =>
      texts.map((t) => bySeed.find((n) => t.includes(n))).filter((n): n is string => !!n);
    const chipsIn = (texts: string[], key: string) =>
      SEEDED.filter((e) => texts.some((t) => t.includes(dictString("en", key, { seed: e.seed })))).map((e) => e.seed);
    return {
      hubNames: namesIn(hubTexts),
      hubChips: chipsIn(hubTexts, "teams.seed"),
      pageNames: namesIn(pageTexts),
      pageChips: chipsIn(pageTexts, "division.seed"),
    };
  };
  const apiSeeds = async () => {
    const res = await publicJson<{ entrants: { display_name: string; seed: number | null }[] }>(apiPath);
    expect(res.status).toBe(200);
    return res.data!.entrants.map((e) => [e.display_name, e.seed]);
  };

  // ON (the default): the chips are there, in seed order.
  expect(await spectate(), "seeds shown").toEqual({
    hubNames: bySeed,
    hubChips: [1, 2, 3],
    pageNames: bySeed,
    pageChips: [1, 2, 3],
  });
  expect(await apiSeeds()).toEqual(SEEDED.map((e) => [e.name, e.seed]));

  // The organiser turns it off, through the real control.
  const settings = `/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=settings`;
  const openPublicPage = async (p: Page) => {
    await p.goto(settings);
    await expect(p.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });
    await p.getByRole("button", { name: new RegExp(uiString("en", "divset.publicPage.title")) }).click();
    return p.getByTestId("show-seeds-toggle").getByRole("checkbox");
  };
  const box = await openPublicPage(page);
  await expect(box, "the control opens at the stored value (on)").toBeChecked();
  await box.uncheck();
  await expect(page.getByText(uiString("en", "divset.publicPage.saved"))).toBeVisible({ timeout: 15_000 });
  // It stuck: a fresh load opens at OFF, and the collapsed summary says so.
  await page.goto(settings);
  await expect(page.getByText(uiString("en", "divset.publicPage.seedsHidden"))).toBeVisible({ timeout: 20_000 });
  await expect(await openPublicPage(page)).not.toBeChecked();

  // OFF: no chip on either page, the same names, alphabetical — and the API
  // sends no number at all.
  expect(await spectate(), "seeds hidden").toEqual({
    hubNames: byName,
    hubChips: [],
    pageNames: byName,
    pageChips: [],
  });
  expect(await apiSeeds()).toEqual(byName.map((n) => [n, null]));

  // The organiser's own Entrants tab still carries every seed (admin reads
  // never go through the public view).
  const own = await apiJson<{ display_name: string; seed: number | null }[]>(
    request,
    `/api/v1/divisions/${rig.divisionId}/entrants`,
  );
  expect(own.data!.map((e) => [e.display_name, e.seed]).sort()).toEqual(
    SEEDED.map((e) => [e.name, e.seed]).sort(),
  );

  // The house widths: the Public page block, open, with no page-level
  // horizontal scroll. Element shots only — the block, not the page. The
  // settings column is `max-w-2xl` (672px), so the 768 and 1280 shots are
  // expected to be identical; the viewport and the block's own right edge are
  // asserted so an identical pair cannot mean "the resize never happened".
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const toggle = await openPublicPage(page);
    await expect(toggle).toBeVisible();
    expect(await page.evaluate(() => window.innerWidth)).toBe(width);
    await expectNoHorizontalScroll(page);
    const block = page.getByTestId("show-seeds-toggle").locator("xpath=ancestor::section[1]");
    const rect = (await block.boundingBox())!;
    expect(rect.x + rect.width, `the block fits a ${width}px viewport`).toBeLessThanOrEqual(width);
    await block.screenshot({ path: testInfo.outputPath(`division-settings-public-page-${width}.png`) });
  }
});
