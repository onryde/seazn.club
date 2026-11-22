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
import { lotSeed, type StandingsRow } from "@seazn/engine/competition";
import { shuffle } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import { bestNthSourceOf } from "../pool-results";
import { sourcePoolKeys } from "../stage-seeding";
import { completeStage } from "../stages";
import { bestNthBasisNote } from "@/lib/bestnth-basis-note";
import { snakeSizes } from "@/lib/field-cut-gate";
import { getSeedProposal } from "../stages";
import { declaredCrossGroup, proposedBestNth, publicT, scene, type Meeting, type Scene } from "./_groups-ko-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

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
    const handed = await withTenant(s.auth.orgId, async (tx) => bestNthSourceOf(tx, s.srcId, await sourcePoolKeys(tx, s.srcId)));
    expect([...handed.results].map(([k, r]) => [k, r.length]).sort(), "each pool's counted results").toEqual([["A", 6], ["B", 6]]);
    const done = await completeStage(s.auth, s.srcId);
    expect(done.completed).toBe(true);
    const { bestNth, winners } = await proposedBestNth(s);
    expect(new Set(winners)).toEqual(new Set([A[0], B[0]]));
    expect(bestNth, "RB5-U6: equal pools compare full rows").toEqual([A[1]]);
  });

  it("X-UP-1 seam: a boardgame source (Sonneborn-Berger on the table) hands best-Nth only results its own game-points rule paid (same-load identity)", async () => {
    // The second sport: boardgame's round-robin cascade ranks by Sonneborn-Berger, so every pool row carries `metrics.sberger`
    // and each reduced row's SB is recomputed over the remaining results in the stage's game points (engine normalisedRow). Its
    // game-points reader is identity-keyed on the results ONE load of the stage paid (gamePointsReader): the results the source
    // hands best-Nth must come from that same load, or the recompute asks for a result the reader never paid (mutant M5).
    // What this proves is that identity, not the SB VALUE: every candidate's SB is 0 reduced AND unreduced (a 3-pool
    // runner-up's one win is over a bottom row that scored nothing), so a wrong SB number would not move the seats (Task 0
    // review m1). The recompute's value is the engine's own normalisedRow suite's to prove.
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
    const handed = await withTenant(s.auth.orgId, async (tx) => bestNthSourceOf(tx, s.srcId, await sourcePoolKeys(tx, s.srcId)));
    const results = [...handed.results.values()].flat();
    expect(results.length, "results handed").toBe(3 + 3 + 1 + 1);
    expect(handed.crossGroup.gamePoints, "the source's game-points rule is forwarded").toBeDefined();
    for (const r of results) expect(() => handed.crossGroup.gamePoints!(r)).not.toThrow();
    const { bestNth } = await proposedBestNth(s);
    // WHO qualifies is the source's cascade (RB5-U1, then its lots over the level runners-up; X-PD-8); WHERE the level three sit is
    // the knockout's own stored draw seed (ruling 281, W5 app PR B T5), so the seats are compared as a set.
    expect(new Set(bestNth), "RB5-U1, then the source's lots over the level runners-up").toEqual(new Set(drawOf(rngSeed, candidates).slice(0, 3)));
    expect(bestNth, "three seats").toHaveLength(3);
  });
});

describe.skipIf(!HAS_DB)("no app path reaches pool_results_missing or SEEDING_BESTNTH_UNEQUAL_POOLS (W5 app PR B Task 4, K19)", () => {
  it("X-UP-1 sweep: every groups_ko pool shape 2..4 pools x 2..5 per pool, setup and on_complete, seats its best runner-up; equal pools show no source footnote", async () => {
    // single-sport: the refusal is the builders' (results on every pool), not a sport's; generic decides every meeting 1-0 to the
    // higher seed. qualified = pools + 1: every pool's winner and the best runner-up (topNPerGroup 1 + bestNth nth 2 count 1).
    // Per pool count, the field runs 2 per pool (equal), 2 per pool + 1, 5 per pool - 1 (unequal) and 5 per pool (equal).
    // differential: drop the results on the on_complete builder (`tablesForCompletedStage`) and its leg is refused
    // SEEDING_POOL_RESULTS_MISSING (formerly swallowed silently, K19); on 9.x every unequal shape refused SEEDING_BESTNTH_UNEQUAL_POOLS
    // unless the take carried the flag.
    // Task 5 part 3 (owed item 1): the on_complete leg draws across the pools too, so RB5-D10 (X-PD-4, owner 288) refuses it by
    // name whenever the best runner-up must meet her own pool's winner (the winners keep their places, the runner-up has one seat).
    // That refusal comes AFTER the resolver seated the field from results on every pool, so it still proves this sweep's seam; it is
    // read by its own rule (one pool supplying two of poolCount + 1 seats in a single_elim) and counted, never excused silently.
    const t = publicT("en");
    let checked = 0, unequal = 0, footnotes = 0, seededOnComplete = 0, refusedOnComplete = 0;
    for (const poolCount of [2, 3, 4]) {
      for (const entrants of [2 * poolCount, 2 * poolCount + 1, 5 * poolCount - 1, 5 * poolCount]) {
        const sizes = snakeSizes(entrants, poolCount);
        const isUnequal = new Set(sizes).size > 1;
        for (const timing of ["setup", "on_complete"] as const) {
          const label = `${entrants} into ${poolCount} (${sizes.join("/")}) ${timing}`;
          const plan = (size: number): Meeting[] =>
            Array.from({ length: size }, (_, w) => Array.from({ length: size - w - 1 }, (_, i): Meeting => ({ w, l: w + i + 1, score: [1, 0] }))).flat();
          const s: Scene = await scene({ sport: "generic", entrants, poolCount, qualified: poolCount + 1, timing, plan });
          expect(s.pools.map((p) => p.members.length), label).toEqual(sizes);
          let done;
          try {
            done = await completeStage(s.auth, s.srcId);
          } catch (e) {
            const err = e as { code?: string; extra?: { cause?: string; entrants?: number; count?: number; shape?: string } };
            if (timing === "on_complete" && err.code === "STAGE_COMPLETED_SEEDING_FAILED" && err.extra?.cause === "SEEDING_POOL_SEPARATION_IMPOSSIBLE") {
              expect({ entrants: err.extra.entrants, count: err.extra.count, shape: err.extra.shape }, `${label}: RB5-D10's own shape`).toEqual({ entrants: poolCount + 1, count: 2, shape: "single_elim" });
              const [src] = await sql<{ status: string }[]>`select status from stages where id = ${s.srcId}`;
              expect(src!.status, `${label}: the completion stands`).toBe("complete");
              refusedOnComplete++;
              checked++;
              if (isUnequal) unequal++;
              continue;
            }
            throw new Error(`${label}: refused ${err.code} (cause ${err.extra?.cause}): ${String(e)}`);
          }
          expect(done.completed, label).toBe(true);
          if (timing === "on_complete") {
            expect(done.qualified?.entrants, `${label}: the knockout was seeded`).toHaveLength(poolCount + 1);
            seededOnComplete++;
          } else {
            const proposal = await getSeedProposal(s.auth, s.koId);
            expect(proposal?.status, label).toBe("draft");
            const best = proposal!.computed.qualifiers.filter((q) => q.basis !== undefined);
            expect(best, `${label}: one best runner-up, its basis stored`).toHaveLength(1);
            const basis = best[0]!.basis!;
            expect(basis.nth, label).toBe(2);
            // RB5-U1: each larger pool drops its bottom (size - smallest) rows; equal pools drop nothing (RB5-U6).
            const smallest = Math.min(...sizes);
            const expectDropped = s.pools
              .filter((p) => p.members.length > smallest)
              .map((p) => ({ pool: p.key, against: p.members.slice(smallest) }));
            const byPool = (a: { pool: string }, b: { pool: string }) => a.pool.localeCompare(b.pool);
            expect([...basis.dropped].sort(byPool), label).toEqual(expectDropped);
            const rows = (await sql<{ pool_key: string; rows: StandingsRow[] }[]>`
              select p.key as pool_key, ss.rows from standings_snapshots ss join pools p on p.id = ss.pool_id where ss.stage_id = ${s.srcId}`);
            const note = bestNthBasisNote(basis, rows.map((r) => ({ key: r.pool_key, rows: r.rows })), {}, new Set(), t, "en");
            expect(note === null, `${label}: a footnote exactly when the pools are unequal`).toBe(!isUnequal);
            if (note !== null) footnotes++;
          }
          checked++;
          if (isUnequal) unequal++;
        }
      }
    }
    expect(checked, "anti-vacuity: every shape on both paths").toBe(3 * 4 * 2);
    expect(unequal, "the sweep saw unequal shapes").toBe(3 * 2 * 2);
    expect(footnotes, "an unequal setup shape shows its footnote").toBe(3 * 2);
    // anti-vacuity on the on_complete leg: every leg is one or the other, and each kind was met.
    expect(seededOnComplete + refusedOnComplete, "every on_complete leg judged").toBe(3 * 4);
    expect(seededOnComplete, "on_complete legs seeded").toBeGreaterThan(0);
    expect(refusedOnComplete, "on_complete legs refused by RB5-D10").toBeGreaterThan(0);
    console.log(`X-UP-1 sweep: on_complete seeded ${seededOnComplete}, refused by RB5-D10 ${refusedOnComplete}`);
  }, 240_000);
});
