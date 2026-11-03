import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type AnySportModule, type TiebreakerKey } from "@seazn/engine/sport";
import { STAGE_TEMPLATES, buildTemplateStages } from "../../src/lib/format-templates";
import { PAIR_MINTING_STAGE_KINDS } from "../../src/lib/chess-individual-only-rule";
import { TAG, apiJson, competitionPath, expectNoHorizontalScroll, pickBuilderSport, showAllFormats, withDb } from "../helpers";
import { fill, uiEn as L } from "../match-room-kit";
import { dismissCookieBanner } from "../scorepad-a11y-kit";

/**
 * Match Day C9 — an organiser makes a division through the four-step builder
 * (Who plays, Format, Division rules, Review; owner 2026-11-02), from the
 * competition page's "Add division" to the new division's Fixtures tab.
 *
 * Every step is tapped: the name refused empty, the sport, the entrant kind
 * (asked at creation since C9), the category, the folded age and note, Back
 * and Next with nothing lost, the plan, Show all, a format and its knobs, the
 * Division rules strip in its draft mode (variant, points, tie-break order),
 * the folded schedule, the Review receipt, Edit from Review and straight back,
 * and Create. Then the system's own record is read back from the DATABASE —
 * divisions, stages and schedule_settings rows — field by field.
 *
 * ## What the read-back is held to
 *
 * Not to the builder: the expected values come from what was typed, the
 * engine's own declarations (the variant presets, the entrant model, the
 * sport's tie-break order) and `buildTemplateStages` — the format catalogue the
 * builder submits through, unchanged by C9 — so "the payload is unchanged"
 * means the same stages any earlier builder sent for the same knobs.
 *
 * ## A lost answer (C9 fix round 1, I1)
 *
 * The first stages request reaches the server, which makes the stages, and its
 * answer is then lost (Playwright fetches it and aborts it to the page): the
 * organiser sees a refusal on Format, the steps already saved with the division
 * read-only and saying so, and Create again REPLACES the stages. The database
 * then holds one division with the values typed before the refusal and the
 * format's stages once - a second append would have doubled them.
 *
 * ## Chess
 *
 * The second test is chess with online play: on Division rules, online play is
 * asked BEFORE the variant (owner 2026-11-02), Lichess without one of its eight
 * controls is refused on that step, and the control picked is the clock the
 * division stores. CI offers online chess to every walkthrough
 * (ONLINE_CHESS_ALWAYS=1, e2e.yml); a server without it would not draw the
 * Online play control, and the test says so rather than skipping.
 *
 * ## The pickers (C9 R2, owner 2026-11-03)
 *
 * Sport is a tile per sport (mock "Sport A"), five shown and a Show more tile
 * as the sixth cell; the Format grid keeps its cards and its Show more is the
 * sixth cell too. Both grids are measured collapsed and opened at every width
 * (the tile is the grid's last cell, 44px targets, two or three sport tiles to
 * a row, one or two format cards), with a shot of each. The keyboard moves the
 * sport pick between the SHOWN tiles. After the chess division is made, the
 * builder's sport order is read against the organisation's own division rows:
 * its sports most recent first, then the owner's popular five, the registry,
 * and "Any other game" last.
 *
 * ## The entrant kind (C9 review 2, owner n3 "yes", 2026-11-03)
 *
 * The kind shown on Who plays narrows the division to that kind ALWAYS -
 * clicked (the first test: generic, Teams) or left at the sport's default (the
 * third: volleyball, Teams untouched) - and Review says the one kind it takes.
 * Format offers what the DIVISION's kind can play (N1): Americano and Mexicano
 * pair up individual players, so badminton at Individuals offers them, after
 * every other card, and badminton at Pairs (or a Teams division) offers
 * neither; an Americano picked before the kind changed is dropped.
 *
 * ## Widths
 *
 * The walk runs at 1280. At every step it is also measured at 1280, 1024, 768
 * and 320: no horizontal page scroll, the four step buttons and the footer
 * actions at least 44px tall, and ONE DOM (below md the step names fold to
 * their numbers and a "Step n of 4" line names the step; from md the line is
 * hidden). Each measurement leaves a full-page screenshot in the test's output
 * directory, which is where the visual sign-off reads them from.
 */

/** A derived budget (AGENTS.md 20): navigations at 20s, every tap/type/read at 2.5s, and each width sweep its four widths. */
const NAV_MS = 20_000;
const ACT_MS = 2_500;
const WIDTHS = [1280, 1024, 768, 320] as const;
const SWEEP_MS = WIDTHS.length * 4 * ACT_MS;
const budget = (navs: number, acts: number, sweeps: number) => Math.max(90_000, navs * NAV_MS + acts * ACT_MS + sweeps * SWEEP_MS);

const STEPS = ["who", "format", "rules", "review"] as const;
type Step = (typeof STEPS)[number];
const STEP_NAME: Record<Step, string> = {
  who: L["divBuilder.step.who"]!,
  format: L["wizard.tab.format"]!,
  rules: L["rulesStrip.title"]!,
  review: L["divBuilder.step.review"]!,
};
const plural = (key: string, count: number) => fill(`${key}.${count === 1 ? "one" : "other"}`, { count });

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return m as AnySportModule;
};

const builder = (page: Page) => page.getByTestId("division-builder");
const onStep = (page: Page, step: Step) => expect(builder(page)).toHaveAttribute("data-step", step);
const stepButton = (page: Page, step: Step) => page.getByTestId(`division-builder-step-${step}`);
const next = (page: Page) => page.getByTestId("division-builder-next").click();
const reviewRow = (page: Page, id: string) => page.locator(`[data-review-row="${id}"]`);

/** The owner's popular sports, in his order (C9 R2 brief, 2026-11-03). */
const POPULAR = ["football", "cricket", "badminton", "tennis", "tabletennis"];
const REGISTRY = builtinModules.map((m) => m.key);
/** The partner-rotation formats by the declarations: the live templates whose stages mint pairs. */
const MINTING = STAGE_TEMPLATES.filter(
  (t) => !t.retired && t.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 }).some((s) => PAIR_MINTING_STAGE_KINDS.includes(s.kind)),
).map((t) => t.key);

/** Every sport tile, in the picker's (DOM) order, folded or not. */
const sportTilesInOrder = (page: Page) => page.locator("label[data-sport]").evaluateAll((els) => els.map((el) => el.getAttribute("data-sport") ?? ""));
/** The sport tiles an organiser can see, in order. */
const shownSports = (page: Page) =>
  page.locator("label[data-sport]").evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-sport") ?? ""));
/** The format cards an organiser can see, in order. */
const shownTemplates = (page: Page) =>
  page.locator("label[data-template]").evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-template") ?? ""));

/**
 * The Sport picker's order as the C9 R2 brief rules it, worked out here from the RECORD (never from the builder): the
 * sports this organisation has run divisions in, most recent first, read as raw rows and ordered in JS; then the owner's
 * popular five; then the registry's order; then any other listed sport by name; "generic" last. Only the sports the
 * catalogue lists (the page's own `sports` rows) appear.
 */
async function sportOrderFromRecord(compId: string): Promise<string[]> {
  const { listed, runs } = await withDb(async (sql) => {
    const listed = await sql<{ key: string }[]>`select key from sports order by name`;
    const runs = await sql<{ sport_key: string; created_at: Date }[]>`
      select d.sport_key, d.created_at from divisions d where d.org_id = (select org_id from competitions where id = ${compId})`;
    return { listed: listed.map((r) => r.key), runs: [...runs] };
  });
  const recent = runs.sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).map((r) => r.sport_key);
  const out: string[] = [];
  for (const k of [...recent, ...POPULAR, ...REGISTRY, ...listed]) if (k !== "generic" && listed.includes(k) && !out.includes(k)) out.push(k);
  return listed.includes("generic") ? [...out, "generic"] : out;
}

/**
 * C9 R2: a picker grid measured collapsed and opened at every width - no horizontal page scroll, the Show more (or
 * Show fewer) tile the grid's LAST shown cell and the only one, five shown before it when collapsed, every cell a 44px
 * target, the columns the width asks for, and (`rowMatch`) the tile as tall as the card beside it. A shot of each.
 * Leaves the grid collapsed at 1280. No word in a shown cell breaks across lines. Counts what it measured.
 */
async function gridSweep(
  page: Page,
  testInfo: TestInfo,
  o: { label: string; section: string; grid: string; more: string; cols: (width: number) => number; rowMatch: boolean },
): Promise<void> {
  let checked = 0;
  let wordsMeasured = 0;
  const more = page.getByTestId(o.more);
  for (const open of [false, true]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    if ((await more.getAttribute("aria-expanded")) !== String(open)) await more.click();
    await expect(more).toHaveAttribute("aria-expanded", String(open));
    for (const width of WIDTHS) {
      const at = `${o.label} ${open ? "opened" : "collapsed"} @${width}`;
      await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
      await expectNoHorizontalScroll(page);
      const cells = await page.getByTestId(o.grid).evaluate((grid) =>
        [...grid.children]
          .filter((c) => c.getClientRects().length > 0)
          .map((c) => {
            const r = c.getBoundingClientRect();
            return { tile: c.tagName === "BUTTON", x: Math.round(r.x), y: Math.round(r.y), h: r.height, dashed: getComputedStyle(c).borderTopStyle === "dashed" };
          }),
      );
      expect(cells.filter((c) => c.tile), `${at}: one Show more tile`).toHaveLength(1);
      expect(cells.at(-1)?.tile, `${at}: the tile is the grid's last cell`).toBe(true);
      expect(cells.at(-1)?.dashed, `${at}: the tile's edge is dashed`).toBe(true);
      if (!open) expect(cells.length, `${at}: five, then the tile`).toBe(6);
      for (const c of cells) expect(c.h, `${at}: a 44px target`).toBeGreaterThanOrEqual(44);
      expect(cells.filter((c) => c.y === cells[0]!.y).length, `${at}: ${o.cols(width)} to a row`).toBe(o.cols(width));
      if (o.rowMatch && o.cols(width) > 1) {
        const tile = cells.at(-1)!;
        const mate = cells.find((c) => !c.tile && c.y === tile.y);
        if (!open) expect(mate, `${at}: the tile shares its row with the fifth card`).toBeDefined();
        if (mate) expect(Math.abs(mate.h - tile.h), `${at}: the tile is as tall as the card beside it`).toBeLessThanOrEqual(1);
      }
      // No name or line breaks INSIDE a word (a two-column phone tile once printed "Badmint / on"): every word of every
      // shown cell, measured as a Range, sits on one line. A hyphen or slash is a break the browser may take.
      const words = await page.getByTestId(o.grid).evaluate((grid) => {
        let seen = 0;
        const broken: string[] = [];
        for (const cell of [...grid.children].filter((c) => c.getClientRects().length > 0)) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (const m of (n.textContent ?? "").matchAll(/[^\s\-–—/]+/g)) {
              const range = document.createRange();
              range.setStart(n, m.index);
              range.setEnd(n, m.index + m[0].length);
              const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
              if (lines.size === 0) continue;
              seen++;
              if (lines.size > 1) broken.push(m[0]);
            }
          }
        }
        return { seen, broken };
      });
      expect(words.broken, `${at}: no word breaks across lines`).toEqual([]);
      expect(words.seen, `${at}: words measured`).toBeGreaterThan(0);
      wordsMeasured += words.seen;
      await page.getByTestId(o.section).screenshot({ path: testInfo.outputPath(`${o.label}-${open ? "opened" : "collapsed"}-${width}.png`) });
      checked++;
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  expect(checked).toBe(WIDTHS.length * 2);
  expect(wordsMeasured, "anti-vacuity: words measured across the sweep").toBeGreaterThan(0);
  console.info(`[gridSweep] ${o.label}: ${checked} views, ${wordsMeasured} words measured`);
}

/** Measure the step on screen at every width, then come back to 1280. Counts what it checked: four widths, each with
 *  four step buttons and at least one footer action. */
async function sweep(page: Page, testInfo: TestInfo, step: Step, label: string): Promise<void> {
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
    await onStep(page, step);
    await expectNoHorizontalScroll(page);
    // One DOM: the same four buttons at every width; below md the name folds and a line names the step instead.
    for (const s of STEPS) {
      // The same name at every width: below md it is sr-only, never gone.
      await expect(stepButton(page, s)).toHaveAccessibleName(STEP_NAME[s]);
      const box = await stepButton(page, s).boundingBox();
      expect(box, `${label} @${width}: the ${s} step button has a box`).not.toBeNull();
      expect(box!.height, `${label} @${width}: the ${s} step button is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    const line = page.getByTestId("division-builder-step-label");
    if (width < 768) await expect(line).toContainText(`${fill("divBuilder.stepOf", { n: STEPS.indexOf(step) + 1, total: 4 })}`);
    else await expect(line).toBeHidden();
    let actions = 0;
    for (const id of ["division-builder-back", "division-builder-next", "division-builder-create", "division-builder-back-to-review"]) {
      const action = page.getByTestId(id);
      if (!(await action.isVisible())) continue;
      const box = await action.boundingBox();
      expect(box!.height, `${label} @${width}: ${id} is a 44px target`).toBeGreaterThanOrEqual(44);
      actions++;
    }
    expect(actions, `${label} @${width}: the footer carries an action`).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath(`${label}-${width}.png`), fullPage: true });
    checked++;
  }
  expect(checked).toBe(WIDTHS.length);
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The competition page's own "+ Add division" (no division yet), tapped. */
async function openBuilderFromCompetition(page: Page, request: import("@playwright/test").APIRequestContext, name: string): Promise<string> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `${name} ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
    ends_on: "2030-12-31",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBe(201);
  const path = await competitionPath(request, comp.data!.id);
  await page.goto(path);
  await dismissCookieBanner(page);
  await page.getByRole("link", { name: `+ ${L["action.addDivision"]}`, exact: true }).click();
  await page.waitForURL(/\/d\/new$/, { timeout: NAV_MS });
  await expect(page.getByTestId("division-builder-name")).toBeVisible({ timeout: NAV_MS });
  return comp.data!.id;
}

/** The format card for a template key (the radio is `sr-only` inside the card's label), checked to carry its title. */
async function card(page: Page, key: string): Promise<Locator> {
  const el = page.locator(`label[data-template="${key}"]`);
  await expect(el).toHaveCount(1);
  await expect(el).toContainText(L[`format.template.${key}.label`]!);
  return el;
}

type DivisionRow = {
  id: string;
  slug: string;
  name: string;
  sport_key: string;
  variant_key: string;
  config: Record<string, unknown>;
  tiebreakers: TiebreakerKey[] | null;
  category: string | null;
  age_max: number | null;
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  eligibility_note: string | null;
  camera_policy: string | null;
};
type StageRow = { seq: number; kind: string; name: string; config: Record<string, unknown>; progression: unknown };

async function readBack(
  slug: string,
  competitionId: string,
): Promise<{ division: DivisionRow; stages: StageRow[]; schedule: Record<string, unknown> | null; divisionsInCompetition: number }> {
  return withDb(async (sql) => {
    const [division] = await sql<DivisionRow[]>`
      select id, slug, name, sport_key, variant_key, config, tiebreakers, category, age_max, age_cutoff_month, age_cutoff_day, eligibility_note,
             camera_policy
      from divisions where competition_id = ${competitionId} and slug = ${slug}`;
    if (!division) throw new Error(`no division ${slug} in ${competitionId}`);
    const stages = await sql<StageRow[]>`select seq, kind, name, config, progression from stages where division_id = ${division.id} order by seq`;
    const [schedule] = await sql<{ config: Record<string, unknown> }[]>`select config from schedule_settings where division_id = ${division.id}`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where competition_id = ${competitionId}`;
    return { division, stages: [...stages], schedule: schedule?.config ?? null, divisionsInCompetition: n };
  });
}

/** Lands on the new division's Fixtures tab (owner, C9): its slug, from the URL. */
async function landed(page: Page): Promise<string> {
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+\?tab=fixtures$/, { timeout: NAV_MS });
  return page.url().match(/\/d\/([^/?]+)/)![1]!;
}

test("an organiser makes a division in four steps, edits it from Review, and the record holds every field", async ({ page, request }, testInfo) => {
  test.setTimeout(budget(5, 120, 8));
  const G = mod("generic");
  const model = effectiveEntrantModel(G.entrantModel ?? null, null);
  // A kind that is NOT the sport's default, so the stored kind is the CLICKED one (n3 narrows an untouched one too: the
  // third test reads that back).
  const kind = model.kinds.find((k) => k !== model.defaultKind)!;
  expect(kind, "premise: generic allows a second entrant kind, Teams (owner Q3's case)").toBe("team");
  expect(model.kinds.length, "premise: generic allows more than the one kind picked").toBeGreaterThan(1);
  const variant = "score";
  const preset = (G.variants as Record<string, Record<string, unknown>>)[variant]!;
  const presetPoints = preset.points as Record<string, number>;
  expect(presetPoints.w, "premise: the preset pays a win something other than 4").not.toBe(4);
  const sportOrder = G.defaultTiebreakers("group", preset as never) as TiebreakerKey[];
  const at = sportOrder.indexOf("diff");
  expect([at > 0, sportOrder[at + 1]], "premise: generic ranks the difference, then goals for").toEqual([true, "for"]);
  const ownOrder = [...sportOrder];
  [ownOrder[at], ownOrder[at + 1]] = [ownOrder[at + 1]!, ownOrder[at]!];

  const compId = await openBuilderFromCompetition(page, request, "Builder walk");
  await page.setViewportSize({ width: 1280, height: 900 });
  await onStep(page, "who");
  await expect(page).toHaveTitle(/.+/);

  // ---- 1 Who plays. Next with no name is refused, on this step, with the reason.
  await next(page);
  await onStep(page, "who");
  await expect(page.getByTestId("division-builder-error")).toHaveText(L["wizard.err.name"]!);
  await page.screenshot({ path: testInfo.outputPath("validation-blocked-1280.png"), fullPage: true });

  const name = `Open teams ${TAG}`;
  await page.getByTestId("division-builder-name").fill(name);
  // Fixed, the refusal goes at once: no "Enter a division name" left standing over a typed name.
  await expect(page.getByTestId("division-builder-error")).toBeHidden();

  // ---- C9 R2: Sport is a tile per sport: one group named Sport, described by the "can't change" line; five shown,
  // then the Show more tile naming the rest.
  const sportGroup = page.getByRole("group", { name: L["wizard.sport"], exact: true });
  await expect(sportGroup).toHaveAccessibleDescription(L["divBuilder.sportFixed"]!);
  const sportTiles = await sportTilesInOrder(page);
  expect(sportTiles.length, "a tile per listed sport").toBeGreaterThanOrEqual(REGISTRY.length);
  expect(sportTiles.at(-1), "generic last").toBe("generic");
  const sportMore = page.getByTestId("division-builder-sport-more");
  await expect(sportMore).toHaveAttribute("aria-expanded", "false");
  await expect(sportMore).toHaveText(plural("divBuilder.sport.showMore", sportTiles.length - 5));
  expect(await shownSports(page), "five shown").toHaveLength(5);
  // The keyboard: Tab from the name lands on the picked sport, and an arrow moves the pick to the next SHOWN tile -
  // never into a folded one.
  const focusedSport = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      return el?.name === "division-sport" ? el.value : null;
    });
  const shownBefore = await shownSports(page);
  await page.getByTestId("division-builder-name").focus();
  await page.keyboard.press("Tab");
  const startSport = await focusedSport();
  expect(startSport, "Tab from the name lands on a sport tile").not.toBeNull();
  await expect(page.locator(`label[data-sport="${startSport}"] input`), "on the picked one").toBeChecked();
  await page.keyboard.press("ArrowRight");
  const movedTo = await focusedSport();
  expect(movedTo, "the arrow moves to the next shown tile").toBe(shownBefore[(shownBefore.indexOf(startSport!) + 1) % shownBefore.length]);
  await expect(page.locator(`label[data-sport="${movedTo}"] input`), "the arrow moves the pick").toBeChecked();
  await expect(page.locator(`label[data-sport="${movedTo}"]`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sport-keyboard-focus-1280.png") });
  await page.keyboard.press("ArrowLeft");
  expect(await focusedSport()).toBe(startSport);
  await gridSweep(page, testInfo, {
    label: "sport",
    section: "division-builder-sport",
    grid: "division-builder-sports",
    more: "division-builder-sport-more",
    cols: (w) => (w < 768 ? 2 : 3),
    rowMatch: false,
  });
  await pickBuilderSport(page, "generic");
  // Opened to reach it, then closed: the picked sport is never folded away, and it reads "Any other game" here.
  if ((await sportMore.getAttribute("aria-expanded")) === "true") await sportMore.click();
  const genericTile = page.locator('label[data-sport="generic"]');
  await expect(genericTile).toBeVisible();
  await expect(genericTile).toHaveText(L["divBuilder.sport.generic"]!);
  expect(await shownSports(page), "the pick takes the fifth slot").toHaveLength(5);
  expect((await shownSports(page)).at(-1)).toBe("generic");
  for (const width of [1280, 320] as const) {
    await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
    await page.getByTestId("division-builder-sport").screenshot({ path: testInfo.outputPath(`sport-picked-generic-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Class 19: the entrant kind OPENS at the engine's default for the sport, before any tap.
  const kinds = page.getByTestId("division-builder-entrant-kind");
  await expect(kinds.locator(`input[value="${model.defaultKind}"]`)).toBeChecked();
  await kinds.locator(`label[data-entrant-kind="${kind}"]`).click();
  await expect(kinds.locator(`input[value="${kind}"]`)).toBeChecked();
  await page.locator('label[data-category="mixed"]').click();
  await expect(page.locator('input[name="division-category"][value="mixed"]')).toBeChecked();
  await page.getByTestId("division-builder-eligibility-toggle").click();
  await page.getByTestId("division-builder-age").fill("16");
  await page.getByTestId("division-builder-cutoff-month").selectOption("9");
  await page.getByTestId("division-builder-cutoff-day").fill("1");
  const note = `Club members only ${TAG}`;
  await page.getByTestId("division-builder-note").fill(note);
  await sweep(page, testInfo, "who", "step1-who");

  // ---- Next, then Back: nothing typed is lost.
  await next(page);
  await onStep(page, "format");
  await page.getByTestId("division-builder-back").click();
  await onStep(page, "who");
  await expect(page.getByTestId("division-builder-name")).toHaveValue(name);
  await expect(kinds.locator(`input[value="${kind}"]`)).toBeChecked();
  await expect(page.locator('input[name="division-category"][value="mixed"]')).toBeChecked();
  await expect(page.getByTestId("division-builder-age")).toHaveValue("16");
  await expect(page.getByTestId("division-builder-note")).toHaveValue(note);

  // ---- 2 Format: the plan opens at 16 entrants (class 19), five suggested, the rest under Show more (C9 R2).
  await next(page);
  await onStep(page, "format");
  await expect(page.getByTestId("division-builder-plan-entrants")).toHaveValue("16");
  await expect(page.locator("label[data-suggested]")).toHaveCount(5);
  // C9 R2: Show more is the grid's sixth cell, as tall as the fifth card beside it; Americano and Mexicano, when the
  // sport offers them, come after every other card.
  await gridSweep(page, testInfo, {
    label: "format",
    section: "division-builder-templates",
    grid: "division-builder-templates",
    more: "division-builder-show-all",
    cols: (w) => (w < 768 ? 1 : 2),
    rowMatch: true,
  });
  {
    const order = await page.locator("label[data-template]").evaluateAll((els) => els.map((el) => el.getAttribute("data-template") ?? ""));
    // N1: a Teams division is offered no partner-rotation format, folded or not (the third test walks the order of a
    // division that IS offered them: badminton at Individuals).
    expect(order.filter((k) => MINTING.includes(k)), `a Teams division: no Americano or Mexicano in ${order.join(",")}`).toEqual([]);
    expect(order.length, "the cards it is offered").toBeGreaterThan(5);
    expect(await shownTemplates(page), "five shown").toHaveLength(5);
  }
  await page.getByTestId("division-builder-plan-entrants").fill("12");
  await showAllFormats(page);
  const groups = await card(page, "groups_ko");
  await groups.click();
  await expect(groups.locator("input")).toBeChecked();
  await page.getByLabel(L["wizard.pools"]!, { exact: true }).fill("3");
  await page.getByTestId("legs-choice").getByText(L["wizard.legsHomeAway"]!, { exact: true }).click();
  // Class 19: carried standings open at "none"; the organiser carries the points into the knockout.
  const carry = page.getByTestId("division-builder-carry");
  await expect(carry).toHaveValue("none");
  await carry.selectOption("points");
  await sweep(page, testInfo, "format", "step2-format");

  // ---- 3 Division rules: the strip, in draft mode (no Save anywhere), its Match rules panel open.
  await next(page);
  await onStep(page, "rules");
  const strip = page.getByTestId("division-builder-rules").getByTestId("division-rules-strip");
  await expect(strip).toBeVisible();
  for (const save of ["division-rules-format-save", "division-points-save", "division-tiebreaks-save"]) await expect(strip.getByTestId(save)).toHaveCount(0);
  await strip.getByTestId("division-settings-variant").selectOption(variant);
  for (const p of ["points", "tiebreaks"] as const) {
    const toggle = strip.getByTestId(`division-rules-toggle-${p}`);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(strip.getByTestId(`division-rules-panel-${p}`)).toBeVisible();
  }
  // Class 19: the Win box opens at the preset's own number.
  const win = strip.getByTestId("division-rules-panel-points").getByRole("spinbutton", { name: L["divset.win"], exact: true });
  await expect(win).toHaveValue(String(presetPoints.w));
  await win.fill("4");
  const orderPanel = strip.getByTestId("division-rules-panel-tiebreaks");
  const listed = () => orderPanel.locator('[data-testid^="stage-tiebreaks-row-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-key") ?? ""));
  await expect.poll(listed, { message: "the order opens at the sport's own" }).toEqual([...sportOrder]);
  await orderPanel.getByTestId(`stage-tiebreaks-down-${at}`).click();
  await expect.poll(listed).toEqual([...ownOrder]);
  // The schedule, folded under "Set now".
  const toggle = page.getByTestId("division-builder-schedule-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("division-builder-match-minutes").fill("25");
  await page.getByLabel(L["boardset.startAt"]!).fill("2030-06-12");
  await page.getByLabel("Time", { exact: true }).selectOption("09:00");
  await page.getByLabel(L["boardset.endAt"]!).fill("2030-06-13");
  await sweep(page, testInfo, "rules", "step3-rules");

  // ---- 4 Review: the receipt, a row per step, each saying where it changes later.
  await next(page);
  await onStep(page, "review");
  await expect(reviewRow(page, "who")).toContainText(name);
  // n3: Review names the one kind the division takes.
  await expect(reviewRow(page, "who")).toContainText(L[`divBuilder.review.only.${kind}`]!);
  await expect(reviewRow(page, "who")).toContainText(fill("divBuilder.review.under", { age: 16 }));
  await expect(reviewRow(page, "format")).toContainText(L["format.template.groups_ko.label"]!);
  await expect(reviewRow(page, "format")).toContainText(plural("divBuilder.review.pools", 3));
  // m7: the rows say what is played, marked the organiser's (the unit suite pins the full words).
  await expect(reviewRow(page, "points")).toContainText(L["divBuilder.review.points.own"]!.replace("{points}", "").trim());
  await expect(reviewRow(page, "points")).toContainText("4");
  await expect(reviewRow(page, "tiebreaks")).toContainText(L["divBuilder.review.order.own"]!.split("{order}")[0]!.trim());
  await expect(reviewRow(page, "schedule")).toContainText(fill("divBuilder.review.minutes", { minutes: 25 }));
  for (const [row, later] of [["who", "who"], ["format", "format"], ["rules", "rules"], ["schedule", "schedule"]] as const) {
    await expect(reviewRow(page, row)).toContainText(L[`divBuilder.review.later.${later}`]!);
  }
  await sweep(page, testInfo, "review", "step4-review");

  // ---- Edit from Review: the Format row's Edit opens Format with a way straight back; the change shows on the receipt.
  await page.getByTestId("division-builder-edit-format").click();
  await onStep(page, "format");
  const backToReview = page.getByTestId("division-builder-back-to-review");
  await expect(backToReview).toHaveText(L["divBuilder.backToReview"]!);
  await page.getByLabel(L["wizard.pools"]!, { exact: true }).fill("2");
  await page.screenshot({ path: testInfo.outputPath("review-edit-open-1280.png"), fullPage: true });
  await backToReview.click();
  await onStep(page, "review");
  await expect(reviewRow(page, "format")).toContainText(plural("divBuilder.review.pools", 2));
  await expect(reviewRow(page, "format")).not.toContainText(plural("divBuilder.review.pools", 3));

  // ---- Create, on a bad connection (I1): the first stages request lands on the server, and its answer is lost.
  const stagesCalls: string[] = [];
  const stagesRoute = "**/api/v1/divisions/*/stages";
  await page.route(stagesRoute, async (route) => {
    stagesCalls.push(route.request().method());
    if (stagesCalls.length > 1) return route.continue();
    await route.fetch();
    return route.abort("failed");
  });
  const create = page.getByTestId("division-builder-create");
  await expect(create).toBeEnabled();
  await create.click();
  // The refusal lands on Format, the step whose stages were refused.
  await onStep(page, "format");
  await expect(page.getByTestId("division-builder-error")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("stages-refused-1280.png"), fullPage: true });
  // Who plays and Division rules were saved with the division: read-only now, and said so by name.
  await stepButton(page, "who").click();
  await onStep(page, "who");
  await expect(page.getByTestId("division-builder-who").getByTestId("division-builder-saved-note")).toContainText(name);
  await expect(page.getByTestId("division-builder-name")).toBeDisabled();
  // n5 (C9 review 2): the saved step LOOKS read-only too - dimmed, in a real browser's computed style.
  await expect(page.getByTestId("division-builder-who-fields")).toHaveCSS("opacity", "0.7");
  await stepButton(page, "rules").click();
  await onStep(page, "rules");
  await expect(page.getByTestId("division-builder-rules").getByTestId("division-builder-saved-note")).toContainText(name);
  await expect(win).toBeDisabled();
  await expect(page.getByTestId("division-builder-rules-fields")).toHaveCSS("opacity", "0.7");
  await page.screenshot({ path: testInfo.outputPath("stages-refused-rules-1280.png"), fullPage: true });
  await stepButton(page, "review").click();
  await onStep(page, "review");
  for (const id of ["who", "rules", "points", "tiebreaks"]) {
    await expect(page.getByTestId(`division-builder-saved-${id}`), `${id} saved with the division`).toHaveText(L["divBuilder.review.saved"]!);
  }
  // n5: the saved state at the phone and tablet widths too (Review's Saved pills, then the dimmed Who plays).
  for (const width of [320, 768] as const) {
    await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`stages-refused-review-${width}.png`), fullPage: true });
  }
  await stepButton(page, "who").click();
  await onStep(page, "who");
  for (const width of [320, 768] as const) {
    await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`stages-refused-who-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await stepButton(page, "review").click();
  await onStep(page, "review");
  // ---- Create again: the stages are REPLACED, and it lands on the new division's Fixtures tab.
  await create.click();
  const slug = await landed(page);
  await page.unroute(stagesRoute);
  expect(stagesCalls, "the retry replaces the stages the lost answer made").toEqual(["POST", "PUT"]);
  await expect(page.getByTestId("division-rules-strip")).toBeVisible({ timeout: NAV_MS });
  await page.screenshot({ path: testInfo.outputPath("landing-fixtures-1280.png"), fullPage: true });

  // ---- The record, read from the database.
  const { division, stages, schedule, divisionsInCompetition } = await readBack(slug, compId);
  expect(divisionsInCompetition, "one division, however many times Create was pressed").toBe(1);
  const startIso = await page.evaluate(() => new Date("2030-06-12T09:00").toISOString());
  const endIso = await page.evaluate(() => new Date("2030-06-13T23:59:00").toISOString());
  const fields: [string, unknown, unknown][] = [
    ["name", division.name, name],
    ["sport_key", division.sport_key, "generic"],
    ["variant_key", division.variant_key, variant],
    // Owner Q3 and n3 (2026-11-03): the kind shown narrows the division to it - teams, clicked here (generic's default is
    // individuals).
    ["config.entrants", division.config.entrants, { kinds: [kind], defaultKind: kind }],
    ["config.points", division.config.points, { ...presetPoints, w: 4 }],
    ["config.onlinePlay (not chess: absent)", division.config.onlinePlay, undefined],
    ["tiebreakers", division.tiebreakers, ownOrder],
    ["category", division.category, "mixed"],
    // "Under 16": the age a player must be UNDER, stored as the oldest allowed.
    ["age_max", division.age_max, 15],
    ["age_cutoff_month", division.age_cutoff_month, 9],
    ["age_cutoff_day", division.age_cutoff_day, 1],
    ["eligibility_note", division.eligibility_note, note],
    ["camera_policy (not chess: NULL, the server's default)", division.camera_policy, null],
    ["schedule.matchMinutes", schedule?.matchMinutes, 25],
    ["schedule.startAt", schedule?.startAt, startIso],
    ["schedule.endAt", schedule?.endAt, endIso],
  ];
  let fieldsRead = 0;
  for (const [label, got, want] of fields) {
    expect(got, label).toEqual(want);
    fieldsRead++;
  }
  // m11: every column the read-back SELECTED is held to an expected value (id and slug key the read itself), so a column
  // added to the query and never checked reds here; the count is of reads that ran, never of an array literal.
  const covered = new Set(fields.map(([label]) => label.split(/[ .(]/)[0]!));
  const unchecked = Object.keys(division).filter((column) => column !== "id" && column !== "slug" && !covered.has(column));
  expect(unchecked, "a column read back with no expected value").toEqual([]);
  expect(fieldsRead, "fields read back").toBeGreaterThanOrEqual(Object.keys(division).length - 2);
  const want = buildTemplateStages("groups_ko", { qualified: 4, swissRounds: 3, poolCount: 2, legs: 2 });
  expect(stages.length, "the stages the format builds, once: the retry replaced the lost answer's").toBe(want.length);
  let stagesChecked = 0;
  for (const [i, w] of want.entries()) {
    expect(stages[i], `stage ${i + 1}`).toMatchObject({ seq: i + 1, kind: w.kind, name: w.name, config: w.config, progression: w.progression });
    stagesChecked++;
  }
  expect(stagesChecked, "every stage row read back").toBe(stages.length);
  expect(stagesChecked).toBeGreaterThan(1);
  // K5: the carry picked on Format, on the stage that follows the groups (what was typed, not the builder's).
  expect(want[1]?.progression, "premise: groups_ko's knockout has a progression to carry into").toBeTruthy();
  expect((stages[1]?.progression as { carry?: unknown } | null)?.carry, "stage 2's progression.carry").toBe("points");
  expect((stages[0]?.progression as { carry?: unknown } | null)?.carry, "stage 1 carries nothing").toBeUndefined();
});

/** The eight controls Lichess plays, read from the catalogue's source (server-only, so not importable here). */
function lichessCatalogue(): { key: string; limitSeconds: number; incrementSeconds: number }[] {
  const src = readFileSync(fileURLToPath(new URL("../../src/server/external-play/time-controls.ts", import.meta.url)), "utf8");
  const body = /export const SHIP1_TIME_CONTROLS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src)?.[1];
  if (!body) throw new Error("SHIP1_TIME_CONTROLS not found in time-controls.ts");
  return [...body.matchAll(/key: "([^"]+)", limitSeconds: (\d+), incrementSeconds: (\d+)/g)].map((m) => ({
    key: m[1]!,
    limitSeconds: Number(m[2]),
    incrementSeconds: Number(m[3]),
  }));
}

test("chess: online play is asked first, Lichess is refused without one of its eight clocks, and the clock picked is stored", async ({ page, request }, testInfo) => {
  test.setTimeout(budget(6, 60, 1));
  const catalogue = lichessCatalogue();
  expect(catalogue.length, "Lichess's catalogue").toBe(8);
  const picked = catalogue.find((c) => c.incrementSeconds > 0 && c.limitSeconds !== 600)!;
  expect(picked, "premise: a control with an increment other than the default 10+5").toBeDefined();

  const compId = await openBuilderFromCompetition(page, request, "Builder chess");
  await page.setViewportSize({ width: 1280, height: 900 });
  const name = `Chess online ${TAG}`;
  await page.getByTestId("division-builder-name").fill(name);
  await pickBuilderSport(page, "boardgame");
  // Chess is individuals only: said in words, no choice to make.
  const kinds = page.getByTestId("division-builder-entrant-kind");
  await expect(kinds).toContainText(L["divBuilder.entrants.only.individual"]!);
  await expect(kinds.locator('input[type="radio"]')).toHaveCount(0);

  await next(page);
  await onStep(page, "format");
  await showAllFormats(page);
  const swiss = await card(page, "swiss");
  await swiss.click();
  await expect(swiss.locator("input")).toBeChecked();
  await page.getByLabel(L["wizard.rounds"]!, { exact: true }).fill("5");

  await next(page);
  await onStep(page, "rules");
  const strip = page.getByTestId("division-builder-rules").getByTestId("division-rules-strip");
  const online = strip.getByTestId("division-online-play");
  await expect(online, "online chess is offered (ONLINE_CHESS_ALWAYS=1 on the server under test)").toBeVisible();
  // Online play is asked BEFORE the variant: above it on the page.
  const onlineBox = await online.boundingBox();
  const variantBox = await strip.getByTestId("division-settings-variant").boundingBox();
  expect(onlineBox!.y, "online play sits above the variant").toBeLessThan(variantBox!.y);
  // The variant the builder opened on, as shown: the one the division must store (n9 holds every column read back).
  const shownVariant = await strip.getByTestId("division-settings-variant").inputValue();
  expect(Object.keys(mod("boardgame").variants as object), "the variant shown is one of chess's").toContain(shownVariant);
  await online.selectOption("lichess");
  const clock = strip.getByTestId("division-time-control");
  // Class 19: the clock opens at "Choose" (no control yet), listing exactly the catalogue.
  await expect(clock).toHaveValue("");
  await expect(clock.locator('option:not([value=""])')).toHaveCount(catalogue.length);
  await next(page);
  await onStep(page, "rules");
  await expect(page.getByTestId("division-builder-error")).toHaveText(L["divBuilder.err.timeControl"]!);
  await page.screenshot({ path: testInfo.outputPath("chess-rules-refused-1280.png"), fullPage: true });
  await clock.selectOption(picked.key);
  // m6: the camera, next to online play, opens at the server's default (inherit the competition's); Required is picked.
  const camera = strip.getByTestId("division-builder-camera");
  await expect(camera).toHaveValue("inherit");
  await camera.selectOption("required");
  // m8: the control moves the match length - both clocks spent, base + 40 moves of increment, rounded up.
  const slotMinutes = Math.ceil((2 * (picked.limitSeconds + 40 * picked.incrementSeconds)) / 60);
  await expect(page.getByTestId("division-builder-match-minutes")).toHaveValue(String(slotMinutes));
  await sweep(page, testInfo, "rules", "chess-rules");

  await next(page);
  await onStep(page, "review");
  await expect(reviewRow(page, "rules")).toContainText(L["divset.onlinePlay.lichess"]!);
  await expect(reviewRow(page, "rules")).toContainText(fill("divBuilder.review.camera", { policy: L["divset.camera.required"]! }));
  await page.getByTestId("division-builder-create").click();
  const slug = await landed(page);

  const { division, stages, schedule } = await readBack(slug, compId);
  const stored = division.config.clock as { base?: unknown; increment?: unknown; delay?: unknown } | undefined;
  const checks: [string, unknown, unknown][] = [
    ["name", division.name, name],
    ["sport_key", division.sport_key, "boardgame"],
    ["variant_key (as shown on Division rules)", division.variant_key, shownVariant],
    ["config.onlinePlay", division.config.onlinePlay, "lichess"],
    ["config.clock.base (seconds)", stored?.base, picked.limitSeconds],
    ["config.clock.increment (seconds)", stored?.increment, picked.incrementSeconds],
    // n3 (owner 2026-11-03): the one kind shown - chess's only one - is the division's, stored as such.
    ["config.entrants (the kind shown, alone)", division.config.entrants, { kinds: ["individual"], defaultKind: "individual" }],
    // Untouched on Who plays and Division rules: the server's defaults.
    ["tiebreakers (untouched: the sport's, unsent)", division.tiebreakers, null],
    ["category (open: unsent)", division.category, null],
    ["age_max", division.age_max, null],
    ["age_cutoff_month", division.age_cutoff_month, null],
    ["age_cutoff_day", division.age_cutoff_day, null],
    ["eligibility_note", division.eligibility_note, null],
    ["stages", stages.map((s) => `${s.seq}:${s.kind}`), ["1:swiss"]],
    ["swiss rounds", stages[0]?.config.rounds, 5],
    ["camera_policy", division.camera_policy, "required"],
    ["schedule.matchMinutes (the control's length)", schedule?.matchMinutes, slotMinutes],
  ];
  // m11: the count is of reads that ran, never of the array literal.
  let read = 0;
  for (const [label, got, want] of checks) {
    expect(got, label).toEqual(want);
    read++;
  }
  // n9 (C9 review 2): as the first test - every column the read-back SELECTED is held to an expected value, so a column
  // added to the query and never checked reds here.
  const covered = new Set(checks.map(([label]) => label.split(/[ .(]/)[0]!));
  const unchecked = Object.keys(division).filter((column) => column !== "id" && column !== "slug" && !covered.has(column));
  expect(unchecked, "a column read back with no expected value").toEqual([]);
  expect(read, "chess fields read back").toBe(checks.length);
  expect(read).toBeGreaterThanOrEqual(Object.keys(division).length - 2);

  // ---- C9 R2: the next division's Sport picker leads with what this organisation has run, most recent first, read
  // against the organisation's own division rows. Other specs make divisions in this organisation at the same time, so
  // the page and the record are read again until they agree on one moment.
  await page.goto(await competitionPath(request, compId, "/d/new"));
  await expect(page.getByTestId("division-builder-name")).toBeVisible({ timeout: NAV_MS });
  let agreed: string[] = [];
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.getByTestId("division-builder-name")).toBeVisible({ timeout: NAV_MS });
        const shown = await sportTilesInOrder(page);
        const want = await sportOrderFromRecord(compId);
        agreed = shown;
        return shown.join(",") === want.join(",") ? "agree" : `page ${shown.join(",")} | record ${want.join(",")}`;
      },
      { message: "the Sport picker's order is the organisation's history, then the popular five, then the registry, generic last", timeout: 4 * NAV_MS, intervals: [500, 1_000, 2_000] },
    )
    .toBe("agree");
  // The witness: the history moved something - the order is not the one with no history at all.
  const noHistory = [...POPULAR, ...REGISTRY.filter((k) => !POPULAR.includes(k) && k !== "generic"), "generic"];
  expect(agreed.filter((k) => REGISTRY.includes(k)), "the organisation's own sports lead, so the order is not the no-history one").not.toEqual(noHistory);
  // C9 round 3: the builder opens on that first tile - the organisation's latest sport - and on no other.
  await expect(page.locator(`label[data-sport="${agreed[0]}"] input`), `it opens on the first tile, ${agreed[0]}`).toBeChecked();
  await expect(page.locator('input[name="division-sport"]:checked')).toHaveCount(1);
  await page.getByTestId("division-builder-sport").screenshot({ path: testInfo.outputPath("sport-order-history-1280.png") });
});

test("the entrant kind: Format offers a Pairs division no Americano (N1), and a kind left untouched is the division's only one (n3)", async ({ page, request }, testInfo) => {
  test.setTimeout(budget(5, 60, 0));
  expect([...MINTING].sort(), "premise: the partner-rotation formats are the owner's two").toEqual(["americano", "mexicano"]);
  const badminton = effectiveEntrantModel(mod("badminton").entrantModel ?? null, null);
  expect([badminton.defaultKind, badminton.kinds.includes("pair")], "premise: badminton opens at individuals and allows pairs").toEqual(["individual", true]);
  const volleyball = effectiveEntrantModel(mod("volleyball").entrantModel ?? null, null);
  // The witness for n3: volleyball allows more than its default, so storing the default alone NARROWS it.
  expect([volleyball.defaultKind, volleyball.kinds.length > 1], "premise: volleyball opens at teams and allows another kind").toEqual(["team", true]);
  const allCards = () => page.locator("label[data-template]").evaluateAll((els) => els.map((el) => el.getAttribute("data-template") ?? ""));
  const checkedCards = () => page.locator("label[data-template]:has(input:checked)").evaluateAll((els) => els.map((el) => el.getAttribute("data-template") ?? ""));

  const compId = await openBuilderFromCompetition(page, request, "Builder kinds");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId("division-builder-name").fill(`Doubles ${TAG}`);
  await pickBuilderSport(page, "badminton");
  const kinds = page.getByTestId("division-builder-entrant-kind");
  await expect(kinds.locator('input[value="individual"]')).toBeChecked();

  // ---- Individuals: both partner-rotation formats are offered, after every other card (C9 R2). Americano is picked.
  await next(page);
  await onStep(page, "format");
  await showAllFormats(page);
  const asIndividuals = await allCards();
  expect(asIndividuals.filter((k) => MINTING.includes(k)).sort(), `Individuals: ${asIndividuals.join(",")}`).toEqual([...MINTING].sort());
  const firstPair = asIndividuals.findIndex((k) => MINTING.includes(k));
  expect(asIndividuals.slice(firstPair).every((k) => MINTING.includes(k)), `pair formats last: ${asIndividuals.join(",")}`).toBe(true);
  const americano = await card(page, "americano");
  await americano.click();
  await expect(americano.locator("input")).toBeChecked();

  // ---- Back to Who plays: Pairs. On Format, neither format is offered, and the Americano pick is gone with its card.
  await page.getByTestId("division-builder-back").click();
  await onStep(page, "who");
  await kinds.locator('label[data-entrant-kind="pair"]').click();
  await expect(kinds.locator('input[value="pair"]')).toBeChecked();
  await next(page);
  await onStep(page, "format");
  await showAllFormats(page);
  const asPairs = await allCards();
  expect(asPairs.filter((k) => MINTING.includes(k)), `N1: a Pairs division is offered no Americano or Mexicano: ${asPairs.join(",")}`).toEqual([]);
  expect(asPairs, "only the partner-rotation cards left").toEqual(asIndividuals.filter((k) => !MINTING.includes(k)));
  // One card checked, and a shown one (n1: the opening) - never a checked radio behind a missing card.
  const picked = await checkedCards();
  expect(picked, "one card checked").toHaveLength(1);
  expect(MINTING).not.toContain(picked[0]);
  await expect(page.locator(`label[data-template="${picked[0]}"]`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("kind-pairs-format-1280.png"), fullPage: true });

  // ---- n3: volleyball, the kind left at its default (Teams). Review says "Teams only", and the division stores it alone.
  await page.goto(await competitionPath(request, compId, "/d/new"));
  await expect(page.getByTestId("division-builder-name")).toBeVisible({ timeout: NAV_MS });
  const name = `Volley ${TAG}`;
  await page.getByTestId("division-builder-name").fill(name);
  await pickBuilderSport(page, "volleyball");
  await expect(kinds.locator('input[value="team"]')).toBeChecked();
  for (const step of ["format", "rules", "review"] as const) {
    await next(page);
    await onStep(page, step);
  }
  await expect(reviewRow(page, "who")).toContainText(L["divBuilder.review.only.team"]!);
  await page.screenshot({ path: testInfo.outputPath("kind-untouched-review-1280.png"), fullPage: true });
  await page.getByTestId("division-builder-create").click();
  const slug = await landed(page);
  const { division } = await readBack(slug, compId);
  expect([division.name, division.sport_key], "the division read back").toEqual([name, "volleyball"]);
  expect(division.config.entrants, "the untouched default, alone").toEqual({ kinds: ["team"], defaultKind: "team" });
});

test("Settings › Format offers a builder-made Individuals Americano division Americano and Mexicano, Americano selected (C9 round 3)", async ({ page, request }, testInfo) => {
  test.setTimeout(budget(4, 60, 0));
  expect([...MINTING].sort(), "premise: the partner-rotation formats are the owner's two").toEqual(["americano", "mexicano"]);
  const badminton = effectiveEntrantModel(mod("badminton").entrantModel ?? null, null);
  // The witness: badminton's own model holds pairs too, so a division narrowed to Individuals (n3) is the one shape the
  // old both-kinds rule refused in Settings while the builder offered it.
  expect([badminton.defaultKind, badminton.kinds.includes("pair")], "premise: badminton opens at individuals and allows pairs").toEqual(["individual", true]);

  const compId = await openBuilderFromCompetition(page, request, "Builder settings format");
  await page.setViewportSize({ width: 1280, height: 900 });
  const name = `Rotation ${TAG}`;
  await page.getByTestId("division-builder-name").fill(name);
  await pickBuilderSport(page, "badminton");
  await expect(page.getByTestId("division-builder-entrant-kind").locator('input[value="individual"]')).toBeChecked();
  await next(page);
  await onStep(page, "format");
  await showAllFormats(page);
  const americano = await card(page, "americano");
  await americano.click();
  await expect(americano.locator("input")).toBeChecked();
  for (const step of ["rules", "review"] as const) {
    await next(page);
    await onStep(page, step);
  }
  await page.getByTestId("division-builder-create").click();
  const slug = await landed(page);
  const { division, stages } = await readBack(slug, compId);
  expect([division.name, division.sport_key], "the division read back").toEqual([name, "badminton"]);
  expect(division.config.entrants, "n3: an Individuals division stores that kind alone").toEqual({ kinds: ["individual"], defaultKind: "individual" });
  expect(stages.map((s) => s.kind), "one americano stage").toEqual(["americano"]);

  // ---- Settings › Format: the structure the division plays is selected, and both partner-rotation formats are offered.
  await page.goto(page.url().replace(/\?tab=fixtures$/, "?tab=settings"));
  const settings = page.getByTestId("division-settings");
  await expect(settings).toBeVisible({ timeout: NAV_MS });
  await settings.getByRole("button", { name: /Format/ }).first().click();
  const select = page.getByTestId("format-template");
  await expect(select).toBeVisible();
  await expect(select, "Americano selected").toHaveValue("americano");
  const offered = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(offered.filter((k) => MINTING.includes(k)).sort(), `Settings offers both: ${offered.join(",")}`).toEqual([...MINTING].sort());
  expect(offered.length, "and the rest of the offer").toBeGreaterThan(MINTING.length);
  await expectNoHorizontalScroll(page);
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("settings-format-americano-1280.png"), fullPage: true });
});
