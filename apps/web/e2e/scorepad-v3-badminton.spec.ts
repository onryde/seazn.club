import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";

// ScoringPad v3, wave R5 — the coverage badminton's conversion OWES beyond
// re-pointing the pre-existing flows at the v3 DOM (scoring.spec.ts's two
// badminton tests, gallery.capture.ts's two racquet states). Sibling of
// scorepad-v3-tennis.spec.ts, same shape and the same reasoning: those files
// prove the sport's old flows still work; this one proves what v3 does that no
// earlier badminton pad could.
//
// Badminton is the SECOND tapModel-S sport and the FIRST of the three that
// share `sports/setbased`'s kernel (table tennis and volleyball convert in
// later waves and still render racquet-skin.tsx). As with tennis, there is no
// `data-tile-id` for a rally — the scoreboard halves ARE the rally buttons —
// so every half below is addressed POSITIONALLY: a tappable half's accessible
// name is the player's own name plus hint text, never a fixed string.
//
// What lives here, and why each one is not provable anywhere else:
//
//  - D-17, THE WAVE'S HEADLINE, END TO END. `setBasedServeContext` has unit
//    coverage against real folds, but the pad's own claim is that the SCREEN
//    names the server and that the tap it builds carries that person to the
//    SERVER. Both halves need a browser: the first rally of a match carries NO
//    `server` (the BWF's first server comes from a toss the kernel does not
//    fold, so the reader refuses), and every rally after it does — an
//    asymmetry no unit test of a pure builder can demonstrate reaching a
//    ledger.
//
//  - THE SERVE ACROSS A GAME CHANGE (BWF Law 8.1), driven through the Set
//    score TILE's own guided sheet rather than a posted event — the transition
//    a scorer actually performs.
//
//  - THE SCORER DOCK'S DRAINED PAYLOAD (ruling R5-2). R3's goal dock shipped
//    its own two-step narrowing INERT past five green unit tests and a gallery
//    screenshot, because a pure builder whose output depends on the advanced
//    payload is fully unit-testable and fully inert at the same time. Only a
//    browser proves a dock chip's `mutate` reached the SUBMITTED event rather
//    than a local copy of it. This is the wave's product headline —
//    per-player badminton stats — so it is the one thing that must not ship
//    on unit tests alone.
//
//  - D-7 AT THE DOM: the interval hint and the band-limited notice are
//    covered by gallery.capture.ts's `12-bandlimited`, deliberately not
//    duplicated here.
//
// Deliberately NOT serial: every test seeds its own fixture, so there is no
// shared state to serialise for.
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}

/**
 * One TAPPABLE scoreboard half, home first (scorebug.tsx's own render order).
 *
 * Scoped to `button` deliberately, and the narrowing is load-bearing rather
 * than cosmetic: a half renders EITHER a `<button>` (tappable — live, band 3)
 * OR a plain `<div>` (everything else) at the exact same grid position. A
 * wildcard locator happily resolves and clicks the still-present pre-fold
 * `<div>`, which has no handler and dispatches nothing; scoping to `button`
 * means this locator matches NOTHING until the client's own re-render swaps
 * the element, so Playwright's normal auto-wait closes the race.
 * scorepad-v3-tennis.spec.ts's own `tennisHalf` carries the same reasoning.
 */
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}

/** One half's SCORE readout specifically. `ScorebugHalf.big` carries no data
 *  attribute, so it is addressed by the two classes only it wears
 *  (`app-display` + `font-bold`; the optional `sub` figure is
 *  `font-semibold`). A `toContainText` on the whole half would be unsafe here:
 *  badminton's scores are bare small integers and every fixture label in this
 *  file ends in a numeric TAG. */
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

async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function ralliesOf(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "badminton.rally");
}

/**
 * A rally tap, spaced past the pipeline's own double-submit guard.
 *
 * `DOUBLE_SUBMIT_WINDOW_MS` is 600ms (use-pad-pipeline.ts) and it compares the
 * whole payload — so N consecutive taps on the SAME half build an identical
 * `{wonBy, server, scorer}` every time and every one after the first is
 * silently swallowed. That is correct behaviour (it is what stops a
 * double-tapped phone recording two points), and it is exactly why a test that
 * needs eleven rallies for one side cannot simply loop. Same 700ms-shaped
 * clearance scorepad-v3-tennis.spec.ts already takes for its own repeat tap.
 */
async function tapRally(page: Page, side: "home" | "away"): Promise<void> {
  await half(page, side).click();
  await page.waitForTimeout(750);
}

/** The dock's own dismiss control (`pad.dock.dismiss` — "Send now"):
 *  detail-dock.tsx's `dismiss()` calls `releaseHeld`, an IMMEDIATE FLUSH of
 *  the soft-commit hold, never a cancel. Same helper, same reasoning as
 *  scorepad-v3-tennis.spec.ts's own. */
async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

async function openPad(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// D-17 + the interval — eleven rallies, TAPPED
// ---------------------------------------------------------------------------

test("badminton v3 singles: tapped rallies to the interval at 11, and the server is named from the second rally on", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const homeName = `V3 Bad Interval Home ${TAG}`;
  const awayName = `V3 Bad Interval Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Badminton Interval ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await openPad(page, fx);

  // BEFORE anything is scored: the BWF's first server comes from a toss this
  // kernel does not fold, so the reader answers `serveOrderKnown: false` and
  // the pad must render NOTHING. D-17's defect was an em dash printed here;
  // a different placeholder would be the same defect in a new glyph, so this
  // asserts ABSENCE, not emptiness.
  await expect(
    strip(page, "server"),
    "before the first rally nobody can say who serves — the pad must not guess, and must not print a dash",
  ).toHaveCount(0);
  // The interval, hinted ahead of itself. BWF Law 16.2's 60-second break is at
  // 11 in a game to 21 — derived from the target, not hardcoded.
  await expect(strip(page, "interval")).toContainText("11", { timeout: 20_000 });

  // Eleven rallies to home, every one TAPPED on the scoreboard half itself.
  for (let i = 0; i < 11; i++) {
    await tapRally(page, "home");
    // The optimistic fold advances on the tap (`submitHeld` folds before the
    // hold releases), so the board is assertable immediately — no waiting on
    // the 6s hold between taps.
    await expect(halfScore(page, "home")).toHaveText(String(i + 1), { timeout: 20_000 });
  }
  await expect(halfScore(page, "away"), "eleven unanswered rallies leave the opponent on nothing").toHaveText("0");

  // The interval is NOW, and the hint says so rather than still counting up
  // to it.
  await expect(strip(page, "interval"), "at 11 the strip must announce the interval, not still hint at it").toHaveText(
    "Interval",
    { timeout: 20_000 },
  );
  // BWF Law 10.1 — the rally winner serves next, so home has held serve
  // throughout and the pad names them.
  await expect(strip(page, "server")).toContainText(homeName, { timeout: 20_000 });

  // The ledger, once every hold has drained. THIS is the asymmetry no unit
  // test of a pure builder can demonstrate: the FIRST rally carries no
  // `server` at all (nobody could say), and every rally after it carries
  // home's person — because by then the ledger itself has answered the
  // question. `scorer` is stamped on all eleven: a singles side has one
  // on-field player, so there is nothing to ask and nothing to dock (R5-2).
  await expect.poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(11);
  const rows = await ralliesOf(page.request, fx.fixtureId);
  const homePersonId = fx.personIds[homeName]!;
  expect(rows.map((r) => r.payload.wonBy)).toEqual(Array.from({ length: 11 }, () => fx.homeEntrantId));
  expect(rows.map((r) => r.payload.scorer)).toEqual(Array.from({ length: 11 }, () => homePersonId));
  expect(
    rows[0]!.payload.server,
    "the match's very first rally has no derivable server — the pad must send none, not a guess",
  ).toBeUndefined();
  expect(rows.slice(1).map((r) => r.payload.server)).toEqual(Array.from({ length: 10 }, () => homePersonId));
  // `SetBasedRally.serving` (the SIDE that served) is the umpire's own
  // observation and this pad never fabricates it — filling it from the same
  // derivation the reader uses would make the engine's drift detector compare
  // a belief with itself and agree forever.
  for (const row of rows) expect(row.payload).not.toHaveProperty("serving");
});

// ---------------------------------------------------------------------------
// The serve across a game change — BWF Law 8.1, driven through the tile
// ---------------------------------------------------------------------------

test("badminton v3: banking a game through the Set score tile moves the serve to the game's winner", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const homeName = `V3 Bad Game Home ${TAG}`;
  const awayName = `V3 Bad Game Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Badminton GameChange ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await openPad(page, fx);
  await expect(scorebug(page)).toContainText("Game 1", { timeout: 20_000 });

  // The scorer's own flow: the Set score TILE, not a posted event. Two number
  // steps, one per side, each confirmed in turn.
  await v3Tile(page, "setScore").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  for (const value of ["15", "21"]) {
    const field = sheet.getByRole("spinbutton");
    await expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  }

  // Game 1 to AWAY, 15-21. The board moves on, and the games tally is a
  // DIFFERENT fact from the halves' points — D-11's whole point.
  await expect(scorebug(page), "the board must name the game it is now on").toContainText("Game 2", {
    timeout: 20_000,
  });
  await expect(strip(page, "games")).toContainText("0–1", { timeout: 20_000 });
  await expect(halfScore(page, "home"), "a new game starts at nothing, not at the last game's score").toHaveText("0");
  await expect(halfScore(page, "away")).toHaveText("0");

  // BWF Law 8.1 — the side that WON a game serves first in the next one. No
  // alternation, and no second toss. Asserted BEFORE any rally in game 2,
  // which is the only shape that isolates the rule: a rally would hand the
  // serve to its own winner under Law 10.1 and the two rules would agree by
  // construction.
  await expect(
    strip(page, "server"),
    "the winner of game 1 serves first in game 2 — Law 8.1, before any rally can confuse it",
  ).toContainText(awayName, { timeout: 20_000 });
  await expect(strip(page, "server")).not.toContainText(homeName);

  // ...and the within-game rule takes over from there: home wins the first
  // rally of game 2, so home serves the second.
  await tapRally(page, "home");
  await expect(halfScore(page, "home")).toHaveText("1", { timeout: 20_000 });
  await expect(
    strip(page, "server"),
    "Law 10.1 takes over inside the game: the rally winner serves next",
  ).toContainText(homeName, { timeout: 20_000 });

  // The tapped summary really reached the ledger with the entered score — the
  // board could be reading an optimistic local fold otherwise.
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "badminton.game.summary")?.payload, {
      timeout: 60_000,
    })
    .toMatchObject({ home: 15, away: 21 });
});

// ---------------------------------------------------------------------------
// R5-2 — the scorer dock, proved in the SUBMITTED payload
// ---------------------------------------------------------------------------

test("badminton v3 doubles: the dock's scorer chip reaches the SUBMITTED rally, not just the local copy", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const homeFirst = `V3 Bad Pair HomeA ${TAG}`;
  const homeSecond = `V3 Bad Pair HomeB ${TAG}`;
  const awayFirst = `V3 Bad Pair AwayA ${TAG}`;
  const awaySecond = `V3 Bad Pair AwayB ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Badminton Pair ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "pair",
    // `pairOrder` declared, and running the OTHER WAY from the array order —
    // a skin that quietly sorted by team-sheet order would offer the chips
    // reversed and this test would notice.
    home: [
      { fullName: homeSecond, pairOrder: 2 },
      { fullName: homeFirst, pairOrder: 1 },
    ],
    away: [
      { fullName: awaySecond, pairOrder: 2 },
      { fullName: awayFirst, pairOrder: 1 },
    ],
    emitCoreStart: true,
  });
  await openPad(page, fx);

  // A PAIR has something to choose, so the tap opens the dock instead of
  // committing complete — the exact opposite of the singles case above, and
  // ruling R5-2's whole reason for existing: dedicating `badminton.rally` to
  // the scoreboard half retires the generic form AND its attribution fields,
  // so without this question per-player badminton stats become unrecordable.
  await half(page, "home").click();
  const dock = v3Dock(page);
  await expect(dock, "a pair's rally must ask who scored it").toBeVisible({ timeout: 20_000 });
  await expect(dock).toContainText("Who won the rally?");
  // Both partners offered, first-named first.
  await expect(dock.getByRole("button", { name: homeFirst, exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: homeSecond, exact: true })).toBeVisible();
  // The LOSING pair is never offered: `wonBy` names the side that won, and the
  // scorer is one of ITS players.
  await expect(dock.getByRole("button", { name: awayFirst, exact: true })).toHaveCount(0);

  // The SECOND partner deliberately — picking the first would be satisfied by
  // an implementation that always stamped `pairOrder: 1`.
  await dock.getByRole("button", { name: homeSecond, exact: true }).click();
  // One way, and the alternative leaves: once a scorer lands the dock shows
  // only that chip, never both beside a payload that already names someone.
  await expect(
    dock.getByRole("button", { name: homeFirst, exact: true }),
    "the answered question must not still be open beside its own answer",
  ).toHaveCount(0);
  await sendHeldNow(page);

  // THE ASSERTION THIS WHOLE FILE EXISTS FOR. A pure builder whose output
  // depends on the advanced payload is fully unit-testable AND fully inert at
  // once (R3's goal dock shipped exactly that way). Only the DRAINED event
  // proves the chip's `mutate` reached the submission.
  await expect.poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(1);
  const rally = (await ralliesOf(page.request, fx.fixtureId))[0]!;
  expect(rally.payload.wonBy).toBe(fx.homeEntrantId);
  expect(
    rally.payload.scorer,
    "the dock's chip must reach the SUBMITTED rally — this is the wave's product headline",
  ).toBe(fx.personIds[homeSecond]!);
  // A pair names no SERVER person at all: BWF Law 10.5 picks the doubles
  // server by the service COURT the players are standing in, which this kernel
  // does not fold — so the pad omits the fact rather than guessing at it.
  expect(rally.payload.server, "a doubles server is not derivable, so none may be sent").toBeUndefined();

  // ...and the same omission on screen: the strip names the serving SIDE, and
  // never marks one partner with the serve pip.
  await expect(strip(page, "server"), "a pair's serve is a SIDE fact, and the strip says so").toContainText("Home", {
    timeout: 20_000,
  });
  await expect(strip(page, "server")).not.toContainText(homeFirst);
  await expect(strip(page, "server")).not.toContainText(homeSecond);
});
