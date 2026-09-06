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
import { activeOrg, apiJson, createStageAndGenerate, fixturePath, TAG } from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { POLL_MS } from "../../src/components/public-site/match-centre/use-live-fixture";
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
} from "./spectator-public-helpers";

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

test.afterEach(closeOpenContexts);

// ---------------------------------------------------------------------------
// 1. setup — a public competition, cricket "live" (match A) and "finished"
//    (match B) divisions
// ---------------------------------------------------------------------------

test("setup: a public competition with cricket live (match A) and finished (match B) divisions", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
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
  const liveDivId = await makeCricketDivision(request, compId, {
    name: `Live ${TAG}`,
    ballsPerInnings: 48,
    playersPerSide: 8,
  });
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
  await playInnings(request, matchA, blazers, comets, { ballsPerInnings: 48, playersPerSide: 8, seed: 11 });
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
    ballsPerInnings: 48,
    playersPerSide: 8,
    stopAtLegalBalls: 27,
    seed: 43,
  });

  // === cricket "finished" division — match B: band 2 (cricket.player.line) =
  const finishedDivId = await makeCricketDivision(request, compId, {
    name: `Finished ${TAG}`,
    ballsPerInnings: 48,
    // Matches the actual 4-player rosters below — `allOutWickets`'s strict
    // check reads the real lineup size, not a config value divorced from it
    // (a mismatched 11 here rejected `wickets: 5` as "exceed all-out (3)").
    playersPerSide: 4,
  });
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

  expect(
    orgSlug && compSlug && liveDivSlug && matchA && finishedDivSlug && matchB,
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
  test.setTimeout(Math.max(120_000, taps * (HOLD_MS + 2_000) + POLL_MS + 30_000));

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
  await expect(
    anon320.getByTestId(/^mc-ball-\d+\.\d+\.\d+$/).first(),
    "the newest ball must appear on the already-open anonymous page within one poll interval",
  ).toBeVisible({ timeout: POLL_MS + 5_000 });

  await expect
    .poll(
      async () => [await anon320.getByTestId("mc-score-0").textContent(), await anon320.getByTestId("mc-score-1").textContent()],
      { timeout: POLL_MS + 5_000 },
    )
    .not.toEqual(scoreBefore);

  await anon320.getByTestId("mc-tab-summary").click();
  await expect(anon320.getByTestId("mc-tab-panel-summary")).toBeVisible();
  await expect
    .poll(async () => anon320.getByTestId("mc-fow-2").locator('[role="listitem"]').count(), { timeout: POLL_MS + 5_000 })
    .toBeGreaterThan(fowBefore);

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
  const row = anon.getByTestId(`mc-bat-${matchBEnrichedPersonId}`);
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
