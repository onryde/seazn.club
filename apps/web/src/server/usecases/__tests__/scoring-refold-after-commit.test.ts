// Post-commit hooks that fail AFTER the score committed (lots-draw fix, review I-3 in round 1, I-A and m2 in round 2,
// 2026-11-18).
//
// `onDecided` runs its table hooks after `scoreEvent`'s append has committed: the refold (`recomputeStandings`), the
// dependent seed proposals' staleness (`markDependentSeedProposalsStale`) and auto-advance's "did the stage just finish?"
// read. Each used to throw straight out of `scoreEvent`: a result that STOOD answered with a 500 (the load run's refold: a
// lots draw of a 72+ entrant tie class the store could not index, V528), and every hook after it skipped. Now each is
// logged by name and the score is answered as written. A failed refold leaves the stored table stale, and auto-advance is
// what heals it when the stage has just finished: the completion ranks the stage afresh from its fixtures (round 2: the
// round-1 gate that skipped auto-advance after a failed refold blocked the only automatic repair).
//
// The failures are one-shot and armed per test: the NEXT refold of a stage throws the load run's own error; the next
// staleness mark throws; or, right after the next staleness mark, the next "fixtures" expunge-abandon fragment (auto-advance's
// readiness read builds exactly one) throws. Every other call is the real one. Everything else is the product's own: a
// generic league of three feeding a two-seat knockout, auto_progress on, every result through `scoreEvent`. Expected values
// come from the rulebook (a decided fixture counts one played match for each side), never from the code under test.
// Single-sport reason: the change is the post-commit control flow of `onDecided`, which no sport reaches differently.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { post, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const inject = vi.hoisted(() => ({
  failNext: new Map<string, number>(),
  failStaleMark: 0,
  trapReadyAfterStaleMark: false,
  trapReady: false,
  failDiscipline: 0,
  disciplineFolds: 0,
  drafted: [] as string[],
  cacheSets: [] as { key: string; value: unknown }[],
  fired: 0,
}));
// scoreEvent's own post-commit hooks after onDecided (fix round 3, review m-1): the discipline fold (`detectSuspensions`,
// which `refreshDiscipline` runs for a division with an enabled rule set), the news draft refreshNews makes for a division
// with auto_posts on, and the idempotency cache write. Passthrough witnesses; the fold throws once when armed.
vi.mock("../discipline", async (orig) => {
  const real = await orig<typeof import("../discipline")>();
  return {
    ...real,
    detectSuspensions: vi.fn(async (...args: Parameters<typeof real.detectSuspensions>) => {
      if (inject.failDiscipline > 0) {
        inject.failDiscipline--;
        inject.fired++;
        throw new Error("Connection terminated unexpectedly");
      }
      inject.disciplineFolds++;
      return real.detectSuspensions(...args);
    }),
  };
});
vi.mock("../org-posts", async (orig) => {
  const real = await orig<typeof import("../org-posts")>();
  return {
    ...real,
    draftPostsForDecidedFixture: vi.fn(async (...args: Parameters<typeof real.draftPostsForDecidedFixture>) => {
      inject.drafted.push(args[1]);
      return real.draftPostsForDecidedFixture(...args);
    }),
  };
});
vi.mock("@/lib/cache", async (orig) => {
  const real = await orig<typeof import("@/lib/cache")>();
  return {
    ...real,
    cacheSet: async (...args: Parameters<typeof real.cacheSet>) => {
      inject.cacheSets.push({ key: args[0], value: args[1] });
      return real.cacheSet(...args);
    },
  };
});
vi.mock("../stages", async (orig) => {
  const real = await orig<typeof import("../stages")>();
  return {
    ...real,
    markDependentSeedProposalsStale: vi.fn(async (...args: Parameters<typeof real.markDependentSeedProposalsStale>) => {
      if (inject.failStaleMark > 0) {
        inject.failStaleMark--;
        inject.fired++;
        throw new Error("Connection terminated unexpectedly");
      }
      const out = await real.markDependentSeedProposalsStale(...args);
      if (inject.trapReadyAfterStaleMark) {
        inject.trapReadyAfterStaleMark = false;
        inject.trapReady = true;
      }
      return out;
    }),
  };
});
vi.mock("@/server/engine-db/recorded-abandon", async (orig) => {
  const real = await orig<typeof import("@/server/engine-db/recorded-abandon")>();
  return {
    ...real,
    // A plain function, NOT vi.fn: a vitest spy calls `.then` on a thenable it returns (to record the settled result), and a
    // postgres.js fragment is a thenable query, so a spied fragment is sent on its own and the server refuses it.
    hasActiveAbandonSql: (...args: Parameters<typeof real.hasActiveAbandonSql>) => {
      if (inject.trapReady && args[1] === "fixtures" && args[2]?.expunge === true) {
        inject.trapReady = false;
        inject.fired++;
        throw new Error("Connection terminated unexpectedly");
      }
      return real.hasActiveAbandonSql(...args);
    },
  };
});
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
  inject.failDiscipline = 0;
  inject.failStaleMark = 0;
  inject.trapReadyAfterStaleMark = false;
  inject.trapReady = false;
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

type Logged = { event?: string; fixtureId?: string; stageId?: string; divisionId?: string };
const logged = (spy: { mock: { calls: unknown[][] } }, event: string) =>
  spy.mock.calls.map((c) => c[0] as Logged).filter((o) => o?.event === event);
const refoldFailures = (spy: { mock: { calls: unknown[][] } }) =>
  logged(spy, "standings_recompute_failed").map((o) => ({ fixtureId: o.fixtureId, stageId: o.stageId }));

/** Run `act` (which arms a one-shot failure), and pin that the failure fired exactly once inside it. */
async function firesOnce<T>(act: () => Promise<T>): Promise<T> {
  const before = inject.fired;
  const out = await act();
  expect(inject.fired - before, "premise: the injected failure fired, once").toBe(1);
  return out;
}
const resultOf = async (fixtureId: string) =>
  (await sql<{ id: string }[]>`select id from score_events where fixture_id = ${fixtureId} and type = 'generic.result' order by seq desc limit 1`)[0]!.id;

describe.skipIf(!HAS_DB)("post-commit hooks that fail after the score committed", () => {
  it("a failed refold: answered and logged; mid-stage the table stays stale until the next refold, on the last result auto-advance heals it", async () => {
    const r = await rig();
    const [f1, f2, f3] = r.fixtures as [string, string, string];
    const errors = vi.spyOn(log, "error");
    await win(r.auth, f1);
    expect((await state(r, f1)).played, "premise: one result folded, one played match a side (two)").toBe(2);

    // 1. a result that does NOT finish the stage, its refold failing: answered as written, logged, the stored table stale
    const out = await firesOnce(() => win(r.auth, f2, () => inject.failNext.set(r.leagueId, 1)));
    expect(out.status, "scoreEvent answers the committed result").toBe("decided");
    expect(refoldFailures(errors), "the failure is logged by name, with the fixture and the stage").toEqual([{ fixtureId: f2, stageId: r.leagueId }]);
    expect(await state(r, f2), "the result stands, the stored table is the stale one (f1 only), nothing advanced").toEqual({
      fixture: "decided",
      played: 2,
      autoAdvanced: 0,
      koSeated: 0,
      league: "active",
    });

    // 2. a void of that result, its refold failing too: answered, logged again, the fixture reopened
    const res2 = await resultOf(f2);
    const voided = await firesOnce(() => {
      inject.failNext.set(r.leagueId, 1);
      return post(r.auth, f2, "core.void", { event_id: res2 });
    });
    expect(voided.outcome, "the void is answered: the result is gone").toBeNull();
    expect(refoldFailures(errors), "logged again, for the same fixture").toEqual([
      { fixtureId: f2, stageId: r.leagueId },
      { fixtureId: f2, stageId: r.leagueId },
    ]);
    const afterVoid = await state(r, f2);
    expect(afterVoid.fixture, "the fixture is no longer decided").not.toBe("decided");
    expect([afterVoid.autoAdvanced, afterVoid.koSeated, afterVoid.league], "nothing advanced").toEqual([0, 0, "active"]);

    // 3. the same fixture scored again, its refold the real one: the table catches up (two results, four played)
    expect((await win(r.auth, f2)).status).toBe("decided");
    expect((await state(r, f2)).played, "the next refold brings the stored table up to date").toBe(4);

    // 4. the LAST result, its refold failing: answered and logged, and auto-advance (the stage just finished) completes the
    //    stage, which ranks it afresh from its fixtures: the stored table is healed (three results, six played) and the
    //    knockout is seated, in this same request
    const last = await firesOnce(() => win(r.auth, f3, () => inject.failNext.set(r.leagueId, 1)));
    expect(last.status).toBe("decided");
    expect(refoldFailures(errors), "the last result's failure is logged too").toEqual([
      { fixtureId: f2, stageId: r.leagueId },
      { fixtureId: f2, stageId: r.leagueId },
      { fixtureId: f3, stageId: r.leagueId },
    ]);
    expect(await state(r, f3), "healed: the completed table, and the advance auto_progress asks for").toEqual({
      fixture: "decided",
      played: 6,
      autoAdvanced: 1,
      koSeated: 2,
      league: "complete",
    });
  }, 120_000);

  it("a failed staleness mark of the dependent seed proposals: answered and logged, and the hooks after it still run", async () => {
    const r = await rig();
    const [f1, f2, f3] = r.fixtures as [string, string, string];
    const errors = vi.spyOn(log, "error");
    await win(r.auth, f1);
    await win(r.auth, f2);
    const out = await firesOnce(() => win(r.auth, f3, () => (inject.failStaleMark = 1)));
    expect(out.status, "scoreEvent answers the committed result").toBe("decided");
    expect(
      logged(errors, "seed_proposals_stale_mark_failed").map((o) => ({ fixtureId: o.fixtureId, stageId: o.stageId })),
      "the failure is logged by name, with the fixture and the stage",
    ).toEqual([{ fixtureId: f3, stageId: r.leagueId }]);
    expect(await state(r, f3), "the refold before it stood, and auto-advance after it ran").toEqual({
      fixture: "decided",
      played: 6,
      autoAdvanced: 1,
      koSeated: 2,
      league: "complete",
    });
  }, 120_000);

  // Final fix wave (m5): the COMPLETED table's branch of the same hook (a correction inside a finished league or group,
  // `includeConfirmed`) logged without an `event:` tag, unlike its sibling above - an alert keyed on the tag never saw it.
  it("a failed staleness mark inside a COMPLETED table (a correction): answered and logged by name, with the fixture and the stage", async () => {
    const r = await rig();
    const [f1, f2, f3] = r.fixtures as [string, string, string];
    const errors = vi.spyOn(log, "error");
    await win(r.auth, f1);
    await win(r.auth, f2);
    await win(r.auth, f3);
    expect((await state(r, f3)).league, "premise: the league is complete, so the next write is a correction inside it").toBe("complete");
    const res3 = await resultOf(f3);
    const corrected = await firesOnce(() => {
      inject.failStaleMark = 1;
      return post(r.auth, f3, "core.void", { event_id: res3 });
    });
    expect(corrected.outcome, "the correction is answered: the result is gone").toBeNull();
    expect(
      logged(errors, "table_cut_drift_stale_failed").map((o) => ({ fixtureId: o.fixtureId, stageId: o.stageId })),
      "logged by name, with the fixture and the stage",
    ).toEqual([{ fixtureId: f3, stageId: r.leagueId }]);
    expect(logged(errors, "seed_proposals_stale_mark_failed"), "and not under the incomplete table's tag").toEqual([]);
  }, 120_000);

  it("a failed auto-advance readiness read: answered and logged, nothing advanced; the next result advances", async () => {
    const r = await rig();
    const [f1, f2, f3] = r.fixtures as [string, string, string];
    const errors = vi.spyOn(log, "error");
    await win(r.auth, f1);
    await win(r.auth, f2);
    const out = await firesOnce(() => win(r.auth, f3, () => (inject.trapReadyAfterStaleMark = true)));
    expect(out.status, "scoreEvent answers the committed result").toBe("decided");
    expect(
      logged(errors, "auto_advance_check_failed").map((o) => ({ stageId: o.stageId, divisionId: o.divisionId })),
      "the failure is logged by name, with the stage and the division",
    ).toEqual([{ stageId: r.leagueId, divisionId: r.divisionId }]);
    expect(await state(r, f3), "the refold stood; the stage did not advance").toEqual({
      fixture: "decided",
      played: 6,
      autoAdvanced: 0,
      koSeated: 0,
      league: "active",
    });

    // the sequence: the result voided and scored again, every hook real, and the stage advances
    const res3 = await resultOf(f3);
    expect((await post(r.auth, f3, "core.void", { event_id: res3 })).outcome).toBeNull();
    expect((await win(r.auth, f3)).status).toBe("decided");
    expect(logged(errors, "auto_advance_check_failed"), "no further failure logged").toHaveLength(1);
    expect(await state(r, f3)).toEqual({ fixture: "decided", played: 6, autoAdvanced: 1, koSeated: 2, league: "complete" });
  }, 120_000);

  it("a failed discipline refresh: answered and logged, the news draft and the idempotency cache still written; the next result folds", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtures as [string, string, string];
    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    // An enabled (empty) rule set, so refreshDiscipline folds whenever it runs (held-behaviours.test.ts's witness).
    await sql`
      insert into discipline_rules (org_id, division_id, enabled, rules)
      values (${r.auth.orgId}, ${r.divisionId}, true, ${sql.json({ accumulation: [], dismissal: [] })})`;
    const errors = vi.spyOn(log, "error");
    await post(r.auth, f1, "core.start");
    const key = randomUUID();
    const out = await firesOnce(async () => {
      inject.failDiscipline = 1;
      return scoreEvent(r.auth, f1, { expected_seq: await tip(f1), type: "generic.result", payload: { p1Score: 1, p2Score: 0 }, idempotency_key: key } as never);
    });
    expect(out.status, "scoreEvent answers the committed result").toBe("decided");
    expect(
      logged(errors, "discipline_refresh_failed").map((o) => o.fixtureId),
      "the failure is logged by name, with the fixture",
    ).toEqual([f1]);
    expect(inject.drafted.filter((id) => id === f1), "refreshNews still ran for the result").toEqual([f1]);
    expect(
      inject.cacheSets.filter((c) => (c.value as { event_id?: string } | null)?.event_id === out.event_id).length,
      "the idempotency cache still holds the answer",
    ).toBe(1);

    // the sequence: the next result, nothing armed, folds the discipline and logs nothing more
    const folds = inject.disciplineFolds;
    expect((await win(r.auth, f2)).status).toBe("decided");
    expect(inject.disciplineFolds - folds, "the next result's discipline fold ran").toBe(1);
    expect(logged(errors, "discipline_refresh_failed"), "no further failure logged").toHaveLength(1);
  }, 120_000);
});
