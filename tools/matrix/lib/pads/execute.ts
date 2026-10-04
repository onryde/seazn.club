// COPIED from tools/bench/lib/drivers/scorer.ts:232-268 (private there; ruling 38). Keep in step by hand; pad-execute.test.ts pins the kind list.
//
// Three changes, and only these (pad-execute.test.ts compares this body with
// the bench's, the first change normalised away):
//  (a) every TAP_WAIT_TIMEOUT_MS is the caller's `waitMs`. The caller passes
//      budgetMs({ taps: 1, holds: 0, holdMs }) (fixture-console.ts
//      forfeitBudgets), which floors at FLOOR_MS — above TAP_WAIT_TIMEOUT_MS —
//      so a slow width never reds as a timeout (AGENTS class 20);
//  (b) HANDLED_KINDS names the tap kinds the switch below handles;
//  (c) a waitMs that is not a finite number of ms above 0 is refused first
//      (Playwright reads a 0 timeout as no bound at all).
// The selectors are the bench's own selectorForTapStep (imported, ruling 38).
import { selectorForTapStep, type PadPage, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import { assertWaitMs } from "../browser/budget.ts";

export const HANDLED_KINDS: readonly TapStep["kind"][] = Object.freeze(["tile", "choice", "number", "confirm", "testid", "half", "chip", "offeredChip", "releaseHold", "text"] as const);

export async function executeStep(page: PadPage, step: TapStep, waitMs: number): Promise<void> {
  assertWaitMs("waitMs", waitMs);
  const locator = page.locator(selectorForTapStep(step));
  switch (step.kind) {
    case "releaseHold": {
      // `count()` never waits: nothing held is normal, and costs nothing.
      if ((await locator.count()) === 0) return;
      try {
        await locator.click();
      } catch (err) {
        // The hold can release ITSELF (its own HOLD_MS tick) between the
        // presence check and the tap — the dock is gone, which is the goal.
        if ((await locator.count()) > 0) throw err;
      }
      await locator.waitFor({ state: "detached", timeout: waitMs });
      return;
    }
    case "offeredChip":
      await page.locator(selectorForTapStep({ kind: "releaseHold" })).waitFor({ timeout: waitMs });
      if ((await locator.count()) > 0) await locator.click();
      return;
    case "number":
      await locator.waitFor({ timeout: waitMs });
      await locator.fill(String(step.value));
      return;
    case "text":
      await locator.waitFor({ timeout: waitMs });
      await locator.fill(step.value);
      return;
    default:
      await locator.waitFor({ timeout: waitMs });
      await locator.click();
  }
}

export async function executeSteps(page: PadPage, steps: readonly TapStep[], waitMs: number): Promise<void> {
  for (const step of steps) await executeStep(page, step, waitMs);
}
