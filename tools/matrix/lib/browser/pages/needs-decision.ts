// The organiser's "Needs a decision" block on an open fixture console, and its settle dialog (W2a Task 14 Step 6;
// plan Task 11, spec §5.5). A bracket match that ended level (or was abandoned) is HELD, and only the organiser closes
// it: the block's button opens the dialog, the dialog takes the winner, the method and an optional note, and its
// confirm posts core.settle to the fixture's events route (ORGANISER_ONLY, X-ST-2 — the scorer's pad never does).
//
// The testids are FROZEN by plan Task 11 ("Produces"), and the product file that renders them is loop H's
// (components/v2/needs-decision.tsx, not written when this lane was cut). NEEDS_DECISION_PINS pins each to that file as
// TEXT, like selectors.ts does for the rest — so they are red until H lands, by name, and a rename after that reds them
// instead of timing out mid-run. They are kept here, not in selectors.ts's table, so the existing pin tests stay green
// in the meantime.
//
// What was NOT seen: this page object has never driven the real console (H does not exist yet). The flow below is the
// plan's description; Step 8 is its proof. Nothing here is a recording.
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
  constructor(private readonly c: PageCtx, private readonly fixtureId: string) {}

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
