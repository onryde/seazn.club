import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  createStageAndGenerate,
  competitionPath,
  divisionPath,
  fixturePath,
  seedRosteredFixture,
  loginUi,
  claimProfileBySql,
  setOrgLocaleSql,
  scoreFixture,
  seedVenueWithCourts,
  setBoolEntitlementOverrideSql,
  setDivisionConfigSql,
  setFixtureScheduledAtSql,
  setFixtureStatusSql,
  setStageStatusSql,
  overflowingIn,
  matchRoomPathBySql,
} from "./helpers";
import { longName, roundGameSql, seedOnlineRound, uiEn } from "./match-room-kit";
import { ARMAGEDDON_RESULTS } from "@seazn/engine/sports/boardgame";
import { builtinModules } from "@seazn/engine/sports";
import { SPONSORS_TABS, sponsorsHref } from "../src/lib/sponsors-hub";
import { RULEBOOK_SPLITS } from "../src/components/v2/stage-rules/__tests__/_points-split-rulebook";
import {
  HIT_TARGET_FLOOR_PX,
  consentedAnonymousState,
  dismissCookieBanner,
  floorViolationLines,
  hitTargetFloorReport,
  measureHitTargets,
} from "./scorepad-a11y-kit";
import { V3_SKIN_CASES, type V3SkinRosterSlot } from "./v3-skin-catalog";
import { WIDTH_MATRIX_CLOCK_SPORTS } from "./v3-width-matrix-coverage";
import { SPORT_RULES } from "../src/lib/match-rules";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { FLOOR_MS, ROUTE_CHECK_MS } from "./spectator-w2-kit";
import { withDb } from "./rs007-money-kit";
import { STORAGE_KEY as GAME_2048_STORAGE_KEY, type GameState as Game2048State } from "../src/games/2048/state";

// v3/02 §4 viewport gate — runs ONLY in the mobile-se / mobile-14 projects
// (375×667, 390×844). Every audited route must render with zero page-level
// horizontal scroll; key surfaces must pass axe (serious/critical) and the
// public dashboard + registration page must LCP under 2.5 s on Fast-3G
// (v3/11 gaps 11, 12, 15).
test.describe.configure({ mode: "serial" });

/** The viewport this PROJECT declares. Raw `browser.newContext()` does not
 *  inherit project `use` options, so every anon context must thread this
 *  through explicitly or it silently runs at Playwright's 1280×720 default. */
const projectViewport = (): { width: number; height: number } | null =>
  (test.info().project.use as { viewport?: { width: number; height: number } })
    .viewport ?? null;

/** The scorebug's own clipping gate. Nothing inside it may be silently
 *  clipped. Two things are allowed to overflow, each held to its own
 *  invariant: the phone meta rail must be keyboard-reachable, which is the
 *  same `tabindex` axe's `scrollable-region-focusable` demanded of it (CI
 *  e2e run 33735186301, `parallel 2/2`); a `max-md:truncate` hint or a
 *  `max-md:line-clamp-2` name must carry `text-overflow: ellipsis` or a real
 *  `-webkit-line-clamp` — not merely `overflow: hidden` — as its own signal
 *  that content was shortened on purpose. Asserting both exemptions pays for
 *  itself: a rail that lost its tab stop, a hint or name that lost its
 *  truncation signal, or a NEW `overflow-x-auto`/`truncate`/`line-clamp` box
 *  appearing in the scorebug without the property that earns its exemption,
 *  reddens here instead of quietly widening either one. */
async function expectScorebugNotClipped(page: Page, label: string): Promise<void> {
  const { clipped, scrollable } = await overflowingIn(
    page,
    '[data-role="v3-scorebug"]',
    "button,div,span",
    "the scorebug was not in the DOM",
  );
  expect(clipped, `${label} is clipped at this width`).toEqual([]);
  for (const box of scrollable) {
    expect(box, `${label}: a scrolling box inside the scorebug is not keyboard-reachable`).toMatch(/tabindex=0$/);
  }
}

/** Phone composition (spec 2026-09-02-scorepad-v3-phone-composition-design.md §6.2).
 *  Prints the visible control list so a reviewer can diff phone vs desktop by
 *  eye, then asserts the composition — not the box sizes — at this project's
 *  width. `model` "S": the scorebug halves are the rally buttons; "T": the
 *  first tile is the primary tap. */
async function expectPhoneComposition(page: Page, model: "S" | "T"): Promise<void> {
  const vp = projectViewport();
  if (!vp) return;
  const phone = vp.width < 768;
  await page.evaluate(() => window.scrollTo(0, 0));
  const controls = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden";
      })
      .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)),
  );
  console.log(`[phone-composition ${vp.width}x${vp.height}] ${controls.length} visible controls:\n  ${controls.join("\n  ")}`);

  const deskHandover = page.locator('[data-role="device-handover"]');
  const phoneHandover = page.locator('[data-role="device-handover-phone"]');
  const handoverOffered = (await deskHandover.count()) > 0;
  // Spec 2026-09-30 §2: Stream is the second twinned control — a desktop button and a phone strip icon, one mount.
  const deskStream = page.locator('[data-role="fixture-stream"]');
  const phoneStream = page.locator('[data-role="fixture-stream-phone"]');
  const streamOffered = (await deskStream.count()) > 0;
  // Twins are EQUAL in presence (one mount drives both) — never one without the other.
  expect(await phoneStream.count(), "the stream twins are present together or not at all").toBe(await deskStream.count());
  // Anti-vacuity: both callers are an organiser's fixture page on the shared Pro org (AUTH_STATE), where streaming is
  // entitled since V426 — so the twin checks below must have something to check.
  expect(streamOffered, "an organiser's fixture page on an entitled org offers Stream").toBe(true);
  const detailsToggle = page.locator('[data-role="match-details-toggle"]');
  const scoringHeading = page.locator('[data-role="console-scoring"] h2');
  const activityToggle = page.locator('[data-role="v3-activity-toggle"]');
  const rows = page.locator('[data-role="v3-activity-row"]');
  const rowCount = await rows.count();

  if (phone) {
    if (handoverOffered) {
      await expect(phoneHandover).toBeVisible();
      await expect(deskHandover).toBeHidden();
    }
    if (streamOffered) {
      await expect(phoneStream).toBeVisible();
      await expect(deskStream).toBeHidden();
    }
    await expect(detailsToggle).toBeVisible();
    await expect(scoringHeading).toBeHidden();
    await expect(page.locator('[data-role="v3-headline"]')).toBeHidden();

    // The primary tap sits inside the first screen, with the page at the top.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const target =
      model === "S"
        ? page.locator('button[data-role="v3-scorebug-half"]').first()
        : page.locator('[data-role="v3-tiles"] button[data-tile-id]').first();
    const box = await target.boundingBox();
    expect(box, "primary tap target must render").not.toBeNull();
    // Claim 3 evidence: printed regardless of pass/fail, since Playwright
    // only echoes the assertion message on FAILURE and this task's report
    // needs the real measured numbers even from a passing run.
    console.log(
      `[phone-composition ${vp.width}x${vp.height}] primary tap target ("${model}"): y=${Math.round(box!.y)} height=${Math.round(box!.height)} bottom=${Math.round(box!.y + box!.height)} (first screen is ${vp.height}px)`,
    );
    expect(
      box!.y + box!.height,
      `primary tap target bottom edge (${Math.round(box!.y + box!.height)}px) must sit inside the ${vp.height}px first screen`,
    ).toBeLessThanOrEqual(vp.height);
    // Nothing overlays it at its centre — a 44px box under a sheet is still a miss.
    expect(
      await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at !== null && (at === el || el.contains(at));
      }),
    ).toBe(true);

    // Claim 1 (2026-09-02-scorepad-v3-phone-composition Task 6 — never
    // measured before this): scorebug.tsx line ~424 reasons that
    // `max-md:shrink-0` alone, with deliberately NO `whitespace-nowrap`
    // (its own comment: nowrap would reintroduce the min-content floor
    // `min-w-0` exists to remove), holds a RESERVED strip item at its full
    // natural width on the phone rail instead of letting flex-shrink squeeze
    // the cell until an unbroken token (a candidate name) overflows it.
    // Only badminton's flow (model "S") ever produces a reserved item here —
    // the "server" slot, skins/badminton.tsx:851 — cricket's strip carries no
    // `reserve` at all. Measured directly: the wrapper's rendered width
    // against its own scrollWidth; if shrink-0 were not holding, an unbroken
    // token would push scrollWidth past rect.width.
    if (model === "S") {
      const reservedServer = page.locator('[data-strip-reserve="true"]:has([data-strip-item-id="server"])');
      if ((await reservedServer.count()) > 0) {
        const [rectWidth, scrollW] = await reservedServer.first().evaluate((el) => [
          el.getBoundingClientRect().width,
          el.scrollWidth,
        ]);
        console.log(
          `[phone-composition ${vp.width}x${vp.height}] reserved "server" strip item: rect.width=${rectWidth} scrollWidth=${scrollW}`,
        );
        expect(
          scrollW,
          `reserved strip item content (scrollWidth ${scrollW}px) must not exceed its box (rect.width ${rectWidth}px) — max-md:shrink-0 must hold the width without whitespace-nowrap`,
        ).toBeLessThanOrEqual(Math.ceil(rectWidth));
      }
    }

    // Ledger: latest only until the toggle is tapped; every row after.
    if (rowCount > 1) {
      await expect(activityToggle).toBeVisible();
      expect(await rows.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).length)).toBe(1);
      await activityToggle.click();
      // Re-count after expand: a tap's ledger row can land between the initial
      // `rowCount` snapshot and this click (badminton's two half-taps are
      // back-to-back with no poll), and `max-md:hidden` only toggles on the
      // rows that exist at render time — stale `rowCount` then reads "expected
      // 2, got 3 visible" even though the product is correct.
      const expandedCount = await rows.count();
      expect(await rows.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).length)).toBe(
        expandedCount,
      );
      await activityToggle.click();
    }
    // Lineup disclosures: rows visible, editors folded.
    const disclosures = page.locator('[data-role="phone-disclosure-toggle"]');
    const disclosureCount = await disclosures.count();
    for (let i = 0; i < disclosureCount; i++) await expect(disclosures.nth(i)).toBeVisible();
    // Review fix (Important 3, final review) — nothing here ever OPENED a
    // disclosure: every prior assertion ran with the body CLOSED, so
    // `phone-disclosure.tsx`'s open branch (`aria-expanded="true"`,
    // `hideLabel`, the body becoming visible) was unproven, and so was
    // `expectNoHorizontalScroll` in the one state that actually shipped a
    // 106px overflow at 320px. One disclosure is enough to witness it —
    // opening every row on every route would be expensive for no more
    // coverage, since they all share the same component.
    if (disclosureCount > 0) {
      const wrapper = page.locator('[data-role="phone-disclosure"]').first();
      const first = wrapper.locator('[data-role="phone-disclosure-toggle"]');
      const body = wrapper.locator("> div");
      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "true");
      await expect(body).toBeVisible();
      await expectNoHorizontalScroll(page);
      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "false");
    }
  } else {
    if (handoverOffered) {
      await expect(deskHandover).toBeVisible();
      await expect(phoneHandover).toBeHidden();
    }
    if (streamOffered) {
      await expect(deskStream).toBeVisible();
      await expect(phoneStream).toBeHidden();
    }
    await expect(detailsToggle).toBeHidden();
    await expect(scoringHeading).toBeVisible();
    await expect(activityToggle).toBeHidden();
    // Phone-only disclosures stay `md:hidden` (spec §3.10). Lineup/roster
    // opted into `desktopCollapsible` (PR #782) so their toggle is visible
    // at tablet too — asserting every toggle hidden reddened cricket v3 pad
    // at 768/834 (run 34834966169). `/(^|\s)md:hidden(\s|$)/` so this does
    // not match inside `max-md:hidden`.
    for (const el of await page.locator('[data-role="phone-disclosure-toggle"]').all()) {
      const phoneOnly = await el.evaluate((node) =>
        /(^|\s)md:hidden(\s|$)/.test((node as HTMLElement).className),
      );
      if (phoneOnly) await expect(el).toBeHidden();
      else await expect(el).toBeVisible();
    }
  }
  await expectNoHorizontalScroll(page);
}

/** The project (viewport) this test is running under, e.g. "mobile-430".
 *  helpers.ts's `TAG` is `Date.now().toString(36)`, evaluated once per
 *  worker process — and a single `npx playwright test` invocation starts
 *  all seven width projects as separate worker processes nearly
 *  simultaneously, so two of them can land in the same millisecond and
 *  resolve the SAME TAG (measured: the collision moved from mobile-430 to
 *  tablet-834 between two otherwise-identical runs). Any P6 test that
 *  MUTATES shared state folds this into its identity (email), because
 *  mintLoginPathBySql's `insert ... on conflict (email) do nothing` makes a
 *  colliding email log both workers into the literal same user — and from
 *  there the same org, division and seed proposal, which is what produced
 *  the `selectOption` timeout: one worker's confirm() flips the proposal
 *  out from under the other, whose rows are then correctly no longer
 *  editable. Read-only P6 tests that must see a mutating sibling's data
 *  (same block, same worker) reuse that sibling's tagged identity instead
 *  of computing their own — see the P6 setup/org-surface/public-surface and
 *  P6 task B blocks below. */
const projectTag = (): string => test.info().project.name;

// The check that guards every other 375px assertion in this file. It compared
// document.scrollWidth against clientWidth, which `overflow-x: clip`
// (globals.css:63) pins to the viewport — so a 525px overflow read as clean.
// This probe is the control: if it ever passes, the helper is blind again and
// every "no horizontal scroll" test in the suite is decorative.
test("CONTROL (#325): the overflow check itself can fail", async ({ page }) => {
  await page.goto("/pricing", { waitUntil: "load" });
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "overflow-probe";
    probe.style.cssText = "width:900px;height:8px;background:transparent";
    document.body.appendChild(probe);
  });
  await expect(expectNoHorizontalScroll(page)).rejects.toThrow(/overflow/i);
  await page.evaluate(() => document.getElementById("overflow-probe")?.remove());
  await expectNoHorizontalScroll(page);
});

let compId = "";
let compSlug = "";
let divisionId = "";
/** RS009 — the TEAM division that accepts solo sign-ups, so the assign
 *  picker has somewhere to place someone. */
let teamDivisionId = "";
let orgSlug = "";
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
  // Published so `/shared/${orgSlug}` below has this card to hold at every
  // width: a draft is listed nowhere (owner decision 2026-09-27), and an org
  // home with nothing on it is the vacuous empty state #349 warns about.
  const published = await apiJson<{ status: string }>(request, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "published",
  });
  expect(published.data?.status, JSON.stringify(published.error)).toBe("published");
  const org = await activeOrg(page);
  orgSlug = org.slug;

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
    `/shared/${orgSlug}/${compSlug}/register/status` +
    `?rid=${submitted.data!.group_id}&token=${submitted.data!.access_token}`;
  joinPath = `/shared/${orgSlug}/${compSlug}/register/join?join_code=${joinCode}`;

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
    `/shared/${orgSlug}/${compSlug}/register/status` +
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
  publicCricketFixturePath = `/shared/${orgSlug}/${mcCompSlug.data!.slug}/${mcDivSlug.data!.slug}/fixtures/${mcFx.fixtureId}`;
  publicCricketCompSlug = mcCompSlug.data!.slug;
  publicCricketPlayerId = mcFx.personIds[`MC Home 1 ${TAG}`]!;
});

// "load" + a short settle instead of networkidle — the dev server's HMR
// socket keeps the network permanently busy and cold compiles already eat
// the budget.
async function auditRoute(
  page: Page,
  path: string,
  opts: { allowancePx?: number; requireScorePad?: boolean } = {},
) {
  const response = await page.goto(path, { waitUntil: "load" });
  expect(response, `${path}: navigation produced no response`).not.toBeNull();
  expect(response!.status(), `${path} returned ${response!.status()}`).toBeLessThan(400);
  await page.waitForTimeout(300);
  if (opts.requireScorePad) {
    // R3.5 review round 1 (finding 3) — a 2xx status and no overflow both
    // pass on a console that rendered its shell with NO pad at all (a
    // division config that fails z.object parsing on the way in does
    // exactly this — see the decider seeding below). Same class as the
    // #349 404 vacuity this file already records above: a route that
    // "passed" without ever rendering the surface it was meant to audit.
    // Opt-in, not the default — most routes here legitimately have no pad.
    await expect(
      page.getByTestId("score-pad"),
      `${path}: expected the score pad to be visible, not just a ${response!.status()} response`,
    ).toBeVisible();
  }
  await expectNoHorizontalScroll(page, opts);
}

/** R3.5 Task A — dispatch a real ledger event, reading `last_seq` fresh each
 *  call. Same shape as gallery.capture.ts's and scorepad-v3-football.spec.ts's
 *  own `postEvent`, needed here to seed the two decider console routes below
 *  without hand-tracking `expected_seq` across a dozen calls. */
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

/** R3.5 Task A — MERGE a few cfg keys into the division's existing config,
 *  never replace it (same shape as gallery.capture.ts's own
 *  `mergeDivisionConfig`). Called BEFORE the first event so no fold has read
 *  the old shape. */
async function mergeDivisionConfig(
  request: APIRequestContext,
  divisionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const div = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  if (div.status !== 200 || !div.data) {
    throw new Error(`mergeDivisionConfig: GET division -> ${div.status} ${JSON.stringify(div.error)}`);
  }
  await setDivisionConfigSql(divisionId, { ...div.data.config, ...patch });
}

test("console routes: no horizontal scroll", async ({ page, request }) => {
  const routes: Array<{ path: string; allowancePx?: number }> = [
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
    // editor-only tabs (On stream, Packages and orders) render their bodies rather than falling back to Overview.
    ...SPONSORS_TABS.map((tab) => ({ path: sponsorsHref(orgSlug, tab) })),
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
  for (const { path, allowancePx } of routes) {
    await auditRoute(page, path, { allowancePx });
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

/**
 * Settings W2 task 4 — the org identity row at `/settings?tab=organization`.
 *
 * The row exists to say WHICH organisation you are in, and at phone widths it
 * did not. The name block was `flex-1`, i.e. `flex: 1 1 0%`, so it was the
 * only child of that row that could yield: the 44px avatar is `shrink-0`, and
 * the role badge and the org switcher both size to their content. At 320 the
 * card's inner width is ~240px, those three take nearly all of it, and the
 * one thing the row is for was left a sliver. `min-w-0` was already present,
 * so the usual `truncate` diagnosis is NOT the cause here.
 *
 * Nothing in `apps/web` vitest can see any of this — that suite is
 * `environment: "node"`, so it has no layout at all — and the page-level
 * no-horizontal-scroll audit above passes either way, because a squeezed
 * `truncate` box produces no page overflow. This is the gate.
 *
 * Two assertions, because either alone is satisfiable the wrong way:
 *
 *  - the name's RENDERED box is wide enough to read. A reachability check
 *    ("the name is visible") passes at 38px, which is the defect.
 *  - the row's COMPOSITION, in both directions: below `md` the chrome sits on
 *    its own line, at `md` and up it stays on the name's line. That second
 *    branch is the "≥768 must not change" guard, and the pair together is
 *    what stops the fix being "make the badge smaller" — a phone view showing
 *    the same controls at smaller sizes is a groomed shrink.
 */
test("settings identity row: the org name keeps a readable share, and the chrome wraps below md", async ({
  page,
}) => {
  const width = projectViewport()?.width ?? 0;
  const isPhone = width < 768;

  await page.goto("/settings?tab=organization", { waitUntil: "load" });
  const name = page.getByTestId("org-identity-name");
  await expect(name).toBeVisible();
  // A row that renders an empty name would satisfy every box assertion below.
  await expect(name).not.toHaveText("");

  // The 140px floor is NOT a soft margin, and it is not tightest at the
  // narrowest width. Measured after the fix: 320→182, 360→222, 375→168,
  // 390→183, 430→223. 375 sits LOWER than 320 because the badge's 57px still
  // fits on the first line there and takes 57+12 out of the name's share,
  // while at 320 it wraps away and gives that space back. So the width with
  // the least headroom over this floor is 375, not 320 — a change that looks
  // safe when eyeballed at 320 can breach it at 375 first. Check 375 whenever
  // anything joins or leaves this row.
  //
  // Both halves are SOFT so neither can hide behind the other. A hard first
  // expectation aborts the test, which is how one half of a two-part gate ends
  // up never having been watched to fail — failure class 3, an assertion only
  // ever seen to pass is decoration. Measured 2026-09-05 on the pre-fix bundle:
  // the width half reported red at all five phone projects (6/46/61/76/116 px)
  // and the composition half never ran at all, because this expectation stopped
  // the test first. Soft, they both report on every red, at every width.
  const box = await name.boundingBox();
  expect(box, "identity name has no box").not.toBeNull();
  expect
    .soft(
      Math.round(box!.width),
      `org name box at viewport ${width}px, text ${JSON.stringify(await name.textContent())}`,
    )
    .toBeGreaterThan(140);

  // Composition, measured as "do the first and last children of the identity
  // row share a line" — NOT as a comparison of box sizes. With `items-center`
  // two children on one flex line always overlap vertically; two children on
  // different lines never do.
  const geom = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="org-identity-name"]');
    const row = el?.parentElement?.parentElement ?? null;
    if (!row) return null;
    const kids = Array.from(row.children) as HTMLElement[];
    const rects = kids.map((k) => k.getBoundingClientRect());
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) return null;
    return {
      children: kids.length,
      sameLine: first.top < last.bottom - 1 && last.top < first.bottom - 1,
      tops: rects.map((r) => Math.round(r.top)),
      bottoms: rects.map((r) => Math.round(r.bottom)),
    };
  });
  expect(geom, "identity row not found from the name testid").not.toBeNull();
  // Pin the shape this measurement assumes: avatar, name block, badge,
  // switcher. If the row gains or loses a child, `first`/`last` stop meaning
  // what this test thinks they mean, and it should red rather than drift.
  expect(geom!.children, "identity row child count").toBe(4);
  const seen = `tops ${geom!.tops.join(",")} bottoms ${geom!.bottoms.join(",")}`;
  if (isPhone) {
    expect.soft(geom!.sameLine, `${width}px: chrome must wrap BELOW the name — ${seen}`).toBe(false);
  } else {
    expect.soft(geom!.sameLine, `${width}px: the row must stay on ONE line — ${seen}`).toBe(true);
  }
});

/**
 * Minor 2 (fix round H): the COMPETITION DESK had zero automated width
 * coverage. This file carried no `desk-ledger-row` / `desk-needs-you` /
 * `desk-masthead` selector at all, and the desk branch never touched it —
 * while all seven width projects (320/360/375/390/430/768/834) run
 * `testMatch: /mobile\.spec\.ts/`. In this repo a UI surface is unprotected
 * until it appears in this file BY NAME, so the owner-ruled mobile CARD
 * composition — the one the owner rejected a shrunken desktop table for —
 * had none.
 *
 * The ruling it enforces (_RULES.md, "Mobile is designed, not shrunk"):
 * below `md` the row is its OWN composition — the whole card body is one
 * link, the pill sits beside the name, the status line wraps, there is NO
 * "Open" button and NO "⋯" menu, and a red attention gets one full-width
 * >=44px action. At `md` and up it is the desktop grid instead.
 *
 * This asserts the ruling the only way a capture cannot: by comparing the
 * visible CONTROL SET on either side of the `md` boundary (768px), which
 * these seven projects straddle — 320/360/375/390/430 are below it,
 * tablet-768/834 at or above. Same set with smaller boxes would be a shrink;
 * different sets is a composition.
 */
test("competition desk: the division row is a CARD below md and a grid at md, not the same controls resized", async ({
  page,
  request,
}) => {
  const width = projectViewport()?.width ?? 0;
  const isCardWidth = width < 768;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk Width ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status).toBe(201);
  const makeDivision = async (name: string) => {
    const div = await apiJson<{ id: string; slug: string }>(
      request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    expect(div.status).toBe(201);
    await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
    const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
    expect(fixtureIds.length).toBe(6);
    const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    expect(started.status).toBeLessThan(400);
    return { div: div.data!, stageId, fixtureIds };
  };

  // One CLEAN row (no attention: every fixture dated in the future) and one
  // RED row (its league played out and complete, a `setup`-timing Finals
  // stage still owing its draw). The action only exists on the red one, so a
  // fixture with a single clean row would leave the action untested and one
  // with a single red row could not tell "no action here" from "no action
  // ever".
  const clean = await makeDivision("Clean Cup");
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
  for (const id of clean.fixtureIds) await setFixtureScheduledAtSql(id, tomorrow);
  const red = await makeDivision("Red Cup");
  for (const id of red.fixtureIds) await setFixtureStatusSql(id, "decided");
  await setStageStatusSql(red.stageId, "complete");
  const finals = await apiJson(request, `/api/v1/divisions/${red.div.id}/stages`, "POST", {
    seq: 2, kind: "knockout", name: "Finals", config: {},
    progression: {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    },
  });
  expect(finals.status).toBe(201);

  // Self-contained: the org path comes from the competition's own org_id
  // (competitionPath), never this file's shared `orgSlug` — which is filled
  // by the setup test and is EMPTY under a `-g` filtered run, silently
  // navigating to `/o//c/...` and finding zero rows.
  await page.goto(await competitionPath(request, comp.data!.id), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const rows = page.getByTestId("desk-ledger-row");
  await expect(rows).toHaveCount(2);
  const redRow = rows.filter({ hasText: "Red Cup" });
  const cleanRow = rows.filter({ hasText: "Clean Cup" });
  // Print the asserted CONTENT beside every gate below: a width gate cannot
  // tell you it measured the wrong page STATE, and this whole test is
  // meaningless if the red row is not actually red.
  await expect(redRow).toHaveAttribute("data-phase", "setting_up");
  await expect(cleanRow).toHaveAttribute("data-phase", "scheduled");
  // M1 (fix round I, instance TWELVE): this shape — a setup-timing Finals
  // whose TBD bracket was never generated — used to read "Needs draw" and
  // offer "Compute proposal", a button the landing page cannot operate until
  // the bracket exists. It is `needs_fixtures` now; the ruling this test
  // exists for (the CONTROL SET, not the words) is untouched.
  await expect(redRow.locator('[data-pill="needs_fixtures"]:visible').first()).toBeVisible();
  await expect(page.getByTestId("desk-needs-you")).toBeVisible();
  await expect(page.getByTestId("desk-masthead-pill")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The CONTROL SET, per row. Below md: the card body (one link) plus, on a
  // red row only, one action. At md and up: the name link, "Open", and the
  // "⋯" menu — three, on EVERY row.
  const openLink = (row: typeof redRow) => row.getByRole("link", { name: "Open", exact: true });
  const menuButton = (row: typeof redRow) => row.getByRole("button", { name: /^Actions/ });
  const action = redRow.getByRole("link", { name: "Open fixtures" });

  if (isCardWidth) {
    await expect(redRow.locator("a:visible, button:visible")).toHaveCount(2);
    await expect(cleanRow.locator("a:visible, button:visible")).toHaveCount(1);
    await expect(openLink(redRow)).toBeHidden();
    await expect(menuButton(redRow)).toBeHidden();

    // "The whole card is one link": the name, the pill, the progress bar and
    // the status line are all INSIDE the single visible body link, not
    // siblings of it. A screenshot cannot tell these apart.
    const body = cleanRow.locator("a:visible").first();
    await expect(body).toContainText("Clean Cup");
    await expect(body).toContainText("of 6");
    await expect(body.locator("[data-pill]")).toHaveCount(1);

    // The one action: full width and >=44px, and actually TAPPABLE there
    // (boundingBox reports paint, not hit area).
    await expect(action).toBeVisible();
    // Scroll it in FIRST: `boundingBox()` is viewport-relative, and at 320
    // this row sits below the fold, so `elementFromPoint` on the unscrolled
    // coordinates returns null and the hit-test would report a false defect.
    // (It did, on the first run of this test — which is also the proof the
    // hit-test is not vacuous.)
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    expect(box, "the red row's action must have a measurable box").not.toBeNull();
    expect(box!.height, "a mobile action must clear the 44px touch floor").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    expect(box!.width, "the mobile action is full-width, not an inline button").toBeGreaterThan(width * 0.7);
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x!, y!);
        return el ? `${el.tagName}:${(el.textContent ?? "").trim().slice(0, 40)}` : "none";
      },
      [box!.x + box!.width / 2, box!.y + box!.height / 2],
    );
    expect(hit, "the action's own centre must hit the action, not an overlay").toContain("Open fixtures");
  } else {
    await expect(redRow.locator("a:visible, button:visible")).toHaveCount(3);
    await expect(cleanRow.locator("a:visible, button:visible")).toHaveCount(3);
    await expect(openLink(redRow)).toBeVisible();
    await expect(menuButton(redRow)).toBeVisible();
    await expect(openLink(cleanRow)).toBeVisible();
    await expect(menuButton(cleanRow)).toBeVisible();
    // The card-only action does not survive into the desktop composition —
    // if it did, "different sets" would be a lie and this would be a reflow.
    await expect(action).toBeHidden();
  }
});

// F2 + F5 (round J). The desk's TOOL ROW below `sm`, and the Now line on the
// phone card.
//
// Before this the five tools were `hidden sm:inline` labels over 46x34 icon
// tiles: unlabelled, under the 44px floor, on the width most likely to be in
// a hand at a venue — a groomed shrink of the desktop row rather than a phone
// composition. The gate is a CONTROL-SET diff (membership and reachability),
// never a comparison of box sizes: a phone view showing the same controls
// smaller is exactly the defect this asserts against.
test("competition desk: the tool row is a phone composition below md, not the desktop row shrunk", async ({
  page,
  request,
}) => {
  const width = projectViewport()?.width ?? 0;
  // Ruling T8-C: Task 8 unified this row's own breakpoint (and the masthead
  // tool row's) from `sm:` (640) onto `md:` (768) — this literal was left
  // behind, stale against the split it is meant to classify. Harmless while
  // no matrix width falls in [640, 768), but the constant and the breakpoint
  // must move together or the next width added here silently misclassifies.
  const isPhone = width < 768;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk Tools ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    { name: "Tools Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status).toBe(201);
  await addEntrantsViaApi(request, div.data!.id, ["Alpha", "Bravo", "Charlie", "Delta"]);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(400);
  // One fixture LIVE, so the ledger row has a "Now: …" line to carry (F5).
  await setFixtureStatusSql(fixtureIds[0]!, "in_play");

  await page.goto(await competitionPath(request, comp.data!.id), { waitUntil: "load" });
  await dismissCookieBanner(page);

  const toolRow = page.getByTestId("desk-tool-row");
  const schedule = page.getByTestId("desk-tool-schedule");
  const more = page.getByTestId("desk-tools-more-toggle");
  // Scoped to the tool row: the org nav carries its own "Settings" link, and
  // an unscoped role query matches that too — a strict-mode violation that
  // reads like a product defect. The fold's copy of the label is deliberately
  // included in the row's own set, which is why the set is captured BEFORE
  // the fold is opened.
  //
  // Ordered by GEOMETRY, never by DOM order. The phone stack is composed with
  // CSS `order`, which moves what the reader sees and leaves the DOM where it
  // was — so `allInnerTexts()` answers a question nobody asked. The first
  // version of the index assertion below read the DOM and reported the upsell
  // as leading the row when it renders last on screen; sorting by `y` is what
  // makes "leads with" mean what it says.
  const rowControlSet = async (): Promise<string[]> => {
    const items = await toolRow.locator("a:visible, button:visible").all();
    const withPos = await Promise.all(
      items.map(async (el) => ({
        text: ((await el.innerText()) || "").replace(/\s+/g, " ").trim(),
        box: await el.boundingBox(),
      })),
    );
    return withPos
      .filter((i) => i.text && i.box)
      .sort((a, b) => a.box!.y - b.box!.y || a.box!.x - b.box!.x)
      .map((i) => i.text);
  };

  // F5: the Now line, at EVERY width. The phone card used to drop it — the
  // one width where "a match is on right now" matters most was the only one
  // that never said so.
  const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Tools Cup" }).first();
  const nowLine = row.locator("p:visible", { hasText: /^Now:/ });
  await expect(nowLine, "the ledger row must name the live fixture at this width").toHaveCount(1);
  await expect(nowLine).toContainText(/Alpha|Bravo|Charlie|Delta/);

  if (isPhone) {
    // 1. The primary action is labelled, full width, and clears the floor.
    await expect(schedule).toBeVisible();
    await expect(schedule, "the phone primary must carry its WORD, not just a glyph").toContainText("Schedule");
    const box = await schedule.boundingBox();
    expect(box, "the phone primary must have a measurable box").not.toBeNull();
    expect(box!.height, "a phone action must clear the 44px touch floor").toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
    expect(box!.width, "the phone primary is full-width, not an inline tile").toBeGreaterThan(width * 0.7);

    // 1b. And it stays primary while it is being PRESSED. `btn-ghost` carries
    //     `hover:bg-purple-50 hover:text-purple-700`, and a `hover:` utility
    //     outranks a plain one — so the filled phone primary turned pale
    //     lavender with purple text the moment a finger or cursor was on it.
    //     The owner found that by looking at it; nothing in this suite read a
    //     hover state, so nothing could have caught it. Compare the two
    //     computed colours rather than pinning a hex: the ONE thing that must
    //     hold is that pressing it does not turn it into the ghost buttons
    //     underneath it.
    const bgOf = (l: typeof schedule) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    const restBg = await bgOf(schedule);
    await schedule.hover();
    const hoverBg = await bgOf(schedule);
    const ghostBg = await bgOf(page.getByTestId("desk-tools-more-toggle"));
    expect(hoverBg, `pressed primary must not fall back to the ghost fill (rest ${restBg})`).not.toBe(ghostBg);
    expect(
      await schedule.evaluate((el) => getComputedStyle(el).color),
      "a pressed primary must keep its own text colour, not the ghost's purple",
    ).toBe(await schedule.evaluate((el) => getComputedStyle(el).color));
    await expect(schedule).toHaveCSS("color", "rgb(255, 255, 255)");

    // 2. Registration keeps its label AND its count on screen: it is the one
    //    tool that reports status, and status behind a fold is status nobody
    //    sees.
    const registration = page.getByRole("link", { name: /Registration/ });
    await expect(registration).toBeVisible();
    await expect(registration).toContainText("Registration");

    // 3. The CONTROL-SET diff, captured before anything is opened: the
    //    desktop row's inline Settings, Slideshow, Public page and QR tiles
    //    are not on this width at all. Membership, never box sizes — a phone
    //    view showing the same controls smaller is the defect, not the fix.
    const phoneSet = await rowControlSet();
    // Review 7, Important 3: this used to be `phoneSet.join(" | ")` matched
    // against /Schedule/, which passes for ANY position — and it was the one
    // assertion that could have caught the upsell taking `order: 0` above the
    // primary. The message claimed a positional property the assertion could
    // not express (class 4, "tests lie in their names"). Index, not
    // containment.
    expect(phoneSet[0], `the phone row leads with the schedule board; got ${phoneSet.join(" | ")}`).toMatch(/Schedule/);
    expect(phoneSet.join(" | "), "registration keeps its label on a phone").toMatch(/Registration/);
    expect(phoneSet.join(" | "), "a phone needs a labelled More control").toMatch(/More/);
    expect(phoneSet.join(" | "), "the inline Settings tile must not survive into the phone row").not.toMatch(/Settings/);
    expect(phoneSet.join(" | "), "the inline Slideshow tile must not survive into the phone row").not.toMatch(/Slideshow/);

    // 4. The rest are FOLDED — attached, so a test can tell "behind the fold"
    //    from "never rendered", but not visible until the disclosure opens.
    await expect(more, "a phone needs a labelled More control, not a bare glyph").toBeVisible();
    await expect(more).toContainText("More");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // `.locator("a")`, not `getByRole("link")`: the closed panel carries the
    // `hidden` ATTRIBUTE, which correctly removes its links from the
    // accessibility tree — so a role query finds nothing and cannot tell
    // "folded away" from "never rendered", the exact pair this assertion
    // exists to separate. (It reported `element(s) not found` on the first
    // run, which is also the proof the distinction is real.)
    const folded = page.getByTestId("desk-tools-more").locator("a");
    await expect(folded.first(), "the folded tools must be in the DOM, just not on screen").toBeAttached();
    await expect(folded.first()).not.toBeVisible();
    await expect(
      page.getByTestId("desk-tools-more").getByRole("link"),
      "a closed fold must be out of the accessibility tree too, not merely invisible",
    ).toHaveCount(0);

    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const count = await folded.count();
    expect(count, "the fold must carry the tools the row no longer shows inline").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      const item = folded.nth(i);
      await expect(item).toBeVisible();
      const itemBox = await item.boundingBox();
      expect(itemBox, `folded tool ${i} must have a box once open`).not.toBeNull();
      expect(itemBox!.height, `folded tool ${i} must clear the 44px floor`).toBeGreaterThanOrEqual(HIT_TARGET_FLOOR_PX);
      expect((await item.textContent())?.trim(), `folded tool ${i} must be labelled`).toBeTruthy();
    }

    // 5. And once open, the labels are BACK — in a different control, in a
    //    different place. That is what makes this a composition rather than a
    //    deletion: nothing was taken away from the organiser, it moved.
    const openedSet = await rowControlSet();
    expect(openedSet.join(" | "), "the fold restores the tools the row dropped").toMatch(/Settings/);
    expect(openedSet.join(" | ")).toMatch(/Slideshow/);
  } else {
    // 768 and up is UNCHANGED: the labelled row, and no disclosure at all.
    await expect(more, "the phone disclosure must not appear at tablet width").toBeHidden();
    await expect(schedule).toBeVisible();
    const tabletSet = (await rowControlSet()).join(" | ");
    expect(tabletSet, "the labelled row is unchanged at 768 and up").toMatch(/Settings/);
    expect(tabletSet).toMatch(/Slideshow/);
    expect(tabletSet, "no disclosure at this width").not.toMatch(/More/);
  }
  await expectNoHorizontalScroll(page);

  // Review finding m4 — the 640-767 band, which NO width project covers.
  // The design doc flagged it explicitly when Task 8 unified this row's
  // breakpoint from `sm:` (640) onto `md:` (768): the run-sheet row got its
  // own `{ width: 700 }` leg, the masthead tool row did not. The failure that
  // leaves open is a real one and completely silent — put `DeskToolsMore`
  // back on `sm:hidden` while the labelled tools stay `max-md:hidden` and a
  // small tablet gets NEITHER set, a competition masthead with no tools at
  // all, with every gate in this matrix green.
  //
  // Reloaded rather than merely resized: on a phone project the fold above is
  // left OPEN, and an open fold puts its own copies of Settings/Slideshow
  // back into the row's control set — which would make the "not inline"
  // assertion below read the wrong state.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.reload({ waitUntil: "load" });
  await dismissCookieBanner(page);
  const bandSet = (await rowControlSet()).join(" | ");
  console.log("desk tool row at 700px:", bandSet);
  await expect(more, "at 700 (below md) the phone disclosure must be present").toBeVisible();
  await expect(schedule, "at 700 the primary must still be there").toBeVisible();
  expect(bandSet, "at 700 the row keeps a labelled More control").toMatch(/More/);
  expect(bandSet, "at 700 the inline Settings tile must not be back — that is the desktop row").not.toMatch(/Settings/);
  expect(bandSet, "at 700 the inline Slideshow tile must not be back").not.toMatch(/Slideshow/);
  await expectNoHorizontalScroll(page);
});

// R3.5 review round 1 (2026-08-26, finding 4) — split out of "console
// routes: no horizontal scroll" above. Two fixture seeds plus ~18
// postEvents (~36 round trips) used to run at the HEAD of that test's own
// ~22-route audit, under this file's file-level `mode: "serial"` (top of
// file). Any 4xx here, or a timeout, killed the pre-existing audit AND
// skipped every later test in the file, across all seven projects — this
// test's own failure now stays contained to just these two routes.
test("decider consoles: no horizontal scroll, score pad renders (not just a 2xx)", async ({
  page,
  request,
}) => {
  // core.start poll + ~18 postEvents across two fixtures; same headroom
  // convention as this file's other self-contained-fixture tests (e.g. the
  // cricket v3 pad test below) that budget generously over their own sum.
  test.setTimeout(90_000);

  // R3.5 Task A (2026-08-26) — the two live decider consoles. Neither
  // defect is fixed yet (capture the broken state first): this is what
  // proves the seven-width matrix had ZERO coverage of either screen before
  // this wave, the same gap gallery.capture.ts's own 11-superover/
  // 11-shootout states exist to close for the three-width gallery.
  // Sequences are the wave plan's own (Task A steps 2 and 4), verbatim.
  //
  // Tag folds in projectTag() (review finding 5) — bare `${TAG}so`/
  // `${TAG}sh` collided across width projects that resolve the same
  // millisecond TAG (`projectTag`'s own doc-comment above records a
  // MEASURED collision), and persons are get-or-create BY NAME, so two
  // width projects would otherwise silently share these six person rows.
  const soTag = `${TAG}-${projectTag()}so`;
  const cricketDecider = await seedRosteredFixture(request, {
    label: `Mobile Cricket SuperOver ${TAG}-${projectTag()}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [
      { fullName: `Mobile Cricket SO Home1 ${soTag}` },
      { fullName: `Mobile Cricket SO Home2 ${soTag}` },
    ],
    away: [
      { fullName: `Mobile Cricket SO Away1 ${soTag}` },
      { fullName: `Mobile Cricket SO Away2 ${soTag}` },
    ],
  });
  const mh1 = cricketDecider.personIds[`Mobile Cricket SO Home1 ${soTag}`]!;
  const mh2 = cricketDecider.personIds[`Mobile Cricket SO Home2 ${soTag}`]!;
  const ma1 = cricketDecider.personIds[`Mobile Cricket SO Away1 ${soTag}`]!;
  const ma2 = cricketDecider.personIds[`Mobile Cricket SO Away2 ${soTag}`]!;
  await mergeDivisionConfig(request, cricketDecider.divisionId, { superOver: true });
  await postEvent(request, cricketDecider.fixtureId, "core.start", {});
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 1, striker: mh1, nonStriker: mh2, bowler: ma1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 2, striker: mh2, nonStriker: mh1, bowler: ma1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.innings.close", { reason: "other" });
  // target = 3; away scores exactly 2 => TIE => phase super_over.
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 1, striker: ma1, nonStriker: ma2, bowler: mh1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.ball", {
    over: 0, ballInOver: 2, striker: ma2, nonStriker: ma1, bowler: mh1, runs: { bat: 1 },
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.innings.close", { reason: "other" });
  // Away bats first in the super over; home bowls with h2 — an arbitrary
  // pick, not a forced one (see gallery.capture.ts's identical sequence:
  // applySuperOverBall opens the innings on a fresh `fine`, so h1 would be
  // accepted exactly as legally).
  await postEvent(request, cricketDecider.fixtureId, "cricket.superover.ball", {
    over: 0, ballInOver: 1, striker: ma1, nonStriker: ma2, bowler: mh2, runs: { bat: 4 }, boundary: 4,
  });
  await postEvent(request, cricketDecider.fixtureId, "cricket.superover.ball", {
    over: 0, ballInOver: 2, striker: ma1, nonStriker: ma2, bowler: mh2, runs: { bat: 2 },
  });

  const shTag = `${TAG}-${projectTag()}sh`;
  const footballDecider = await seedRosteredFixture(request, {
    label: `Mobile Football Shootout ${TAG}-${projectTag()}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `Mobile Football SO Home ${shTag}`, positionKey: "FW" }],
    away: [{ fullName: `Mobile Football SO Away ${shTag}`, positionKey: "GK" }],
  });
  // `extraTime` is a plain z.object whose two fields are BOTH required,
  // defaulted only as a whole object — `{ enabled: false }` alone fails the
  // cfg parse, and because the division config is written by SQL nothing
  // validates it on the way in.
  await mergeDivisionConfig(request, footballDecider.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });
  await postEvent(request, footballDecider.fixtureId, "core.start", {});
  await postEvent(request, footballDecider.fixtureId, "football.goal", { by: footballDecider.homeEntrantId });
  await postEvent(request, footballDecider.fixtureId, "football.goal", { by: footballDecider.awayEntrantId });
  await postEvent(request, footballDecider.fixtureId, "football.period", { phase: "HT" });
  await postEvent(request, footballDecider.fixtureId, "football.period", { phase: "FT" });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.homeEntrantId, scored: true,
  });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.awayEntrantId, scored: false,
  });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.homeEntrantId, scored: true,
  });
  await postEvent(request, footballDecider.fixtureId, "football.shootout.kick", {
    by: footballDecider.awayEntrantId, scored: true,
  });

  // R3.5 review round 1 (finding 3) — `requireScorePad: true` on both: a 2xx
  // status and no overflow both pass on a console that rendered its shell
  // with NO pad at all, the same class as the #349 404 vacuity this file
  // already records in "console routes: no horizontal scroll" above.
  await auditRoute(page, await fixturePath(request, cricketDecider.fixtureId), { requireScorePad: true });
  await auditRoute(page, await fixturePath(request, footballDecider.fixtureId), { requireScorePad: true });
});

// P8/D5a added a FOURTH Directory tab, which pushed "Venues" past the right
// edge of the tab strip at 320: you land on the venues tab and cannot see
// which tab is selected. The no-horizontal-scroll gate above is structurally
// unable to catch this — `.scroll-x` means the strip is SUPPOSED to scroll, so
// the page body never overflows and the audit passes while the active tab sits
// off-screen. A full-page screenshot cannot be trusted here either: Chromium's
// fullPage capture resets nested scroll containers, so the tab reads as hidden
// in `gallery.capture.ts` output whether the fix works or not.
//
// Hence a geometry assertion against the scroller's own visible box. This is
// the only instrument in the repo that can fail for the real reason.
//
// 2026-09-30 (fixture-page stream T7) a FIFTH tab, Streaming, ended the strip
// and the test drove IT (with Venues it went vacuous at 430, where Venues fit
// unscrolled while the strip still overflowed — its own control below caught
// that). 2026-10-27 (owner): Streaming left the Directory for a top-nav page of
// its own, so the strip is FOUR tabs again and Venues is its last — the one
// furthest past the edge. `/directory?tab=streaming` is now an unknown tab and
// would open Players, so the test names the tab it drives.
test("Directory: the active tab is scrolled into view at this width", async ({ page }) => {
  await page.goto("/directory?tab=venues", { waitUntil: "load" });

  const active = page.locator('nav [aria-current="page"]');
  await expect(active).toHaveText(/venues/i);
  expect(
    await active.evaluate((el) => el === el.closest("nav")!.querySelector("a:last-of-type")),
    "the driven tab is the strip's LAST one",
  ).toBe(true);

  // Proves the assertion below can actually fail: force the strip back to the
  // unscrolled state this test exists to catch, and confirm the geometry check
  // rejects it. Without this the test would pass on any width where the tabs
  // happen to fit, and silently stop guarding anything.
  const visibleWhenUnscrolled = await active.evaluate((el) => {
    const nav = el.closest("nav")!;
    const restore = nav.scrollLeft;
    nav.scrollLeft = 0;
    const tab = el.getBoundingClientRect();
    const strip = nav.getBoundingClientRect();
    const inView = tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
    nav.scrollLeft = restore;
    return inView;
  });
  const overflows = await active.evaluate((el) => {
    const nav = el.closest("nav")!;
    return nav.scrollWidth > nav.clientWidth;
  });
  if (overflows) {
    expect(
      visibleWhenUnscrolled,
      "control failed: the tab is reachable without scrolling, so this test proves nothing at this width",
    ).toBe(false);
  }

  await expect
    .poll(
      async () =>
        active.evaluate((el) => {
          const nav = el.closest("nav");
          if (!nav) return false;
          const tab = el.getBoundingClientRect();
          const strip = nav.getBoundingClientRect();
          // Fully inside the scroller's visible box, 1px tolerance for
          // sub-pixel layout. Deliberately NOT requiring the tab to clear the
          // 24px `.scroll-x-fade` gradient: the LAST tab scrolled to the end
          // sits flush against that edge by construction, so demanding fade
          // clearance asserts something no correct implementation can satisfy.
          return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
        }),
      { message: "the active Directory tab never scrolled inside the visible strip" },
    )
    .toBe(true);
});

// #516: an organiser who is ALSO a claimed player (nav.tsx's `isPlayer`,
// dual-role seam PROMPT-53) gets a 4th "Player home" nav link. At this
// project's width that pushes the header's fixed-width budget (wordmark +
// org chip + 4 nav links + help + logout) past what the #349 min-w-0/
// shrink-0 mechanism can reclaim by shrinking the display-name span alone
// (it was already fully collapsed) — the row overflows and "Sign out"
// renders clipped past the right edge. Own throwaway account + org: must
// NOT touch the shared pro.json identity other specs (and other projects
// sharing its storageState) depend on staying a 3-link organiser.
test("dual-role header (#516): organiser + claimed player profile holds no horizontal scroll", async ({
  browser,
}) => {
  const email = `delivered+e2e-dualrole-${TAG}@resend.dev`;
  const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined });
  try {
    const dual = await ctx.newPage();
    await loginUi(dual, email);
    // requirePageAuth (src/app/dashboard/page.tsx) is what auto-provisions
    // "My organization" for a member of none — a raw API call doesn't run
    // it, so visit a page before asking activeOrg for a slug.
    await dual.goto("/dashboard", { waitUntil: "load" });
    await claimProfileBySql(email);
    const org = await activeOrg(dual);

    for (const path of ["/dashboard", `/o/${org.slug}/settings`]) {
      await auditRoute(dual, path);
    }

    // Geometry alone (expectNoHorizontalScroll, inside auditRoute) proves the
    // PAGE doesn't overflow — it does not prove Sign out is the thing that
    // stayed on-screen rather than something else giving way. Pin that too.
    await dual.goto("/dashboard", { waitUntil: "load" });
    await dual.waitForTimeout(300);
    const signOut = dual.getByRole("button", { name: /sign out/i });
    await expect(signOut).toBeVisible();
    const box = await signOut.boundingBox();
    expect(box, "Sign out button has no layout box").not.toBeNull();
    const vw = dual.viewportSize()?.width ?? 0;
    expect(box!.x + box!.width, "Sign out button right edge must stay within the viewport").toBeLessThanOrEqual(vw);
  } finally {
    await ctx.close();
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
      `/shared/${orgSlug}`,
      `/shared/${orgSlug}/${compSlug}`,
      `/shared/${orgSlug}/${compSlug}/register`,
      // Seazn Games (design doc 2026-08-26, W3) — public, no login, no org.
      // Added here rather than the "console routes" test above because
      // these are genuinely anonymous marketing/play surfaces, same as "/"
      // and "/pricing" already on this list, not authed console pages.
      "/games",
      "/games/chess-quest",
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
        await anon.goto(`/shared/${orgSlug}/${comp}?tab=${id}`, { waitUntil: "load" });
        await expect(anon.getByTestId(`mh-tab-panel-${id}`), `${comp} ?tab=${id} opened a different tab`).toBeVisible();
        await expectNoHorizontalScroll(anon);
      }
    }
    expect(publicCricketPlayerId, "setup did not fill the player id").toBeTruthy();
    await anon.goto(`/shared/${orgSlug}/${publicCricketCompSlug}/players/${publicCricketPlayerId}`, { waitUntil: "load" });
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

test("RS009: the assign sheet holds at this width, and the hub does not scroll behind it", async ({
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
    await anon.goto(`/shared/${orgSlug}/news`, { waitUntil: "load" });
    await anon.waitForTimeout(300);
    await expectNoHorizontalScroll(anon);
    // Assert the card while still ON the feed — the post page has no cards.
    await expect(anon.getByTestId("news-card").first()).toBeVisible();

    await anon.goto(`/shared/${orgSlug}/news/${postSlug}`, { waitUntil: "load" });
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
    `/shared/${orgSlug}/${compSlug}`,
    // RS010 close-out (v3/11 gap 11 was never re-swept for the Registration
    // redesign) — the public register stepper (divisionId above has
    // registration enabled, open, individual entrant), the Registration hub
    // (both tabs — same two routes the "console routes" no-h-scroll test
    // audits above, reused here for axe), and the register status page
    // (statusPath, seeded by the setup test with a real registration so this
    // renders populated, not its empty state) had zero axe coverage.
    `/shared/${orgSlug}/${compSlug}/register`,
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

test("page smokes: settings save + invoice/plan card render", async ({ page }) => {
  // Org rename round-trip proves forms submit on a phone viewport.
  await page.goto("/settings?tab=organization");
  const nameInput = page.getByLabel(/organi[sz]ation name/i);
  await expect(nameInput).toBeVisible();
  // Two "Save" buttons live on this tab (rename + payment details) — scope
  // to the rename form's own label container.
  const renameForm = page.locator("label", { has: nameInput });
  const orgName = await nameInput.inputValue();
  await nameInput.fill(`${orgName} ✓`);
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(renameForm.getByText("Saved.")).toBeVisible();
  // Restore — other specs assert on the org name.
  await nameInput.fill(orgName);
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(renameForm.getByText("Saved.")).toBeVisible();

  // Billing: the plan card is the invoice-adjacent surface every org has.
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: /plan & billing/i })).toBeVisible();
  await expect(page.getByText(/current plan/i).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
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
    for (const path of [`/shared/${orgSlug}/${compSlug}`, `/shared/${orgSlug}/${compSlug}/register`]) {
      const lcp = await measureLcp(anon, path);
      expect(lcp, `LCP on ${path}`).toBeLessThan(2500);
    }
  } finally {
    await anonCtx.close();
  }
});

/**
 * #230 item 2 follow-up — the publish gate's confirm step at phone width.
 *
 * It is a bottom sheet under `sm` and it lists an arbitrary number of conflicts,
 * so it is exactly the shape that overflows a 375px page. This file is the ONLY
 * place a 375px assertion actually runs: the mobile projects are
 * `testMatch: /mobile\.spec\.ts/`, so the same assertion written into
 * schedule-board.spec.ts would silently run at desktop and pass.
 */
test("the publish gate's confirm sheet holds at phone width", async ({ page, request }) => {
  const DAY = Date.UTC(2026, 9, 19);
  const at = (hour: number) => new Date(DAY + hour * 3_600_000).toISOString();

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Gate Sheet ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Gate Sheet",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const gateDivisionId = div.data!.id;
  await addEntrantsViaApi(request, gateDivisionId, ["Eve M", "Fay M", "Gus M", "Hal M"]);
  const { fixtureIds } = await createStageAndGenerate(request, gateDivisionId);
  const { courts: gateCourts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${gateDivisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: at(9),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: gateCourts.map((c) => c.id),
        // A two-hour floor, so the hour-apart pair below is a `warn.rest` — a
        // warning, which is the case that HAS a confirm affordance to size.
        perEntrantMinRest: 120,
      },
    },
  );
  // Every ScheduleConfig field carries a `.default()`, so a rejected PUT still
  // leaves a usable config behind and the only symptom is "the dialog never
  // appeared" — a failure reported against the sheet, three screens from its
  // cause.
  expect(settings.status).toBe(200);

  type Row = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  const rows = await Promise.all(
    fixtureIds.map(async (id) => (await apiJson<Row>(request, `/api/v1/fixtures/${id}`)).data!),
  );
  const first = rows[0]!;
  const sharer = rows.find(
    (f) =>
      f.id !== first.id &&
      [f.home_entrant_id, f.away_entrant_id].some((e) =>
        [first.home_entrant_id, first.away_entrant_id].includes(e),
      ),
  )!;
  await apiJson(request, `/api/v1/fixtures/${first.id}`, "PATCH", {
    scheduled_at: at(9),
    court_id: gateCourts[0]!.id,
  });
  await apiJson(request, `/api/v1/fixtures/${sharer.id}`, "PATCH", {
    scheduled_at: at(10),
    court_id: gateCourts[1]!.id,
  });

  await page.goto(await divisionPath(page.request, gateDivisionId, "/schedule?tab=board"), { waitUntil: "load" });
  const publish = page.getByTestId("board-publish-schedule");
  await expect(publish).toBeVisible({ timeout: 30_000 });
  await publish.click();

  const dialog = page.getByTestId("board-gate");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('[data-testid="board-gate-conflict"]').first()).toBeVisible();

  // The sheet is what is being audited: the page must not scroll sideways
  // behind it, and the sheet's own body must not either — the conflict list is
  // the part that grows without a ceiling.
  await expectNoHorizontalScroll(page);
  const clipped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="board-gate"]');
    if (!root) return ["the gate sheet was not in the DOM"];
    const suspects: HTMLElement[] = [
      root,
      ...Array.from(root.querySelectorAll<HTMLElement>("p,ul,li")),
    ];
    return suspects
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
  });
  expect(clipped, "the gate sheet's content is clipped at this width").toEqual([]);

  for (const id of ["board-gate-confirm", "board-gate-cancel"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} has no box`).not.toBeNull();
    expect(box!.height, `${id} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: `test-results/publish-gate-sheet-${test.info().project.name}.png`,
  });

  // And it works from here — a sheet that renders but cannot be confirmed on a
  // phone is the same dead end in a nicer wrapper.
  await page.getByTestId("board-gate-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const after = await apiJson<{ status: string }>(request, `/api/v1/divisions/${gateDivisionId}`);
  expect(after.data!.status).toBe("scheduled");
  await expectNoHorizontalScroll(page);
});

/**
 * T14b — the lineup editor's role/pair-order selects at phone width.
 *
 * S12/#421 pass E review, Finding 3: both `<select>`s reused the existing
 * `w-24`/`w-32 px-2 py-1 text-xs` recipe, which Tailwind's utilities layer
 * shrinks well under this repo's 44px touch-target floor — and this file had
 * zero references to the lineup editor at all despite already owning the
 * exact assertion pattern this test reuses (`toBeGreaterThanOrEqual(44)`,
 * see T15 below). `min-h-11` is now on both selects, at EVERY width — not
 * `sm:min-h-0`, which was the first shape of this fix and is wrong here for a
 * reason worth writing down: this file runs under all SEVEN width projects,
 * including `tablet-768` and `tablet-834`, and those are touch devices too. A
 * `sm:` escape hatch would have restored 26px controls at exactly two of the
 * widths this very test runs at — the assertion below is unconditional, so the
 * fix would have shipped its own red. Same recipe as every other control this
 * file already holds to the floor, and the same bare `min-h-11` the scorepad
 * chassis uses for its chips and phase tabs.
 *
 * A pair-kind entrant (`entrantKind: "pair"`, not a sport-specific position
 * catalog — S12/#421 pass E Finding 1 made the pair-order control read the
 * entrant's own declared kind instead) is what puts the pair-order select on
 * the page at all; the role select renders for every lineup row regardless
 * of shape, so one seeded fixture proves both controls.
 *
 * Self-contained, like T15 below: its own competition/division/fixture.
 */
test("lineup editor role/pair-order selects hold at phone width", async ({ page, request }) => {
  // `generic` declares `lineup: { size: 1, benchMax: 0 }` (lineup-editor.tsx's
  // own `lineupEditorApplies` doc comment groups it with chess/carrom as "no
  // lineup to pick") — the editor never mounted here, at ANY width, which is
  // why this fixture never actually proved the touch floor. The racquet
  // family (`size: 1, benchMax: 1`) is the one `lineupEditorApplies` singles
  // out by name as needing the pair-order editor kept.
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Lineup ${TAG}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "pair",
    home: [{ fullName: "Home One" }, { fullName: "Home Two" }],
    away: [{ fullName: "Away One" }, { fullName: "Away Two" }],
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });

  const roleSelects = page.getByTestId("lineup-role-select");
  // Below `md` each lineup card sits inside a `PhoneDisclosure`
  // (`fixture-console.tsx`, one per side) whose body is `max-md:hidden` until
  // the row is tapped — spec 2026-09-02-scorepad-v3-phone-composition §3.10.
  // So at five of this file's seven width projects the selects are present in
  // the DOM but UNPAINTED: `boundingBox()` returns null and `toBeVisible()`
  // never resolves. The fold is the approved design, so the fix is to open the
  // disclosure, NOT to weaken what this test asserts — the 44px floor still
  // has to hold in the state a scorer actually reaches these controls in, and
  // `expectNoHorizontalScroll` at the foot now runs with the body open, which
  // is the state that shipped a 106px overflow at 320px during this wave.
  //
  // Wait ATTACHED first (the editor is client-rendered) — visibility is
  // exactly what the fold denies, so it cannot be the wait condition here.
  await expect(roleSelects.first(), "no role select rendered").toBeAttached({ timeout: 30_000 });
  // BOTH sides, not the first: each side mounts its own disclosure, so opening
  // one leaves the other's selects boxless and the loop below fails on them.
  // Gated on the toggle being VISIBLE rather than on a width literal.
  //
  // The lineup's own PhoneDisclosure is `desktopCollapsible` (PR #782, fold
  // the lineup once the match starts, every width) — its toggle is visible at
  // every width here, not just phone-narrow. At `tablet-768`/`tablet-834`
  // (real `md`-and-up viewports) the body also starts OPEN pre-match, since
  // this fixture never sends `core.start`, so the toggle may already read
  // `aria-expanded="true"` before any click — only click when it does not.
  const lineupDisclosures = page.locator('[data-role="phone-disclosure"]:has([data-testid="lineup-role-select"])');
  expect(await lineupDisclosures.count(), "lineup editor is not inside a PhoneDisclosure").toBeGreaterThan(0);
  for (const wrapper of await lineupDisclosures.all()) {
    const toggle = wrapper.locator('[data-role="phone-disclosure-toggle"]');
    if (!(await toggle.isVisible())) continue;
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  await expect(roleSelects.first(), "role select still folded after its disclosure was opened").toBeVisible({
    timeout: 30_000,
  });
  for (const select of await roleSelects.all()) {
    const box = await select.boundingBox();
    expect(box, "role select has no box").not.toBeNull();
    expect(box!.height, `role select touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }

  const pairOrderSelects = page.getByTestId("lineup-pairorder-select");
  await expect(pairOrderSelects.first(), "no pair-order select rendered — entrant.kind did not reach isPairShaped").toBeVisible({
    timeout: 30_000,
  });
  for (const select of await pairOrderSelects.all()) {
    const box = await select.boundingBox();
    expect(box, "pair-order select has no box").not.toBeNull();
    expect(box!.height, `pair-order select touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }

  await expectNoHorizontalScroll(page);
});

/**
 * T16 — the ScoringPad v3 cricket pad (R2/task F1) at all SEVEN width
 * projects (320/360/375/390/430/768/834), same "add it above the z3 test"
 * placement T15's own comment asks for.
 *
 * Cricket is the first sport this repo flips onto `V3_SKINS`
 * (v3/registry.ts) — a brand-new render tree (tile-grid.tsx/context-
 * strip.tsx/scorebug.tsx) with ZERO width coverage until it lands inside
 * THIS file (reference_new_ui_surface_uncovered_until_in_mobile_spec — this
 * file's own SEVEN projects are the only place a new surface gets narrower
 * than 375/768 coverage at all). Self-contained fixture, no shared org.
 *
 * The context strip (D-14) only renders once an innings exists
 * (`buildContext`, v3/skins/cricket.tsx requires `currentInnings() !==
 * null`), and `cricket.ts` creates that innings lazily inside the FIRST
 * ball's own fold — so one run tile is tapped first, both to prove the
 * tile itself clears the touch floor and to bring the context strip on
 * screen for its own floor check right after.
 */
test("cricket v3 pad: tiles + over-summary sheet + context strip hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  // core.start poll + a held ball dispatch (queue.ts's HOLD_MS)
  // each budget up to 20s below; generous headroom over their sum.
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Cricket V3 ${TAG}-${projectTag()}`,
    sportKey: "cricket",
    variantKey: "t20",
    home: [{ fullName: `Mobile V3 Striker ${TAG}` }, { fullName: `Mobile V3 NonStriker ${TAG}` }],
    away: [{ fullName: `Mobile V3 Bowler ${TAG}` }],
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });
  // Click until the ledger actually moves. `waitUntil: "load"` resolves
  // before React has hydrated, so on a loaded machine the first click lands
  // on server-rendered markup with no handler attached and is silently a
  // no-op: the fixture stays "Scheduled", core.start never lands, and the
  // failure surfaces 20s later at the poll below as an empty event list
  // rather than anywhere near the click. Observed at all seven widths while
  // the same flow passed under the `parallel` project on a quieter machine.
  const startBtn = page.getByRole("button", { name: "Start match", exact: true });
  await expect(startBtn).toBeEnabled({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        if (await startBtn.isVisible().catch(() => false)) {
          await startBtn.click({ timeout: 5_000 }).catch(() => {});
        }
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).some((e) => e.type === "core.start");
      },
      { timeout: 30_000, message: "Start match must reach the ledger once the pad has hydrated" },
    )
    .toBe(true);
  // Wait on the real LEDGER, not the click alone — the pad's own
  // `useFixtureStream` polls at a 15s interval (scorepad-v2.spec.ts's own
  // `openLiveConsole` comment), so a tile-visibility check racing the click
  // itself could stall past this test's budget waiting on that poll cycle.
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).map((e) => e.type);
      },
      { timeout: 20_000 },
    )
    .toContain("core.start");

  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };

  // The run tiles are the pad's most-tapped control (D-14's replacement for
  // the old "This over" selects) — assert the floor BEFORE tapping one,
  // since the tap itself is what this same assertion is proving is safe.
  await assertFloor(pad.locator('[data-tile-id="run1"]'), "run tile \"1\"");
  await assertFloor(pad.locator('[data-tile-id="wicket"]'), "wicket tile");

  // R2b: the over-by-over guided sheet (SheetNumberStep, guided-sheet.tsx) is
  // a brand-new surface with zero width coverage until it lands here — same
  // "new v3 surface, only covered inside this file" reasoning this test's
  // own header gives for the tile grid itself. Checked BEFORE the run tap
  // below: recording a ball first locks this innings to ball-by-ball
  // fidelity and the tile disappears entirely (R2b's own mutually-exclusive
  // gate), so this is the only point in the flow where the sheet is still
  // reachable.
  await assertFloor(pad.locator('[data-tile-id="overSummary"]'), "over-summary tile");
  await pad.locator('[data-tile-id="overSummary"]').click();
  const sheet = pad.locator('[data-role="v3-sheet"]');
  await expect(sheet, "guided sheet must open").toBeVisible({ timeout: 10_000 });
  // Fix 1f7403c0 (review finding 2): the stepper buttons' accessible names
  // now come from dedicated pad.sheet.decrease/.increase dictionary keys
  // ("Decrease {title}"/"Increase {title}", en/ui.json) rather than the
  // step title plus a bare glyph — "Decrease Runs this over"/"Increase Runs
  // this over", not "Runs this over −"/"Runs this over +". The title itself
  // changed from "Total runs" when Q2 was reversed (per-over delta, not a
  // running total, `_INDEX.md` 2026-08-17); these names are derived from it,
  // so they move with it.
  await assertFloor(
    sheet.getByRole("button", { name: "Decrease Runs this over", exact: true }),
    "over-sheet stepper minus",
  );
  await assertFloor(sheet.getByRole("spinbutton", { name: "Runs this over" }), "over-sheet numeric field");
  await assertFloor(
    sheet.getByRole("button", { name: "Increase Runs this over", exact: true }),
    "over-sheet stepper plus",
  );
  await assertFloor(sheet.getByRole("button", { name: "Confirm", exact: true }), "over-sheet confirm");
  await expectNoHorizontalScroll(page);
  // Cancel, not confirm: a real submission here would open this innings at
  // COARSE fidelity and remove the run tiles the rest of this test still
  // needs to exercise below.
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet, "cancel must close the sheet without dispatching").not.toBeVisible({ timeout: 10_000 });

  await pad.getByRole("button", { name: "1", exact: true }).click();
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).filter((e) => e.type === "cricket.ball").length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);

  // Every chip, interactive or not. After the first ball the strip is
  // ENTIRELY non-interactive by design: striker and non-striker are
  // read-only because the engine refuses those overrides under a strict
  // fold, and bowler is read-only until an over boundary (`currentBowler
  // === null`) because mid-over the same fold refuses it. Selecting on
  // `button` therefore matched nothing here and the test failed at all
  // seven widths — the 44px floor applies to the chip footprint, which is
  // what a thumb meets, not to whether it happens to be a control.
  const chips = pad.locator('[data-role="context-chip"]');
  await expect(chips.first(), "context strip must render once an innings exists").toBeVisible({ timeout: 20_000 });
  const chipCount = await chips.count();
  expect(chipCount, "cricket declares striker, non-striker and bowler").toBe(3);
  // R8 / WS-M round 2 — the mode statement is deliberately NOT among them: it
  // renders as plain text with a lock glyph, not a pill, so the 44px floor
  // loop below must not measure it — nothing can tap it, and a hit-target
  // sweep that grades a statement is measuring the wrong thing. It must still
  // READ correctly at every width: this innings was opened by the ball tapped
  // above, so it is locked to the fine lane, and an indicator that ignored the
  // fold would say "Over-by-over" over a pad that has just recorded a ball.
  const modeLine = pad.locator('[data-role="context-mode"]');
  await expect(modeLine, "the pad must state which scoring mode this innings locked into").toHaveCount(1);
  await expect(modeLine).toHaveText("This innings: Ball-by-ball");
  await expect(
    pad.locator('[data-role="context-chip"][data-slot-kind="mode"]'),
    "the mode statement must never render as a chip",
  ).toHaveCount(0);
  for (let i = 0; i < chipCount; i++) {
    await assertFloor(chips.nth(i), `context chip ${i}`);
  }
  // Mid-over none of them may be a control: a chip that opens a picker the
  // engine will refuse is the defect this wave fixed twice (G5, then the
  // bowler's own mid-over case).
  await expect(
    pad.locator('[data-role="context-chip"][data-readonly="false"]'),
    "mid-over every context chip is read-only",
  ).toHaveCount(0);

  await expectNoHorizontalScroll(page);
  await expectPhoneComposition(page, "T");
});

/**
 * T17 — the ScoringPad v3 tennis pad (R4/tennis) at all SEVEN width
 * projects (320/360/375/390/430/768/834), same "add it above the z3 test"
 * placement T16's own comment describes, and the same reason: a new v3
 * render surface gets no width coverage anywhere else — this file's seven
 * projects are the only place anything narrower than 375/768 ever runs.
 *
 * Tennis is the first tapModel-S sport (v3/skins/tennis.tsx): the
 * scoreboard HALF itself is the point button (`ScorebugHalf.tappable`/
 * `tapEvent`), not a tile — so the control this file must prove fits and
 * is safe to tap is the scorebug half, not a `data-tile-id`.
 * `scorepad-v3-tennis.spec.ts` already proves the pad's full functional
 * surface (deuce/advantage, dock legality by serve side, the doubles
 * serve pip, D-16) at desktop; this file's job is narrower and different —
 * does that SAME control still render, fit, and clear the 44px
 * tap-target floor once the viewport drops to 320px, which nothing
 * anywhere else checks.
 *
 * A half renders EITHER a real `<button>` (tappable — live, band>=3) or a
 * plain, click-inert `<div>` at the identical grid position (`buildHalf`,
 * v3/skins/tennis.tsx). The fixture below is seeded already-started
 * (`emitCoreStart: true`), so the only fold race left is the server's
 * response against the client's first render — and the locator is scoped
 * to `button` specifically (the fix in commit 8a50b48d7, the same
 * `tennisHalf` shape `scorepad-v3-tennis.spec.ts` uses), so Playwright's
 * ordinary actionability wait closes that race instead of resolving to the
 * still-present pre-fold `<div>` and reading a stale, empty box.
 *
 * The floor is measured from `boundingBox()`, never inferred from the
 * `minHeight: 44` inline style scorebug.tsx declares on the button — the
 * Scorebug's own root card is `overflow-hidden`, the exact shape that has
 * silently clipped a declared floor back down elsewhere in this chassis
 * (tile-grid's 2px `::before` bleed). Checked BEFORE either half is
 * tapped, since the tap itself is what the floor is proving is safe.
 *
 * "Live and populated" is asserted on the SEEDED players' own names, not
 * merely "a button exists" — a board that rendered but is still showing
 * stale or placeholder content would pass a presence-only check for the
 * wrong reason. The card's own `overflow-hidden` also means a name could
 * be silently clipped without ever producing page-level horizontal
 * scroll, so this checks the card's own content width too, not just the
 * page's.
 *
 * Doubles (second test below) is layout-only, deliberately: TWO names per
 * half (`buildHalf`'s `who` — one WhoLine per on-field player) is the
 * shape most likely to overflow or clip at 320px, so it gets its own
 * floor/populated/no-scroll pass, but not a repeat of the full score/dock
 * flow — `scorepad-v3-tennis.spec.ts` already proves that functionally,
 * and repeating it here would roughly double this test's per-width
 * runtime for no additional WIDTH signal. Left uncovered by that scope
 * choice: a doubles-specific dock render defect (the pair-narrowing
 * second question) at a narrow viewport — real, but a different and
 * larger test than a coverage-gap fix belongs doing in one pass.
 */
test("tennis v3 pad (singles): the scoreboard half holds the 44px floor, live and populated, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  // R8 close-out — the `-${projectTag()}` suffix is DROPPED here, the same
  // trim the DOUBLES test below already carries and for the same measured
  // reason (its comment has the full account). WS-I root-caused this file's
  // intermittent 320px scorebug clip to the FIXTURE NAME, not the scorebug:
  // an entrant name has no uniqueness requirement — it is scoped to one
  // fixture, which `label` already isolates — and the decoration pushed the
  // who-block past its clamp only once the webfont swapped, because
  // `globals.css`'s `.app-display` resolves `--font-barlow` (condensed) over
  // `--font-geist-sans` (not), so the identical string measures wider until
  // Barlow lands. That is what made it INTERMITTENT rather than reproducible.
  // The box is already correct (scorebug.tsx: `line-clamp-6`, `min-w-0`,
  // wrap-anywhere) — do NOT restyle it to chase this.
  const homeName = `Mobile V3 Tennis Home ${TAG}`;
  const awayName = `Mobile V3 Tennis Away ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Tennis V3 ${TAG}-${projectTag()}`,
    sportKey: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });

  // Positional, home first (scorebug.tsx's render order) — a tappable
  // half's accessible name is the PLAYER'S OWN name plus hint text, not a
  // fixed string this file could match on (same reasoning
  // scorepad-v3-tennis.spec.ts's own `tennisHalf` gives).
  const halves = pad.locator('[data-role="v3-scorebug"] .grid > button');
  const homeHalf = halves.nth(0);
  const awayHalf = halves.nth(1);

  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible — board never reached live/band-3`).toBeVisible({
      timeout: 20_000,
    });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };

  // The floor, BEFORE tapping either half — the tap itself is what this
  // assertion is proving is safe (same ordering T16's cricket test uses).
  await assertFloor(homeHalf, "home scoreboard half");
  await assertFloor(awayHalf, "away scoreboard half");

  // LIVE AND POPULATED: the real seeded names, not a pre-phase board with
  // nothing on it.
  await expect(homeHalf, "home half must show the real seeded player").toContainText(homeName);
  await expect(awayHalf, "away half must show the real seeded player").toContainText(awayName);

  // The scorebug card is `overflow-hidden`, so a clipped name would not
  // necessarily show up as page-level horizontal scroll — checked here as
  // its own signal, not folded into `expectNoHorizontalScroll` below.
  await expectScorebugNotClipped(page, "scorebug content (before tap)");
  await expectNoHorizontalScroll(page);

  // Prove the target is not just big enough but a REAL, wired control:
  // tap it, resolve the point dock (singles still asks "how was the point
  // won" — R4-5's auto-stamp only skips the SECOND, scorer question), and
  // confirm the point actually reaches the ledger. "Winner" is legal
  // regardless of which side is serving (scorepad-v3-tennis.spec.ts's own
  // dock test), so it holds whichever half a thumb lands on first.
  await homeHalf.click();
  const dock = pad.locator('[data-role="v3-dock"]');
  await expect(dock, "tapping the half must open the point dock").toBeVisible({ timeout: 10_000 });
  await expect(dock).toContainText("How was the point won?");
  await dock.getByRole("button", { name: "Winner", exact: true }).click();
  // One-way collapse (build spec §4): the alternatives must leave once a
  // kind lands — same proof T16 and the sibling functional spec both give
  // that this dock re-render is real, not merely unit-tested.
  await expect(
    dock.getByRole("button", { name: "Ace", exact: true }),
    "once a kind lands, the dock must show ONLY that chip",
  ).toHaveCount(0);
  await dock.getByRole("button", { name: "Send now", exact: true }).click();
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).filter((e) => e.type === "tennis.point").length;
      },
      { timeout: 20_000, message: "a tap on the scoreboard half must reach the ledger as a tennis.point" },
    )
    .toBe(1);

  await expectNoHorizontalScroll(page);
});

/**
 * T17b — tennis doubles: TWO names per half, the layout most likely to
 * overflow or clip at 320px. See T17's own header above for the shared
 * reasoning (fold race, `boundingBox()` over the inline style, why this is
 * layout-only rather than a repeat of the full dock flow).
 */
test("tennis v3 pad (doubles): both partners' names hold the 44px floor and fit inside the half, no horizontal scroll", async ({
  page,
  request,
}) => {
  // `${TAG}` only, not `${TAG}-${projectTag()}` — unlike the competition
  // `label` below (a real cross-project collision risk this file's own
  // header documents), an entrant's name has no uniqueness requirement at
  // all: it's scoped to this one fixture, which the label already isolates.
  // The extra suffix was pure decoration copied from the label's own
  // pattern, and at this box's narrowest column (320, ~98px) two real long
  // names plus that decoration needed more vertical room than any
  // reasonable clamp could give without chasing a moving CI-renderer
  // target — see scorebug.tsx's own comment on the who-block's clamp.
  const home1 = `Mobile V3 Tennis D Home1 ${TAG}`;
  const home2 = `Mobile V3 Tennis D Home2 ${TAG}`;
  const away1 = `Mobile V3 Tennis D Away1 ${TAG}`;
  const away2 = `Mobile V3 Tennis D Away2 ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Tennis V3 Doubles ${TAG}-${projectTag()}`,
    sportKey: "tennis",
    variantKey: "doubles-noad-mtb10",
    entrantKind: "pair",
    home: [
      { fullName: home1, pairOrder: 1 },
      { fullName: home2, pairOrder: 2 },
    ],
    away: [
      { fullName: away1, pairOrder: 1 },
      { fullName: away2, pairOrder: 2 },
    ],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });

  const halves = pad.locator('[data-role="v3-scorebug"] .grid > button');
  const homeHalf = halves.nth(0);
  const awayHalf = halves.nth(1);

  const assertFloor = async (locator: Locator, label: string) => {
    await expect(locator, `${label} not visible — board never reached live/band-3`).toBeVisible({
      timeout: 20_000,
    });
    const box = await locator.boundingBox();
    expect(box, `${label} has no box`).not.toBeNull();
    expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  };
  await assertFloor(homeHalf, "home scoreboard half (doubles)");
  await assertFloor(awayHalf, "away scoreboard half (doubles)");

  // Both partners, not just the first — a half that silently dropped or
  // clipped its second name would still pass a single-name check.
  await expect(homeHalf, "home half must show BOTH partners").toContainText(home1);
  await expect(homeHalf, "home half must show BOTH partners").toContainText(home2);
  await expect(awayHalf, "away half must show BOTH partners").toContainText(away1);
  await expect(awayHalf, "away half must show BOTH partners").toContainText(away2);

  await expectScorebugNotClipped(page, "doubles scoreboard content");

  await expectNoHorizontalScroll(page);
});

/**
 * T15 — the z3 solver action bar and its result strip at phone width.
 *
 * THIS TEST CANNOT LIVE IN `auto-schedule.spec.ts`. The `mobile-se`
 * (375×667) and `mobile-14` (390×844) projects are declared with
 * `testMatch: /mobile\.spec\.ts/`, so they run this one file and nothing else —
 * a new spec file gets desktop coverage only, however it is named. The 375px
 * gate for the feature is therefore a section here, by construction.
 *
 * Self-contained: it seeds its own competition rather than borrowing the file's
 * shared division, which has no stage and so renders no action bar at all.
 *
 * Three things are asserted, in the order they can be:
 *   - the three actions are hit-testable. `min-h-11 sm:min-h-0` on all three is
 *     the only reason they clear 44px — the shared `py-1.5 text-xs` button
 *     renders 28px, and the override is mobile-only, so nothing at desktop
 *     width would notice it being dropped.
 *   - the strip renders and its own content is not clipped. The metrics grid
 *     carries `overflow-hidden`, which means a grid that outgrew its container
 *     would silently truncate rather than push the page wide — invisible to the
 *     page-level scroll check below, and the reason this is measured separately.
 *   - no horizontal page scroll, checked AFTER the strip has rendered. The strip
 *     is the widest thing this surface ever shows; running the check on the
 *     board before a run would prove nothing about the element under test.
 */
// LAST IN THE FILE, DELIBERATELY. This whole spec is
// `test.describe.configure({ mode: "serial" })`, so a failure SKIPS every case
// after it — and this is the only case here that depends on a z3 solve, i.e. the
// one most likely to fail for a reason that is nothing to do with layout (a
// solver hiccup, a busy queue, a WASM that will not boot). Sitting mid-file it
// took the public-surface, news, axe, page-smoke and LCP cases down with it.
// Anything added below this line inherits that risk; add it above.
test("z3 schedule actions + result strip hold at phone width", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Solver ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Solver",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const solverDivisionId = div.data!.id;
  await addEntrantsViaApi(request, solverDivisionId, ["Ash M", "Brook M", "Clay M", "Dune M"]);
  const { fixtureIds } = await createStageAndGenerate(request, solverDivisionId);
  expect(fixtureIds.length).toBe(6);
  const { courts: solverCourts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${solverDivisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: solverCourts.map((c) => c.id),
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  await page.goto(await divisionPath(page.request, solverDivisionId, "/schedule?tab=board"), { waitUntil: "load" });

  // Ids, not labels (#465): "Auto-schedule {name}" interpolates the division
  // name and "Improve times" is not the word "Polish".
  const auto = page.getByTestId("schedule-auto");
  const reflow = page.getByTestId("schedule-reflow");
  const polish = page.getByTestId("schedule-polish");
  // The toolbar's other four controls (#349 review): freeze/publish/start/AI
  // never got the min-h-11 floor their three auto/reflow/polish siblings did.
  const freeze = page.getByTestId("board-freeze");
  const publish = page.getByTestId("board-publish-schedule");
  const start = page.getByTestId("board-start-division");
  const aiSchedule = page.getByTestId("board-ai-schedule");
  for (const [name, button] of [
    ["schedule-auto", auto],
    ["schedule-reflow", reflow],
    ["schedule-polish", polish],
    ["board-freeze", freeze],
    ["board-publish-schedule", publish],
    ["board-start-division", start],
    ["board-ai-schedule", aiSchedule],
  ] as const) {
    await expect(button, `${name} is not visible at this width`).toBeVisible({ timeout: 30_000 });
    const box = await button.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.height, `${name} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }

  await auto.click();
  await page.getByTestId("schedule-rebuild-confirm").click();
  const strip = page.getByTestId("schedule-result-strip");
  await expect(strip).toBeVisible({ timeout: 45_000 });
  // The whole round trip, not just the proposal: `autoRun` clears `busy` in its
  // `finally`, after the apply POST and the refresh.
  await expect(auto).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByTestId("schedule-result-headline")).toBeVisible();

  // Nothing inside the strip is clipped or scrolled sideways — including the
  // metrics grid, whose `overflow-hidden` would otherwise hide the failure.
  const clipped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="schedule-result-strip"]');
    if (!root) return ["the strip was not in the DOM"];
    const suspects: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("dl,p"))];
    return suspects
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
  });
  expect(clipped, "result strip content is clipped at this width").toEqual([]);

  await expectNoHorizontalScroll(page);
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
// P6 (D4b task A) fix round 1 — a TBD fixture's slot label, rendered in a
// real browser, on an org surface AND a public one (the two gaps the review
// found: finding #2, public surfaces stuck on hardcoded English regardless
// of the org's own locale; the unit/regression suites already prove the
// resolver + dictionaries are correct in isolation, but P5's own
// stage-progression.spec.ts is request-only (no `page`) and never asserted
// on rendered text at all). Lives in mobile.spec.ts — not a new spec file —
// specifically so it inherits the seven-width viewport matrix; a new file
// would run desktop-only and silently skip 320/360/375/390/430/768/834.
// A brand-new logged-in user (own auto-provisioned org), never the file's
// shared `orgSlug`/`divisionId` above — this scenario needs to flip the
// ORG's own default_locale, which would otherwise leak into every other
// scenario in this file that reuses the same account.
// ---------------------------------------------------------------------------

let p6OrgSlug = "";
let p6CompSlug = "";
let p6DivSlug = "";
let p6DivisionId = "";

// Per-project identity (see `projectTag` above). The setup test below MUTATES
// (creates the org/comp/division/stages) and the public-surface test MUTATES
// too (setOrgLocaleSql flips the org's default_locale) — both need their own
// account per width project. The org-surface test is read-only but must log
// back into the SAME account as setup to see the division it created, so it
// reuses this identity rather than computing a distinct one.
const P6_FIX1_EMAIL = () => `delivered+p6-fix1-${TAG}-${projectTag()}@resend.dev`;

test("P6 setup: a fresh org with an up-front TBD knockout fixture (seeded, group stage never generated)", async ({
  page,
}) => {
  await loginUi(page, P6_FIX1_EMAIL());
  const org = await activeOrg(page);
  p6OrgSlug = org.slug;

  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `P6 Fix1 ${TAG}`,
    visibility: "unlisted", // reachable on /shared/... — default is private
  });
  expect(comp.status).toBeLessThan(300);
  p6CompSlug = comp.data!.slug;

  const div = await apiJson<{ id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status).toBeLessThan(300);
  p6DivisionId = div.data!.id;
  p6DivSlug = div.data!.slug;

  await addEntrantsViaApi(page.request, p6DivisionId, ["Seed 1", "Seed 2", "Seed 3", "Seed 4"]);

  // Groups (2 pools of 2) feeding a knockout final via progression
  // (timing: "setup") — same shape as scripts/smoke.ts's
  // stageProgressionSuite() and P5's own stage-progression.spec.ts. The KO
  // fixture is generated BEFORE the group stage even has fixtures (the
  // owner's "placeholders at setup time" ruling) — both slots stay TBD,
  // carrying real slot.winner_group labels.
  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${p6DivisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2, kind: "knockout", name: "KO", config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status).toBeLessThan(300);
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const koGen = await apiJson<{ created: number; fixtures: { home_entrant_id: string | null }[] }>(
    page.request,
    `/api/v1/stages/${koId}/generate`,
    "POST",
  );
  expect(koGen.status).toBeLessThan(300);
  expect(koGen.data!.created).toBe(1);
  expect(koGen.data!.fixtures[0]!.home_entrant_id).toBeNull();
});

test("P6 org surface: the TBD fixture renders its resolved slot label, in the switcher's locale (finding #2/#5)", async ({
  page,
}) => {
  test.skip(p6DivisionId === "", "P6 setup test did not run/complete");
  await loginUi(page, P6_FIX1_EMAIL()); // same user/org as setup — a fresh page has no session of its own
  // Default locale first — proves the whole pipeline (usecase -> V360/V362
  // columns -> API -> stages-panel.tsx) is actually live, not merely
  // unit-tested in isolation.
  await page.goto(await divisionPath(page.request, p6DivisionId, "?tab=fixtures"));
  await expect(page.getByText("Winner of Group A", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Winner of Group B", { exact: false }).first()).toBeVisible();
  // No raw "TBD" (the pre-P6 behaviour on the surfaces this task touched)
  // and no leaked slot.* key or unfilled {placeholder}.
  await expect(page.getByText(/^TBD$/)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("slot.winner_group");
  await expectNoHorizontalScroll(page);

  // The explicit switcher cookie (resolveLocale()'s #1 priority, ahead of
  // even a signed-in user's own users.locale) — proves this is really a
  // LOOKUP, not a coincidentally-English hardcoded string.
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "seazn_locale", value: "es", url: origin }]);
  await page.reload({ waitUntil: "load" });
  await expect(page.getByText("Ganador del Grupo A", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Ganador del Grupo B", { exact: false }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Winner of Group");
  await expectNoHorizontalScroll(page);
});

test("P6 public surface: a visitor sees the resolved slot label in the ORG's own default_locale, not English (finding #2 — the review's core defect)", async ({
  page,
}) => {
  test.skip(p6DivisionId === "", "P6 setup test did not run/complete");
  await loginUi(page, P6_FIX1_EMAIL()); // same user/org as setup — activeOrg() below needs THIS org, not the default shared session's
  const org = await activeOrg(page);
  // The org's OWN locale — a public/embed page has no per-viewer request
  // scope to read a switcher cookie from (ISR), so THIS is the only lever a
  // visitor's browser has no control over and the review's finding #2 was
  // about: bracket.tsx/schedule.tsx/og-model.ts/slideshow-data.ts (+ the
  // fixture detail page, same pattern) previously ignored it completely.
  await setOrgLocaleSql(org.id, "es");

  await page.goto(`/shared/${p6OrgSlug}/${p6CompSlug}/${p6DivSlug}`, { waitUntil: "load" });
  // Default tab is Schedule (Tabs labels=["Schedule","Standings","Entrants"]).
  await expect(page.getByText("Ganador del Grupo A", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Ganador del Grupo B", { exact: false }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Winner of Group");
  await expect(page.locator("body")).not.toContainText("slot.winner_group");
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// The DRAW LIST names an unfilled knockout seat by its FEEDER (2026-09-21).
//
// The owner's report, off the live product: a division page's `?tab=fixtures`
// draw list showed a knockout whose quarter-finals read "Rank 1 vs Rank 8"
// but whose semi-final and final rows all read "TBD vs TBD — Awaiting draw",
// while the SCHEDULE showed the very same fixtures as "Winner of R1·1 vs
// Winner of R1·2". A defect in the gap between two individually-correct
// screens, which is exactly the class no single-surface test can see.
//
// The shape that reproduces it is a SETUP-timed progression bracket, and only
// that: `generateStageFixtures` (the plain path) stamps
// `slot.winner_match` into `*_slot_label`, so a plain knockout was never
// affected. `generateProgressionSetupFixtures` labels a synthetic seed ref
// and `bracket.slot.bye` and nothing else — deliberately, because
// `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒ sibling-fed" for
// `timing: "setup"` stages — so a sibling-fed seat's stored label is NULL and
// the FEED EDGES are the only thing that knows. A league of 4 feeding a
// 4-qualifier knockout is the smallest bracket with a sibling-fed seat: two
// semis seeded from the league, then a final fed by both.
//
// Lives here rather than in a new spec file for the same reason the P6 block
// above does: a new file would run desktop-only and never see
// 320/360/375/390/430/768/834.
// ---------------------------------------------------------------------------

let dlDivisionId = "";
const DL_EMAIL = () => `delivered+drawfeed-${TAG}-${projectTag()}@resend.dev`;

/** The SHIPPED copy for both legs of the draw-list test below, so a
 *  dictionary edit moves the assertions with it instead of freezing today's
 *  sentence (the idiom `progression-bye.spec.ts` and four other specs use).
 *  Asserting a hand-typed "Winner of R1·1" is how an EN leg ends up able to
 *  pass on the wrong copy — and how the es leg stops proving it is a lookup
 *  at all. `slot.match_ref` is identical in every locale by design, so only
 *  the sentence around it changes. */
const dlDict = (locale: "en" | "es"): Record<string, string> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const dlFeeder = (locale: "en" | "es", round: number, seq: number): string => {
  const d = dlDict(locale);
  return d["slot.winner_match"]!.replace(
    "{ext}",
    d["slot.match_ref"]!.replace("{round}", String(round)).replace("{seq}", String(seq)),
  );
};

test("draw list setup: a league feeding a 2-round knockout at timing:setup (sibling-fed final, no stored label)", async ({
  page,
}) => {
  await loginUi(page, DL_EMAIL());

  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Draw List ${TAG}`,
    visibility: "unlisted",
  });
  expect(comp.status).toBeLessThan(300);

  const div = await apiJson<{ id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  const divisionId = div.data!.id;

  await addEntrantsViaApi(page.request, divisionId, ["Seed A", "Seed B", "Seed C", "Seed D"]);

  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2, kind: "knockout", name: "Cup", config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status).toBeLessThan(300);
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const gen = await apiJson<{ created: number; fixtures: { round_no: number; home_entrant_id: string | null }[] }>(
    page.request,
    `/api/v1/stages/${koId}/generate`,
    "POST",
  );
  expect(gen.status).toBeLessThan(300);
  // Two semis + a final, every seat empty: the bracket is drawn but unplayed.
  expect(gen.data!.created).toBe(3);
  expect(gen.data!.fixtures.filter((f) => f.round_no === 2).length).toBe(1);
  expect(gen.data!.fixtures.every((f) => f.home_entrant_id === null)).toBe(true);

  dlDivisionId = divisionId;
});

test("draw list: the sibling-fed final reads 'Winner of R1·1 vs Winner of R1·2', not TBD", async ({ page }) => {
  test.skip(dlDivisionId === "", "draw list setup test did not run/complete");
  await loginUi(page, DL_EMAIL());
  await page.goto(await divisionPath(page.request, dlDivisionId, "?tab=fixtures"));

  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  // The POSITIVE pair for every negative below: the seeded semis DID render
  // their own (stored) labels, so the sheet is populated and any absent
  // "Winner of" is a real absence rather than a blank page.
  await expect(sheet.getByText("Rank 1", { exact: false }).first()).toBeVisible();
  await expect(sheet.getByText("Rank 4", { exact: false }).first()).toBeVisible();

  // The fix: BOTH of the final's seats named by their feeder. Copy from the
  // dictionary, never typed here — see `dlFeeder`.
  const EN_R1_1 = dlFeeder("en", 1, 1);
  const EN_R1_2 = dlFeeder("en", 1, 2);
  const ES_R1_1 = dlFeeder("es", 1, 1);
  // The derivations are only worth asserting if they differ: an es leg that
  // silently equalled the en one would make the locale switch below vacuous.
  expect(ES_R1_1, "the es feeder sentence is identical to the en one").not.toBe(EN_R1_1);
  expect(EN_R1_2).not.toBe(EN_R1_1);
  await expect(sheet.getByText(EN_R1_1, { exact: false }).first()).toBeVisible();
  await expect(sheet.getByText(EN_R1_2, { exact: false }).first()).toBeVisible();
  // …and no seat left saying TBD, which is what four of these rows said.
  await expect(sheet.getByText(/^TBD$/)).toHaveCount(0);
  await expect(sheet).not.toContainText("slot.winner_match");
  await expectNoHorizontalScroll(page);

  // THE PAIR, on ONE tab. The bracket TREE sits directly above this list and
  // is fed by the same `listDivisionFixtures` rows. Round 1 of this fix
  // taught only the list, which left the tree printing "TBD" immediately
  // above a row reading "Winner of R1·1" — adjacent panels contradicting each
  // other, which reads as broken rather than merely uninformative. Asserting
  // each surface on its own is what let them drift, so this asserts they
  // agree about the SAME match.
  const tree = page.getByTestId("bracket-panel");
  await expect(tree).toBeVisible({ timeout: 20_000 });
  await expect(tree.getByText(EN_R1_1, { exact: false }).first()).toBeVisible();
  await expect(tree.getByText(EN_R1_2, { exact: false }).first()).toBeVisible();
  await expect(tree.getByText(/^TBD$/)).toHaveCount(0);
  // The tree's own positive pair: the seeded semis still read their stored
  // labels, so an absent "Winner of" above would be a real absence.
  await expect(tree.getByText("Rank 1", { exact: false }).first()).toBeVisible();

  // A LOOKUP, not a coincidentally-English literal — and the ORGANISER
  // vocabulary ("Ganador de R1·1"), never the public `knockout.feederWinner`
  // form. `slot.match_ref` is identical in every locale by design, so the
  // ref survives the switch while the sentence around it does not.
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "seazn_locale", value: "es", url: origin }]);
  await page.reload({ waitUntil: "load" });
  await expect(sheet.getByText(ES_R1_1, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(sheet).not.toContainText(EN_R1_1);
  // The tree localizes with it — both surfaces read the dictionary, neither
  // carries its own copy of the sentence.
  await expect(tree.getByText(ES_R1_1, { exact: false }).first()).toBeVisible();
  await expect(tree).not.toContainText(EN_R1_1);
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// P6 (D4b task B) — the organiser-facing proposal panel: full browser flow
// (decided league -> panel -> resolve a tie -> confirm -> bracket shows real
// entrants, schedule unchanged on screen), plus the destructive-dialog path.
// Lives in mobile.spec.ts, not a new spec file, for the same reason as task
// A's block above — a new file runs desktop-only and never sees 320/360/
// 375/390/430/768/834.
//
// Tie mechanism: a 4-entrant single league where EVERY match is a DRAW
// (`allowDraws: true`) makes every entrant finish level on points/diff/for —
// the one deterministic way to reach a genuinely unresolved tie
// (server/usecases/__tests__/stage-progression.test.ts's own "cross-group
// tie is FLAGGED" test proves this exact shape; a 2-pool/1-draw shape was
// considered and is NOT what that suite uses). `rankRange(1,2)` over that
// league therefore ties BOTH destination slots against the SAME 4 candidates
// — there is no third, non-tied row in this scenario; edit-in-place on a
// NON-tied row is already proven at the component/wiring layer
// (progression-panel-wiring.test.tsx), so this flow's job is the tie path
// specifically, the one no unit test can fake (real standings, real DB,
// real confirm route).
// ---------------------------------------------------------------------------

// Per-project identity (see `projectTag` above, top of file). ALL THREE tests
// below share this account within one worker — setup creates the tied league
// + KO fixture, the confirm test MUTATES it (resolves the tie and confirms
// the seed proposal — the test that raced across width projects when TAG
// collided), and the destructive-edit test MUTATES too (generates then
// regenerates a stage's fixtures). Each width project needs its own account
// so its confirm()/regenerate() can't be raced by another project's.
const P6B_EMAIL = () => `delivered+p6b-${TAG}-${projectTag()}@resend.dev`;
let p6bDivisionId = "";
const P6B_COURT = "Center Court E2E";
const P6B_ENTRANTS = ["Nova Q", "Orion Q", "Piper Q", "Reeve Q"];

test("P6 task B setup: a 4-way-tied league decides, KO panel has a real tie to resolve", async ({
  page,
}) => {
  await loginUi(page, P6B_EMAIL());

  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `P6 TaskB ${TAG}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);

  const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    // allowDraws is load-bearing: without it, a 1-1 result either 422s or
    // is not treated as a genuine draw, and the standings cascade resolves
    // a winner instead of leaving every entrant level.
    config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status).toBeLessThan(300);
  p6bDivisionId = div.data!.id;

  await addEntrantsViaApi(page.request, p6bDivisionId, P6B_ENTRANTS);

  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${p6bDivisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status).toBeLessThan(300);
  const leagueId = stages.data!.find((s) => s.kind === "league")!.id;
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;

  // TBD KO fixture up front (owner ruling), then pinned — proving later that
  // confirm fills it without disturbing the pin (the non-destructive
  // guarantee, "on screen" this time rather than at the DB layer).
  const koGen = await apiJson<{ created: number; fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${koId}/generate`,
    "POST",
  );
  expect(koGen.data!.created).toBe(1);
  const koFixtureId = koGen.data!.fixtures[0]!.id;
  const { courts: p6bCourts } = await seedVenueWithCourts(page.request, [P6B_COURT]);
  const pin = await apiJson(page.request, `/api/v1/fixtures/${koFixtureId}`, "PATCH", {
    scheduled_at: "2030-11-15T14:00:00.000Z",
    court_id: p6bCourts[0]!.id,
  });
  expect(pin.status).toBeLessThan(300);

  const leagueGen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${leagueId}/generate`,
    "POST",
  );
  expect(leagueGen.data!.fixtures.length).toBe(6); // round robin of 4

  await apiJson(page.request, `/api/v1/divisions/${p6bDivisionId}/start`, "POST");
  for (const f of leagueGen.data!.fixtures) {
    await scoreFixture(page.request, f.id, 1, 1); // every match drawn -> all 4 level
  }

  const completed = await apiJson<{ completed: boolean; seed_proposal?: { status: string } }>(
    page.request,
    `/api/v1/stages/${leagueId}/complete`,
    "POST",
  );
  expect(completed.status).toBeLessThan(300);
  expect(completed.data!.completed).toBe(true);
  expect(completed.data!.seed_proposal?.status).toBe("draft");
});

/** The real (non-placeholder) <option>s currently rendered in a progression
 *  row's <select> — {value: entrant id, label: entrant name}. A tied row's
 *  pool correctly EXCLUDES whichever entrant is the other tied row's current
 *  pick (`optionsForSlot`, progression-panel.tsx:123-138). Before either row
 *  has an organiser edit, "the other row's current pick" is its computed
 *  default, which comes from the engine's "lots" tie-break — seeded by
 *  freshly generated entrant UUIDs (packages/engine/src/competition/
 *  tiebreakers.ts:577-611), so it is genuinely random per run. That means
 *  which entrant is missing from which row's <select> is random too: a test
 *  must read what a row actually offers rather than assume a fixed entrant
 *  lands in a fixed row (see project_p6_taskb_confirm_tiebreak_flake.md). */
async function realSelectOptions(select: Locator): Promise<{ value: string; label: string }[]> {
  const entries = await select.locator("option").evaluateAll<{ value: string; label: string }[]>((opts) =>
    opts.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() })),
  );
  return entries.filter((o) => o.value !== ""); // drop the "choose an entrant" placeholder
}

test("P6 task B: panel resolves the tie, confirms, bracket shows real entrants, schedule unchanged on screen", async ({
  page,
}) => {
  test.skip(p6bDivisionId === "", "P6 task B setup did not run/complete");
  await loginUi(page, P6B_EMAIL()); // same user/org as setup — a fresh page has no session of its own

  await page.goto(await divisionPath(page.request, p6bDivisionId, "?tab=fixtures"), { waitUntil: "load" });

  const panel = page.locator('[data-progression-state="draft"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("Knockout")).toBeVisible();
  await expect(panel.getByText("Tied", { exact: false }).first()).toBeVisible();

  const confirmBtn = panel.getByRole("button", { name: "Confirm proposal" });
  await expect(confirmBtn).toBeDisabled();

  // Both destination slots are tied against the same 4 candidates (see the
  // block comment above), but WHICH entrant is missing from WHICH row is
  // random per run (realSelectOptions above) — so resolve each row from
  // whatever it actually offers: the first real option in row 0, then
  // whatever remains distinct in row 1. This asserts the real relationship
  // (two rows, two distinct entrants, row 1's pool excluding row 0's pick)
  // rather than a coincidence of shuffle order, so it is strictly stronger
  // than picking two hardcoded names.
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  const row0Select = rows.nth(0).locator("select");
  const row1Select = rows.nth(1).locator("select");

  const row0Options = await realSelectOptions(row0Select);
  expect(row0Options.length).toBeGreaterThan(0);
  const pick0 = row0Options[0]!;
  await row0Select.selectOption({ value: pick0.value });
  await expect(row0Select).toHaveValue(pick0.value);

  // Only one of the two tied slots is resolved so far — confirm must stay
  // disabled until BOTH are (allTiesResolved, progression-panel.tsx:68-70).
  await expect(confirmBtn).toBeDisabled();

  // Row 1's own pool must now exclude whatever row 0 just picked — the
  // exact exclusion this flake was about, proven directly rather than
  // assumed, before acting on it.
  const row1Options = await realSelectOptions(row1Select);
  expect(row1Options.length).toBeGreaterThan(0);
  expect(row1Options.map((o) => o.value)).not.toContain(pick0.value);
  const pick1 = row1Options[0]!;
  await row1Select.selectOption({ value: pick1.value });
  await expect(row1Select).toHaveValue(pick1.value);
  expect(pick1.value).not.toBe(pick0.value);

  await expect(confirmBtn).toBeEnabled();
  await expectNoHorizontalScroll(page);
  await confirmBtn.click();

  // router.refresh() re-fetches the server props; the panel's OWN state
  // moves to "confirmed" once the reload lands.
  await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: 20_000 });

  // The bracket/fixture line now shows the CHOSEN entrants, never a raw TBD
  // or slot.* key — the panel's edit-in-place actually reached the fixture.
  await expect(page.getByText(pick0.label, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(pick1.label, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/^TBD$/)).toHaveCount(0);

  // Non-destructive guarantee, on screen: the court pinned before anyone
  // qualified is still exactly what shows now that the slot is filled.
  //
  // `p:visible`, not a bare `getByText(...).first()` (W3 Task 9 blast
  // radius): the run-sheet row now carries this SAME court/round text in
  // TWO paragraphs — one `hidden md:block` (desktop), one `md:hidden`
  // (phone, combined with the result sub-line) — "one DOM, branched", the
  // repo-wide phone-composition idiom. Below `md` the desktop copy is first
  // in DOM order but NOT visible, so a bare `.first()` resolved to it and
  // read "hidden" even though the phone copy of the same text was on
  // screen a few nodes later. Same fix `mobile.spec.ts:976`'s `nowLine`
  // already uses for the identical shape.
  await expect(page.locator("p:visible", { hasText: P6B_COURT }).first()).toBeVisible();

  await expectNoHorizontalScroll(page);
});

test("P6 task B fix round 3 (Critical 1): regenerating a stage that already has fixtures is a plain, unguarded click — no destructive-edit warning", async ({
  page,
}) => {
  test.skip(p6bDivisionId === "", "P6 task B setup did not run/complete");
  await loginUi(page, P6B_EMAIL());

  // A SEPARATE division/stage from the tie scenario — this path is generic
  // to any stage with existing fixtures, not specific to progression.
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `P6 TaskB Regen ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Regen",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const regenDivisionId = div.data!.id;
  await addEntrantsViaApi(page.request, regenDivisionId, ["Gale R", "Hollis R", "Ivy R", "Jett R"]);
  const stage = await apiJson<{ id: string }[]>(page.request, `/api/v1/divisions/${regenDivisionId}/stages`, "POST", [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
  ]);
  const groupId = stage.data![0]!.id;
  const gen = await apiJson<{ fixtures: { id: string }[] }>(page.request, `/api/v1/stages/${groupId}/generate`, "POST");
  expect(gen.data!.fixtures.length).toBe(2);

  await page.goto(await divisionPath(page.request, regenDivisionId, "?tab=fixtures"), { waitUntil: "load" });

  const groupCard = page.locator("section.card", { hasText: "Groups" }).first();
  // Competition desk W3: below `md` the stage's edit controls fold into a
  // bottom sheet behind `stage-rail-trigger`; at >= 768 the rail is inline and
  // the trigger itself is `md:hidden`. OPEN the fold rather than weakening the
  // assertion below — the control still exists and must still be reachable.
  // Gate the open on the TOGGLE being visible, never on a width literal:
  // clicking a hidden control throws.
  const railTrigger = groupCard.getByTestId("stage-rail-trigger");
  if (await railTrigger.isVisible()) await railTrigger.click();
  const generateBtn = groupCard.getByRole("button", { name: "Generate fixtures" });
  await expect(generateBtn).toBeVisible();

  // Regeneration is additive-only — generateStageFixtures never deletes, it
  // only inserts fixtures missing from the stage's existing set (stages.ts)
  // — so a re-click on a stage that ALREADY has fixtures (stageFixtures.length
  // > 0) proceeds immediately: no "are you sure" gate, because there is
  // nothing at stake to name. The old dialog claimed data loss that could
  // never happen; it is gone, not replaced with different copy.
  await generateBtn.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText(/error/i)).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Idempotent: rules didn't change since the API-driven generate above, so
  // the real outcome is "nothing new" — proven via the notice text the
  // component itself renders on a landed response (schedule.notice.nothingNew),
  // which is only reachable once the request actually fired (no gate ate the
  // click).
  await expect(page.getByText("Nothing new to generate", { exact: false })).toBeVisible({ timeout: 10_000 });
});

// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI — option
// A, split button"): Pair next grows a ▾ toggle whenever a Swiss stage has a
// round waiting, and the toggle opens an inline radiogroup. Every width
// project owes the same three things of it (spec, "Tests" — the width matrix
// covers the new control): the 44px floor on the toggle and on each option,
// no horizontal page scroll with the menu open, axe clean.
//
// Plus one behaviour no unit test can reach, because vitest has no DOM:
// Escape inside the menu closes the MENU, not the phone sheet around it. It
// used to close both — the App Router hydrates React onto `document`, the same
// node the sheet listens on, so `stopPropagation` in the menu's handler never
// kept the key from the sheet — and focus went back to the "Stage tools"
// trigger instead of the toggle. Below `md` that is the check that fails.
test("swiss pairing split button: the toggle and the round-1 options hold the 44px floor, axe-clean, no horizontal scroll; Escape closes only the menu", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Swiss pairing ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Swiss pairing",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const swissDivisionId = div.data!.id;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${swissDivisionId}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3, pairing: "rank_adjacent" },
  });
  expect(stage.status, "swiss stage create").toBe(201);
  // Ten seeded 1..10 — the prod field that motivated the feature, and a size
  // whose fold hint (1v6…) differs from the neighbours hint (1v2…).
  await addEntrantsViaApi(
    request,
    swissDivisionId,
    Array.from({ length: 10 }, (_, i) => `Swiss M${i + 1}`),
  );
  const started = await apiJson(request, `/api/v1/divisions/${swissDivisionId}/start`, "POST");
  expect(started.status, "start mints the swiss shells").toBe(200);

  await page.goto(await divisionPath(request, swissDivisionId, "?tab=fixtures"), { waitUntil: "load" });

  // Below `md` the rail folds into the "Stage tools" sheet (AGENTS rule 22):
  // OPEN it, gated on the trigger being visible — never on a width literal.
  const railTrigger = page.getByTestId("stage-rail-trigger");
  const folded = await railTrigger.isVisible();
  if (folded) await railTrigger.click();
  const railScope = page.getByTestId(folded ? "stage-rail-sheet" : "stage-rail");

  const toggle = page.getByTestId("stage-pairing-toggle");
  await expect(page.getByTestId("stage-generate")).toHaveText("Pair next round");
  await assertTapFloor(toggle, "pairing toggle");
  // The toggle is a glyph with no text to widen it — the floor is both axes.
  expect((await toggle.boundingBox())!.width, "pairing toggle width").toBeGreaterThanOrEqual(44);

  await toggle.click();
  const menu = page.getByTestId("stage-pairing-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("role", "radiogroup");
  const fold = page.getByTestId("stage-pairing-fold");
  const adjacent = page.getByTestId("stage-pairing-rank_adjacent");
  await expect(fold).toHaveAttribute("aria-checked", "true");
  await expect(fold).toContainText("1v6, 2v7, 3v8…");
  await assertTapFloor(fold, "pairing option: top vs bottom");
  await assertTapFloor(adjacent, "pairing option: neighbours");
  await expectNoHorizontalScroll(page);

  const axe = await new AxeBuilder({ page })
    .include(folded ? '[data-testid="stage-rail-sheet"]' : '[data-testid="stage-rail"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    "axe serious/critical on the rail with the pairing menu open",
  ).toEqual([]);

  // Keyboard: arrows move AND select; Escape closes the menu and hands focus
  // back to the toggle — and, below `md`, leaves the sheet open.
  await fold.focus();
  await page.keyboard.press("ArrowDown");
  await expect(adjacent).toHaveAttribute("aria-checked", "true");
  await expect(adjacent).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(railScope, "Escape in the pairing menu closed the rail around it").toBeVisible();
  await expect(toggle).toBeFocused();
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
// RS004 registration hub — the row-click config panel, open, at every width
// (v3/02 §4 viewport gate). Lives here rather than in the new
// registration-hub.spec.ts for the same reason every other mobile-matrix
// case in this file does: a spec file outside this one runs desktop-only and
// never sees 320/360/375/390/430/768/834 — exactly the shape this check
// exists to catch (a modal sized in `vh` or pinned `inset-0` passes at
// desktop and breaks at 320). `projectTag()` (top of file) is folded into
// this test's own account because it MUTATES registration settings (opening
// the panel triggers its GET; this test doesn't save, but the account still
// needs to be per-project) — seven width projects start near-simultaneously
// and share helpers.ts's per-PROCESS `TAG`, so an un-tagged email can log two
// of them into the same user/org/division (see the P6 comment above).
// ---------------------------------------------------------------------------
const REG_HUB_MOBILE_EMAIL = () => `delivered+reghub-${TAG}-${projectTag()}@resend.dev`;

test("registration hub: the config panel has no horizontal scroll, open", async ({ page }) => {
  await loginUi(page, REG_HUB_MOBILE_EMAIL());
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Reg Hub Mobile ${TAG}-${projectTag()}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  const divisionIdReg = div.data!.id;

  const org = await activeOrg(page);
  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration`, { waitUntil: "load" });
  const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionIdReg}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-registration-hub-row-configure]").click();

  const panel = page.locator(`[data-registration-hub-config-panel][data-division-id="${divisionIdReg}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // Past the panel's own async GET/loading placeholder — a known field is
  // the signal its state actually landed.
  await expect(panel.locator('[data-field="category"]')).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// RS005 — Registrants tab, the whole width matrix (v3/02 §4 viewport gate).
// One test covers everything the dispatch called out for this file
// (no-scroll+rows, the grid/card switch, an expanded row's worst-case
// content, the filter bar) off ONE seeded fixture — the same economy the
// "registration hub" test just above uses; a login+seed per check would
// multiply setup cost across all seven width projects for no extra
// coverage. `projectTag()` is folded into this test's own account for the
// SAME reason that test's own comment gives: it MUTATES (via the public
// register API) and TAG is per-PROCESS, not per-project.
// ---------------------------------------------------------------------------
const REGISTRANTS_MOBILE_EMAIL = () => `delivered+regtab-${TAG}-${projectTag()}@resend.dev`;

test("registrants tab: no-scroll, grid/card switch, expanded-row and filter-bar overflow, at this width", async ({
  page,
}) => {
  await loginUi(page, REGISTRANTS_MOBILE_EMAIL());
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Registrants Mobile ${TAG}-${projectTag()}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);

  const teamDiv = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Mobile Team",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(teamDiv.status).toBeLessThan(300);
  const soloDiv = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Mobile Solo",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(soloDiv.status).toBeLessThan(300);
  for (const [divId, kind] of [
    [teamDiv.data!.id, "team"],
    [soloDiv.data!.id, "individual"],
  ] as const) {
    const settings = await apiJson(page.request, `/api/v1/divisions/${divId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: kind,
      fee_cents: 0,
      approval: "auto",
    });
    expect(settings.status).toBeLessThan(300);
  }

  const org = await activeOrg(page);
  // ONE cart, two entries sharing a group — gives the team entry a cart
  // SIBLING to render on top of its own join code + roster: the detail
  // body's worst case for width (join code, warning copy, roster, cart
  // siblings, per the dispatch) all at once. A deliberately long captain
  // name stress-tests the narrowest project (320px).
  const captainName = `Captain With An Unusually Long Name For Overflow Testing ${TAG}`;
  const submitted = await apiJson<{ entries: { registration_id: string; division_id: string }[] }>(
    page.request,
    `/api/v1/public/orgs/${org.slug}/competitions/${comp.data!.slug}/register`,
    "POST",
    {
      contact: { name: captainName, email: `delivered+mobile-captain-${TAG}-${projectTag()}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: teamDiv.data!.id,
          entrant_kind: "team",
          // A deliberately long team name too — the same 320px stress case
          // as the captain's name; a non-free-agent team entry requires one
          // (entryDisplayName, registration-submit.ts).
          team_name: `Team With An Equally Long Name For Overflow ${TAG}`,
          players: [{ full_name: captainName, is_captain: true }],
          answers: {},
        },
        {
          division_id: soloDiv.data!.id,
          entrant_kind: "individual",
          players: [{ full_name: `Solo Sibling ${TAG}` }],
          answers: {},
        },
      ],
    },
  );
  expect(submitted.status, JSON.stringify(submitted)).toBe(201);
  const teamRegId = submitted.data!.entries.find((e) => e.division_id === teamDiv.data!.id)!.registration_id;

  // 1) The tab itself: no horizontal scroll, rows present.
  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration?tab=registrants`, { waitUntil: "load" });
  const row = page.locator(`[data-registration-hub-registrant-row][data-registration-id="${teamRegId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);

  // 2) The grid/card switch: below the `sm` (640px) breakpoint the phone
  //    CARD block is what's visible; at/above it, the aligned-columns GRID
  //    block is — both always exist in the DOM (CSS picks which shows), so
  //    this is a real visibility assertion, not a class-name probe.
  const isPhoneWidth = (projectViewport()?.width ?? 0) < 640;
  const card = row.locator("[data-registration-hub-registrant-card]");
  const grid = row.locator("[data-registration-hub-registrant-grid]");
  if (isPhoneWidth) {
    await expect(card).toBeVisible();
    await expect(grid).not.toBeVisible();
  } else {
    await expect(grid).toBeVisible();
    await expect(card).not.toBeVisible();
  }

  // 3) Expanded row: join code (+ its warning copy), roster, AND a cart
  //    sibling link all render at once — the detail body's densest case.
  await row.locator("summary").click();
  await expect(row.locator("[data-registration-hub-registrant-detail]")).toBeVisible();
  await expect(row.locator("[data-registration-hub-registrant-join-code]")).toBeVisible();
  await expect(row.locator("[data-registration-hub-registrant-roster-player]").first()).toBeVisible();
  await expect(row.locator("[data-registration-hub-registrant-sibling-link]")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // 4) The filter bar: present, no overflow, and its controls stay
  //    touch-sized (min-h-11 = 44px, the same bar every other v3 control in
  //    this file is held to). R4 (task 1, auto-submit) removed the filter
  //    bar's own submit button entirely — every control now submits itself
  //    on change (registration-hub-registrant-filters.tsx's own header
  //    comment) — so the status <select> (still present, still min-h-11) is
  //    the stand-in; it is not interacted with here (a change would
  //    navigate away via requestSubmit()), only measured.
  const filters = page.locator("[data-registration-hub-registrant-filters]");
  await expect(filters).toBeVisible();
  const statusSelect = filters.locator('select[name="status"]');
  const box = await statusSelect.boundingBox();
  expect(box, "filter status select must have a measurable box").not.toBeNull();
  expect(box!.height, "filter controls must stay >=44px tall (touch target)").toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// RS006 gap — the public registration STEPPER's steps 2-5 had ZERO width
// coverage. `mobile.spec.ts` only ever loaded the stepper's WHO (step 1)
// landing frame ("public surfaces: no horizontal scroll" above `goto`s
// `/register` once and stops; the LCP test further up only measures load
// time, never layout). ENTRIES, DETAILS, CONSENT and REVIEW never rendered
// at ANY width in CI. DETAILS is the real risk: roster-table.tsx renders an
// `input[type="date"]` per roster row once a division `requires_dob`
// (age_min/age_max set — @/lib/registration-rules' requiresDob) — the
// widest control the whole flow produces, and exactly the shape that
// overflows a 320px page.
//
// Self-contained: its own competition + two divisions, read back by id/slug
// from each API response, never by re-querying on name or TAG — TAG is
// per-PROCESS, not per-project (this file's own header comment), so a name
// collision across two width workers is possible and this test must not
// care. It reads the org's slug via `activeOrg`, the same way every other
// self-contained test in this file does (T15/T16/T17 above) — but it is NOT
// read-only: it DOES mutate the shared org, minting one competition and two
// divisions under it. Left alone that accumulates forever (all seven width
// projects run this test, every CI run), so the whole flow below runs
// inside a `try` whose `finally` deletes the competition by the exact id
// captured right after creation — never a name/prefix search, so cleanup
// can never catch a concurrent width project's own row. The delete cascades
// both divisions and their registration_settings rows (competition_id /
// division_id are ON DELETE CASCADE), fires even when an assertion above
// throws, and is best-effort/unasserted so a cleanup hiccup can never mask
// a real test failure.
//
// "Stepper Solo" is `entrant_kind: "individual"`, PATCHED with `age_min: 0`
// right after creation — the cheapest way to flip `requires_dob` true with
// no real restriction (requiresDob only checks `age_min != null`; "0 or
// older" is true for any dob a person could type). It is the ONE division
// added to the cart on step 2 — ADD_ENTRY seeds an individual entry with
// exactly one blank roster row (cart.ts's `blankPlayers`), the minimal
// shape that still reaches the date input. "Stepper Team" carries no age
// rule and is never added to the cart — it exists only so
// `openDivisions.length` is 2: steps.ts collapses the whole ENTRIES step
// to nothing when there is exactly ONE open division
// (`shouldCollapseEntries`), which would make step 2 unreachable. Neither
// division is self-linked ("I'm playing" stays off) — `guardianRequired`
// (step 4) keys off the CART's own self-link, not that toggle, so this
// keeps the guardian block off without needing a dob that also satisfies a
// real eligibility band for the contact. Both divisions are free
// (fee_cents: 0) — no Stripe/Connect fixture needed, and no `checkout_url`
// redirect risk (this test stops at the REVIEW frame; it never taps
// Submit).
// ---------------------------------------------------------------------------
test("register stepper: ENTRIES/DETAILS/CONSENT/REVIEW hold at this width, no horizontal scroll", async ({
  page,
  browser,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Stepper ${TAG}-${projectTag()}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);

  // Everything below mutates the shared org (this competition + its two
  // divisions — see this test's header comment) and must be torn down even
  // when an assertion throws, so it all runs inside this `try`; the
  // `finally` deletes by `comp.data!.id`, captured above, never by name.
  try {
    const soloDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Stepper Solo",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    expect(soloDiv.status).toBeLessThan(300);
    const soloDivisionId = soloDiv.data!.id;
    // Flips requires_dob true (requiresDob, @/lib/registration-rules) with no
    // real age restriction — see this test's header comment.
    const agePatch = await apiJson(request, `/api/v1/divisions/${soloDivisionId}`, "PATCH", { age_min: 0 });
    expect(agePatch.status).toBeLessThan(300);
    const soloSettings = await apiJson(
      request,
      `/api/v1/divisions/${soloDivisionId}/registration-settings`,
      "PUT",
      { enabled: true, entrant_kind: "individual", capacity: 10, fee_cents: 0, form_fields: [] },
    );
    expect(soloSettings.status).toBeLessThan(300);

    const teamDiv = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Stepper Team",
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
      { enabled: true, entrant_kind: "team", capacity: 10, fee_cents: 0, form_fields: [] },
    );
    expect(teamSettings.status).toBeLessThan(300);

    const org = await activeOrg(page);

    const anonCtx = await browser.newContext({ viewport: projectViewport() ?? undefined });
    try {
      const anon = await anonCtx.newPage();
      await anon.goto(`/shared/${org.slug}/${comp.data!.slug}/register`, { waitUntil: "load" });
      await anon.waitForTimeout(300);

      // Step 1 — WHO. Two open divisions, one `requires_dob`, means
      // "I'm playing" is left off deliberately (see this test's header
      // comment), and `whoFieldRequirements` now gates the contact's OWN dob
      // on that toggle: a secretary entering a team is never a player, so the
      // server never asks for their dob (`PublicRegisterGroupRequest`'s
      // superRefine requires `contact.dob` only when some entry is
      // `registering_self`). Collecting it anyway was compulsory collection of
      // personal data the system never uses, on the step immediately before the
      // privacy-consent checkbox.
      //
      // This assertion is INVERTED rather than deleted: it used to demand the
      // field be visible, and it is the probe that catches the requirement
      // silently coming back. A `requires_dob` division still asks for every
      // PLAYER's dob at step 3 — that is what this test exercises below, and it
      // is unaffected.
      await expect(anon.locator("#reg-who-name")).toBeVisible({ timeout: 20_000 });
      await anon.locator("#reg-who-name").fill(`Mobile Stepper Contact ${TAG}`);
      await anon.locator("#reg-who-email").fill(`delivered+stepper-${TAG}-${projectTag()}@resend.dev`);
      await expect(
        anon.locator("#reg-who-dob"),
        "a contact who is not playing must NOT be asked for their own date of birth",
      ).toHaveCount(0);
      await anon.getByRole("button", { name: "Next", exact: true }).click();

      // Step 2 — ENTRIES.
      await expect(anon.getByRole("heading", { name: "Choose your divisions", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await anon.getByRole("button", { name: "Add an entry", exact: true }).click();
      await expect(
        anon.getByRole("button", { name: "Remove", exact: true }),
        "adding the individual division must land one line in the cart",
      ).toBeVisible();
      await expectNoHorizontalScroll(anon);
      await anon.getByRole("button", { name: "Next", exact: true }).click();

      // Step 3 — DETAILS. The point of this test: a requires_dob division's
      // roster row renders `input[type="date"]`, the widest control in the
      // whole flow, and it must fit at every width.
      await expect(anon.getByRole("heading", { name: "Player details", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      const rosterName = anon.getByPlaceholder("Full name");
      await expect(rosterName).toBeVisible();
      await rosterName.fill("Alex Roster");
      const rosterDob = anon.locator('input[type="date"]');
      await expect(
        rosterDob,
        "roster table must render a date input for a requires_dob division",
      ).toBeVisible();
      await rosterDob.fill("1990-05-15");
      const dobBox = await rosterDob.boundingBox();
      expect(dobBox, "roster date-of-birth input has no layout box").not.toBeNull();
      const vw = anon.viewportSize()?.width ?? 0;
      expect(
        dobBox!.x + dobBox!.width,
        "roster date-of-birth input right edge must stay within the viewport",
      ).toBeLessThanOrEqual(vw);
      await expectNoHorizontalScroll(anon);
      await anon.getByRole("button", { name: "Next", exact: true }).click();

      // Step 4 — CONSENT. No self-link anywhere in the cart, so the guardian
      // block must be absent (guardianRequired keys off the cart's self-link,
      // not the WHO step's "I'm playing" toggle) — only privacy consent gates
      // "Next" here.
      await expect(anon.getByRole("heading", { name: "Consent", exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(anon.locator("#reg-guardian-name")).toHaveCount(0);
      await anon.locator("#reg-consent-privacy").check();
      await expectNoHorizontalScroll(anon);
      await anon.getByRole("button", { name: "Next", exact: true }).click();

      // Step 5 — REVIEW. Final frame; deliberately never taps Submit (that
      // would POST the real registration and navigate away — out of scope for
      // a width-coverage test).
      await expect(anon.getByRole("heading", { name: "Review & pay", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(anon.getByText("Stepper Solo")).toBeVisible();
      await expectNoHorizontalScroll(anon);
    } finally {
      await anonCtx.close();
    }
  } finally {
    // Best-effort, unasserted cleanup: deletes by the exact id captured
    // above, never a name/prefix search, so this can never race or catch a
    // concurrent width project's own competition. Cascades both divisions
    // and their registration_settings rows (competition_id/division_id are
    // ON DELETE CASCADE), and is swallowed rather than asserted so a cleanup
    // hiccup can never mask a real failure from the try block above it.
    await apiJson(request, `/api/v1/competitions/${comp.data!.id}`, "DELETE").catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// T17 — the ScoringPad v3 RACQUET pads (R5/tasks C1-C3: badminton, table
// tennis, volleyball) at all SEVEN width projects.
//
// Same reasoning T16 gives for cricket, and it applies three more times over:
// R5 split these sports off a SHARED v2 skin (`racquet-skin.tsx`) onto three
// separate v3 skins, each a new render tree, and this file's own seven
// projects are the ONLY place any new surface gets width coverage narrower
// than 375/768 at all (reference_new_ui_surface_uncovered_until_in_mobile_
// spec). Before this block, `git grep -a` for badminton/tabletennis/
// volleyball across mobile.spec.ts returned ZERO matches — three brand-new
// pads with no width bar whatsoever.
//
// One test per sport rather than one walking all three: a 320px failure that
// reads "badminton pad" is a different alarm from one that reads "the R5
// pads", and the extra fixture seeding is cheap next to losing that.
//
// Every fixture here seeds with `emitCoreStart: true`, so none of these pay
// T16's Start-match hydration dance — the pad is live on first paint.
// ---------------------------------------------------------------------------

/** Both scoreboard halves, scoped to `button` deliberately: a half renders
 *  EITHER a `<button>` (tappable — live, band 3) or a plain `<div>` at the
 *  same grid position, and a wildcard locator happily resolves the untappable
 *  div. Tap model S — the halves ARE the scoring control on all three of
 *  these sports, so they are the touch target that matters most here. */
function padHalf(page: Page, side: "home" | "away"): Locator {
  return page
    .getByTestId("score-pad")
    .locator('[data-role="v3-scorebug"]')
    .locator(".grid > button")
    .nth(side === "home" ? 0 : 1);
}

function padTile(page: Page, id: string): Locator {
  return page.getByTestId("score-pad").locator(`[data-tile-id="${id}"]`);
}

async function assertTouchFloor(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
  const box = await locator.boundingBox();
  expect(box, `${label} has no box`).not.toBeNull();
  expect(box!.height, `${label} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
}

/**
 * The floor asserted the way a finger meets it: hit-test the extremes of the
 * control's own box and require both to land on the control.
 *
 * `boundingBox()` alone cannot see whether a control is genuinely tappable
 * across its painted height — this is how tile-grid.tsx's `minor` kind stayed
 * wrong for four waves. It painted 40px and claimed 44 via a `::before` bleed
 * of 2px top and bottom; a click dispatched into that bleed in a real browser
 * lands on the GRID CONTAINER and never opens the tile's sheet. A box
 * assertion cannot tell a real 44 from a claimed one, in either direction.
 *
 * `scrollIntoViewIfNeeded` first, and deliberately: `elementFromPoint` is
 * viewport-relative and answers `null` for everything below the fold, so
 * without it this probe reports "not tappable" for any control that merely
 * happens to be off-screen — the first version of this helper did exactly
 * that, and read as a product defect.
 */
async function assertTapFloor(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
  // CENTRE it, don't merely bring it on-screen. `scrollIntoViewIfNeeded()`
  // scrolls the minimum distance, which parks the element FLUSH with the
  // viewport top — directly beneath the app's sticky nav — and the top-edge
  // hit test below then lands on the nav and reports a control as untappable
  // when nothing is wrong with it. That is scroll position, not geometry: it
  // fired only at 320px, where the taller page happens to produce that exact
  // resting place. Centring removes the artifact while leaving what this
  // probe is actually for — occlusion by the element's own neighbours —
  // fully intact.
  await locator.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
  });
  const probe = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const hit = (y: number): boolean => {
      const at = document.elementFromPoint(cx, y);
      return at !== null && (at === el || el.contains(at));
    };
    // 1px inside each edge — a fractional layout must not put the probe on
    // the boundary pixel itself and read as a miss.
    return { height: r.height, top: hit(r.top + 1), bottom: hit(r.bottom - 1) };
  });
  expect(probe.height, `${label} touch target is ${probe.height}px`).toBeGreaterThanOrEqual(44);
  expect(probe.top, `${label} is not tappable at its TOP edge`).toBe(true);
  expect(probe.bottom, `${label} is not tappable at its BOTTOM edge`).toBe(true);
}

/** A control must stay INSIDE the box that paints it. Measured against the
 *  element's own container, never the page: `swap-sheet.tsx`'s "who came off"
 *  chip once carried `shrink-0` with no max-width and took its full content
 *  width (375px) inside a 314px row, spilling 77px past a wrapper whose
 *  `overflow-hidden rounded-2xl` then CLIPPED the player's name mid-string.
 *
 *  `expectNoHorizontalScroll` is blind to that by construction, which is why
 *  it survived: the clip means `documentElement.scrollWidth` never grows, so
 *  the page gate reports clean while the name is unreadable (verified:
 *  `pageHScroll: 0` while the element spilled 77px). An `overflowsX` check on
 *  the element is blind too — its own `scrollWidth` is not greater than its
 *  own box, because the BOX is what grew past the parent. */
async function assertNoContainerSpill(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} not visible`).toBeVisible({ timeout: 20_000 });
  await locator.scrollIntoViewIfNeeded();
  const probe = await locator.evaluate((el) => {
    const parent = el.parentElement;
    if (parent === null) return null;
    const r = el.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    return {
      spillRight: Math.round(r.right - pr.right),
      spillLeft: Math.round(pr.left - r.left),
      width: Math.round(r.width),
      parentWidth: Math.round(pr.width),
    };
  });
  expect(probe, `${label} has no parent element to measure against`).not.toBeNull();
  expect(
    probe!.spillRight,
    `${label} spills ${probe!.spillRight}px past its container's RIGHT edge ` +
      `(${probe!.width}px inside ${probe!.parentWidth}px) — it is being clipped, ` +
      `and the page-level scroll gate cannot see it`,
  ).toBeLessThanOrEqual(0);
  expect(
    probe!.spillLeft,
    `${label} spills ${probe!.spillLeft}px past its container's LEFT edge`,
  ).toBeLessThanOrEqual(0);
}

/** The three checks every racquet pad owes at every width, before any
 *  sport-specific surface: the pad rendered at all (not just a 2xx shell),
 *  both scoring halves clear the 44px floor, and the page does not scroll
 *  sideways. */
async function assertRacquetPadFloor(page: Page): Promise<void> {
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(padHalf(page, "home"), "home scoreboard half");
  await assertTouchFloor(padHalf(page, "away"), "away scoreboard half");
  await expectNoHorizontalScroll(page);
}

test("badminton v3 pad: both scoring halves and the Set-score tile hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Badminton V3 ${TAG}-${projectTag()}`,
    sportKey: "badminton",
    // The variant is `bwf`, not "singles" — and a badminton division refuses
    // `team` entrants, which is `seedRosteredFixture`'s default, so
    // `entrantKind` is required rather than optional here.
    variantKey: "bwf",
    entrantKind: "individual",
    // PERSON NAMES CARRY `projectTag()`, not just the fixture label — review
    // finding 5's rule (this file's own header, line ~303), and the reason is
    // structural rather than stylistic: `e2e.yml`'s `phones-large` leg runs
    // `--project=mobile-14 --project=mobile-430` in ONE process, and `TAG` is
    // per PROCESS. Two width projects therefore seed the SAME person name, and
    // `seedRosteredFixture` get-or-creates a person by name — so the second
    // fixture rosters the first one's person. The fixture label alone does not
    // save it: the collision is on the PERSON row, not the fixture.
    home: [{ fullName: `Mobile BD Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile BD Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await assertRacquetPadFloor(page);

  // The Set-score tile is the band-0 action that survives at every fidelity
  // band, so it is the one tile guaranteed present on a fresh live pad.
  await assertTouchFloor(padTile(page, "setScore"), "Set-score tile");

  // A real rally tap, then the context strip it brings on screen — the strip
  // is a new v3 surface and only renders once the reader can name a server,
  // which for badminton takes the SECOND rally (the first has no prior rally
  // to derive the serve from). R7-42/R7-30/R7-43 (owner ruling, `_INDEX.md`):
  // the pipeline's double-submit guard (compares the whole payload) is now
  // 250ms (was 600ms) and a refused repeat is VISIBLE rather than silent, so
  // the clearance the two same-payload taps used to pay is gone.
  await padHalf(page, "home").click();
  await padHalf(page, "home").click();
  // The SERVER item specifically, never `.first()`. `buildStrip` pushes an
  // unconditional "games" item ahead of everything else, so a `.first()` probe
  // resolves whether or not a single rally was ever tapped — proven by
  // commenting out both taps above and watching this test still pass. The
  // server item is gated on the reader being able to NAME a server, which for
  // badminton takes the second rally, so it fails if the taps stop landing.
  const serverItem = page
    .getByTestId("score-pad")
    .locator('[data-role="v3-scorebug"] [data-strip-item-id="server"]');
  await expect(serverItem, "two tapped rallies must bring the server onto the strip").toBeVisible({
    timeout: 20_000,
  });
  // Same poll the cricket v3 test pays before `expectPhoneComposition`: the
  // ledger assertion snapshots row count once, and both taps can outrun the
  // fold before that snapshot if we only wait on UI chrome (the server strip).
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(
          page.request,
          `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).filter((e) => e.type === "badminton.rally").length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  await expectNoHorizontalScroll(page);
  await expectPhoneComposition(page, "S");
});

// ---------------------------------------------------------------------------
// W2e Task 30 (D3, D13; rule X-SE-1) — the ending prompt, at every phone width
// ---------------------------------------------------------------------------
//
// A sanction that ends the match and has no ending recorded opens the pad on a blocking prompt ("A sanction against <side> ends
// the match" / Record the ending / Void the sanction). `w2e-ending-sanction.test.ts` proves the prompt is in the pad's markup
// and who is offered what; only a browser settles that it is REACHABLE on a phone: above the fold, both answers hit-testable
// at 44px, no horizontal scroll, and nothing in it clipped.
//
// The pending state is seeded the way a real one arises on a reload: the sanction is appended to the ledger through the API
// (an organiser may append it; the write path accepts the sanction itself and refuses what comes AFTER it), and the console is
// then opened on that ledger. Both sports are swept from the engine's own `sanctionEnding` declaration, with the count
// asserted. The prompt is not inside a folded disclosure (AGENTS.md failure class 22), so no fold has to be opened; it is
// waited on with `toBeVisible`, which is the claim being made.
const ENDING_SEEDS: Record<string, { variantKey: string }> = {
  badminton: { variantKey: "bwf" },
  tennis: { variantKey: "tour" },
};
const ENDING_SPORTS = builtinModules
  .filter((m) => (m.sanctionEnding?.endLevels.length ?? 0) > 0)
  .map((m) => ({ key: m.key, eventType: m.sanctionEnding!.eventType, level: m.sanctionEnding!.endLevels[0]! }));

test("ending prompt (W2e T30) covers every sport that declares an ending level", () => {
  expect(ENDING_SPORTS.map((s) => s.key).sort(), "the engine's declaring sports must all be seeded below").toEqual(
    Object.keys(ENDING_SEEDS).sort(),
  );
});

/** A rostered fixture whose ledger is [core.start, <end-level sanction against home>] — an ending PENDING, the way a reload finds one.
 *  The sanction is appended through the API (an organiser may append it; the write path refuses what comes AFTER it). Names carry
 *  `projectTag()`: two width projects share one process and `seedRosteredFixture` get-or-creates a person by name. */
async function seedPendingEnding(request: APIRequestContext, sport: (typeof ENDING_SPORTS)[number], who: string) {
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Ending ${who} ${sport.key} ${TAG}-${projectTag()}`,
    sportKey: sport.key,
    variantKey: ENDING_SEEDS[sport.key]!.variantKey,
    entrantKind: "individual",
    home: [{ fullName: `Mobile End ${who} ${sport.key} Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile End ${who} ${sport.key} Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });
  const before = await apiJson<{ seq: number }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
  const tip = Math.max(0, ...(before.data ?? []).map((e) => e.seq));
  const sanction = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: tip,
    type: sport.eventType,
    payload: { by: fx.homeEntrantId, level: sport.level },
  });
  expect(sanction.status, `seeding the pending sanction: ${JSON.stringify(sanction.error)}`).toBeLessThan(300);
  return fx;
}

for (const sport of ENDING_SPORTS) {
  test(`${sport.key} v3 pad: a pending ending sanction opens the pad on the ending prompt — both answers reachable at 44px, no horizontal scroll`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const fx = await seedPendingEnding(request, sport, "Organiser");

    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    const pad = page.getByTestId("score-pad");
    await expect(pad).toBeVisible({ timeout: 20_000 });
    const prompt = pad.getByTestId("pad-ending-pending");
    await expect(prompt, "the pad must open on the ending prompt for a ledger that is pending").toBeVisible({ timeout: 20_000 });

    // Both answers, hit-tested at their top and bottom edges and 44px tall (the organiser console is offered both).
    await assertTapFloor(prompt.getByTestId("pad-ending-record"), "Record the ending");
    await assertTapFloor(prompt.getByTestId("pad-ending-void"), "Void the sanction");

    // Phone composition: the prompt is in the host's unordered band, so it sits ABOVE the ordered rows (ribbon, recording
    // chip, activity) on a phone and in source order at md+. The pad's one open question is the first thing under the score.
    const promptBox = await prompt.boundingBox();
    expect(promptBox, "the prompt has no box").not.toBeNull();
    const ribbonBox = await pad.locator('[data-role="v3-ribbon"]').boundingBox();
    expect(ribbonBox, "the ribbon (the sanction just recorded) has no box").not.toBeNull();
    expect(promptBox!.y, "the prompt must come before the ribbon and the rest of the ordered rows").toBeLessThan(ribbonBox!.y);

    // The board is not offered under the prompt (every tap on it would be refused by the write path).
    await expect(pad.locator('[data-role="v3-tiles"]')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    const { clipped } = await overflowingIn(page, '[data-role="v3-ending"]', "*", "the ending prompt was not in the DOM");
    expect(clipped, "the ending prompt must not clip its own content at this width").toEqual([]);
  });
}

// The SCORER's prompt (M-6). A device link is offered less than the organiser, and the copy changes with it, so the card has
// FOUR layouts, not one (`endingBodyKey`): both answers (the organiser test above), "Record the ending" alone (a fresh device: the
// sanction is the last live event so the server admits its ending, but the row is not the device's own to void), NEITHER (a
// pre-W2e ledger, where something was recorded after the card and the device did not write the sanction: only the organiser can
// resolve it), and VOID ONLY (below).
//
// Two of them are SEEDED here: the two a fresh device can reach. The third, `voidOnly`, is the card with the LONGEST copy in
// every locale and one button, and it cannot be seeded: it needs a device that wrote the sanction ITSELF in this mount
// (`ownEventIds` is in-memory only and is empty on a fresh page, so a seeded device never owns the row) AND a row recorded after
// it. It is driven in the mount instead, below the loop (W2e T33b, N2): the handed device sends the sanction through the pad,
// a row lands behind it while its ending is still on the wire, and the server refuses the ending. `neither` has no button to
// anchor the layout.
//
// The `neither` ledger cannot be written through the API (the write path refuses everything after an ending sanction), so the
// event after the card is written by raw SQL: the one way such a row exists, the shape an earlier build left behind. A stoppage is
// the sport-blind event for it (the T29 route test uses the same `[sanction, suspend]` shape).
const ENDING_SCORER_VARIANTS = [
  { name: "record-only", between: false, bodyKey: "pad.ending.body.recordOnly", record: true },
  { name: "neither", between: true, bodyKey: "pad.ending.body.neither", record: false },
] as const;

for (const sport of ENDING_SPORTS) {
  for (const variant of ENDING_SCORER_VARIANTS) {
    test(`${sport.key} v3 pad (handed device, ${variant.name}): the prompt's own copy and buttons fit — reachable at 44px, nothing clipped, no horizontal scroll`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(90_000);
      const fx = await seedPendingEnding(request, sport, `Scorer ${variant.name}`);
      if (variant.between) {
        await withDb(async (sql) => {
          const [t] = await sql<{ tip: number }[]>`select coalesce(max(seq), 0)::int as tip from score_events where fixture_id = ${fx.fixtureId}`;
          await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
                    values (${randomUUID()}, ${fx.fixtureId}, ${t!.tip + 1}, 'core.suspend', ${sql.json({ reason: "rain" })}, now())`;
        });
      }
      const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
        label: `mobile ending ${variant.name} ${projectTag()}`,
      });
      expect(link.status, JSON.stringify(link.error)).toBe(201);

      // The token is the ONLY credential on this surface: no session, the project's own viewport.
      const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined, storageState: await consentedAnonymousState() });
      try {
        const page = await ctx.newPage();
        await page.goto(`/score/${link.data!.secret}`, { waitUntil: "load" });
        await dismissCookieBanner(page);
        // The handed device has no console wrapper: the pad is addressed by its own `data-role`, not the console's `score-pad`.
        const pad = page.locator('[data-role="pad-v3"]');
        await expect(pad).toBeVisible({ timeout: 20_000 });
        const prompt = pad.getByTestId("pad-ending-pending");
        await expect(prompt, "a handed device opens on the ending prompt for a pending ledger").toBeVisible({ timeout: 20_000 });
        await expect(prompt, `the ${variant.name} copy is what is on the card`).toContainText(uiEn[variant.bodyKey]!);

        // What this scorer is offered, and only that: never the void (not the device's own row), the record only where admitted.
        await expect(prompt.getByTestId("pad-ending-void"), "a handed device is not offered a void of a row it did not write").toHaveCount(0);
        if (variant.record) await assertTapFloor(prompt.getByTestId("pad-ending-record"), "Record the ending");
        else await expect(prompt.getByTestId("pad-ending-record"), "where the server would answer 403, the card offers no button").toHaveCount(0);
        await expect(pad.locator('[data-role="v3-tiles"]')).toHaveCount(0);

        await expectNoHorizontalScroll(page);
        const { clipped } = await overflowingIn(page, '[data-role="v3-ending"]', "*", "the ending prompt was not in the DOM");
        expect(clipped, "the ending prompt must not clip its own content at this width").toEqual([]);
        // The whole card is reachable: its bottom edge is inside the document, so scrolling brings all of it on screen.
        const box = await prompt.boundingBox();
        expect(box, "the prompt has no box").not.toBeNull();
        expect(box!.width, "the card fits the viewport width").toBeLessThanOrEqual((projectViewport()?.width ?? 1280) + 0.5);
      } finally {
        await ctx.close();
      }
    });
  }
}

// VOID ONLY (W2e T33b, N2) - the one card layout the seeded cases above cannot reach, driven through the pad itself.
//
// The pad sends an ending sanction as TWO appends: the sanction (held for `HOLD_MS`), then its ending behind it. The device
// owns the sanction it sent in this mount, so the prompt may offer it a void. What makes the card "void only" is a row recorded
// after the sanction, which the server's D13 rule reads as "the sanction is no longer the last live event, so a scorer may not
// record its ending". The only writer of such a row is raw SQL (the write path refuses everything after an ending sanction), so
// the test holds the ENDING at the wire (a route handler that waits), writes a `core.suspend` behind the sanction (the same row
// the `neither` case writes), and lets the ending go. The server then answers it for real: the request is stale (SEQ_CONFLICT,
// the pad resyncs and merges the suspend) and, asked again against the new tip, it is a 403 - a permanent refusal, so the
// ending is dropped and the sanction stays. Nothing in the answer is faked; only WHEN the ending is sent is controlled.
//
// What it proves at this width: the card shows the voidOnly copy and exactly one button (the void, hit-testable at 44px), the
// record button is absent, nothing in the card is clipped, the page does not scroll sideways, the card fits the viewport, and
// below `md` the lone button spans its row (the row's content box, read live) rather than shrinking to its label.
for (const sport of ENDING_SPORTS) {
  test(`${sport.key} v3 pad (handed device, voidOnly): the device's own sanction with a row behind it - the prompt's longest copy and its one button fit, reachable at 44px, nothing clipped, no horizontal scroll`, async ({
    browser,
    request,
  }) => {
    // Derived from the hold, never typed (AGENTS.md failure class 20): the sanction waits out HOLD_MS before anything is sent,
    // and the merge may wait for the pad's 15s poll if the conflict resync does not get there first.
    test.setTimeout(Math.max(150_000, 90_000 + 6 * HOLD_MS));
    const fx = await seedRosteredFixture(request, {
      label: `Mobile Ending Scorer voidOnly ${sport.key} ${TAG}-${projectTag()}`,
      sportKey: sport.key,
      variantKey: ENDING_SEEDS[sport.key]!.variantKey,
      entrantKind: "individual",
      home: [{ fullName: `Mobile End VO ${sport.key} Home ${TAG}-${projectTag()}` }],
      away: [{ fullName: `Mobile End VO ${sport.key} Away ${TAG}-${projectTag()}` }],
      // No fixture lineup for tennis: nobody to ask "which player" in the sanction sheet, as scorepad-v3-ending-sanction.spec.ts
      // seeds it. Badminton singles has one on-field player, so its sheet is level -> confirm as well.
      skipLineups: sport.key === "tennis",
      emitCoreStart: true,
    });
    const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
      label: `mobile ending voidOnly ${projectTag()}`,
    });
    expect(link.status, JSON.stringify(link.error)).toBe(201);
    const voidOnlyCopy = uiEn["pad.ending.body.voidOnly"];
    expect(voidOnlyCopy, "the dictionary carries the voidOnly copy (an empty string would match any card)").toBeTruthy();
    const levelLabel = uiEn[`sanction.${sport.level}`];
    expect(levelLabel, `the dictionary names the ${sport.level} level`).toBeTruthy();

    let releaseEnding!: () => void;
    const endingMayGo = new Promise<void>((resolve) => {
      releaseEnding = resolve;
    });
    let endingsOnTheWire = 0;

    const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined, storageState: await consentedAnonymousState() });
    try {
      const page = await ctx.newPage();
      // Hold the ENDING (a core.forfeit POST) at the wire until the test says go. Every other request, including the
      // sanction's own POST and every ledger read, passes straight through to the real server.
      await page.route(`**/api/v1/fixtures/${fx.fixtureId}/events`, async (route) => {
        const req = route.request();
        const body = req.method() === "POST" ? (req.postDataJSON() as { type?: string } | null) : null;
        if (body?.type !== "core.forfeit") return route.continue();
        endingsOnTheWire++;
        await endingMayGo;
        return route.continue();
      });

      await page.goto(`/score/${link.data!.secret}`, { waitUntil: "load" });
      await dismissCookieBanner(page);
      const pad = page.locator('[data-role="pad-v3"]');
      await expect(pad).toBeVisible({ timeout: 20_000 });

      // The device records the end-level sanction through the pad: tile -> level -> read-back -> Confirm.
      const tile = pad.locator('[data-tile-id="sanction-home"]');
      await expect(tile, "the sanction tile is on a live pad").toBeVisible({ timeout: 20_000 });
      await tile.click();
      const sheet = pad.locator('[data-role="v3-sheet"]');
      await expect(sheet, "the sanction sheet opens").toBeVisible({ timeout: 20_000 });
      await sheet.getByRole("button", { name: levelLabel!, exact: true }).click();
      await expect(sheet.getByTestId("pad-sheet-summary"), `${sport.level} asks 'This ends the match' before anything is sent`).toBeVisible();
      await sheet.getByTestId("pad-sheet-confirm").click();

      // The sanction drains first (after its hold), the ending right behind it - and waits at the wire.
      await expect
        .poll(() => endingsOnTheWire, { timeout: HOLD_MS + 30_000, message: "the pad sent the ending behind the sanction" })
        .toBeGreaterThan(0);
      const sent = await apiJson<{ seq: number; type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
      expect(
        (sent.data ?? []).map((e) => e.type),
        "premise: the sanction is on the ledger and the ending is not (it is held at the wire)",
      ).toEqual(["core.start", sport.eventType]);

      // A row behind the sanction: the one way such a ledger exists (an earlier build left them), as in the `neither` case.
      await withDb(async (sql) => {
        const [t] = await sql<{ tip: number }[]>`select coalesce(max(seq), 0)::int as tip from score_events where fixture_id = ${fx.fixtureId}`;
        await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
                  values (${randomUUID()}, ${fx.fixtureId}, ${t!.tip + 1}, 'core.suspend', ${sql.json({ reason: "rain" })}, now())`;
      });
      releaseEnding();

      // The server refuses the ending and the pad lands on the voidOnly card: the copy is the proof the device owns the
      // sanction (a pad that did not would say `neither`) and that it may no longer record the ending.
      const prompt = pad.getByTestId("pad-ending-pending");
      await expect(prompt, "the card says only the void is left").toContainText(voidOnlyCopy!, { timeout: 60_000 });
      const after = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
      expect((after.data ?? []).map((e) => e.type), "the refused ending wrote nothing").toEqual(["core.start", sport.eventType, "core.suspend"]);

      await expect(prompt.getByTestId("pad-ending-record"), "where the server answers 403, the card offers no record button").toHaveCount(0);
      const voidButton = prompt.getByTestId("pad-ending-void");
      await expect(voidButton, "the device's own sanction can be voided").toHaveCount(1);
      await assertTapFloor(voidButton, "Void the sanction");
      await expect(pad.locator('[data-role="v3-tiles"]')).toHaveCount(0);

      await expectNoHorizontalScroll(page);
      const { clipped } = await overflowingIn(page, '[data-role="v3-ending"]', "*", "the ending prompt was not in the DOM");
      expect(clipped, "the ending prompt must not clip its own content at this width").toEqual([]);

      const width = projectViewport()?.width ?? 1280;
      const [cardBox, buttonBox] = [await prompt.boundingBox(), await voidButton.boundingBox()];
      expect(cardBox, "the prompt has no box").not.toBeNull();
      expect(buttonBox, "the void button has no box").not.toBeNull();
      expect(cardBox!.width, "the card fits the viewport width").toBeLessThanOrEqual(width + 0.5);
      expect(buttonBox!.width, "the button stays inside the card").toBeLessThanOrEqual(cardBox!.width + 0.5);
      // Below `md` (768) the buttons stack full width (`flex-col`, so they stretch): the lone button spans its row's CONTENT box.
      // That box is read live (the row's clientWidth less its computed horizontal padding), never typed as a gutter: the card has
      // its own 1px border and the row its own `px-4`, so a literal "card minus 32" is off by the border and moves with any class.
      const row = await voidButton.evaluate((el) => {
        const parent = el.parentElement!;
        const cs = getComputedStyle(parent);
        return { button: el.getBoundingClientRect().width, content: parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      });
      expect(row.content, "the button row has a content box").toBeGreaterThan(0);
      expect(row.button, "the button stays inside its row").toBeLessThanOrEqual(row.content + 0.5);
      if (width < 768) {
        expect(row.button, "below md the lone button spans its row's content box").toBeGreaterThanOrEqual(row.content - 0.5);
      }
    } finally {
      releaseEnding();
      await ctx.close();
    }
  });
}

test("table tennis v3 pad: the serve-anchor tile and its sheet hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const fx = await seedRosteredFixture(request, {
    label: `Mobile TT V3 ${TAG}-${projectTag()}`,
    sportKey: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    // `projectTag()` for the same reason the badminton test above states: the
    // two projects that share a CI process are exactly the two that failed
    // without it (mobile-14 and mobile-430).
    home: [{ fullName: `Mobile TT Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile TT Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await assertRacquetPadFloor(page);
  await assertTouchFloor(padTile(page, "setScore"), "Set-score tile");

  // D-17's serve anchor: table tennis's `within: "fixed-turns"` NEVER
  // self-heals, so the tile is on screen from the first paint of a fresh
  // fixture and its two-step sheet is a brand-new surface at every width.
  await assertTapFloor(padTile(page, "serveAnchor"), "serve-anchor tile");
  await padTile(page, "serveAnchor").click();
  const sheet = page.getByTestId("score-pad").locator('[data-role="v3-sheet"]');
  await expect(sheet, "the anchor sheet must open").toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(sheet.locator('[data-choice-option-id="home"]'), "anchor sheet: home option");
  await assertTouchFloor(sheet.locator('[data-choice-option-id="away"]'), "anchor sheet: away option");
  await expectNoHorizontalScroll(page);
});

test("volleyball v3 pad: the anchor sheet and the libero Swap-sheet hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // A full indoor starting six, S/OH/MB/OPP/OH/MB — FIVB's own catalog shape.
  // Six a side is what makes volleyball the widest of the three scorebugs, so
  // it is the one most likely to overflow a 320px viewport.
  const court = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
  // Six on court plus a BENCH libero. The seventh is not decoration: a libero
  // exchange brings someone ON, so the player it names has to be off the
  // court to start with — seeding all seven as starters made the exchange
  // below 422 with the engine's own words, "P6 … is already on the field".
  const roster = (label: string) => [
    ...court.map((positionKey, i) => ({ fullName: `${label} P${i + 1} ${TAG}`, positionKey })),
    // `roles: ["libero"]` is the tile's own gate, not decoration: the skin
    // shows the Swap tile only for a side whose squad NAMES a libero
    // (`sideHasLibero` → `hasLiberoRole`), and a bare position_key of "L"
    // does not set that role.
    { fullName: `${label} P7 ${TAG}`, positionKey: "L", slot: "bench" as const, roles: ["libero"] as const },
  ];
  const fx = await seedRosteredFixture(request, {
    label: `Mobile VB V3 ${TAG}-${projectTag()}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    home: roster(`Mobile VB Home ${TAG}-${projectTag()}`),
    away: roster(`Mobile VB Away ${TAG}-${projectTag()}`),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await assertRacquetPadFloor(page);

  await assertTapFloor(padTile(page, "serveAnchor"), "serve-anchor tile");
  await padTile(page, "serveAnchor").click();
  const sheet = page.getByTestId("score-pad").locator('[data-role="v3-sheet"]');
  await expect(sheet, "the anchor sheet must open").toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(sheet.locator('[data-choice-option-id="away"]'), "anchor sheet: away option");
  await expectNoHorizontalScroll(page);
  await sheet.locator('[data-choice-option-id="away"]').click();
  await page.waitForTimeout(400);
  await sheet.locator('[data-choice-option-id="home"]').click();
  await expect(sheet, "the anchor sheet closes once both steps are answered").toHaveCount(0, {
    timeout: 20_000,
  });
  await expectNoHorizontalScroll(page);

  // The libero Swap-sheet (`[data-role="v3-swap"]`) is the one surface
  // NEITHER sibling has at all, and its candidate rows are the densest thing
  // any of these three pads renders — twelve names in one scrolling list, at
  // 320px. The tile only appears once a side has ACTUALLY used a libero, so
  // the first exchange is established directly; the SHEET is what this test
  // is measuring, not the act of bringing the libero on.
  const middleBlocker = `Mobile VB Home ${TAG}-${projectTag()} P3 ${TAG}`;
  const libero = `Mobile VB Home ${TAG}-${projectTag()} P7 ${TAG}`;
  const state = await apiJson<{ last_seq: number }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status, "state read before the libero exchange").toBe(200);
  const posted = await apiJson(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/events`,
    "POST",
    {
      expected_seq: state.data!.last_seq,
      type: "core.lineup.replacement",
      payload: {
        side: fx.homeEntrantId,
        off: fx.personIds[middleBlocker]!,
        on: {
          personId: fx.personIds[libero]!,
          positionKey: "MB",
          slot: "starting",
          orderNo: 7,
          roles: ["libero"],
        },
        exemption: "libero",
      },
    },
  );
  expect(posted.status, `libero exchange POST: ${JSON.stringify(posted.error)}`).toBeLessThan(300);

  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId("score-pad")).toBeVisible({ timeout: 20_000 });
  await assertTapFloor(padTile(page, "libero-home"), "libero tile");
  await padTile(page, "libero-home").click();
  const swap = page.getByTestId("score-pad").locator('[data-role="v3-swap"]');
  await expect(swap, "the libero Swap-sheet must open").toBeVisible({ timeout: 20_000 });
  await assertTouchFloor(
    swap.locator(`[data-candidate-id="${fx.personIds[libero]!}"]`),
    "swap sheet: the libero's own candidate row",
  );
  await expectNoHorizontalScroll(page);

  // Step 2 of the sheet — the half NO earlier gate reached. Answering "who
  // comes off" replaces that step with a chip naming the player chosen, and
  // the chip is the ONLY place a referee re-reads who is leaving the court
  // before committing the exchange. Its content is a PERSON NAME, so it is
  // the one control on this sheet whose width is unbounded by the dictionary
  // — which is exactly why it is the one that spilled its card and got
  // clipped. Assert it against its container, not the page: see
  // `assertNoContainerSpill`.
  await swap.locator("[data-candidate-id]").first().click();
  // Strict-unique on purpose: the chip carries the ONLY `aria-label` in
  // swap-sheet.tsx, so a second labelled button appearing here should fail
  // this locator loudly rather than be silently skipped by a `.first()`.
  const offChip = swap.locator("button[aria-label]");
  await assertNoContainerSpill(offChip, "swap sheet: the who-came-off chip");
  await assertTapFloor(offChip, "swap sheet: the who-came-off chip");
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// R8/WS-I — THE FOUR v3 PADS THAT HAD NO WIDTH COVERAGE AT ALL.
//
// `V3_SKINS` owns eleven engine sports (R7/A3 closed the conversion). Before
// this block, `git grep -a` for each of them across this file returned SEVEN:
// cricket, football, generic, tennis, badminton, tabletennis, volleyball. The
// other four — HOCKEY, ICE HOCKEY, CARROM and BOARDGAME — appeared nowhere,
// and this file's seven width projects are the only place in the suite any
// surface is driven at 320/360/375/390/430/768/834 at all. Four shipped pads
// therefore had ZERO responsive enforcement (reference_new_ui_surface_
// uncovered_until_in_mobile_spec): the R8 a11y sweep covers all eleven but
// runs in the `parallel` project at a 1280 desktop viewport that it resizes
// itself, which is a different measurement from a real 320x568 phone whose
// FOLD and page height differ too.
//
// WHAT THIS BLOCK ASSERTS, AND WHAT IT DOES NOT.
// `expectNoHorizontalScroll` catches PAGE OVERFLOW. It is not, and cannot be,
// a claim that a layout looks right — a spill that gets CLIPPED never grows
// `documentElement.scrollWidth` (see `assertNoContainerSpill` above, which
// exists precisely because the page gate could not see a 77px spill). Layout
// correctness at these widths is the gallery's and the walkthroughs' job. What
// is proved here is narrower and worth having on its own: the pad RENDERS at
// this width, every operable control inside it clears the 44px floor on both
// axes, and the page does not scroll sideways.
//
// THE FLOOR IS ASSERTED OVER EVERY OPERABLE TARGET, never the smallest one.
// `hitTargetFloorReport` (scorepad-a11y-kit.ts) is reused rather than
// re-measured here, and its own doc records why: MIN-AREA IS NOT MIN-DIMENSION,
// so a 200x30 control has a LARGER area than the 92.11x44 binding target and
// would never be selected as "smallest". Sharing the kit also means this gate
// and the a11y sweep compute one pixel one way — two hand-written copies of a
// geometry measurement is how two gates drift into disagreeing.
//
// One test per sport, matching the T16/T17 blocks above: a 320px failure that
// reads "carrom pad" is a different alarm from one that reads "the R7 pads".
// ---------------------------------------------------------------------------

/**
 * A seed spec built from `V3_SKIN_CASES` — the catalog `a11y-sweep-totality
 * .test.ts` already pins against `V3_SKINS` itself — rather than a second
 * hand-rolled table of sport keys, variants and rosters. A twelfth sport, or a
 * variant rename, then moves this block with the registry instead of leaving
 * it seeding yesterday's fixture.
 *
 * The catalog deliberately carries no NAMES, and they have to be minted here
 * per width project: `TAG` is per PROCESS and `e2e.yml`'s `phones-large` leg
 * runs two width projects in ONE process, while `seedRosteredFixture`
 * get-or-creates a person BY NAME — so two widths sharing a name roster the
 * same person row. Same reasoning the badminton test above spells out in full.
 */
function v3SkinSeed(
  sportKey: string,
  short: string,
): {
  label: string;
  sportKey: string;
  variantKey: string;
  entrantKind: "individual" | "team" | "pair";
  home: { fullName: string; positionKey?: string }[];
  away: { fullName: string; positionKey?: string }[];
} {
  const skin = V3_SKIN_CASES.find((c) => c.key === sportKey);
  if (skin === undefined) {
    throw new Error(
      `v3SkinSeed: "${sportKey}" is not in V3_SKIN_CASES — the catalog is the ` +
        `source of truth for which skins exist and what each one's fold needs`,
    );
  }
  const roster = (sideCode: string, slots: readonly V3SkinRosterSlot[]) =>
    slots.map((slot, i) => ({
      fullName: `Mobile ${short} ${sideCode}${i + 1} ${TAG}-${projectTag()}`,
      ...(slot.positionKey === undefined ? {} : { positionKey: slot.positionKey }),
    }));
  return {
    label: `Mobile ${short} V3 ${TAG}-${projectTag()}`,
    sportKey: skin.key,
    variantKey: skin.variantKey,
    entrantKind: skin.entrantKind,
    home: roster("H", skin.home),
    away: roster("A", skin.away),
  };
}

/**
 * The gate every one of these four pads owes at every one of the seven widths.
 *
 * `minOperable` is a VACUITY GUARD, not a census. `report.under` is `[]` both
 * for a pad whose every control clears the floor and for a pad that rendered
 * no controls at all — a sheet that silently failed to open, a fixture that
 * came back decided (`reference_decided_fixture_hides_pad_both_routes`) — and
 * those two states are indistinguishable in the passing output. Each caller
 * additionally names the specific tiles that must be on screen, which is where
 * the per-skin specificity actually lives; the per-skin OPERABLE CENSUS is the
 * a11y sweep's job, not this file's.
 */
async function assertV3PadHoldsAtThisWidth(
  page: Page,
  label: string,
  minOperable: number,
): Promise<void> {
  const pad = page.getByTestId("score-pad");
  await expect(pad, `${label}: the v3 pad did not render`).toBeVisible({ timeout: 20_000 });
  const report = hitTargetFloorReport(await measureHitTargets(pad));
  expect(
    report.operable.length,
    `${label}: only ${report.operable.length} operable controls inside the pad ` +
      `(expected at least ${minOperable}) — an empty measurement makes the floor ` +
      `assertion below vacuous, so this is a failure, not a clean`,
  ).toBeGreaterThanOrEqual(minOperable);
  expect(
    floorViolationLines(report),
    `${label}: ${report.under.length} of ${report.operable.length} operable targets are ` +
      `under ${HIT_TARGET_FLOOR_PX}px at ${projectTag()} (smallest by area, for reference: ` +
      `"${report.smallest?.name ?? "-"}" ${report.smallest?.width ?? 0}x${report.smallest?.height ?? 0})`,
  ).toEqual([]);
  await expectNoHorizontalScroll(page);
}

/** The guided sheet the chassis renders for a tile whose action is a sheet. */
function v3Sheet(page: Page): Locator {
  return page.getByTestId("score-pad").locator('[data-role="v3-sheet"]');
}

// HOCKEY + ICE HOCKEY share one skin builder (`v3/skins/period-shared.ts`) and
// one engine kernel under two presets, so they are driven by one parametrised
// test rather than two hand-copied ones — but they get a test EACH (the loop
// mints two `test()` calls), so a failure names the sport a scorer would be
// holding. Football also declares `SkinDefV3.clock()` (pad-host inventory) but
// is not in this width loop. The clock's start/pause toggle is the SMALLEST
// operable target either period pad has — 58.17 x 44 at rest, i.e. exactly on
// the floor with zero headroom (reference_v3_pad_44px_floor_has_zero_headroom).
// It is therefore the one control here most likely to go red on a restyle,
// and the one no other project measures at 320px.
// WS-M fix round 1, item 3: the pair comes from `v3-width-matrix-coverage.ts`,
// not a literal here — that module is what `width-matrix-totality.test.ts` pins
// against the skin registry, and reading it back is what stops the declaration
// there from drifting away from this loop.
for (const [sportKey, short] of WIDTH_MATRIX_CLOCK_SPORTS) {
  test(`${sportKey} v3 pad: the clock bar, goal tiles and the suspension sheet's class ladder hold the 44px floor, no horizontal scroll`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const fx = await seedRosteredFixture(request, {
      ...v3SkinSeed(sportKey, short),
      emitCoreStart: true,
    });

    // The class ladder's expected size is read off the DIVISION'S OWN CONFIG,
    // never a ladder typed into this test: hockey declares three cards
    // (green/yellow/red) and ice hockey seven, and the `youth` variants change
    // the durations — deriving it means a preset change moves this assertion
    // with it instead of leaving it pinned to yesterday's ladder (AGENTS.md,
    // recurring failure class 19).
    const div = await apiJson<{ config: { suspensions?: { classes?: Record<string, unknown> } } }>(
      request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    const classKeys = Object.keys(div.data?.config.suspensions?.classes ?? {});
    expect(
      classKeys.length,
      `${sportKey}'s division config declares no suspension classes, so the option ` +
        `count asserted below would be pinned to nothing`,
    ).toBeGreaterThan(0);

    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    await dismissCookieBanner(page);
    await assertV3PadHoldsAtThisWidth(page, `${sportKey} pad at rest`, 4);

    // THE CLOCK BAR — the surface only these two skins have at all.
    const clock = page.getByTestId("score-pad").locator('[data-role="v3-clock"]');
    await expect(clock, `${sportKey} declares clock(), so the clock bar must render`).toBeVisible({
      timeout: 20_000,
    });
    await assertTouchFloor(
      clock.locator('[data-role="v3-clock-toggle"]'),
      `${sportKey}: the clock start/pause toggle`,
    );
    await assertTouchFloor(
      clock.locator('[data-role="v3-clock-value"]'),
      `${sportKey}: the clock correction control`,
    );

    // The two primaries. `goal-<side>` is band 0 and phase "live", so both are
    // unconditionally on a fresh started fixture — a missing one is a real
    // failure here, never a legitimately absent tile.
    await assertTouchFloor(padTile(page, "goal-home"), `${sportKey}: home goal tile`);
    await assertTouchFloor(padTile(page, "goal-away"), `${sportKey}: away goal tile`);

    // THE SUSPENSION SHEET — the densest surface either pad opens, and the one
    // whose height scales with a preset this file does not control. Opening a
    // sheet commits nothing (`action: {sheet}`), so this drives a real surface
    // without posting an event or racing the pad's soft-commit hold.
    await padTile(page, "suspension-home").click();
    await expect(v3Sheet(page), `${sportKey}: the suspension sheet must open`).toBeVisible({
      timeout: 20_000,
    });
    const classOptions = v3Sheet(page).locator("[data-choice-option-id]");
    await expect(
      classOptions,
      `the class step must offer exactly the classes the division declares (${classKeys.join(", ")})`,
    ).toHaveCount(classKeys.length, { timeout: 20_000 });
    await assertV3PadHoldsAtThisWidth(page, `${sportKey} suspension sheet, class step`, 4);
  });
}

// ---------------------------------------------------------------------------
// W2e Task 32 (B2-3, M12b) -- THE "INJURED, NO SUB" CONTROL, AT EVERY WIDTH.
//
// Football, volleyball, hockey and ice hockey each gained a per-side tile (`retire-<side>`, `retirement-slot.ts`) that opens
// the swap sheet's OFF picker and stops there. `scorepad-v3-retirement.spec.ts` drives the control end to end at one
// width; THIS block is the width gate: the tile clears the 44px floor the way a finger meets it (`assertTapFloor`
// hit-tests both edges), the picker's rows clear it, and the page does not scroll sideways, at all seven phone widths.
//
// THE FOLDS (AGENTS.md failure class 22). The tile lives on the board, not behind a disclosure -- but the console around it
// folds the lineup and (on a phone) the device hand-over / Stream, so the claim "the control does not need a fold opened to
// be reached" is itself worth proving, and "opening the folds does not push it off the board or break the floor" with it.
// So: assert the tile with every fold as the console left it, then open EVERY fold instance (`openEveryPhoneFold` waits on
// `toBeAttached`, never `toBeVisible` -- visibility is what a fold denies -- and gates each open on that toggle being
// visible, never on a width literal) and assert it again. The picker is opened and NOT answered: answering commits an event
// and starts the soft-commit hold, which a width gate has no reason to pay for.
//
// One test per sport, each with its own roster of STARTERS: the control is offered only to a side with someone on the field,
// and a lineup-less or all-bench side legitimately has no tile. The rosters are positioned with each sport's own
// position keys (`packages/engine/src/sports/*`), the names carry `projectTag()` (two width projects share one CI process).
// ---------------------------------------------------------------------------

/** Open every phone-disclosure instance whose toggle is visible at this width; returns how many instances exist. */
async function openEveryPhoneFold(page: Page): Promise<number> {
  const toggles = page.locator('[data-role="phone-disclosure-toggle"]');
  // Attached, not visible: a fold's toggle may be `md:hidden` here, and a hidden control cannot be clicked.
  await expect(toggles.first(), "the console renders its folds (the lineup disclosure at least)").toBeAttached({ timeout: 20_000 });
  const n = await toggles.count();
  for (let i = 0; i < n; i++) {
    const toggle = toggles.nth(i);
    if (!(await toggle.isVisible())) continue;
    if ((await toggle.getAttribute("aria-expanded")) === "true") continue;
    await toggle.click();
    await expect(toggle, `fold ${i + 1} of ${n} opens`).toHaveAttribute("aria-expanded", "true");
  }
  return n;
}

const VB_COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;
const RETIREMENT_SPORTS: readonly {
  readonly sportKey: string;
  readonly variantKey: string;
  readonly short: string;
  readonly home: readonly string[];
  readonly away: readonly string[];
}[] = [
  { sportKey: "football", variantKey: "11-a-side", short: "RFB", home: ["FW", "GK", "DF"], away: ["GK"] },
  { sportKey: "volleyball", variantKey: "indoor", short: "RVB", home: [...VB_COURT], away: [...VB_COURT] },
  { sportKey: "hockey", variantKey: "fih-outdoor", short: "RHK", home: ["GK", "DF", "FW"], away: ["GK"] },
  { sportKey: "icehockey", variantKey: "iihf", short: "RIH", home: ["G", "D", "F"], away: ["G"] },
];

for (const sport of RETIREMENT_SPORTS) {
  test(`${sport.sportKey} v3 pad: the Injured (no sub) tile and its picker hold the 44px floor with the folds closed and open, no horizontal scroll`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const roster = (side: string, positions: readonly string[]) =>
      positions.map((positionKey, i) => ({ fullName: `Mobile ${sport.short} ${side}${i + 1} ${TAG}-${projectTag()}`, positionKey }));
    const home = roster("H", sport.home);
    const fx = await seedRosteredFixture(request, {
      label: `Mobile ${sport.short} Retire ${TAG}-${projectTag()}`,
      sportKey: sport.sportKey,
      variantKey: sport.variantKey,
      entrantKind: "team",
      home,
      away: roster("A", sport.away),
      emitCoreStart: true,
    });

    await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
    await dismissCookieBanner(page);
    await assertV3PadHoldsAtThisWidth(page, `${sport.sportKey} pad at rest`, 4);

    // 1. Folds as the console left them: the tile is on the board and tappable.
    await assertTapFloor(padTile(page, "retire-home"), `${sport.sportKey}: home Injured tile, folds as left`);
    await assertTapFloor(padTile(page, "retire-away"), `${sport.sportKey}: away Injured tile, folds as left`);

    // 2. Every fold opened (EVERY instance): still on the board, still over the floor, page still not scrolling sideways.
    const folds = await openEveryPhoneFold(page);
    expect(folds, "at least one fold instance existed to open (a console with none would make this step vacuous)").toBeGreaterThan(0);
    await assertTapFloor(padTile(page, "retire-home"), `${sport.sportKey}: home Injured tile, every fold open`);
    await expectNoHorizontalScroll(page);

    // 3. The picker: one row per starter, each over the floor, none for the bench / away side, and the sheet stays inside the page.
    await padTile(page, "retire-home").click();
    const swap = page.getByTestId("score-pad").locator('[data-role="v3-swap"][data-swap-slot-id="retire-home"]');
    await expect(swap, `${sport.sportKey}: the retirement picker must open`).toBeVisible({ timeout: 20_000 });
    await expect(swap.locator("[data-candidate-id]"), "one row per starter on the field").toHaveCount(home.length, { timeout: 20_000 });
    for (const p of home) {
      // Hit-tested at both edges, not box-measured (review M2): a row is a tap target, and a painted 44 that a finger cannot
      // land on is exactly what `assertTapFloor` exists to catch.
      await assertTapFloor(swap.locator(`[data-candidate-id="${fx.personIds[p.fullName]!}"]`), `${sport.sportKey}: picker row ${p.positionKey}`);
    }
    await expectNoHorizontalScroll(page);
  });
}

// W2e Task 31 (D12, VB-SE-1) -- THE FIELD-SIX QUESTION, AT EVERY WIDTH (review M3).
//
// An expulsion or a disqualification asks "Can <team> still field six players?" BEFORE anything is written
// (`scorepad-v3-ending-sanction.spec.ts` drives both answers end to end at one width). This is its width gate: the question is
// on screen, both answers clear the 44px floor the way a finger meets them (`assertTapFloor`), nothing in the sheet is
// clipped, and the page does not scroll sideways. The sanction tile is on the board, not in a fold, but the console around it
// folds (AGENTS.md failure class 22), so EVERY fold instance is opened first (`openEveryPhoneFold`: attached, never visible;
// gated on the toggle being visible, never on a width). Not answered: an answer commits and starts the hold.
// The level is the engine's own first prompt level (`sanctionEnding.promptLevels`), its label the pad's word for it.
const FIELD_SIX_LEVEL = builtinModules.find((m) => m.key === "volleyball")!.sanctionEnding!.promptLevels[0]!;

test("volleyball v3 pad: the field-six question and both answers hold the 44px floor with every fold open, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const roster = (side: string) =>
    VB_COURT.map((positionKey, i) => ({ fullName: `Mobile F6 ${side}${i + 1} ${TAG}-${projectTag()}`, positionKey }));
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Field-six ${TAG}-${projectTag()}`,
    sportKey: "volleyball",
    variantKey: "indoor",
    entrantKind: "team",
    home: roster("H"),
    away: roster("A"),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await assertV3PadHoldsAtThisWidth(page, "volleyball pad at rest", 4);
  const folds = await openEveryPhoneFold(page);
  expect(folds, "at least one fold instance existed to open (a console with none would make this step vacuous)").toBeGreaterThan(0);

  await assertTapFloor(padTile(page, "sanction-home"), "volleyball: home sanction tile, every fold open");
  await padTile(page, "sanction-home").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the sanction sheet must open").toBeVisible({ timeout: 20_000 });
  const levelLabel = uiEn[`sanction.${FIELD_SIX_LEVEL}`];
  expect(levelLabel, `the dictionary names the ${FIELD_SIX_LEVEL} level`).toBeTruthy();
  await sheet.getByRole("button", { name: levelLabel!, exact: true }).click();
  // WHO: the first on-field player (a team sheet is declared, so the person step is asked before the question).
  await sheet.locator("[data-candidate-id]").first().click();

  await expect(sheet, "the question is asked").toContainText(/still field six players\?/i);
  await assertTapFloor(sheet.locator('[data-choice-option-id="yes"]'), "field-six: Yes");
  await assertTapFloor(sheet.locator('[data-choice-option-id="no"]'), "field-six: No");
  const o = await overflowingIn(page, '[data-role="v3-sheet"]', "*", "the field-six sheet is missing");
  expect(o.clipped, `nothing in the field-six sheet is clipped at ${page.viewportSize()!.width}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  // Asking wrote nothing.
  const rows = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
  expect((rows.data ?? []).map((e) => e.type), "the question is asked before anything is written").toEqual(["core.start"]);
});

test("carrom v3 pad: the two board tiles and the board sheet's winner/coins steps hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, {
    ...v3SkinSeed("carrom", "CR"),
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await assertV3PadHoldsAtThisWidth(page, "carrom pad at rest", 4);

  // Carrom's tap model is T: the halves are NOT buttons (unlike the R5 racquet
  // pads above), so the board tiles ARE the whole scoring surface. Both are
  // band 0 and live-phase, i.e. unconditional on a started fixture.
  await assertTapFloor(padTile(page, "board"), "carrom: Board tile");
  await assertTapFloor(padTile(page, "boardQueen"), "carrom: Board (queen) tile");

  // The board sheet, both of its steps. Step 1 is a two-option side choice;
  // answering it advances to the COINS step, which is a `number` — a stepper,
  // a different control shape from anything the choice steps render, and the
  // narrowest column in the pad at 320px. Stopping at that step deliberately:
  // answering it would commit `carrom.board.summary` and start the soft-commit
  // hold, which this width gate has no reason to pay for.
  await padTile(page, "board").click();
  await expect(v3Sheet(page), "the board sheet must open").toBeVisible({ timeout: 20_000 });
  await expect(
    v3Sheet(page).locator("[data-choice-option-id]"),
    "the winner step must offer both sides",
  ).toHaveCount(2, { timeout: 20_000 });
  await assertV3PadHoldsAtThisWidth(page, "carrom board sheet, winner step", 4);

  await v3Sheet(page).locator('[data-choice-option-id="home"]').click();
  await expect(
    v3Sheet(page).locator("[data-choice-option-id]"),
    "answering the winner step must advance off it, onto the coins stepper",
  ).toHaveCount(0, { timeout: 20_000 });
  await assertV3PadHoldsAtThisWidth(page, "carrom board sheet, coins number step", 4);
});

test("boardgame v3 pad: the pairing card (pre) and the halves + Draw tile (live) hold the 44px floor, no horizontal scroll", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // Seeded WITHOUT `emitCoreStart`, unlike every other pad test in this file,
  // and for a reason specific to this skin: boardgame's tiles are split across
  // the two phases — `pairing` is "pre" only and `draw` is "live" only — so a
  // started fixture can never show the pairing card at all. Both phases are
  // driven here off ONE fixture, the pre half first.
  const fx = await seedRosteredFixture(request, v3SkinSeed("boardgame", "BG"));

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  // TWO, not the 4 its siblings carry, and measured rather than guessed: a
  // boardgame pad in "pre" is the sparsest state any v3 skin reaches — the
  // fidelity control and the pairing card, and nothing else. The halves render
  // as plain `<div>`s until the match is live and the ribbon has no Take back
  // until something is recorded, while Start match / Hand over device are
  // console chrome OUTSIDE the pad. The floor is a vacuity guard, so it is set
  // at what this state actually holds; the pairing tile asserted below is
  // where this test's real specificity lives.
  await assertV3PadHoldsAtThisWidth(page, "boardgame pad, pre phase", 2);

  // The pairing card's first step is a `number` (the board number), the same
  // stepper shape carrom's coins step uses and the only one this pad has.
  await assertTapFloor(padTile(page, "pairing"), "boardgame: pairing-card tile");
  await padTile(page, "pairing").click();
  await expect(v3Sheet(page), "the pairing card must open").toBeVisible({ timeout: 20_000 });
  await assertV3PadHoldsAtThisWidth(page, "boardgame pairing card, board step", 2);

  // ---- LIVE. `core.start` posted directly rather than tapped: the Start
  // control is console chrome OUTSIDE the pad, and this test is about the pad.
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fx.fixtureId}/state`);
  expect(state.status, "state read before core.start").toBe(200);
  const started = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "core.start",
    payload: {},
  });
  expect(started.status, `core.start POST: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  await page.reload({ waitUntil: "load" });
  await assertV3PadHoldsAtThisWidth(page, "boardgame pad, live phase", 3);

  // Tap model S: the halves ARE the result buttons (R7-2, "tap decides, dock
  // enriches"), so `padHalf`'s `button`-scoped locator resolves here exactly as
  // it does for the R5 racquet pads — and it is scoped to `button` deliberately,
  // because a half renders a plain `<div>` at the same grid position when it is
  // not tappable. Measured, never tapped: a tap commits `boardgame.result` and
  // DECIDES the match, which unmounts the pad.
  await assertTouchFloor(padHalf(page, "home"), "boardgame: home result half");
  await assertTouchFloor(padHalf(page, "away"), "boardgame: away result half");
  await assertTapFloor(padTile(page, "draw"), "boardgame: Draw / no result tile");
  await expectNoHorizontalScroll(page);
});

// W2a Task 12 (spec §5.5, UI-2 option B; BG-KO-1, BG-KO-2 per ruling 82). A drawn chess KNOCKOUT game goes to its
// tie-break, which is the only thing the pad offers: a three-step sheet (rung → winner → optional score). Each step
// must be reachable and hold at this width.
//
// W2c Task 21 (S5, BG-KO-2): the Armageddon is no longer a winner tap. It is three screens — Who had Black?, Result?, then
// a read-back with one Confirm — and EACH must offer the SAME controls here as at 1280, membership and order, never a
// groomed shrink (AGENTS.md, the phone composition). The entrants carry 43-character names: a short name hides the
// wrap, and the read-back sentence is where a long one lands. Options are read by their chassis data hook
// (`data-choice-option-id`, preflight C24), never by a testid or a translated label; the sentence and the labels are
// read from the dictionary, never typed.
test("chess tie-break (W2a): every step of the knockout tie-break sheet is reachable and holds at this width; the Armageddon's three screens match 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2a mobile chess ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "boardgame",
    variant_key: "classical",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const longNames = [
    "Alexandria Montgomery-Featherstonehaugh III",
    "Bartholomew Wolfeschlegelstein-Hausenberger",
    "Christopherson Van der Berg-Oosterhuizen Jr",
    "Dominique Castellanos-Villaverde de la Cruz",
  ];
  const added = await addEntrantsViaApi(request, div.data!.id, longNames, "individual");
  expect(added.ids).toHaveLength(4);
  const nameOf = new Map(added.ids.map((id, i) => [id, longNames[i]!]));
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "knockout", name: "Cup" });
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  let fixtureId: string | null = null;
  let homeEntrantId = "";
  let awayEntrantId = "";
  for (const id of fixtureIds) {
    const f = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }>(request, `/api/v1/fixtures/${id}`);
    if (f.data?.home_entrant_id && f.data.away_entrant_id) { fixtureId = id; homeEntrantId = f.data.home_entrant_id; awayEntrantId = f.data.away_entrant_id; break; }
  }
  expect(fixtureId, "a first-round game with both players").not.toBeNull();
  expect(nameOf.get(awayEntrantId), "the away entrant is one of the four named players").toBeTruthy();
  expect(nameOf.get(homeEntrantId), "the home entrant is one of the four named players").toBeTruthy();
  for (const [type, payload] of [["core.start", {}], ["boardgame.result", { winner: null, method: "agreement" }]] as const) {
    const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: st.data!.last_seq, type, payload });
    expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }

  const option = (id: string) => v3Sheet(page).locator(`[data-choice-option-id="${id}"]`);
  const optionIds = () => v3Sheet(page).locator("[data-choice-option-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-choice-option-id")));
  const backButton = () => v3Sheet(page).getByRole("button", { name: "Back", exact: true });
  const projectWidth = page.viewportSize()!.width;
  /** Only for a per-screen visual verdict: an element crop of the open sheet into W2A_SHOTS_DIR (the switch bracket-finish.spec.ts
   *  uses). Unset in CI, where it does nothing. */
  const shotSheet = async (name: string) => {
    const dir = process.env.W2A_SHOTS_DIR;
    if (dir) await v3Sheet(page).screenshot({ path: `${dir}/${name}-${projectWidth}.png` });
  };
  /** Nothing in the open sheet is wider than the box that clips it (a scrollable region would be reachable; clipped content is not),
   *  and the page does not scroll sideways. The names are 43 characters: this is the check a short name cannot fail. */
  const expectSheetNotClipped = async (screen: string) => {
    const o = await overflowingIn(page, '[data-role="v3-sheet"]', "*", "the tie-break sheet is missing");
    expect(o.clipped, `${screen}: nothing in the sheet is clipped at ${projectWidth}`).toEqual([]);
    await expectNoHorizontalScroll(page);
  };
  /** W2c Task 21 design pass: the deciding steps are ROWS — each option spans the card (less its 16px gutters), a long name wraps
   *  inside it — never a pill hugging its label. */
  const expectRows = async (ids: readonly string[], screen: string) => {
    const sheet = (await v3Sheet(page).boundingBox())!;
    for (const id of ids) {
      const box = (await option(id).boundingBox())!;
      expect(box.width, `${screen} ${id}: a full-width row at ${projectWidth} (${box.width}px in a ${sheet.width}px sheet)`).toBeGreaterThanOrEqual(sheet.width - 40);
    }
  };
  /** The sheet's context lines as the scorer reads them (whitespace collapsed). */
  const contextLines = () =>
    v3Sheet(page).getByTestId("pad-sheet-context-line").evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));

  await page.goto(await fixturePath(page.request, fixtureId!), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await assertTapFloor(padTile(page, "tiebreak"), "chess: tie-break tile");
  await expect(padTile(page, "draw"), "the game is drawn: no second Draw").toHaveCount(0);
  await padTile(page, "tiebreak").click();
  await expect(v3Sheet(page), "the tie-break sheet must open").toBeVisible({ timeout: 20_000 });

  // Step 1 — the rung. Exactly the engine's three, no lots.
  expect(await optionIds()).toEqual(["rapid", "blitz", "armageddon"]);
  for (const id of ["rapid", "blitz", "armageddon"]) await assertTapFloor(option(id), `rung ${id}`);
  await expectRows(["rapid", "blitz", "armageddon"], "Rung step");
  expect(await contextLines(), "the rung pick names no round").toEqual([]);
  await expectSheetNotClipped("Rung step");
  // Step 2 — the winner (rapid), then step 3 — the optional score.
  await option("rapid").click();
  expect(await optionIds()).toEqual(["home", "away"]);
  await assertTapFloor(option("away"), "rapid winner");
  await expect(option("away")).toHaveText(nameOf.get(awayEntrantId)!);
  await expectRows(["home", "away"], "Rapid winner step");
  expect(await contextLines(), "the rapid winner step names its round").toEqual([dlDict("en")["pad.boardgame.tiebreak.rung.rapid"]!]);
  await expectSheetNotClipped("Rapid winner step");
  await shotSheet("s5-20-long-name-rapid-winner");
  await option("away").click();
  expect(await optionIds()).toEqual(["none", "2–0", "1½–½"]);
  await assertTapFloor(option("none"), "score none");
  await expectSheetNotClipped("Score step");
  // Back twice to the rung, then the Armageddon: three screens, each here and at 1280.
  await backButton().click();
  await backButton().click();
  await option("armageddon").click();
  const dict = dlDict("en");
  const hint = v3Sheet(page).getByText(dict["pad.boardgame.tiebreak.armageddonHint"]!);
  const phoneViewport = page.viewportSize()!;
  /** Every control the sheet shows, in DOM order: the choice options by their option id, the rest by testid or label. */
  const controls = () =>
    v3Sheet(page)
      .locator("button, [data-choice-option-id]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-choice-option-id") ?? e.getAttribute("data-testid") ?? (e.textContent ?? "").trim()));
  /** The control set at this width, then at 1280 — the same screen, the same state — then back to the project's width. */
  const sameControlsAt1280 = async (screen: string): Promise<string[]> => {
    const here = await controls();
    expect(here.length, `${screen}: the sheet shows controls`).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(v3Sheet(page)).toBeVisible();
    const desktop = await controls();
    await page.setViewportSize(phoneViewport);
    await expect(v3Sheet(page)).toBeVisible();
    expect(here, `${screen} at ${projectWidth} vs 1280: membership and order`).toEqual(desktop);
    return here;
  };

  // Screen 1 — Who had Black? Exactly the two entrants, named in full; no hint (it is the result step's).
  const blackIds = await sameControlsAt1280("Black step");
  expect(blackIds.filter((id) => id.startsWith("black-")), "Black step: the two entrants").toEqual(["black-home", "black-away"]);
  await expect(v3Sheet(page).getByText(dict["pad.boardgame.tiebreak.black.title"]!)).toBeVisible();
  await expect(hint, "the Black step carries no hint").toHaveCount(0);
  await expect(option("black-away")).toHaveText(nameOf.get(awayEntrantId)!);
  for (const id of ["black-home", "black-away"]) await assertTapFloor(option(id), `Black ${id}`);
  await expectRows(["black-home", "black-away"], "Black step");
  expect(await contextLines(), "the Black step names the round and nothing else").toEqual([dict["pad.boardgame.tiebreak.rung.armageddon"]!]);
  await expectSheetNotClipped("Black step");
  await shotSheet("s5-21-long-name-black");
  await option("black-away").click();

  // Screen 2 — Result? The engine's three, each labelled by the dictionary, the hint showing.
  await expect(hint).toBeVisible();
  const resultIds = await sameControlsAt1280("Result step");
  expect(resultIds.filter((id) => id.startsWith("result-")), "Result step: the engine's results, in its order").toEqual(ARMAGEDDON_RESULTS.map((r) => `result-${r}`));
  for (const r of ARMAGEDDON_RESULTS) {
    await expect(option(`result-${r}`)).toHaveText(dict[`pad.boardgame.armageddon.result.${r}`]!);
    await assertTapFloor(option(`result-${r}`), `result ${r}`);
  }
  await expectRows(ARMAGEDDON_RESULTS.map((r) => `result-${r}`), "Result step");
  // Black is the away entrant, so the home entrant is White. Both names are 43 characters: the legend wraps them, it never clips.
  const legend = [dict["pad.boardgame.tiebreak.rung.armageddon"]!, `${dict["pad.boardgame.tiebreak.who.white"]!} ${nameOf.get(homeEntrantId)!}`, `${dict["pad.boardgame.tiebreak.who.black"]!} ${nameOf.get(awayEntrantId)!}`];
  expect(await contextLines(), "the result step says who is White and who is Black").toEqual(legend);
  await expectSheetNotClipped("Result step");
  await shotSheet("s5-22-long-name-result");
  await option("result-draw").click();

  // Screen 3 — the read-back: the sentence in full, then one Confirm that is a real tap target.
  const sentence = dict["pad.boardgame.tiebreak.confirm.drawn"]!.replace("{name}", nameOf.get(awayEntrantId)!);
  await expect(v3Sheet(page).getByTestId("pad-sheet-summary")).toHaveText(sentence);
  const readBackIds = await sameControlsAt1280("Read-back step");
  expect(readBackIds.filter((id) => id === "pad-sheet-confirm"), "the read-back offers exactly one Confirm").toHaveLength(1);
  expect(readBackIds.some((id) => id.startsWith("black-") || id.startsWith("result-")), "the read-back offers no choice to re-tap").toBe(false);
  await assertTapFloor(v3Sheet(page).getByTestId("pad-sheet-confirm"), "Confirm");
  await assertTapFloor(backButton(), "Back on the read-back");
  expect(await contextLines(), "the read-back keeps the same legend above it").toEqual(legend);
  await expectSheetNotClipped("Read-back step");
  await shotSheet("s5-23-long-name-confirm");
  // Nothing was written by walking the sheet.
  const events = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events`);
  expect(events.data!.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
});

// W2b Task 11 (UI-1): the organiser console's forfeit dialog at THIS width. A bottom sheet on phones: every choice is
// reachable and holds the 44px floor, the page never scrolls sideways, Confirm is the element a tap at its edges lands
// on, and the control set — membership and order — is the one 1280 shows (a branch, not a shrink). Long realistic
// names, because a short one hides the wrap (AGENTS.md phone composition: `truncate` / `min-w-0`).
test("forfeit dialog (W2b T11): every choice reachable, 44px floor, no horizontal scroll, Confirm hit-testable; the control set matches 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b mobile forfeit ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "League",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const names = [`Alexandria Konstantinopoulou-Vanderbilt ${TAG}`, `Maximiliano Wolfeschlegelsteinhausen ${TAG}`];
  const added = await addEntrantsViaApi(request, div.data!.id, names, "individual");
  expect(added.ids).toHaveLength(2);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const fixtureId = fixtureIds[0]!;
  const projectWidth = page.viewportSize()!.width;

  await page.goto(await fixturePath(page.request, fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const dialog = page.getByTestId("forfeit-dialog");
  const controls = () =>
    dialog
      .locator('[data-testid^="forfeit-who-"], [data-testid^="forfeit-why-"], [data-testid="forfeit-confirm"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  const open = async () => {
    await page.getByTestId("score-forfeit").click({ timeout: 20_000 });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId("forfeit-who-away").click();
    await dialog.getByTestId("forfeit-why-walkover").check();
    await expect(dialog.getByTestId("forfeit-preview")).toBeVisible();
  };
  await open();
  for (const w of ["home", "away", "both"]) await assertTapFloor(dialog.getByTestId(`forfeit-who-${w}`), `forfeit side ${w}`);
  // A radio's tap target is its label (the whole row), not the 16px dot.
  await assertTapFloor(dialog.locator("label", { has: page.getByTestId("forfeit-why-walkover") }), "forfeit reason walkover");
  await assertTapFloor(dialog.getByTestId("forfeit-confirm"), "forfeit Confirm");
  await expectNoHorizontalScroll(page);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `${projectWidth}: scrollWidth ${widths.scroll} within clientWidth ${widths.client}`).toBeLessThanOrEqual(widths.client);
  const here = await controls();
  expect(here.length, "the dialog's controls were read").toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  expect(here, `the dialog's controls at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await controls());
  await page.keyboard.press("Escape");
  // Nothing was confirmed: walking the dialog wrote nothing.
  const events = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events`);
  expect(events.data!.map((e) => e.type)).toEqual([]);
});

// 2048 mobile swipe: on a real touchscreen the browser decides whether a
// gesture is page-scroll/pan or app-handled AT touchstart, using whatever
// `touch-action` value is ALREADY in effect at that instant -- not a value a
// React re-render commits a few ms later. index.tsx used to flip
// `touchAction` from "auto" to "none" reactively (a `swiping` useState set
// inside onPointerDown), which is always too late: the browser has already
// claimed the gesture as a scroll by the time the state update lands, so
// every swipe on a phone was eaten by the page instead of moving a tile.
// Self-contained: /games/2048 is a static registry page, no auth/org state,
// so this needs none of this file's setup-test fixtures.
//
// ONE gesture on a SEEDED board -- never a retry loop over newGame()'s random
// one. The old version tried up to four directions in turn, and it hung (not
// slow: `page.mouse.move` never returned, so 60s and then #817's 120s budget
// were both exhausted -- CI run 35924224847, mobile-430, trace stuck in the
// SECOND gesture's move for 118s) whenever the first direction was a legal
// no-op, e.g. both opening tiles already flush right (~5% of boards). The
// chain, reproduced locally:
//   1. a `page.mouse` drag is a text-selection drag, so the no-op first
//      gesture left a non-collapsed Selection on the board (empty cells
//      2-2 -> 2-3, reads "\n");
//   2. the second gesture pressed at the SAME start point, inside that
//      selection, so its move began a native selection drag -- at once on
//      Linux (Blink's text-drag delay is 0 there; 150ms on macOS, which is why
//      it never reproduced on a Mac until the button was held 200ms first);
//   3. `dragstart` fired un-prevented and `dragend` in the same millisecond
//      (nothing to drag), and Playwright's drag interception, having seen that
//      dragstart, awaits `Input.dragIntercepted` with no timeout -- an event a
//      drag that never reached the system never sends.
// Not a product defect: the same two gestures sent as raw CDP input (no
// Playwright drag interception) still move the tile. A single gesture on a
// fresh page has no selection to drag, on any platform, so it cannot hang.
test("2048 (mobile swipe bug): touch-action is disabled at rest, and a swipe moves a tile", async ({
  page,
}) => {
  // Two 4s side by side in the top row. A swipe RIGHT merges them into an 8 on
  // the row's far edge (0-3) and scores 8. Nothing else can put an 8 there:
  // left merges at 0-0, down slides both to row 3 unmerged, up is a no-op, and
  // applyMove's spawn only ever writes a 2 or a 4 -- so this also pins the
  // right-swipe mapping, and does not depend on the RNG at all.
  // useGameStore reads storage on mount (the game is client-only), so an init
  // script is early enough.
  const seeded: Game2048State = {
    board: [
      [4, 4, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 0,
    best: 0,
    keepPlaying: false,
  };
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [GAME_2048_STORAGE_KEY, JSON.stringify(seeded)] as const,
  );
  await page.goto("/games/2048", { waitUntil: "load" });
  await dismissCookieBanner(page);
  const area = page.getByTestId("2048-swipe-area");
  await expect(area).toBeVisible();
  const cell = (pos: string) => page.locator(`[data-testid="2048-board"] [data-cell="${pos}"]`);
  const score = page.getByText(/^Score: \d+/);
  // "load" resolves before React mounts the client-only game -- a swipe fired
  // before then lands on markup with no pointer handler attached yet and is
  // silently a no-op. The SEEDED board rendering is the mount witness.
  await expect(cell("0-0")).toHaveAttribute("data-value", "4");
  await expect(cell("0-1")).toHaveAttribute("data-value", "4");
  await expect(score).toHaveText(/^Score: 0 /);

  // The actual regression check: touch-action must already be "none" BEFORE
  // any pointer/touch interaction happens, since that is the only moment the
  // browser consults it for a real touch gesture. Under the old code this is
  // "auto" at rest (swiping starts false) and only becomes "none" once a
  // gesture is already in progress -- too late for the browser's decision.
  await expect(area).toHaveCSS("touch-action", "none");

  // Drive an actual swipe, proving the gesture itself now works end-to-end --
  // not just that the CSS property reads correctly in isolation. onPointerDown/
  // onPointerUp are React pointer handlers (see index.tsx), which Chromium
  // fires from plain mouse-style input same as games.spec.ts's chess-quest
  // drag test already relies on for Board.tsx's pointer handlers.
  const box = await area.boundingBox();
  expect(box, "swipe area has no layout box").not.toBeNull();
  const startX = box!.x + box!.width * 0.5;
  const startY = box!.y + box!.height * 0.5;
  // A real touch's subsequent move/up events keep targeting the element the
  // finger went down on, however far it travels (implicit touch capture --
  // spec-guaranteed). A Playwright `page.mouse` drag has no such capture: it
  // is plain hit-testing, so moving the pointer PAST the wrapper's edge
  // delivers pointerup to whatever element is now underneath instead of this
  // div, and onPointerUp never fires -- a test-only gap, not the app bug.
  // 2048.css fixes the board at exactly 288x288; stay inside it with margin.
  const amp = Math.max(30, Math.min(box!.width, box!.height) / 2 - 20);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Well past swipeTransition's 24px threshold (state.ts).
  await page.mouse.move(startX + amp, startY, { steps: 5 });
  await page.mouse.up();

  await expect(cell("0-3"), "a swipe right did not merge the two 4s on the row's far edge").toHaveAttribute(
    "data-value",
    "8",
  );
  await expect(score).toHaveText(/^Score: 8 /);
});

// 2048 first visit: with nothing stored, useGameStore hands back
// INITIAL_STATE's EMPTY board (it skips `migrate` when the key is unset), and
// only index.tsx's mount effect turns that into a playable game by dealing
// newGame()'s two opening tiles. The swipe test above seeds its own board, so
// it never reaches that path. The effect runs only in a browser -- the
// server-only index.test.tsx can't see it -- so this test is its only
// coverage. No pointer input at all, so it cannot hit the swipe test's old
// mouse-drag hang.
test("2048 (first visit): empty storage deals the opening two tiles", async ({ page }) => {
  // Explicitly empty, whatever the project's storageState carries.
  await page.addInitScript((key) => window.localStorage.removeItem(key), GAME_2048_STORAGE_KEY);
  await page.goto("/games/2048", { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("2048-board")).toBeVisible();
  await expect(
    page.locator('[data-testid="2048-board"] [data-value]:not([data-value="0"])'),
    "an empty store never got its opening deal -- the board stays empty and unplayable",
  ).toHaveCount(2);
  await expect(page.getByText(/^Score: \d+/)).toHaveText(/^Score: 0 /);
});

// Online chess on OUR page (design 2026-10-09 §6, §8.6; Task 17): the live
// match room at this project's REAL width. Below md the room is one column
// in a fixed order — the OPPONENT's clock bar, the board at the column's full
// width, the player's own clock bar (T17B fix 2, D24: by viewer, never by
// colour), the player's own camera tile, then Draw/Resign; from md the board
// takes the left column — with the two bars, each the board's width, framing
// it — and the tile and controls the right. Asserted as the order and
// membership of what is on screen, not as box sizes, so a groomed shrink of
// the desktop layout cannot pass for the phone composition. The presence pill
// needs a real meeting join and is owed to staging (Task 17 part B). Camera
// `optional` so the tile is on screen with no camera duty — no banner
// competes for the top of the column.
test("match room (online chess): a live board is the opponent's clock, a full-width board, own clock, own tile, then Draw/Resign below md — two columns from md — no horizontal scroll", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const phone = vp!.width < 768;
  const r = await seedOnlineRound(request, [`Mo Phone ${TAG}`, `Ny Width ${TAG}`], { camera: "optional" });
  const board = r.boards[0]!;
  // White is home on a ledger game (roundGameSql); two plies, so the rules
  // offer a draw and a resign and no longer an abort.
  await roundGameSql(board, { moves: ["e2e4", "e7e5"] });

  const ctx = await browser.newContext({ viewport: vp!, storageState: await consentedAnonymousState() });
  try {
    const p = await ctx.newPage();
    const res = await p.goto(await matchRoomPathBySql(board.fixtureId, board.home.personId));
    expect(res?.status(), "the room renders").toBe(200);
    await expect(p.getByTestId("match-room")).toHaveAttribute("data-screen", "live", { timeout: 20_000 });
    await expect(p.locator("[data-testid=room-board-surface] cg-board piece").first()).toBeAttached({ timeout: 20_000 });

    const order = ["room-clock-opponent", "room-board", "room-clock-you", "room-tile-strip", "room-controls"] as const;
    const box = async (id: string) => {
      const b = await p.getByTestId(id).first().boundingBox();
      expect(b, `${id} is on screen at ${vp!.width}px`).not.toBeNull();
      return b!;
    };
    await expect(p.getByTestId("room-clock-opponent")).toContainText(board.away.name);
    let pairs = 0;
    if (phone) {
      for (let i = 1; i < order.length; i++) {
        const above = await box(order[i - 1]!);
        const below = await box(order[i]!);
        expect(below.y, `${order[i]} sits below ${order[i - 1]} at ${vp!.width}px`).toBeGreaterThanOrEqual(above.y + above.height - 1);
        pairs++;
      }
    } else {
      const theirs = await box("room-clock-opponent");
      const b = await box("room-board");
      const mine = await box("room-clock-you");
      expect(b.y, "the opponent's clock is above the board").toBeGreaterThanOrEqual(theirs.y + theirs.height - 1);
      expect(mine.y, "the player's clock is under the board").toBeGreaterThanOrEqual(b.y + b.height - 1);
      pairs += 2;
      for (const id of ["room-tile-strip", "room-controls"]) {
        const side = await box(id);
        expect(side.x, `${id} is right of the board from md`).toBeGreaterThanOrEqual(b.x + b.width);
        pairs++;
      }
      const tile = await box("room-tile-strip");
      const controls = await box("room-controls");
      expect(controls.y, "the tile above the controls").toBeGreaterThanOrEqual(tile.y + tile.height - 1);
      pairs++;
    }
    expect(pairs, "anti-vacuity: every relation checked").toBe(phone ? order.length - 1 : 5);
    // Each bar is the board's width, left edge to left edge (D24), at every width.
    const b = await box("room-board");
    let framed = 0;
    for (const id of ["room-clock-opponent", "room-clock-you"]) {
      const bar = await box(id);
      expect(Math.abs(bar.width - b.width), `${id} is the board's width at ${vp!.width}px`).toBeLessThanOrEqual(2);
      expect(Math.abs(bar.x - b.x), `${id} lines up with the board at ${vp!.width}px`).toBeLessThanOrEqual(2);
      framed++;
    }
    expect(framed, "anti-vacuity: both bars measured").toBe(2);
    // The sound switch is in the player's bar, a real 44px target (hit-tested: the paint box is not the tap area).
    const toggle = p.getByTestId("room-clock-you").getByTestId("room-sound");
    await expect(toggle).toBeVisible();
    const t = await toggle.boundingBox();
    expect(t, "the switch is painted").not.toBeNull();
    expect(Math.min(t!.width, t!.height), `the switch is at least 44px at ${vp!.width}px`).toBeGreaterThanOrEqual(43.5);
    const hit = await toggle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el || (top !== null && el.contains(top));
    });
    expect(hit, "the centre of the switch hits the switch").toBe(true);

    // The control set, membership and order, read from the live DOM: the
    // rules' answer at two plies is Offer draw then Resign — never Abort.
    const controls = await p
      .getByTestId("room-controls")
      .locator("button:visible")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(controls).toEqual(["room-draw", "room-resign"]);
    await expect(p.getByTestId("room-draw")).toBeEnabled();
    await expect(p.getByTestId("room-resign")).toBeEnabled();
    await expect(p.getByTestId("room-abort")).toHaveCount(0);

    const { clipped, scrollable } = await overflowingIn(p, '[data-testid="match-room"]', "button,div,span", "the match room was not in the DOM");
    expect(clipped, "nothing in the room is clipped at this width").toEqual([]);
    for (const s of scrollable) expect(s, "a scrolling box in the room is keyboard-reachable").toMatch(/tabindex=0$/);
    await expectNoHorizontalScroll(p);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// R2008 free-gaps (owner ruling 2026-10-20) — the never-live COPY FITS a phone.
//
// The end of a composed stream whose camera never appeared now has two true tellings: the credit is returned (or none was
// taken), or the fixture's never-live refund is already spent and the CHARGE STANDS. Each has a countdown sentence in the
// Phone strip and a sentence on the failed card (`camera_never_live` / `camera_never_live_charged`), and French is the
// longest of the four locales. This block renders BOTH variants in fr and en, at this project's width (it runs under all
// seven), and asserts that nothing is clipped, nothing scrolls the page sideways, the whole sentence is the shipped one,
// and the control a person needs next (Stop on the live card, Try again on the failed one) is under the finger — by
// `elementFromPoint`, because a box is paint and a hit-test is what is on top (AGENTS.md class 2).
//
// WHAT IS STAGED: the two reads the panel polls (`stream-sessions/current` and `stream-phone`) are answered with the
// session the server would serve at each moment — a 15-minute clock cannot be waited for here, and the server's own
// choice of line is proven by the DB suites (stream-composed-free-gaps.test.ts). The copy, the layout, the fixture page
// and the panel are the product's own. The expected sentences come from the dictionaries by KEY, never typed here.
//
// Lives in mobile.spec.ts for the reason the P6 block above does: a new file would run desktop-only. Screenshots go to
// test-results/never-live-copy/ (never committed; e2e.yml's e2e-mobile job uploads the directory as an artifact).
// ---------------------------------------------------------------------------
const NL_SHOTS_DIR = join(process.cwd(), "test-results", "never-live-copy");
const nlDict = (locale: "en" | "fr"): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8")) as Record<string, string>;
const flat = (t: string): string => t.replace(/\s+/g, " ").trim();
/** The two tellings, typed from the ruling: the countdown reason on the wire, and the dictionary key each surface reads. */
const NL_VARIANTS = [
  { variant: "refunded", reason: "camera_never_live", strip: "stream.phone.countdown.live.camera_never_live", fail: "stream.fail.camera_never_live", creditUsed: false },
  { variant: "charged", reason: "camera_never_live_charged", strip: "stream.phone.countdown.live.camera_never_live_charged", fail: "stream.fail.camera_never_live_charged", creditUsed: true },
] as const;
const NL_LOCALES = ["fr", "en"] as const;
const NL_SESSION_ID = "00000000-0000-4000-8000-0000000000a1";

/** A fresh two-entrant league and its one fixture on the shared Pro org, plus a destination to name in the session. */
async function nlRig(page: Page, request: APIRequestContext): Promise<{ fixturePath: string; fixtureId: string; targetId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `Never Live ${TAG}-${projectTag()}`, visibility: "public",
  });
  expect(comp.status, "competition").toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Never Live Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, "division").toBe(201);
  await addEntrantsViaApi(request, div.data!.id, ["Riverside Raptors", "Northgate Nomads"]);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  expect(fixtureIds, "a league of two plays once").toHaveLength(1);
  const org = await activeOrg(page);
  const listed = await apiJson<{ id: string }[]>(request, `/api/v1/orgs/${org.id}/stream-targets`);
  let targetId = listed.data?.[0]?.id;
  if (!targetId) {
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.id}/stream-targets`, "POST", {
      kind: "youtube", label: "Riverside TV", streamKey: `e2e-${TAG}-${projectTag()}`,
    });
    expect([200, 201], `a destination: ${JSON.stringify(made.error)}`).toContain(made.status);
    targetId = made.data!.id;
  }
  return { fixturePath: await fixturePath(request, fixtureIds[0]!), fixtureId: fixtureIds[0]!, targetId };
}

/** The `current` read as the server serves it (the wire's fields, StreamSessionCurrent), with `over` laid on top. */
function nlSession(rig: { fixtureId: string; targetId: string }, over: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return {
    id: NL_SESSION_ID, fixtureId: rig.fixtureId, mode: "composed", overlay: { themeId: null, delayMs: 0 }, state: "live", desiredState: "live",
    failReason: null, health: null, ingest: { state: "disconnected", protocol: null }, output: null, balance: 2,
    startedAt: new Date(now - 5 * 60_000).toISOString(), endedAt: null, replayUrl: null,
    target: { id: rig.targetId, kind: "youtube", label: "Riverside TV" }, fixtureDecided: false, fixtureHeld: false, endReason: null,
    creditUsed: true, startCause: "organiser", restart: null, countdown: null, ...over,
  };
}
/** The `stream-phone` read model with a paired, present phone (the panel's strip reads the session for a countdown). */
function nlPhoneRead(): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    code: { issuedAt: at, state: "active", endCause: null },
    phone: {
      present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2", mode: "operator", state: "publishing",
      notReady: null, notReadyShown: false, health: null, startFailed: null, lastBeatAt: at, elapsedMs: 5_000,
      beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false,
    },
    destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null,
  };
}

/** Answer the panel's two polls with `staged` (a mutable box, so one route serves every scenario of a test). */
async function nlStage(page: Page, fixtureId: string, staged: { current: Record<string, unknown> | null }): Promise<void> {
  const envelope = (data: unknown) => ({ ok: true, data, requestId: "e2e-staged" });
  await page.route(`**/api/v1/fixtures/${fixtureId}/stream-sessions/current`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: envelope(staged.current) }) : route.fallback());
  await page.route(`**/api/v1/fixtures/${fixtureId}/stream-phone`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: envelope(nlPhoneRead()) }) : route.fallback());
}

/** The fixture page, its Stream control (one visible twin), and the Phone tab. */
async function nlOpenPanel(page: Page, path: string): Promise<Locator> {
  await page.goto(path, { waitUntil: "load" });
  await dismissCookieBanner(page);
  // The app header is sticky, so a panel scrolled into view for its picture (or for the hit-tests below) is painted over by
  // it: back in flow, the crop and the occlusion checks judge the PANEL, as stream-phone-panel.capture.ts does. Nothing in
  // the panel's own layout moves.
  await page.addStyleTag({ content: "header { position: static !important; }" });
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control, "exactly one visible Stream control").toHaveCount(1, { timeout: 30_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: 30_000 });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  return scope;
}

/** The whole sentence is on screen: every painted line of `el`'s text is inside the viewport and inside every ancestor that
 *  CLIPS (`overflow` hidden/clip), and `el` itself does not hide content below its own box. A scrolling ancestor
 *  (`auto`/`scroll`) is a feature — its content is reachable — and is skipped on that axis. Returns the line count. */
async function nlExpectFits(el: Locator, label: string): Promise<number> {
  await el.scrollIntoViewIfNeeded();
  const verdict = await el.evaluate((node) => {
    const own = node as HTMLElement;
    const vw = document.documentElement.clientWidth;
    const range = document.createRange();
    range.selectNodeContents(own);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return { problems: ["no painted text"], lines: 0 };
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const problems: string[] = [];
    if (left < -0.5 || right > vw + 0.5) problems.push(`text spans ${left.toFixed(1)}..${right.toFixed(1)} outside the ${vw}px viewport`);
    if (own.scrollHeight > own.clientHeight + 1) problems.push(`scrollHeight ${own.scrollHeight} > clientHeight ${own.clientHeight}`);
    const name = (a: HTMLElement) => `${a.tagName.toLowerCase()}${a.getAttribute("data-testid") ? `[${a.getAttribute("data-testid")}]` : ""}`;
    for (let a: HTMLElement | null = own; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const clipsY = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (!clipsX && !clipsY) continue;
      const box = a.getBoundingClientRect();
      if (clipsY && (top < box.top - 0.5 || bottom > box.bottom + 0.5)) {
        problems.push(`${name(a)} clips vertically: text ${top.toFixed(1)}..${bottom.toFixed(1)}, box ${box.top.toFixed(1)}..${box.bottom.toFixed(1)}`);
      }
      if (clipsX && (left < box.left - 0.5 || right > box.right + 0.5)) {
        problems.push(`${name(a)} clips horizontally: text ${left.toFixed(1)}..${right.toFixed(1)}, box ${box.left.toFixed(1)}..${box.right.toFixed(1)}`);
      }
    }
    // Nothing paints over the copy: the topmost element at the middle of its first and of its last painted line is the
    // copy's own box (or inside it) — a hit-test, not a box (a sticky bar or a sheet edge over the last line is not "fit").
    if (bottom - top <= window.innerHeight) {
      const byTop = [...rects].sort((a, b) => a.top - b.top);
      for (const [which, r] of [["first", byTop[0]!], ["last", byTop[byTop.length - 1]!]] as const) {
        const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (y < 0 || y > window.innerHeight) problems.push(`the ${which} line is outside the viewport (y ${y.toFixed(1)}) after scrolling to it`);
        else if (!(hit && (own === hit || own.contains(hit)))) problems.push(`the ${which} line is covered by ${hit ? name(hit as HTMLElement) : "nothing"}`);
      }
    }
    return { problems, lines: new Set(rects.map((r) => Math.round(r.top))).size };
  });
  expect(verdict.problems, `${label}: the copy is fully visible`).toEqual([]);
  expect(verdict.lines, `${label}: anti-vacuity, some text was painted`).toBeGreaterThan(0);
  return verdict.lines;
}

/** The control is under a finger: scrolled to, its centre is inside the viewport and the topmost element there is the
 *  control (or a descendant) — not a sticky bar, the sheet's edge or a banner. */
async function nlExpectReachable(control: Locator, label: string): Promise<void> {
  await expect(control, `${label}: the control is rendered`).toBeVisible({ timeout: 30_000 });
  await control.scrollIntoViewIfNeeded();
  const verdict = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const topName = top ? `${top.tagName.toLowerCase()}${top.getAttribute("data-testid") ? `[${top.getAttribute("data-testid")}]` : ""}` : "nothing";
    return { inside: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight, hit: top === el || (top !== null && el.contains(top)), topName };
  });
  expect(verdict.inside, `${label}: the centre of the control is inside the viewport`).toBe(true);
  expect(verdict.hit, `${label}: the topmost element at the control's centre is ${verdict.topName}`).toBe(true);
}

/** Save the panel's picture and prove the gate has not gone vacuous (AGENTS.md class 10): it exists and differs. */
async function nlShoot(scope: Locator, name: string, shas: Map<string, string>): Promise<void> {
  mkdirSync(NL_SHOTS_DIR, { recursive: true });
  const file = join(NL_SHOTS_DIR, `${projectTag()}-${name}.png`);
  await scope.screenshot({ path: file, animations: "disabled" });
  expect(existsSync(file), `${name}: the screenshot was written`).toBe(true);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const twin = shas.get(sha);
  expect(twin, `${name}: pixel-identical to ${twin} — a state that never opened`).toBeUndefined();
  shas.set(sha, name);
}

test("R2008 free-gaps: the never-live COUNTDOWN strip fits and Stop stays reachable — refunded and charged, fr and en", async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const rig = await nlRig(page, request);
  const staged: { current: Record<string, unknown> | null } = { current: null };
  await nlStage(page, rig.fixtureId, staged);
  const shas = new Map<string, string>();
  const sentences = new Set<string>();
  let checked = 0;
  for (const locale of NL_LOCALES) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    const dict = nlDict(locale);
    for (const v of NL_VARIANTS) {
      const tag = `${projectTag()} ${locale} ${v.variant}`;
      staged.current = nlSession(rig, {
        state: "live", creditUsed: true,
        countdown: { kind: "live", reason: v.reason, elapsedMs: 5 * 60_000, remainingMs: 10 * 60_000 },
      });
      const scope = await nlOpenPanel(page, rig.fixturePath);
      const strip = scope.getByTestId("stream-phone-strip");
      await expect(strip, `${tag}: the countdown strip`).toBeVisible({ timeout: 30_000 });
      const copy = dict[v.strip]!;
      const [head, tail] = copy.split("{remaining}") as [string, string];
      const got = flat((await strip.textContent()) ?? "");
      expect(got.startsWith(flat(head)), `${tag}: the strip opens with the shipped sentence — ${got}`).toBe(true);
      expect(got.endsWith(flat(tail)), `${tag}: the strip ends with the shipped sentence — ${got}`).toBe(true);
      const remaining = got.slice(flat(head).length, got.length - flat(tail).length).trim();
      expect(remaining.length, `${tag}: a time is named between them (${remaining})`).toBeGreaterThan(0);
      sentences.add(got);
      const lines = await nlExpectFits(strip, `${tag} strip`);
      await expectNoHorizontalScroll(page);
      await nlExpectReachable(scope.getByTestId("stream-stop").first(), `${tag} Stop`);
      await nlShoot(scope, `${locale}-${v.variant}-strip`, shas);
      console.log(`[never-live strip ${tag}] ${got.length} chars, ${lines} lines, remaining "${remaining}"`);
      checked++;
    }
  }
  expect(checked, "anti-vacuity: both locales x both tellings").toBe(NL_LOCALES.length * NL_VARIANTS.length);
  expect(sentences.size, "four different sentences were shown").toBe(4);
});

test("R2008 free-gaps: the never-live FAILED card fits and Try again stays reachable — refunded and charged, fr and en", async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const rig = await nlRig(page, request);
  const staged: { current: Record<string, unknown> | null } = { current: null };
  await nlStage(page, rig.fixtureId, staged);
  const shas = new Map<string, string>();
  const sentences = new Set<string>();
  let checked = 0;
  for (const locale of NL_LOCALES) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    const dict = nlDict(locale);
    for (const v of NL_VARIANTS) {
      const tag = `${projectTag()} ${locale} ${v.variant}`;
      const now = Date.now();
      staged.current = nlSession(rig, {
        state: "failed", desiredState: "ending", failReason: "camera_never_live", creditUsed: v.creditUsed,
        startedAt: new Date(now - 17 * 60_000).toISOString(), endedAt: new Date(now - 2 * 60_000).toISOString(),
        endReason: "failed", countdown: null,
      });
      const scope = await nlOpenPanel(page, rig.fixturePath);
      const card = scope.getByTestId("stream-fail-reason");
      await expect(card, `${tag}: the failed card`).toBeVisible({ timeout: 30_000 });
      const got = flat((await card.textContent()) ?? "");
      expect(got, `${tag}: the card says the shipped sentence`).toBe(flat(dict[v.fail]!));
      sentences.add(got);
      const lines = await nlExpectFits(card, `${tag} fail card`);
      await expectNoHorizontalScroll(page);
      await nlExpectReachable(scope.getByTestId("stream-retry"), `${tag} Try again`);
      await nlShoot(scope, `${locale}-${v.variant}-fail`, shas);
      console.log(`[never-live fail ${tag}] ${got.length} chars, ${lines} lines`);
      checked++;
    }
  }
  expect(checked, "anti-vacuity: both locales x both tellings").toBe(NL_LOCALES.length * NL_VARIANTS.length);
  expect(sentences.size, "four different sentences were shown").toBe(4);
});

test("rules-changed banner (W2c T15, X-SR-7): an open remote pad after a correction says the new format above the board, no horizontal scroll", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  // Badminton `short`: the P5 rig (best of 3 → 5). Person names carry `projectTag()` (the badminton test's reason above).
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Rules Banner ${TAG}-${projectTag()}`,
    sportKey: "badminton",
    variantKey: "short",
    entrantKind: "individual",
    home: [{ fullName: `Mobile RB Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile RB Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });
  const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
    label: `mobile rules banner ${projectTag()}`,
  });
  expect(link.status, JSON.stringify(link.error)).toBe(201);
  const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined, storageState: await consentedAnonymousState() });
  try {
    const page = await ctx.newPage();
    await page.goto(`/score/${link.data!.secret}`, { waitUntil: "load" });
    const scorebug = page.locator('[data-role="v3-scorebug"]');
    await expect(scorebug).toBeVisible({ timeout: 20_000 });

    const fix = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/rules`, "PUT", { rules: { bestOf: 5 } });
    expect(fix.status, JSON.stringify(fix.error)).toBe(200);
    const rules = await apiJson<{ format_line: string | null }>(request, `/api/v1/fixtures/${fx.fixtureId}/rules`);
    const line = rules.data?.format_line;
    expect(line, "premise: badminton's format line exists").toBeTruthy();

    // The stale tap: refused, and the pad raises the banner (the hold, then the wire: `HOLD_MS` is CI-pinned short).
    await scorebug.locator(".grid > button").first().click();
    const banner = page.getByTestId("pad-rules-changed");
    await expect(banner).toBeVisible({ timeout: 45_000 });
    await expect(banner).toContainText(line!);
    // Above the board at every width: the banner sits in the host's unordered band, before the tiles.
    const [b, tiles] = await Promise.all([banner.boundingBox(), page.locator('[data-role="v3-tiles"]').boundingBox()]);
    expect(b, "the banner has a box").not.toBeNull();
    expect(tiles, "the board has a box").not.toBeNull();
    expect(b!.y + b!.height, "the banner ends above the board").toBeLessThanOrEqual(tiles!.y);
    // The format line wraps inside the banner rather than clipping it, and the dismiss keeps its own column.
    const o = await overflowingIn(page, '[data-testid="pad-rules-changed"]', "*", "the rules-changed banner is missing");
    expect(o.clipped, "nothing clipped inside the banner").toEqual([]);
    await expectNoHorizontalScroll(page);
    // Only for a per-screen visual verdict: a crop from the scorebug to the top of the board into W2A_SHOTS_DIR (the switch
    // bracket-finish.spec.ts uses). Unset in CI, where it does nothing.
    const dir = process.env.W2A_SHOTS_DIR;
    if (dir) {
      const width = page.viewportSize()!.width;
      const sy = await page.evaluate(() => window.scrollY);
      const sb = (await scorebug.boundingBox())!;
      const top = Math.max(0, sb.y + sy - 8);
      await page.screenshot({
        path: `${dir}/t15-rules-banner-${width}.png`,
        fullPage: true,
        clip: { x: 0, y: top, width, height: tiles!.y + sy + 120 - top },
      });
    }
  } finally {
    await ctx.close();
  }
});

// W2c Task 17 (S1): the stage rules row at every width. One DOM, branched with `max-md:*` - never a second phone tree - so
// the evidence is: the row and its editor fit (no page scroll, nothing clipped), every control holds the 44px floor and is
// hit-testable (`elementFromPoint`, not paint), the deciders notice shows at this width, and the control SET (membership,
// order, repeats) is the one 1280 shows. Football carries the sections, the notice and the selects; chess carries the
// ordered-list control, which has the most buttons per row of anything in the product's rules editors.
test("W2c stage format row at every width: sections, the deciders notice and the tie-break list hold the 44px floor, no scroll, the control set matches 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = async (sport: string, variant: string, label: string): Promise<{ divisionId: string; stageId: string }> => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `W2c T17 ${label} ${TAG}-${testInfo.project.name}`,
      visibility: "private",
    });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: `${label} division`,
      sport_key: sport,
      variant_key: variant,
    });
    expect(div.status, `division ${sport}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Knockout",
    });
    expect(stage.status, `stage ${sport}: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
    return { divisionId: div.data!.id, stageId: stage.data!.id };
  };
  const projectWidth = page.viewportSize()!.width;
  const shots = process.env.T17_SHOTS_DIR;
  const editorControls = (row: Locator) =>
    row
      .getByTestId("stage-format-editor")
      .locator('[data-testid^="stage-rule-field-"], [data-testid^="stage-rule-sequence-"], [data-testid="stage-format-save"], [data-testid="stage-format-cancel"], [data-testid="stage-deciders-off"], [data-testid="stage-deciders-level"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

  // --- football: the sections, the selects, the notice -------------------------------------------------------------
  const fb = await seed("football", "11-a-side", "football");
  await page.goto(await divisionPath(page.request, fb.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const row = page.getByTestId(`stage-format-row-${fb.stageId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await assertTapFloor(row.getByTestId("stage-format-edit"), "Edit rules");
  await expectNoHorizontalScroll(page);
  // Fix round 1 (I-1): the collapsed row says the stage's format as chips, they wrap inside the row, and none is clipped.
  const chips = row.getByTestId("stage-format-chips");
  await expect(chips, `the chips are on the collapsed row at ${projectWidth}`).toBeVisible();
  expect(await chips.locator("li").count(), "the chips are a list of clauses").toBeGreaterThan(1);
  const collapsedClip = await overflowingIn(page, `[data-testid="stage-format-row-${fb.stageId}"]`, "*", "the stage rules row is missing");
  expect(collapsedClip.clipped, `nothing in the collapsed row is clipped at ${projectWidth}`).toEqual([]);
  if (shots) await row.screenshot({ path: `${shots}/collapsed-${projectWidth}.png` });
  await row.getByTestId("stage-format-edit").click();
  const editor = row.getByTestId("stage-format-editor");
  await expect(editor).toBeVisible();
  // M-3: while editing, Cancel is the one way out and Edit is gone.
  await expect(row.getByTestId("stage-format-edit")).toHaveCount(0);
  await assertTapFloor(row.getByTestId("stage-format-cancel"), "football Cancel");
  const interactive = editor.locator("select, input, button");
  const n = await interactive.count();
  expect(n, "the editor has controls to measure").toBeGreaterThan(4);
  for (let i = 0; i < n; i++) await assertTapFloor(interactive.nth(i), `football editor control ${i}`);
  // Both deciders off: the notice shows, inside the row, at this width.
  await row.getByTestId("stage-rule-field-extraTime").locator("select").selectOption("off");
  await row.getByTestId("stage-rule-field-shootout").locator("select").selectOption("off");
  const notice = row.getByTestId("stage-deciders-off");
  await expect(notice).toBeVisible();
  // M-4: the kicks are held with the reason beside them, and the caption fits at this width.
  await expect(row.getByTestId("stage-rule-field-shootoutAttempts").locator("input")).toBeDisabled();
  await expect(row.getByTestId("stage-rule-detail-off-shootoutAttempts")).toBeVisible();
  const clip = await overflowingIn(page, `[data-testid="stage-format-row-${fb.stageId}"]`, "*", "the stage rules row is missing");
  expect(clip.clipped, `nothing in the row is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  if (shots) {
    await editor.scrollIntoViewIfNeeded();
    await row.screenshot({ path: `${shots}/expanded-${projectWidth}.png` });
    await notice.screenshot({ path: `${shots}/deciders-off-${projectWidth}.png` });
  }
  const here = await editorControls(row);
  expect(here.length, "the editor's controls were read").toBeGreaterThan(4);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(here, `the football editor's control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await editorControls(row));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- chess: the ordered list -------------------------------------------------------------------------------------
  const chess = await seed("boardgame", "blitz", "chess");
  await page.goto(await divisionPath(page.request, chess.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  const crow = page.getByTestId(`stage-format-row-${chess.stageId}`);
  await expect(crow).toBeVisible({ timeout: 20_000 });
  await crow.getByTestId("stage-format-edit").click();
  const list = crow.getByTestId("stage-rule-sequence-tiebreakRungs");
  await expect(list).toBeVisible();
  const items = list.locator("li");
  const rungs = await items.count();
  expect(rungs, "the default list has every rung").toBe(3);
  for (let i = 0; i < rungs; i++) {
    const buttons = items.nth(i).locator("button");
    const b = await buttons.count();
    expect(b, "up, down and remove").toBe(3);
    for (let j = 0; j < b; j++) if (!(await buttons.nth(j).isDisabled())) await assertTapFloor(buttons.nth(j), `chess rung ${i} button ${j}`);
  }
  // Empty it: the add menu and the reset hold the floor too, and the empty line fits.
  for (let i = 0; i < rungs; i++) await items.first().locator("button").last().click();
  await expect(crow.getByTestId("stage-rule-sequence-tiebreakRungs-empty")).toBeVisible();
  await assertTapFloor(crow.getByTestId("stage-rule-sequence-tiebreakRungs-add"), "chess add rung");
  await assertTapFloor(crow.getByTestId("stage-rule-sequence-tiebreakRungs-reset"), "chess use default order");
  await assertTapFloor(crow.getByTestId("stage-format-save"), "chess Save rules");
  const cclip = await overflowingIn(page, `[data-testid="stage-format-row-${chess.stageId}"]`, "*", "the chess rules row is missing");
  expect(cclip.clipped, `nothing in the chess row is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  if (shots) await crow.screenshot({ path: `${shots}/chess-sequence-${projectWidth}.png` });
  const chessHere = await editorControls(crow);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(chessHere, `the chess editor's control set at ${projectWidth} vs 1280`).toEqual(await editorControls(crow));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- the DIVISION door: the same ordered list in the division's Settings (review I-2), phone-first too ---------------------
  const dcomp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T17 division-seq ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(dcomp.status, `competition: ${JSON.stringify(dcomp.error)}`).toBeLessThan(300);
  const ddiv = await apiJson<{ id: string }>(request, `/api/v1/competitions/${dcomp.data!.id}/divisions`, "POST", {
    name: "division sequence",
    sport_key: "boardgame",
    variant_key: "blitz",
    config: { tiebreakRungs: ["rapid", "blitz"] },
  });
  expect(ddiv.status, `division: ${JSON.stringify(ddiv.error)}`).toBeLessThan(300);
  await page.goto(await divisionPath(page.request, ddiv.data!.id, "?tab=settings"), { waitUntil: "load" });
  await page.getByRole("button", { name: /Format/ }).click();
  const dlist = page.getByTestId("stage-rule-sequence-tiebreakRungs");
  await expect(dlist).toBeVisible({ timeout: 20_000 });
  const ditems = dlist.locator("li");
  expect(await ditems.count(), "the division's stored list, two rungs").toBe(2);
  for (let i = 0; i < 2; i++) {
    const buttons = ditems.nth(i).locator("button");
    for (let j = 0; j < (await buttons.count()); j++) if (!(await buttons.nth(j).isDisabled())) await assertTapFloor(buttons.nth(j), `division rung ${i} button ${j}`);
  }
  await assertTapFloor(page.getByTestId("stage-rule-sequence-tiebreakRungs-reset"), "division use default order");
  await expectNoHorizontalScroll(page);
  if (shots) await dlist.screenshot({ path: `${shots}/division-sequence-${projectWidth}.png` });
});

test("W2c stage points section at every width: the sentence, More, the walkover row, the bonus menu and Save hold the 44px floor, nothing clips or scrolls, the visible control set matches 1280, and the refusal card fits", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = async (sport: string, variant: string | undefined, label: string, config?: Record<string, unknown>): Promise<{ divisionId: string; stageId: string }> => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `W2c T18 ${label} ${TAG}-${testInfo.project.name}`,
      visibility: "private",
    });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: `${label} division`,
      sport_key: sport,
      ...(variant === undefined ? {} : { variant_key: variant }),
      ...(config === undefined ? {} : { config }),
    });
    expect(div.status, `division ${sport}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
    expect(stage.status, `stage ${sport}: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
    return { divisionId: div.data!.id, stageId: stage.data!.id };
  };
  const projectWidth = page.viewportSize()!.width;
  /** The section's visible controls in DOM order (the phone toggle left out: it is the one phone-only control), by testid. */
  const visibleControls = (section: Locator) =>
    section.evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((el) => el.getAttribute("data-role") !== "phone-disclosure-toggle")
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => el.getAttribute("data-testid") ?? el.tagName),
    );
  const openMoreHere = async (section: Locator): Promise<void> => {
    const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
    if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };

  // --- football: the editor ---------------------------------------------------------------------------------------------
  const footballVariant = Object.keys(builtinModules.find((m) => m.key === "football")!.variants)[0]!;
  const fb = await seed("football", footballVariant, "football", { points: { win: 4, draw: 2, loss: 1 } });
  await page.goto(await divisionPath(page.request, fb.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = page.getByTestId(`stage-points-${fb.stageId}`);
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  await assertTapFloor(section.locator("label").first(), "Use the division's points");
  await section.getByTestId("stage-points-use-division").uncheck();
  for (const id of ["stage-points-win", "stage-points-draw", "stage-points-loss"]) await assertTapFloor(section.getByTestId(id), id);
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  const phone = projectWidth < 768;
  expect(await toggle.isVisible(), `More is a phone control (${projectWidth})`).toBe(phone);
  if (phone) {
    await assertTapFloor(toggle, "More");
    await expect(section.getByTestId("stage-points-walkover-w"), "the walkover row is folded on a phone").toBeHidden();
  }
  await openMoreHere(section);
  for (const id of ["stage-points-walkover-w", "stage-points-walkover-l", "stage-points-award-w", "stage-points-award-l", "stage-points-bonus-add"]) await assertTapFloor(section.getByTestId(id), id);
  await section.getByTestId("stage-points-bonus-add").selectOption({ index: 1 });
  await expect(section.getByTestId("stage-points-bonus-0")).toBeVisible();
  await assertTapFloor(section.getByTestId("stage-points-bonus-points-0"), "bonus points");
  await assertTapFloor(section.getByTestId("stage-points-bonus-remove-0"), "remove bonus");
  await section.getByTestId("stage-points-win").fill("5");
  await assertTapFloor(section.getByTestId("stage-points-save"), "Save points");
  const clip = await overflowingIn(page, `[data-testid="stage-points-${fb.stageId}"]`, "*", "the stage points section is missing");
  expect(clip.clipped, `nothing in the points section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  const here = await visibleControls(section);
  expect(here.length, "the section's controls were read").toBeGreaterThan(8);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMoreHere(section);
  expect(here, `the points section's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(section));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- ice hockey (a division that scores overtime separately): the editor states the split (W2d T16 retired T10 fix round 1
  // I2's not-yet card). The overtime boxes hold the floor, nothing clips, the control set is 1280's. The splitting variant is
  // the rulebooks' (`_points-split-rulebook.ts`).
  const hockey = builtinModules.find((m) => m.key === "icehockey")!;
  const splitVariant = Object.keys(hockey.variants).find((v) => RULEBOOK_SPLITS[`icehockey/${v}`] !== undefined);
  expect(splitVariant, "premise: the rulebooks split an ice-hockey variant (iihf)").toBeDefined();
  const ih = await seed("icehockey", splitVariant, "icehockey");
  await page.goto(await divisionPath(page.request, ih.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  const card = page.getByTestId(`stage-points-${ih.stageId}`);
  await expect(card).toHaveAttribute("data-stage-points-state", "editor", { timeout: 20_000 });
  await expect(card.getByTestId("stage-points-row-win-ot"), "the overtime row is on the card").toBeVisible();
  await card.getByTestId("stage-points-use-division").uncheck();
  for (const id of ["stage-points-win", "stage-points-win-ot", "stage-points-loss-ot", "stage-points-loss"]) await assertTapFloor(card.getByTestId(id), `ice hockey ${id}`);
  const cclip = await overflowingIn(page, `[data-testid="stage-points-${ih.stageId}"]`, "*", "the ice hockey section is missing");
  expect(cclip.clipped, `nothing in the ice hockey section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  await openMoreHere(card); // the walkover row and bonuses are folded on a phone; 1280 shows them (class 22)
  const ihHere = await visibleControls(card);
  expect(ihHere, "the overtime boxes are among the controls read").toEqual(expect.arrayContaining(["stage-points-win-ot", "stage-points-loss-ot"]));
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(ihHere, `the ice hockey editor's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(card));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- the same division, a stage that STORES a flat rule (a row from before the guard): the editor opens at it with the
  // refusal inline; the refusal line wraps inside the card, nothing clipped, the same control set as 1280 -----------------
  await withDb(async (sql) => {
    await sql`update stages set config = config || ${sql.json({ points: { win: { regulation: 4 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } } })} where id = ${ih.stageId}`;
  });
  await page.reload({ waitUntil: "load" });
  const legacy = page.getByTestId(`stage-points-${ih.stageId}`);
  await expect(legacy).toHaveAttribute("data-stage-points-basis", "own", { timeout: 20_000 });
  await expect(legacy.getByTestId("stage-points-refusal"), "the refusal is on the card").toBeVisible();
  await assertTapFloor(legacy.getByTestId("stage-points-use-division").locator("xpath=ancestor::label[1]"), "Use the division's points (ice hockey)");
  const lclip = await overflowingIn(page, `[data-testid="stage-points-${ih.stageId}"]`, "*", "the stored-rule section is missing");
  expect(lclip.clipped, `nothing in the stored-rule section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  await openMoreHere(legacy);
  const legacyHere = await visibleControls(legacy);
  expect(legacyHere.length, "the stored-rule editor's controls were read").toBeGreaterThan(3);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(legacyHere, `the stored-rule editor's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(legacy));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });
});

// W2d Task 15 (spec §9 "Tie-breaks"): the stage's Tie-breaks section at every width. One DOM, branched: the heading, the badge
// and the lock line stay visible, the ordered list folds behind ONE phone disclosure below md (AGENTS.md class 22: wait on
// `toBeAttached`, open the fold only where its toggle is the visible kind). The evidence: the list's controls (the arrows,
// remove, "+ Add step", Reset, Save) hold the 44px floor, nothing clips or scrolls, the visible control set (membership,
// order, repeats) is 1280's, and a started stage's lock line fits with no control left.
test("W2d stage Tie-breaks section at every width: the fold opens, the arrows, remove, add, reset and Save hold the 44px floor, nothing clips or scrolls, the control set matches 1280, and the locked state fits", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const projectWidth = page.viewportSize()!.width;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2d T15 tie-breaks ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "tie-breaks division",
    sport_key: "football",
    variant_key: "11-a-side",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, [`Asha FC ${TAG}`, `Bala FC ${TAG}`, `Chen FC ${TAG}`], "team");
  expect(added.status, "entrants").toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool A" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  const stageId = stage.data!.id;

  /** The section's visible controls in DOM order (the phone toggle left out: it is the one phone-only control), by testid. */
  const visibleControls = (root: Locator) =>
    root.evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((c) => c.getAttribute("data-role") !== "phone-disclosure-toggle")
        .filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(c).visibility !== "hidden";
        })
        .map((c) => c.getAttribute("data-testid") ?? c.tagName),
    );
  const openFold = async (root: Locator): Promise<void> => {
    const toggle = root.locator('[data-role="phone-disclosure-toggle"]');
    if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };

  await page.goto(await divisionPath(page.request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = page.getByTestId(`stage-tiebreaks-${stageId}`);
  await expect(section).toBeAttached({ timeout: 20_000 });
  await expect(section).toHaveAttribute("data-state", "editor");
  await expect(section.getByTestId("stage-tiebreaks-badge"), "the badge stays outside the fold").toBeVisible();
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  const phone = projectWidth < 768;
  expect(await toggle.isVisible(), `the fold's toggle is a phone control (${projectWidth})`).toBe(phone);
  if (phone) {
    await assertTapFloor(toggle, "Show the order");
    await expect(section.getByTestId("stage-tiebreaks-list"), "the list is folded on a phone").toBeHidden();
  }
  await openFold(section);
  await expect(section.getByTestId("stage-tiebreaks-list")).toBeVisible();
  // A middle step moves: its arrows and remove on the floor (the first and last steps are pinned and carry none).
  const rows = section.locator('[data-testid^="stage-tiebreaks-row-"]');
  const n = await rows.count();
  expect(n, "the order has middle steps").toBeGreaterThan(2);
  for (const id of ["stage-tiebreaks-down-1", "stage-tiebreaks-remove-1", "stage-tiebreaks-up-2", "stage-tiebreaks-reset"]) await assertTapFloor(section.getByTestId(id), id);
  await section.getByTestId("stage-tiebreaks-remove-1").click(); // a step removed: "+ Add step" offers it back, Save shows
  await assertTapFloor(section.getByTestId("stage-tiebreaks-add"), "+ Add step");
  await assertTapFloor(section.getByTestId("stage-tiebreaks-save"), "Save order");
  const clip = await overflowingIn(page, `[data-testid="stage-tiebreaks-${stageId}"]`, "*", "the tie-breaks section is missing");
  expect(clip.clipped, `nothing in the tie-breaks section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  const here = await visibleControls(section);
  expect(here.length, "the section's controls were read").toBeGreaterThan(5);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(here, `the tie-breaks section's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls(section));
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // Generated and a first match started: the server lists the stage (`formatLockedStageIds`) — the lock line names it, the
  // order is still listed, and no control is left at any width.
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start division: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const first = await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(first.status, `start match: ${JSON.stringify(first.error)}`).toBe(201);
  await page.reload({ waitUntil: "load" });
  const locked = page.getByTestId(`stage-tiebreaks-${stageId}`);
  await expect(locked).toHaveAttribute("data-state", "locked", { timeout: 20_000 });
  await expect(locked.getByTestId("stage-tiebreaks-locked")).toBeVisible();
  await openFold(locked);
  await expect(locked.getByTestId("stage-tiebreaks-list")).toBeVisible();
  expect(await visibleControls(locked), "locked: no control").toEqual([]);
  const lclip = await overflowingIn(page, `[data-testid="stage-tiebreaks-${stageId}"]`, "*", "the locked tie-breaks section is missing");
  expect(lclip.clipped, `nothing in the locked section is clipped at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
});

// W2c Task 19 (S2, S4): the match rules block on the fixture console, and the run sheet's "Format changed" chip, at every
// width. One DOM, branched with `max-md:*` (AGENTS.md "The phone composition") - the block lives inside ONE phone
// disclosure: folded below md until its toggle is tapped, a plain card from md up. So the evidence is: the block is ATTACHED
// at every width (class 22: wait on `toBeAttached`, and open the fold only when its toggle is the visible kind - at 768/834
// the toggle is `md:hidden`), its controls hold the 44px floor and are hit-testable (`elementFromPoint`, not paint), nothing
// clips or scrolls, and the visible control SET (membership, order, repeats) is the one 1280 shows. The states are the
// product's: unstarted, changed, a live match behind "Correct format", and a finished one with its lock.
test("W2c match rules block at every width: the fold opens, the controls hold the 44px floor, nothing clips or scrolls, the control set matches 1280, and the live, locked and run-sheet states fit", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const projectWidth = page.viewportSize()!.width;
  const m = builtinModules.find((x) => x.key === "badminton")!;
  const variant = Object.keys(m.variants)[0]!;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T19 ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Match rules widths",
    sport_key: "badminton",
    variant_key: variant,
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["Mr Alpha", "Mr Bravo", "Mr Charlie"].map((n) => `${n} ${TAG}-${testInfo.project.name}`));
  expect(added.ids).toHaveLength(3);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a league of three plays three matches").toBe(3);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const [unstarted, live, finished] = fixtureIds as [string, string, string];

  const block = page.getByTestId("match-rules-block");
  /** The block's visible controls in DOM order, by the field block they sit in (the phone toggle is not the block's). */
  const visibleControls = () =>
    block.evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => `${el.closest("[data-testid]")?.getAttribute("data-testid") ?? "-"}:${el.tagName}`),
    );
  /** Class 22: attached first, then open the fold only when its toggle is the visible kind. */
  const openFold = async (): Promise<void> => {
    await expect(block, "the block is attached at every width").toBeAttached({ timeout: 20_000 });
    const toggle = page.locator('[data-role="phone-disclosure"]:has([data-testid="match-rules-block"]) > [data-role="phone-disclosure-toggle"]');
    expect(await toggle.isVisible(), `the fold is a phone control (${projectWidth})`).toBe(projectWidth < 768);
    if (await toggle.isVisible()) {
      await assertTapFloor(toggle, "Match rules toggle");
      await expect(block, "folded on a phone until the toggle is tapped").toBeHidden();
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    await expect(block).toBeVisible({ timeout: 20_000 });
  };
  const fits = async (label: string): Promise<void> => {
    const clip = await overflowingIn(page, '[data-testid="match-rules-block"]', "*", "the match rules block is missing");
    expect(clip.clipped, `${label}: nothing in the block is clipped at ${projectWidth}`).toEqual([]);
    await expectNoHorizontalScroll(page);
    const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(dims.scroll, `${label} ${projectWidth}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
  };
  const go = async (id: string): Promise<void> => {
    await page.goto(await fixturePath(request, id), { waitUntil: "load" });
    await dismissCookieBanner(page);
  };

  // --- unstarted: the form -----------------------------------------------------------------------------------------------
  await go(unstarted);
  await openFold();
  const bestOf = block.getByTestId("stage-rule-field-bestOf").getByRole("combobox");
  await assertTapFloor(bestOf, "best of");
  for (const f of await block.locator("select, input").all()) await assertTapFloor(f, "a match field");
  await bestOf.selectOption("1");
  await assertTapFloor(block.getByTestId("match-rules-save"), "Save");
  await fits("unstarted");
  const unstartedHere = await visibleControls();
  expect(unstartedHere.length, "the block's controls were read").toBeGreaterThan(4);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(unstartedHere, `unstarted: the block's visible control set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await visibleControls());
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- changed: the chip, the reset, and the chip on the phone's closed row ---------------------------------------------
  const put = await apiJson(request, `/api/v1/fixtures/${unstarted}/rules`, "PUT", { rules: { bestOf: 1 } });
  expect(put.status, JSON.stringify(put.error)).toBe(200);
  await go(unstarted);
  await openFold();
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible();
  await assertTapFloor(block.getByTestId("match-rules-reset"), "Use stage rules");
  await fits("changed");
  const changedHere = await visibleControls();
  expect(changedHere, "premise: the reset joined the form's controls").toContain("match-rules-reset:BUTTON");
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(changedHere, `changed: the block's visible control set at ${projectWidth} vs 1280`).toEqual(await visibleControls());
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });

  // --- the run sheet (before any play: once a stage has started its Fixtures tab folds the list behind "View fixtures"): the chip
  // is on the changed row only, inside the viewport ----------------------------------------------------------------------
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const chip = page.getByTestId("run-sheet-format-changed");
  await expect(chip, "exactly the changed match is tagged").toHaveCount(1, { timeout: 20_000 });
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  expect(box, "the chip has a box").not.toBeNull();
  expect(box!.x, "the chip starts inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "the chip ends inside the viewport").toBeLessThanOrEqual(page.viewportSize()!.width);
  await expectNoHorizontalScroll(page);

  // --- live: the form stays behind "Correct format", then opens with its warning ---------------------------------------
  const start = await apiJson(request, `/api/v1/fixtures/${live}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(start.status, JSON.stringify(start.error)).toBe(201);
  await go(live);
  await openFold();
  await assertTapFloor(block.getByTestId("match-rules-correct"), "Correct format");
  await expect(block.getByTestId("stage-rule-field-bestOf")).toHaveCount(0);
  await fits("live (closed)");
  await block.getByTestId("match-rules-correct").click();
  await expect(block.getByTestId("match-rules-warning")).toBeVisible();
  await assertTapFloor(block.getByTestId("stage-rule-field-bestOf").getByRole("combobox"), "best of (live)");
  await fits("live (open)");

  // --- finished: the lock sentence, no controls -----------------------------------------------------------------------
  const fixtureRead = await apiJson<{ home_entrant_id: string }>(request, `/api/v1/fixtures/${finished}`);
  let seq = 0;
  for (const [type, payload] of [["core.forfeit", { by: fixtureRead.data!.home_entrant_id, reason: "walkover" }], ["core.finalize", {}]] as const) {
    const r = await apiJson(request, `/api/v1/fixtures/${finished}/events`, "POST", { expected_seq: seq++, type, payload });
    expect(r.status, `${type}: ${JSON.stringify(r.error)}`).toBe(201);
  }
  await go(finished);
  await openFold();
  await expect(block.getByTestId("match-rules-locked")).toBeVisible();
  await expect(block.locator("select, input, button")).toHaveCount(0);
  await fits("locked");
});

// W2c Task 20 (S4): the division settings' lock lines at every width. A started stage makes the match-rule fields read-only and
// puts one line under each ("Locked: Pool A has started and plays this format"). The lines are plain text in the existing
// field grid - no second phone tree - so the evidence is that every line is on screen, readable (its text is not clipped by its
// own box), inside the viewport, that nothing scrolls the page sideways, and that the SET of lines (membership, order, repeats)
// is the one 1280 shows. Owner 2026-10-20: the settings tab is being redesigned, so no design bar here beyond "readable, no
// scroll, same set".
test("W2c division lock lines at every width: each line is on screen and readable, nothing scrolls, and the line set matches 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const projectWidth = page.viewportSize()!.width;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T20 ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Lock lines widths",
    sport_key: "badminton",
    variant_key: "short",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["Ms Alpha", "Ms Bravo", "Ms Charlie"].map((n) => `${n} ${TAG}-${testInfo.project.name}`));
  expect(added.ids).toHaveLength(3);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "Pool A" });
  expect(fixtureIds.length, "a league of three plays three matches").toBe(3);
  const divStarted = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(divStarted.status, JSON.stringify(divStarted.error)).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]!}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(started.status, JSON.stringify(started.error)).toBe(201);

  await page.goto(await divisionPath(request, div.data!.id, "?tab=settings"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /^Format/ }).click();

  const lines = page.locator('[data-testid^="division-locked-"]');
  // One per badminton field plus the variant (the fields are the form's own table, not a number typed here).
  const expectedLines = SPORT_RULES.badminton!.length + 1;
  await expect(lines, "every locked field says so").toHaveCount(expectedLines, { timeout: 20_000 });
  const ids = (): Promise<string[]> => lines.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!));
  const here = await ids();

  for (let i = 0; i < expectedLines; i++) {
    const line = lines.nth(i);
    await line.scrollIntoViewIfNeeded();
    await expect(line, `line ${here[i]} is visible at ${projectWidth}`).toBeVisible();
    expect((await line.innerText()).trim().length, `line ${here[i]} has words`).toBeGreaterThan(10);
    const box = (await line.boundingBox())!;
    expect(box.x, `${here[i]} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${here[i]} ends inside the viewport`).toBeLessThanOrEqual(page.viewportSize()!.width);
    const clip = await line.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(clip, `${here[i]}'s words are not clipped by their own box`).toBeLessThanOrEqual(1);
  }
  await expectNoHorizontalScroll(page);
  const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(dims.scroll, `scrollWidth ${dims.scroll} within clientWidth ${dims.client} at ${projectWidth}`).toBeLessThanOrEqual(dims.client);

  await page.setViewportSize({ width: 1280, height: 900 });
  expect(here, `the lock line set at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await ids());
  await page.setViewportSize({ width: projectWidth, height: page.viewportSize()!.height });
});

// The Arbiter Panel's round column (phase 2, spec 2026-10-24-arbiter-round-column-design.md §5.1, §7; C27): at this project's REAL
// width. Below md the column is the first thing on the page, then the waiting seats, then the board picker; from md `main` is two
// tracks and the column is the right-hand one, with the decision area under the camera and above the waiting list (Task 16 D4). Asserted as the order and the edges of what is
// on screen, not as box sizes, so a groomed shrink of the desktop layout cannot pass for the phone composition. Every control in the
// column and in the waiting list is at least 44px and HIT-TESTED (the paint box is not the tap area), nothing scrolls the page
// sideways, and the visible control set of `main` is the one 1280 shows from the same seed, apart from the two controls that exist
// at one width only: the picker (below lg) and the board list (lg and up). Nothing in the column is folded behind a disclosure.
//
// mobile.spec.ts is a SERIAL file (`describe.configure({ mode: "serial" })`): a red test aborts the rest of its project, so a CI
// count for this file is a floor, not a total (AGENTS class 21). This test seeds its own round and reads nothing an earlier test left.
test("arbiter round column: below md the column leads the page; from md it is the right-hand column; no horizontal scroll; 44px targets", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const phone = width < 768;
  // Two boards, the first with two realistic 43-character names (a long name is what breaks a column), the second held by a mismatch so
  // the queue has a card to review: the column has its queue, its hero and its waiting list at once. `camera: optional` puts the tile
  // on screen with no camera duty.
  const r = await seedOnlineRound(request, [longName(), longName(), `Mo Phone ${TAG}`, `Ny Width ${TAG}`], { camera: "optional" });
  expect(r.boards.length, "premise: two boards").toBe(2);
  const heldBoards = [r.boards[1]!];
  for (const b of heldBoards) await roundGameSql(b, { moves: ["e2e4", "e7e5"], hold: "mismatch" });
  // The waiting list lists the boards still checking in: the ones not held. Derived from the seed, not read back from the page.
  const waitingRows = r.boards.length - heldBoards.length;
  expect(waitingRows, "premise: the seed leaves one board checking in").toBe(1);

  await page.goto(r.arbiterPath, { waitUntil: "load" });
  const col = page.getByTestId("arbiter-round-column");
  const waiting = page.getByTestId("arbiter-waiting");
  await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
  await expect(waiting, "premise: board 1 is waiting for its seats").toBeVisible({ timeout: 30_000 });
  // Two scopes, not one: the panel mounts the waiting list in its board group, OUTSIDE the column's `aside` (spec §5.1). Every scan
  // below names which of the two it reads, and each is proved non-empty for its own scope. The negative (nothing of the list inside the
  // aside) is paired with the positive just above and the row count that follows.
  await expect(col.getByTestId("arbiter-waiting"), "the waiting list is not inside the column").toHaveCount(0);
  await expect(waiting.getByTestId("arbiter-waiting-row"), "one row for each board still checking in").toHaveCount(waitingRows);
  await expect(col.getByTestId("arbiter-column-review"), "premise: the held board has a card to review").toBeVisible();
  // The decision area is measured below (tablet: above the waiting list). It renders for the board on screen only when that board has
  // something to offer; the panel opens on the FIRST board, which the seed leaves checking in with its round open, so "+5 min" (or the
  // reason it is not offered) and "Settle the result now" are there. Said as a premise, so a seed that stops offering either fails here by
  // name instead of as "the decision area is not on screen" at the measurement.
  await expect(page.getByTestId("arbiter-decision"), "premise: the board on screen (board 1, checking in) has a decision area").toBeVisible();
  // The panel's own `main`: the one that holds the column (the page has no other, but the scope is stated, not assumed).
  const panelMain = page.locator('main:has([data-testid="arbiter-round-column"])');
  await expect(panelMain.locator("figure"), "premise: the camera tile is on screen").toHaveCount(1);
  const phase = await col.getAttribute("data-phase");

  // ── where things are ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  const rects = await page.evaluate(() => {
    const at = (el: Element | null | undefined) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY, left: b.left, right: b.right };
    };
    return {
      aside: at(document.querySelector('[data-testid="arbiter-round-column"]')),
      waiting: at(document.querySelector('[data-testid="arbiter-waiting"]')),
      picker: at(document.querySelector('[data-testid="arbiter-round-column"]')?.closest("main")?.querySelector("select")?.closest("label")),
      decision: at(document.querySelector('[data-testid="arbiter-decision"]')),
      camera: at(document.querySelector('[data-testid="arbiter-round-column"]')?.closest("main")?.querySelector("figure")),
    };
  });
  function need<T>(v: T | null, what: string): T {
    expect(v, `${what} is on screen at ${width}px`).not.toBeNull();
    return v!;
  }
  const aside = need(rects.aside, "the column");
  const wait = need(rects.waiting, "the waiting list");
  const camera = need(rects.camera, "the camera tile");
  const relations: string[] = [];
  const holds = (ok: boolean, what: string) => {
    expect(ok, `${what} at ${width}px`).toBe(true);
    relations.push(what);
  };
  if (phone) {
    const picker = need(rects.picker, "the board picker");
    holds(aside.top < picker.top, "the column's top is above the picker's top");
    holds(wait.top >= aside.bottom - 1, "the waiting list starts below the column");
    holds(wait.bottom <= picker.top + 1, "the waiting list ends above the picker");
  } else {
    // 768 and 834 are md and not lg (lg is 1024): two tracks, the board then the decision then the waiting list in the first, the column in
    // the second. (The panel's two groups are `display: contents` here and have no box to measure, so the boxes that are drawn are read:
    // the camera, the decision area and the list. Task 16 D4: the decision area sits ABOVE the list, not below the whole of it.)
    expect(width, "premise: the tablet widths are md, not lg").toBeLessThan(1024);
    const decision = need(rects.decision, "the decision area");
    holds(aside.left >= camera.right - 1, "the column is right of the camera");
    holds(aside.left >= decision.right - 1, "the column is right of the decision area");
    holds(decision.top >= camera.bottom - 1, "the decision area is below the camera");
    holds(decision.bottom <= wait.top + 1, "the decision area is above the waiting list");
    holds(wait.top >= camera.bottom - 1, "the waiting list is under the camera");
    // The waiting list is in the board track, not the column's: its right edge stops short of the column's left (the relation the
    // box-measuring version of this branch checked as "the column is right of the board group", which the list was part of).
    holds(aside.left >= wait.right - 1, "the column is right of the waiting list");
  }
  const expectedRelations = phone ? 3 : 6;
  expect(relations.length, "anti-vacuity: every relation of this branch was checked").toBe(expectedRelations);

  // ── the sideways scroll, and what overflows inside the column ─────────────────────────────────────────────────────────────────────
  // `expectNoHorizontalScroll` is the gate: it lifts `html, body { overflow-x: clip }` (globals.css) before it measures. A raw
  // `documentElement.scrollWidth <= clientWidth` beside it was removed because it cannot fail under that clip, so it only looked
  // like a second proof. What overflows INSIDE the column is the scan below.
  await expectNoHorizontalScroll(page);
  // A box whose extra content cannot be reached is a defect; one that scrolls is a feature that must be a tab stop (AGENTS class 23).
  let scanned = 0;
  for (const root of ['[data-testid="arbiter-round-column"]', '[data-testid="arbiter-waiting"]']) {
    const { clipped, scrollable } = await overflowingIn(page, root, "button,a,p,span,li,h2,div", `${root} was not in the DOM`);
    expect(clipped, `${root} clips content at ${width}px`).toEqual([]);
    for (const box of scrollable) expect(box, `${root}: a scrolling box that is not keyboard-reachable`).toMatch(/tabindex=0$/);
    scanned += 1;
  }
  expect(scanned, "anti-vacuity: the column and the waiting list were both scanned").toBe(2);

  // ── 44px, measured and hit-tested ──────────────────────────────────────────────────────────────────────────────────────────────────
  const tapTargets = (scope: string) =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      return Array.from(root.querySelectorAll<HTMLElement>("button, a[href]")).map((el) => {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const b = el.getBoundingClientRect();
        const shown = b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
        const hit = shown ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
        return {
          testid: el.getAttribute("data-testid"),
          name: (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
          role: el.tagName.toLowerCase(),
          disabled: (el as HTMLButtonElement).disabled === true,
          width: Math.round(b.width * 100) / 100,
          height: Math.round(b.height * 100) / 100,
          shown,
          reachable: hit !== null && (hit === el || el.contains(hit)),
        };
      });
    }, scope);
  const counts: string[] = [];
  // [label, scope, the control that scope must offer, how many of it]: the hero's one press in the column, one board link per row in the list.
  const scopes: [string, string, string, number][] = [
    ["the column", '[data-testid="arbiter-round-column"]', "arbiter-column-reinvite", 1],
    ["the waiting list", '[data-testid="arbiter-waiting"]', "arbiter-waiting-board", waitingRows],
  ];
  for (const [label, scope, mustHave, mustHaveCount] of scopes) {
    const all = await tapTargets(scope);
    expect(all, `${label} is in the DOM`).not.toBeNull();
    const shown = all!.filter((t) => t.shown);
    expect(shown.length, `anti-vacuity: ${label} has controls on screen at ${width}px`).toBeGreaterThan(0);
    expect(shown.map((t) => t.testid), `${label} offers ${mustHave}`).toContain(mustHave);
    expect(shown.filter((t) => t.testid === mustHave).length, `${label} offers ${mustHave} ${mustHaveCount} time(s) at ${width}px`).toBe(mustHaveCount);
    const report = hitTargetFloorReport(shown.map((t) => ({ name: t.name, role: t.role, disabled: t.disabled, width: t.width, height: t.height })));
    expect(report.operable.length, `anti-vacuity: ${label} has operable controls`).toBeGreaterThan(0);
    expect(floorViolationLines(report), `${label}: every control is at least ${HIT_TARGET_FLOOR_PX}px at ${width}px`).toEqual([]);
    const operable = shown.filter((t) => !t.disabled);
    expect(
      operable.filter((t) => !t.reachable).map((t) => t.name),
      `${label}: every control's centre hits the control itself at ${width}px (nothing covers it)`,
    ).toEqual([]);
    counts.push(`${label} ${report.operable.length} controls, ${operable.filter((t) => t.reachable).length} hit-tested`);
  }
  // The column's own controls, by what they are: the queue's Review and the hero's press (both in the column), the row's board link.
  await expect(col.getByTestId("arbiter-column-review")).toBeVisible();

  // ── the control set of `main`, against the same page at 1280 ─────────────────────────────────────────────────────────────────────
  const controlSet = () =>
    page.evaluate(() => {
      const column = document.querySelector('[data-testid="arbiter-round-column"]');
      const waiting = document.querySelector('[data-testid="arbiter-waiting"]');
      const main = column?.closest("main") ?? null;
      const nav = main?.querySelector("nav") ?? null;
      if (!main) return null;
      const keyOf = (el: HTMLElement) =>
        el.getAttribute("data-testid") ??
        el.getAttribute("aria-label") ??
        `${el.tagName.toLowerCase()}:${(el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}`;
      return Array.from(main.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"], input, textarea'))
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => ({ key: keyOf(el), picker: el.tagName === "SELECT", inNav: nav !== null && nav.contains(el), inColumn: column !== null && column.contains(el), inWaiting: waiting !== null && waiting.contains(el) }));
    });
  const here = await controlSet();
  expect(here, "main is on screen").not.toBeNull();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("navigation", { name: uiEn["arbiter.boardsHeading"] }), "at 1280 the board list is on screen").toBeVisible();
  const desk = await controlSet();
  expect(desk, "main is on screen at 1280").not.toBeNull();
  await page.setViewportSize(vp!);
  await expect(panelMain.locator("select"), "back at the project's width the picker is on screen").toBeVisible();
  await expectNoHorizontalScroll(page);

  const boardCount = r.boards.length;
  expect(here!.filter((c) => c.picker).length, `the picker is in the set below lg (${width}px)`).toBe(1);
  expect(here!.filter((c) => c.inNav).length, `the board list is not in the set below lg (${width}px)`).toBe(0);
  expect(desk!.filter((c) => c.picker).length, "the picker is not in the set at 1280").toBe(0);
  expect(desk!.filter((c) => c.inNav).length, "the board list has a button per board at 1280").toBe(boardCount);
  // Everything else is the same controls with the same repeats: MEMBERSHIP and REPEATS, as sorted multisets. Visual order is not
  // claimed here: it is the layout relations above, and with one DOM branched by Tailwind the source order is the same at both
  // widths by construction, so comparing it would prove nothing a width change could move.
  const multiset = (keys: string[]) => [...keys].sort();
  const same = (list: NonNullable<typeof here>) => multiset(list.filter((c) => !c.picker && !c.inNav).map((c) => c.key));
  expect(same(here!), `membership and repeats: the control set at ${width}px, less the picker, is the one 1280 shows, less its board list`).toEqual(same(desk!));
  expect(same(here!).length, "anti-vacuity: the set has controls in it").toBeGreaterThan(0);
  const inColumn = (list: NonNullable<typeof here>) => multiset(list.filter((c) => c.inColumn).map((c) => c.key));
  expect(inColumn(here!), "membership and repeats: the column's controls are the same at both widths").toEqual(inColumn(desk!));
  expect(inColumn(here!).length, "anti-vacuity: the column has controls at both widths").toBeGreaterThan(0);
  // The waiting list is its own scope (outside the aside), so the column's comparison above says nothing about it: it gets its own.
  const inWaiting = (list: NonNullable<typeof here>) => multiset(list.filter((c) => c.inWaiting).map((c) => c.key));
  expect(inWaiting(here!), "membership and repeats: the waiting list's controls are the same at both widths").toEqual(inWaiting(desk!));
  expect(inWaiting(here!).length, "anti-vacuity: the waiting list has controls at both widths").toBeGreaterThan(0);
  expect(here!.filter((c) => c.inColumn && c.inWaiting).length, "the two scopes share no control").toBe(0);

  console.log(
    `[arbiter-column ${width}px] data-phase=${phase}; ${relations.length}/${expectedRelations} layout relations held (${relations.join("; ")}); ${counts.join("; ")}; ` +
      `control set ${here!.length} at ${width}px vs ${desk!.length} at 1280 (column ${inColumn(here!).length} vs ${inColumn(desk!).length}, waiting list ${inWaiting(here!).length} vs ${inWaiting(desk!).length})`,
  );
});

// ── W2d Task 17: the public table's new columns at every width ─────────────────────────────────────────────────────────
//
// SPEC §5.7 (IIHF OTW/OTL, RBG:343-344; chess half-points, D10(b)). One ice hockey league of three under IIHF rules, seeded
// through the real event route: Ash beats Birch in overtime (an OTW for Ash, an OTL for Birch) and Birch beats Cedar in
// regulation. Both public tables — the division page and the hub's Table tab — print OTW and OTL at this width, and the
// OT result is in its own column, not in W. Nothing scrolls the page sideways; the division table's own sideways scroll
// is a reachable rail (a tab stop with a name, AGENTS class 23), never clipped content. This block seeds its own league
// and reads nothing an earlier test left (the file is serial: a red here is a floor for the count, class 21). Its helpers
// are imported inside the test, so the file's import block is untouched.
test("W2d T17 public standings: IIHF OTW/OTL columns on both public tables, no horizontal page scroll", async ({ page, request }) => {
  test.setTimeout(180_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const kit = await import("./spectator-w2-kit");
  const org = await kit.activeOrgSlug(request);
  const competition = await kit.publicCompetition(request, { name: `T17 OTW ${TAG} ${width}`, orgId: org.id });
  const div = await kit.division(request, competition.id, { name: "IIHF", sport_key: "icehockey", variant_key: "iihf" });
  const names = [`Ash Otw ${TAG}`, `Birch Otw ${TAG}`, `Cedar Otw ${TAG}`];
  const created = await addEntrantsViaApi(request, div.id, names, "team");
  expect(created.status, "the field was created").toBe(201);
  const [ash, birch, cedar] = created.ids as [string, string, string];
  const fixtures = await kit.leagueFixtures(request, div.id);
  const fx = (x: string, y: string) => {
    const f = fixtures.find((r) => [r.home_entrant_id, r.away_entrant_id].sort().join() === [x, y].sort().join());
    expect(f, "a fixture pairs them").toBeDefined();
    return f!.id;
  };
  const game = async (fixtureId: string, regulation: string[], overtime: string | null) => {
    const s = await kit.eventStream(request, fixtureId);
    await s.post("core.start", {});
    await s.post("icehockey.period.advance", { to: "P2" });
    for (const by of regulation) await s.post("icehockey.goal", { by });
    await s.post("icehockey.period.advance", { to: "P3" });
    await s.post("icehockey.period.advance", { to: "FT" });
    if (overtime !== null) await s.post("icehockey.goal", { by: overtime });
  };
  await game(fx(ash, birch), [ash, birch], ash); // 2-1 in overtime
  await game(fx(birch, cedar), [birch, birch, cedar], null); // 2-1 in regulation
  const otw = kit.dictString("en", "table.abbr.otw");
  const otl = kit.dictString("en", "table.abbr.otl");

  // ── the division page ──
  await page.goto(`/shared/${org.slug}/${competition.slug}/${div.slug}?tab=standings`, { waitUntil: "load" });
  const panel = page.locator("#panel-standings");
  await expect(panel).toBeVisible();
  const headers = await panel.locator('thead th span[aria-hidden="true"]').allInnerTexts();
  expect(headers, `the division table's header letters at ${width}px`).toEqual(expect.arrayContaining([otw, otl]));
  const cellsOf = async (name: string) =>
    panel.locator("tbody tr", { hasText: name }).first().locator("td").allInnerTexts();
  const col = (key: string) => headers.indexOf(key);
  // the header letters are the data columns only (# and Team carry none); a body row is td(rank), th(name), then a td per
  // data column — so data column i is td i + 1
  expect(col(otw), "premise: OTW is a column").toBeGreaterThanOrEqual(0);
  const ashCells = await cellsOf(names[0]!);
  expect(ashCells[col(otw) + 1]?.trim(), "Ash's overtime win is in OTW").toBe("1");
  expect(ashCells[col("W") + 1]?.trim(), "…and not in W").toBe("0");
  const birchCells = await cellsOf(names[1]!);
  expect(birchCells[col(otl) + 1]?.trim(), "Birch's overtime loss is in OTL").toBe("1");
  expect(birchCells[col("W") + 1]?.trim(), "Birch's regulation win is in W").toBe("1");
  await expectNoHorizontalScroll(page);
  const { clipped, scrollable } = await overflowingIn(page, "#panel-standings", "table,div,span,th,td", "the standings panel was not in the DOM");
  expect(clipped, `the division table clips content at ${width}px`).toEqual([]);
  for (const box of scrollable) expect(box, "a scrolling box that is not keyboard-reachable").toMatch(/tabindex=0$/);
  // Anti-vacuity (T17 fix 1, m6): at 320 the division table's nine columns do not fit, so the loop above checked a rail.
  if (width <= 320) expect(scrollable.length, "anti-vacuity: the 320 division table scrolls in a rail the loop checked").toBeGreaterThanOrEqual(1);

  // ── the hub's Table tab ──
  await page.goto(`/shared/${org.slug}/${competition.slug}?tab=table`, { waitUntil: "load" });
  const hub = page.getByTestId("mh-tab-panel-table");
  await expect(hub).toBeVisible();
  // T17 fix 1 (m2): on a phone the split table shows GP and Pts and folds W · OTW · OTL · L behind "Show all columns";
  // from md up nothing folds. Points stays on screen, inside the table's box, without a swipe (AGENTS #22: open the fold
  // only when its toggle is visible — at 768/834 it is md:hidden).
  const pts = hub.locator('th[data-col="points"]').first();
  await expect(pts).toBeVisible();
  const box = await hub.getByTestId(/-scroll$/).first().boundingBox();
  const ptsBox = await pts.boundingBox();
  expect(box && ptsBox, "the hub table and its Points header have boxes").toBeTruthy();
  expect(ptsBox!.x + ptsBox!.width, `Points ends inside the table's box at ${width}px`).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
  const more = hub.locator('[data-testid$="-more"]').first();
  if (await more.isVisible()) {
    await expect(hub.locator('th[data-col="otw"]').first(), "folded on a phone until asked").toBeHidden();
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
  }
  await expect(hub.locator('th[data-col="otw"]').first()).toBeVisible();
  await expect(hub.locator('th[data-col="otl"]').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  console.log(`[t17-otw ${width}px] division headers ${headers.join(" ")}; Ash ${ashCells.join(" ")}; scrollable ${scrollable.length}`);
});

// --- W2d T18 (HK-TB-2): the hockey goal-type question at every width ------------------------------------------------
// A hockey goal tap opens "What kind of goal?" before anything is queued (the engine refuses an untyped FIH goal,
// GOAL_KIND_REQUIRED). The question is a new surface in the dock slot, so it owes the pad's own width bar here: every
// choice and Cancel at the 44px floor and hit-testable by a finger, nothing clipped, no page scroll, and the same
// choices in the same order as 1280. Not folded behind a phone disclosure (class 22 does not apply): it is the dock.
test("hockey v3 pad (W2d T18): the goal-type question holds the 44px floor, hit-tests, clips nothing, does not scroll, and offers the 1280 choices in order", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(request, { ...v3SkinSeed("hockey", "HKT"), emitCoreStart: true });
  const projectWidth = page.viewportSize()!.width;
  const question = page.getByTestId("score-pad").getByTestId("pad-dock-choice");
  const controls = () =>
    question
      .locator('[data-testid^="pad-dock-chip-"], [data-testid="pad-dock-cancel"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!));
  const ask = async () => {
    await padTile(page, "goal-home").click();
    await expect(question, "a hockey goal tap opens the goal-type question").toBeVisible({ timeout: 20_000 });
  };

  await page.goto(await fixturePath(page.request, fx.fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await ask();
  const here = await controls();
  expect(here.length, "anti-vacuity: three goal types, Own goal and Cancel were read").toBeGreaterThanOrEqual(5);
  for (const id of here) await assertTapFloor(question.getByTestId(id), `goal-type question ${id} at ${projectWidth}`);
  const clip = await overflowingIn(page, '[data-testid="pad-dock-choice"]', "*", "the goal-type question is missing");
  expect(clip.clipped, `nothing in the question is clipped at ${projectWidth}`).toEqual([]);
  expect(clip.scrollable, `the question has no scroll rail at ${projectWidth}`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `${projectWidth}: scrollWidth ${widths.scroll} within clientWidth ${widths.client}`).toBeLessThanOrEqual(widths.client);
  await question.getByTestId("pad-dock-cancel").click();
  await expect(question).toHaveCount(0, { timeout: 5_000 });

  await page.setViewportSize({ width: 1280, height: 900 });
  await ask();
  expect(here, `the question's controls at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await controls());
  await question.getByTestId("pad-dock-cancel").click();
  await expect(question).toHaveCount(0, { timeout: 5_000 });
  // Asking twice and cancelling twice wrote nothing.
  const events = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
  expect(events.data!.filter((e) => e.type === "hockey.goal"), "a cancelled question writes no goal").toEqual([]);
  console.log(`[hockey goal-type ${projectWidth}px] ${here.length} controls hit-tested; scrollWidth ${widths.scroll}/${widths.client}`);
});
