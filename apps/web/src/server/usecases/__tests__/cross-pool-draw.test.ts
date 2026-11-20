// W5 app PR B Task 5 (FX-G5; owner Q6, ruling 281; RB5-D1..D10; X-PD-1..7; F11; preflight K22, K23): a knockout-shaped stage fed
// from groups never pairs two entrants of one pool in round one, its level runs drawn with the destination's STORED draw seed.
//
// Every scene runs the REAL producers: real stages (`createStages`), a real snake draw into pools, real results through
// `scoreEvent`, the real completion that proposes the destination (`sourcesToTables -> resolveProgression -> computeSeedProposal`),
// the real confirm that fills the TBD lines. Expected seats come from the rulebook (RB5-D2's rotation, D6's byes) and the engine's
// own declarations (`seedPositions`, `shuffle`), never from the code under test. Results are chosen per scene: `decisive` leaves no
// two rows of different pools level on any key; `uniform` (every winner 1-0) leaves each place level across equal pools.
// single-sport (generic): its for/against ledger is what makes `decisive` decisive; the draw reads only pools and tiers.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { shuffle } from "@seazn/engine/core";
import { swissDrawSeed } from "@/lib/swiss-draw";
import { seedPositions, nextPowerOfTwo } from "@seazn/engine/scheduling";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal } from "../stages";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { buildTemplateStages } from "@/lib/format-templates";
import { post } from "./_groups-ko-scene";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Score = (winnerSeed: number, loserSeed: number) => readonly [number, number];
/** Every winner by a margin her own seed sets: no two entrants of different pools end level on points, diff and for. */
const decisive: Score = (w) => [20 - w, 0];
/** Every winner 1-0: the same place of equal pools ends level on every key, and on played. */
const uniform: Score = () => [1, 0];

interface Built {
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  divId: string;
  srcId: string;
  koId: string;
  poolOf: Map<string, string>;
  seedOf: Map<string, number>;
}

/** A generic division: `entrants` seeded 1..n, a group of `pools` pools (or a league), then the destination `kind` fed from it
 *  (`take`, rank_order, setup timing: its TBD lines exist before the source is played). The source is played out with `score`
 *  (the lower seed wins every meeting) but NOT completed. */
async function build(o: { entrants: number; pools: number | "league"; kind: string; take: unknown[]; score: Score; timing?: "setup" | "on_complete" }): Promise<Built> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "XPD", visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: o.entrants }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const source = o.pools === "league" ? { kind: "league", config: { legs: 1 } } : { kind: "group", config: { legs: 1, pools: { count: o.pools } } };
  const [src, ko] = await createStages(auth, div.id, [
    { seq: 1, ...source, name: "Groups" },
    { seq: 2, kind: o.kind, name: "Finals", config: o.kind === "knockout" ? { thirdPlace: false } : {}, progression: { sources: [{ stage: "previous", take: o.take }], placement: "rank_order", timing: o.timing ?? "setup" } },
  ] as never);
  // An on_complete destination has no lines until its source completes: `seedNextStage` writes `config.qualified`, then completion
  // generates it.
  if ((o.timing ?? "setup") === "setup") await generateStageFixtures(auth, ko!.id);
  await generateStageFixtures(auth, src!.id);
  await startDivision(auth, div.id);
  const seedOf = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed]));
  const fx = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string; key: string | null }[]>`
    select f.id, f.home_entrant_id, f.away_entrant_id, p.key from fixtures f left join pools p on p.id = f.pool_id where f.stage_id = ${src!.id}`;
  expect(fx.length, "the source has lines").toBeGreaterThan(0);
  const poolOf = new Map<string, string>();
  for (const f of fx) {
    poolOf.set(f.home_entrant_id, f.key ?? "");
    poolOf.set(f.away_entrant_id, f.key ?? "");
    await post(auth, f.id, "core.start");
    const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
    const [ws, ls] = o.score(Math.min(seedOf.get(f.home_entrant_id)!, seedOf.get(f.away_entrant_id)!), Math.max(seedOf.get(f.home_entrant_id)!, seedOf.get(f.away_entrant_id)!));
    await post(auth, f.id, "generic.result", homeWins ? { p1Score: ws, p2Score: ls } : { p1Score: ls, p2Score: ws });
  }
  return { auth, divId: div.id, srcId: src!.id, koId: ko!.id, poolOf, seedOf };
}

/** The draft's seats in seed order (rank 1 first). */
async function seats(b: Built): Promise<string[]> {
  const p = await getSeedProposal(b.auth, b.koId);
  expect(p?.status, "a live draft").toBe("draft");
  return [...p!.computed.qualifiers].sort((x, y) => x.rank - y.rank).map((q) => q.entrantId);
}

/** Round one of the filled bracket: its real pairs (both sides seated) and its bye lines' entrants. */
async function roundOne(b: Built): Promise<{ pairs: [string, string][]; byes: string[] }> {
  const rows = await sql<{ home: string | null; away: string | null; round_no: number }[]>`
    select home_entrant_id as home, away_entrant_id as away, round_no from fixtures where stage_id = ${b.koId} order by round_no, seq_in_round`;
  const first = Math.min(...rows.map((r) => r.round_no));
  const r1 = rows.filter((r) => r.round_no === first);
  return {
    pairs: r1.filter((r) => r.home !== null && r.away !== null).map((r) => [r.home!, r.away!]),
    byes: r1.filter((r) => (r.home === null) !== (r.away === null)).map((r) => (r.home ?? r.away)!),
  };
}

const label = (b: Built, id: string) => `${b.poolOf.get(id)}${b.seedOf.get(id)}`;

describe.skipIf(!HAS_DB)("FX-G5 groups feed a knockout with no pool-mates in round one (ruling 281)", () => {
  it("X-PD-1 three pools top two: no pool-mates in round one; byes to the pool winners (X-PD-6)", async () => {
    const b = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    expect((await completeStage(b.auth, b.srcId)).completed).toBe(true);
    const order = await seats(b);
    expect(order).toHaveLength(6);
    // differential: today's seats (the fold - rank, then pool: A1, B1, C1, A2, B2, C2) on the engine's own bracket geometry pair
    // C1 with C2.
    const drafted = (await getSeedProposal(b.auth, b.koId))!.computed.qualifiers;
    const fold = [...drafted].sort((x, y) => x.source.rank - y.source.rank || (x.pool ?? "").localeCompare(y.pool ?? "")).map((q) => q.entrantId);
    const pos = seedPositions(nextPowerOfTwo(6));
    const foldPairs: [string, string][] = [];
    for (let i = 0; i < pos.length; i += 2) if (pos[i]! <= 6 && pos[i + 1]! <= 6) foldPairs.push([fold[pos[i]! - 1]!, fold[pos[i + 1]! - 1]!]);
    expect(foldPairs.some(([x, y]) => b.poolOf.get(x) === b.poolOf.get(y)), "the premise: the fold seats a same-pool pair").toBe(true);

    const proposal = await getSeedProposal(b.auth, b.koId);
    expect(proposal!.computed.crossPoolDraw?.seed, "the draw seed is stored on the proposal").toEqual(expect.any(Number));
    await confirmSeedProposal(b.auth, b.koId, { proposalId: proposal!.id });
    const r1 = await roundOne(b);
    expect(r1.pairs, "6 into 8: two real round-one matches").toHaveLength(2);
    for (const [x, y] of r1.pairs) expect(b.poolOf.get(x), `${label(b, x)} v ${label(b, y)}`).not.toBe(b.poolOf.get(y));
    // RB5-D6: the two byes go to the top qualifiers - two of the three pool winners (seeds 1, 2 of the draw).
    expect(r1.byes.map((id) => b.seedOf.get(id)).sort(), "byes to the top seeds").toEqual([1, 2]);
  });

  it("X-PD-2 two pools top two: rank then rotation - A1 v B2, B1 v A2 (pin; the fold already gives it)", async () => {
    const b = await build({ entrants: 8, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    await completeStage(b.auth, b.srcId);
    const proposal = await getSeedProposal(b.auth, b.koId);
    await confirmSeedProposal(b.auth, b.koId, { proposalId: proposal!.id });
    const { pairs } = await roundOne(b);
    // snake 8 into 2: A = 1,4,5,8; B = 2,3,6,7 - A1 = seed 1, A2 = 4, B1 = 2, B2 = 3
    expect(pairs.map((p) => p.map((id) => b.seedOf.get(id)).sort((x, y) => x! - y!))).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it("X-PD-3 a rank tie across pools (group_rank tier) is drawn with the STORED seed; the same seed reproduces it", async () => {
    // uniform: A1 and B1 are level on every key and played (3 x 1-0), so are A2 and B2. The tier-1 run is shuffled with the seed.
    const b = await build({ entrants: 8, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: uniform });
    await completeStage(b.auth, b.srcId);
    const first = await getSeedProposal(b.auth, b.koId);
    const stored = first!.computed.crossPoolDraw!.seed;
    const winners = first!.computed.qualifiers.filter((q) => q.source.rank === 1).map((q) => q.entrantId);
    const run = [...winners].sort((x, y) => b.seedOf.get(x)! - b.seedOf.get(y)!); // pool order: A1 (seed 1), B1 (seed 2)
    const expectedTop = (seed: number) => shuffle(seed, run.map((entrantId) => ({ entrantId }))).map((s) => s.entrantId);
    expect((await seats(b)).slice(0, 2), "the stored seed's shuffle of the winners").toEqual(expectedTop(stored));
    // a second stored seed whose shuffle of the run differs
    let other = stored;
    for (let s = 1; s < 1000 && other === stored; s++) if (expectedTop(s)[0] !== expectedTop(stored)[0]) other = s;
    expect(other, "a seed whose shuffle differs").not.toBe(stored);
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{crossPoolDraw,seed}', ${other}::text::jsonb) where id = ${first!.id}`;
    await computeSeedProposal(b.auth, b.koId);
    expect((await seats(b)).slice(0, 2), "re-proposed with the other stored seed").toEqual(expectedTop(other));
    // Recompute (Rebuild's re-proposal) reads the stored seed back: the same draw.
    const again = await computeSeedProposal(b.auth, b.koId);
    expect(again.computed.crossPoolDraw?.seed).toBe(other);
    expect((await seats(b)).slice(0, 2), "reproduced").toEqual(expectedTop(other));
  });

  it("X-PD-3 with no tie the seed changes nothing (the engine's step-1 identity)", async () => {
    const b = await build({ entrants: 8, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    await completeStage(b.auth, b.srcId);
    const first = await getSeedProposal(b.auth, b.koId);
    const before = await seats(b);
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{crossPoolDraw,seed}', ${first!.computed.crossPoolDraw!.seed + 1}::text::jsonb) where id = ${first!.id}`;
    await computeSeedProposal(b.auth, b.koId);
    expect(await seats(b)).toEqual(before);
    expect(before.map((id) => b.seedOf.get(id)), "rank, then pool order: A1, B1, A2, B2").toEqual([1, 2, 4, 3]);
  });

  it("X-PD-3 a best-Nth tier tie (basis.levelWith) is drawn with the stored seed", async () => {
    // 9 into 3 (3/3/3), the winners and the best 2 runners-up. uniform: every runner-up is level (1 win 1-0, 1 loss 0-1), so the
    // engine's best-Nth ranking names them level (levelWith) and its own cross-group order picks two; those two are tied.
    const b = await build({ entrants: 9, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 2 }], score: uniform });
    await completeStage(b.auth, b.srcId);
    const first = await getSeedProposal(b.auth, b.koId);
    const best = first!.computed.qualifiers.filter((q) => q.basis !== undefined).sort((x, y) => x.rank - y.rank);
    expect(best, "two best runners-up").toHaveLength(2);
    expect(best[1]!.basis!.levelWith, "the premise: the engine left them level").toContain(best[0]!.entrantId);
    const stored = first!.computed.crossPoolDraw!.seed;
    // The tier-2 run in the resolver's order (rank_order: best-Nth position), as the engine received it.
    const resolverRun = [...best].sort((x, y) => b.seedOf.get(x.entrantId)! - b.seedOf.get(y.entrantId)!).map((q) => q.entrantId);
    const expected = (seed: number) => shuffle(seed, resolverRun.map((entrantId) => ({ entrantId }))).map((s) => s.entrantId);
    const tier2 = async () => (await seats(b)).slice(3);
    const drawn = await tier2();
    expect(new Set(drawn)).toEqual(new Set(resolverRun));
    let other = stored;
    for (let s = 1; s < 1000 && other === stored; s++) if (expected(s)[0] !== expected(stored)[0]) other = s;
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{crossPoolDraw,seed}', ${other}::text::jsonb) where id = ${first!.id}`;
    await computeSeedProposal(b.auth, b.koId);
    const redrawn = await tier2();
    expect(redrawn, "another stored seed, another order of the level pair").not.toEqual(drawn);
    expect(new Set(redrawn)).toEqual(new Set(drawn));
  });

  it("X-PD-4 an impossible separation is refused by name at confirm: a page playoff of three winners and Group C's runner-up", async () => {
    // 9 into 3: A = 1,6,7; B = 2,5,8; C = 3,4,9. decisive: C2 (seed 4) is the best runner-up (diff -1 v B2's -3, A2's -5).
    // Page pairs (1,2) and (3,4): C1 v C2 - tier 1 holds its places and tier 2 has one seat, so no ordering separates them.
    const b = await build({ entrants: 9, pools: 3, kind: "page_playoff", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }], score: decisive });
    expect((await completeStage(b.auth, b.srcId)).completed).toBe(true);
    const draft = await getSeedProposal(b.auth, b.koId);
    // the draft stays (the source's Standings read its basis); the draw's refusal rides it, by name, with its numbers
    expect(draft!.computed.crossPoolDraw?.refused).toEqual({ code: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", vars: { pool: "C", count: 2, entrants: 4, shape: "page_playoff" } });
    const err = await confirmSeedProposal(b.auth, b.koId, { proposalId: draft!.id }).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(err?.status, "never seated silently").toBe(422);
    expect(err?.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    expect(err?.extra).toEqual({ pool: "C", count: 2, entrants: 4, shape: "page_playoff" });
    const lines = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${b.koId} and (home_entrant_id is not null or away_entrant_id is not null)`;
    expect(lines[0]!.n, "nothing filled").toBe(0);
  });

  it("X-PD-7 a stepladder fed from GROUPS separates its first rung (today B2 v B3; drawn A2 v B3)", async () => {
    // 8 into 2: A = 1,4,5,8; B = 2,3,6,7. Every winner 1-0 except B3 (seed 6), who wins 11-0: B3 is the best third.
    const b = await build({ entrants: 8, pools: 2, kind: "stepladder", take: [{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 1 }], score: (w) => [w === 6 ? 11 : 1, 0] });
    await completeStage(b.auth, b.srcId);
    const order = await seats(b);
    expect(order).toHaveLength(5);
    const [x, y] = [order[3]!, order[4]!]; // the first rung: the last two seeds
    expect(b.seedOf.get(y), "the premise: B3 is the best third").toBe(6);
    expect(b.poolOf.get(x), `first rung ${label(b, x)} v ${label(b, y)}`).not.toBe(b.poolOf.get(y));
    // differential: the fold (A1, B1, A2, B2, B3) puts B2 on the rung with B3
    expect(b.seedOf.get(x), "A2 (seed 4) swapped onto the rung").toBe(4);
  });

  it("K23 a one-pool group never reaches the draw: seats as today, no draw seed stored", async () => {
    const b = await build({ entrants: 6, pools: 1, kind: "knockout", take: [{ kind: "rankRange", from: 1, to: 4 }], score: decisive });
    await completeStage(b.auth, b.srcId);
    const p = await getSeedProposal(b.auth, b.koId);
    expect(p!.computed.crossPoolDraw, "no cross-pool draw over one pool").toBeUndefined();
    expect((await seats(b)).map((id) => b.seedOf.get(id))).toEqual([1, 2, 3, 4]);
  });
});

describe.skipIf(!HAS_DB)("X-PD-7 a league-sourced stepladder / page playoff still seeds (N6)", () => {
  for (const template of ["group_stepladder", "group_playoffs"] as const) {
    it(`${template}: the league's finishing order, no draw, no refusal`, async () => {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "N6", visibility: "private", branding: {} });
      const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
        select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
      const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
      await createEntrants(auth, div.id, Array.from({ length: 6 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
      const drafts = buildTemplateStages(template, { qualified: 4, poolCount: 1, swissRounds: 3, legs: 1 });
      const stages = await createStages(auth, div.id, drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })) as never);
      const src = stages.find((s) => s.seq === 1)!;
      const dest = stages.find((s) => s.seq === 2)!;
      expect(src.kind, "the premise: a league source").toBe("league");
      await generateStageFixtures(auth, dest.id);
      await generateStageFixtures(auth, src.id);
      await startDivision(auth, div.id);
      const seedOf = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed]));
      for (const f of await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${src.id}`) {
        await post(auth, f.id, "core.start");
        const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
        await post(auth, f.id, "generic.result", homeWins ? { p1Score: 20 - seedOf.get(f.home_entrant_id)!, p2Score: 0 } : { p1Score: 0, p2Score: 20 - seedOf.get(f.away_entrant_id)! });
      }
      expect((await completeStage(auth, src.id)).completed).toBe(true);
      const p = await getSeedProposal(auth, dest.id);
      expect(p!.computed.crossPoolDraw, "no cross-pool draw: a league has no pools").toBeUndefined();
      // the league's finishing order (seed 1 wins everything, then 2, ...) seated rank 1..4 as today
      expect([...p!.computed.qualifiers].sort((x, y) => x.rank - y.rank).map((q) => seedOf.get(q.entrantId))).toEqual([1, 2, 3, 4]);
    });
  }
});

describe.skipIf(!HAS_DB)("F11 a draft made before the bump (Review Focus 4)", () => {
  it("X-PD a pre-bump unequal best-Nth draft is re-proposed on confirm", async () => {
    // 7 into 2 (A = 1,4,5; B = 2,3,6,7): the winners and the best runner-up, A2 (seed 4, every win 30-0) - B2 would meet B1 in round
    // one with no way out (RB5-D10: A1, B1 and B2 into a 4-draw is refused).
    const b = await build({ entrants: 7, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }], score: (w) => [w === 4 ? 30 : 1, 0] });
    await completeStage(b.auth, b.srcId);
    const draft = await getSeedProposal(b.auth, b.koId);
    // a 9.x draft: its best-Nth seat carried neither pool nor basis
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{qualifiers}',
      (select jsonb_agg(q - 'basis' - 'pool') from jsonb_array_elements(computed->'qualifiers') q)) where id = ${draft!.id}`;
    const err = await confirmSeedProposal(b.auth, b.koId, { proposalId: draft!.id }).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(err?.code, "never confirmed as drafted").toBe("SEEDING_PROPOSAL_STALE");
    const fresh = await getSeedProposal(b.auth, b.koId);
    expect(fresh!.id, "a new draft").not.toBe(draft!.id);
    expect(err?.extra?.reproposed).toBe(fresh!.id);
    expect(fresh!.computed.qualifiers.some((q) => q.basis !== undefined), "the new draft carries the basis").toBe(true);
    const [old] = await sql<{ status: string }[]>`select status from stage_seed_proposals where id = ${draft!.id}`;
    expect(old!.status).toBe("stale");
    expect((await confirmSeedProposal(b.auth, b.koId, { proposalId: fresh!.id })).filled).toBeGreaterThan(0);
  });

  it("X-PD a pre-bump top-two draft is confirmed as drafted", async () => {
    const b = await build({ entrants: 7, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    await completeStage(b.auth, b.srcId);
    const draft = await getSeedProposal(b.auth, b.koId);
    // a 9.x draft: no pool on any seat (and, top-two, no best-Nth seat at all)
    await sql`update stage_seed_proposals set computed = jsonb_set(computed - 'crossPoolDraw', '{qualifiers}',
      (select jsonb_agg(q - 'basis' - 'pool') from jsonb_array_elements(computed->'qualifiers') q)) where id = ${draft!.id}`;
    const out = await confirmSeedProposal(b.auth, b.koId, { proposalId: draft!.id });
    expect(out.proposalId).toBe(draft!.id);
    expect(out.filled).toBe(4);
  });
});

// Task 5 part 3 (owed item 1): the `timing: "on_complete"` path - `seedNextStage` resolves the qualifiers at the source's completion
// and writes them to `config.qualified`, whose order IS the seeding Generate lays out (`seed: i + 1` on the engine's bracket
// geometry). An API or legacy knockout fed from groups that way is drawn across the pools exactly as a setup proposal is.
describe.skipIf(!HAS_DB)("FX-G5 on_complete: the knockout seeded at the source's completion crosses the pools too", () => {
  /** The fold an on_complete knockout seated before the draw - rank, then pool (A1, B1, C1, A2, B2, C2) - read off the scene's own
   *  results: under `decisive` the lower entrant seed wins every meeting, so a pool's place-k entrant is its k-th lowest seed. */
  const fold = (b: Built, perPool: number) => {
    const pools = [...new Set(b.poolOf.values())].sort();
    const ranked = new Map(pools.map((p) => [p, [...b.poolOf.entries()].filter(([, q]) => q === p).map(([id]) => id).sort((x, y) => b.seedOf.get(x)! - b.seedOf.get(y)!)] as const));
    return Array.from({ length: perPool }, (_, k) => pools.map((p) => ranked.get(p)![k]!)).flat();
  };
  const qualifiedOf = async (koId: string) => {
    const [row] = await sql<{ q: string[] | null }[]>`select config->'qualified' as q from stages where id = ${koId}`;
    return row?.q ?? null;
  };

  it("X-PD-1 three pools top two: no pool-mates in the real round one; byes to the pool winners (X-PD-6)", async () => {
    const b = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive, timing: "on_complete" });
    expect((await completeStage(b.auth, b.srcId)).completed).toBe(true);
    const today = fold(b, 2);
    // differential: today `config.qualified` is the fold, and the engine's own geometry pairs C1 with C2 at seeds 3 and 6.
    const pos = seedPositions(nextPowerOfTwo(6));
    const foldPairs: [string, string][] = [];
    for (let i = 0; i < pos.length; i += 2) if (pos[i]! <= 6 && pos[i + 1]! <= 6) foldPairs.push([today[pos[i]! - 1]!, today[pos[i + 1]! - 1]!]);
    expect(foldPairs.some(([x, y]) => b.poolOf.get(x) === b.poolOf.get(y)), "the premise: the fold seats a same-pool pair").toBe(true);
    const qualified = await qualifiedOf(b.koId);
    expect(new Set(qualified), "the same six qualify").toEqual(new Set(today));
    const r1 = await roundOne(b);
    expect(r1.pairs, "6 into 8: two real round-one matches").toHaveLength(2);
    for (const [x, y] of r1.pairs) expect(b.poolOf.get(x), `${label(b, x)} v ${label(b, y)}`).not.toBe(b.poolOf.get(y));
    // RB5-D6: the byes go to the top qualifiers - two of the pool winners, the draw's tier 1 holding its places (seeds 1, 2).
    expect(r1.byes.map((id) => b.seedOf.get(id)).sort(), "byes to the top seeds").toEqual([1, 2]);
  });

  it("X-PD-3 a rank tie across pools is drawn with the stage's stored seed (minted from the stage, W4 K5); the ledger records it", async () => {
    // uniform: A1 and B1 are level on every key and played, so the tier-1 run is shuffled with the stage's seed.
    const b = await build({ entrants: 8, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: uniform, timing: "on_complete" });
    await completeStage(b.auth, b.srcId);
    const winners = fold(b, 1); // pool order: A1 (seed 1), B1 (seed 2)
    const seed = swissDrawSeed(b.koId);
    const expectedTop = shuffle(seed, winners.map((entrantId) => ({ entrantId }))).map((s) => s.entrantId);
    expect((await qualifiedOf(b.koId))!.slice(0, 2), "the stage's seed's shuffle of the level winners").toEqual(expectedTop);
    const [ev] = await sql<{ payload: { crossPoolDraw?: { seed: number } } }[]>`
      select payload from division_events where division_id = ${b.divId} and type = 'stage_seeded' and payload->>'stageId' = ${b.koId}`;
    expect(ev?.payload.crossPoolDraw, "the draw seed is recorded with the seeding").toEqual({ seed });
  });

  it("X-PD-4 RB5-D10: two pools, the winners and Group B's runner-up into a 4-draw - refused by name, nothing seated", async () => {
    // 7 into 2 (A = 1,4,5; B = 2,3,6,7). decisive: B2 (seed 3) is the best runner-up once B's bottom row is dropped, so the 4-draw
    // pairs B1 v B2 with no ordering out (tier 1 holds its places, tier 2 has one seat).
    const b = await build({ entrants: 7, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }], score: decisive, timing: "on_complete" });
    const err = await completeStage(b.auth, b.srcId).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(err?.status, "the completion stands; its seeding half is refused").toBe(409);
    expect(err?.code).toBe("STAGE_COMPLETED_SEEDING_FAILED");
    expect(err?.extra).toMatchObject({ cause: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", pool: "B", count: 2, entrants: 3, shape: "single_elim" });
    const [src] = await sql<{ status: string }[]>`select status from stages where id = ${b.srcId}`;
    expect(src!.status).toBe("complete");
    expect(await qualifiedOf(b.koId), "never seated silently").toBeNull();
    const lines = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${b.koId}`;
    expect(lines[0]!.n, "nothing drawn").toBe(0);
  });

  it("a `picks` take is the organiser's own seat order: never drawn, on either path (setup and on_complete)", async () => {
    // doc 05 §2.3's cross-pool template: the organiser lists A1, B2, B1, A2. Its tiers go down along the list, which the engine's
    // draw refuses (`tiers_out_of_order`); the organiser placed every seat, so the draw is not run (as `seeded_map`).
    // differential: drawn, both paths refuse SEEDING_CROSS_POOL_DRAW_INVALID {reason: tiers_out_of_order} and nobody is seated.
    const picks = [{ kind: "picks", picks: [{ pool: "A", rank: 1 }, { pool: "B", rank: 2 }, { pool: "B", rank: 1 }, { pool: "A", rank: 2 }] }];
    // snake 8 into 2: A = 1,4,5,8; B = 2,3,6,7 - decisive: A1 = 1, A2 = 4, B1 = 2, B2 = 3
    const listed = [1, 3, 2, 4];
    const on = await build({ entrants: 8, pools: 2, kind: "knockout", take: picks, score: decisive, timing: "on_complete" });
    expect((await completeStage(on.auth, on.srcId)).completed).toBe(true);
    expect((await qualifiedOf(on.koId))!.map((id) => on.seedOf.get(id)), "on_complete: the listed order").toEqual(listed);
    const set = await build({ entrants: 8, pools: 2, kind: "knockout", take: picks, score: decisive });
    expect((await completeStage(set.auth, set.srcId)).completed).toBe(true);
    const p = await getSeedProposal(set.auth, set.koId);
    expect(p!.computed.crossPoolDraw, "setup: no draw").toBeUndefined();
    expect((await seats(set)).map((id) => set.seedOf.get(id)), "setup: the listed order").toEqual(listed);
  });

  it("K23 a one-pool group seeded on_complete keeps today's order (no draw, no seed recorded)", async () => {
    const b = await build({ entrants: 6, pools: 1, kind: "knockout", take: [{ kind: "rankRange", from: 1, to: 4 }], score: decisive, timing: "on_complete" });
    await completeStage(b.auth, b.srcId);
    expect((await qualifiedOf(b.koId))!.map((id) => b.seedOf.get(id))).toEqual([1, 2, 3, 4]);
    const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${b.divId} and type = 'stage_seeded' and payload->>'stageId' = ${b.koId}`;
    expect(ev, "seeded").toBeDefined();
    expect(ev!.payload.crossPoolDraw).toBeUndefined();
  });
});
