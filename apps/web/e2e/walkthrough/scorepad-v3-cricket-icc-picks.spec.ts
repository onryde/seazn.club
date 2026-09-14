// Cricket ICC player picks — a scorer names the opening pair and bowler,
// must say who walks in after a wicket, then can rename that incoming
// batter until they face. Retire is the same incoming question on a
// different event.
//
// scorepad-v3-cricket.spec.ts already pins pieces of this (opening strip,
// non-next incoming, post-wicket strip swap, retire crease list). This
// file is the product walk: every step that IS the pick is tapped, the
// ledger agrees, three widths, no hockey "Nobody" copy, no page scroll.
//
// Set DEMO_PACE=<ms> and run `--headed` to watch it; DEMO_HOLD=<ms> keeps
// the window open on the last screen.
import { test, expect, type Page, type APIRequestContext, type TestInfo } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  screenshotAtWidths,
  seedRosteredFixture,
  TAG,
} from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";

test.describe.configure({ mode: "parallel" });

const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);
const HOCKEY_NOBODY = "Nobody — the offender serves it";

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function strip(page: Page) {
  return pad(page).locator('[data-role="context-strip"]');
}
function sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}
function dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function ballsOf(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "cricket.ball");
}

async function sendHeldNow(page: Page): Promise<void> {
  const btn = dock(page).getByRole("button", { name: "Send now", exact: true });
  if (await btn.count()) await btn.click();
}

async function pace(page: Page): Promise<void> {
  if (PACE > 0) await page.waitForTimeout(PACE);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await screenshotAtWidths(page, testInfo, name, [1280, 768, 320], async (p) => {
    await expectNoHorizontalScroll(p);
  });
}

async function setContextPerson(page: Page, chipLabel: string, personName: string): Promise<void> {
  const row = strip(page);
  await row.getByRole("button", { name: new RegExp(`^${chipLabel}(:|$)`) }).click();
  const candidate = row.getByRole("button", { name: personName, exact: true });
  await expect(candidate, `${chipLabel} picker must show real names, not ids`).toBeVisible({ timeout: 10_000 });
  await candidate.click();
  await pace(page);
}

async function startMatch(page: Page, fixtureId: string): Promise<void> {
  await page.goto(await fixturePath(page.request, fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

test("cricket ICC picks: opening pair and bowler, required incoming, then rename who walked in until they face", async ({
  page,
}, testInfo) => {
  // 3 held dispatches (opening dot, wicket, post-swap dot) plus Start match
  // and the incoming sheet. sendHeldNow flushes; HOLD_MS is still the cost
  // if the dock is missed and the poll waits the window out.
  const taps = 3;
  const shotSets = 5;
  test.setTimeout(Math.max(180_000, 40_000 + taps * (HOLD_MS + 8_000) + shotSets * 6_000));

  const fx = await seedRosteredFixture(page.request, {
    label: `WT ICC ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [
      { fullName: `WT One ${TAG}` },
      { fullName: `WT Two ${TAG}` },
      { fullName: `WT Three ${TAG}` },
      { fullName: `WT Four ${TAG}` },
    ],
    away: [{ fullName: `WT BowlA ${TAG}` }, { fullName: `WT BowlB ${TAG}` }],
  });
  const one = fx.personIds[`WT One ${TAG}`]!;
  const two = fx.personIds[`WT Two ${TAG}`]!;
  const three = fx.personIds[`WT Three ${TAG}`]!;
  const four = fx.personIds[`WT Four ${TAG}`]!;
  const bowlB = fx.personIds[`WT BowlB ${TAG}`]!;

  await startMatch(page, fx.fixtureId);
  await expect(strip(page), "opening strip must exist before ball 1").toBeVisible({ timeout: 10_000 });
  const openingCopy = (await pad(page).innerText()).replace(/\s+/g, " ");
  expect(openingCopy).toContain("Striker");
  expect(openingCopy).toContain("Non-striker");
  expect(openingCopy).toContain("Bowler");
  expect(openingCopy).not.toContain(HOCKEY_NOBODY);
  await shot(page, testInfo, "01-opening");

  await setContextPerson(page, "Striker", `WT Three ${TAG}`);
  await expect(
    strip(page).getByRole("button", { name: /^Non-striker(:|$)/ }),
    "overriding only striker must keep the default other end",
  ).toContainText(`WT Two ${TAG}`);
  await strip(page).getByRole("button", { name: /^Non-striker(:|$)/ }).click();
  const blocked = strip(page).locator('[data-blocked="true"]');
  await expect(blocked).toContainText(`WT Three ${TAG}`);
  await expect(blocked).toContainText("Already at the other end");
  await shot(page, testInfo, "02-other-end-blocked");

  await strip(page).getByRole("button", { name: `WT Four ${TAG}`, exact: true }).click();
  await setContextPerson(page, "Bowler", `WT BowlB ${TAG}`);
  await pace(page);

  await pad(page).getByRole("button", { name: "0", exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => (await ballsOf(page.request, fx.fixtureId)).length, { timeout: 20_000 }).toBe(1);
  const first = (await ballsOf(page.request, fx.fixtureId))[0]!;
  expect(first.payload.striker, "named opener, not lineup[0]").toBe(three);
  expect(first.payload.nonStriker).toBe(four);
  expect(first.payload.bowler).toBe(bowlB);

  await expect(strip(page).getByRole("button", { name: /^Striker(:|$)/ })).toHaveCount(0);

  await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
  await expect(sheet(page).getByText("What happened?")).toBeVisible();
  await sheet(page).getByRole("button", { name: "Bowled", exact: true }).click();
  await expect(sheet(page).getByText("Who walks in?")).toBeVisible({ timeout: 10_000 });
  await expect(sheet(page).getByText(HOCKEY_NOBODY)).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: `WT One ${TAG}`, exact: true })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: `WT Two ${TAG}`, exact: true })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: `WT Three ${TAG}`, exact: true })).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: `WT Four ${TAG}`, exact: true })).toHaveCount(0);
  expect(await ballsOf(page.request, fx.fixtureId), "an unanswered incoming step must not post").toHaveLength(1);
  await shot(page, testInfo, "03-who-walks-in");

  await sheet(page).getByRole("button", { name: "Back", exact: true }).click();
  await expect(sheet(page).getByText("What happened?")).toBeVisible();
  await sheet(page).getByRole("button", { name: "Bowled", exact: true }).click();
  await expect(sheet(page).getByText("Who walks in?")).toBeVisible();
  await sheet(page).getByRole("button", { name: `WT Two ${TAG}`, exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => (await ballsOf(page.request, fx.fixtureId)).length, { timeout: 20_000 }).toBe(2);
  const wicketBall = (await ballsOf(page.request, fx.fixtureId)).find((e) => e.payload.wicket !== undefined)!;
  const wicket = wicketBall.payload.wicket as { incoming?: string; out: string };
  expect(wicket.out).toBe(three);
  expect(wicket.incoming, "captain's choice, not auto next-in-order (One)").toBe(two);

  await expect(strip(page).getByRole("button", { name: /^Striker(:|$)/ })).toBeVisible();
  await expect(strip(page).getByRole("button", { name: /^Non-striker(:|$)/ })).toHaveCount(0);
  await shot(page, testInfo, "04-incoming-editable");
  await setContextPerson(page, "Striker", `WT One ${TAG}`);
  await pad(page).getByRole("button", { name: "0", exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => (await ballsOf(page.request, fx.fixtureId)).length, { timeout: 20_000 }).toBe(3);
  const afterSwap = (await ballsOf(page.request, fx.fixtureId))[2]!;
  expect(afterSwap.payload.striker, "the strip pick, not the sheet's incoming").toBe(one);
  expect(afterSwap.payload.nonStriker).toBe(four);
  expect(afterSwap.payload.striker).not.toBe(two);
  await shot(page, testInfo, "05-after-rename");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});

test("cricket ICC picks: retiring a batter also asks who walks in, and that name reaches cricket.retire", async ({
  page,
}, testInfo) => {
  test.setTimeout(Math.max(120_000, 35_000 + HOLD_MS + 8_000 + 6_000));

  const fx = await seedRosteredFixture(page.request, {
    label: `WT ICC Retire ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [
      { fullName: `WT RT One ${TAG}` },
      { fullName: `WT RT Two ${TAG}` },
      { fullName: `WT RT Three ${TAG}` },
    ],
    away: [{ fullName: `WT RT Bowl ${TAG}` }],
  });
  const three = fx.personIds[`WT RT Three ${TAG}`]!;

  await startMatch(page, fx.fixtureId);
  await pad(page).getByRole("button", { name: "0", exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => (await ballsOf(page.request, fx.fixtureId)).length, { timeout: 20_000 }).toBe(1);

  await pad(page).locator('[data-tile-id="retire"]').click();
  const s = sheet(page);
  await expect(s).toBeVisible({ timeout: 10_000 });
  await s.getByRole("button", { name: `WT RT One ${TAG}`, exact: true }).click();
  await s.getByRole("button", { name: "Hurt", exact: true }).click();
  await expect(s.getByText("Who walks in?")).toBeVisible({ timeout: 10_000 });
  await expect(s.getByText(HOCKEY_NOBODY)).toHaveCount(0);
  await expect(s.getByRole("button", { name: `WT RT Three ${TAG}`, exact: true })).toBeVisible();
  await expect(s.getByRole("button", { name: `WT RT One ${TAG}`, exact: true })).toHaveCount(0);
  await expect(s.getByRole("button", { name: `WT RT Two ${TAG}`, exact: true })).toHaveCount(0);
  await shot(page, testInfo, "06-retire-incoming");
  await s.getByRole("button", { name: `WT RT Three ${TAG}`, exact: true }).click();
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.retire").length, {
      timeout: 20_000,
    })
    .toBe(1);
  const retire = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "cricket.retire")!;
  expect(retire.payload.reason).toBe("hurt");
  expect(retire.payload.incoming, "retire incoming must reach the payload, not fall back to omitted auto").toBe(three);

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
