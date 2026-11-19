import { test, expect } from "@playwright/test";
import { expectNoHorizontalScroll, seedRosteredFixture, TAG } from "./helpers";
import { ledger, openLiveConsole, pad } from "./scorepad-v3-football-kit";

// Scoring-defects item 5 (2026-11-19): a football match with NO lineup set. The goal dock asks "who scored?" by offering the
// scoring side's on-pitch players; with no lineup there are none, and the dock used to show only its two flag chips and say
// nothing, where every other scorer surface (action-form, context-strip, guided-sheet, swap-sheet) says
// "No roster available yet." (`scorepad.attribution.noRoster`). Driven through the real console; the message is the SAME key.
test.describe.configure({ mode: "parallel" });

const dock = (page: import("@playwright/test").Page) => pad(page).locator('[data-role="v3-dock"]');

test("football v3: the goal dock of a match with NO lineup says there is no roster, and the goal still records", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB NoRoster ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBN Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBN Away ${TAG}`, positionKey: "GK" }],
    skipLineups: true,
  });
  await openLiveConsole(page, fx);

  await pad(page).locator('[data-tile-id="goal-home"]').click();
  await expect(dock(page)).toBeVisible({ timeout: 10_000 });
  await expect(dock(page), "the flag chips are still offered").toContainText("Own goal");
  await expect(
    dock(page).getByTestId("pad-dock-no-roster"),
    "the dock says why there is nobody to pick",
  ).toHaveText("No roster available yet.");
  await expect(dock(page).locator('[data-testid^="pad-dock-chip-scorer:"]'), "and offers no scorer chip").toHaveCount(0);
  await expectNoHorizontalScroll(page);

  await expect.poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.goal").length, { timeout: 30_000 }).toBe(1);
});

test("football v3: the negative pair - a match WITH a lineup offers its scorers and shows no roster message", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB WithRoster ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBW Scorer ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBW Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  await pad(page).locator('[data-tile-id="goal-home"]').click();
  await expect(dock(page)).toBeVisible({ timeout: 10_000 });
  await expect(dock(page).getByRole("button", { name: `V3 FBW Scorer ${TAG}`, exact: true })).toBeVisible();
  await expect(dock(page).getByTestId("pad-dock-no-roster")).toHaveCount(0);
});
