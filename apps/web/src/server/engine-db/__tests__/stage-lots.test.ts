// W2d Task 9 (spec §5.8, X-TB-4, X-TB-6; Review Focus 2 and 3; PS-5b; T7 m9) — a residual tie is drawn ONCE and stored:
// every later read ranks the tied set by the stored order, a changed tied set is drawn afresh (the old draw kept as
// history), two writers racing store one draw, and the rank_lock a completion records carries the stored order and the
// DB's own drawn_at.
//
// Real Postgres, every result through `scoreEvent`. One sport (generic) on purpose: the draw is stored by the table, for
// whatever sport ranked it — the store is sport-blind (the engine's `completeTableStage` hands back `newLotsDraws` alike).
// The drawn order itself is random (the stage's rng): expected orders are read back from `stage_lots_draws`, never
// predicted, and every assertion is about the table AGREEING with the stored row.
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { membersKeyOf } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { startDivision } from "@/server/usecases/schedule";
import { completeStage, generateStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { rankedStageStandings, recomputeStandings } from "../competition";
import { loadLotsDraws, persistLotsDraws } from "../table-rules";
import { between, genericResult, seatedFixtures, tableScene } from "./helpers/w2d-table-rig";
import { post } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface DrawRow {
  id: string;
  members_key: string;
  members: string[];
  drawn_order: string[];
  drawn_at: string;
  superseded_at: string | null;
}
const draws = (stageId: string) =>
  sql<DrawRow[]>`
    select id, members_key, members, drawn_order, to_json(drawn_at) #>> '{}' as drawn_at, to_json(superseded_at) #>> '{}' as superseded_at
      from stage_lots_draws where stage_id = ${stageId} order by drawn_at, id`;

/** The draw that orders a tied set: the NEWEST stored row of its members key, superseded or not (spec §5.8 as ruled in the
 *  progress ledger, T5/T9 — a set that comes back after a wider one is ordered as it was first drawn). Every recompute
 *  stores the draws of the table AS IT STANDS, so the store also holds the ties of intermediate tables (two entrants
 *  nobody has played yet are level). */
const servedDraw = (stored: readonly DrawRow[], key: string): DrawRow | undefined => stored.filter((d) => d.members_key === key).at(-1);

/** The tied members in the order the table ranks them. */
const orderIn = (rows: readonly { entrantId: string }[], members: readonly string[]) =>
  rows.map((r) => r.entrantId).filter((id) => members.includes(id));

async function started(entrants = 4) {
  const s = await tableScene({ entrants });
  const stageId = s.stageIds[0]!;
  await generateStageFixtures(s.auth, stageId);
  await startDivision(s.auth, s.divisionId);
  return { ...s, stageId };
}

describe.skipIf(!HAS_DB)("W2d T9: stored lots draws (§5.8)", () => {
  it("X-TB-4 a residual tie is drawn once, stored, and the same order comes back on two reloads", async () => {
    const t = await started();
    const [A, B, C, D] = t.entrants as [string, string, string, string];
    // A and B: one 1-0 win each, never met — level through points, difference, scored and head-to-head. C and D likewise.
    await genericResult(t.auth, t.stageId, A, C, 1, 0);
    await genericResult(t.auth, t.stageId, B, D, 1, 0);
    const first = await recomputeStandings(t.auth.orgId, t.stageId);
    const stored = await draws(t.stageId);
    // After the first result, B and D (neither played) were level and drawn; the second result superseded that draw.
    const live = stored.filter((d) => d.superseded_at === null);
    expect(live.map((d) => d.members_key).sort(), "one live draw per tied set").toEqual([membersKeyOf([A, B]), membersKeyOf([C, D])].sort());
    expect(stored.filter((d) => d.superseded_at !== null).map((d) => d.members_key), "the intermediate table's draw, kept").toEqual([membersKeyOf([B, D])]);
    for (const key of [membersKeyOf([A, B]), membersKeyOf([C, D])]) expect(stored.filter((d) => d.members_key === key), `${key} drawn once`).toHaveLength(1);
    let checked = 0;
    for (const d of live) {
      expect(d.members_key).toBe(membersKeyOf(d.members));
      expect([...d.drawn_order].sort()).toEqual([...d.members].sort());
      expect(d.superseded_at).toBeNull();
      expect(orderIn(first, d.members), "the table ranks the tied set by the stored order").toEqual(d.drawn_order);
      checked++;
    }
    expect(checked).toBe(2);
    // two reloads, through both readers: the same order, nothing new stored
    for (let i = 0; i < 2; i++) {
      expect(await recomputeStandings(t.auth.orgId, t.stageId), `reload ${i + 1}`).toEqual(first);
      expect(await draws(t.stageId), `reload ${i + 1}: the store is untouched`).toEqual(stored);
    }
    const ranked = await sql.begin((tx) => rankedStageStandings(tx, t.stageId));
    expect(ranked.map((r) => r.entrantId)).toEqual(first.map((r) => r.entrantId));
    expect(await draws(t.stageId)).toEqual(stored);
  }, 180_000);

  it("X-TB-6 an empty table stores no draw", async () => {
    const t = await started();
    const rows = await recomputeStandings(t.auth.orgId, t.stageId);
    expect(rows.length, "premise: every entrant has a row").toBe(4);
    expect(rows.every((r) => r.played === 0), "premise: nothing played").toBe(true);
    expect(await draws(t.stageId)).toEqual([]);
    // and after a result is voided back to an empty table
    const [A, B] = t.entrants as [string, string];
    // Sequence: a result, then its void — the table is empty again, and the empty table draws nothing more.
    await genericResult(t.auth, t.stageId, A, B, 1, 0);
    await recomputeStandings(t.auth.orgId, t.stageId);
    const withResult = await draws(t.stageId);
    const f = await between(t.stageId, A, B);
    const [res] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${f.id} and type = 'generic.result'`;
    await post(t.auth, f.id, "core.void", { event_id: res!.id });
    const [after] = await sql<{ status: string }[]>`select status from fixtures where id = ${f.id}`;
    expect(after!.status, "premise: the result is voided").not.toBe("decided");
    const empty = await recomputeStandings(t.auth.orgId, t.stageId);
    expect(empty.every((r) => r.played === 0), "premise: empty again").toBe(true);
    expect(await draws(t.stageId), "the empty table stored nothing").toEqual(withResult);
  }, 180_000);

  it("Review Focus 2: a withdrawal that changes the tied set stores a new draw and marks the old one superseded; an expunged fixture (ruling 105) likewise", async () => {
    const t = await started();
    const [A, B, C, D] = t.entrants as [string, string, string, string];
    // A beats D 1-0, then A, B and C draw each other 0-0. In that order every intermediate table's only tie is {B, C}
    // (A-D: B and C unplayed; A-B: no tie; A-C, B-C: B and C level, then level having drawn each other), so the store
    // holds that one draw — and {A, B, C} has never been level before the withdrawal below.
    await genericResult(t.auth, t.stageId, A, D, 1, 0);
    await genericResult(t.auth, t.stageId, A, B, 0, 0);
    await genericResult(t.auth, t.stageId, A, C, 0, 0);
    await genericResult(t.auth, t.stageId, B, C, 0, 0);
    await recomputeStandings(t.auth.orgId, t.stageId);
    const before = await draws(t.stageId);
    expect(before.map((d) => d.members_key), "premise: {B, C} drawn, once").toEqual([membersKeyOf([B, C])]);

    // D leaves having played one of three: the league expunges D's matches (ruling 105) — A's win over D leaves the
    // table, and A is level with B and C.
    const out = await withdrawEntrantCascade(t.auth, D);
    expect(out.policy, "premise: an early withdrawal expunges").toBe("expunge");
    const ad = await between(t.stageId, A, D);
    const abandons = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${ad.id} and type = 'core.abandon' and payload ->> 'expunge' = 'true'`;
    expect(abandons[0]!.n, "premise: A-D is expunged").toBe(1);
    const rows = await recomputeStandings(t.auth.orgId, t.stageId);
    const after = await draws(t.stageId);
    const old = after.find((d) => d.id === before[0]!.id)!;
    const fresh = after.filter((d) => d.id !== before[0]!.id);
    expect(fresh.map((d) => d.members_key), "a new draw for the new tied set").toEqual([membersKeyOf([A, B, C])]);
    expect(old.superseded_at, "the old draw is kept, superseded").not.toBeNull();
    expect(old.drawn_order, "history is kept as drawn").toEqual(before[0]!.drawn_order);
    expect(fresh[0]!.superseded_at).toBeNull();
    expect(orderIn(rows, [A, B, C]), "the table ranks the new set by its stored order").toEqual(fresh[0]!.drawn_order);
  }, 240_000);

  it("a tied set that comes back after a wider one ranks by its FIRST draw and stores nothing new ({A,B} → {A,B,C,D} → {A,B})", async () => {
    const t = await started();
    const [A, B, C, D] = t.entrants as [string, string, string, string];
    await genericResult(t.auth, t.stageId, A, B, 0, 0);
    await recomputeStandings(t.auth.orgId, t.stageId);
    const one = await draws(t.stageId);
    const ab = one.find((d) => d.members_key === membersKeyOf([A, B]));
    expect(ab, "premise: {A, B} drawn").toBeDefined();
    // C and D draw too: all four level (one point each, nothing scored, a drawn head-to-head each)
    await genericResult(t.auth, t.stageId, C, D, 0, 0);
    await recomputeStandings(t.auth.orgId, t.stageId);
    const two = await draws(t.stageId);
    const wide = two.find((d) => d.members_key === membersKeyOf([A, B, C, D]));
    expect(wide, "the wider set is drawn").toBeDefined();
    expect(two.find((d) => d.id === ab!.id)!.superseded_at, "{A, B} superseded by the wider draw").not.toBeNull();
    // void C-D: back to {A, B}
    const cd = await between(t.stageId, C, D);
    const [res] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${cd.id} and type = 'generic.result'`;
    await post(t.auth, cd.id, "core.void", { event_id: res!.id });
    const rows = await recomputeStandings(t.auth.orgId, t.stageId);
    const three = await draws(t.stageId);
    expect(three.filter((d) => d.members_key === membersKeyOf([A, B])), "no second {A, B} draw").toHaveLength(1);
    expect(three.length, "nothing new stored for the set that came back").toBe(two.length);
    expect(orderIn(rows, [A, B]), "ranked by its first draw").toEqual(ab!.drawn_order);
  }, 240_000);

  it("Review Focus 3: two concurrent recomputes store one draw per (stage, pool, members) and both return its order", async () => {
    const t = await started();
    const [A, B, C, D] = t.entrants as [string, string, string, string];
    await genericResult(t.auth, t.stageId, A, C, 1, 0);
    await genericResult(t.auth, t.stageId, B, D, 1, 0);
    // the writes above recomputed already; start from an unstored tie
    await sql`delete from stage_lots_draws where stage_id = ${t.stageId}`;
    const [r1, r2] = await Promise.all([recomputeStandings(t.auth.orgId, t.stageId), recomputeStandings(t.auth.orgId, t.stageId)]);
    const stored = await draws(t.stageId);
    expect(stored.map((d) => d.members_key).sort()).toEqual([membersKeyOf([A, B]), membersKeyOf([C, D])].sort());
    expect(r1).toEqual(r2);
    for (const d of stored) expect(orderIn(r1, d.members)).toEqual(d.drawn_order);

    // The writer itself, raced with no lock between: the second insert waits on the first's uncommitted row, finds it
    // on commit, and stores nothing; both then read the first's order.
    await sql`delete from stage_lots_draws where stage_id = ${t.stageId}`;
    const members = [A, B];
    const mine = { membersKey: membersKeyOf(members), members, drawnOrder: [A, B], seed: 1 };
    const theirs = { membersKey: membersKeyOf(members), members, drawnOrder: [B, A], seed: 2 };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = sql.begin(async (tx) => {
      await persistLotsDraws(tx, t.stageId, null, [mine]);
      await held; // committed only once the second writer is waiting on this row
      return loadLotsDraws(tx, t.stageId);
    });
    // wait until the first row exists (uncommitted), then start the second writer
    for (let i = 0; i < 100; i++) {
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where state = 'idle in transaction' and query ilike '%stage_lots_draws%'`;
      if (w!.n > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = sql.begin(async (tx) => {
      await persistLotsDraws(tx, t.stageId, null, [theirs]);
      return loadLotsDraws(tx, t.stageId);
    });
    let waited = false;
    for (let i = 0; i < 100 && !waited; i++) {
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%insert into stage_lots_draws%'`;
      waited = w!.n > 0;
      if (!waited) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waited, "premise: the second writer waited on the first's row").toBe(true);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.get("")?.get(mine.membersKey)?.order, "the first writer's order").toEqual(mine.drawnOrder);
    expect(b.get("")?.get(mine.membersKey)?.order, "the racing writer reads the first's order").toEqual(mine.drawnOrder);
    const live = await draws(t.stageId);
    expect(live, "one stored draw").toHaveLength(1);
    expect(live[0]!.drawn_order).toEqual(mine.drawnOrder);
  }, 180_000);

  it("X-TB-4 rank_lock at completion carries the stored order and the stored drawn_at (the DB's now(), read back — PS-5b), not a JS clock", async () => {
    const t = await started();
    // every match 0-0: all four level through the whole order — one draw of the four
    for (const f of await seatedFixtures(t.stageId)) await genericResult(t.auth, t.stageId, f.home, f.away, 0, 0);
    const [status] = await sql<{ status: string }[]>`select status from stages where id = ${t.stageId}`;
    if (status!.status !== "complete") await completeStage(t.auth, t.stageId);
    const stored = await draws(t.stageId);
    // the four were level in intermediate tables too; the draw that orders them is their set's newest stored row
    const used = servedDraw(stored, membersKeyOf(t.entrants));
    expect(used, "the four are drawn").toBeDefined();
    const live = [used!];
    const locks = await sql<{ payload: { order: string[]; drawnAt: string; group: string[]; method: string } }[]>`
      select payload from division_events where division_id = ${t.divisionId} and type = 'rank_lock' order by seq`;
    expect(locks, "one rank_lock").toHaveLength(1);
    const lock = locks[0]!.payload;
    expect(lock.method).toBe("lots");
    expect(lock.order, "the stored order").toEqual(live[0]!.drawn_order);
    expect(lock.drawnAt, "the stored drawn_at, as the DB prints it").toBe(live[0]!.drawn_at);
    // microseconds: the DB's clock, never a JS Date (which prints milliseconds and a `Z`)
    expect(lock.drawnAt).toMatch(/\.\d{6}\+00:00$/);
    const [snap] = await sql<{ rows: { entrantId: string }[] }[]>`select rows from standings_snapshots where stage_id = ${t.stageId} and pool_id is null`;
    expect(snap!.rows.map((r) => r.entrantId), "the final snapshot is the stored order").toEqual(live[0]!.drawn_order);
  }, 240_000);

  it("T7 m9: persistLotsDraws refuses a draw naming an entrant twice, a members key that is not its members', and an order of other entrants — and stores a well-formed one", async () => {
    const t = await started();
    const [A, B, C] = t.entrants as [string, string, string];
    // Each bad draw breaks ONE rule and passes the other two, so each guard is witnessed by its own refusal (a duplicate
    // whose order also repeats would be caught by the order check and leave the duplicate guard untested).
    const BAD = [
      { why: "names an entrant twice", draw: { membersKey: membersKeyOf([A, A, B]), members: [A, A, B], drawnOrder: [B, A], seed: 1 } },
      { why: "carries a members key that is not its members'", draw: { membersKey: membersKeyOf([A, C]), members: [A, B], drawnOrder: [B, A], seed: 1 } },
      { why: "orders entrants other than its members", draw: { membersKey: membersKeyOf([A, B]), members: [A, B], drawnOrder: [A, C], seed: 1 } },
    ];
    let refused = 0;
    for (const bad of BAD) {
      const err = await sql.begin((tx) => persistLotsDraws(tx, t.stageId, null, [bad.draw])).catch((e: unknown) => e);
      expect(EngineError.is(err), `${bad.why}: ${String(err)}`).toBe(true);
      expect(err, bad.why).toMatchObject({ code: "CONFIG_INVALID", data: { reason: "lots_draw_invalid" } });
      expect((err as Error).message, "refused for its own reason").toContain(bad.why);
      refused++;
    }
    expect(refused).toBe(BAD.length);
    expect(await draws(t.stageId), "nothing stored").toEqual([]);
    await sql.begin((tx) => persistLotsDraws(tx, t.stageId, null, [{ membersKey: membersKeyOf([A, B]), members: [B, A], drawnOrder: [B, A], seed: 1 }]));
    expect((await draws(t.stageId)).map((d) => d.members_key), "the positive pair stores").toEqual([membersKeyOf([A, B])]);
  }, 120_000);
});
