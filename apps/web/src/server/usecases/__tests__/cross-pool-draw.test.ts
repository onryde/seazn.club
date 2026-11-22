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
import { PROPOSAL_STALE_REDRAWN, PROPOSAL_STALE_SUPERSEDED } from "@/lib/seeding-error";
import { shuffle } from "@seazn/engine/core";
import { swissDrawSeed } from "@/lib/swiss-draw";
import { crossPoolDraw, seedPositions, nextPowerOfTwo } from "@seazn/engine/scheduling";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal } from "../stages";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { listCrossPoolDraws } from "../knockout-desk";
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

  it("X-PD-5 round two follows the fold: the drawn bracket feeds round two exactly as an undrawn one does", async () => {
    // The draw moves entrants between round-one seats; it never rewires the bracket. Round-one line k (seq_in_round order) feeds
    // round-two line ceil(k/2), slot 1 from the odd line and slot 2 from the even one - the standard bracket geometry - so pool-mates
    // may meet from round two on. The witness: a group-fed 6-into-8 drawn at setup (a confirmed proposal) and at on_complete
    // (`config.qualified`), each against a league-fed 6-into-8 (no pools, no draw).
    const wiring = async (koId: string) => {
      const rows = await sql<{ id: string; round_no: number; seq_in_round: number; winner_to_fixture: string | null; winner_to_slot: number | null }[]>`
        select id, round_no, seq_in_round, winner_to_fixture, winner_to_slot from fixtures where stage_id = ${koId} order by round_no, seq_in_round`;
      const first = Math.min(...rows.map((r) => r.round_no));
      const seqOf = new Map(rows.map((r) => [r.id, r.seq_in_round]));
      return rows.filter((r) => r.round_no === first).map((r) => [r.seq_in_round, r.winner_to_fixture ? seqOf.get(r.winner_to_fixture) : null, r.winner_to_slot]);
    };
    const drawn = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    expect((await completeStage(drawn.auth, drawn.srcId)).completed).toBe(true);
    const p = await getSeedProposal(drawn.auth, drawn.koId);
    expect(p!.computed.crossPoolDraw?.seed, "the premise: this bracket was drawn").toEqual(expect.any(Number));
    await confirmSeedProposal(drawn.auth, drawn.koId, { proposalId: p!.id });
    const plain = await build({ entrants: 6, pools: "league", kind: "knockout", take: [{ kind: "rankRange", from: 1, to: 6 }], score: decisive });
    expect((await completeStage(plain.auth, plain.srcId)).completed).toBe(true);
    const q = await getSeedProposal(plain.auth, plain.koId);
    expect(q!.computed.crossPoolDraw, "the premise: the league-fed bracket was not drawn").toBeUndefined();
    await confirmSeedProposal(plain.auth, plain.koId, { proposalId: q!.id });

    const late = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive, timing: "on_complete" });
    expect((await completeStage(late.auth, late.srcId)).completed).toBe(true);
    const [{ n: lines }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${late.koId}`;
    expect(lines, "the premise: the on_complete bracket was generated at completion").toBeGreaterThan(0);

    const undrawn = await wiring(plain.koId);
    expect(undrawn, "round one -> round two: line k feeds line ceil(k/2), odd line slot 1, even line slot 2").toEqual(
      [1, 2, 3, 4].map((k) => [k, Math.ceil(k / 2), k % 2 === 1 ? 1 : 2]),
    );
    let checked = 0;
    for (const [path, b] of [["setup", drawn], ["on_complete", late]] as const) {
      const got = await wiring(b.koId);
      expect(got, `${path}: the drawn bracket is wired as the undrawn one`).toEqual(undrawn);
      checked += got.length;
    }
    expect(checked, "round-one lines checked across both drawn paths (4 each)").toBe(8);
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

  // e2e walkthrough tables-w2d "best third across groups" (CI 2026-11-22): six into two pools of three, the winners, the best second
  // and the best third into a 4-draw, seeded at the groups' completion. Which pool supplies the best second and third is decided by
  // the results, so the same take is refused for one field and seated for another - both through the real completion.
  /** 6 into 2 is A = seeds 1, 4, 5 and B = 2, 3, 6 (the boustrophedon deal); the lower seed wins every meeting. */
  const BEST_THIRD_TAKE = [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }, { kind: "bestNth", nth: 3, count: 1 }];
  const SIX_IN_TWO = { 1: "A", 4: "A", 5: "A", 2: "B", 3: "B", 6: "B" } as const;
  /** A score per meeting, keyed `winnerSeed-loserSeed`. A meeting the table does not name is a rig fault, never a default score. */
  const scored = (table: Readonly<Record<string, readonly [number, number]>>): Score => (w, l) => {
    const s = table[`${w}-${l}`];
    if (s === undefined) throw new Error(`rig: no score for seed ${w} v seed ${l}`);
    return s;
  };
  const poolsBySeed = (b: Built) => Object.fromEntries([...b.seedOf].map(([id, seed]) => [seed, b.poolOf.get(id)]));
  const idOfSeed = (b: Built, seed: number) => [...b.seedOf].find(([, s]) => s === seed)![0];

  it("RB5-D4: the winners, the best second and the best third of two pools into a 4-draw, Group B supplying three - refused by name at Complete", async () => {
    // B2 (diff +2) beats A2 (-4) and B3 (-4) beats A3 (-6) on every cross-group key, so the field is A1, B1, B2, B3. Two round-one
    // matches hold at most two of one pool apart (pigeonhole): RB5-D4's "one pool supplies more than half the draw" (OWNER 281).
    // The CI walkthrough's exact refusal: pool B, 3 of 4, single elimination.
    const score = scored({ "1-4": [5, 0], "1-5": [5, 0], "4-5": [1, 0], "2-3": [1, 0], "2-6": [2, 1], "3-6": [3, 0] });
    const b = await build({ entrants: 6, pools: 2, kind: "knockout", take: BEST_THIRD_TAKE, score, timing: "on_complete" });
    expect(poolsBySeed(b), "the premise: the boustrophedon deal").toEqual(SIX_IN_TWO);
    const err = await completeStage(b.auth, b.srcId).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(err?.status, "the completion stands; its seeding half is refused").toBe(409);
    expect(err?.code).toBe("STAGE_COMPLETED_SEEDING_FAILED");
    expect(err?.extra).toMatchObject({ cause: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", pool: "B", count: 3, entrants: 4, shape: "single_elim" });
    const [src] = await sql<{ status: string }[]>`select status from stages where id = ${b.srcId}`;
    expect(src!.status, "the groups are complete").toBe("complete");
    expect(await qualifiedOf(b.koId), "never seated with pool-mates in round one (RB5-D1)").toBeNull();
    const lines = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${b.koId}`;
    expect(lines[0]!.n, "nothing drawn").toBe(0);
  });

  it("RB5-D1/D2: the same take seats at Complete when Group A supplies the best second and Group B the best third - A1 v B3, B1 v A2", async () => {
    // A2 (diff 0) beats B2 (-1); A3 and B3 are level on diff (-2) and B3 leads on goals for (3 v 0). Winners A1 (+2) and B1 (+3) are
    // not level, so no tie is drawn. The fold is A1, B1, A2, B3 (rank, then pool), and a 4-draw's round one is 1 v 4, 2 v 3: the
    // rulebook's rotation (RB5-D2) keeps every pool apart (RB5-D1) without moving a seat.
    const score = scored({ "1-4": [3, 2], "1-5": [1, 0], "4-5": [1, 0], "2-3": [2, 0], "2-6": [4, 3], "3-6": [1, 0] });
    const b = await build({ entrants: 6, pools: 2, kind: "knockout", take: BEST_THIRD_TAKE, score, timing: "on_complete" });
    expect(poolsBySeed(b), "the premise: the boustrophedon deal").toEqual(SIX_IN_TWO);
    expect((await completeStage(b.auth, b.srcId)).completed).toBe(true);
    const [a1, b1, a2, b3] = [1, 2, 4, 6].map((s) => idOfSeed(b, s));
    expect(await qualifiedOf(b.koId), "seeded in the fold's order: A1, B1, the best second A2, the best third B3").toEqual([a1, b1, a2, b3]);
    const r1 = await roundOne(b);
    const pairs = r1.pairs.map((p) => [...p].sort().join(" v ")).sort();
    expect(pairs, "round one: A1 v B3, B1 v A2").toEqual([[a1!, b3!].sort().join(" v "), [b1!, a2!].sort().join(" v ")].sort());
    for (const [x, y] of r1.pairs) expect(b.poolOf.get(x), `${label(b, x)} v ${label(b, y)}`).not.toBe(b.poolOf.get(y));
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

  it("m-3 the stage card reads an on_complete knockout's draw seed from the seeding ledger, a setup one's from its proposal; one pool, none", async () => {
    // B2 review m-3: the on_complete path draws and records its seed on `stage_seeded` (no proposal is ever made), and the card's
    // read took proposals only - so the destination's header said nothing. Expected: what each producer recorded.
    const on = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive, timing: "on_complete" });
    expect((await completeStage(on.auth, on.srcId)).completed).toBe(true);
    expect(await getSeedProposal(on.auth, on.koId), "the premise: on_complete makes no proposal").toBeNull();
    const [ev] = await sql<{ payload: { crossPoolDraw?: { seed?: unknown } } }[]>`
      select payload from division_events where division_id = ${on.divId} and type = 'stage_seeded' and payload->>'stageId' = ${on.koId}`;
    const recorded = ev?.payload.crossPoolDraw?.seed;
    expect(recorded, "the premise: the on_complete draw recorded its seed").toEqual(expect.any(Number));
    expect(recorded, "the premise: it is the stage's minted seed (W4 K5) - no proposal or Generate stored another").toBe(swissDrawSeed(on.koId));
    expect(await listCrossPoolDraws(on.auth, on.divId), "on_complete: the ledger's seed").toEqual({ [on.koId]: { seed: recorded } });
    // The setup path: the draft's stored seed, as before.
    const setup = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    await completeStage(setup.auth, setup.srcId);
    const draft = (await getSeedProposal(setup.auth, setup.koId))!;
    expect(await listCrossPoolDraws(setup.auth, setup.divId), "setup: the proposal's seed").toEqual({ [setup.koId]: { seed: draft.computed.crossPoolDraw!.seed } });
    // The empty case: a one-pool source records no draw (K23), so the card shows none.
    const one = await build({ entrants: 6, pools: 1, kind: "knockout", take: [{ kind: "rankRange", from: 1, to: 4 }], score: decisive, timing: "on_complete" });
    expect((await completeStage(one.auth, one.srcId)).completed).toBe(true);
    expect(await listCrossPoolDraws(one.auth, one.divId), "one pool: nothing drawn, nothing shown").toEqual({});
  });

  it("m-3 (B2 re-review N-2) a live proposal speaks for its stage over an older seeding ledger row: a refused draft keeps its red band", async () => {
    // The X-PD-4 scene: the draft's draw is refused by name. Its stage is also given a `stage_seeded` row with a seed, in the shape
    // the on_complete writer (`seedNextStage`, stages/carry-over.ts) records - forged, because no door today makes both for one
    // stage. The ledger is the fallback for a stage no live proposal speaks for, so the refusal must survive it.
    const b = await build({ entrants: 9, pools: 3, kind: "page_playoff", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }], score: decisive });
    expect((await completeStage(b.auth, b.srcId)).completed).toBe(true);
    const draft = (await getSeedProposal(b.auth, b.koId))!;
    const refused = draft.computed.crossPoolDraw?.refused;
    expect(refused?.code, "the premise: the live draft's draw is refused").toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    const seed = draft.computed.crossPoolDraw!.seed;
    await sql`
      insert into division_events (division_id, seq, type, payload)
      select ${b.divId}, coalesce(max(seq), 0) + 1, 'stage_seeded', ${sql.json({ stageId: b.koId, from: b.srcId, entrants: [], crossPoolDraw: { seed } } as never)}
        from division_events where division_id = ${b.divId}`;
    const [ledger] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_events where division_id = ${b.divId} and type = 'stage_seeded' and payload->>'stageId' = ${b.koId}`;
    expect(ledger!.n, "the premise: the stage has a seeding ledger row too").toBe(1);
    expect(await listCrossPoolDraws(b.auth, b.divId), "the proposal's read, refusal and all").toEqual({ [b.koId]: { seed, refused } });
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

// D-B2-1 (live matrix F4, carrom and badminton): a tie the confirm needs picked must not undo the cross-pool draw. Ruling (controller,
// owner standing "apply rec"): the pick fixes the ORDER of the tied entrants, then the draw re-runs over the picked slate with the
// draft's stored seed; a picked slate the draw cannot separate is refused by name, never seated.
// Scene: 7 into 2 (A = 1,4,5; B = 2,3,6,7), every winner 1-0. The winners are never level across the pools (A1 played 2, B1 3), so
// tier 1 holds the fold's places (A1 seed 1, B1 seed 2). A2 (seed 4) and B2 (seed 3, compared on two matches once B's bottom row is
// dropped) are level on every key: the best-Nth comparison flags them, and the confirm refuses until the tie is picked.
describe.skipIf(!HAS_DB)("D-B2-1 a tie pick re-draws round one: pool-mates still never meet first", () => {
  /** The pairs and byes of round one for a seat order, on the engine's own bracket geometry (`seedPositions`), as sorted id pairs. */
  const geometry = (order: readonly string[]) => {
    const pos = seedPositions(nextPowerOfTwo(order.length));
    const pairs: string[] = [];
    const byes: string[] = [];
    for (let i = 0; i < pos.length; i += 2) {
      const [x, y] = [order[pos[i]! - 1], order[pos[i + 1]! - 1]];
      if (x !== undefined && y !== undefined) pairs.push([x, y].sort().join(" v "));
      else byes.push((x ?? y)!);
    }
    return { pairs: pairs.sort(), byes: byes.sort() };
  };
  const actual = async (b: Built) => {
    const r1 = await roundOne(b);
    return { pairs: r1.pairs.map((p) => [...p].sort().join(" v ")).sort(), byes: [...r1.byes].sort() };
  };
  /** The same round one read as pool + entrant seed (A1, B2, ...), for a diff a reader can follow. */
  const named = (b: Built, r: { pairs: string[]; byes: string[] }) => ({
    pairs: r.pairs.map((p) => p.split(" v ").map((id) => label(b, id)).sort().join(" v ")).sort(),
    byes: r.byes.map((id) => label(b, id)).sort(),
  });
  /** The engine's own draw over the picked slate: tier 1 (`winners`, `winnersTied`: level across pools) in fold order, then the
   *  picked tier in the pick's order - not tied, the pick ordered it. */
  const engineSeats = (b: Built, winners: readonly string[], winnersTied: boolean, picked: readonly string[], seed: number) =>
    crossPoolDraw(
      [
        ...winners.map((entrantId, i) => ({ entrantId, pool: b.poolOf.get(entrantId)!, tier: 1, ...(winnersTied && i > 0 ? { tied: true } : {}) })),
        ...picked.map((entrantId) => ({ entrantId, pool: b.poolOf.get(entrantId)!, tier: 2 })),
      ],
      "single_elim",
      seed,
    ).order;
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as HttpError);
  const filledLines = async (b: Built) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${b.koId} and (home_entrant_id is not null or away_entrant_id is not null)`)[0]!.n;
  /** 7 into 2, uniform: the scene above. `count`: best runners-up seated (2: both; 1: one seat, the tie straddles it). */
  const scene = async (count: 1 | 2) => {
    const b = await build({ entrants: 7, pools: 2, kind: "knockout", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count }], score: uniform });
    await completeStage(b.auth, b.srcId);
    const draft = (await getSeedProposal(b.auth, b.koId))!;
    const bySeed = (s: number) => [...b.seedOf.entries()].find(([, v]) => v === s)![0];
    const [a1, b1, a2, b2] = [bySeed(1), bySeed(2), bySeed(4), bySeed(3)];
    expect([b.poolOf.get(a1), b.poolOf.get(b1), b.poolOf.get(a2), b.poolOf.get(b2)], "the premise: the snake's pools").toEqual(["A", "B", "A", "B"]);
    expect(draft.computed.ties, "the premise: one flagged tie, the two runners-up").toHaveLength(1);
    expect([...draft.computed.ties[0]!.entrantIds].sort()).toEqual([a2, b2].sort());
    expect(draft.computed.ties[0]!.slots, `the premise: the tie holds ${count} seat(s)`).toHaveLength(count);
    return { b, draft, a1, b1, a2, b2, tie: draft.computed.ties[0]! };
  };

  // The pick is read against the DRAFT's seats: one that swaps the two drawn runners-up (the matrix's carrom and badminton cells -
  // the pick listed the tied ids in their listed order, the reverse of the drawn seats), and one that keeps them. Both seat what the
  // engine draws over the picked order: tier 2 has two seats and two pools, so separation decides the seats either way.
  for (const swap of [true, false]) {
    it(`both runners-up seated, a pick that ${swap ? "swaps" : "keeps"} the drawn seats: the draw re-runs and round one still crosses the pools`, async () => {
      const { b, draft, a1, b1, a2, b2, tie } = await scene(2);
      const occupant = new Map(draft.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId] as const));
      const drawn = tie.slots.map((s) => occupant.get(s)!);
      expect(new Set(drawn), "the premise: the tie's seats hold the two runners-up").toEqual(new Set([a2, b2]));
      const order = swap ? [...drawn].reverse() : drawn;
      const expected = geometry(engineSeats(b, [a1, b1], false, order, draft.computed.crossPoolDraw!.seed));
      await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order }] });
      const got = await actual(b);
      expect(named(b, got), "the engine's draw over the picked slate").toEqual(named(b, expected));
      expect(got.pairs, "4 into 4: two real round-one matches").toHaveLength(2);
      for (const pair of got.pairs) {
        const [x, y] = pair.split(" v ");
        expect(b.poolOf.get(x!), `${label(b, x!)} v ${label(b, y!)}`).not.toBe(b.poolOf.get(y!));
      }
    });
  }

  it("one seat, a pick that leaves no separable round one is refused by name; a re-pick that separates is seated (pick, then re-pick)", async () => {
    const { b, draft, a1, b1, a2, b2, tie } = await scene(1);
    // B2 into the one seat: 3 into 4, seed 3 meets seed 2 = B1 - tier 1 holds its places and tier 2 has one seat (RB5-D10).
    const err = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [b2, a2] }] }));
    expect(err?.status, "never seated over the pools").toBe(422);
    expect(err?.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    expect(err?.extra).toEqual({ pool: "B", count: 2, entrants: 3, shape: "single_elim" });
    expect(await filledLines(b), "nothing filled").toBe(0);
    expect((await getSeedProposal(b.auth, b.koId))!.status, "the draft is still the organiser's to pick again").toBe("draft");
    // the re-pick: A2 takes the seat - the engine's draw seats A1 on the bye and B1 v A2.
    const expected = geometry(engineSeats(b, [a1, b1], false, [a2], draft.computed.crossPoolDraw!.seed));
    await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [a2, b2] }] });
    expect(named(b, await actual(b))).toEqual(named(b, expected));
    expect(expected.pairs, "the premise: the engine seats B1 v A2").toEqual([[b1, a2].sort().join(" v ")]);
  });

  it("a pick fixes its tier's order: the stored seed reshuffles the level winners, never the picked runners-up (3 pools)", async () => {
    // 9 into 3 (A = 1,6,7; B = 2,5,8; C = 3,4,9), every winner 1-0: the three winners are level across the pools on every key and
    // played (tier 1 is shuffled with the stored seed, X-PD-3), and so are the three runners-up - one flagged tie, three seats.
    // 6 into 8: byes to seeds 1 and 2, then 4 v 5 and 3 v 6.
    const b = await build({ entrants: 9, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 3 }], score: uniform });
    await completeStage(b.auth, b.srcId);
    const draft = (await getSeedProposal(b.auth, b.koId))!;
    const ids = (seeds: number[]) => seeds.map((s) => [...b.seedOf.entries()].find(([, v]) => v === s)![0]);
    const winners = ids([1, 2, 3]); // A1, B1, C1 - the fold's pool order
    const runners = ids([6, 5, 4]); // A2, B2, C2
    expect(draft.computed.ties, "the premise: one flagged tie, the three runners-up").toHaveLength(1);
    const tie = draft.computed.ties[0]!;
    expect(new Set(tie.entrantIds)).toEqual(new Set(runners));
    expect(tie.slots).toHaveLength(3);
    // A stored seed and a pick it would reorder: the engine's draw over the pick untied differs from the same draw with the picked
    // tier still a tied run - so the seats say which one ran. The draft's seed is set to the first such seed (deterministic: the
    // draw reads only pools, tiers and the seed), as the X-PD-3 cases set theirs.
    const perms = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    const tiedSeats = (order: readonly string[], seed: number) =>
      crossPoolDraw(
        [
          ...winners.map((entrantId, i) => ({ entrantId, pool: b.poolOf.get(entrantId)!, tier: 1, ...(i > 0 ? { tied: true } : {}) })),
          ...order.map((entrantId, i) => ({ entrantId, pool: b.poolOf.get(entrantId)!, tier: 2, ...(i > 0 ? { tied: true } : {}) })),
        ],
        "single_elim",
        seed,
      ).order;
    const differs = (order: string[], seed: number) => JSON.stringify(geometry(engineSeats(b, winners, true, order, seed))) !== JSON.stringify(geometry(tiedSeats(order, seed)));
    let seed = 0;
    let order: string[] = [];
    for (let s = 1; s <= 1000 && seed === 0; s++) {
      const hit = perms(runners).find((o) => differs(o, s));
      if (hit !== undefined) [seed, order] = [s, hit];
    }
    expect(seed, "a stored seed that would reorder some pick (searched 1..1000, 6 orders each)").toBeGreaterThan(0);
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{crossPoolDraw,seed}', ${seed}::text::jsonb) where id = ${draft.id}`;
    const expected = geometry(engineSeats(b, winners, true, order, seed));
    await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order }] });
    const got = await actual(b);
    expect(named(b, got), "the picked order, drawn across the pools").toEqual(named(b, expected));
    expect(got.pairs).toHaveLength(2);
    for (const pair of got.pairs) {
      const [x, y] = pair.split(" v ");
      expect(b.poolOf.get(x!), `${label(b, x!)} v ${label(b, y!)}`).not.toBe(b.poolOf.get(y!));
    }
  });

  it("a pick that does not rank the tie is unresolved; a draft whose tie the tables no longer make is stale (guards)", async () => {
    const { b, draft, a1, a2, b2, tie } = await scene(2);
    // A1 is no member of the tie: the pick does not answer it.
    const outsider = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [a1, a2] }] }));
    expect(outsider?.status).toBe(422);
    expect(outsider?.code).toBe("SEEDING_TIE_UNRESOLVED");
    expect(await filledLines(b)).toBe(0);
    // The stored draft names a tie the tables do not make (B2 swapped for A1): re-drawing it would seat a slate nobody proposed.
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{ties,0,entrantIds}', ${JSON.stringify([a1, b2])}::jsonb) where id = ${draft.id}`;
    const stale = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [b2, a1] }] }));
    expect(stale?.status).toBe(409);
    expect(stale?.code).toBe("SEEDING_PROPOSAL_STALE");
    expect(await filledLines(b)).toBe(0);
  });

  it("a draft whose slate the tables no longer make is stale, never re-drawn into a slate nobody proposed (guard)", async () => {
    const { b, draft, a2, b2, tie } = await scene(2);
    // The stored draft seats seed 7 (no qualifier) where the tables seat A1.
    const nobody = [...b.seedOf.entries()].find(([, v]) => v === 7)![0];
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{qualifiers,0,entrantId}', ${JSON.stringify(nobody)}::jsonb) where id = ${draft.id}`;
    const stale = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [a2, b2] }] }));
    expect(stale?.status).toBe(409);
    expect(stale?.code).toBe("SEEDING_PROPOSAL_STALE");
    expect(await filledLines(b)).toBe(0);
  });

  it("a REFUSED draft (B2 drafted into the seat that meets B1) is seated once a pick puts A2 there; unanswered it stays refused", async () => {
    // Which of the level runners-up the draft seats is the engine's last resort (entrant id), so scenes are built until one drafts
    // B2 - each does with even odds; eight tries leave a 1-in-256 miss, named below.
    let found: Awaited<ReturnType<typeof scene>> | null = null;
    for (let i = 0; i < 8 && found === null; i++) {
      const s = await scene(1);
      if (s.draft.computed.crossPoolDraw?.refused !== undefined) found = s;
    }
    expect(found, "a scene whose draft seats B2 (8 tries)").not.toBeNull();
    const { b, draft, a1, b1, a2, b2, tie } = found!;
    expect(draft.computed.qualifiers.map((q) => q.entrantId), "the premise: B2 drafted").toContain(b2);
    const unanswered = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id }));
    expect(unanswered?.code, "no answer: the draft's own refusal").toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    const expected = geometry(engineSeats(b, [a1, b1], false, [a2], draft.computed.crossPoolDraw!.seed));
    await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [a2, b2] }] });
    expect(named(b, await actual(b))).toEqual(named(b, expected));
  });

  it("the desk's route: an edit that fills the tied seat is the same pick - refused by name over the pools, seated across them", async () => {
    // progression-panel.tsx resolves a tie through `edits[]` only; an edit covering every tied slot answers the tie exactly as a pick.
    const { b, draft, a1, b1, a2, b2, tie } = await scene(1);
    const err = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, edits: [{ destinationSlot: tie.slots[0]!, entrantId: b2 }] }));
    expect(err?.code, "B2 into the seat that meets B1").toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    expect(await filledLines(b)).toBe(0);
    const expected = geometry(engineSeats(b, [a1, b1], false, [a2], draft.computed.crossPoolDraw!.seed));
    await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, edits: [{ destinationSlot: tie.slots[0]!, entrantId: a2 }] });
    expect(named(b, await actual(b))).toEqual(named(b, expected));
  });

  // I-1 (B2 review; ruling, controller under the owner's standing "apply rec"): a confirm that answers a tie AND edits a seat outside
  // it made those edits against the DRAFT's seats, but the answer re-draws round one - an edit replayed over the re-draw lands on
  // whoever the draw moved there. Such a confirm stores the re-drawn slate as a new draft and answers 409 SEEDING_PROPOSAL_STALE
  // {reason: redrawn, reproposed}; the organiser confirms the seats they now see (F11's pattern). A pick alone still re-draws and
  // confirms; edits alone on a drawn draft are placed as made.
  // Scene: 12 into 4 (A = 1,8,9; B = 2,7,10; C = 3,6,11; D = 4,5,12), the winners and the two best runners-up into an 8-draw: byes to
  // seeds 1 and 2, then 4 v 5 and 3 v 6. Every winner beats her runner-up 1-0 and her third by 9 - her seed, so no two winners are
  // level and tier 1 keeps its places; each runner-up beats her third by A 2, B 4, C 3, D 3 - B2 is the best runner-up and C2, D2 are
  // level on every key for the second seat: one flagged tie, one seat. Whichever of them the draft seats there (the engine's last
  // resort), the other is the pick, and the re-draw moves B2 (C2 cannot take seed 6 against C1) - asserted from the engine below.
  const runnersLevel: Score = (w, l) => (w <= 4 ? (l <= 8 ? [1, 0] : [9 - w, 0]) : [({ 5: 3, 6: 3, 7: 4, 8: 2 } as Record<number, number>)[w]!, 0]);
  const levelScene = async () => {
    const b = await build({ entrants: 12, pools: 4, kind: "knockout", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 2 }], score: runnersLevel });
    expect((await completeStage(b.auth, b.srcId)).completed).toBe(true);
    const draft = (await getSeedProposal(b.auth, b.koId))!;
    const id = (s: number) => [...b.seedOf.entries()].find(([, v]) => v === s)![0];
    const [a1, b1, c1, d1, d2, c2, b2, a2] = [1, 2, 3, 4, 5, 6, 7, 8].map(id) as [string, string, string, string, string, string, string, string];
    expect([a1, b1, c1, d1, a2, b2, c2, d2].map((x) => b.poolOf.get(x)).join(""), "the premise: the snake's pools").toBe("ABCDABCD");
    expect(draft.computed.crossPoolDraw?.refused, "the premise: the draft is drawn").toBeUndefined();
    const ranked = [...draft.computed.qualifiers].sort((x, y) => x.rank - y.rank).map((q) => q.entrantId);
    expect(ranked.slice(0, 4), "the premise: tier 1 holds its places").toEqual([a1, b1, c1, d1]);
    expect(draft.computed.ties, "the premise: one flagged tie").toHaveLength(1);
    const tie = draft.computed.ties[0]!;
    expect(new Set(tie.entrantIds), "the premise: C2 and D2 level").toEqual(new Set([c2, d2]));
    expect(tie.slots, "the premise: one seat").toHaveLength(1);
    const drafted = draft.computed.qualifiers.find((q) => q.destinationSlot === tie.slots[0])!.entrantId;
    const picked = drafted === c2 ? d2 : c2;
    // The engine's draw over the picked slate: tier 1 in place, tier 2 B2 then the pick (the pick ordered it, so not a tied run).
    const redrawn = engineSeats(b, [a1, b1, c1, d1], false, [b2, picked], draft.computed.crossPoolDraw!.seed);
    expect(redrawn.indexOf(b2) + 1, "the premise: the re-draw moves B2 off her draft seat").not.toBe(ranked.indexOf(b2) + 1);
    return { b, draft, tie, d1, a2, b2, drafted, picked, redrawn };
  };
  const slotOf = (p: { computed: { qualifiers: { destinationSlot: string; entrantId: string }[] } }, entrantId: string) =>
    p.computed.qualifiers.find((q) => q.entrantId === entrantId)!.destinationSlot;
  /** The 409 a re-drawn confirm answers, read; then the stored re-proposal, checked against the engine's draw. */
  const expectReproposed = async (s: Awaited<ReturnType<typeof levelScene>>, err: HttpError | null) => {
    expect(err?.status, "never confirmed over the re-drawn seats").toBe(409);
    expect(err?.code).toBe("SEEDING_PROPOSAL_STALE");
    expect(err?.extra).toMatchObject({ reason: PROPOSAL_STALE_REDRAWN });
    expect(await filledLines(s.b), "nothing filled").toBe(0);
    const fresh = (await getSeedProposal(s.b.auth, s.b.koId))!;
    expect(fresh.id, "a new draft").not.toBe(s.draft.id);
    expect(err?.extra, "the reply names the stored re-proposal").toMatchObject({ reproposed: fresh.id });
    expect(await seats(s.b), "the re-proposal seats the engine's draw over the picked slate").toEqual(s.redrawn);
    expect(fresh.computed.ties, "the tie is answered").toEqual([]);
    expect(fresh.computed.crossPoolDraw, "drawn with the draft's stored seed").toEqual({ seed: s.draft.computed.crossPoolDraw!.seed });
    expect(fresh.computed.standingsHash).toBe(s.draft.computed.standingsHash);
    // Each seat keeps the table's comparison basis (who was level is a fact of the table, not of the pick): the tied seat still
    // lists C2 and D2 as level. Read off the draft (the resolver's), seat by seat.
    const bases = (p: typeof fresh) => p.computed.qualifiers.map((q) => JSON.stringify(q.basis ?? null)).sort();
    expect(bases(fresh)).toEqual(bases(s.draft));
    expect(s.draft.computed.qualifiers.some((q) => (q.basis?.levelWith.length ?? 0) > 0), "the premise: a seat names who was level").toBe(true);
    // B2 re-review N-1: each re-drawn seat keeps the engine's pool too - the Standings footnote and `preBumpBestNthDraft` read it. The
    // expected pool is the one her source lines were drawn in (the fixtures' own pool key), never the draft's copy alone.
    // (The pick swaps who holds the tied seat, so each slate is read against its own entrants.)
    const poolBy = (p: typeof fresh) => Object.fromEntries(p.computed.qualifiers.map((q) => [q.entrantId, q.pool ?? null]));
    const truth = (p: typeof fresh) => Object.fromEntries(p.computed.qualifiers.map((q) => [q.entrantId, s.b.poolOf.get(q.entrantId) ?? null]));
    expect(Object.values(truth(fresh)).filter((k) => k !== null && k !== ""), "anti-vacuity: every one of the 6 seats has a pool").toHaveLength(6);
    expect(poolBy(s.draft), "the premise: the draft carries each seat's pool").toEqual(truth(s.draft));
    expect(poolBy(fresh), "the re-proposal keeps each seat's pool").toEqual(truth(fresh));
    return fresh;
  };
  const noPoolMates = (b: Built, r: { pairs: string[] }) => {
    for (const pair of r.pairs) {
      const [x, y] = pair.split(" v ");
      expect(b.poolOf.get(x!), `${label(b, x!)} v ${label(b, y!)}`).not.toBe(b.poolOf.get(y!));
    }
    return r.pairs.length;
  };

  it("I-1 a tie pick with an edit outside the tie re-proposes the re-drawn slate (409); the edit made again on it seats as shown", async () => {
    const s = await levelScene();
    const { b, draft, tie, a2, b2, picked } = s;
    // The organiser picks the other runner-up and puts A2 where the DRAFT shows B2. Replayed over the re-draw, that edit landed on
    // the pick: B2 (replaced) stayed seated and the pick sat nowhere - and the confirm succeeded.
    const err = await refusal(
      confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [picked, s.drafted] }], edits: [{ destinationSlot: slotOf(draft, b2), entrantId: a2 }] }),
    );
    const fresh = await expectReproposed(s, err);
    // The answered draft is spent: confirming it again names the newer one (F5).
    const again = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id }));
    expect(again?.code).toBe("SEEDING_PROPOSAL_STALE");
    expect(again?.extra).toMatchObject({ reason: PROPOSAL_STALE_SUPERSEDED, newer: fresh.id });
    // The edit made again, where the re-proposal shows B2.
    await confirmSeedProposal(b.auth, b.koId, { proposalId: fresh.id, edits: [{ destinationSlot: slotOf(fresh, b2), entrantId: a2 }] });
    const got = await actual(b);
    expect(named(b, got), "the re-proposal with A2 in B2's seat").toEqual(named(b, geometry(s.redrawn.map((x) => (x === b2 ? a2 : x)))));
    const seated = new Set([...got.pairs.flatMap((p) => p.split(" v ")), ...got.byes]);
    expect(seated.has(picked), "the pick is seated").toBe(true);
    expect(seated.has(b2), "the entrant the organiser replaced is not").toBe(false);
    expect(noPoolMates(b, got), "6 into 8: two real round-one matches").toBe(2);
  });

  it("I-1 a tie pick with a swap of two seats outside the tie re-proposes (409, not SEEDING_SLOT_DOUBLE_ASSIGNED); the swap on it seats", async () => {
    const s = await levelScene();
    const { b, draft, tie, d1, b2, picked } = s;
    const swap = (p: Parameters<typeof slotOf>[0]) => [
      { destinationSlot: slotOf(p, b2), entrantId: d1 },
      { destinationSlot: slotOf(p, d1), entrantId: b2 },
    ];
    const err = await refusal(confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [picked, s.drafted] }], edits: swap(draft) }));
    expect(err?.code, "a clean swap on the screen the organiser saw is never refused as a double assignment").not.toBe("SEEDING_SLOT_DOUBLE_ASSIGNED");
    const fresh = await expectReproposed(s, err);
    await confirmSeedProposal(b.auth, b.koId, { proposalId: fresh.id, edits: swap(fresh) });
    const got = await actual(b);
    expect(named(b, got), "the re-proposal with B2 and D1 swapped").toEqual(named(b, geometry(s.redrawn.map((x) => (x === b2 ? d1 : x === d1 ? b2 : x)))));
    expect(noPoolMates(b, got)).toBe(2);
  });

  it("I-1 the desk's route: edits that fill the tied seat and another seat are the same rule - re-proposed (409)", async () => {
    // progression-panel.tsx answers a tie through `edits[]` only.
    const s = await levelScene();
    const { b, draft, tie, a2, b2, picked } = s;
    const err = await refusal(
      confirmSeedProposal(b.auth, b.koId, {
        proposalId: draft.id,
        edits: [
          { destinationSlot: tie.slots[0]!, entrantId: picked },
          { destinationSlot: slotOf(draft, b2), entrantId: a2 },
        ],
      }),
    );
    await expectReproposed(s, err);
  });

  it("I-1 a tie pick alone still re-draws and confirms in one call (no re-proposal)", async () => {
    const s = await levelScene();
    const { b, draft, tie, picked } = s;
    await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [picked, s.drafted] }] });
    const after = (await getSeedProposal(b.auth, b.koId))!;
    expect([after.id, after.status], "the draft itself is confirmed").toEqual([draft.id, "confirmed"]);
    const got = await actual(b);
    expect(named(b, got), "the engine's draw over the picked slate").toEqual(named(b, geometry(s.redrawn)));
    expect(noPoolMates(b, got)).toBe(2);
  });

  it("I-1 edits alone on a drawn draft (no tie to answer) are placed as made, in one call", async () => {
    // X-PD-1's scene (12 into 3, decisive): drawn, no tie. The organiser replaces the bottom qualifier with her own pool's third.
    const b = await build({ entrants: 12, pools: 3, kind: "knockout", take: [{ kind: "topNPerGroup", n: 2 }], score: decisive });
    await completeStage(b.auth, b.srcId);
    const draft = (await getSeedProposal(b.auth, b.koId))!;
    expect(draft.computed.crossPoolDraw?.refused, "the premise: drawn").toBeUndefined();
    expect(draft.computed.crossPoolDraw?.seed).toEqual(expect.any(Number));
    expect(draft.computed.ties, "the premise: no tie").toEqual([]);
    const order = await seats(b);
    const out = order[5]!;
    const pool = b.poolOf.get(out)!;
    const third = [...b.poolOf.entries()].filter(([x, p]) => p === pool && !order.includes(x)).sort(([x], [y]) => b.seedOf.get(x)! - b.seedOf.get(y)!)[0]![0];
    await confirmSeedProposal(b.auth, b.koId, { proposalId: draft.id, edits: [{ destinationSlot: slotOf(draft, out), entrantId: third }] });
    expect((await getSeedProposal(b.auth, b.koId))!.id, "no re-proposal").toBe(draft.id);
    const got = await actual(b);
    expect(named(b, got)).toEqual(named(b, geometry(order.map((x) => (x === out ? third : x)))));
    expect(noPoolMates(b, got)).toBe(2);
  });
});
