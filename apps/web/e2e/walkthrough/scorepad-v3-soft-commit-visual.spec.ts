import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "../helpers";

/**
 * Walkthrough — soft-commit vs immediate, visual tour.
 *
 * One serial path a reviewer can watch (`DEMO_PACE` / headed): cricket plain
 * (no dock) → noball (dock) → football goal (dock) → clock start (no dock).
 * Screenshots land under e2e-artifacts/soft-commit-walkthrough/.
 *
 * Budget: ~15–25s headless; multi-viewport shots ×7. Keep on walkthrough
 * project (serial) — do not move into the heavy parallel shard.
 */
test.describe.configure({ mode: "serial" });

const ARTIFACT = "e2e-artifacts/soft-commit-walkthrough";
const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}
function tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status).toBe(200);
  return res.data ?? [];
}

async function beat(page: Page): Promise<void> {
  if (PACE > 0) await page.waitForTimeout(PACE);
}

let shotNo = 0;
async function shot(page: Page, caption: string): Promise<void> {
  shotNo += 1;
  const n = String(shotNo).padStart(2, "0");
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${ARTIFACT}/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

test("walkthrough — soft-commit vs immediate, visual", async ({ page }) => {
  test.setTimeout(Math.max(180_000, HOLD_MS * 4 + 90_000));
  shotNo = 0;

  // ---- Cricket: plain (immediate) then noball (hold) ----
  const cricket = await seedRosteredFixture(page.request, {
    label: `WT SoftCommit Cricket ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `WT SC Striker ${TAG}` }, { fullName: `WT SC Non ${TAG}` }],
    away: [{ fullName: `WT SC Bowl ${TAG}` }],
  });
  await page.goto(await fixturePath(page.request, cricket.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, cricket.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await shot(page, "cricket-open");

  await beat(page);
  await tile(page, "run1").click();
  await expect(dock(page), "plain run: no enrichment dock").toHaveCount(0, { timeout: 3_000 });
  await expect
    .poll(async () => (await ledger(page.request, cricket.fixtureId)).filter((e) => e.type === "cricket.ball").length, {
      timeout: Math.min(2_500, HOLD_MS - 500),
    })
    .toBe(1);
  await shot(page, "cricket-plain-no-dock");

  await beat(page);
  await tile(page, "extra-noball").click();
  await expect(dock(page), "noball: soft-commit dock").toBeVisible({ timeout: 5_000 });
  await shot(page, "cricket-noball-dock");
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(dock(page)).toHaveCount(0, { timeout: 5_000 });
  await shot(page, "cricket-noball-flushed");

  // ---- Football: goal hold + clock immediate ----
  const football = await seedRosteredFixture(page.request, {
    label: `WT SoftCommit Football ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `WT SC F Home ${TAG}` }, { fullName: `WT SC F Home2 ${TAG}` }],
    away: [{ fullName: `WT SC F Away ${TAG}` }],
  });
  await page.goto(await fixturePath(page.request, football.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, football.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await shot(page, "football-open");

  await beat(page);
  await tile(page, "goal-home").click();
  await expect(dock(page)).toBeVisible({ timeout: 5_000 });
  await shot(page, "football-goal-dock");
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(dock(page)).toHaveCount(0, { timeout: 5_000 });

  const beforeClock = (await ledger(page.request, football.fixtureId)).filter((e) => e.type === "football.clock")
    .length;
  await beat(page);
  await pad(page).locator('[data-role="v3-clock-toggle"]').click();
  await expect(dock(page)).toHaveCount(0);
  await expect
    .poll(
      async () => (await ledger(page.request, football.fixtureId)).filter((e) => e.type === "football.clock").length,
      { timeout: Math.min(2_500, HOLD_MS - 500) },
    )
    .toBe(beforeClock + 1);
  await shot(page, "football-clock-no-dock");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
