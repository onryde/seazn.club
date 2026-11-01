// Match Day C2: the division's match format, standings points and tie-break order moved from Settings' Match rules block to
// the Division rules strip at the top of the Fixtures tab (`components/v2/rules/division-rules-strip.tsx`). Its panels open
// inline from three toggles; each panel has its own Save. One way in for every spec that used to drive Settings.
import { expect, type Locator, type Page } from "@playwright/test";

export type RulesPanel = "format" | "points" | "tiebreaks";

/** The strip on the division's Fixtures tab (`divisionUrl` without a query), with `panels` open. */
export async function openDivisionRules(page: Page, divisionUrl: string, ...panels: RulesPanel[]): Promise<Locator> {
  await page.goto(`${divisionUrl}?tab=fixtures`);
  const strip = page.getByTestId("division-rules-strip");
  await expect(strip).toBeVisible({ timeout: 20_000 });
  await openPanels(strip, ...panels);
  return strip;
}

/** Open `panels` on a strip already on screen (a toggle already open stays open). */
export async function openPanels(strip: Locator, ...panels: RulesPanel[]): Promise<void> {
  for (const p of panels) {
    const toggle = strip.getByTestId(`division-rules-toggle-${p}`);
    // A click before hydration is a no-op: retry click + check, clicking only a toggle still closed.
    await expect(async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(strip.getByTestId(`division-rules-panel-${p}`)).toBeVisible();
  }
}

/** The Match format panel's Save ("Save match format"). */
export const saveFormat = (strip: Locator): Locator => strip.getByTestId("division-rules-format-save");
/** The Points panel's Save (offered once a box differs from what is stored). */
export const savePoints = (strip: Locator): Locator => strip.getByTestId("division-points-save");
