// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): stage / division rules panels: the Swiss pairing split button and the W2c-W2d format, points, tie-break, match-rules and lock-line panels.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  TAG,
  apiJson,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  fixturePath,
  overflowingIn,
  enclosingStageCard,
  openStagePanel,
  stageCardOf,
} from "../helpers";
import { builtinModules } from "@seazn/engine/sports";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { expectStageToolsSheet } from "../helpers/stage-tools-sheet";
import { moduleOf, summaryFormatText } from "../helpers/stage-summary";
import { RULEBOOK_SPLITS } from "../../src/components/v2/stage-rules/__tests__/_points-split-rulebook";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { openPanels } from "../helpers/rules-strip";
import { withDb } from "../rs007-money-kit";
import { openConsolePanel } from "../helpers/console-panels";
import { assertTapFloor } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI — option
// A, split button"): Pair next grows a ▾ toggle whenever a Swiss stage has a
// round waiting, and the toggle opens an inline radiogroup. Every width
// project owes the same three things of it (spec, "Tests" — the width matrix
// covers the new control): the 44px floor on the toggle and on each option,
// no horizontal page scroll with the menu open, axe clean.
//
// Plus one behaviour no unit test can reach, because vitest has no DOM:
// Escape inside the menu closes the MENU, not the phone sheet around it. It
// used to close both — the App Router hydrates React onto `document`, the same
// node the sheet listens on, so `stopPropagation` in the menu's handler never
// kept the key from the sheet — and focus went back to the "Stage tools"
// trigger instead of the toggle. Below `md` that is the check that fails.
test("swiss pairing split button: the toggle and the round-1 options hold the 44px floor, axe-clean, no horizontal scroll; Escape closes only the menu", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Swiss pairing ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Swiss pairing",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const swissDivisionId = div.data!.id;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${swissDivisionId}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3, pairing: "rank_adjacent" },
  });
  expect(stage.status, "swiss stage create").toBe(201);
  // Ten seeded 1..10 — the prod field that motivated the feature, and a size
  // whose fold hint (1v6…) differs from the neighbours hint (1v2…).
  await addEntrantsViaApi(
    request,
    swissDivisionId,
    Array.from({ length: 10 }, (_, i) => `Swiss M${i + 1}`),
  );
  const started = await apiJson(request, `/api/v1/divisions/${swissDivisionId}/start`, "POST");
  expect(started.status, "start mints the swiss shells").toBe(200);

  await page.goto(await divisionPath(request, swissDivisionId, "?tab=fixtures"), { waitUntil: "load" });

  // Below `md` the rail folds into the "Stage tools" sheet (AGENTS rule 22):
  // OPEN it, gated on the trigger being visible — never on a width literal.
  const railTrigger = page.getByTestId("stage-rail-trigger");
  const folded = await railTrigger.isVisible();
  if (folded) await railTrigger.click();
  const railScope = page.getByTestId(folded ? "stage-rail-sheet" : "stage-rail");

  const toggle = page.getByTestId("stage-pairing-toggle");
  await expect(page.getByTestId("stage-generate")).toHaveText("Pair next round");
  await assertTapFloor(toggle, "pairing toggle");
  // The toggle is a glyph with no text to widen it — the floor is both axes.
  expect((await toggle.boundingBox())!.width, "pairing toggle width").toBeGreaterThanOrEqual(44);

  await toggle.click();
  const menu = page.getByTestId("stage-pairing-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("role", "radiogroup");
  const fold = page.getByTestId("stage-pairing-fold");
  const adjacent = page.getByTestId("stage-pairing-rank_adjacent");
  await expect(fold).toHaveAttribute("aria-checked", "true");
  await expect(fold).toContainText("1v6, 2v7, 3v8…");
  await assertTapFloor(fold, "pairing option: top vs bottom");
  await assertTapFloor(adjacent, "pairing option: neighbours");
  await expectNoHorizontalScroll(page);

  const axe = await new AxeBuilder({ page })
    .include(folded ? '[data-testid="stage-rail-sheet"]' : '[data-testid="stage-rail"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    "axe serious/critical on the rail with the pairing menu open",
  ).toEqual([]);

  // Keyboard: arrows move AND select; Escape closes the menu and hands focus
  // back to the toggle — and, below `md`, leaves the sheet open.
  await fold.focus();
  await page.keyboard.press("ArrowDown");
  await expect(adjacent).toHaveAttribute("aria-checked", "true");
  await expect(adjacent).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(railScope, "Escape in the pairing menu closed the rail around it").toBeVisible();
  await expect(toggle).toBeFocused();
});

// W2c Task 17 (S1): the stage rules row at every width. One DOM, branched with `max-md:*` - never a second phone tree - so
// the evidence is: the row and its editor fit (no page scroll, nothing clipped), every control holds the 44px floor and is
// hit-testable (`elementFromPoint`, not paint), the deciders notice shows at this width, and the control SET (membership,
// order, repeats) is the one 1280 shows. Football carries the sections, the notice and the selects; chess carries the
// ordered-list control, which has the most buttons per row of anything in the product's rules editors.
test("W2c stage format row at every width: sections, the deciders notice and the tie-break list hold the 44px floor, no scroll, the control set matches 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = async (sport: string, variant: string, label: string): Promise<{ divisionId: string; stageId: string }> => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `W2c T17 ${label} ${TAG}-${testInfo.project.name}`,
      visibility: "private",
    });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: `${label} division`,
      sport_key: sport,
      variant_key: variant,
    });
    expect(div.status, `division ${sport}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Knockout",
    });
    expect(stage.status, `stage ${sport}: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
    return { divisionId: div.data!.id, stageId: stage.data!.id };
  };
  const projectWidth = page.viewportSize()!.width;
  const shots = process.env.T17_SHOTS_DIR;
  const editorControls = (row: Locator) =>
    row
      .getByTestId("stage-format-editor")
      .locator('[data-testid^="stage-rule-field-"], [data-testid^="stage-rule-sequence-"], [data-testid="stage-format-save"], [data-testid="stage-format-cancel"], [data-testid="stage-deciders-off"], [data-testid="stage-deciders-level"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

  // --- football: the sections, the selects, the notice -------------------------------------------------------------
  const fb = await seed("football", "11-a-side", "football");
  await page.goto(await divisionPath(page.request, fb.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const row = page.getByTestId(`stage-format-row-${fb.stageId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Match Day C3: closed, the card is a one-line summary under a header of three buttons; below `md` an editor's header buttons are
  // hidden and the same three are the TOP rows of the card's one "Stage tools" sheet (review round 1). Gate the open on the TRIGGER
  // being visible, never on a width literal (AGENTS.md rule 22); the hidden twin is waited on with `toBeAttached`.
  const card = enclosingStageCard(row);
  const railTrigger = card.getByTestId("stage-rail-trigger");
  const sheetFormat = card.getByTestId("stage-sheet-tool-format");
  const folded = await railTrigger.isVisible();
  await expect(card.getByTestId("stage-settings-trigger"), "the retired second phone trigger is gone").toHaveCount(0);
  // A knockout stage has no table to rank: of the settings buttons it carries Match rules (Points and Tie-breaks are table stages'
  // buttons) - present once in the header and once as a sheet row (one DOM); the other two are absent, not hidden. (It carries the
  // Bracket button too - a toggle once its fixtures exist, greyed before - which is the stage-card-bracket-button spec's, not this one's.)
  await expect(card.getByTestId("stage-tool-format")).toBeAttached();
  await expect(sheetFormat).toBeAttached();
  for (const id of ["points", "tiebreaks"]) {
    await expect(card.getByTestId(`stage-tool-${id}`), `a bracket has no ${id} button`).toHaveCount(0);
    await expect(card.getByTestId(`stage-sheet-tool-${id}`), `a bracket has no ${id} row`).toHaveCount(0);
  }
  if (folded) {
    await assertTapFloor(railTrigger, "Stage tools");
    await expect(card.getByTestId("stage-tool-format"), "below md the header button is hidden").toBeHidden();
    await railTrigger.click();
    await expect(railTrigger).toHaveAttribute("aria-expanded", "true");
    await assertTapFloor(sheetFormat, "Match rules row in the Stage tools sheet");
    // The open sheet is a modal dialog over the trigger: Escape puts it away (a second click would land on the sheet).
    await page.keyboard.press("Escape");
    await expect(railTrigger).toHaveAttribute("aria-expanded", "false");
  } else {
    await assertTapFloor(card.getByTestId("stage-tool-format"), "stage-tool-format");
    await expect(sheetFormat, "the sheet's row is the phone's twin: not shown here").toBeHidden();
  }
  await expectNoHorizontalScroll(page);
  // The collapsed row says the stage's format in ONE line (Match Day C3: the chips became the summary), it wraps inside the row, and
  // nothing is clipped. Its words are the declared copy (review m6): the public line's clauses for the cfg this stage plays under -
  // the division's, with the engine's own knockout preset laid over it.
  const summary = row.getByTestId("stage-format-summary");
  await expect(summary, `the summary is on the collapsed row at ${projectWidth}`).toBeVisible();
  const football = moduleOf("football");
  const divisionRead = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${fb.divisionId}`);
  expect(divisionRead.status, "GET division").toBe(200);
  const playedCfg = football.configSchema.parse({ ...divisionRead.data!.config, ...stageDefaultsFor(football, "knockout", null) });
  await expect(summary, `the summary says the knockout's format at ${projectWidth}`).toHaveText(summaryFormatText("football", "knockout", playedCfg));
  const collapsedClip = await overflowingIn(page, `[data-testid="stage-format-row-${fb.stageId}"]`, "*", "the stage rules row is missing");
  expect(collapsedClip.clipped, `nothing in the collapsed row is clipped at ${projectWidth}`).toEqual([]);
  if (shots) await row.screenshot({ path: `${shots}/collapsed-${projectWidth}.png` });
  await openStagePanel(card, "format");
  const editor = row.getByTestId("stage-format-editor");
  await expect(editor).toBeVisible();
  // M-3: while editing, Cancel is the one way out and the Match rules button reads as pressed.
  await expect(card.getByTestId("stage-tool-format")).toHaveAttribute("aria-expanded", "true");
  await assertTapFloor(row.getByTestId("stage-format-cancel"), "football Cancel");
  const interactive = editor.locator("select, input, button");
  const n = await interactive.count();
  expect(n, "the editor has controls to measure").toBeGreaterThan(4);
  for (let i = 0; i < n; i++) await assertTapFloor(interactive.nth(i), `football editor control ${i}`);
  // Both deciders off: the notice shows, inside the row, at this width.
  await row.getByTestId("stage-rule-field-extraTime").locator("select").selectOption("off");
  await row.getByTestId("stage-rule-field-shootout").locator("select").selectOption("off");
  const notice = row.getByTestId("stage-deciders-off");
  await expect(notice).toBeVisible();
  // M-4: the kicks are held with the reason beside them, and the caption fits at this width.
  await expect(row.getByTestId("stage-rule-field-shootoutAttempts").locator("input")).toBeDisabled();
  await expect(row.getByTestId("stage-rule-detail-off-shootoutAttempts")).toBeVisible();
  const clip = await overflowingIn(page, `[data-testid="stage-format-row-${fb.stageId}"]`, "*", "the stage rules row is missing");
  expect(clip.clipped, `nothing in the row is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  if (shots) {
    await editor.scrollIntoViewIfNeeded();
    await row.screenshot({ path: `${shots}/expanded-${projectWidth}.png` });
    await notice.screenshot({ path: `${shots}/deciders-off-${projectWidth}.png` });
  }
  const here = await editorControls(row);
  expect(here.length, "the editor's controls were read").toBeGreaterThan(4);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(here, `the football editor's control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await editorControls(row));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- chess: the ordered list -------------------------------------------------------------------------------------
  const chess = await seed("boardgame", "blitz", "chess");
  await page.goto(await divisionPath(page.request, chess.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  const crow = page.getByTestId(`stage-format-row-${chess.stageId}`);
  await expect(crow).toBeVisible({ timeout: 20_000 });
  await openStagePanel(enclosingStageCard(crow), "format");
  const list = crow.getByTestId("stage-rule-sequence-tiebreakRungs");
  await expect(list).toBeVisible();
  const items = list.locator("li");
  const rungs = await items.count();
  expect(rungs, "the default list has every rung").toBe(3);
  for (let i = 0; i < rungs; i++) {
    const buttons = items.nth(i).locator("button");
    const b = await buttons.count();
    expect(b, "up, down and remove").toBe(3);
    for (let j = 0; j < b; j++) if (!(await buttons.nth(j).isDisabled())) await assertTapFloor(buttons.nth(j), `chess rung ${i} button ${j}`);
  }
  // Empty it: the add menu and the reset hold the floor too, and the empty line fits.
  for (let i = 0; i < rungs; i++) await items.first().locator("button").last().click();
  await expect(crow.getByTestId("stage-rule-sequence-tiebreakRungs-empty")).toBeVisible();
  await assertTapFloor(crow.getByTestId("stage-rule-sequence-tiebreakRungs-add"), "chess add rung");
  await assertTapFloor(crow.getByTestId("stage-rule-sequence-tiebreakRungs-reset"), "chess use default order");
  await assertTapFloor(crow.getByTestId("stage-format-save"), "chess Save rules");
  const cclip = await overflowingIn(page, `[data-testid="stage-format-row-${chess.stageId}"]`, "*", "the chess rules row is missing");
  expect(cclip.clipped, `nothing in the chess row is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  if (shots) await crow.screenshot({ path: `${shots}/chess-sequence-${projectWidth}.png` });
  const chessHere = await editorControls(crow);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(chessHere, `the chess editor's control set at ${projectWidth} vs 1280`).toEqual(await editorControls(crow));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- the DIVISION door: the same ordered list on the division's rules strip (review I-2; Match Day C2 moved it out of
  // Settings into the Fixtures tab's Division rules strip), phone-first too ----------------------------------------------
  const dcomp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T17 division-seq ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(dcomp.status, `competition: ${JSON.stringify(dcomp.error)}`).toBeLessThan(300);
  const ddiv = await apiJson<{ id: string }>(request, `/api/v1/competitions/${dcomp.data!.id}/divisions`, "POST", {
    name: "division sequence",
    sport_key: "boardgame",
    variant_key: "blitz",
    config: { tiebreakRungs: ["rapid", "blitz"] },
  });
  expect(ddiv.status, `division: ${JSON.stringify(ddiv.error)}`).toBeLessThan(300);
  await page.goto(await divisionPath(page.request, ddiv.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  const dstrip = page.getByTestId("division-rules-strip");
  await expect(dstrip).toBeVisible({ timeout: 20_000 });
  await openPanels(dstrip, "format");
  const dlist = dstrip.getByTestId("stage-rule-sequence-tiebreakRungs");
  await expect(dlist).toBeVisible({ timeout: 20_000 });
  const ditems = dlist.locator("li");
  expect(await ditems.count(), "the division's stored list, two rungs").toBe(2);
  for (let i = 0; i < 2; i++) {
    const buttons = ditems.nth(i).locator("button");
    for (let j = 0; j < (await buttons.count()); j++) if (!(await buttons.nth(j).isDisabled())) await assertTapFloor(buttons.nth(j), `division rung ${i} button ${j}`);
  }
  await assertTapFloor(page.getByTestId("stage-rule-sequence-tiebreakRungs-reset"), "division use default order");
  await expectNoHorizontalScroll(page);
  if (shots) await dlist.screenshot({ path: `${shots}/division-sequence-${projectWidth}.png` });
});

// Match Day C3 (review round 1, phone ruling): ONE phone trigger per stage card. The Match rules / Points / Tie-breaks buttons are the
// header's from `md` up and the TOP rows of the "Stage tools" sheet below it - the same three, one DOM. The branch only a phone reaches
// (header hidden, sheet rows, Escape, choose-a-row-closes-the-sheet, a second look) runs here at every width; the shared driver is
// `helpers/stage-tools-sheet.ts` (also run at 1280 from `stage-card-c3.spec.ts`).
test("Stage tools sheet at every width: the three settings buttons are its top rows below md and the header's from md up, one trigger, 44px floor, no scroll", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `C3 tools sheet ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Singles",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  await addEntrantsViaApi(request, div.data!.id, ["Ana", "Ben", "Cy"].map((n) => `${n} ${TAG}`));
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  const gen = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const card = stageCardOf(page, stage.data!.id);
  await expect(card, "the stage card is on the Fixtures tab").toBeVisible({ timeout: 20_000 });
  const branch = await expectStageToolsSheet(page, card, stage.data!.id);
  // The width decides the branch, and the branch is the one the product's own breakpoint says: md (768) is the first width with the header.
  expect(branch, `${page.viewportSize()!.width}px takes the ${branch} branch`).toBe(page.viewportSize()!.width < 768 ? "sheet" : "header");
});

// Match Day E1 item 4 (owner 2026-11-01: the Variant label and select "look messy"): every field in the Division rules strip's panels is
// label-above and content-sized - full width below md, 20rem from md - and one line under the Variant select says what the variant
// plays. The unit test pins the classes and the words; this one reads the PAINT at every width, which is where the original defect
// lived (the label flipped from beside the select at 1280 to above it at 320).
test("Division rules strip field layout at every width: labels above their controls, selects full width below md and 20rem from md, the variant's meaning under its select, no scroll", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `E1 rules layout ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Singles",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const strip = page.getByTestId("division-rules-strip");
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await openPanels(strip, "format", "points", "tiebreaks");
  // Below md the Tie-breaks list sits behind its own phone disclosure (a `max-md:hidden` body under a toggle that is `md:hidden`): the
  // Add-a-step select is not on screen until it is opened, so open it - and prove it is the select that appeared, not a different one.
  const foldToggle = strip.getByTestId("division-rules-panel-tiebreaks").locator('[data-role="phone-disclosure-toggle"]');
  if (await foldToggle.isVisible()) {
    if ((await foldToggle.getAttribute("aria-expanded")) !== "true") await foldToggle.click();
    await expect(foldToggle).toHaveAttribute("aria-expanded", "true");
  }
  await expect(strip.getByTestId("stage-tiebreaks-add"), "the Add-a-step select is on screen at every width").toBeVisible();

  const width = page.viewportSize()!.width;
  const phone = width < 768; // md: the first width with the cap
  const REM = 16;
  const variant = strip.getByTestId("division-settings-variant");
  await expect(variant).toBeVisible();
  // Label above: the `.label` span's box ends where the select's begins - never to its left on the same line.
  const label = variant.locator("xpath=preceding-sibling::span[1]");
  await expect(label).toHaveText("Variant");
  const [lb, sb] = [(await label.boundingBox())!, (await variant.boundingBox())!];
  expect(lb.y + lb.height, "the Variant label ends above its select").toBeLessThanOrEqual(sb.y + 1);
  expect(Math.abs(lb.x - sb.x), "and starts on the select's left edge").toBeLessThan(2);
  // Width: the whole row below md; capped at 20rem from md.
  const row = (await variant.locator("xpath=ancestor::label[1]").boundingBox())!;
  if (phone) expect(Math.abs(sb.width - row.width), `${width}px: the select fills its row`).toBeLessThan(2);
  else expect(sb.width, `${width}px: the select is capped at 20rem`).toBeLessThanOrEqual(20 * REM + 1);
  expect(sb.height, "44px tap floor").toBeGreaterThanOrEqual(44);
  // What the variant plays, in words: the engine's own preset numbers (read here, never typed).
  const bwf = (builtinModules.find((m) => m.key === "badminton")!.variants as Record<string, { setTo: number; cap: number }>).bwf!;
  const meaning = strip.getByTestId("division-variant-meaning");
  await expect(meaning).toBeVisible();
  await expect(meaning).toContainText(String(bwf.setTo));
  await expect(meaning).toContainText(String(bwf.cap));
  const mb = (await meaning.boundingBox())!;
  expect(mb.y, "the line sits under the select").toBeGreaterThanOrEqual(sb.y + sb.height - 1);

  // The grid's own selects and the Add-a-step menu follow the same width rule.
  const selects = strip.locator("select");
  const count = await selects.count();
  expect(count, "anti-vacuity: the three panels draw selects").toBeGreaterThanOrEqual(3);
  let measured = 0;
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible())) continue;
    const box = (await sel.boundingBox())!;
    if (!phone) expect(box.width, `${width}px: select ${i} is capped at 20rem`).toBeLessThanOrEqual(20 * REM + 1);
    else {
      // The row's CONTENT width: the Add-a-step row is `px-2`, so its box is 16px wider than what a select can fill.
      const room = await sel.evaluate((el) => {
        const p = el.parentElement!;
        const cs = getComputedStyle(p);
        return p.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      });
      expect(Math.abs(box.width - room), `${width}px: select ${i} fills its row`).toBeLessThan(2);
    }
    measured++;
  }
  expect(measured, "every visible select measured").toBeGreaterThanOrEqual(3);
  await expectNoHorizontalScroll(page);
});

test("W2c stage points section at every width: the sentence, More, the walkover row, the bonus menu and Save hold the 44px floor, nothing clips or scrolls, the visible control set matches 1280, and the refusal card fits", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = async (sport: string, variant: string | undefined, label: string, config?: Record<string, unknown>): Promise<{ divisionId: string; stageId: string }> => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `W2c T18 ${label} ${TAG}-${testInfo.project.name}`,
      visibility: "private",
    });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: `${label} division`,
      sport_key: sport,
      ...(variant === undefined ? {} : { variant_key: variant }),
      ...(config === undefined ? {} : { config }),
    });
    expect(div.status, `division ${sport}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
    expect(stage.status, `stage ${sport}: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
    return { divisionId: div.data!.id, stageId: stage.data!.id };
  };
  const projectWidth = page.viewportSize()!.width;
  /** The section's visible controls in DOM order (the phone toggle left out: it is the one phone-only control), by testid. */
  const visibleControls = (section: Locator) =>
    section.evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((el) => el.getAttribute("data-role") !== "phone-disclosure-toggle")
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => el.getAttribute("data-testid") ?? el.tagName),
    );
  const openMoreHere = async (section: Locator): Promise<void> => {
    const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
    if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };

  // --- football: the editor ---------------------------------------------------------------------------------------------
  const footballVariant = Object.keys(builtinModules.find((m) => m.key === "football")!.variants)[0]!;
  const fb = await seed("football", footballVariant, "football", { points: { win: 4, draw: 2, loss: 1 } });
  await page.goto(await divisionPath(page.request, fb.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  // Match Day C3: the Points section opens from the card's header (a phone: from the Stage settings menu).
  await openStagePanel(stageCardOf(page, fb.stageId), "points");
  const section = page.getByTestId(`stage-points-${fb.stageId}`);
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  await assertTapFloor(section.locator("label").first(), "Use the division's points");
  await section.getByTestId("stage-points-use-division").uncheck();
  for (const id of ["stage-points-win", "stage-points-draw", "stage-points-loss"]) await assertTapFloor(section.getByTestId(id), id);
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  const phone = projectWidth < 768;
  expect(await toggle.isVisible(), `More is a phone control (${projectWidth})`).toBe(phone);
  if (phone) {
    await assertTapFloor(toggle, "More");
    await expect(section.getByTestId("stage-points-walkover-w"), "the walkover row is folded on a phone").toBeHidden();
  }
  await openMoreHere(section);
  for (const id of ["stage-points-walkover-w", "stage-points-walkover-l", "stage-points-award-w", "stage-points-award-l", "stage-points-bonus-add"]) await assertTapFloor(section.getByTestId(id), id);
  await section.getByTestId("stage-points-bonus-add").selectOption({ index: 1 });
  await expect(section.getByTestId("stage-points-bonus-0")).toBeVisible();
  await assertTapFloor(section.getByTestId("stage-points-bonus-points-0"), "bonus points");
  await assertTapFloor(section.getByTestId("stage-points-bonus-remove-0"), "remove bonus");
  await section.getByTestId("stage-points-win").fill("5");
  await assertTapFloor(section.getByTestId("stage-points-save"), "Save points");
  const clip = await overflowingIn(page, `[data-testid="stage-points-${fb.stageId}"]`, "*", "the stage points section is missing");
  expect(clip.clipped, `nothing in the points section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  const here = await visibleControls(section);
  expect(here.length, "the section's controls were read").toBeGreaterThan(8);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMoreHere(section);
  expect(here, `the points section's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(section));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- ice hockey (a division that scores overtime separately): the editor states the split (W2d T16 retired T10 fix round 1
  // I2's not-yet card). The overtime boxes hold the floor, nothing clips, the control set is 1280's. The splitting variant is
  // the rulebooks' (`_points-split-rulebook.ts`).
  const hockey = builtinModules.find((m) => m.key === "icehockey")!;
  const splitVariant = Object.keys(hockey.variants).find((v) => RULEBOOK_SPLITS[`icehockey/${v}`] !== undefined);
  expect(splitVariant, "premise: the rulebooks split an ice-hockey variant (iihf)").toBeDefined();
  const ih = await seed("icehockey", splitVariant, "icehockey");
  await page.goto(await divisionPath(page.request, ih.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await openStagePanel(stageCardOf(page, ih.stageId), "points");
  const card = page.getByTestId(`stage-points-${ih.stageId}`);
  await expect(card).toHaveAttribute("data-stage-points-state", "editor", { timeout: 20_000 });
  await expect(card.getByTestId("stage-points-row-win-ot"), "the overtime row is on the card").toBeVisible();
  await card.getByTestId("stage-points-use-division").uncheck();
  for (const id of ["stage-points-win", "stage-points-win-ot", "stage-points-loss-ot", "stage-points-loss"]) await assertTapFloor(card.getByTestId(id), `ice hockey ${id}`);
  const cclip = await overflowingIn(page, `[data-testid="stage-points-${ih.stageId}"]`, "*", "the ice hockey section is missing");
  expect(cclip.clipped, `nothing in the ice hockey section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  await openMoreHere(card); // the walkover row and bonuses are folded on a phone; 1280 shows them (class 22)
  const ihHere = await visibleControls(card);
  expect(ihHere, "the overtime boxes are among the controls read").toEqual(expect.arrayContaining(["stage-points-win-ot", "stage-points-loss-ot"]));
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(ihHere, `the ice hockey editor's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(card));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- the same division, a stage that STORES a flat rule (a row from before the guard): the editor opens at it with the
  // refusal inline; the refusal line wraps inside the card, nothing clipped, the same control set as 1280 -----------------
  await withDb(async (sql) => {
    await sql`update stages set config = config || ${sql.json({ points: { win: { regulation: 4 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } } })} where id = ${ih.stageId}`;
  });
  await page.reload({ waitUntil: "load" });
  await openStagePanel(stageCardOf(page, ih.stageId), "points");
  const legacy = page.getByTestId(`stage-points-${ih.stageId}`);
  await expect(legacy).toHaveAttribute("data-stage-points-basis", "own", { timeout: 20_000 });
  await expect(legacy.getByTestId("stage-points-refusal"), "the refusal is on the card").toBeVisible();
  await assertTapFloor(legacy.getByTestId("stage-points-use-division").locator("xpath=ancestor::label[1]"), "Use the division's points (ice hockey)");
  const lclip = await overflowingIn(page, `[data-testid="stage-points-${ih.stageId}"]`, "*", "the stored-rule section is missing");
  expect(lclip.clipped, `nothing in the stored-rule section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  await openMoreHere(legacy);
  const legacyHere = await visibleControls(legacy);
  expect(legacyHere.length, "the stored-rule editor's controls were read").toBeGreaterThan(3);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(legacyHere, `the stored-rule editor's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(legacy));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });
});

// W2d Task 15 (spec §9 "Tie-breaks"): the stage's Tie-breaks section at every width. One DOM, branched: the heading, the badge
// and the lock line stay visible, the ordered list folds behind ONE phone disclosure below md (AGENTS.md class 22: wait on
// `toBeAttached`, open the fold only where its toggle is the visible kind). The evidence: the list's controls (the arrows,
// remove, "+ Add step", Reset, Save) hold the 44px floor, nothing clips or scrolls, the visible control set (membership,
// order, repeats) is 1280's, and a started stage's lock line fits with no control left.
test("W2d stage Tie-breaks section at every width: the fold opens, the arrows, remove, add, reset and Save hold the 44px floor, nothing clips or scrolls, the control set matches 1280, and the locked state fits", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const projectWidth = page.viewportSize()!.width;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2d T15 tie-breaks ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "tie-breaks division",
    sport_key: "football",
    variant_key: "11-a-side",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, [`Asha FC ${TAG}`, `Bala FC ${TAG}`, `Chen FC ${TAG}`], "team");
  expect(added.status, "entrants").toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool A" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  const stageId = stage.data!.id;

  /** The section's visible controls in DOM order (the phone toggle left out: it is the one phone-only control), by testid. */
  const visibleControls = (root: Locator) =>
    root.evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((c) => c.getAttribute("data-role") !== "phone-disclosure-toggle")
        .filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(c).visibility !== "hidden";
        })
        .map((c) => c.getAttribute("data-testid") ?? c.tagName),
    );
  const openFold = async (root: Locator): Promise<void> => {
    const toggle = root.locator('[data-role="phone-disclosure-toggle"]');
    if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };

  await page.goto(await divisionPath(page.request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await openStagePanel(stageCardOf(page, stageId), "tiebreaks");
  const section = page.getByTestId(`stage-tiebreaks-${stageId}`);
  await expect(section).toBeAttached({ timeout: 20_000 });
  await expect(section).toHaveAttribute("data-state", "editor");
  await expect(section.getByTestId("stage-tiebreaks-badge"), "the badge stays outside the fold").toBeVisible();
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  const phone = projectWidth < 768;
  expect(await toggle.isVisible(), `the fold's toggle is a phone control (${projectWidth})`).toBe(phone);
  if (phone) {
    await assertTapFloor(toggle, "Show the order");
    await expect(section.getByTestId("stage-tiebreaks-list"), "the list is folded on a phone").toBeHidden();
  }
  await openFold(section);
  await expect(section.getByTestId("stage-tiebreaks-list")).toBeVisible();
  // A middle step moves: its arrows and remove on the floor (the first and last steps are pinned and carry none).
  const rows = section.locator('[data-testid^="stage-tiebreaks-row-"]');
  const n = await rows.count();
  expect(n, "the order has middle steps").toBeGreaterThan(2);
  for (const id of ["stage-tiebreaks-down-1", "stage-tiebreaks-remove-1", "stage-tiebreaks-up-2", "stage-tiebreaks-reset"]) await assertTapFloor(section.getByTestId(id), id);
  await section.getByTestId("stage-tiebreaks-remove-1").click(); // a step removed: "+ Add step" offers it back, Save shows
  await assertTapFloor(section.getByTestId("stage-tiebreaks-add"), "+ Add step");
  await assertTapFloor(section.getByTestId("stage-tiebreaks-save"), "Save order");
  const clip = await overflowingIn(page, `[data-testid="stage-tiebreaks-${stageId}"]`, "*", "the tie-breaks section is missing");
  expect(clip.clipped, `nothing in the tie-breaks section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  const here = await visibleControls(section);
  expect(here.length, "the section's controls were read").toBeGreaterThan(5);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(here, `the tie-breaks section's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(section));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // Generated and a first match started: the server lists the stage (`formatLockedStageIds`) — the lock line names it, the
  // order is still listed, and no control is left at any width.
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start division: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const first = await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(first.status, `start match: ${JSON.stringify(first.error)}`).toBe(201);
  await page.reload({ waitUntil: "load" });
  await openStagePanel(stageCardOf(page, stageId), "tiebreaks");
  const locked = page.getByTestId(`stage-tiebreaks-${stageId}`);
  await expect(locked).toHaveAttribute("data-state", "locked", { timeout: 20_000 });
  // Review I3: the card's one lock line is the summary's (visible at this width); the opened section repeats nothing.
  await expect(stageCardOf(page, stageId).getByTestId("stage-locked")).toBeVisible();
  await expect(locked.getByTestId("stage-tiebreaks-locked")).toHaveCount(0);
  await openFold(locked);
  await expect(locked.getByTestId("stage-tiebreaks-list")).toBeVisible();
  expect(await visibleControls(locked), "locked: no control").toEqual([]);
  const lclip = await overflowingIn(page, `[data-testid="stage-tiebreaks-${stageId}"]`, "*", "the locked tie-breaks section is missing");
  expect(lclip.clipped, `nothing in the locked section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
});

// W2c Task 19 (S2, S4): the match rules block on the fixture console, and the run sheet's "Format changed" chip, at every
// width. One DOM, branched with `max-md:*` (AGENTS.md "The phone composition") - the block lives inside ONE phone
// disclosure: folded below md until its toggle is tapped, a plain card from md up. So the evidence is: the block is ATTACHED
// at every width (class 22: wait on `toBeAttached`, and open the fold only when its toggle is the visible kind - at 768/834
// the toggle is `md:hidden`), its controls hold the 44px floor and are hit-testable (`elementFromPoint`, not paint), nothing
// clips or scrolls, and the visible control SET (membership, order, repeats) is the one 1280 shows. The states are the
// product's: unstarted, changed, a live match behind "Correct format", and a finished one with its lock.
test("W2c match rules block at every width: the fold opens, the controls hold the 44px floor, nothing clips or scrolls, the control set matches 1280, and the live, locked and run-sheet states fit", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const projectWidth = page.viewportSize()!.width;
  const m = builtinModules.find((x) => x.key === "badminton")!;
  const variant = Object.keys(m.variants)[0]!;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T19 ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Match rules widths",
    sport_key: "badminton",
    variant_key: variant,
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["Mr Alpha", "Mr Bravo", "Mr Charlie"].map((n) => `${n} ${TAG}-${testInfo.project.name}`));
  expect(added.ids).toHaveLength(3);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a league of three plays three matches").toBe(3);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const [unstarted, live, finished] = fixtureIds as [string, string, string];

  const block = page.getByTestId("match-rules-block");
  /** The block's visible controls in DOM order, by the field block they sit in (the phone toggle is not the block's). */
  const visibleControls = () =>
    block.evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => `${el.closest("[data-testid]")?.getAttribute("data-testid") ?? "-"}:${el.tagName}`),
    );
  /** Class 22: attached first, then open the fold only when its toggle is the visible kind. */
  const openFold = async (): Promise<void> => {
    await expect(block, "the block is attached at every width").toBeAttached({ timeout: 20_000 });
    const toggle = page.getByTestId("match-rules-toggle");
    await assertTapFloor(toggle, "Match rules toggle");
    await expect(block, "closed until the header button is tapped").toBeHidden();
    await openConsolePanel(page, "rules");
    await expect(block).toBeVisible({ timeout: 20_000 });
  };
  const fits = async (label: string): Promise<void> => {
    const clip = await overflowingIn(page, '[data-testid="match-rules-block"]', "*", "the match rules block is missing");
    expect(clip.clipped, `${label}: nothing in the block is clipped at ${projectWidth}`).toEqual([]);
    await expectNoHorizontalScroll(page);
    const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(dims.scroll, `${label} ${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  };
  const go = async (id: string): Promise<void> => {
    await page.goto(await fixturePath(request, id), { waitUntil: "load" });
    await dismissCookieBanner(page);
  };

  // --- unstarted: the form -----------------------------------------------------------------------------------------------
  await go(unstarted);
  await openFold();
  const bestOf = block.getByTestId("stage-rule-field-bestOf").getByRole("combobox");
  await assertTapFloor(bestOf, "best of");
  for (const f of await block.locator("select, input").all()) await assertTapFloor(f, "a match field");
  await bestOf.selectOption("1");
  await assertTapFloor(block.getByTestId("match-rules-save"), "Save");
  await fits("unstarted");
  const unstartedHere = await visibleControls();
  expect(unstartedHere.length, "the block's controls were read").toBeGreaterThan(4);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(unstartedHere, `unstarted: the block's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls());
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- changed: the chip, the reset, and the chip on the phone's closed row ---------------------------------------------
  const put = await apiJson(request, `/api/v1/fixtures/${unstarted}/rules`, "PUT", { rules: { bestOf: 1 } });
  expect(put.status, JSON.stringify(put.error)).toBe(200);
  await go(unstarted);
  await openFold();
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible();
  await assertTapFloor(block.getByTestId("match-rules-reset"), "Use stage rules");
  await fits("changed");
  const changedHere = await visibleControls();
  expect(changedHere, "premise: the reset joined the form's controls").toContain("match-rules-reset:BUTTON");
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(changedHere, `changed: the block's visible control set at ${projectWidth} vs 1280`).toEqual(await visibleControls());
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- the run sheet (before any play: once a stage has started its Fixtures tab folds the list behind "View fixtures"): the chip
  // is on the changed row only, inside the viewport ----------------------------------------------------------------------
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const chip = page.getByTestId("run-sheet-format-changed");
  await expect(chip, "exactly the changed match is tagged").toHaveCount(1, { timeout: 20_000 });
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  expect(box, "the chip has a box").not.toBeNull();
  expect(box!.x, "the chip starts inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "the chip ends inside the viewport").toBeLessThanOrEqual(page.viewportSize()!.width);
  await expectNoHorizontalScroll(page);

  // --- live: the form stays behind "Correct format", then opens with its warning ---------------------------------------
  const start = await apiJson(request, `/api/v1/fixtures/${live}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(start.status, JSON.stringify(start.error)).toBe(201);
  await go(live);
  await openFold();
  await assertTapFloor(block.getByTestId("match-rules-correct"), "Correct format");
  await expect(block.getByTestId("stage-rule-field-bestOf")).toHaveCount(0);
  await fits("live (closed)");
  await block.getByTestId("match-rules-correct").click();
  await expect(block.getByTestId("match-rules-warning")).toBeVisible();
  await assertTapFloor(block.getByTestId("stage-rule-field-bestOf").getByRole("combobox"), "best of (live)");
  await fits("live (open)");

  // --- finished: the lock sentence, no controls -----------------------------------------------------------------------
  const fixtureRead = await apiJson<{ home_entrant_id: string }>(request, `/api/v1/fixtures/${finished}`);
  let seq = 0;
  for (const [type, payload] of [["core.forfeit", { by: fixtureRead.data!.home_entrant_id, reason: "walkover" }], ["core.finalize", {}]] as const) {
    const r = await apiJson(request, `/api/v1/fixtures/${finished}/events`, "POST", { expected_seq: seq++, type, payload });
    expect(r.status, `${type}: ${JSON.stringify(r.error)}`).toBe(201);
  }
  await go(finished);
  await openFold();
  await expect(block.getByTestId("match-rules-locked")).toBeVisible();
  await expect(block.locator("select, input, button")).toHaveCount(0);
  await fits("locked");
});

// Match Day E1 fix round 1 (m7): the 44px tap floor holds for EVERY control of EVERY rules panel - the stage card's Match rules / Points /
// Tie-breaks panels and the Division rules strip's three - not just the few controls each earlier test happened to name. The panels are
// opened through the product's own buttons; every visible select, input, button and link inside each is hit-tested (`assertTapFloor`:
// height, and `elementFromPoint` at both edges). Counted: a panel that yields no control, or a run that measures too few, is a FAILURE,
// not a pass (TEST-STRATEGY anti-vacuity).
test("E1 fix 1 m7: every control in every rules panel (the stage card's three, the Division rules strip's three) holds the 44px floor, counted", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `E1 rules floor ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Eleven",
    // Football, not a set sport: a set sport keeps no win/draw/loss points, so the Division rules strip's Points panel is a read-only
    // summary with nothing to tap. Football's is the editor (three number boxes + Save) - the panel this test exists to measure.
    sport_key: "football",
    variant_key: "11-a-side",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  const stageId = stage.data!.id;
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);

  const CONTROLS = 'select, input:not([type="hidden"]), textarea, button, a[href], [role="switch"]';
  /** Open a phone fold inside `root` when its toggle is the visible kind (gated on visibility, never a width literal). */
  const openFolds = async (root: Locator): Promise<void> => {
    const toggles = root.locator('[data-role="phone-disclosure-toggle"]');
    for (let i = 0; i < (await toggles.count()); i++) {
      const t = toggles.nth(i);
      if ((await t.isVisible()) && (await t.getAttribute("aria-expanded")) !== "true") await t.click();
    }
  };
  /** Every visible control in `root` holds the floor; returns how many were measured. */
  const measure = async (root: Locator, label: string): Promise<number> => {
    await expect(root, `${label} is on screen`).toBeVisible({ timeout: 20_000 });
    await openFolds(root);
    const all = root.locator(CONTROLS);
    const n = await all.count();
    let measured = 0;
    for (let i = 0; i < n; i++) {
      const c = all.nth(i);
      if (!(await c.isVisible())) continue;
      // A checkbox / radio is drawn small on purpose and tapped through its <label> (the pattern the points editor uses: a 20px box inside
      // a min-h-11 label): the label is the target, so it is what is measured. A bare one with no label is measured as itself, and fails.
      const bare = await c.evaluate((el) => el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"));
      const wrapper = c.locator("xpath=ancestor::label[1]");
      await assertTapFloor(bare && (await wrapper.count()) === 1 ? wrapper : c, `${label} control ${i}`);
      measured++;
    }
    return measured;
  };

  const strip = page.getByTestId("division-rules-strip");
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await openPanels(strip, "format", "points", "tiebreaks");
  const card = stageCardOf(page, stageId);
  for (const panel of ["format", "points", "tiebreaks"] as const) await openStagePanel(card, panel);

  const counts: Record<string, number> = {};
  for (const panel of ["format", "points", "tiebreaks"] as const) {
    counts[`strip ${panel}`] = await measure(strip.getByTestId(`division-rules-panel-${panel}`), `strip ${panel} panel`);
    counts[`card ${panel}`] = await measure(page.locator(`#stage-panel-${stageId}-${panel}`), `stage card ${panel} panel`);
  }
  for (const [panel, n] of Object.entries(counts)) expect(n, `${panel}: the panel yielded controls to measure`).toBeGreaterThan(0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  expect(total, `controls measured across the six panels (${JSON.stringify(counts)})`).toBeGreaterThan(20);
  await expectNoHorizontalScroll(page);
});

// Match Day E1 fix round 2 (m3): the stage card's "N to schedule" clause is a link to the division schedule (fix round 1, m3), so on a phone
// it is a control and owes the 44px tap floor - measured on the real card, hit-tested at both edges (`assertTapFloor`). Counted: a card
// that offers no such link is a FAILURE (`toHaveCount(1)`), so the floor is never measured on nothing. From `md` up the link is an inline clause in a line of text and the
// floor does not apply (the rule is phone-only), so there the test pins that the link is on the card and goes to the schedule.
test("E1 fix 2 m3: the stage card's 'N to schedule' link holds the 44px floor below md, and goes to the division schedule at every width", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `E1 to-schedule ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "To schedule",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["Ms Alpha", "Ms Bravo", "Ms Charlie"].map((n) => `${n} ${TAG}-${testInfo.project.name}`));
  expect(added.status, "entrants accepted (an individual-kind roster on a singles division)").toBeLessThan(300);
  expect(added.ids).toHaveLength(3);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a league of three plays three matches, none of them dated").toBe(3);
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);

  const links = page.getByTestId("stage-progress-to-schedule");
  await expect(links, "the card carries ONE 'N to schedule' link").toHaveCount(1, { timeout: 20_000 });
  await expect(links.first()).toContainText("3");
  const href = await links.first().getAttribute("href");
  expect(href, "the link goes to the division's schedule").toMatch(/\/schedule(\?|$)/);
  // Anti-vacuity is `toHaveCount(1)` above: a card with no such link fails there, so the floor is never measured on nothing.
  if (page.viewportSize()!.width < 768) {
    await assertTapFloor(links.first(), "the stage card's 'N to schedule' link");
  } else {
    await expect(links.first()).toBeVisible();
  }
  await expectNoHorizontalScroll(page);
});

// W2c Task 20 (S4): the division's rule lock lines at every width (Match Day C2: on the Division rules strip's Match rules
// panel, on the Fixtures tab - they left Settings with the match rules). A started stage locks the match-rule fields, and the
// section says so ONCE ("Locked: Pool A has started and plays this format"; C2 fix round 1, I1 - never a line per field). The lines are plain text in the existing
// field grid - no second phone tree - so the evidence is that every line is on screen, readable (its text is not clipped by its
// own box), inside the viewport, that nothing scrolls the page sideways, and that the SET of lines (membership, order, repeats)
// is the one 1280 shows. Owner 2026-10-20: the settings tab is being redesigned, so no design bar here beyond "readable, no
// scroll, same set".
test("W2c division lock lines at every width: each line is on screen and readable, nothing scrolls, and the line set matches 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const projectWidth = page.viewportSize()!.width;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T20 ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Lock lines widths",
    sport_key: "badminton",
    variant_key: "short",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["Ms Alpha", "Ms Bravo", "Ms Charlie"].map((n) => `${n} ${TAG}-${testInfo.project.name}`));
  expect(added.ids).toHaveLength(3);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "Pool A" });
  expect(fixtureIds.length, "a league of three plays three matches").toBe(3);
  const divStarted = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(divStarted.status, JSON.stringify(divStarted.error)).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]!}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(started.status, JSON.stringify(started.error)).toBe(201);

  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const strip = page.getByTestId("division-rules-strip");
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await openPanels(strip, "format");

  const lines = page.locator('[data-testid^="division-locked-"]');
  // ONE for the section, however many of its fields the stage locks (every badminton field and the variant, here); the section
  // then reads, with no Save over a form the server would refuse whole.
  const expectedLines = 1;
  await expect(lines, "the section says its lock once").toHaveCount(expectedLines, { timeout: 20_000 });
  await expect(page.getByTestId("division-locked-format")).toBeVisible();
  await expect(page.getByTestId("division-rules-format-save"), "no Save").toHaveCount(0);
  const ids = (): Promise<string[]> => lines.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!));
  const here = await ids();

  for (let i = 0; i < expectedLines; i++) {
    const line = lines.nth(i);
    await line.scrollIntoViewIfNeeded();
    await expect(line, `line ${here[i]} is visible at ${projectWidth}`).toBeVisible();
    expect((await line.innerText()).trim().length, `line ${here[i]} has words`).toBeGreaterThan(10);
    const box = (await line.boundingBox())!;
    expect(box.x, `${here[i]} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${here[i]} ends inside the viewport`).toBeLessThanOrEqual(page.viewportSize()!.width);
    const clip = await line.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(clip, `${here[i]}'s words are not clipped by their own box`).toBeLessThanOrEqual(1);
  }
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `scrollWidth ${dims.scroll} within clientWidth ${dims.client} at ${projectWidth}`).toBeLessThanOrEqual(dims.client);

  await page.setViewportSize({ width: 1280, height: 900 });
  expect(here, `the lock line set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await ids());
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });
});
