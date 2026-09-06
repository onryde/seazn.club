// Task 15 (spectator W1) — the anonymous match centre: football's
// Timeline/Sets(periods) tabs, tennis's Sets tab, consent masking, the
// 320-vs-1280 control-set diff with 44px tab hit-targets, an axe pass,
// screenshots, and the French locale. Split out of one combined file (see
// spectator-public-helpers.ts's header) so this file's own run stays
// comfortably under budget; the two cricket matches (A tapped through the
// real pad, B finished) live in spectator-public.spec.ts instead.
//
// This file seeds its OWN public competition and its own "live" cricket
// division (same recipe spectator-public.spec.ts verified — seed=43 keeps
// the chase open after 27 legal balls) purely through the API: the R7
// pad-driving requirement is already satisfied once by
// spectator-public.spec.ts's own match A, so widths/axe/screens/locale only
// need a genuinely live match to READ, not a second pad-tap proof.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { activeOrg, apiJson, createStageAndGenerate, expectNoHorizontalScroll, setOrgLocaleSql, TAG } from "../helpers";
import { scanPadContrast } from "../scorepad-a11y-kit";
import { POLL_MS } from "../../src/components/public-site/match-centre/use-live-fixture";
import { maskDisplayName } from "../../src/lib/name-display";
import {
  type Team,
  mustPost,
  playInnings,
  fixtureSides,
  divisionSlug,
  publicFixturePath,
  makeCricketDivision,
  makeTeams,
  startCricketMatch,
  createPerson,
  createPersons,
  anonPage,
  closeOpenContexts,
  shotAllTabs,
  shotAtWidths,
  controlSet,
  centreHits,
  OUT,
} from "./spectator-public-helpers";

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// shared seeded state
// ---------------------------------------------------------------------------

let orgSlug = "";
let compSlug = "";

// cricket — "live" division, seeded purely through the API (no pad tap
// needed here — R7's pad-driving proof already lives in
// spectator-public.spec.ts's own match A)
let liveDivSlug = "";
let matchA = "";
let matchATeams: Team[] = [];

// cricket — "consent" division
let consentDivSlug = "";
let matchC = "";
const maskedFullName = `Priya Consent ${TAG}`;
let maskedPersonId = "";

// football
let footballDivSlug = "";
let footballFixture = "";
let footballHome = "";
let footballAway = "";

// tennis
let tennisDivSlug = "";
let tennisFixture = "";

test.afterEach(closeOpenContexts);

// ---------------------------------------------------------------------------
// 1. setup — a public competition, a live cricket division, football, tennis
//    and consent divisions
// ---------------------------------------------------------------------------

test("setup: a public competition with a live cricket division, football, tennis and consent divisions", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const org = await activeOrg(page);
  orgSlug = org.slug;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Spectator Walkthrough Two ${TAG}`,
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
  // seed=43 (verified in spectator-public.spec.ts, whose own match A hit
  // an ALREADY_DECIDED 422 with the original seed=41 -- that seed leaves
  // the chase only 4 runs short of target after 27 balls) stops at 30/0,
  // a comfortable margin below the target, so this file's own live match
  // stays genuinely "in_play" for widths/axe/screens/locale to read.
  await playInnings(request, matchA, comets, blazers, {
    ballsPerInnings: 48,
    playersPerSide: 8,
    stopAtLegalBalls: 27,
    seed: 43,
  });

  // === cricket "consent" division — masked person, deterministic script ====
  const consentDivId = await makeCricketDivision(request, compId, {
    name: `Consent ${TAG}`,
    ballsPerInnings: 12,
    playersPerSide: 4,
  });
  consentDivSlug = await divisionSlug(request, consentDivId);
  maskedPersonId = await createPerson(request, maskedFullName, true);
  const homeNames = [maskedFullName, `Consent Home 2 ${TAG}`, `Consent Home 3 ${TAG}`, `Consent Home 4 ${TAG}`];
  const homeIds = [maskedPersonId, ...(await createPersons(request, homeNames.slice(1)))];
  const awayIds = await createPersons(
    request,
    Array.from({ length: 4 }, (_, i) => `Consent Away ${i + 1} ${TAG}`),
  );
  const consentEnts = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${consentDivId}/entrants`, "POST", [
    { kind: "team", display_name: `Consent Home ${TAG}`, seed: 1, members: homeIds.map((person_id) => ({ person_id })) },
    { kind: "team", display_name: `Consent Away ${TAG}`, seed: 2, members: awayIds.map((person_id) => ({ person_id })) },
  ]);
  if (!consentEnts.data || consentEnts.data.length !== 2) {
    throw new Error(`consent entrants -> ${consentEnts.status} ${JSON.stringify(consentEnts.error)}`);
  }
  const consentHome: Team = { name: "Consent Home", entrantId: consentEnts.data[0]!.id, order: homeIds };
  const consentAway: Team = { name: "Consent Away", entrantId: consentEnts.data[1]!.id, order: awayIds };
  const { fixtureIds: consentFixtures } = await createStageAndGenerate(request, consentDivId);
  await apiJson(request, `/api/v1/divisions/${consentDivId}/start`, "POST");
  matchC = consentFixtures[0]!;
  await startCricketMatch(request, matchC, [consentHome, consentAway], consentHome);

  // innings 1 (Consent Home bat) — masked player is the opener, hits 10
  // off 4 (only even run values so strike never rotates away from her),
  // then bowled by away.order[0]. Only even values are used so strike stays
  // with her; the incoming batter finishes the over.
  const a0 = consentAway.order[0]!;
  const a1 = consentAway.order[1]!;
  const h1 = consentHome.order[1]!;
  const h2 = consentHome.order[2]!;
  await mustPost(request, matchC, "cricket.ball", {
    over: 0,
    ballInOver: 1,
    striker: maskedPersonId,
    nonStriker: h1,
    bowler: a0,
    runs: { bat: 4 },
    boundary: 4,
  });
  await mustPost(request, matchC, "cricket.ball", {
    over: 0,
    ballInOver: 2,
    striker: maskedPersonId,
    nonStriker: h1,
    bowler: a0,
    runs: { bat: 0 },
  });
  await mustPost(request, matchC, "cricket.ball", {
    over: 0,
    ballInOver: 3,
    striker: maskedPersonId,
    nonStriker: h1,
    bowler: a0,
    runs: { bat: 6 },
    boundary: 6,
  });
  await mustPost(request, matchC, "cricket.ball", {
    over: 0,
    ballInOver: 4,
    striker: maskedPersonId,
    nonStriker: h1,
    bowler: a0,
    runs: { bat: 0 },
  });
  await mustPost(request, matchC, "cricket.ball", {
    over: 0,
    ballInOver: 5,
    striker: maskedPersonId,
    nonStriker: h1,
    bowler: a0,
    runs: { bat: 0 },
    wicket: { kind: "bowled", out: maskedPersonId, bowlerCredited: true, incoming: h2 },
  });
  await mustPost(request, matchC, "cricket.ball", {
    over: 0,
    ballInOver: 6,
    striker: h2,
    nonStriker: h1,
    bowler: a0,
    runs: { bat: 0 },
  });
  // over 2 (a1 bowls — a0 cannot bowl consecutive overs): trivial fill. The
  // fold swaps ends at EVERY over boundary (not just on an odd-run ball) —
  // over 1 ended on ball 6 with striker=h2/nonStriker=h1, so over 2 opens
  // swapped: striker=h1/nonStriker=h2. Tracked explicitly rather than by a
  // formula, which is what produced the "striker/non-striker do not match
  // the ledger" 422 this comment replaces.
  let s2 = h1;
  let ns2 = h2;
  for (let i = 1; i <= 6; i++) {
    const bat = i === 1 || i === 3 || i === 5 ? 1 : 0;
    await mustPost(request, matchC, "cricket.ball", {
      over: 1,
      ballInOver: i,
      striker: s2,
      nonStriker: ns2,
      bowler: a1,
      runs: { bat },
    });
    if (bat % 2 === 1) {
      const t = s2;
      s2 = ns2;
      ns2 = t;
    }
  }

  // innings 2 (Consent Away bat, Consent Home bowl) — masked player bowls
  // over 1 (openers are lineup order[0]/order[1] EXACTLY for ball 1, but the
  // BOWLER is a free pick on ball 1 — see scorepad-v3-cricket.spec.ts's own
  // comment on this exact rule). Every ball is even runs, so there is no
  // ODD-run swap inside the over — only the over-boundary one.
  const [away0, away1] = [consentAway.order[0]!, consentAway.order[1]!];
  for (let i = 1; i <= 6; i++) {
    await mustPost(request, matchC, "cricket.ball", {
      over: 0,
      ballInOver: i,
      striker: away0,
      nonStriker: away1,
      bowler: maskedPersonId,
      runs: { bat: i === 3 ? 2 : 0 },
    });
  }
  // Over boundary swap (see the comment above the innings-1 over-2 fix):
  // over 1 ended with striker=away0/nonStriker=away1 throughout (no odd
  // runs), so over 2 opens swapped.
  for (let i = 1; i <= 6; i++) {
    await mustPost(request, matchC, "cricket.ball", {
      over: 1,
      ballInOver: i,
      striker: away1,
      nonStriker: away0,
      bowler: h1,
      runs: { bat: 0 },
    });
  }

  // === football division — Timeline + Sets(periods) =========================
  const fdiv = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: `Football ${TAG}`,
    sport_key: "football",
    variant_key: "11-a-side",
  });
  if (!fdiv.data) throw new Error(`football division -> ${fdiv.status} ${JSON.stringify(fdiv.error)}`);
  footballDivSlug = fdiv.data.slug;
  const fents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${fdiv.data.id}/entrants`, "POST", [
    { kind: "team", display_name: `Hawks ${TAG}`, seed: 1 },
    { kind: "team", display_name: `Town ${TAG}`, seed: 2 },
  ]);
  if (!fents.data || fents.data.length !== 2) {
    throw new Error(`football entrants -> ${fents.status} ${JSON.stringify(fents.error)}`);
  }
  const { fixtureIds: footballFixtures } = await createStageAndGenerate(request, fdiv.data.id);
  await apiJson(request, `/api/v1/divisions/${fdiv.data.id}/start`, "POST");
  footballFixture = footballFixtures[0]!;
  const fsides = await fixtureSides(request, footballFixture);
  footballHome = fsides.home;
  footballAway = fsides.away;
  await mustPost(request, footballFixture, "core.start", {});
  await mustPost(request, footballFixture, "football.goal", { by: footballHome });
  await mustPost(request, footballFixture, "football.period", { phase: "HT" });

  // === tennis division — Sets ================================================
  const tdiv = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: `Tennis ${TAG}`,
    sport_key: "tennis",
    variant_key: "tour",
  });
  if (!tdiv.data) throw new Error(`tennis division -> ${tdiv.status} ${JSON.stringify(tdiv.error)}`);
  tennisDivSlug = tdiv.data.slug;
  const tents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${tdiv.data.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Player One ${TAG}`, seed: 1 },
    { kind: "individual", display_name: `Player Two ${TAG}`, seed: 2 },
  ]);
  if (!tents.data || tents.data.length !== 2) {
    throw new Error(`tennis entrants -> ${tents.status} ${JSON.stringify(tents.error)}`);
  }
  const { fixtureIds: tennisFixtures } = await createStageAndGenerate(request, tdiv.data.id);
  await apiJson(request, `/api/v1/divisions/${tdiv.data.id}/start`, "POST");
  tennisFixture = tennisFixtures[0]!;
  const tsides = await fixtureSides(request, tennisFixture);
  await mustPost(request, tennisFixture, "core.start", {});
  for (let i = 0; i < 3; i++) await mustPost(request, tennisFixture, "tennis.point", { by: tsides.home });
  await mustPost(request, tennisFixture, "tennis.point", { by: tsides.away });

  expect(
    orgSlug && compSlug && liveDivSlug && matchA && consentDivSlug && matchC && footballFixture && tennisFixture,
    "setup produced every id this file needs",
  ).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 2. football — Timeline + Sets(periods), updated live after an API goal
// ---------------------------------------------------------------------------

test("football: Timeline and Sets/Periods tabs render by presence and update in place after an API goal", async ({
  browser,
  request,
}) => {
  test.setTimeout(60_000 + POLL_MS + 10_000);
  const footballPath = publicFixturePath(orgSlug, compSlug, footballDivSlug, footballFixture);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(footballPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expect(anon.getByTestId("mc-tab-timeline")).toBeVisible();
  await expect(anon.getByTestId("mc-tab-sets")).toBeVisible();
  await expect(anon.getByTestId("mc-tab-scorecard")).toHaveCount(0);

  await anon.getByTestId("mc-tab-timeline").click();
  await expect(anon.getByTestId("mc-tab-panel-timeline")).toBeVisible();
  const lineCountBefore = await anon.getByTestId(/^mc-timeline-line-\d+$/).count();
  const urlBefore = anon.url();
  let loadFired = false;
  anon.on("load", () => {
    loadFired = true;
  });

  await mustPost(request, footballFixture, "football.goal", { by: footballAway });

  await expect
    .poll(async () => anon.getByTestId(/^mc-timeline-line-\d+$/).count(), { timeout: POLL_MS + 5_000 })
    .toBeGreaterThan(lineCountBefore);
  expect(anon.url()).toBe(urlBefore);
  expect(loadFired).toBe(false);

  await anon.getByTestId("mc-tab-sets").click();
  await expect(anon.getByTestId("mc-tab-panel-sets")).toBeVisible();
  await expect(anon.getByTestId("mc-sets-col-0")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. tennis — the Sets tab, one column per set
// ---------------------------------------------------------------------------

test("tennis: the Sets tab is present with one column per set", async ({ browser }) => {
  const tennisPath = publicFixturePath(orgSlug, compSlug, tennisDivSlug, tennisFixture);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(tennisPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expect(anon.getByTestId("mc-tab-sets")).toBeVisible();
  await anon.getByTestId("mc-tab-sets").click();
  await expect(anon.getByTestId("mc-sets-col-0")).toBeVisible();
  await expect(anon.getByTestId(/^mc-sets-col-\d+$/)).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 4. consent — masked, never blank, positive + negative pair
// ---------------------------------------------------------------------------

test("consent: a masked person appears masked, never blank, across batting, bowling, FoW, partnerships and top performers", async ({
  browser,
}) => {
  const matchCPath = publicFixturePath(orgSlug, compSlug, consentDivSlug, matchC);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchCPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });

  // Derived from the REAL resolver (name-display.ts), never a typed table:
  // `maskedFullName` carries the random per-run TAG as its last word (e.g.
  // "Priya Consent mtp1a2b3"), so the masked initial is the TAG's own first
  // character, not "C." for "Consent" -- a fixed "Priya C." here would only
  // pass on the runs where TAG happened to start with "c".
  const maskedLabel = maskDisplayName(maskedFullName, "first_initial");

  // --- Summary: FoW, partnerships, top performers ---------------------------
  await expect(anon.getByTestId("mc-fow-1")).toContainText(maskedLabel);
  await expect(anon.getByTestId("mc-partnerships-1")).toContainText(maskedLabel);
  await expect(anon.getByTestId("mc-top-performers")).toContainText(maskedLabel);
  await expect(anon.locator("body")).not.toContainText(maskedFullName);

  // --- Commentary: the ball-by-ball lines mention her, masked --------------
  // She bats in innings 0's over 0 (dismissed) and bowls in innings 1's own
  // over 0 -- NEITHER is the newest over posted (innings 1's over 1, a
  // trivial fill bowled by someone else, is), so `.first()` on the over
  // sections would resolve to an over that never mentions her at all. This
  // checks the whole commentary panel instead of guessing which over is
  // "first".
  await anon.getByTestId("mc-tab-commentary").click();
  const commentaryPanel = anon.getByTestId("mc-tab-panel-commentary");
  await expect(commentaryPanel).toBeVisible();
  await expect(commentaryPanel).toContainText(maskedLabel);
  await expect(anon.locator("body")).not.toContainText(maskedFullName);

  // --- Scorecard: batting (innings 1, needs its accordion opened — only the
  // LAST innings is open by default) and bowling (innings 2, open already) --
  await anon.getByTestId("mc-tab-scorecard").click();
  await expect(anon.getByTestId("mc-tab-panel-scorecard")).toBeVisible();
  await anon.getByTestId("mc-innings-1").locator("summary").click();
  const batRow = anon.getByTestId(`mc-bat-${maskedPersonId}`);
  await expect(batRow, "a masked batter must render a real row, never blank").toBeVisible();
  await expect(batRow).toContainText(maskedLabel);
  const bowlRow = anon.getByTestId(`mc-bowl-${maskedPersonId}`);
  await expect(bowlRow, "a masked bowler must render a real row, never blank").toBeVisible();
  await expect(bowlRow).toContainText(maskedLabel);
  await expect(anon.locator("body")).not.toContainText(maskedFullName);
});

// ---------------------------------------------------------------------------
// 5. widths — control-set diff, tab reachability, 44px hit targets, no scroll
// ---------------------------------------------------------------------------

test("widths 320 vs 1280: control-set diff, every tab reachable, 44px tab hit targets, no horizontal scroll", async ({
  browser,
}) => {
  // PRODUCT DEFECT, not a test bug -- recorded here with evidence, not
  // fixed (tab-rail.tsx is Task 10's, out of Task 15's scope): the tab
  // rail's buttons (`ACTIVE_CLASS`/`INACTIVE_CLASS` in
  // src/components/public-site/match-centre/tab-rail.tsx, `py-1.5` +
  // `text-sm`) measure ~32px tall at 320px width via `boundingBox()` --
  // short of the 44px minimum tap target R11 requires. Previously
  // undiscovered: every prior run of this walkthrough aborted earlier
  // (match A's seed bug, fixed above) before serial execution ever
  // reached this test. The assertion below is left intact, unweakened, so
  // this test starts passing again on its own once tab-rail.tsx is fixed.
  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 320, height: 568 });
  await anon.goto(matchAPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(anon);
  const controls320 = await controlSet(anon);

  await anon.setViewportSize({ width: 1280, height: 900 });
  await anon.waitForTimeout(200);
  await expectNoHorizontalScroll(anon);
  const controls1280 = await controlSet(anon);

  expect(controls1280, "R1: the SAME control set at 320 and 1280 — membership, order, repeats").toEqual(controls320);

  // every tab reachable + visible when clicked, and a real 44px tap target.
  const tabTestIds = await anon.locator('[role="tab"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(tabTestIds.length, "at least one tab must render").toBeGreaterThan(0);
  for (const testId of tabTestIds) {
    if (!testId) continue;
    const box = await anon.getByTestId(testId).boundingBox();
    expect(box, `${testId} has no layout box`).not.toBeNull();
    expect(box!.height, `${testId} must be at least 44px tall`).toBeGreaterThanOrEqual(44);
    expect(await centreHits(anon, testId), `${testId}'s own centre must resolve back to it via elementFromPoint`).toBe(true);
    await anon.getByTestId(testId).click();
    const panelId = testId.replace("mc-tab-", "mc-tab-panel-");
    await expect(anon.getByTestId(panelId), `${panelId} must be visible once its tab is clicked`).toBeVisible();
    await expectNoHorizontalScroll(anon);
  }
});

// ---------------------------------------------------------------------------
// 5b. tab deep link — `?tab=` is read client-side (Task 14d) and still
// selects the right tab on an anonymous, cold visit; an unknown value falls
// back to the document's first tab rather than rendering blank or crashing.
// ---------------------------------------------------------------------------

test("tab deep link: ?tab=scorecard lands on Scorecard; an unknown ?tab=nope falls back to the first tab", async ({
  browser,
}) => {
  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 320, height: 568 });

  await anon.goto(`${matchAPath}?tab=scorecard`, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expect(anon.getByTestId("mc-tab-scorecard"), "the scorecard tab must end up selected").toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 10_000 },
  );
  await expect(anon.locator('[role="tab"][aria-selected="true"]'), "exactly one tab is ever selected").toHaveCount(1);
  await expect(anon.getByTestId("mc-tab-panel-scorecard")).toBeVisible();

  // An unknown `?tab=` value is not a valid tab id -- `initialTab` falls
  // back to `tabs[0]` (match-centre.tsx) rather than rendering nothing.
  await anon.goto(`${matchAPath}?tab=nope`, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expect(anon.getByTestId("mc-tab-summary"), "an unknown tab falls back to the first tab").toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 10_000 },
  );
  await expect(anon.locator('[role="tab"][aria-selected="true"]'), "exactly one tab is ever selected").toHaveCount(1);
  await expect(anon.getByTestId("mc-tab-panel-summary")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. axe — zero serious/critical at 320
// ---------------------------------------------------------------------------

test("axe: the match centre at 320 has zero serious/critical violations", async ({ browser }) => {
  // PRODUCT DEFECT, not a test bug -- recorded here with evidence, not
  // fixed (Task 10's court-card and stat-card styling, out of Task 15's
  // scope): axe reports two SERIOUS color-contrast violations at 320,
  // previously undiscovered because every prior run aborted earlier
  // (match A's seed bug, fixed above) before serial execution ever
  // reached this test.
  //   1. `mc-updated-at` ("Updated 0s ago", court-card.tsx) --
  //      `text-court-muted/70` at 11px on the court card's dark `bg-court`
  //      background measures 4.09:1, short of WCAG AA's 4.5:1 for text
  //      this small.
  //   2. The bowling-figure labels ("SR 104.5", "Econ 6.5", ...) at 12px --
  //      `text-ink-muted/80` on white `bg-surface` cards measures 3.45:1,
  //      also short of 4.5:1. Four such nodes on this one page (repeated
  //      per stat card).
  // The assertion below is left intact, unweakened, so this test starts
  // passing again on its own once those two styles are fixed.
  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 320, height: 568 });
  await anon.goto(matchAPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-root")).toBeVisible({ timeout: 20_000 });
  const scan = await scanPadContrast(anon, '[data-testid="mc-root"]', { padMarker: null });
  expect(scan.serious, JSON.stringify(scan.serious, null, 2)).toEqual([]);
});

// ---------------------------------------------------------------------------
// 7. screens — every tab at 320/768/1280 for match A (live) and the tennis
//    fixture (match B, "final", is shot from spectator-public.spec.ts
//    instead — it's seeded in a different competition there)
// ---------------------------------------------------------------------------

test("screens: every tab at 320/768/1280 for match A (live) and the tennis fixture", async ({ browser }, testInfo) => {
  // Fix round 1 (task-15-review.md I4): 320/768/1280 for EVERY tab, via the
  // real pinned `screenshotAtWidths` (wrapped as `shotAllTabs`/`shotAtWidths`
  // -- see spectator-public-helpers.ts), committed under
  // `__screens__/spectator-w1/walkthrough/` (Task 19's own convention).
  // Match B (finished) is shot from spectator-public.spec.ts instead, where
  // it's actually seeded -- this file's own competition has no band-2 match.
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const WIDTHS = [320, 768, 1280];

  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchAPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await shotAtWidths(anon, testInfo, "match-a-page", WIDTHS);
  await shotAllTabs(anon, testInfo, "match-a", WIDTHS);

  const footballPath = publicFixturePath(orgSlug, compSlug, footballDivSlug, footballFixture);
  await anon.goto(footballPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await shotAllTabs(anon, testInfo, "football", WIDTHS);

  const tennisPath = publicFixturePath(orgSlug, compSlug, tennisDivSlug, tennisFixture);
  await anon.goto(tennisPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await shotAllTabs(anon, testInfo, "tennis", WIDTHS);
});

// ---------------------------------------------------------------------------
// 8. locale — MUST run last: flips a French-locale org's default_locale,
// which affects every fixture under it.
// ---------------------------------------------------------------------------

// `getPublicFixture` caches its org/division/fixture read for
// `REVALIDATE_FAST` seconds (data.ts:138, currently 30) tagged by division —
// `setOrgLocaleSql` below writes `organizations.default_locale` straight
// through SQL (the fast, sanctioned way to REACH a state per R7/R10's own
// setup convention) with no matching `revalidateTag` call, so a request
// against an ALREADY-CACHED division could still serve a stale read. A real
// org owner flipping locale through the actual settings UI would go through
// a mutation that revalidates the tag; this raw-SQL shortcut does not.
// Budget the wait from that same constant (never a flat guess) rather than
// hardcoding a number that would silently drift if REVALIDATE_FAST changes.
// Kept as a safety net even though THIS test's own division (below) has
// never been read publicly before the flip, so the cache should be cold and
// the very first poll should already see French.
const LOCALE_CACHE_BUDGET_MS = 30_000 /* data.ts REVALIDATE_FAST, seconds->ms */ + 20_000; // safety margin

test("locale: a French-locale org renders French tab labels and status words, English literals absent", async ({
  browser,
  request,
}) => {
  test.setTimeout(LOCALE_CACHE_BUDGET_MS + 60_000);
  // Fix round 2 (task-15-rereview, New Issue #1): this test used to flip
  // the SHARED walkthrough org's `default_locale` -- the same org
  // `spectator-public.spec.ts` reads via its own `activeOrg()`. CI runs the
  // `walkthrough` project at `--workers=3` with `fullyParallel: true`
  // (`e2e.yml:206`, `playwright.config.ts:126,164-168`), so that file could
  // read the org mid-flip. A dedicated org -- created and activated here,
  // read by NOTHING else -- makes the mutation invisible to any other file
  // regardless of scheduling, rather than merely narrowing the window.
  const localeOrg = await apiJson<{ id: string; slug: string }>(request, "/api/orgs", "POST", {
    name: `Spectator Locale ${TAG}`,
  });
  if (!localeOrg.data) throw new Error(`locale org -> ${localeOrg.status} ${JSON.stringify(localeOrg.error)}`);
  const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: localeOrg.data.id });
  expect(activated.status, `activate locale org -> ${activated.status}`).toBeLessThan(300);

  const localeComp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Locale Walkthrough ${TAG}`,
    ends_on: "2026-12-31",
    visibility: "public",
  });
  if (!localeComp.data) throw new Error(`locale competition -> ${localeComp.status} ${JSON.stringify(localeComp.error)}`);
  // Minimal band-3 fixture (same recipe mobile.spec.ts's own public
  // match-centre fixture uses): toss before core.start, then ONE
  // `cricket.ball` -- enough real batting/over data to put every tab
  // (Summary/Scorecard/Commentary/Info) on the page, which is what this
  // test needs to check every tab's own label.
  const localeDivId = await makeCricketDivision(request, localeComp.data.id, {
    name: `Locale ${TAG}`,
    ballsPerInnings: 12,
    playersPerSide: 2,
  });
  const localeDivSlug = await divisionSlug(request, localeDivId);
  const localeTeams = await makeTeams(request, localeDivId, [
    { name: `Locale Home ${TAG}`, names: [`Locale Home 1 ${TAG}`, `Locale Home 2 ${TAG}`] },
    { name: `Locale Away ${TAG}`, names: [`Locale Away 1 ${TAG}`, `Locale Away 2 ${TAG}`] },
  ]);
  const [localeHome, localeAway] = localeTeams as [Team, Team];
  const { fixtureIds: localeFixtures } = await createStageAndGenerate(request, localeDivId);
  await apiJson(request, `/api/v1/divisions/${localeDivId}/start`, "POST");
  const localeFixtureId = localeFixtures[0]!;
  await startCricketMatch(request, localeFixtureId, localeTeams, localeHome);
  await mustPost(request, localeFixtureId, "cricket.ball", {
    over: 0,
    ballInOver: 1,
    striker: localeHome.order[0],
    nonStriker: localeHome.order[1],
    bowler: localeAway.order[0],
    runs: { bat: 4 },
    boundary: 4,
  });

  await setOrgLocaleSql(localeOrg.data.id, "fr");
  const localeFixturePath = publicFixturePath(localeOrg.data.slug, localeComp.data.slug, localeDivSlug, localeFixtureId);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(localeFixturePath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });

  // Poll by RE-NAVIGATING (a plain `expect.poll` on the existing DOM would
  // never see a locale change baked into server-rendered HTML) -- see the
  // cache comment above for why this should resolve on its first iteration.
  await expect
    .poll(
      async () => {
        await anon.goto(localeFixturePath, { waitUntil: "load" });
        return anon.getByTestId("mc-tab-summary").textContent();
      },
      { timeout: LOCALE_CACHE_BUDGET_MS, intervals: [2_000] },
    )
    .toBe("Résumé");

  await expect(anon.getByTestId("mc-tab-summary")).toHaveText("Résumé");
  await expect(anon.getByTestId("mc-tab-scorecard")).toHaveText("Feuille de match");
  await expect(anon.getByTestId("mc-tab-commentary")).toHaveText("Commentaire");
  await expect(anon.getByTestId("mc-tab-info")).toHaveText("Infos");
  await expect(anon.getByTestId("mc-live-pill")).toContainText("En direct");

  const body = anon.locator("body");
  await expect(body).not.toContainText("Summary");
  await expect(body).not.toContainText("Scorecard");
  await expect(body).not.toContainText("Commentary");
  // "Info" is a French cognate but not the EXACT English string ("Infos" is
  // French, plain "Info" is English) — checked via the tab label itself
  // above rather than a body-wide substring, which "Infos" would trivially
  // satisfy a naive "not.toContainText('Info')" check anyway (fix per the
  // standing rule: only assert a negative where the strings genuinely
  // differ). "Sets" is identical in both locales (see en/fr public.json) —
  // no negative assertion is possible for it, so none is made.
  await setOrgLocaleSql(localeOrg.data.id, "en");
});
