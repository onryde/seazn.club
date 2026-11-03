import { test, expect, type TestInfo } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  activeOrgIdFromRequest,
  competitionPath,
  divisionPath,
  expectNoHorizontalScroll,
  fixturePath,
  scoreFixture,
  seedVenueWithCourts,
  withDb,
} from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import { openFormatDialog } from "./helpers/rules-strip";
import { spectator } from "./spectator-w2-kit";
import { fill, seedOnlineRound, uiEn } from "./match-room-kit";
import type { Page } from "@playwright/test";
import { swissColourLot, swissDrawSeed, swissRoundOneOrder } from "../src/lib/swiss-draw";
import {
  LATE_SPORTS,
  addLatePlayer,
  isByeRow,
  noticeLines,
  scoreAt,
  showAllFixtures,
  stageFixtures,
  startedSwiss,
  type Fx,
  type LateEntryAnswer,
  type Seated,
} from "./support/swiss-app-a-kit";
import { builtinModules } from "@seazn/engine/sports";

// W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md). One
// describe per rule, each driven through the real desk.

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const position = (f: Pick<Fx, "pool_id" | "round_no" | "seq_in_round">) =>
  `${f.pool_id ?? "-"}|${f.round_no}|${f.seq_in_round}`;

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

    // The desk: the rail renders its controls, no Add match, and the guidance in its place. SCF (owner pick, Option A): "in its place" is the
    // stage's LEGEND line now - information, not an action, so it is read on every width without opening the phone's Stage tools sheet, and
    // it is not in the rail's row at all.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await expect(page.getByTestId("stage-generate")).toBeAttached({ timeout: 20_000 });
    const note = page.getByTestId("stage-swiss-adhoc-note");
    await expect(note, "visible with nothing opened - it is not behind the phone's sheet").toBeVisible();
    await expect(note).toHaveText("Swiss rounds are paired by the system. Add friendlies in another stage.");
    expect(
      await note.evaluate((n) => n.parentElement === document.querySelector('[data-testid="stage-swiss-legend"]')?.parentElement),
      "the sentence shares the legend line's container",
    ).toBe(true);
    await expect(page.getByTestId("stage-rail").getByTestId("stage-swiss-adhoc-note"), "and the action row does not hold it").toHaveCount(0);
    await expect(page.getByTestId("stage-add-match")).toHaveCount(0);
  });
});

// X-SW-16 (W3 T11, SW-H2, RB3-3; rulebook-W3-swiss.md §3.1/§3.2): a field of 4 pairs at most 3 rounds (hard maximum
// n − 1 for an even field). A 5-round Swiss over it used to start and dead-end; Start now refuses it before anything is
// written, and the console says why in the reader's language with the field's guidance (§3.2: 2 recommended, at most 3).
// The Settings tab's Rounds box names the same guidance before the organiser presses anything. Generic sport: the bounds
// are arithmetic on the field, which no sport field reaches (swiss-rounds-cap.test.ts sweeps every sport on the server).
test.describe("X-SW-16 rounds above the hard max are refused at Start", () => {
  test("4 entrants × 5 rounds: Start is refused with the field's guidance, the division stays in setup, and the Format dialog names the guidance", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Rounds cap ${TAG}`,
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
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Cap P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 5 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;

    const guidance = uiEn["swiss.rounds.guidance.other"]!.replace("{n}", "4").replace("{count}", "2").replace("{hardMax}", "3");
    expect(guidance, "premise: the copy names the field, the recommendation and the hard maximum").toBe(
      "For 4 entrants: 2 rounds recommended, at most 3.",
    );

    // The console's Start, then its confirmation: refused, said in English copy from the dictionary, not the wire's.
    await page.goto(await divisionPath(request, divisionId));
    await page.getByRole("button", { name: "Start tournament" }).click();
    await page.getByTestId("start-confirm-confirm").click();
    await expect(page.getByText(`${uiEn["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${guidance}`)).toBeVisible({ timeout: 20_000 });

    // Nothing was written: the division is still in setup and the stage holds no fixture.
    const after = await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`);
    expect(after.status, JSON.stringify(after.error)).toBe(200);
    expect(after.data!.status).toBe("setup");
    expect(await stageFixtures(request, divisionId, stageId)).toEqual([]);

    // The API answers the same: 422 SWISS_ROUNDS_ABOVE_MAX naming the rounds, the field and the hard maximum.
    const refused = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(refused.status).toBe(422);
    expect(refused.error).toMatchObject({ code: "SWISS_ROUNDS_ABOVE_MAX", rounds: 5, field: 4, hardMax: 3, canFinish: false });

    // The Format dialog (FMT5: Settings › Format moved onto the Fixtures tab's Division rules card), before Start: it opens on
    // the stored Swiss, its Rounds box takes 1 and names the field's guidance under it.
    const formatDialog = await openFormatDialog(page, (await divisionPath(request, divisionId)).split("?")[0]!);
    const rounds = formatDialog.getByRole("spinbutton", { name: uiEn["wizard.rounds"]!, exact: true });
    await expect(rounds).toHaveAttribute("min", "1");
    await expect(rounds).toHaveValue("5");
    await expect(formatDialog.getByTestId("builder-swiss-rounds-guidance")).toHaveText(guidance);
    await expect(rounds, "the guidance is the box's description").toHaveAccessibleDescription(guidance);
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

    // The auto pass. The placement service lays a board from the window's first org-local midnight (so a board can sit
    // at 00:00 on 2030-06-18), the greedy fallback from the 11:00Z start. The boards do NOT always land on the window's
    // first day: X-SW-29 (W3 T11 finding) - the solver's lattice runs one slack day past greedy's end
    // (`boundSolverWindow`), every objective rung (placed > days > day_span > day_start > idle_gap > imbalance) is
    // shift-invariant, so the whole board can tie onto 2030-06-19 (measured about 1 run in 4 on a 4-vCPU placement
    // container, the CI runner's size). The day assertion below is the defect's witness and is deliberately NOT relaxed;
    // owner decision pending (W3 App B task-11 report).
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
    // proves only that. That a bye prints no SHEET even when it holds a time (a pre-V485 row, which only SQL can seed)
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


// W3 T10 (X-SW-12, X-SW-13, X-SW-14 UI half; ruling 250; owner pick: option A). "Add late player" sits in the Swiss
// stage rail's More menu and opens the Entrants tab's EXISTING add form (controller ruling 1). Each case is set up by
// the rulebook's own conditions, then driven through the desk, and read back where the organiser reads it: the notice
// under the form, and the run sheet.
//   (a) nothing of the round has started            → the round is re-paired with the newcomer;
//   (b) a board has started, the field was odd      → the newcomer plays the round's bye holder;
//   (c) a board has started, the field was even     → the newcomer joins from the next round;
//   the last round has started                      → refused by name (SWISS_NO_ROUND_LEFT), nothing written.
// The notice's expected lines are the ruling's copy table (en dictionary, values filled here) applied to the server's own
// answer (`late_entry` on the POST the form sent) — never the desk's notice builder, which is the code under test.
// Two sports, the same body: badminton and chess (boardgame, colours on).
/** W3 T10c: does the sport's engine module declare a doubles pair (`entrantModel.kinds`)? Chess is individual-only, so the
 *  pair step runs only where the engine says a pair exists — and at least one LATE_SPORTS sport must, or it would vanish. */
const takesPairs = (key: string) => builtinModules.find((m) => m.key === key)?.entrantModel?.kinds.includes("pair") === true;
if (!LATE_SPORTS.some((s) => takesPairs(s.key))) throw new Error("no LATE_SPORTS sport takes a pair: the doubles step would never run");

/** The ruling's copy table over the server's answer (see the describe's header): the lines the notice owes, in order. */
function owedLines(le: LateEntryAnswer, nameOf: (id: string) => string): { tone: "done" | "todo"; text: string }[] {
  const name = nameOf(le.entrant_id);
  const out: { tone: "done" | "todo"; text: string }[] = [];
  const unscheduled = () => {
    if (le.new_board && !le.new_board.scheduled) out.push({ tone: "todo", text: fill("swiss.lateEntry.newMatchUnscheduled") });
  };
  if (le.case === "a") {
    const changed = le.repaired!.changed_entrant_ids;
    if (changed.length === 0) out.push({ tone: "done", text: fill("swiss.lateEntry.repairedNoChange", { round: le.round, name }) });
    else {
      const key = changed.length === 1 ? "swiss.lateEntry.repaired.one" : "swiss.lateEntry.repaired.other";
      out.push({ tone: "done", text: fill(key, { round: le.round, name, count: changed.length }) });
      const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(
        changed.map(nameOf).sort((x, y) => x.localeCompare(y, "en")),
      );
      out.push({ tone: "todo", text: fill("swiss.lateEntry.tellChanged", { names }) });
    }
    if (changed.length > 0 || le.new_board) out.push({ tone: "todo", text: fill("swiss.lateEntry.reprintSheets", { round: le.round }) });
    unscheduled();
  } else if (le.case === "b") {
    out.push({ tone: "done", text: fill("swiss.lateEntry.tookBye", { name, holder: nameOf(le.bye_holder_id!), round: le.round }) });
    unscheduled();
  } else {
    out.push({ tone: "done", text: fill("swiss.lateEntry.nextRound", { name, round: le.round }) });
  }
  return out;
}

for (const sport of LATE_SPORTS) {
  test.describe(`X-SW-12 add a late player in each case (${sport.key})`, () => {
    /** A name for a PERSON a test creates. Players is the org's whole list and outlives a test, and `TAG` is minted once
     *  per worker process, so a name built from `TAG` alone is shared by the same test of the other sport when one worker
     *  runs both (the premise "not in Players" then fails), and by a rerun of the same test in one process (--repeat-each).
     *  Sport and attempt are part of the name: no two runs of any test ask for the same person. */
    const personName = (stem: string, testInfo: TestInfo) => `${stem} ${TAG} ${sport.key} r${testInfo.retry}`;

    test(`(a) before any board starts: the round is re-paired with the newcomer (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 3, "LateA");
      const late = `LateA Zoe ${TAG}`;
      const { status, body } = await addLatePlayer(page, request, r.divisionId, late);
      expect(status, JSON.stringify(body.error)).toBe(201);
      const le = body.data!.late_entry!;
      expect(le, "a late add answers its case").toBeDefined();
      expect([le.case, le.round], "nothing started: round 1 is re-paired").toEqual(["a", 1]);
      const nameOf = (id: string) => (id === body.data!.id ? late : r.nameOf.get(id)!);
      expect(await noticeLines(page)).toEqual(owedLines(le, nameOf));

      // The run sheet: round 1 now seats the newcomer (seven entrants: three boards and a bye).
      const seated = (await r.round(1)).find((f) => f.home_entrant_id === body.data!.id || f.away_entrant_id === body.data!.id);
      expect(seated, "the newcomer is seated in round 1").toBeDefined();
      expect((await r.boards(1)).length).toBe(3);
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      if (isByeRow(seated!)) await expect(page.getByTestId("run-sheet-bye")).toContainText(late, { timeout: 20_000 });
      else await expect(page.locator(`li[data-fixture-no="${seated!.fixture_no}"]`)).toContainText(late, { timeout: 20_000 });
    });

    test(`(b) after one board starts on an odd field: the newcomer plays the bye holder (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 5, 3, "LateB");
      const round1 = await r.round(1);
      const bye = round1.find(isByeRow);
      expect(bye?.home_entrant_id, "premise: five entrants leave a seated bye").toBeTruthy();
      const holder = r.nameOf.get(bye!.home_entrant_id!)!;
      await scoreAt(request, (await r.boards(1))[0]!.id, "core.start");

      const late = `LateB Zoe ${TAG}`;
      const { status, body } = await addLatePlayer(page, request, r.divisionId, late);
      expect(status, JSON.stringify(body.error)).toBe(201);
      const le = body.data!.late_entry!;
      expect([le.case, le.round, le.bye_holder_id], "a started round with a bye: the newcomer takes it").toEqual(["b", 1, bye!.home_entrant_id]);
      const nameOf = (id: string) => (id === body.data!.id ? late : r.nameOf.get(id)!);
      expect(await noticeLines(page)).toEqual(owedLines(le, nameOf));

      // The run sheet: the new board names both, and no bye is left in round 1.
      const board = (await r.round(1)).find((f) => f.id === le.new_board?.fixture_id);
      expect(board, "the new board is round 1's").toBeDefined();
      expect([board!.home_entrant_id, board!.away_entrant_id].sort()).toEqual([body.data!.id, bye!.home_entrant_id].sort());
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await showAllFixtures(page);
      const row = page.locator(`li[data-fixture-no="${board!.fixture_no}"]`);
      await expect(row).toContainText(late, { timeout: 20_000 });
      await expect(row).toContainText(holder);
      await expect(page.getByTestId("run-sheet-bye")).toHaveCount(0);
    });

    test(`(c) after one board starts on an even field: the newcomer joins from round 2 (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 3, "LateC");
      await scoreAt(request, (await r.boards(1))[0]!.id, "core.start");
      const before = (await r.round(1)).map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]);

      const late = `LateC Zoe ${TAG}`;
      const { status, body } = await addLatePlayer(page, request, r.divisionId, late);
      expect(status, JSON.stringify(body.error)).toBe(201);
      const le = body.data!.late_entry!;
      expect([le.case, le.round], "no bye to take: the next round").toEqual(["c", 2]);
      const nameOf = (id: string) => (id === body.data!.id ? late : r.nameOf.get(id)!);
      expect(await noticeLines(page)).toEqual(owedLines(le, nameOf));

      // Round 1 is untouched, and the rail counts the latecomer the next Pair seats.
      expect((await r.round(1)).map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]), "round 1 stands").toEqual(before);
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await expect(page.getByTestId("stage-swiss-latecomer")).toHaveText(fill("swiss.lateEntry.joinNextRound.one", { count: 1 }), {
        timeout: 20_000,
      });
      // No line of the run sheet names the latecomer: round 1's three boards are listed (so the sheet is not empty) and
      // none of its rows, nor a bye line, carries the name.
      await showAllFixtures(page);
      const round1 = await r.boards(1);
      expect(round1.length, "premise: six entrants pair three boards").toBe(3);
      for (const f of round1) await expect(page.locator(`li[data-fixture-no="${f.fixture_no}"]`)).toBeVisible();
      await expect(page.locator("li[data-fixture-no]").filter({ hasText: late })).toHaveCount(0);
      await expect(page.getByTestId("run-sheet-bye").filter({ hasText: late })).toHaveCount(0);
      // Where the name IS shown: the stage's "Waiting for the next round" line (the roster-drift banner in its Swiss
      // state), which says Pair next round seats them — the same fact the rail's count states.
      const waiting = page.getByTestId("roster-drift-banner");
      await expect(waiting).toHaveAttribute("data-roster-drift-state", "swiss-awaiting-pairing");
      await expect(waiting).toContainText(late);
    });

    // W3 T10c (owner 2026-11-01, "support all entrant kind"): a doubles PAIR is the late entrant (spec §4 "Doubles"). A
    // field of six pairs, round 1 paired and nothing started — (a). The pair is built in the form: the Pair kind, one
    // player picked from Players, the partner created with New player. Only where the engine declares a pair.
    if (takesPairs(sport.key)) {
      test(`a late doubles PAIR through the form, one player picked and one created: (a) seats it in round 1 (${sport.key})`, async ({ page, request }, testInfo) => {
        test.setTimeout(180_000);
        const r = await startedSwiss(request, sport, 6, 3, "LateP", "pair");
        const existing = personName("LateP Ann", testInfo);
        const created = personName("LateP Bea", testInfo);
        const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: existing });
        expect(person.status, JSON.stringify(person.error)).toBe(201);
        const { status, body } = await addLatePlayer(page, request, r.divisionId, created, { pair: { existing, created } });
        expect(status, JSON.stringify(body.error)).toBe(201);
        const entrant = body.data!;
        expect(entrant.kind, "a pair entrant").toBe("pair");
        const members = await withDb(async (sql) =>
          (await sql<{ full_name: string }[]>`
            select p.full_name from entrant_members m join persons p on p.id = m.person_id where m.entrant_id = ${entrant.id}`).map((m) => m.full_name),
        );
        expect(members.sort(), "the pair is the two players").toEqual([existing, created].sort());
        const le = entrant.late_entry!;
        expect([le.case, le.round], "nothing started: round 1 is re-paired with the pair").toEqual(["a", 1]);
        const nameOf = (id: string) => (id === entrant.id ? entrant.display_name : r.nameOf.get(id)!);
        expect(await noticeLines(page)).toEqual(owedLines(le, nameOf));

        // The run sheet: round 1 seats the pair (seven pairs: three boards and a bye).
        const seated = (await r.round(1)).find((f) => f.home_entrant_id === entrant.id || f.away_entrant_id === entrant.id);
        expect(seated, "the pair is seated in round 1").toBeDefined();
        expect((await r.boards(1)).length).toBe(3);
        await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
        if (isByeRow(seated!)) await expect(page.getByTestId("run-sheet-bye")).toContainText(entrant.display_name, { timeout: 20_000 });
        else await expect(page.locator(`li[data-fixture-no="${seated!.fixture_no}"]`)).toContainText(entrant.display_name, { timeout: 20_000 });
      });
    }

    // Owner ruling 2026-11-01: a late arrival who is NOT in Players yet. New player creates the person in the form,
    // the entrant carries that person, and the case decides the seat exactly as it does for a name-only add.
    const personIdsNamed = (full: string) =>
      withDb(async (sql) => (await sql<{ id: string }[]>`select id from persons where full_name = ${full} and merged_into is null`).map((r) => r.id));
    const membersOf = (entrantId: string) =>
      withDb(async (sql) => (await sql<{ person_id: string }[]>`select person_id from entrant_members where entrant_id = ${entrantId}`).map((r) => r.person_id));

    test(`New player (a): someone not in Players is created, picked, and seated in round 1 (${sport.key})`, async ({ page, request }, testInfo) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 3, "LateNA");
      const late = personName("LateNA Yara", testInfo);
      expect(await personIdsNamed(late), "premise: not in Players").toEqual([]);
      const { status, body } = await addLatePlayer(page, request, r.divisionId, late, { viaNewPlayer: true });
      expect(status, JSON.stringify(body.error)).toBe(201);
      const people = await personIdsNamed(late);
      expect(people, "exactly one person created").toHaveLength(1);
      expect(await membersOf(body.data!.id), "the entrant is that person").toEqual(people);
      const le = body.data!.late_entry!;
      expect([le.case, le.round]).toEqual(["a", 1]);
      const nameOf = (id: string) => (id === body.data!.id ? late : r.nameOf.get(id)!);
      expect(await noticeLines(page)).toEqual(owedLines(le, nameOf));
      const seated = (await r.round(1)).find((f) => f.home_entrant_id === body.data!.id || f.away_entrant_id === body.data!.id);
      expect(seated, "seated in round 1").toBeDefined();
    });

    test(`New player (c): someone not in Players is created and queued for round 2 (${sport.key})`, async ({ page, request }, testInfo) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 3, "LateNC");
      await scoreAt(request, (await r.boards(1))[0]!.id, "core.start");
      const late = personName("LateNC Yara", testInfo);
      const { status, body } = await addLatePlayer(page, request, r.divisionId, late, { viaNewPlayer: true });
      expect(status, JSON.stringify(body.error)).toBe(201);
      const people = await personIdsNamed(late);
      expect(people).toHaveLength(1);
      expect(await membersOf(body.data!.id)).toEqual(people);
      const le = body.data!.late_entry!;
      expect([le.case, le.round], "queued for the next round").toEqual(["c", 2]);
      expect(
        (await r.round(1)).some((f) => f.home_entrant_id === body.data!.id || f.away_entrant_id === body.data!.id),
        "not seated in the started round",
      ).toBe(false);
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await expect(page.getByTestId("stage-swiss-latecomer")).toHaveText(fill("swiss.lateEntry.joinNextRound.one", { count: 1 }), {
        timeout: 20_000,
      });

      // A second late arrival with the SAME name, typed in another case: New player finds the existing person (no duplicate)
      // and - UI5 item 3, one person one entry per division - says she is already entered here instead of picking her.
      await page.goto(await divisionPath(request, r.divisionId, "?tab=entrants"));
      const form = page.locator("#add-entrant");
      await form.getByTestId("new-player-name").fill(`  ${late.toUpperCase()}  `);
      await form.getByTestId("new-player-add").click();
      await expect(form.getByTestId("new-player-note")).toHaveText(uiEn["entrants.err.personAlreadyEntered"]!.replace("{name}", late));
      expect(await personIdsNamed(late), "no duplicate person").toHaveLength(1);
    });

    test(`the last round started: refused by name, nothing written, and More is still offered (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 1, "LateR");
      await scoreAt(request, (await r.boards(1))[0]!.id, "core.start");
      const count = async () => (await apiJson<unknown[]>(request, `/api/v1/divisions/${r.divisionId}/entrants`)).data!.length;
      const n = await count();

      const { status, body } = await addLatePlayer(page, request, r.divisionId, `LateR Zoe ${TAG}`);
      expect([status, body.error?.code]).toEqual([409, "SWISS_NO_ROUND_LEFT"]);
      // 6 players × 1 round: round 2 fits (hard max 5), so the sentence names Add a round (T12 Fix round 1, review I1).
      await expect(page.getByTestId("entrants-error")).toHaveText(
        `${uiEn["swiss.refusal.SWISS_NO_ROUND_LEFT"]!} ${uiEn["swiss.rounds.noRoundLeft.add"]!}`,
      );
      await expect(page.getByTestId("entrants-late-entry-line")).toHaveCount(0);
      expect(await count(), "nothing written").toBe(n);

      // At the last round the action stays: the refusal is the organiser's answer, not a missing button.
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await expect(page.getByTestId("stage-more")).toBeVisible({ timeout: 20_000 });
    });

    // X-SW-8 (Task 6's UI path): a latecomer who missed two rounds scores 0 for them, so round 3 never pairs them with
    // a two-win entrant. Six entrants play rounds 1 and 2 (the home side wins every board); one board of round 2 has
    // started, so the newcomer joins from round 3 (c). Round 3 is paired through the desk's own Pair next.
    test(`X-SW-8 a latecomer who missed two rounds is paired as 0, never with a two-win entrant (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(240_000);
      const r = await startedSwiss(request, sport, 6, 3, "LateS");
      const wins = new Map<string, number>(r.names.map((n) => [r.idOf(n), 0]));
      for (const f of await r.boards(1)) {
        await sport.win(request, f, f.home_entrant_id!);
        wins.set(f.home_entrant_id!, wins.get(f.home_entrant_id!)! + 1);
      }
      const pair2 = await apiJson(request, `/api/v1/stages/${r.stageId}/generate`, "POST");
      expect(pair2.status, JSON.stringify(pair2.error)).toBe(200);
      const round2 = await r.boards(2);
      expect(round2.length, "premise: round 2 is paired").toBe(3);
      await scoreAt(request, round2[0]!.id, "core.start");

      const late = `LateS Zoe ${TAG}`;
      const { status, body } = await addLatePlayer(page, request, r.divisionId, late);
      expect(status, JSON.stringify(body.error)).toBe(201);
      expect([body.data!.late_entry!.case, body.data!.late_entry!.round]).toEqual(["c", 3]);
      const lateId = body.data!.id;

      for (const f of round2) {
        // The started board is played on from its Start; the others from scratch.
        if (f.id === round2[0]!.id) {
          if (sport.key === "boardgame") await scoreAt(request, f.id, "boardgame.result", { winner: f.home_entrant_id, method: "resign" });
          else for (let g = 0; g < 2; g++) await scoreAt(request, f.id, "badminton.game.summary", { home: 21, away: 10 });
        } else await sport.win(request, f, f.home_entrant_id!);
        wins.set(f.home_entrant_id!, wins.get(f.home_entrant_id!)! + 1);
      }
      const twoWins = [...wins].filter(([, w]) => w === 2).map(([id]) => id);
      expect(twoWins.length, "anti-vacuity: someone has two wins for the latecomer to be wrongly paired with").toBeGreaterThan(0);

      // Pair round 3 on the desk.
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await page.getByTestId("stage-generate").click();
      await expect.poll(async () => (await r.round(3)).filter((f) => f.home_entrant_id !== null).length, { timeout: 30_000 }).toBe(4);
      const mine = (await r.round(3)).find((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId);
      expect(mine, "the latecomer is seated in round 3").toBeDefined();
      const opponent = mine!.home_entrant_id === lateId ? mine!.away_entrant_id : mine!.home_entrant_id;
      expect(opponent === null || !twoWins.includes(opponent), "never paired with a two-win entrant (0, not +2)").toBe(true);
      // Review m4: pin the bye too, from the rulebook (the bye goes to the LOWEST score group; within it the order is
      // sport tie-break, so not WHO). Seven entrants, so round 3 has one. The latecomer counts 0: the lowest group is
      // the 0-win entrants plus the latecomer, and a +2 latecomer could only hold the bye if the bye left that group.
      const byeRow = (await r.round(3)).find(isByeRow);
      expect(byeRow?.home_entrant_id, "an odd round 3 seats a bye").toBeTruthy();
      const lowest = new Set([...[...wins].filter(([, w]) => w === 0).map(([id]) => id), lateId]);
      expect(lowest.has(byeRow!.home_entrant_id!), "the bye is in the lowest score group").toBe(true);
      if (opponent !== null) expect(wins.get(opponent), "a 0-point latecomer meets the lowest group it can").toBeLessThanOrEqual(1);
      else expect(byeRow!.home_entrant_id, "or holds the bye itself").toBe(lateId);
      if (opponent === null) await expect(page.getByTestId("run-sheet-bye")).toContainText(late, { timeout: 20_000 });
      else await expect(page.locator(`li[data-fixture-no="${mine!.fixture_no}"]`)).toContainText(late, { timeout: 20_000 });
    });

    // X-SW-15 (Task 7's UI path): a pair whose match was not played has not met. Four entrants, three rounds. Round 1 is
    // the fold; S1 and S4 win, so round 2 pairs {S1, S4} and {S2, S3}. Both round-2 boards end as double walkovers
    // through the console's Forfeit dialog (Neither → walkover). Round 3, paired on the desk, re-seats both pairs:
    // played, they would have met, and round 3 would be S1-S2 and S3-S4.
    test(`X-SW-15 a double walkover pair may meet again (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(240_000);
      const r = await startedSwiss(request, sport, 4, 3, "Unplayed");
      const [s1, s2, s3, s4] = r.names.map(r.idOf);
      for (const f of await r.boards(1)) {
        const winner = [f.home_entrant_id, f.away_entrant_id].find((id) => id === s1 || id === s4);
        expect(winner, "premise: the fold puts S1 and S4 on different boards").toBeTruthy();
        await sport.win(request, f, winner!);
      }
      const pair2 = await apiJson(request, `/api/v1/stages/${r.stageId}/generate`, "POST");
      expect(pair2.status, JSON.stringify(pair2.error)).toBe(200);
      const pairsOf = async (round: number) =>
        (await r.boards(round)).map((f) => [r.nameOf.get(f.home_entrant_id!)!, r.nameOf.get(f.away_entrant_id!)!].sort().join(" | ")).sort();
      const REMATCH = [[s1, s4], [s2, s3]].map((p) => p.map((id) => r.nameOf.get(id!)!).sort().join(" | ")).sort();
      expect(await pairsOf(2), "premise: round 2 pairs the score groups").toEqual(REMATCH);

      for (const f of await r.boards(2)) {
        await page.goto(await fixturePath(request, f.id));
        await page.getByTestId("score-forfeit").click({ timeout: 20_000 });
        const d = page.getByTestId("forfeit-dialog");
        await expect(d).toBeVisible({ timeout: 10_000 });
        await d.getByTestId("forfeit-who-both").click();
        await expect(d.getByTestId("forfeit-why-walkover")).toBeChecked();
        await expect(d.getByTestId("forfeit-confirm")).toHaveText(uiEn["forfeitDialog.confirm.doubleWalkover"]!);
        await d.getByTestId("forfeit-confirm").click();
        await expect
          .poll(async () => (await apiJson<{ outcome: { kind?: string } | null }>(request, `/api/v1/fixtures/${f.id}/state`)).data?.outcome?.kind, {
            timeout: 20_000,
          })
          .toBe("double_walkover");
      }

      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await page.getByTestId("stage-generate").click();
      await expect.poll(async () => (await r.boards(3)).length, { timeout: 30_000 }).toBe(2);
      expect(await pairsOf(3), "round 3 re-seats both unplayed pairs").toEqual(REMATCH);
      for (const f of await r.boards(3)) {
        const row = page.locator(`li[data-fixture-no="${f.fixture_no}"]`);
        await expect(row).toContainText(r.nameOf.get(f.home_entrant_id!)!, { timeout: 20_000 });
        await expect(row).toContainText(r.nameOf.get(f.away_entrant_id!)!);
      }
    });

    // X-SW-30 (W3 T14, SW-L12, RB3-25): a board's seats cannot be edited in round 2 or later (PATCH /fixtures/{id} refuses
    // them: fixtures/[id]/__tests__/route.test.ts, smoke check 19) and the Swiss rules decide the pairing, so the Pair next
    // menu's read-only line says so and names the way to re-derive it after a correction — Unpair, then Pair next — and the
    // organiser can follow it (with nothing corrected the same pairing comes back, which is what the wording says). Round 1 paired and unplayed, so round 2 is the one
    // waiting and Unpair is on the rail; the line is read off the real menu, the way the organiser reads it. Following it
    // brings round 1 back as the choosable round, which carries no such line; Pair next seats round 1 again and round 2
    // waits with the line.
    test(`X-SW-30 round 2 waiting: the Pair next menu says Unpair then Pair next, and following it works (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 3, "Hint30");
      const pairsOf = async () => (await r.boards(1)).map((f) => [f.home_entrant_id, f.away_entrant_id].sort().join("|")).sort();
      const paired = await pairsOf();
      expect(paired.length, "premise: round 1 is paired, three boards for six").toBe(3);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      const menu = page.getByTestId("stage-pairing-menu");
      const hint = page.getByTestId("stage-pairing-change-hint");
      const openMenu = () =>
        expect(async () => {
          if ((await menu.count()) === 0) await page.getByTestId("stage-pairing-toggle").click();
          await expect(menu).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 30_000 });

      // Round 2 waiting: the read-only line, then the guidance, and the button it names beside Pair next.
      await openMenu();
      await expect(page.getByTestId("stage-pairing-readonly"), "round 2 is the read-only round").toBeVisible();
      await expect(hint).toHaveText(uiEn["schedule.pairing.changeHint"]!);
      await expect(page.getByTestId("stage-unpair"), "the button the line names").toBeVisible();

      // Follow it: Unpair puts round 1 back on its shells, and round 1 is the choosable round again — no guidance there.
      await page.getByTestId("stage-unpair").click();
      await expect.poll(async () => (await r.boards(1)).length, { timeout: 30_000 }).toBe(0);
      // The server has written; wait for the DESK to re-read it before opening the menu. The rail keys the menu's open
      // state to the round it was opened for (stage-rail.tsx, `pairingState`), so round 2's open menu stays on screen
      // until the refresh lands and then reads closed for round 1. Opening it before that finds the stale round-2 menu
      // already open, skips the toggle, and is closed under the assertion. With nothing seated, Unpair leaves the rail.
      await expect(page.getByTestId("stage-unpair"), "the desk re-read: nothing is seated, so nothing to unpair").toHaveCount(0, {
        timeout: 30_000,
      });
      await openMenu();
      await expect(page.getByTestId("stage-pairing-fold"), "round 1 is choosable again").toBeVisible();
      await expect(page.getByTestId("stage-pairing-readonly")).toHaveCount(0);
      await expect(hint).toHaveCount(0);

      // Then Pair next: round 1 is seated again (three boards for six), and round 2 waits with the line.
      await page.getByTestId("stage-generate").click();
      await expect.poll(async () => (await r.boards(1)).length, { timeout: 30_000 }).toBe(3);
      // The rules decide the pairing and nothing was corrected, so the same pairing comes back — which is what the line says.
      expect(await pairsOf(), "Unpair then Pair next with no change re-derives the same pairing").toEqual(paired);
      // As above: the desk re-reads before the menu is opened (round 1 seated again puts Unpair back on the rail), or the
      // toggle opens round 1's menu and the refresh closes it.
      await expect(page.getByTestId("stage-unpair"), "the desk re-read: round 1 is seated again").toBeVisible({ timeout: 30_000 });
      await openMenu();
      await expect(hint).toHaveText(uiEn["schedule.pairing.changeHint"]!);
    });
  });
}

// X-SW-17 (W3 T12, SW-M10, #838, RB3-5; owner pick B, "the edit dialog") and BG-SW-1's colours. Before the stage's first
// start the rail's "Rounds: N · Edit" opens a dialog that names exactly which unplayed rounds a new count removes, and
// Save writes it once; after the first start the count is a fixed chip, a PATCH is refused (409 SWISS_ROUNDS_LOCKED,
// and the chess colours by their OWN code, 422 SWISS_CHESS_LOCKED), and the More menu's "Add a round" mints round N + 1.
// The expected numbers are the rulebook's (§3.1: a field of 6 has hard max 5, safe max 3, 3 boards a round), never read
// off the code. Every sport in LATE_SPORTS (a racket sport and chess). UI5 item 4 (owner 2026-11-03): no card draws a chess
// colours switch any more — a chess Swiss always balances colours, and the door refuses `chess: false` (422
// SWISS_CHESS_ALWAYS_ON) before the first start and after it.
test.describe("X-SW-17 edit rounds, then add a round after play", () => {
  for (const sport of LATE_SPORTS) {
    test(`5 → 3 in the dialog before play; after the first start the count is fixed and Add a round mints round 4 (${sport.key})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000);
      const r = await startedSwiss(request, sport, 6, 5, "Rounds");
      const roundsIn = async () => [...new Set((await stageFixtures(request, r.divisionId, r.stageId)).map((f) => f.round_no))].sort((a, b) => a - b);
      expect(await roundsIn(), "premise: Start minted five rounds").toEqual([1, 2, 3, 4, 5]);

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      const chip = page.getByTestId("stage-rounds");
      await expect(chip).toHaveAttribute("data-state", "editable", { timeout: 20_000 });
      await expect(chip).toContainText(fill("stage.rounds.chip", { n: 5 }));

      // UI5 item 4: no chess colours switch on the card (the chip above is the loaded-page anchor), and on chess the door
      // refuses switching the colours off.
      const chess = page.getByTestId("stage-chess-switch");
      await expect(chess, "no chess colours switch").toHaveCount(0);
      const codeOf = (res: { error?: unknown }) => (res.error as { code?: string } | undefined)?.code;
      if (sport.key === "boardgame") {
        const off = await apiJson(request, `/api/v1/stages/${r.stageId}`, "PATCH", { chess: false });
        expect([off.status, codeOf(off)], "colours off, before play").toEqual([422, "SWISS_CHESS_ALWAYS_ON"]);
      }

      // The dialog: the field's guidance, then 5 → 3 names rounds 4 to 5 and their 6 unplayed matches before Save.
      await chip.click();
      const dialog = page.getByTestId("stage-rounds-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("stage-rounds-guidance")).toHaveText(fill("swiss.rounds.guidance.other", { n: 6, count: 3, hardMax: 5 }));
      await expect(dialog.getByTestId("stage-rounds-more"), "5 is the hard max for 6").toBeDisabled();
      await dialog.getByTestId("stage-rounds-fewer").click();
      await dialog.getByTestId("stage-rounds-fewer").click();
      await expect(dialog.getByTestId("stage-rounds-value")).toHaveText("3");
      await expect(dialog.getByTestId("stage-rounds-removed")).toHaveText(fill("stage.rounds.preview.removeMany.other", { from: 4, to: 5, count: 6 }));
      expect(await roundsIn(), "nothing written before Save").toEqual([1, 2, 3, 4, 5]);
      const saved = page.waitForResponse((res) => res.url().endsWith(`/api/v1/stages/${r.stageId}`) && res.request().method() === "PATCH");
      await dialog.getByTestId("stage-rounds-save").click();
      expect((await saved).status(), "Save writes once").toBe(200);
      await expect(dialog).toBeHidden();
      await expect(page.getByText(fill("schedule.notice.roundsSaved.other", { count: 3 }))).toBeVisible({ timeout: 20_000 });
      expect(await roundsIn(), "rounds 4 and 5 are gone").toEqual([1, 2, 3]);
      await expect(chip).toContainText(fill("stage.rounds.chip", { n: 3 }), { timeout: 20_000 });

      // Play starts: one board of round 1.
      await sport.win(request, (await r.boards(1))[0]!, (await r.boards(1))[0]!.home_entrant_id!);
      await page.reload();
      // SCF (owner pick, Option A): once a board has started the count cannot change, and a bordered pill that does nothing reads as a
      // button - so the row draws nothing for it; the legend line says "3 rounds". The legend first: it is the positive anchor that the
      // reloaded desk is on screen, so the absence below is read off a loaded page.
      await expect(page.getByTestId("stage-swiss-legend")).toContainText(fill("stage.swissLegend.rounds.other", { count: 3 }), { timeout: 20_000 });
      await expect(chip, "the fixed count is no longer a pill in the row").toHaveCount(0);
      await expect(chess, "still no chess colours switch once play has started").toHaveCount(0);
      if (sport.key === "boardgame") {
        const off = await apiJson(request, `/api/v1/stages/${r.stageId}`, "PATCH", { chess: false });
        expect([off.status, codeOf(off)], "colours off, after play: the permanent reason, not the start lock").toEqual([422, "SWISS_CHESS_ALWAYS_ON"]);
      }
      const lockedRounds = await apiJson(request, `/api/v1/stages/${r.stageId}`, "PATCH", { rounds: 2 });
      expect([lockedRounds.status, (lockedRounds.error as { code?: string } | undefined)?.code]).toEqual([409, "SWISS_ROUNDS_LOCKED"]);
      expect(lockedRounds.error).toMatchObject({ canFinish: false, canAddRound: true });
      const lockedChess = await apiJson(request, `/api/v1/stages/${r.stageId}`, "PATCH", { chess: true });
      expect([lockedChess.status, (lockedChess.error as { code?: string } | undefined)?.code]).toEqual([422, "SWISS_CHESS_LOCKED"]);

      // Add a round, from the More menu: round 4 for the 6 entrants, 3 boards.
      await page.getByTestId("stage-more").click();
      const add = page.getByTestId("stage-add-round");
      await expect(add).toBeEnabled();
      await expect(add).toContainText(fill("stage.more.addRound.hint.other", { round: 4, count: 6 }));
      const added = page.waitForResponse((res) => res.url().endsWith(`/api/v1/stages/${r.stageId}/swiss/add-round`) && res.request().method() === "POST");
      await add.click();
      expect((await added).status()).toBe(200);
      await expect(page.getByText(fill("schedule.notice.roundAdded", { round: 4 }))).toBeVisible({ timeout: 20_000 });
      expect(await roundsIn()).toEqual([1, 2, 3, 4]);
      expect((await r.round(4)).filter((f) => !isByeRow(f)), "round 4: ⌊6/2⌋ boards").toHaveLength(3);

      // An undo barrier: Undo across it is refused by name.
      const undo = await apiJson(request, `/api/v1/divisions/${r.divisionId}/undo`, "POST", {});
      expect((undo.error as { code?: string } | undefined)?.code).toBe("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE");
    });

    test(`a late player refused at the last round: Add a round from the refusal, then the player joins it (${sport.key})`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await startedSwiss(request, sport, 6, 1, "RoundsLate");
      await scoreAt(request, (await r.boards(1))[0]!.id, "core.start");
      const late = `RoundsLate Zoe ${TAG}`;
      const refused = await addLatePlayer(page, request, r.divisionId, late);
      expect([refused.status, refused.body.error?.code]).toEqual([409, "SWISS_NO_ROUND_LEFT"]);
      // 6 players × 1 round: round 2 fits (hard max 5), so the sentence names Add a round (T12 Fix round 1, review I1).
      await expect(page.getByTestId("entrants-error")).toHaveText(
        `${uiEn["swiss.refusal.SWISS_NO_ROUND_LEFT"]!} ${uiEn["swiss.rounds.noRoundLeft.add"]!}`,
      );
      const recover = page.getByTestId("entrants-add-round");
      await expect(recover, "the recovery the sentence names").toHaveText(uiEn["stage.more.addRound"]!);
      const added = page.waitForResponse((res) => res.url().endsWith(`/api/v1/stages/${r.stageId}/swiss/add-round`) && res.request().method() === "POST");
      await recover.click();
      expect((await added).status()).toBe(200);
      await expect(page.getByTestId("entrants-round-added")).toHaveText(fill("entrants.lateEntry.roundAdded", { round: 2 }));
      await expect(page.getByTestId("entrants-error")).toHaveCount(0);

      // Added again, the player joins round 2 (case c).
      const form = page.locator("#add-entrant");
      await form.getByLabel(uiEn["entrants.add.name"]!, { exact: true }).fill(late);
      const answered = page.waitForResponse((res) => res.url().endsWith(`/api/v1/divisions/${r.divisionId}/entrants`) && res.request().method() === "POST");
      await form.getByRole("button", { name: uiEn["entrants.add.submit"]! }).click();
      const res = await answered;
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { data?: { late_entry?: { case: string; round: number } } };
      expect(body.data?.late_entry).toMatchObject({ case: "c", round: 2 });
    });
  }
});

// W3 T13 (RB3-20, X-SW-26): "Finish the Swiss now" — a 5-round Swiss feeding a knockout of the top 4 (the swiss_knockout
// shape: `timing: "setup"`, its TBD bracket drawn on day one), three rounds played through the scorer's events, then
// the organiser's path: the rail's More → Finish the Swiss now → the house confirm naming what goes → Finish. Read back:
// rounds 4–5 gone, the stage complete, the knockout's seed proposal drawn from the table read BEFORE the finish, and Undo
// refused across the barrier the finish wrote.
test.describe("X-SW-26 finish a 5-round Swiss after round 3 into the knockout", () => {
  for (const sport of LATE_SPORTS) {
    test(`More → Finish the Swiss now confirms what goes, ends the Swiss after round 3, and seeds the knockout from round 3's table (${sport.key})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(300_000);
      const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `Finish ${sport.key} ${TAG}`,
        visibility: "private",
      });
      expect(comp.status, JSON.stringify(comp.error)).toBe(201);
      const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
        name: "Open",
        sport_key: sport.key,
        variant_key: sport.variant,
        config: sport.config,
      });
      expect(div.status, JSON.stringify(div.error)).toBe(201);
      const divisionId = div.data!.id;
      const added = await apiJson<{ id: string }[]>(
        request,
        `/api/v1/divisions/${divisionId}/entrants`,
        "POST",
        Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: `Finish S${i + 1} ${TAG}`, seed: i + 1, members: [] })),
      );
      expect(added.status, JSON.stringify(added.error)).toBe(201);
      const swiss = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 1,
        kind: "swiss",
        name: "Swiss",
        config: { rounds: 5 },
      });
      expect(swiss.status, JSON.stringify(swiss.error)).toBe(201);
      const ko = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      });
      expect(ko.status, JSON.stringify(ko.error)).toBe(201);
      const swissId = swiss.data!.id;
      const koId = ko.data!.id;
      const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
      expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);
      const drawn = await apiJson(request, `/api/v1/stages/${koId}/generate`, "POST");
      expect(drawn.status, `the knockout's TBD bracket → ${JSON.stringify(drawn.error)}`).toBe(200);
      const rowsOf = async (r?: number) =>
        ((await stageFixtures(request, divisionId, swissId)) as Seated[])
          .filter((f) => r === undefined || f.round_no === r)
          .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
      const roundsIn = async () => [...new Set((await rowsOf()).map((f) => f.round_no))];
      expect(await roundsIn(), "premise: five rounds minted").toEqual([1, 2, 3, 4, 5]);
      for (let r = 1; r <= 3; r++) {
        const paired = await apiJson(request, `/api/v1/stages/${swissId}/generate`, "POST");
        expect(paired.status, `pair round ${r} → ${JSON.stringify(paired.error)}`).toBe(200);
        const boards = (await rowsOf(r)).filter((f) => !isByeRow(f) && f.home_entrant_id !== null && f.away_entrant_id !== null);
        expect(boards, `round ${r}: ⌊6/2⌋ boards`).toHaveLength(3);
        for (const f of boards) await sport.win(request, f, f.home_entrant_id!);
      }
      // The table after round 3, read BEFORE the finish: the independent expected value for the knockout's seeds.
      const table = await apiJson<{ rows: { entrantId: string; rank?: number }[] }>(request, `/api/v1/stages/${swissId}/standings`);
      expect(table.status, JSON.stringify(table.error)).toBe(200);
      const top = [...table.data!.rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 4).map((r) => r.entrantId);
      expect(top, "premise: four ranked").toHaveLength(4);

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
      await page.getByTestId("stage-more").first().click();
      const finish = page.getByTestId("stage-finish-swiss");
      await expect(finish).toBeEnabled({ timeout: 20_000 });
      await expect(page.getByTestId("stage-finish-swiss-hint")).toHaveText(fill("stage.more.finishSwiss.hint", { round: 3 }));
      await finish.click();
      const confirm = page.getByRole("alertdialog", { name: uiEn["stage.finish.confirm.title"]! });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(fill("stage.finish.confirm.final", { round: 3 }));
      await expect(confirm).toContainText(fill("stage.finish.confirm.removeMany", { from: 4, to: 5 }));
      expect(await roundsIn(), "nothing written before the confirm").toEqual([1, 2, 3, 4, 5]);
      const posted = page.waitForResponse((res) => res.url().endsWith(`/api/v1/stages/${swissId}/swiss/finish`) && res.request().method() === "POST");
      await confirm.getByRole("button", { name: uiEn["stage.finish.confirm.label"]! }).click();
      const answer = await posted;
      expect(answer.status(), "Finish writes once").toBe(200);
      expect(((await answer.json()) as { data?: unknown }).data).toMatchObject({ finished_after: 3, shells_removed: 6, completed: true });
      await expect(page.getByText(fill("schedule.notice.swissFinished", { round: 3 }))).toBeVisible({ timeout: 20_000 });
      expect(await roundsIn(), "rounds 4 and 5 are gone").toEqual([1, 2, 3]);

      // The knockout seeds from round 3's table: the proposal's qualifiers, in rank order, are its top four.
      const proposal = await apiJson<{ computed: { qualifiers: { rank: number; entrantId: string }[] } }>(
        request,
        `/api/v1/stages/${koId}/seed-proposal`,
        "POST",
      );
      // 201: the route creates a DRAFT proposal (`reply(201, …)`; openapi documents 201 for this POST, 200 for /confirm).
      expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
      expect([...proposal.data!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId)).toEqual(top);

      // Finished stays finished: the item is gone from More, a second Finish is SWISS_OVER, and Undo is refused by name.
      await page.reload();
      // The positive anchor first (the Swiss card reads complete), so the absence below is read off a loaded desk.
      await expect(page.locator(`[data-stage-id="${swissId}"]`).getByText(uiEn["schedule.sstatus.complete"]!, { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId("stage-finish-swiss")).toHaveCount(0);
      const again = await apiJson(request, `/api/v1/stages/${swissId}/swiss/finish`, "POST");
      expect([again.status, (again.error as { code?: string } | undefined)?.code]).toEqual([422, "SWISS_OVER"]);
      const undo = await apiJson(request, `/api/v1/divisions/${divisionId}/undo`, "POST", {});
      expect((undo.error as { code?: string } | undefined)?.code).toBe("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE");
    });
  }
});

// X-SW-23 (W3 T15, RB3-17; rulebook §12 "disqualification = withdrawal from that moment"): a disqualification runs the
// withdrawal cascade. There is no Disqualify button on a Swiss desk — the roster editor's status patch is the one route —
// so the departure is driven through the API (`PATCH /entrants/{id}`), and the desk is read: the open board shows the
// walkover, the played result stands, and the next round pairs without her.
test.describe("X-SW-23 a disqualification cascades like a withdrawal", () => {
  for (const sport of LATE_SPORTS) {
    test(`PATCH status disqualified mid-Swiss walks her open board over, the run sheet shows the walkover, round 1 stands, and round 3 pairs without her (${sport.key})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000);
      // Six, not four (review I2): with three left, a chess round 3 can be left unpaired — engine 1.x fixes the bye before
      // it checks the rest can pair (carried to app-B). Five left always pair. Both sports take the same field.
      const r = await startedSwiss(request, sport, 6, 3, "Dq");
      const read = async (id: string) => {
        const got = await apiJson<Seated & { status: string; outcome: unknown }>(request, `/api/v1/fixtures/${id}`);
        expect(got.status, JSON.stringify(got.error)).toBe(200);
        return got.data!;
      };
      for (const f of await r.boards(1)) await sport.win(request, f, f.home_entrant_id!);
      const paired = await apiJson(request, `/api/v1/stages/${r.stageId}/generate`, "POST");
      expect(paired.status, `pair round 2 → ${JSON.stringify(paired.error)}`).toBe(200);
      const [open, ...others] = await r.boards(2);
      expect([open !== undefined, others.length], "premise: round 2 is paired, three boards").toEqual([true, 2]);
      const dq = open!.home_entrant_id!;
      const opponent = open!.away_entrant_id!;
      const played = (await r.boards(1)).find((f) => f.home_entrant_id === dq || f.away_entrant_id === dq)!;
      const playedBefore = await read(played.id);
      expect(playedBefore.status, "premise: her round-1 board was played").toBe("decided");

      const out = await apiJson<{ status: string }>(request, `/api/v1/entrants/${dq}`, "PATCH", { status: "disqualified" });
      expect(out.status, JSON.stringify(out.error)).toBe(200);
      expect(out.data!.status).toBe("disqualified");
      // The walkover the withdrawal cascade writes: to the opponent, reason unchanged ("withdrew"; ruling 115 decides credit).
      const walked = await read(open!.id);
      expect([walked.status, walked.outcome]).toEqual(["forfeited", { kind: "award", winner: opponent, loser: dq, reason: "withdrew" }]);
      const stands = await read(played.id);
      expect([stands.status, stands.outcome], "the played result stands").toEqual([playedBefore.status, playedBefore.outcome]);

      // A second PATCH is idempotent: 200, the same status, nothing rewritten.
      const again = await apiJson<{ status: string }>(request, `/api/v1/entrants/${dq}`, "PATCH", { status: "disqualified" });
      expect([again.status, again.data?.status], JSON.stringify(again.error)).toEqual([200, "disqualified"]);
      expect([(await read(open!.id)).status, (await read(open!.id)).outcome]).toEqual([walked.status, walked.outcome]);

      // The desk: the run sheet's line names the opponent, tagged as a walkover.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
      await showAllFixtures(page);
      const line = fill("schedule.outcome.wonTagged", { name: r.nameOf.get(opponent)!, tag: uiEn["forfeit.tag.walkover"]! });
      await expect(page.locator(`li[data-fixture-no="${open!.fixture_no}"]`)).toContainText(line, { timeout: 20_000 });

      // She is not paired again: round 3 seats the five still in the field, never her.
      for (const f of others) await sport.win(request, f, f.home_entrant_id!);
      const third = await apiJson(request, `/api/v1/stages/${r.stageId}/generate`, "POST");
      expect(third.status, `pair round 3 → ${JSON.stringify(third.error)}`).toBe(200);
      const seated = (await r.round(3)).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null);
      // Five left: two boards and a bye (the bye row seats its holder), each of the five once.
      expect(seated).not.toContain(dq);
      expect([...seated].sort()).toEqual([...r.nameOf.keys()].filter((id) => id !== dq).sort());
    });
  }
});

// W3 T16 (SW-L11): the public hub's Table tab names where a Swiss stage stands - "Round X of N" - from the round's own
// boards: paired (every board still to play), in play, complete, and "Final standings after N rounds" once the stage is
// done. A spectator reads it, so the page is opened ANONYMOUSLY, in a browser, on the hub's Table tab (which reads `?tab=`
// on the client: the server-rendered HTML is the Overview and carries no chip). The expected sentences are typed here, in
// English (the org's language), not read back from the dictionary. `N` is the stage's CURRENT round count: after "Finish
// the Swiss now" it is the round it finished after, not the 3 it was set to. A league table beside it has no chip.
const SWISS_CHIP = '[data-testid^="mh-table-"][data-testid$="-swiss-round"]';

/** What a spectator sees on the hub's Table tab, as one string: how many chips there are, or the ONE chip's `data-state`
 *  (`getAttribute`: an attribute that is absent reads `null`, never a pass) and its words. Reloaded on each call, so a poll
 *  reads the page afresh (ISR can serve a page rendered a moment before the last result folded). */
async function readSwissChip(page: Page, hubUrl: string): Promise<string> {
  await page.goto(hubUrl, { waitUntil: "load" });
  try {
    await page.getByTestId("mh-tab-panel-table").waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return "no Table tab";
  }
  const chips = page.locator(SWISS_CHIP);
  const n = await chips.count();
  if (n !== 1) return `${n} chips`;
  return `${await chips.getAttribute("data-state")} | ${((await chips.textContent()) ?? "").trim()}`;
}

test.describe("public Swiss shows Round X of N", () => {
  test.afterEach(async () => {
    // Never `finally`: a Playwright timeout skips it.
    await closeOpenContexts();
  });

  for (const sport of LATE_SPORTS) {
    test(`the Table tab says paired, in play, complete, then the next round paired and, after Finish, the final standings over the CURRENT rounds; a league beside it has no chip, and no width scrolls (${sport.key})`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(400_000);
      // Four players and three rounds: two boards a round and no bye.
      const g = await startedSwiss(request, sport, 4, 3, "Public round");
      const div = await apiJson<{ competition_id: string }>(request, `/api/v1/divisions/${g.divisionId}`);
      expect(div.status, JSON.stringify(div.error)).toBe(200);
      const competitionId = div.data!.competition_id;
      const made = await apiJson<{ visibility: string }>(request, `/api/v1/competitions/${competitionId}`, "PATCH", { visibility: "public" });
      expect([made.status, made.data?.visibility], `a spectator can only read a public competition: ${JSON.stringify(made.error)}`).toEqual([200, "public"]);
      const hubUrl = (await competitionPath(request, competitionId)).replace(/^\/o\/([^/]+)\/c\//, "/live/$1/") + "?tab=table";
      expect(hubUrl, "premise: the organiser path became the public one").toMatch(/^\/live\/[^/]+\/[^/?]+\?tab=table$/);

      const page = await spectator(browser, { width: 1280, height: 900 });
      const reads = (want: string) =>
        expect.poll(() => readSwissChip(page, hubUrl), { timeout: 90_000, intervals: [2_000] }).toBe(want);

      // A league in the same competition: one result in, so its table exists. It must never carry a chip.
      const league = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
        name: "League",
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
      });
      expect(league.status, JSON.stringify(league.error)).toBe(201);
      const leagueStage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${league.data!.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      });
      expect(leagueStage.status, JSON.stringify(leagueStage.error)).toBe(201);
      expect((await addEntrantsViaApi(request, league.data!.id, ["League A", "League B", "League C"].map((n) => `${n} ${TAG}`))).status).toBe(201);
      expect((await apiJson(request, `/api/v1/stages/${leagueStage.data!.id}/generate`, "POST")).status).toBe(200);
      expect((await apiJson(request, `/api/v1/divisions/${league.data!.id}/start`, "POST")).status).toBe(200);
      const leagueFixtures = ((await apiJson<{ id: string; stage_id: string }[]>(request, `/api/v1/divisions/${league.data!.id}/fixtures`)).data ?? []).filter(
        (f) => f.stage_id === leagueStage.data!.id,
      );
      expect(leagueFixtures.length, "premise: a league of three has three fixtures").toBe(3);
      await scoreFixture(request, leagueFixtures[0]!.id, 2, 1);

      // Round 1: both boards on their shells, paired and unplayed.
      const one = await g.boards(1);
      expect(one, "premise: two boards in round 1").toHaveLength(2);
      await reads("paired | Round 1 of 3 · paired");
      // The league's table is on the page too (its one result may fold a moment after the Swiss's page rendered, so poll
      // for it), and the chip is the Swiss's alone.
      const sections = page.locator('section[data-testid^="mh-table-"]');
      await expect
        .poll(
          async () => {
            await readSwissChip(page, hubUrl);
            return sections.count();
          },
          { timeout: 90_000, intervals: [2_000], message: "premise: the Swiss table and the league table" },
        )
        .toBe(2);
      expect(await sections.locator(SWISS_CHIP).count(), "a league table has no chip: one chip on a page of two tables").toBe(1);
      const chipless = sections.filter({ hasNot: page.locator(SWISS_CHIP) });
      expect(await chipless.count(), "exactly one table without a chip, and it is the league").toBe(1);
      await expect(chipless.first()).toContainText(`League A ${TAG}`);

      // One board decided, the other still open: in play.
      await sport.win(request, one[0]!, one[0]!.home_entrant_id!);
      await reads("in_play | Round 1 of 3 · in play");
      // Both decided: the round is complete.
      await sport.win(request, one[1]!, one[1]!.home_entrant_id!);
      await reads("complete | Round 1 of 3 · complete");

      // Round 2 paired: the verdict moves to the new round, and the denominator stays the stage's three.
      const paired = await apiJson(request, `/api/v1/stages/${g.stageId}/generate`, "POST");
      expect(paired.status, `pair round 2 → ${JSON.stringify(paired.error)}`).toBe(200);
      await reads("paired | Round 2 of 3 · paired");

      // No width scrolls the page, and the chip sits inside it: the sentence wraps rather than widening anything.
      for (const width of [768, 320] as const) {
        await page.setViewportSize({ width, height: 900 });
        expect(await readSwissChip(page, hubUrl), `at ${width}`).toBe("paired | Round 2 of 3 · paired");
        await expectNoHorizontalScroll(page);
        const box = await page.locator(SWISS_CHIP).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, vw: document.documentElement.clientWidth, scroll: el.scrollWidth, client: el.clientWidth };
        });
        expect(box.left, `at ${width}: the chip starts inside the page`).toBeGreaterThanOrEqual(0);
        expect(box.right, `at ${width}: the chip ends inside the page`).toBeLessThanOrEqual(box.vw);
        expect(box.scroll, `at ${width}: the chip's words fit the chip`).toBeLessThanOrEqual(box.client);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // Play round 2, then Finish the Swiss now: it ends after round 2, so the table reads over TWO rounds, not three.
      for (const f of await g.boards(2)) await sport.win(request, f, f.home_entrant_id!);
      await reads("complete | Round 2 of 3 · complete");
      const finished = await apiJson<{ finished_after: number; completed: boolean }>(request, `/api/v1/stages/${g.stageId}/swiss/finish`, "POST");
      expect([finished.status, finished.data?.finished_after, finished.data?.completed], JSON.stringify(finished.error)).toEqual([200, 2, true]);
      await reads("final | Final standings after 2 rounds");
    });
  }
});

// X-SW-25 (W3 T17, RB3-19): a correction to a Swiss result AFTER its knockout began never moves a bracket seat — the bracket
// stands — and the desk says so. The cut here is a Top 3 of four; the Swiss's last board (P3 v P4) is taken back and given to
// P4, which puts P4 in today's top three and P3 out. Driven end to end: the real scorer events, the real Complete + confirmed
// seeding, the real void; the warning is read off the organiser's Fixtures tab, names not ids, at three widths.
test.describe("X-SW-25 the desk warns after a cut-changing correction", () => {
  for (const sport of LATE_SPORTS) {
    test(`a correction that moves the Swiss cut after the knockout began leaves the bracket and warns the organiser (${sport.key})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(300_000);
      const resultType = sport.key === "boardgame" ? "boardgame.result" : "badminton.game.summary";
      const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `Cut drift ${sport.key} ${TAG}`,
        visibility: "private",
      });
      expect(comp.status, JSON.stringify(comp.error)).toBe(201);
      const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
        name: "Open",
        sport_key: sport.key,
        variant_key: sport.variant,
        config: sport.config,
      });
      expect(div.status, JSON.stringify(div.error)).toBe(201);
      const divisionId = div.data!.id;
      const names = [1, 2, 3, 4].map((n) => `Drift P${n} ${TAG}`);
      const added = await apiJson<{ id: string; display_name: string }[]>(
        request,
        `/api/v1/divisions/${divisionId}/entrants`,
        "POST",
        names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1, members: [] })),
      );
      expect(added.status, JSON.stringify(added.error)).toBe(201);
      const ids = names.map((n) => added.data!.find((e) => e.display_name === n)!.id);
      const [, , p3, p4] = ids as [string, string, string, string];
      const nameOf = new Map(names.map((n, i) => [ids[i]!, n] as const));
      const swiss = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 1,
        kind: "swiss",
        name: "Swiss",
        config: { rounds: 3 },
      });
      expect(swiss.status, JSON.stringify(swiss.error)).toBe(201);
      const ko = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      });
      expect(ko.status, JSON.stringify(ko.error)).toBe(201);
      const swissId = swiss.data!.id;
      const koId = ko.data!.id;
      expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
      expect((await apiJson(request, `/api/v1/stages/${koId}/generate`, "POST")).status, "the knockout's TBD bracket").toBe(200);

      const rowsOf = async (stageId: string) =>
        ((await stageFixtures(request, divisionId, stageId)) as Seated[]).sort(
          (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
        );
      const lower = (f: Seated) => (ids.indexOf(f.home_entrant_id!) < ids.indexOf(f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
      const real = (f: Seated) => !isByeRow(f) && f.home_entrant_id !== null && f.away_entrant_id !== null;
      // Rounds 1-3: the lower-numbered side wins every board, so the table is P1 (3 wins), P2 (2), P3 (1), P4 (0).
      for (let r = 1; r <= 3; r++) {
        expect((await apiJson(request, `/api/v1/stages/${swissId}/generate`, "POST")).status, `pair round ${r}`).toBe(200);
        const boards = (await rowsOf(swissId)).filter((f) => f.round_no === r && real(f));
        expect(boards, `round ${r}: two boards`).toHaveLength(2);
        for (const f of boards) await sport.win(request, f, lower(f));
      }
      const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${swissId}/complete`, "POST");
      expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
      const proposal = await apiJson<{ id: string; computed: { qualifiers: { entrantId: string }[] } }>(
        request,
        `/api/v1/stages/${koId}/seed-proposal`,
        "POST",
      );
      expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
      expect(
        proposal.data!.computed.qualifiers.map((q) => nameOf.get(q.entrantId)),
        "premise: the cut is P1, P2, P3",
      ).toEqual(names.slice(0, 3));
      const confirmed = await apiJson(request, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
      expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);

      // Before the knockout has a result there is nothing to warn about, on the API and on the desk.
      const drift0 = await apiJson<{ drift: unknown }>(request, `/api/v1/stages/${swissId}/swiss-cut`);
      expect([drift0.status, drift0.data?.drift], JSON.stringify(drift0.error)).toEqual([200, null]);
      const warning = page.getByTestId("swiss-cut-drift-warning");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
      // The positive anchor first (the Swiss card reads complete), so the absence below is read off a loaded desk.
      await expect(page.locator(`[data-stage-id="${swissId}"]`).getByText(uiEn["schedule.sstatus.complete"]!, { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(warning, "no warning before the knockout has a result").toHaveCount(0);

      // The knockout begins: its one real line (the semi-final, P2 v P3) is decided.
      const seatsOf = async () => (await rowsOf(koId)).map((f) => `${f.id}|${f.home_entrant_id ?? "-"}|${f.away_entrant_id ?? "-"}`);
      const semi = (await rowsOf(koId)).filter(real);
      expect(semi, "premise: one real semi-final line (a Top 3 pads to four)").toHaveLength(1);
      await sport.win(request, semi[0]!, lower(semi[0]!));
      const drift1 = await apiJson<{ drift: unknown }>(request, `/api/v1/stages/${swissId}/swiss-cut`);
      expect([drift1.status, drift1.data?.drift], "knockout begun, table unchanged: no drift").toEqual([200, null]);
      const seatsBefore = await seatsOf();

      // The correction: take back P3 v P4 (P3 won it as the lower number) and give it to P4.
      const board = (await rowsOf(swissId)).find((f) => real(f) && [f.home_entrant_id, f.away_entrant_id].sort().join() === [p3, p4].sort().join())!;
      expect(board, "premise: P3 and P4 meet once").toBeTruthy();
      const ledger = await apiJson<{ id: string; type: string; payload: Record<string, unknown> }[]>(
        request,
        `/api/v1/fixtures/${board.id}/events?since_seq=0`,
      );
      const taken = new Set((ledger.data ?? []).filter((e) => e.type === "core.void").map((e) => e.payload.event_id));
      const live = (ledger.data ?? []).filter((e) => e.type === resultType && !taken.has(e.id));
      expect(live.length, "premise: the board holds a result to take back").toBeGreaterThan(0);
      for (const e of live.reverse()) await scoreAt(request, board.id, "core.void", { event_id: e.id });
      // The board is still started: re-score it, never re-start it (core.start would be refused WRONG_PHASE).
      await sport.result(request, board, p4);

      const drift2 = await apiJson<{ drift: { out: string[]; in: string[] } | null }>(request, `/api/v1/stages/${swissId}/swiss-cut`);
      expect([drift2.status, drift2.data?.drift], JSON.stringify(drift2.error)).toEqual([200, { out: [p3], in: [p4] }]);
      expect(await seatsOf(), "the bracket stands: no seat moved").toEqual(seatsBefore);

      const copy = fill("swiss.cutDrift.warning.one", { in: nameOf.get(p4)!, out: nameOf.get(p3)! });
      for (const width of [1280, 768, 320] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
        await expect(warning, `at ${width}`).toBeVisible({ timeout: 20_000 });
        await expect(warning, `at ${width}: the names, not the ids`).toHaveText(copy);
        await expectNoHorizontalScroll(page);
        const box = await warning.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, vw: document.documentElement.clientWidth };
        });
        expect(box.left, `at ${width}: starts inside the page`).toBeGreaterThanOrEqual(0);
        expect(box.right, `at ${width}: ends inside the page`).toBeLessThanOrEqual(box.vw);
      }
    });
  }
});

// X-SW-18 (W3 T18, RB3-7(c), signed 252): a requested half-point or zero-point bye is DEFERRED. There is no door that takes
// one, and the key a client would reach for — `requestedByes` on a stage config — is refused by name with the way out
// (record a walkover on the player's board). API only: the desk never sends the key, so there is nothing to click.
// Driven on the real server: the three doors that read a stage config (create, replace, PATCH), a refusal that writes
// nothing, and the guidance's own walkover as a path that works.
test.describe("X-SW-18 requested half/zero byes have no path and refuse with guidance", () => {
  test("create, replace and PATCH refuse requestedByes 400 SWISS_REQUESTED_BYES_DEFERRED and write nothing; the walkover the sentence names goes through", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    // The sentence the task's brief signs, typed here (never read back from the product).
    const GUIDANCE =
      "Requested half-point or zero-point byes aren't offered yet. If a player must miss a round, record a walkover on their board.";
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `No requested byes ${TAG}`,
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
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `NoBye P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const requested = [{ entrantId: added.data![0]!.id, round: 2, value: 0.5 }];
    const named = (res: { status: number; error?: { code?: string; message?: string } }, where: string) => {
      expect(res.status, `${where}: ${JSON.stringify(res.error)}`).toBe(400);
      expect(res.error?.code, where).toBe("SWISS_REQUESTED_BYES_DEFERRED");
      expect(res.error?.message, where).toBe(GUIDANCE);
    };
    const stagesOf = async () => {
      const list = await apiJson<{ id: string; config: { rounds?: number } }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
      expect(list.status, JSON.stringify(list.error)).toBe(200);
      return list.data!;
    };

    // Create: refused by name; the division still has no stage.
    const body = (config: Record<string, unknown>) => ({ seq: 1, kind: "swiss", name: "Swiss", config });
    named(await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", body({ rounds: 2, requestedByes: requested })), "POST one stage");
    named(await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", [body({ rounds: 2, requestedByes: true })]), "POST a list");
    expect((await stagesOf()).length, "nothing written by a refused create").toBe(0);

    // The same config without the key creates the stage (the refusal is the key, not the stage).
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", body({ rounds: 2 }));
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;

    // Replace and PATCH: refused by name; the stage keeps its two rounds.
    named(await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "PUT", body({ rounds: 3, requestedByes: requested })), "PUT");
    named(await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { requestedByes: requested }), "PATCH the key alone");
    named(await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { rounds: 3, requestedByes: requested }), "PATCH beside a real edit");
    const after = await stagesOf();
    expect(after.map((s) => s.id), "the PUT replaced nothing").toEqual([stageId]);
    expect(after[0]!.config.rounds, "neither the PUT nor a PATCH moved the round count").toBe(2);
    expect(JSON.stringify(after[0]!.config), "no requested bye was stored").not.toContain("requestedByes");

    // The way out the sentence names: a walkover on the player's board is a real, working path. It is recorded on a STARTED
    // Swiss — scoring is closed until the division starts (WRONG_PHASE "division has not started") — so it is driven on
    // the late-player tests' own helper, which starts the division and pairs round 1, in every sport it covers. The
    // refusals above ran on the unstarted division, where the three doors take a config.
    for (const sport of LATE_SPORTS) {
      const r = await startedSwiss(request, sport, 4, 2, "NoByeWO");
      const board = (await r.boards(1))[0];
      expect(board, `${sport.key}: premise: round 1 seats a real board`).toBeDefined();
      await scoreAt(request, board!.id, "core.forfeit", { by: board!.home_entrant_id, reason: "walkover" });
      const decided = await apiJson<{ status: string; outcome: unknown }>(request, `/api/v1/fixtures/${board!.id}`);
      expect(decided.status, JSON.stringify(decided.error)).toBe(200);
      expect(decided.data!.status, `${sport.key}: the walkover decided the board`).toBe("forfeited");
      expect(decided.data!.outcome, `${sport.key}: the side that did not forfeit is awarded it`).toMatchObject({
        kind: "award",
        winner: board!.away_entrant_id,
      });
    }
  });
});
