import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Match Day B1 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §9, "Needs you lives in one place at a time").
 *
 * On a match day — the competition has a match today, or one in play — the competition page carries NO Needs-you list: the
 * whole list lives in Match Day, behind its header's attention button, and the competition page shows one line pointing
 * there, beside Open Match Day in its header. Before the day the list is the competition page's, as it always was.
 *
 * `needsYouInMatchDay` is for a test standing on the competition page on a match day: it asserts the page lists nothing,
 * follows the one line into Match Day, opens the list there and returns it. So a kind asserted on the returned list has been
 * seen in exactly one place — never zero, never two.
 */
export async function needsYouInMatchDay(page: Page): Promise<Locator> {
  // The page rendered (the positive half), and it is a match day by its own header.
  await expect(page.getByTestId("desk-ledger-row").first()).toBeAttached();
  await expect(page.getByTestId("desk-tool-match-day")).toBeVisible();
  // Nothing listed here: no section, and no row of one anywhere on the page.
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  await expect(page.locator("[data-attention]")).toHaveCount(0);

  const line = page.getByTestId("desk-needs-you-in-match-day");
  await expect(line).toBeVisible();
  await expect(line).toContainText(/\d+ things? needs? you, in Match Day/);
  await line.click();
  await expect(page).toHaveURL(/\/match-day$/);

  const toggle = page.getByTestId("md-needs-you-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = page.getByTestId("md-needs-you");
  await expect(list).toBeVisible();
  return list;
}

/** Before the day: the competition page offers no way into Match Day and keeps the list itself. Returns that list. */
export async function needsYouOnCompetitionPage(page: Page): Promise<Locator> {
  const needs = page.getByTestId("desk-needs-you");
  await expect(needs).toBeVisible();
  await expect(page.getByTestId("desk-tool-match-day")).toHaveCount(0);
  await expect(page.getByTestId("desk-needs-you-in-match-day")).toHaveCount(0);
  return needs;
}
