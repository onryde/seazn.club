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
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { HUMAN_FASTEST_REPEAT_MS } from "../../src/components/v2/scorepad/use-pad-pipeline";

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
 *
 * R7-42/R7-30/R7-43 (owner ruling, `_INDEX.md`) — this used to pay a flat
 * 750ms clearance on a same-side repeat (tracked in `lastSide`, shared with
 * `tapAnchor` below) so it would not collide with `DOUBLE_SUBMIT_WINDOW_MS`.
 * That window is now 250ms (was 600ms) and a refused repeat is VISIBLE
 * rather than silent, so the flat clearance was deleted.
 *
 * Deleting it entirely was a step too far, and the identical omission in
 * `scorepad-v3-volleyball-match.spec.ts` flaked in CI for it (`Expected: 4,
 * Received: 3`, a different rally each run). Visible is not recorded: the
 * guard still REFUSES a byte-identical repeat inside its window, two
 * consecutive rallies to the same side ARE byte-identical, and the refused
 * tap writes no ledger row — so the poll below then waits 20s for a row that
 * will never come. The only thing keeping this file green was the ledger
 * round trip usually outlasting the window, which is luck.
 *
 * `pace` is pinned to `HUMAN_FASTEST_REPEAT_MS`, NOT to the guard's own
 * window — see the fuller note in the volleyball sibling. A wait derived
 * from the guard dodges it (the workaround R7-43 ruled must be deletable); a
 * wait derived from the human floor states what this test actually claims,
 * and clears the guard by construction because the unit suite asserts
 * `DOUBLE_SUBMIT_WINDOW_MS < HUMAN_FASTEST_REPEAT_MS`. It waits only the
 * remainder, and only on a same-side repeat.
 */
let lastTap: { side: "home" | "away"; at: number } | null = null;
async function pace(page: Page, side: "home" | "away"): Promise<void> {
  if (lastTap !== null && lastTap.side === side) {
    const remaining = HUMAN_FASTEST_REPEAT_MS - (Date.now() - lastTap.at);
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
  lastTap = { side, at: Date.now() };
}

async function tapRally(page: Page, fx: RosteredFixture, side: "home" | "away"): Promise<void> {
  const before = (await ledger(page.request, fx.fixtureId)).length;
  if (PACE > 0) await page.waitForTimeout(PACE);
  await pace(page, side);
  await half(page, side).click();
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
  // Keyed on `wonBy` — the anchor dispatches ONE rally won by that side, so
  // that is the side a following tap could be an identical repeat of. Shared
  // bookkeeping with `tapRally`, exactly as the old `lastSide` was.
  await pace(page, wonBy);
  await v3Tile(page, "serveAnchor").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, serving).click();
  await expect(sheet).toContainText("Who won it?", { timeout: 20_000 });
  await choiceOption(sheet, wonBy).click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

test("R5 — table tennis: tap a match across the turnLength:2 rotation, into deuce, and through a game boundary to a decided result", async ({
  page,
}) => {
  // DERIVED from HOLD_MS, never a flat literal. Every tap here soft-commits:
  // the event enters the queue at once but is not SENT for a full hold
  // window, and `tapRally` polls the ledger for it before the next tap — so
  // this spec's wall time is dominated by HOLD_MS x taps (21 of them).
  //
  // A flat 180_000 was the bug: it fit at the old 6s window, and the moment
  // the shipped window moved to 12s (21 x ~13s) this spec ran out of clock
  // on its second-to-last tap and reported it as a ledger-count mismatch —
  // a timing budget failing in the costume of a scoring defect. e2e runs the
  // pad at a shortened window now, but a LOCAL run uses the shipped one, and
  // this expression has to hold for both.
  test.setTimeout(Math.max(180_000, 60_000 + 21 * (HOLD_MS + 2_000)));
  shotNo = 0;

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

  // ---- GAME TWO to AWAY — the match must go the DISTANCE --------------------
  // Deliberately not another straight home game. Every sport this programme
  // has broken, it broke at the DECIDER — cricket's super over, football's
  // shoot-out, tennis's match tie-break — and a walkthrough that wins 3-0 of
  // best-of-5 never plays one. Away takes games two and four so the match
  // reaches game FIVE, which under ITTF Law 2.13.5 is the game where ends
  // change at 5 points.
  await tapRally(page, fx, "away");
  await tapRally(page, fx, "away");
  await tapRally(page, fx, "away");
  await expect(scorebug(page)).toContainText("Game 3", { timeout: 20_000 });
  await expect(strip(page, "games")).toContainText("1–1", { timeout: 20_000 });
  await expect(half(page, "home"), "a game lost must leave the board live and scoreable").toBeVisible();

  // ---- GAME THREE to home ---------------------------------------------------
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");
  await expect(scorebug(page)).toContainText("Game 4", { timeout: 20_000 });
  await expect(strip(page, "games")).toContainText("2–1", { timeout: 20_000 });

  // ---- GAME FOUR to away — into the decider ---------------------------------
  await tapRally(page, fx, "away");
  await tapRally(page, fx, "away");
  await tapRally(page, fx, "away");
  await expect(scorebug(page), "two games all — the match reaches its DECIDER").toContainText("Game 5", {
    timeout: 20_000,
  });
  await expect(strip(page, "games")).toContainText("2–2", { timeout: 20_000 });
  // The decider is still an ordinary scoreable board: table tennis has no
  // `decidingSetTossed`, so unlike volleyball nothing is re-tossed here and
  // the serve carries through by the same fixed-turns rotation.
  await expect(half(page, "home"), "the DECIDER must be live and scoreable").toBeVisible();
  await expect(strip(page, "server"), "the decider names a server like any other game").not.toHaveCount(0);
  await shot(page, "decider-opens");

  // ---- GAME FIVE to home — the match decides IN THE DECIDER ------------------
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");
  await tapRally(page, fx, "home");

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "a match taken to game five did not decide").toBe("decided");
  expect(decided.outcome, "a decided table tennis match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);

  const rallies = await ralliesOf(page.request, fx.fixtureId);
  // 6 in game one (the anchor, the turnLength:2 rotation and the deuce dance),
  // then 3 in each of games two through five — the match now goes the DISTANCE.
  expect(rallies.length, "the ledger holds a different number of rallies than were tapped").toBe(18);
  expect(rallies[0]!.payload.serving, "the anchor names who served it").toBe(fx.awayEntrantId);
  for (const rally of rallies.slice(1)) {
    expect(rally.payload, "an ordinary tap must never declare serving").not.toHaveProperty("serving");
  }

  await page.reload();
  await expect(pad(page)).toHaveCount(0);
  await shot(page, "decided");

  // ---- UNDO THE DECIDING RALLY ----------------------------------------------
  const undoLast = page.getByRole("button", { name: /Void last entry/ });
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
  await expect(halfScore(page, "away"), "the OTHER side's score must survive the undo untouched").toHaveText("0");
  await expect(half(page, "home"), "the board came back dead after undoing the deciding rally").toBeVisible();
  await shot(page, "undone-pad-back");

  // ---- AND FINISH IT AGAIN, THE OTHER WAY ------------------------------------
  // The undo alone proves the board comes back; it never proves the board is
  // still USABLE. A scorer who corrects a mistake has to be able to carry on.
  // The deciding point goes to AWAY this time — a pad that replayed its old
  // state rather than re-deriving it would name the winner from before.
  // FOUR taps, not three: the undo leaves home on 2, so away must reach 4 to
  // clear `winBy: 2`. Three leaves it 2-3 and still in play — which the first
  // draft of this asserted, and the board correctly refused to decide.
  await tapRally(page, fx, "away");
  await tapRally(page, fx, "away");
  await tapRally(page, fx, "away");
  expect(
    (await fixtureState(page.request, fx.fixtureId)).status,
    "a one-point lead decided the decider — winBy 2 is not being honoured",
  ).toBe("in_play");
  await tapRally(page, fx, "away");
  const refinished = await fixtureState(page.request, fx.fixtureId);
  expect(refinished.status, "the match could not be finished again after an undo").toBe("decided");
  expect(refinished.outcome!.winner, "the re-finished decider named the wrong winner").toBe(fx.awayEntrantId);
  await page.reload();
  await expect(pad(page), "a re-decided match unmounts the pad again").toHaveCount(0);
  await shot(page, "refinished-the-other-way");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
