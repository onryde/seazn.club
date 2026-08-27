// R5 — badminton, WHOLE MATCH: tapped from a live pad through a game
// boundary to a decided result, then the deciding rally undone.
//
// scorepad-v3-badminton.spec.ts (e2e/) proves D-17's server-naming, the
// game-change tile flow and the R5-2 doubles dock — one game each, never a
// second one, and never a DECIDED match. `scorepad-v3-tennis-mtb.spec.ts`
// (this folder's own sibling) is what this file copies for badminton: tap a
// real match to a decided result through the one phase transition that has
// broken every sport that skipped this proof (cricket's super over,
// football's shoot-out), then undo the deciding event.
//
// Badminton's own phase transition is BWF Law 8.1: the side that WINS a
// game serves FIRST in the next one — no toss, no alternation, and (unlike
// table tennis's `fixed-turns` or volleyball's `alternate`) always
// resolvable from the closed game's own SCORE, so `setStart: "set-winner"`
// never leaves a game dark the way the other two racquet sports can. That
// robustness is exactly what this file has to prove live: the SCOREBOARD,
// not a fold in a unit test, must name the winner as server before the
// first rally of the next game is ever tapped.
//
// Set DEMO_PACE=<ms> and run with `--headed` to watch it happen in a real
// browser; DEMO_HOLD=<ms> keeps the window open at the end.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  seedRosteredFixture,
  setDivisionConfigSql,
  TAG,
  type RosteredFixture,
} from "../helpers";

test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
/** Scoped to `button` deliberately: a half renders EITHER a `<button>`
 *  (tappable) OR a plain `<div>` at the same grid position until the client
 *  re-renders from the fold, and a wildcard locator happily clicks the dead
 *  `<div>`. Same reasoning, same locator shape as every sibling spec's own
 *  `half`/`tennisHalf`. */
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
function halfScore(page: Page, side: "home" | "away") {
  return scorebug(page)
    .locator(".grid > *")
    .nth(side === "home" ? 0 : 1)
    .locator(".app-display.font-bold");
}
function strip(page: Page, id: string) {
  return scorebug(page).locator(`[data-strip-item-id="${id}"]`);
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
async function ralliesOf(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "badminton.rally");
}
async function fixtureState(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{ status: string; outcome: { winner?: string } | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}

const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);

let shotNo = 0;
async function shot(page: Page, caption: string): Promise<void> {
  shotNo += 1;
  const n = String(shotNo).padStart(2, "0");
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `e2e-artifacts/badminton-match/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

/** Tap a rally on one half and wait for it to REACH the ledger.
 *  `DOUBLE_SUBMIT_WINDOW_MS` (600ms) swallows a same-payload repeat, and a
 *  side that wins a WHOLE game unanswered is nothing but same-side repeats —
 *  so, like the tennis walkthrough's own `tapPoint`, a same-side tap pays a
 *  clearance the alternating case never needs. */
let lastSide: "home" | "away" | null = null;
async function tapRally(page: Page, fx: RosteredFixture, side: "home" | "away"): Promise<void> {
  const before = (await ledger(page.request, fx.fixtureId)).length;
  if (side === lastSide) await page.waitForTimeout(750);
  if (PACE > 0) await page.waitForTimeout(PACE);
  await half(page, side).click();
  lastSide = side;
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

/** A clean 3-0 game under the shortened config — `setTo:3`, `winBy:2`: three
 *  straight rallies clear the target with a 2-point lead. */
async function winGame(page: Page, fx: RosteredFixture, side: "home" | "away"): Promise<void> {
  for (let i = 0; i < 3; i += 1) await tapRally(page, fx, side);
}

test("R5 — badminton: tap a match through a game boundary to a decided result, and Law 8.1 names the game's winner as the next game's server", async ({
  page,
}) => {
  test.setTimeout(180_000);
  shotNo = 0;
  lastSide = null;

  const homeName = `V3 Bad Match Home ${TAG}`;
  const awayName = `V3 Bad Match Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Badminton Match ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    // `emitCoreStart` LEFT OFF, unlike the brief's own default: V347 freezes
    // `config_snapshot` at the fixture's FIRST EVENT, and `core.start` counts
    // as that event — seeding it here would freeze the SHIPPED (unshortened)
    // config before this test ever gets to shorten it. Confirmed the hard
    // way: an earlier draft set this true and played out a whole game to
    // 21, not 3, with "Interval at 11" still on the strip. `Start match` is
    // tapped below instead, AFTER the config is shortened, matching the
    // tennis walkthrough's own sequence exactly.
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status, `GET division -> ${div.status}`).toBe(200);
  const cfg = div.data!.config;
  // Law 8.1 itself (`setStart: "set-winner"`) is not a cfg field at all — it
  // is baked into badminton.ts's own `serve`, so nothing this test writes
  // through this endpoint could touch it. What DOES come from the division
  // is the match length, and it must be the real "bwf" preset's before this
  // test shortens it — otherwise shortening it proves only that a test can
  // write a config.
  expect(cfg, "the shipped bwf variant no longer ships to 21, cap 30").toMatchObject({
    bestOf: 3,
    setTo: 21,
    finalSetTo: 21,
    winBy: 2,
    cap: 30,
  });

  // `bestOf` and `winBy` untouched — bestOf must stay odd (3, already is)
  // and Law 8.1's own decider needs nothing shortened but the games
  // themselves. cap(5) >= max(setTo,finalSetTo)=3, the kernel's own
  // refinement (setbased/kernel.ts's `makeConfigSchema`). Written by SQL: a
  // division that already owns fixtures is FORMAT_LOCKED and 409s a config
  // PATCH, and it must land before the first event — V347 freezes
  // `config_snapshot` at first score.
  await setDivisionConfigSql(fx.divisionId, { ...cfg, setTo: 3, finalSetTo: 3, cap: 5 });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await expect(scorebug(page)).toContainText("Game 1", { timeout: 20_000 });
  // D-17: before the first rally of the match nobody can say who serves —
  // the pad must render nothing, not a guess.
  await expect(strip(page, "server"), "before the first rally nobody can say who serves").toHaveCount(0);
  await expect(half(page, "home"), "a live fixture must render a real, tappable half").toBeVisible();
  await shot(page, "match-open");

  // ---- GAME ONE to home, straight -------------------------------------------
  // No score check on the winning tap itself: the game-closing fold is
  // atomic with the rally that decides it, so the board never renders the
  // old game's final score at all — it repoints straight to the fresh game
  // the boundary check below asserts. Confirmed empirically: a `halfScore`
  // check here read "0" (game two's own fresh board), never "3".
  await winGame(page, fx, "home");

  // ---- THE BOUNDARY: Law 8.1, asserted BEFORE any game-two rally -----------
  // The board must have moved on to a fresh game, and the winner of game one
  // must already be named as server — before a single rally of game two
  // could hand it to them under Law 10.1 instead, which would make the two
  // rules agree by construction and prove nothing.
  await expect(scorebug(page), "the board must name the game it is now on").toContainText("Game 2", {
    timeout: 20_000,
  });
  await expect(strip(page, "games")).toContainText("1–0", { timeout: 20_000 });
  await expect(halfScore(page, "home"), "a new game starts at nothing, not at the last game's score").toHaveText(
    "0",
  );
  await expect(halfScore(page, "away")).toHaveText("0");
  await expect(
    strip(page, "server"),
    "Law 8.1 — the winner of game one serves first in game two, before any rally of it is tapped",
  ).toContainText(homeName, { timeout: 20_000 });
  await expect(half(page, "home"), "the boundary must leave the board live and scoreable").toBeVisible();
  await shot(page, "game-two-opens-home-serving");

  // ---- GAME TWO to home, straight — the match decides -----------------------
  await winGame(page, fx, "home");

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "two straight games did not decide the match").toBe("decided");
  expect(decided.outcome, "a decided badminton match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);

  // Every rally in the ledger came from a tap: 3 + 3.
  const rallies = await ralliesOf(page.request, fx.fixtureId);
  expect(rallies.length, "the ledger holds a different number of rallies than were tapped").toBe(6);

  // The pad unmounts once decided (same chassis behaviour the tennis
  // walkthrough's own F15/F16 note pins) — anchor the capture off that.
  await page.reload();
  await expect(pad(page)).toHaveCount(0);
  await shot(page, "decided");

  // ---- UNDO THE DECIDING RALLY ----------------------------------------------
  const undoLast = page.getByRole("button", { name: /Undo last/ });
  await expect(undoLast, "a match decided by a tapped rally left no way to undo it").toBeVisible();
  await undoLast.click();
  await expect
    .poll(async () => (await fixtureState(page.request, fx.fixtureId)).status, { timeout: 20_000 })
    .toBe("in_play");

  const reopened = await fixtureState(page.request, fx.fixtureId);
  expect(reopened.outcome, "the fixture is in_play but still carries an outcome").toBeNull();
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    halfScore(page, "home"),
    "undoing the deciding rally must roll the score back with it",
  ).toHaveText("2", { timeout: 20_000 });
  await expect(half(page, "home"), "the board came back dead after undoing the deciding rally").toBeVisible();
  await shot(page, "undone-pad-back");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
