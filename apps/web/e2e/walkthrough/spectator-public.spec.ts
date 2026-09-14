// Task 15 (spectator W1) — the anonymous match centre, driven as a customer
// would see it: the two cricket matches. Live match A is played through the
// REAL v3 pad (R7: setup may reach a state through the API, but at least one
// over of the cricket match under test is tapped through the real pad, then
// read on the public page — the pad -> ledger -> page seam is proven by
// driving it, never by a fixture on both ends). Match B is finished, seeded
// via `cricket.player.line` (band 2), including Task 18's owed enriched
// batting-only line check on the public Scorecard.
//
// Split out of one combined file (see spectator-public-helpers.ts's header)
// so this file's own run stays comfortably under budget; football, tennis,
// consent, the control-set diff, axe, screens and locale live in
// spectator-public-2.spec.ts instead.
//
// Replaces `e2e/walkthrough/w0-spectator-capture.spec.ts` (deleted — its
// seeding shapes are reused/adapted here, with one real bug fixed: W0 posted
// `core.start` BEFORE `cricket.toss`, which the engine's own
// `case "cricket.toss"` guard 422s ("toss must precede core.start",
// cricket.ts:3372) — W0's own `postEvent` (not `mustPost`) swallowed that
// failure silently, so the toss never actually recorded and `battingFirst`
// fell through to its `"home"` default, which happened to match every W0
// fixture's own choice. This file posts the toss FIRST and checks it with
// `mustPost`.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { activeOrg, apiJson, createStageAndGenerate, fixturePath, TAG } from "../helpers";
import { spectatorSetupBudgetMs } from "../spectator-public-budget";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import {
  type Team,
  mustPost,
  ledger,
  playInnings,
  divisionSlug,
  publicFixturePath,
  makeCricketDivision,
  makeTeams,
  startCricketMatch,
  pad,
  tapBallTile,
  tapWicketBowled,
  pollBallCount,
  anonPage,
  closeOpenContexts,
  shotAllTabs,
  LIVE_UPDATE_BUDGET_MS,
  OUT,
} from "../spectator-public-helpers";

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// shared seeded state
// ---------------------------------------------------------------------------

let orgSlug = "";
let compSlug = "";

// cricket — "live" division (match A)
let liveDivSlug = "";
let matchA = "";
let matchATeams: Team[] = [];

// cricket — "finished" division (match B, band 2)
let finishedDivSlug = "";
let matchB = "";
const matchBEnrichedPersonName = `Task15 Enriched Batter ${TAG}`;
let matchBEnrichedPersonId = "";
const matchBBowlerName = `Falcon 1 ${TAG}`; // falcons.order[0] — credited on the enriched dismissal

// cricket — "upcoming" division (match C): never started, so the court card
// says "Starts …" and the page's subheading says the same time. M1 k2's
// rain-delay check reschedules it.
let upcomingDivSlug = "";
let matchC = "";
/** Match C's seeded kick-off, and the rain-delayed one it is moved to. BOTH
 *  the date and the minute change, so the two rendered strings cannot collide
 *  in any timezone the venue might resolve to (a whole-hour offset preserves
 *  minutes; a half-hour one shifts them, and neither can turn 3 Nov 09:05 into
 *  5 Nov 16:47). */
const MATCH_C_KICK_OFF = "2026-11-03T09:05:00.000Z";
const MATCH_C_RAIN_DELAY = "2026-11-05T16:47:00.000Z";

/** EVERY division the setup stands up, and the config each is created with.
 *  The setup's own clock is derived from this table's SIZE (`SETUP_BUDGET_MS`
 *  below), so a fourth division cannot be added without moving the budget with
 *  it — the flat `180_000` this file used to carry survived M1 k2 adding a
 *  whole third division, in a `mode: "serial"` file where a blown setup aborts
 *  everything after it and reports itself as a data defect (AGENTS.md #20/#21).
 *  `src/lib/__tests__/spectator-walkthrough-budget.test.ts` reds if a division
 *  is created with an inline config instead of an entry here. */
const SETUP_DIVISIONS = {
  /** Match A: 8 overs, 8 a side. Two innings posted ball by ball. */
  live: { name: `Live ${TAG}`, ballsPerInnings: 48, playersPerSide: 8 },
  /** Match B: band 2 (`cricket.player.line`). `playersPerSide` matches the
   *  actual 4-player rosters below — `allOutWickets`'s strict check reads the
   *  real lineup size, not a config value divorced from it (a mismatched 11
   *  here rejected `wickets: 5` as "exceed all-out (3)"). */
  finished: { name: `Finished ${TAG}`, ballsPerInnings: 48, playersPerSide: 4 },
  /** Match C: generated, never played, so its court card still says "Starts …". */
  upcoming: { name: `Upcoming ${TAG}`, ballsPerInnings: 48, playersPerSide: 4 },
} as const;

/** Derived, never typed: see `spectator-public-budget.ts` for the arithmetic
 *  and for why it lives in a module of its own. */
const SETUP_BUDGET_MS = spectatorSetupBudgetMs({ divisions: Object.keys(SETUP_DIVISIONS).length });

test.afterEach(closeOpenContexts);

// ---------------------------------------------------------------------------
// 1. setup — a public competition, cricket "live" (match A) and "finished"
//    (match B) divisions
// ---------------------------------------------------------------------------

test("setup: a public competition with cricket live (match A) and finished (match B) divisions", async ({
  page,
  request,
}) => {
  test.setTimeout(SETUP_BUDGET_MS);
  const org = await activeOrg(page);
  orgSlug = org.slug;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Spectator Walkthrough ${TAG}`,
    ends_on: "2026-12-31",
    visibility: "public",
  });
  if (!comp.data) throw new Error(`competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const compId = comp.data.id;
  compSlug = comp.data.slug;

  // === cricket "live" division — match A: 8 overs, 8 a side ================
  const liveDivId = await makeCricketDivision(request, compId, SETUP_DIVISIONS.live);
  liveDivSlug = await divisionSlug(request, liveDivId);
  matchATeams = await makeTeams(request, liveDivId, [
    {
      name: `Blazers ${TAG}`,
      names: Array.from({ length: 8 }, (_, i) => `Blazer ${i + 1} ${TAG}`),
    },
    {
      name: `Comets ${TAG}`,
      names: Array.from({ length: 8 }, (_, i) => `Comet ${i + 1} ${TAG}`),
    },
  ]);
  const { fixtureIds: liveFixtures } = await createStageAndGenerate(request, liveDivId);
  await apiJson(request, `/api/v1/divisions/${liveDivId}/start`, "POST");
  matchA = liveFixtures[0]!;
  const [blazers, comets] = matchATeams as [Team, Team];
  await startCricketMatch(request, matchA, matchATeams, blazers);
  // Innings config off the SAME table the division was created from, so the
  // two cannot drift (a `playersPerSide` divorced from the real roster is what
  // `allOutWickets` rejects — see `SETUP_DIVISIONS.finished`).
  const liveOvers = {
    ballsPerInnings: SETUP_DIVISIONS.live.ballsPerInnings,
    playersPerSide: SETUP_DIVISIONS.live.playersPerSide,
  };
  await playInnings(request, matchA, blazers, comets, { ...liveOvers, seed: 11 });
  const inn1 = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${matchA}/state`);
  expect(inn1.status, "match A must still be reachable after innings 1").toBe(200);
  // seed=41 (the original choice) leaves the chase only 4 runs short of
  // the target after 27 legal balls (51 vs target 55, from seed=11's own
  // innings-1 total of 54) -- confirmed via trace: the pad's SECOND tap
  // (run4) legitimately completes the chase (201 Created), and the THIRD
  // tap (wide) is then correctly rejected 422 ALREADY_DECIDED by the
  // engine, one short of the ledger count this test polls for. Not a
  // product defect -- the engine is right to refuse a ball after the
  // match is decided. seed=43 stops at 30/0 after 27 balls, a 25-run
  // margin comfortably above the one-over tap sequence's worst case
  // (+14: 1+4+wide1+0+wicket0+2+6), so the chase stays open through
  // every tap.
  await playInnings(request, matchA, comets, blazers, {
    ...liveOvers,
    stopAtLegalBalls: 27,
    seed: 43,
  });

  // === cricket "finished" division — match B: band 2 (cricket.player.line) =
  const finishedDivId = await makeCricketDivision(request, compId, SETUP_DIVISIONS.finished);
  finishedDivSlug = await divisionSlug(request, finishedDivId);
  // The enriched line's person is a real ENTRANT MEMBER from the start — a
  // lineup slot alone isn't enough (a person must be a member of the
  // entrant before a lineup can name them, "lineup contains a person who is
  // not a member of the entrant"), and the roster can't be edited after the
  // match decides (below) either ("lineup is locked once a fixture is
  // decided") — so this is the only point where adding them is possible.
  const finishedTeams = await makeTeams(request, finishedDivId, [
    { name: `Falcons ${TAG}`, names: Array.from({ length: 4 }, (_, i) => `Falcon ${i + 1} ${TAG}`) },
    { name: `Eagles ${TAG}`, names: [...Array.from({ length: 4 }, (_, i) => `Eagle ${i + 1} ${TAG}`), matchBEnrichedPersonName] },
  ]);
  const [falcons, eagles] = finishedTeams as [Team, Team];
  matchBEnrichedPersonId = eagles.order[4]!;
  const { fixtureIds: finishedFixtures } = await createStageAndGenerate(request, finishedDivId);
  await apiJson(request, `/api/v1/divisions/${finishedDivId}/start`, "POST");
  matchB = finishedFixtures[0]!;
  await startCricketMatch(request, matchB, [falcons, eagles], falcons);
  // innings 1 (Falcons bat): coarse totals, then two batting-only lines.
  await mustPost(request, matchB, "cricket.innings.summary", { runs: 130, wickets: 2, legalBalls: 48, partial: false });
  await mustPost(request, matchB, "cricket.player.line", {
    innings: 1,
    person: falcons.order[0],
    batting: { out: true, runs: 60, balls: 40 },
  });
  await mustPost(request, matchB, "cricket.player.line", {
    innings: 1,
    person: falcons.order[1],
    batting: { out: false, runs: 30, balls: 25 },
  });
  // innings 2 (Eagles bat, chase falls short): coarse totals, two batting
  // lines, PLUS a third enriched line (Task 18's owed public-page check —
  // fours + a real dismissal) for a brand-new person so it never collides
  // with `player-line.test.ts`'s own dedupe rule.
  await mustPost(request, matchB, "cricket.innings.summary", { runs: 100, wickets: 3, legalBalls: 48, partial: false });
  await mustPost(request, matchB, "cricket.player.line", {
    innings: 2,
    person: eagles.order[0],
    batting: { out: true, runs: 40, balls: 35 },
  });
  await mustPost(request, matchB, "cricket.player.line", {
    innings: 2,
    person: eagles.order[1],
    batting: { out: false, runs: 20, balls: 18 },
  });
  await mustPost(request, matchB, "cricket.player.line", {
    innings: 2,
    person: matchBEnrichedPersonId,
    batting: {
      out: true,
      runs: 25,
      balls: 20,
      fours: 5,
      dismissal: { kind: "bowled", bowler: falcons.order[0] },
    },
  });
  const bDone = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${matchB}/state`);
  expect(bDone.status, `match B state read -> ${bDone.status}`).toBe(200);

  // === cricket "upcoming" division — match C: generated, never played ======
  // M1 k2 needs a fixture whose court card is still saying "Starts …": every
  // other fixture in this file is in play or decided, and neither of those
  // renders a kick-off time to compare the page's subheading against. Its own
  // division, rather than a second fixture in an existing one, so match A's
  // and match B's seeded worlds (entrant counts, standings, generated fixture
  // order) are untouched.
  const upcomingDivId = await makeCricketDivision(request, compId, SETUP_DIVISIONS.upcoming);
  upcomingDivSlug = await divisionSlug(request, upcomingDivId);
  await makeTeams(request, upcomingDivId, [
    { name: `Kites ${TAG}`, names: Array.from({ length: 4 }, (_, i) => `Kite ${i + 1} ${TAG}`) },
    { name: `Owls ${TAG}`, names: Array.from({ length: 4 }, (_, i) => `Owl ${i + 1} ${TAG}`) },
  ]);
  const { fixtureIds: upcomingFixtures } = await createStageAndGenerate(request, upcomingDivId);
  await apiJson(request, `/api/v1/divisions/${upcomingDivId}/start`, "POST");
  matchC = upcomingFixtures[0]!;
  // A generated fixture has no kick-off time of its own; without one the court
  // card has no status line at all and there would be nothing to compare.
  const scheduled = await apiJson(request, `/api/v1/fixtures/${matchC}`, "PATCH", {
    scheduled_at: MATCH_C_KICK_OFF,
  });
  expect(scheduled.status, `match C schedule -> ${scheduled.status} ${JSON.stringify(scheduled.error)}`).toBe(200);

  expect(
    orgSlug && compSlug && liveDivSlug && matchA && finishedDivSlug && matchB && upcomingDivSlug && matchC,
    "setup produced every id this file needs",
  ).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 2. cricket match A — the anonymous match centre updates live (R7 + R10)
// ---------------------------------------------------------------------------

test("cricket match A: the anonymous match centre updates live as the real pad and API post events (R7 + R10)", async ({
  page,
  browser,
}) => {
  const taps = 7; // 6 legal balls (one a wicket) + 1 wide
  // Fix round 1: +POLL_MS for the extra scorecard-row poll (task-15-review
  // I1) added after the taps below.
  //
  // The four live-update waits below (newest ball, score strip, fall of
  // wickets, scorecard row) each get `LIVE_UPDATE_BUDGET_MS`, so the test's
  // own budget has to carry four of them or a slow poll trips the WALL CLOCK
  // and reports itself as whichever assertion happened to be in flight
  // (AGENTS.md rule #20). Derived, never a literal: raising `POLL_MS` raises
  // this with it.
  const liveWaits = 4;
  test.setTimeout(Math.max(120_000, taps * (HOLD_MS + 2_000) + liveWaits * LIVE_UPDATE_BUDGET_MS + 30_000));

  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);

  // --- open the anonymous context BEFORE the taps, at 320 -------------------
  const anon320 = await anonPage(browser, { width: 320, height: 568 });
  await anon320.goto(matchAPath, { waitUntil: "load" });
  await expect(anon320.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await anon320.getByTestId("mc-tab-commentary").click();
  await expect(anon320.getByTestId("mc-tab-panel-commentary")).toBeVisible();

  const scoreBefore = [
    await anon320.getByTestId("mc-score-0").textContent(),
    await anon320.getByTestId("mc-score-1").textContent(),
  ];
  const fowBefore = await anon320.getByTestId("mc-fow-2").locator('[role="listitem"]').count();

  // Fix round 1 (task-15-review.md I1) -- the THIRD R10 witness (score
  // strip, newest over, scorecard row): find whoever is CURRENTLY on strike
  // via the ledger's own last `cricket.ball` event (the real API state, not
  // a guess) so the pad's first tap below is guaranteed to add a real,
  // provable run to a KNOWN row, whichever way the fold's strike-rotation
  // and over-boundary swaps otherwise move the crease.
  const ledgerBeforeTaps = await ledger(page.request, matchA);
  const priorBall = [...ledgerBeforeTaps].reverse().find((e) => e.type === "cricket.ball");
  const strikerId = priorBall?.payload.striker as string | undefined;
  expect(strikerId, "a striker must already be on strike before the pad taps").toBeTruthy();
  await anon320.getByTestId("mc-tab-scorecard").click();
  // Scoped `mc-bat-<innings position>.<personId>`: a super over reuses an
  // innings number, so two rows once shared one testid. The position is
  // matched as `\d+` rather than pinned, because which innings this striker
  // bats in is the fixture's business, not this test's.
  const strikerRow = anon320.getByTestId(new RegExp(`^mc-bat-\\d+\\.${strikerId}$`));
  await expect(strikerRow, "the current striker must already have a scorecard row").toBeVisible();
  const strikerRunsBefore = await strikerRow.locator("td").nth(1).textContent();
  // back to Commentary -- the taps below assert the newest ball appears there.
  await anon320.getByTestId("mc-tab-commentary").click();
  await expect(anon320.getByTestId("mc-tab-panel-commentary")).toBeVisible();

  // The ball ids ALREADY on screen before a single tap. Without this the
  // assertion after the taps ("the newest ball appeared") was satisfied by
  // balls rendered at page load: it read `.first()` of the ball testids and
  // checked it was visible, which is true of any innings with a ball in it.
  // It stayed green with the live transport deleted entirely.
  const ballIdsBefore = new Set(
    await anon320
      .getByTestId(/^mc-ball-\d+\.\d+\.\d+$/)
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? "")),
  );
  expect(ballIdsBefore.size, "the commentary must already show balls — otherwise 'a NEW ball' proves nothing").toBeGreaterThan(0);

  let loadFired = false;
  anon320.on("load", () => {
    loadFired = true;
  });
  // R10 tests "no navigation" (no reload, no route change), never "the URL
  // string is frozen" -- the test itself switches to the Summary tab below,
  // and `MatchCentre`'s `onChange` legitimately reflects that
  // via `history.replaceState` (match-centre.tsx:72-78, "switching tabs is
  // not a new page in the browser's history sense"). Comparing full hrefs
  // here would fail on the test's OWN deliberate tab click, not on a
  // product defect -- so this pins the PATHNAME (still the same fixture,
  // never a different page) and leaves the `tab=` query out of it.
  const pathBefore = new URL(anon320.url()).pathname;

  // --- tap one over through the real v3 pad in the SIGNED-IN page ----------
  await page.goto(await fixturePath(page.request, matchA));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  let ballsBefore = (await ledger(page.request, matchA)).filter((e) => e.type === "cricket.ball").length;
  const pollTimeout = Math.max(20_000, HOLD_MS + 5_000);

  await tapBallTile(page, "run1");
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);
  await tapBallTile(page, "run4");
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);
  await tapBallTile(page, "wide");
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);
  await tapBallTile(page, "run0");
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);
  await tapWicketBowled(page);
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);
  await tapBallTile(page, "run2");
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);
  await tapBallTile(page, "run6");
  await pollBallCount(page.request, matchA, ++ballsBefore, pollTimeout);

  // --- back on the ALREADY-OPEN anonymous page, without navigating ---------
  // A ball id that was NOT on screen before the taps. The seven taps above
  // each minted a delivery, so at least one new id must arrive by transport
  // alone — the page never navigates. Compared as ids rather than counts: an
  // over that rolls could leave the count unchanged while the content moved.
  await expect
    .poll(
      async () => {
        const now = await anon320
          .getByTestId(/^mc-ball-\d+\.\d+\.\d+$/)
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
        return now.filter((id) => !ballIdsBefore.has(id)).length;
      },
      {
        timeout: LIVE_UPDATE_BUDGET_MS,
        message: "a ball that was not on screen before the taps must arrive on the already-open anonymous page",
      },
    )
    .toBeGreaterThan(0);

  await expect
    .poll(
      async () => [await anon320.getByTestId("mc-score-0").textContent(), await anon320.getByTestId("mc-score-1").textContent()],
      { timeout: LIVE_UPDATE_BUDGET_MS },
    )
    .not.toEqual(scoreBefore);

  await anon320.getByTestId("mc-tab-summary").click();
  await expect(anon320.getByTestId("mc-tab-panel-summary")).toBeVisible();
  await expect
    .poll(async () => anon320.getByTestId("mc-fow-2").locator('[role="listitem"]').count(), { timeout: LIVE_UPDATE_BUDGET_MS })
    .toBeGreaterThan(fowBefore);

  // Fix round 1 (task-15-review.md I1) -- the THIRD R10 witness: the
  // striker's own Scorecard row updates IN PLACE. Tap 1 (`run1`) is odd and
  // is the very first event after `strikerId` was captured, so it MUST add
  // at least one run to this row regardless of whatever strike-rotation the
  // rest of the over does afterward (`playInnings`'s own swap rules, mirrored
  // by the real reducer both the pad and the API share). Read from the DOM,
  // never the API payload.
  await anon320.getByTestId("mc-tab-scorecard").click();
  await expect(anon320.getByTestId("mc-tab-panel-scorecard")).toBeVisible();
  const strikerRowAfter = anon320.getByTestId(new RegExp(`^mc-bat-\\d+\\.${strikerId}$`));
  await expect(strikerRowAfter, "the striker's row must still render after the update").toBeVisible();
  await expect
    .poll(async () => strikerRowAfter.locator("td").nth(1).textContent(), { timeout: LIVE_UPDATE_BUDGET_MS })
    .not.toBe(strikerRunsBefore);

  // Fix round 1 (task-15-review.md I2) -- the positive pair for "no
  // navigation": a fresh document arrived, even though the page never
  // navigated. NOT a before/after TEXT-equality check: caught live on the
  // first real run of this exact assertion -- `mc-updated-at`'s "Updated Ns
  // ago" resets to "Updated 0s ago" on ANY fresh document, so a page that is
  // merely newly loaded and a page that just received a genuinely new one
  // can both read "Updated 0s ago" at the moment each is checked (before
  // !== after is neither necessary -- a real update can leave the STRING
  // unchanged -- nor sufficient -- the ticking clock alone changes it a
  // second later with no update at all). Parsing the elapsed-seconds NUMBER
  // and asserting it is small is real proof: if the client were still
  // showing the page-load-stale document at this point (tens of seconds
  // into the test by now), that number would be large, not small.
  const updatedAtAfter = await anon320.getByTestId("mc-updated-at").textContent();
  // Fix round 2 (task-15-rereview, New Issue #1): `/(\d+)s ago/` only
  // matches the ENGLISH string. Every `matchCentre.updatedAgo` dictionary
  // entry carries exactly one `{seconds}` placeholder and no other digits
  // (en "Updated {seconds}s ago", fr "Mis à jour il y a {seconds}s", es
  // "Actualizado hace {seconds}s", nl "Bijgewerkt {seconds}s geleden") --
  // reading the key's own shape, the first integer anywhere in the label is
  // locale-agnostic. This file never itself changes locale, but a sibling
  // walkthrough file does (spectator-public-2.spec.ts's own locale test),
  // and both now run under CI's real multi-worker scheduling -- matching
  // only the English word "ago" was a real cross-file flake vector even
  // though this file's OWN org is no longer shared with that test (fix
  // round 2 also gave the locale test its own dedicated org); parsing
  // locale-agnostically removes the coupling to WHICH locale happens to be
  // active at all, rather than relying on isolation being perfect forever.
  const secondsAfter = Number(updatedAtAfter?.match(/(\d+)/)?.[1]);
  expect(Number.isFinite(secondsAfter), `mc-updated-at did not parse a number: ${updatedAtAfter}`).toBe(true);
  expect(secondsAfter, "mc-updated-at must show a FRESH elapsed time right after the update, not the page-load-old one").toBeLessThan(
    10,
  );

  // negative pair: same URL, no navigation event, throughout the whole update.
  expect(new URL(anon320.url()).pathname, "the anonymous page must never navigate to a different page").toBe(pathBefore);
  expect(loadFired, "no `load` event may fire — R10 is in-place, never a reload").toBe(false);

  // --- a SECOND anonymous context, opened AFTER the taps, at 1280 ----------
  const anon1280 = await anonPage(browser, { width: 1280, height: 900 });
  await anon1280.goto(matchAPath, { waitUntil: "load" });
  await expect(anon1280.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await anon1280.getByTestId("mc-tab-commentary").click();
  await expect(anon1280.getByTestId(/^mc-ball-\d+\.\d+\.\d+$/).first()).toBeVisible({ timeout: 10_000 });
  await anon1280.getByTestId("mc-tab-summary").click();
  await expect(anon1280.getByTestId("mc-fow-2").locator('[role="listitem"]')).not.toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 3. an enriched batting-only player line posted through the API (Task 18)
// ---------------------------------------------------------------------------

test("cricket: the batting-only player line posted through the API shows on the anonymous Scorecard row (Task 18 owed check)", async ({
  browser,
}) => {
  const matchBPath = publicFixturePath(orgSlug, compSlug, finishedDivSlug, matchB);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchBPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await anon.getByTestId("mc-tab-scorecard").click();
  // innings 2 is the LAST innings — open by default (`ScorecardTab`'s own
  // "the open innings is always the last one" rule), so no accordion click
  // is needed to see this row.
  const row = anon.getByTestId(new RegExp(`^mc-bat-\\d+\\.${matchBEnrichedPersonId}$`));
  await expect(row, "the enriched line's batter row must render").toBeVisible({ timeout: 10_000 });
  // The "bowled" dismissal names the REAL bowler (matchBBowlerName), never
  // "not out" — proves the dismissal Msg resolved, not merely that the row
  // has some text (a not-out batter's row is also non-empty).
  await expect(row, "the dismissal text must name the real bowler").toContainText(matchBBowlerName);
  // Exact cell-text match, not substring: the runs column ("25") also
  // contains the character "5", so a substring filter can silently match
  // the wrong cell.
  const cells = await row.locator("td").allTextContents();
  expect(cells, `the 4s column must show "5" (posted count) — cells: ${JSON.stringify(cells)}`).toContain("5");
});

// ---------------------------------------------------------------------------
// 4. cricket match B (finished) — result, top performers, no live block
// ---------------------------------------------------------------------------

test("cricket match B (finished): result line, two top-performer cards, no live block", async ({ browser }) => {
  const matchBPath = publicFixturePath(orgSlug, compSlug, finishedDivSlug, matchB);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchBPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expect(anon.getByTestId("mc-result-chip")).toBeVisible();
  await expect(anon.getByTestId("mc-status-line")).toBeVisible();
  await expect(anon.getByTestId("mc-live-pill")).toHaveCount(0);
  await expect(anon.getByTestId("mc-tab-panel-summary").getByTestId("mc-live-block")).toHaveCount(0);
  const performers = anon.getByTestId("mc-top-performers").locator("> div");
  await expect(performers).toHaveCount(2);
});

// ---------------------------------------------------------------------------
// 5. cricket match C (upcoming) — M1 k2: ONE kick-off time on the page, and
//    it follows a rain-delay reschedule without a reload
// ---------------------------------------------------------------------------

test("cricket match C (upcoming): the subheading and the court card show the SAME kick-off, and both follow a reschedule with no reload", async ({
  browser,
  request,
}) => {
  // Two live waits (the court card's status line, then the subheading), each
  // allowed `LIVE_UPDATE_BUDGET_MS`. Derived, never a literal: raising
  // `POLL_MS` raises this with it, so a slower poll cannot trip the WALL CLOCK
  // and report itself as whichever assertion happened to be in flight
  // (AGENTS.md rule #20).
  test.setTimeout(Math.max(90_000, 2 * LIVE_UPDATE_BUDGET_MS + 45_000));

  const matchCPath = publicFixturePath(orgSlug, compSlug, upcomingDivSlug, matchC);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchCPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });

  const subheading = anon.getByTestId("mc-subheading");
  const statusLine = anon.getByTestId("mc-status-line");
  await expect(subheading, "an upcoming fixture's page carries the kick-off line").toBeVisible();
  await expect(statusLine, 'an upcoming fixture\'s court card says "Starts …"').toBeVisible();

  // --- M1 k1, as a customer meets it --------------------------------------
  // The live test found this card reading the LITERAL text "Starts {time}":
  // the builder passed `{ when }` to a template that names `{time}`, and
  // `t()` prints an unsupplied placeholder verbatim. A brace anywhere in
  // either line is that defect, whatever the copy around it says.
  const before = {
    subheading: (await subheading.textContent())?.trim() ?? "",
    status: (await statusLine.textContent())?.trim() ?? "",
  };
  expect(before.status, "no unresolved {placeholder} reaches the reader").not.toMatch(/\{\w+\}/);
  expect(before.subheading, "no unresolved {placeholder} reaches the reader").not.toMatch(/\{\w+\}/);

  // --- ONE kick-off, one wording ------------------------------------------
  // The subheading is "<time> · <venue> · <court>", so its first segment is
  // the time; the card's line is "Starts <time>". Character-for-character, or
  // the page is showing one kick-off twice in two formats (and, before M1,
  // two TIMEZONES — the page formatted with no `timeZone` at all).
  const timeOf = (line: string) => line.split(" · ")[0]!.trim();
  expect(
    before.status,
    `the card ("${before.status}") must carry the subheading's own time ("${timeOf(before.subheading)}")`,
  ).toContain(timeOf(before.subheading));

  // A marker that only survives if the page is never reloaded or navigated.
  // Without it "both lines show the new time" would also pass on a full
  // document reload, which is the one thing rule R10 forbids.
  await anon.evaluate(() => {
    (window as unknown as { __m1NoReload?: number }).__m1NoReload = 1;
  });

  // --- the rain delay ------------------------------------------------------
  const moved = await apiJson(request, `/api/v1/fixtures/${matchC}`, "PATCH", {
    scheduled_at: MATCH_C_RAIN_DELAY,
  });
  expect(moved.status, `reschedule -> ${moved.status} ${JSON.stringify(moved.error)}`).toBe(200);

  // The card moves first (it is the surface that already polled); the
  // subheading is the line M1 k2 added to the same document, so it must move
  // on the SAME snapshot rather than on the next page load.
  await expect
    .poll(async () => (await statusLine.textContent())?.trim() ?? "", {
      timeout: LIVE_UPDATE_BUDGET_MS,
      message: "the court card must pick up the new kick-off from a poll/push",
    })
    .not.toBe(before.status);
  await expect
    .poll(async () => (await subheading.textContent())?.trim() ?? "", {
      timeout: LIVE_UPDATE_BUDGET_MS,
      message: "the subheading must pick up the new kick-off too — this is the k2 defect",
    })
    .not.toBe(before.subheading);

  const after = {
    subheading: (await subheading.textContent())?.trim() ?? "",
    status: (await statusLine.textContent())?.trim() ?? "",
  };
  expect(after.status).not.toMatch(/\{\w+\}/);
  expect(after.subheading).not.toMatch(/\{\w+\}/);
  // Still ONE time after the move — a subheading that re-rendered from some
  // second formatter would satisfy "it changed" and still disagree with the
  // card.
  expect(
    after.status,
    `after the reschedule the card ("${after.status}") must still carry the subheading's time ("${timeOf(after.subheading)}")`,
  ).toContain(timeOf(after.subheading));

  // …and none of it was a reload.
  expect(
    await anon.evaluate(() => (window as unknown as { __m1NoReload?: number }).__m1NoReload),
    "the page must never have reloaded — rule R10 is an IN-PLACE update",
  ).toBe(1);
});

// ---------------------------------------------------------------------------
// 6. screens — match B (finished), every tab at 320/768/1280 (task-15-review
//    I4: the brief's "live and final" pairing needs BOTH; match B only
//    exists in this file's own seeded competition, so its screenshots live
//    here rather than in spectator-public-2.spec.ts's own "screens" test)
// ---------------------------------------------------------------------------

test("screens: match B (finished) — every tab at 320/768/1280", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const matchBPath = publicFixturePath(orgSlug, compSlug, finishedDivSlug, matchB);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchBPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await shotAllTabs(anon, testInfo, "match-b", [320, 768, 1280]);
});
