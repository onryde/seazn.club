import { test, expect } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, seedVenueWithCourts } from "./helpers";
import { stageFixtures } from "./support/swiss-app-a-kit";

// W3 Swiss app-B Task 9b (X-SW-31; owner rulings 255-256): a Swiss round is scheduled only after the previous round ENDS.
// Driven through the real desk - the Auto-schedule button on the division's schedule board - against the production-shaped
// server, then judged on the board the organiser is left with, read back over the API.
//
// Its own file (not a describe in `w3-swiss-app-b.spec.ts`) so a red here cannot hide, or be hidden by, another task's
// describe; serial mode is set per describe, never file-wide (AGENTS.md class 21). Run only by the CI dispatch (`e2e.yml`)
// and judged as a WHOLE file, never with `-g`.
//
// WHAT IS DELIBERATELY NOT ASSERTED: that the placement service (rather than the greedy fallback) produced the board.
// The vendored client forwards the round rules now (round_barrier, the gap, the cap, the unpaired-slot flag, the pins'
// day), and `schedule-swiss-round-barrier.test.ts` proves the live solver answers SOLVED; but a CI e2e run may or may not
// have a service behind it, and either board must keep the barrier. That is what this file proves; the strip's status
// is read for the failure message only.
//
// Geometry: four players, four courts, two rounds of 30-minute boards. Round 1 (two boards) fills two courts in the first
// slot; round 2 is still TBD v TBD, so no entrant exists for a rest rule to hold it back, and under the old start floor its
// two shells would have taken the other two courts in that SAME slot. Only the end barrier puts them one match later.

const START = new Date(Date.UTC(2030, 7, 1, 9, 0)).toISOString();
const MATCH_MIN = 30;
const MIN = 60_000;

test.describe("W3 Swiss app-B T9b: Auto-schedule keeps round 2 after round 1's last board ends", () => {
  test.describe.configure({ mode: "serial" });

  test("the board the organiser gets has no round-2 board starting before round 1 has finished", async ({ page, request }) => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `T9b barrier ${TAG}`,
      visibility: "private",
    });
    expect(comp.status).toBeLessThan(300);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Barrier",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status).toBeLessThan(300);
    const divisionId = div.data!.id;
    const added = await addEntrantsViaApi(request, divisionId, ["Q1", "Q2", "Q3", "Q4"]);
    expect(added.ids, "four players").toHaveLength(4);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 2 },
    });
    expect(stage.status).toBeLessThan(300);
    const stageId = stage.data!.id;
    const { courts } = await seedVenueWithCourts(request, ["Court A", "Court B", "Court C", "Court D"]);
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: START,
        matchMinutes: MATCH_MIN,
        gapMinutes: 0,
        courts: courts.map((c) => c.id),
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    });
    expect(settings.status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status, "Pair round 1").toBe(200);

    const before = await stageFixtures(request, divisionId, stageId);
    const boards = before.filter((f) => !/-bye$/.test(f.ext_key ?? ""));
    expect(boards.filter((f) => f.round_no === 1), "round 1 has its two boards").toHaveLength(2);
    expect(boards.filter((f) => f.round_no === 2), "round 2 has its two TBD boards").toHaveLength(2);
    expect(boards.every((f) => f.scheduled_at === null), "nothing is on the board yet").toBe(true);

    // The organiser's click, on the real board: Auto-schedule, confirm, wait for the whole run (build, then apply).
    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=board"));
    const button = page.getByTestId("schedule-auto");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    await page.getByTestId("schedule-rebuild-confirm").click();
    const strip = page.getByTestId("schedule-result-strip");
    await expect(strip).toBeVisible({ timeout: 60_000 });
    await expect(button).toBeEnabled({ timeout: 60_000 });
    const status = await strip.getAttribute("data-status");

    const after = (await stageFixtures(request, divisionId, stageId)).filter((f) => !/-bye$/.test(f.ext_key ?? ""));
    const startsOf = (round: number) =>
      after.filter((f) => f.round_no === round && f.scheduled_at !== null).map((f) => Date.parse(f.scheduled_at!));
    const r1 = startsOf(1);
    const r2 = startsOf(2);
    expect(r1, `every round-1 board is on the board (strip status ${status})`).toHaveLength(2);
    expect(r2, `every round-2 board is on the board (strip status ${status})`).toHaveLength(2);
    const r1LastEnd = Math.max(...r1) + MATCH_MIN * MIN;
    expect(
      Math.min(...r2),
      `round 2 starts at or after round 1's last board ends (strip status ${status}): r1 ${r1.map((t) => new Date(t).toISOString())}, r2 ${r2.map((t) => new Date(t).toISOString())}`,
    ).toBeGreaterThanOrEqual(r1LastEnd);
    // Positive pair: the round is not pushed further than the barrier asks. Four courts, and nothing else in the way, so
    // round 2 fills the slot right after round 1's end (a board parked a day later would also pass the line above).
    expect(Math.min(...r2), "and no later than the very next slot").toBeLessThanOrEqual(r1LastEnd);
  });
});
