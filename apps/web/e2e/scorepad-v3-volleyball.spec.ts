import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";

// ScoringPad v3, wave R5/C3 — volleyball's own conversion coverage, the LAST
// of the three racquet sports (badminton R5/C1, table tennis R5/C2 before
// it). Sibling of scorepad-v3-badminton.spec.ts and
// scorepad-v3-tabletennis.spec.ts, same shape: those files prove their own
// sport's flows; this one proves what volleyball's own conversion adds that
// no earlier browser drive of this sport ever could.
//
// What lives here, and why each one is not provable anywhere else:
//
//  - D-17 + THE SERVE ANCHOR, end to end. `setBasedServeContext` has unit
//    coverage against real folds, but volleyball is the ONE racquet sport
//    whose reader genuinely CANNOT resolve `rotation`/`serverPersonId`
//    without a declared rally somewhere (`setStart: "alternate"` — see
//    `v3/skins/volleyball.tsx`'s own header for the full engine-verified
//    reasoning). The anchor TILE + its two-step SHEET, tapped in a real
//    browser, is what proves the browser round-trip actually resolves the
//    reader — the unit suite's own job is only proving the payload shape.
//
//  - THE ROTATION NUMBER (FIVB 7.6.2), swept across BOTH sides — new
//    coverage no earlier volleyball pad (v2 or otherwise) has ever had,
//    since `racquet-skin.tsx` never named a server at all.
//
//  - A SET CLOSING BY SUMMARY LEAVES THE NEXT SET'S OPENER UNRESOLVED, and
//    the anchor tile REAPPEARS to fix it — the "alternate" rule's own
//    honest cost, proven live: closing set 1 through the Set score tile
//    alone (no rally, so no declared `firstServer`) cannot open set 2 by
//    alternation, exactly as `volleyball.tsx`'s header states and a pure
//    unit test cannot show reaching a real ledger through a real tile tap.
//
//  - THE BEACH PAIR NAMES A PERSON (FIVB 13.2), unlike indoor — and THE
//    SCORER DOCK'S DRAINED PAYLOAD (ruling R5-2), the identical proof
//    obligation the siblings both carry: a pure builder whose output
//    depends on the ADVANCED payload is fully unit-testable and fully inert
//    at the same time (R3's goal dock shipped exactly that way past five
//    green tests).
//
//  - THE LIBERO SWAP (FIVB 15.6/19.3) — the one thing NEITHER sibling has at
//    all (badminton and table tennis both declare no `swap()`): the tile,
//    the sheet, a legal exchange reaching the SUBMITTED `core.lineup.
//    replacement`, and a SECOND exchange refused in the sport's own words
//    once FIVB's one-return limit is spent — sport-worded from the machine
//    `.reason` slug, never the engine's own ID-bearing English prose.
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
 * reasoning. UNLIKE the siblings, this half's accessible name is NEVER a
 * player's — it is the SIDE label ("Home"/"Away") plus hint text
 * (`v3/skins/volleyball.tsx`'s own header), so it is addressed positionally
 * exactly the same way regardless.
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

function v3Swap(page: Page) {
  return pad(page).locator('[data-role="v3-swap"]');
}

/** A choice step's option, addressed by its STABLE `data-choice-option-id`
 *  (guided-sheet.tsx) — never by its translated label text, which would make
 *  this spec locale-fragile for no reason: the option ids here are literally
 *  `"home"`/`"away"`, not sport vocabulary. Table tennis's own
 *  `choiceOption` carries the identical reasoning for its own anchor sheet. */
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
  return (await ledger(request, fixtureId)).filter((e) => e.type === "volleyball.rally");
}

/**
 * A rally tap, spaced past the pipeline's own double-submit guard.
 * `DOUBLE_SUBMIT_WINDOW_MS` is 600ms (use-pad-pipeline.ts) and compares the
 * whole payload — so N consecutive taps on the SAME half build an identical
 * `{wonBy, server}` and every one after the first is silently swallowed.
 * Same 750ms-shaped clearance the siblings' own `tapRally` takes.
 */
async function tapRally(page: Page, side: "home" | "away"): Promise<void> {
  await half(page, side).click();
  await page.waitForTimeout(750);
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

/** A full indoor starting six, S/OH/MB/OPP/OH/MB — FIVB's own catalog shape,
 *  the identical roster `setbased/lineup.test.ts`'s own `volleyballSide`
 *  fixture uses at the engine level. */
const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
function indoorRoster(label: string) {
  return COURT.map((positionKey, i) => ({ fullName: `${label} P${i + 1} ${TAG}`, positionKey }));
}

// ---------------------------------------------------------------------------
// D-17 + the serve anchor + the rotation number, swept across both sides
// ---------------------------------------------------------------------------

test("volleyball v3 indoor: the serve anchor resolves D-17 and the rotation, ordinary taps carry it forward on BOTH sides", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(request, {
    label: `V3 Volleyball Anchor ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: indoorRoster("V3 VB Anchor Home"),
    away: indoorRoster("V3 VB Anchor Away"),
    emitCoreStart: true,
  });
  await openPad(page, fx);

  // BEFORE any declaration: side-out has nothing to self-heal from yet, so
  // the reader answers `serveOrderKnown: false` and the pad must render
  // NOTHING — D-17's own rule, never a placeholder.
  await expect(strip(page, "server"), "before any rally nobody can say who serves").toHaveCount(0);
  await expect(strip(page, "rotation")).toHaveCount(0);
  // The anchor tile is the visible affordance for exactly this state.
  await expect(v3Tile(page, "serveAnchor")).toBeVisible({ timeout: 20_000 });

  // The anchor: AWAY served, HOME won. Two independent choice steps.
  await v3Tile(page, "serveAnchor").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, "away").click();
  await expect(sheet).toContainText("Who won it?", { timeout: 20_000 });
  await choiceOption(sheet, "home").click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });

  await expect(halfScore(page, "home"), "the anchor rally is a real point").toHaveText("1", { timeout: 20_000 });
  // Indoor never names a PERSON (no serverFromPairOrder answer for a
  // six-long roster) — the strip's own honest degrade is the side label.
  await expect(strip(page, "server"), "resolved by the anchor — home is due next").toContainText("Home", {
    timeout: 20_000,
  });
  // The strip item renders LABEL and value together ("Rotation 2"), so these
  // anchor on both: a bare `toHaveText("2")` fails even when correct, and a
  // `toContainText("2")` would pass on a label that happened to carry a digit.
  await expect(strip(page, "rotation"), "FIVB 7.6.2 — home's own court-position number").toHaveText("Rotation 2", {
    timeout: 20_000,
  });
  await expect(v3Tile(page, "serveAnchor"), "resolved — the anchor tile withdraws").toHaveCount(0, {
    timeout: 20_000,
  });

  // Away wins the second rally — a PLAIN tap, no declaration needed anymore.
  await tapRally(page, "away");
  await expect(halfScore(page, "away")).toHaveText("1", { timeout: 20_000 });
  await expect(strip(page, "server")).toContainText("Away", { timeout: 20_000 });
  await expect(strip(page, "rotation"), "away's OWN rotation number, independent of home's").toHaveText("Rotation 2", {
    timeout: 20_000,
  });

  // Home wins the third rally — home's rotation has now genuinely advanced,
  // never pinned at the same value twice by accident.
  await tapRally(page, "home");
  await expect(halfScore(page, "home")).toHaveText("2", { timeout: 20_000 });
  await expect(strip(page, "server")).toContainText("Home", { timeout: 20_000 });
  await expect(strip(page, "rotation"), "home's rotation moved from 2 to 3 — a genuine increment").toHaveText("Rotation 3", {
    timeout: 20_000,
  });

  // The ledger, once every hold has drained — the SUBMITTED shape.
  await expect.poll(async () => (await ralliesOf(request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(3);
  const rows = await ralliesOf(request, fx.fixtureId);
  expect(rows.map((r) => r.payload.wonBy)).toEqual([fx.homeEntrantId, fx.awayEntrantId, fx.homeEntrantId]);
  expect(rows[0]!.payload.serving, "the anchor names who served it").toBe(fx.awayEntrantId);
  expect(rows[1]!.payload.serving, "an ordinary tap must never declare serving").toBeUndefined();
  expect(rows[2]!.payload.serving).toBeUndefined();
  // Indoor never stamps `server` (a PERSON) on any rally — no pairOrder
  // answer exists for a six-long roster, on either side, ever.
  for (const row of rows) expect(row.payload).not.toHaveProperty("server");
});

// ---------------------------------------------------------------------------
// A set closed by SUMMARY alone leaves the next set's opener unresolved —
// the "alternate" rule's own honest cost, and the anchor's own re-offer
// ---------------------------------------------------------------------------

test("volleyball v3: banking a set through the Set score tile alone does NOT resolve the next set's server — the anchor tile reappears to fix it", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(request, {
    label: `V3 Volleyball SetClose ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: indoorRoster("V3 VB Close Home"),
    away: indoorRoster("V3 VB Close Away"),
    emitCoreStart: true,
  });
  await openPad(page, fx);
  await expect(scorebug(page)).toContainText("Set 1", { timeout: 20_000 });

  // The scorer's own flow: the Set score TILE, not a posted event — banks
  // set 1 with NO rally ever tapped, so no `serving` was ever declared.
  await v3Tile(page, "setScore").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  for (const value of ["20", "25"]) {
    const field = sheet.getByRole("spinbutton");
    await expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  }

  // Set 1 to AWAY, 20-25. The board moves on — D-11's own "stated once,
  // never twice" proof, the identical assertion the siblings' own game-
  // change tests make.
  await expect(scorebug(page), "the pad must name the set it is now on").toContainText("Set 2", { timeout: 20_000 });
  await expect(strip(page, "games")).toContainText("0–1", { timeout: 20_000 });
  await expect(halfScore(page, "home"), "a new set starts at nothing").toHaveText("0");
  await expect(halfScore(page, "away")).toHaveText("0");

  // THE HONEST COST: `setStart: "alternate"` reads the CLOSED set's own
  // FIRST SERVER, which a summary-only close never declared — so unlike
  // badminton's `set-winner` rule (which reads the set's SCORE, always
  // derivable), this set opens UNRESOLVED, not confidently wrong.
  await expect(strip(page, "server"), "no rally in set 1 ever declared who served it").toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(
    v3Tile(page, "serveAnchor"),
    "the anchor tile reoffers itself — set 2 is exactly as unresolved as a fresh match was",
  ).toBeVisible({ timeout: 20_000 });

  // Declare it now: home served, away won.
  await v3Tile(page, "serveAnchor").click();
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, "home").click();
  await choiceOption(sheet, "away").click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });
  await expect(strip(page, "server")).toContainText("Away", { timeout: 20_000 });
  await expect(v3Tile(page, "serveAnchor")).toHaveCount(0, { timeout: 20_000 });

  await expect
    .poll(async () => (await ledger(request, fx.fixtureId)).find((e) => e.type === "volleyball.set.summary")?.payload, {
      timeout: 60_000,
    })
    .toMatchObject({ home: 20, away: 25 });
});

// ---------------------------------------------------------------------------
// FIVB 13.2 — the beach pair names a PERSON, once anchored.
// R5-2 — the scorer dock, proved in the SUBMITTED payload.
// ---------------------------------------------------------------------------

test("volleyball v3 beach pair: the server is a named PERSON once anchored, no rotation number, and the dock's chip reaches the SUBMITTED rally", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const homeFirst = `V3 VB Pair HomeA ${TAG}`;
  const homeSecond = `V3 VB Pair HomeB ${TAG}`;
  const awayFirst = `V3 VB Pair AwayA ${TAG}`;
  const awaySecond = `V3 VB Pair AwayB ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `V3 Volleyball Pair ${TAG}`,
    sportKey: "volleyball",
    variantKey: "beach",
    entrantKind: "pair",
    // `pairOrder` declared, and running the OTHER WAY from the array order —
    // a skin that quietly sorted by team-sheet order would name the wrong
    // player as due to serve, and this test would notice.
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

  // The anchor: home served, away won. Under `within: "rally-winner"` the
  // WINNER serves next, so it is AWAY's own service order (pairOrder 1 first)
  // that the strip reads from here — not home's. An earlier draft of this
  // test asserted home's, which is the one thing side-out guarantees it is
  // not; it was committed without ever being run.
  await v3Tile(page, "serveAnchor").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await choiceOption(sheet, "home").click();
  await choiceOption(sheet, "away").click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });

  // UNLIKE indoor (which can only ever name a SIDE), a beach pair's own
  // declared order names a PERSON — FIVB 13.2.
  await expect(
    strip(page, "server"),
    "FIVB 13.2 — the pad names the SERVER, not merely the side",
  ).toContainText(awayFirst, { timeout: 20_000 });
  // `pairOrder` runs the OTHER WAY from the array order in this fixture, so
  // naming the second-listed player is what proves the skin read the declared
  // order rather than the team sheet's.
  await expect(strip(page, "server")).not.toContainText(awaySecond);
  // And no six-position rotation for a 2-player side, ever.
  await expect(strip(page, "rotation")).toHaveCount(0);

  // A pair has something to choose, so the away half's own next tap opens
  // the dock instead of committing complete — R5-2's whole reason for
  // existing, and true on EVERY volleyball side, never only a doubles case.
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

  await expect.poll(async () => (await ralliesOf(request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(2);
  const rows = await ralliesOf(request, fx.fixtureId);
  const rally2 = rows[1]!;
  expect(rally2.payload.wonBy).toBe(fx.awayEntrantId);
  expect(
    rally2.payload.scorer,
    "the dock's chip must reach the SUBMITTED rally — R5-2's product headline",
  ).toBe(fx.personIds[awaySecond]!);
  // The server person too: this rally was served by AWAY's pairOrder-1 player
  // (the strip proved it above; this proves the wire payload agrees).
  expect(rally2.payload.server).toBe(fx.personIds[awayFirst]!);
});

// ---------------------------------------------------------------------------
// FIVB 15.6/19.3 — the libero swap, and its own refusal in the sport's words
// ---------------------------------------------------------------------------

test("volleyball v3: the libero swap surfaces via the Swap-sheet, and a libero return is UNLIMITED (FIVB 19.3.2.1) rather than capped like a substitution", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const middleBlocker = `V3 VB Libero MB1 ${TAG}`;
  const libero = `V3 VB Libero Sub ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `V3 Volleyball Libero ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: [
      { fullName: `V3 VB Libero S ${TAG}`, positionKey: "S" },
      { fullName: `V3 VB Libero OH1 ${TAG}`, positionKey: "OH" },
      { fullName: middleBlocker, positionKey: "MB" },
      { fullName: `V3 VB Libero OPP ${TAG}`, positionKey: "OPP" },
      { fullName: `V3 VB Libero OH2 ${TAG}`, positionKey: "OH" },
      { fullName: `V3 VB Libero MB2 ${TAG}`, positionKey: "MB" },
      // FIVB 19.1 — the libero is DESIGNATED on the match roster, before the
      // match; a replacement cannot invent one (`core/lineup.ts`'s `bringOn`
      // carries `onField`/`timesOn`/`positionKey` onto an existing member but
      // never `slot.roles`). An earlier draft declared no roles here and tried
      // to name the libero through the replacement below: the role was
      // silently dropped, `liberoNamed` stayed false, and the tile this test
      // is about never rendered at all.
      { fullName: libero, slot: "bench", roles: ["libero"] },
      { fullName: `V3 VB Libero Bench2 ${TAG}`, slot: "bench" },
    ],
    away: indoorRoster("V3 VB Libero Away"),
    emitCoreStart: true,
  });
  const middleBlockerId = fx.personIds[middleBlocker]!;
  const liberoId = fx.personIds[libero]!;

  // The libero is on the SHEET but not yet on court. Her first exchange is
  // established directly — the FIVB scoresheet's own act of bringing her on,
  // not a UI this test is proving. The UI proof below is the SECOND exchange
  // and the refused THIRD one.
  await postEvent(page.request, fx.fixtureId, "core.lineup.replacement", {
    side: fx.homeEntrantId,
    off: middleBlockerId,
    on: { personId: liberoId, positionKey: "MB", slot: "starting", orderNo: 7, roles: ["libero"] },
    exemption: "libero",
  });
  await openPad(page, fx);

  await expect(v3Tile(page, "libero-home"), "a libero is now on court for home").toBeVisible({ timeout: 20_000 });
  const swap = v3Swap(page);
  await v3Tile(page, "libero-home").click();
  await expect(swap).toBeVisible({ timeout: 10_000 });

  // OFF: the libero, currently on court. ON: the original middle blocker,
  // her FIRST return — legal, not blocked.
  await swap.locator(`[data-candidate-id="${liberoId}"]`).click();
  await expect(swap.locator(`[data-candidate-id="${middleBlockerId}"]`)).not.toHaveAttribute("data-blocked", "true");
  await swap.locator(`[data-candidate-id="${middleBlockerId}"]`).click();
  await expect(swap).toHaveCount(0, { timeout: 20_000 });

  await expect
    .poll(
      async () =>
        (await ledger(request, fx.fixtureId)).filter((e) => e.type === "core.lineup.replacement").length,
      { timeout: 20_000 },
    )
    .toBe(2);
  const secondExchange = (await ledger(request, fx.fixtureId)).filter((e) => e.type === "core.lineup.replacement")[1]!;
  expect(secondExchange.payload).toMatchObject({
    side: fx.homeEntrantId,
    off: liberoId,
    on: { personId: middleBlockerId, positionKey: "MB" },
    exemption: "libero",
  });

  // Send the libero on AGAIN — legal (her own first return).
  await v3Tile(page, "libero-home").click();
  await expect(swap).toBeVisible({ timeout: 10_000 });
  await swap.locator(`[data-candidate-id="${middleBlockerId}"]`).click();
  await swap.locator(`[data-candidate-id="${liberoId}"]`).click();
  await expect(swap).toHaveCount(0, { timeout: 20_000 });

  // NOW the middle blocker's SECOND return. This block used to assert it was
  // REFUSED, on the reading that FIVB 15.6's one-return cap governs here. It
  // does not: a libero replacement is not a substitution (FIVB 19.3.2.1), so
  // libero exchanges are UNLIMITED and this player may come and go as often
  // as the libero does. `core/lineup.ts`'s `bringOn` skips both count
  // refusals for the `on` half of a replacement naming a declared exemption,
  // and this is the assertion that holds the pad to the same rule — the old
  // one held it to the opposite.
  await v3Tile(page, "libero-home").click();
  await expect(swap).toBeVisible({ timeout: 10_000 });
  await swap.locator(`[data-candidate-id="${liberoId}"]`).click();
  const returning = swap.locator(`[data-candidate-id="${middleBlockerId}"]`);
  await expect(returning, "a second libero return stays offered, never blocked").toBeVisible({
    timeout: 20_000,
  });
  await expect(returning).not.toHaveAttribute("data-blocked", "true");
  await expect(returning).toBeEnabled();
  await returning.click();
  await expect(swap).toHaveCount(0, { timeout: 20_000 });

  // FOUR exchanges: the seeded one plus three tapped. A cap surviving
  // anywhere on this path — engine or skin — stops the ledger at three, and
  // every assertion above it still passes.
  await expect
    .poll(
      async () =>
        (await ledger(request, fx.fixtureId)).filter((e) => e.type === "core.lineup.replacement").length,
      { timeout: 20_000 },
    )
    .toBe(4);
  const fourthExchange = (await ledger(request, fx.fixtureId)).filter(
    (e) => e.type === "core.lineup.replacement",
  )[3]!;
  expect(fourthExchange.payload).toMatchObject({
    side: fx.homeEntrantId,
    off: liberoId,
    on: { personId: middleBlockerId, positionKey: "MB" },
    exemption: "libero",
  });
});

/**
 * The blocked-and-reasoned path, which the test above no longer covers now
 * that FIVB 19.3.2.1 removed the cap it used to trip. R2b's binding ruling —
 * a refused candidate stays VISIBLE, disabled, with the reason beside the
 * name — still needs a live case, and there is exactly one a scorer can
 * actually reach: an ordinary player offered when no libero is on court to
 * come off. Before the engine grew its `requiresRole` bound (review of PR
 * #678) that pair was ACCEPTED, laundering an ordinary re-entry through the
 * exemption channel and past FIVB 15.6 entirely.
 */
test("volleyball v3: with no libero on court, an ordinary player is offered BLOCKED and reasoned, never laundered through the exemption", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const setter = `V3 VB NoLib S ${TAG}`;
  const middleBlocker = `V3 VB NoLib MB1 ${TAG}`;
  const libero = `V3 VB NoLib Lib ${TAG}`;
  const bench = `V3 VB NoLib Bench ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `V3 Volleyball NoLibero ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: [
      { fullName: setter, positionKey: "S" },
      { fullName: `V3 VB NoLib OH1 ${TAG}`, positionKey: "OH" },
      { fullName: middleBlocker, positionKey: "MB" },
      { fullName: `V3 VB NoLib OPP ${TAG}`, positionKey: "OPP" },
      { fullName: `V3 VB NoLib OH2 ${TAG}`, positionKey: "OH" },
      { fullName: `V3 VB NoLib MB2 ${TAG}`, positionKey: "MB" },
      // NAMED but never brought on. `liberoNamed` reads the WHOLE squad, so
      // the tile renders while the court itself holds no libero — which is
      // the whole state under test.
      { fullName: libero, slot: "bench", roles: ["libero"] },
      { fullName: bench, slot: "bench" },
    ],
    away: indoorRoster("V3 VB NoLib Away"),
    emitCoreStart: true,
  });
  const setterId = fx.personIds[setter]!;
  const middleBlockerId = fx.personIds[middleBlocker]!;
  const liberoId = fx.personIds[libero]!;
  const benchId = fx.personIds[bench]!;

  // An ORDINARY substitution, charged to FIVB 15.6's own cap: the middle
  // blocker leaves the court the normal way. `core.lineup.substitution` is a
  // different event from the `core.lineup.replacement` the libero sheet
  // builds — the latter REQUIRES an `exemption` and so can never express an
  // ordinary swap. That is what gives her `timesOff > 0` and puts her on the
  // libero sheet's ON list at all; the libero herself has still never come on.
  await postEvent(page.request, fx.fixtureId, "core.lineup.substitution", {
    side: fx.homeEntrantId,
    off: middleBlockerId,
    on: { personId: benchId, positionKey: "MB", slot: "starting", orderNo: 7 },
  });
  await openPad(page, fx);

  const swap = v3Swap(page);
  await v3Tile(page, "libero-home").click();
  await expect(swap).toBeVisible({ timeout: 10_000 });
  // OFF: an on-court player who is not a libero — because none is on court.
  // Whoever is named here, no ON pick could be the return leg of a libero
  // exchange, which is precisely what the block below reports.
  await swap.locator(`[data-candidate-id="${setterId}"]`).click();

  const blockedCandidate = swap.locator(`[data-candidate-id="${middleBlockerId}"]`);
  await expect(blockedCandidate, "the refused candidate stays visible, never removed").toBeVisible({
    timeout: 20_000,
  });
  await expect(blockedCandidate).toHaveAttribute("data-blocked", "true");
  await expect(
    blockedCandidate,
    "sport-worded from the machine .reason slug — never the engine's own raw English/ID-bearing message",
  ).toContainText("Not a libero exchange");
  await expect(blockedCandidate, "never the raw personId in the visible copy").not.toContainText(middleBlockerId);
  await expect(blockedCandidate).toBeDisabled();

  // The libero IS a legal pick in this same state, and is offered unblocked.
  // Without this line the test would also pass against a sheet that refused
  // every candidate for any reason at all.
  await expect(
    swap.locator(`[data-candidate-id="${liberoId}"]`),
    "the one pick that IS a libero exchange stays offered",
  ).not.toHaveAttribute("data-blocked", "true");

  // No libero exchange ever reached the ledger — the refusal held at the
  // sheet, and the only lineup event on file is the ordinary substitution
  // this test seeded.
  const lineupEvents = (await ledger(request, fx.fixtureId)).filter((e) => e.type.startsWith("core.lineup."));
  expect(lineupEvents.filter((e) => e.type === "core.lineup.replacement").length).toBe(0);
  expect(lineupEvents.length).toBe(1);
});

/** Dispatch a real ledger event directly, reading `last_seq` fresh each
 *  call. Used for SETUP only — the one action each test is actually about
 *  always goes through the real pad. Same helper, same posture as
 *  scorepad-v3-football.spec.ts's own. */
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
