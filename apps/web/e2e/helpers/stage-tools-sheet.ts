// Match Day C3 (review round 1, phone ruling): the stage card's three settings buttons and the ONE phone trigger. Below `md` an editor's
// header buttons are hidden and the same three are the TOP rows of the card's "Stage tools" sheet; from `md` up the header carries them
// and the sheet's rows are not shown. Shared by `stage-card-c3.spec.ts` (1280) and `mobile.spec.ts` (every phone and tablet width), so the
// branch that only a phone reaches runs where a phone runs. Gated on the trigger being VISIBLE, never on a width literal (AGENTS.md rule 22).
import { expect, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalScroll } from "../helpers";

const PANELS = ["format", "points", "tiebreaks"] as const;

/** Drive one table stage's card (a league with fixtures, so Complete is in the sheet): returns which branch it took. */
export async function expectStageToolsSheet(page: Page, card: Locator, stageId: string): Promise<"sheet" | "header"> {
  const trigger = card.getByTestId("stage-rail-trigger");
  const folded = await trigger.isVisible();
  // The retired "Stage settings" trigger and menu are gone at every width; the card has exactly one phone trigger.
  await expect(card.getByTestId("stage-settings-trigger")).toHaveCount(0);
  await expect(card.getByTestId("stage-settings-menu")).toHaveCount(0);
  await expect(trigger, "one trigger per stage").toHaveCount(1);
  // Each button exists twice at every width (the header's and the sheet's row - one DOM, two placements): attached always.
  for (const panel of PANELS) {
    await expect(card.getByTestId(`stage-tool-${panel}`), `${panel}: the header button`).toHaveCount(1);
    await expect(card.getByTestId(`stage-sheet-tool-${panel}`), `${panel}: the sheet row`).toHaveCount(1);
  }
  if (folded) {
    // Below md: the header buttons are hidden, the sheet is closed - its rows attached but not visible - until the trigger is tapped.
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    for (const panel of PANELS) {
      await expect(card.getByTestId(`stage-tool-${panel}`), `${panel}: header hidden`).toBeHidden();
      await expect(card.getByTestId(`stage-sheet-tool-${panel}`), `${panel}: row attached`).toBeAttached();
      await expect(card.getByTestId(`stage-sheet-tool-${panel}`), `${panel}: row hidden while the sheet is closed`).toBeHidden();
    }
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const completeY = (await card.getByTestId("stage-complete").boundingBox())!.y;
    let rows = 0;
    for (const panel of PANELS) {
      const row = card.getByTestId(`stage-sheet-tool-${panel}`);
      await expect(row).toBeVisible();
      const box = (await row.boundingBox())!;
      expect(box.height, `${panel}: 44px tap floor`).toBeGreaterThanOrEqual(44);
      expect(box.y, `${panel}: a TOP row of the sheet - above the actions`).toBeLessThan(completeY);
      // Hit-test, not paint: the row is what a finger lands on at its centre.
      const hit = await row.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at === el || el.contains(at);
      });
      expect(hit, `${panel}: nothing covers the row`).toBe(true);
      rows++;
    }
    expect(rows, "anti-vacuity: every row measured").toBe(PANELS.length);
    // Escape puts the sheet away without opening anything, and hands focus back to the trigger.
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger, "focus returns to the control that opened the sheet").toBeFocused();
    await expect(card.locator(`#stage-panel-${stageId}-points`)).toHaveCount(0);
    // Choosing a row opens its panel and closes the sheet.
    await trigger.click();
    await card.getByTestId("stage-sheet-tool-points").click();
    await expect(card.getByTestId(`stage-points-${stageId}`), "the panel opened").toBeVisible();
    await expect(trigger, "choosing a row closes the sheet").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("stage-rail-backdrop")).toHaveCount(0);
    // A second look at the same row: it now reads pressed, and tapping it again closes the panel (the sequence, not one tap).
    await trigger.click();
    await expect(card.getByTestId("stage-sheet-tool-points")).toHaveAttribute("aria-expanded", "true");
    await card.getByTestId("stage-sheet-tool-points").click();
    await expect(card.getByTestId(`stage-points-${stageId}`), "tapped again, the panel closes").toHaveCount(0);
  } else {
    // md and up: the buttons sit in the header; the sheet's rows are the phone's twin and are not on screen.
    for (const panel of PANELS) {
      await expect(card.getByTestId(`stage-tool-${panel}`)).toBeVisible();
      await expect(card.getByTestId(`stage-sheet-tool-${panel}`), `${panel}: the phone row is not shown here`).toBeHidden();
    }
  }
  await expectNoHorizontalScroll(page);
  return folded ? "sheet" : "header";
}
