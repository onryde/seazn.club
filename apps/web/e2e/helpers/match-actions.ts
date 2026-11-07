import { expect, type Page } from "@playwright/test";

/**
 * The fixture console keeps Forfeit, Abandon and Finalize in a Match actions panel. From 768 px up it is absent until
 * its toggle opens it, right under the Scoring header; a phone shows it open with no toggle. Open it before reaching
 * for one of those controls.
 *
 * A click that lands before the page hydrates does nothing, so the click is retried until the toggle itself reports
 * `aria-expanded="true"` — a single click would race hydration and the panel would never appear.
 */
export async function openMatchActions(page: Page): Promise<void> {
  // The console hydrates after navigation; wait for the toggle or the panel itself before deciding there is none.
  await page
    .locator('[data-testid="match-actions-toggle"], [data-role="match-actions"]')
    .first()
    .waitFor({ state: "attached", timeout: 20_000 })
    .catch(() => undefined);
  const toggle = page.getByTestId("match-actions-toggle");
  if ((await toggle.count()) === 0 || !(await toggle.isVisible())) return;
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}
