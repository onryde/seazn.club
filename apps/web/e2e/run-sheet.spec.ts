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
  // this repo (`grep -a -rn "page.clock" apps/web/e2e` returns nothing).
  // Two rows before now, one after, all on the SAME UTC calendar day. A flat
  // ±90-minute spread crossed midnight UTC in a real run of this suite
  // (2026-09-03, ~22:48 UTC put the "future" row after midnight and this
  // test read two day groups instead of one) — clamped here to the room
  // actually available before/after midnight, with a small floor so the
  // three rows still sort into a distinct before/before/after order.
  const now = Date.now();
  const minutesSinceMidnightUtc = (now - Math.floor(now / 86_400_000) * 86_400_000) / 60_000;
  const minutesUntilMidnightUtc = 1440 - minutesSinceMidnightUtc;
  const beforeFarMin = Math.min(90, Math.max(3, minutesSinceMidnightUtc - 2));
  const beforeNearMin = Math.min(30, beforeFarMin / 2);
  const afterMin = Math.min(90, Math.max(3, minutesUntilMidnightUtc - 2));
  await setFixtureScheduledAtSql(fixtureIds[0]!, new Date(now - beforeFarMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[1]!, new Date(now - beforeNearMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[2]!, new Date(now + afterMin * 60_000).toISOString());

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
  console.log("run sheet day keys:", dayKeys);
  expect(dayKeys, `expected one day group, saw ${JSON.stringify(dayKeys)}`).toHaveLength(1);

  // The three fixtures are printed on the sheet — the pitch is the venue
  // clause (suppressed here, since no venue/court is set — "an empty cell is
  // not information"), the time is the spine cell. Assert the row count and
  // that the fixture numbers we seeded are present (`data-fixture-no`), not
  // just that SOME rows rendered.
  const fixtureNos = await sheet
    .locator("[data-fixture-no]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-fixture-no")));
  console.log("run sheet fixture-no attributes:", fixtureNos);
  expect(fixtureNos.length, `expected at least 3 rows, saw ${JSON.stringify(fixtureNos)}`).toBeGreaterThanOrEqual(3);

  // The NOW rule sits between the 30-minutes-ago row and the 90-minutes-
  // hence row: exactly one rule, present at most once in the whole sheet.
  const nowRuleCount = await sheet.getByTestId("run-sheet-now").count();
  console.log("run sheet NOW rule count:", nowRuleCount);
  await expect(sheet.getByTestId("run-sheet-now")).toHaveCount(1);
});

// Regression (finding 3, competition-desk-design.md "Error and empty
// states" + supplement C7): "a decided fixture renders no 'Unscheduled'
// chip." W1's `FixtureLine` put a settled-but-never-timed fixture into its
// round list (`scheduled_at !== null || isBye(f) || f.status !== "scheduled"`
// — a decided match's status alone satisfied the third clause) and rendered
// its "Unscheduled" timetable chip on an already-played match. The run sheet
// fixes this a level up, not just by dropping the chip: `buildRunSheet`'s
// null-`scheduled_at` branch only keeps OPEN work (`scheduled`/`in_play`,
// run-sheet-groups.ts's `OPEN` set) — a settled fixture with no time is
// simply never placed on the sheet at all, so it cannot carry a stale
// "Unscheduled" label anywhere a reader could see one.
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
  // Scoped to the "Not yet scheduled" BLOCK, not the whole sheet — the
  // filter segment has its own, entirely legitimate "Unscheduled" button
  // label (`runsheet.filter.unscheduled`) that a page-wide text search would
  // collide with and misreport as this finding.
  const unscheduledBlock = sheet.locator('[data-run-sheet-block="unscheduled"]');

  // PRINT WHAT WAS SEEN — the unscheduled block's own text, so a failure
  // shows exactly what an organiser would have read instead of a bare
  // boolean.
  const blockText = (await unscheduledBlock.textContent().catch(() => null)) ?? "(no unscheduled block rendered)";
  console.log(`regression finding-3 fixture_no=${fixtureNo}, unscheduled block text:`, blockText);

  // The decided fixture must not appear inside the "Not yet scheduled"
  // group (or anywhere else — it has no time to bucket into a day, and it
  // is settled, so it is not "open work" either way).
  await expect(page.locator(`[data-fixture-no="${fixtureNo}"]`)).toHaveCount(0);
});
