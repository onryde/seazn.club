// Match Day Phase C, Task C3 (spec 2026-10-31-match-day-design.md section 12, items 1, 5-9, 12) - the stage card on the division's
// Fixtures tab, DRIVEN: a badminton league with one match in play and two to schedule, and a Swiss stage mid-round. What a unit
// render cannot show (apps/web vitest is environment:"node"): the header buttons open and close their panels, the phone's ONE
// "Stage tools" sheet carries the same three buttons as its top rows (opened the way AGENTS.md rule 22 says: gated on the trigger being
// visible, waited on `toBeAttached`), the stage's fixtures are in the card with no "View N fixtures" trip, and Complete waits for the
// matches.
//
// Anti-vacuity: every absence is paired with the presence beside it; the sweep reports how many panels it opened.
import { expect, test, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, openStagePanel, closeStagePanel, stageCardOf, type StagePanel } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { expectStageToolsSheet } from "./helpers/stage-tools-sheet";
import { escapeRe, moduleOf, summaryFormatText, summaryPointsText, summaryTiesPrefix } from "./helpers/stage-summary";

const STEP_MS = 20_000;
const PANELS: readonly StagePanel[] = ["format", "points", "tiebreaks"];

async function seedLeague(request: Parameters<typeof apiJson>[0], label: string): Promise<{ divisionId: string; stageId: string; fixtureIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `C3 ${label} ${TAG}`,
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
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  const fixtureIds = gen.data!.fixtures.map((f) => f.id);
  expect(fixtureIds, "a league of three plays three matches").toHaveLength(3);
  return { divisionId: div.data!.id, stageId: stage.data!.id, fixtureIds };
}

async function startMatch(request: Parameters<typeof apiJson>[0], fixtureId: string): Promise<void> {
  const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: st.data!.last_seq, type: "core.start", payload: {} });
  expect(res.status, `core.start: ${JSON.stringify(res.error)}`).toBe(201);
}

async function openCard(page: Page, request: Parameters<typeof apiJson>[0], divisionId: string, stageId: string) {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const card = stageCardOf(page, stageId);
  await expect(card, "the stage card is on the Fixtures tab").toBeVisible({ timeout: STEP_MS });
  return card;
}

test("the stage card: header buttons, a one-line summary, the stage's own fixtures, and Complete waiting for its matches", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { divisionId, stageId, fixtureIds } = await seedLeague(request, "league");
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  await startMatch(request, fixtureIds[0]!); // one in play, two still to schedule
  const card = await openCard(page, request, divisionId, stageId);

  // The three header buttons are on a table stage, each a disclosure that names its panel.
  for (const panel of PANELS) {
    const tool = card.getByTestId(`stage-tool-${panel}`);
    await expect(tool, `${panel}: the header button`).toBeAttached();
    await expect(tool).toHaveAttribute("aria-expanded", "false");
    await expect(tool).toHaveAttribute("aria-controls", `stage-panel-${stageId}-${panel}`);
  }

  // Closed, the card is a one-line summary - and not the old inline sections.
  const summary = card.getByTestId("stage-format-summary");
  await expect(summary).toBeVisible();
  // ...whose words are the declared copy (review m6), clause for clause: the format as the public line words it for the cfg the server
  // folds this stage's matches under, then the engine's own points pair, then the ties clause. Not "it says something".
  const rules = await apiJson<{ cfg: Record<string, unknown> }>(request, `/api/v1/fixtures/${fixtureIds[0]!}/rules`);
  expect(rules.status, `GET rules: ${JSON.stringify(rules.error)}`).toBe(200);
  const badminton = moduleOf("badminton");
  const pair = badminton.tablePointsRule(badminton.configSchema.parse(rules.data!.cfg), "league").bySetScore!["*"]!;
  await expect(summary, "the summary reads: format, points, ties").toHaveText(
    new RegExp(`^${escapeRe(summaryFormatText("badminton", "league", rules.data!.cfg))} \u00b7 ${escapeRe(summaryPointsText(pair[0], pair[1]))} \u00b7 ${escapeRe(summaryTiesPrefix())}\\S`),
  );
  await expect(card.getByTestId("stage-format-editor"), "no inline Match format section").toHaveCount(0);
  await expect(card.getByTestId(`stage-points-${stageId}`), "no inline Points section").toHaveCount(0);
  await expect(card.getByTestId(`stage-tiebreaks-${stageId}`), "no inline Tie-breaks section").toHaveCount(0);

  // The stage's fixtures are IN the card; there is no "View N fixtures" trip and no "See the fixtures" link. A started division opens
  // its sheet on Today, which keeps none of these unscheduled matches (the page says so, once): "All" shows the stage's rows.
  await expect(page.getByTestId("run-sheet-empty"), "Today keeps none of them: the page says so once").toHaveCount(1);
  await page.getByTestId("run-sheet-filter").locator('[data-filter="all"]').click();
  await expect(card.getByTestId("stage-run-sheet"), "the stage's rows are in its card").toBeVisible();
  await expect(card.locator("li[data-fixture-no]"), "all three matches are in the card").toHaveCount(3);
  await expect(page.getByTestId("stage-view-fixtures")).toHaveCount(0);
  await expect(page.getByText(/View \d+ fixtures?/)).toHaveCount(0);
  await expect(page.getByText(/See the fixtures/i)).toHaveCount(0);

  // Generate is gone once the stage has started; Complete is there but waits, and says why.
  await expect(card.getByTestId("stage-generate"), "a started stage has no Generate").toHaveCount(0);
  const rail = card.getByTestId("stage-rail");
  const railTrigger = card.getByTestId("stage-rail-trigger");
  if (await railTrigger.isVisible()) await railTrigger.click();
  const complete = card.getByTestId("stage-complete");
  await expect(complete, "Complete is rendered").toBeVisible();
  await expect(complete, "three matches are not all played").toBeDisabled();
  await expect(card.getByTestId("stage-complete-hint")).toHaveText(/unlocks when all 3 matches are played/);
  await expect(rail).toBeAttached();
  // A phone's rail sheet is modal: put it away before the header buttons are tapped.
  if (await railTrigger.isVisible()) await page.keyboard.press("Escape");

  // Each panel opens and closes from its button (and a second open after a close still works - the sequence, not the click).
  let opened = 0;
  for (let round = 0; round < 2; round++) {
    for (const panel of PANELS) {
      await openStagePanel(card, panel);
      opened++;
      await expect(card.locator(`#stage-panel-${stageId}-${panel}`), `${panel}: the panel is on the card (round ${round + 1})`).toBeVisible();
      await closeStagePanel(card, panel);
      await expect(card.locator(`#stage-panel-${stageId}-${panel}`), `${panel}: closed again (round ${round + 1})`).toHaveCount(0);
    }
  }
  expect(opened, "the sweep opened every panel twice").toBe(PANELS.length * 2);

  // Several can be open at once: Match format and Points together.
  await openStagePanel(card, "format");
  await openStagePanel(card, "points");
  await expect(card.getByTestId("stage-format-editor")).toBeVisible();
  await expect(card.getByTestId(`stage-points-${stageId}`)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("the phone: the three buttons are the top rows of the ONE Stage tools sheet; choosing one closes the sheet and opens its panel", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { divisionId, stageId } = await seedLeague(request, "phone");
  const card = await openCard(page, request, divisionId, stageId);
  await expectStageToolsSheet(page, card, stageId);
});

test("a Swiss stage mid-round: Pair next leads, Complete waits (disabled, with its reason), and Unpair is offered", async ({ page, request }) => {
  test.setTimeout(150_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `C3 swiss ${TAG}`, visibility: "private" });
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Swiss",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } });
  await addEntrantsViaApi(request, divisionId, ["S1", "S2", "S3", "S4"].map((n) => `${n} ${TAG}`));
  const started = await apiJson<{ generated: number }>(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.data!.generated, "start mints every round's shells: two rounds of two boards").toBe(4);

  const card = await openCard(page, request, divisionId, stage.data!.id);
  const railTrigger = card.getByTestId("stage-rail-trigger");
  const openSheet = async () => {
    if ((await railTrigger.isVisible()) && (await railTrigger.getAttribute("aria-expanded")) !== "true") await railTrigger.click();
  };
  await openSheet();
  const pairNext = card.getByTestId("stage-generate");
  const complete = card.getByTestId("stage-complete");
  // Round 1 waiting (shells only): Pair next leads; Complete is there, disabled, and says why (all four matches are open).
  await expect(pairNext, "Pair next leads").toHaveText(/pair next round/i);
  await expect(pairNext).toHaveClass(/btn-primary/);
  await expect(complete, "Complete is present").toBeVisible();
  await expect(complete).toBeDisabled();
  await expect(card.getByTestId("stage-complete-hint")).toHaveText(/unlocks when all 4 matches are played/);
  await expect(card.getByTestId("stage-unpair"), "nothing is paired yet: nothing to unpair").toHaveCount(0);

  // Pair round 1: now MID-ROUND (round 1 seated and open, round 2 still waiting). Pair next still leads - there is a round to pair -
  // and Complete still waits; Unpair is offered for the round just seated.
  await pairNext.click();
  await expect.poll(async () => (await apiJson<{ round_no: number; home_entrant_id: string | null; stage_id: string }[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter((f) => f.round_no === 1 && f.home_entrant_id !== null).length, { timeout: 20_000 }).toBe(2);
  await page.reload({ waitUntil: "load" });
  await dismissCookieBanner(page);
  await openSheet();
  await expect(card.getByTestId("stage-generate"), "mid-round, Pair next still leads").toHaveText(/pair next round/i);
  await expect(card.getByTestId("stage-generate")).toHaveClass(/btn-primary/);
  await expect(card.getByTestId("stage-complete"), "mid-round, Complete waits").toBeDisabled();
  await expect(card.getByTestId("stage-complete-hint")).toHaveText(/unlocks when all 4 matches are played/);
  await expect(card.getByTestId("stage-unpair"), "the round just seated can be taken back").toBeVisible();
});

test("a stage not yet started: Generate leads, no Complete, and the card still says what it will play", async ({ page, request }) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `C3 pending ${TAG}`, visibility: "private" });
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Singles", sport_key: "badminton", variant_key: "bwf" });
  await addEntrantsViaApi(request, div.data!.id, ["Dee", "Eli"].map((n) => `${n} ${TAG}`));
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  const card = await openCard(page, request, div.data!.id, stage.data!.id);
  const railTrigger = card.getByTestId("stage-rail-trigger");
  if (await railTrigger.isVisible()) await railTrigger.click();
  await expect(card.getByTestId("stage-generate"), "an unstarted stage leads with Generate").toBeVisible();
  await expect(card.getByTestId("stage-complete"), "nothing to complete before it starts").toHaveCount(0);
  await expect(card.getByTestId("stage-format-summary"), "and the summary is there").toBeVisible();
  await expect(card.getByTestId("stage-run-sheet"), "no fixtures yet, no sheet").toHaveCount(0);
});
