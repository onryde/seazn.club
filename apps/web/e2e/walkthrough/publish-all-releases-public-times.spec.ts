// The organiser releases a whole competition's timetable, and a spectator who
// could only read "Time TBD" reads a kick-off time.
//
// WHY THIS FILE EXISTS. `apps/web` vitest is `environment: "node"`, so the two
// suites that already cover this feature are each blind to the thing it is FOR:
// `unreleased-banner.test.tsx` renders the banner outside the page that mounts
// it, and `competition-schedule-publish.test.ts` calls the use-case without the
// route, the button or the public surface. Both can be green while the seam
// between them is dead — the recurring failure class AGENTS.md #1 names, which
// has shipped six times in this repo. Only a browser can say that a person
// pressing that button makes a spectator see a time.
//
// THE CLAIM, in one line: `public_fixtures_v` NULLs `scheduled_at` for every
// fixture of a division at `status = 'setup'`
// (`V401__fixture_stream_url.sql:24`), so the hub prints "Time TBD" and files
// the match under "Unscheduled"; the competition board's Publish all is the
// only control that moves those divisions; and after it, the hub prints the
// instant that was seeded. The BEFORE half is not decoration — without it the
// spec cannot witness a change at all, only a state.
//
// AND THE PARTIAL CASE. Publish-all is deliberately best-effort, not atomic
// (`competition-schedule-publish.ts` decision 1), so the half that matters
// publicly is that a refused division keeps its times hidden while its
// neighbour's go live on the same page. Division B is refused for a REAL
// reason: its schedule window is narrowed — after its fixture is placed — to a
// day its fixture does not fall on, which `validateAssignments` reports as a
// `window` conflict and `isBlockingConflict` (calendar.ts:339) treats as
// blocking. The narrowing is a SETTINGS write, and deliberately so: the write
// gate `assertNoNewBlocking` (schedule.ts) refuses what a BOARD change
// introduces, so reaching for a double-booked court or a reversed feed order
// would mean asking a fixture PATCH to store the very thing that gate exists to
// refuse. `putScheduleSettings` runs no such gate — and `publishSchedule`'s own
// header says why its gate is absolute rather than delta-based: a settings
// change is one of the four things it names as able to invalidate a board
// between the organiser's last look and the publish. This spec drives that.
//
// PROVED NOT VACUOUS. Both tests pass, so the green is only worth what a
// mutation says it is: with `publishCompetitionSchedule`'s candidate query
// changed from `status = 'setup'` to `status = 'completed'` (nothing to
// publish, everything else untouched), test 2 reds on "Nothing was published."
// against the expected "Published 1 division." while test 1 stays green — i.e.
// the assertions run through the real button, route, use-case and database
// rather than being satisfied by the state the seed already left behind.
// Test 3 was killed the same way, with the mutation that IS its subject:
// deleting the candidate query's `exists (select 1 from fixtures ...)` clause
// — so the server releases the empty division the banner never counted — reds
// it on `published: Expected 1, Received 2`, the exact disagreement the case
// exists to catch, while tests 1 and 2 stay green.
//
// SEEDING. Setup reaches the state over the API (the folder's rule: "setup may
// use the API to REACH a state"). Every step that IS the thing under test —
// reading the hub, pressing Publish all, reading the hub again — is done
// through a browser.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { fmtPublicDate, fmtPublicTime } from "../../src/lib/format";
import {
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  seedVenueWithCourts,
  TAG,
} from "../helpers";
import { closeOpenContexts } from "../spectator-public-helpers";
import {
  API_CALL_MS,
  dictString,
  division,
  FLOOR_MS,
  LAND_SLACK_MS,
  mintSpectatorOrg,
  publicCompetition,
  spectator,
  STEP_MS,
  switchActiveOrg,
  uiString,
  w2Clock,
} from "../spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

// ---------------------------------------------------------------------------
// The instants, and the zone they are read in
// ---------------------------------------------------------------------------
//
// The division's own `tz` is PINNED rather than inherited, because both public
// loaders resolve the zone as `coalesce(ss.tz, o.timezone, 'UTC')`
// (`PutScheduleSettings.tz`'s own doc comment) — pinning it is what makes the
// expected string derivable at all instead of a guess about a fresh org's
// default.
//
// Both kick-offs are chosen so the LOCAL hour differs from the UTC hour: in
// June, Europe/London is BST (+1), so a spec that formatted in UTC — or a page
// that did — reads 12:30 against an expected 13:30 and fails. A same-hour
// instant would let that whole class of defect through.
const TZ = "Europe/London";
/** Day one, 13:30 BST. Division A — the one that publishes. */
const KICKOFF_A = "2027-06-05T12:30:00.000Z";
/** Day two, 15:45 BST. Division B — the one the gate refuses. */
const KICKOFF_B = "2027-06-06T14:45:00.000Z";
const COMP_STARTS_ON = "2027-06-05";
const COMP_ENDS_ON = "2027-06-06";
/** Division B's narrowed window: day ONE only, so its day-two fixture falls
 *  outside it. Inside the competition's own dates, which `putScheduleSettings`
 *  requires of any range it is asked to store (SCHEDULE_OUTSIDE_COMPETITION). */
const B_WINDOW_FROM = "2027-06-05T08:00:00.000Z";
const B_WINDOW_TO = "2027-06-05T17:00:00.000Z";

/** The hub's day-group key is the VENUE-local calendar date — `dayKeyInZone`
 *  (lib/matches-hub.ts) and its `en-CA` ISO-ordering trick, DERIVED here from
 *  the seeded instant rather than typed out, so moving a kick-off moves the
 *  section this spec looks in with it. */
function dayKeyOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
const DAY_A = dayKeyOf(KICKOFF_A);
const UNSCHEDULED = "unscheduled";

/** MIRRORS `matches-tab.tsx`'s own private `DAY_OPTS`. Copied rather than
 *  imported because the constant is module-private; if it is ever edited, this
 *  assertion is meant to red rather than quietly stop checking the heading —
 *  a public day heading changing shape is a copy change worth announcing. */
const DAY_HEADING_OPTS: Intl.DateTimeFormatOptions = {
  weekday: "long",
  day: "numeric",
  month: "long",
};

// ---------------------------------------------------------------------------
// Budgets, from the product's own clocks
// ---------------------------------------------------------------------------

/** The longest a publish may take to reach a spectator's next page load.
 *  `fireDivisionRevalidate` drops the hub's Next tags inside the request, so
 *  this is one ISR regeneration plus a loaded machine — not a poll interval. */
function publicLandMs(): number {
  const clock = w2Clock();
  return Math.max(FLOOR_MS, clock.revalidateFastMs + clock.hubIdlePollMs + LAND_SLACK_MS);
}

interface Rig {
  orgId: string;
  orgSlug: string;
  compId: string;
  compSlug: string;
  /** The division that publishes cleanly. */
  a: { id: string; name: string; fixtureId: string };
  /** The division the gate blocks. */
  b: { id: string; name: string; fixtureId: string };
}

let rig: Rig;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** One division with two entrants, a generated league fixture, one court in its
 *  settings and a pinned zone — and NOT started, so it stays at `setup`, which
 *  is the whole precondition. `leagueFixtures` in the W2 kit starts the
 *  division, which would move it out of `setup`; this deliberately does not. */
async function unreleasedDivision(
  request: APIRequestContext,
  compId: string,
  name: string,
  courtId: string,
  kickoff: string,
): Promise<{ id: string; name: string; fixtureId: string }> {
  const div = await division(request, compId, {
    name,
    sport_key: "generic",
    variant_key: "score",
  });
  const added = await addEntrantsViaApi(request, div.id, [`${name} Home`, `${name} Away`]);
  expect(added.status, `entrants for ${name}`).toBeLessThan(300);
  const { fixtureIds } = await createStageAndGenerate(request, div.id);
  expect(fixtureIds, `${name} generated no fixture`).toHaveLength(1);

  // The court has to be in the division's OWN settings, not merely referenced
  // by the fixture: `strandedCourtIdsForDivision` reports an assigned court the
  // division does not list, and a stranded-fixture conflict would refuse the
  // publish with PUBLISH_UNACKNOWLEDGED — a different refusal from the one this
  // spec is about, arriving on the division that is supposed to be clean.
  await putSettings(request, div.id, (config) => ({
    ...config,
    courts: [courtId],
    startAt: `${COMP_STARTS_ON}T00:00:00.000Z`,
    endAt: `${COMP_ENDS_ON}T22:00:00.000Z`,
  }));

  const placed = await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]!}`, "PATCH", {
    scheduled_at: kickoff,
    court_id: courtId,
  });
  expect(placed.status, `place ${name}: ${JSON.stringify(placed.error)}`).toBe(200);

  const status = await apiJson<{ status: string }>(request, `/api/v1/divisions/${div.id}`);
  expect(status.data?.status, `${name} must still be unreleased`).toBe("setup");
  return { id: div.id, name, fixtureId: fixtureIds[0]! };
}

/** Read-modify-write of a division's schedule settings. The PUT takes the WHOLE
 *  config, so anything not carried forward is erased; `tz` is sent on every
 *  call because it is tri-state and omitting it means "leave it alone". */
async function putSettings(
  request: APIRequestContext,
  divisionId: string,
  edit: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const read = await apiJson<{ config: Record<string, unknown> }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
  );
  expect(read.status, `read settings ${divisionId}`).toBe(200);
  const res = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: edit(read.data!.config),
    tz: TZ,
  });
  expect(res.status, `save settings ${divisionId}: ${JSON.stringify(res.error)}`).toBe(200);
}

// ---------------------------------------------------------------------------
// The public hub, as a spectator reads it
// ---------------------------------------------------------------------------

async function openMatches(page: Page): Promise<void> {
  await page.goto(`/shared/${rig.orgSlug}/${rig.compSlug}?tab=matches`);
  await expect(
    page.getByTestId("mh-tab-panel-matches"),
    "?tab=matches did not open the Matches tab",
  ).toBeVisible();
}

/** The card's own time slot — the last item of its meta row, which is where
 *  `match-card.tsx` renders either `fmtPublicTime` or `matchesHub.timeTbd`.
 *  Read as its own element rather than by scanning the whole card, so "13:30"
 *  appearing anywhere else on the card could never satisfy the assertion. */
function timeSlot(page: Page, fixtureId: string) {
  return page.getByTestId(`mh-match-${fixtureId}`).locator("span.ml-auto").first();
}

/** The `mh-day-*` section a fixture's card is filed under. */
function dayOf(page: Page, dayKey: string, fixtureId: string) {
  return page.getByTestId(`mh-day-${dayKey}`).getByTestId(`mh-match-${fixtureId}`);
}

// ---------------------------------------------------------------------------
// 1 — the state the feature exists to end
// ---------------------------------------------------------------------------

test("an unreleased competition shows the public Time TBD under Unscheduled", async ({
  request,
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 24 * API_CALL_MS + 2 * STEP_MS));

  const org = await mintSpectatorOrg(request, { name: `Publish All ${TAG}`, plan: "pro" });
  const comp = await publicCompetition(request, {
    name: `Release Weekend ${TAG}`,
    orgId: org.id,
    startsOn: COMP_STARTS_ON,
    endsOn: COMP_ENDS_ON,
  });
  const { courts } = await seedVenueWithCourts(request, ["Court 1", "Court 2"], { orgId: org.id });

  const a = await unreleasedDivision(request, comp.id, `Saturday ${TAG}`, courts[0]!.id, KICKOFF_A);
  const b = await unreleasedDivision(request, comp.id, `Sunday ${TAG}`, courts[1]!.id, KICKOFF_B);

  // Division B's board is made un-publishable AFTER its fixture is placed: the
  // window closes in front of a card that is already on it. See the header for
  // why it cannot be done the other way round.
  await putSettings(request, b.id, (config) => ({
    ...config,
    startAt: B_WINDOW_FROM,
    endAt: B_WINDOW_TO,
  }));

  rig = {
    orgId: org.id,
    orgSlug: org.slug,
    compId: comp.id,
    compSlug: comp.slug,
    a,
    b,
  };

  // --- the spectator's side, BEFORE anything is published -------------------
  const page = await spectator(browser, { width: 1280, height: 900 });
  await openMatches(page);

  const tbd = dictString("en", "matchesHub.timeTbd");
  for (const div of [a, b]) {
    await expect(
      timeSlot(page, div.fixtureId),
      `${div.name}: an unreleased division must not show a kick-off time`,
    ).toHaveText(tbd);
    await expect(
      dayOf(page, UNSCHEDULED, div.fixtureId),
      `${div.name}: an unreleased match must be filed under Unscheduled`,
    ).toHaveCount(1);
  }

  // The heading the two cards sit under, by its dictionary string — never the
  // English literal, which would pass on three locales' worth of nothing.
  await expect(
    page.getByTestId(`mh-day-${UNSCHEDULED}`).getByRole("heading", { level: 2 }),
  ).toHaveText(dictString("en", "matchesHub.unscheduled"));

  // And nothing is filed under the day either fixture is actually on.
  await expect(
    page.getByTestId(`mh-day-${DAY_A}`),
    "a day section exists for an unreleased division's own date",
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 2 — the organiser presses the button, and the spectator reads a time
// ---------------------------------------------------------------------------

test("Publish all gives the public a real kick-off time, and a blocked division keeps Time TBD", async ({
  page,
  browser,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 8 * API_CALL_MS + 6 * STEP_MS + publicLandMs()));

  // `page` and `request` have separate cookie jars, so the board's own context
  // has to be pointed at the org the rig was seeded into.
  await switchActiveOrg(page.request, rig.orgId);
  await page.goto(await competitionPath(page.request, rig.compId, "/schedule"));

  // --- the banner, and the count it states ---------------------------------
  const banner = page.getByTestId("board-unreleased-banner");
  await expect(banner, "the competition board offered no publish path at all").toBeVisible();
  await expect(
    page.getByTestId("board-unreleased-headline"),
    "the banner must count the unreleased divisions, not merely announce some",
  ).toHaveText(uiString("en", "board.publishAll.headline.other", { count: 2, total: 2 }));

  // The banner is a full sentence, a name and a button in one row, and the
  // standing UI bar is no horizontal page scroll at 320 as well as at desktop
  // — the width where `min-w-0` mistakes actually show. No unit test can see
  // this: `apps/web` vitest is node-env, so a class scan stays green.
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(banner, "the banner must survive a phone width").toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  // --- the press ------------------------------------------------------------
  await page.getByTestId("board-publish-all").click();

  const outcome = page.getByTestId("board-publish-all-outcome");
  await expect(outcome, "pressing Publish all reported nothing back").toBeVisible();
  await expect(
    outcome,
    "the outcome must say how many divisions went live",
  ).toContainText(uiString("en", "board.publishAll.publishedCount.one", { count: 1 }));

  // The one that did NOT publish is named, with its state — `blocked`, not
  // `needs_ack`: a window conflict is physically impossible to acknowledge away
  // and offering the organiser a confirm would be a promise the server refuses.
  const remaining = page.getByTestId("board-publish-all-division");
  await expect(remaining, "exactly one division should have been refused").toHaveCount(1);
  await expect(remaining).toHaveAttribute("data-division-id", rig.b.id);
  await expect(remaining).toHaveAttribute("data-state", "blocked");
  await expect(remaining).toContainText(rig.b.name);
  await expect(remaining).toContainText(uiString("en", "board.publishAll.blocked"));

  // "Blocked" alone sends the organiser hunting, so the row owes its REASONS —
  // and the reason has to be the real one. `warn.window` is the wire code
  // `REASON_CODE` (lib/schedule-board.ts) maps the engine's `window` reason to,
  // and `isBlockingConflict` is what makes it `yes` rather than a warning.
  const windowRow = page.locator(
    '[data-testid="board-publish-all-conflict"][data-code="warn.window"]',
  );
  await expect(windowRow, "a blocked division must name what blocked it").toHaveCount(1);
  await expect(windowRow).toHaveAttribute("data-blocking", "yes");
  await expect(windowRow).toContainText(uiString("en", "board.conflict.warn.window"));

  // --- the record agrees ----------------------------------------------------
  const after = await Promise.all(
    [rig.a, rig.b].map(async (d) => ({
      name: d.name,
      status: (await apiJson<{ status: string }>(page.request, `/api/v1/divisions/${d.id}`)).data
        ?.status,
    })),
  );
  expect(after, "one division released, one left where it was").toEqual([
    { name: rig.a.name, status: "scheduled" },
    { name: rig.b.name, status: "setup" },
  ]);

  // --- the spectator, again -------------------------------------------------
  // The assertion the whole file exists for. The expected string is DERIVED:
  // the product's own `fmtPublicTime` over the instant that was seeded, in the
  // zone the division was pinned to — never a literal typed in here, which
  // would stop moving the day the formatter's options do.
  const expectedTime = fmtPublicTime("en", TZ, KICKOFF_A);
  expect(expectedTime, "a kick-off that formats to nothing proves nothing").toMatch(/^\d{2}:\d{2}$/);
  const tbd = dictString("en", "matchesHub.timeTbd");
  expect(expectedTime, "the expected time must differ from the string it replaces").not.toBe(tbd);

  const spectatorPage = await spectator(browser, { width: 1280, height: 900 });
  await expect
    .poll(
      async () => {
        await openMatches(spectatorPage);
        return (await timeSlot(spectatorPage, rig.a.fixtureId).textContent())?.trim() ?? "";
      },
      {
        message: `the published division's kick-off never reached the hub: still not ${expectedTime}`,
        timeout: publicLandMs(),
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toBe(expectedTime);

  // TBD is GONE for that match, and the card has moved out of Unscheduled into
  // the day it is played on — the grouping and the time are two separate reads
  // of the same redaction, and a fix to one without the other is a half fix.
  await expect(dayOf(spectatorPage, UNSCHEDULED, rig.a.fixtureId)).toHaveCount(0);
  await expect(dayOf(spectatorPage, DAY_A, rig.a.fixtureId)).toHaveCount(1);
  await expect(
    spectatorPage.getByTestId(`mh-day-${DAY_A}`).getByRole("heading", { level: 2 }),
  ).toHaveText(fmtPublicDate("en", TZ, KICKOFF_A, DAY_HEADING_OPTS));

  // --- and the blocked division is still invisible --------------------------
  await expect(
    timeSlot(spectatorPage, rig.b.fixtureId),
    "a division the gate refused must not have released its times",
  ).toHaveText(tbd);
  await expect(dayOf(spectatorPage, UNSCHEDULED, rig.b.fixtureId)).toHaveCount(1);

  await expectNoHorizontalScroll(spectatorPage);
});

// ---------------------------------------------------------------------------
// 3 — the division the organiser has not built yet
// ---------------------------------------------------------------------------
//
// Owner ruling 2026-09-22: Publish all skips a `setup` division with NO
// fixtures. Leaving `setup` is irreversible in effect — `public_fixtures_v`
// stops redacting that division for ever, so anything placed in it afterwards
// goes public the instant it is placed, with no second publish to consent to.
// A bulk button must not arm a division nobody has built.
//
// WHY THIS CASE IS HERE AND NOT IN EITHER UNIT SUITE. The rule was implemented
// TWICE, independently: the server narrowed its candidate SELECT, and the
// board narrowed `unreleasedDivisions`. Each is unit-tested against its own
// idea of the rule, and a green pair proves only that each side is
// self-consistent. The defect neither can witness is DISAGREEMENT — a banner
// promising "2 of 3" over a server that publishes one, which reads to the
// organiser as a division that silently refused. So this case pins ONE number
// against BOTH surfaces: the count the banner renders, and the length of the
// report the server sends back on the wire.
//
// The absence is asserted on the RESPONSE BODY rather than on the outcome
// block, deliberately. A clean publish leaves no unreleased candidate, so the
// banner's own predicate goes false and it unmounts with the outcome inside it
// — "no row names the empty division" would then be true of a DOM that renders
// no rows at all, which is the vacuous shape AGENTS.md #3 warns about. The
// wire body is the artefact that block renders, and `results` is demonstrably
// non-empty, so the empty division being absent from it is a real absence.

/** As much of `CompetitionPublishOut` (usecases/competition-schedule-publish.ts)
 *  as this case reads. Declared here rather than imported: the use-case module
 *  is `server-only` and pulling it into a spec would drag the app's DB graph in
 *  with it. Only the four fields asserted below are named, so a widening of the
 *  wire shape does not touch this file. */
interface PublishAllReport {
  published: number;
  needs_acknowledgement: number;
  blocked: number;
  results: { division_id: string; name: string; published: boolean }[];
}

/** The number the two surfaces must agree on: divisions Publish all will
 *  release. One number, used for the banner's sentence AND for the length of
 *  the server's report — if either side counts the empty division, one of the
 *  two assertions below fails, which is the whole point of the case. */
const BUILT_CANDIDATES = 1;
/** `total` in the sentence stays the competition's DIVISION count — the
 *  denominator is "how much of this competition", not "how many candidates". */
const DIVISIONS_IN_COMPETITION = 2;

test("Publish all leaves a fixture-less division alone, and never reports it", async ({
  request,
  page,
}) => {
  test.setTimeout(Math.max(FLOOR_MS, 14 * API_CALL_MS + 5 * STEP_MS));

  // A competition of its own, in the org test 1 minted: the rig above has
  // already moved its divisions, and a candidate count is only readable on a
  // board whose divisions were all seeded for it.
  await switchActiveOrg(request, rig.orgId);
  const comp = await publicCompetition(request, {
    name: `Half Built ${TAG}`,
    orgId: rig.orgId,
    startsOn: COMP_STARTS_ON,
    endsOn: COMP_ENDS_ON,
  });
  const { courts } = await seedVenueWithCourts(request, ["Court 3"], { orgId: rig.orgId });

  const built = await unreleasedDivision(
    request,
    comp.id,
    `Built ${TAG}`,
    courts[0]!.id,
    KICKOFF_A,
  );

  // The unbuilt one carries ENTRANTS but no stage, so it has no fixtures at
  // all. That is the realistic shape of the ruling's subject — an organiser
  // who has entered the teams and not yet drawn the matches — and a stronger
  // case than a division with nothing in it, which a rule keyed on the wrong
  // table might exclude by accident.
  const unbuilt = await division(request, comp.id, {
    name: `Unbuilt ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
  });
  const seeded = await addEntrantsViaApi(request, unbuilt.id, [
    `Unbuilt ${TAG} Home`,
    `Unbuilt ${TAG} Away`,
  ]);
  expect(seeded.status, "entrants for the unbuilt division").toBeLessThan(300);
  const noFixtures = await apiJson<unknown[]>(
    request,
    `/api/v1/divisions/${unbuilt.id}/fixtures`,
  );
  expect(noFixtures.data ?? [], "the unbuilt division must have no fixtures").toHaveLength(0);

  // --- surface one: what the banner COUNTS --------------------------------
  await switchActiveOrg(page.request, rig.orgId);
  await page.goto(await competitionPath(page.request, comp.id, "/schedule"));
  await expect(
    page.getByTestId("board-unreleased-headline"),
    "the banner must count only the division Publish all would release — an empty one is not a candidate",
  ).toHaveText(
    uiString("en", "board.publishAll.headline.one", {
      count: BUILT_CANDIDATES,
      total: DIVISIONS_IN_COMPETITION,
    }),
  );

  // --- surface two: what the SERVER reports -------------------------------
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/competitions/${comp.id}/schedule/publish`) &&
        r.request().method() === "POST",
    ),
    page.getByTestId("board-publish-all").click(),
  ]);
  const report = ((await response.json()) as { data?: PublishAllReport }).data;
  expect(report, `publish-all answered ${response.status()} with no report`).toBeDefined();
  expect(report!.published, "one built division published").toBe(BUILT_CANDIDATES);
  expect(report!.needs_acknowledgement, "nothing was left awaiting acknowledgement").toBe(0);
  expect(report!.blocked, "nothing was blocked").toBe(0);
  // ABSENT — not blocked, not failed, not a `published: false` row. The report
  // names the built division and stops, and it is the same length as the
  // number the banner rendered a moment ago.
  expect(
    report!.results.map((r) => r.division_id),
    "the report must name the built division and nothing else",
  ).toEqual([built.id]);
  expect(
    report!.results,
    "the banner's count and the server's report must be the same number",
  ).toHaveLength(BUILT_CANDIDATES);

  // --- the organiser is still told -----------------------------------------
  // A clean publish unmounts the banner (every candidate is gone), so the
  // confirmation arrives on the board's own notice channel instead. Located by
  // its sentence because that element carries no testid — which is also the
  // claim: this is the copy the organiser reads.
  await expect(
    page.getByText(uiString("en", "board.publishAll.notice.one", { count: BUILT_CANDIDATES })),
    "a clean Publish all must confirm itself somewhere the organiser can see",
  ).toBeVisible();

  // --- and the empty division does not re-arm the button -------------------
  // Read after a full reload, so this is the server-rendered board's own
  // verdict rather than a stale client tree. `schedule-action-bar` is asserted
  // first: "no banner" on a page that failed to render is not a finding.
  await page.reload();
  await expect(page.getByTestId("schedule-action-bar")).toBeVisible();
  await expect(
    page.getByTestId("board-unreleased-banner"),
    "a setup division with no fixtures must not arm Publish all on its own",
  ).toHaveCount(0);

  // --- the record ----------------------------------------------------------
  const after = await Promise.all(
    [built, unbuilt].map(async (d) => ({
      id: d.id,
      status: (await apiJson<{ status: string }>(page.request, `/api/v1/divisions/${d.id}`)).data
        ?.status,
    })),
  );
  expect(after, "the built division released; the unbuilt one was never touched").toEqual([
    { id: built.id, status: "scheduled" },
    { id: unbuilt.id, status: "setup" },
  ]);
});
