import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAG, apiJson, activeOrg, expectNoHorizontalScroll, linkPersonToUserBySql, withDb } from "./helpers";
import { seedOnlineRound, seedUser } from "./match-room-kit";
import { closeOpenContexts } from "./spectator-public-helpers";
import { openDivisionRules, saveFormat, savePoints } from "./helpers/rules-strip";
import { dictString, publicJson, spectator, uiString, type W2Locale } from "./spectator-w2-kit";

// v8 acceptance (spec 2026-07-13): the division Settings tab collects
// general/format/sharing/danger; the stage STRUCTURE locks once fixtures exist
// (UI note + PUT 409 FORMAT_LOCKED) while the match RULES lock per field once a
// stage that plays by them has STARTED (W2c Task 20: UI lock line + PATCH 409
// DIVISION_FORMAT_LOCKED naming the field); cards wear their identity — sport
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

test("settings tab: sections render, rename works, structure locks with fixtures, rules lock once a stage has started", async ({
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

  // Match Day C2: the match rules left Settings for the Division rules strip on the Fixtures tab; Settings says where.
  await expect(page.getByTestId("division-rules-moved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save match rules" }), "no rules Save left in Settings").toHaveCount(0);
  // The points still apply independently of the structure - from the strip's Points panel.
  const renamedBase = page.url().split("?")[0]!;
  const rules = await openDivisionRules(page, renamedBase, "points");
  await rules.getByTestId("division-rules-panel-points").getByRole("spinbutton", { name: "Win", exact: true }).fill("5");
  await savePoints(rules).click();
  await expect(rules.getByTestId("division-rules-saved")).toHaveText(uiString("en", "divset.notice.rulesSaved"), { timeout: 15_000 });
  // generic stores its points as w/d/l (the seed's own shape).
  const pointsNow = await apiJson<{ config: { points?: { w?: number } } }>(request, `/api/v1/divisions/${rig.divisionId}`);
  expect(pointsNow.data!.config.points?.w, "the typed win landed").toBe(5);

  // The strays moved: no embed snippet / danger zone under other tabs.
  await page.goto(`${base}?tab=entrants`);
  await expect(page.getByTestId("division-settings")).toHaveCount(0);
  await expect(page.getByText("Danger zone")).toHaveCount(0);

  // Generate fixtures on the new structure. W2c Task 20 (S4): that locks the STRUCTURE (replaceStages refuses on any fixture
  // row) and nothing else - the match rules lock per field and per STARTED stage that inherits them, so until a match is
  // started they stay editable. (This test used to pin "fixtures exist => PATCH 409 FORMAT_LOCKED".)
  await apiJson(
    request,
    `/api/v1/divisions/${rig.divisionId}/entrants`,
    "POST",
    ["Alpha", "Bravo", "Cara", "Drew"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stagesNow = await apiJson<{ id: string; name: string }[]>(request, `/api/v1/divisions/${rig.divisionId}/stages`);
  const firstStage = stagesNow.data![0]!;
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${firstStage.id}/generate`, "POST");
  expect(gen.data!.fixtures.length, "premise: the first stage has fixtures").toBeGreaterThan(0);

  // Renames regenerate the slug - resolve the current one before navigating.
  const fresh = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${rig.divisionId}`);
  const divisionUrl = `/o/${org.slug}/c/${rig.compSlug}/d/${fresh.data!.slug}`;
  const settingsUrl = `${divisionUrl}?tab=settings`;
  const lockLines = page.locator('[data-testid^="division-locked-"]');
  await page.goto(settingsUrl);
  await page.getByRole("button", { name: /Format/ }).click();
  // The structure is locked and says so; the structure controls are gone.
  await expect(page.getByTestId("format-locked")).toBeVisible();
  await expect(page.getByTestId("format-locked")).toContainText(uiString("en", "divset.lockedNotePre").split("(")[0]!.trim());
  await expect(page.getByTestId("format-template")).toHaveCount(0);
  // Fixtures exist but no stage has started: the RULES are open (on the strip) - no lock line, the variant is editable...
  const strip = await openDivisionRules(page, divisionUrl, "format", "points");
  await expect(lockLines, "no stage has started: nothing is locked").toHaveCount(0);
  const variant = strip.getByRole("combobox", { name: new RegExp(`^${uiString("en", "divset.variant")}`) });
  await expect(variant).toBeEnabled();
  // ...and a DIFFERENT variant saves (a no-op re-send of the stored one would pass on a lock that refuses nothing).
  await variant.selectOption("win_loss");
  await saveFormat(strip).click();
  await expect(strip.getByTestId("division-rules-saved")).toHaveText(uiString("en", "divset.notice.rulesSaved"));
  const afterSave = await apiJson<{ variant_key: string }>(request, `/api/v1/divisions/${rig.divisionId}`);
  expect(afterSave.data!.variant_key, "the new variant landed").toBe("win_loss");

  // The structure door is shut for good.
  const swap = await page.request.put(`/api/v1/divisions/${rig.divisionId}/stages`, {
    data: [{ seq: 1, kind: "league", name: "L", config: {}, progression: null }],
  });
  expect(swap.status()).toBe(409);
  expect(((await swap.json()) as { error?: { code?: string } }).error?.code).toBe("FORMAT_LOCKED");

  // Start the division, then a match: the stage that plays it now holds the rules. The page says so BEFORE anyone types...
  const divStarted = await apiJson(request, `/api/v1/divisions/${rig.divisionId}/start`, "POST");
  expect(divStarted.status, JSON.stringify(divStarted.error)).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  // The started stage plays the variant and every rule field, so the Match format section reads (C2 fix round 1, I1): ONE
  // line naming the stage, no variant picker, no field and no Save.
  const lockedStrip = await openDivisionRules(page, divisionUrl, "format");
  const formatPanel = lockedStrip.getByTestId("division-rules-panel-format");
  const formatLine = formatPanel.getByTestId("division-locked-format");
  await expect(formatLine).toBeVisible();
  await expect(formatLine).toContainText(uiString("en", "ruleLock.DIVISION_FORMAT_LOCKED", { stage: firstStage.name }));
  await expect(formatPanel.locator('[data-testid^="division-locked-"]'), "one line for the section").toHaveCount(1);
  await expect(formatPanel.getByRole("combobox"), "no variant picker, no rule field").toHaveCount(0);
  await expect(formatPanel.getByTestId("division-rules-format-save"), "no Save").toHaveCount(0);
  // ...and the server agrees: the same variant change that landed above is now refused, naming the field.
  const refused = await page.request.patch(`/api/v1/divisions/${rig.divisionId}`, { data: { variant_key: "score" } });
  expect(refused.status()).toBe(409);
  const refusedBody = (await refused.json()) as { error?: { code?: string; refused?: { field: string; stageName: string }[] } };
  expect(refusedBody.error?.code).toBe("DIVISION_FORMAT_LOCKED");
  // The variant is refused first, and so is every key the other variant's preset would have changed with it (the points here):
  // nothing of a refused variant may land. Each names the stage that holds it.
  const refusedList = refusedBody.error?.refused ?? [];
  expect(refusedList[0]?.field, "the variant heads the list").toBe("variant_key");
  expect(refusedList.map((r) => r.stageName), "every refused field names the started stage").toEqual(refusedList.map(() => firstStage.name));
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
  // A click that lands before hydration does nothing: retry click + check until the group reports itself open. Each attempt
  // clicks only a group that is still closed, so a click that DID land is never undone by the retry.
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
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
    await expect(page.getByTestId("division-camera-needs-online")).toContainText(uiString("en", "divset.camera.needsOnlinePlay"));

    // ...and the hint says where online play is set now: a link to the Fixtures tab's Division rules (C2 fix round 1, M3).
    await expect(page.getByTestId("division-camera-needs-online")).toContainText(uiString("en", "divset.camera.needsOnlinePlay"));
    const onlineLink = page.getByTestId("division-camera-online-link");
    await expect(onlineLink).toHaveText(uiString("en", "divset.rulesMovedLink"));

    // Online play moved with the match rules to the Division rules strip (Match Day C2). An unsaved choice there does not
    // unlock the camera: the camera follows the SAVED value (C2 fix round 1, M2 - asserted, not just said).
    const divisionUrl = rig.settings.split("?")[0]!;
    await onlineLink.click();
    await expect(page, "the link lands on the Fixtures tab").toHaveURL(/[?&]tab=fixtures\b/);
    const unsaved = await openDivisionRules(page, divisionUrl, "format");
    await unsaved.getByTestId("division-online-play").selectOption("lichess");
    await expect(unsaved.getByTestId("division-online-play"), "premise: chosen, not saved").toHaveValue("lichess");
    await gotoSettings(page, rig.settings);
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy"), "an unsaved choice does not unlock the camera").toBeDisabled();
    await expect(page.getByTestId("division-camera-needs-online")).toBeVisible();
    expect((await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${rig.divisionId}`)).data!.config.onlinePlay, "nothing stored").toBeUndefined();

    const strip = await openDivisionRules(page, divisionUrl, "format");
    await expect(strip.getByTestId("division-online-play"), "the strip reads what is stored").toHaveValue("off");
    await strip.getByTestId("division-online-play").selectOption("lichess");
    // Saving the rules turns it on — and (M-6) the refreshed config re-syncs the strip without crashing the tab.
    await saveFormat(strip).click();
    await expect(strip.getByTestId("division-rules-saved")).toHaveText(uiString("en", "divset.notice.rulesSaved"), { timeout: 15_000 });
    await expect(strip.getByTestId("division-online-play"), "M-6: re-synced to the saved value").toHaveValue("lichess");
    await expect(page.getByTestId("division-rules-strip"), "M-6: the tab still renders after a rules save").toBeVisible();
    await gotoSettings(page, rig.settings);
    await openCameraGroup(page);
    await expect(page.getByTestId("division-camera-policy")).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId("division-camera-needs-online")).toHaveCount(0);
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
    // The Division rules strip's Match format panel (Match Day C2: the clock moved there from Settings), then the clock fields.
    // The fields' names are drawn from the dictionary in every locale (W2e PR B localized ALL rule-field labels, not only the
    // five ruling-157 ones), so each is looked up through the key the product renders (`RuleField.labelKey`) rather than typed
    // in English - an English literal here is a name that only the `en` page has.
    const strip = await openDivisionRules(page, rig.settings.split("?")[0]!, "format");
    await expect(strip.getByTestId("division-rules-toggle-format")).toHaveText(uiString("fr", "rulesStrip.format"));
    // Online play is still Off, so the free clock fields are there: type a 1+0 the server will refuse. THEN turn
    // Lichess on — the picker takes the fields' place, finds none of the supported controls in the typed clock, and
    // says so (item 2, 2026-10-19: with Lichess the clock is a picker, not three free inputs).
    await page.getByRole("spinbutton", { name: uiString("fr", "rules.field.clockBaseMinutes.label") }).fill("1");
    await page.getByRole("spinbutton", { name: uiString("fr", "rules.field.clockIncrementSeconds.label") }).fill("0");
    await page.getByTestId("division-online-play").selectOption("lichess");
    await expect(page.getByTestId("division-time-control"), "a typed 1+0 is none of the supported controls").toHaveValue("");
    await expect(page.getByText(uiString("fr", "divset.timeControl.unsupported"))).toBeVisible();
    await saveFormat(strip).click();
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
    const divisionUrl = rig.settings.split("?")[0]!;
    const strip = await openDivisionRules(page, divisionUrl, "format");
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
    await saveFormat(strip).click();
    await expect(strip.getByTestId("division-rules-saved")).toBeVisible({ timeout: 15_000 });
    const stored = await apiJson<{ config: { onlinePlay?: string; variant?: string; clock?: unknown } }>(
      request,
      `/api/v1/divisions/${rig.divisionId}`,
    );
    expect(stored.data?.config.clock).toEqual({ base: 300, increment: 3 });
    expect(stored.data?.config.variant).toBe("blitz");
    expect(stored.data?.config.onlinePlay).toBe("lichess");

    // Reopen: the saved control is the one selected.
    const reopened = await openDivisionRules(page, divisionUrl, "format");
    await expect(reopened.getByTestId("division-time-control")).toHaveValue("5+3");
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

  // Owner ruling 2026-10-25 ("apply rec"): switching a chess division to online play while players cannot be paired online
  // WARNS, naming them, and never blocks - clubs switch first and collect links later. Fix rounds 1 and 2 (controller): "cannot
  // be paired" is the seat gate's word, so the warning has THREE sentences - players with no Lichess link, players whose link
  // must be reconnected (identity-only, so the seat says lichess_reconsent_required), and entrants with nobody on them (which
  // nobody can claim a seat for). Driven end to end: real entrants, the real Settings tab, the real save. The drop-off when a
  // player links is a database fact (lichess-link-gaps.test.ts): there is no Lichess to link to here.
  test("online play with players who cannot be paired: nobody short is silent; choosing Lichess warns in three sentences and names them, an unbroken name stays inside the box; the save still lands; the warning stays after it and after a reload, in all four languages, at 320/768/1280; each sentence stands alone", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const errors = pageErrors(page);
    const rig = await seedChessDivision(request, page, { online: false });
    const warning = page.getByTestId("division-online-unlinked");
    const reconnect = page.getByTestId("division-online-reconnect");
    const empty = page.getByTestId("division-online-empty");
    const gaps = page.getByTestId("division-online-link-gaps");
    // Online play and its warning moved with the match rules to the Division rules strip on the Fixtures tab (Match Day C2).
    const divisionUrl = rig.settings.split("?")[0]!;
    const openFormat = () => openDivisionRules(page, divisionUrl, "format");

    // Empty case first: a roster of nobody has nobody to warn about.
    await openFormat();
    await page.getByTestId("division-online-play").selectOption("lichess");
    await expect(warning, "no entrants: nothing to warn about").toHaveCount(0);
    await expect(reconnect, "no entrants: nothing to reconnect").toHaveCount(0);
    await expect(empty, "no entrants: no empty entrant").toHaveCount(0);
    await expect(gaps, "no entrants: no box at all").toHaveCount(0);

    // One of each gap (the division is still Off, so no link is demanded of the roster): Ann, Ben and one more are people with
    // no Lichess account - the last named by 72 unbroken characters, the case the box must hold at 320; Cat has a Seazn account
    // whose Lichess link is identity-only (no token, no consent); and an entrant with no member at all.
    const LONG = "W".repeat(72);
    const cat = await seedUser("Cat Reconnect");
    const catPerson = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: "Cat Reconnect", consent: { public_name: true } });
    expect(catPerson.status, JSON.stringify(catPerson.error)).toBeLessThan(300);
    await linkPersonToUserBySql(catPerson.data!.id, cat.userId);
    const catLichessId = `e2e-gap-${TAG}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
    await withDb(async (sql) => {
      await sql`
        insert into user_external_accounts (user_id, provider, external_user_id, username, scopes)
        values (${cat.userId}, 'lichess', ${catLichessId}, ${catLichessId}, '{}'::text[])`;
    });
    const added = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${rig.divisionId}/entrants`, "POST", [
      ...["Ann Unlinked", "Ben Unlinked", LONG].map((n) => ({
        kind: "individual",
        display_name: n,
        members: [{ new_person: { full_name: n }, is_captain: false, roles: [] }],
      })),
      { kind: "individual", display_name: "Cat Reconnect", members: [{ person_id: catPerson.data!.id, is_captain: false, roles: [] }] },
      { kind: "individual", display_name: "Board 3 (nobody yet)", members: [] },
    ]);
    expect(added.status, JSON.stringify(added.error)).toBeLessThan(300);
    expect(added.data, "anti-vacuity: five entrants were created").toHaveLength(5);

    const listIn = (locale: W2Locale, items: string[]) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
    // Alphabetical without regard to case. The empty entrant is named by its own name, in its own sentence - it is not a player.
    const sentence = (locale: W2Locale) =>
      uiString(locale, "divset.onlinePlay.unlinked.other", { count: 3, names: listIn(locale, ["Ann Unlinked", "Ben Unlinked", LONG]) });
    const reconnectSentence = (locale: W2Locale) =>
      uiString(locale, "divset.onlinePlay.reconnect.one", { count: 1, names: "Cat Reconnect" });
    const emptySentence = (locale: W2Locale) =>
      uiString(locale, "divset.onlinePlay.empty.one", { count: 1, names: "Board 3 (nobody yet)" });

    // The box holds its sentences: measured, not assumed. `break-words` alone let a 72-character token push a sentence to 593px
    // inside a 244px box without the PAGE ever scrolling sideways, so the page-level check cannot see it. Each sentence must end
    // inside the box, neither the sentence nor the box may scroll horizontally, and the box must end inside the viewport.
    const expectHeld = async (where: string, width: number) => {
      const box = await gaps.evaluate((el) => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth }));
      expect(box.scroll, `${where}: the box does not scroll sideways`).toBeLessThanOrEqual(box.client);
      expect(box.right, `${where}: the box fits a ${width}px viewport`).toBeLessThanOrEqual(width);
      let held = 0;
      for (const el of [warning, reconnect, empty]) {
        if ((await el.count()) === 0) continue;
        const m = await el.evaluate((p) => ({
          id: p.getAttribute("data-testid"),
          right: p.getBoundingClientRect().right,
          boxRight: p.parentElement!.getBoundingClientRect().right,
          scroll: p.scrollWidth,
          client: p.clientWidth,
        }));
        expect(m.right, `${where}: ${m.id} ends inside the box (${JSON.stringify(m)})`).toBeLessThanOrEqual(m.boxRight + 0.5);
        expect(m.scroll, `${where}: ${m.id} does not scroll sideways`).toBeLessThanOrEqual(m.client);
        held++;
      }
      expect(held, `${where}: anti-vacuity: at least one sentence was measured`).toBeGreaterThan(0);
    };

    // The switch moment: Off is silent, Lichess warns - before anything is saved - and nothing is disabled.
    await openFormat();
    await page.getByTestId("division-online-play").selectOption("off");
    await expect(gaps).toHaveCount(0);
    await page.getByTestId("division-online-play").selectOption("lichess");
    await expect(warning).toBeVisible();
    await expect(warning).toHaveText(sentence("en"));
    await expect(reconnect, "the reconnect player is a sentence of their own").toBeVisible();
    await expect(reconnect).toHaveText(reconnectSentence("en"));
    await expect(empty, "the empty entrant is a sentence of its own").toBeVisible();
    await expect(empty).toHaveText(emptySentence("en"));
    await expect(warning, "Cat is not in the no-link sentence").not.toContainText("Cat Reconnect");
    await expect(warning, "the empty entrant is not counted among the players with no link").not.toContainText("Board 3");
    await expect(gaps).toHaveAttribute("role", "status");
    const stillOff = await apiJson<{ config: { onlinePlay?: string } }>(request, `/api/v1/divisions/${rig.divisionId}`);
    expect(stillOff.data?.config.onlinePlay, "choosing it saved nothing").toBeUndefined();
    await expect(page.getByTestId("division-online-play")).toBeEnabled();
    const save = page.getByTestId("division-rules-format-save");
    await expect(save, "the warning does not block the save").toBeEnabled();

    // The save lands - 200, stored - and all three sentences are still there on the refreshed page.
    await save.click();
    await expect(page.getByTestId("division-rules-saved")).toBeVisible({ timeout: 15_000 });
    const stored = await apiJson<{ config: { onlinePlay?: string } }>(request, `/api/v1/divisions/${rig.divisionId}`);
    expect(stored.data?.config.onlinePlay, "the switch was saved with three unlinked, one to reconnect and one empty").toBe("lichess");
    await expect(warning, "still warned after the save").toHaveText(sentence("en"));
    await expect(reconnect, "still told to reconnect after the save").toHaveText(reconnectSentence("en"));
    await expect(empty, "still told about the empty entrant after the save").toHaveText(emptySentence("en"));

    // After a reload, in every language, at every width: the saved division keeps all three sentences, the unbroken name stays
    // inside the box, and the page never scrolls sideways.
    let checked = 0;
    for (const locale of LOCALES) {
      await setLocaleCookie(page, locale);
      for (const width of [1280, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await openFormat();
        await expect(warning, `${locale} ${width}`).toBeVisible();
        await expect(warning, `${locale} ${width}`).toHaveText(sentence(locale));
        await expect(reconnect, `${locale} ${width}`).toBeVisible();
        await expect(reconnect, `${locale} ${width}`).toHaveText(reconnectSentence(locale));
        await expect(empty, `${locale} ${width}`).toBeVisible();
        await expect(empty, `${locale} ${width}`).toHaveText(emptySentence(locale));
        await expectNoHorizontalScroll(page);
        await expectHeld(`${locale} ${width}`, width);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: four languages at three widths").toBe(12);

    // Each sentence stands alone. Withdraw the three with no link (a departed entrant is owed nothing): the reconnect and the
    // empty-entrant sentences are left. Withdraw the empty entrant: only the reconnect sentence. Withdraw Cat too: nothing is
    // left, and the box goes with it.
    await setLocaleCookie(page, "en");
    await page.setViewportSize({ width: 1280, height: 900 });
    const withdraw = async (name: string) => {
      const e = added.data!.find((x) => x.display_name === name)!;
      const res = await apiJson(request, `/api/v1/entrants/${e.id}`, "PATCH", { status: "withdrawn" });
      expect(res.status, `withdraw ${name}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    };
    for (const name of ["Ann Unlinked", "Ben Unlinked", LONG]) await withdraw(name);
    await openFormat();
    await expect(warning, "nobody is unlinked now: that sentence is gone").toHaveCount(0);
    await expect(reconnect, "Cat is still to reconnect").toHaveText(reconnectSentence("en"));
    await expect(empty, "the empty entrant is still empty").toHaveText(emptySentence("en"));
    await withdraw("Board 3 (nobody yet)");
    await openFormat();
    await expect(empty, "the empty entrant left the field: its sentence is gone").toHaveCount(0);
    await expect(reconnect, "only Cat is left to reconnect").toHaveText(reconnectSentence("en"));
    await expect(gaps).toBeVisible();
    await withdraw("Cat Reconnect");
    await openFormat();
    await expect(page.getByTestId("division-online-play"), "premise: the Online play control is still there").toBeVisible();
    await expect(gaps, "nobody left: no box").toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
