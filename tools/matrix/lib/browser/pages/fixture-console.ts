// The organiser's own acts on an open fixture console: forfeit and finalize
// (Task 5). The console is opened by openFixtureUi (run-sheet.ts). Product
// facts, read at Step 0 (components/v2/fixture-console.tsx):
//  - send() (:524-560) POSTs /api/v1/fixtures/<id>/events with
//    `{expected_seq: live.last_seq, type, payload, idempotency_key}`, then
//    resync() and router.refresh(); `busy` disables the controls meanwhile.
//    A SEQ_CONFLICT is answered 409 — actAndAwait's RefusedCall.
//  - Finalize is `score-finalize` → send("core.finalize", {}) (:1272-1276):
//    the FIXTURE'S EVENTS ROUTE, not a /finalize endpoint (the brief's Step 0
//    question). It renders only once the page knows the match is decided
//    (`decided`, :714) and sits in the match-actions band, which needs
//    `scoring` (:685 — status not finalized) — so a finalized console drops it.
//  - Start is `score-start-match` → send("core.start", {}) (:1026-1031), shown
//    while the status is scheduled (`started`, :725). The console never
//    starts a match by itself: a forfeit on a scheduled fixture is preceded
//    by the Start tap here, as HttpDriver.forfeit posts [START, forfeit].
//  - ForfeitButton (:1294, :1336-1408) renders while not decided: toggle
//    `score-forfeit` → `score-forfeit-home|away` → TextPromptDialog (opens
//    "walkover") → send("core.forfeit", {by, reason}). Those steps are the
//    bench's own organiserStepsFor (scorer.ts:322-355, ruling 38), run through
//    the copied executeStep (lib/pads/execute.ts).
//  - "Void last entry" (:1277-1286, W1d Task 14) has no testid: it is the button whose accessible name is the
//    dictionary's score.voidLast, and its title (score.voidLastTitle) names the entry it would void. It voids the
//    newest event that is neither a core.void nor already voided (:880 lastVoidable) — an entry the console
//    chooses itself, so the page object reports the answer and the caller judges the choice. It renders only while
//    the match is scoring (not decided-locked), so it is offered on an in-play fixture.
//  - "Abandon" (W2a Task 14 Step 8) has no testid either: it is the `btn btn-danger` button whose accessible name is the
//    dictionary's score.abandon. It opens the TextPromptDialog forfeit's reason prompt also uses (score-prompt-reason /
//    score-prompt-submit) and submits send("core.abandon", { reason }). It is offered only while `offerOrganiserActions`
//    (not decided, not HELD, an organiser), so an abandoned or held match drops it.
//  - The console polls only every 15 s (scorepad/use-fixture-stream.ts:21),
//    and a console loaded before the fixture's last event is answered
//    SEQ_CONFLICT — so both acts reload first, as the bench's
//    reloadConsoleBeforeAction does (tap-play.ts:456).
import type { Page } from "playwright";
import { FINALIZE_TESTID, FORFEIT_TESTID, PROMPT_REASON_TESTID, PROMPT_SUBMIT_TESTID, START_MATCH_TESTID, organiserStepsFor, type PadPage, type TapStep } from "../../../../bench/lib/drivers/scorer.ts";
import { executeSteps } from "../../pads/execute.ts";
import { BadBudget, budgetMs } from "../budget.ts";
import { actAndAwait } from "../respond.ts";
import { NAME } from "../selectors.ts";
import type { FixtureRow, PostedEvent } from "../../driver/types.ts";
import { actBudget, awaitScreen, exactPath, navBudget, reload, shoot, stepBudget, type PageCtx } from "./ctx.ts";

/** The route every console send answers on — finalize's included. */
export function eventsPath(fixtureId: string): RegExp {
  return exactPath(`/api/v1/fixtures/${fixtureId}/events`);
}

export class ForfeitNeedsBothSides extends Error {
  constructor(fixtureId: string) {
    super(`browser: fixture ${fixtureId} has an empty side — the console's Forfeit names two entrants, so there is no forfeit to author`);
    this.name = "ForfeitNeedsBothSides";
  }
}

export type ForfeitFixture = Pick<FixtureRow, "id" | "home_entrant_id" | "away_entrant_id">;
export type ForfeitReason = "walkover" | "retired hurt";

/** The console taps that forfeit `fixture` for `by`: the bench's own
 *  organiserStepsFor (it reads only the two entrants; the config is opaque to
 *  it), refusing a fixture with an empty side first. */
export function forfeitSteps(fixture: ForfeitFixture, by: string, reason: ForfeitReason): readonly TapStep[] {
  if (fixture.home_entrant_id === null || fixture.away_entrant_id === null) throw new ForfeitNeedsBothSides(fixture.id);
  return organiserStepsFor({ type: "core.forfeit", payload: { by, reason } }, { cfg: null, entrants: { home: fixture.home_entrant_id, away: fixture.away_entrant_id } });
}

export interface ForfeitBudgets { readonly stepMs: number; readonly responseMs: number }

/** Bounded waits one step can spend (execute.ts): its waitFor(waitMs), then a
 *  bare click()/fill() under the page's default — stepMs too, once
 *  BrowserDriver has run boundActions (ctx.ts, ruling F). */
const WAITS_PER_STEP = 2;

/** The forfeit's two bounds, both in the product's constants (AGENTS class
 *  20). Each step waits up to `stepMs` for its control and then taps it under
 *  the page default, stepMs as well (executeStep; ctx.ts boundActions); the
 *  events answer lands only after the LAST step, so its wait is every step's
 *  worst case plus one round trip — a slow success must never read as
 *  act-pending. `stepMs` is ctx.ts stepBudget, which floors at FLOOR_MS,
 *  above the bench's TAP_WAIT_TIMEOUT_MS (execute.ts's contract). */
export function forfeitBudgets(c: Pick<PageCtx, "holdMs">, steps: number): ForfeitBudgets {
  if (!(Number.isInteger(steps) && steps >= 1)) throw new BadBudget("steps", steps, "a whole count of at least 1 (a forfeit with no steps posts nothing to wait on)");
  const stepMs = stepBudget(c);
  return { stepMs, responseMs: budgetMs({ base: steps * WAITS_PER_STEP * stepMs, taps: 1, holdMs: c.holdMs }) };
}

/** Taps `steps` on the open console and returns the product's answer to the
 *  core.forfeit they post. The bounds are forfeitBudgets for THESE steps, so
 *  no caller can pass a step count that differs from the steps it taps. */
export async function postForfeit(page: Pick<Page, "waitForResponse"> & PadPage, c: Pick<PageCtx, "holdMs">, fixtureId: string, steps: readonly TapStep[]): Promise<PostedEvent> {
  const b = forfeitBudgets(c, steps.length);
  const { data } = await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(fixtureId) }, () => executeSteps(page, steps, b.stepMs), b.responseMs);
  return data;
}

/** Forfeits the open console's match for `by` (an entrant id); every events
 *  answer the console produced, in order: core.start's first when the fixture
 *  was still scheduled, then core.forfeit's. A `by` naming neither side, or
 *  an unauthorable reason, is the bench's own refusal (organiserStepsFor). */
export async function forfeitUi(c: PageCtx, fixture: ForfeitFixture, by: string, reason: ForfeitReason): Promise<PostedEvent[]> {
  const { page } = c;
  const steps = forfeitSteps(fixture, by, reason);
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const start = page.getByTestId(START_MATCH_TESTID);
  // The first act is Start while the match is scheduled, else the Forfeit toggle.
  await reload(c, { control: start.or(page.getByTestId(FORFEIT_TESTID)), what: "the console's Start or Forfeit" });
  const posted: PostedEvent[] = [];
  if ((await start.count()) > 0) {
    posted.push((await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(fixture.id) }, () => start.click({ timeout: t }), t)).data);
    await awaitScreen(() => start.waitFor({ state: "detached", timeout: nav }), "the console, started", nav);
  }
  const before = await shoot(c, "07-forfeit-before");
  posted.push(await postForfeit(page, c, fixture.id, steps));
  await awaitScreen(() => page.getByTestId(FORFEIT_TESTID).waitFor({ state: "detached", timeout: nav }), "the console, decided by forfeit", nav);
  await shoot(c, "07-forfeit", before);
  return posted;
}

/** Finalizes the open console's decided match; the product's answer to the
 *  core.finalize it posts. */
export async function finalizeUi(c: PageCtx, fixtureId: string): Promise<PostedEvent> {
  const { page } = c;
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const finalize = page.getByTestId(FINALIZE_TESTID);
  await reload(c, { control: finalize, what: "the console's Finalize" });
  await awaitScreen(() => finalize.waitFor({ state: "visible", timeout: nav }), "the console's Finalize, for a decided match", nav);
  const before = await shoot(c, "09-finalized-before");
  const { data } = await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(fixtureId) }, () => finalize.click({ timeout: t }), t);
  await awaitScreen(() => finalize.waitFor({ state: "detached", timeout: nav }), "the console, finalized", nav);
  await shoot(c, "09-finalized", before);
  return data;
}

/** The entry the console's Void last entry button offers to void is named by its title (score.voidLastTitle:
 *  "Void {type} (seq {seq}) — …"). After the void the console offers the next entry or nothing, so the screen
 *  proves the void once no element carries that title any more. */
export async function voidLastUi(c: PageCtx, fixtureId: string): Promise<PostedEvent> {
  const { page } = c;
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const voidLast = page.getByRole("button", { name: NAME.voidLast.text });
  await reload(c, { control: voidLast, what: "the console's Void last entry" });
  await awaitScreen(() => voidLast.waitFor({ state: "visible", timeout: nav }), "the console's Void last entry, offered for a match in play", nav);
  const offered = await voidLast.getAttribute("title", { timeout: t });
  const before = await shoot(c, "10-void-before");
  const { data } = await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(fixtureId) }, () => voidLast.click({ timeout: t }), t);
  if (offered !== null) await awaitScreen(() => page.getByTitle(offered, { exact: true }).waitFor({ state: "detached", timeout: nav }), "the console, no longer offering the entry just voided", nav);
  await shoot(c, "10-void", before);
  return data;
}

export class AbandonNeedsAReason extends Error {
  constructor(fixtureId: string) {
    super(`browser: the console's Abandon on fixture ${fixtureId} was given an empty reason — the prompt is submitted with the reason the event carries, so there is nothing to type`);
    this.name = "AbandonNeedsAReason";
  }
}

/** Abandons the open console's match through its Abandon button and reason prompt (W2a Task 14 Step 8); the product's
 *  answer to the core.abandon the prompt posts. The button going away is the screen proving it: an abandoned (or held)
 *  match is no longer offered Abandon. */
export async function abandonUi(c: PageCtx, fixtureId: string, reason: string): Promise<PostedEvent> {
  if (reason === "") throw new AbandonNeedsAReason(fixtureId);
  const { page } = c;
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const abandon = page.getByRole("button", { name: NAME.abandon.text, exact: true });
  await reload(c, { control: abandon, what: "the console's Abandon" });
  await awaitScreen(() => abandon.waitFor({ state: "visible", timeout: nav }), "the console's Abandon, for a match in play", nav);
  const before = await shoot(c, "12-abandon-before");
  await abandon.click({ timeout: t });
  await page.getByTestId(PROMPT_REASON_TESTID).fill(reason, { timeout: t });
  const { data } = await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(fixtureId) }, () => page.getByTestId(PROMPT_SUBMIT_TESTID).click({ timeout: t }), t);
  await awaitScreen(() => abandon.waitFor({ state: "detached", timeout: nav }), "the console, abandoned", nav);
  await shoot(c, "12-abandon", before);
  return data;
}
