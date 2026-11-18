// V528 — a lots draw of a LARGE tie class is stored (found by the 100-board / 200-player Swiss load run, 2026-11-18).
//
// The defect on the tree before V528: `stage_lots_draws_live_key` (V475) was a unique index over the member list's full text
// (`members_key`, 37 characters an entrant), so a tie class of ~71 entrants or more overflowed Postgres's btree row maximum
// (2704 bytes, "index row size N exceeds btree version 4 maximum 2704") and the INSERT threw. The throw came out of
// `recomputeStandings`, which `scoreEvent` calls AFTER the score committed: the result stood, the caller got a 500, the
// stage's table was not refolded, and every hook after it was skipped. Every unplayed entrant of a fresh Swiss round is one
// class, so a 200-player round 1 hit it on each of its first ~65 results.
//
// Real Postgres. Two layers, so neither proves only itself:
//   - the producer/consumer chain: a result through the product's own `scoreEvent` on a stage whose unplayed field is one
//     class of 78, the table read back from `standings_snapshots`;
//   - the index itself, through `persistLotsDraws`, across the class sizes either side of the old limit: the live key
//     still holds (one live draw per stage, pool and member set), a superseded draw still allows a new live one.
// Expected values come from the rulebook and the engine's declarations (`membersKeyOf`, the btree maximum Postgres itself
// names), never from the writer under test. The store is sport-blind (the table keys a stage, a pool and a member set), so
// the index cases carry no sport; the chain runs for the generic sport and for chess (`boardgame`, the load run's sport).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { membersKeyOf } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { recomputeStandings } from "../competition";
import { loadLotsDraws, persistLotsDraws } from "../table-rules";
import { seatedFixtures, tableScene } from "./helpers/w2d-table-rig";
import { post } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The btree v4 maximum index row Postgres reports ("... exceeds btree version 4 maximum 2704"). A key longer than this
 *  cannot be indexed as text — the premise every case below states for itself. */
const BTREE_V4_MAX = 2704;

interface DrawRow {
  id: string;
  members_key: string;
  members: string[];
  drawn_order: string[];
  superseded_at: string | null;
}
const draws = (stageId: string) =>
  sql<DrawRow[]>`
    select id, members_key, members, drawn_order, to_json(superseded_at) #>> '{}' as superseded_at
      from stage_lots_draws where stage_id = ${stageId} order by drawn_at, id`;
const live = async (stageId: string) => (await draws(stageId)).filter((d) => d.superseded_at === null);

/** A draw as the engine makes one: the key is the engine's own `membersKeyOf`, the order a permutation of the members. */
function drawOf(size: number, seed = 1) {
  const members = Array.from({ length: size }, () => randomUUID());
  const key = membersKeyOf(members);
  return { membersKey: key, members, drawnOrder: [...members].reverse(), seed };
}

const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

/** The two result writers of the chain. Each decides a board for its HOME side, as the sport's own scorer does. */
const WRITERS = [
  {
    sport: "generic",
    variant: "score",
    stageConfig: {},
    win: async (auth: AuthCtx, id: string) => {
      await post(auth, id, "core.start");
      await post(auth, id, "generic.result", { p1Score: 1, p2Score: 0 });
    },
  },
  {
    sport: "boardgame",
    variant: "classical",
    stageConfig: { chess: true },
    win: async (auth: AuthCtx, id: string, home: string) => {
      await post(auth, id, "core.start");
      await post(auth, id, "boardgame.result", { winner: home, method: "resign" });
    },
  },
] as const;

describe.skipIf(!HAS_DB)("V528: a lots draw of a large tie class is stored", () => {
  for (const w of WRITERS) {
    it(`${w.sport}: an 80-entrant Swiss — a result posts, the 78 who have not played are ONE stored draw, the table ranks them by it`, async () => {
      const t = await tableScene({
        sport: w.sport,
        variant: w.variant,
        entrants: 80,
        stages: { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3, ...w.stageConfig }, progression: null } as never,
      });
      const stageId = t.stageIds[0]!;
      await startDivision(t.auth, t.divisionId);
      await generateStageFixtures(t.auth, stageId); // pairs round 1: 40 boards
      const boards = await seatedFixtures(stageId);
      expect(boards.length, "premise: 80 entrants, 40 boards in round 1").toBe(40);
      expect(await draws(stageId), "premise: nothing drawn before a result (an empty table stores no draw)").toEqual([]);

      // 1. the first result. Before V528 this REJECTED with the btree error — after committing the result.
      const first = boards[0]!;
      await w.win(t.auth, first.id, first.home);
      const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${first.id}`;
      expect(row!.status, "the result stands").toBe("decided");

      // the rulebook's answer: two entrants have played; the other 78 are level on every criterion (none has played, no
      // head-to-head), so they are one tie class — and a class of two or more is drawn.
      const unplayed = t.entrants.filter((e) => e !== first.home && e !== first.away);
      expect(unplayed.length, "premise: a class of 78").toBe(78);
      expect(membersKeyOf(unplayed).length, "premise: its key is longer than a btree page can index as text").toBeGreaterThan(BTREE_V4_MAX);
      const lots1 = await live(stageId);
      expect(lots1, "one live draw").toHaveLength(1);
      expect(sameSet(lots1[0]!.members, unplayed), "the draw is exactly the 78 who have not played").toBe(true);
      expect(lots1[0]!.members_key, "its key is the engine's key of its members").toBe(membersKeyOf(lots1[0]!.members));

      // the stored table: the winner first, the other 78 in the stored order, nobody missing
      const [snap1] = await sql<{ rows: { entrantId: string; played: number }[] }[]>`
        select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
      const ids1 = snap1!.rows.map((r) => r.entrantId);
      expect(ids1[0], "the winner leads").toBe(first.home);
      expect(snap1!.rows.reduce((n, r) => n + r.played, 0), "the table folded the result: two entrants have played one").toBe(2);
      expect(ids1.filter((id) => unplayed.includes(id)), "the unplayed class sits in the stored order").toEqual(lots1[0]!.drawn_order);

      // 2. a second call stores nothing new and reorders nothing
      const again = await recomputeStandings(t.auth.orgId, stageId);
      expect(again.map((r) => r.entrantId), "a refold ranks the class by the stored order").toEqual(ids1);
      expect((await draws(stageId)).length, "a refold stores no further draw").toBe(1);

      // 3. a second result shrinks the class to 76 (still over the old limit): the 78-draw is superseded, the 76 is live
      const second = boards.find((b) => b.id !== first.id)!;
      await w.win(t.auth, second.id, second.home);
      const unplayed2 = unplayed.filter((e) => e !== second.home && e !== second.away);
      expect(unplayed2.length, "premise: a class of 76").toBe(76);
      const all2 = await draws(stageId);
      const liveNow = all2.filter((d) => d.superseded_at === null);
      expect(
        liveNow.filter((d) => d.members.length > 70).map((d) => d.members.length),
        "exactly one live draw of the large class, and it is the 76",
      ).toEqual([76]);
      expect(all2.find((d) => d.id === lots1[0]!.id)!.superseded_at, "the 78-draw is history now").not.toBeNull();

      // 4. a void takes the table back toward empty: nothing breaks, nothing is drawn afresh, the history is kept
      const [res] = await sql<{ id: string }[]>`
        select id from score_events where fixture_id = ${second.id} and type in ('generic.result', 'boardgame.result')`;
      await post(t.auth, second.id, "core.void", { event_id: res!.id });
      const afterVoid = await draws(stageId);
      expect(afterVoid.length, "the void stores no new draw").toBe(all2.length);
      expect((await recomputeStandings(t.auth.orgId, stageId)).length, "the table still reads every entrant").toBe(80);
    }, 600_000);
  }

  it("the live key holds at every class size either side of the old limit: one live draw per stage, pool and member set", async () => {
    const t = await tableScene({ entrants: 2 });
    const stageId = t.stageIds[0]!;
    // 2 is the smallest class a draw orders; 70 and 71 fit the old row (37 characters an entrant plus ~51 bytes of row
    // against 2704), 72 does not (its KEY is still under 2704 — the limit is the index ROW, which also carries the stage and
    // pool); 80 and 200 are the load run's tie classes (200 entrants made a 7376-byte row).
    const SIZES = [2, 70, 71, 72, 80, 200];
    let checked = 0;
    for (const size of SIZES) {
      const pool = randomUUID(); // a pool of its own per size, so the sizes do not supersede one another
      const d = drawOf(size);
      // premise, where the key alone says it: a small class's key is under a btree page, a big one's is over (71 and 72 sit
      // on the edge, where only the whole row decides)
      if (size <= 70) expect(d.membersKey.length, `${size}: premise on the key length`).toBeLessThan(BTREE_V4_MAX);
      if (size >= 80) expect(d.membersKey.length, `${size}: premise on the key length`).toBeGreaterThan(BTREE_V4_MAX);
      await sql.begin((tx) => persistLotsDraws(tx, stageId, pool, [d]));
      const stored = (await draws(stageId)).filter((r) => r.members_key === d.membersKey);
      expect(stored, `${size}: stored once`).toHaveLength(1);
      expect(stored[0]!.drawn_order, `${size}: with its order`).toEqual(d.drawnOrder);

      // a second live draw of the SAME set in the SAME pool: not stored (the live key), the first one serves
      const again = { ...d, drawnOrder: [...d.members], seed: 2 };
      await sql.begin((tx) => persistLotsDraws(tx, stageId, pool, [again]));
      const afterAgain = (await draws(stageId)).filter((r) => r.members_key === d.membersKey);
      expect(afterAgain, `${size}: the repeat stored nothing`).toHaveLength(1);
      expect(afterAgain[0]!.drawn_order, `${size}: the first draw serves`).toEqual(d.drawnOrder);
      expect((await loadLotsDraws(sql, stageId)).get(pool)?.get(d.membersKey)?.order, `${size}: read back`).toEqual(d.drawnOrder);

      // the key itself (not only the writer's `on conflict`): a raw second live insert is refused by NAME
      const raw = await sql`
        insert into stage_lots_draws (stage_id, pool_id, members_key, members, drawn_order, seed)
        values (${stageId}, ${pool}, ${d.membersKey}, ${d.members}::uuid[], ${d.members}::uuid[], 3)`.catch((e: unknown) => e);
      expect(raw, `${size}: a raw duplicate is refused`).toMatchObject({ code: "23505", constraint_name: "stage_lots_draws_live_key" });

      // the same member set in ANOTHER pool is its own draw; so is the stage-wide table (the null pool)
      const otherPool = randomUUID();
      await sql.begin((tx) => persistLotsDraws(tx, stageId, otherPool, [{ ...d, seed: 4 }]));
      await sql.begin((tx) => persistLotsDraws(tx, stageId, null, [{ ...d, seed: 5 }]));
      const everywhere = (await live(stageId)).filter((r) => r.members_key === d.membersKey);
      expect(everywhere, `${size}: one live draw in each of three pools`).toHaveLength(3);
      // …and the null pool is ONE pool (the key's coalesce: a NULL is never "distinct" from another NULL): a second
      // null-pool draw of the set stores NOTHING — counted over every row, since a stored-then-superseded duplicate would
      // leave the live count unchanged — and a raw second live insert into it is refused by name
      await sql.begin((tx) => persistLotsDraws(tx, stageId, null, [{ ...d, seed: 6 }]));
      expect((await draws(stageId)).filter((r) => r.members_key === d.membersKey), `${size}: the null pool stored the set once`).toHaveLength(3);
      const rawNull = await sql`
        insert into stage_lots_draws (stage_id, pool_id, members_key, members, drawn_order, seed)
        values (${stageId}, null, ${d.membersKey}, ${d.members}::uuid[], ${d.members}::uuid[], 3)`.catch((e: unknown) => e);
      expect(rawNull, `${size}: a raw duplicate in the null pool is refused`).toMatchObject({ code: "23505", constraint_name: "stage_lots_draws_live_key" });
      // …and a DIFFERENT member set of the same size in the same pool is its own live draw
      const other = drawOf(size, 7);
      await sql.begin((tx) => persistLotsDraws(tx, stageId, pool, [other]));
      expect((await live(stageId)).filter((r) => r.members_key === other.membersKey), `${size}: another member set is its own draw`).toHaveLength(1);
      checked++;
    }
    expect(checked, "anti-vacuity: every size ran").toBe(SIZES.length);
  }, 300_000);

  it("a superseded draw still allows a new live one: the set drawn again after a wider set superseded it", async () => {
    const t = await tableScene({ entrants: 2 });
    const stageId = t.stageIds[0]!;
    const wide = drawOf(80);
    const narrow = { members: wide.members.slice(0, 78) };
    const narrowDraw = { membersKey: membersKeyOf(narrow.members), members: narrow.members, drawnOrder: [...narrow.members].reverse(), seed: 8 };
    expect(wide.membersKey.length, "premise: both keys are over the old limit").toBeGreaterThan(BTREE_V4_MAX);
    expect(narrowDraw.membersKey.length, "premise: both keys are over the old limit").toBeGreaterThan(BTREE_V4_MAX);

    await sql.begin((tx) => persistLotsDraws(tx, stageId, null, [narrowDraw]));
    expect(await live(stageId), "the narrow set is live").toHaveLength(1);
    // the wide set intersects it: stored live, the narrow one superseded
    await sql.begin((tx) => persistLotsDraws(tx, stageId, null, [wide]));
    const afterWide = await draws(stageId);
    expect(afterWide.filter((d) => d.superseded_at === null).map((d) => d.members_key), "only the wide set is live").toEqual([wide.membersKey]);
    expect(afterWide.filter((d) => d.superseded_at !== null).map((d) => d.members_key), "the narrow set is history").toEqual([narrowDraw.membersKey]);
    // the narrow set comes back: its old row is superseded, so the live key admits a NEW live row for the same set
    const narrowAgain = { ...narrowDraw, drawnOrder: [...narrow.members], seed: 9 };
    expect(narrowAgain.drawnOrder, "premise: the second draw of the set differs from the first").not.toEqual(narrowDraw.drawnOrder);
    await sql.begin((tx) => persistLotsDraws(tx, stageId, null, [narrowAgain]));
    const final = await draws(stageId);
    expect(final.filter((d) => d.members_key === narrowDraw.membersKey), "the set has its old row and a new one").toHaveLength(2);
    expect(final.filter((d) => d.superseded_at === null).map((d) => d.members_key), "the new one is live, the wide one superseded").toEqual([narrowDraw.membersKey]);
    // and the reader serves the newest row of the set, the one just stored
    const served = (await loadLotsDraws(sql, stageId)).get("")?.get(narrowDraw.membersKey);
    expect(served?.order, "the newest draw of the set serves").toEqual(narrowAgain.drawnOrder);
  }, 120_000);
});
