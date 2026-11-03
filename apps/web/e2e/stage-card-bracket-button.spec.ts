// SCF fix round 1 (owner 2026-11-03: "should every knockout stage card get a Bracket button? Before fixtures exist it would be greyed
// out with 'Generate fixtures to see the bracket'. yes"), DRIVEN in a browser. `apps/web` vitest is environment:"node": it cannot see a
// bubble land, a link scroll, or a sheet close. The decision (`bracketAccess`) and the markup are `bracket-view.test.ts` and
// `stages-panel-stage-card.test.tsx`; this file is the half only a browser reaches:
//
//   - CARD placement (a knockout): greyed with its reason until Generate; a press on the greyed button opens nothing; Generate (the real
//     button, not an API call) turns it into the live toggle and the tree opens INSIDE the card.
//   - PAGE placement (a stepladder, a double elimination): a same-page link; clicking it brings the page-level tree into view (it was
//     out of view before); the tree is NOT inside the card.
//   - The carrom-ladder shape - a League, then Stepladder finals that take its top four: the League has no Bracket button at all, the
//     finals' card has one (greyed until its fixtures exist, then a link).
//   - The reason bubble stays inside the card at every width the header floats it (768, 1024, 1280), and on a phone the greyed row of the
//     Stage tools sheet shows it in flow; a page-tree link on a phone closes the sheet.
//
// Anti-vacuity: every sweep reports how many widths / kinds it checked, and zero is a failure.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, openStagePanel, stageCardOf } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { uiEn } from "./match-room-kit";

const NAV_MS = 20_000;
const SEED_MS = 45_000;
const ACT_MS = 3_000;
/** Derived from the work, never one flat number (AGENTS.md class 20): a seed, each navigation, each tap or measurement. */
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

type Req = APIRequestContext;
type StageSpec = { kind: string; name: string; config?: Record<string, unknown>; progression?: unknown };

const TOP_FOUR = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" };

/** A generic-sport division with `entrants` and `specs` as its stages, in order. Nothing is generated: the stages are empty. */
async function seed(request: Req, label: string, entrants: number, specs: StageSpec[]): Promise<{ divisionId: string; stageIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Bracket button ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  await addEntrantsViaApi(request, div.data!.id, Array.from({ length: entrants }, (_, i) => `B${i + 1} ${TAG}`));
  const stageIds: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: i + 1,
      kind: spec.kind,
      name: spec.name,
      config: spec.config ?? {},
      ...(spec.progression === undefined ? {} : { progression: spec.progression }),
    });
    expect(stage.status, `stage ${spec.kind}: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
    stageIds.push(stage.data!.id);
  }
  return { divisionId: div.data!.id, stageIds };
}

async function generate(request: Req, stageId: string): Promise<void> {
  const gen = await apiJson<{ created?: number }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
}

async function openFixtures(page: Page, request: Req, divisionId: string): Promise<void> {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
}

/** `inner` lies inside `outer` (a pixel of slack for rounding). */
async function expectInside(inner: Locator, outer: Locator, label: string): Promise<void> {
  const i = (await inner.boundingBox())!;
  const o = (await outer.boundingBox())!;
  expect(i, `${label}: measured`).toBeTruthy();
  expect(i.x, `${label}: left edge inside`).toBeGreaterThanOrEqual(o.x - 1);
  expect(i.x + i.width, `${label}: right edge inside`).toBeLessThanOrEqual(o.x + o.width + 1);
}

/** The element is on screen (any part of it) - the page really scrolled to it. */
async function onScreen(page: Page, loc: Locator): Promise<boolean> {
  const box = await loc.boundingBox();
  const vh = page.viewportSize()!.height;
  return box !== null && box.y < vh && box.y + box.height > 0;
}

const GENERATE_FIRST = uiEn["bracket.generateFirst"]!;

test.describe("Bracket button: card placement (a knockout)", () => {
  test("greyed with its reason until Generate; a press opens nothing; Generate (the real button) makes it the live toggle", async ({ page, request }) => {
    test.setTimeout(budget(2, 14));
    const { divisionId, stageIds } = await seed(request, "card", 8, [{ kind: "knockout", name: "Knockout" }]);
    const stageId = stageIds[0]!;
    await openFixtures(page, request, divisionId);
    const card = stageCardOf(page, stageId);
    await expect(card, "the stage card is on the Fixtures tab").toBeVisible({ timeout: NAV_MS });

    const tool = card.getByTestId("stage-tool-bracket");
    const bubble = card.getByTestId("stage-tool-bracket-hint");
    await expect(tool, "a knockout with no fixtures still has the button").toBeVisible();
    await expect(tool).toHaveAttribute("aria-disabled", "true");
    await expect(tool, "greyed, not a disclosure").not.toHaveAttribute("aria-expanded", /.*/);
    await expect(tool, "described by its bubble").toHaveAttribute("aria-describedby", `stage-tool-bracket-hint-${stageId}`);
    await expect(bubble, "closed until asked").toBeHidden();

    // Hover shows the reason; it sits inside the card (it is the last button in a right-aligned group).
    await tool.hover();
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveText(GENERATE_FIRST);
    await expectInside(bubble, card, "the bubble in the card");
    await page.mouse.move(0, 0);
    await expect(bubble).toBeHidden();

    // Keyboard focus shows it too: the button is in the tab order (aria-disabled, not disabled).
    await tool.focus();
    await expect(bubble, "focus shows the reason").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bubble, "Escape puts it away").toBeHidden();

    // A press on the greyed button opens no tree and does not become a disclosure.
    await tool.click({ force: true });
    await expect(card.getByTestId("stage-bracket"), "nothing opened").toHaveCount(0);
    await expect(page.getByTestId("bracket-panel")).toHaveCount(0);
    await expect(tool).not.toHaveAttribute("aria-expanded", /.*/);

    // Generate: the real button on the card. The same Bracket button is now the live toggle.
    await card.getByTestId("stage-generate").click();
    await expect(tool, "after Generate the button is the toggle").toHaveAttribute("aria-expanded", "false", { timeout: NAV_MS });
    await expect(tool).not.toHaveAttribute("aria-disabled", /.*/);
    await expect(card.getByTestId("stage-tool-bracket-hint"), "the bubble went with the greying").toHaveCount(0);
    await openStagePanel(card, "bracket");
    await expect(card.getByTestId("bracket-panel"), "the tree opened inside the card").toBeVisible();
    await expect(card.locator('[data-testid="bracket-panel"] a[href*="/f/"]').first(), "and draws the stage's matches").toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  for (const width of [768, 1024, 1280]) {
    test(`the reason bubble stays inside the card and the viewport at ${width}px (a knockout and a stepladder before Generate)`, async ({ page, request }) => {
      test.setTimeout(budget(1, 8));
      await page.setViewportSize({ width, height: 900 });
      const { divisionId, stageIds } = await seed(request, `bubble-${width}`, 8, [
        { kind: "knockout", name: "Knockout" },
        { kind: "stepladder", name: "Stepladder" },
      ]);
      await openFixtures(page, request, divisionId);
      let checked = 0;
      for (const stageId of stageIds) {
        const card = stageCardOf(page, stageId);
        await expect(card).toBeVisible({ timeout: NAV_MS });
        const tool = card.getByTestId("stage-tool-bracket");
        await tool.hover();
        const bubble = card.getByTestId("stage-tool-bracket-hint");
        await expect(bubble).toBeVisible();
        await expectInside(bubble, card, `${width}px bubble`);
        const box = (await bubble.boundingBox())!;
        expect(box.x, `${width}px: not off the left of the screen`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${width}px: not off the right of the screen`).toBeLessThanOrEqual(width);
        await page.mouse.move(0, 0);
        checked++;
      }
      expect(checked, "anti-vacuity: both cards measured").toBe(2);
      await expectNoHorizontalScroll(page);
    });
  }
});

test.describe("Bracket button: page placement (a stepladder)", () => {
  test("a same-page link: out of view before, the page-level tree in view after the click; the card draws no tree of its own", async ({ page, request }) => {
    test.setTimeout(budget(2, 10));
    await page.setViewportSize({ width: 1280, height: 600 });
    const { divisionId, stageIds } = await seed(request, "page", 4, [{ kind: "stepladder", name: "Stepladder" }]);
    const stageId = stageIds[0]!;
    // Greyed first: no rungs yet, so the page has no tree to jump to.
    await openFixtures(page, request, divisionId);
    const card = stageCardOf(page, stageId);
    await expect(card).toBeVisible({ timeout: NAV_MS });
    await expect(card.getByTestId("stage-tool-bracket"), "before Generate: greyed").toHaveAttribute("aria-disabled", "true");
    await expect(page.locator(`#bracket-${stageId}`), "and there is no tree anchor on the page yet").toHaveCount(0);

    await generate(request, stageId);
    await openFixtures(page, request, divisionId);
    const link = card.getByTestId("stage-tool-bracket");
    await expect(link, "after Generate: a link, not a button").toHaveJSProperty("tagName", "A", { timeout: NAV_MS });
    await expect(link).toHaveAttribute("href", `#bracket-${stageId}`);
    await expect(link).not.toHaveAttribute("aria-disabled", /.*/);
    await expect(link).not.toHaveAttribute("aria-expanded", /.*/);
    const target = page.locator(`#bracket-${stageId}`);
    await expect(target, "the page's tree anchor").toHaveCount(1);
    await expect(target.getByTestId("bracket-panel-ladder"), "holds the page-level tree").toBeVisible();
    await expect(card.getByTestId("bracket-panel-ladder"), "the card draws no tree of its own").toHaveCount(0);

    // Out of view first (scroll to the foot of the page), then the click brings it into view.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await link.scrollIntoViewIfNeeded();
    expect(await onScreen(page, target), "premise: the tree is out of view before the click").toBe(false);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#bracket-${stageId}$`));
    await expect.poll(() => onScreen(page, target), { message: "the click scrolled the page-level tree into view", timeout: ACT_MS * 2 }).toBe(true);
    const top = (await target.boundingBox())!.y;
    expect(top, "the tree starts on screen, not above the fold").toBeGreaterThanOrEqual(0);
    await expectNoHorizontalScroll(page);
  });

  test("a double elimination links to its two-lane tree the same way", async ({ page, request }) => {
    test.setTimeout(budget(1, 6));
    await page.setViewportSize({ width: 1280, height: 600 });
    const { divisionId, stageIds } = await seed(request, "de", 4, [{ kind: "double_elim", name: "Double elim" }]);
    const stageId = stageIds[0]!;
    await generate(request, stageId);
    await openFixtures(page, request, divisionId);
    const card = stageCardOf(page, stageId);
    const link = card.getByTestId("stage-tool-bracket");
    await expect(link).toHaveJSProperty("tagName", "A", { timeout: NAV_MS });
    await expect(link).toHaveAttribute("href", `#bracket-${stageId}`);
    await expect(page.locator(`#bracket-${stageId}`).getByTestId("bracket-panel-de"), "the anchor holds the two-lane tree").toBeVisible();
    await expect(card.getByTestId("bracket-panel-de"), "outside the card").toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#bracket-${stageId}$`));
    await expect.poll(() => onScreen(page, page.locator(`#bracket-${stageId}`)), { timeout: ACT_MS * 2 }).toBe(true);
  });
});

test.describe("Bracket button: the carrom-ladder shape (a League, then Stepladder finals)", () => {
  test("the League has no Bracket button; the finals' card has one - greyed until its fixtures exist, then a link to the tree", async ({ page, request }) => {
    test.setTimeout(budget(2, 12));
    const { divisionId, stageIds } = await seed(request, "carrom", 6, [
      { kind: "league", name: "League", config: { legs: 1 } },
      { kind: "stepladder", name: "Stepladder finals", progression: TOP_FOUR },
    ]);
    const [leagueId, finalsId] = stageIds as [string, string];
    await openFixtures(page, request, divisionId);
    const league = stageCardOf(page, leagueId);
    const finals = stageCardOf(page, finalsId);
    await expect(league).toBeVisible({ timeout: NAV_MS });
    await expect(finals).toBeVisible();
    await expect(league.getByTestId("stage-tool-bracket"), "a league is not a bracket: no button").toHaveCount(0);
    await expect(league.getByTestId("stage-sheet-tool-bracket")).toHaveCount(0);
    await expect(finals.getByTestId("stage-tool-bracket"), "the finals' card has one").toHaveAttribute("aria-disabled", "true");

    // Day one: generating both stages draws the finals' (TBD-seated) rung list at once, so the finals' button is a link now.
    await generate(request, leagueId);
    await generate(request, finalsId);
    await openFixtures(page, request, divisionId);
    await expect(finals.getByTestId("stage-tool-bracket")).toHaveJSProperty("tagName", "A", { timeout: NAV_MS });
    await expect(finals.getByTestId("stage-tool-bracket")).toHaveAttribute("href", `#bracket-${finalsId}`);
    await expect(page.locator(`#bracket-${finalsId}`).getByTestId("bracket-panel-ladder"), "the finals' tree is on the page").toBeVisible();
    await expect(league.getByTestId("stage-tool-bracket"), "still none on the league").toHaveCount(0);
    await finals.getByTestId("stage-tool-bracket").click();
    await expect(page).toHaveURL(new RegExp(`#bracket-${finalsId}$`));
    await expectNoHorizontalScroll(page);
  });
});

test.describe("Bracket button: on a phone (the Stage tools sheet)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the greyed row shows its reason in flow and nothing overflows; a page-tree row is a link that closes the sheet", async ({ page, request }) => {
    test.setTimeout(budget(2, 16));
    const { divisionId, stageIds } = await seed(request, "phone", 8, [
      { kind: "knockout", name: "Knockout" },
      { kind: "stepladder", name: "Stepladder" },
    ]);
    const [koId, ladderId] = stageIds as [string, string];
    await openFixtures(page, request, divisionId);
    const ko = stageCardOf(page, koId);
    await expect(ko).toBeVisible({ timeout: NAV_MS });
    // The header's twin is away on a phone (an editor); the row lives on the card's one sheet.
    await expect(ko.getByTestId("stage-tool-bracket")).toBeHidden();
    const trigger = ko.getByTestId("stage-rail-trigger");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const row = ko.getByTestId("stage-sheet-tool-bracket");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-disabled", "true");
    expect((await row.boundingBox())!.height, "44px tap floor").toBeGreaterThanOrEqual(44);
    const bubble = ko.getByTestId("stage-sheet-tool-bracket-hint");
    await expect(bubble, "closed until tapped").toBeHidden();
    await row.click({ force: true });
    await expect(bubble, "a tap shows the reason in flow").toBeVisible();
    await expect(bubble).toHaveText(GENERATE_FIRST);
    const b = (await bubble.boundingBox())!;
    expect(b.x, "inside the screen, left").toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, "inside the screen, right").toBeLessThanOrEqual(390);
    await expect(trigger, "the tap did not close the sheet").toHaveAttribute("aria-expanded", "true");
    await expectNoHorizontalScroll(page);
    await page.keyboard.press("Escape"); // spends the bubble first
    await page.keyboard.press("Escape"); // then the sheet

    // The stepladder, once it has rungs: its row is a link; tapping it closes the sheet and brings the page's tree into view.
    await generate(request, ladderId);
    await openFixtures(page, request, divisionId);
    const ladder = stageCardOf(page, ladderId);
    await ladder.getByTestId("stage-rail-trigger").click();
    const link = ladder.getByTestId("stage-sheet-tool-bracket");
    await expect(link).toHaveJSProperty("tagName", "A", { timeout: NAV_MS });
    await expect(link).toHaveAttribute("href", `#bracket-${ladderId}`);
    expect((await link.boundingBox())!.height, "44px tap floor").toBeGreaterThanOrEqual(44);
    await link.click();
    await expect(ladder.getByTestId("stage-rail-trigger"), "the tap closed the sheet").toHaveAttribute("aria-expanded", "false");
    await expect(page).toHaveURL(new RegExp(`#bracket-${ladderId}$`));
    await expect.poll(() => onScreen(page, page.locator(`#bracket-${ladderId}`)), { timeout: ACT_MS * 2 }).toBe(true);
    await expectNoHorizontalScroll(page);
  });
});
