import { test, expect } from "@playwright/test";
import { seedScoredDivision, divisionPath, TAG, apiJson } from "./helpers";

// PROMPT-27 player stats: the leaderboard tab renders one of its settled
// states. seedScoredDivision scores at result level, and W4 gave the generic
// module a playerStats model (generic.score → person), so a result-only
// division is exactly the case the "requires detailed scoring" notice exists
// for — no per-person rows, decided fixtures, wrong zeros refused.
//
// The assertion anchors on the test id, not the copy: the strings live in four
// dictionaries and the notice's wording ("stats require detailed") stopped
// matching the old /requires detailed/i probe without failing anything, because
// the panel was landing in the empty state until W4.
test("stats tab renders the requires-detailed notice for result-level scoring", async ({
  page,
  request,
}) => {
  const { divisionId } = await seedScoredDivision(request);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=stats"));
  await expect(page.getByTestId("stats-requires-detailed")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("stats-board")).toHaveCount(0);
});

// S8/#417 W6 (owner-ruled gap 4): the wave that wires per-sport player stats
// — the entrant->person fold in @seazn/engine/stats, plus this app's
// entrant_members loader (server/engine-db/entrant-members.ts) that makes the
// fallback reachable from real data — shipped with unit + conformance
// coverage only. There is no rendering page yet (S9/#418 builds /me), so this
// drives the real /api/v1 HTTP surface end to end: a real event stream in, a
// real per-person number out. Each assertion below is written to fail hard —
// not just a non-200 — if `aggregatePlayerStats`/`aggregatePlayerStatsWithDiagnostics`
// returned `[]`: `row` would be `undefined` and `row!.stats.*` would throw.
test("an explicit scorer's goals and points are credited from a real football event stream", async ({
  page,
}) => {
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Stats Explicit ${TAG}`,
    visibility: "public",
  });
  const div = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Prem", sport_key: "football", variant_key: "11-a-side" },
  );
  const divisionId = div.data!.id;

  const scorer = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Goal Scorer ${TAG}`,
    consent: { public_name: true },
  });
  const keeper = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Keeper Away ${TAG}`,
    consent: { public_name: true },
  });
  const ents = await apiJson<{ id: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      {
        kind: "team",
        display_name: `Reds ${TAG}`,
        seed: 1,
        members: [{ person_id: scorer.data!.id }],
      },
      {
        kind: "team",
        display_name: `Blues ${TAG}`,
        seed: 2,
        members: [{ person_id: keeper.data!.id }],
      },
    ],
  );
  const homeId = ents.data![0]!.id;
  const awayId = ents.data![1]!.id;

  const stage = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(page.request, `/api/v1/divisions/${divisionId}/start`, "POST");

  // The engine's `applyGoal` rejects an explicit scorer who is not on the
  // pitch (football.ts: "scorer is not on the pitch for <entrant>") — both
  // sides need a real lineup, not just the scoring one, to mirror how an
  // organiser would actually run this fixture.
  await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/lineups/${homeId}`, "PUT", {
    slots: [{ person_id: scorer.data!.id, slot: "starting", position_key: "FW", order_no: 1, roles: [] }],
  });
  await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/lineups/${awayId}`, "PUT", {
    slots: [{ person_id: keeper.data!.id, slot: "starting", position_key: "GK", order_no: 1, roles: [] }],
  });

  const started = await apiJson<{ seq: number }>(
    page.request,
    `/api/v1/fixtures/${fixtureId}/events`,
    "POST",
    { expected_seq: 0, type: "core.start", payload: {} },
  );
  const goal = await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: started.data!.seq,
    type: "football.goal",
    payload: { by: homeId, scorer: scorer.data!.id },
  });
  expect(goal.status, `football.goal rejected: ${JSON.stringify(goal.error)}`).toBeLessThan(300);

  const table = await apiJson<{
    rows: { person_id: string; full_name: string; stats: Record<string, number> }[];
    requires_detailed_scoring: boolean;
  }>(page.request, `/api/v1/divisions/${divisionId}/stats/players?metric=goals`);
  expect(table.status).toBe(200);
  expect(table.data!.requires_detailed_scoring).toBe(false);
  const row = table.data!.rows.find((r) => r.person_id === scorer.data!.id);
  expect(row).toBeDefined();
  expect(row!.stats.goals).toBe(1);
  expect(row!.stats.points).toBe(1);

  // Also reaches the one real rendering surface that exists today (the
  // division console's own Stats tab, PROMPT-27 — S9/#418 is what adds a
  // dedicated /me page, not this session's job).
  await page.goto(await divisionPath(page.request, divisionId, "?tab=stats"));
  await expect(page.getByTestId("stats-board")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`Goal Scorer ${TAG}`)).toBeVisible();
});

// THE HEADLINE case #417 exists for: a v1-era stream that names only the
// entrant (setbased `wonBy`, no `scorer`/`server`) must still produce a
// per-person row, via this app's entrant_members -> PlayerStatsFoldCtx
// wiring (entrant-members.ts's `entrantFoldCtx`/`loadEntrantMembersForDivision`)
// rather than the explicit-person metric path. No lineup is ever recorded for
// this fixture — the fallback is keyed on entrant roster membership only, so
// setting one would prove the wrong mechanism.
test("a wonBy-only rally (no scorer/server) still credits a person via the entrant-fallback path", async ({
  page,
}) => {
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Stats Fallback ${TAG}`,
    visibility: "public",
  });
  const div = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "badminton", variant_key: "bwf" },
  );
  const divisionId = div.data!.id;

  const alex = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Alex Fallback ${TAG}`,
    consent: { public_name: true },
  });
  const bo = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Bo Fallback ${TAG}`,
    consent: { public_name: true },
  });
  const ents = await apiJson<{ id: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      {
        kind: "individual",
        display_name: `Alex E ${TAG}`,
        seed: 1,
        members: [{ person_id: alex.data!.id }],
      },
      {
        kind: "individual",
        display_name: `Bo E ${TAG}`,
        seed: 2,
        members: [{ person_id: bo.data!.id }],
      },
    ],
  );
  const homeEntrantId = ents.data![0]!.id;

  const stage = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(page.request, `/api/v1/divisions/${divisionId}/start`, "POST");
  // Resolve which entrant is actually home for THIS generated fixture — league
  // generation order is not the assertion here, real attribution is.
  const fixture = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }>(
    page.request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  const homeId = fixture.data!.home_entrant_id;
  expect(homeId).not.toBeNull();

  const started = await apiJson<{ seq: number }>(
    page.request,
    `/api/v1/fixtures/${fixtureId}/events`,
    "POST",
    { expected_seq: 0, type: "core.start", payload: {} },
  );
  // ONLY the entrant id — no scorer, no server: exactly the v1-era shape
  // #417's entrant fallback exists to attribute.
  const rally = await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: started.data!.seq,
    type: "badminton.rally",
    payload: { wonBy: homeId },
  });
  expect(rally.status, `badminton.rally rejected: ${JSON.stringify(rally.error)}`).toBeLessThan(300);

  const table = await apiJson<{
    rows: { person_id: string; stats: Record<string, number> }[];
    requires_detailed_scoring: boolean;
  }>(page.request, `/api/v1/divisions/${divisionId}/stats/players`);
  expect(table.status).toBe(200);
  const homePersonId = homeId === homeEntrantId ? alex.data!.id : bo.data!.id;
  const row = table.data!.rows.find((r) => r.person_id === homePersonId);
  expect(row).toBeDefined();
  expect(row!.stats.points_won).toBe(1);
  expect(table.data!.requires_detailed_scoring).toBe(false);
});
