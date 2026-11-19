import { test, expect, type Page } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { pad } from "./scorepad-v3-football-kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Scoring-defects fix round 1, I-2. A tap the server refuses ALREADY_DECIDED reads differently on the surface it is read on,
// because the control that scores again differs: the organiser's console has "⟲ Void last entry", a device link has only
// "⟲ Void my last entry". The refusal itself cannot be provoked by play (the console swaps to its decided screen first), so
// the server's answer is the one thing faked here: a real pad, a real tap, a real 422 envelope. Everything after the
// response (the transport, the pipeline, the pad host's banner) is the product. The expected lines are read from the
// dictionary, with the control filled from its own key, never typed here.
test.describe.configure({ mode: "parallel" });

const dict = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const deviceLine = dict["scorepad.refusal.alreadyDecidedDevice"]!.replace("{control}", `⟲ ${dict["device.undoMine"]}`);
const consoleLine = dict["engineError.ALREADY_DECIDED"]!.replace("{control}", dict["score.voidLast"]!);

async function refuseEvents(page: Page): Promise<() => number> {
  let posts = 0;
  await page.route("**/api/v1/fixtures/*/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "ALREADY_DECIDED", message: "this match already has a result" } }),
    });
  });
  return () => posts;
}


test("the organiser's console reads the console's sentence for a refused tap", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `AD Console ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `AD CH ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `AD CA ${TAG}`, positionKey: "GK" }],
    skipLineups: true,
    emitCoreStart: true,
  });
  const posts = await refuseEvents(page);
  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await pad(page).locator('[data-tile-id="goal-home"]').click();
  const banner = pad(page).locator('[data-role="v3-rejection"]');
  await expect(banner, "the refused tap says so, in the console's words").toHaveText(consoleLine, { timeout: 30_000 });
  expect(posts(), "the tap really went to the (faked) server").toBeGreaterThan(0);
  expect(consoleLine, "precondition: it names the console's control").toContain(dict["score.voidLast"]!);
});

test("a device link's pad reads its own sentence for a refused tap: its own control, an organiser to ask", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `AD Device ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `AD DH ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `AD DA ${TAG}`, positionKey: "GK" }],
    skipLineups: true,
    emitCoreStart: true,
  });
  const minted = await apiJson<{ id: string; secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", { label: "Court 1" });
  expect(minted.status).toBe(201);
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const page = await ctx.newPage();
    const posts = await refuseEvents(page);
    await page.goto(`/score/${minted.data!.secret}`, { waitUntil: "load" });
    await expect(page.locator('[data-tile-id="goal-home"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-tile-id="goal-home"]').click();
    const banner = page.locator('[data-role="v3-rejection"]');
    await expect(banner, "the device pad's own words").toHaveText(deviceLine, { timeout: 30_000 });
    expect(posts(), "the tap really went to the (faked) server").toBeGreaterThan(0);
    expect(deviceLine, "precondition: the two surfaces read differently").not.toBe(consoleLine);
    expect(await banner.textContent(), "and it never sends a device scorer to a console it does not have").not.toContain(dict["score.voidLast"]!);
  } finally {
    await ctx.close();
  }
});
