import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAG, apiJson, activeOrg, expectNoHorizontalScroll } from "./helpers";
import { seedOnlineRound } from "./match-room-kit";
import { closeOpenContexts } from "./spectator-public-helpers";
import { dictString, publicJson, spectator, uiString, type W2Locale } from "./spectator-w2-kit";

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

// ─── Online chess: the camera group (Task 6's owed browser checks) ──────────────────────────────────────────────────
//
// task-6-report.md "Visual and e2e checks owed" 1-11, the T6 review's M-7 (a) axe on the group and (b) its collapsed
// summary at 320, the follow-up review's Minor 2 (save "Competition setting" and RELOAD) and M-6 (the tab still renders
// after a rules save — the TDZ crash T6 fixed had no test that fails without it). apps/web vitest is node-env and the
// Group renders collapsed, so none of this is reachable from a unit test. Copy comes from the dictionaries (the copy's
// own source); the time-control list is the owner's ruling (2026-10-09), typed here — never read from the catalogue.

/** Ship-1 online clocks, as the owner ruled them (progress.md, 2026-10-09 + the 10+0/15+0 ruling), in that order. */
const SHIP_1_CLOCKS = ["3+0", "3+2", "5+0", "5+3", "10+0", "10+5", "15+0", "15+10"];
/** "Monitored" in each locale — no camera sentence may claim it (task-6-report.md check 11). */
const MONITORED: Record<W2Locale, RegExp> = { en: /monitor/i, es: /monitoriz|vigilad/i, fr: /surveill/i, nl: /monitor|bewaakt|toezicht/i };
const LOCALES: W2Locale[] = ["en", "es", "fr", "nl"];

async function seedChessDivision(
  request: APIRequestContext,
  page: Page,
  opts: { online: boolean; camera?: "off" | "optional" | "required" },
): Promise<{ divisionId: string; settings: string }> {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `T6 Camera ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Camera Open",
    sport_key: "boardgame",
    variant_key: "classical",
    // 10+5: a ship-1 clock, so turning online play on is a legal save.
    config: { variant: "classical", clock: { base: 600, increment: 5 }, ...(opts.online ? { onlinePlay: "lichess" } : {}) },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  if (opts.camera) {
    const cam = await apiJson(request, `/api/v1/divisions/${div.data!.id}`, "PATCH", { camera_policy: opts.camera });
    expect(cam.status, JSON.stringify(cam.error)).toBeLessThan(300);
  }
  return { divisionId: div.data!.id, settings: `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=settings` };
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The camera group's toggle; its accessible name is the title, then the summary while collapsed. */
const cameraToggle = (page: Page, locale: W2Locale = "en") =>
  page.getByRole("button", { name: new RegExp(`^${escapeRe(uiString(locale, "divset.camera.label"))}`) });
const cameraSection = (page: Page, locale: W2Locale = "en") => page.locator("section").filter({ has: cameraToggle(page, locale) });

async function openCameraGroup(page: Page, locale: W2Locale = "en"): Promise<void> {
  const toggle = cameraToggle(page, locale);
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("division-camera-policy")).toBeVisible();
}

async function gotoSettings(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });
}

/** Every uncaught page error, so a crash the error boundary swallows still reds. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
  return errors;
}

async function setLocaleCookie(page: Page, locale: W2Locale): Promise<void> {
  const origin = new URL(page.url() === "about:blank" ? (process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000") : page.url()).origin;
  await page.context().addCookies([{ name: "seazn_locale", value: locale, url: origin }]);
}

test.describe("online chess: the division's camera group (Task 6's owed browser checks)", () => {
  test("chess only; gated on SAVED online play — and a rules save leaves the tab standing (M-6); the inherited hint; the Required notice; Save, reload, and back to the competition's setting (Minor 2)", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const errors = pageErrors(page);

    // 1. Not a chess division: no camera group. One non-chess sport only — the gate is `sport_key === "boardgame"`, one
    //    comparison, and the chess division below is its positive pair.
    const org = await activeOrg(page);
    const plain = await seedRig(request);
    await gotoSettings(page, `/o/${org.slug}/c/${plain.compSlug}/d/${plain.divSlug}?tab=settings`);
    await expect(page.getByRole("button", { name: /Format/ })).toBeVisible();
    await expect(cameraToggle(page)).toHaveCount(0);

    // 2. A chess division with online play OFF: the group is there, the select and Save are disabled, and it says why.
    const rig = await seedChessDivision(request, page, { online: false });
    await gotoSettings(page, rig.settings);
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy")).toBeDisabled();
    await expect(page.getByTestId("division-camera-save")).toBeDisabled();
    await expect(page.getByTestId("division-camera-needs-online")).toHaveText(uiString("en", "divset.camera.needsOnlinePlay"));

    // An unsaved Online play choice does not unlock it: the camera follows the SAVED value.
    await page.getByRole("button", { name: /Format/ }).click();
    await page.getByTestId("division-online-play").selectOption("lichess");
    await expect(page.getByTestId("division-camera-policy"), "an unsaved choice unlocked the camera").toBeDisabled();
    // Saving the rules turns it on — and (M-6) the refreshed config re-syncs the form without crashing the tab: the
    // enabled select below can only come from the NEW config having rendered.
    await page.getByRole("button", { name: uiString("en", "divset.saveRules") }).click();
    await expect(page.getByText("Match rules saved.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("division-camera-policy")).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId("division-camera-needs-online")).toHaveCount(0);
    await expect(page.getByTestId("division-settings"), "M-6: the tab still renders after a rules save").toBeVisible();
    expect(errors, "M-6: no page error from the post-save re-sync").toEqual([]);

    // 3. Nothing pinned: the competition's setting applies, and the hint says which (the competition default, Off).
    const off = uiString("en", "divset.camera.off");
    await expect(page.getByTestId("division-camera-policy")).toHaveValue("inherit");
    await expect(page.getByTestId("division-camera-inherited")).toHaveText(uiString("en", "divset.camera.inherited", { policy: off }));
    // 5. Unchanged: Save is disabled.
    await expect(page.getByTestId("division-camera-save")).toBeDisabled();

    // 4. Required shows what players are told, verbatim; Optional and Off hide it.
    const notice = page.getByTestId("division-camera-player-notice");
    await page.getByTestId("division-camera-policy").selectOption("required");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(uiString("en", "divset.camera.playerNoticeLabel"));
    await expect(notice).toContainText(uiString("en", "onlineChess.camera.playerNotice"));
    for (const relaxed of ["optional", "off"]) {
      await page.getByTestId("division-camera-policy").selectOption(relaxed);
      await expect(notice, `${relaxed} hides the notice`).toHaveCount(0);
    }

    // 3 + 5. Pin Optional: saved, the inherited hint goes, and it survives a reload.
    await page.getByTestId("division-camera-policy").selectOption("optional");
    await expect(page.getByTestId("division-camera-save")).toBeEnabled();
    await page.getByTestId("division-camera-save").click();
    await expect(page.getByText(uiString("en", "divset.camera.saved"))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("division-camera-inherited")).toHaveCount(0);
    await gotoSettings(page, rig.settings);
    await expect(cameraToggle(page), "the collapsed summary names the pinned value").toHaveAccessibleName(
      new RegExp(`${escapeRe(uiString("en", "divset.camera.optional"))}$`),
    );
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy")).toHaveValue("optional");
    await expect(page.getByTestId("division-camera-inherited")).toHaveCount(0);
    await expect(page.getByTestId("division-camera-save"), "unchanged after the reload").toBeDisabled();

    // Minor 2: back to the competition's setting. Before Save the hint says what WILL apply; after Save and a reload
    // the division stores nothing (null) and inherits again.
    await page.getByTestId("division-camera-policy").selectOption("inherit");
    await expect(page.getByTestId("division-camera-inherited")).toHaveText(uiString("en", "divset.camera.inheritPending", { policy: off }));
    await page.getByTestId("division-camera-save").click();
    await expect(page.getByText(uiString("en", "divset.camera.saved"))).toBeVisible({ timeout: 15_000 });
    await gotoSettings(page, rig.settings);
    await expect(cameraToggle(page)).toHaveAccessibleName(new RegExp(`${escapeRe(uiString("en", "divset.camera.inheritSummary", { policy: off }))}$`));
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy")).toHaveValue("inherit");
    await expect(page.getByTestId("division-camera-inherited")).toHaveText(uiString("en", "divset.camera.inherited", { policy: off }));
    const stored = await apiJson<{ camera_policy: string | null }>(request, `/api/v1/divisions/${rig.divisionId}`);
    expect(stored.data?.camera_policy, "inherit is stored as NULL, not as the competition's value").toBeNull();
    expect(errors).toEqual([]);
  });

  test("a division WITH fixtures: the Format group is read-only, the camera group still edits and saves (6)", async ({ page, request }) => {
    test.setTimeout(150_000);
    const round = await seedOnlineRound(request, ["Cam Fix A", "Cam Fix B"], { open: false });
    const settings = round.fixturesTab.replace("?tab=fixtures", "?tab=settings");
    await gotoSettings(page, settings);
    await page.getByRole("button", { name: /Format/ }).click();
    await expect(page.getByTestId("format-locked")).toBeVisible();
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy")).toBeEnabled();
    // No round is open, so tightening is still allowed (D9).
    await page.getByTestId("division-camera-policy").selectOption("required");
    await page.getByTestId("division-camera-save").click();
    await expect(page.getByText(uiString("en", "divset.camera.saved"))).toBeVisible({ timeout: 15_000 });
    await gotoSettings(page, settings);
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy")).toHaveValue("required");
  });

  test("after a round opens: a tightening is refused in the viewer's language and the select snaps back; a relaxation saves (7)", async ({ page, request }) => {
    test.setTimeout(150_000);
    const round = await seedOnlineRound(request, ["Cam Lock A", "Cam Lock B"], { camera: "optional" });
    const settings = round.fixturesTab.replace("?tab=fixtures", "?tab=settings");
    await gotoSettings(page, settings);
    await setLocaleCookie(page, "es");
    await gotoSettings(page, settings);
    await openCameraGroup(page, "es");
    const select = page.getByTestId("division-camera-policy");
    await expect(select).toHaveValue("optional");
    await select.selectOption("required");
    await page.getByTestId("division-camera-save").click();
    await expect(page.getByText(uiString("es", "divset.err.cameraPolicyLocked"))).toBeVisible({ timeout: 15_000 });
    await expect(select, "snapped back to the stored value").toHaveValue("optional");
    const still = await apiJson<{ camera_policy: string | null }>(request, `/api/v1/divisions/${round.divisionId}`);
    expect(still.data?.camera_policy, "nothing was written").toBe("optional");
    // Relaxing is always allowed.
    await select.selectOption("off");
    await page.getByTestId("division-camera-save").click();
    await expect(page.getByText(uiString("es", "divset.camera.saved"))).toBeVisible({ timeout: 15_000 });
    await gotoSettings(page, settings);
    await openCameraGroup(page, "es");
    await expect(select).toHaveValue("off");
  });

  test("a rules save with Lichess on a 1+0 clock names the ship-1 clocks, in the viewer's language (8)", async ({ page, request }) => {
    test.setTimeout(120_000);
    const rig = await seedChessDivision(request, page, { online: false });
    await gotoSettings(page, rig.settings);
    await setLocaleCookie(page, "fr");
    await gotoSettings(page, rig.settings);
    // The Format group's title in French, then the clock fields (sport-rules vocabulary: English in every locale).
    await page.getByRole("button", { name: new RegExp(escapeRe(uiString("fr", "divset.format"))) }).first().click();
    // Online play is still Off, so the free clock fields are there: type a 1+0 the server will refuse. THEN turn
    // Lichess on — the picker takes the fields' place, finds none of the supported controls in the typed clock, and
    // says so (item 2, 2026-10-19: with Lichess the clock is a picker, not three free inputs).
    await page.getByRole("spinbutton", { name: "Time per side (minutes)" }).fill("1");
    await page.getByRole("spinbutton", { name: "Increment per move (seconds, Fischer)" }).fill("0");
    await page.getByTestId("division-online-play").selectOption("lichess");
    await expect(page.getByTestId("division-time-control"), "a typed 1+0 is none of the supported controls").toHaveValue("");
    await expect(page.getByText(uiString("fr", "divset.timeControl.unsupported"))).toBeVisible();
    await page.getByRole("button", { name: uiString("fr", "divset.saveRules") }).click();
    await expect(page.getByText(uiString("fr", "divset.err.timeControlUnsupported", { controls: SHIP_1_CLOCKS.join(", ") }))).toBeVisible({
      timeout: 15_000,
    });
    const stored = await apiJson<{ config: { onlinePlay?: string; clock?: unknown } }>(request, `/api/v1/divisions/${rig.divisionId}`);
    expect(stored.data?.config.onlinePlay, "the refused save wrote nothing").toBeUndefined();
    expect(stored.data?.config.clock).toEqual({ base: 600, increment: 5 });
  });

  test("online play = Lichess: the clock is ONE picker of the supported controls; choosing saves, a reopen keeps it, Off brings the free fields back (item 2)", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const errors = pageErrors(page);
    // 10+5 stored, online play OFF: the free fields are there to begin with.
    const rig = await seedChessDivision(request, page, { online: false });
    await gotoSettings(page, rig.settings);
    await page.getByRole("button", { name: /Format/ }).click();
    const freeFields = ["Time per side (minutes)", "Increment per move (seconds, Fischer)", "Move delay (seconds, Bronstein/US delay)"];
    for (const name of freeFields) await expect(page.getByRole("spinbutton", { name }), `Off: ${name}`).toBeVisible();
    await expect(page.getByTestId("division-time-control"), "Off: no picker").toHaveCount(0);

    // Lichess: one select, opened on the stored clock; the free inputs (and the family field) give way to it.
    await page.getByTestId("division-online-play").selectOption("lichess");
    const picker = page.getByTestId("division-time-control");
    await expect(picker).toBeVisible();
    await expect(picker, "opens on the stored 10+5").toHaveValue("10+5");
    for (const name of freeFields) await expect(page.getByRole("spinbutton", { name }), `Lichess: ${name}`).toHaveCount(0);
    await expect(page.getByText("Clock family", { exact: true })).toHaveCount(0);
    // The options are the supported controls — the same list the server's refusal names (test 8 above reads it from there).
    const values = await picker.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values).toEqual(SHIP_1_CLOCKS);
    const labels = await picker.locator("option").allTextContents();
    expect(labels, "each option names its clock family").toContain(`5+3 \u00b7 ${uiString("en", "variant.boardgame.blitz")}`);
    expect(labels).toContain(`10+5 \u00b7 ${uiString("en", "variant.boardgame.rapid")}`);

    // Choose 5+3. Lichess -> Off: the free inputs return carrying the pick (the same form fields); -> Lichess again: still 5+3.
    await picker.selectOption("5+3");
    await page.getByTestId("division-online-play").selectOption("off");
    await expect(page.getByTestId("division-time-control")).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: freeFields[0]! })).toHaveValue("5");
    await expect(page.getByRole("spinbutton", { name: freeFields[1]! })).toHaveValue("3");
    await page.getByTestId("division-online-play").selectOption("lichess");
    await expect(page.getByTestId("division-time-control")).toHaveValue("5+3");

    // Save: the same fields the free inputs write (seconds), the family follows, Lichess on.
    await page.getByRole("button", { name: uiString("en", "divset.saveRules") }).click();
    await expect(page.getByText("Match rules saved.")).toBeVisible({ timeout: 15_000 });
    const stored = await apiJson<{ config: { onlinePlay?: string; variant?: string; clock?: unknown } }>(
      request,
      `/api/v1/divisions/${rig.divisionId}`,
    );
    expect(stored.data?.config.clock).toEqual({ base: 300, increment: 3 });
    expect(stored.data?.config.variant).toBe("blitz");
    expect(stored.data?.config.onlinePlay).toBe("lichess");

    // Reopen: the saved control is the one selected.
    await gotoSettings(page, rig.settings);
    await page.getByRole("button", { name: /Format/ }).click();
    await expect(page.getByTestId("division-time-control")).toHaveValue("5+3");
    expect(errors).toEqual([]);
  });

  test("Required, in all four languages: the notice verbatim and nothing says monitored (11); no page scroll at 320/768/1280 in es and fr (10); axe on the open group (M-7a); the collapsed summary at 320 (M-7b)", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const errors = pageErrors(page);
    const rig = await seedChessDivision(request, page, { online: true, camera: "required" });
    const inherit = await seedChessDivision(request, page, { online: true });
    await gotoSettings(page, rig.settings);
    let localesChecked = 0;
    let widthsChecked = 0;
    for (const locale of LOCALES) {
      await setLocaleCookie(page, locale);
      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoSettings(page, rig.settings);
      await openCameraGroup(page, locale);
      const notice = page.getByTestId("division-camera-player-notice");
      await expect(notice.locator("p").first()).toHaveText(uiString(locale, "divset.camera.playerNoticeLabel"));
      await expect(notice.locator("p").nth(1), `${locale}: the notice, verbatim`).toHaveText(uiString(locale, "onlineChess.camera.playerNotice"));
      const groupText = await cameraSection(page, locale).innerText();
      expect(groupText, `${locale}: a camera sentence says "monitored"`).not.toMatch(MONITORED[locale]);
      if (locale === "es" || locale === "fr") {
        for (const width of [320, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(notice).toBeVisible();
          await expectNoHorizontalScroll(page);
          widthsChecked++;
        }
      }
      if (locale === "es") {
        // M-7 (a): the open group, notice shown, at the narrowest width.
        await page.setViewportSize({ width: 320, height: 900 });
        const axe = await new AxeBuilder({ page })
          .include('section:has([data-testid="division-camera-policy"])')
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();
        const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(blocking.map((v) => `${v.id}: ${v.nodes[0]?.html}`), "axe serious/critical on the open camera group").toEqual([]);
        // M-7 (b): the COLLAPSED summary at 320, for a pinned value and for the inherited one — not cut off, and no
        // page scroll.
        let summaries = 0;
        for (const [path, want] of [
          [rig.settings, uiString("es", "divset.camera.required")],
          [inherit.settings, uiString("es", "divset.camera.inheritSummary", { policy: uiString("es", "divset.camera.off") })],
        ] as const) {
          await gotoSettings(page, path);
          const toggle = cameraToggle(page, "es");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          const summary = toggle.locator("span.truncate");
          await expect(summary).toHaveText(want);
          const fit = await summary.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right }));
          expect(fit.scroll, `es-320 summary "${want}" is cut off: ${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.client);
          expect(fit.right).toBeLessThanOrEqual(320);
          await expectNoHorizontalScroll(page);
          summaries++;
        }
        expect(summaries).toBe(2);
      }
      localesChecked++;
    }
    expect(localesChecked, "anti-vacuity: all four locales").toBe(4);
    expect(widthsChecked, "anti-vacuity: three widths in es and fr").toBe(6);
    expect(errors).toEqual([]);
  });
});
