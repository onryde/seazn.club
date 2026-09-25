import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";

// Activity "Void" is two-step: the first tap ARMS the row (Cancel + Confirm
// void), only Confirm writes a core.void. Runs at three widths because the
// armed row swaps one 44px button for two and must not overflow the row.
const SHOTS = process.env.VOID_CONFIRM_SHOT_DIR ?? "/tmp/void-confirm-shots";

const pad = (page: Page) => page.locator('[data-testid="score-pad"]');

async function ledger(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{ id: string; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status).toBe(200);
  return res.data ?? [];
}
const voids = async (request: APIRequestContext, id: string) =>
  (await ledger(request, id)).filter((e) => e.type === "core.void");

for (const width of [320, 768, 1280]) {
  test(`void needs a confirming tap @${width}`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 VoidConfirm ${width} ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `VC Striker ${TAG}` }, { fullName: `VC NonStriker ${TAG}` }],
      away: [{ fullName: `VC Bowler ${TAG}` }],
    });
    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Start match", exact: true }).click();
    for (const runs of ["1", "2"]) {
      await pad(page).getByRole("button", { name: runs, exact: true }).click();
    }
    await expect
      .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length, {
        timeout: 60_000,
      })
      .toBe(2);
    await page.reload();
    await expect(pad(page)).toBeVisible({ timeout: 30_000 });

    const panel = page.locator('[data-role="v3-activity"]');
    const expand = panel.locator('[data-role="v3-activity-toggle"]');
    if (await expand.isVisible()) await expand.click();
    // Pin the row by its event id: once armed, the row has no Void button, so a
    // locator filtered on that button would silently re-resolve to another row.
    const firstVoidable = panel
      .locator('[data-role="v3-activity-row"]')
      .filter({ has: page.locator('[data-role="v3-activity-void"]') })
      .first();
    await expect(firstVoidable).toBeVisible({ timeout: 30_000 });
    const eventId = await firstVoidable.getAttribute("data-event-id");
    const row = panel.locator(`[data-role="v3-activity-row"][data-event-id="${eventId}"]`);
    const voidBtn = row.locator('[data-role="v3-activity-void"]');
    await expect(voidBtn).toBeEnabled({ timeout: 30_000 });
    await row.scrollIntoViewIfNeeded();
    await row.screenshot({ path: `${SHOTS}/${width}-1-rest.png` });

    await voidBtn.click();
    const confirm = row.locator('[data-role="v3-activity-void-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(voidBtn).toHaveCount(0);
    expect(await voids(page.request, fx.fixtureId), "one tap voids nothing").toHaveLength(0);
    await row.screenshot({ path: `${SHOTS}/${width}-2-armed.png` });
    // no horizontal page scroll with the wider armed row
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Cancel disarms and still voids nothing
    await row.locator('[data-role="v3-activity-void-cancel"]').click();
    await expect(voidBtn).toBeVisible();
    expect(await voids(page.request, fx.fixtureId)).toHaveLength(0);

    // Re-arm, then let it lapse on its own (4s)
    await voidBtn.click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveCount(0, { timeout: 8_000 });
    expect(await voids(page.request, fx.fixtureId)).toHaveLength(0);

    // Arm + confirm writes exactly one void
    await voidBtn.click();
    await confirm.click();
    await expect.poll(async () => (await voids(page.request, fx.fixtureId)).length, { timeout: 30_000 }).toBe(1);
  });
}
