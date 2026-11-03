import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  divisionPath,
  expectNoHorizontalScroll,
  openStagePanel,
  closeStagePanel,
  scoreFixture,
  setDateTime,
  stageCardOf,
  withDb,
} from "../helpers";
import { openPanels } from "../helpers/rules-strip";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { uiEn, fill } from "../match-room-kit";

/**
 * The stage card and the division page around it, WALKED by an organiser (Task W; owner rule 2026-11-01: every event under test is
 * tapped, the API only reaches a state, each walk runs to its terminal state and reads back what a person sees). At the walkthrough
 * project's 1280, on the shared Pro organisation, one competition per test:
 *
 *   1. A league mid-way: the Division rules strip (Match rules / Points / Tie-breaks) opens, several at once, and closes; the stage
 *      card's actions in the order the rail declares them, then the divider, then the card's own three settings; tapping the greyed
 *      Complete shows its reason (there is no ⓘ any more) and completes nothing; Add match opens and closes; the round bars read
 *      "Round N · x of y done" from the matches' own status; a round's rows are in TIME order; a round opened by hand, and one closed
 *      by hand, are exactly as the person left them after a real router.refresh() caused by a write elsewhere on the card (PB1).
 *   2. A knockout: the bracket opens inline, inside the stage's card.
 *   3. A Swiss stage taken from start to finish: Pair next round, Unpair offered, More and Pair next ▾ opening as popovers over the
 *      card (SCF: the card does not grow; Escape and a tap elsewhere close them) and the "paired by the system" sentence read off the
 *      legend line, the second round, Complete enabled only when every match is played, the card folding to its one line - and then
 *      the competition page: the finished division is hidden, the Show finished switch brings it back and puts it away again.
 *   4. The Entrants tab: the entrant kinds block above the roster - open on an empty division, folded under one row once there is an
 *      entrant, Save lands in the stored config and survives a reload, Reset drops it and the chips follow the sport default.
 *
 * Every string asserted is read from the dictionary (`uiEn` / `fill`), every count from the database, and the card's action order from
 * the rail's own source (the order it renders them in is a declaration; the test does not retype it). Budgets are derived from the
 * number of navigations and taps, never one flat number (class 20).
 *
 * One sport (generic) except where a kind needs another, on purpose: this walks layout and flow, which is sport-agnostic (owner rule: skip
 * rare cases).
 */

const NAV_MS = 20_000;
const ACT_MS = 4_000;
const SEED_MS = 45_000;
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function seedDivision(
  request: APIRequestContext,
  label: string,
  opts: { entrants: string[]; stage?: { kind: string; name: string; config?: Record<string, unknown> }; start?: boolean; sport?: string; variant?: string },
): Promise<{ competitionId: string; divisionId: string; stageId: string; entrantIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `SC ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: label,
    sport_key: opts.sport ?? "generic",
    variant_key: opts.variant ?? "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const ents = await addEntrantsViaApi(request, div.data!.id, opts.entrants.map((n) => `${n} ${TAG}`));
  expect(ents.ids, "entrants").toHaveLength(opts.entrants.length);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, ...(opts.stage ?? { kind: "league", name: "League" }) });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  if (opts.start !== false) {
    const kind = (opts.stage ?? { kind: "league" }).kind;
    if (kind !== "swiss") {
      const gen = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
      expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
    }
    const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  }
  return { competitionId: comp.data!.id, divisionId: div.data!.id, stageId: stage.data!.id, entrantIds: ents.ids };
}

async function openCard(page: Page, request: APIRequestContext, divisionId: string, stageId: string, tab = "fixtures"): Promise<Locator> {
  await page.goto(await divisionPath(request, divisionId, `?tab=${tab}`), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const card = stageCardOf(page, stageId);
  await expect(card, "the stage card is on the Fixtures tab").toBeVisible({ timeout: NAV_MS });
  return card;
}

/** A phone puts the actions behind the rail trigger; at the walkthrough's width the trigger is not shown and this does nothing. */
async function openRail(card: Locator): Promise<void> {
  const trigger = card.getByTestId("stage-rail-trigger");
  if ((await trigger.isVisible()) && (await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

interface Fx {
  id: string;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  status: string;
}
const fixturesOf = (stageId: string): Promise<Fx[]> =>
  withDb((sql) => sql<Fx[]>`select id, round_no, seq_in_round, fixture_no, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`);

const RAIL_SRC = readFileSync(fileURLToPath(new URL("../../src/components/v2/desk/stage-rail.tsx", import.meta.url)), "utf8");

test.describe("The stage card, walked", () => {
  test("a league mid-way: the rules strip, the card's actions, Complete's reason, round bars, rows in time order, a round left open across a refresh", async ({ page, request }) => {
    test.setTimeout(budget(3, 60));
    const leagueEntrants = ["Ana", "Ben", "Cy", "Di"];
    const seed = await seedDivision(request, "League", { entrants: leagueEntrants });
    const { stageId, divisionId } = seed;
    const all = await fixturesOf(stageId);
    const n = leagueEntrants.length;
    expect(all, "a league plays every pair once").toHaveLength((n * (n - 1)) / 2);
    const rounds = [...new Set(all.map((f) => f.round_no))].sort((a, b) => a - b);
    expect(rounds, "in one round fewer than there are entrants").toHaveLength(n - 1);
    const inRound = (n: number): Fx[] => all.filter((f) => f.round_no === rounds[n - 1]);
    // Round 1: both played. Round 2: one played, one left to play. Round 3: none played - and its two matches TIMED in the reverse of
    // their order in the round, so "rows in time order" differs from "rows in draw order".
    for (const f of inRound(1)) await scoreFixture(request, f.id, 2, 1);
    await scoreFixture(request, inRound(2)[0]!.id, 1, 0);
    const [r3a, r3b] = inRound(3) as [Fx, Fx];
    await withDb(async (sql) => {
      await sql`update fixtures set scheduled_at = '2030-06-15T12:00:00Z' where id = ${r3a.id}`;
      await sql`update fixtures set scheduled_at = '2030-06-15T10:00:00Z' where id = ${r3b.id}`;
    });

    // ── the page, and the Division rules strip ───────────────────────────────────────────────────────────────────────────────
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
    await dismissCookieBanner(page);
    const strip = page.getByTestId("division-rules-strip");
    await expect(strip).toBeVisible({ timeout: NAV_MS });
    await expect(strip.getByRole("heading", { name: uiEn["rulesStrip.title"]! })).toBeVisible();
    const toggles = [
      ["format", uiEn["rulesStrip.format"]!],
      ["points", uiEn["stagePoints.title"]!],
      ["tiebreaks", uiEn["stageTiebreaks.title"]!],
    ] as const;
    for (const [id, label] of toggles) {
      const t = strip.getByTestId(`division-rules-toggle-${id}`);
      await expect(t, `${id}: the toggle is named in the dictionary's words`).toHaveText(label);
      await expect(t).toHaveAttribute("aria-expanded", "false");
      await expect(strip.getByTestId(`division-rules-panel-${id}`)).toHaveCount(0);
    }
    await openPanels(strip, "format", "points", "tiebreaks");
    let panels = 0;
    for (const [id] of toggles) {
      await expect(strip.getByTestId(`division-rules-panel-${id}`), `${id}: its panel is open beside the others`).toBeVisible();
      panels++;
    }
    expect(panels, "anti-vacuity: every panel open at once").toBe(toggles.length);
    await expectNoHorizontalScroll(page);
    for (const [id] of toggles) {
      await strip.getByTestId(`division-rules-toggle-${id}`).click();
      await expect(strip.getByTestId(`division-rules-toggle-${id}`)).toHaveAttribute("aria-expanded", "false");
      await expect(strip.getByTestId(`division-rules-panel-${id}`)).toHaveCount(0);
    }

    // ── the stage card header: actions, the divider, the card's own three settings ───────────────────────────────────────────
    const card = stageCardOf(page, stageId);
    await expect(card).toBeVisible();
    await openRail(card);
    const railIds = ["stage-complete", "stage-delete", "stage-add-match"];
    // The rail renders its controls in its source order; then the divider, which is the SETTINGS group's first child (SCF, owner pick
    // Option A: stages-panel.tsx, not the rail), then the card's three settings.
    const declared = railIds
      .filter((id) => RAIL_SRC.includes(`data-testid="${id}"`))
      .sort((x, y) => RAIL_SRC.indexOf(`data-testid="${x}"`) - RAIL_SRC.indexOf(`data-testid="${y}"`));
    const expectedOrder = [...declared, "stage-controls-divider", "stage-tool-format", "stage-tool-points", "stage-tool-tiebreaks"];
    const present: string[] = [];
    for (const id of expectedOrder) if ((await card.getByTestId(id).count()) > 0) present.push(id);
    expect(present.length, "anti-vacuity: the card shows its actions, the divider and the three settings").toBeGreaterThanOrEqual(6);
    const domOrder = await card.evaluate(
      (el, ids) =>
        ids
          .map((id) => ({ id, node: el.querySelector(`[data-testid="${id}"]`) }))
          .filter((x): x is { id: string; node: Element } => x.node !== null)
          .sort((p, q) => (p.node.compareDocumentPosition(q.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .map((x) => x.id),
      expectedOrder,
    );
    expect(domOrder, "the card's controls, in the order the rail declares them").toEqual(present);
    await expect(card.getByTestId("stage-complete")).toHaveText(uiEn["schedule.complete"]!);
    await expect(card.getByTestId("stage-add-match")).toHaveText(uiEn["stage.addMatch.button"]!);
    for (const [id, label] of [["format", uiEn["rulesStrip.format"]!], ["points", uiEn["stagePoints.title"]!], ["tiebreaks", uiEn["stageTiebreaks.title"]!]] as const) {
      await expect(card.getByTestId(`stage-tool-${id}`)).toHaveText(label);
    }
    // The divider sits between the actions and the settings, by position on the page.
    const [c, d, t] = await Promise.all([card.getByTestId("stage-complete").boundingBox(), card.getByTestId("stage-controls-divider").boundingBox(), card.getByTestId("stage-tool-format").boundingBox()]);
    expect(c!.x + c!.width, "actions, then the divider").toBeLessThanOrEqual(d!.x + 1);
    expect(d!.x + d!.width, "then the settings").toBeLessThanOrEqual(t!.x + 1);
    // SCF: the divider is the settings group's own - on Match rules' line, right beside it.
    expect(Math.abs(d!.y + d!.height / 2 - (t!.y + t!.height / 2)), "the divider is on the settings buttons' line").toBeLessThan(t!.height / 2);
    expect(t!.x - (d!.x + d!.width), "and right beside them").toBeLessThanOrEqual(24);

    // Complete is waiting (five matches are not played): tapping it shows the reason on the button itself and completes nothing. No ⓘ.
    const complete = card.getByTestId("stage-complete");
    const hint = card.getByTestId("stage-complete-hint");
    await expect(card.getByTestId("stage-complete-info"), "PB1: the ⓘ is retired").toHaveCount(0);
    await expect(complete).toHaveAttribute("aria-disabled", "true");
    await expect(hint, "closed until asked").toBeHidden();
    // `force`: the button is aria-disabled (Playwright reads that as "not enabled" and would wait forever); a finger taps it all the same.
    await complete.click({ force: true });
    await expect(hint, "a tap shows the reason").toBeVisible();
    await expect(hint).toHaveText(fill("stageCard.completeHint.other", { count: all.length }));
    await expect(complete).toHaveAccessibleDescription(fill("stageCard.completeHint.other", { count: all.length }));
    const status = await withDb((sql) => sql<{ status: string }[]>`select status from stages where id = ${stageId}`);
    expect(status[0]!.status, "the tap completed nothing").not.toBe("complete");
    // A tap elsewhere: on the rules strip's own title, a heading nothing listens to.
    await strip.getByRole("heading", { name: uiEn["rulesStrip.title"]! }).click();
    await expect(hint, "a tap elsewhere puts it away").toBeHidden();

    // Add match opens its form and closes it again (twice: the sequence, not the click).
    const addMatch = card.getByTestId("stage-add-match");
    for (let pass = 0; pass < 2; pass++) {
      await addMatch.click();
      await expect(addMatch, `pass ${pass + 1}: open`).toHaveAttribute("aria-expanded", "true");
      await addMatch.click();
      await expect(addMatch, `pass ${pass + 1}: closed`).toHaveAttribute("aria-expanded", "false");
    }
    // The card's own settings open and close from their buttons.
    let opened = 0;
    const settingsPanels = ["format", "points", "tiebreaks"] as const;
    for (const panel of settingsPanels) {
      await openStagePanel(card, panel);
      await expect(card.locator(`#stage-panel-${stageId}-${panel}`)).toBeVisible();
      await closeStagePanel(card, panel);
      await expect(card.locator(`#stage-panel-${stageId}-${panel}`)).toHaveCount(0);
      opened++;
    }
    expect(opened, "anti-vacuity: every settings panel opened and closed").toBe(settingsPanels.length);

    // ── round bars: "Round N · x of y done", from the matches' own status ───────────────────────────────────────────────────
    const bars = card.getByTestId("run-sheet-round-toggle");
    await expect(bars, "a bar per round").toHaveCount(rounds.length);
    // The statuses in `all` were read BEFORE the scoring above; re-read them for the expected counts.
    const nowRows = await fixturesOf(stageId);
    const doneOf = (n: number): number => nowRows.filter((f) => f.round_no === rounds[n - 1] && f.status === "decided").length;
    const expectedDone = [2, 1, 0];
    let barsRead = 0;
    for (let r = 1; r <= rounds.length; r++) {
      expect(doneOf(r), `premise: round ${r} has ${expectedDone[r - 1]} played in the database`).toBe(expectedDone[r - 1]);
      const roundBar = card.locator(`[aria-controls="run-sheet-rounds-${stageId}-${rounds[r - 1]}"]`);
      await expect(roundBar).toHaveText(new RegExp(`^${esc(fill("runsheet.round.heading", { round: r }))}\\s*·\\s*${esc(fill("runsheet.round.done.other", { done: doneOf(r), total: inRound(r).length }))}`));
      barsRead++;
    }
    expect(barsRead, "anti-vacuity: every bar read").toBe(rounds.length);
    const bar = (n: number): Locator => card.locator(`[aria-controls="run-sheet-rounds-${stageId}-${rounds[n - 1]}"]`);
    const rowsOf = (n: number): Locator => card.locator(`#run-sheet-rounds-${stageId}-${rounds[n - 1]} li[data-fixture-no]:visible`);
    await expect(bar(1), "round 1 is finished: folded").toHaveAttribute("aria-expanded", "false");
    await expect(bar(2), "round 2 has a match to play: open").toHaveAttribute("aria-expanded", "true");
    await expect(bar(3), "round 3 has matches to play: open").toHaveAttribute("aria-expanded", "true");

    // Rows in time order: round 3's two matches are timed in the reverse of the draw's order, and the sheet follows the clock.
    const byTime = (await withDb((sql) => sql<{ fixture_no: number }[]>`select fixture_no from fixtures where stage_id = ${stageId} and round_no = ${rounds[2]} order by scheduled_at, fixture_no`)).map((r) => r.fixture_no);
    const byDraw = [r3a, r3b].map((f) => f.fixture_no);
    expect(byTime, "premise: the clock order is not the draw order").not.toEqual(byDraw);
    await expect(rowsOf(3)).toHaveCount(2);
    const shown = await rowsOf(3).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-fixture-no"))));
    expect(shown, "round 3's rows follow their times").toEqual(byTime);
    await expectNoHorizontalScroll(page);

    // ── PB1: a round opened by hand, and one closed by hand, survive a real router.refresh() ────────────────────────────────
    await bar(1).click();
    await expect(bar(1)).toHaveAttribute("aria-expanded", "true");
    await expect(rowsOf(1), "round 1's two matches are on screen").toHaveCount(2);
    await bar(3).click();
    await expect(bar(3)).toHaveAttribute("aria-expanded", "false");
    await expect(rowsOf(3)).toHaveCount(0);
    // A write elsewhere on the card: give round 2's unplayed match a time. The PATCH lands, then the page is re-rendered by the server.
    const target = inRound(2)[1]!;
    const row = card.locator(`li[data-fixture-no="${target.fixture_no}"]`);
    const setTime = row.locator('[data-row-action="set_time"]');
    await expect(setTime, "the unplayed match offers Set time").toBeVisible();
    await setTime.click();
    const editor = row.getByTestId("run-sheet-set-time-editor");
    await expect(editor).toBeVisible();
    await setDateTime(editor, "2030-06-15T16:45");
    const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/v1/fixtures/${target.id}`));
    const refreshed = page.waitForResponse((r) => r.request().method() === "GET" && /[?&]_rsc=/.test(r.url()) && r.url().includes("/d/"));
    await row.getByRole("button", { name: uiEn["schedule.save"]!, exact: true }).click();
    expect((await patched).status(), "the write landed").toBeLessThan(300);
    expect((await refreshed).status(), "and the server re-rendered the page").toBe(200);
    await expect(row.getByTestId("run-sheet-edit-time"), "the server's new time is drawn").toBeVisible();
    await expect(bar(1), "the round the person opened is still open").toHaveAttribute("aria-expanded", "true");
    await expect(rowsOf(1)).toHaveCount(2);
    await expect(bar(3), "the round the person closed is still closed (the default is open)").toHaveAttribute("aria-expanded", "false");
    await expect(rowsOf(3)).toHaveCount(0);
    await expect(bar(2), "the round nobody touched keeps its default").toHaveAttribute("aria-expanded", "true");
    await expectNoHorizontalScroll(page);
  });

  test("a knockout: the bracket opens inline, inside the stage's own card", async ({ page, request }) => {
    test.setTimeout(budget(2, 20));
    const seed = await seedDivision(request, "Cup", { entrants: ["Wil", "Xan", "Yun", "Zed"], stage: { kind: "knockout", name: "Cup" } });
    const { stageId, divisionId } = seed;
    const fx = await fixturesOf(stageId);
    expect(fx, "four entrants: two semi-finals and a final").toHaveLength(3);
    const card = await openCard(page, request, divisionId, stageId);
    await openRail(card);
    const tool = card.getByTestId("stage-tool-bracket");
    await expect(tool, "a single-elimination stage offers its bracket").toHaveText(uiEn["bracket.title"]!);
    await expect(tool).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByTestId("bracket-panel"), "closed by default").toHaveCount(0);
    let opens = 0;
    for (let pass = 0; pass < 2; pass++) {
      await openStagePanel(card, "bracket");
      const panel = card.getByTestId("bracket-panel");
      await expect(panel, `pass ${pass + 1}: the tree is INSIDE the card`).toBeVisible();
      // Every match of the stage is on the tree, once, and the page holds no second bracket above the card.
      const tiles = panel.locator('a[href*="/f/"]');
      await expect(tiles, `pass ${pass + 1}: the tree draws the stage's three matches`).toHaveCount(fx.length);
      const drawn = (await tiles.evaluateAll((els) => els.map((e) => Number(/\/f\/(\d+)/.exec(e.getAttribute("href") ?? "")?.[1])))).sort((a, b) => a - b);
      expect(drawn, "and they are the stage's own matches").toEqual(fx.map((f) => f.fixture_no).sort((a, b) => a - b));
      await expect(page.getByTestId("bracket-panel"), "one tree on the page").toHaveCount(1);
      await expectNoHorizontalScroll(page);
      await closeStagePanel(card, "bracket");
      await expect(card.getByTestId("bracket-panel")).toHaveCount(0);
      opens++;
    }
    expect(opens, "anti-vacuity: opened and closed twice").toBe(2);
  });

  test("a Swiss stage from Pair next to Complete, then the competition page's Show finished switch", async ({ page, request }) => {
    test.setTimeout(budget(8, 56));
    const swissEntrants = ["S1", "S2", "S3", "S4"];
    const swissRounds = 2;
    const boards = swissEntrants.length / 2; // a board per pair of entrants, each round
    const matches = swissRounds * boards;
    const seed = await seedDivision(request, "Swiss", { entrants: swissEntrants, stage: { kind: "swiss", name: "Swiss", config: { rounds: swissRounds } } });
    const { stageId, divisionId, competitionId } = seed;
    expect((await fixturesOf(stageId)).length, "start mints every round's shells: every round's boards").toBe(matches);
    const paired = async (round: number): Promise<number> =>
      (await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId} and round_no = ${round} and home_entrant_id is not null and away_entrant_id is not null`))[0]!.n;
    let card = await openCard(page, request, divisionId, stageId);
    await openRail(card);
    const pairNext = card.getByTestId("stage-generate");
    const complete = card.getByTestId("stage-complete");
    await expect(pairNext, "Pair next leads").toHaveText(uiEn["schedule.pairNext"]!);
    await expect(pairNext).toHaveClass(/btn-primary/);
    await expect(complete, "Complete waits").toHaveAttribute("aria-disabled", "true");
    await expect(card.getByTestId("stage-unpair"), "nothing is paired: nothing to unpair").toHaveCount(0);

    // Pair round 1.
    expect(await paired(1)).toBe(0);
    await pairNext.click();
    await expect.poll(() => paired(1), { timeout: 20_000, message: "round 1 is seated" }).toBe(boards);
    await page.reload({ waitUntil: "load" });
    card = stageCardOf(page, stageId);
    await openRail(card);
    await expect(card.getByTestId("stage-unpair"), "the round just seated can be unpaired").toBeVisible();
    await expect(card.getByTestId("stage-unpair")).toHaveText(uiEn["schedule.unpair"]!);
    await expect(card.getByTestId("stage-generate"), "Pair next still leads: there is a round to pair").toHaveText(uiEn["schedule.pairNext"]!);
    await expect(card.getByTestId("stage-complete")).toHaveAttribute("aria-disabled", "true");
    await expectNoHorizontalScroll(page);

    // SCF (owner pick, Option A): round 1 is seated and round 2 waits, so More (Add late player) and the Pair next ▾ are both on the card.
    // Each opens OVER the content - the card does not grow - and is put away by Escape (focus back on its trigger) or a tap elsewhere.
    const heightNow = async (): Promise<number> => (await card.boundingBox())!.height;
    const settled = await heightNow();
    const more = card.getByTestId("stage-more");
    const moreMenu = card.getByTestId("stage-more-menu");
    await more.click();
    await expect(moreMenu, "More opens").toBeVisible();
    await expect(moreMenu.getByTestId("stage-add-late-player"), "it offers the late add, in the dictionary's words").toContainText(uiEn["stage.more.addLatePlayer"]!);
    expect(Math.abs((await heightNow()) - settled), "More floats: the card did not grow").toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await expect(moreMenu, "Escape puts it away").toBeHidden();
    await expect(more, "and focus is back on More").toBeFocused();
    const pairToggle = card.getByTestId("stage-pairing-toggle");
    const pairMenu = card.getByTestId("stage-pairing-menu");
    await pairToggle.click();
    await expect(pairMenu, "Pair next ▾ opens").toBeVisible();
    await expect(pairMenu.getByTestId("stage-pairing-hint"), "round 2 shows its read-only reason").toHaveText(uiEn["schedule.pairing.roundOneOnly"]!);
    expect(Math.abs((await heightNow()) - settled), "Pair next ▾ floats: the card did not grow").toBeLessThanOrEqual(1);
    await card.locator("header h3").first().click();
    await expect(pairMenu, "a tap elsewhere puts it away").toBeHidden();
    // The "paired by the system" sentence is read on the legend line, beside the round count - not in the action row.
    const adhocNote = card.getByTestId("stage-swiss-adhoc-note");
    await expect(adhocNote).toHaveText(uiEn["swiss.refusal.SWISS_ADHOC_REFUSED"]!);
    expect(
      await adhocNote.evaluate((n) => n.parentElement === document.querySelector('[data-testid="stage-swiss-legend"]')?.parentElement),
      "the legend line carries it",
    ).toBe(true);
    await expect(card.getByTestId("stage-rail").getByTestId("stage-swiss-adhoc-note"), "and the action row does not").toHaveCount(0);

    // Play round 1 (a scorer's pads), pair round 2.
    for (const f of (await fixturesOf(stageId)).filter((x) => x.round_no === 1)) await scoreFixture(request, f.id, 2, 0);
    await page.reload({ waitUntil: "load" });
    card = stageCardOf(page, stageId);
    await openRail(card);
    expect(await paired(2)).toBe(0);
    await card.getByTestId("stage-generate").click();
    await expect.poll(() => paired(2), { timeout: 20_000, message: "round 2 is seated" }).toBe(boards);

    // Play round 2: every match is played, and only then does Complete unlock.
    for (const f of (await fixturesOf(stageId)).filter((x) => x.round_no === 2)) await scoreFixture(request, f.id, 1, 0);
    await page.reload({ waitUntil: "load" });
    card = stageCardOf(page, stageId);
    await openRail(card);
    const done = card.getByTestId("stage-complete");
    await expect(done, "every match is played: Complete unlocks").not.toHaveAttribute("aria-disabled", "true");
    await expect(card.getByTestId("stage-complete-hint")).toHaveCount(0);
    await expect(card.getByTestId("stage-generate"), "no round left to pair").toHaveCount(0);
    await done.click();
    await expect
      .poll(async () => (await withDb((sql) => sql<{ status: string }[]>`select status from stages where id = ${stageId}`))[0]!.status, { timeout: 20_000, message: "the stage completes" })
      .toBe("complete");
    // Terminal state of the card, as the organiser meets it next: complete, and folded to its one line.
    await page.reload({ waitUntil: "load" });
    card = stageCardOf(page, stageId);
    const fold = card.getByTestId("stage-collapse-toggle");
    await expect(fold, "a completed stage's card is folded on arrival").toHaveAttribute("aria-expanded", "false");
    await expect(card.getByTestId("stage-collapsed-summary")).toHaveText(fill("runsheet.round.done.other", { done: matches, total: matches }));
    await expect(card.locator("h3 ~ .badge"), "the status pill").toHaveText(uiEn["schedule.sstatus.complete"]!);
    await expect(card.getByTestId("stage-controls"), "its buttons are away with it").toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(card.getByTestId("stage-controls"), "opened: its header is back").toBeVisible();
    await expectNoHorizontalScroll(page);

    // The competition page: the finished division is out of the list; Show finished brings it back, and the switch puts it away again.
    await page.goto(await competitionPath(request, competitionId), { waitUntil: "load" });
    await dismissCookieBanner(page);
    const rows = page.getByTestId("desk-ledger-row");
    const switchEl = page.getByTestId("desk-ledger-finished-toggle");
    await expect(rows, "a finished division is hidden by default").toHaveCount(0);
    await expect(switchEl).toContainText(fill("desk.ledger.showFinished", { n: 1 }));
    await expect(switchEl).toHaveAttribute("aria-checked", "false");
    await switchEl.click();
    await expect(page).toHaveURL(/[?&]finished=1(&|$)/);
    await expect(rows, "Show finished: the division is in the list").toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-phase", "finished");
    await expect(switchEl).toHaveAttribute("aria-checked", "true");
    await expectNoHorizontalScroll(page);
    await switchEl.click();
    await expect(page).not.toHaveURL(/[?&]finished=1(&|$)/);
    await expect(rows, "switched off: hidden again").toHaveCount(0);
    await expect(switchEl).toHaveAttribute("aria-checked", "false");
  });

  test("the Entrants tab: the kinds block sits above the roster, opens on an empty division, folds once there is an entrant, Save and Reset", async ({ page, request }) => {
    test.setTimeout(budget(5, 25));
    const seed = await seedDivision(request, "Kinds", { entrants: [], start: false });
    const { divisionId } = seed;
    const base = await divisionPath(request, divisionId);
    const toggle = page.getByRole("button", { name: new RegExp(`^${esc(uiEn["divset.entrants.kinds"]!)}`) });
    const chip = (kind: string): Locator => page.getByTestId("entrant-kinds").locator(`[data-kind="${kind}"]`);
    const stored = async (): Promise<{ kinds?: string[] } | undefined> =>
      (await apiJson<{ config: { entrants?: { kinds?: string[] } } }>(request, `/api/v1/divisions/${divisionId}`)).data!.config.entrants;

    // Settings carries none of it.
    await page.goto(`${base}?tab=settings`, { waitUntil: "load" });
    await dismissCookieBanner(page);
    await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: NAV_MS });
    await expect(toggle, "no entrant kinds group in Settings").toHaveCount(0);

    // The Entrants tab, empty: open by default, above the roster's add form.
    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await expect(toggle).toBeVisible({ timeout: NAV_MS });
    await expect(toggle, "an empty division opens the kinds block").toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("entrant-kinds")).toBeVisible();
    const header = await toggle.boundingBox();
    const addForm = await page.getByRole("heading", { name: uiEn["entrants.add.title"]! }).boundingBox();
    expect(header!.y, "the kinds sit above the roster").toBeLessThan(addForm!.y);
    let kindChips = 0;
    const KINDS = ["individual", "pair", "team"];
    for (const kind of KINDS) {
      await expect(chip(kind), `${kind}: a chip`).toHaveText(uiEn[`divset.entrants.kind.${kind}`]!);
      kindChips++;
    }
    expect(kindChips, "anti-vacuity: every kind is offered").toBe(KINDS.length);
    await expectNoHorizontalScroll(page);

    // One entrant in: the block folds under its one row.
    const first = await addEntrantsViaApi(request, divisionId, [`Kinds Probe ${TAG}`]);
    expect(first.status).toBeLessThan(300);
    await page.reload({ waitUntil: "load" });
    await expect(toggle, "a division with an entrant folds the block").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("entrant-kinds"), "folded: no body").toHaveCount(0);

    // Open, tick the opposite of Pair, Save.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("entrants-sport-default")).toBeVisible();
    const before = (await chip("pair").getAttribute("aria-pressed")) === "true";
    await chip("pair").click();
    await expect(chip("pair")).toHaveAttribute("aria-pressed", String(!before));
    await page.getByRole("button", { name: uiEn["divset.entrants.save"]! }).click();
    await expect(page.getByTestId("entrant-kinds-notice")).toHaveText(uiEn["divset.entrants.saved"]!, { timeout: 15_000 });
    expect((await stored())?.kinds?.includes("pair"), "the stored override carries the new Pair state").toBe(!before);

    // A reload keeps it, and names it as an override.
    await page.reload({ waitUntil: "load" });
    await toggle.click();
    await expect(chip("pair")).toHaveAttribute("aria-pressed", String(!before));
    await expect(page.getByTestId("entrants-sport-default"), "an override is saved: no sport-default caption").toHaveCount(0);

    // Reset: the override is dropped, and the chips follow the sport default again.
    await page.getByRole("button", { name: uiEn["divset.entrants.reset"]! }).click();
    await expect(page.getByTestId("entrant-kinds-notice")).toHaveText(uiEn["divset.entrants.resetDone"]!, { timeout: 15_000 });
    expect(await stored(), "the override key is gone").toBeUndefined();
    await expect(chip("pair"), "the chips follow the sport default").toHaveAttribute("aria-pressed", String(before), { timeout: 15_000 });
    await expect(page.getByTestId("entrants-sport-default")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
