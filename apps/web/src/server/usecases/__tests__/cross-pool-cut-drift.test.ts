// W5 app PR B final review I-6 (cross-batch: T5's cross-pool draw x W5-A's X-CUT-4 judge): a knockout fed from THREE pools is
// seated in the cross-pool draw's order (`drawAcrossPools` re-numbers the seeds, so the confirmed slate's `rank` is the DRAWN seed),
// and the judge that decides whether a correction (or a Reinstate) inside the completed group un-fills it (`tableSlateStands`)
// compared that slate seat for seat with the undrawn fold. It now judges a drawn slate on the places it was drawn from: the same
// people, each pool's in the same order. Who sits where ACROSS the pools is the draw's - a correction that changes only who is
// level across the pools moves no place, even mid-correction (the pad's void-then-re-enter is judged at every event).
//
// differential: before the fix `tableSlateStands` compared the drawn slate with the undrawn "today" (rank, then pool key), so any
// slate whose draw is not the identity "did not stand": a correction that moved nobody emptied the confirmed bracket and V540's
// frozen Qualified/Out markers went with it. Three pools are the commonest shape where the draw is not the identity: the fold's
// seed 3 v seed 6 is C1 v C2, so the draw swaps the runners-up of B and C.
//
// Driven through the real doors on a real database: the catalogue's own `groups_ko` template, the generator's snake into three
// pools, results on the ledger, Complete (which proposes), the real confirm (which draws), and then the scorer's correction
// (`scoreEvent`, whose post-commit hook is the seam under test), the withdrawal cascade and the Reinstate (`patchEntrant`).
//
// Expected values: the rulebook's table read by hand off the results, never from the cut under test. Twelve entrants snake into
// three pools of four (A = 1, 6, 7, 12; B = 2, 5, 8, 11; C = 3, 4, 9, 10), the better seed wins every meeting by 20 minus its own
// seed (19-0 for seed 1, 18-0 for seed 2, ...), so no two entrants of different pools end level on any key: every pool finishes in
// seed order, and the thirds compare A3 (seed 7: 13 for, 33 against) over B3 (seed 8: 12 for, 33 against) over C3 (seed 9).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { crossPoolDraw, nextPowerOfTwo, seedPositions } from "@seazn/engine/scheduling";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { listStageQualificationMeta } from "../stage-qualification";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal, refoldStageTable } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The two template shapes into a knockout from three pools: the top two of each (6 into a draw of 8, byes to two winners), and
 *  the top two plus the two best thirds (8, a quarter-final) - the shape the review named. */
const SHAPES = [
  { qualified: 6, cut: [1, 2, 3, 4, 5, 6] },
  { qualified: 8, cut: [1, 2, 3, 4, 5, 6, 7, 8] },
] as const;

/** The snake of 12 into three pools, by key: each pool's members in seed order (its finishing order before any correction). */
const POOLS: Record<string, readonly number[]> = { A: [1, 6, 7, 12], B: [2, 5, 8, 11], C: [3, 4, 9, 10] };

interface Fx {
  id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  srcId: string;
  koId: string;
  idOf: Map<number, string>;
  seedOf: Map<string, number>;
  /** The destination as the generator wrote it, before any confirm. */
  dayOne: Fx[];
  confirmedId: string;
}

const rowsOf = (stageId: string) =>
  sql<Fx[]>`
    select id, round_no, home_entrant_id, away_entrant_id, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

/** A decisive generic result: the winner by 20 minus her own seed, the home side's score first. */
function result(r: Rig, f: { home_entrant_id: string | null }, winnerSeed: number, margin = 20 - winnerSeed) {
  const homeWins = r.seedOf.get(f.home_entrant_id!) === winnerSeed;
  return { p1Score: homeWins ? margin : 0, p2Score: homeWins ? 0 : margin };
}

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

const lineOf = async (r: Rig, a: number, b: number): Promise<Fx> => {
  const [x, y] = [r.idOf.get(a)!, r.idOf.get(b)!];
  const line = (await rowsOf(r.srcId)).find((f) => [f.home_entrant_id, f.away_entrant_id].sort().join() === [x, y].sort().join());
  expect(line, `premise: E${a} and E${b} meet in the group`).toBeTruthy();
  return line!;
};

/** The scorer's correction of a decided group line: its live events taken back, newest first, then a new result for `winner` by
 *  `margin`. Every `scoreEvent` runs the post-commit hook under test. */
async function correct(r: Rig, a: number, b: number, winner: number, margin: number): Promise<void> {
  const f = await lineOf(r, a, b);
  const live = await sql<{ id: string }[]>`
    select e.id from score_events e
     where e.fixture_id = ${f.id} and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)
     order by e.seq desc`;
  expect(live.length, "premise: the line holds live events to take back").toBeGreaterThan(0);
  for (const e of live) await post(r.auth, f.id, "core.void", { event_id: e.id });
  await post(r.auth, f.id, "core.start");
  await post(r.auth, f.id, "generic.result", result(r, f, winner, margin));
}

/** `margin`: every winner's score (the loser's is 0) - by default 20 minus her seed, no two pools level. `drawSeed`: the stored
 *  draw seed the confirmed draft is re-proposed with first (read off the engine by the case, never the stage id's lot). */
async function rig(qualified: number, opts: { margin?: (winnerSeed: number) => number; drawSeed?: number } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `I6 ${suffix}`, visibility: "private", branding: {} });
  // single-sport: the draw and the judge read pools, tiers and seats, which no sport field reaches; the sport only scores the group, and the X-CUT-4 judge's sport sweep is table-source-correction.test.ts.
  const div = await createDivision(auth, comp.id, { name: "Open", slug: `open-${suffix}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG } as never);
  const ents = await createEntrants(
    auth,
    div.id,
    Array.from({ length: 12 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const idOf = new Map(ents.map((e) => [e.seed as number, e.id]));
  const seedOf = new Map(ents.map((e) => [e.id, e.seed as number]));
  const drafts = buildTemplateStages("groups_ko", { qualified, poolCount: 3, swissRounds: 3, legs: 1 });
  expect(drafts[1]?.progression?.timing, "the knockout is seeded by a confirm").toBe("setup");
  const stages = await createStages(
    auth,
    div.id,
    drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })) as never,
  );
  const src = stages.find((s) => s.seq === 1)!;
  const ko = stages.find((s) => s.seq === 2)!;
  await generateStageFixtures(auth, ko.id);
  await generateStageFixtures(auth, src.id);
  await startDivision(auth, div.id);
  const r: Rig = { auth, divisionId: div.id, srcId: src.id, koId: ko.id, idOf, seedOf, dayOne: await rowsOf(ko.id), confirmedId: "" };
  // The pools as the generator drew them: the snake the header reads the table from.
  const drawn = await sql<{ key: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select p.key, f.home_entrant_id, f.away_entrant_id from fixtures f join pools p on p.id = f.pool_id where f.stage_id = ${src.id}`;
  const members: Record<string, number[]> = {};
  for (const f of drawn) for (const id of [f.home_entrant_id, f.away_entrant_id]) members[f.key] = [...new Set([...(members[f.key] ?? []), seedOf.get(id)!])];
  expect(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, [...v].sort((x, y) => x - y)])), "premise: the snake of 12 into 3").toEqual(POOLS);
  // Results straight on the ledger: scoring's auto-advance would complete the group before the case's own steps.
  const fx = await rowsOf(src.id);
  expect(fx, "every meeting of three pools of four").toHaveLength(18);
  for (const f of fx) {
    const w = Math.min(seedOf.get(f.home_entrant_id!)!, seedOf.get(f.away_entrant_id!)!);
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: result(r, f, w, opts.margin?.(w)) });
  }
  await refoldStageTable(auth.orgId, { id: src.id, kind: src.kind }, "skip");
  expect((await completeStage(auth, src.id)).completed, "rig: the group completed").toBe(true);
  let draft = await getSeedProposal(auth, ko.id);
  expect(draft?.status, "rig: completion left a draft").toBe("draft");
  if (opts.drawSeed !== undefined) {
    // The stage's stored seed is the newest proposal's (`storedCrossPoolSeed`): store the chosen one, then re-propose with it.
    await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{crossPoolDraw,seed}', ${opts.drawSeed}::text::jsonb) where id = ${draft!.id}`;
    await computeSeedProposal(auth, ko.id);
    draft = await getSeedProposal(auth, ko.id);
    expect(draft?.computed.crossPoolDraw?.seed, "rig: re-proposed with the chosen draw seed").toBe(opts.drawSeed);
  }
  expect(draft!.computed.ties, "decisive results: no tie to answer").toEqual([]);
  expect(draft!.computed.crossPoolDraw?.refused, "the draw separated the pools").toBeUndefined();
  r.confirmedId = draft!.id;
  await confirmSeedProposal(auth, ko.id, { proposalId: draft!.id });
  return r;
}

const statusOf = async (proposalId: string) => (await sql<{ status: string }[]>`select status from stage_seed_proposals where id = ${proposalId}`)[0]?.status;

/** The destination's seats, by seed, in line order (null = empty). */
const seats = async (r: Rig) => (await rowsOf(r.koId)).map((f) => [f.home_entrant_id, f.away_entrant_id].map((id) => (id === null ? null : r.seedOf.get(id)!)));

/** V540's `qualified`: who the public pages mark Qualified (null - no markers at all). */
const qualified = async (r: Rig) => {
  const meta = (await listStageQualificationMeta(r.auth, [r.srcId])).get(r.srcId) as { qualified?: string[] | null } | undefined;
  return meta?.qualified === null || meta?.qualified === undefined ? null : meta.qualified.map((id) => r.seedOf.get(id)!);
};

/** The newest proposal: its status and its slate as entrant seeds in seat order. */
const newest = async (r: Rig) => {
  const p = await getSeedProposal(r.auth, r.koId);
  return { status: p!.status, seeds: [...p!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => r.seedOf.get(q.entrantId)!), slate: p!.computed.qualifiers };
};

/** The destination is back as the generator wrote it: every seat empty, every line scheduled with no outcome. */
async function expectDayOne(r: Rig): Promise<void> {
  const rows = await rowsOf(r.koId);
  expect(rows.length, "anti-vacuity: the destination has lines").toBeGreaterThan(0);
  expect(rows.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id, f.status, f.outcome])).toEqual(r.dayOne.map((f) => [f.id, null, null, "scheduled", null]));
}

/** The premise every case rests on: the confirmed slate is NOT the fold. The fold is rank, then pool key (A1 B1 C1 A2 B2 C2, then
 *  the best thirds as the header ranks them); the engine's own draw over it - its geometry (`seedPositions`), its separation - is
 *  what the confirm seated. Read from the engine, never from the server's draw. */
async function expectDrawnNotFold(r: Rig, q: number): Promise<{ seated: (number | null)[][]; marked: number[] }> {
  const p = (await getSeedProposal(r.auth, r.koId))!;
  expect(p.id, "premise: the confirmed proposal is the newest").toBe(r.confirmedId);
  expect(p.status).toBe("confirmed");
  const pool = (seed: number) => Object.entries(POOLS).find(([, m]) => m.includes(seed))![0];
  const fold = q === 6 ? [1, 2, 3, 6, 5, 4] : [1, 2, 3, 6, 5, 4, 7, 8];
  const tierOf = (i: number) => (i < 3 ? 1 : i < 6 ? 2 : 3);
  const engine = crossPoolDraw(
    fold.map((seed, i) => ({ entrantId: r.idOf.get(seed)!, pool: pool(seed), tier: tierOf(i) })),
    "single_elim",
    p.computed.crossPoolDraw!.seed,
  ).order.map((id) => r.seedOf.get(id)!);
  const drawn = [...p.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((x) => r.seedOf.get(x.entrantId)!);
  expect(drawn, "the confirmed slate is the engine's draw over the fold").toEqual(engine);
  expect(drawn, "premise (I-6): the draw is NOT the identity - the fold would seat C1 v C2").not.toEqual(fold);
  // ...and the fold on the engine's own geometry does pair two of one pool, which is why it was drawn.
  const pos = seedPositions(nextPowerOfTwo(q));
  const foldPairs: [number, number][] = [];
  for (let i = 0; i < pos.length; i += 2) if (pos[i]! <= q && pos[i + 1]! <= q) foldPairs.push([fold[pos[i]! - 1]!, fold[pos[i + 1]! - 1]!]);
  expect(foldPairs.some(([x, y]) => pool(x) === pool(y)), "premise: the fold seats a same-pool pair").toBe(true);
  const seated = await seats(r);
  // A bye holder sits on her bye line and on the round-two line it feeds, so the seats are read as a set.
  expect([...new Set(seated.flat().filter((s) => s !== null))].sort((a, b) => a! - b!), "the confirm seated the whole cut").toEqual(SHAPES.find((s) => s.qualified === q)!.cut);
  const marked = await qualified(r);
  expect(marked, "V540 marks who went through").not.toBeNull();
  expect([...marked!].sort((a, b) => a - b)).toEqual(SHAPES.find((s) => s.qualified === q)!.cut);
  return { seated, marked: marked! };
}

describe.runIf(HAS_DB)("I-6 a confirmed knockout drawn across three pools, and the X-CUT-4 judge", () => {
  let standing = 0;
  for (const { qualified: q } of SHAPES) {
    it(`a correction that moves nobody leaves the drawn bracket and its markers standing [${q} from 3 pools]`, async () => {
      const r = await rig(q);
      const before = await expectDrawnNotFold(r, q);
      // A mistyped score fixed: E1 beat E12 19-0, entered again as 15-0. E1 still wins pool A on every key; nobody moves.
      await correct(r, 1, 12, 1, 15);
      expect(await statusOf(r.confirmedId), "the confirmed proposal still stands").toBe("confirmed");
      expect(await seats(r), "no seat moved").toEqual(before.seated);
      expect((await newest(r)).status, "and nothing was re-proposed").toBe("confirmed");
      expect(await qualified(r), "the frozen markers stay").toEqual(before.marked);
      standing++;
    });

    it(`a Reinstate that moves nobody leaves the drawn bracket and its markers standing [${q} from 3 pools]`, async () => {
      const r = await rig(q);
      const before = await expectDrawnNotFold(r, q);
      // E12 (pool A's fourth, nobody's seat) withdraws after the table is final, then is reinstated. Her departure is judged with
      // her as `departing` (not named: it stands); the Reinstate re-judges every confirmed cut with no one departing.
      await withdrawEntrantCascade(r.auth, r.idOf.get(12)!);
      expect(await statusOf(r.confirmedId), "premise: her departure moved nobody").toBe("confirmed");
      await patchEntrant(r.auth, r.idOf.get(12)!, { status: "registered" });
      const [{ status }] = await sql<{ status: string }[]>`select status from entrants where id = ${r.idOf.get(12)!}`;
      expect(status, "premise: she is back").toBe("registered");
      expect(await statusOf(r.confirmedId), "the confirmed proposal still stands").toBe("confirmed");
      expect(await seats(r), "no seat moved").toEqual(before.seated);
      expect(await qualified(r), "the frozen markers stay").toEqual(before.marked);
      standing++;
    });

    // The positive pairs: a correction that DOES move the cut still un-fills the drawn bracket before the knockout starts.
    it(`a correction that swaps a qualifier in still un-fills the drawn bracket [${q} from 3 pools]`, async () => {
      const r = await rig(q);
      await expectDrawnNotFold(r, q);
      // E9 beats E4 (11-0): pool C finishes 3, 9, 4, 10. Top two: E9 in, E4 down to third. With the best thirds (q = 8) E4 is
      // C's third on 16 for / 28 against, over A3 (E7: 13 / 33) and B3 (E8: 12 / 33): E4 and E7 go through, E8 is out.
      await correct(r, 4, 9, 9, 11);
      expect(await statusOf(r.confirmedId), "the confirmed proposal went stale").toBe("stale");
      await expectDayOne(r);
      const now = await newest(r);
      expect(now.status, "a re-proposal, ready to confirm").toBe("draft");
      expect([...now.seeds].sort((a, b) => a - b), "the corrected cut").toEqual(q === 6 ? [1, 2, 3, 5, 6, 9] : [1, 2, 3, 4, 5, 6, 7, 9]);
      expect(await qualified(r), "no verdict while the re-proposal waits").toBeNull();
      standing++;
    });

    it(`a correction that re-orders a pool (the same people) still un-fills the drawn bracket [${q} from 3 pools]`, async () => {
      const r = await rig(q);
      await expectDrawnNotFold(r, q);
      // E6 beats E1 (14-0): pool A finishes 6, 1, 7, 12 - the same two go through, E6 now the winner: the bracket seeds by rank.
      await correct(r, 1, 6, 6, 14);
      expect(await statusOf(r.confirmedId), "the confirmed proposal went stale").toBe("stale");
      await expectDayOne(r);
      const now = await newest(r);
      expect(now.status).toBe("draft");
      expect([...now.seeds].sort((a, b) => a - b), "the same people").toEqual(SHAPES.find((s) => s.qualified === q)!.cut);
      const rankOnSource = (seed: number) => now.slate.find((x) => x.entrantId === r.idOf.get(seed))!.source.rank;
      expect([rankOnSource(6), rankOnSource(1)], "E6 wins pool A, E1 is its runner-up").toEqual([1, 2]);
      standing++;
    });

    // Who is level ACROSS the pools is the draw's input, never a place: the draw shuffles a level run with the stored seed (X-PD-3),
    // so a correction that makes two winners level would re-draw them, about half the time against the confirmed order. The judge
    // reads places, so the bracket stands whichever way the stored seed would draw them. Both seeds are CHOSEN off the engine's own
    // draw - one keeps E1 first, one puts E2 first - so each reads one outcome every run, never the stage id's lot.
    it(`a correction that only makes two pool winners level leaves the drawn bracket standing, whatever the stored seed would draw [${q} from 3 pools]`, async () => {
      const pool = (seed: number) => Object.entries(POOLS).find(([, m]) => m.includes(seed))![0];
      const fold = q === 6 ? [1, 2, 3, 6, 5, 4] : [1, 2, 3, 6, 5, 4, 7, 8];
      // E1 19-0 over E12 corrected to 16-0: E1 54 for, 0 against - E2's record exactly (3 x 18-0), so A1 and B1 are level; C1 (E3,
      // 51-0) is not. Every place is unchanged.
      const orderWith = (drawSeed: number) =>
        crossPoolDraw(
          fold.map((seed, i) => ({ pool: pool(seed), tier: i < 3 ? 1 : i < 6 ? 2 : 3, entrantId: String(seed), ...(seed === 2 ? { tied: true } : {}) })),
          "single_elim",
          drawSeed,
        ).order.map(Number);
      let keep = 0;
      let swap = 0;
      for (let s = 1; s < 1000 && (keep === 0 || swap === 0); s++) {
        if (orderWith(s)[0] === 1 && keep === 0) keep = s;
        if (orderWith(s)[0] === 2 && swap === 0) swap = s;
      }
      expect([keep, swap].every((s) => s > 0), "the engine's draw orders the level pair both ways over some seeds").toBe(true);
      let judged = 0;
      for (const drawSeed of [keep, swap]) {
        const r = await rig(q);
        const before = await expectDrawnNotFold(r, q);
        // Untied at the confirm, the draw does not read the seed: the slate is the same whichever is stored. Store the chosen one.
        await sql`update stage_seed_proposals set computed = jsonb_set(computed, '{crossPoolDraw,seed}', ${drawSeed}::text::jsonb) where id = ${r.confirmedId}`;
        await correct(r, 1, 12, 1, 16);
        expect(await statusOf(r.confirmedId), `seed ${drawSeed} (E${orderWith(drawSeed)[0]} first): the confirmed proposal stands`).toBe("confirmed");
        expect(await seats(r), "no seat moved").toEqual(before.seated);
        expect(await qualified(r), "the frozen markers stay").toEqual(before.marked);
        judged++;
      }
      expect(judged, "anti-vacuity: both seeds judged").toBe(2);
      standing++;
    });
  }

  // A correction on the pad is a run of events - the result voided, then entered again - and the judge runs after EACH, so the line
  // is judged undecided in between. With level pool winners (every win 1-0) the undecided line takes A1 out of the level run for a
  // moment: who is level across the pools changes, and no place does. Only q = 6: at q = 8 the level thirds are a tie to answer.
  it("a no-op correction of a level pool winner's line, judged at every event, leaves the drawn bracket standing [6 from 3 pools, level winners]", async () => {
    const pool = (seed: number) => Object.entries(POOLS).find(([, m]) => m.includes(seed))![0];
    const fold = [1, 2, 3, 6, 5, 4];
    // Every win 1-0: A1 B1 C1 level (3-0 from 3), A2 B2 C2 level (2-1): each tier one level run, in pool order. `aOut`: E1's line
    // undecided - she has played 2, so B1 is level with nobody before her and C1 still with B1.
    const orderWith = (drawSeed: number, aOut = false) =>
      crossPoolDraw(
        fold.map((seed, i) => ({ entrantId: String(seed), pool: pool(seed), tier: i < 3 ? 1 : 2, ...(i % 3 !== 0 && !(aOut && i === 1) ? { tied: true } : {}) })),
        "single_elim",
        drawSeed,
      ).order.map(Number);
    let drawSeed = 1;
    while (drawSeed < 1000 && orderWith(drawSeed).join() === orderWith(drawSeed, true).join()) drawSeed++;
    expect(drawSeed, "a stored seed whose draw of the level winners differs from the draw with E1 out of the run").toBeLessThan(1000);
    const r = await rig(6, { margin: () => 1, drawSeed });
    const confirmed = (await getSeedProposal(r.auth, r.koId))!;
    expect(confirmed.status, "premise: confirmed").toBe("confirmed");
    expect([...confirmed.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => r.seedOf.get(q.entrantId)!), "premise: the engine's draw of the level runs with the stored seed").toEqual(orderWith(drawSeed));
    const seated = await seats(r);
    const marked = await qualified(r);
    expect(marked, "premise: V540 marks who went through").not.toBeNull();
    await correct(r, 1, 12, 1, 1); // E1 beat E12 1-0: voided, then entered again 1-0 - nobody moves, nothing changes
    expect(await statusOf(r.confirmedId), "the confirmed proposal still stands").toBe("confirmed");
    expect(await seats(r), "no seat moved").toEqual(seated);
    expect(await qualified(r), "the frozen markers stay").toEqual(marked);
    standing++;
  });

  it("anti-vacuity: every shape ran every case", () => {
    expect(standing, "5 cases x 2 shapes, and the level-winners case").toBe(SHAPES.length * 5 + 1);
  });
});
