import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type AnySportModule, type TiebreakerKey } from "@seazn/engine/sport";
import { buildTemplateStages } from "../../src/lib/format-templates";
import { TAG, apiJson, competitionPath, expectNoHorizontalScroll, showAllFormats, withDb } from "../helpers";
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
 * ## Chess
 *
 * The second test is chess with online play: on Division rules, online play is
 * asked BEFORE the variant (owner 2026-11-02), Lichess without one of its eight
 * controls is refused on that step, and the control picked is the clock the
 * division stores. CI offers online chess to every walkthrough
 * (ONLINE_CHESS_ALWAYS=1, e2e.yml); a server without it would not draw the
 * Online play control, and the test says so rather than skipping.
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
};
type StageRow = { seq: number; kind: string; name: string; config: Record<string, unknown>; progression: unknown };

async function readBack(slug: string, competitionId: string): Promise<{ division: DivisionRow; stages: StageRow[]; schedule: Record<string, unknown> | null }> {
  return withDb(async (sql) => {
    const [division] = await sql<DivisionRow[]>`
      select id, slug, name, sport_key, variant_key, config, tiebreakers, category, age_max, age_cutoff_month, age_cutoff_day, eligibility_note
      from divisions where competition_id = ${competitionId} and slug = ${slug}`;
    if (!division) throw new Error(`no division ${slug} in ${competitionId}`);
    const stages = await sql<StageRow[]>`select seq, kind, name, config, progression from stages where division_id = ${division.id} order by seq`;
    const [schedule] = await sql<{ config: Record<string, unknown> }[]>`select config from schedule_settings where division_id = ${division.id}`;
    return { division, stages: [...stages], schedule: schedule?.config ?? null };
  });
}

/** Lands on the new division's Fixtures tab (owner, C9): its slug, from the URL. */
async function landed(page: Page): Promise<string> {
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+\?tab=fixtures$/, { timeout: NAV_MS });
  return page.url().match(/\/d\/([^/?]+)/)![1]!;
}

test("an organiser makes a division in four steps, edits it from Review, and the record holds every field", async ({ page, request }, testInfo) => {
  test.setTimeout(budget(4, 70, 4));
  const G = mod("generic");
  const model = effectiveEntrantModel(G.entrantModel ?? null, null);
  // A kind that is NOT the sport's default, so the choice is sent (class 19: the default goes unsent).
  const kind = model.kinds.find((k) => k !== model.defaultKind)!;
  expect(kind, "premise: generic allows a second entrant kind").toBeDefined();
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
  await page.getByRole("combobox", { name: L["wizard.sport"], exact: true }).selectOption("generic");
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

  // ---- 2 Format: the plan opens at 16 entrants (class 19), four suggested, the rest under Show all.
  await next(page);
  await onStep(page, "format");
  await expect(page.getByTestId("division-builder-plan-entrants")).toHaveValue("16");
  await expect(page.locator("label[data-suggested]")).toHaveCount(4);
  await page.getByTestId("division-builder-plan-entrants").fill("12");
  await showAllFormats(page);
  const groups = await card(page, "groups_ko");
  await groups.click();
  await expect(groups.locator("input")).toBeChecked();
  await page.getByLabel(L["wizard.pools"]!, { exact: true }).fill("3");
  await page.getByTestId("legs-choice").getByText(L["wizard.legsHomeAway"]!, { exact: true }).click();
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
  await expect(reviewRow(page, "who")).toContainText(L[`divBuilder.entrants.kind.${kind}`]!);
  await expect(reviewRow(page, "who")).toContainText(fill("divBuilder.review.under", { age: 16 }));
  await expect(reviewRow(page, "format")).toContainText(L["format.template.groups_ko.label"]!);
  await expect(reviewRow(page, "format")).toContainText(plural("divBuilder.review.pools", 3));
  await expect(reviewRow(page, "points")).toContainText(L["divBuilder.review.own"]!);
  await expect(reviewRow(page, "tiebreaks")).toContainText(L["divBuilder.review.own"]!);
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

  // ---- Create: lands on the new division's Fixtures tab.
  const create = page.getByTestId("division-builder-create");
  await expect(create).toBeEnabled();
  await create.click();
  const slug = await landed(page);
  await expect(page.getByTestId("division-rules-strip")).toBeVisible({ timeout: NAV_MS });
  await page.screenshot({ path: testInfo.outputPath("landing-fixtures-1280.png"), fullPage: true });

  // ---- The record, read from the database.
  const { division, stages, schedule } = await readBack(slug, compId);
  const startIso = await page.evaluate(() => new Date("2030-06-12T09:00").toISOString());
  const endIso = await page.evaluate(() => new Date("2030-06-13T23:59:00").toISOString());
  const fields: [string, unknown, unknown][] = [
    ["name", division.name, name],
    ["sport_key", division.sport_key, "generic"],
    ["variant_key", division.variant_key, variant],
    ["config.entrants", division.config.entrants, { kinds: [...model.kinds], defaultKind: kind }],
    ["config.points", division.config.points, { ...presetPoints, w: 4 }],
    ["config.onlinePlay (not chess: absent)", division.config.onlinePlay, undefined],
    ["tiebreakers", division.tiebreakers, ownOrder],
    ["category", division.category, "mixed"],
    // "Under 16": the age a player must be UNDER, stored as the oldest allowed.
    ["age_max", division.age_max, 15],
    ["age_cutoff_month", division.age_cutoff_month, 9],
    ["age_cutoff_day", division.age_cutoff_day, 1],
    ["eligibility_note", division.eligibility_note, note],
    ["schedule.matchMinutes", schedule?.matchMinutes, 25],
    ["schedule.startAt", schedule?.startAt, startIso],
    ["schedule.endAt", schedule?.endAt, endIso],
  ];
  for (const [label, got, want] of fields) expect(got, label).toEqual(want);
  const want = buildTemplateStages("groups_ko", { qualified: 4, swissRounds: 3, poolCount: 2, legs: 2 });
  expect(stages.length, "the stages the format builds").toBe(want.length);
  let stagesChecked = 0;
  for (const [i, w] of want.entries()) {
    expect(stages[i], `stage ${i + 1}`).toMatchObject({ seq: i + 1, kind: w.kind, name: w.name, config: w.config, progression: w.progression });
    stagesChecked++;
  }
  expect(stagesChecked).toBeGreaterThan(1);
  expect(fields.length + stagesChecked, "every inventory field read back").toBe(15 + want.length);
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
  test.setTimeout(budget(3, 45, 1));
  const catalogue = lichessCatalogue();
  expect(catalogue.length, "Lichess's catalogue").toBe(8);
  const picked = catalogue.find((c) => c.incrementSeconds > 0 && c.limitSeconds !== 600)!;
  expect(picked, "premise: a control with an increment other than the default 10+5").toBeDefined();

  const compId = await openBuilderFromCompetition(page, request, "Builder chess");
  await page.setViewportSize({ width: 1280, height: 900 });
  const name = `Chess online ${TAG}`;
  await page.getByTestId("division-builder-name").fill(name);
  await page.getByRole("combobox", { name: L["wizard.sport"], exact: true }).selectOption("boardgame");
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
  await sweep(page, testInfo, "rules", "chess-rules");

  await next(page);
  await onStep(page, "review");
  await expect(reviewRow(page, "rules")).toContainText(L["divset.onlinePlay.lichess"]!);
  await page.getByTestId("division-builder-create").click();
  const slug = await landed(page);

  const { division, stages } = await readBack(slug, compId);
  const stored = division.config.clock as { base?: unknown; increment?: unknown; delay?: unknown } | undefined;
  const checks: [string, unknown, unknown][] = [
    ["sport_key", division.sport_key, "boardgame"],
    ["config.onlinePlay", division.config.onlinePlay, "lichess"],
    ["config.clock.base (seconds)", stored?.base, picked.limitSeconds],
    ["config.clock.increment (seconds)", stored?.increment, picked.incrementSeconds],
    ["config.entrants (the sport's own default: unsent)", division.config.entrants, undefined],
    ["stages", stages.map((s) => `${s.seq}:${s.kind}`), ["1:swiss"]],
    ["swiss rounds", stages[0]?.config.rounds, 5],
  ];
  for (const [label, got, want] of checks) expect(got, label).toEqual(want);
  expect(checks.length).toBe(7);
});
