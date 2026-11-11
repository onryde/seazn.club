import type { Page } from "@playwright/test";
import { openConsolePanel } from "./console-panels";

/**
 * The fixture console keeps Forfeit, Abandon and Finalize's neighbours in a Match actions panel that starts CLOSED at every
 * width (owner 2026-11-11: one of the five header panels, opened from the panel bar). Open it before reaching for Forfeit,
 * Abandon or Declare joint winners. A no-op when the console offers no Match actions button (a scorer, a decided match) —
 * the caller's own assertion says whether the controls should be there.
 */
export async function openMatchActions(page: Page): Promise<void> {
  // The console hydrates after navigation; wait for the bar or its panel before deciding there is none.
  await page
    .locator('[data-role="console-panel-bar"], [data-role="match-actions"]')
    .first()
    .waitFor({ state: "attached", timeout: 20_000 })
    .catch(() => undefined);
  await openConsolePanel(page, "actions", { optional: true });
}
