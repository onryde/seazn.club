// R5 — table tennis, WHOLE MATCH: tapped from a live pad through the
// turnLength:2 rotation, into deuce, across a game boundary, to a decided
// result, then the deciding rally undone.
//
// scorepad-v3-tabletennis.spec.ts (e2e/) proves the anchor resolves D-17
// and the within-turn rotation for ONE game — never a game boundary, never
// a deuce dance, never a decided match. This file is what
// `scorepad-v3-tennis-mtb.spec.ts` (this folder's own sibling) is for every
// racquet sport: tap a real match to a decided result through the phase
// transition that has broken every sport that skipped this proof, then
// undo the deciding event.
//
// Table tennis's own transition is `setStart: "alternate"` — UNLIKE
// badminton's `set-winner` (always derivable from the closed game's own
// score), the next game's opener is the OPPONENT of the closed game's own
// declared first server, which exists only where a rally actually declared
// one. This file anchors the match's very first rally ONCE and then proves,
// live, that every later game — table tennis has no `decidingSetTossed`
// exception the way volleyball does — keeps self-healing off that one
// declaration for the rest of the match, exactly as `tabletennis.ts`'s own
// `serve` comment (ITTF 2.13.6) claims and a unit test of `foldMatch` alone
// cannot show reaching a real ledger through a real tile tap.
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
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function v3Sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}
/** A choice step's option, addressed by its STABLE `data-choice-option-id`
 *  (guided-sheet.tsx) — never by its translated label text. Same locator the
 *  non-walkthrough table tennis/volleyball specs' own `choiceOption` uses. */
function choiceOption(sheet: ReturnType<typeof v3Sheet>, optionId: "home" | "away") {
  return sheet.locator(`[data-choice-option-id="${optionId}"]`);
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
async function ralliesOf(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "tabletennis.rally");
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
    await page.screenshot({ path: `e2e-artifacts/tabletennis-match/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

/** Tap a rally on one half and wait for it to REACH the ledger.
 *  `DOUBLE_SUBMIT_WINDOW_MS` (600ms) swallows a same-payload repeat, so a
 *  same-side tap pays a clearance the alternating case never needs — same
 *  shape as the tennis walkthrough's own `tapPoint`. */
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

/** The serve anchor: two independent choice steps dispatching ONE real
 *  rally — who served it, then who won it. */
async function tapAnchor(
  page: Page,
  fx: RosteredFixture,
  serving: "home" | "away",
  wonBy: "home" | "away",
): Promise<void> {
  const before = (await ledger(page.request, fx.fixtureId)).length;
  if (PACE > 0) await page.waitForTimeout(PACE);
  await v3Tile(page, "serveAnchor").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, serving).click();
  await expect(sheet).toContainText("Who won it?", { timeout: 20_000 });
  await choiceOption(sheet, wonBy).click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });
  lastSide = wonBy;
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

test("R5 — table tennis: tap a match across the turnLength:2 rotation, into deuce, and through a game boundary to a decided result", async ({
  page,
}) => {
  test.setTimeout(180_000);
  shotNo = 0;
  lastSide = null;

  const homeName = `V3 TT Match Home ${TAG}`;
  const awayName = `V3 TT Match Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 TableTennis Match ${TAG}`,
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    // `emitCoreStart` LEFT OFF, unlike the brief's own default: V347 freezes
    // `config_snapshot` at the fixture's FIRST EVENT, and `core.start`
    // counts as that event — seeding it here would freeze the SHIPPED
    // (unshortened) config before this test ever gets to shorten it.
    // `Start match` is tapped below instead, AFTER the config is shortened,
    // matching the tennis walkthrough's own sequence exactly.
  });

  const div = await apiJson<{ config: Record<string, unknown> }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  expect(div.status, `GET division -> ${div.status}`).toBe(200);
  const cfg = div.data!.config;
  // `turnLength`/`acceleratesAtDeuce` (the thing under test) are not cfg
  // fields at all — they are baked into tabletennis.ts's own `serve`, so
  // nothing this test writes through this endpoint could touch them. What
  // DOES come from the division is the match length, and it must be the
  // real "bo5" preset's before this test shortens it.
  expect(cfg, "the shipped bo5 variant no longer ships games to 11, uncapped").toMatchObject({
    bestOf: 5,
    setTo: 11,
    finalSetTo: 11,
    winBy: 2,
    cap: null,
  });

  // `cap` moves from ITTF's real "uncapped" to 5 — the one field this
  // shortening deliberately changes the MEANING of, not merely the size of:
  // deuce still triggers once 2*(setTo-1)=4 points are played
  // (setbased/kernel.ts's own `accelerateFromNow`, ITTF 2.13.3), well before
  // the cap can bite, so the mechanic under test is untouched — the cap
  // only bounds how long this test's own deuce dance can run before forcing
  // a decision. bestOf stays 5 (odd) and cap(5) >= max(setTo,finalSetTo)=3
  // — the kernel's own refinements. Written by SQL: a division that already
  // owns fixtures is FORMAT_LOCKED and 409s a config PATCH, and it must
  // land before the first event — V347 freezes `config_snapshot` at first
  // score.
  await setDivisionConfigSql(fx.divisionId, { ...cfg, setTo: 3, finalSetTo: 3, cap: 5 });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await expect(scorebug(page)).toContainText("Game 1", { timeout: 20_000 });
  // D-17: `fixed-turns` never self-heals the way badminton's side-out does,
  // so before any declaration this must render nothing.
  await expect(strip(page, "server"), "undeclared — the pad must not guess").toHaveCount(0);
  await expect(strip(page, "serve")).toHaveCount(0);
  await expect(v3Tile(page, "serveAnchor")).toBeVisible({ timeout: 20_000 });
  await shot(page, "match-open");

  // ---- GAME ONE — anchored once, then the rotation itself -------------------
  // Away serves the anchor, home wins it: point 1, turn 0.
  await tapAnchor(page, fx, "away", "home");
  await expect(halfScore(page, "home")).toHaveText("1", { timeout: 20_000 });
  await expect(strip(page, "server"), "away served the anchor and turnLength is 2").toContainText(awayName, {
    timeout: 20_000,
  });
  await expect(strip(page, "serve")).toHaveText("2nd serve", { timeout: 20_000 });
  await expect(v3Tile(page, "serveAnchor"), "resolved — the anchor tile withdraws").toHaveCount(0, {
    timeout: 20_000,
  });

  // Point 2, still turn 0 — away's own second serve. Away wins it too.
  await tapRally(page, fx, "away");
  await expect(halfScore(page, "away")).toHaveText("1", { timeout: 20_000 });

  // ---- THE TURN BOUNDARY: point 3 crosses into turn 1 -----------------------
  // Two points have now been played, so the turn flips to home — even
  // though AWAY just won the point that crossed it: the server is a
  // function of the SCORE, never of who is winning.
  await expect(
    strip(page, "server"),
    "the turn boundary — server is a function of the score, not the winner",
  ).toContainText(homeName, { timeout: 20_000 });
  await expect(strip(page, "serve")).toHaveText("1st serve", { timeout: 20_000 });
  await tapRally(page, fx, "away");
  await expect(halfScore(page, "away")).toHaveText("2", { timeout: 20_000 });

  // Point 4, still turn 1 — home's own second serve. Home wins it: 2-2.
  await expect(strip(page, "server")).toContainText(homeName, { timeout: 20_000 });
  await expect(strip(page, "serve")).toHaveText("2nd serve", { timeout: 20_000 });
  await tapRally(page, fx, "home");
  await expect(halfScore(page, "home")).toHaveText("2", { timeout: 20_000 });

  // ---- INTO DEUCE: 2*(setTo-1)=4 points played, and the game is still
  // alive, so the score can only be 2-2 (ITTF 2.13.3's own clause) ----------
  await expect(strip(page, "server"), "deuce — away's own turn, one rally long").toContainText(awayName, {
    timeout: 20_000,
  });
  await expect(strip(page, "serve"), "every accelerated turn is length 1, so it is always the 1st").toHaveText(
    "1st serve",
    { timeout: 20_000 },
  );
  await tapRally(page, fx, "home");
  await expect(halfScore(page, "home")).toHaveText("3", { timeout: 20_000 });

  // Not decided (3-2, lead 1 < winBy 2). Deuce continues, one rally per turn.
  await expect(strip(page, "server"), "deuce alternates every single point, not every two").toContainText(homeName, {
    timeout: 20_000,
  });
  await expect(strip(page, "serve")).toHaveText("1st serve", { timeout: 20_000 });
  // No score check on the winning tap itself: the game-closing fold is
  // atomic with the rally that decides it, so the board never renders the
  // old game's final score — it repoints straight to the fresh game the
  // boundary check below asserts.
  await tapRally(page, fx, "home");

  // ---- THE BOUNDARY: game one closes 4-2, and the next game self-heals -----
  // ITTF 2.13.6 — the opener alternates off game one's OWN declared first
  // server (away, from the anchor); no second anchor is needed, unlike
  // volleyball's own decider, because this sport declares no
  // `decidingSetTossed` exception anywhere in its `serve` (tabletennis.ts).
  await expect(scorebug(page), "the board must name the game it is now on").toContainText("Game 2", {
    timeout: 20_000,
  });
  await expect(strip(page, "games")).toContainText("1–0", { timeout: 20_000 });
  await expect(
    halfScore(page, "home"),
    "a new game starts at nothing, not at the last game's score",
  ).toHaveText("0");
  await expect(halfScore(page, "away")).toHaveText("0");
  await expect(strip(page, "server"), "self-healed — no re-anchor needed for game two").toContainText(homeName, {
    timeout: 20_000,
  });
  await expect(v3Tile(page, "serveAnchor"), "self-healed — the tile stays withdrawn").toHaveCount(0);
  await expect(half(page, "home"), "the boundary must leave the board live and scoreable").toBeVisible();
  await shot(page, "game-two-self-healed");

  // ---- GAME TWO to home, straight — self-heals again into game three -------
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");
  await expect(scorebug(page)).toContainText("Game 3", { timeout: 20_000 });
  await expect(strip(page, "games")).toContainText("2–0", { timeout: 20_000 });

  // ---- GAME THREE to home, straight — the match decides ---------------------
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "three straight games did not decide the match").toBe("decided");
  expect(decided.outcome, "a decided table tennis match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);

  const rallies = await ralliesOf(page.request, fx.fixtureId);
  expect(rallies.length, "the ledger holds a different number of rallies than were tapped").toBe(12);
  expect(rallies[0]!.payload.serving, "the anchor names who served it").toBe(fx.awayEntrantId);
  for (const rally of rallies.slice(1)) {
    expect(rally.payload, "an ordinary tap must never declare serving").not.toHaveProperty("serving");
  }

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
