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
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { activeOrg, apiJson, createStageAndGenerate, expectNoHorizontalScroll, setOrgLocaleSql, TAG } from "../helpers";
import { scanPadContrast } from "../scorepad-a11y-kit";
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
  LIVE_UPDATE_BUDGET_MS,
  centreHits,
  OUT,
} from "../spectator-public-helpers";

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
// a second tennis division whose two entrants collide past every rung of the
// abbreviation ladder — the only fixture in this file with a 4-character badge
let namesDivSlug = "";
let namesFixture = "";

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

  // === tennis division, colliding names — the badge chip's widest label ======
  // Every entrant this file creates elsewhere abbreviates to three characters
  // ("ONE", "TWO"), and every screenshot the programme has taken is cricket,
  // whose team codes are three too. So the FOUR-character label — the widest
  // the abbreviation ladder can produce, and the one the chip has to be able
  // to hold — had no coverage anywhere: not in a unit test (no layout in
  // `environment: "node"`), not in a screenshot, not in the width sweep. Two
  // entrants whose surnames agree for longer than the badge is wide are the
  // only way to see it in a browser: they exhaust every rung and land on the
  // positional tie-break, "AND1"/"AND2".
  const ndiv = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: `Tennis names ${TAG}`,
    sport_key: "tennis",
    variant_key: "tour",
  });
  if (!ndiv.data) throw new Error(`tennis names division -> ${ndiv.status} ${JSON.stringify(ndiv.error)}`);
  namesDivSlug = ndiv.data.slug;
  const nents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${ndiv.data.id}/entrants`, "POST", [
    { kind: "individual", display_name: "John Andersen", seed: 1 },
    { kind: "individual", display_name: "John Anderson", seed: 2 },
  ]);
  if (!nents.data || nents.data.length !== 2) {
    throw new Error(`tennis names entrants -> ${nents.status} ${JSON.stringify(nents.error)}`);
  }
  const { fixtureIds: namesFixtures } = await createStageAndGenerate(request, ndiv.data.id);
  await apiJson(request, `/api/v1/divisions/${ndiv.data.id}/start`, "POST");
  namesFixture = namesFixtures[0]!;
  const nsides = await fixtureSides(request, namesFixture);
  await mustPost(request, namesFixture, "core.start", {});
  for (let i = 0; i < 3; i++) await mustPost(request, namesFixture, "tennis.point", { by: nsides.home });

  expect(
    orgSlug &&
      compSlug &&
      liveDivSlug &&
      matchA &&
      consentDivSlug &&
      matchC &&
      footballFixture &&
      tennisFixture &&
      namesFixture,
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
  test.setTimeout(60_000 + LIVE_UPDATE_BUDGET_MS + 10_000);
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
    .poll(async () => anon.getByTestId(/^mc-timeline-line-\d+$/).count(), { timeout: LIVE_UPDATE_BUDGET_MS })
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
  // The rows are found by the masked LABEL, never by `maskedPersonId`. This
  // selector used to be `mc-bat-${maskedPersonId}` — which quietly asserted
  // the very leak the surrogate fix removed: a masked person's real
  // `persons.id` reaching anonymous HTML as a testid and a React key, where
  // the same uuid on another division's page (one where they DID consent)
  // re-joins the name to the row this page took care to mask. The testid is
  // also scoped `<innings position>.<id>` now, because a super over can reuse
  // an innings number and two rows shared one testid.
  const batRow = anon.getByTestId(/^mc-bat-\d+\./).filter({ hasText: maskedLabel });
  await expect(batRow, "a masked batter must render a real row, never blank").toHaveCount(1);
  const bowlRow = anon.getByTestId(/^mc-bowl-\d+\./).filter({ hasText: maskedLabel });
  await expect(bowlRow, "a masked bowler must render a real row, never blank").toHaveCount(1);

  await expect(anon.locator("body")).not.toContainText(maskedFullName);

  // The point of the whole block, and the half that was missing: neither the
  // name NOR the id survives into the page. Checked against the raw MARKUP,
  // not rendered text — the leak was in an attribute, where `toContainText`
  // cannot see it. `maskedPersonId` is a uuid, so a substring check is exact.
  const markup = await anon.content();
  expect(markup, "a masked person's real id must not reach anonymous HTML").not.toContain(maskedPersonId);

  // ...and the row is keyed by a SURROGATE rather than by nothing at all: an
  // absent id would break the row's React identity across a live update, so
  // "no real id" and "no id" are different fixes and only one is correct.
  const batTestId = await batRow.getAttribute("data-testid");
  expect(batTestId, "the masked row must still carry a stable surrogate id").toMatch(/^mc-bat-\d+\.m\d+$/);
});

// ---------------------------------------------------------------------------
// 5. widths — control-set diff, tab reachability, 44px hit targets, no scroll
// ---------------------------------------------------------------------------

test("widths 320 vs 1280: control-set diff, every tab reachable, 44px tab hit targets, no horizontal scroll", async ({
  browser,
}) => {
  // CLOSED. This block used to declare a LIVE product defect — the tab rail's
  // buttons measuring ~32px against R11's 44px minimum — and it went stale
  // when the fix landed: `tab-rail.tsx:102`'s `TAB_BUTTON_CLASS` now carries
  // `min-h-11`, and the assertion below has passed ever since. Rewritten
  // rather than deleted because the note's own history is the useful part:
  // the defect was invisible for weeks because every prior run of this serial
  // file aborted earlier, so nothing ever reached this test. That is the
  // reason the assertion stays here, unweakened, rather than being trimmed
  // now that it is green.
  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 320, height: 568 });
  await anon.goto(matchAPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(anon);

  // R1 sweeps EVERY tab, not merely whichever panel happens to be mounted.
  // Only the ACTIVE tab's panel is in the DOM, so a single `controlSet(anon)`
  // call could only ever see the Summary tab — and a phone-only control added
  // to Scorecard, Commentary or Timeline was invisible to the one gate that
  // exists to catch exactly that ("a phone view showing the same control set
  // at smaller sizes is a groomed shrink, which is the thing this programme
  // exists to undo"). The per-tab `expectNoHorizontalScroll` is the same
  // widening: page overflow was previously only ever checked on Summary.
  const controlSetByTab = async (): Promise<Record<string, string[]>> => {
    const ids = await anon
      .locator('[role="tab"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
    expect(ids.length, "the rail must render tabs — an empty sweep passes R1 vacuously").toBeGreaterThan(0);
    const out: Record<string, string[]> = {};
    for (const id of ids) {
      await anon.getByTestId(id).click();
      await expect(anon.getByTestId(id.replace("mc-tab-", "mc-tab-panel-"))).toBeVisible();
      out[id] = await controlSet(anon);
      await expectNoHorizontalScroll(anon);
    }
    return out;
  };

  const controls320 = await controlSetByTab();

  await anon.setViewportSize({ width: 1280, height: 900 });
  await anon.waitForTimeout(200);
  await expectNoHorizontalScroll(anon);
  const controls1280 = await controlSetByTab();

  expect(Object.keys(controls1280), "R1: the same TABS must exist at 320 and 1280").toEqual(Object.keys(controls320));
  for (const tabId of Object.keys(controls320)) {
    expect(
      controls1280[tabId],
      `R1: the SAME control set at 320 and 1280 on ${tabId} — membership, order, repeats`,
    ).toEqual(controls320[tabId]);
  }

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

  // Review round 1, Important #3 — everything above runs at 1280 (the
  // viewport switched away from 320 above, before this loop), so none of it
  // has ever actually re-exercised the 320px clipping scenario C6 fixes
  // (`match-a-tab-commentary-320.png` showed "Commentar…" clipped before
  // that fix landed). `toBeVisible()` (used above) does not catch this
  // either — Playwright's own definition is "has a box and is not
  // display:none", never "the box is within the viewport". Commentary is
  // the third of cricket's four tabs — far enough along the rail to sit
  // off-screen before selection.
  //
  // Both scenarios use a FRESH page/context, not `anon` above (which the
  // per-tab loop left on an arbitrary active tab and scroll position — a
  // resize fired from THAT state can drag Commentary into view as a side
  // effect of scrolling whatever tab the loop left active, which nearly
  // produced a false green here). A fresh load gives a known, deterministic
  // start: `active` is the document's first tab (Summary) and the rail's
  // `scrollLeft` is 0, so Commentary is genuinely off-screen before
  // selection, not "off-screen because a previous step happened to leave it
  // there".
  // `tab-rail.tsx:62` scrolls with `behavior: "smooth"`, so the tab is IN
  // MOTION when the effect fires and a flat `waitForTimeout` is racing an
  // animation rather than waiting for it. Under load that race was lost by
  // 2.078px at 320 — the scroll caught ~99% of the way to its rest, not a
  // rail that failed to move. Poll the resting position instead.
  //
  // This does not weaken the gate. The predicate is the same one the flat
  // wait asserted, so a rail that never scrolls (the effect deleted, the
  // listener removed) leaves the tab permanently outside the viewport, the
  // poll never goes true, and the test fails on the timeout. Only a rail
  // that DOES arrive can satisfy it — the change buys the animation time to
  // finish, nothing else. The exact edges are re-asserted afterwards so a
  // failure past the poll still reports real numbers rather than `false`.
  const assertCommentaryTabInsideViewport = async (page: Page, viewportWidth: number) => {
    const tab = page.getByTestId("mc-tab-commentary");
    // +1px tolerance on the right edge for sub-pixel float rounding
    // (measured ~0.08px over in practice, not a visible clip).
    const insideViewport = (box: { x: number; width: number } | null) =>
      box !== null && box.x >= 0 && box.x + box.width <= viewportWidth + 1;
    await expect
      .poll(async () => insideViewport(await tab.boundingBox()), {
        timeout: 10_000,
        message: "the active tab must come to REST fully inside the viewport",
      })
      .toBe(true);
    const box = await tab.boundingBox();
    expect(box, "mc-tab-commentary has no layout box").not.toBeNull();
    expect(box!.x, "active tab's LEFT edge must be inside the viewport").toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "active tab's RIGHT edge must be inside the viewport").toBeLessThanOrEqual(
      viewportWidth + 1,
    );
  };

  // Two shapes, because `tab-rail.tsx`'s fix has two independent parts and
  // each needs its own witness:

  // (a) click AND view both at 320 — the "on selection" `useEffect` alone.
  // `dispatchEvent("click")`, NOT `.click()`: Playwright's own actionability
  // protocol scrolls a target into view before a REAL `.click()`, which
  // made this pass even with the component's own effect deleted entirely
  // (confirmed by hand). `dispatchEvent` fires the DOM event directly with
  // no such assist, so only the app's own `onClick` → `onChange` →
  // re-render → `useEffect` chain can move the rail.
  const freshA = await anonPage(browser, { width: 320, height: 568 });
  await freshA.goto(matchAPath, { waitUntil: "load" });
  await expect(freshA.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await freshA.getByTestId("mc-tab-commentary").dispatchEvent("click");
  // A short fixed wait for the click to REFLOW, not for the scroll to finish —
  // the poll inside the assertion owns the settle. It is still needed: polling
  // the instant the event is dispatched can read a pre-reflow box and pass on
  // a position the rail is about to leave.
  await freshA.waitForTimeout(400);
  await assertCommentaryTabInsideViewport(freshA, 320);

  // (b) click at a WIDE viewport, then resize down — the exact sequence
  // `screenshotAtWidths`/`shotAllTabs` use (click once, then walk several
  // viewports without re-clicking). The "on selection" effect alone cannot
  // pass this shape (`active` never changes across the resize), which is
  // exactly why the resize LISTENER was added — this is its own witness,
  // independent of (a). A real `.click()` is fine here (matches the real
  // harness) — at 1280 nothing needs scrolling, so Playwright's own
  // actionability assist is a no-op.
  const freshB = await anonPage(browser, { width: 1280, height: 900 });
  await freshB.goto(matchAPath, { waitUntil: "load" });
  await expect(freshB.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await freshB.getByTestId("mc-tab-commentary").click();
  await freshB.waitForTimeout(300);
  await freshB.setViewportSize({ width: 320, height: 568 });
  // Same shape as (a): the wait is for the RESIZE to reflow, so the poll
  // cannot read a stale pre-resize box; the poll owns the scroll's settle.
  await freshB.waitForTimeout(400);
  await assertCommentaryTabInsideViewport(freshB, 320);
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
  // CLOSED. This block used to declare two LIVE SERIOUS axe contrast
  // violations at 320 — `text-court-muted/70` on the court card (4.09:1) and
  // `text-ink-muted/80` on the stat cards (3.45:1), both short of WCAG AA's
  // 4.5:1 at those sizes. Both opacity variants are gone from
  // `components/public-site/` entirely; the court card uses the unmodified
  // `text-court-muted`. Kept as a record rather than deleted for the same
  // reason as the note above: both were invisible for weeks because this
  // serial file aborted before reaching either test, which is why the
  // assertions stay unweakened now that they pass.
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

// ---------------------------------------------------------------------------
// 9. badge chip width — LAST, deliberately
// ---------------------------------------------------------------------------
//
// This file is `mode: "serial"`, so a red here aborts every test below it. This
// one pins an exact abbreviation string produced by a ladder that changed in
// three consecutive review rounds, which makes it the most likely test in the
// file to red on a future edit — and when it sat above them, a red took the axe
// pass, the width sweep, the deep-link test and all 39 screenshots with it,
// reporting "1 failed" for what was really "1 failed, 6 never ran". Last, so a
// count in this file is a total rather than a floor.
// The chip that carries an entrant's abbreviation is a fixed-height box with
// no `truncate`: a label wider than the box does not clip, it spills. Nothing
// in the suite could see that. A unit test cannot — `apps/web` vitest is
// `environment: "node"`, so there is no layout to measure — and every fixture
// that had ever been screenshotted abbreviated to three characters, so the
// four-character case was invisible in both directions at once.
//
// TWO ASSERTIONS, and the second is the one with teeth. `scrollWidth <=
// clientWidth` only rules out a spill, and once the chips became content-sized
// (`min-w-[24px] px-0.5`, no fixed width) that is nearly true by construction —
// it kills the `w-6` revert by about a pixel, which a rounding difference on
// another runner's font metrics could erase. So the box must also be shown to
// have GROWN past its floor for a four-character label: a `w-6` revert pins
// `clientWidth` at exactly the floor, which no rounding can fake. A
// reachability check is satisfied by any value; pin what the control opens at.
//
// Run at 320 as well as 1280: the chip sits beside a truncating name at both,
// and the phone width is where a two-pixel spill collides with something.
const BADGE_MIN_PX = 24; // `min-w-[24px]` on both chips — the FLOOR, not a ceiling.
const COURT_CARD_TIMEOUT_MS = 20_000;
test("badge chips hold the WIDEST abbreviation the ladder produces, at 320 and 1280", async ({ browser }) => {
  // Two page loads, each fronted by an explicit 20s court-card wait, against a
  // 60s default. Expressed against those waits rather than as a flat number so
  // that raising one raises the budget with it — a blown budget reports itself
  // as a DATA defect here, printing whichever `expect` was in flight (the
  // `toHaveText("AND1")`) above the timeout line, which reads as a broken
  // abbreviation ladder rather than a wall clock.
  const WIDTHS = [320, 1280];
  test.setTimeout(Math.max(60_000, WIDTHS.length * (COURT_CARD_TIMEOUT_MS + 25_000)));
  const namesPath = publicFixturePath(orgSlug, compSlug, namesDivSlug, namesFixture);
  for (const width of WIDTHS) {
    const anon = await anonPage(browser, { width, height: 900 });
    await anon.goto(namesPath, { waitUntil: "load" });
    await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: COURT_CARD_TIMEOUT_MS });
    await anon.getByTestId("mc-tab-sets").click();

    const badge = anon.getByTestId("mc-sets-badge-0");
    await expect(badge).toBeVisible();
    // The label is what makes this test able to fail. Assert it before the
    // geometry: a three-character code would fit any of these boxes, so a
    // green geometry check on the wrong label proves nothing.
    await expect(badge).toHaveText("AND1");
    await expect(anon.getByTestId("mc-sets-badge-1")).toHaveText("AND2");

    const setsBoxes = [];
    for (const seq of [0, 1]) {
      const box = await anon.getByTestId(`mc-sets-badge-${seq}`).evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
        text: el.textContent,
      }));
      expect(box.scroll, `sets badge ${seq} at ${width}px: "${box.text}" needs ${box.scroll}px in ${box.client}px`).toBeLessThanOrEqual(box.client);
      expect(box.client, `sets badge ${seq} at ${width}px: "${box.text}" is 4 characters and must have widened past the ${BADGE_MIN_PX}px floor, not sat on it`).toBeGreaterThan(BADGE_MIN_PX);
      setsBoxes.push(box);
    }

    // These two chips are STACKED, one per side, and their names are laid out
    // after them — so a width difference between them starts the two entrant
    // names at different x. `AND1` and `AND2` are the same length and differ by
    // one digit, so they are only the same width because the chip carries
    // `tabular-nums`; without it a proportional face renders "2" wider than
    // "1" and the column goes ragged by ~2px. This is the assertion that
    // notices if that class is dropped — nothing else in the repo would.
    expect(
      setsBoxes[0]!.client,
      `at ${width}px the two stacked sets badges are different widths ("${setsBoxes[0]!.text}" ${setsBoxes[0]!.client}px vs "${setsBoxes[1]!.text}" ${setsBoxes[1]!.client}px), so the two entrant names no longer start at the same x. tabular-nums alone does NOT fix this: it is a font FEATURE a face may not implement (the CI runner's fallback does not). The chip needs a monospace FAMILY`,
    ).toBe(setsBoxes[1]!.client);

    // And the consequence itself, rather than only its cause: the names line up.
    const nameLefts = await anon
      .locator("tbody th span.block")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(new Set(nameLefts).size, `entrant names start at ${nameLefts.join(" and ")} at ${width}px`).toBe(1);

    // Same chip, the other tab. `SideBadge` and the Sets row badge are two
    // renderings of one object and have gone out of step before.
    //
    // This ASSERTS the Timeline tab rather than skipping when it is absent.
    // The tab's presence is not a fact discovered about someone else's data —
    // this test seeds its own division and posts the three `tennis.point`
    // events that make `extraTabs` push `timeline`. A `continue` here would be
    // a guard over a fact the test itself establishes, and it sits on the ONLY
    // browser-side measurement of `SideBadge` in the repository: `mobile.spec`
    // reaches the match centre only through a cricket fixture, and cricket
    // renders neither the Sets nor the Timeline tab. Lose this and the chip
    // has no width gate at all, with everything still green.
    await expect(
      anon.getByTestId("mc-tab-timeline"),
      "the seeded tennis fixture must expose a Timeline tab — this test's own events produce it",
    ).toHaveCount(1);
    await anon.getByTestId("mc-tab-timeline").click();
    const timelineBadges = anon.getByTestId(/^mc-side-badge-\d+$/);
    const count = await timelineBadges.count();
    expect(count, "the timeline rendered at least one entrant chip").toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await timelineBadges.nth(i).evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
        text: el.textContent,
      }));
      expect(box.scroll, `timeline badge ${i} at ${width}px: "${box.text}" needs ${box.scroll}px in ${box.client}px`).toBeLessThanOrEqual(box.client);
      expect(box.client, `timeline badge ${i} at ${width}px: "${box.text}" is 4 characters and must have widened past the ${BADGE_MIN_PX}px floor, not sat on it`).toBeGreaterThan(BADGE_MIN_PX);
    }
    await anon.close();
  }
});

// ---------------------------------------------------------------------------
// 10. tap targets — every CONTROL, not just the tabs
// ---------------------------------------------------------------------------
//
// The width sweep above already pins the tab rail at 44px. Nothing pinned
// anything else, and an audit of the live pages found four controls under the
// floor at every width, phone included: "Share on WhatsApp" at 34px, "Load
// earlier overs" and both Info links at 38px. Three of the four were styled
// with `py-*` alone, which sets padding and lets a 13px line box decide the
// height.
//
// WHAT THIS SWEEPS, and why it is not simply "every anchor": the 44px floor is
// for things a finger aims at. An anchor inside a sentence — a breadcrumb, the
// footer's "Run your own free" — is exempt by convention and would make this
// assertion unpassable without shipping 44px-tall prose links. The split used
// here is the one the DOM already makes: a control that has been styled as a
// button is not `display: inline`. That is a property of the thing under test
// rather than a list of testids, so a control added later is swept without
// anyone remembering to add it here.
test("tap targets: every button-shaped control in the match centre clears 44px at 320", async ({ browser }) => {
  test.setTimeout(Math.max(60_000, COURT_CARD_TIMEOUT_MS + 40_000));
  const path = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 320, height: 900 });
  await anon.goto(path, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: COURT_CARD_TIMEOUT_MS });

  const tabIds = await anon
    .locator('[role="tab"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")).filter(Boolean));
  expect(tabIds.length, "at least one tab must render").toBeGreaterThan(0);

  const undersized: string[] = [];
  let swept = 0;
  for (const tabId of tabIds) {
    await anon.getByTestId(tabId as string).click();
    await anon.waitForTimeout(200);

    const found = await anon.locator("main button, main a").evaluateAll((els) =>
      els
        .filter((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === "inline") return false; // prose link — exempt
          if (cs.visibility === "hidden" || cs.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width >= 1 && r.height >= 1;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id:
              el.getAttribute("data-testid") ??
              `${el.tagName.toLowerCase()}:"${(el.textContent || "").trim().slice(0, 20)}"`,
            h: Math.round(r.height),
            w: Math.round(r.width),
          };
        }),
    );
    swept += found.length;
    for (const c of found) {
      if (c.h < 44) undersized.push(`${tabId}: ${c.id} is ${c.w}x${c.h}`);
    }
  }

  // The sweep must have SEEN something, or an empty result would pass as
  // silently as a clean one — a selector that matches nothing satisfies every
  // "none of them are too short" assertion ever written.
  expect(swept, "the sweep found no button-shaped controls at all — check the selector").toBeGreaterThan(0);
  expect(undersized, `controls under the 44px tap-target floor at 320px:\n${undersized.join("\n")}`).toEqual([]);
  await anon.close();
});

// ---------------------------------------------------------------------------
// The tab rail's KEYBOARD path, driven in a real browser
// ---------------------------------------------------------------------------
//
// `tab-rail.tsx` uses the ARIA roving-tabindex pattern: exactly one tab is in
// the browser's tab order (`tabIndex={isActive ? 0 : -1}`) and the others are
// reached with the arrow keys, which `handleKeyDown` turns into an `onChange`
// plus a `.focus()` on the newly selected button.
//
// The two halves of that pattern only work TOGETHER, and neither half can be
// witnessed by a unit test: `apps/web` vitest is `environment: "node"`, so a
// markup scan sees the `tabindex` attributes but never what a browser does
// with them. Delete the arrow handling and the markup is byte-identical while
// a keyboard user loses every tab except the selected one — a suite-green
// accessibility regression. Every other tab assertion in this file clicks.
test("tab rail keyboard: one tab stop, arrows move selection AND focus, Home/End reach the ends", async ({
  browser,
}) => {
  const matchAPath = publicFixturePath(orgSlug, compSlug, liveDivSlug, matchA);
  const anon = await anonPage(browser, { width: 1280, height: 900 });
  await anon.goto(matchAPath, { waitUntil: "load" });
  await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });

  const tabIds = await anon
    .locator('[role="tab"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
  expect(tabIds.length, "the rail must render tabs — otherwise every assertion below is vacuous").toBeGreaterThan(1);

  // ONE tab stop. Counted off the live DOM rather than the class list,
  // because `tabindex` is what the browser actually reads.
  const inTabOrder = await anon
    .locator('[role="tab"]')
    .evaluateAll((els) => els.filter((el) => el.getAttribute("tabindex") === "0").length);
  expect(inTabOrder, "exactly one tab may be in the tab order (roving tabindex)").toBe(1);
  const tablistFocusable = await anon.locator('[role="tablist"]').getAttribute("tabindex");
  expect(tablistFocusable, "the tablist container must not be a tab stop of its own").toBeNull();

  // Focus the selected tab the way a keyboard user arrives at it, then walk
  // right. Both halves are asserted: the selection moved, AND the browser's
  // focus went with it. Selection alone would strand the user's focus on a
  // tab that is no longer the selected one.
  const focusedTestId = async () =>
    anon.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

  await anon.getByTestId(tabIds[0]!).focus();
  expect(await focusedTestId(), "focus must start on the first tab").toBe(tabIds[0]);

  await anon.keyboard.press("ArrowRight");
  await expect(anon.getByTestId(tabIds[1]!), "ArrowRight must SELECT the next tab").toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await focusedTestId(), "ArrowRight must also move FOCUS to the next tab").toBe(tabIds[1]);
  await expect(
    anon.getByTestId(`mc-tab-panel-${tabIds[1]!.replace("mc-tab-", "")}`),
    "the newly selected tab's panel must be the one on screen",
  ).toBeVisible();

  // Home/End reach the ends. A rail whose arrows worked but whose Home/End
  // did nothing passes everything above.
  await anon.keyboard.press("End");
  expect(await focusedTestId(), "End must land on the last tab").toBe(tabIds[tabIds.length - 1]);
  await expect(anon.getByTestId(tabIds[tabIds.length - 1]!)).toHaveAttribute("aria-selected", "true");

  await anon.keyboard.press("Home");
  expect(await focusedTestId(), "Home must land on the first tab").toBe(tabIds[0]);
  await expect(anon.getByTestId(tabIds[0]!)).toHaveAttribute("aria-selected", "true");

  // Still exactly ONE tab stop after all that movement — the roving half of
  // roving tabindex. A rail that set the new tab to 0 without clearing the
  // old one passes every assertion above while leaving a growing trail of
  // stops behind it.
  const inTabOrderAfter = await anon
    .locator('[role="tab"]')
    .evaluateAll((els) => els.filter((el) => el.getAttribute("tabindex") === "0").length);
  expect(inTabOrderAfter, "still exactly one tab stop after arrow/Home/End navigation").toBe(1);

  await anon.close();
});
