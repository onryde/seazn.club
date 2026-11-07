import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, activeOrgIdFromRequest, apiJson, divisionPath, seedVenueWithCourts } from "./helpers";
import { showAllFixtures, stageFixtures, type Fx } from "./support/swiss-app-a-kit";

// W4 knockout app-A (spec 2026-11-04-format-matrix-w4-knockout-design.md). One describe per rule, each driven through the
// real product: the v1 routes the desk and the pad call, and read back on the division's run sheet.

type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };

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
