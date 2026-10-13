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
//    starts a match by itself. Since W2b Task 11 its Forfeit is offered BEFORE
//    play too (the dialog's walkover and "Neither", D3 R2), so forfeitUi drives
//    a forfeit on a scheduled match through the dialog as well, and never taps
//    Start: a walkover is recorded before core.start (review I-1, which retired
//    the old refusal of a console still showing Start).
//  - The forfeit dialog (W2b Task 11, forfeit-dialog.tsx `ForfeitDialog`)
//    opens from `score-forfeit` while not decided (and on a chess tie-break
//    that is pending, R14): `forfeit-who-home|away|both` →
//    `forfeit-why-<reason>` (only the reasons the engine's phase guard admits,
//    never the cascade's withdrew) → `forfeit-confirm` →
//    post("core.forfeit", {by, reason}). Those steps are the bench's own
//    organiserStepsFor (scorer.ts, ruling 38), run through the copied
//    executeStep (lib/pads/execute.ts). The dialog OMITS a choice it does not
//    offer — Neither on a match that feeds no next match (D19: the
//    `forfeit-guidance-no-next-match` line shows instead), a reason the phase
//    does not admit — so forfeitUi COUNTS the side and the reason chips once
//    the dialog (`forfeit-dialog`) and its reason group are up, and an absent
//    one is ConsoleChoiceNotOffered by name, never a wait that times out
//    (Task 11 re-review N-1).
//  - "Void last entry" (:1277-1286, W1d Task 14) has no testid: it is the button whose accessible name is the
//    dictionary's score.voidLast, and its title (score.voidLastTitle) names the entry it would void. It voids the
//    newest event that is neither a core.void nor already voided (:880 lastVoidable) — an entry the console
//    chooses itself, so the page object reports the answer and the caller judges the choice. It renders only while
//    the match is scoring (not decided-locked), so it is offered on an in-play fixture.
//  - "Abandon" (W2a Task 14 Step 8) has no testid either: it is the `btn btn-danger` button whose accessible name is the
//    dictionary's score.abandon. It opens the console's TextPromptDialog reason prompt (score-prompt-reason /
//    score-prompt-submit — the abandon's alone since W2b Task 11) and submits send("core.abandon", { reason }). It is
//    offered only while `offerAbandon` (not decided, not HELD, an organiser), so an abandoned or held match drops it.
//  - The console polls only every 15 s (scorepad/use-fixture-stream.ts:21),
//    and a console loaded before the fixture's last event is answered
//    SEQ_CONFLICT — so both acts reload first, as the bench's
//    reloadConsoleBeforeAction does (tap-play.ts:456).
import type { Page } from "playwright";
import { FINALIZE_TESTID, FORFEIT_TESTID, FORFEIT_WHO_TESTID_PREFIX, FORFEIT_WHY_TESTID_PREFIX, PROMPT_REASON_TESTID, PROMPT_SUBMIT_TESTID, organiserStepsFor, selectorForTapStep, type PadPage, type TapStep } from "../../../../bench/lib/drivers/scorer.ts";
import { executeStep, executeSteps } from "../../pads/execute.ts";
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

/** The forfeit dialog's panel and its no-next-match guidance (forfeit-dialog.tsx `ForfeitDialog`). */
export const FORFEIT_DIALOG_TESTID = "forfeit-dialog";
export const FORFEIT_GUIDANCE_NO_NEXT_MATCH_TESTID = "forfeit-guidance-no-next-match";
/** The dialog's "Neither side turned up" (organiserStepsFor's side chip for `by: "both"`). */
export const FORFEIT_NEITHER_TESTID = `${FORFEIT_WHO_TESTID_PREFIX}both`;

/** The open forfeit dialog does not render the choice a forfeit needs: a side (`forfeit-who-<side>`; Neither is
 *  `forfeit-who-both`) or a reason (`forfeit-why-<reason>`). Counted once the dialog is up, never waited for, so it is
 *  this error by name and not a step timeout. `guidance` says whether the dialog showed the no-next-match line in the
 *  choice's place (D19), which is the one case BrowserDriver answers over http (Task 11 re-review N-1). */
export class ConsoleChoiceNotOffered extends Error {
  readonly fixtureId: string;
  readonly testid: string;
  readonly guidance: boolean;
  constructor(fixtureId: string, testid: string, guidance: boolean) {
    super(`browser: fixture ${fixtureId}'s forfeit dialog does not offer ${testid}${guidance ? " (it shows the no-next-match guidance instead)" : ""} — the product withholds the choice, so there is nothing to tap`);
    this.name = "ConsoleChoiceNotOffered";
    this.fixtureId = fixtureId;
    this.testid = testid;
    this.guidance = guidance;
  }
}

export type ForfeitFixture = Pick<FixtureRow, "id" | "home_entrant_id" | "away_entrant_id">;
/** D1's reasons (streams/types.ts); the console's forfeit dialog offers them as choices (W2b Task 11), less withdrew. */
export type { ForfeitReason } from "../../streams/types.ts";
import type { ForfeitReason } from "../../streams/types.ts";

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

/** The choice `step` taps is rendered in the open dialog, or ConsoleChoiceNotOffered: `count()` never waits. */
async function requireOffered(page: Page, fixtureId: string, step: TapStep): Promise<void> {
  if ((await page.locator(selectorForTapStep(step)).count()) > 0) return;
  const guidance = (await page.getByTestId(FORFEIT_GUIDANCE_NO_NEXT_MATCH_TESTID).count()) > 0;
  throw new ConsoleChoiceNotOffered(fixtureId, step.kind === "testid" ? step.testid : selectorForTapStep(step), guidance);
}

/** Forfeits the open console's match for `by` (an entrant id, or "both" for the dialog's Neither); the console's answer
 *  to the core.forfeit, as a one-element list. The match may be scheduled or under way: the dialog offers a walkover
 *  and Neither before Start (D3 R2), and Start is never tapped. A `by` naming neither side, or an unauthorable reason,
 *  is the bench's own refusal (organiserStepsFor). A side or reason the dialog does not render — Neither where the
 *  match feeds no next match (D19), a reason the PHASE does not admit — is ConsoleChoiceNotOffered by name: the chip is
 *  COUNTED once the dialog (then its reason group) is up, so nothing waits on a choice the product withholds, and
 *  nothing is posted. */
export async function forfeitUi(c: PageCtx, fixture: ForfeitFixture, by: string, reason: ForfeitReason): Promise<PostedEvent[]> {
  const { page } = c;
  const steps = forfeitSteps(fixture, by, reason);
  const [opener, who, why] = steps;
  if (opener === undefined || who === undefined || why === undefined) throw new Error(`browser: the forfeit's steps are opener, side, reason, Confirm — got ${steps.length}`);
  const nav = navBudget(c);
  const { stepMs } = forfeitBudgets(c, steps.length);
  // The Forfeit opener is the first act, scheduled or under way.
  await reload(c, { control: page.getByTestId(FORFEIT_TESTID), what: "the console's Forfeit" });
  const posted: PostedEvent[] = [];
  const before = await shoot(c, "07-forfeit-before");
  // Open the dialog and wait for its PANEL (always rendered), then count the side; pick it, wait for the reason group
  // (an offered side always has one), then count the reason. Only then the reason and Confirm, answered by the post.
  await executeStep(page, opener, stepMs);
  await page.getByTestId(FORFEIT_DIALOG_TESTID).waitFor({ timeout: stepMs });
  await requireOffered(page, fixture.id, who);
  await executeStep(page, who, stepMs);
  await page.locator(`[data-testid^="${FORFEIT_WHY_TESTID_PREFIX}"]`).first().waitFor({ timeout: stepMs });
  await requireOffered(page, fixture.id, why);
  posted.push(await postForfeit(page, c, fixture.id, steps.slice(2)));
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
