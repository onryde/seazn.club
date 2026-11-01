import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrgIdFromRequest, competitionPath, divisionPath, seedVenueWithCourts, withDb } from "./helpers";
import { seedOnlineRound, uiEn } from "./match-room-kit";
import { swissColourLot, swissDrawSeed, swissRoundOneOrder } from "../src/lib/swiss-draw";

// W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md). One
// describe per rule, each driven through the real desk.

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

type Fx = {
  id: string;
  stage_id: string;
  fixture_no: number;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  scheduled_at: string | null;
  court_id: string | null;
  ext_key?: string | null;
};

const position = (f: Pick<Fx, "pool_id" | "round_no" | "seq_in_round">) =>
  `${f.pool_id ?? "-"}|${f.round_no}|${f.seq_in_round}`;

async function stageFixtures(request: APIRequestContext, divisionId: string, stageId: string): Promise<Fx[]> {
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return (all.data ?? []).filter((f) => f.stage_id === stageId);
}

// X-RB-1 (W3 T1, #840): Rebuild used to delete every fixture and regenerate
// fresh rows, so every time and court the organiser had laid out was gone. It
// now keeps each slot at its (pool, round, seq) position. Driven through the
// roster-drift banner's Rebuild button, the only place an organiser presses it,
// and read back on the run sheet itself, not only the API.
test.describe("X-RB-1 rebuild keeps the board", () => {
  test("pin a court and time on every fixture, withdraw a player, Rebuild — every slot is still there", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = await activeOrgIdFromRequest(request);
    // TAG-unique court names: CI's shared Pro org already carries other specs' "Court 1".
    const courtNames = [`Keep Court A ${TAG}`, `Keep Court B ${TAG}`];
    const { venueId, courts } = await seedVenueWithCourts(request, courtNames, { orgId });

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Rebuild keeps ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;

    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      [`Keep Alice ${TAG}`, `Keep Bob ${TAG}`, `Keep Cleo ${TAG}`].map((n, i) => ({
        kind: "individual",
        display_name: n,
        seed: i + 1,
      })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const aliceId = added.data!.find((e) => e.display_name === `Keep Alice ${TAG}`)!.id;

    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const gen = await apiJson<{ created: number }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(gen.status, JSON.stringify(gen.error)).toBe(200);

    // Lay out every fixture: its own hour, alternating courts. The expected
    // slot per position is what THIS test writes, never what the code returns.
    const laid = new Map<string, { scheduled_at: string; court_id: string; court: string }>();
    const before = await stageFixtures(request, divisionId, stageId);
    expect(before.length, "a board to lay out").toBe(3);
    for (const [i, f] of before.entries()) {
      const at = `2030-06-15T${String(9 + i).padStart(2, "0")}:00:00.000Z`;
      const court = courts[i % 2]!;
      const placed = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
        scheduled_at: at,
        venue_id: venueId,
        court_id: court.id,
      });
      expect(placed.status, JSON.stringify(placed.error)).toBe(200);
      laid.set(position(f), { scheduled_at: at, court_id: court.id, court: court.name });
    }

    // Pre-Start withdrawal plus a late registration: the drift Rebuild answers.
    const withdrawn = await apiJson(request, `/api/v1/entrants/${aliceId}/withdraw`, "POST");
    expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);
    const late = await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "individual", display_name: `Keep Dee ${TAG}`, seed: 4 },
    ]);
    expect(late.status, JSON.stringify(late.error)).toBe(201);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const banner = page.getByTestId("roster-drift-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByTestId("roster-drift-rebuild").click();
    const dialog = page.getByRole("alertdialog", { name: "Rebuild this stage's fixtures?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Rebuild" }).click();
    // Every position survived (3 entrants before, 3 after), so the notice is the
    // plain one: no slot was freed or left unscheduled.
    await expect(page.getByText("Rebuilt — 3 fixture(s) replaced.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Keep Alice ${TAG}`)).toHaveCount(0);

    const after = await stageFixtures(request, divisionId, stageId);
    expect(after.some((f) => before.some((b) => b.id === f.id)), "new rows, not an in-place edit").toBe(false);
    let checked = 0;
    for (const f of after) {
      const want = laid.get(position(f));
      expect(want, `position ${position(f)} was laid out`).toBeDefined();
      expect({ scheduled_at: f.scheduled_at, court_id: f.court_id }, position(f)).toEqual({
        scheduled_at: want!.scheduled_at,
        court_id: want!.court_id,
      });
      // On the run sheet: the rebuilt row names the court it inherited.
      await expect(page.locator(`[data-fixture-no="${f.fixture_no}"]`)).toContainText(want!.court);
      checked++;
    }
    expect(checked, "anti-vacuity: every rebuilt fixture was read back").toBe(3);
  });
});

// X-RB-1 (W3 T2, SW-L8): a pre-Start departure shrinks every unseated Swiss
// round, and the shrink used to take the highest-seq board whatever it held —
// so the board an organiser had laid out in advance went, while a bare one
// survived. Driven through the desk's own "Pair next round" button, the press
// that runs the reshape, and read back on the run sheet.
test.describe("X-RB-1 pre-Start reshape keeps pinned boards", () => {
  test("eight → seven before Start: round 2 loses its unscheduled board, the pinned b4 keeps its court and time", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const orgId = await activeOrgIdFromRequest(request);
    const courtNames = [`Pin Court A ${TAG}`, `Pin Court B ${TAG}`];
    const { venueId, courts } = await seedVenueWithCourts(request, courtNames, { orgId });

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Reshape keeps ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Pin P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 3 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    // Mint the shells: eight ⇒ four boards a round, no bye.
    const minted = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(minted.status, JSON.stringify(minted.error)).toBe(200);

    const round2 = (rows: Fx[]) => rows.filter((f) => f.round_no === 2).sort((a, b) => a.seq_in_round - b.seq_in_round);
    const before = round2(await stageFixtures(request, divisionId, stageId));
    expect(before.map((f) => f.ext_key)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3", "sw-r2-b4"]);
    // Lay out boards 1, 2 and 4; board 3 stays bare.
    const laid = new Map<string, { scheduled_at: string; court_id: string; court: string }>();
    for (const [i, key] of ["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"].entries()) {
      const f = before.find((r) => r.ext_key === key)!;
      const at = `2030-06-16T${String(9 + i).padStart(2, "0")}:00:00.000Z`;
      const court = courts[i % 2]!;
      const placed = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
        scheduled_at: at,
        venue_id: venueId,
        court_id: court.id,
      });
      expect(placed.status, JSON.stringify(placed.error)).toBe(200);
      laid.set(key, { scheduled_at: at, court_id: court.id, court: court.name });
    }

    // A pre-Start departure: the highest seed leaves before anything starts.
    const leaving = added.data!.find((e) => e.display_name === `Pin P8 ${TAG}`)!;
    const gone = await apiJson(request, `/api/v1/entrants/${leaving.id}`, "DELETE");
    expect(gone.status, JSON.stringify(gone.error)).toBeLessThan(300);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const pairNext = page.getByTestId("stage-generate");
    await expect(pairNext).toHaveText(/pair next round/i, { timeout: 20_000 });
    await pairNext.click();
    await expect
      .poll(async () => round2(await stageFixtures(request, divisionId, stageId)).map((f) => `${f.seq_in_round}:${f.ext_key}`), {
        timeout: 20_000,
      })
      .toEqual(["1:sw-r2-b1", "2:sw-r2-b2", "3:sw-r2-b4", "4:sw-r2-bye"]);

    const after = round2(await stageFixtures(request, divisionId, stageId));
    let checked = 0;
    for (const [key, want] of laid) {
      const f = after.find((r) => r.ext_key === key)!;
      expect({ scheduled_at: f.scheduled_at, court_id: f.court_id }, key).toEqual({
        scheduled_at: want.scheduled_at,
        court_id: want.court_id,
      });
      await expect(page.locator(`[data-fixture-no="${f.fixture_no}"]`)).toContainText(want.court);
      checked++;
    }
    expect(checked, "anti-vacuity: every pinned board was read back").toBe(3);
    expect(after.some((f) => f.id === before.find((r) => r.ext_key === "sw-r2-b3")!.id), "the bare board is the one deleted").toBe(false);
  });
});


// X-SW-21 (W3 T4, RB3-15 A, ruling 252; #846): Swiss rounds are paired by the
// system, so a Swiss stage offers no "Add match" — an ad-hoc board made
// phantom byes and broke the round shells. The rail shows the refusal's own
// copy where the trigger stood, and the API refuses the match by name. The
// rail's own Pair/Generate control is asserted first, so the absence is not a
// rail that rendered nothing (the league's trigger is pinned at unit level,
// stage-rail.test.tsx and stages-panel-swiss-pairing.test.tsx).
test.describe("X-SW-21 no Add match on a Swiss stage", () => {
  test("a paired Swiss stage has no Add match trigger and shows why; a POST is refused 422 SWISS_ADHOC_REFUSED and writes nothing", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `No ad-hoc Swiss ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Adhoc P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const [p1, p2] = added.data!;
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 2 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const paired = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(paired.status, JSON.stringify(paired.error)).toBe(200);
    const before = await stageFixtures(request, divisionId, stageId);
    expect(before.length, "premise: the Swiss rounds are minted").toBeGreaterThan(0);

    // The API refuses by name and writes nothing.
    const refused = await apiJson(request, `/api/v1/stages/${stageId}/fixtures`, "POST", {
      home_entrant_id: p1!.id,
      away_entrant_id: p2!.id,
    });
    expect(refused.status).toBe(422);
    expect(refused.error?.code).toBe("SWISS_ADHOC_REFUSED");
    expect((await stageFixtures(request, divisionId, stageId)).length, "nothing written").toBe(before.length);

    // The desk: the rail renders its controls, no Add match, and the guidance in its place.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await expect(page.getByTestId("stage-generate")).toBeAttached({ timeout: 20_000 });
    const trigger = page.getByTestId("stage-rail-trigger");
    if (await trigger.isVisible()) await trigger.click(); // phone widths fold the rail into a sheet
    await expect(page.getByTestId("stage-swiss-adhoc-note")).toHaveText(
      "Swiss rounds are paired by the system. Add friendlies in another stage.",
    );
    await expect(page.getByTestId("stage-add-match")).toHaveCount(0);
  });
});

// X-SW-29 (W3 T3, SW-M13, RB3-23): a Swiss stage mints each round's bye row as
// a shell before Pair, and every placement writer used to take it for one more
// match — the auto pass gave it a court and a time, the board offered it a drag,
// and a placed bye printed a scorer sheet. A bye is not played. Driven through
// the auto pass and read back where an organiser looks: the schedule board's
// unscheduled tray, the run sheet, and the print control's day list.
test.describe("X-SW-29 a bye has no court and no sheet", () => {
  test("an odd Swiss field, auto-scheduled: the boards take courts, the byes take none, are never offered to the board or the run sheet, and add no sheet day", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const orgId = await activeOrgIdFromRequest(request);
    const { courts } = await seedVenueWithCourts(request, [`Bye Court A ${TAG}`, `Bye Court B ${TAG}`], { orgId });
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Bye no court ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 5 }, (_, i) => ({ kind: "individual", display_name: `Bye P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 2 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const minted = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(minted.status, JSON.stringify(minted.error)).toBe(200);
    const shells = await stageFixtures(request, divisionId, stageId);
    const byes = shells.filter((f) => /^sw-r\d+-bye$/.test(f.ext_key ?? ""));
    const boards = shells.filter((f) => !/^sw-r\d+-bye$/.test(f.ext_key ?? ""));
    expect([byes.length, boards.length], "premise: five players mint a bye and two boards a round").toEqual([2, 4]);

    // The board, before any placement: the tray offers the four boards and no bye.
    await page.goto(await divisionPath(request, divisionId, "/schedule"));
    const tray = page.getByTestId("board-tray");
    await expect(tray).toHaveAttribute("data-count", "4", { timeout: 20_000 });
    for (const b of boards) await expect(page.locator(`[data-fixture-id="${b.id}"]`).first()).toBeAttached();
    for (const b of byes) await expect(page.locator(`[data-fixture-id="${b.id}"]`)).toHaveCount(0);

    // The run sheet: the board shells wait to be scheduled; a bye shell is no row at all. A row carries
    // `data-fixture-no` only when the fixture has a number (run-sheet-row.tsx), so the count-0 negative below would pass
    // by absence for a bye with none: premise first that every bye HAS one.
    for (const b of byes) expect(b.fixture_no, `premise: bye ${b.ext_key} has a fixture number`).toEqual(expect.any(Number));
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await expect(page.locator(`[data-fixture-no="${boards[0]!.fixture_no}"]`).first()).toBeAttached({ timeout: 20_000 });
    for (const b of boards) await expect(page.locator(`[data-fixture-no="${b.fixture_no}"]`).first()).toBeAttached();
    for (const b of byes) await expect(page.locator(`[data-fixture-no="${b.fixture_no}"]`)).toHaveCount(0);

    // The auto pass. Midday UTC, so the day is the same date on any org clock within eleven hours of UTC.
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: "2030-06-18T11:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courts.map((c) => c.id),
        perEntrantMinRest: 0,
      },
    });
    expect(settings.status, JSON.stringify(settings.error)).toBe(200);
    const auto = await apiJson<{ assignments: { fixture_id: string; scheduled_at: string; court_id: string }[] }>(
      request,
      `/api/v1/stages/${stageId}/schedule/auto`,
      "POST",
      {},
    );
    expect(auto.status, JSON.stringify(auto.error)).toBe(200);
    const byeIds = new Set(byes.map((b) => b.id));
    expect(auto.data!.assignments.filter((a) => byeIds.has(a.fixture_id)), "the pass proposes no bye").toEqual([]);
    const applied = await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: auto.data!.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
      source: "auto",
    });
    expect(applied.status, JSON.stringify(applied.error)).toBe(200);
    const after = await stageFixtures(request, divisionId, stageId);
    let checked = 0;
    for (const f of after) {
      const isBye = byeIds.has(f.id);
      expect(f.court_id === null && f.scheduled_at === null, `${f.ext_key}: ${isBye ? "a bye holds no slot" : "a board was placed"}`).toBe(isBye);
      checked++;
    }
    expect(checked, "anti-vacuity: every row was read back").toBe(6);

    // The board after the pass opens on the boards' day with all four placed (the grid at a desktop width, the agenda
    // on a phone), and nothing is left to place: an empty tray renders nothing at all — the byes are not waiting in it.
    await page.goto(await divisionPath(request, divisionId, "/schedule"));
    for (const b of boards) await expect(page.locator(`[data-fixture-id="${b.id}"]`).first()).toBeAttached({ timeout: 20_000 });
    await expect(page.getByTestId("board-tray")).toHaveCount(0);
    await expect(page.getByTestId("board-tray-mobile")).toHaveCount(0);
    for (const b of byes) await expect(page.locator(`[data-fixture-id="${b.id}"]`)).toHaveCount(0);

    // The print control offers the boards' day and no other: a bye holds no time, so it adds no print day. This step
    // proves only that. That a bye prints no SHEET even when it holds a time (a pre-V483 row, which only SQL can seed)
    // is proven by the server scorer-sheets test's X-SW-29 case: neither `listSheetDays` nor the sheet loader
    // (`isPrintable`) offers it.
    await page.goto(await competitionPath(request, comp.data!.id, "/schedule"));
    const day = page.getByTestId("print-sheets-day");
    await expect(day).toBeAttached({ timeout: 20_000 });
    expect(await day.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual([
      "2030-06-18",
    ]);
  });
});

// X-SW-28 (W3 T5, SW-M2 / #835, RB3-22): a Pair next seats a Swiss round by
// UPDATING shells that already exist, so its ledger row named nothing for Undo
// to delete — Undo "worked" and every player stayed seated. Undo now puts the
// round back onto its shells when no match of it has started. Pressed where an
// organiser presses it (the History panel's Undo) and read back on the run
// sheet and the API. Every "seats are empty" below has its positive pair: the
// same rows seated, and named on the run sheet, before the Undo.
test.describe("X-SW-28 Undo clears a paired round", () => {
  test("Pair round 1 of an odd Swiss, press Undo: the boards are back on empty shells, the bye is gone, the shells stay", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Undo pair ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const names = Array.from({ length: 5 }, (_, i) => `Undo P${i + 1} ${TAG}`);
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 2 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    // The first press mints the shells; the second is Pair next (round 1).
    for (const what of ["mint", "pair"]) {
      const gen = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
      expect(gen.status, `${what}: ${JSON.stringify(gen.error)}`).toBe(200);
    }
    const round1 = async () =>
      ((await stageFixtures(request, divisionId, stageId)) as Seated[]).filter((f) => f.round_no === 1);
    const isBye = (f: Fx) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");

    // Positive pair, API: every round-1 row is seated (two boards and the bye).
    const paired = await round1();
    expect(paired.length, "premise: five players seat two boards and a bye").toBe(3);
    for (const f of paired) {
      expect(f.home_entrant_id !== null && (isBye(f) || f.away_entrant_id !== null), `${f.ext_key} is seated`).toBe(true);
    }
    const boards = paired.filter((f) => !isBye(f));
    expect(boards.length).toBe(2);

    // Positive pair, page: the run sheet names each board's players and shows the bye.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    for (const b of boards) {
      const row = page.locator(`li[data-fixture-no="${b.fixture_no}"]`);
      await expect(row).toContainText(nameOf.get(b.home_entrant_id!)!, { timeout: 20_000 });
      await expect(row).toContainText(nameOf.get(b.away_entrant_id!)!);
    }
    await expect(page.getByTestId("run-sheet-bye")).toHaveCount(1);

    // Undo, on the History panel.
    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=history"));
    const undo = page.getByTestId("history-undo");
    await expect(undo).toBeEnabled({ timeout: 20_000 });
    // Review m4: wait on the Undo's own answer before judging the panel. A no-error check read before the request
    // returns passes on a refusal that has not rendered yet.
    const undone = page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/divisions/${divisionId}/undo`) && r.request().method() === "POST",
    );
    await undo.click();
    expect((await undone).status(), "the Undo is answered 200").toBe(200);

    // The seats are empty and the shells stay: same ids, nobody seated, nothing decided.
    await expect
      .poll(async () => (await round1()).filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null).length, {
        timeout: 20_000,
      })
      .toBe(0);
    // After the answer and the cleared seats: the panel shows no refusal.
    await expect(page.getByTestId("history-error")).toHaveCount(0);
    const after = await round1();
    expect(after.map((f) => f.id).sort(), "Undo keeps every shell").toEqual(paired.map((f) => f.id).sort());

    // And on the run sheet: the board rows are still there, naming nobody; the bye row is gone.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    for (const b of boards) {
      const row = page.locator(`li[data-fixture-no="${b.fixture_no}"]`);
      await expect(row).toBeAttached({ timeout: 20_000 });
      await expect(row).not.toContainText(nameOf.get(b.home_entrant_id!)!);
      await expect(row).not.toContainText(nameOf.get(b.away_entrant_id!)!);
    }
    await expect(page.getByTestId("run-sheet-bye")).toHaveCount(0);
  });
});

// W3 T8 (spec §12; X-SW-22 SW-L6 RB3-16, BG-SW-1 SW-H3 RB3-10). Two halves, each through the real desk:
//   BG-SW-1 — a boardgame Swiss created now is a chess Swiss, and round 1's colours are by lot: board 1's upper player
//             takes the lot's colour and the boards alternate. Read where the arbiter reads it: the Arbiter Panel's
//             round column names White first.
//   X-SW-22 — an unseeded round 1 is the stage's seeded random draw. The organiser is told so in the Pair next menu,
//             and the Pair seats the draw (the stage's own seed over the field in the order the server reads it).
// Expected values come from the rulebook (the fold: position k meets position k + n/2, the upper at home; the lot's
// alternation) composed with the pure draw functions — never read back from the Pair under test.
test.describe("X-SW-22 / BG-SW-1", () => {
  test("BG-SW-1 a new boardgame Swiss is a chess Swiss: round 1 is coloured by lot and the boards alternate White and Black", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // Seeded 1..8 by the kit (seed = position in `names`), so no draw: only the lot moves a seat.
    const names = Array.from({ length: 8 }, (_, i) => `Lot P${i + 1} ${TAG}`);
    const r = await seedOnlineRound(request, names, { stage: "swiss", open: false });
    const stages = await apiJson<{ id: string; config: Record<string, unknown> }[]>(request, `/api/v1/divisions/${r.divisionId}/stages`);
    expect(stages.status, JSON.stringify(stages.error)).toBe(200);
    expect(stages.data!.find((s) => s.id === r.stageId)?.config.chess, "the create door stored chess colours on").toBe(true);

    const lot = swissColourLot(swissDrawSeed(r.stageId));
    const half = names.length / 2;
    // The fold, upper at home, then the lot: board k's upper player is White iff (k is odd) === (the lot is white).
    const expected = Array.from({ length: half }, (_, i) => {
      const [upper, lower] = [names[i]!, names[i + half]!];
      const upperWhite = (i % 2 === 0) === (lot === "white");
      return upperWhite ? { white: upper, black: lower } : { white: lower, black: upper };
    });
    expect(r.boards.map((b) => ({ white: b.home.name, black: b.away.name })), "home is White, by lot").toEqual(expected);
    // The alternation itself, stated apart from the formula above: the upper players' colours never repeat board to board.
    const upperIsWhite = expected.map((b, i) => b.white === names[i]);
    let flips = 0;
    for (let i = 1; i < upperIsWhite.length; i++) {
      expect(upperIsWhite[i], `board ${i + 1} alternates from board ${i}`).not.toBe(upperIsWhite[i - 1]);
      flips++;
    }
    expect(flips, "anti-vacuity: every adjacent pair of boards compared").toBe(half - 1);

    // On the arbiter's screen: White first on every board, before the round is opened.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    const column = page.getByTestId("arbiter-round-column");
    await expect(column, "paired, not opened").toHaveAttribute("data-phase", "before", { timeout: 30_000 });
    for (const [i, b] of r.boards.entries()) {
      const sides = page.getByTestId(`arbiter-column-pairing-${b.fixtureId}`).locator('[data-field="names"] > span');
      await expect(sides.nth(0), `board ${i + 1}: White`).toHaveText(expected[i]!.white);
      await expect(sides.nth(2), `board ${i + 1}: Black`).toHaveText(expected[i]!.black);
    }
  });

  test("X-SW-22 an unseeded round 1: the Pair next menu says it is drawn at random, and the Pair seats the stage's draw", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Drawn round one ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Drawn P${i + 1} ${TAG}`, seed: null })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 3 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);

    // The organiser opens ▾ before pressing Pair next: round 1, and the line that says the field is drawn.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const menu = page.getByTestId("stage-pairing-menu");
    await expect(async () => {
      if ((await menu.count()) === 0) await page.getByTestId("stage-pairing-toggle").click();
      await expect(menu).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("stage-pairing-draw-note")).toHaveText(uiEn["schedule.pairing.drawnAtRandom"]);
    await expect(menu).toHaveAttribute("aria-describedby", `pairing-draw-note-${stageId}`);
    await page.getByTestId("stage-generate").click();

    const round1 = async () => {
      const all = await apiJson<Seated[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
      expect(all.status, JSON.stringify(all.error)).toBe(200);
      return (all.data ?? [])
        .filter((f) => f.stage_id === stageId && f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)
        .sort((a, b) => a.seq_in_round - b.seq_in_round);
    };
    await expect.poll(async () => (await round1()).length, { timeout: 30_000 }).toBe(4);

    // The field in the order the Pair reads it (the server's active select), drawn with the stage's own seed.
    const field = await withDb((sql) => sql<{ id: string; seed: number | null }[]>`
      select id, seed from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')
       order by seed nulls last, created_at, id`);
    expect(field.length, "premise: the whole field is active").toBe(8);
    const drawn = swissRoundOneOrder(swissDrawSeed(stageId), field);
    // The fold over the drawn positions; a generic Swiss has no colours, so the upper position sits at home.
    const expected = Array.from({ length: 4 }, (_, i) => ({ home: drawn[i], away: drawn[i + 4] }));
    expect((await round1()).map((f) => ({ home: f.home_entrant_id, away: f.away_entrant_id })), "the stage's draw").toEqual(expected);
  });
});
