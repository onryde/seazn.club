// R5 — volleyball, WHOLE MATCH: tapped from a live pad through a set opened
// by cascade, a set opened by a fresh anchor, into the DECIDING set's own
// fresh TOSS, to a decided result, then the deciding rally undone.
//
// scorepad-v3-volleyball.spec.ts (e2e/) proves the anchor resolves D-17 and
// the rotation number for ONE set, that closing a set through the Set score
// tile ALONE leaves the next set unresolved, and the libero swap — never a
// real set boundary crossed by tapping, never a deciding set, never a
// decided match. This file is what `scorepad-v3-tennis-mtb.spec.ts` (this
// folder's own sibling) is for every racquet sport: tap a real match to a
// decided result through the phase transition that has broken every sport
// that skipped this proof, then undo the deciding event.
//
// Volleyball is the ONE racquet sport whose reader genuinely cannot resolve
// `rotation`/`serverPersonId` without a declared rally somewhere
// (`setStart: "alternate"`, `v3/skins/volleyball.tsx`'s own header, verified
// there directly against `foldMatch`), AND the one sport whose DECIDING set
// is tossed afresh (FIVB 7.1) regardless of how resolved the set before it
// was. Both matter here:
//
//  - SET ONE opens on a deliberate ORDINARY tap, not the anchor — the
//    realistic path a scorer who just starts scoring takes, and the exact
//    scenario commit `aca58a959` fixed: the side self-heals from the tap's
//    own winner (side-out is unconditional), but the rotation cannot, and
//    the tile must stay offered rather than withdraw the moment the side
//    alone resolves. Asserted here as the NEW behaviour, not the old one.
//  - Because set one was never anchored, set two opens fully unresolved too
//    — a CASCADE, not a bug — so it is anchored there instead, proving a
//    mid-match (non-opening, non-decider) anchor use works.
//  - SET THREE is the deciding set of this shortened `bestOf: 3` — tossed
//    afresh (`closed === cfg.bestOf - 1`, setbased/kernel.ts's own
//    `openNextSet`) regardless of set two's own clean resolution, re-
//    offering the anchor tile one last time. Anchored there too.
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
function v3Dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}
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
  return (await ledger(request, fixtureId)).filter((e) => e.type === "volleyball.rally");
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
    await page.screenshot({ path: `e2e-artifacts/volleyball-match/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

/** A full indoor starting six, S/OH/MB/OPP/OH/MB — FIVB's own catalog
 *  shape, identical to the sibling non-walkthrough spec's own
 *  `indoorRoster`. */
const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
function indoorRoster(label: string) {
  return COURT.map((positionKey, i) => ({ fullName: `${label} P${i + 1} ${TAG}`, positionKey }));
}

/** Volleyball's own dock ALWAYS asks (`onCourt.length <= 1` never fires for
 *  a 6-a-side or a beach pair — `volleyball.tsx`'s own "THE DOCK ALWAYS
 *  ASKS"), so every rally in this file needs this. Checked defensively
 *  (`.count()`, not assumed) rather than required, matching
 *  scorepad-v3-deciders-fullmatch.spec.ts's own `sendHeldNow` — a rally
 *  this file does not expect to open one must not hang on a control that
 *  will never appear. */
async function sendHeldNowIfAsked(page: Page): Promise<void> {
  const btn = v3Dock(page).getByRole("button", { name: "Send now", exact: true });
  if (await btn.count()) await btn.click();
}

let lastSide: "home" | "away" | null = null;
/**
 * `opener` is STRICT in both directions, deliberately. Passing it REQUIRES
 * the set-opener sheet to appear and answers it; omitting it requires that no
 * sheet appears at all. A defensive "answer it if it happens to be there"
 * would let the prompt silently stop firing — the exact regression this whole
 * mechanism exists to prevent — and would also hide it firing where it should
 * not, which is the cost side of the same feature.
 */
async function tapRally(
  page: Page,
  fx: RosteredFixture,
  side: "home" | "away",
  opener?: "home" | "away",
): Promise<void> {
  const before = (await ledger(page.request, fx.fixtureId)).length;
  if (side === lastSide) await page.waitForTimeout(750);
  if (PACE > 0) await page.waitForTimeout(PACE);
  await half(page, side).click();
  lastSide = side;
  const sheet = v3Sheet(page);
  if (opener !== undefined) {
    await expect(sheet, "the first tap of an unopened set must ASK who served").toBeVisible({
      timeout: 20_000,
    });
    await choiceOption(sheet, opener).click();
    await expect(sheet, "one question only — it must close on the first answer").toHaveCount(0, {
      timeout: 20_000,
    });
  } else {
    await expect(sheet, "an ordinary rally must score on ONE tap — model S").toHaveCount(0);
  }
  await sendHeldNowIfAsked(page);
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
  await sendHeldNowIfAsked(page);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before + 1);
}

test("R5 — volleyball: tap a match through a cascaded set, an anchored set, and the deciding set's own fresh toss, to a decided result", async ({
  page,
}) => {
  test.setTimeout(180_000);
  shotNo = 0;
  lastSide = null;

  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Volleyball Match ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: indoorRoster("V3 VB Match Home"),
    away: indoorRoster("V3 VB Match Away"),
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
  // `decidingSetTossed` (the thing under test) is not a cfg field at all —
  // it is baked into volleyball.ts's own `serve`, so nothing this test
  // writes through this endpoint could touch it. What DOES come from the
  // division is the match length, and it must be the real "indoor"
  // preset's before this test shortens it.
  expect(cfg, "the shipped indoor variant no longer ships sets to 25/15, best of 5").toMatchObject({
    bestOf: 5,
    setTo: 25,
    finalSetTo: 15,
    winBy: 2,
    cap: null,
  });

  // `bestOf` shortened too, deliberately — beyond the unit suite's own
  // `{setTo,finalSetTo,cap}` shorthand, but the same technique applied to
  // the orthogonal knob this file actually needs short: the toss this file
  // exists to prove fires exactly when `closed === cfg.bestOf - 1`
  // (setbased/kernel.ts's own `openNextSet`), a check written in terms of
  // `cfg.bestOf` and nothing else — a best-of-3 match reaches the SAME
  // tossed decider a real best-of-5 does, three sets in instead of five.
  // bestOf must stay odd (3 is) and cap(5) >= max(setTo,finalSetTo)=3 — the
  // kernel's own refinements (`makeConfigSchema`). Written by SQL: a
  // division that already owns fixtures is FORMAT_LOCKED and 409s a config
  // PATCH, and it must land before the first event — V347 freezes
  // `config_snapshot` at first score.
  await setDivisionConfigSql(fx.divisionId, { ...cfg, setTo: 3, finalSetTo: 3, cap: 5, bestOf: 3 });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
  await expect(scorebug(page)).toContainText("Set 1", { timeout: 20_000 });
  await expect(strip(page, "server"), "before any rally nobody can say who serves").toHaveCount(0);
  await expect(strip(page, "rotation")).toHaveCount(0);
  await expect(v3Tile(page, "serveAnchor")).toBeVisible({ timeout: 20_000 });
  await expect(half(page, "home"), "a live fixture must render a real, tappable half").toBeVisible();
  await shot(page, "match-open");

  // ---- SET ONE opens on an ORDINARY tap, and the pad ASKS -------------------
  // REWRITTEN (review of PR #678). This block used to open set one on a bare
  // tap and then assert the rotation stayed dark "by design, not by defect" —
  // documenting a real loss: `firstServer` is only ever set by a declaration
  // landing on the set's OWN first rally, and nothing asked for one.
  //
  // Owner ruling R5-7 tried to close that by keeping the anchor tile visible
  // afterwards. That could not work, and the reason is not an engine
  // shortcoming: under side-out the next server IS the last rally's winner,
  // so once a point exists, "who is serving" no longer says who OPENED the
  // set — and the opener is the only thing the rotation is missing. The tile
  // therefore promised a repair it could never perform.
  //
  // So the question moved to the one tap where the answer still exists. The
  // natural flow — tap a half and start scoring — now asks once, and the
  // rotation survives it.
  await tapRally(page, fx, "home", "home");
  await expect(halfScore(page, "home")).toHaveText("1", { timeout: 20_000 });
  await expect(strip(page, "server"), "side-out self-heals from any rally's own winner").toContainText("Home", {
    timeout: 20_000,
  });
  await expect(
    strip(page, "rotation"),
    "the answer bought the rotation number the old flow threw away",
  ).toContainText("1", { timeout: 20_000 });
  // And the tile withdraws, because there is nothing left for it to fix.
  // Its former job — offering a repair mid-set — was never possible; this is
  // the same defect closed from the other end.
  await expect(
    v3Tile(page, "serveAnchor"),
    "with both fields reported the tile has no question left to ask",
  ).toHaveCount(0);
  await shot(page, "set-one-opener-asked-rotation-live");

  await tapRally(page, fx, "home");
  await expect(halfScore(page, "home")).toHaveText("2", { timeout: 20_000 });
  // No score check on the winning tap itself: the set-closing fold is
  // atomic with the rally that decides it, so the board never renders the
  // old set's final score — it repoints straight to the fresh set the
  // boundary check below asserts.
  await tapRally(page, fx, "home");

  // ---- THE BOUNDARY: set one closes 3-0, unresolved rotation and all -------
  await expect(scorebug(page), "the board must name the set it is now on").toContainText("Set 2", {
    timeout: 20_000,
  });
  await expect(strip(page, "games")).toContainText("1–0", { timeout: 20_000 });
  await expect(halfScore(page, "home"), "a new set starts at nothing").toHaveText("0");
  await expect(halfScore(page, "away")).toHaveText("0");
  // CASCADED — and now it cascades something REAL. This block used to assert
  // the opposite (no server, no rotation, "set one never named a first server
  // for set two to alternate off"), which was true only because set one was
  // allowed to open unanswered. It no longer can be: the pad asks, so set
  // one HAS a first server, and FIVB 12.1.2's alternation gives set two its
  // opener for free — the OPPONENT of the side that opened set one.
  //
  // That is the cascade this file exists to demonstrate, finally carrying
  // information instead of carrying a gap.
  await expect(
    strip(page, "server"),
    "set two alternates off set one's own opener, which is now known",
  ).toContainText("Away", { timeout: 20_000 });
  await expect(strip(page, "rotation")).toContainText("1", { timeout: 20_000 });
  await expect(
    v3Tile(page, "serveAnchor"),
    "nothing to anchor: the opener came free from alternation",
  ).toHaveCount(0);
  await expect(half(page, "home"), "the boundary must leave the board live and scoreable").toBeVisible();
  await shot(page, "set-two-opens-unresolved");

  // ---- SET TWO — inherited, and scored on ONE tap ---------------------------
  // This block used to open set two with `tapAnchor`, because set two's own
  // opener was unknown. It no longer is: set one now names a first server, so
  // alternation hands set two its opener and there is no anchor tile to press.
  //
  // What that buys is the point of the whole mechanism — ONE question at the
  // start of the match, and every set after it inherits. Tap model S is
  // untouched here: this is a bare tap that scores.
  await tapRally(page, fx, "away");
  await expect(halfScore(page, "away")).toHaveText("1", { timeout: 20_000 });
  await expect(strip(page, "server"), "away won it, so away serves next").toContainText("Away", {
    timeout: 20_000,
  });
  // The strip item renders its LABEL and value together ("Rotation 2"), so
  // this anchors on both: a `toHaveText("2")` would fail even when correct,
  // and a bare `toContainText("2")` would pass on a label that happened to
  // carry the digit.
  await expect(strip(page, "rotation"), "FIVB 7.6.2 — away's own court-position number").toHaveText("Rotation 2", {
    timeout: 20_000,
  });
  await expect(v3Tile(page, "serveAnchor"), "nothing unresolved — no tile").toHaveCount(0);
  await shot(page, "set-two-inherited");

  await tapRally(page, fx, "away");
  await expect(halfScore(page, "away")).toHaveText("2", { timeout: 20_000 });
  await tapRally(page, fx, "away");

  // ---- THE DECIDER: TOSSED AFRESH, regardless of set two's own resolution --
  await expect(scorebug(page)).toContainText("Set 3", { timeout: 20_000 });
  await expect(strip(page, "games")).toContainText("1–1", { timeout: 20_000 });
  await expect(halfScore(page, "home")).toHaveText("0");
  await expect(halfScore(page, "away")).toHaveText("0");
  // UNLIKE set one -> set two above: set two WAS fully anchored, so this
  // reset is not a cascade — it is FIVB 7.1's own fresh toss firing at
  // `closed === cfg.bestOf - 1` regardless of how resolved the set before
  // it was.
  await expect(strip(page, "server"), "the deciding set is tossed afresh, not alternated").toHaveCount(0);
  await expect(strip(page, "rotation")).toHaveCount(0);
  await expect(v3Tile(page, "serveAnchor"), "the anchor tile reappears at the decider").toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "decider-tossed");

  // ---- THE DECIDER, ANCHORED — the rotation number resolves -----------------
  await tapAnchor(page, fx, "away", "home");
  await expect(halfScore(page, "home")).toHaveText("1", { timeout: 20_000 });
  await expect(strip(page, "server"), "resolved by the anchor — home is due next").toContainText("Home", {
    timeout: 20_000,
  });
  await expect(
    strip(page, "rotation"),
    "FIVB 7.6.2 — home's own court-position number, resolved at the decider",
  ).toHaveText("Rotation 2", { timeout: 20_000 });
  await expect(v3Tile(page, "serveAnchor")).toHaveCount(0, { timeout: 20_000 });
  await shot(page, "decider-anchored");

  await tapRally(page, fx, "home");
  await expect(halfScore(page, "home")).toHaveText("2", { timeout: 20_000 });
  await tapRally(page, fx, "home");

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "the decider did not decide the match").toBe("decided");
  expect(decided.outcome, "a decided volleyball match carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);

  const rallies = await ralliesOf(page.request, fx.fixtureId);
  expect(rallies.length, "the ledger holds a different number of rallies than were tapped").toBe(9);
  expect(
    rallies[0]!.payload,
    "set one's own first rally was an ORDINARY tap, not a declaration",
  ).not.toHaveProperty("serving");
  expect(rallies[3]!.payload.serving, "set two's own anchor declared home as its server").toBe(
    fx.homeEntrantId,
  );
  expect(rallies[6]!.payload.serving, "the decider's own anchor declared away as its server").toBe(
    fx.awayEntrantId,
  );

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
  // WAIT FOR THE BOARD ITSELF, NOT JUST THE PAD. `pad()` becomes visible while
  // the scorebug's own grid is still empty — the halves arrive on the refold
  // that follows the void. Asserting a score straight off `pad()` therefore
  // races a remount, and under load (a vitest run on the same machine) that
  // race is lost for longer than the 20s budget: the first version of this
  // block failed with a stable "0", which reads exactly like a scoring defect
  // and is not one. The fold's own answer here is home 2, away 0.
  await expect(
    scorebug(page).locator(".grid > *").first(),
    "the scorebug never re-rendered after the undo",
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    halfScore(page, "home"),
    "undoing the deciding rally must roll the score back with it",
  ).toHaveText("2", { timeout: 20_000 });
  await expect(
    halfScore(page, "away"),
    "the OTHER side's score must survive the undo untouched",
  ).toHaveText("0");
  await expect(half(page, "home"), "the board came back dead after undoing the deciding rally").toBeVisible();
  // The decider was ANCHORED before this rally, and undoing a rally must not
  // un-anchor the set: the serve chain is derived from the ledger, and the
  // declaration that resolved it is still in there.
  await expect(
    v3Tile(page, "serveAnchor"),
    "undoing a rally re-opened a serve question the ledger had already answered",
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(strip(page, "rotation"), "the rotation survives the undo").toHaveCount(1);
  await shot(page, "undone-pad-back");

  // ---- AND FINISH IT AGAIN, THE OTHER WAY ------------------------------------
  // The undo proves the board comes back; it never proves the board is still
  // USABLE. A scorer who corrects a mistake has to be able to carry on and
  // finish. The deciding rally goes to AWAY this time — a pad that replayed
  // its old state rather than re-deriving it would name the winner from
  // before, and the rotation would follow the wrong side out.
  // FOUR taps, not one, and the arithmetic is the decider's own cfg: the board
  // stands at 2-0 to HOME in a set to 3, winBy 2, cap 5. Away therefore passes
  // through 2-1, 2-2, 2-3 (three points is the target but a one-point lead is
  // not enough) and takes the set at 2-4. Asserting each step is what proves
  // the board is LIVE rather than replaying the state it held before the undo.
  for (const expected of ["1", "2", "3"]) {
    await tapRally(page, fx, "away");
    await expect(
      halfScore(page, "away"),
      `the board stopped advancing after the undo at away ${expected}`,
    ).toHaveText(expected, { timeout: 20_000 });
  }
  // The FOURTH tap takes the set (2-4) and with it the match, so the pad
  // unmounts on the same commit — there is no board left to read a "4" from.
  // Asserting one here is the same mistake as reading a score off a decided
  // fixture: the proof of this tap is the fixture's own status, below.
  await tapRally(page, fx, "away");
  const refinished = await fixtureState(page.request, fx.fixtureId);
  expect(refinished.status, "the match could not be finished again after an undo").toBe("decided");
  expect(refinished.outcome!.winner, "the re-finished decider named the wrong winner").toBe(fx.awayEntrantId);
  await page.reload();
  await expect(pad(page), "a re-decided match unmounts the pad again").toHaveCount(0);
  await shot(page, "refinished-the-other-way");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
