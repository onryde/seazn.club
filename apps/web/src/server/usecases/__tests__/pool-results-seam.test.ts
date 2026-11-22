// W5 app PR B Task 0 (G4; ST-G3 seam, app PR A's former Task 11b; X-UP-1, X-UP-5): pool `results` reach best-Nth on BOTH seeding
// paths. Since engine 10 (ruling 286) best-Nth across unequal pools is always normalised: each candidate of a larger pool is
// compared without its results against its pool's bottom k = size - min (RB5-U1, ruling 280), and a larger pool that hands no
// results is refused, STAGE_NOT_READY `pool_results_missing`. App PR A passed none, so the bump alone refuses every unequal
// groups_ko; on 9.x the same tables resolved on the raw rows (progression.ts:655). The bump and this wiring land together.
//
// Every scene runs the REAL producers: real stages from the groups_ko template, a real pool draw, real results through the
// scorer's door (`scoreEvent`), the real completion, then the setup path's proposal (`completeStage` -> `computeSeedProposal` ->
// `sourcesToTables`) or the on_complete path's seed (`completeStage` -> `seedNextStage` -> `tablesForCompletedStage`).
// Expected seats come from the rulebook (RB5-U1's comparison on the smallest pool's matches, RB5-U6's equal pools) and the
// engine's declarations (the sport's cross-group order, `defaultCrossGroup`; the lots draw, `shuffle(lotSeed(...))`), never from
// the resolver. Each scene's results are chosen so the right answer differs from the raw-row answer 9.x gave.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { defaultCrossGroup, lotSeed, type StandingsRow } from "@seazn/engine/competition";
import { shuffle } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { bestNthSourceOf } from "../pool-results";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures, getSeedProposal } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Sport = "generic" | "boardgame";
/** One meeting inside a pool, by the members' places in seed order (0 = the pool's top seed): `w` beats `l`, `score` for generic. */
type Meeting = { w: number; l: number; score?: readonly [number, number] };

interface Scene {
  auth: AuthCtx;
  srcId: string;
  koId: string;
  /** The pools by key, each member list in seed order. */
  pools: { key: string; members: string[] }[];
}

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** A groups_ko division built by the template, its group stage drawn, every meeting decided as `plan` says (by the pool's size). */
async function scene(o: {
  sport: Sport;
  entrants: number;
  poolCount: number;
  qualified: number;
  timing: "setup" | "on_complete";
  plan: (size: number) => readonly Meeting[];
  rngSeed?: (pools: Scene["pools"]) => number;
}): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "PR " + o.sport, visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = ${o.sport} and is_system order by key limit 1`;
  expect(variant, `${o.sport} has a system variant`).toBeDefined();
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: o.sport, variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: o.entrants }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const drafts = buildTemplateStages("groups_ko", { qualified: o.qualified, poolCount: o.poolCount, swissRounds: 3, legs: 1 });
  const stages = await createStages(
    auth,
    div.id,
    drafts.map((d, i) => ({
      seq: i + 1,
      kind: d.kind,
      name: d.name,
      config: d.config,
      progression: d.progression === null ? null : { ...d.progression, timing: o.timing },
    })) as never,
  );
  const src = stages.find((s) => s.seq === 1)!;
  const ko = stages.find((s) => s.seq === 2)!;
  // The setup path proposes INTO the knockout's TBD lines, so they exist first; the on_complete path seeds before any draw.
  if (o.timing === "setup") await generateStageFixtures(auth, ko.id);
  await generateStageFixtures(auth, src.id);
  await startDivision(auth, div.id);

  const seeds = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed]));
  const poolRows = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${src.id} order by key`;
  const fx = await sql<{ id: string; pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${src.id}`;
  const pools = poolRows.map((p) => ({
    key: p.key,
    members: [...new Set(fx.filter((f) => f.pool_id === p.id).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].sort((a, b) => seeds.get(a)! - seeds.get(b)!),
  }));
  if (o.rngSeed) await sql`update stages set config = config || ${sql.json({ rngSeed: o.rngSeed(pools) } as never)} where id = ${src.id}`;

  let decided = 0;
  for (const p of pools) {
    const meetings = o.plan(p.members.length);
    // A full round robin: every pair of the pool meets once (legs 1), and the plan names each pair exactly once.
    expect(meetings.length, `pool ${p.key}: the plan decides every meeting`).toBe((p.members.length * (p.members.length - 1)) / 2);
    for (const m of meetings) {
      const winner = p.members[m.w]!;
      const loser = p.members[m.l]!;
      const f = fx.find((x) => (x.home_entrant_id === winner && x.away_entrant_id === loser) || (x.home_entrant_id === loser && x.away_entrant_id === winner));
      expect(f, `pool ${p.key}: ${m.w} v ${m.l} is a fixture`).toBeDefined();
      await post(auth, f!.id, "core.start");
      if (o.sport === "boardgame") {
        await post(auth, f!.id, "boardgame.result", { winner, method: "resign" });
      } else {
        const [ws, ls] = m.score!;
        await post(auth, f!.id, "generic.result", f!.home_entrant_id === winner ? { p1Score: ws, p2Score: ls } : { p1Score: ls, p2Score: ws });
      }
      decided++;
    }
  }
  expect(decided, "meetings decided").toBe(fx.length);
  return { auth, srcId: src.id, koId: ko.id, pools };
}

/** The proposal's best-Nth seats, in seed order: the qualifiers read from no group (a `best_nth` descriptor names none). */
async function proposedBestNth(s: Scene): Promise<{ bestNth: string[]; winners: string[] }> {
  const proposal = await getSeedProposal(s.auth, s.koId);
  expect(proposal?.status, "the completion proposed the knockout").toBe("draft");
  const q = [...proposal!.computed.qualifiers].sort((a, b) => a.rank - b.rank);
  return { bestNth: q.filter((x) => x.source.group === undefined).map((x) => x.entrantId), winners: q.filter((x) => x.source.group !== undefined).map((x) => x.entrantId) };
}

const variantConfig = async (sport: Sport) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from sport_variants where sport_key = ${sport} and is_system order by key limit 1`)[0]!.config;
/** The sport's declared cross-group order (engine `defaultCrossGroup` over its group cascade): the comparison's keys. */
const declaredCrossGroup = async (sport: Sport) =>
  defaultCrossGroup(builtinModules.find((m) => m.key === sport)!.defaultTiebreakers("group", (await variantConfig(sport)) as never));

// 10 entrants into 4 pools draw 3/3/2/2; groups_ko with 7 qualifiers takes every pool's winner and the best 3 of the 4 runners-up
// (topNPerGroup 1 + bestNth nth 2 count 3, format-templates.ts). Within a pool, place 0 is the top seed.
//   3-pools: 0 beats 1 and 2; 1 beats 2. The first 3-pool's runner-up beats its bottom 5-0, the second's 4-0, and they lose to
//            their winner 0-2 and 0-3.   2-pools: 0 beats 1, 3-2 in the first, 2-1 in the second.
// RB5-U1: k = 1 for the 3-pools, 0 for the 2-pools, so each 3-pool runner-up is compared without its result against its bottom
// row. Generic's cross-group order is points, diff, for, lots (asserted below, from the engine):
//   A2 0 pts, diff -2, for 0 | B2 0, -3, 0 | C2 0, -1, 2 | D2 0, -1, 1  ->  C2, D2, A2 seat; B2 is out.
// On the raw rows (9.x, no results): A2 3 pts +3, B2 3 pts +1 above C2 and D2 -> A2, B2, C2 seat and D2 is out.
// The second 3-pool's scores differ from the first's (its runner-up loses 0-3 and wins 4-0), and the second 2-pool's from the first's.
const unequalGenericPlan = () => {
  let threes = 0;
  let twos = 0;
  return (size: number): Meeting[] => {
    if (size === 3) {
      const first = threes++ === 0;
      return [{ w: 0, l: 1, score: first ? [2, 0] : [3, 0] }, { w: 0, l: 2, score: [2, 0] }, { w: 1, l: 2, score: first ? [5, 0] : [4, 0] }];
    }
    const first = twos++ === 0;
    return [{ w: 0, l: 1, score: first ? [3, 2] : [2, 1] }];
  };
};

/** The scene's premises: 3/3/2/2 in key order, and generic's cross-group order is the one the expected seats were derived on. */
async function unequalPremises(s: Scene): Promise<{ A: string[]; B: string[]; C: string[]; D: string[] }> {
  expect(s.pools.map((p) => p.members.length), "10 into 4 pools draws 3/3/2/2").toEqual([3, 3, 2, 2]);
  expect(await declaredCrossGroup("generic"), "generic's declared cross-group order").toEqual(["points", "diff", "for", "lots"]);
  const [A, B, C, D] = s.pools.map((p) => p.members) as [string[], string[], string[], string[]];
  return { A, B, C, D };
}

describe.skipIf(!HAS_DB)("pool results reach best-Nth on both seeding paths (W5 app PR B Task 0, G4)", () => {
  it("X-UP-1 seam: an unequal groups_ko source passes pool results on the setup path", async () => {
    // single-sport: the seam is the app's table builder, and generic's for/against ledger makes the dropped result visible on
    // every key; the boardgame scene below is the second sport (Sonneborn-Berger on the table).
    const s = await scene({ sport: "generic", entrants: 10, poolCount: 4, qualified: 7, timing: "setup", plan: unequalGenericPlan() });
    const { A, B, C, D } = await unequalPremises(s);
    // differential: with the bump alone, STAGE_NOT_READY pool_results_missing (app PR A passes none) and the completion answers
    // STAGE_COMPLETED_SEEDING_FAILED; on 9.x the raw rows seated A2, B2, C2 (progression.ts:655).
    const done = await completeStage(s.auth, s.srcId);
    expect(done.completed).toBe(true);
    const { bestNth, winners } = await proposedBestNth(s);
    expect(new Set(winners), "every pool's winner").toEqual(new Set([A[0], B[0], C[0], D[0]]));
    expect(bestNth, "RB5-U1: the runners-up compared on the smallest pool's matches").toEqual([C[1], D[1], A[1]]);
    expect(bestNth, "the raw-row answer is not the one seated").not.toEqual([A[1], B[1], C[1]]);
  });

  it("X-UP-1 seam: an unequal groups_ko source passes pool results on the on_complete path", async () => {
    // single-sport: the same seam on the other builder (`tablesForCompletedStage`); the sport sweep is the setup path's.
    const s = await scene({ sport: "generic", entrants: 10, poolCount: 4, qualified: 7, timing: "on_complete", plan: unequalGenericPlan() });
    const { A, B, C, D } = await unequalPremises(s);
    // differential: with the bump alone, seedNextStage's STAGE_NOT_READY pool_results_missing is swallowed by the completion's
    // best-effort catch and the knockout is never seeded; on 9.x the raw rows seated A2, B2, C2.
    const done = await completeStage(s.auth, s.srcId);
    expect(done.completed).toBe(true);
    expect(done.qualified?.stage_id, "the completion seeded the knockout").toBe(s.koId);
    const entrants = done.qualified!.entrants;
    expect(entrants, "7 qualifiers").toHaveLength(7);
    // rank_order over the take's pots: every pool's winner, then the best-Nth seats in the comparison's order.
    expect(new Set(entrants.slice(0, 4)), "every pool's winner").toEqual(new Set([A[0], B[0], C[0], D[0]]));
    expect(entrants.slice(4), "RB5-U1: the runners-up compared on the smallest pool's matches").toEqual([C[1], D[1], A[1]]);
    const [row] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${s.koId}`;
    expect(row!.config.qualified, "stored as the knockout's qualifiers").toEqual(entrants);
  });

  it("X-UP-5 equal pools drop nothing, with results present", async () => {
    // single-sport: the rule is the pools' sizes, not a sport's; generic's diff key shows a dropped result at once.
    // 8 entrants into 2 pools of 4; groups_ko with 3 qualifiers takes both winners and the better runner-up (bestNth nth 2 count 1).
    //   Pool A: 0 beats everyone 1-0; 1 beats 2 1-0 and 3 10-0; 2 beats 3 1-0.  A2: 6 pts, for 11, against 1, diff +10.
    //   Pool B: 0 beats everyone 1-0; 1 beats 2 3-0 and 3 1-0; 2 beats 3 1-0.   B2: 6 pts, for 4, against 1, diff +3.
    // RB5-U6: equal pools have k = 0, so nothing is dropped and A2 (+10) takes the seat. Were each pool's bottom row dropped,
    // A2 would read 3 pts, diff 0 and B2 3 pts, diff +2: B2 would take it (the mutant "drop a row of equal pools").
    let pool = 0;
    const plan = (): Meeting[] => {
      const first = pool++ === 0;
      return [
        { w: 0, l: 1, score: [1, 0] }, { w: 0, l: 2, score: [1, 0] }, { w: 0, l: 3, score: [1, 0] },
        { w: 1, l: 2, score: first ? [1, 0] : [3, 0] }, { w: 1, l: 3, score: first ? [10, 0] : [1, 0] }, { w: 2, l: 3, score: [1, 0] },
      ];
    };
    const s = await scene({ sport: "generic", entrants: 8, poolCount: 2, qualified: 3, timing: "setup", plan });
    expect(s.pools.map((p) => p.members.length), "8 into 2 pools draws 4/4").toEqual([4, 4]);
    expect(await declaredCrossGroup("generic"), "generic's declared cross-group order").toEqual(["points", "diff", "for", "lots"]);
    const [A, B] = s.pools.map((p) => p.members) as [string[], string[]];
    // The results ARE present: both pools hand the comparison their six results each.
    const handed = await withTenant(s.auth.orgId, (tx) => bestNthSourceOf(tx, s.srcId));
    expect([...handed.results].map(([k, r]) => [k, r.length]).sort(), "each pool's counted results").toEqual([["A", 6], ["B", 6]]);
    const done = await completeStage(s.auth, s.srcId);
    expect(done.completed).toBe(true);
    const { bestNth, winners } = await proposedBestNth(s);
    expect(new Set(winners)).toEqual(new Set([A[0], B[0]]));
    expect(bestNth, "RB5-U6: equal pools compare full rows").toEqual([A[1]]);
  });

  it("X-UP-1 seam: a boardgame source (Sonneborn-Berger on the table) recomputes a reduced row's SB from the results the same fold paid", async () => {
    // The second sport: boardgame's round-robin cascade ranks by Sonneborn-Berger, so every pool row carries `metrics.sberger`
    // and each reduced row's SB is recomputed over the remaining results in the stage's game points (engine normalisedRow). Its
    // game-points reader is identity-keyed on the results ONE load of the stage paid (gamePointsReader): the results the source
    // hands best-Nth must come from that same load, or the recompute asks for a result the reader never paid.
    // 3-pools: 0 beats 1 and 2, 1 beats 2. 2-pools: 0 beats 1. Compared without each 3-pool runner-up's win over its bottom row
    // (RB5-U1), every runner-up has 0 points, 0 wins and SB 0: level on every key before `lots`, so the source's stored rngSeed
    // draws the order (`shuffle(lotSeed(rngSeed, sorted ids), sorted ids)`, the engine's lots). The rngSeed is chosen so the
    // draw leaves out a 3-pool runner-up, whom the raw rows (one win each) would have seated.
    const drawOf = (seed: number, ids: readonly string[]) => {
      const sorted = [...ids].sort();
      return shuffle(lotSeed(seed, sorted), sorted);
    };
    let candidates: string[] = [];
    let rngSeed = 0;
    const s = await scene({
      sport: "boardgame",
      entrants: 10,
      poolCount: 4,
      qualified: 7,
      timing: "setup",
      plan: (size) => (size === 3 ? [{ w: 0, l: 1 }, { w: 0, l: 2 }, { w: 1, l: 2 }] : [{ w: 0, l: 1 }]),
      rngSeed: (pools) => {
        candidates = pools.map((p) => p.members[1]!);
        const threePoolRunnersUp = new Set(pools.filter((p) => p.members.length === 3).map((p) => p.members[1]!));
        rngSeed = Array.from({ length: 500 }, (_, i) => i + 1).find((x) => threePoolRunnersUp.has(drawOf(x, candidates)[3]!)) ?? 0;
        expect(rngSeed, "an rngSeed whose draw leaves a 3-pool runner-up out").toBeGreaterThan(0);
        return rngSeed;
      },
    });
    expect(s.pools.map((p) => p.members.length), "10 into 4 pools draws 3/3/2/2").toEqual([3, 3, 2, 2]);
    const order = await declaredCrossGroup("boardgame");
    expect(order, "boardgame's cross-group order reads SB and ends in lots").toEqual(expect.arrayContaining(["sberger", "lots"]));
    expect(order.at(-1)).toBe("lots");
    const done = await completeStage(s.auth, s.srcId);
    expect(done.completed).toBe(true);
    // Anti-vacuity: the stored rows carry SB, so the reduced rows' recompute ran.
    const rows = (await sql<{ rows: StandingsRow[] }[]>`select rows from standings_snapshots where stage_id = ${s.srcId}`).flatMap((r) => r.rows);
    expect(rows.length, "source rows").toBe(10);
    expect(rows.filter((r) => r.metrics["sberger"] !== undefined).length, "rows carrying Sonneborn-Berger").toBe(10);
    // Every result the source hands best-Nth is one its own game-points rule paid.
    const handed = await withTenant(s.auth.orgId, (tx) => bestNthSourceOf(tx, s.srcId));
    const results = [...handed.results.values()].flat();
    expect(results.length, "results handed").toBe(3 + 3 + 1 + 1);
    expect(handed.crossGroup.gamePoints, "the source's game-points rule is forwarded").toBeDefined();
    for (const r of results) expect(() => handed.crossGroup.gamePoints!(r)).not.toThrow();
    const { bestNth } = await proposedBestNth(s);
    expect(bestNth, "RB5-U1, then the source's lots over the level runners-up").toEqual(drawOf(rngSeed, candidates).slice(0, 3));
  });
});
