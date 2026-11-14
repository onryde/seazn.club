// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): the setup test's competition (org console routes, public surfaces, hub tabs, registrants/assign sheets, news, axe, LCP, portfolio, New competition form, t20-super8 template, density sweep, sponsor archive).
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  competitionPath,
  divisionPath,
  seedRosteredFixture,
  seedVenueWithCourts,
  setBoolEntitlementOverrideSql,
  overflowingIn,
} from "../helpers";
import { uiEn } from "../match-room-kit";
import { SPONSORS_TABS, dealHref, sponsorHref, sponsorsHref } from "../../src/lib/sponsors-hub";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { FLOOR_MS, ROUTE_CHECK_MS } from "../spectator-w2-kit";
import { withDb } from "../rs007-money-kit";
import { openSponsorRowTools } from "../settings-support";
import { auditRoute, projectViewport, assertTapFloor, projectTag, hitFloor, paintedInsideViewport } from "./_shared";

// Serial, kept from the original file: the setup test fills module-level `let` state (compId, orgSlug, divisionId, ...) that the other tests in this file read, and the sponsors/archive seeds are torn down in afterAll.
test.describe.configure({ mode: "serial" });

let compId = "";
let compSlug = "";
let divisionId = "";
/** RS009 — the TEAM division that accepts solo sign-ups, so the assign
 *  picker has somewhere to place someone. */
let teamDivisionId = "";
let orgSlug = "";
/** The active org's id, recorded by the setup test beside `orgSlug` - the sponsors seed below reuses it instead of resolving the org again. */
let setupOrgId = "";
/** RS007's two new public surfaces, with the query strings that make them
 *  render populated rather than their (also valid, but far simpler) empty
 *  state. Filled by the setup test below. */
let statusPath = "";
let joinPath = "";
/** RS012 — the POOLED SOLO SIGN-UP's own status page (never assigned in
 *  this fixture), distinct from `statusPath` above which is the fully-
 *  formed team's own page and can never render the "waiting"/deadline
 *  copy this exists to give width coverage to. */
let soloStatusPath = "";
/** Task 15 (spectator W1) — the public match-centre fixture page had zero
 *  width coverage in this file: a band-3 (real `cricket.ball`) fixture, so
 *  the page renders its Scorecard/Commentary tabs rather than the two-tab
 *  fallback a bare `core.start` alone would produce. */
let publicCricketFixturePath = "";
/** Spectator W2 (Task 17, MS1) — the same band-3 cricket fixture's
 *  COMPETITION (its hub has a live match, a table and a squad) and one of its
 *  consenting players, whose card leads with that live match. */
let publicCricketCompSlug = "";
let publicCricketPlayerId = "";
/** Sponsor deals PR 2 (Batch J) - the sponsor's own page and the deal's own page, which the hub picks by `?sponsor=` / `?deal=`. One
 *  sponsor (a realistic 43-character name) holding one open offline deal, seeded by the "console routes" test itself (`seedSponsorsSweep`,
 *  never the serial setup test). An id the hub does not know
 *  renders the LIST - a 200 with no overflow - so "console routes" names a test id it must see on each, and null here fails that test. */
let sponsorsSweep: { sponsorId: string; dealId: string; packageId: string; orgId: string } | null = null;

/** Seeds the sponsor, package and open offline deal the two sponsor pages below render (the sponsor's own page and the deal's own page need
 *  a real sponsor and a real deal to render at all). It runs at the top of the ONE test that needs it ("console routes"), never in the
 *  serial file's setup test: a sponsor API regression there would abort every test after it - roughly 110, across seven width
 *  projects - where here it reds the one test that is about sponsors (batch J review m8). */
async function seedSponsorsSweep(request: APIRequestContext): Promise<NonNullable<typeof sponsorsSweep>> {
  // A retry of the test reuses the sponsor it already made, so a flaky run does not pile a second one into the org.
  if (sponsorsSweep !== null && sponsorsSweep.dealId !== "") return sponsorsSweep;
  // The org the setup test resolved (this file is serial, so it has run): a blank id means setup never got that far, and a request to
  // `/orgs//sponsors` would only read as a 404 about something else.
  expect(setupOrgId, "the setup test recorded the active org's id").not.toBe("");
  const org = { id: setupOrgId };
  const sweepPackage = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.id}/sponsor-packages`, "POST", {
    name: `Mobile Gate partner board ${TAG}`, price_cents: 25_000, currency: "gbp", tier: "partner",
  });
  expect(sweepPackage.status, `sponsor package -> ${sweepPackage.status} ${JSON.stringify(sweepPackage.error)}`).toBe(201);
  const sweepSponsor = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.id}/sponsors`, "POST", {
    name: "Harbourside Building Supplies and Timber Co", tier: "partner", url: "https://sponsor.example/",
  });
  expect(sweepSponsor.status, `sponsor -> ${sweepSponsor.status} ${JSON.stringify(sweepSponsor.error)}`).toBe(201);
  // Recorded as soon as the package and the sponsor exist (the deal id follows), so the afterAll cleanup finds them even when the deal's
  // own create is the red step.
  const seeded = { sponsorId: sweepSponsor.data!.id, dealId: "", packageId: sweepPackage.data!.id, orgId: org.id };
  sponsorsSweep = seeded;
  const sweepDeal = await apiJson<{ deal: { id: string } }>(request, `/api/v1/orgs/${org.id}/sponsors/${sweepSponsor.data!.id}/deals`, "POST", {
    package_id: sweepPackage.data!.id, competition_id: null, payment_method: "offline", go_live: "on_payment",
  });
  expect(sweepDeal.status, `sponsor deal -> ${sweepDeal.status} ${JSON.stringify(sweepDeal.error)}`).toBe(201);
  seeded.dealId = sweepDeal.data!.deal.id;
  return seeded;
}

// The sponsor is removed and the package retired, so a re-run against the same database does not pile sponsors into the shared org.
// The deal stays OFFLINE on purpose (an offline deal's page carries the invoice's chrome, which this file gives width coverage to), and
// an offline deal is numbered when it is made, so the API refuses this sponsor's delete as history (409 `sponsor_has_deal_history`,
// sponsor invoices F10) - by design, for a club. The test's own deal is therefore dropped first with privileged SQL (the e2e
// DATABASE_URL role bypasses the tenant fence), and the API delete then removes a sponsor with no deals. The org's invoice counter
// is left as it is: numbers are never reused, so the next run's deal simply takes the next one. Never throws: a teardown must not
// fail a green run.
test.afterAll(async ({ request }) => {
  if (sponsorsSweep === null) return;
  const { orgId, sponsorId, packageId } = sponsorsSweep;
  await withDb((sql) => sql`delete from sponsor_orders where org_id = ${orgId} and sponsor_id = ${sponsorId}`).catch(() => undefined);
  await apiJson(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}`, "DELETE").catch(() => undefined);
  await apiJson(request, `/api/v1/orgs/${orgId}/sponsor-packages/${packageId}`, "DELETE").catch(() => undefined);
});

test("setup: public competition with an entrant-ready division", async ({ page, request }) => {
  // This file is `mode: "serial"`, so a red HERE aborts every test after it —
  // roughly 110 of them, across all seven width projects. This block is also
  // the heaviest in the file: a competition, a division, entrants, a fixture
  // and a scored ledger, all over the API, and it ran on the config's plain
  // 60s while individually lighter blocks below already ask for 90s. Under
  // load that is a wall-clock red wearing a data defect's clothes (AGENTS
  // rule 20) — and its cost is the whole file, not one test.
  test.setTimeout(180_000);

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Mobile Gate ${TAG}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);
  compId = comp.data!.id;
  compSlug = comp.data!.slug;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Mobile Singles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ada M", "Bea M", "Cal M", "Dev M"]);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "individual",
      capacity: 10,
      fee_cents: 0,
      form_fields: [],
    },
  );
  expect(settings.status).toBeLessThan(300);
  // Published so `/live/${orgSlug}` below has this card to hold at every
  // width: a draft is listed nowhere (owner decision 2026-09-27), and an org
  // home with nothing on it is the vacuous empty state #349 warns about.
  const published = await apiJson<{ status: string }>(request, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "published",
  });
  expect(published.data?.status, JSON.stringify(published.error)).toBe("published");
  const org = await activeOrg(page);
  orgSlug = org.slug;
  setupOrgId = org.id;

  // RS007. The two surfaces this wave ADDED — the group status page and the
  // public join page — had zero width coverage, which in this repo means a
  // new UI surface is unprotected until it appears in this file by name.
  // Both need a real registration to render anything but their empty state,
  // and the join page needs a TEAM entry, since only those mint a join_code.
  const teamDiv = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Mobile Teams",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(teamDiv.status).toBeLessThan(300);
  const teamSettings = await apiJson(
    request,
    `/api/v1/divisions/${teamDiv.data!.id}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "team",
      capacity: 10,
      fee_cents: 0,
      form_fields: [],
      // RS009 — the Registrants tab's assign control only renders for a
      // pooled solo sign-up, so without this the picker has nothing to open
      // and its width coverage would pass vacuously.
      allow_free_agents: true,
      // RS012 — a future place_by_at so the status page's NEW deadline line
      // (register.status.entry.awaitingTeamDeadline) actually renders for
      // the pooled solo sign-up seeded below. Without this the line stays
      // untested at every width, same class of gap as the assign picker's
      // own comment just above — a division with neither place_by_at nor
      // closes_at set renders nothing here to measure.
      place_by_at: "2030-06-01T00:00:00.000Z",
    },
  );
  expect(teamSettings.status).toBeLessThan(300);
  teamDivisionId = teamDiv.data!.id;

  // A captain plus ONE team-mate the captain enters on their behalf: that
  // second row is `captain_entered`/`pending`, which is precisely the slot
  // the join page exists to let someone claim. A roster of one would render
  // a join page with nothing to pick.
  const submitted = await apiJson<{
    group_id: string;
    access_token: string;
    entries: { join_code: string | null }[];
  }>(request, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: `Mobile Captain ${TAG}`, email: `delivered+mobile-captain-${TAG}@resend.dev` },
    privacy_consent: true,
    entries: [
      {
        division_id: teamDiv.data!.id,
        entrant_kind: "team",
        // Required: `entryDisplayName` (registration-submit.ts) 422s a
        // nameless team, which is the client/server split RS007 also closed.
        team_name: `Mobile Team ${TAG}`,
        players: [{ full_name: `Mobile Captain ${TAG}` }, { full_name: `Mobile Mate ${TAG}` }],
        answers: {},
      },
    ],
  });
  expect(submitted.status, "the width matrix needs a real registration to render").toBeLessThan(300);
  const joinCode = submitted.data!.entries[0]!.join_code;
  expect(joinCode, "a team entry must mint a join_code or the join page has nothing to show").toBeTruthy();
  statusPath =
    `/live/${orgSlug}/${compSlug}/register/status` +
    `?rid=${submitted.data!.group_id}&token=${submitted.data!.access_token}`;
  joinPath = `/live/${orgSlug}/${compSlug}/register/join?join_code=${joinCode}`;

  // RS009 — one person entering the team division ALONE, so the Registrants
  // tab has a row whose "Assign to a team" control exists. A hub with no
  // solo sign-up renders no picker, and the width test below would then be
  // measuring an empty tab.
  const solo = await apiJson<{
    group_id: string;
    access_token: string;
    entries: { join_code: string | null }[];
  }>(
    request,
    `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`,
    "POST",
    {
      contact: { name: `Mobile Solo ${TAG}`, email: `delivered+mobile-solo-${TAG}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: teamDiv.data!.id,
          entrant_kind: "team",
          free_agent: true,
          players: [{ full_name: `Mobile Solo ${TAG}` }],
          answers: {},
        },
      ],
    },
  );
  expect(solo.status, "the assign picker needs a pooled solo sign-up to open").toBeLessThan(300);
  // RS012 — this solo sign-up's OWN status page, distinct from `statusPath`
  // above (the TEAM's own status page — a fully-formed team can never say
  // "waiting for a team"). Each entry submitted through a SEPARATE cart gets
  // its own group_id/access_token, so this is a genuinely different page.
  soloStatusPath =
    `/live/${orgSlug}/${compSlug}/register/status` +
    `?rid=${solo.data!.group_id}&token=${solo.data!.access_token}`;
  // P11 (D6): import.events has no plan_entitlements row on any plan during
  // rollout (design doc §2.4/R6) — without this override the import route
  // added to "console routes" below renders page.tsx's notFound() instead of
  // the real page, and a 404 has no overflow, i.e. exactly the vacuous pass
  // the #349 comment on that test already warns about for six other routes.
  await setBoolEntitlementOverrideSql(org.id, "import.events", true);

  // Task 15 (spectator W1) — a real (band-3) cricket fixture for the public
  // match-centre page's own width coverage below. `cricket.toss` BEFORE
  // `core.start` (cricket.ts:3372, "toss must precede core.start" — a
  // WRONG_PHASE 422 the other way round). One `cricket.ball` event is
  // enough to give the fold real batting/over data, which is what puts the
  // Scorecard and Commentary tabs on the page (buildMatchCentre only adds
  // them once `card.innings[].batting`/`.overs` are non-empty) — a bare
  // `core.start` alone would render only the two-tab (Summary/Info)
  // fallback and this route would then cover nothing new.
  const mcFx = await seedRosteredFixture(request, {
    label: `Mobile Match Centre ${TAG}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `MC Home 1 ${TAG}` }, { fullName: `MC Home 2 ${TAG}` }],
    away: [{ fullName: `MC Away 1 ${TAG}` }, { fullName: `MC Away 2 ${TAG}` }],
  });
  const mcTossState = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${mcFx.fixtureId}/state`);
  const mcToss = await apiJson(request, `/api/v1/fixtures/${mcFx.fixtureId}/events`, "POST", {
    expected_seq: mcTossState.data!.last_seq,
    type: "cricket.toss",
    payload: { wonBy: mcFx.homeEntrantId, elected: "bat" },
  });
  expect(mcToss.status, `cricket.toss -> ${mcToss.status} ${JSON.stringify(mcToss.error)}`).toBeLessThan(300);
  const mcStartState = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${mcFx.fixtureId}/state`);
  const mcStart = await apiJson(request, `/api/v1/fixtures/${mcFx.fixtureId}/events`, "POST", {
    expected_seq: mcStartState.data!.last_seq,
    type: "core.start",
    payload: {},
  });
  expect(mcStart.status, `core.start -> ${mcStart.status} ${JSON.stringify(mcStart.error)}`).toBeLessThan(300);
  const mcBallState = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${mcFx.fixtureId}/state`);
  const mcBall = await apiJson(request, `/api/v1/fixtures/${mcFx.fixtureId}/events`, "POST", {
    expected_seq: mcBallState.data!.last_seq,
    type: "cricket.ball",
    payload: {
      over: 0,
      ballInOver: 1,
      striker: mcFx.personIds[`MC Home 1 ${TAG}`],
      nonStriker: mcFx.personIds[`MC Home 2 ${TAG}`],
      bowler: mcFx.personIds[`MC Away 1 ${TAG}`],
      runs: { bat: 4 },
      boundary: 4,
    },
  });
  expect(mcBall.status, `cricket.ball -> ${mcBall.status} ${JSON.stringify(mcBall.error)}`).toBeLessThan(300);
  const mcCompSlug = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${mcFx.competitionId}`);
  const mcDivSlug = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${mcFx.divisionId}`);
  publicCricketFixturePath = `/live/${orgSlug}/${mcCompSlug.data!.slug}/${mcDivSlug.data!.slug}/fixtures/${mcFx.fixtureId}`;
  publicCricketCompSlug = mcCompSlug.data!.slug;
  publicCricketPlayerId = mcFx.personIds[`MC Home 1 ${TAG}`]!;
});

test("console routes: no horizontal scroll", async ({ page, request }) => {
  // The sponsor and deal the two sponsor pages below render: without them they would silently render the list.
  const sweep = await seedSponsorsSweep(request);
  expect(sweep.sponsorId, "the sponsor for the sponsor pages was seeded").toBeTruthy();
  const routes: Array<{ path: string; allowancePx?: number; requireTestId?: string }> = [
    { path: "/dashboard" },
    // These six used to be legacy id-routes (/competitions/{id},
    // /divisions/{id}...) deleted by commit e8bed930 — they 404'd, and a 404
    // page has no overflow, so the gate passed vacuously on a third of the
    // console inventory (#349). Re-pointed to the live /o/{org}/c/{comp}/...
    // slug chain via the same helpers the rest of the suite uses.
    { path: await competitionPath(request, compId) },
    { path: await competitionPath(request, compId, "/settings") },
    { path: await divisionPath(request, divisionId) },
    { path: await divisionPath(request, divisionId, "?tab=fixtures") },
    { path: await divisionPath(request, divisionId, "?tab=standings") },
    // RS009 — the competition-level Registration hub, BOTH tabs. The old
    // division-level "registrations panel" was removed by RS001 and this
    // inventory kept a note saying no replacement route existed yet; RS004
    // and RS005 shipped one and neither added it back here, so the hub ran
    // from 2026-08-24 to 2026-08-30 with ZERO width coverage on any of the
    // seven projects. A surface is unprotected until it appears in this file
    // by name, no matter how many other specs touch it.
    { path: `/o/${orgSlug}/c/${compSlug}/registration?tab=settings` },
    { path: `/o/${orgSlug}/c/${compSlug}/registration?tab=registrants` },
    // Match Day (task A3) — the organiser's court list + focus. Page-level width at all seven projects; the court states
    // themselves (playing, called, free + candidates, the call sheet) are driven at 320/768/1280 by e2e/match-day.spec.ts.
    { path: `/o/${orgSlug}/c/${compSlug}/match-day` },
    // The /schedule console was absent from this inventory entirely, so the
    // three tabs that carry the portfolio's new panels (P1 capacity card on
    // Settings, P2 health panel on Health, both on the Board's chrome) shipped
    // with no width enforcement at all — the two /schedule tests further down
    // this file pin the publish-gate sheet and the z3 strip, not the page.
    // Page-level only: this setup division has no stage, so neither panel is
    // in the DOM here. The panels' OWN widths are pinned by
    // "portfolio panels (P1/P2/P4) hold at this width" below, which seeds
    // until each one actually renders.
    { path: await divisionPath(request, divisionId, "/schedule?tab=board") },
    { path: await divisionPath(request, divisionId, "/schedule?tab=settings") },
    { path: await divisionPath(request, divisionId, "/schedule?tab=health") },
    // P11 (D6) — division batch score-event import page, own route sibling
    // to schedule/ (design doc §7, R8). Absent from this list = zero width
    // coverage no matter how many other specs touch the page (design doc
    // §9) — events-import.spec.ts covers the functional path, not width.
    { path: await divisionPath(request, divisionId, "/import") },
    { path: "/settings?tab=organization" },
    { path: "/settings?tab=news" },
    // The Sponsors hub (R4 sponsors-on-stream S11): Settings -> Sponsors moved to its own top-level route, and Settings' own
    // `?tab=sponsors` now redirects there. EVERY tab of the hub, derived from the declaration (SPONSORS_TABS), so a tab added later
    // is swept by name instead of silently missing from the seven width projects. The profile here is the org's owner, so the
    // editor-only tabs (Packages, On stream) render their bodies rather than falling back to Overview.
    ...SPONSORS_TABS.map((tab) => ({ path: sponsorsHref(orgSlug, tab) })),
    // The sponsor's own page and the deal's own page (sponsor deals PR 2): a page below 768, a side panel from it. Each must show the
    // surface the route is for (`requireTestId`), or the list rendering in its place would pass.
    { path: sponsorHref(orgSlug, sweep.sponsorId), requireTestId: "sponsor-sheet" },
    { path: dealHref(orgSlug, sweep.sponsorId, sweep.dealId), requireTestId: "deal-page" },
    { path: "/settings?tab=team" },
    { path: "/settings?tab=api" },
    { path: "/settings?tab=preferences" },
    { path: "/settings?tab=account" },
    // Now carries the sidebar strip too — eleven chips that must scroll inside
    // their own container, never the page body.
    { path: "/settings/billing" },
    // The Event Pass page (task 22). Its comparison table is three plans wide
    // and must scroll inside its own container, never the page body — the one
    // v3/02 §4 rule this surface is most likely to break. This account is Pro,
    // so it renders the paid-plan state; the offer / owned / ceiling states are
    // driven at 390×844 by e2e/event-pass.spec.ts.
    //
    // allowancePx: 6, tracked as #532 — a genuine ~5px `html.scrollWidth`
    // overflow that the culprit-walker reports as "unknown" (no un-contained
    // element found wide enough to explain it). THREE separate CI-confirmed
    // dead ends before this landed: the comparison table's own width
    // (already correctly contained, `overflowPx: 0` locally), `break-words`
    // on its longest cell text (byte-identical failure after), and hiding
    // Stripe.js's injected telemetry iframe by name before measuring (also
    // byte-identical after). ONLY OBSERVED on mobile-320 — every other
    // project measures 0 here — so the allowance is scoped to that project
    // alone below, not applied blindly to every width this test runs at.
    // Does not reproduce locally (macOS/overlay scrollbars); only CI's
    // Linux runner shows it. Route-specific AND project-specific — NOT a
    // global bump to `expectNoHorizontalScroll`'s default, which would
    // swallow a real regression on every other route or width.
    {
      path: `/o/${orgSlug}/c/${compSlug}/upgrade`,
      allowancePx: test.info().project.name === "mobile-320" ? 6 : undefined,
    },
    { path: "/directory" },
    // D5/P8 venues & courts — Directory tab, not org settings (A2). Without
    // this entry the seven width projects never render the venue list or
    // the per-court calendar editor at all; gallery.capture.ts's own
    // "venues" capture (320/768/1280) shows the calendar editor OPEN, which
    // this route-level pass cannot — see that harness for the layout check.
    { path: "/directory?tab=venues" },
    // The Streaming page (owner, 2026-10-27: its own top-nav page, formerly the Directory's fifth tab) — and with it the gantry's
    // FIFTH nav item, which is the width budget this sweep exists to hold at every phone and tablet project.
    { path: "/streaming" },
    { path: "/import" },
    { path: "/me" },
    // P4/D1a wizard step 0 — the template gallery. A 6-card grid, which is the
    // shape most likely to force a min-width overflow at 320 (grid items
    // default to `min-width: auto`).
    { path: `/o/${orgSlug}/c/new` },
  ];
  // 60s was ample for ~35 routes; the budget now follows the route count, so the next route added moves it too.
  test.setTimeout(Math.max(60_000, routes.length * 4_000));
  for (const { path, allowancePx, requireTestId } of routes) {
    await auditRoute(page, path, { allowancePx, requireTestId });
  }
});

// The division tab rail is a SCROLLING rail, not clipped content — a
// distinction a `scrollWidth > clientWidth` scan cannot make on its own, and
// the page-level no-horizontal-scroll gate above cannot see at all because the
// box scrolls inside itself. Nothing classified it until W4: "the tabs are
// reachable at 320" was true by accident. (The comment at page.tsx:500 citing
// "v3/02 §3.3" as the source for this rail's behaviour points at a document
// that does not exist anywhere under docs/ — treat it as a hypothesis, not a
// ruling; it is not why this test exists.)
test("division tab rail overflows reachably, never clipped", async ({ page, request }) => {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const { clipped, scrollable } = await overflowingIn(
    page,
    "nav.scroll-x",
    "a",
    "the division tab rail is absent",
  );
  expect(clipped, "the tab rail (or something in it) is clipped, not scrollable").toEqual([]);
  // Only phone widths are tight enough to force the rail to overflow (measured:
  // it does at all five, 320-430) — at >=768 every tab fits without scrolling,
  // which is correct, not a gap in this gate. Scoping the vacuousness check to
  // where overflow is guaranteed is what stops the SECOND assertion itself
  // being the vacuous one (a fixed `toBeGreaterThan(0)` would fail for a real,
  // non-defect reason on tablet-768/tablet-834 — confirmed by running the
  // unscoped version first).
  if ((projectViewport()?.width ?? 0) < 768) {
    expect(
      scrollable.length,
      "the rail did not overflow at all — this gate is vacuous here",
    ).toBeGreaterThan(0);
  }
});

test("public surfaces: no horizontal scroll (v3/11 gap 12)", async ({ browser }) => {
  // Anonymous context — public pages must hold without the authed shell.
  const anonCtx = await browser.newContext({ viewport: projectViewport() ?? undefined });
  try {
    const anon = await anonCtx.newPage();
    const routes = [
      "/",
      "/pricing",
      `/live/${orgSlug}`,
      `/live/${orgSlug}/${compSlug}`,
      `/live/${orgSlug}/${compSlug}/register`,
      // Seazn Games (design doc 2026-08-26, W3) — public, no login, no org.
      // Added here rather than the "console routes" test above because
      // these are genuinely anonymous marketing/play surfaces, same as "/"
      // and "/pricing" already on this list, not authed console pages.
      "/games",
      "/games/chess-quest",
      // The organiser's /start wizard (start wizard plan 2026-11-13, T6): its first step as a link lands on it. Every step,
      // walked, is the "start wizard" case at the end of this file.
      "/en/start?sport=football",
      // RS007's two new surfaces, POPULATED — an empty state holds at any
      // width, so visiting them without a real rid/token/join_code would be
      // the vacuous pass this file's own #349 comment warns about.
      statusPath,
      joinPath,
      // RS012 — the pooled solo sign-up's own status page, populated with
      // the NEW "waiting" + deadline copy (register.status.entry.
      // awaitingTeam / awaitingTeamDeadline) — untested at every width
      // until it appears here by name, same rule as RS007's two entries
      // just above.
      soloStatusPath,
      // Task 15 (spectator W1) — the public match-centre fixture page, a
      // band-3 cricket fixture so the Scorecard/Commentary tabs (not just
      // the two-tab fallback) are on screen at every width.
      publicCricketFixturePath,
    ];
    for (const path of routes) {
      // Guards the two RS007 entries: an unset module var would make `goto`
      // hit "/" and pass while proving nothing about either page.
      expect(path, "a route in this list is empty — setup did not fill it").toBeTruthy();
      await anon.goto(path, { waitUntil: "load" });
      await anon.waitForTimeout(300);
      await expectNoHorizontalScroll(anon);
    }
    // Prove the two new pages actually rendered their populated state, not a
    // designed "we couldn't find that registration" — which also holds at
    // every width, and which a bad token or an expired code would produce.
    await anon.goto(statusPath, { waitUntil: "load" });
    await expect(anon.getByText(`Mobile Team ${TAG}`).first()).toBeVisible();
    await anon.goto(joinPath, { waitUntil: "load" });
    await expect(anon.getByText(`Mobile Mate ${TAG}`).first()).toBeVisible();
    // RS012 — the pooled solo sign-up is never assigned in this fixture, so
    // its own status page must show the "still waiting" copy AND (place_by_at
    // is set in the setup test above) the new deadline line — proving BOTH
    // render at this width, not merely that the page loads without overflow.
    await anon.goto(soloStatusPath, { waitUntil: "load" });
    await expect(
      anon.getByText(/waiting for a team/i),
      "an unassigned solo sign-up must show the waiting notice",
    ).toBeVisible();
    await expect(
      anon.getByText(/automatically refunded/i),
      "a solo sign-up with a place_by_at set must show the RS012 deadline line",
    ).toBeVisible();
    // Task 15 — the match centre must actually render (not a 404 or the
    // no-document fallback, both of which also hold at every width).
    await anon.goto(publicCricketFixturePath, { waitUntil: "load" });
    await expect(anon.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  } finally {
    await anonCtx.close();
  }
});

// Spectator W2 (Task 17, MS1) — the competition hub's POPULATED tabs and a
// player's card at every width project. Its own test, not more entries in the
// routes list above: a red there would also hide the RS007/RS012 routes.
// Genuinely anonymous (empty cookies, consent answered so no banner covers the
// page) — a bare `newContext()` inherits the signed-in Pro state. Every tab is
// read from the hub document, never assumed, and each must open as ITSELF: a
// `?tab=` the hub does not render falls back to Overview and would pass the
// scroll check while proving nothing about that tab.
test("spectator hub tabs and a player card: no horizontal scroll, each tab opens as itself (W2 MS1)", async ({ browser }) => {
  const renderable = new Set(["overview", "matches", "table", "knockout", "stats", "teams", "info"]);
  const anonCtx = await browser.newContext({
    viewport: projectViewport() ?? undefined,
    storageState: await consentedAnonymousState(),
  });
  try {
    const anon = await anonCtx.newPage();
    const hubs: { comp: string; tabs: string[] }[] = [];
    for (const comp of [publicCricketCompSlug, compSlug]) {
      expect(comp, "setup did not fill a competition slug").toBeTruthy();
      const res = await anon.request.get(`/api/v1/public/orgs/${orgSlug}/competitions/${comp}/hub`);
      expect(res.status(), `hub document for ${comp}`).toBe(200);
      const doc = ((await res.json()) as { data: { tabs: string[] } }).data;
      hubs.push({ comp, tabs: doc.tabs.filter((id) => renderable.has(id)) });
    }
    console.log(`MS1 hub tabs: ${JSON.stringify(hubs)}`);
    // The premise: the cricket hub is the populated one this test exists for —
    // a live match and two squads. It has no Table tab: its fixture is seeded
    // without a league stage, so there are no standings to draw.
    expect(hubs[0]!.tabs, "the live cricket competition's hub tabs").toEqual(
      expect.arrayContaining(["overview", "matches", "teams", "info"]),
    );
    const routes = hubs.reduce((n, h) => n + h.tabs.length, 0) + 1;
    test.setTimeout(Math.max(FLOOR_MS, routes * ROUTE_CHECK_MS));
    for (const { comp, tabs } of hubs) {
      for (const id of tabs) {
        await anon.goto(`/live/${orgSlug}/${comp}?tab=${id}`, { waitUntil: "load" });
        await expect(anon.getByTestId(`mh-tab-panel-${id}`), `${comp} ?tab=${id} opened a different tab`).toBeVisible();
        await expectNoHorizontalScroll(anon);
      }
    }
    expect(publicCricketPlayerId, "setup did not fill the player id").toBeTruthy();
    await anon.goto(`/live/${orgSlug}/${publicCricketCompSlug}/players/${publicCricketPlayerId}`, { waitUntil: "load" });
    await expect(anon.getByTestId("mh-player-matches").locator('[data-slab="true"]')).toBeVisible();
    await expectNoHorizontalScroll(anon);
  } finally {
    await anonCtx.close();
  }
});

test("RS012: the Registrants tab pool summary banner holds at this width", async ({ page }) => {
  // The banner is page-level content (unlike the assign sheet just below,
  // which is behind a click) — but it renders ONLY when some division has a
  // pooled solo sign-up (registration-hub-registrants-panel.tsx), so the
  // plain "console routes" sweep visiting this same URL earlier in this file
  // proves only that the PAGE doesn't overflow, never that the banner itself
  // is on screen or holds at this width. The seeded solo sign-up (setup test
  // above) is what makes it render here.
  await page.goto(`/o/${orgSlug}/c/${compSlug}/registration?tab=registrants`, { waitUntil: "load" });
  await expect(
    page.locator("[data-registration-hub-pool-summary]"),
    "the pool summary banner must render for the seeded pooled solo sign-up",
  ).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(page);
});

test("RS009: the assign sheet opens, lists its targets, holds at this width with no horizontal scroll, and Escape closes it", async ({
  page,
}) => {
  // The picker is a bottom sheet under `sm` and a centred dialog above it, so
  // the two halves of that design are only ever both exercised by running
  // this across the seven width projects. The page-level inventory above
  // cannot see it at all: the sheet is behind a click, and a surface behind
  // an interaction has no width coverage from a page load.
  //
  // This asserts the SHEET, not just the absence of overflow: a no-horizontal-
  // scroll gate passes on a page where the dialog never opened.
  await page.goto(`/o/${orgSlug}/c/${compSlug}/registration?tab=registrants&division_id=${teamDivisionId}`);

  // Open the registrant's detail panel EXPLICITLY, and let a failure here
  // fail the test. The first version did `.click().catch(() => {})` — a
  // swallowed click — so when the row never opened, the assertion below
  // reported "the assign control is not visible" and said nothing about why.
  // The control is present in every collapsed row's DOM (the panel is a
  // <details>), so "not visible" is the symptom of an unopened row and of a
  // genuinely missing control alike. A test that hides which one it hit
  // costs more than it saves.
  const row = page.locator("details").filter({ hasText: `Mobile Solo ${TAG}` }).first();
  await expect(row, "the seeded solo sign-up must be listed").toBeVisible({ timeout: 15_000 });
  await row.locator("summary").click();

  const opener = row.locator('[data-registration-hub-assign-action="open"]');
  await expect(opener, "a pooled solo sign-up must offer the assign control").toBeVisible({
    timeout: 15_000,
  });
  await opener.click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  // The target list must be reachable inside the sheet at every width — this
  // is the "list-in-a-drawer, not a table at 320px" requirement.
  await expect(page.locator("[data-registration-hub-assign-target]").first()).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Esc closes and the page is usable again — the sheet must never trap the
  // organiser on a narrow screen.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expectNoHorizontalScroll(page);
});

test("news (SPEC-2): feed + post page hold at mobile width", async ({ page, browser }) => {
  // Publish a manual post (free on every plan) so the public feed has content.
  const orgId = (await apiJson<{ id: string }[]>(page.request, "/api/orgs")).data![0]!.id;
  const created = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${orgId}/posts`, "POST", {
    title: `Mobile news ${TAG}`,
    body_md: "Weekend round-up on a narrow phone.",
    kind: "announcement",
  });
  const pub = await apiJson<{ slug: string }>(
    page.request,
    `/api/v1/posts/${created.data!.id}`,
    "PATCH",
    { action: "publish" },
  );
  const postSlug = pub.data!.slug;

  const anonCtx = await browser.newContext({ viewport: projectViewport() ?? undefined });
  try {
    const anon = await anonCtx.newPage();
    await anon.goto(`/live/${orgSlug}/news`, { waitUntil: "load" });
    await anon.waitForTimeout(300);
    await expectNoHorizontalScroll(anon);
    // Assert the card while still ON the feed — the post page has no cards.
    await expect(anon.getByTestId("news-card").first()).toBeVisible();

    await anon.goto(`/live/${orgSlug}/news/${postSlug}`, { waitUntil: "load" });
    await anon.waitForTimeout(300);
    await expectNoHorizontalScroll(anon);
  } finally {
    await anonCtx.close();
  }
});

test("axe: no serious/critical violations on key surfaces (v3/11 gap 11)", async ({ page, request }) => {
  const routes = [
    "/dashboard",
    // Were /competitions/{id} and /divisions/{id}?tab=standings — dead legacy
    // id-routes that 404, so the scan below ran against a 404 page (#349).
    // Re-pointed to the live /o/{org}/c/{comp}/... slug chain, mirroring the
    // "console routes" test's fix for the same class of bug.
    await competitionPath(request, compId),
    await divisionPath(request, divisionId, "?tab=standings"),
    "/settings?tab=organization",
    "/settings/billing",
    `/o/${orgSlug}/c/${compSlug}/upgrade`,
    `/live/${orgSlug}/${compSlug}`,
    // RS010 close-out (v3/11 gap 11 was never re-swept for the Registration
    // redesign) — the public register stepper (divisionId above has
    // registration enabled, open, individual entrant), the Registration hub
    // (both tabs — same two routes the "console routes" no-h-scroll test
    // audits above, reused here for axe), and the register status page
    // (statusPath, seeded by the setup test with a real registration so this
    // renders populated, not its empty state) had zero axe coverage.
    `/live/${orgSlug}/${compSlug}/register`,
    `/o/${orgSlug}/c/${compSlug}/registration?tab=settings`,
    `/o/${orgSlug}/c/${compSlug}/registration?tab=registrants`,
    statusPath,
    // B4 re-review n3: the Streaming page (spec 2026-09-30 §4; its own top-nav page since 2026-10-27) had its axe ruling resting
    // on a read of the rule, not a run — and the Directory's scrolling tab strip (class 23's scrollable-region-focusable) with it.
    "/streaming",
    "/directory?tab=venues",
  ];
  for (const path of routes) {
    const response = await page.goto(path, { waitUntil: "load" });
    expect(response, `${path}: navigation produced no response`).not.toBeNull();
    expect(response!.status(), `${path} returned ${response!.status()}`).toBeLessThan(400);
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking.map((v) => `${path}: ${v.id} — ${v.nodes[0]?.html}`),
      `axe serious/critical on ${path}`,
    ).toEqual([]);
  }
});

// v3/11 gap 15: LCP < 2.5 s on Fast-3G for the money pages. CDP network
// emulation (Chromium only — the mobile projects are Chromium).
const FAST_3G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
};

async function measureLcp(page: Page, path: string): Promise<number> {
  // Pre-warm: the dev server compiles a route on first hit — that cost is
  // build tooling, not page weight, so it stays out of the measurement.
  await page.request.get(path);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", FAST_3G);
  await page.goto(path);
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) resolve(last.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
        // No LCP entry (already settled) — fall back to nav timing.
        setTimeout(() => resolve(performance.now()), 4000);
      }),
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await cdp.detach();
  return lcp;
}

test("LCP < 2.5s on Fast-3G: public dashboard + registration (v3/11 gap 15)", async ({
  browser,
}) => {
  const vp = projectViewport();
  test.skip(
    !vp || (vp.width !== 375 && vp.width !== 390),
    "LCP gates load perf at the phone reference widths only (spec §1); layout is gated by every project",
  );
  const anonCtx = await browser.newContext({ viewport: projectViewport() ?? undefined });
  try {
    const anon = await anonCtx.newPage();
    for (const path of [`/live/${orgSlug}/${compSlug}`, `/live/${orgSlug}/${compSlug}/register`]) {
      const lcp = await measureLcp(anon, path);
      expect(lcp, `LCP on ${path}`).toBeLessThan(2500);
    }
  } finally {
    await anonCtx.close();
  }
});

// The portfolio wave 1 + wave 2 panels (P1 capacity card, P2 health panel, P4
// template gallery) each shipped a new UI surface, and none of the three was
// reachable from this file's route inventory — the /schedule console was
// absent entirely and /c/new had never been listed. The sweep above now visits
// all four routes, but a route sweep alone is vacuous for these three: the
// setup division has no stage, so the capacity card and the health panel are
// simply not in the DOM there, and a page with no panel cannot overflow
// because of one. This test seeds until each panel actually renders, asserts
// it is visible, and only then measures — page-level scroll AND the panel's
// own content, since a card that clips its text inside `overflow-hidden`
// leaves the page width clean.
test("portfolio panels (P1/P2/P4) hold at this width", async ({ page, request }) => {
  const DAY = "2026-10-17";
  const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

  /** Nothing inside `root` may scroll sideways. Text nodes are the ones that
   *  fail first at 320: a metric label or a suggestion row with no wrap. */
  const assertNotClipped = async (selector: string, label: string) => {
    const clipped = await page.evaluate((sel) => {
      const root = document.querySelector<HTMLElement>(sel);
      if (!root) return [`${sel} was not in the DOM`];
      const suspects: HTMLElement[] = [
        root,
        ...Array.from(root.querySelectorAll<HTMLElement>("p,li,dd,dt,h2,h3,span,button")),
      ];
      return suspects
        .filter((el) => el.scrollWidth - el.clientWidth > 1)
        .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
    }, selector);
    expect(clipped, `${label} content is clipped at this width`).toEqual([]);
  };

  // --- P1: the capacity card, in its "impossible" state — the widest it ever
  // gets, because that is the only verdict carrying the suggestion rows. Same
  // arithmetic capacity-precheck.spec.ts uses: 28 fixtures, 1 court, 60-minute
  // matches, one day = 24 slots. 28 > 24, on the free tier.
  const capComp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Capacity ${TAG}`,
    visibility: "private",
  });
  const capDiv = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${capComp.data!.id}/divisions`,
    "POST",
    {
      name: "Capacity",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const capDivisionId = capDiv.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${capDivisionId}/entrants`,
    "POST",
    Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `C${i + 1}`, seed: i + 1 })),
  );
  const capStage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${capDivisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const capGen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${capStage.data!.id}/generate`,
    "POST",
  );
  // Guard the premise, not just the render: 28 is what makes the board
  // impossible, and a generator change that produced fewer would leave this
  // test measuring a card that never appears.
  expect(capGen.data!.fixtures.length).toBe(28);
  const { courts: capCourts } = await seedVenueWithCourts(request, ["Court 1"]);
  const capSettings = await apiJson(request, `/api/v1/divisions/${capDivisionId}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-09-12T00:00:00.000Z",
      endAt: "2026-09-12T23:59:00.000Z",
      matchMinutes: 60,
      gapMinutes: 0,
      courts: [capCourts[0]!.id],
      perEntrantMinRest: 0,
    },
  });
  expect(capSettings.status).toBe(200);

  await page.goto(await divisionPath(page.request, capDivisionId, "/schedule?tab=settings"), {
    waitUntil: "load",
  });
  const capCard = page.locator('[data-capacity-verdict="impossible"]');
  await expect(capCard).toBeVisible({ timeout: 30_000 });
  await expect(capCard.getByText(/Add 1 day|Add 1 court|Shorten matches/i).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await assertNotClipped('[data-capacity-verdict="impossible"]', "the capacity card");

  // --- P2: the health panel, with a real applied board so all five metric
  // cards render (an unapplied stage renders the empty state instead, which
  // is a single line of text and cannot fail a width check).
  const hComp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Health ${TAG}`,
    visibility: "private",
  });
  const hDiv = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${hComp.data!.id}/divisions`,
    "POST",
    {
      name: "Health",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const hDivisionId = hDiv.data!.id;
  const hEntrants = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${hDivisionId}/entrants`, "POST", [
    { kind: "individual", display_name: "Ada H", seed: 1 },
    { kind: "individual", display_name: "Bea H", seed: 2 },
    { kind: "individual", display_name: "Cal H", seed: 3 },
    { kind: "individual", display_name: "Dev H", seed: 4 },
  ]);
  const [h1] = hEntrants.data!.map((e) => e.id);
  const hStage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${hDivisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const hStageId = hStage.data!.id;
  type HFixture = {
    id: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    round_no: number;
  };
  const hGen = await apiJson<{ fixtures: HFixture[] }>(request, `/api/v1/stages/${hStageId}/generate`, "POST");
  const { courts: hCourts } = await seedVenueWithCourts(request, ["Court 1", "Court 2"]);
  await apiJson(request, `/api/v1/divisions/${hDivisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: `${DAY}T00:00:00.000Z`,
      endAt: `${DAY}T23:59:00.000Z`,
      matchMinutes: 60,
      gapMinutes: 0,
      courts: hCourts.map((c) => c.id),
      perEntrantMinRest: 0,
      sessionWindows: [{ from: `${DAY}T09:00:00.000Z`, to: `${DAY}T21:00:00.000Z` }],
    },
  });
  // C1 ("hard lexicographic round ordering", #546) now rejects an applied
  // board where a later round starts before an earlier one, across the
  // solver, verifier AND this apply call. This board used to come from a
  // hand-written pair list (pick(h1,h2)@09:00, pick(h1,h3)@10:15, ...) that
  // assumed its pairing order matched the generator's round assignment — an
  // assumption C1 is not obliged to honour. Derive slot order from each
  // fixture's own round_no instead. If you're about to hand-write a pair
  // list here again, this comment is why it will 409.
  const roundNos = Array.from(new Set(hGen.data!.fixtures.map((f) => f.round_no))).sort((a, b) => a - b);
  // Anchor times keep the original board's shape — an even 75-minute
  // cadence, then a big jump for the last round so gapDispersion still sees
  // a real, non-uniform gap. A round beyond the third keeps stepping by 75
  // minutes rather than assuming there are only three.
  const anchorTimes = ["09:00", "10:15", "15:00"];
  const slotTime = (i: number): string => {
    if (i < anchorTimes.length) return anchorTimes[i]!;
    const [h, m] = anchorTimes[anchorTimes.length - 1]!.split(":").map(Number);
    const minutes = h! * 60 + m! + 75 * (i - anchorTimes.length + 1);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  };
  // Deliberately lopsided (every one of H1's matches on Court 1) so the cards
  // carry real offender counts and "Show details" rows, not a uniform 100.
  //
  // That two-court split only works because this division has exactly FOUR
  // entrants, so a round-robin round holds exactly two fixtures: one with H1
  // (Court 1) and one without (Court 2). Raise the entrant count and a round
  // holds three or more, every non-H1 fixture lands on "Court 2" at the same
  // `scheduled_at`, and the apply route 409s on a court double-booking — a
  // loud failure, but one whose message points at the court conflict rather
  // than at the entrant count that actually caused it. The assertion below
  // fails first, and says so.
  const assignments = roundNos.flatMap((roundNo, i) => {
    const t = slotTime(i);
    const inRound = hGen.data!.fixtures.filter((f) => f.round_no === roundNo);
    expect(
      inRound.length,
      `round ${roundNo} holds ${inRound.length} fixtures; the H1/not-H1 court split only ` +
        `covers two. Raise the court count in schedule-settings to match, or keep this ` +
        `division at 4 entrants.`,
    ).toBeLessThanOrEqual(2);
    return inRound.map((f) => ({
      fixture_id: f.id,
      scheduled_at: at(t),
      court_id: f.home_entrant_id === h1! || f.away_entrant_id === h1! ? hCourts[0]!.id : hCourts[1]!.id,
    }));
  });
  const applied = await apiJson(request, `/api/v1/stages/${hStageId}/schedule/apply`, "POST", {
    assignments,
    source: "manual",
  });
  expect(applied.status).toBeLessThan(300);

  await page.goto(await divisionPath(page.request, hDivisionId, "/schedule?tab=health"), { waitUntil: "load" });
  await expect(page.locator('[data-health-status="ready"]').first()).toBeVisible({ timeout: 30_000 });
  // All five, by name — a panel that rendered one card would otherwise pass.
  for (const metric of [
    "restSpread",
    "courtBalance",
    "gapDispersion",
    "homeAwayAlternation",
    "primeSlotFairness",
  ]) {
    await expect(page.locator(`[data-health-metric="${metric}"]`)).toBeVisible();
  }
  await expectNoHorizontalScroll(page);
  await assertNotClipped("[data-health-panel]", "the health panel");

  // Offender lists are the part that grows without a ceiling, so measure them
  // expanded, not collapsed. "Show details" is the affordance; clicking the
  // card body does nothing.
  const restCard = page.locator('[data-health-metric="restSpread"]');
  await restCard.getByRole("button", { name: /show details/i }).click();
  await expect(restCard.locator("li").first()).toBeVisible({ timeout: 10_000 });
  await expectNoHorizontalScroll(page);
  await assertNotClipped("[data-health-panel]", "the health panel with offenders expanded");

  // --- P4: the template gallery and its detail sheet. The sheet is the part
  // with a two-column date row, which is where 320 breaks if it does.
  await page.goto(`/o/${orgSlug}/c/new`, { waitUntil: "load" });
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalScroll(page);
  await assertNotClipped('[data-testid="template-gallery"]', "the template gallery");

  // euro24, not .first(): P7/D1b (T5) needs a template that actually carries
  // a PROGRESSION map (a stage with a real `progression` field, timing:
  // "setup") to prove that block renders real rule text, and needs the sheet
  // body's reorder (T4, 403c6bfd) proven against the template most likely to
  // break it — PROGRESSION is the block T4's own comment names as having
  // worsened the pre-fix scroll-fold, and .first() (slam128) carries no
  // progression at all, so the old assertions never exercised either.
  await gallery.getByTestId("template-card-euro24").click();
  const dialog = page.locator('[role="dialog"]');
  await expect(page.getByTestId("template-detail-structure")).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(page);

  // PROGRESSION content: not just the testid present — the actual rendered
  // rule text, joining BOTH take rules euro24's knockout stage carries
  // (topNPerGroup + bestNth) with the "and" connector, arrowed to the stage
  // they feed, and prefixed by the SOURCE stage's own name (P7/D1b T6 — the
  // source prefix is what tells two seeded stages apart when a template has
  // more than one, as t20-super8 below does). A block that rendered but
  // stayed empty, dropped the second rule, or dropped the source prefix,
  // would still pass a bare visibility check.
  const progression = page.getByTestId("template-detail-progression");
  await expect(progression).toBeVisible();
  await expect(progression).toContainText("Group Stage: Top 2 per group and 4 best 3-placed → Knockout");

  // Regression guard for T4's reorder: form fields (Name/Starts on/Ends on)
  // must render ABOVE the Structure/Progression prose, not below it — pre-T4
  // the required Ends-on field sat below the sheet's internal scroll fold on
  // every template, and PROGRESSION only made the prose above it longer.
  // boundingBox() never scrolls, so this reads the layout exactly as first
  // painted — a revert to prose-first would put Structure's box above
  // Ends-on's and this comparison would flip.
  const endsOnField = dialog.getByLabel(/^Ends on/i);
  const structureList = page.getByTestId("template-detail-structure");
  const [endsOnBox, structureBox] = await Promise.all([
    endsOnField.boundingBox(),
    structureList.boundingBox(),
  ]);
  expect(endsOnBox, "Ends on field has no layout box").not.toBeNull();
  expect(structureBox, "Structure block has no layout box").not.toBeNull();
  expect(
    endsOnBox!.y,
    "Ends on field must render ABOVE the Structure prose block (T4 reorder)",
  ).toBeLessThan(structureBox!.y);

  // At the tightest width, the field must actually be reachable without
  // scrolling — not merely earlier in the DOM. Walks up to the nearest
  // scrollable ancestor (the sheet's own overflow-y-auto body) and checks
  // the field's rect sits inside ITS unscrolled visible window, which is
  // what a reorder-revert would push it out of.
  if (test.info().project.name === "mobile-320") {
    const reach = await endsOnField.evaluate((el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        node = node.parentElement;
      }
      const elRect = el.getBoundingClientRect();
      if (!node || node === document.body) {
        return {
          withinView: elRect.top >= 0 && elRect.bottom <= window.innerHeight,
          elBottom: elRect.bottom,
          containerBottom: window.innerHeight,
        };
      }
      const containerRect = node.getBoundingClientRect();
      return {
        withinView: elRect.top >= containerRect.top - 1 && elRect.bottom <= containerRect.bottom + 1,
        elBottom: elRect.bottom,
        containerBottom: containerRect.bottom,
      };
    });
    expect(
      reach.withinView,
      `Ends on field (bottom ${reach.elBottom}) must fit inside the sheet's visible ` +
        `scroll area (bottom ${reach.containerBottom}) at 320px without scrolling`,
    ).toBe(true);
  }

  const submit = page.getByTestId("template-detail-submit");
  const submitBox = await submit.boundingBox();
  expect(submitBox, "the template detail submit has no box").not.toBeNull();
  expect(submitBox!.height, `submit touch target is ${submitBox!.height}px`).toBeGreaterThanOrEqual(44);

  // The FOOTER, not the body. `components/modal.tsx` puts the footer outside
  // the scrollable body (`shrink-0`), so it is the part a panel taller than the
  // visible viewport pushes off-screen entirely — no scroll can recover it.
  //
  // HONEST LIMIT: this cannot prove the 85vh→85dvh fix. Headless Chrome has no
  // retractable browser chrome, so `100dvh === 100vh` here and the two spell
  // the same number at every one of these seven widths. The unit assertion in
  // components/__tests__/pass-checkout-parity.test.tsx is what pins the unit;
  // this pins the geometry that unit exists to protect.
  const viewportH = page.viewportSize()!.height;
  expect(
    submitBox!.y + submitBox!.height,
    `the sheet's footer button ends at ${submitBox!.y + submitBox!.height}px, past the ` +
      `${viewportH}px viewport — a footer outside the scroll body cannot be scrolled to`,
  ).toBeLessThanOrEqual(viewportH + 1);

  await page.screenshot({
    path: `test-results/portfolio-panels-${test.info().project.name}.png`,
    fullPage: false,
  });
});

// ---------------------------------------------------------------------------
// Match Day C8 — the New competition form (blank path) and the "Add your first
// division" screen it ends on, at every width. The gallery test above only
// reaches step 0; the form behind "Start from blank" is the part that was
// rebuilt as one column, and the part with three things that break at 320:
// the segmented visibility control (three words in a ~85px segment), the
// Starts/Ends pair (stacked below 360, side by side from it) and the editor
// toolbar (wraps, 44px buttons). One test, one pass over the states the owner's
// shots show: empty, Public + showcase + "What this allows" open, Private with
// the showcase reason, and the screen after Create.
// ---------------------------------------------------------------------------

test("Match Day C8: the New competition form and the first-division screen hold at this width", async ({
  page,
}) => {
  // 1 nav + 1 gallery swap + 3 form passes + 1 create + 1 prompt pass.
  test.setTimeout(Math.max(90_000, 2 * 30_000 + 6 * 10_000 + 20_000));
  const w = page.viewportSize()!.width;
  const vis = (k: "private" | "unlisted" | "public") => uiEn[`visibility.${k}.label`]!;
  const name = `C8 Form ${TAG}-${Math.random().toString(36).slice(2, 6)}`;

  await page.goto(`/o/${orgSlug}/c/new`, { waitUntil: "load" });
  await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("template-start-blank").click();
  const form = page.getByTestId("new-competition-form");
  await expect(form).toBeVisible({ timeout: 10_000 });

  /** Nothing in the form's card may sit outside it (sr-only radios are 1px and skipped), and the page must not scroll sideways. */
  const holds = async (label: string) => {
    await expectNoHorizontalScroll(page);
    const spill = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="new-competition-form"]');
      if (!root) return ["new-competition-form was not in the DOM"];
      const box = root.getBoundingClientRect();
      const out: string[] = [];
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        if (r.left < box.left - 1 || r.right > box.right + 1) {
          out.push(`${el.tagName.toLowerCase()} ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(box.left)}..${Math.round(box.right)}`);
        }
      }
      return out;
    });
    expect(spill, `${label}: something sits outside the form's card at ${w}px`).toEqual([]);
  };

  /** A box whose text is cut by its own container is a defect; `overflowingIn` keeps sr-only and ellipsis-by-design apart from it. */
  const notClipped = async (selector: string, label: string) => {
    const { clipped } = await overflowingIn(
      page,
      selector,
      "p,li,span,button,a,label,summary,h2,h3",
      `${selector} was not in the DOM`,
    );
    expect(clipped, `${label} is clipped at ${w}px`).toEqual([]);
  };

  // --- empty form -----------------------------------------------------------
  await holds("empty form");
  // Every project here is below `lg` (1024), where the form is the ONE column it
  // always was: the description under the decisions, same left edge, same width.
  // (The two-column composition from `lg` is measured by the walkthrough.)
  const decisionsBox = (await form.getByTestId("new-competition-decisions").boundingBox())!;
  const descriptionBox = (await form.getByTestId("new-competition-description").boundingBox())!;
  expect(descriptionBox.y, `the description sits below the decisions at ${w}px`).toBeGreaterThanOrEqual(
    decisionsBox.y + decisionsBox.height,
  );
  expect(Math.abs(descriptionBox.x - decisionsBox.x), `one column at ${w}px: same left edge`).toBeLessThanOrEqual(1.5);
  expect(Math.abs(descriptionBox.width - decisionsBox.width), `one column at ${w}px: same width`).toBeLessThanOrEqual(1.5);
  await assertTapFloor(page.getByPlaceholder(uiEn["comp.wizard.name.placeholder"]!), "name input");
  await assertTapFloor(form.getByLabel(uiEn["comp.wizard.startsOn"]!), "Starts on");
  await assertTapFloor(form.getByLabel(new RegExp(`^${uiEn["comp.wizard.endsOn"]}`)), "Ends on");
  for (const k of ["private", "unlisted", "public"] as const) {
    // `has:` is matched inside each label: page-rooted, not form-rooted.
    const radio = page.getByRole("radio", { name: vis(k), exact: true });
    await assertTapFloor(form.locator("label").filter({ has: radio }), `${k} segment`);
    // The word is the control: three words in three segments must not truncate.
    const clipped = await form
      .locator("label")
      .filter({ has: radio })
      .locator("> span:last-of-type")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(clipped, `the "${vis(k)}" segment truncates its own word at ${w}px`).toBeLessThanOrEqual(0);
  }
  // The editor: 44px toolbar buttons and tabs below lg (every project here is < 1024).
  await assertTapFloor(form.getByRole("tab", { name: uiEn["editor.write"]!, exact: true }), "Write tab");
  const bold = form.getByRole("button", { name: uiEn["editor.bold"]!, exact: true });
  await assertTapFloor(bold, "Bold");
  const boldBox = await bold.boundingBox();
  expect(boldBox!.width, `Bold is ${boldBox!.width}px wide`).toBeGreaterThanOrEqual(44);
  // Create is disabled with its reason shown, and the reason is reachable.
  const create = form.getByRole("button", { name: uiEn["comp.wizard.create"]!, exact: true });
  await expect(create).toBeDisabled();
  await expect(form.getByTestId("create-blocker")).toBeVisible();
  await notClipped('[data-testid="create-blocker"]', "the Create reason");

  // --- Public + showcase + "What this allows" --------------------------------
  await page.getByPlaceholder(uiEn["comp.wizard.name.placeholder"]!).fill(name);
  await form.getByLabel(new RegExp(`^${uiEn["comp.wizard.endsOn"]}`)).fill("2030-12-31");
  const publicSegment = form.locator("label").filter({ has: page.getByRole("radio", { name: vis("public"), exact: true }) });
  await publicSegment.click();
  const showcase = form.getByRole("switch", { name: uiEn["showcase.label"]!, exact: true });
  await expect(showcase).toBeEnabled();
  await assertTapFloor(form.getByTestId("showcase-optin").locator("label").first(), "Showcase row");
  await showcase.check();
  const allows = form.getByText(uiEn["comp.wizard.showcase.allows"]!, { exact: true });
  await assertTapFloor(allows, "What this allows");
  await allows.click();
  await expect(form.getByText(uiEn["showcase.consent"]!)).toBeVisible();
  await expect(form.getByTestId("competition-reach").locator("li[data-audience]")).toHaveCount(5);
  await holds("Public + showcase + consent open");
  // axe on the richest state of the form: the radio group, the switch, the
  // disclosure, the date pair and the editor are all on screen. Serious and
  // critical only, scoped to the form, as the page-level sweep above does.
  {
    const results = await new AxeBuilder({ page })
      .include('[data-testid="new-competition-form"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.passes.length, "axe ran its rules over the form").toBeGreaterThan(0);
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      blocking.map((v) => `${v.id}: ${v.nodes[0]?.html}`),
      `axe serious/critical on the New competition form at ${w}px`,
    ).toEqual([]);
  }

  // --- Private: showcase off, with the reason --------------------------------
  await form.locator("label").filter({ has: page.getByRole("radio", { name: vis("private"), exact: true }) }).click();
  await expect(showcase).toBeDisabled();
  await expect(showcase).not.toBeChecked();
  await expect(form.getByText(uiEn["showcase.needsPublic"]!)).toBeVisible();
  await holds("Private + showcase reason");

  // --- Create, then the first-division screen --------------------------------
  await expect(create).toBeEnabled();
  await create.click();
  const prompt = page.getByTestId("first-division-prompt");
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt).toContainText(name);
  await expectNoHorizontalScroll(page);
  await assertTapFloor(page.getByTestId("first-division-add"), "Add division");
  await assertTapFloor(page.getByTestId("first-division-later"), "Later");
  await notClipped('[data-testid="first-division-prompt"]', "the first-division screen");
  {
    const results = await new AxeBuilder({ page })
      .include('[data-testid="first-division-prompt"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.passes.length, "axe ran its rules over the first-division screen").toBeGreaterThan(0);
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      blocking.map((v) => `${v.id}: ${v.nodes[0]?.html}`),
      `axe serious/critical on the first-division screen at ${w}px`,
    ).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// P7 (D1b task T5) — the t20-super8 catalog template: THREE stages at
// instantiation (group -> Super 8 -> knockout), the first template in the
// catalog where TWO stages carry `progression` (timing: "setup") in the same
// division. Instantiation itself creates NO fixtures (owner ruling, D1b
// brief: a "setup"-timing progression stage mints synthetic entrants and can
// generate with zero real ones, and one fixture row at birth would
// format-lock the competition via both replaceStages and patchDivision) —
// so this proves the stages exist and are visible FIRST, then adds entrants
// and generates before a Super 8 fixture exists to assert on at all.
//
// t20-super8 is 3 stages. That was over community's stages.per_division.max
// (2) until V471 ("all stages are free", owner ruling 2026-10-20) made the
// count unlimited on every plan; this file's shared storageState account is
// the Pro user (playwright.config.ts's AUTH_STATE) either way.
// ---------------------------------------------------------------------------

test("P7/D1b: the t20-super8 template creates 3 stages, and Super 8 fixtures resolve seeded slot labels before the group stage is even played", async ({
  page,
  request,
}) => {
  await page.goto(`/o/${orgSlug}/c/new`, { waitUntil: "load" });
  await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("template-card-t20-super8").click();
  await expect(page.getByTestId("template-detail-structure")).toBeVisible({ timeout: 15_000 });
  // Every mobile/tablet project shares the SAME storageState org (one Pro
  // account, seven concurrent worker processes) — the sheet defaults Name to
  // the template's own translated string verbatim, so leaving it untouched
  // means every project races to insert the identical (org_id, slug) pair.
  // TAG alone is not enough (it's per-PROCESS and this file's own comment
  // above documents two processes landing on the same TAG); add the same
  // random suffix seedScoredDivision() uses for exactly this reason.
  await page
    .getByLabel("Name", { exact: true })
    .fill(`T20 Super 8 ${TAG}-${Math.random().toString(36).slice(2, 6)}`);
  await page.getByLabel(/^Ends on/i).fill("2030-12-31");
  await page.getByTestId("template-detail-submit").click();
  // Away from /c/new specifically — a URL matching the pre-click page would
  // be a vacuous wait (the trap this repo's helpers call out explicitly).
  await page.waitForURL(/\/o\/[^/]+\/c\/(?!new$)[^/?]+$/, { timeout: 20_000 });

  const slug = page.url().match(/\/c\/([^/?]+)/)![1]!;
  const list = await apiJson<{ items: { id: string; slug: string }[] }>(
    request,
    "/api/v1/competitions?limit=100",
  );
  const t20CompId = list.data!.items.find((c) => c.slug === slug)!.id;
  const divs = await apiJson<{ id: string }[]>(request, `/api/v1/competitions/${t20CompId}/divisions`);
  const t20DivisionId = divs.data![0]!.id;

  await page.goto(await divisionPath(page.request, t20DivisionId, "?tab=fixtures"), { waitUntil: "load" });

  // Three stages, visible, before a single entrant exists or Generate has
  // ever been clicked — instantiation creates the STAGE ROWS, never
  // fixtures. Digit-prefixed: StagesPanel's own heading is "{seq}. {name}";
  // ProgressionPanel (rendered above it for each seeded stage) uses the
  // SAME stage name with no digit, so an un-prefixed match would be
  // ambiguous for Super 8 and Knockout (both carry progression).
  await expect(page.getByRole("heading", { name: /^\d+\.\s*Group Stage$/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: /^\d+\.\s*Super 8$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^\d+\.\s*Knockout$/ })).toBeVisible();

  const stages = await apiJson<{ id: string; kind: string; seq: number; name: string }[]>(
    request,
    `/api/v1/divisions/${t20DivisionId}/stages`,
  );
  expect(stages.data!.length, "t20-super8 must instantiate all 3 stages").toBe(3);
  const groupStageId = stages.data!.find((s) => s.name === "Group Stage")!.id;
  const super8StageId = stages.data!.find((s) => s.name === "Super 8")!.id;

  const teamNames = Array.from({ length: 16 }, (_, i) => `T20 Squad ${i + 1}`);
  await addEntrantsViaApi(request, t20DivisionId, teamNames, "team");

  const groupGen = await apiJson(request, `/api/v1/stages/${groupStageId}/generate`, "POST");
  expect(groupGen.status, "group-stage generate").toBeLessThan(300);

  const superGen = await apiJson<{
    created: number;
    fixtures: { fixture_no: number; home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(request, `/api/v1/stages/${super8StageId}/generate`, "POST");
  expect(superGen.status, "Super 8 generate").toBeLessThan(300);
  expect(superGen.data!.created, "Super 8 must generate real fixture rows").toBeGreaterThan(0);
  // The group stage was only just generated, never played — every Super 8
  // fixture must still be TBD on both sides at the data level, not only
  // in the rendered copy asserted below.
  for (const f of superGen.data!.fixtures) {
    expect(f.home_entrant_id).toBeNull();
    expect(f.away_entrant_id).toBeNull();
  }

  await page.reload({ waitUntil: "load" });
  // Competition Desk W2 (Task 4): fixture rows no longer render inside the
  // stage's own card — every fixture now renders ONCE, division-wide, in
  // the run sheet (`<RunSheet>`, mounted once in `stages-panel.tsx`,
  // outside the per-stage card loop). These Super 8 fixtures are all TBD on
  // both sides (never explicitly scheduled), so they land wherever the
  // sheet's grouping puts an untimed OPEN fixture — never assumed here,
  // located instead by `data-fixture-no`, the one stable per-fixture hook
  // the sheet carries, fetched from the generate response rather than
  // guessed at a block or a stage heading's proximity.
  const fixtureRows = page.locator(
    superGen.data!.fixtures.map((f) => `[data-fixture-no="${f.fixture_no}"]`).join(", "),
  );
  await expect(fixtureRows.first()).toBeVisible({ timeout: 15_000 });
  const rowCount = await fixtureRows.count();
  expect(rowCount, "Super 8 must render every one of its generated fixtures").toBe(
    superGen.data!.fixtures.length,
  );
  const rowTexts = await fixtureRows.allTextContents();
  for (const text of rowTexts) {
    // Resolved seed-descriptor text (P6/D4b's slot-label resolver), never a
    // real team name and never the raw pre-P6 "TBD" fallback — proving the
    // seeding rules P7 persists actually reach a non-terminal (group-kind)
    // stage, not only a knockout final (mobile.spec.ts:1051-1052 already
    // covers a knockout; deliberately not re-asserting that exact string
    // here — group letters differ per run and would either collide with or
    // duplicate that pin for no new signal).
    expect(text).toMatch(/Winner of Group|Runner-up of Group/);
    for (const name of teamNames) {
      expect(text, `Super 8 row leaked a real entrant name: ${text}`).not.toContain(name);
    }
  }

  // The board toolbar on a THREE-stage division, at whatever width this
  // project runs. Every other board assertion in this file drives a
  // single-stage division, so the stage selector — the control that replaced
  // one solver triplet PER STAGE — is rendered nowhere else in the seven-width
  // matrix. Two claims, and the second is the one that needs a real browser:
  // the selector offers every runnable stage at a real touch size, and the row
  // it sits in WRAPS rather than pushing the page sideways at 320px, which is
  // the failure mode a segmented control with three long stage names has.
  await page.goto(await divisionPath(request, t20DivisionId, "/schedule?tab=board"), {
    waitUntil: "load",
  });
  const stageOptions = page.getByTestId("schedule-stage");
  await expect(stageOptions).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    const box = await stageOptions.nth(i).boundingBox();
    expect(box, `stage option ${i} has no box`).not.toBeNull();
    expect(
      box!.height,
      `stage option ${i} touch target is ${box!.height}px`,
    ).toBeGreaterThanOrEqual(44);
  }
  // One action set, three stages — the duplication regression, asserted at
  // every width rather than only at desktop.
  await expect(page.getByTestId("schedule-auto")).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// S13/#422 W11 followup — app-wide `.select`/`.input` density-pair sweep.
//
// Same defect as T14b above: a components-layer `.select`/`.input` class sets
// its own padding, but a `px-2 py-1 text-xs` (or `py-1.5 text-sm`, `py-1
// text-xs`, etc.) utility recipe beside it wins under Tailwind's utilities
// layer and silently collapses the control under this repo's 44px touch
// floor. The scorepad tree and the lineup editor were fixed in an earlier
// session; re-deriving the pattern with `git grep` across the rest of
// apps/web/src/components turned up 12 more files (24 controls). `min-h-11`
// on all of them, unconditional — no `sm:`/`md:` escape hatch, for the exact
// reason T14b's comment gives: this file runs under all SEVEN width
// projects (320/360/375/390/430/768/834), including tablet-768/834, and a
// tablet is still a touch device. The density recipes themselves (text-xs,
// etc.) are untouched — this is a sizing fix, not a restyle.
//
// Four of the twelve fixed files are covered below (a fifth — the org-
// console "registrations panel" component — was deleted wholesale by RS001
// along with the rest of the old registration UI — its fix is moot, so its
// check is removed rather than left probing a route that 404s), each reusing a
// fixture this file already has live by this point in the serial run (the
// shared setup division/org and its registration settings, or the console's
// own authenticated session) — no new seeding. The other seven (americano-panel,
// board/move-panel, club-hub/team-squad-editor, division-builder's preview
// step, me/officiating-lane, me/rsvp-control, stages-panel's AddMatchForm +
// inline fixture edit) each need a format/officiating/club-hub scenario this
// file has no fixture for yet — an americano-variant division, an officials
// assignment on the signed-in account, a club with a team and squad, a
// scheduled board to open the move sheet on, or a stage with fixtures to
// open the inline editor on. Adding one bespoke seed per surface for a single
// boundingBox() read would be a lot of new weight for what the fix itself
// already proves is the same mechanical override; flagged here rather than
// faked with a shallow test.
// ---------------------------------------------------------------------------
test("density-pair sweep: four more .select/.input controls hold the 44px floor (S13/#422 W11)", async ({
  page,
  browser,
}) => {
  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };

  // Pricing page currency switcher (currency-switcher.tsx) — anonymous,
  // public; already one of the "public surfaces" routes above, just not
  // previously measured control-by-control.
  const anonCtx = await browser.newContext({ viewport: projectViewport() ?? undefined });
  try {
    const anon = await anonCtx.newPage();
    await anon.goto("/pricing", { waitUntil: "load" });
    await assertFloor(anon.locator("[data-currency-switcher]"), "pricing currency switcher");
  } finally {
    await anonCtx.close();
  }

  // Settings > Team (org-team.tsx) — both invite-role selects render
  // whenever the signed-in account is an editor, which this file's shared
  // session always is (it creates/edits competitions elsewhere without any
  // permission error).
  await page.goto("/settings?tab=team", { waitUntil: "load" });
  await assertFloor(page.getByTestId("team-invite-email-role"), "team invite (email) role select");
  await assertFloor(page.getByTestId("team-invite-link-role"), "team invite (link) role select");
  await expectNoHorizontalScroll(page);

  // Entrants tab (entrants-panel.tsx) — the shared setup division's own
  // entrants (Ada M et al.) already carry a seed input each; no extra seeding.
  await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"), { waitUntil: "load" });
  // By TESTID, not by the accessible name: that name is
  // `entrants.row.seedLabel` in all four catalogues as of 2026-09-22, so an
  // `aria-label^="Seed for "` prefix match selects nothing outside English —
  // and `.first()` on an empty locator fails as a tap-target defect rather
  // than as the selector fault it would be.
  await assertFloor(page.getByTestId("entrant-row-seed").first(), "entrant seed input");
  await expectNoHorizontalScroll(page);
  // Match Day C4: the entrant kinds block sits at the top of this tab (organiser). Folded, its header row holds the floor; opened,
  // so do the three kind chips and the Save, and the page still has no horizontal scroll.
  const kindsToggle = page.getByRole("button", { name: /^Entrant kinds/ });
  await assertFloor(kindsToggle, "entrant kinds header");
  await kindsToggle.click();
  for (const kind of ["individual", "pair", "team"]) await assertFloor(page.getByTestId("entrant-kinds").locator(`[data-kind="${kind}"]`), `entrant kind chip ${kind}`);
  await assertFloor(page.getByRole("button", { name: "Save entrant settings" }), "entrant kinds Save");
  await expectNoHorizontalScroll(page);

  // Registrations tab (the org-console "registrations panel" component) was
  // checked here until RS001 deleted it along with the rest of the old
  // registration UI; the route now 404s, so the check is gone with it.

  // Schedule > History (history-panel.tsx) — the create-save-point form
  // renders whenever `canEdit` is true; it needs no stage or schedule state.
  // `tab=history`, NOT `tab=board`: the panel is only mounted on its own tab
  // (`schedule/page.tsx:382`, `TABS` at :52). The first version of this test
  // navigated to the board and waited 20s for a control that was never on the
  // page — a red that read like an unreachable control and was really a wrong
  // URL.
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=history"), { waitUntil: "load" });
  await assertFloor(page.getByPlaceholder("e.g. before rain reshuffle"), "history save-point input");
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// Archive a sponsor (spec 2026-11-11-sponsor-archive, plan Task 8 step 2) - the three new surfaces at all seven width projects, in es and
// nl (the longest words): the sponsor's page with its Archive card BLOCKED by a live deal, an ARCHIVED sponsor's page with its banner and
// Unarchive, and the list with "Show archived (N)" on. Names are 43 characters (the check a short name cannot fail).
// Its own test with its own seed - never the serial setup test (a sponsor API regression there would abort ~110 tests; see
// `seedSponsorsSweep`). What it holds, each hit-tested the way a finger meets it (elementFromPoint, not a painted box):
//   - the list switch is 44px at EVERY width; the Archive, Unarchive and Add-deal-sheet close buttons are 44px below md (768), where
//     `max-md:min-h-11` / `max-md:h-11` is the declared floor; from 768 they are hit-tested but sized by the desktop rule (SMALL_BTN is
//     30px; the large modal close is 40px) - a tablet floor is not in the design of record, so none is asserted there.
//   - no horizontal page scroll, and nothing of the new surfaces painted past the viewport;
//   - axe serious/critical on the new surfaces (the archive card, the banner, the switch row and the Archived group).
// The list's ⋯ tray is a fold below md: the archived row's tools are opened (gated on the toggle being visible) before the trash is read.
// ---------------------------------------------------------------------------
type ArchiveSweep = { orgId: string; blocked: string; plain: string; archived: string; ids: string[]; blockedId: string; plainId: string; archivedId: string; done: boolean };
let archiveSweep: ArchiveSweep | null = null;
/** 43 characters, distinct from the first letter (the sponsors share one org). */
const archiveName = (head: string): string => `${head} Building Supplies and Timber Company Ltd`.slice(0, 43);

async function seedArchiveSweep(request: APIRequestContext): Promise<ArchiveSweep> {
  // A retry of the test reuses what it already made, so a flaky run does not pile a second set into the org.
  if (archiveSweep !== null && archiveSweep.done) return archiveSweep;
  expect(setupOrgId, "the setup test recorded the active org's id").not.toBe("");
  const orgId = setupOrgId;
  const mk = async (name: string): Promise<string> => {
    const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsors`, "POST", { name, tier: "partner", url: "https://sponsor.example/" });
    expect(res.status, `sponsor ${name} -> ${res.status} ${JSON.stringify(res.error)}`).toBe(201);
    return res.data!.id;
  };
  const blocked = archiveName("Brightwater");
  const plain = archiveName("Wharfside");
  const archived = archiveName("Yardley");
  for (const n of [blocked, plain, archived]) expect(n.length, `${n} is 43 characters`).toBe(43);
  const pkg = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", { name: `Archive gate partner ${TAG}`, price_cents: 25_000, currency: "gbp", tier: "partner" });
  expect(pkg.status, `package -> ${pkg.status} ${JSON.stringify(pkg.error)}`).toBe(201);
  const blockedId = await mk(blocked);
  const plainId = await mk(plain);
  const archivedId = await mk(archived);
  // Recorded as soon as they exist, so the afterAll cleanup finds them even when a later step is the red one.
  const seeded: ArchiveSweep = { orgId, blocked, plain, archived, ids: [blockedId, plainId, archivedId], blockedId, plainId, archivedId, done: false };
  archiveSweep = seeded;
  const deal = await apiJson<{ deal: { deal_status: string } }>(request, `/api/v1/orgs/${orgId}/sponsors/${blockedId}/deals`, "POST", {
    package_id: pkg.data!.id, competition_id: null, payment_method: "complimentary", go_live: "immediate",
  });
  expect(deal.status, `deal -> ${deal.status} ${JSON.stringify(deal.error)}`).toBe(201);
  expect(deal.data!.deal.deal_status, "premise: the complimentary deal is live, so it blocks Archive").toBe("live");
  const arch = await apiJson(request, `/api/v1/orgs/${orgId}/sponsors/${archivedId}/archive`, "POST");
  expect(arch.status, `archive -> ${arch.status} ${JSON.stringify(arch.error)}`).toBe(200);
  seeded.done = true;
  return seeded;
}

// Sponsors with deals cannot be deleted (history), so the live deal is dropped first with privileged SQL, as the sponsors sweep does;
// never throws: a teardown must not fail a green run.
test.afterAll(async ({ request }) => {
  if (archiveSweep === null) return;
  const { orgId, ids } = archiveSweep;
  for (const id of ids) {
    await withDb((sql) => sql`delete from sponsor_orders where org_id = ${orgId} and sponsor_id = ${id}`).catch(() => undefined);
    await apiJson(request, `/api/v1/orgs/${orgId}/sponsors/${id}`, "DELETE").catch(() => undefined);
  }
});

test("sponsor archive: the blocked page, the archived page and the list with the switch, in es and nl - fit, 44px where a finger is the pointer, axe clean", async ({ page, request, baseURL }) => {
  test.setTimeout(300_000);
  const seed = await seedArchiveSweep(request);
  const width = page.viewportSize()!.width;
  const finger = width < 768;
  const visible = (testId: string): Locator => page.locator(`[data-testid="${testId}"]:visible`);
  const axeOn = async (selector: string, label: string): Promise<void> => {
    expect(await page.locator(selector).count(), `${label}: axe has something to scan`).toBeGreaterThan(0);
    const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} - ${v.nodes[0]?.html}`),
      `axe serious/critical on ${label} at ${width}px`,
    ).toEqual([]);
  };
  let checked = 0;
  for (const locale of ["es", "nl"] as const) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    const dict: Record<string, string> = JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"));
    const word = (key: string): string => {
      const v = dict[key];
      if (v === undefined || v === "") throw new Error(`${locale}/ui.json has no ${key}`);
      return v;
    };
    const tag = `${projectTag()} ${locale}`;

    // 1. The blocked page: Archive is shown, disabled, with its reason, in the locale's words.
    await page.goto(sponsorHref(orgSlug, seed.blockedId));
    await expect(visible("sponsor-sheet"), `${tag}: the sponsor's page opens`).toBeVisible({ timeout: 30_000 });
    const archive = visible("sponsor-sheet-archive-button");
    await expect(archive, `${tag}: Archive is offered`).toBeVisible();
    await expect(archive, `${tag}: ...and disabled by the live deal`).toBeDisabled();
    await expect(visible("sponsor-sheet-archive-blocked"), `${tag}: the reason, in ${locale}`).toHaveText(word("sponsors.archive.blocked"));
    await expect(archive, `${tag}: the button says its own word`).toContainText(word("sponsors.archive.button"));
    await hitFloor(archive, `${tag} blocked Archive`, finger ? 44 : 0);
    checked += await paintedInsideViewport(visible("sponsor-sheet-archive"), `${tag} the Archive card`);
    await expectNoHorizontalScroll(page);
    await axeOn('[data-testid="sponsor-sheet-archive"]', `${tag} the blocked Archive card`);

    // 2. An active, unblocked sponsor: Archive is ENABLED (the positive pair), and its Add deal sheet's close is the large one.
    await page.goto(sponsorHref(orgSlug, seed.plainId));
    await expect(visible("sponsor-sheet"), `${tag}: the plain sponsor's page opens`).toBeVisible({ timeout: 30_000 });
    await expect(visible("sponsor-sheet-archive-button"), `${tag}: with no live deal Archive is enabled`).toBeEnabled();
    await expect(visible("sponsor-sheet-archive-blocked"), `${tag}: ...and there is no reason line`).toHaveCount(0);
    await hitFloor(visible("sponsor-sheet-archive-button"), `${tag} Archive`, finger ? 44 : 0);
    const addDeal = visible("sponsor-sheet-add-deal");
    await expect(async () => {
      if (await page.getByTestId("add-deal-sheet").isVisible()) return;
      await addDeal.click({ timeout: 2_000 });
      await expect(page.getByTestId("add-deal-sheet")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    const close = page.locator('[role="dialog"]:has([data-testid="add-deal-sheet"]) button[aria-label="Close"]');
    await expect(close, `${tag}: the Add deal sheet has ONE close`).toHaveCount(1);
    await hitFloor(close, `${tag} modal close`, finger ? 44 : 40);
    await close.click();
    await expect(page.getByTestId("add-deal-sheet"), `${tag}: the close closes it`).toHaveCount(0);
    checked++;

    // 3. The archived page: its banner (the locale's sentence around the date) and Unarchive.
    await page.goto(sponsorHref(orgSlug, seed.archivedId));
    await expect(visible("sponsor-sheet"), `${tag}: the archived sponsor's page opens`).toBeVisible({ timeout: 30_000 });
    const banner = visible("sponsor-sheet-archived");
    await expect(banner, `${tag}: the banner`).toBeVisible();
    const [head, tail] = word("sponsors.archive.banner").split("{date}") as [string, string];
    const parts = [head.trim(), tail.trim()].filter((t) => t.length > 0);
    expect(parts.length, `${tag}: anti-vacuity: the banner sentence has text around its date`).toBeGreaterThan(0);
    for (const part of parts) await expect(banner, `${tag}: the banner reads in ${locale}`).toContainText(part);
    await expect(visible("sponsor-sheet-archive"), `${tag}: no Archive card on an archived page`).toHaveCount(0);
    const unarchive = visible("sponsor-sheet-unarchive");
    await expect(unarchive, `${tag}: Unarchive`).toContainText(word("sponsors.archive.unarchive"));
    await hitFloor(unarchive, `${tag} Unarchive`, finger ? 44 : 0);
    checked += await paintedInsideViewport(banner, `${tag} the archived banner`);
    await expectNoHorizontalScroll(page);
    await axeOn('[data-testid="sponsor-sheet-archived"]', `${tag} the archived banner`);

    // 4. The list with the switch on: the switch (44 at every width), the Archived group, the chip, the greyed row, no sideways scroll.
    await page.goto(sponsorsHref(orgSlug, "sponsors"));
    const filter = page.getByTestId("sponsors-archived-filter");
    await expect(filter, `${tag}: the switch row`).toBeVisible({ timeout: 30_000 });
    const archivedNow = await apiJson<{ archived_at: string | null }[]>(request, `/api/v1/orgs/${seed.orgId}/sponsors?archived=1`);
    const n = archivedNow.data!.filter((s) => s.archived_at !== null).length;
    expect(n, `${tag}: premise: at least the seeded sponsor is archived`).toBeGreaterThanOrEqual(1);
    await expect(filter.locator("label"), `${tag}: "Show archived (N)" in ${locale}`).toHaveText(word("sponsors.archive.show").replace("{count}", String(n)));
    await hitFloor(page.getByTestId("sponsors-archived-switch"), `${tag} the archived switch`, 44);
    const group = page.locator('[data-testid="sponsor-group"][data-tier="archived"]');
    await expect(async () => {
      if (await group.isVisible()) return;
      await page.getByTestId("sponsors-archived-switch").click({ timeout: 2_000 });
      await expect(group).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("sponsors-archived-switch"), `${tag}: the switch reads on`).toHaveAttribute("aria-checked", "true");
    const row = group.getByTestId("sponsor-row").filter({ hasText: seed.archived });
    await expect(row, `${tag}: the archived sponsor's row is in the Archived group`).toHaveCount(1);
    await expect(row.getByTestId("sponsor-row-archived-chip"), `${tag}: its chip, in ${locale}`).toHaveText(word("sponsors.archive.chip"));
    await expect(page.getByTestId("sponsor-row").filter({ hasText: seed.plain }).first(), `${tag}: pair: a live row is on the list too`).toBeVisible();
    // The ⋯ tray folds the row's tools below md: open it (gated on the toggle being visible, never a width literal) and read the trash.
    const opened = await openSponsorRowTools(page, seed.archived);
    await expect(opened.getByRole("button", { name: word("settings.org.sponsors.remove").replace("{name}", seed.archived), exact: true }), `${tag}: an archived row without history keeps its trash`).toBeVisible();
    checked += await paintedInsideViewport(page.getByTestId("sponsors-list-view"), `${tag} the list`);
    await expectNoHorizontalScroll(page);
    await axeOn('[data-testid="sponsors-archived-filter"]', `${tag} the switch row`);
    await axeOn('[data-testid="sponsor-group"][data-tier="archived"]', `${tag} the Archived group`);
  }
  expect(checked, "anti-vacuity: painted boxes were counted across both locales").toBeGreaterThan(20);
});
