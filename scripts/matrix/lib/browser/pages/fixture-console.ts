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
//  - The console polls only every 15 s (scorepad/use-fixture-stream.ts:21),
//    and a console loaded before the fixture's last event is answered
//    SEQ_CONFLICT — so both acts reload first, as the bench's
//    reloadConsoleBeforeAction does (tap-play.ts:456).
import type { Page } from "playwright";
import { FINALIZE_TESTID, FORFEIT_TESTID, START_MATCH_TESTID, organiserStepsFor, type PadPage, type TapStep } from "../../../../bench/lib/drivers/scorer.ts";
import { executeSteps } from "../../pads/execute.ts";
import { BadBudget, budgetMs } from "../budget.ts";
import { actAndAwait } from "../respond.ts";
import type { FixtureRow, PostedEvent } from "../../driver/types.ts";
import { actBudget, awaitScreen, exactPath, navBudget, shoot, stepBudget, type PageCtx } from "./ctx.ts";

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
  await page.reload({ timeout: nav });
  const posted: PostedEvent[] = [];
  const start = page.getByTestId(START_MATCH_TESTID);
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
  await page.reload({ timeout: nav });
  const finalize = page.getByTestId(FINALIZE_TESTID);
  await awaitScreen(() => finalize.waitFor({ state: "visible", timeout: nav }), "the console's Finalize, for a decided match", nav);
  const before = await shoot(c, "09-finalized-before");
  const { data } = await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(fixtureId) }, () => finalize.click({ timeout: t }), t);
  await awaitScreen(() => finalize.waitFor({ state: "detached", timeout: nav }), "the console, finalized", nav);
  await shoot(c, "09-finalized", before);
  return data;
}
