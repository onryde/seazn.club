import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "./helpers";

/**
 * Soft-commit inventory — browser proof of `usesSoftCommit` (HOLD iff dock
 * has chips) plus screenshots for visual review under
 * `e2e-artifacts/soft-commit-inventory/`.
 */
test.describe.configure({ mode: "parallel" });

const ARTIFACT = "e2e-artifacts/soft-commit-inventory";
/** Immediate taps must beat this; must stay strictly below HOLD_MS. DERIVED,
 *  not flat (review 2026-09-14, I6): CI sets `NEXT_PUBLIC_SCOREPAD_HOLD_MS`
 *  to 3000, and a flat 2_500 left only a 500ms margin there — flaky by
 *  construction (AGENTS.md class 20, "a flat timeout beside a derived cost is
 *  a latent red"). Half of HOLD_MS, floored at 1_500 so a very short
 *  HOLD_MS still leaves taps a real budget. */
const IMMEDIATE_MS = Math.max(1_500, Math.floor(HOLD_MS * 0.5));
/** Hold proof: ledger must still be quiet this long before Send now. */
const HOLD_PROOF_MS = Math.min(Math.floor(HOLD_MS * 0.45), 2_000);

test.beforeAll(() => {
  expect(IMMEDIATE_MS, "immediate budget must be shorter than soft-commit hold").toBeLessThan(HOLD_MS);
  expect(HOLD_PROOF_MS, "hold proof must leave room before auto-flush").toBeLessThan(HOLD_MS);
});

// The page clock is installed (flowing in real time) before every page opens,
// so `expectHeldThenFlush` can pause it once the hold is proven. It has to be
// in place before the tap: the hold is a `setTimeout` armed by the tap itself,
// and a timer created before `install()` is a real one no pause can stop.
test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

/** How far `freezeClock` lets the page clock jump. Small beside what is left
 *  of the hold at that point (HOLD_MS − HOLD_PROOF_MS, less a ledger read). */
const FREEZE_JUMP_MS = 100;

/**
 * Stop the page clock where it stands, so the open dock cannot flush itself
 * while it is photographed and Send now is pressed.
 *
 * Needed because the photograph outlasts the hold under load: CI's HOLD_MS is
 * 3000, the proof below spends HOLD_PROOF_MS of it, and a full-page capture on
 * a loaded machine took the rest — "tennis point holds" timed out on Send now
 * with the dock already gone. Frozen only AFTER the mid-hold ledger read, so
 * the proof that the hold lasts HOLD_PROOF_MS still runs on a live clock.
 *
 * `pauseAt(t)` pauses and then jumps FORWARD to `t`, firing every timer due on
 * the way, so the jump is kept small rather than generous: jumping past the
 * hold's deadline would flush the very dock this protects. A target the page
 * clock has already passed by the time the call lands is refused ("Cannot
 * fast-forward to the past") — read the clock again and retry, never widen
 * the jump.
 */
async function freezeClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + FREEZE_JUMP_MS);
      return;
    } catch (error) {
      if (attempt >= 5 || !String(error).includes("past")) throw error;
    }
  }
}

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
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
function sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function openLive(page: Page, fixtureId: string): Promise<void> {
  await page.goto(await fixturePath(page.request, fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

async function shot(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: `${ARTIFACT}/${name}.png`, fullPage: true });
}

async function sendNow(page: Page): Promise<void> {
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

async function expectImmediate(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  before: number,
  shotName: string,
): Promise<void> {
  await expect(dock(page), "immediate tap must not open an enrichment dock").toHaveCount(0, { timeout: 3_000 });
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === type).length, {
      timeout: IMMEDIATE_MS,
      intervals: [100, 200, 400],
      message: `${type} must land under HOLD_MS=${HOLD_MS}`,
    })
    .toBe(before + 1);
  await shot(page, shotName);
}

async function expectHeldThenFlush(
  page: Page,
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  before: number,
  shotName: string,
): Promise<void> {
  await expect(dock(page), "enrichment tap must open the soft-commit dock").toBeVisible({ timeout: 5_000 });
  // Prove soft-commit actually HOLDS: dock stays up and ledger stays quiet for
  // a meaningful fraction of HOLD_MS (not a 400ms glance that would pass if
  // submit were immediate under the dock).
  await page.waitForTimeout(HOLD_PROOF_MS);
  await expect(dock(page), "dock must still be open mid-hold").toBeVisible();
  expect(
    (await ledger(request, fixtureId)).filter((e) => e.type === type).length,
    `${type} must not reach the ledger before Send now / HOLD_MS`,
  ).toBe(before);
  await freezeClock(page);
  await expect(dock(page), "freezing the clock must not have flushed the dock").toBeVisible();
  await shot(page, shotName);
  await sendNow(page);
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === type).length, {
      timeout: 20_000,
    })
    .toBe(before + 1);
  await expect(dock(page)).toHaveCount(0, { timeout: 5_000 });
  await page.clock.resume();
}

test("inventory: cricket plain immediate; noball holds; wide immediate", async ({ page }) => {
  test.setTimeout(150_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `SCI Cricket ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `SCI C Striker ${TAG}` }, { fullName: `SCI C Non ${TAG}` }],
    away: [{ fullName: `SCI C Bowl ${TAG}` }],
  });
  await openLive(page, fx.fixtureId);

  let before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length;
  await tile(page, "run1").click();
  await expectImmediate(page, page.request, fx.fixtureId, "cricket.ball", before, "01-cricket-plain-immediate");

  before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length;
  await tile(page, "extra-noball").click();
  await expectHeldThenFlush(page, page.request, fx.fixtureId, "cricket.ball", before, "02-cricket-noball-hold");

  before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length;
  await tile(page, "wide").click();
  await expectImmediate(page, page.request, fx.fixtureId, "cricket.ball", before, "03-cricket-wide-immediate");
});

test("inventory: football period immediate; goal holds; clock publishes immediately", async ({ page }) => {
  test.setTimeout(150_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `SCI Football ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `SCI F Home ${TAG}` }, { fullName: `SCI F Home2 ${TAG}` }],
    away: [{ fullName: `SCI F Away ${TAG}` }],
  });
  await openLive(page, fx.fixtureId);

  const beforeGoal = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.goal").length;
  await tile(page, "goal-home").click();
  await expectHeldThenFlush(page, page.request, fx.fixtureId, "football.goal", beforeGoal, "04-football-goal-hold");

  const beforePeriod = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.period").length;
  await tile(page, "period").click();
  await expect(sheet(page), "period tile opens Which break?").toBeVisible({ timeout: 10_000 });
  await sheet(page).locator('[data-choice-option-id="HT"]').click();
  await expect(dock(page)).toHaveCount(0, { timeout: 3_000 });
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.period").length, {
      timeout: IMMEDIATE_MS + 5_000,
      message: "football.period must submit with no soft-commit dock",
    })
    .toBe(beforePeriod + 1);
  await shot(page, "05-football-period-immediate");

  // Clock on a fresh live half — period HT reseats; start a new fixture for clock.
  const clockFx = await seedRosteredFixture(page.request, {
    label: `SCI Football Clock ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `SCI FC Home ${TAG}` }],
    away: [{ fullName: `SCI FC Away ${TAG}` }],
  });
  await openLive(page, clockFx.fixtureId);
  const beforeClock = (await ledger(page.request, clockFx.fixtureId)).filter((e) => e.type === "football.clock")
    .length;
  const clockToggle = pad(page).locator('[data-role="v3-clock-toggle"]');
  await expect(clockToggle).toBeVisible({ timeout: 10_000 });
  await clockToggle.click();
  await expect(dock(page)).toHaveCount(0);
  await expect
    .poll(
      async () => (await ledger(page.request, clockFx.fixtureId)).filter((e) => e.type === "football.clock").length,
      { timeout: IMMEDIATE_MS, intervals: [100, 200], message: "football.clock via publishClock" },
    )
    .toBe(beforeClock + 1);
  await shot(page, "06-football-clock-immediate");
});

test("inventory: hockey advance immediate (whistleAt FT proof lives in period-pair)", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `SCI Hockey ${TAG}`,
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    home: [{ fullName: `SCI H Home ${TAG}` }, { fullName: `SCI H Home2 ${TAG}` }],
    away: [{ fullName: `SCI H Away ${TAG}` }],
  });
  await openLive(page, fx.fixtureId);

  const before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "hockey.period.advance")
    .length;
  await tile(page, "advance").click();
  await expectImmediate(page, page.request, fx.fixtureId, "hockey.period.advance", before, "07-hockey-advance-immediate");

  const advances = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "hockey.period.advance");
  expect(advances.length).toBeGreaterThanOrEqual(1);
  for (const ev of advances) {
    expect(ev.payload.at).toEqual(
      expect.objectContaining({ period: expect.any(String), elapsed: expect.any(Number) }),
    );
  }
  await shot(page, "08-hockey-advance-whistleAt-stamp");
});

test("inventory: badminton singles immediate; doubles holds", async ({ page }) => {
  test.setTimeout(150_000);

  const singles = await seedRosteredFixture(page.request, {
    label: `SCI BD Singles ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `SCI BD S Home ${TAG}` }],
    away: [{ fullName: `SCI BD S Away ${TAG}` }],
  });
  await openLive(page, singles.fixtureId);
  const beforeS = (await ledger(page.request, singles.fixtureId)).filter((e) => e.type === "badminton.rally").length;
  await half(page, "home").click();
  await expectImmediate(page, page.request, singles.fixtureId, "badminton.rally", beforeS, "09-badminton-singles-immediate");

  const doubles = await seedRosteredFixture(page.request, {
    label: `SCI BD Doubles ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "pair",
    home: [
      { fullName: `SCI BD D H1 ${TAG}`, pairOrder: 1 },
      { fullName: `SCI BD D H2 ${TAG}`, pairOrder: 2 },
    ],
    away: [
      { fullName: `SCI BD D A1 ${TAG}`, pairOrder: 1 },
      { fullName: `SCI BD D A2 ${TAG}`, pairOrder: 2 },
    ],
  });
  await openLive(page, doubles.fixtureId);
  const beforeD = (await ledger(page.request, doubles.fixtureId)).filter((e) => e.type === "badminton.rally").length;
  await half(page, "home").click();
  await expectHeldThenFlush(page, page.request, doubles.fixtureId, "badminton.rally", beforeD, "10-badminton-doubles-hold");
});

test("inventory: volleyball indoor rally holds (always asks scorer)", async ({ page }) => {
  test.setTimeout(120_000);
  const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
  const roster = (label: string) =>
    COURT.map((positionKey, i) => ({ fullName: `${label} P${i + 1} ${TAG}`, positionKey }));
  const fx = await seedRosteredFixture(page.request, {
    label: `SCI VB ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: roster("SCI VB H"),
    away: roster("SCI VB A"),
  });
  await openLive(page, fx.fixtureId);
  const before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "volleyball.rally").length;
  await half(page, "home").click();
  // First rally may open a serve sheet before the scorer dock — wait for either.
  const sh = sheet(page);
  await expect
    .poll(
      async () => {
        if (await dock(page).isVisible().catch(() => false)) return "dock";
        if (await sh.isVisible().catch(() => false)) return "sheet";
        return "neither";
      },
      { timeout: 10_000, message: "rally tap must open a serve sheet or the scorer dock" },
    )
    .not.toBe("neither");
  if (await sh.isVisible().catch(() => false)) {
    await sh.locator('[data-choice-option-id="home"]').click();
  }
  await expectHeldThenFlush(page, page.request, fx.fixtureId, "volleyball.rally", before, "11-volleyball-rally-hold");
});

test("inventory: boardgame result holds for method enrichment", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `SCI Board ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: `SCI BG White ${TAG}` }],
    away: [{ fullName: `SCI BG Black ${TAG}` }],
  });
  await openLive(page, fx.fixtureId);
  const before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "boardgame.result").length;
  await half(page, "home").click();
  await expectHeldThenFlush(page, page.request, fx.fixtureId, "boardgame.result", before, "12-boardgame-result-hold");
});

test("inventory: tennis point holds", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `SCI Tennis ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: `SCI TN Home ${TAG}` }],
    away: [{ fullName: `SCI TN Away ${TAG}` }],
  });
  await openLive(page, fx.fixtureId);
  const before = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "tennis.point").length;
  await half(page, "home").click();
  await expectHeldThenFlush(page, page.request, fx.fixtureId, "tennis.point", before, "13-tennis-point-hold");
});
