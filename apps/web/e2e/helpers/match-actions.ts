import type { Page } from "@playwright/test";

/**
 * The fixture console keeps Forfeit, Abandon and Finalize in a Match actions panel that starts closed at 768 px and
 * wider (a phone shows it open, with no toggle). Open it before reaching for one of those controls.
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
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.click();
}
