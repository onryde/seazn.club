import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, expectNoHorizontalScroll, TAG } from "./helpers";
import { HIT_TARGET_FLOOR_PX, measureHitTargets, scanPadContrast, smallestOperable } from "./scorepad-a11y-kit";

// S11/#420 W9 — one real-browser headline flow per shipped skin (cricket,
// racquet, tennis, football, period), all at 375px.
//
// S13/#422 W11 cutover — re-anchored off `/score/harness` (deleted this
// session) onto the REAL fixture console (`/f/[no]`), against REAL seeded
// rosters (`seedRosteredFixture`, helpers.ts) — the same helper and the same
// `openLiveConsole`/`pad`/`ledger` pattern scorepad-v2.spec.ts's own console
// tests already established and (per that file's own header) already proved
// in a real browser. That removes the harness's two structural gaps outright
// rather than working around them here a second time:
//
//  - Synthetic lineups ("h-1"/"h-2"/…) 422 against a real server fold for any
//    person-attributed action (cricket's striker/bowler, football's scorer/
//    assist) — S11 could drive football side-only and could not drive
//    cricket AT ALL for exactly this reason (see this file's own prior
//    header, preserved in git history). Real rosters remove the gap; the
//    cricket case below is a genuine flow now, not a `test.skip`.
//  - The harness's `?fixture=` mode never passed `initialEvents` to
//    `PadRenderer`, so a same-tick tap after "Start match" replayed a stale
//    "pre"-phase fold and threw client-side — the ~15-20s realtime-reconcile
//    wait every test below used to need. The fixture console's own "Start
//    match" is a SEPARATE control from the pad's pipeline there too, but
//    `openLiveConsole` polls the real ledger for `core.start` before
//    proceeding rather than a fixed sleep — the same pattern
//    scorepad-v2.spec.ts's cricket/football console flows already use
//    successfully, with no extra wait or reload needed on this surface.
//
// Football and cricket already have deeper real coverage in
// scorepad-v2.spec.ts (scorer+assist, undo, a full over with a dismissal) —
// the two flows below stay deliberately more modest (a side-only goal, a
// couple of balls) so this file keeps its own original shape — a quick tour
// across all five skins in one place — without just repeating that file.
test.use({ viewport: { width: 375, height: 800 } });

/** The pad's own scoring surface (fixture-console.tsx), scoped so a
 *  page-wide text match can never satisfy an assertion the skin was
 *  supposed to. Mirrors scorepad-v2.spec.ts's own `pad()` exactly. */
function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/** The fixture's REAL, server-persisted ledger from seq 0 — every assertion
 *  below is checked against this, not only against the screen. */
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

/** Open the console and take the fixture live through the console's own
 *  "Start match" control — the real organiser flow, not an API-seeded
 *  `core.start` (see the file header on why that matters: `core.start`
 *  arriving from the chrome is a foreign write as far as the pad's own
 *  pipeline is concerned, and polling the ledger — not a fixed sleep — is
 *  what makes tapping the pad safe immediately afterward). */
async function openLiveConsole(page: Page, fx: { fixtureId: string }): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

/**
 * S13/#422 W11 cutover — the WCAG AA color-contrast guard, extended to the
 * four skins (and the chassis header they all share) the ONE pre-existing
 * axe scan never reached: v6-sports.spec.ts's icehockey-penalties test is
 * the only place this repo runs axe against the v2 scoring pad, so cricket,
 * football, racquet and tennis (and pad-renderer.tsx's own dark header,
 * which the icehockey test happens not to exercise either — it renders
 * period-skin.tsx's OWN header instead) went unchecked. That gap is exactly
 * how the text-slate-500-on-bg-slate-900 / text-slate-400-on-white /
 * text-purple-400-on-white failures fixed this session (source files, this
 * same commit set) went unnoticed across five files for as long as they
 * did — a defect this deterministic needed only ONE real render to be
 * caught, and four skins' worth of renders never happened under axe.
 *
 * Same invocation shape as v6-sports.spec.ts's own scan (the only existing
 * precedent in this repo): scoped to `[data-testid="score-pad"]` — the
 * SAME element `pad()` above already scopes every other assertion in this
 * file to — so a pre-existing contrast debt on the WIDER fixture console
 * chrome (out of this session's scope) can never fail this guard; only
 * `wcag2a`/`wcag2aa` tags, and only `serious`/`critical` impact, matching
 * the repo's one other precedent exactly rather than inventing a stricter
 * or looser gate here.
 *
 * Placed at the END of each flow (immediately before the existing
 * `expectNoHorizontalScroll` call every test below already has), after the
 * real interaction has run — a scan against the pad's INITIAL render alone
 * would miss whatever an expanded ActionForm, a chip row or a populated
 * header value newly draws, which is exactly the kind of state a courtside
 * scorer actually sees mid-match.
 *
 * R8/WS-H — TWO CHANGES, both additive.
 *
 * First, the axe invocation moved into `scorepad-a11y-kit.ts` (shared with the
 * eleven-skin sweep in `scorepad-v3-a11y-sweep.spec.ts` and with
 * `scorepad-a11y-evidence.spec.ts`, so all three run ONE implementation).
 * Same tags, same scope, same serious/critical gate as the call it replaces —
 * what it adds is a proof that the scan was not vacuous: a `.include()` that
 * resolves to the page chrome or the cookie banner reports zero violations
 * just as happily as a clean pad does, and this suite has already been fooled
 * by exactly that once.
 *
 * Second, THE 44px HIT-TARGET FLOOR, which this file never measured. Before
 * R8 it existed for `generic` and nothing else — one skin of eleven. The
 * eleven-skin sweep now covers every skin's pad AT REST; this call adds the
 * five sports here at their POST-INTERACTION state, where a Detail Dock chip
 * row or a guided sheet's option list is on screen and the at-rest sweep
 * cannot see it. `measureHitTargets` is imported, never re-derived: a
 * `boundingBox()` is the real painted rectangle, whereas reading `min-h-11`
 * off a class name cannot see a parent that clips it.
 */
async function expectPadA11yClean(page: Page): Promise<void> {
  const scan = await scanPadContrast(page, '[data-testid="score-pad"]');
  expect(scan.serious, JSON.stringify(scan.serious, null, 2)).toEqual([]);

  const smallest = smallestOperable(await measureHitTargets(pad(page)));
  expect(smallest, "no operable hit target rendered inside the pad — nothing was measured").not.toBeNull();
  const detail = `smallest operable target "${smallest?.name}" (${smallest?.role}) is ${smallest?.width}x${smallest?.height}px`;
  expect(smallest!.width, detail).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
  expect(smallest!.height, detail).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
}

/**
 * R3/task D — football moved to the v3 chassis, so the four football flows in
 * this file drive the v3 pad's own DOM. Three helpers the converted tests
 * share, all chassis-generic (they name nothing football-specific):
 *
 * `v3Tile` addresses a tile by `TileSpec.id` (`data-tile-id`, tile-grid.tsx)
 * rather than by accessible name: a tile's name is the concatenation of two
 * LOCALISED strings ("Goal" + "Home"), and every assertion below is about
 * behaviour, not copy.
 *
 * `sendHeldNow` taps the Detail Dock's own dismiss control (`pad.dock.dismiss`
 * — "Send now": detail-dock.tsx's `dismiss()` is an IMMEDIATE FLUSH, never a
 * cancel), so a test that only needs its event ON THE LEDGER does not wait out
 * the full `HOLD_MS` soft-commit window. Same helper, same reasoning
 * as scorepad-v3-cricket.spec.ts's own. It is only available for an event
 * whose skin declares a dock — football's goal and card do, its substitution
 * does not (`buildDock` returns null, so `DetailDock` renders nothing and
 * there is no control to tap); those flows poll the ledger instead.
 */
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

function v3Sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}

/** R6 cutover — hockey/icehockey's Detail Dock (goal kind, suspension
 *  offender chips). Same primitive as `v3Tile`/`v3Sheet` above. */
function v3Dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}

/** A scorebug strip item by its skin-declared `StripItem.id` (period, box,
 *  strength, …) — the v3 equivalent of the v2 period skin's own header
 *  fields (`header-score`/`header-period`), which no longer render for any
 *  sport on this chassis. */
function stripItem(page: Page, id: string) {
  return pad(page).locator(`[data-role="v3-scorebug"] [data-strip-item-id="${id}"]`);
}

async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

/** One half of the v3 scorebug, home first — the visible score, which is what
 *  the pre-conversion versions of these tests asserted through the v2 skin's
 *  own "0 - 0"/"1 - 0" string. v3 renders the two sides as separate cells
 *  (`ScorebugSpec.halves`, scorebug.tsx) with no per-half `data-*` of their
 *  own, so this indexes the two children of the halves grid. */
function scorebugHalf(page: Page, index: 0 | 1) {
  return pad(page).locator('[data-role="v3-scorebug"] .grid > *').nth(index);
}

test("cricket skin: real roster, a couple of balls scored", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `Skins Cricket ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `Skins Striker ${TAG}` }, { fullName: `Skins NonStriker ${TAG}` }],
    away: [{ fullName: `Skins Bowler ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  const striker = fx.personIds[`Skins Striker ${TAG}`]!;
  const nonStriker = fx.personIds[`Skins NonStriker ${TAG}`]!;
  const bowler = fx.personIds[`Skins Bowler ${TAG}`]!;

  // R2's v2→v3 cutover for cricket (V3_SKINS) replaces the three "This over"
  // selects with the context strip (D-14) — no picker tap is needed here at
  // all: with exactly one home pair and one away player, the strip's own
  // fold-derived defaults (`resolvePeople`, v3/skins/cricket.tsx —
  // `battingOrder[0]/[1]`, `bowlingOrder[0]`) are already this fixture's only
  // possible assignment, so a run tile can be tapped directly. The picker
  // ITSELF (tap a chip, tap a candidate BY NAME, and the pick survives into
  // the next dispatched payload) has its own dedicated proof in
  // scorepad-v3-cricket.spec.ts — this file stays the "one quick real-roster
  // tour per skin" it was before.
  await pad(page).getByRole("button", { name: "4", exact: true }).click();
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await pad(page).getByRole("button", { name: "1", exact: true }).click();
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "cricket.ball").length,
      { timeout: 20_000 },
    )
    .toBe(2);

  const balls = (await ledger(request, fx.fixtureId)).filter((e) => e.type === "cricket.ball");
  // Real roster ids, never the harness's synthetic ones — the whole reason
  // this flow could not exist in this file before this session.
  for (const b of balls) {
    expect([striker, nonStriker]).toContain(b.payload.striker);
    expect(b.payload.bowler).toBe(bowler);
  }
  // S13/#422 W11 cutover — cricket's own scan (see expectPadA11yClean's
  // header comment for why this file, not just v6-sports.spec.ts's single
  // icehockey scan, needs one per skin).
  await expectPadA11yClean(page);
  await expectNoHorizontalScroll(page);
});

test("tennis skin: play points to deuce", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `Skins Tennis ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: `Skins Tennis Home ${TAG}` }],
    away: [{ fullName: `Skins Tennis Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // R4/tennis cutover — v3 tapModel S: the scoreboard halves ARE the point
  // buttons (v3/skins/tennis.tsx), so the v2-era one-tap "Home"/"Away" pair
  // this test used to click no longer exists. `scorebugHalf` (this file's
  // own football-era helper, above) already indexes the halves grid
  // positionally, home first — a band-3 org's tappable halves render as
  // real <button>s regardless of sport. Reaching deuce is still 6 taps: 3
  // each, alternating — never two of the same side in a row, which matters
  // for `usePadPipeline`'s own double-submit guard (identical payloads
  // within its window are correctly swallowed; alternating ones never
  // collide with it).
  //
  // `openLiveConsole` only waits for the SERVER's ledger to carry
  // `core.start` — the CLIENT's own re-render from "pre" (a plain, click-
  // inert <div> at this same grid position) to "live" (a real <button>) is
  // a separate, later event that generic wait says nothing about (found by
  // running this file: the first tap intermittently landed on the
  // still-present <div> and dispatched nothing). `scorebugHalf`'s `.grid >
  // *` is shared with football's own div-only usage above, so rather than
  // narrow that helper this waits, once, for both halves to have actually
  // become buttons before the tap loop starts.
  await expect(pad(page).locator('[data-role="v3-scorebug"] button'), "both halves must be live (tappable) before the first tap").toHaveCount(
    2,
    { timeout: 20_000 },
  );
  const homeHalf = scorebugHalf(page, 0);
  const awayHalf = scorebugHalf(page, 1);
  await expect(homeHalf).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await homeHalf.click();
    await awayHalf.click();
  }
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "tennis.point").length,
      { timeout: 20_000 },
    )
    .toBe(6);

  // v3 renders each half's OWN points via `ScorebugHalf.big` (scorebug.tsx),
  // not the v2 header's combined "Points" field this test used to read —
  // 40–40 is deuce, one call per half.
  await expect(homeHalf).toContainText("40");
  await expect(awayHalf).toContainText("40");
  // S13/#422 W11 cutover — tennis's own scan.
  await expectPadA11yClean(page);
  await expectNoHorizontalScroll(page);

  const points = await ledger(request, fx.fixtureId);
  const byType = points.filter((e) => e.type === "tennis.point").map((e) => e.payload.by);
  expect(byType).toEqual([
    fx.homeEntrantId,
    fx.awayEntrantId,
    fx.homeEntrantId,
    fx.awayEntrantId,
    fx.homeEntrantId,
    fx.awayEntrantId,
  ]);
});

test("volleyball skin: a set summary then a rally", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `Skins Volleyball ${TAG}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: [{ fullName: `Skins VB Home ${TAG}` }],
    away: [{ fullName: `Skins VB Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // R5/C3 cutover — v3 tapModel S: the scoreboard halves ARE the rally
  // buttons (v3/skins/volleyball.tsx), so the v2-era one-tap "Home"/"Away"
  // pair this test used to click no longer exists, and neither does the v2
  // `[data-role="racquet-header"]` this test used to read the score off.
  // Every half's own `who` is the SIDE label ("Home"/"Away") plus hint text,
  // so it is addressed POSITIONALLY, never by an exact accessible name — the
  // identical badminton/tennis reasoning `scorebugHalf`'s own doc states.
  //
  // ORDER IS LOAD-BEARING (setbased/kernel.ts's own fold, via the server's
  // actual rejection): a set is scored EITHER rally-by-rally OR by summary,
  // never both, so the only way to drive both actions for real is to close
  // set 1 by summary FIRST, then open+score set 2 with a rally.
  // R5 — THE SET SCORE SHEET IS GUIDED, one field per STEP. The three lines
  // that used to stand here were written against the v2 form and had never
  // been run since the cutover: `getByLabel("Points — Away")` timed out at
  // 120s, and `[data-role="confirm"]` has ZERO producers anywhere in v3. Same
  // idiom as `scorepad-v3-volleyball.spec.ts`, which does run: fill the ONE
  // spinbutton the current step shows, Confirm, and the sheet advances to the
  // next. HOME is step one, AWAY step two — the order the sheet asks in.
  await v3Tile(page, "setScore").click();
  const setScoreSheet = v3Sheet(page);
  await expect(setScoreSheet).toBeVisible({ timeout: 20_000 });
  for (const value of ["25", "20"]) {
    const field = setScoreSheet.getByRole("spinbutton");
    // The retry wraps BOTH the fill and the read-back: the step's own field
    // remounts between steps, so a fill racing that remount lands in a node
    // that is already gone.
    await expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await setScoreSheet.getByRole("button", { name: "Confirm", exact: true }).click();
  }
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "volleyball.set.summary").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  await expect(pad(page).locator('[data-role="v3-scorebug"] button'), "both halves must be live (tappable) before the tap").toHaveCount(
    2,
    { timeout: 20_000 },
  );
  const homeHalf = scorebugHalf(page, 0);
  await homeHalf.click();
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "volleyball.rally").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  // v3 renders each half's OWN points via `ScorebugHalf.big`, not the v2
  // header's combined "Points" field this test used to read; the sets tally
  // moved to the strip's own "games"-id item (D-11's retirement of the old
  // three-times-stated score, the identical proof the siblings' own tests
  // make).
  await expect(homeHalf).toContainText("1");
  const strip = pad(page).locator('[data-role="v3-scorebug"] [data-strip-item-id="games"]');
  await expect(strip).toContainText("1–0");
  // S13/#422 W11 cutover — volleyball's own scan.
  await expectPadA11yClean(page);
  await expectNoHorizontalScroll(page);

  const rows = await ledger(request, fx.fixtureId);
  const summary = rows.find((e) => e.type === "volleyball.set.summary")!;
  const rally = rows.find((e) => e.type === "volleyball.rally")!;
  expect(summary.payload).toMatchObject({ home: 25, away: 20 });
  expect(rally.payload).toMatchObject({ wonBy: fx.homeEntrantId });
});

test("football skin: a side-only goal", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `Skins Football ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `Skins FB Home ${TAG}`, positionKey: "FW" },
      { fullName: `Skins FB Home Keeper ${TAG}`, positionKey: "GK" },
    ],
    away: [{ fullName: `Skins FB Away Keeper ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  await expect(scorebugHalf(page, 0)).toContainText("Home");
  await expect(scorebugHalf(page, 0), "the home half must open on zero").toContainText("0");

  // R3/task D — v3: a goal COMMITS ON THE TAP. `scorer`/`assist` are both
  // `.optional()` on `FootballGoal`, so the event the engine receives is
  // already complete; the Detail Dock then offers the attribution as
  // enrichment rather than as a modal before every goal. There is NO Confirm
  // button on this path at all — the v2 control the pre-conversion version of
  // this test clicked does not exist on the v3 pad.
  //
  // This test keeps its original subject: the SIDE-ONLY goal, both attribution
  // slots left unpicked. The dock is dismissed with "Send now" (an immediate
  // flush, not a cancel) instead of waiting out the 6s hold — the payload is
  // identical either way, and the hold's own timing is owned by
  // scorepad-v3-cricket.spec.ts's two undo tests.
  await v3Tile(page, "goal-home").click();
  await sendHeldNow(page);
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "football.goal").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  await expect(scorebugHalf(page, 0), "the goal must reach the visible score").toContainText("1");
  await expect(scorebugHalf(page, 1), "the away half must be untouched").toContainText("0");
  // S13/#422 W11 cutover — football's own scan.
  await expectPadA11yClean(page);
  await expectNoHorizontalScroll(page);

  const goal = (await ledger(request, fx.fixtureId)).find((e) => e.type === "football.goal")!;
  expect(goal.payload).toEqual({ by: fx.homeEntrantId });
});

test("period skin (icehockey): a goal and a period advance", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    label: `Skins Icehockey ${TAG}`,
    sportKey: "icehockey",
    variantKey: "iihf",
    home: [{ fullName: `Skins IH Home ${TAG}` }],
    away: [{ fullName: `Skins IH Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // R6 cutover — hockey/icehockey moved onto the v3 chassis (period-
  // shared.ts), so the v2 header fields this test used to read
  // (`header-score`/`header-period`) no longer render for either sport. v3
  // renders the score as two separate scorebug halves and the period as a
  // strip item (`buildScorebug`), same idiom this file's own football/
  // tennis/volleyball v3 ports already established above.
  await expect(scorebugHalf(page, 0), "the home half must open on zero").toContainText("0");
  await expect(scorebugHalf(page, 1), "the away half must open on zero").toContainText("0");
  await expect(stripItem(page, "period"), "ice hockey opens on its first period").toContainText("P1");

  // R6 — v3: a goal COMMITS ON THE TAP (period-shared.ts's own
  // `buildTiles`); there is no Confirm control and no attribution step
  // before the event dispatches. The v2 "Kind" select this test used to
  // drive is now a Detail Dock chip offered AFTER the tap — and "Fg" (the
  // value this test used to pick) is deliberately given NO chip at all: it
  // is the kind that needs no enrichment (`buildDock`'s own comment,
  // period-shared.ts: "`fg` is the default and needs no chip"). "Power
  // play" is the closest live equivalent — an explicit, non-default kind a
  // scorer actually has to pick — which proves the SAME underlying wiring
  // ("a chosen kind reaches the submitted payload") the original selection
  // did, just off a kind the dock can actually offer.
  await v3Tile(page, "goal-home").click();
  const dock = v3Dock(page);
  await expect(dock, "a goal always opens the Detail Dock (buildDock's e.goal case)").toBeVisible({
    timeout: 10_000,
  });
  await dock.getByRole("button", { name: "Power play", exact: true }).click();
  await sendHeldNow(page);
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "icehockey.goal").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  // THE WHISTLE — one tap, no picker: `buildTiles` already knows the next
  // period label, unlike the v2 generic form's own `<select>`.
  await v3Tile(page, "advance").click();
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "icehockey.period.advance").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  await expect(scorebugHalf(page, 0), "the goal must reach the visible score").toContainText("1");
  await expect(stripItem(page, "period"), "the board must repoint onto the period it just advanced to").toContainText(
    "P2",
  );
  // S13/#422 W11 cutover — period's own scan (the v3 chassis's own
  // Scorebug/TileGrid/DetailDock, not period-skin.tsx's v2 dark header —
  // the icehockey e2e in v6-sports.spec.ts scans a DIFFERENT icehockey
  // fixture reaching the suspension flow, not this goal-scoring one, so
  // this is genuinely additional coverage, not a duplicate scan).
  await expectPadA11yClean(page);
  await expectNoHorizontalScroll(page);

  const goal = (await ledger(request, fx.fixtureId)).find((e) => e.type === "icehockey.goal")!;
  expect(goal.payload).toMatchObject({ by: fx.homeEntrantId, kind: "pp" });
});

// ---------------------------------------------------------------------------
// S13/#422 W11 cutover — closing four items the programme carried as
// deferred e2e debt (`_INDEX.md` decision log, S12 close-out entry "the
// deferred-e2e debt, discharged per session with a verdict each"). Same
// helpers, same real-fixture pattern as the five tests above.
// ---------------------------------------------------------------------------

test("football skin: a substitution, through the SAME reducer core.lineup.substitution goes through", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // S3/#426 (mutable squads) — the deferred half. `football.sub` is NOT a
  // parallel mechanism: its own fold (football.ts's `applySub`) calls
  // `reduceLineupEvent(..., { type: "core.lineup.substitution", ... })`
  // internally, so driving this action through the pad IS driving the S3
  // shared lineup event end to end. `seedRosteredFixture` seeds every roster
  // member `slot: "starting"`, so the "on" chip (bench pool) needs a real
  // bench member — the new optional `slot` override on `RosterSlotSpec`
  // (this file, added this session; every other caller is unaffected).
  const fx = await seedRosteredFixture(request, {
    label: `Skins FB Sub ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `Skins FB OnPitch ${TAG}`, positionKey: "FW" },
      { fullName: `Skins FB Bench ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `Skins FB Sub Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  const off = fx.personIds[`Skins FB OnPitch ${TAG}`]!;
  const on = fx.personIds[`Skins FB Bench ${TAG}`]!;

  // R3/task D — v3: the per-side Sub tile opens that side's OWN `SwapSlot`
  // (`swap: "sub-home"`, football.tsx's `swapSlotId`), the chassis primitive
  // R3's own sub-wave fixed for this wave's first real use of it. Off step,
  // then on step; candidates carry `data-candidate-id` (context-strip.tsx's
  // shared `renderCandidateRow`, which the swap sheet reuses), so this
  // addresses PEOPLE BY ID and can never click the wrong one of two similarly
  // named seeds.
  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap, "the Sub tile must open this side's swap sheet").toBeVisible({ timeout: 10_000 });
  await expect(swap).toHaveAttribute("data-swap-slot-id", "sub-home");
  await swap.locator(`[data-candidate-id="${off}"]`).click();
  // Picking the ON player is the last decision — it dispatches immediately,
  // the same "last required attribution auto-submits" rule the v2 flow had.
  await swap.locator(`[data-candidate-id="${on}"]`).click();

  // No "Send now" here: `buildDock` returns null for `football.sub`, so the
  // dock renders nothing and there is no flush control — this waits the hold
  // window out, which the 20s budget already covers.
  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "football.sub").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  const sub = (await ledger(request, fx.fixtureId)).find((e) => e.type === "football.sub")!;
  // Attribution ONLY — and NO `at`. R3-2 stamps a substitution from the fold's
  // own `asOf`, and `stampOf`'s staleness guard omits the stamp when `asOf` is
  // missing (which it is on a stream recorded entirely through this pad, where
  // no tile sends an `at`). Omitting is legal — `at` is `.optional()` — and is
  // the honest failure: a WRONG stamp mis-attributes a stoppage.
  expect(sub.payload).toEqual({ by: fx.homeEntrantId, off, on });
  await expectNoHorizontalScroll(page);
});

test("football skin: a penalty awarded and its outcome, through the v3 guided sheet", async ({ page, request }) => {
  test.setTimeout(120_000);
  // S4/#428 (offence taxonomies) — the football half, converted to v3.
  //
  // WHAT MOVED, stated so it is not lost: on the v2 pad `football.penalty`
  // rendered through the GENERIC ActionForm, which drew every field `padSpec`
  // declares — `outcome`, `offence` (the IFAB Law 12 direct-free-kick
  // taxonomy) and the `...stamp` pair. The v3 skin gives the penalty a
  // dedicated two-step guided sheet ("Who was awarded it?" / "What
  // happened?", football.tsx's `penaltySheet`) and, because a dedicated sheet
  // removes its event from the More sheet (`dedicatedEventTypes`), the
  // generic form is no longer a second route to it. `offence` is therefore
  // not askable anywhere on the v3 pad today. That is a PRODUCT gap this
  // conversion records rather than papers over — it is reported to the wave,
  // and it is not asserted either way here, because asserting its absence
  // would enshrine it.
  //
  // What this test still owns end to end: the awarded SIDE and the required
  // `outcome`, both on the real ledger, driven through the real sheet.
  const fx = await seedRosteredFixture(request, {
    label: `Skins FB Penalty ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `Skins FB Taker ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `Skins FB Penalty Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  await v3Tile(page, "penalty").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the Penalty tile must open the skin's guided sheet").toBeVisible({ timeout: 10_000 });
  // Step 1 — the awarded side. The options are entrant ids labelled with the
  // shared `scorepad.attribution.*` copy, so this clicks the ID and the label
  // is what the assertion below proves reached the payload.
  await sheet.locator(`[data-choice-option-id="${fx.homeEntrantId}"]`).click();
  // Step 2 — `outcome`, REQUIRED on `FootballPenalty` (it is what keeps the
  // branch structurally distinct in the event union) and deliberately WITHOUT
  // "scored": a converted penalty is a `football.goal {penalty: true}`.
  await expect(
    sheet.locator('[data-choice-option-id="scored"]'),
    "a converted penalty is a goal, never this event — 'scored' must not be offered",
  ).toHaveCount(0);
  await sheet.locator('[data-choice-option-id="saved"]').click();

  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "football.penalty").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  const penalty = (await ledger(request, fx.fixtureId)).find((e) => e.type === "football.penalty")!;
  expect(penalty.payload).toMatchObject({ by: fx.homeEntrantId, outcome: "saved" });
  await expectNoHorizontalScroll(page);
});

test("period skin (icehockey): a suspension with a reason selected (PeriodSuspensionReason)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // S4/#428 (offence taxonomies) — the period half. `suspension.start` is
  // labelled "Card" and sits in the always-visible "discipline" secondary
  // group, fidelity band 1 — free, no entitlement grant needed (verified:
  // `period/kernel.ts`'s own `fidelityEntitlements` names band 2, never 1).
  const fx = await seedRosteredFixture(request, {
    label: `Skins IH Suspension ${TAG}`,
    sportKey: "icehockey",
    variantKey: "iihf",
    home: [{ fullName: `Skins IH Offender ${TAG}` }],
    away: [{ fullName: `Skins IH Susp Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  const offender = fx.personIds[`Skins IH Offender ${TAG}`]!;

  // R6 cutover — v3 has no interactive band picker at all (pad-host.tsx's
  // own `PadHostV3Props` doc: `RecordingChip` replaces it with a worded
  // display/upsell, never an editable control), so the v2 "Card" button's
  // ambiguity with the fidelity band strip's own same-named button does not
  // exist here: the suspension is a per-side TILE, addressed by
  // `data-tile-id`, never by accessible name. class/reason/minutes/servedBy
  // are all steps of ONE guided sheet (`suspensionSheet`, period-shared.ts).
  await v3Tile(page, "suspension-home").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the suspension tile must open the guided sheet").toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="minor"]').click();
  await expect(
    sheet.locator('[data-choice-option-id="tripping"]'),
    "the reason step must follow the class step",
  ).toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="tripping"]').click();

  const minutesField = sheet.getByLabel("Minutes", { exact: true });
  await expect(minutesField, "the minutes step must follow the reason step").toBeVisible({ timeout: 10_000 });
  await minutesField.fill("2");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

  // servedBy — R6/S7 (#427), additive on v3, and distinct from the DOCK's
  // own "person" chip below (`suspensionSheet`'s own comment: "person, the
  // offender, stays on the DOCK … this step is additive, not a replacement
  // for it"). This fixture has only one home player, so servedBy and
  // person end up naming the same offender — same disambiguation this
  // file's own prior v2 version already established for the two attribution
  // fields sharing one full-squad pool.
  const servedByCandidate = sheet.locator(`[data-candidate-id="${offender}"]`);
  await expect(servedByCandidate, "the servedBy step must follow minutes").toBeVisible({ timeout: 10_000 });
  await servedByCandidate.click();
  await expect(sheet, "the sheet must close once servedBy is answered").toHaveCount(0, { timeout: 20_000 });

  // person — the offender, now a Detail Dock chip (`buildDock`'s
  // `e.suspStart` case) rather than a second attribution field on the same
  // form.
  const dock = v3Dock(page);
  await expect(dock, "a suspension always opens the Detail Dock (buildDock's e.suspStart case)").toBeVisible({
    timeout: 10_000,
  });
  await dock.getByRole("button", { name: `Skins IH Offender ${TAG}`, exact: true }).click();
  await sendHeldNow(page);

  await expect
    .poll(
      async () =>
        (await ledger(request, fx.fixtureId)).filter((e) => e.type === "icehockey.suspension.start").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  const susp = (await ledger(request, fx.fixtureId)).find((e) => e.type === "icehockey.suspension.start")!;
  expect(susp.payload).toMatchObject({
    by: fx.homeEntrantId,
    class: "minor",
    reason: "tripping",
    person: offender,
    servedBy: offender,
    minutes: 2,
  });
  await expectNoHorizontalScroll(page);
});

test("football skin: mini-soccer quarters — a QT period marker under the non-default variant", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // S5/#431 — football's quarters half. `mini-soccer` (halves: 4) is the
  // non-default variant the deferred row named; `periodMarkers(cfg)` only
  // offers "QT"/"3QT" when `cfg.halves === 4`, so driving one proves the
  // variant is live on the pad, not merely declared in the engine.
  const fx = await seedRosteredFixture(request, {
    label: `Skins FB Quarters ${TAG}`,
    sportKey: "football",
    variantKey: "mini-soccer",
    home: [{ fullName: `Skins FB Qtr Home ${TAG}` }],
    away: [{ fullName: `Skins FB Qtr Away ${TAG}` }],
  });
  await openLiveConsole(page, fx);

  // R3/task D — v3: ONE "End of period" tile whose sheet asks WHICH break.
  // `periodMarkersOf(cfg)` mirrors the engine's own private `periodMarkers`,
  // so a quarters cfg offers QT/HT/3QT/FT and a halves cfg offers only HT/FT
  // — driving QT through the real sheet is what proves the variant is live on
  // the pad rather than merely declared in the engine, which is exactly what
  // the pre-conversion version of this test proved through the v2 tile.
  await v3Tile(page, "period").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the period tile must open the 'Which break?' sheet").toBeVisible({ timeout: 10_000 });
  await expect(
    sheet.locator('[data-choice-option-id="QT"]'),
    "a quarters cfg must offer the quarter-time marker a halves cfg never can",
  ).toBeVisible();
  await sheet.locator('[data-choice-option-id="QT"]').click();

  await expect
    .poll(
      async () => (await ledger(request, fx.fixtureId)).filter((e) => e.type === "football.period").length,
      { timeout: 20_000 },
    )
    .toBe(1);

  const marker = (await ledger(request, fx.fixtureId)).find((e) => e.type === "football.period")!;
  expect(marker.payload).toEqual({ phase: "QT" });
  await expectNoHorizontalScroll(page);
});
