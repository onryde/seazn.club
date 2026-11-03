import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, stageCardOf } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { uiEn } from "../match-room-kit";

/**
 * UI5 (owner, demo of 2026-11-03): four fixes to the division page, WALKED by an organiser. The owner's rule (2026-11-01): every
 * event under test is tapped, the API only reaches a state, each walk runs to its terminal state and reads back what a person
 * sees. At the walkthrough project's 1280, on the shared Pro organisation, one competition per test.
 *
 *   1. The "Starting locks the setup" banner is gone from the Fixtures tab of a division being set up. The lock is still said
 *      where it always was: the Start dialog names it, and after Start the Entrants tab says the list is locked.
 *
 * Every string asserted is read from the dictionary (`uiEn`), except the removed banner's own title, which no dictionary holds
 * any more (that is the point) and is spelled out once below. Budgets are derived from the navigations and taps (class 20).
 * One sport (generic) for item 1 on purpose: the banner was drawn the same way for every sport.
 */

const NAV_MS = 20_000;
const ACT_MS = 4_000;
const SEED_MS = 45_000;
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

/** The removed banner's English title, as `tips.division.start-locks.title` said it until UI5. */
const REMOVED_BANNER_TITLE = "Starting locks the setup";

async function seedLeague(request: APIRequestContext, label: string, entrants: string[]): Promise<{ divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `UI5 ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: label,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const ents = await addEntrantsViaApi(request, div.data!.id, entrants.map((n) => `${n} ${TAG}`));
  expect(ents.ids, "entrants").toHaveLength(entrants.length);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  const gen = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  return { divisionId: div.data!.id, stageId: stage.data!.id };
}

test.describe("UI5: the division page's owner fixes, walked", () => {
  test("1. no start-locks banner while setting up; Start still names the lock, and the Entrants tab says it after", async ({ page, request }) => {
    test.setTimeout(budget(3, 6));
    const { divisionId, stageId } = await seedLeague(request, "Banner", ["Ana", "Ben", "Cy", "Di"]);
    const base = await divisionPath(request, divisionId);

    // The state the banner used to show in: an organiser, the division set up (not started), a stage built, nothing played.
    await page.goto(`${base}?tab=fixtures`, { waitUntil: "load" });
    await dismissCookieBanner(page);
    await expect(stageCardOf(page, stageId), "the stage card is on the Fixtures tab (the loaded page)").toBeVisible({ timeout: NAV_MS });
    await expect(page.getByTestId("launch-start-division"), "premise: the division is not started").toBeVisible();
    await expect(page.getByText(REMOVED_BANNER_TITLE), "no start-locks banner").toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // The lock is still said where it belongs: the Start dialog names it, before anything is started.
    await page.getByTestId("launch-start-division").click();
    const dialog = page.getByTestId("start-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("start-confirm-format-locks")).toHaveText(uiEn["launch.confirm.formatLocksNow"]!);
    await dialog.getByTestId("start-confirm-confirm").click();
    await expect(page.getByTestId("launch-start-division"), "started: no Start button").toHaveCount(0, { timeout: NAV_MS });

    // Terminal state: started. The Entrants tab says the list is locked, and the Fixtures tab still has no banner.
    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await expect(page.getByTestId("entrants-roster-locked")).toHaveText(uiEn["entrants.locked.note"]!, { timeout: NAV_MS });
    await page.goto(`${base}?tab=fixtures`, { waitUntil: "load" });
    await expect(stageCardOf(page, stageId)).toBeVisible({ timeout: NAV_MS });
    await expect(page.getByText(REMOVED_BANNER_TITLE)).toHaveCount(0);
  });
});
