import type { Locator, Page } from "@playwright/test";

/**
 * The fixture console's header panel bar (owner 2026-11-11): Stream · Remote scoring · Lineup · Match rules · Match actions.
 * ONE panel is open at a time and every panel starts closed, at every width, so a spec that reaches for something inside one
 * opens it first, as a person would. The bar's buttons are one DOM at every width (a 2-column grid on a phone), so unlike the
 * old per-width twins there is exactly one button per panel and it is always visible when offered.
 */
export type ConsolePanel = "stream" | "handover" | "lineup" | "rules" | "actions";

/** The bar button of one panel. Match on `aria-controls`, the one hook every button of the bar carries. */
export function consolePanelButton(page: Page, panel: ConsolePanel): Locator {
  return page.locator(`[data-role="console-panel-bar"] button[aria-controls="console-panel-${panel}"]`);
}

/** The panel's own region (present closed too for Lineup and Match rules, which stay mounted, hidden). */
export function consolePanel(page: Page, panel: ConsolePanel): Locator {
  return page.locator(`[data-role="console-panel"][data-panel="${panel}"]`);
}

/**
 * Open a panel (a no-op when it is already open). Waits for the bar to hydrate. With `optional`, a panel the console does
 * not offer returns false instead of failing — for specs whose sport may or may not have the panel (Lineup).
 */
export async function openConsolePanel(page: Page, panel: ConsolePanel, opts: { optional?: boolean } = {}): Promise<boolean> {
  const button = consolePanelButton(page, panel);
  await page
    .locator('[data-role="console-panel-bar"]')
    .first()
    .waitFor({ state: "attached", timeout: 20_000 })
    .catch(() => undefined);
  if ((await button.count()) === 0) {
    if (opts.optional) return false;
    throw new Error(`the console's panel bar offers no "${panel}" button`);
  }
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await consolePanel(page, panel).waitFor({ state: "visible", timeout: 20_000 });
  return true;
}
