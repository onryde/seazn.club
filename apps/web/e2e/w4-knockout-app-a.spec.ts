import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, activeOrgIdFromRequest, apiJson, competitionPath, divisionPath, seedVenueWithCourts } from "./helpers";
import { showAllFixtures, stageFixtures, type Fx } from "./support/swiss-app-a-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { uiEn } from "./match-room-kit";
import { swissDrawSeed, swissRoundOneOrder } from "../src/lib/swiss-draw";

// W4 knockout app-A (spec 2026-11-04-format-matrix-w4-knockout-design.md). One describe per rule, each driven through the
// real product: the v1 routes the desk and the pad call, and read back on the division's run sheet.

type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null; status: string };

/** A badminton knockout of `names`, seeded in order, generated and Started. */
async function startedKnockout(request: APIRequestContext, label: string, names: string[]) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
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
    kind: "knockout",
    name: "Cup",
    config: {},
  });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const stageId = stage.data!.id;
  const gen = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, JSON.stringify(gen.error)).toBe(200);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBe(200);
  const rows = async () => (await stageFixtures(request, divisionId, stageId)) as Seated[];
  return { divisionId, stageId, nameOf, rows };
}

/** The scorer's events for a home win, two games to love; returns the deciding event's id. */
async function homeWins(request: APIRequestContext, fixtureId: string): Promise<string> {
  let last: { event_id?: string } | undefined;
  for (const [type, payload] of [
    ["core.start", {}],
    ["badminton.game.summary", { home: 21, away: 10 }],
    ["badminton.game.summary", { home: 21, away: 12 }],
  ] as const) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    const res = await apiJson<{ event_id: string }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type,
      payload,
    });
    expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    last = res.data;
  }
  expect(last?.event_id, "the deciding event's id").toBeTruthy();
  return last!.event_id!;
}

// X-LE-9 (W4 T2, K4; owner ruling 257): a Match Day call is a start. A call writes a court and a time and no status or
// event, so the take-back that empties a next match's seat when its feeder's result is voided read a called final as
// waiting, and took a name off a match whose players stood at the court. Now the void is refused by the same 409 a
// started next match answers, and the run sheet still shows both finalists.
test.describe("X-LE-9 a called match is started", () => {
  test("decide both semi-finals, call the final to a court, void a semi-final — refused, and the run sheet keeps both finalists", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = await activeOrgIdFromRequest(request);
    const { courts } = await seedVenueWithCourts(request, [`Called Court ${TAG}`], { orgId });
    const ko = await startedKnockout(request, "Called final", [`Cal Ana ${TAG}`, `Cal Ben ${TAG}`, `Cal Cas ${TAG}`, `Cal Dee ${TAG}`]);

    const r1 = (await ko.rows()).filter((f) => f.round_no === 1);
    expect(r1.length, "premise: two semi-finals").toBe(2);
    const decider = await homeWins(request, r1[0]!.id);
    await homeWins(request, r1[1]!.id);
    const final = (await ko.rows()).find((f) => f.round_no === 2)!;
    expect(final.home_entrant_id && final.away_entrant_id, "premise: both finalists seated").toBeTruthy();
    const finalists = [ko.nameOf.get(final.home_entrant_id!)!, ko.nameOf.get(final.away_entrant_id!)!];

    const called = await apiJson(request, `/api/v1/fixtures/${final.id}/call`, "POST", { court_id: courts[0]!.id });
    expect(called.status, JSON.stringify(called.error)).toBe(200);

    const tip = (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${r1[0]!.id}/state`)).data!.last_seq;
    const voided = await apiJson(request, `/api/v1/fixtures/${r1[0]!.id}/events`, "POST", {
      expected_seq: tip,
      type: "core.void",
      payload: { event_id: decider },
    });
    expect([voided.status, voided.error?.code], "the take-back refuses a called next match").toEqual([409, "NEXT_MATCH_STARTED"]);
    const after = (await ko.rows()).find((f) => f.id === final.id)!;
    expect([after.home_entrant_id, after.away_entrant_id], "the final keeps both seats").toEqual([final.home_entrant_id, final.away_entrant_id]);
    expect(after.court_id, "and its court").toBe(courts[0]!.id);

    await page.goto(await divisionPath(request, ko.divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const row = page.locator(`li[data-fixture-no="${final.fixture_no}"]`);
    for (const name of finalists) await expect(row, `the run sheet still seats ${name}`).toContainText(name, { timeout: 20_000 });
  });
});

// X-SD-5 (W4 T3, K2): a bye is not played, so it never takes a court or a time. A plain knockout of three bakes its bye
// `forfeited` at generation; a quick Start's rolling times used to stamp it with round 1's time, the board let a drag drop
// it on a court, and the award of a progression bracket's bye kept the court it had been given. Now Start skips it, the
// board's move is refused by name (BYE_LINE_NOT_PLACEABLE), and the run sheet shows it as its round's bye while the real
// line beside it holds its court.
test.describe("X-SD-5 a bye holds no court on the run sheet", () => {
  test("a knockout of three Started with rolling times: the bye takes no time, the board cannot place it, the run sheet shows it as a bye", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = await activeOrgIdFromRequest(request);
    const { courts } = await seedVenueWithCourts(request, [`Bye Court A ${TAG}`, `Bye Court B ${TAG}`], { orgId });
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Bye cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const names = [`Bye Ana ${TAG}`, `Bye Ben ${TAG}`, `Bye Cas ${TAG}`];
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: { startAt: "2030-08-01T09:00:00.000Z", matchMinutes: 30, gapMinutes: 0, roundMinutes: 45, courts: courts.map((c) => c.id) },
    });
    expect(settings.status, JSON.stringify(settings.error)).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);

    const rows = async () => (await stageFixtures(request, divisionId, stage.data!.id)) as Seated[];
    const r1 = (await rows()).filter((f) => f.round_no === 1);
    const bye = r1.find((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    const real = r1.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(bye && real, "premise: round 1 is one bye and one real line").toBeTruthy();
    expect([bye!.scheduled_at, bye!.court_id], "Start's rolling times skip the bye").toEqual([null, null]);
    expect(real!.scheduled_at, "positive pair: the real line got round 1's time").not.toBeNull();

    const refused = await apiJson(request, `/api/v1/fixtures/${bye!.id}`, "PATCH", { scheduled_at: "2030-08-01T10:00:00.000Z", court_id: courts[0]!.id });
    expect([refused.status, refused.error?.code], "the board cannot place a bye").toEqual([422, "BYE_LINE_NOT_PLACEABLE"]);
    const placed = await apiJson(request, `/api/v1/fixtures/${real!.id}`, "PATCH", { scheduled_at: "2030-08-01T10:00:00.000Z", court_id: courts[1]!.id });
    expect(placed.status, `positive pair: the real line is placed — ${JSON.stringify(placed.error)}`).toBe(200);
    const after = (await rows()).find((f) => f.id === bye!.id)!;
    expect([after.scheduled_at, after.court_id], "nothing was written to the bye").toEqual([null, null]);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const ana = added.data!.find((e) => e.id === (bye!.home_entrant_id ?? bye!.away_entrant_id))!.display_name;
    const byeRow = page.getByTestId("run-sheet-bye").filter({ hasText: ana });
    await expect(byeRow, "the run sheet shows the bye as its round's bye").toHaveCount(1, { timeout: 20_000 });
    await expect(byeRow, "and names no court on it").not.toContainText(`Bye Court`);
    const realRow = page.locator(`li[data-fixture-no="${real!.fixture_no}"]`);
    await expect(realRow, "positive pair: the real line's row names its court").toContainText(courts[1]!.name, { timeout: 20_000 });
  });
});

// X-RB-1 (W4 T4, K3): a knockout's round numbers count from its FIRST round, so a Rebuild that carried slots by
// (pool, round, seq) handed the old final's court and time to a semi-final when a ninth entrant doubled the bracket, and
// left the new final unscheduled. Rebuild now carries a knockout by bracket role: the final keeps the final's slot, the
// semi-finals keep the semi-finals'. Driven through the roster-drift banner's Rebuild button and read back on the run sheet.
test.describe("X-RB-1 the final keeps its court across 8→9", () => {
  test("lay out a knockout of eight, enrol a ninth, Rebuild — the final still holds the final's court and time", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const orgId = await activeOrgIdFromRequest(request);
    const { venueId, courts } = await seedVenueWithCourts(request, [`Role Court ${TAG}`, `Final Court ${TAG}`], { orgId });
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Role cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Role P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const gen = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(gen.status, JSON.stringify(gen.error)).toBe(200);

    // Lay out every line: its own hour; the final alone on the final's court. Expected slots are what THIS test writes.
    const before = await stageFixtures(request, divisionId, stageId);
    const finalRound = Math.max(...before.map((f) => f.round_no));
    expect([before.length, before.filter((f) => f.round_no === finalRound).length], "premise: seven lines, one final").toEqual([7, 1]);
    const laid = new Map<string, { scheduled_at: string; court_id: string }>();
    for (const [i, f] of before.entries()) {
      const at = `2030-06-15T${String(8 + i).padStart(2, "0")}:00:00.000Z`;
      const court = f.round_no === finalRound ? courts[1]! : courts[0]!;
      const placed = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", { scheduled_at: at, venue_id: venueId, court_id: court.id });
      expect(placed.status, JSON.stringify(placed.error)).toBe(200);
      laid.set(f.id, { scheduled_at: at, court_id: court.id });
    }
    const oldFinal = laid.get(before.find((f) => f.round_no === finalRound)!.id)!;
    const oldSemis = before.filter((f) => f.round_no === finalRound - 1).map((f) => laid.get(f.id)!.scheduled_at).sort();

    const late = await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "individual", display_name: `Role P9 ${TAG}`, seed: 9 },
    ]);
    expect(late.status, JSON.stringify(late.error)).toBe(201);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const banner = page.getByTestId("roster-drift-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByTestId("roster-drift-rebuild").click();
    const dialog = page.getByRole("alertdialog", { name: "Rebuild this stage's fixtures?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Rebuild" }).click();
    // Every old role survives in a bracket of 16; the one real new first-round line has nothing to inherit (its seven
    // neighbours are byes, which need no slot).
    await expect(
      page.getByText("Rebuilt — 7 fixture(s) replaced. 7 slot(s) kept, 0 freed, 1 unscheduled.", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    const after = await stageFixtures(request, divisionId, stageId);
    const newFinalRound = Math.max(...after.map((f) => f.round_no));
    expect(newFinalRound, "premise: the final moved a round later").toBe(finalRound + 1);
    const finals = after.filter((f) => f.round_no === newFinalRound);
    expect(finals.length).toBe(1);
    expect({ scheduled_at: finals[0]!.scheduled_at, court_id: finals[0]!.court_id }, "the final keeps the final's slot").toEqual(oldFinal);
    expect(
      after.filter((f) => f.round_no === newFinalRound - 1).map((f) => f.scheduled_at).sort(),
      "the semi-finals keep the semi-finals' times",
    ).toEqual(oldSemis);
    await expect(page.locator(`[data-fixture-no="${finals[0]!.fixture_no}"]`), "the run sheet's final names the final's court").toContainText(
      courts[1]!.name,
      { timeout: 20_000 },
    );
  });
});

// K1 (W4 T5): Undo cannot cross a seed confirm. A Plate is drawn on day one with every seat TBD (`timing: "setup"`); the
// confirm seats it through `fillSlot`, which no ledger step records, so the next Undo inverted the Plate's own generation
// and deleted the seeded draw. The confirm now appends a `seed_confirmed` undo barrier: History lists it as "Draw
// confirmed", and its Undo is refused by name in the reader's language while the Plate keeps every seat.
test.describe("K1 Undo refuses across a confirmed draw", () => {
  test("play out a Main draw of eight, confirm its Plate, press Undo on the History panel — refused by name, and the Plate keeps every seat", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Plate cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Plate P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
    const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main draw", config: {} });
    expect(main.status, JSON.stringify(main.error)).toBe(201);
    const plate = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Plate",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }], placement: "rank_order", timing: "setup" },
    });
    expect(plate.status, JSON.stringify(plate.error)).toBe(201);
    // Main first, the Plate's day-one draw after it, as Start would: the newest step Undo can invert is then the Plate's
    // own generation (no result on it), so only the confirm's barrier can refuse it. Generated the other way round, Undo
    // targets the Main draw's generation, whose matches have results, and the results guard refuses before the barrier.
    expect((await apiJson(request, `/api/v1/stages/${main.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/stages/${plate.data!.id}/generate`, "POST")).status, "the Plate's day-one draw").toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);

    const mainRows = async () => (await stageFixtures(request, divisionId, main.data!.id)) as Seated[];
    for (let guard = 0; guard < 6; guard++) {
      const open = (await mainRows()).filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status),
      );
      if (open.length === 0) break;
      for (const f of open) await homeWins(request, f.id);
    }
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${main.data!.id}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const proposal = await apiJson<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } }>(
      request,
      `/api/v1/stages/${plate.data!.id}/seed-proposal`,
      "POST",
    );
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    const ties = proposal.data!.computed.ties;
    const confirmed = await apiJson(request, `/api/v1/stages/${plate.data!.id}/seed-proposal/confirm`, "POST", {
      proposalId: proposal.data!.id,
      ...(ties.length > 0 ? { tiePicks: ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
    });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    const plateRows = async () => (await stageFixtures(request, divisionId, plate.data!.id)) as Seated[];
    const seated = (await plateRows()).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(seated.length, "premise: the confirm seated the Plate's two first-round lines").toBe(2);
    const seatsBefore = (await plateRows()).map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]);

    // The History panel: the confirm is listed by name, and Undo answers the barrier's refusal in the reader's language.
    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=history"));
    await expect(page.getByText("Draw confirmed").first(), "History names the confirm").toBeVisible({ timeout: 20_000 });
    const undo = page.getByTestId("history-undo");
    await expect(undo).toBeEnabled({ timeout: 20_000 });
    const answered = page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/divisions/${divisionId}/undo`) && r.request().method() === "POST",
    );
    await undo.click();
    expect((await answered).status(), "the Undo is refused").toBe(409);
    await expect(page.getByTestId("history-error")).toHaveText("This draw is confirmed and can't be undone.", {
      timeout: 20_000,
    });
    expect((await plateRows()).map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]), "the Plate keeps every seat").toEqual(seatsBefore);

    // And the run sheet still names the Plate's seeded players.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const line = page.locator(`li[data-fixture-no="${seated[0]!.fixture_no}"]`);
    for (const id of [seated[0]!.home_entrant_id!, seated[0]!.away_entrant_id!]) {
      await expect(line, `the run sheet seats ${nameOf.get(id)}`).toContainText(nameOf.get(id)!, { timeout: 20_000 });
    }
  });
});

// X-CH-7 (W4 T6, AN-2 app half): a bracket completes only with every match decided. The engine completes once every
// FINAL is settled, and a third-place line is never one — so Complete went through with it unplayed and the division read
// Finished beside a missing result. Match Day C3 disables Complete while any match is open, so the refusal is what a
// STALE tab still reaches: the page renders with every match settled, the third-place result is taken back behind it,
// and Complete is refused by name in the reader's language — the stage stays active until that line has its result.
test.describe("X-CH-7 Complete refuses an unfinished bracket", () => {
  test("a knockout of four with a third-place line: the third-place result taken back behind a stale page, Complete is refused by name, then completes once it is decided", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Bronze cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Bronze P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Cup",
      config: { thirdPlace: true },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    const rows = async () => (await stageFixtures(request, divisionId, stageId)) as Seated[];
    const semis = (await rows()).filter((f) => f.round_no === 1);
    expect(semis.length, "premise: two semi-finals").toBe(2);
    for (const f of semis) await homeWins(request, f.id);
    const lastRound = (await rows()).filter((f) => f.round_no === 2);
    const bronze = lastRound.find((f) => f.ext_key?.endsWith("3p"));
    const final = lastRound.find((f) => f !== bronze);
    expect(bronze && final, "premise: the final and the third-place line, both seated").toBeTruthy();
    await homeWins(request, final!.id);
    const bronzeDecider = await homeWins(request, bronze!.id);
    const stageStatus = async () =>
      (await apiJson<{ id: string; status: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`)).data!.find((s) => s.id === stageId)!.status;

    // Every match settled: the page renders with Complete enabled.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const complete = page.getByTestId("stage-complete");
    await expect(complete).toBeEnabled({ timeout: 20_000 });
    // Behind it, the third-place result is taken back: that line is in play again.
    const tip = (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${bronze!.id}/state`)).data!.last_seq;
    const voided = await apiJson(request, `/api/v1/fixtures/${bronze!.id}/events`, "POST", {
      expected_seq: tip,
      type: "core.void",
      payload: { event_id: bronzeDecider },
    });
    expect(voided.status, JSON.stringify(voided.error)).toBeLessThan(300);
    expect((await rows()).find((f) => f.id === bronze!.id)!.status, "premise: the third-place line is open again").not.toBe("decided");

    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/stages/${stageId}/complete`) && r.request().method() === "POST");
    await complete.click();
    const res = await answered;
    expect(res.status(), "Complete is refused").toBe(409);
    expect(((await res.json()) as { error?: { code?: string; fixture_ids?: string[] } }).error).toMatchObject({
      code: "STAGE_HAS_UNDECIDED_FIXTURES",
      fixture_ids: [bronze!.id],
    });
    await expect(page.getByTestId("schedule-warning"), "said in the organiser's words").toHaveText(
      "This bracket still has matches without a result. Finish or settle them first.",
    );
    expect(await stageStatus(), "the stage stays active").toBe("active");

    // The positive pair: the third-place line decided again, the same Complete goes through.
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${bronze!.id}/state`);
    const decided = await apiJson(request, `/api/v1/fixtures/${bronze!.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "badminton.game.summary",
      payload: { home: 21, away: 12 },
    });
    expect(decided.status, JSON.stringify(decided.error)).toBeLessThan(300);
    await page.reload();
    await expect(complete).toBeEnabled({ timeout: 20_000 });
    await complete.click();
    await expect.poll(stageStatus, { timeout: 20_000 }).toBe("complete");
    await expect(page.getByTestId("schedule-warning")).toHaveCount(0);
  });
});

// X-SD-7 / X-SD-8 (W4 T7, K5): a knockout's unseeded players are DRAWN with the stage's own seed, never placed in
// registration order — main handed the byes to the first two to register. The seed is the stage's, so the same field
// draws the same bracket every time: an Undo then a fresh Generate, and a Rebuild, both seat it again. Expected seats come
// from the draw (`lib/swiss-draw.ts` over the field in registration order) and the rulebook (RB4-D2: the byes go to the
// draw's top two), never from the stage code; read back on the run sheet.
test.describe("X-SD-7 the draw replays", () => {
  test("six unseeded players: the byes go to the draw's top two, and Undo + Generate, then Rebuild, seat the same bracket", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Draw cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    // One POST each, so registration order is the server's own tie-break (`seed nulls last, created_at, id`).
    const registered: { id: string; display_name: string }[] = [];
    for (const n of ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay"]) {
      const added = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
        { kind: "individual", display_name: `Draw ${n} ${TAG}` },
      ]);
      expect(added.status, JSON.stringify(added.error)).toBe(201);
      registered.push(added.data![0]!);
    }
    const nameOf = new Map(registered.map((e) => [e.id, e.display_name]));
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const drawn = swissRoundOneOrder(swissDrawSeed(stageId), registered.map((e) => ({ id: e.id, seed: null })));
    const rows = async () => (await stageFixtures(request, divisionId, stageId)) as Seated[];
    const seats = (fx: Seated[]) => fx.map((f) => `${f.round_no}:${f.seq_in_round}:${f.home_entrant_id ?? "-"}|${f.away_entrant_id ?? "-"}`).sort();
    const byeHolders = (fx: Seated[]) =>
      fx
        .filter((f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null))
        .map((f) => nameOf.get((f.home_entrant_id ?? f.away_entrant_id)!)!)
        .sort();

    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
    const first = await rows();
    expect(first.length, "premise: a bracket of eight, seven lines").toBe(7);
    const want = [nameOf.get(drawn[0]!)!, nameOf.get(drawn[1]!)!].sort();
    expect(byeHolders(first), "RB4-D2/D3: the byes go to the draw's top two").toEqual(want);

    const undo = await apiJson(request, `/api/v1/divisions/${divisionId}/undo`, "POST", {});
    expect(undo.status, JSON.stringify(undo.error)).toBe(200);
    expect((await rows()).length, "Undo took the bracket away").toBe(0);
    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
    expect(seats(await rows()), "RB4-D4: the same field draws the same bracket").toEqual(seats(first));
    const rebuilt = await apiJson(request, `/api/v1/stages/${stageId}/rebuild`, "POST");
    expect(rebuilt.status, JSON.stringify(rebuilt.error)).toBe(200);
    expect(seats(await rows()), "RB4-D5: a Rebuild reuses the stage's seed").toEqual(seats(first));

    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    for (const name of want) {
      await expect(page.getByTestId("run-sheet-bye").filter({ hasText: name }), `the run sheet shows ${name}'s bye`).toHaveCount(1, { timeout: 20_000 });
    }
  });
});

// FX-G2 (W4 T8; MB-005): Generate over a bracket that already has its lines reconciles it. Main inserted by `ext_key`
// alone: an eighth player added after the draw of seven inserted nothing and the desk said "fixtures are up to date"
// while the player sat in no line. Now the desk's own Generate places them in the bye, in place, and says so.
test.describe("FX-G2 Generate places the eighth player in the bye", () => {
  test("seven unseeded players drawn, an eighth registered, Generate pressed on the desk: the bye becomes their match, nothing inserted, and the notice counts the placement", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Reconcile cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const registered: { id: string; display_name: string }[] = [];
    for (const n of ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay", "Gus"]) {
      const added = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
        { kind: "individual", display_name: `Recon ${n} ${TAG}` },
      ]);
      expect(added.status, JSON.stringify(added.error)).toBe(201);
      registered.push(added.data![0]!);
    }
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
    const rows = async () => (await stageFixtures(request, divisionId, stageId)) as Seated[];
    const first = await rows();
    // Seven of eight slots: one bye, held by the draw's first (RB4-D2/D3 over lib/swiss-draw.ts).
    const drawn = swissRoundOneOrder(swissDrawSeed(stageId), registered.map((e) => ({ id: e.id, seed: null })));
    const byes = first.filter((f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    expect([first.length, byes.length], "premise: seven lines, one bye").toEqual([7, 1]);
    expect(byes[0]!.home_entrant_id ?? byes[0]!.away_entrant_id, "premise: the bye is the draw's first").toBe(drawn[0]);

    const late = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "individual", display_name: `Recon Hal ${TAG}` },
    ]);
    expect(late.status, JSON.stringify(late.error)).toBe(201);
    const lateId = late.data![0]!.id;

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    // B2 fix round 1 (item 6): the first Generate made the stage `active` before Start, so the not-started rule alone hid
    // Generate; the desk offers it again because the roster moved — the same control, worded "Update draw".
    const generate = page.getByTestId("stage-generate");
    await expect(generate).toBeEnabled({ timeout: 20_000 });
    await expect(generate).toHaveText("Update draw");
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/stages/${stageId}/generate`) && r.request().method() === "POST");
    await generate.click();
    expect((await answered).status(), "Generate answers 200 (main: 'up to date', the player in no line)").toBe(200);
    await expect(page.getByText("1 new entrant placed in a bye.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Nothing new to generate — fixtures are up to date.", { exact: true })).toHaveCount(0);
    // The roster matches the seats again, so the offer is gone (it comes back only when the roster moves).
    await expect(page.getByTestId("stage-generate"), "no drift left: no Update draw").toHaveCount(0, { timeout: 20_000 });

    const after = await rows();
    expect(after.map((f) => f.id).sort(), "nothing inserted or deleted: the same seven lines").toEqual(first.map((f) => f.id).sort());
    const line = after.find((f) => f.id === byes[0]!.id)!;
    expect([line.home_entrant_id, line.away_entrant_id].sort(), "the bye became the eighth player's match against its holder").toEqual(
      [drawn[0], lateId].sort(),
    );
    expect(
      after.filter((f) => f.round_no === 1 && (f.home_entrant_id === null || f.away_entrant_id === null)).length,
      "round one is full: no bye is left",
    ).toBe(0);
  });
});

// X-LE-3/X-LE-4 (W4 T10; ruling 263): "Add late player" on a Started knockout. Six seeded in a bracket of eight, so seeds 1
// and 2 hold byes; the newcomer plays the LOWEST-seeded holder (seed 2, RB4-L4 — read off the seeds given here, not the
// code), that bye's line is a match again on the run sheet, and a full round 1 refuses the next add by name.
test.describe("X-LE-3 a late player takes the bye", () => {
  test("six seeded Started, a seventh added: they meet seed 2 on the run sheet; an eighth fills the other bye; a ninth is refused KO_LATE_ENTRY_NO_SLOT", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const names = ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay"].map((n) => `Late ${n} ${TAG}`);
    const ko = await startedKnockout(request, "Late bye cup", names);
    const seedOf = new Map([...ko.nameOf].map(([id, name]) => [id, names.indexOf(name) + 1]));
    const seed2 = [...seedOf].find(([, s]) => s === 2)![0];
    const before = await ko.rows();
    const byes = before.filter((f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    expect(byes.length, "premise: two byes").toBe(2);
    const seed2Line = byes.find((f) => (f.home_entrant_id ?? f.away_entrant_id) === seed2)!;
    expect(seed2Line, "premise: seed 2 holds a bye").toBeTruthy();

    const lateName = `Late Gus ${TAG}`;
    const late = await apiJson<{ id: string; late_entry?: { format: string; case: string; fixture_id?: string; opponent_id?: string } }>(
      request,
      `/api/v1/divisions/${ko.divisionId}/entrants`,
      "POST",
      { kind: "individual", display_name: lateName },
    );
    expect(late.status, JSON.stringify(late.error)).toBe(201);
    expect(late.data!.late_entry).toMatchObject({ format: "knockout", case: "bye", fixture_id: seed2Line.id, opponent_id: seed2 });

    await page.goto(await divisionPath(request, ko.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    await showAllFixtures(page);
    const row = page.locator(`li[data-fixture-no="${seed2Line.fixture_no}"]`);
    await expect(row, "the late player is on seed 2's line").toContainText(lateName, { timeout: 20_000 });
    await expect(row).toContainText(ko.nameOf.get(seed2)!);

    // The second call takes the remaining bye (seed 1's); the third finds round 1 full — nothing has started, so Rebuild
    // is offered — and writes nothing.
    const second = await apiJson<{ late_entry?: { case: string; opponent_id?: string } }>(request, `/api/v1/divisions/${ko.divisionId}/entrants`, "POST", {
      kind: "individual",
      display_name: `Late Hal ${TAG}`,
    });
    expect(second.status, JSON.stringify(second.error)).toBe(201);
    expect(second.data!.late_entry).toMatchObject({ case: "bye", opponent_id: [...seedOf].find(([, s]) => s === 1)![0] });
    const third = await apiJson(request, `/api/v1/divisions/${ko.divisionId}/entrants`, "POST", { kind: "individual", display_name: `Late Ivy ${TAG}` });
    expect([third.status, third.error?.code, third.error?.message]).toEqual([409, "KO_LATE_ENTRY_NO_SLOT", "Round 1 complete; no slot left."]);
    const list = await apiJson<{ display_name: string }[]>(request, `/api/v1/divisions/${ko.divisionId}/entrants`);
    expect(list.data!.some((e) => e.display_name === `Late Ivy ${TAG}`), "the refused add wrote nothing").toBe(false);
  });
});

// X-LE-10 (W4 T11, K7/K13; ruling 271): an AUTOMATIC arrival is never placed by the app. Here the arrival is a Reinstate
// (the public PATCH door): eight Started, one withdrawn — the withdrawal walks their line over — then reinstated. They
// WAIT: the walked-over line is unchanged, the competition desk says "1 late player waiting — add to bracket" (the
// brief's sentence, typed here), and the organiser's one tap (`POST /stages/{id}/late-entrants/{entrantId}/place`) gives
// them their own seat back, the walkover reversed; the desk row goes and a second tap is refused by name.
test.describe("X-LE-10 a reinstated player waits, then one tap places them", () => {
  test("withdraw, reinstate: the desk flags one late player; the tap reverses their walkover; a second tap is KO_LATE_ENTRY_NOT_WAITING", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const names = ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay", "Gus", "Hal"].map((n) => `Wait ${n} ${TAG}`);
    const ko = await startedKnockout(request, "Late wait cup", names);
    const line = (await ko.rows()).find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    const gone = line.home_entrant_id!;
    const opp = line.away_entrant_id!;
    const out = await apiJson(request, `/api/v1/entrants/${gone}/withdraw`, "POST");
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    const walked = (await ko.rows()).find((f) => f.id === line.id)!;
    expect(walked.status, "premise: the withdrawal walked the line over").not.toBe("scheduled");

    const back = await apiJson(request, `/api/v1/entrants/${gone}`, "PATCH", { status: "registered" });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect((await ko.rows()).find((f) => f.id === line.id), "the reinstatement re-seats nobody").toEqual(walked);

    const div = await apiJson<{ competition_id: string }>(request, `/api/v1/divisions/${ko.divisionId}`);
    await page.goto(await competitionPath(request, div.data!.competition_id));
    await dismissCookieBanner(page);
    const flag = page.locator('[data-attention="late_players_waiting"]').first();
    await expect(flag, "the desk flags the waiting player").toContainText("1 late player waiting — add to bracket", { timeout: 20_000 });

    const tap = await apiJson<{ case: string; fixture_id?: string; opponent_id?: string }>(
      request,
      `/api/v1/stages/${ko.stageId}/late-entrants/${gone}/place`,
      "POST",
    );
    expect(tap.status, JSON.stringify(tap.error)).toBe(200);
    expect(tap.data).toMatchObject({ case: "withdrawn_slot", fixture_id: line.id, opponent_id: opp });
    const placed = (await ko.rows()).find((f) => f.id === line.id)!;
    expect([placed.home_entrant_id, placed.away_entrant_id, placed.status]).toEqual([gone, opp, "scheduled"]);

    await page.reload();
    await expect(page.locator('[data-attention="late_players_waiting"]'), "the desk row goes").toHaveCount(0, { timeout: 20_000 });
    const again = await apiJson(request, `/api/v1/stages/${ko.stageId}/late-entrants/${gone}/place`, "POST");
    expect([again.status, again.error?.code, again.error?.message]).toEqual([409, "KO_LATE_ENTRY_NOT_WAITING", "This player isn't waiting to join this bracket."]);
  });
});

// X-LL-1 (W4 T13, K9; RB4-V2): a qualifier who withdraws before their first main-draw match is replaced by a LUCKY
// LOSER — the best loser below the cut — and the opponent is not walked over. Driven through the v1 routes the desk calls
// (Generate, Start, the scorer, Complete, the proposal and its confirm, Withdraw) and read back on the division's run
// sheet. Expected: every qualifying line is won by its home side, so the quarter-final losers are the four away seats of
// round 1 and the lucky loser is the best-seeded of them (one round, so seed decides: C2); never the code under test.
test.describe("X-LL-1 a lucky loser fills the main draw", () => {
  test("eight qualify for a main draw of four; a qualifier withdraws before their match — the best quarter-final loser takes the seat, and the run sheet names them", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Lucky loser ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string; display_name: string; seed: number }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `LL${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
    const seedOf = new Map(added.data!.map((e, i) => [e.id, i + 1]));
    const qual = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Qualifying", config: {} });
    expect(qual.status, JSON.stringify(qual.error)).toBe(201);
    const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Main draw",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
    });
    expect(main.status, JSON.stringify(main.error)).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${qual.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/stages/${main.data!.id}/generate`, "POST")).status, "the main draw's day-one lines").toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);

    const qualRows = async () => (await stageFixtures(request, divisionId, qual.data!.id)) as (Seated & { round_no: number })[];
    for (let guard = 0; guard < 6; guard++) {
      const open = (await qualRows()).filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status),
      );
      if (open.length === 0) break;
      for (const f of open) await homeWins(request, f.id);
    }
    const quarterLosers = (await qualRows()).filter((f) => f.round_no === 1).map((f) => f.away_entrant_id!);
    expect(quarterLosers.length, "premise: four quarter-final losers, below the cut").toBe(4);
    const expected = [...quarterLosers].sort((a, b) => seedOf.get(a)! - seedOf.get(b)!)[0]!;
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${qual.data!.id}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const proposal = await apiJson<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } }>(
      request,
      `/api/v1/stages/${main.data!.id}/seed-proposal`,
      "POST",
    );
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    const ties = proposal.data!.computed.ties;
    const confirmed = await apiJson(request, `/api/v1/stages/${main.data!.id}/seed-proposal/confirm`, "POST", {
      proposalId: proposal.data!.id,
      ...(ties.length > 0 ? { tiePicks: ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
    });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    const mainRows = async () => (await stageFixtures(request, divisionId, main.data!.id)) as (Seated & { round_no: number })[];
    const line = (await mainRows()).find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    expect(line, "premise: the confirm seated a first-round line").toBeTruthy();
    const leaving = line.away_entrant_id!;
    const staying = line.home_entrant_id!;

    const out = await apiJson<{ walkovers: number; lucky_loser: { entrant_id: string; fixture_id: string } | null }>(
      request,
      `/api/v1/entrants/${leaving}/withdraw`,
      "POST",
    );
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    expect(out.data!.lucky_loser, "the best quarter-final loser takes the seat").toEqual({ entrant_id: expected, fixture_id: line.id });
    expect(out.data!.walkovers, "nobody was walked over").toBe(0);
    const after = (await mainRows()).find((f) => f.id === line.id)!;
    expect([after.home_entrant_id, after.away_entrant_id, after.status]).toEqual([staying, expected, "scheduled"]);

    // The run sheet: the line names the lucky loser beside the player who stayed, and no longer the one who left.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const row = page.locator(`li[data-fixture-no="${line.fixture_no}"]`);
    await expect(row, `the run sheet seats ${nameOf.get(expected)}`).toContainText(nameOf.get(expected)!, { timeout: 20_000 });
    await expect(row).toContainText(nameOf.get(staying)!);
    await expect(row).not.toContainText(nameOf.get(leaving)!);
  });
});

// X-QM-4 (W4 T14, FX-G16; RB4-Q5): a correction inside a completed qualifying stage. An organiser cannot void a quarter-final
// whose semi-final was played (409 NEXT_MATCH_STARTED), so what they really do is unwind: the final, the semi-final, then the
// quarter-final, re-recorded the other way and played forward. Before the main draw starts the confirmed proposal goes
// stale and its seats go back to TBD; a re-proposal seats the new qualifier. After it starts, the bracket stands and the desk
// names who moved. Expected: every line is won by its home side, so the semi-final's away seat is a qualifier who lost the
// semi, and the quarter-final that put them through is the one corrected, its away seat the new qualifier.
test.describe("X-QM-4 a corrected qualifier is re-proposed", () => {
  type Line = Seated & { round_no: number };

  /** Eight qualify for a main draw of four: everything played, completed and confirmed. */
  async function confirmedMainDraw(request: APIRequestContext, label: string) {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "badminton", variant_key: "bwf", config: {} });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `QM${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
    const qual = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Qualifying", config: {} });
    expect(qual.status, JSON.stringify(qual.error)).toBe(201);
    const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Main draw",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
    });
    expect(main.status, JSON.stringify(main.error)).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${qual.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/stages/${main.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    const qualRows = async () => (await stageFixtures(request, divisionId, qual.data!.id)) as Line[];
    const mainRows = async () => (await stageFixtures(request, divisionId, main.data!.id)) as Line[];
    for (let guard = 0; guard < 6; guard++) {
      const open = (await qualRows()).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status));
      if (open.length === 0) break;
      for (const f of open) await homeWins(request, f.id);
    }
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${qual.data!.id}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    await proposeAndConfirm(request, main.data!.id);
    return { divisionId, qualId: qual.data!.id, mainId: main.data!.id, nameOf, qualRows, mainRows };
  }

  type ProposalOut = { id: string; computed: { qualifiers: { entrantId: string }[]; ties: { slots: string[]; entrantIds: string[] }[] } };
  /** A proposal has no GET (no route reads stage_seed_proposals), so its state reads off what the desk's Compute answers. */
  const propose = (request: APIRequestContext, stageId: string) => apiJson<ProposalOut>(request, `/api/v1/stages/${stageId}/seed-proposal`, "POST");
  async function proposeAndConfirm(request: APIRequestContext, stageId: string): Promise<void> {
    const made = await propose(request, stageId);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const ties = made.data!.computed.ties;
    const confirmed = await apiJson(request, `/api/v1/stages/${stageId}/seed-proposal/confirm`, "POST", {
      proposalId: made.data!.id,
      ...(ties.length > 0 ? { tiePicks: ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
    });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
  }

  /** Take a line's decision back: every live event, newest first, as a scorer's Undo does. */
  async function takeBack(request: APIRequestContext, fixtureId: string): Promise<void> {
    const ledger = await apiJson<{ id: string; seq: number; type: string; voids_event_id: string | null }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
    expect(ledger.status, JSON.stringify(ledger.error)).toBe(200);
    const voided = new Set(ledger.data!.map((e) => e.voids_event_id));
    const live = ledger.data!.filter((e) => e.type !== "core.void" && !voided.has(e.id)).sort((a, b) => b.seq - a.seq);
    expect(live.length, "premise: the line holds live events").toBeGreaterThan(0);
    for (const e of live) {
      const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
      const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: state.data!.last_seq, type: "core.void", payload: { event_id: e.id } });
      expect(res.status, JSON.stringify(res.error)).toBeLessThan(300);
    }
  }

  async function awayWins(request: APIRequestContext, fixtureId: string): Promise<void> {
    for (const [type, payload] of [
      ["core.start", {}],
      ["badminton.game.summary", { home: 10, away: 21 }],
      ["badminton.game.summary", { home: 12, away: 21 }],
    ] as const) {
      const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
      const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: state.data!.last_seq, type, payload });
      expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    }
  }

  /** The qualifier who lost a semi-final, the quarter-final that put them through, and who should have won it. */
  async function correctionOf(rows: () => Promise<Line[]>) {
    const all = await rows();
    const final = all.reduce((a, b) => (b.round_no > a.round_no ? b : a));
    const semi = all.find((f) => f.round_no === 2 && f.seq_in_round === 1)!;
    const out = semi.away_entrant_id!;
    const quarter = all.find((f) => f.round_no === 1 && f.home_entrant_id === out)!;
    expect(quarter, "premise: every line was won by its home side").toBeTruthy();
    return { final, semi, quarter, out, in: quarter.away_entrant_id! };
  }

  /** Replay forward: the corrected quarter-final, then the semi-final and the final, both to the home seat. */
  async function replay(request: APIRequestContext, c: { final: Line; semi: Line; quarter: Line }): Promise<void> {
    await awayWins(request, c.quarter.id);
    await homeWins(request, c.semi.id);
    await homeWins(request, c.final.id);
  }

  test("before the main draw starts: the seats go back to TBD, and a re-proposal seats the new qualifier on the run sheet", async ({ page, request }) => {
    test.setTimeout(300_000);
    const q = await confirmedMainDraw(request, "Corrected qualifier");
    const seated = (rows: Line[]) => rows.filter((f) => f.round_no === 1).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]);
    const c = await correctionOf(q.qualRows);
    expect(seated(await q.mainRows()), "premise: the confirmed main draw seats the semi-final loser").toContain(c.out);

    await takeBack(request, c.final.id);
    expect(seated(await q.mainRows()), "the final's void moves nobody across the cut").toContain(c.out);
    expect((await propose(request, q.mainId)).error?.code, "still confirmed").toBe("SEEDING_ALREADY_CONFIRMED");
    await takeBack(request, c.semi.id);
    await takeBack(request, c.quarter.id);

    expect(seated(await q.mainRows()).every((id) => id === null), "the quarter-final's void empties the seats it fed").toBe(true);
    const undecided = await propose(request, q.mainId);
    expect([undecided.status, undecided.error?.code], "no longer confirmed, and nothing to propose from until the source is decided").toEqual([409, "SEEDING_SOURCE_INCOMPLETE"]);
    await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
    await expect(page.locator('[data-progression-state="stale"]'), "the desk says the proposal went stale").toBeVisible({ timeout: 20_000 });

    await replay(request, c);
    await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
    await expect(page.locator('[data-progression-state="draft"]'), "re-decided, a fresh draft waits on the desk with nobody asking").toBeVisible({ timeout: 20_000 });
    const fresh = await propose(request, q.mainId);
    expect(fresh.status, JSON.stringify(fresh.error)).toBe(201);
    const offered = fresh.data!.computed.qualifiers.map((x) => x.entrantId);
    expect(offered).toContain(c.in);
    expect(offered).not.toContain(c.out);
    await proposeAndConfirm(request, q.mainId);

    const line = (await q.mainRows()).find((f) => f.round_no === 1 && (f.home_entrant_id === c.in || f.away_entrant_id === c.in));
    expect(line, "the new qualifier holds a seat").toBeTruthy();
    await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const row = page.locator(`li[data-fixture-no="${line!.fixture_no}"]`);
    await expect(row, "the run sheet seats the new qualifier").toContainText(q.nameOf.get(c.in)!, { timeout: 20_000 });
    await expect(row).not.toContainText(q.nameOf.get(c.out)!);
  });

  // The owner's ruling (RB4-Q3 seeds by rank): the same four in a new order is a new draw while nothing is lost by redrawing it.
  // Expected from the final's own seats: its away side now wins, so it is rank 1 and its home side rank 2.
  test("before the main draw starts, the final flipped: the seats go back and the same four are offered in the new order", async ({ page, request }) => {
    test.setTimeout(300_000);
    const q = await confirmedMainDraw(request, "Flipped final");
    const seated = (rows: Line[]) => rows.filter((f) => f.round_no === 1).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]);
    const { final } = await correctionOf(q.qualRows);
    const four = new Set(seated(await q.mainRows()));
    expect(four.size, "premise: four qualifiers seated").toBe(4);

    await takeBack(request, final.id);
    await awayWins(request, final.id);

    expect(seated(await q.mainRows()).every((id) => id === null), "the confirmed order no longer stands: the seats go back").toBe(true);
    await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
    await expect(page.locator('[data-progression-state="draft"]'), "a fresh draft waits on the desk with nobody asking").toBeVisible({ timeout: 20_000 });
    const fresh = await propose(request, q.mainId);
    expect(fresh.status, JSON.stringify(fresh.error)).toBe(201);
    const offered = fresh.data!.computed.qualifiers.map((x) => x.entrantId);
    expect(new Set(offered), "the same four").toEqual(four);
    expect(offered.slice(0, 2), "the new winner seeded first").toEqual([final.away_entrant_id, final.home_entrant_id]);
  });

  test("after the main draw starts: the bracket stands and the organiser's desk names who moved, at every width", async ({ page, request }) => {
    test.setTimeout(300_000);
    const q = await confirmedMainDraw(request, "Bracket stands");
    const c = await correctionOf(q.qualRows);
    const line = (await q.mainRows()).find((f) => f.round_no === 1 && f.home_entrant_id !== c.out && f.away_entrant_id !== c.out)!;
    await homeWins(request, line.id);
    const before = await q.mainRows();

    await takeBack(request, c.final.id);
    await takeBack(request, c.semi.id);
    await takeBack(request, c.quarter.id);
    await replay(request, c);

    expect(await q.mainRows(), "no seat moved").toEqual(before);
    expect((await propose(request, q.mainId)).error?.code, "the proposal stays confirmed").toBe("SEEDING_ALREADY_CONFIRMED");

    const warning = page.getByTestId("knockout-cut-drift-warning");
    const words = uiEn["knockout.cutDrift.warning.one"]!;
    expect(words, "premise: the dictionary has the sentence").toBeTruthy();
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
      await expect(warning, `visible at ${width}`).toBeVisible({ timeout: 20_000 });
      await expect(warning, "the dictionary's sentence, each name on its own side").toHaveText(words.replace("{in}", q.nameOf.get(c.in)!).replace("{out}", q.nameOf.get(c.out)!));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no horizontal page scroll at ${width}`).toBeLessThanOrEqual(0);
    }
  });
});
