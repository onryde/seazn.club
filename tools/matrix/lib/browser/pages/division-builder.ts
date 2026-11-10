// Building a division through the division builder (Task 5; Match Day C9's four steps). Product facts, read at Step 0
// (components/v2/division-builder.tsx, lib/division-builder/model.ts):
//  - /o/<org>/c/<comp>/d/new (routes.ts). Four steps, BUILDER_STEPS (model.ts, pinned as BUILDER_STEP_COUNT): Who plays,
//    Format, Division rules, Review. A `<nav>` of buttons named by each step (Format: wizard.tab.format); every step's
//    section stays in the DOM, `hidden` unless current. Create (`division-builder-create`) renders only on Review, Next
//    (`division-builder-next`) on every other step; Next refuses an unfinished step into `division-builder-error`.
//  - Who plays: `division-builder-name`; Sport is a radio tile per sport (C9 R2): a `<label data-sport={key}>` around an
//    sr-only radio, five shown and the rest folded (`hidden`) until the Show more tile (`division-builder-sport-more`).
//  - Format: each template is a <label> around an sr-only `<input type="radio" name="template">` and a span with
//    format.template.<key>.label. Five are suggested for the plan; the rest are folded (`hidden`) until Show more, the
//    grid's sixth cell (`division-builder-show-all`). Every knob is left untouched - the builder's defaults ARE
//    BUILDER_DEFAULT_KNOBS.
//  - Division rules: the Division rules strip in its draft mode; the Variant select is the strip's
//    (`<label><span class="label">divset.variant</span><select>`), options `value={v.key}`.
//  - Create: POST /api/v1/competitions/<compId>/divisions → {id, slug}; THEN POST /api/v1/divisions/<division.id>/stages
//    with the stage array; a schedule-settings PUT (non-fatal); then router.push(routes.division(org, comp, slug,
//    "fixtures")) - the division's page on its Fixtures tab (the path is the division's; the tab is the query).
import type { Page } from "playwright";
import type { TemplateRowKey } from "../../catalogue.ts";
import { actAndAwait } from "../respond.ts";
import { DATA, NAME, TESTID, templateLabel } from "../selectors.ts";
import { actBudget, attrEquals, awaitScreen, exactPath, navBudget, selectorValue, shoot, visit, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";

/** lib/division-builder/model.ts BUILDER_STEPS's length (pinned): Next is pressed at most this many times on the way to
 *  Create. */
export const BUILDER_STEP_COUNT = 4;

/** The product's Division and Stage rows (api-v1 api-v1/schemas/ Division, Stage). */
export interface DivisionOut { id: string; competition_id: string; name: string; slug: string; sport_key: string; variant_key: string; config: Record<string, unknown>; status: string }
export interface StageOut { id: string; division_id: string; seq: number; kind: string; name: string; config: Record<string, unknown>; progression: unknown; status: string }

export class StagesForAnotherDivision extends Error {
  constructor(wanted: string, got: string) {
    super(`browser: the builder created its division and then answered stages at ${got}, not ${wanted} — these are not this division's stages`);
    this.name = "StagesForAnotherDivision";
  }
}

export class BuiltOtherThanAsked extends Error {
  constructor(field: "sport_key" | "variant_key", asked: string, got: string) {
    super(`browser: the builder was set to ${field} ${asked}, and the product stored ${got} — the pick never reached the page's state (a control used before it hydrated reads as the builder's default)`);
    this.name = "BuiltOtherThanAsked";
  }
}

export class BuilderNeverOfferedCreate extends Error {
  constructor(steps: number, error: string | null) {
    super(`browser: ${steps} presses of Next never reached the builder's Create${error === null ? "" : ` — it says: ${error}`}`);
    this.name = "BuilderNeverOfferedCreate";
  }
}

/** Both answers Create produces, in the product's order: the division, then
 *  the stages posted under ITS id. Both waits exist before `act` clicks (the
 *  stages wait is registered first, the division's inside it). A refused
 *  division is its RefusedCall (no stages are ever posted); stages answered
 *  at another division's path are refused by name. */
export async function awaitDivisionAndStages(page: Pick<Page, "waitForResponse">, compId: string, act: () => Promise<void>, budget: number): Promise<{ division: DivisionOut; stages: StageOut[] }> {
  let divisionAnswer!: Promise<{ data: DivisionOut; path: string }>;
  const { data: stages, path } = await actAndAwait<StageOut | StageOut[]>(page, { method: "POST", path: /^\/api\/v1\/divisions\/[^/]+\/stages$/ }, async () => {
    divisionAnswer = actAndAwait<DivisionOut>(page, { method: "POST", path: exactPath(`/api/v1/competitions/${compId}/divisions`) }, act, budget);
    await divisionAnswer;
  }, budget);
  const { data: division } = await divisionAnswer;
  const wanted = `/api/v1/divisions/${division.id}/stages`;
  if (path !== wanted) throw new StagesForAnotherDivision(wanted, path);
  return { division, stages: Array.isArray(stages) ? stages : [stages] };
}

/** The stored division is the sport and variant the builder was set to. */
export function assertBuiltAsAsked(division: Pick<DivisionOut, "sport_key" | "variant_key">, asked: { sportKey: string; variantKey: string }): void {
  if (division.sport_key !== asked.sportKey) throw new BuiltOtherThanAsked("sport_key", asked.sportKey, division.sport_key);
  if (division.variant_key !== asked.variantKey) throw new BuiltOtherThanAsked("variant_key", asked.variantKey, division.variant_key);
}

/** Builds the division as the organiser would: name and sport (Who plays), the template row (Format), the variant
 *  (Division rules), the defaults for everything else; Create on Review. */
export async function createDivisionUi(c: PageCtx, compSlug: string, compId: string, input: { name: string; sportKey: string; variantKey: string; row: TemplateRowKey }): Promise<{ division: DivisionOut; stages: StageOut[] }> {
  const { page } = c;
  const t = actBudget(c, 1);
  const name = page.getByTestId(TESTID.builderName.id);
  await visit(c, paths.divisionNew(c.orgSlug, compSlug), { control: name, what: "the division builder's name field" });
  const field = (label: string) => page.locator("label").filter({ has: page.getByText(label, { exact: true }) }).locator("select");
  await name.fill(input.name, { timeout: t });
  // The sport's tile; one past the first five is folded under Show more. check() on the tile's <label> checks its sr-only
  // radio and throws unless it ends checked.
  const sportMore = page.getByTestId(TESTID.builderSportMore.id);
  if ((await sportMore.count()) > 0 && (await sportMore.getAttribute("aria-expanded", { timeout: t })) !== "true") await sportMore.click({ timeout: t });
  await page.locator(attrEquals(DATA.sportTile.selector, "sport key", input.sportKey)).check({ timeout: t });
  // Each pick is pictured on the step that shows it: Create lives on Review, so the shot before it can show neither the
  // sport, the format nor the variant.
  const basics = await shoot(c, "02-builder-basics");
  await page.getByRole("button", { name: NAME.formatTab.text, exact: true }).click({ timeout: t });
  // Five formats are suggested for the plan; the row's may be folded under Show more.
  const showAll = page.getByTestId(TESTID.builderShowAll.id);
  if ((await showAll.count()) > 0 && (await showAll.getAttribute("aria-expanded", { timeout: t })) !== "true") await showAll.click({ timeout: t });
  // check() on the template's <label> checks its sr-only radio and throws unless it ends checked.
  await page.locator("label").filter({ has: page.locator(DATA.templateRadio.selector) }).filter({ has: page.getByText(templateLabel(input.row), { exact: true }) }).check({ timeout: t });
  const format = await shoot(c, "02-builder-format", basics);
  // On to Division rules, where the sport's own variant list is.
  await page.getByTestId(TESTID.builderNext.id).click({ timeout: t });
  const variant = field(NAME.variantSelect.text);
  await awaitScreen(() => variant.locator(`option[value="${selectorValue("variant key", input.variantKey)}"]`).waitFor({ state: "attached", timeout: t }), `variant ${input.variantKey} under sport ${input.sportKey}`, t);
  await variant.selectOption({ value: input.variantKey }, { timeout: t });
  const rules = await shoot(c, "02-builder-rules", format);
  const create = page.getByTestId(TESTID.builderCreate.id);
  for (let pressed = 0; pressed < BUILDER_STEP_COUNT && (await create.count()) === 0; pressed++) {
    await page.getByTestId(TESTID.builderNext.id).click({ timeout: t });
  }
  if ((await create.count()) === 0) {
    const error = page.getByTestId(TESTID.builderError.id);
    throw new BuilderNeverOfferedCreate(BUILDER_STEP_COUNT, (await error.count()) > 0 ? await error.innerText({ timeout: t }) : null);
  }
  const before = await shoot(c, "02-division-built-before", rules);
  const built = await awaitDivisionAndStages(page, compId, () => create.click({ timeout: t }), actBudget(c, 2));
  assertBuiltAsAsked(built.division, input);
  const landing = paths.division(c.orgSlug, compSlug, built.division.slug);
  const nav = navBudget(c);
  await awaitScreen(() => page.waitForURL((u) => u.pathname === landing, { timeout: nav }), `the new division's page ${landing}`, nav);
  await shoot(c, "02-division-built", before);
  return built;
}
