import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  divisionPath,
  createStageAndGenerate,
  setFixtureScheduledAtSql,
  setFixtureStatusSql,
} from "./helpers";

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
async function seedRunSheetDivision(request: import("@playwright/test").APIRequestContext) {
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
  // The venue zone this whole sheet buckets and prints in (amendment 4) —
  // pinned to UTC, same convention `division-schedule.spec.ts` already uses,
  // so a day boundary near real "now" in some other zone can never flake this.
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: {},
    tz: "UTC",
  });
  expect(settings.status, `schedule-settings PUT failed: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  return { divisionId, fixtureIds };
}

test("the run sheet groups by venue day and prints the day, the time and the pitch", async ({ page, request }) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(3);

  // Times relative to REAL now — NOT `page.clock`, which has zero uses in
  // this repo (`grep -a -rn "page.clock" apps/web/e2e` returns nothing), so
  // the NOW rule's actual position can never be pinned to a fixed clock; it
  // has to be derived from whatever "now" the SUT itself reads at render.
  // Two rows before now, one after, all on the SAME UTC calendar day.
  //
  // Fix round 2 (controller finding A): the PREVIOUS version clamped each
  // offset to the room available before/after midnight, but floored that
  // clamp at a flat 3 minutes — `Math.max(3, room - 2)` — which DEMANDS 3
  // minutes of room even when less than 3 exist, and overshoots into the
  // adjacent calendar day. A live run at 23:58 UTC hit exactly this
  // (`afterMin` forced to 3 when only ~2 remained) and read two day groups
  // instead of one; "ran twice, green both times" was clock luck, not
  // coverage. Fixed by taking HALF the room actually available on each
  // side instead of a fixed floor — halving a positive quantity can never
  // exceed it, so `now ± offset` is PROVABLY inside the same UTC day at any
  // hour, not just probably. (`minutesSinceMidnightUtc`/`Until` are real
  // numbers derived from `Date.now()`'s millisecond precision, so landing on
  // the literal zero that would degenerate this to a zero gap is ~1-in-86.4M
  // — the same order of residual risk `page.clock`'s absence already leaves
  // for the render round-trip itself, not a new one this test introduces.)
  const now = Date.now();
  const minutesSinceMidnightUtc = (now - Math.floor(now / 86_400_000) * 86_400_000) / 60_000;
  const minutesUntilMidnightUtc = 1440 - minutesSinceMidnightUtc;
  const beforeFarMin = Math.min(90, minutesSinceMidnightUtc / 2);
  const beforeNearMin = Math.min(30, beforeFarMin / 2);
  const afterMin = Math.min(90, minutesUntilMidnightUtc / 2);
  await setFixtureScheduledAtSql(fixtureIds[0]!, new Date(now - beforeFarMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[1]!, new Date(now - beforeNearMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[2]!, new Date(now + afterMin * 60_000).toISOString());

  // Derived from the seed, never typed — the exact expected day key (fix
  // round 1, IMPORTANT 5a): the division's venue zone is pinned to UTC
  // (`seedRunSheetDivision`), so the day all three seeded instants land on is
  // simply the UTC calendar date of "now".
  const expectedDayKey = new Date(now).toISOString().slice(0, 10);
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
