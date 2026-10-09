// The organiser's "Needs a decision" block on an open fixture console, and its settle dialog (W2a Task 14 Step 6;
// plan Task 11, spec §5.5). A bracket match that ended level (or was abandoned) is HELD, and only the organiser closes
// it: the block's button opens the dialog, the dialog takes the winner, the method and an optional note, and its
// confirm posts core.settle to the fixture's events route (ORGANISER_ONLY, X-ST-2 — the scorer's pad never does).
//
// The testids are FROZEN by plan Task 11, and the product file that renders them is loop H's
// (components/v2/needs-decision.tsx). NEEDS_DECISION_PINS pins each to that file as TEXT, like selectors.ts does for the
// rest, so a rename reds HERE, by name, and not as a timeout mid-run. They are kept here, not in selectors.ts's table.
//
// What was SEEN: Step 8 drove this page object through the real console on a prod build (generic, football, hockey,
// cricket, carrom and badminton bracket cells: abandon, then settle through the dialog; the evidence is
// 11-settle-before/11-settle in every case's shots).
import type { Locator } from "playwright";
import { SETTLE_METHODS } from "@seazn/engine/core";
import type { PostedEvent } from "../../driver/types.ts";
import { actAndAwait } from "../respond.ts";
import { actBudget, awaitScreen, navBudget, reload, shoot, type PageCtx } from "./ctx.ts";
import { eventsPath } from "./fixture-console.ts";
import type { Pin } from "../selectors.ts";

const V2 = "apps/web/src/components/v2";

/** Plan Task 11's frozen testids. The two composed ones are prefixes: `settle-winner-<entrantId>`, `settle-method-<m>`. */
export const NEEDS_DECISION = Object.freeze({
  block: "needs-decision",
  open: "settle-open",
  winnerPrefix: "settle-winner-",
  methodPrefix: "settle-method-",
  note: "settle-note",
  confirm: "settle-confirm",
  error: "settle-error",
});

/** Each testid (or composed prefix) must appear in the file that renders it. Red until loop H lands. */
export const NEEDS_DECISION_PINS: readonly Readonly<{ name: string } & Pin>[] = Object.freeze(
  Object.entries(NEEDS_DECISION).map(([name, needle]) => Object.freeze({ name, needle, file: `${V2}/needs-decision.tsx` })),
);

export type SettleMethodId = (typeof SETTLE_METHODS)[number];

export class UnknownSettleMethod extends Error {
  constructor(method: string) {
    super(`browser: '${method}' is not one of the engine's SETTLE_METHODS (${SETTLE_METHODS.join(", ")}) — the dialog has no radio for it`);
    this.name = "UnknownSettleMethod";
  }
}

export class SettleNeedsAWinner extends Error {
  constructor() {
    super("browser: settle() was given an empty winner entrant id — the dialog's winner buttons are keyed by the entrant, so there is nothing to tap");
    this.name = "SettleNeedsAWinner";
  }
}

/** The block and dialog on ONE fixture's console. The fixture id bounds the answer the page object waits for: the
 *  events route of THAT fixture, so another tab's write is never taken for this settle. */
export class NeedsDecisionPage {
  // Explicit fields, not parameter properties: this file loads under node's strip-only TypeScript (strip-types-loadable.test.ts).
  private readonly c: PageCtx;
  private readonly fixtureId: string;
  constructor(c: PageCtx, fixtureId: string) {
    this.c = c;
    this.fixtureId = fixtureId;
  }

  /** The block, present only while the fixture is held. */
  block(): Locator {
    return this.c.page.getByTestId(NEEDS_DECISION.block);
  }

  /** The refusal text the console shows in the block after the dialog closes (spec §7). */
  error(): Locator {
    return this.c.page.getByTestId(NEEDS_DECISION.error);
  }

  /** Settles the held match: reload first (the console polls only every 15 s, and a console loaded before the last
   *  event is answered SEQ_CONFLICT — fixture-console.ts), open the dialog, pick the winner and the method, write the
   *  note if one is given, confirm, and return the product's own answer to the core.settle it posts. The block going
   *  away is the screen proving it: a settled match is no longer held. A refusal is the RefusedCall the product
   *  answered, with its code. */
  async settle(winnerEntrantId: string, method: SettleMethodId, note?: string): Promise<PostedEvent> {
    if (winnerEntrantId === "") throw new SettleNeedsAWinner();
    if (!(SETTLE_METHODS as readonly string[]).includes(method)) throw new UnknownSettleMethod(method);
    const { c } = this;
    const { page } = c;
    const t = actBudget(c, 1);
    const nav = navBudget(c);
    const block = this.block();
    await reload(c, { control: block, what: "the console's Needs a decision block" });
    await awaitScreen(() => block.waitFor({ state: "visible", timeout: nav }), "the console's Needs a decision block, for a held match", nav);
    await page.getByTestId(NEEDS_DECISION.open).click({ timeout: t });
    await page.getByTestId(`${NEEDS_DECISION.winnerPrefix}${winnerEntrantId}`).click({ timeout: t });
    await page.getByTestId(`${NEEDS_DECISION.methodPrefix}${method}`).check({ timeout: t });
    if (note !== undefined) await page.getByTestId(NEEDS_DECISION.note).fill(note, { timeout: t });
    const before = await shoot(c, "11-settle-before");
    const { data } = await actAndAwait<PostedEvent>(page, { method: "POST", path: eventsPath(this.fixtureId) }, () => page.getByTestId(NEEDS_DECISION.confirm).click({ timeout: t }), t);
    await awaitScreen(() => block.waitFor({ state: "detached", timeout: nav }), "the console, settled (no longer held)", nav);
    await shoot(c, "11-settle", before);
    return data;
  }
}

/** The page object as a function, the shape BrowserDriver's page seam takes (forfeitUi, abandonUi, voidLastUi). */
export function settleUi(c: PageCtx, fixtureId: string, winnerEntrantId: string, method: SettleMethodId, note?: string): Promise<PostedEvent> {
  return new NeedsDecisionPage(c, fixtureId).settle(winnerEntrantId, method, note);
}
