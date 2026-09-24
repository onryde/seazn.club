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

/**
 * A soft-commit dock lives for HOLD_MS (3000 in CI) and then commits on its
 * own, taking "Send now" with it. Photographing the dock at three widths
 * costs ~2s on a CI runner and more on a loaded one — measured locally at
 * `--workers=6`: 4.4s between the dock appearing and the Send-now click, so
 * the window had closed, the button was gone, and the click waited out the
 * whole 180s test budget (12 of 15 runs). Two flat numbers, one of them a
 * product timer, with nothing tying them together.
 *
 * So the page's clock is held still for the dock's whole open life: frozen
 * BEFORE the tap that opens it (the hold's release tick is armed on the
 * frozen clock and cannot fire), resumed only once Send now has flushed it.
 * Nothing this walkthrough proves is timer-driven inside that span — the dock
 * opens on the tap, and Send now is an immediate flush (`releaseHeld`) — and
 * the dock's countdown and depletion bar stay at their opening frame, so the
 * dock screenshots show the same picture on every run instead of whichever
 * tick the capture happened to land on. `page.clock.install()` at the top of
 * the test is what makes the page's timers pausable; until paused, time flows
 * as normal.
 */
async function freezeClockForDock(page: Page): Promise<void> {
  // A small jump forward is how `pauseAt` pauses; no hold is armed yet, so
  // nothing that matters is due inside it.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}

/**
 * THE CLICK THAT LANDED ON A GREYED BUTTON (CI run 35969236588, "walkthrough
 * 1/3"). Football's "Start match" was clicked and the ledger stayed `[]` for
 * the full 20s poll. The trace's DOM snapshot at the instant of the click has
 * the button carrying `disabled`: Playwright judged it enabled from the
 * server-rendered markup, then the pad hydrated, its mount effect reported
 * its SEED ledger through `onEvents`, and the console's `handlePadEvents`
 * greyed every scoring control (`padSyncing`) for a `/state` + `/events`
 * round trip — ~80ms, straddling the click. A disabled button drops a click,
 * so nothing was sent. A real scorer tapping in that window loses the tap the
 * same way, on every page load, for a refresh whose answer is already on
 * screen. Fixed in the product (`useReportLedgerChanges`, v3/pad-host.tsx):
 * the pad reports a CHANGED ledger, never the one it was seeded with.
 *
 * This probe is the regression witness, and it is deterministic rather than
 * a race of its own. It counts every time the Start button turns `disabled`
 * BEFORE the page has seen any pointer input — the only legitimate greying
 * is the scorer's own press (`busy`), which a `pointerdown` precedes. It is
 * armed as an init script so it observes from the first byte of every
 * navigation, and `openAndStart` below clicks only after the pad's own mount
 * effects have run, so a regression that re-greys the button at mount is
 * always inside the window this counts.
 */
const PROBE = "__startMatchSelfDisabled";
async function armStartMatchProbe(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const box = window as unknown as Record<string, number>;
    box[key] = 0;
    let pressed = false;
    window.addEventListener(
      "pointerdown",
      () => {
        pressed = true;
      },
      { capture: true },
    );
    new MutationObserver((records) => {
      if (pressed) return;
      for (const record of records) {
        const el = record.target as Element;
        if (el.getAttribute("data-testid") === "score-start-match" && el.hasAttribute("disabled")) {
          box[key] = (box[key] ?? 0) + 1;
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
  }, PROBE);
}

/** Open a scheduled fixture's console and press Start match.
 *
 *  Clicks only once the pad has run its mount effects, not merely painted:
 *  `goto` returns at `load` and the pad is server-rendered, so "visible" is
 *  true long before React owns the tree. The signal is the pad's FIRST client
 *  act — `use-fixture-stream.ts` asks the realtime-token door from the same
 *  effect flush in which `PadHostV3` reports its ledger, so once that request
 *  is on the wire the tree is hydrated and every mount effect has already run. */
async function openAndStart(page: Page, fixtureId: string): Promise<void> {
  const padMounted = page.waitForRequest(
    (req) => req.url().includes(`/api/v1/public/fixtures/${fixtureId}/realtime-token`),
    { timeout: 20_000 },
  );
  await page.goto(await fixturePath(page.request, fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await padMounted;
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  expect(
    await page.evaluate((key) => (window as unknown as Record<string, number | undefined>)[key] ?? -1, PROBE),
    "Start match went grey on its own before the scorer pressed it (-1: the probe never armed)",
  ).toBe(0);
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
  await armStartMatchProbe(page);
  // Before any navigation, so every page timer is one `freezeClockForDock` can
  // hold still. Time flows normally until then.
  await page.clock.install();

  // ---- Cricket: plain (immediate) then noball (hold) ----
  const cricket = await seedRosteredFixture(page.request, {
    label: `WT SoftCommit Cricket ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `WT SC Striker ${TAG}` }, { fullName: `WT SC Non ${TAG}` }],
    away: [{ fullName: `WT SC Bowl ${TAG}` }],
  });
  await openAndStart(page, cricket.fixtureId);
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
  await freezeClockForDock(page);
  await tile(page, "extra-noball").click();
  await expect(dock(page), "noball: soft-commit dock").toBeVisible({ timeout: 5_000 });
  await shot(page, "cricket-noball-dock");
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(dock(page)).toHaveCount(0, { timeout: 5_000 });
  await page.clock.resume();
  await shot(page, "cricket-noball-flushed");

  // ---- Football: goal hold + clock immediate ----
  const football = await seedRosteredFixture(page.request, {
    label: `WT SoftCommit Football ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `WT SC F Home ${TAG}` }, { fullName: `WT SC F Home2 ${TAG}` }],
    away: [{ fullName: `WT SC F Away ${TAG}` }],
  });
  await openAndStart(page, football.fixtureId);
  await shot(page, "football-open");

  await beat(page);
  await freezeClockForDock(page);
  await tile(page, "goal-home").click();
  await expect(dock(page)).toBeVisible({ timeout: 5_000 });
  await shot(page, "football-goal-dock");
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(dock(page)).toHaveCount(0, { timeout: 5_000 });
  await page.clock.resume();

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
