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

/** The Match rules panel's Save ("Save match rules"). */
export const saveFormat = (strip: Locator): Locator => strip.getByTestId("division-rules-format-save");
/** The Points panel's Save (offered once a box differs from what is stored). */
export const savePoints = (strip: Locator): Locator => strip.getByTestId("division-points-save");

// FMT5: the division's FORMAT (its stage structure) moved from Settings › Format onto the same card, behind its Format
// button (`components/v2/rules/division-format.tsx`), which opens a dialog holding the builder's own picker
// (`components/v2/format-picker.tsx`, so its cards and knobs wear the builder's testids).

/** The card's Format button on the division's Fixtures tab (`divisionUrl` without a query). */
export async function formatButton(page: Page, divisionUrl: string): Promise<Locator> {
  await page.goto(`${divisionUrl}?tab=fixtures`);
  const button = page.getByTestId("division-rules-format");
  await expect(button).toBeVisible({ timeout: 20_000 });
  return button;
}

/** The Format dialog, opened from the card's Format button. */
export async function openFormatDialog(page: Page, divisionUrl: string): Promise<Locator> {
  const button = await formatButton(page, divisionUrl);
  const dialog = page.getByRole("dialog");
  // A click before hydration is a no-op: retry the click until the dialog is up.
  await expect(async () => {
    if ((await dialog.count()) === 0) await button.click();
    await expect(dialog.getByTestId("division-format-dialog")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return dialog;
}

/** Pick `template` in the open dialog's picker, unfolding "Show all" first when the card is folded away. */
export async function pickFormat(dialog: Locator, template: string): Promise<void> {
  const card = dialog.locator(`label[data-template="${template}"]`);
  await expect(card, `the picker offers ${template}`).toHaveCount(1);
  if (!(await card.isVisible())) await dialog.getByTestId("division-builder-show-all").click();
  await card.click();
  await expect(card.locator('input[type="radio"]')).toBeChecked();
}

/** The Format dialog's Save ("Save format"). */
export const saveFormatDialog = (dialog: Locator): Locator => dialog.getByTestId("division-format-save");
