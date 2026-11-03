// Task SCF (owner pick, Option A, 2026-11-03) - the stage card's action row, DRIVEN in a browser. `apps/web` vitest is environment:"node"
// (AGENTS.md class 2): it cannot see where a popover lands, whether the card grew, what a click hits, or which line a divider is on. This file
// is that half. The markup half (the sentence is on the legend line, the divider is the settings group's first child, Rounds is absent once
// the count is fixed) is `stages-panel-stage-card.test.tsx` / `stages-panel-swiss-pairing.test.tsx` / `stage-rail*.test.tsx`.
//
//   - From md (768) up, More and the Pair next ▾ panel are POPOVERS hung from their trigger: opening one leaves the card exactly as tall as it
//     was and moves nothing else; the menu is the topmost thing at every corner of its box (so nothing clips it, and nothing paints over it);
//     an outside press and Escape close it (Escape hands focus back to the trigger). Picking a radio in the pairing panel does NOT close it.
//   - The Swiss "paired by the system" sentence is information, not an action: it is on the stage's legend line, never in the action row,
//     and the row holds controls only.
//   - The thin divider is the settings group's own: it shares a line with the Match rules button, immediately left of it, at every width.
//   - "Rounds: N" is a real button until the count is fixed, and absent from the row after it.
//   - Below md the menus are what they always were: rows of the Stage tools sheet's column (position static, inside the sheet).
//
// Anti-vacuity: every sweep reports how many (widths, states, menus) it checked, and zero is a failure. One sport (generic): the header's
// geometry does not read the sport.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, scoreFixture, stageCardOf } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { uiEn } from "./match-room-kit";

const NAV_MS = 20_000;
const SEED_MS = 45_000;
const ACT_MS = 3_000;
/** Derived from the work, never one flat number (AGENTS.md class 20): a seed, each navigation, each tap or measurement. */
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

/** md and up, where the menus float: the owner's laptop, a small laptop, and the first width at which the rail is a row. */
const WIDTHS = [1280, 1024, 768] as const;

type Req = APIRequestContext;

interface Seed {
  divisionId: string;
  stageId: string;
}

async function seedDivision(request: Req, label: string, stage: { kind: string; name: string; config?: Record<string, unknown> }, entrants: number): Promise<Seed> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `SCF ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: label,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;
  const made = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, ...stage });
  expect(made.status, `stage: ${JSON.stringify(made.error)}`).toBeLessThan(300);
  const ents = await addEntrantsViaApi(request, divisionId, Array.from({ length: entrants }, (_, i) => `E${i + 1} ${TAG}`));
  expect(ents.ids, "entrants").toHaveLength(entrants);
  return { divisionId, stageId: made.data!.id };
}

interface Fx {
  id: string;
  round_no: number;
  home_entrant_id: string | null;
}
const fixturesOf = async (request: Req, divisionId: string): Promise<Fx[]> => {
  const res = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!;
};

type SwissState = "round-one-waiting" | "paired" | "played";

/** A Swiss over six entrants, three rounds, started. `round-one-waiting`: the shells only. `paired`: round 1 seated, nothing played (Rounds is
 *  still a button). `played`: one board of round 1 decided - the count is fixed now. */
async function seedSwiss(request: Req, label: string, state: SwissState): Promise<Seed> {
  const seed = await seedDivision(request, label, { kind: "swiss", name: "Swiss", config: { rounds: 3 } }, 6);
  const started = await apiJson(request, `/api/v1/divisions/${seed.divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  if (state !== "round-one-waiting") {
    const paired = await apiJson(request, `/api/v1/stages/${seed.stageId}/generate`, "POST");
    expect(paired.status, `pair round 1: ${JSON.stringify(paired.error)}`).toBeLessThan(300);
  }
  if (state === "played") {
    const seated = (await fixturesOf(request, seed.divisionId)).filter((f) => f.round_no === 1 && f.home_entrant_id !== null);
    expect(seated.length, "premise: round 1 is seated").toBeGreaterThan(0);
    await scoreFixture(request, seated[0]!.id, 2, 0);
  }
  return seed;
}

async function seedLeague(request: Req): Promise<Seed> {
  const seed = await seedDivision(request, "League", { kind: "league", name: "League" }, 3);
  const gen = await apiJson(request, `/api/v1/stages/${seed.stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${seed.divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  return seed;
}

async function openCard(page: Page, request: Req, seed: Seed, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(await divisionPath(request, seed.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const card = stageCardOf(page, seed.stageId);
  await expect(card, `@${width}: the stage card is on the Fixtures tab`).toBeVisible({ timeout: NAV_MS });
  return card;
}

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (l: Locator, what: string): Promise<Box> => {
  const b = await l.boundingBox();
  expect(b, `${what}: has a box on screen`).not.toBeNull();
  return b!;
};

/** The menu is the topmost thing at every corner of its box (inset a few px) and at its middle: nothing paints over it and no ancestor clips it. */
async function expectOnTop(menu: Locator, what: string): Promise<number> {
  const hits = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const inset = 4;
    const points: Array<[number, number]> = [
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
      [r.left + r.width / 2, r.top + r.height / 2],
    ];
    return points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return { x: Math.round(x), y: Math.round(y), inside: hit !== null && el.contains(hit), inViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight };
    });
  });
  for (const h of hits) {
    expect(h.inViewport, `${what}: the point (${h.x}, ${h.y}) is on screen`).toBe(true);
    expect(h.inside, `${what}: the menu is the topmost thing at (${h.x}, ${h.y})`).toBe(true);
  }
  return hits.length;
}

/** Everything that must NOT move when a floating menu opens: the card's height, and where the settings buttons sit. */
async function snapshot(card: Locator): Promise<{ card: Box; tools: Box }> {
  return { card: await boxOf(card, "the card"), tools: await boxOf(card.getByTestId("stage-tool-format"), "Match rules") };
}
function expectUnmoved(before: { card: Box; tools: Box }, after: { card: Box; tools: Box }, what: string): void {
  expect(Math.abs(after.card.height - before.card.height), `${what}: the card keeps its height (${before.card.height} -> ${after.card.height})`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.tools.y - before.tools.y), `${what}: the settings buttons stay where they were (${before.tools.y} -> ${after.tools.y})`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.tools.x - before.tools.x), `${what}: and do not slide sideways`).toBeLessThanOrEqual(1);
}

/** The `position` of the menu's popover box: the nearest `absolute` element from the menu up to the actions cluster, else "none". */
async function floatingAncestor(menu: Locator, stopAt = "stage-controls"): Promise<string> {
  return menu.evaluate((el, stop) => {
    for (let e: Element | null = el; e && e.getAttribute("data-testid") !== stop; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === "absolute") return p;
    }
    return "none";
  }, stopAt);
}

/** Open a menu from its trigger and prove it is a popover; returns the number of corners that hit it. */
async function expectFloats(page: Page, card: Locator, trigger: Locator, menu: Locator, what: string): Promise<number> {
  await expect(trigger, `${what}: positive pair - the trigger is on the card`).toBeVisible({ timeout: NAV_MS });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu, `${what}: closed to begin with`).toBeHidden();
  const before = await snapshot(card);
  await trigger.click();
  await expect(menu, `${what}: opens`).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await floatingAncestor(menu), `${what}: it is positioned over the content (an absolutely placed popover), not a row of the header`).toBe("absolute");
  expectUnmoved(before, await snapshot(card), what);
  // A card low on the page opens its popover below the fold (that is what a popover over the content does); bring it into view, THEN
  // hit-test its corners - the page scrolls, nothing re-lays out.
  await menu.scrollIntoViewIfNeeded();
  const corners = await expectOnTop(menu, what);
  await expectNoHorizontalScroll(page);
  return corners;
}

test.describe("SCF: the Swiss stage card's action row (Option A)", () => {
  test("More floats over a running Swiss: the card does not grow, the menu is on top, an outside press and Escape close it - at 1280, 1024 and 768", async ({ page, request }) => {
    test.setTimeout(budget(WIDTHS.length, WIDTHS.length * 14));
    const seed = await seedSwiss(request, "More", "paired");
    let widths = 0;
    let corners = 0;
    for (const width of WIDTHS) {
      const card = await openCard(page, request, seed, width);
      const more = card.getByTestId("stage-more");
      const menu = card.getByTestId("stage-more-menu");
      corners += await expectFloats(page, card, more, menu, `More @${width}`);
      // Read what is in it: the late-add item, in the dictionary's words.
      await expect(menu.getByTestId("stage-add-late-player"), `@${width}: the item is in the menu`).toContainText(uiEn["stage.more.addLatePlayer"]!);

      // Escape closes it and hands focus back to More.
      await page.keyboard.press("Escape");
      await expect(menu, `@${width}: Escape closes it`).toBeHidden();
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(more, `@${width}: focus is back on More`).toBeFocused();

      // An outside press closes it too (the card's title is nothing the menu listens to).
      await more.click();
      await expect(menu).toBeVisible();
      await card.locator("header h3").first().click();
      await expect(menu, `@${width}: a press elsewhere closes it`).toBeHidden();
      await expect(more).toHaveAttribute("aria-expanded", "false");

      // The same button toggles it (a press on the trigger is its own toggle, not an "outside" press that would reopen it).
      await more.click();
      await expect(menu).toBeVisible();
      await more.click();
      await expect(menu, `@${width}: a second press on More closes it`).toBeHidden();
      widths++;
    }
    expect(widths, "anti-vacuity: every width driven").toBe(WIDTHS.length);
    expect(corners, "anti-vacuity: corners hit-tested").toBeGreaterThan(0);
  });

  test("Pair next ▾ floats: round 1's radios, a pick keeps the panel open, an outside press and Escape close it, and the pick survives - at 1280, 1024 and 768", async ({ page, request }) => {
    test.setTimeout(budget(WIDTHS.length, WIDTHS.length * 16));
    const seed = await seedSwiss(request, "Pairing", "round-one-waiting");
    let widths = 0;
    for (const width of WIDTHS) {
      const card = await openCard(page, request, seed, width);
      const toggle = card.getByTestId("stage-pairing-toggle");
      const menu = card.getByTestId("stage-pairing-menu");
      await expectFloats(page, card, toggle, menu, `Pair next ▾ @${width}`);
      const radios = menu.getByRole("radio");
      expect(await radios.count(), `@${width}: round 1 offers a choice`).toBeGreaterThan(1);

      // Picking a radio is an INPUT to Pair next, not an action: the panel stays open with the pick checked.
      const unchecked = menu.locator('[role="radio"][aria-checked="false"]').first();
      const picked = await unchecked.getAttribute("data-pairing-mode");
      expect(picked, `@${width}: there is a mode that is not the checked one`).not.toBeNull();
      await unchecked.click();
      await expect(menu, `@${width}: picking a radio keeps the panel open`).toBeVisible();
      await expect(menu.locator(`[data-pairing-mode="${picked}"]`), `@${width}: and the pick is checked`).toHaveAttribute("aria-checked", "true");

      // An outside press puts it away; reopened, the pick is still the one checked (nothing used it yet).
      await card.locator("header h3").first().click();
      await expect(menu, `@${width}: a press elsewhere closes it`).toBeHidden();
      await toggle.click();
      await expect(menu.locator(`[data-pairing-mode="${picked}"]`), `@${width}: the pick survives a close`).toHaveAttribute("aria-checked", "true");

      // Escape closes it and hands focus back to the ▾.
      await page.keyboard.press("Escape");
      await expect(menu, `@${width}: Escape closes it`).toBeHidden();
      await expect(toggle, `@${width}: focus is back on the toggle`).toBeFocused();
      widths++;
    }
    expect(widths, "anti-vacuity: every width driven").toBe(WIDTHS.length);
  });

  test("Pair next ▾ on a later round: the read-only panel floats too, over a header that holds More as well", async ({ page, request }) => {
    test.setTimeout(budget(WIDTHS.length, WIDTHS.length * 10));
    const seed = await seedSwiss(request, "Later round", "paired");
    let widths = 0;
    for (const width of WIDTHS) {
      const card = await openCard(page, request, seed, width);
      const toggle = card.getByTestId("stage-pairing-toggle");
      const menu = card.getByTestId("stage-pairing-menu");
      await expectFloats(page, card, toggle, menu, `Pair next ▾ (round 2) @${width}`);
      await expect(menu.getByTestId("stage-pairing-readonly"), `@${width}: round 2 is read-only`).toBeVisible();
      await expect(card.getByTestId("stage-more"), `@${width}: More is on the same card`).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      widths++;
    }
    expect(widths).toBe(WIDTHS.length);
  });

  test("the Swiss sentence is on the legend line, not in the action row; the row holds controls only - at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(budget(3, 12));
    const seed = await seedSwiss(request, "Sentence", "paired");
    const sentence = uiEn["swiss.refusal.SWISS_ADHOC_REFUSED"]!;
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      const card = await openCard(page, request, seed, width);
      const note = card.getByTestId("stage-swiss-adhoc-note");
      const legend = card.getByTestId("stage-swiss-legend");
      await expect(legend, `@${width}: positive pair - the legend line is there`).toBeVisible();
      await expect(note, `@${width}: the sentence is visible without opening anything`).toBeVisible();
      await expect(note).toHaveText(sentence);
      // Same line: one container holds both, and the note sits after the legend.
      const shared = await note.evaluate((n) => n.parentElement === document.querySelector('[data-testid="stage-swiss-legend"]')?.parentElement);
      expect(shared, `@${width}: the sentence shares the legend's container`).toBe(true);
      const [l, n] = [await boxOf(legend, "legend"), await boxOf(note, "sentence")];
      expect(n.y + n.height, `@${width}: the sentence is below or beside the legend, never above it`).toBeGreaterThanOrEqual(l.y);
      // Not in the action row: the rail holds no sentence, no paragraph, and every piece of text in it is a control's.
      const rail = card.getByTestId("stage-rail");
      await expect(rail.getByTestId("stage-swiss-adhoc-note"), `@${width}: the rail does not hold it`).toHaveCount(0);
      if (width >= 768) {
        const stray = await rail.evaluate((root) => {
          const out: string[] = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let checked = 0;
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            const text = (t.textContent ?? "").trim();
            if (text === "" || (t.parentElement && getComputedStyle(t.parentElement).display === "none")) continue;
            checked++;
            if (t.parentElement?.closest("button, a[href], [role='button'], [role='menuitem'], [role='radio']") === null) out.push(text);
          }
          return { stray: out, checked };
        });
        expect(stray.checked, `@${width}: anti-vacuity - the row has text to check`).toBeGreaterThan(0);
        expect(stray.stray, `@${width}: the row holds controls only`).toEqual([]);
      }
      await expectNoHorizontalScroll(page);
      widths++;
    }
    expect(widths, "anti-vacuity: every width read").toBe(3);
  });

  test("the divider is the settings group's: it shares a line with Match rules, immediately left of it - Swiss paired, Swiss played, and a league - at 1280, 1024 and 768", async ({ page, request }) => {
    test.setTimeout(budget(WIDTHS.length * 3, WIDTHS.length * 3 * 10));
    const swissPaired = await seedSwiss(request, "Divider paired", "paired");
    const swissPlayed = await seedSwiss(request, "Divider played", "played");
    const league = await seedLeague(request);
    const cases: Array<[string, Seed]> = [
      ["Swiss, round 1 paired", swissPaired],
      ["Swiss, a board played", swissPlayed],
      ["league", league],
    ];
    let checked = 0;
    for (const [name, seed] of cases) {
      for (const width of WIDTHS) {
        const card = await openCard(page, request, seed, width);
        const divider = card.getByTestId("stage-controls-divider");
        const rules = card.getByTestId("stage-tool-format");
        await expect(rules, `${name} @${width}: positive pair - Match rules is on the card`).toBeVisible();
        await expect(divider, `${name} @${width}: the divider is drawn (the row has a control)`).toBeVisible();
        const [d, r] = [await boxOf(divider, "divider"), await boxOf(rules, "Match rules")];
        const dMid = d.y + d.height / 2;
        expect(dMid, `${name} @${width}: the divider shares Match rules' line`).toBeGreaterThanOrEqual(r.y);
        expect(dMid, `${name} @${width}: the divider shares Match rules' line`).toBeLessThanOrEqual(r.y + r.height);
        expect(d.x + d.width, `${name} @${width}: it is left of Match rules`).toBeLessThanOrEqual(r.x + 1);
        expect(r.x - (d.x + d.width), `${name} @${width}: and right beside it, not stranded across the header`).toBeLessThanOrEqual(24);
        expect(d.width, `${name} @${width}: a thin rule`).toBeLessThanOrEqual(2);
        // It is inside the settings group, whatever the header does.
        expect(await divider.evaluate((el) => el.parentElement?.getAttribute("data-testid")), `${name} @${width}: the settings group's child`).toBe("stage-tools-group");
        // Where it lands: on the actions' line with the group (wide), or - when the header wraps - leading the settings group's own line, always
        // with Match rules right beside it. It can never be left behind at the end of the actions' line, which is what stranded it before.
        const lineMates = await card.getByTestId("stage-controls").evaluate((root, y) => {
          const out: string[] = [];
          for (const el of root.querySelectorAll<HTMLElement>("button, a[href]")) {
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            if (y >= b.top && y <= b.bottom) out.push(el.getAttribute("data-testid") ?? el.textContent ?? "?");
          }
          return out;
        }, dMid);
        expect(lineMates, `${name} @${width}: the divider's line holds Match rules`).toContain("stage-tool-format");
        console.log(`SCF divider ${name} @${width}: divider x${Math.round(d.x)} y${Math.round(d.y)}, rules x${Math.round(r.x)} y${Math.round(r.y)}, line: ${lineMates.join(", ")}`);
        await expectNoHorizontalScroll(page);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every (state, width) pair checked").toBe(cases.length * WIDTHS.length);
  });

  test("Rounds: a real button until the count is fixed, absent from the row after it - and the legend says the count either way", async ({ page, request }) => {
    test.setTimeout(budget(2, 8));
    const editable = await seedSwiss(request, "Rounds editable", "paired");
    const fixed = await seedSwiss(request, "Rounds fixed", "played");
    const roundsText = uiEn["stage.swissLegend.rounds.other"]!.replace("{count}", "3");

    let card = await openCard(page, request, editable, 1280);
    const button = card.getByTestId("stage-rounds");
    await expect(button, "before the first start: Rounds is a button").toBeVisible();
    await expect(button).toHaveAttribute("data-state", "editable");
    expect(await button.evaluate((el) => el.tagName), "a real <button>, not a span shaped like one").toBe("BUTTON");
    await expect(card.getByTestId("stage-rail").getByRole("button", { name: /Rounds: 3/ }), "and it is reachable by its name").toBeVisible();
    await expect(card.getByTestId("stage-swiss-legend")).toContainText(roundsText);

    card = await openCard(page, request, fixed, 1280);
    await expect(card.getByTestId("stage-swiss-legend"), "positive pair: the legend line says the count").toContainText(roundsText);
    await expect(card.getByTestId("stage-generate"), "positive pair: the row drew its other controls").toBeVisible();
    await expect(card.getByTestId("stage-rounds"), "once a board has started the row draws nothing for the count").toHaveCount(0);
  });

  test("phones keep today's bottom sheet: below md the menus are rows of the Stage tools sheet (in flow, inside it), at 320", async ({ page, request }) => {
    test.setTimeout(budget(2, 16));
    const waiting = await seedSwiss(request, "Phone pairing", "round-one-waiting");
    const paired = await seedSwiss(request, "Phone more", "paired");
    let menus = 0;
    for (const [seed, trigger, menuId] of [
      [waiting, "stage-pairing-toggle", "stage-pairing-menu"],
      [paired, "stage-more", "stage-more-menu"],
    ] as const) {
      const card = await openCard(page, request, seed, 320);
      const sheetTrigger = card.getByTestId("stage-rail-trigger");
      await expect(sheetTrigger, "320: the actions are behind the Stage tools trigger").toBeVisible();
      await sheetTrigger.click();
      const sheet = card.getByTestId("stage-rail-sheet");
      await expect(sheet).toBeVisible();
      await card.getByTestId(trigger).click();
      const menu = card.getByTestId(menuId);
      await expect(menu, `${menuId} opens in the sheet`).toBeVisible();
      expect(await floatingAncestor(menu, "stage-rail-sheet"), `${menuId}: in flow below md, not floating`).toBe("none");
      const [m, s] = [await boxOf(menu, "menu"), await boxOf(sheet, "sheet")];
      expect(m.x, `${menuId}: inside the sheet on the left`).toBeGreaterThanOrEqual(s.x - 1);
      expect(m.x + m.width, `${menuId}: inside the sheet on the right`).toBeLessThanOrEqual(s.x + s.width + 1);
      await expectNoHorizontalScroll(page);
      menus++;
    }
    expect(menus, "anti-vacuity: both menus driven on a phone").toBe(2);
  });
});
