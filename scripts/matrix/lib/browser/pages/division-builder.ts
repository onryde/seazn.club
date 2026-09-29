// Building a division through the division builder (Task 5). Product facts,
// read at Step 0 (components/v2/division-builder.tsx):
//  - /o/<org>/c/<comp>/d/new (routes.ts:53). Four tabs, TAB_ORDER (:505,
//    pinned as BUILDER_TABS), as `<nav>` buttons named wizard.tab.* (:588-610);
//    every tab's section stays in the DOM, `hidden` unless active (:612, :670,
//    :760, :987). Create (`division-builder-create`) renders only on the LAST
//    tab, Next (`division-builder-next`) on every other (:1127-1145); Next
//    refuses a tab with an error into `division-builder-error` (:529-537, :1101).
//  - Basics: `division-builder-name` (:619); Sport and Variant are
//    `<label><span class="label">…</span><select>` (:628-660), their options
//    `value={s.key}` / `value={v.key}` — sport and variant KEYS (the brief's
//    Step 0 question); picking a sport re-derives the variant list. An exact
//    getByLabel cannot find these selects: a <label>'s text includes every
//    <option>'s (formats.spec.ts:77 addresses them the same way as here).
//  - Format: each template is a <label> around an sr-only
//    `<input type="radio" name="template">` and a span with
//    format.template.<key>.label (:772-812). Every knob is left untouched —
//    the builder's defaults ARE BUILDER_DEFAULT_KNOBS (catalogue.ts).
//  - Create (:423-475): POST /api/v1/competitions/<compId>/divisions → {id,
//    slug}; THEN POST /api/v1/divisions/<division.id>/stages with the stage
//    array; a schedule-settings PUT (non-fatal); then
//    router.push(routes.division(org, comp, division.slug)).
import type { Page } from "playwright";
import type { TemplateRowKey } from "../../catalogue.ts";
import { actAndAwait } from "../respond.ts";
import { DATA, NAME, TESTID, templateLabel } from "../selectors.ts";
import { actBudget, awaitScreen, exactPath, navBudget, selectorValue, shoot, visit, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";

/** division-builder.tsx TAB_ORDER's length (pinned): Next is pressed at most
 *  this many times on the way to Create. */
export const BUILDER_TABS = 4;

/** The product's Division and Stage rows (api-v1 schemas.ts Division, Stage). */
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
  constructor(tabs: number, error: string | null) {
    super(`browser: ${tabs} presses of Next never reached the builder's Create${error === null ? "" : ` — it says: ${error}`}`);
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

/** Builds the division as the organiser would: name, sport, variant, the
 *  template row, the defaults for everything else; Create. */
export async function createDivisionUi(c: PageCtx, compSlug: string, compId: string, input: { name: string; sportKey: string; variantKey: string; row: TemplateRowKey }): Promise<{ division: DivisionOut; stages: StageOut[] }> {
  const { page } = c;
  const t = actBudget(c, 1);
  await visit(c, paths.divisionNew(c.orgSlug, compSlug));
  const field = (label: string) => page.locator("label").filter({ has: page.getByText(label, { exact: true }) }).locator("select");
  await page.getByTestId(TESTID.builderName.id).fill(input.name, { timeout: t });
  await field(NAME.sportSelect.text).selectOption({ value: input.sportKey }, { timeout: t });
  const variant = field(NAME.variantSelect.text);
  // The sport's own variant list, re-derived by the pick above.
  await awaitScreen(() => variant.locator(`option[value="${selectorValue("variant key", input.variantKey)}"]`).waitFor({ state: "attached", timeout: t }), `variant ${input.variantKey} under sport ${input.sportKey}`, t);
  await variant.selectOption({ value: input.variantKey }, { timeout: t });
  await page.getByRole("button", { name: NAME.formatTab.text, exact: true }).click({ timeout: t });
  // check() on the template's <label> checks its sr-only radio and throws unless it ends checked.
  await page.locator("label").filter({ has: page.locator(DATA.templateRadio.selector) }).filter({ has: page.getByText(templateLabel(input.row), { exact: true }) }).check({ timeout: t });
  const create = page.getByTestId(TESTID.builderCreate.id);
  for (let pressed = 0; pressed < BUILDER_TABS && (await create.count()) === 0; pressed++) {
    await page.getByTestId(TESTID.builderNext.id).click({ timeout: t });
  }
  if ((await create.count()) === 0) {
    const error = page.getByTestId(TESTID.builderError.id);
    throw new BuilderNeverOfferedCreate(BUILDER_TABS, (await error.count()) > 0 ? await error.innerText({ timeout: t }) : null);
  }
  const before = await shoot(c, "02-division-built-before");
  const built = await awaitDivisionAndStages(page, compId, () => create.click({ timeout: t }), actBudget(c, 2));
  assertBuiltAsAsked(built.division, input);
  const landing = paths.division(c.orgSlug, compSlug, built.division.slug);
  const nav = navBudget(c);
  await awaitScreen(() => page.waitForURL((u) => u.pathname === landing, { timeout: nav }), `the new division's page ${landing}`, nav);
  await shoot(c, "02-division-built", before);
  return built;
}
