import { test, expect, type Page } from "@playwright/test";
import { apiJson, fixturePath, pickCricketPeople, seedRosteredFixture, TAG, tapCricketExtra } from "./helpers";

// S2-4 Task 10 (gap 8, spec §7.2: "The layout jumps after every ball" → fixed-height regions). The probe: at each
// width, the tile grid and the context strip are measured after the picks, then after each of seven sampled events —
// a dot, a 4, a wide with runs, a no ball, its free hit, a wicket and an over's end — and neither may move or change
// height by more than half a pixel. Every movement is collected before anything is asserted, so one run names every
// region, event and width that moved instead of stopping at the first (AGENTS 21).
//
// Measured in DOCUMENT coordinates (the viewport rect plus `scrollY`): a tap scrolls the page to the tile it hits, and a
// viewport `boundingBox().y` would then report a jump the layout never made.
//
// The fixture is `hundred` (five-ball overs), so the seventh event is the over's fifth legal ball and no unsampled ball
// sits between them: dot (1), 4 (2), wide (–), no ball (–), its free hit (3), wicket (4), over end (5).
//
// One test across the four widths, not four tests: the sample count is one number (7 × 4, preflight W15), and a width
// that never sampled must fail it rather than vanish into a skipped test.

const WIDTHS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;
const SCREENSHOT_WIDTHS: ReadonlySet<number> = new Set([320, 768, 1280]);
const EVENT_COUNT = 7;
const TOLERANCE_PX = 0.5;
/** Per width: seeding, the page, the start, three picks and seven ledger round trips (no cricket ball waits on a hold
 *  since S2-4 Task 4). The budget is per width, so a fifth width moves it with it. */
const BUDGET_PER_WIDTH_MS = 120_000;

const REGIONS = ["v3-tiles", "v3-context"] as const;
type Region = (typeof REGIONS)[number];
type Box = { top: number; height: number };
type Sample = Record<Region, Box>;

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

async function ballCount(page: Page, fixtureId: string): Promise<number> {
  const res = await apiJson<{ type: string }[]>(page.request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  return (res.data ?? []).filter((e) => e.type === "cricket.ball").length;
}

/** Both regions in document coordinates, after two animation frames so a pending layout has landed. */
async function measure(page: Page): Promise<Sample> {
  return page.evaluate((roles) => {
    return new Promise<Record<string, { top: number; height: number }>>((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const out: Record<string, { top: number; height: number }> = {};
          for (const role of roles) {
            const el = document.querySelector(`[data-testid="score-pad"] [data-role="${role}"]`);
            if (!el) throw new Error(`steady layout: [data-role="${role}"] is not on the page`);
            const rect = el.getBoundingClientRect();
            out[role] = { top: rect.top + window.scrollY, height: rect.height };
          }
          resolve(out);
        }),
      );
    });
  }, REGIONS as readonly string[]) as Promise<Sample>;
}

async function startMatch(page: Page, fixtureId: string): Promise<void> {
  // Click until the ledger moves: `load` resolves before React hydrates, so a first click can land on server markup
  // with no handler (mobile.spec.ts's own start, for the same reason).
  const start = page.getByRole("button", { name: "Start match", exact: true });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        if (await start.isVisible().catch(() => false)) await start.click({ timeout: 5_000 }).catch(() => {});
        const res = await apiJson<{ type: string }[]>(page.request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
        return (res.data ?? []).some((e) => e.type === "core.start");
      },
      { timeout: 30_000, message: "Start match must reach the ledger" },
    )
    .toBe(true);
}

test("the tile grid and the context strip do not move across a dot, a 4, a wide with runs, a no-ball, its free hit, a wicket and an over end", async ({
  page,
}, testInfo) => {
  test.setTimeout(WIDTHS.length * BUDGET_PER_WIDTH_MS);
  const moved: string[] = [];
  let samples = 0;

  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    const names = {
      one: `V3 SL Bat One ${TAG}`,
      two: `V3 SL Bat Two ${TAG}`,
      three: `V3 SL Bat Six ${TAG}`,
      bowler: `V3 SL Bowl One ${TAG}`,
    };
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket Steady ${size.width} ${TAG}`,
      sportKey: "cricket",
      variantKey: "hundred",
      home: [{ fullName: names.one }, { fullName: names.two }, { fullName: names.three }, { fullName: `V3 SL Bat Ten ${TAG}` }],
      away: [{ fullName: names.bowler }, { fullName: `V3 SL Bowl Two ${TAG}` }],
    });
    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });
    await startMatch(page, fx.fixtureId);
    await pickCricketPeople(page, { striker: names.one, nonStriker: names.two, bowler: names.bowler });
    await expect(pad(page).locator('[data-tile-id="run0"]'), "the picks open the tiles").toHaveAttribute(
      "data-tile-disabled",
      "false",
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const queue = pad(page).locator('[data-role="v3-queue-status"]');
    const idle = (await queue.textContent()) ?? "";
    const baseline = await measure(page);

    const events: { name: string; act: () => Promise<void> }[] = [
      { name: "a dot", act: () => pad(page).locator('[data-tile-id="run0"]').click() },
      { name: "a 4", act: () => pad(page).locator('[data-tile-id="run4"]').click() },
      { name: "a wide with 2 run", act: () => tapCricketExtra(page, "wide", "2") },
      { name: "a no ball, 1 off the bat", act: () => tapCricketExtra(page, "extra-noball", "bat:1") },
      { name: "its free hit, a single", act: () => pad(page).locator('[data-tile-id="run1"]').click() },
      {
        name: "a wicket (bowled)",
        act: async () => {
          await pad(page).locator('[data-tile-id="wicket"]').click();
          const sheet = pad(page).locator('[data-role="v3-sheet"]');
          await sheet.getByRole("button", { name: "Bowled", exact: true }).click();
          await sheet.getByRole("button", { name: names.three, exact: true }).click();
        },
      },
      { name: "an over end (a dot, the fifth legal ball)", act: () => pad(page).locator('[data-tile-id="run0"]').click() },
    ];
    expect(events, "the seven sampled events").toHaveLength(EVENT_COUNT);

    for (const [i, event] of events.entries()) {
      await event.act();
      await expect
        .poll(() => ballCount(page, fx.fixtureId), { timeout: 20_000, message: `${event.name} reaches the ledger` })
        .toBe(i + 1);
      // Settled: no sheet open, and the queue reads as it did at rest before the first ball.
      await expect(pad(page).locator('[data-role="v3-sheet"]')).toHaveCount(0);
      await expect.poll(async () => (await queue.textContent()) ?? "", { timeout: 20_000 }).toBe(idle);
      const now = await measure(page);
      samples++;
      for (const region of REGIONS) {
        for (const metric of ["top", "height"] as const) {
          const was = baseline[region][metric];
          const is = now[region][metric];
          if (Math.abs(is - was) > TOLERANCE_PX) {
            moved.push(`${size.width}px, after ${event.name}: ${region} ${metric} ${was.toFixed(1)} -> ${is.toFixed(1)}`);
          }
        }
      }
    }

    if (SCREENSHOT_WIDTHS.has(size.width)) {
      await testInfo.attach(`steady-layout-${size.width}`, {
        body: await pad(page).screenshot(),
        contentType: "image/png",
      });
    }
  }

  expect(samples, "every width sampled every event: zero is a failure (preflight W15)").toBe(WIDTHS.length * EVENT_COUNT);
  expect(moved, "no region moved").toEqual([]);
});
