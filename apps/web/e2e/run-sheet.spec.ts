import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  divisionPath,
  createStageAndGenerate,
  setFixtureScheduledAtSql,
  setFixtureStatusSql,
  setZoneSplitSql,
  setDateTime,
} from "./helpers";
// Same authority the row itself uses (`zoned-datetime.ts`, #448) — the
// expected instant below is DERIVED from the two zones, not typed as a
// constant, so the case still witnesses the regression if either zone
// changes (fix round 3).
import { isoFromZonedDateTime } from "../src/lib/zoned-datetime";
// The SAME day-bucketing authority `buildRunSheet` and `fixtureRowAction`
// both call — the expected day key below is derived from it rather than
// re-implemented with `toISOString().slice(0, 10)`, which is only the right
// answer while the venue zone happens to be UTC (fix round 4).
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The SHIPPED English copy, so a copy assertion has one authority and moves
 *  with the dictionary instead of freezing yesterday's sentence into a test
 *  (same idiom as `competition-desk-actions.spec.ts` and four others). */
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/**
 * SHARED-STATE TEARDOWN — `afterEach`, deliberately NOT a `finally`.
 *
 * `organizations.timezone` is org-wide, and every parallel spec in the run
 * shares the one Pro org `auth.setup.ts` provisions. Only the two tests in
 * the "zone-split cases" describe mutate it (`setZoneSplitSql`); every other
 * test here touches fixtures/schedule_settings rows scoped to a division it
 * created itself, which are fine to leave dirty.
 *
 * A `try`/`finally` looks like it covers the restore and does not: on a
 * Playwright TIMEOUT the test body is abandoned and its `finally` NEVER
 * RUNS — only hooks do. The leak would then survive for the rest of the run
 * and surface as day-bucketing or time-formatting failures scattered across
 * unrelated spec files, which is about the most misleading shape a failure
 * can take here: nobody debugging `competition-desk.spec.ts` goes looking
 * for a timezone restore in this one. Fix round 4 moved it here, where it
 * runs on pass, on failure, and on timeout alike.
 *
 * Idempotent and safe when nothing was mutated: `null` until a test actually
 * captures a restore, and cleared BEFORE awaiting so a second `afterEach`
 * (or a retry) cannot re-run a stale closure. Worker-local by construction —
 * each Playwright worker is its own process, so each restores only what it
 * itself captured.
 */
let pendingOrgTzRestore: (() => Promise<void>) | null = null;

test.afterEach(async () => {
  const restore = pendingOrgTzRestore;
  pendingOrgTzRestore = null;
  if (restore !== null) await restore();
});

// Competition Desk W2, Task 4 — the fixtures tab as a run sheet. This is the
// seam obligation for Tasks 2 and 3: `fixtureRowAction` and `buildRunSheet`
// are pure builders in a jsdom-less `vitest` runner, blind to DOM wiring —
// their real producer (`listDivisionFixtures`, via the division page) and
// consumer (the rendered sheet) are proven ONLY here.
//
// `createDivisionForTest` does not exist — this defines its own local seed
// function in the style of `capacity-precheck.spec.ts`'s `seedTightRoundRobin`,
// composing the real `apps/web/e2e/helpers.ts` exports rather than an
// invented request body (a probe in W1 passed at every width once because its
// setup calls had silently failed — stages 400, generate 404, start 422 —
// while the page was never in the state under test).
/**
 * A fixed-offset IANA zone in which `nowMs` reads as local **midday**.
 *
 * Fix round 4 (controller finding). Rounds 1-3 fought the UTC day boundary
 * with a clamp on how far the seeded fixtures could sit from real "now":
 * first `Math.max(3, room - 2)` (which DEMANDED 3 minutes of room it did not
 * have and overshot into tomorrow, a live 23:58 red), then half the room
 * actually available. The halving is arithmetically sound — half a positive
 * is strictly less than it, so every seeded instant stays inside today — but
 * it bought that by SHRINKING THE OFFSETS, and the "future" row has a second
 * job the clamp cannot do: it must still be in the future when the PAGE
 * RENDERS, which is three SQL writes, four API reads and a page load later.
 * At 23:59:50 UTC the future offset became 5 seconds, the row was already
 * past by render, `filteredNowIndex` moved, and the NOW-rule position
 * assertion went red with no day-group message to explain it. The window
 * went from ~3 minutes a day to tens of seconds; it never closed.
 *
 * A floor cannot both stay inside today and outlast render latency — that is
 * the real tension, and neither clamp resolves it. The offsets are not the
 * free variable here; THE VENUE ZONE IS. The sheet buckets and prints in
 * `scheduleSettings.tz` (amendment 4) and this seed chooses that value, so
 * choosing one where "now" is local midday puts ~12 hours of room on each
 * side of the day boundary at every hour of the real clock. The offsets then
 * go back to a flat ±90/-30 minutes: far enough that render latency is
 * irrelevant, and provably inside one local day whenever the run starts.
 *
 * `Etc/GMT±N` is POSIX-style and INVERTS THE SIGN — `Etc/GMT-5` is UTC+5.
 * These zones are deliberate: fixed-offset and DST-free, so a real zone's
 * seasonal shift cannot move the midday anchor out from under the seed.
 */
function middayZoneFor(nowMs: number): string {
  const offsetHours = 12 - new Date(nowMs).getUTCHours();
  if (offsetHours === 0) return "UTC";
  return `Etc/GMT${offsetHours > 0 ? "-" : "+"}${Math.abs(offsetHours)}`;
}

async function seedRunSheetDivision(
  request: import("@playwright/test").APIRequestContext,
  opts: { tz?: string } = {},
) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `RunSheet E2E ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  // The venue zone this whole sheet buckets and prints in (amendment 4).
  // Defaults to UTC (the convention `division-schedule.spec.ts` uses); the
  // day-grouping case passes a midday zone instead — see `middayZoneFor`.
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: {},
    tz: opts.tz ?? "UTC",
  });
  expect(settings.status, `schedule-settings PUT failed: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  return { divisionId, fixtureIds };
}

test("the run sheet groups by venue day and prints the day, the time and the pitch", async ({ page, request }) => {
  // Fix round 4: the venue zone is CHOSEN so that real "now" is local midday
  // in it — see `middayZoneFor` for the whole argument. Everything below is
  // then flat and deterministic; there is no clamp, no floor, and no hour of
  // the real clock at which this case behaves differently.
  const now = Date.now();
  const tz = middayZoneFor(now);
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request, { tz });
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(3);
  // The seed's whole safety argument in one assertion, printed: "now" must
  // really be near the middle of the venue-zone day, or the flat ±90-minute
  // offsets below are not safe and the reader should be told so HERE rather
  // than discovering it as a mystery day-group failure 40 lines later.
  const hourInTz = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date(now)),
  );
  console.log("run sheet seed zone:", tz, "| local hour there:", hourInTz);
  expect(hourInTz, `middayZoneFor(${tz}) did not land near midday`).toBeGreaterThanOrEqual(11);
  expect(hourInTz, `middayZoneFor(${tz}) did not land near midday`).toBeLessThanOrEqual(13);

  // Times relative to REAL now — NOT `page.clock`, which has zero uses in
  // this repo (`grep -a -rn "page.clock" apps/web/e2e` returns nothing), so
  // the NOW rule's actual position can never be pinned to a fixed clock; it
  // has to be derived from whatever "now" the SUT itself reads at render.
  // Two rows before now, one after, all on the same venue-zone day.
  //
  // FLAT offsets, no clamp: the midday zone above guarantees ~12 hours of
  // room on both sides of the local day boundary, so 90 minutes can never
  // reach it. And 90 minutes of headroom is what makes the FUTURE row still
  // future when the page finally renders — the property the round-2 halving
  // clamp silently gave up (at 23:59:50 it left a 5-second future offset,
  // which three SQL writes and a page load outlive).
  const beforeFarMin = 90;
  const beforeNearMin = 30;
  const afterMin = 90;
  await setFixtureScheduledAtSql(fixtureIds[0]!, new Date(now - beforeFarMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[1]!, new Date(now - beforeNearMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[2]!, new Date(now + afterMin * 60_000).toISOString());

  // Derived from the seed through the SUT's OWN bucketing authority (fix
  // round 1, IMPORTANT 5a; fix round 4 re-derives it via `dayKeyInTz` rather
  // than a UTC-only string slice, since the venue zone is no longer UTC).
  const expectedDayKey = dayKeyInTz(now, tz);
  // The exact fixture_no values the day block must show, IN CHRONOLOGICAL
  // ORDER (fix round 1, IMPORTANT 5b) — a sheet that merely contains "at
  // least 3 rows somewhere" passes even when it bucketed into the WRONG day
  // or duplicated a row; `toEqual` on the real fixture numbers, fetched from
  // the API rather than assumed, does not.
  const expectedFixtureNos = await Promise.all(
    [fixtureIds[0]!, fixtureIds[1]!, fixtureIds[2]!].map(async (id) => {
      const info = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${id}`);
      return info.data!.fixture_no;
    }),
  );

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();

  // PRINT WHAT WAS SEEN beside the gate — `_RULES.md`: "A green gate on the
  // wrong state is worse than a red one." A probe in W1 once reported "no
  // horizontal scroll" at every width on a page that was never in the state
  // under test, because its setup calls had silently failed.
  const dayKeys = await sheet
    .locator("[data-run-sheet-day]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-run-sheet-day")));
  console.log("run sheet day keys:", dayKeys, "expected:", expectedDayKey);
  expect(dayKeys, `expected one day group, saw ${JSON.stringify(dayKeys)}`).toHaveLength(1);
  expect(dayKeys[0], `sheet bucketed into the WRONG day`).toBe(expectedDayKey);

  // The three fixtures are printed on the sheet, in the DAY BLOCK
  // specifically — the pitch is the venue clause (suppressed here, since no
  // venue/court is set — "an empty cell is not information"), the time is
  // the spine cell. `sheet` also contains the other 3 generated-but-never-
  // scheduled fixtures, in the unscheduled block — scoping to the day
  // block (found via the day header it contains) is what makes this
  // assertion mean "these three, in this order", not "at least 3 rows
  // somewhere on the page".
  const dayBlock = page.locator("section", { has: page.locator("[data-run-sheet-day]") });
  const fixtureNos = await dayBlock
    .locator("[data-fixture-no]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-fixture-no")));
  console.log("run sheet day-block fixture-no attributes:", fixtureNos, "expected:", expectedFixtureNos);
  expect(fixtureNos).toEqual(expectedFixtureNos.map(String));

  // The NOW rule sits between the 30-minutes-ago row and the 90-minutes-
  // hence row: exactly one rule, present at most once in the whole sheet,
  // AND at the right POSITION — a `nowIndex` pinned to 0 (every row read as
  // "in the future") would still pass a bare `toHaveCount(1)` (fix round 1,
  // IMPORTANT 5c). The row immediately after the rule in DOM order must be
  // the FUTURE fixture.
  await expect(sheet.getByTestId("run-sheet-now")).toHaveCount(1);
  const afterNowFixtureNo = await sheet
    .getByTestId("run-sheet-now")
    .locator("xpath=following-sibling::*[1]")
    .getAttribute("data-fixture-no");
  console.log("run sheet row immediately after NOW:", afterNowFixtureNo, "expected:", expectedFixtureNos[2]);
  expect(afterNowFixtureNo).toBe(String(expectedFixtureNos[2]));
});

// Regression (finding 3, competition-desk-design.md "Error and empty
// states" + supplement C7): "a decided fixture renders no 'Unscheduled'
// chip." W1's `FixtureLine` put a settled-but-never-timed fixture into its
// round list (`scheduled_at !== null || isBye(f) || f.status !== "scheduled"`
// — a decided match's status alone satisfied the third clause) and rendered
// its "Unscheduled" timetable chip on an already-played match. The run sheet
// fixes this a level up, not just by dropping the chip:
// `buildRunSheet`'s null-`scheduled_at` branch only keeps OPEN work
// (`scheduled`/`in_play`, run-sheet-groups.ts's `OPEN` set) in the
// unscheduled pile — a settled fixture with no time is never "open
// scheduling work". Fix round 1 (controller ruling) corrected WHERE it goes
// from there: dropping it off the sheet entirely was itself a regression
// (W1's round list kept these rows) — it now lands in its own terminal
// "settled" block, with a "Result" action, never a stale "Unscheduled" one.
test("regression (finding 3): a decided fixture with no recorded time never reads as unscheduled", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);

  const target = fixtureIds[0]!;
  const targetInfo = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`);
  const fixtureNo = targetInfo.data!.fixture_no;

  // Decided, and deliberately left with no `scheduled_at` at all — a
  // retroactively-recorded result the organiser never put a kickoff time on.
  await setFixtureStatusSql(target, "decided");
  await setFixtureScheduledAtSql(target, null);

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  // IMPORTANT 5d (fix round 1): assert the sheet actually rendered BEFORE
  // asserting an absence inside it — a blank or 500'd page also satisfies
  // "the fixture does not appear inside the unscheduled block", which is
  // exactly the "reachable" bar this whole regression class exists to clear.
  await expect(sheet).toBeVisible();

  const unscheduledBlock = sheet.locator('[data-run-sheet-block="unscheduled"]');
  const settledBlock = sheet.locator('[data-run-sheet-block="settled"]');

  // PRINT WHAT WAS SEEN — both blocks' own text, so a failure shows exactly
  // what an organiser would have read instead of a bare boolean.
  const unscheduledText = (await unscheduledBlock.textContent().catch(() => null)) ?? "(no unscheduled block)";
  const settledText = (await settledBlock.textContent().catch(() => null)) ?? "(no settled block)";
  console.log(
    `regression finding-3 fixture_no=${fixtureNo}, unscheduled block:`,
    unscheduledText,
    "| settled block:",
    settledText,
  );

  // The decided fixture must not appear inside the "Not yet scheduled"
  // group — it is not open work.
  await expect(unscheduledBlock.locator(`[data-fixture-no="${fixtureNo}"]`)).toHaveCount(0);
  // It DOES appear, in the settled tail, with the "Result" action — never
  // "Set time" (the fix round 1 ruling: visible, not dropped, and never
  // under a heading that implies scheduling is still owed).
  const settledRow = settledBlock.locator(`[data-fixture-no="${fixtureNo}"]`);
  await expect(settledRow).toHaveCount(1);
  await expect(settledRow.locator('[data-row-action="result"]')).toHaveCount(1);
  await expect(settledRow.locator('[data-row-action="set_time"]')).toHaveCount(0);
});

// CRITICAL 1 (fix round 1): the run sheet had no empty-filter state. The
// default filter is "today" on a match day; a division whose real fixtures
// exist but none land on today's venue-zone day rendered a filter bar, a tz
// caption, and NOTHING below it — the flagship surface reading as broken on
// the one day it exists for. The same vacuous shape amendment 3 already paid
// for one level up: the empty set answers no to every question and lands on
// whatever the default is. Driven live rather than asserted from
// `buildRunSheet`'s own output, since the whole point is what an organiser
// SEES, not that the builder returns an empty array (it always did — the gap
// was the component never rendering anything for that case).
test("empty-filter state: switching to a filter with no matching rows shows a message and a way back to All", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
  // Far in the future — never "today" no matter when this suite runs.
  await setFixtureScheduledAtSql(fixtureIds[0]!, "2030-06-15T09:00:00.000Z");

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("run-sheet-filter")).toBeVisible();

  await sheet.locator('[data-filter="today"]').click();
  const empty = sheet.getByTestId("run-sheet-empty");
  await expect(empty).toBeVisible({ timeout: 10_000 });
  const emptyText = await empty.textContent();
  console.log("run sheet empty-filter state text:", emptyText);
  expect(emptyText, "empty-filter copy must exist and say something").toBeTruthy();
  // The filter bar and tz caption stay up — only the body goes empty, so the
  // organiser can still see and change the active filter.
  await expect(sheet.getByTestId("run-sheet-filter")).toBeVisible();
  await expect(sheet.getByTestId("tz-caption")).toBeVisible();

  // The affordance back to All actually recovers the sheet — not just
  // present, but functional.
  await sheet.getByTestId("run-sheet-empty-show-all").click();
  await expect(empty).toHaveCount(0);
  await expect(sheet.locator("[data-run-sheet-day]")).toHaveCount(1);
});

// SERIAL, and only these two. Both write `organizations.timezone`, which
// is org-wide and shared by every parallel spec in the run (auth.setup.ts
// provisions ONE Pro org). `fullyParallel: true` parallelises tests WITHIN
// a file, so before this block the two ran in different workers and each
// could see the other's zone: caught live on 2026-09-04, when the note case
// read the org as UTC and the page rendered `America/New_York` because the
// write case had just set it in another worker. Serial mode is the price;
// read a failure count for this describe as a FLOOR, not a total, because
// the first red skips the rest of the block (and only this block).
//
// They also both SET the zone rather than reading it, to the same
// `ORG_TZ`. Reading it cannot work: three other spec files
// (`competition-desk`, `registration-hub`, the organiser walkthrough) write
// the same column, so a value read at the top of a test can be stale by the
// time the page renders.
test.describe("zone-split cases — they share organizations.timezone", () => {
  test.describe.configure({ mode: "serial" });

  /** The one org zone every test in this block writes, so two of them
   *  overlapping (or one restoring while the other reads) can never make
   *  them contradict each other on the value itself. */
  const ORG_TZ = "America/New_York";

  // Fix round 3 (owner ruling): the inline "Set time" editor resolves the
  // typed value in the ORG zone (`orgTz`, #448), never the VENUE zone (`tz`,
  // display-only, amendment 4) and never the browser's implicit zone. This is
  // a VALUE pin, not a reachability check — the whole reason the defect
  // survived every prior write site's own test coverage is that nothing
  // seeded a division where `tz` and `orgTz` actually DISAGREE, so a
  // wrong-zone write and a right-zone write produced the identical instant
  // and nothing could tell them apart. `setZoneSplitSql` seeds exactly that
  // shape.
  test("fix round 3 (owner ruling): the inline Set-time editor writes the ORG zone, not the venue zone", async ({
    page,
    request,
  }) => {
    const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
    expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
    const target = fixtureIds[0]!;
    const targetInfo = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`);
    const fixtureNo = targetInfo.data!.fixture_no;

    // A division whose venue zone DIFFERS from its org zone. `fixtureNo: -1`
    // matches no real row — every fixture in this division (the target
    // included) is left/forced unscheduled by the helper's own "null every
    // OTHER fixture" clause, which is exactly the state "Set time" needs to
    // be reachable at all.
    // Fix round 4: the restore is REGISTERED, not wrapped in a `try`/`finally`.
    // A Playwright timeout abandons the test body without running its
    // `finally`, which would leave the SHARED org's timezone mutated for the
    // rest of the run — see the `afterEach` at the top of this file for the
    // whole argument. Registered BEFORE the first `await` that can time out.
    pendingOrgTzRestore = await setZoneSplitSql({
      divisionId,
      orgTz: ORG_TZ,
      divisionTz: "Asia/Tokyo",
      fixtureNo: -1,
      at: "2030-01-01T00:00:00.000Z",
    });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const targetRow = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    await targetRow.getByRole("button", { name: "Set time", exact: true }).click();
    const typed = "2026-10-12T15:00";
    await setDateTime(page, typed);
    await targetRow.getByRole("button", { name: "Save", exact: true }).click();

    // DERIVED from both zones, never a typed constant — this stays a real
    // witness if either zone (or the chosen date, which crosses a DST
    // boundary differently for each) ever changes. Sanity-checked that the
    // two zones actually disagree for this instant, or the test would be
    // vacuously satisfied by either implementation.
    const expectedInstant = isoFromZonedDateTime(typed, ORG_TZ);
    const wrongZoneInstant = isoFromZonedDateTime(typed, "Asia/Tokyo");
    expect(expectedInstant, "orgTz and tz must actually disagree for this instant, or the case proves nothing").not.toBe(
      wrongZoneInstant,
    );

    // Polled, not a single read — the PATCH is fired from a client click and
    // can still be in flight the instant this check runs. Prints the actual
    // read on every poll tick via a side-channel `let`, so a failure still
    // shows what was seen rather than just a timeout.
    let lastSeen: string | null | undefined;
    await expect
      .poll(
        async () => {
          lastSeen = (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`)).data!
            .scheduled_at;
          return lastSeen;
        },
        { timeout: 15_000 },
      )
      .toBe(expectedInstant);
    console.log(
      "set-time write: typed",
      typed,
      "| written",
      lastSeen,
      "| expected (orgTz)",
      expectedInstant,
      "| would-be-wrong (tz)",
      wrongZoneInstant,
    );
  });

  // Fix round 4 — the zone note, both directions.
  //
  // Round 3 added it unconditionally, saying only which zone the input accepts.
  // Two problems, both about whether an organiser keeps reading it: it fired on
  // every division, including the majority where `orgTz === tz` and there is
  // nothing to disambiguate (a note that speaks when it has nothing to say
  // trains people to stop reading it), and it never said that the ROW
  // redisplays in a different zone, which is the actual confusion — a typed
  // 15:00 reappearing as 04:00 with no visible cause reads as data loss.
  //
  // This is also where `orgTz` gets its teeth. The editor's initial VALUE is
  // no longer read from the fixture (see run-sheet-row.tsx: the ladder only
  // opens this editor for a fixture with no time at all, so that read was dead
  // code), so the note is the one place `orgTz` is observable in the DOM.
  // Pinned as an exact sentence built from the dictionary's own string, not a
  // substring check — a containment assertion cannot tell "enter in NY, shown
  // in Tokyo" from the swapped, exactly-wrong "enter in Tokyo, shown in NY".
  //
  // This case lives in ZONE_SPLIT_CASES (serial) with the fix-round-3 write
  // test, and it SETS the org zone rather than reading it — see that describe's
  // own header for why a read-based expectation cannot work here.
  test("fix round 4: the set-time zone note names both clocks, and only appears when they differ", async ({
    page,
    request,
  }) => {
    const openEditor = async (divisionId: string, fixtureNo: number) => {
      await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
      const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
      await row.locator('[data-row-action="set_time"]').click();
      await expect(row.getByTestId("run-sheet-set-time-editor")).toBeVisible();
      return row;
    };

    // Phase 1 — the two zones DISAGREE. `fixtureNo: -1` matches no real row,
    // so the helper's "null every OTHER fixture" clause leaves every fixture
    // unscheduled, which is the state "Set time" needs to be reachable at all.
    const differing = await seedRunSheetDivision(request);
    expect(differing.fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(
      1,
    );
    const noA = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${differing.fixtureIds[0]!}`)).data!
      .fixture_no;
    // Registered for `afterEach`, never a `finally` — a Playwright timeout
    // skips `finally` entirely and would leave the shared org mutated.
    pendingOrgTzRestore = await setZoneSplitSql({
      divisionId: differing.divisionId,
      orgTz: ORG_TZ,
      divisionTz: "Asia/Tokyo",
      fixtureNo: -1,
      at: "2030-01-01T00:00:00.000Z",
    });
    const rowA = await openEditor(differing.divisionId, noA);
    const note = rowA.getByTestId("run-sheet-set-time-zone-note");
    await expect(note).toBeVisible();
    const seen = (await note.textContent())?.trim() ?? "";
    // Built from the SHIPPED English string, so the copy has exactly one
    // authority and a reworded note moves this expectation with it.
    const expected = UI_EN["runsheet.setTime.zoneNote"]!.replace("{orgTz}", ORG_TZ).replace("{tz}", "Asia/Tokyo");
    console.log(`zone note (orgTz=${ORG_TZ}, tz=Asia/Tokyo):`, JSON.stringify(seen));
    expect(seen).toBe(expected);
    // The sentence must actually change when the two zones swap places, or a
    // reversed note would pass this case.
    expect(expected).not.toBe(
      UI_EN["runsheet.setTime.zoneNote"]!.replace("{orgTz}", "Asia/Tokyo").replace("{tz}", ORG_TZ),
    );

    // Phase 2 — the two zones AGREE, on a SECOND division of this test's own,
    // whose venue zone is set to the SAME `ORG_TZ` the org is already on. No
    // further org write: the column keeps the one value every test in this
    // describe puts there, so nothing here can contradict its neighbour.
    // Every absence below is paired with a positive twin (the editor and its
    // date input are visible), because `toHaveCount(0)` is equally satisfied
    // by a page that failed to render the editor at all.
    const matching = await seedRunSheetDivision(request, { tz: ORG_TZ });
    const noB = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${matching.fixtureIds[0]!}`)).data!
      .fixture_no;
    const rowB = await openEditor(matching.divisionId, noB);
    const editorText = (await rowB.getByTestId("run-sheet-set-time-editor").textContent())?.trim() ?? "";
    console.log(`editor text when orgTz === tz === ${ORG_TZ}:`, JSON.stringify(editorText.slice(0, 40)), "…");
    await expect(rowB.getByTestId("run-sheet-set-time-editor")).toBeVisible();
    await expect(rowB.locator('input[type="date"]')).toBeVisible();
    await expect(rowB.getByTestId("run-sheet-set-time-zone-note")).toHaveCount(0);
  });
});

// Fix round 4, CRITICAL — the "When" field in this editor was ZERO PIXELS
// WIDE at every width, and every gate in the suite passed over it.
//
// `DateTimeSplitField`'s outer box is `@container` (`container-type:
// inline-size`), which applies inline-size CONTAINMENT: its own contents stop
// contributing to its inline size. As a flex item of this editor's row its
// flex-basis is `auto` → max-content → contained → 0, and both halves
// collapsed to the browser's ~26px minimum: on screen, an empty box under
// "When" with the time select's chevron floating over the Save button.
// Measured before the fix at 320/390/768/1280: container 0px, date input
// 26px, time select 26px, and the select's own centre hit-testing to a
// BUTTON. An organiser could not set a fixture time from this tab on any
// device — and with `FixtureLine` retired this is the only inline set-time
// path in the product.
//
// WHY NOTHING CAUGHT IT: `setDateTime` (helpers.ts) drives the halves with
// `.fill()` and `.selectOption()`, and `schedule-datetime-ux.spec.ts` reads
// `<option>` values straight out of the DOM. All of that works perfectly on a
// zero-width control — the element exists, is "visible" to Playwright, and
// accepts programmatic input. Only a BOX MEASUREMENT plus a real hit test can
// see it, which is what this case is.
test("fix round 4: the inline Set-time field is a usable, tappable control at 320 and at 1280", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const sheet = page.getByTestId("run-sheet");
    await expect(sheet).toBeVisible();

    const setTime = sheet.locator('[data-row-action="set_time"]').first();
    await setTime.scrollIntoViewIfNeeded();
    await setTime.click();
    // Deliberately located by the CONTROL it contains, not by the
    // `run-sheet-set-time-editor` testid that shipped alongside this fix: an
    // assertion introduced in the same commit as its own hook can only be run
    // against the fixed build, and this case had to produce a true red
    // against the BROKEN one first. It did — 26px halves, container 0px.
    const editor = sheet.locator("li", { has: page.locator('input[type="date"]') }).first();
    await expect(editor.locator('input[type="date"]')).toBeVisible();

    // Measured from the LIVE box, and hit-tested at the tap point with
    // `document.elementFromPoint` — never `boundingBox()` alone, which
    // reports paint and not hit area (a control can measure 44px and still
    // be untappable under an overlay). `scrollIntoView` first: elementFromPoint
    // is VIEWPORT-relative and returns null for anything below the fold,
    // which reads as "untappable" when it only means "off-screen".
    const seen = await editor.evaluate((el) => {
      const container = el.querySelector('[class*="@container"]') as HTMLElement | null;
      const dateInput = el.querySelector('input[type="date"]') as HTMLElement | null;
      const timeSelect = el.querySelector("select") as HTMLElement | null;
      const w = (node: HTMLElement | null) => (node === null ? -1 : Math.round(node.getBoundingClientRect().width));
      const hit = (node: HTMLElement | null) => {
        if (node === null) return "(absent)";
        node.scrollIntoView({ block: "center" });
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return "(zero box)";
        const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return target === node ? "self" : `${target?.tagName.toLowerCase() ?? "(nothing)"}`;
      };
      return {
        containerW: w(container),
        dateW: w(dateInput),
        timeW: w(timeSelect),
        dateHit: hit(dateInput),
        timeHit: hit(timeSelect),
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      };
    });
    console.log(`set-time field at ${width}px:`, JSON.stringify(seen));

    // 120px is not a style preference: below it a `dd/mm/yyyy` date input
    // clips its own placeholder and the time select shows a bare chevron —
    // the state this test exists to prevent measured 26px. The defect it
    // witnesses is an order of magnitude away from the threshold, so the
    // number is a floor, not a pixel-perfect snapshot that will churn.
    expect(seen.containerW, `the @container box collapsed at ${width}px`).toBeGreaterThanOrEqual(200);
    expect(seen.dateW, `the date input is unusably narrow at ${width}px`).toBeGreaterThanOrEqual(120);
    expect(seen.timeW, `the time select is unusably narrow at ${width}px`).toBeGreaterThanOrEqual(120);
    expect(seen.dateHit, `the date input is not what a tap at its centre hits at ${width}px`).toBe("self");
    expect(seen.timeHit, `the time select is not what a tap at its centre hits at ${width}px`).toBe("self");
    expect(seen.scrollW, `the open editor put the page into horizontal scroll at ${width}px`).toBeLessThanOrEqual(
      seen.clientW,
    );

    // And it still WORKS as a control, not just as a box: type a time
    // through the same helper every other spec uses and read it back.
    await setDateTime(editor, "2030-06-15T14:30");
    const roundTrip = await editor.evaluate((el) => ({
      date: (el.querySelector('input[type="date"]') as HTMLInputElement | null)?.value ?? null,
      time: (el.querySelector("select") as HTMLSelectElement | null)?.value ?? null,
    }));
    console.log(`set-time field round trip at ${width}px:`, JSON.stringify(roundTrip));
    expect(roundTrip).toEqual({ date: "2030-06-15", time: "14:30" });
  }
});

// Fix round 4, the premise behind the deleted read: this editor is
// unreachable on a fixture that already has a time, so there is no existing
// instant for it to display and no zone for that display to get wrong.
// `fixtureRowAction`'s branch 4 returns `set_time` only for
// `scheduledAt === null`; a timed fixture gets `score` / `assign_scorer` /
// `result`, all of which render a plain `<Link>` that never opens an editor.
// Pinned here so a later wave that re-adds an "edit a time already set"
// affordance has to come through this test — and, per the note in
// run-sheet-row.tsx, ship a value pin for the zone it seeds from.
test("fix round 4: a fixture that already has a time offers no inline editor at all", async ({ page, request }) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
  const target = fixtureIds[0]!;
  const fixtureNo = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`)).data!.fixture_no;
  await setFixtureScheduledAtSql(target, "2030-06-15T09:00:00.000Z");

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await expect(page.getByTestId("run-sheet")).toBeVisible();
  const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
  // POSITIVE twin first: the row is really on the page and really carries an
  // action, so the absences below are absences and not a blank page.
  await expect(row).toHaveCount(1);
  const action = await row.locator("[data-row-action]").getAttribute("data-row-action");
  console.log(`scheduled fixture_no=${fixtureNo} action:`, action);
  expect(["score", "assign_scorer"], "a timed, unsettled fixture is scoring work").toContain(action);
  await expect(row.locator('[data-row-action="set_time"]')).toHaveCount(0);
  await expect(row.getByTestId("run-sheet-set-time-editor")).toHaveCount(0);
  await expect(row.locator('input[type="date"]')).toHaveCount(0);
});
