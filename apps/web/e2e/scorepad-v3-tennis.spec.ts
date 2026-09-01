import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";

// ScoringPad v3, wave R4/task G — the coverage tennis's conversion OWES
// beyond re-pointing the pre-existing skin/cutover tests at the v3 DOM
// (scorepad-skins.spec.ts, v6-sports.spec.ts). Sibling of
// scorepad-v3-cricket.spec.ts / scorepad-v3-football.spec.ts, same shape and
// the same reasoning: those files prove the sport's old flows still work,
// this file proves the things v3 does that no earlier pad could.
//
// Tennis is the FIRST tapModel-S sport: the scoreboard halves ARE the point
// buttons (`ScorebugHalf.tappable`/`tapEvent`, v3/skins/tennis.tsx), so
// there is no `data-tile-id` for a point the way every other sport's tiles
// carry one — every test below addresses a half positionally
// (`tennisHalf`), never by accessible name (a tappable half's name is the
// PLAYER'S name plus hint text, not a fixed string).
//
// What lives here and why each one is not provable anywhere else:
//
//  - DEUCE/ADVANTAGE ALTERNATION, driven by real taps on the half itself —
//    the wave's own worked example of tap model S actually scoring a match.
//  - THE POINT DOCK'S LEGALITY-BY-SIDE (ace only for the server, double
//    fault only for the receiver) and its DRAINED payload. R3's goal dock
//    shipped its own two-step narrowing inert past five green unit tests
//    and a gallery screenshot, because a pure builder whose output depends
//    on live state is fully unit-testable and fully inert at once — only a
//    browser proves a dock chip's `mutate` reached the SUBMITTED event
//    rather than a local copy of it (tennis.tsx's own `buildDock` header
//    names this incident by name). Singles auto-stamps `scorer` at TAP time
//    (R4-5); doubles asks a SECOND dock question for it — both need their
//    own proof.
//  - THE DOUBLES SERVE PIP against a KNOWN, declared `pairOrder`, never
//    "whichever name got marked" (`_INDEX.md`'s own standing warning: an
//    undeclared pair order makes `expectedDoublesServer` answer null and
//    the assertion vacuous).
//  - D-16 (the Set-score tile's dead-end-tap fix), proved at the DOM: the
//    tile withheld mid-set, not offered a second time via the generic More
//    sheet, and restored once the point is undone.
//
// Deliberately NOT serial: every test seeds its own fixture, so there is no
// shared state to serialise for.
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/**
 * v3 tapModel S: tennis's scoreboard halves ARE the point buttons — there
 * is no `data-tile-id="point-<side>"` the way every tile-based action
 * carries one, and a tappable half's accessible name is the PLAYER's own
 * name plus hint text (`whoNames`, scorebug.tsx), not a fixed string this
 * file could match on. Indexes the halves grid positionally, home first
 * (scorebug.tsx's own render order) — the same locator shape
 * scorepad-skins.spec.ts's `scorebugHalf` and gallery.capture.ts's
 * `tennisHalf` use, narrowed here to the `<button>` tag specifically.
 *
 * That narrowing is load-bearing, not cosmetic (found by running this file):
 * `openLiveConsole` only waits for the SERVER's ledger to carry `core.start`
 * (`waitForLedgerGrowth`-style poll) — it says nothing about whether the
 * CLIENT has re-rendered from that fold yet. A half renders EITHER a
 * `<button>` (tappable — live, band>=3) OR a plain `<div>` (everything
 * else) at the exact same grid position, so unlike a tile — which does not
 * exist in the DOM at all until its phase/band gate opens, and so makes
 * Playwright's own actionability wait "self-heal" the race — a wildcard
 * locator here happily resolves to and clicks the STILL-PRESENT pre-fold
 * `<div>`, which has no click handler and dispatches nothing. Scoping to
 * `button` restores the self-healing property: this locator matches
 * NOTHING until the client's own re-render swaps the `<div>` for a
 * `<button>`, so `.click()`'s normal auto-wait is what closes the race,
 * exactly the way a tile's own absence-until-ready already does elsewhere.
 */
function tennisHalf(page: Page, side: "home" | "away") {
  return pad(page).locator('[data-role="v3-scorebug"] .grid > button').nth(side === "home" ? 0 : 1);
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

async function countOf(request: APIRequestContext, fixtureId: string, type: string): Promise<number> {
  return (await ledger(request, fixtureId)).filter((e) => e.type === type).length;
}

/** Open the console and take the fixture live through the console's own
 *  "Start match" control — the real organiser flow. Same helper, same
 *  reasoning as scorepad-v3-football.spec.ts's own. */
async function openLiveConsole(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

/** The dock's own dismiss control (`pad.dock.dismiss` — "Send now"):
 *  detail-dock.tsx's `dismiss()` calls `releaseHeld`, an IMMEDIATE FLUSH of
 *  the soft-commit hold, never a cancel. Same helper, same reasoning as
 *  scorepad-v3-football.spec.ts's own. */
async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

// ---------------------------------------------------------------------------
// Singles scoring — deuce, and advantage alternating BOTH ways
// ---------------------------------------------------------------------------

test("tennis v3 singles: deuce, advantage alternates both ways, scored by tapping the scoreboard half itself", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Tennis Deuce ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: `V3 Tennis Deuce Home ${TAG}` }],
    away: [{ fullName: `V3 Tennis Deuce Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  const homeHalf = tennisHalf(page, "home");
  const awayHalf = tennisHalf(page, "away");
  await expect(homeHalf).toBeVisible();

  const pointCount = () => countOf(page.request, fx.fixtureId, "tennis.point");

  // 3 each, alternating — never two of the same side in a row here, which
  // matters for `usePadPipeline`'s own double-submit guard.
  for (let i = 0; i < 3; i++) {
    await homeHalf.click();
    await awayHalf.click();
  }
  await expect.poll(pointCount, { timeout: 20_000 }).toBe(6);
  await expect(homeHalf, "6 points in, 3 apiece, is deuce").toContainText("40");
  await expect(awayHalf).toContainText("40");

  await homeHalf.click(); // 7th: home takes advantage
  await expect.poll(pointCount, { timeout: 20_000 }).toBe(7);
  await expect(homeHalf).toContainText("AD");
  await expect(awayHalf).toContainText("40");

  await awayHalf.click(); // 8th: away cancels it — back to deuce
  await expect.poll(pointCount, { timeout: 20_000 }).toBe(8);
  await expect(homeHalf, "the away point must cancel home's advantage, not stack past it").toContainText("40");
  await expect(awayHalf).toContainText("40");

  // The 9th tap is AWAY again (8th and 9th are both away). R7-42/R7-30/
  // R7-43 (owner ruling, `_INDEX.md`): `DOUBLE_SUBMIT_WINDOW_MS` is now
  // 250ms (was 600ms), so the clearance the alternating taps above never
  // needed either is gone here too — this is one of the acceptance-test
  // call sites for that fix.
  await awayHalf.click(); // 9th: away takes advantage the OTHER way
  await expect.poll(pointCount, { timeout: 20_000 }).toBe(9);
  await expect(homeHalf).toContainText("40");
  await expect(awayHalf, "advantage must alternate to the away side too, not only home's").toContainText("AD");

  await homeHalf.click(); // 10th: home cancels it — deuce again
  await expect.poll(pointCount, { timeout: 20_000 }).toBe(10);
  await expect(homeHalf).toContainText("40");
  await expect(awayHalf).toContainText("40");

  const rows = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "tennis.point");
  expect(rows.map((r) => r.payload.by)).toEqual([
    fx.homeEntrantId,
    fx.awayEntrantId,
    fx.homeEntrantId,
    fx.awayEntrantId,
    fx.homeEntrantId,
    fx.awayEntrantId,
    fx.homeEntrantId,
    fx.awayEntrantId,
    fx.awayEntrantId,
    fx.homeEntrantId,
  ]);
  // R4-5's singles auto-stamp (`buildHalf`): `scorer` is the tapped half's
  // own sole player, on EVERY point, with no dock question — and `server`
  // stays home's sole player throughout, since home never loses the game
  // this deuce/advantage dance never actually finishes.
  const homePersonId = fx.personIds[`V3 Tennis Deuce Home ${TAG}`]!;
  const awayPersonId = fx.personIds[`V3 Tennis Deuce Away ${TAG}`]!;
  for (const row of rows) {
    expect(row.payload.server, "the server must stay home's sole player for the whole game").toBe(homePersonId);
  }
  expect(rows.map((r) => r.payload.scorer)).toEqual([
    homePersonId,
    awayPersonId,
    homePersonId,
    awayPersonId,
    homePersonId,
    awayPersonId,
    homePersonId,
    awayPersonId,
    awayPersonId,
    homePersonId,
  ]);
});

// ---------------------------------------------------------------------------
// The point dock — legality by side, and the DRAINED payload (singles)
// ---------------------------------------------------------------------------

test("tennis v3 singles: the point dock offers ace/double-fault by SERVE legality, and the chosen kind reaches the DRAINED payload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Tennis Dock ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: `V3 Tennis Dock Home ${TAG}` }],
    away: [{ fullName: `V3 Tennis Dock Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);
  const homePersonId = fx.personIds[`V3 Tennis Dock Home ${TAG}`]!;
  const awayPersonId = fx.personIds[`V3 Tennis Dock Away ${TAG}`]!;

  // --- Point 1: home taps while home is serving — an ace is a legal chip,
  // a double fault is not (an ace is the SERVER's point). -------------------
  await tennisHalf(page, "home").click();
  let dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await expect(dock).toContainText("How was the point won?");
  await expect(dock.getByRole("button", { name: "Ace", exact: true }), "the server's own side must offer Ace").toBeVisible();
  await expect(
    dock.getByRole("button", { name: "Double fault", exact: true }),
    "the server's own side must NOT offer Double fault",
  ).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Winner", exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Unforced error", exact: true })).toBeVisible();

  await dock.getByRole("button", { name: "Ace", exact: true }).click();
  // ONE-WAY, AND THE ALTERNATIVES LEAVE (build spec §4): this is the branch
  // R3's own dock shipped inert past unit tests — only a real re-render
  // proves the chosen kind is now the ONLY chip on screen.
  await expect(
    dock.getByRole("button", { name: "Winner", exact: true }),
    "once a kind lands, the dock must show ONLY that chip",
  ).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Ace", exact: true })).toBeVisible();
  await sendHeldNow(page);
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "tennis.point"), { timeout: 20_000 }).toBe(1);
  const acePoint = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "tennis.point")!;
  // The SUBMITTED payload, not the optimistic one — `meta.kind` had to
  // survive a mutation against a still-held event, all the way to the flush.
  expect(acePoint.payload).toEqual({
    by: fx.homeEntrantId,
    server: homePersonId,
    scorer: homePersonId,
    meta: { kind: "ace" },
  });

  // --- Point 2: away taps while home is STILL serving (one point never
  // ends a game) — now a double fault is legal, an ace is not. -------------
  await tennisHalf(page, "away").click();
  dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await expect(
    dock.getByRole("button", { name: "Double fault", exact: true }),
    "the receiving side must offer Double fault",
  ).toBeVisible();
  await expect(
    dock.getByRole("button", { name: "Ace", exact: true }),
    "the receiving side must NOT offer Ace — an ace is the server's own point",
  ).toHaveCount(0);
  await dock.getByRole("button", { name: "Double fault", exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "tennis.point"), { timeout: 20_000 }).toBe(2);
  const dfPoint = (await ledger(page.request, fx.fixtureId)).find(
    (e) => e.type === "tennis.point" && (e.payload.meta as { kind?: string } | undefined)?.kind === "double_fault",
  )!;
  expect(dfPoint.payload).toEqual({
    by: fx.awayEntrantId,
    server: homePersonId,
    scorer: awayPersonId,
    meta: { kind: "double_fault" },
  });
});

// ---------------------------------------------------------------------------
// Doubles — the serve pip on a KNOWN, declared player
// ---------------------------------------------------------------------------

test("tennis v3 doubles: the serving player is the declared pairOrder:1 partner, on the pip AND the strip", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Tennis Serve ${TAG}`,
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "pair",
    home: [
      { fullName: `V3 Tennis Serve Home1 ${TAG}`, pairOrder: 1 },
      { fullName: `V3 Tennis Serve Home2 ${TAG}`, pairOrder: 2 },
    ],
    away: [
      { fullName: `V3 Tennis Serve Away1 ${TAG}`, pairOrder: 1 },
      { fullName: `V3 Tennis Serve Away2 ${TAG}`, pairOrder: 2 },
    ],
  });
  await openLiveConsole(page, fx);

  const home1 = `V3 Tennis Serve Home1 ${TAG}`;
  const home2 = `V3 Tennis Serve Home2 ${TAG}`;

  // Home serves first by default (`kernel.ts`'s own init convention), and at
  // service turn 0 the due server is the declared pairOrder:1 partner
  // (`expectedPairServer`, squad-state.ts) — a KNOWN person, never
  // "whichever name got marked".
  const homeHalf = tennisHalf(page, "home");
  await expect(homeHalf).toBeVisible();
  const ariaLabel = await homeHalf.getAttribute("aria-label");
  expect(ariaLabel, "the serving cue belongs to pairOrder:1 specifically").toContain(`${home1}, Serving`);
  expect(ariaLabel, "the OTHER partner must not also carry the serving cue").not.toContain(`${home2}, Serving`);

  const server = pad(page).locator('[data-strip-item-id="server"]');
  await expect(server, "the strip's own Serving field must name the same known player").toBeVisible();
  await expect(server).toContainText(home1);
  await expect(server).not.toContainText(home2);
});

// ---------------------------------------------------------------------------
// Doubles — the dock's SECOND question, and its DRAINED payload
// ---------------------------------------------------------------------------

test("tennis v3 doubles: the dock's second question narrows to the winning PAIR, and the tapped scorer reaches the DRAINED payload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Tennis PDock ${TAG}`,
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "pair",
    home: [
      { fullName: `V3 Tennis PDock Home1 ${TAG}`, pairOrder: 1 },
      { fullName: `V3 Tennis PDock Home2 ${TAG}`, pairOrder: 2 },
    ],
    away: [
      { fullName: `V3 Tennis PDock Away1 ${TAG}`, pairOrder: 1 },
      { fullName: `V3 Tennis PDock Away2 ${TAG}`, pairOrder: 2 },
    ],
  });
  await openLiveConsole(page, fx);
  const home1Name = `V3 Tennis PDock Home1 ${TAG}`;
  const home2Name = `V3 Tennis PDock Home2 ${TAG}`;
  const away1Name = `V3 Tennis PDock Away1 ${TAG}`;
  const away2Name = `V3 Tennis PDock Away2 ${TAG}`;
  const home1Id = fx.personIds[home1Name]!;
  const home2Id = fx.personIds[home2Name]!;

  await tennisHalf(page, "home").click();
  const dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await expect(dock).toContainText("How was the point won?");
  // The scorer step has not arrived yet — neither partner is offered by NAME
  // on this first question.
  await expect(dock.getByRole("button", { name: home1Name, exact: true })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: home2Name, exact: true })).toHaveCount(0);

  await dock.getByRole("button", { name: "Winner", exact: true }).click();

  // THE R3-CLASS PROOF: whether this second question actually renders
  // depends entirely on `DetailDock`'s `setSpec`/`dockStore` mirror
  // re-invoking `buildDock` with the advanced payload — a real React
  // re-render no node-environment unit test can exercise (tennis.tsx's own
  // `buildDock` doc names this incident). If this hangs, the dock shipped
  // inert exactly the way R3's did.
  await expect(dock, "the dock's SECOND question must replace the first, not sit beside it").toContainText(
    "Who won the point?",
  );
  const home1Chip = dock.getByRole("button", { name: home1Name, exact: true });
  const home2Chip = dock.getByRole("button", { name: home2Name, exact: true });
  await expect(home1Chip, "the winning pair's OWN players must be offered").toBeVisible();
  await expect(home2Chip).toBeVisible();
  // Narrowed to the WINNING side's pair — never the other side's, and never
  // just the auto-inferred server.
  await expect(dock.getByRole("button", { name: away1Name, exact: true })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: away2Name, exact: true })).toHaveCount(0);

  // Deliberately the NON-serving partner — proves `scorer` can be EITHER
  // pair member, not merely whichever one `servingInfo` already knew about.
  await home2Chip.click();
  // One-way collapse again, one step deeper: back to a single "Winner" chip,
  // the scorer step gone.
  await expect(dock.getByRole("button", { name: home1Name, exact: true }), "the scorer step must not persist").toHaveCount(
    0,
  );
  await expect(dock.getByRole("button", { name: "Winner", exact: true })).toBeVisible();

  await sendHeldNow(page);
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "tennis.point"), { timeout: 20_000 }).toBe(1);
  const point = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "tennis.point")!;
  // The SUBMITTED payload: `scorer` must be the SPECIFIC chip tapped
  // (home2), not home1 (the auto-known server) and not absent.
  expect(point.payload).toEqual({
    by: fx.homeEntrantId,
    server: home1Id,
    scorer: home2Id,
    meta: { kind: "winner" },
  });
});

// ---------------------------------------------------------------------------
// D-16 — the Set-score tile's dead-end tap, closed at the DOM
// ---------------------------------------------------------------------------

test("tennis v3: the Set-score tile is withheld while the set is in progress, refused (not just hidden) via More, and restored once undone", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Tennis D16 ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: `V3 Tennis D16 Home ${TAG}` }],
    away: [{ fullName: `V3 Tennis D16 Away ${TAG}` }],
    emitCoreStart: true,
  });
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });

  await expect(v3Tile(page, "setScore"), "a fresh set (nothing scored yet) must offer the Set score tile").toBeVisible();

  await tennisHalf(page, "home").click();
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "tennis.point"), { timeout: 20_000 }).toBe(1);
  await expect(
    v3Tile(page, "setScore"),
    "D-16: a set being scored point-by-point must withhold the tile — applySetSummary refuses it outright",
  ).toHaveCount(0);

  // The other half of D-16: no dead-end tap via the generic More sheet
  // either.
  await v3Tile(page, "more").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(
    sheet.getByRole("button", { name: "Set score", exact: true }),
    "the More sheet must not offer the same mid-set-refused action a second time",
  ).toHaveCount(0);

  await page.reload();
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  // The pad's OWN ribbon (not the console's separate "Undo last" chrome) —
  // undoing the just-scored point through the pad's own live state.
  const ribbon = pad(page).locator('[data-role="v3-ribbon"]');
  const undoBtn = ribbon.getByRole("button", { name: "Take back", exact: true });
  await expect(undoBtn).toBeVisible({ timeout: 20_000 });
  await undoBtn.click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).some((e) => e.type === "core.void"), {
      timeout: 20_000,
    })
    .toBe(true);

  await expect(
    v3Tile(page, "setScore"),
    "D-16 closes BOTH ways: undoing the only point must restore the tile, not just hide it forever",
  ).toBeVisible({ timeout: 20_000 });
});
