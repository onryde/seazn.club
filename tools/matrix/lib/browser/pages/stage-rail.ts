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
import type { CompleteOut, FixtureRow, GenerateOut } from "../../driver/types.ts";
import { actBudget, awaitScreen, exactPath, navBudget, selectorValue, shoot, visit, type DivisionWhere, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";
import { RUN_SHEET_FILTER_OPTIONS, fixtureRowSelector, readThenShowAll, type DefaultFilterSeen } from "./run-sheet.ts";

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

/** Tailwind's `md` breakpoint, the width below which the rail folds behind its trigger (`md:hidden`, stage-rail.tsx).
 *  48rem at the 16px root; run through page-objects.test.ts against Tailwind's own theme text. */
export const MD_BREAKPOINT_PX = 768;

export type FoldBranch = "opened" | "unfolded";
/** The branch a rail visit took, and the page's width when it took it (null: the page reported no viewport). */
export interface RailFold { readonly branch: FoldBranch; readonly width: number | null }

/** The branch the width demands: below md the rail is folded, so the page object opens it; from md up it is not. */
export function expectedFoldBranch(width: number): FoldBranch {
  return width < MD_BREAKPOINT_PX ? "opened" : "unfolded";
}

/** `fold-branch`'s verdict: the branch the page object took against the one the page's width demands. */
export function judgeFoldBranch(f: RailFold): { verdict: "pass" | "fail"; note: string } {
  if (f.width === null) return { verdict: "fail", note: `the page reported no viewport width, so the ${f.branch} branch cannot be judged` };
  const want = expectedFoldBranch(f.width);
  return f.branch === want
    ? { verdict: "pass", note: `${f.width}px: the rail's fold took the ${f.branch} branch` }
    : { verdict: "fail", note: `${f.width}px: the rail's fold took the ${f.branch} branch, the width demands ${want}` };
}

/** openFoldIfFolded, and the branch it took with the width it took it at. */
export async function openFold(
  page: Pick<Page, "viewportSize">,
  trigger: Pick<Locator, "isVisible" | "click">,
  body: Pick<Locator, "isVisible" | "waitFor">,
  budget: number,
): Promise<RailFold> {
  const branch = await openFoldIfFolded(page, trigger, body, budget);
  return { branch, width: page.viewportSize()?.width ?? null };
}

/** What a rail visit saw: the fold's branch, and (when asked) the sheet's default filter before it was widened. */
export interface RailSeen { readonly fold: RailFold; readonly defaultFilter: DefaultFilterSeen | null }
/** The page object's callbacks into its driver: `readDefaultFilter` asks for the sheet's default (run-sheet.ts
 *  readDefaultFilter) before it is widened; `onRail` is told what the visit saw. Both optional, so a caller that
 *  wants neither is unchanged. */
export interface RailHooks { readonly readDefaultFilter?: boolean; readonly onRail?: (seen: RailSeen) => void | Promise<void> }

/** The fixtures tab with `stageId`'s rail open, every run-sheet row showing. */
async function railFor(c: PageCtx, where: DivisionWhere, stageId: string, hooks: RailHooks): Promise<Locator> {
  const { page } = c;
  const sheet = page.locator(railSheetSelector(stageId));
  const trigger = page.locator(railTriggerSelector(stageId));
  // The first act is the run sheet's filter, the fold's trigger or the sheet's
  // own button — whichever the screen asks for first (I-1).
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug, "fixtures"), { control: page.locator(RUN_SHEET_FILTER_OPTIONS).or(trigger).or(sheet.locator("button")), what: `the run sheet's filter and stage ${stageId}'s rail` });
  const t = navBudget(c);
  await awaitScreen(() => sheet.waitFor({ state: "attached", timeout: t }), `the stage rail for stage ${stageId}`, t);
  // The sheet as it arrived BEFORE it is widened (W1d D17), then widened.
  const defaultFilter = await readThenShowAll(c, hooks.readDefaultFilter === true);
  const fold = await openFold(page, trigger, sheet, actBudget(c, 1));
  await hooks.onRail?.({ fold, defaultFilter });
  return sheet;
}

/** Generate answered rows created, yet none of them carries a fixture number.
 *  fixtures.fixture_no is NOT NULL and every insert is numbered by a trigger
 *  (V263__routing_slugs.sql:37-53), so this is a broken answer — refused by
 *  name rather than quietly skipping the check that the screen drew them. */
export class GeneratedWithoutFixtureNumbers extends Error {
  readonly created: number;
  constructor(created: number) {
    super(`browser: generate answered ${created} fixtures created but no fixture number among them — fixture_no is NOT NULL (V263), so the run sheet has no row to prove the screen by`);
    this.name = "GeneratedWithoutFixtureNumbers";
    this.created = created;
  }
}

/** The run-sheet row that proves a generate drew: the highest fixture number
 *  in the answer (numbers only grow), or null when nothing was created and
 *  nothing new is drawn. */
export function newestCreatedFixtureNo(out: { readonly created: GenerateOut["created"]; readonly fixtures: readonly Pick<FixtureRow, "fixture_no">[] }): number | null {
  if (out.created === 0) return null;
  const newest = Math.max(0, ...out.fixtures.map((f) => f.fixture_no ?? 0));
  if (newest < 1) throw new GeneratedWithoutFixtureNumbers(out.created);
  return newest;
}

/** Generate `stageId`'s fixtures from its rail; the product's GenerateOut. */
export async function generateUi(c: PageCtx, where: DivisionWhere, stageId: string, hooks: RailHooks = {}): Promise<GenerateOut> {
  const { page } = c;
  const sheet = await railFor(c, where, stageId, hooks);
  const before = await shoot(c, "05-generated-before");
  const { data } = await actAndAwait<GenerateOut>(page, { method: "POST", path: exactPath(`/api/v1/stages/${stageId}/generate`) },
    () => sheet.getByTestId(TESTID.stageGenerate.id).click({ timeout: actBudget(c, 1) }), actBudget(c, 1));
  // The screen proves it once the refresh draws the NEWEST row. Nothing
  // created, nothing new to draw — and nothing to differ.
  const newest = newestCreatedFixtureNo(data);
  if (newest !== null) {
    const t = navBudget(c);
    await awaitScreen(() => page.locator(fixtureRowSelector(newest)).waitFor({ state: "attached", timeout: t }), `run-sheet row #${newest} after generate`, t);
  }
  await shoot(c, "05-generated", newest !== null ? before : undefined);
  return data;
}

/** Where a stage sits among its division's stages (W1d item 22), by seq: its 1-based ordinal and whether it is the last. */
export interface StagePosition { readonly ordinal: number; readonly last: boolean }
/** The place a caller that names none means: the division's one stage. */
const ONLY_STAGE: StagePosition = Object.freeze({ ordinal: 1, last: true });

/** The two pictures a stage's completion is filed under, named for its place: the LAST stage's is `08-completed`
 *  (the picture of the division's completion), an earlier one's is `07-stage-<ordinal>-completed`. Before W1d
 *  item 22 every completion was `08-completed`, so a multi-stage case's first browser completion (the group stage,
 *  with the knockout's proposal still pending) was filed as the division's. */
export function completionShots(at: StagePosition): { before: string; after: string } {
  if (!Number.isInteger(at.ordinal) || at.ordinal < 1) throw new RangeError(`browser: a stage's place in its division starts at 1, got ${at.ordinal}`);
  const after = at.last ? "08-completed" : `07-stage-${at.ordinal}-completed`;
  return { before: `${after}-before`, after };
}

/** Complete `stageId` from its rail; the product's CompleteOut. At most once
 *  per stage is the DRIVER's rule (HttpDriver's DriverMisuse), not this page's.
 *  `at` is the stage's place in its division (the driver knows it); it names
 *  the pictures and is the division's one stage when omitted. */
export async function completeStageUi(c: PageCtx, where: DivisionWhere, stageId: string, at: StagePosition = ONLY_STAGE, hooks: RailHooks = {}): Promise<CompleteOut> {
  const { page } = c;
  const shots = completionShots(at);
  const sheet = await railFor(c, where, stageId, hooks);
  const complete = sheet.getByTestId(TESTID.stageComplete.id);
  const before = await shoot(c, shots.before);
  const { data } = await actAndAwait<CompleteOut>(page, { method: "POST", path: exactPath(`/api/v1/stages/${stageId}/complete`) },
    () => complete.click({ timeout: actBudget(c, 1) }), actBudget(c, 1));
  // A completed stage's rail drops its Generate/Complete block (:476).
  if (data.completed) {
    const t = navBudget(c);
    await awaitScreen(() => complete.waitFor({ state: "detached", timeout: t }), `stage ${stageId}'s rail without Complete`, t);
  }
  await shoot(c, shots.after, data.completed ? before : undefined);
  return data;
}
