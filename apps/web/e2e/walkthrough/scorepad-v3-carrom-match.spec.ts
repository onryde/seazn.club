// R7/A3 — carrom, WHOLE MATCH: tapped through carrom's own GAME BOUNDARY —
// best-of-3, first to `gameTo` (25 under `icf`) — to a decided match.
//
// Carrom is tapModel T (`v3/skins/carrom.tsx`): both scorebug halves are
// READOUTS, and every action is a TILE ("Board (no queen)" / "Board (queen
// covered)" / "Adjustment — credit" / "Adjustment — deduct") that opens a
// guided SHEET. The thing this file exists to prove is the one shape this
// folder is FOR: carrom's GAME TRANSITION — crossing `gameTo` must repoint
// the pad onto a fresh game (per-game score reset to 0-0) while `gamesWon`
// keeps the running tally, and the match must go on to a REAL decided
// result once `bestOf`'s majority is reached, never stopping short of it
// (R5's three walkthroughs stopped before their own decider closed and
// sailed over a decided-board defect — see this folder's README).
//
// COST: carrom's own `fidelityEntitlements` is `{}` (nothing gated — a
// separately-tracked cross-sport gap, `reference_sportmodule_padspec_
// optional_field_trap.md`'s sibling finding), so `resolveFidelityBand`
// (server/usecases/fidelity.ts) resolves band 3 for ANY org, no plan setup
// needed — but it also means every tapped board opens the breaker-
// attribution DOCK. That attribution is not under test here, so every tap
// below is followed by "Send now" (queue.ts's soft-commit dismiss) rather
// than waiting out the ~12s `HOLD_MS` hold — the folder's own rule applied
// to wall-clock cost, not just tap count: reach game one's near-close by
// API, then tap only the boards that ARE the transition under test (its
// close, and the whole of game two, which must be genuinely live and
// scoreable post-repoint or the "TAP through" claim is untested). No queen
// board, adjustment or toss tap: none of those are the thing under test,
// and Law-52 queen bookkeeping already has its own coverage in
// `carrom-pad.spec.ts` and `gallery.capture.ts`'s carrom recipe.
//
// Set DEMO_PACE=<ms> and run with `--headed` to watch it happen in a real
// browser; DEMO_HOLD=<ms> keeps the window open at the end.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  seedRosteredFixture,
  TAG,
  type RosteredFixture,
} from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { HUMAN_FASTEST_REPEAT_MS } from "../../src/components/v2/scorepad/use-pad-pipeline";

test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
function tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}
function strip(page: Page, id: string) {
  return scorebug(page).locator(`[data-strip-item-id="${id}"]`);
}
/** Same locator shape every sibling walkthrough's own `halfScore` uses —
 *  scoped to `.app-display.font-bold` because that class names the ONE
 *  score digit, never the WHO line or the "(gamesWon)" sub-caption sharing
 *  the same grid cell. */
function halfScore(page: Page, side: "home" | "away") {
  return scorebug(page)
    .locator(".grid > *")
    .nth(side === "home" ? 0 : 1)
    .locator(".app-display.font-bold");
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
async function boardsOf(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "carrom.board.summary");
}
async function fixtureState(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{
    status: string;
    outcome: { kind?: string; winner?: string } | null;
    state: Record<string, unknown>;
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}

/** Dispatch a real ledger event, reading `last_seq` fresh — the same shape
 *  mobile.spec.ts's own `postEvent` documents borrowing from gallery.capture
 *  .ts / scorepad-v3-football.spec.ts. Used ONLY for the one board this file
 *  seeds via the API to REACH game one's near-close (this folder's own
 *  rule) — every board that IS the transition under test goes through a tap. */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/** "Send now" (queue.ts's `releaseHeld` via the dock's dismiss control) —
 *  same idiom `scorepad-v3-deciders-fullmatch.spec.ts`'s own `sendHeldNow`
 *  takes: a no-op when no dock is open, so this is safe to call
 *  unconditionally after every tap. */
async function sendHeldNow(page: Page): Promise<void> {
  const btn = pad(page).locator('[data-role="v3-dock"]').getByRole("button", { name: "Send now", exact: true });
  if (await btn.count()) await btn.click();
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
    await page.screenshot({ path: `e2e-artifacts/carrom-match/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

/**
 * Tap the "Board (no queen)" tile: winner + 9 (the schema's own max —
 * `CarromBoardSummary.opponentCoinsLeft` is `min(0).max(9)`, and
 * `applyBoard`'s own fold reads it straight as the winner's coin points —
 * `coinPoints = payload.opponentCoinsLeft * cfg.pointsPerCoin` — so 9 banks
 * the most a single board can, keeping the tap count to the minimum needed
 * to cross `gameTo` (25) rather than a realistic-looking board count).
 * Confirms, then flushes the breaker-attribution dock with "Send now"
 * (that attribution is not under test) and waits for the SERVER ledger to
 * carry the board before returning — the same "poll the real ledger, never
 * trust the optimistic fold alone" posture every sibling walkthrough takes.
 */
let lastTap: { winner: "home" | "away"; at: number } | null = null;
/** Keyed on `winner`, not on a scoreboard side: carrom is tapModel T, and it
 *  is the PAYLOAD that repeats — `{winner, opponentCoinsLeft: 9}`, identical
 *  every time the same side takes a board. Pinned to
 *  `HUMAN_FASTEST_REPEAT_MS` rather than to the guard's own window; see the
 *  fuller note in `scorepad-v3-badminton-match.spec.ts` for why that
 *  distinction preserves R7-43's acceptance test instead of undoing it.
 *  Waits only the remainder, and only when the same side won the last board.
 */
async function pace(page: Page, winner: "home" | "away"): Promise<void> {
  if (lastTap !== null && lastTap.winner === winner) {
    const remaining = HUMAN_FASTEST_REPEAT_MS - (Date.now() - lastTap.at);
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
  lastTap = { winner, at: Date.now() };
}

async function tapBoard(page: Page, fx: RosteredFixture, winner: "home" | "away"): Promise<void> {
  const before = await ledger(page.request, fx.fixtureId);
  if (PACE > 0) await page.waitForTimeout(PACE);
  await pace(page, winner);
  // Every board tapped in this file is `{winner, opponentCoinsLeft: 9}` —
  // bit-for-bit the SAME payload every time (carrom declares no `clock()`,
  // so `stampFor` hands it back unchanged, per `send`'s own doc in
  // pad-host.tsx). This is R7-43's OWN reproduction (`_INDEX.md`): under
  // real load this file's own tile-click-through-Confirm sequence could
  // complete inside the old `DOUBLE_SUBMIT_WINDOW_MS` (600ms), so a repeat
  // tap was dropped CLIENT-SIDE with no error and no network request at all
  // — the 4th board tap here vanished silently under parallel-worker load,
  // zero POST logged, ledger stuck one short. R7-42's fix (owner ruling)
  // narrowed the window to 250ms and made a refused repeat VISIBLE rather
  // than silent, so the flat clearance this used to pay was deleted and THIS
  // call site was named the acceptance test for that fix.
  //
  // The deletion went too far — the identical omission in the volleyball
  // walkthrough flaked in CI (a different board short each run), and this
  // file's payload is the MOST repeatable in the suite. `pace` above restores
  // spacing pinned to the HUMAN floor rather than to the guard's window, so
  // the acceptance test still asserts something the guard could fail: that a
  // real player's consecutive boards all record.
  await tile(page, "board").click();
  await expect(sheet(page)).toBeVisible({ timeout: 10_000 });
  await sheet(page).locator(`[data-choice-option-id="${winner}"]`).click();
  await sheet(page).getByLabel("Opponent's coins left", { exact: true }).fill("9");
  await sheet(page).getByRole("button", { name: "Confirm", exact: true }).click();
  await sendHeldNow(page);
  // Derived from HOLD_MS, not a flat 20s: "Send now" flushes well under the
  // full hold in the common case, but a bare 20s proved tight under real
  // parallel-worker load. AGENTS.md's own rule: a flat timeout beside a
  // derived cost is a latent red under load, even one "Send now" is meant
  // to make moot.
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: HOLD_MS + 15_000 })
    .toBe(before.length + 1);
}

test("R7/A3 — carrom: tap the boards that close game one, then tap through game two to a decided match", async ({
  page,
}) => {
  // 5 tapped boards in this file (2 to close game one, 3 to close game two);
  // derived from HOLD_MS, never a flat literal — the same AGENTS.md rule
  // (§"a flat timeout beside a derived cost is a latent red") every sibling
  // walkthrough's own budget follows, even though "Send now" keeps the real
  // per-tap cost well under the full hold in the common case.
  test.setTimeout(Math.max(240_000, 90_000 + 5 * (HOLD_MS + 15_000)));
  shotNo = 0;

  const homeName = `V3 Carrom Home ${TAG}`;
  const awayName = `V3 Carrom Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Carrom Match ${TAG}`,
    sportKey: "carrom",
    variantKey: "icf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status, `GET division -> ${div.status}`).toBe(200);
  expect(div.data!.config, "icf ships gameTo 25 / maxBoards 8 / bestOf 3 by default").toMatchObject({
    gameTo: 25,
    maxBoards: 8,
    bestOf: 3,
  });

  // ---- SETUP via API: one board banked to home (9 pts, well short of 25) —
  // REACHING a state, never the thing under test. Every board that actually
  // CLOSES a game, below, is tapped.
  await postEvent(page.request, fx.fixtureId, "carrom.board.summary", {
    winner: fx.homeEntrantId,
    opponentCoinsLeft: 9,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await expect(strip(page, "game")).toContainText("1/3", { timeout: 20_000 });
  await expect(halfScore(page, "home"), "the API-seeded board must already be on the board").toHaveText("9", {
    timeout: 20_000,
  });
  await expect(tile(page, "board"), "a live fixture must render a tappable board tile").toBeVisible();
  await shot(page, "game-one-nine");

  // ---- TAP the boards that close game one -----------------------------------
  await tapBoard(page, fx, "home"); // 9 -> 18: short of gameTo, must NOT repoint.
  await expect(strip(page, "game"), "18 is short of gameTo(25) — must not repoint yet").toContainText("1/3");
  await expect(halfScore(page, "home")).toHaveText("18", { timeout: 20_000 });
  await shot(page, "game-one-eighteen");

  await tapBoard(page, fx, "home"); // 18 -> 27 >= 25: closes game one.
  await expect(strip(page, "game"), "crossing gameTo must repoint the pad onto game two").toContainText("2/3", {
    timeout: 20_000,
  });
  await expect(
    halfScore(page, "home"),
    "a new game starts at nothing, not at the game it just won",
  ).toHaveText("0", { timeout: 20_000 });
  await expect(halfScore(page, "away")).toHaveText("0");
  await expect(tile(page, "board"), "the boundary must leave the board live and scoreable").toBeVisible();
  const afterGameOne = await fixtureState(page.request, fx.fixtureId);
  expect(
    (afterGameOne.state as { gamesWon?: { home?: number; away?: number } }).gamesWon,
    "the games-won tally must accumulate across the boundary, not reset with the per-game score",
  ).toEqual({ home: 1, away: 0 });
  expect(afterGameOne.status, "one game of three must not decide a best-of-3 match").toBe("in_play");
  await shot(page, "game-two-opens");

  // ---- TAP THROUGH game two to the terminal state ----------------------------
  // Not a repeat of game one's own shortcut: game two is driven ENTIRELY by
  // tap, from the fresh 0-0 the boundary opened, proving the repointed board
  // is genuinely live — not merely that the pad SAYS "Game 2" while still
  // privately scoring the old one.
  await tapBoard(page, fx, "home"); // 0 -> 9
  await expect(halfScore(page, "home")).toHaveText("9", { timeout: 20_000 });
  await tapBoard(page, fx, "home"); // 9 -> 18
  await expect(halfScore(page, "home")).toHaveText("18", { timeout: 20_000 });
  await shot(page, "game-two-eighteen");

  await tapBoard(page, fx, "home"); // 18 -> 27 >= 25: closes game two AND the match
  // (gamesWon.home reaches majority(bestOf=3)=2 in the same fold).

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "the tapped boards never decided the match").toBe("decided");
  expect(decided.outcome, "a decided carrom match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner, "the wrong side was named the winner").toBe(fx.homeEntrantId);
  expect(
    (decided.state as { gamesWon?: { home?: number; away?: number } }).gamesWon,
    "the match decided without reaching bestOf's own majority of games won",
  ).toEqual({ home: 2, away: 0 });

  // The ledger and the taps agree: 1 API board + 2 (game one's close) + 3
  // (all of game two) = 6.
  const boards = await boardsOf(page.request, fx.fixtureId);
  expect(boards.length, "the ledger holds a different number of boards than were recorded").toBe(6);

  // The pad unmounts once decided — same chassis behaviour every sibling
  // walkthrough's own note pins (`reference_pad_unmounts_the_instant_a_
  // match_is_decided.md`) — anchor the final capture off that, run through
  // to the actual terminal state rather than stopping at the API's own
  // "decided" flag.
  await page.reload();
  await expect(pad(page), "a decided carrom match must unmount the pad").toHaveCount(0);
  await shot(page, "decided");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
