// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, v1, v1data } from "../harness.ts";
import { careerRollupSuite } from "./careerRollup.ts";

/**
 * S8/#417 W6 (owner-ruled gap 4): the entrant->person player-stat fold —
 * @seazn/engine/stats's aggregatePlayerStats/aggregatePlayerStatsWithDiagnostics
 * plus this app's entrant_members loader that makes the fallback reachable
 * from real data (server/engine-db/entrant-members.ts) — shipped with unit
 * and conformance coverage only. This mirrors apps/web/e2e/stats.spec.ts's
 * two cases over the real /api/v1 HTTP surface: an explicit person field
 * (football.goal's `scorer`) and the v1-era entrant-only fallback
 * (badminton.rally's `wonBy` alone). Every `check` below reads a specific
 * number out of a real event stream — if the fold regressed to returning
 * `[]`, `scorerRow`/`fallbackRow` would be `undefined` and every `?.` read
 * below becomes `undefined === 1`, i.e. every check here goes FAIL, not just
 * a non-200. Own fresh competitions; keyless-safe.
 */
export async function playerStatsSuite(admin: Session, proOrgId: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;

  // --- explicit attribution: football.goal names a scorer directly ---
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Stats Explicit ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Prem",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  const scorer = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Goal Scorer ${tag}`,
      consent: { public_name: true },
    }),
  );
  const keeper = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Keeper Away ${tag}`,
      consent: { public_name: true },
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "team", display_name: `Reds ${tag}`, seed: 1, members: [{ person_id: scorer.id }] },
      { kind: "team", display_name: `Blues ${tag}`, seed: 2, members: [{ person_id: keeper.id }] },
    ]),
  );
  const homeId = ents[0].id;
  const awayId = ents[1].id;
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const fixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures;
  check("stats: football fixture generated", fixtures.length >= 1);
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  const fixtureId = fixtures[0].id;
  // The engine's `applyGoal` rejects an explicit scorer who is not on the
  // pitch — both sides need a real lineup, not just the scoring one.
  await v1(admin, `/api/v1/fixtures/${fixtureId}/lineups/${homeId}`, "PUT", {
    slots: [{ person_id: scorer.id, slot: "starting", position_key: "FW", order_no: 1, roles: [] }],
  });
  await v1(admin, `/api/v1/fixtures/${fixtureId}/lineups/${awayId}`, "PUT", {
    slots: [{ person_id: keeper.id, slot: "starting", position_key: "GK", order_no: 1, roles: [] }],
  });
  const started = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    }),
  );
  const goal = await v1(admin, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: started.seq,
    type: "football.goal",
    payload: { by: homeId, scorer: scorer.id },
  });
  check("stats: explicit scorer's football.goal accepted", goal.status < 300);

  const table = v1data<{
    rows: { person_id: string; stats: Record<string, number> }[];
    requires_detailed_scoring: boolean;
  }>(await v1(admin, `/api/v1/divisions/${div.id}/stats/players?metric=goals`));
  const scorerRow = table.rows.find((r) => r.person_id === scorer.id);
  check("stats: explicit scorer credited 1 goal", scorerRow?.stats.goals === 1);
  check("stats: explicit scorer credited 1 point", scorerRow?.stats.points === 1);
  check(
    "stats: football division does not require detailed scoring",
    table.requires_detailed_scoring === false,
  );

  // --- entrant fallback: badminton.rally names only wonBy (v1-era shape) ---
  const fbComp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Stats Fallback ${tag}`,
      visibility: "public",
    }),
  );
  const fbDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${fbComp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
    }),
  );
  const alex = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Alex Fallback ${tag}`,
      consent: { public_name: true },
    }),
  );
  const bo = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Bo Fallback ${tag}`,
      consent: { public_name: true },
    }),
  );
  const fbEnts = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${fbDiv.id}/entrants`, "POST", [
      {
        kind: "individual",
        display_name: `Alex E ${tag}`,
        seed: 1,
        members: [{ person_id: alex.id }],
      },
      { kind: "individual", display_name: `Bo E ${tag}`, seed: 2, members: [{ person_id: bo.id }] },
    ]),
  );
  const homeEntrantId = fbEnts[0].id;
  const fbStage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${fbDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const fbFixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${fbStage.id}/generate`, "POST"),
  ).fixtures;
  check("stats: badminton fixture generated", fbFixtures.length >= 1);
  await v1(admin, `/api/v1/divisions/${fbDiv.id}/start`, "POST");

  const fbFixtureId = fbFixtures[0].id;
  // No lineup PUT anywhere in this half — the entrant-fallback path is keyed
  // on entrant_members, not on-pitch lineups; setting one would prove the
  // wrong mechanism.
  const fbFixture = v1data<{ home_entrant_id: string | null }>(
    await v1(admin, `/api/v1/fixtures/${fbFixtureId}`),
  );
  const homeId2 = fbFixture.home_entrant_id;
  check("stats: badminton fixture has two real entrants", homeId2 !== null);
  const fbStarted = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${fbFixtureId}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    }),
  );
  const rally = await v1(admin, `/api/v1/fixtures/${fbFixtureId}/events`, "POST", {
    expected_seq: fbStarted.seq,
    type: "badminton.rally",
    payload: { wonBy: homeId2 },
  });
  check("stats: wonBy-only badminton.rally accepted", rally.status < 300);

  const fbTable = v1data<{ rows: { person_id: string; stats: Record<string, number> }[] }>(
    await v1(admin, `/api/v1/divisions/${fbDiv.id}/stats/players`),
  );
  const homePersonId = homeId2 === homeEntrantId ? alex.id : bo.id;
  const fallbackRow = fbTable.rows.find((r) => r.person_id === homePersonId);
  check(
    "stats: wonBy-only rally credits the entrant's roster person via the fallback",
    fallbackRow?.stats.points_won === 1,
  );

  await careerRollupSuite(admin, scorer.id, keeper.id);
}
