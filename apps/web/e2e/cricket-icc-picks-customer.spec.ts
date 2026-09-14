import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  seedRosteredFixture,
  TAG,
} from "./helpers";

/** Customer-drive evidence for cricket ICC player picks. Not a CI gate —
 *  screenshots land under the labeled env's verify dir so a human can see
 *  what this session actually rendered. */
const SHOTS = "/tmp/seazn-env/cricket-icc-picks/verify";
const WIDTHS = [320, 768, 1280] as const;

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status).toBe(200);
  return res.data ?? [];
}

async function dumpCopy(page: Page, label: string): Promise<string> {
  const text = (await pad(page).innerText()).replace(/\s+/g, " ").trim();
  writeFileSync(`${SHOTS}/${label}.txt`, `${text}\n`);
  return text;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: "serial" });

test("customer: opening pair, incoming batter, three widths, then break it", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });

  const fx = await seedRosteredFixture(page.request, {
    label: `Customer ICC ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [
      { fullName: `Cust One ${TAG}` },
      { fullName: `Cust Two ${TAG}` },
      { fullName: `Cust Three ${TAG}` },
      { fullName: `Cust Four ${TAG}` },
    ],
    away: [{ fullName: `Cust BowlA ${TAG}` }, { fullName: `Cust BowlB ${TAG}` }],
  });
  const one = fx.personIds[`Cust One ${TAG}`]!;
  const two = fx.personIds[`Cust Two ${TAG}`]!;
  const three = fx.personIds[`Cust Three ${TAG}`]!;
  const four = fx.personIds[`Cust Four ${TAG}`]!;
  const bowlB = fx.personIds[`Cust BowlB ${TAG}`]!;

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");

  const strip = pad(page).locator('[data-role="context-strip"]');
  await expect(strip, "opening strip must exist before ball 1").toBeVisible({ timeout: 10_000 });

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 320 ? 568 : 900 });
    await expectNoHorizontalScroll(page);
    await shot(page, `01-opening-${w}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const openingCopy = await dumpCopy(page, "01-opening-copy");
  expect(openingCopy).toContain("Striker");
  expect(openingCopy).toContain("Non-striker");
  expect(openingCopy).toContain("Bowler");
  expect(openingCopy).toContain(`Cust One ${TAG}`);
  expect(openingCopy).toContain(`Cust Two ${TAG}`);
  expect(openingCopy).not.toContain("Nobody — the offender serves it");

  // Same person both ends — the other-end batter stays visible and names why.
  await strip.getByRole("button", { name: /^Striker(:|$)/ }).click();
  await strip.getByRole("button", { name: `Cust Three ${TAG}`, exact: true }).click();
  await expect(
    strip.getByRole("button", { name: /^Non-striker(:|$)/ }),
    "changing only striker must keep the default non-striker",
  ).toContainText(`Cust Two ${TAG}`);
  await strip.getByRole("button", { name: /^Non-striker(:|$)/ }).click();
  const blocked = strip.locator('[data-blocked="true"]');
  await expect(blocked).toContainText(`Cust Three ${TAG}`);
  await expect(blocked).toContainText("Already at the other end");
  await shot(page, "02-other-end-blocked");
  await dumpCopy(page, "02-other-end-copy");

  await strip.getByRole("button", { name: `Cust Four ${TAG}`, exact: true }).click();
  await strip.getByRole("button", { name: /^Bowler(:|$)/ }).click();
  await strip.getByRole("button", { name: `Cust BowlB ${TAG}`, exact: true }).click();

  await pad(page).getByRole("button", { name: "0", exact: true }).click();
  const dock = pad(page).locator('[data-role="v3-dock"]');
  await dock.getByRole("button", { name: "Send now", exact: true }).click({ timeout: 8_000 }).catch(() => undefined);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length, {
      timeout: 25_000,
    })
    .toBe(1);
  const first = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "cricket.ball")!;
  expect(first.payload.striker).toBe(three);
  expect(first.payload.nonStriker).toBe(four);
  expect(first.payload.bowler).toBe(bowlB);

  await expect(strip.getByRole("button", { name: /^Striker(:|$)/ })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 568 });
  await expectNoHorizontalScroll(page);
  await shot(page, "03-locked-crease-320");
  await page.setViewportSize({ width: 1280, height: 900 });

  await pad(page).getByRole("button", { name: "Wicket", exact: true }).click();
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  await expect(sheet.getByText("What happened?")).toBeVisible();
  await sheet.getByRole("button", { name: "Bowled", exact: true }).click();
  await expect(sheet.getByText("Who walks in?")).toBeVisible({ timeout: 10_000 });
  await expect(sheet.getByText("Nobody — the offender serves it")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: `Cust One ${TAG}`, exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: `Cust Two ${TAG}`, exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: `Cust Three ${TAG}`, exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: `Cust Four ${TAG}`, exact: true })).toHaveCount(0);

  // Empty: leave the incoming step unanswered. Ledger must not grow.
  await page.waitForTimeout(1500);
  expect((await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball")).toHaveLength(1);

  // Back, then re-enter — sheet must not have posted.
  await sheet.getByRole("button", { name: "Back", exact: true }).click();
  await expect(sheet.getByText("What happened?")).toBeVisible();
  await sheet.getByRole("button", { name: "Bowled", exact: true }).click();
  await expect(sheet.getByText("Who walks in?")).toBeVisible();
  await dumpCopy(page, "04-who-walks-in-copy");
  await shot(page, "04-who-walks-in-1280");
  await page.setViewportSize({ width: 320, height: 568 });
  await expectNoHorizontalScroll(page);
  await shot(page, "04-who-walks-in-320");
  await page.setViewportSize({ width: 768, height: 900 });
  await expectNoHorizontalScroll(page);
  await shot(page, "04-who-walks-in-768");
  await page.setViewportSize({ width: 1280, height: 900 });

  // Double-submit the incoming pick.
  const incomingBtn = sheet.getByRole("button", { name: `Cust Two ${TAG}`, exact: true });
  await incomingBtn.click();
  await dock.getByRole("button", { name: "Send now", exact: true }).click({ timeout: 8_000 }).catch(() => undefined);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length, {
      timeout: 20_000,
    })
    .toBe(2);
  const withWicket = (await ledger(page.request, fx.fixtureId)).find(
    (e) => e.type === "cricket.ball" && (e.payload as { wicket?: unknown }).wicket,
  )!;
  const wicket = withWicket.payload.wicket as { incoming?: string; out: string };
  expect(wicket.out).toBe(three);
  expect(wicket.incoming).toBe(two);
  expect(wicket.incoming).not.toBe(one);
  await shot(page, "05-after-incoming");
});
