import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";

// ScoringPad v3, wave R5/C2 — table tennis's own conversion coverage,
// D-13's first-ever browser drive (`scoring.spec.ts`'s two v2 tests and
// `gallery.capture.ts`'s racquet-serving state are the ONLY prior coverage
// this sport has ever had, and both drove `racquet-skin.tsx`). Sibling of
// `scorepad-v3-badminton.spec.ts`, same shape — that file proves badminton's
// old flows still work; this one proves what v3 does that no earlier table
// tennis pad could, AND the one thing table tennis needs that badminton
// never did: a declared serve anchor.
//
// TABLE TENNIS'S ROTATION DOES NOT SELF-HEAL. `serve.within: "fixed-turns"`
// (ITTF 2.13.3) is a pure function of the SCORE once the set's first server
// is known, and unlike badminton's side-out rotation it is NEVER updated by
// an individual rally's own winner — so `setBasedServeContext` answers
// `serveOrderKnown: false` FOREVER on this sport until something declares
// who served one rally. `SERVE_ANCHOR_TILE_ID` is that declaration; this
// file is what proves the browser round-trip actually resolves the reader
// once it lands, not merely that the sheet's `buildPayload` is shaped right
// (the unit suite's own job).
//
// What lives here, and why each one is not provable anywhere else:
//
//  - D-17 + D-13, END TO END. The anchor sheet, tapped in a real browser,
//    resolving the strip's server AND serve-number fields, walked past a
//    turn (turnLength: 2) boundary — the exact rotation this sport alone
//    among the three R5 racquet sports has to say out loud.
//
//  - ITTF 2.13.4's DOUBLES SERVER, a PERSON — unlike badminton (which never
//    names one at all), and unlike this sport's own singles case (a name
//    the pad already had to prove for badminton). The pairOrder-based
//    identity is new coverage.
//
//  - THE SCORER DOCK'S DRAINED PAYLOAD (ruling R5-2), badminton's own proof
//    obligation repeated here: a pure builder whose output depends on the
//    ADVANCED payload is fully unit-testable and fully inert at the same
//    time (R3's goal dock shipped exactly that way past five green tests).
//
//  - THE EXPEDITE PATH (ITTF 2.15), unique to this sport among the three:
//    starting it, the strip announcing it, and the dock's 13th-return chip
//    reaching the SUBMITTED rally — table tennis's own recovery for the
//    padSpec action FP-2 warned a naive tap-model-S conversion would
//    silently retire.
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
 * One TAPPABLE scoreboard half, home first (scorebug.tsx's own render
 * order). Scoped to `button` deliberately — a half renders EITHER a
 * `<button>` (tappable — live, band 3) OR a plain `<div>` (everything else)
 * at the exact same grid position, and a wildcard locator happily resolves
 * the still-present pre-fold `<div>`, which dispatches nothing.
 * `scorepad-v3-badminton.spec.ts`'s own `half` carries the identical
 * reasoning.
 */
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}

/** One half's SCORE readout specifically — `ScorebugHalf.big` carries no
 *  data attribute, so it is addressed by the two classes only it wears. */
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

/** A choice step's option, addressed by its STABLE `data-choice-option-id`
 *  (guided-sheet.tsx) — never by its translated label text, which would
 *  make this spec locale-fragile for no reason: the option ids here are
 *  literally `"home"`/`"away"`, not sport vocabulary. */
function choiceOption(sheet: ReturnType<typeof v3Sheet>, optionId: "home" | "away") {
  return sheet.locator(`[data-choice-option-id="${optionId}"]`);
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
  return (await ledger(request, fixtureId)).filter((e) => e.type === "tabletennis.rally");
}

/**
 * A rally tap.
 *
 * R7-42/R7-30/R7-43 (owner ruling, `_INDEX.md`) — this used to pay a flat
 * 750ms clearance after EVERY tap so N consecutive taps on the SAME half
 * (an identical `{wonBy, server, scorer}` every time) would not collide with
 * `DOUBLE_SUBMIT_WINDOW_MS`. The window is now 250ms (was 600ms), so the
 * clearance is gone — `scorepad-v3-badminton.spec.ts`'s own `tapRally` took
 * the identical fix.
 */
async function tapRally(page: Page, side: "home" | "away"): Promise<void> {
  await half(page, side).click();
}

/** The dock's own dismiss control (`pad.dock.dismiss` — "Send now"):
 *  detail-dock.tsx's `dismiss()` calls `releaseHeld`, an IMMEDIATE FLUSH of
 *  the soft-commit hold, never a cancel. */
async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

async function openPad(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// D-17 + D-13 — the serve anchor, then the within-turn rotation, TAPPED
// ---------------------------------------------------------------------------

test("table tennis v3 singles: the serve anchor resolves D-17, then the turnLength:2 rotation is tapped past its boundary", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const homeName = `V3 TT Anchor Home ${TAG}`;
  const awayName = `V3 TT Anchor Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 TableTennis Anchor ${TAG}`,
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await openPad(page, fx);

  // BEFORE any declaration: `fixed-turns` never self-heals the way
  // badminton's side-out rotation does, so this must still render NOTHING —
  // no server, no serve-number — even though this is turn 0, where every
  // derivation this program has ever shipped (right or wrong) tends to agree
  // by accident (R4's D-21 lesson).
  await expect(strip(page, "server"), "undeclared — the pad must not guess").toHaveCount(0);
  await expect(strip(page, "serve")).toHaveCount(0);
  // The anchor tile is the visible affordance for exactly this state.
  await expect(v3Tile(page, "serveAnchor")).toBeVisible({ timeout: 20_000 });

  // The anchor: AWAY served, HOME won the rally. Two independent choice
  // steps — serving first, winner second — dispatching ONE real rally.
  await v3Tile(page, "serveAnchor").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, "away").click();
  await expect(sheet).toContainText("Who won it?", { timeout: 20_000 });
  await choiceOption(sheet, "home").click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });

  await expect(halfScore(page, "home"), "the anchor rally is a real point").toHaveText("1", { timeout: 20_000 });
  // Away served the anchor; turnLength is 2, so away serves the SECOND point
  // of their own turn next — the anchor tile must also be gone now that the
  // reader can answer.
  await expect(strip(page, "server"), "away served the anchor and turnLength is 2").toContainText(awayName, {
    timeout: 20_000,
  });
  await expect(strip(page, "serve")).toHaveText("2nd serve", { timeout: 20_000 });
  await expect(v3Tile(page, "serveAnchor"), "resolved — the anchor tile withdraws").toHaveCount(0, { timeout: 20_000 });

  // Away wins the second rally too — a PLAIN tap, no declaration. The turn
  // flips: home's turn now, their first serve.
  await tapRally(page, "away");
  await expect(halfScore(page, "away")).toHaveText("1", { timeout: 20_000 });
  await expect(strip(page, "server"), "turn flips at the 2-point boundary").toContainText(homeName, { timeout: 20_000 });
  await expect(strip(page, "serve")).toHaveText("1st serve", { timeout: 20_000 });

  // Home wins the third rally — still home's turn, their second serve.
  await tapRally(page, "home");
  await expect(halfScore(page, "home")).toHaveText("2", { timeout: 20_000 });
  await expect(strip(page, "server")).toContainText(homeName, { timeout: 20_000 });
  await expect(strip(page, "serve")).toHaveText("2nd serve", { timeout: 20_000 });

  // The ledger, once every hold has drained — the SUBMITTED shape, not an
  // optimistic local one. The anchor rally alone carries `serving`; the two
  // ordinary taps after it carry neither `serving` (never re-declared) —
  // this is the drift-detector-preserving omission the skin's own header
  // documents.
  await expect.poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(3);
  const rows = await ralliesOf(page.request, fx.fixtureId);
  expect(rows.map((r) => r.payload.wonBy)).toEqual([fx.homeEntrantId, fx.awayEntrantId, fx.homeEntrantId]);
  expect(rows[0]!.payload.serving, "the anchor names who served it").toBe(fx.awayEntrantId);
  expect(rows[1]!.payload.serving, "an ordinary tap must never declare serving").toBeUndefined();
  expect(rows[2]!.payload.serving).toBeUndefined();
  const homePersonId = fx.personIds[homeName]!;
  const awayPersonId = fx.personIds[awayName]!;
  // `server` (the PERSON stat field) is safe to stamp on every tap
  // regardless of side, and does so throughout: away served the anchor, so
  // `server` is away's sole player on ALL THREE rows (rows 2 and 3 are the
  // same server as row 1's declaration, since the turn only flips to home
  // between rows 2 and 3's SERVE, not their attribution — the strip proved
  // that walk above; this proves the wire payload agrees with it).
  expect(rows.map((r) => r.payload.scorer)).toEqual([homePersonId, awayPersonId, homePersonId]);
});

// ---------------------------------------------------------------------------
// ITTF 2.13.4 — the doubles server is a NAMED PERSON, unlike badminton.
// R5-2 — the scorer dock's drained payload, proved in the browser.
// ---------------------------------------------------------------------------

test("table tennis v3 doubles: the server is a named PERSON (ITTF 2.13.4), and the scorer dock's chip reaches the SUBMITTED rally", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const homeFirst = `V3 TT Pair HomeA ${TAG}`;
  const homeSecond = `V3 TT Pair HomeB ${TAG}`;
  const awayFirst = `V3 TT Pair AwayA ${TAG}`;
  const awaySecond = `V3 TT Pair AwayB ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 TableTennis Pair ${TAG}`,
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "pair",
    // `pairOrder` declared, and running the OTHER WAY from the array order —
    // a skin that quietly sorted by team-sheet order would offer the chips
    // (and name the server) reversed, and this test would notice.
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

  // The anchor: home served, away won. The anchor rally's OWN payload names
  // no server PERSON — nobody can say WHICH of the pair served the very
  // declaration that establishes the rotation (`serveAnchorSheet`'s own
  // doubles-omits-attribution rule, unit-tested directly) — but it DOES
  // establish `firstServer: home`, which is what the NEXT rally's own
  // `serverFromPairOrder` answer is computed from.
  await v3Tile(page, "serveAnchor").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, "home").click();
  await choiceOption(sheet, "away").click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });

  // UNLIKE badminton (which can only ever name a SIDE for a pair — BWF Law
  // 10.5 reads the service court, a fact this kernel does not fold), the
  // ITTF's own doubles service order names a PERSON. The anchor was home's
  // own FIRST rally as server (turnLength:2 — the SAME turn's second serve
  // still belongs to home, and `expectedPairServer`'s own `order[turn %
  // order.length]` reads home's 0th turn as pairOrder-1): homeFirst.
  await expect(strip(page, "server"), "ITTF 2.13.4 — the pad names the SERVER, not merely the side").toContainText(
    homeFirst,
    { timeout: 20_000 },
  );
  await expect(strip(page, "server")).not.toContainText(homeSecond);

  // A pair has something to choose, so the away half's own next tap opens
  // the dock instead of committing complete — R5-2's whole reason for
  // existing.
  const awayHalf = half(page, "away");
  await awayHalf.click();
  const dock = v3Dock(page);
  await expect(dock, "a pair's rally must ask who scored it").toBeVisible({ timeout: 20_000 });
  await expect(dock).toContainText("Which player won it?");
  await expect(dock.getByRole("button", { name: awayFirst, exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: awaySecond, exact: true })).toBeVisible();
  // The LOSING pair (home) is never offered.
  await expect(dock.getByRole("button", { name: homeFirst, exact: true })).toHaveCount(0);

  // The SECOND partner deliberately — picking the first would be satisfied
  // by an implementation that always stamped `pairOrder: 1`.
  await dock.getByRole("button", { name: awaySecond, exact: true }).click();
  await expect(
    dock.getByRole("button", { name: awayFirst, exact: true }),
    "the answered question must not still be open beside its own answer",
  ).toHaveCount(0);
  await sendHeldNow(page);

  await expect.poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(2);
  const rows = await ralliesOf(page.request, fx.fixtureId);
  const rally2 = rows[1]!;
  expect(rally2.payload.wonBy).toBe(fx.awayEntrantId);
  expect(
    rally2.payload.scorer,
    "the dock's chip must reach the SUBMITTED rally — R5-2's product headline",
  ).toBe(fx.personIds[awaySecond]!);
  // The server person too: this rally's own `server` is home's pairOrder-1
  // player (the strip proved it above; this proves the wire payload agrees).
  expect(rally2.payload.server).toBe(fx.personIds[homeFirst]!);
});

// ---------------------------------------------------------------------------
// ITTF Law 2.15 — the expedite path
// ---------------------------------------------------------------------------

test("table tennis v3: starting expedite announces it on the strip, and the dock's 13th-return chip reaches the SUBMITTED rally", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const homeName = `V3 TT Expedite Home ${TAG}`;
  const awayName = `V3 TT Expedite Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 TableTennis Expedite ${TAG}`,
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });
  await openPad(page, fx);

  await expect(strip(page, "expedite")).toHaveCount(0);
  await expect(v3Tile(page, "expediteStart")).toBeVisible({ timeout: 20_000 });
  await v3Tile(page, "expediteStart").click();

  await expect(strip(page, "expedite"), "ITTF 2.15.1 — the umpire's own introduction of expedite").toContainText(
    "Expedite",
    { timeout: 20_000 },
  );
  // 2.15.4 runs it to the end of the match — the tile that started it
  // withdraws rather than offering a second, refused declaration.
  await expect(v3Tile(page, "expediteStart"), "already in force — the tile withdraws").toHaveCount(0, {
    timeout: 20_000,
  });

  // A singles rally auto-stamps its scorer, so the dock's FIRST question is
  // this sport's own expedite recovery — the padSpec action FP-2 warned a
  // naive conversion would silently retire.
  await half(page, "home").click();
  const dock = v3Dock(page);
  await expect(dock, "expedite in force — the dock offers the 13th-return flag").toBeVisible({ timeout: 20_000 });
  await expect(dock).toContainText("13th return");
  await dock.getByRole("button", { name: "13th return", exact: true }).click();
  await sendHeldNow(page);

  await expect.poll(async () => (await ralliesOf(page.request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(1);
  const rally = (await ralliesOf(page.request, fx.fixtureId))[0]!;
  expect(rally.payload.wonBy).toBe(fx.homeEntrantId);
  expect(
    rally.payload.returns,
    "the dock's chip must reach the SUBMITTED rally, at the exact ITTF 2.15.2 threshold",
  ).toBe(13);
  // Never `serving` — the chip's own doc reason: re-deriving the pre-tap
  // serving side this late risks crediting the WRONG winner
  // (EXPEDITE_WRONG_WINNER).
  expect(rally.payload).not.toHaveProperty("serving");
});
