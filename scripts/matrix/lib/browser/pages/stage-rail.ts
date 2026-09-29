// The stage rail on the division page's fixtures tab: Generate and Complete
// (Task 5). Product facts, read at Step 0:
//  - desk/stage-rail.tsx:196 `const sheetId = \`stage-rail-sheet-${stage.id}\``;
//    the sheet is `id={sheetId}` + data-testid stage-rail-sheet (:398-400) and
//    stays ATTACHED when closed (`hidden` below md, `md:block` above); the
//    trigger is data-testid stage-rail-trigger + `aria-controls={sheetId}`
//    (:314-319) and is `md:hidden`. There is NO data-stage-id on the rail
//    (the brief's premise): a stage's rail is addressed by that id pair.
//  - Generate is `stage-generate` (:531) and Complete `stage-complete` (:607),
//    both inside the sheet, both under `stage.status !== "complete"` (:476);
//    Complete also needs `fixtureCount > 0` (:602).
//  - stages-panel.tsx act() (:576): POST /api/v1/stages/<id>/generate or
//    /complete, then router.refresh().
import type { Locator, Page } from "playwright";
import { assertWaitMs } from "../budget.ts";
import { actAndAwait } from "../respond.ts";
import { TESTID } from "../selectors.ts";
import type { CompleteOut, GenerateOut } from "../../driver/types.ts";
import { actBudget, awaitScreen, exactPath, navBudget, selectorValue, shoot, visit, type DivisionWhere, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";
import { fixtureRowSelector, showAllFixtures } from "./run-sheet.ts";

const SHEET_ID_PREFIX = "stage-rail-sheet-";

export function railSheetSelector(stageId: string): string {
  return `[id="${SHEET_ID_PREFIX}${selectorValue("stage id", stageId)}"]`;
}
export function railTriggerSelector(stageId: string): string {
  return `[data-testid="${TESTID.railTrigger.id}"][aria-controls="${SHEET_ID_PREFIX}${selectorValue("stage id", stageId)}"]`;
}

/** Review Focus 3 / AGENTS class 22. Opens a phone fold when — and only when
 *  — its trigger is VISIBLE: at ≥768 the trigger is md:hidden and clicking a
 *  hidden control throws, so the width is never consulted (`_page` is here so
 *  the Step 6 mutant — keying on `viewportSize()` — is expressible). A body
 *  already open is left open: a second click on the trigger would close it.
 *  Otherwise click, and wait for the body ATTACHED, never visible — visibility
 *  is what a fold denies; the control inside waits for its own. */
export async function openFoldIfFolded(
  _page: Pick<Page, "viewportSize">,
  trigger: Pick<Locator, "isVisible" | "click">,
  body: Pick<Locator, "isVisible" | "waitFor">,
  budget: number,
): Promise<"opened" | "unfolded"> {
  assertWaitMs("budget", budget);
  if (!(await trigger.isVisible())) return "unfolded";
  if (await body.isVisible()) return "opened";
  await trigger.click({ timeout: budget });
  await body.waitFor({ state: "attached", timeout: budget });
  return "opened";
}

/** The fixtures tab with `stageId`'s rail open, every run-sheet row showing. */
async function railFor(c: PageCtx, where: DivisionWhere, stageId: string): Promise<Locator> {
  const { page } = c;
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug, "fixtures"));
  const t = navBudget(c);
  const sheet = page.locator(railSheetSelector(stageId));
  await awaitScreen(() => sheet.waitFor({ state: "attached", timeout: t }), `the stage rail for stage ${stageId}`, t);
  await showAllFixtures(c);
  await openFoldIfFolded(page, page.locator(railTriggerSelector(stageId)), sheet, actBudget(c, 1));
  return sheet;
}

/** Generate `stageId`'s fixtures from its rail; the product's GenerateOut. */
export async function generateUi(c: PageCtx, where: DivisionWhere, stageId: string): Promise<GenerateOut> {
  const { page } = c;
  const sheet = await railFor(c, where, stageId);
  const before = await shoot(c, "05-generated-before");
  const { data } = await actAndAwait<GenerateOut>(page, { method: "POST", path: exactPath(`/api/v1/stages/${stageId}/generate`) },
    () => sheet.getByTestId(TESTID.stageGenerate.id).click({ timeout: actBudget(c, 1) }), actBudget(c, 1));
  // The screen proves it once the refresh draws the NEWEST row (fixture numbers
  // only grow). Nothing created, nothing new to draw — and nothing to differ.
  const newest = Math.max(0, ...data.fixtures.map((f) => f.fixture_no ?? 0));
  const drew = data.created > 0 && newest > 0;
  if (drew) {
    const t = navBudget(c);
    await awaitScreen(() => page.locator(fixtureRowSelector(newest)).waitFor({ state: "attached", timeout: t }), `run-sheet row #${newest} after generate`, t);
  }
  await shoot(c, "05-generated", drew ? before : undefined);
  return data;
}

/** Complete `stageId` from its rail; the product's CompleteOut. At most once
 *  per stage is the DRIVER's rule (HttpDriver's DriverMisuse), not this page's. */
export async function completeStageUi(c: PageCtx, where: DivisionWhere, stageId: string): Promise<CompleteOut> {
  const { page } = c;
  const sheet = await railFor(c, where, stageId);
  const complete = sheet.getByTestId(TESTID.stageComplete.id);
  const before = await shoot(c, "08-completed-before");
  const { data } = await actAndAwait<CompleteOut>(page, { method: "POST", path: exactPath(`/api/v1/stages/${stageId}/complete`) },
    () => complete.click({ timeout: actBudget(c, 1) }), actBudget(c, 1));
  // A completed stage's rail drops its Generate/Complete block (:476).
  if (data.completed) {
    const t = navBudget(c);
    await awaitScreen(() => complete.waitFor({ state: "detached", timeout: t }), `stage ${stageId}'s rail without Complete`, t);
  }
  await shoot(c, "08-completed", data.completed ? before : undefined);
  return data;
}
