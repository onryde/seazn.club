// A table refold that fails AFTER the score committed (fix round 1 of the lots-draw fix, review I-3, 2026-11-18).
//
// `onDecided` refolds a table stage's standings (`recomputeStandings`) after `scoreEvent`'s append has committed. Before this
// fix the call was the one hook there with no catch: a refold that threw (the load run's: a lots draw of a 72+ entrant tie
// class the store could not index, V528) answered a result that STOOD with a 500, and skipped every hook after it - the
// seed-proposal staleness, the discipline and news refreshes, auto-advance, and the room's finish on the external-play path.
// Now: the score is answered as written, a named event (`standings_recompute_failed`, with the fixture and the stage) is
// logged, and the request does not auto-advance (controller ruling, fix round 1).
//
// The refold is the real one, behind a one-shot failure keyed by stage: armed, the NEXT refold of that stage throws the
// load run's own error, once; every other refold (the stage's completion included) is the real one. Everything else is the
// product's own: a generic league of three feeding a two-seat knockout, auto_progress on, every result through `scoreEvent`.
// Expected values come from the rulebook (a decided fixture counts one played match for each side), never from the code
// under test.
// Single-sport reason: the change is the post-commit control flow of `onDecided`, which no sport reaches differently.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const inject = vi.hoisted(() => ({ failNext: new Map<string, number>(), fired: 0 }));
vi.mock("@/server/engine-db", async (orig) => {
  const real = await orig<typeof import("@/server/engine-db")>();
  return {
    ...real,
    recomputeStandings: vi.fn(async (...args: Parameters<typeof real.recomputeStandings>) => {
      const left = inject.failNext.get(args[1]) ?? 0;
      if (left > 0) {
        inject.failNext.set(args[1], left - 1);
        inject.fired++;
        throw Object.assign(new Error('index row size 7376 exceeds btree version 4 maximum 2704 for index "stage_lots_draws_live_key"'), {
          code: "54000",
        });
      }
      return real.recomputeStandings(...args);
    }),
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

afterEach(() => {
  inject.failNext.clear();
  vi.restoreAllMocks();
});

async function rig() {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Refold " + suffix, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const kind = builtinModules.find((m) => m.key === "generic")?.entrantModel?.defaultKind ?? "individual";
  await createEntrants(auth, division.id, ["A", "B", "C"].map((n, i) => ({ kind, display_name: n, seed: i + 1, members: [] })));
  await patchDivision(auth, division.id, { auto_progress: true });
  const [league, ko] = await createStages(auth, division.id, [
    { seq: 1, kind: "league", name: "League", config: {} },
    {
      seq: 2,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
    },
  ]);
  const { fixtures } = await generateStageFixtures(auth, league!.id);
  await startDivision(auth, division.id);
  expect(fixtures.length, "rig: a league of three has three fixtures").toBe(3);
  return { auth, divisionId: division.id, leagueId: league!.id, koId: ko!.id, fixtures: fixtures.map((f) => f.id) };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** The home side wins 1-0: a Start (when there is none yet), then the result. */
async function win(auth: AuthCtx, id: string, before?: () => void) {
  const [st] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id} and type = 'core.start'`;
  if (st!.n === 0) await post(auth, id, "core.start");
  before?.();
  return post(auth, id, "generic.result", { p1Score: 1, p2Score: 0 });
}

/** What the request left behind: the fixture's status, the stored table's played count, and whether the stage advanced. */
async function state(r: Rig, fixtureId: string) {
  const [f] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  const [snap] = await sql<{ played: number | null }[]>`
    select (select sum((x ->> 'played')::int) from jsonb_array_elements(rows) x)::int as played
      from standings_snapshots where stage_id = ${r.leagueId} and pool_id is null`;
  const [ev] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'stage_auto_advanced'`;
  const [ko] = await sql<{ seated: number }[]>`
    select count(*) filter (where home_entrant_id is not null)::int + count(*) filter (where away_entrant_id is not null)::int as seated
      from fixtures where stage_id = ${r.koId}`;
  const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${r.leagueId}`;
  return { fixture: f!.status, played: snap?.played ?? 0, autoAdvanced: ev!.n, koSeated: ko!.seated, league: stage!.status };
}

const refoldFailures = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map((c) => c[0] as { event?: string; fixtureId?: string; stageId?: string })
    .filter((o) => o?.event === "standings_recompute_failed")
    .map((o) => ({ fixtureId: o.fixtureId, stageId: o.stageId }));

describe.skipIf(!HAS_DB)("a table refold that fails after the score committed", () => {
  it("answers the committed score, logs it by name, does not auto-advance; a void on it the same; the next result refolds and advances", async () => {
    const r = await rig();
    const [f1, f2, f3] = r.fixtures as [string, string, string];
    const errors = vi.spyOn(log, "error");
    await win(r.auth, f1);
    await win(r.auth, f2);
    expect((await state(r, f2)).played, "premise: two results folded, one played match a side (four)").toBe(4);

    // 1. the last result of the league, its refold failing: the score is answered as written
    const fired = inject.fired;
    const out = await win(r.auth, f3, () => inject.failNext.set(r.leagueId, 1));
    expect(inject.fired - fired, "premise: the injected failure fired, once").toBe(1);
    expect(out.status, "scoreEvent answers the committed result").toBe("decided");
    expect(refoldFailures(errors), "the failure is logged by name, with the fixture and the stage").toEqual([{ fixtureId: f3, stageId: r.leagueId }]);
    expect(await state(r, f3), "the result stands, the stored table is the stale one, nothing advanced").toEqual({
      fixture: "decided",
      played: 4,
      autoAdvanced: 0,
      koSeated: 0,
      league: "active",
    });

    // 2. a void of that result, its refold failing too: answered, logged again, the fixture reopened
    const [res] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${f3} and type = 'generic.result'`;
    inject.failNext.set(r.leagueId, 1);
    const voided = await post(r.auth, f3, "core.void", { event_id: res!.id });
    expect(voided.outcome, "the void is answered: the result is gone").toBeNull();
    expect(refoldFailures(errors), "logged again, for the same fixture").toEqual([
      { fixtureId: f3, stageId: r.leagueId },
      { fixtureId: f3, stageId: r.leagueId },
    ]);
    const afterVoid = await state(r, f3);
    expect(afterVoid.fixture, "the fixture is no longer decided").not.toBe("decided");
    expect([afterVoid.autoAdvanced, afterVoid.koSeated], "still nothing advanced").toEqual([0, 0]);

    // 3. the next result, its refold the real one: the table catches up (three results, six played) and the stage advances
    const again = await win(r.auth, f3);
    expect(again.status).toBe("decided");
    expect(refoldFailures(errors), "no further failure logged").toHaveLength(2);
    expect(await state(r, f3), "the refolded table, and the advance auto_progress asks for").toEqual({
      fixture: "decided",
      played: 6,
      autoAdvanced: 1,
      koSeated: 2,
      league: "complete",
    });
  }, 120_000);
});
