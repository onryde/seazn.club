// W5 follow-ups B6 (perf-measure-report S5 fix 2(a)): a standings refold read EVERY lots draw the stage had ever stored, on
// every result write, under the division lock - for a Swiss 500, thousands of rows (most superseded) and megabytes of member
// lists. The refold now reads the live draws (bounded by the table: a pool's live draws are disjoint) and then only the tie
// sets it asks for.
//
// Every scene is real Postgres and real results through `scoreEvent`; the planted history is rows a refold could have
// stored (member sets of the stage's own entrants, superseded). The count of rows read is taken at the loader seam (every
// `load*LotsDraws` export of engine-db/table-rules, wrapped to count what it returns), and the bound comes from the ENGINE:
// ranking the stage with no stored draw at all hands back one provisional draw per tie set lots must order, which is
// exactly the set of keys a refold can need. The order is checked by ranking the same stage the old way - every draw read -
// and comparing tables (a differential oracle, not a copy of the code under test).
// single-sport (generic): the store is sport-blind; what is read is decided by the tie sets, not by a sport's scoring.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTableStage, membersKeyOf } from "@seazn/engine/competition";
import { sql, statementTexts } from "@/lib/db";
import { startDivision } from "@/server/usecases/schedule";
import { generateStageFixtures } from "@/server/usecases/stages";
import { recomputeStandings } from "../competition";
import { loadStageInputs, toTableStage } from "../competition/stage-inputs";
import { loadLiveLotsDraws, loadLotsDraws, loadLotsDrawsFor } from "../table-rules";
import { between, genericResult, tableScene } from "./helpers/w2d-table-rig";
import { post } from "@/server/usecases/__tests__/_groups-ko-scene";

const HAS_DB = !!process.env.DATABASE_URL;

/** Rows handed back by any lots-draw loader while `on`, and how many loader calls there were. */
const reads = vi.hoisted(() => ({ on: false, rows: 0, calls: 0 }));
vi.mock("@/server/engine-db/table-rules", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const out: Record<string, unknown> = { ...real };
  for (const [name, fn] of Object.entries(real)) {
    if (typeof fn !== "function" || !/^load\w*LotsDraws/.test(name)) continue;
    out[name] = async (...args: unknown[]) => {
      const byPool = await (fn as (...a: unknown[]) => Promise<ReadonlyMap<string, ReadonlyMap<string, unknown>>>)(...args);
      if (reads.on) {
        reads.calls += 1;
        for (const byKey of byPool.values()) reads.rows += byKey.size;
      }
      return byPool;
    };
  }
  return out;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

beforeEach(() => {
  reads.on = false;
  reads.rows = 0;
  reads.calls = 0;
});

async function started(entrants: number) {
  const s = await tableScene({ entrants });
  const stageId = s.stageIds[0]!;
  await generateStageFixtures(s.auth, stageId);
  await startDivision(s.auth, s.divisionId);
  return { ...s, stageId };
}

const storedCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${stageId}`)[0]!.n;
const liveCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${stageId} and superseded_at is null`)[0]!.n;

/** Every member set of 2..4 of the stage's entrants that has no stored row yet, stored as superseded history (drawn two hours
 *  ago, superseded one hour ago) - the shape a Swiss stage's store reaches after a few rounds. */
async function plantHistory(orgId: string, stageId: string, entrants: readonly string[]): Promise<number> {
  const have = new Set((await sql<{ k: string }[]>`select members_key as k from stage_lots_draws where stage_id = ${stageId}`).map((r) => r.k));
  const sets: string[][] = [];
  const n = entrants.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const ids = entrants.filter((_, i) => mask & (1 << i));
    if (ids.length >= 2 && ids.length <= 4 && !have.has(membersKeyOf([...ids].sort()))) sets.push([...ids].sort());
  }
  for (const ids of sets) {
    await sql`
      insert into stage_lots_draws (org_id, stage_id, pool_id, members_key, members, drawn_order, seed, drawn_at, superseded_at)
      values (${orgId}, ${stageId}, null, ${membersKeyOf(ids)}, ${ids}::uuid[], ${[...ids].reverse()}::uuid[], 7,
              now() - interval '2 hours', now() - interval '1 hour')`;
  }
  return sets.length;
}

/** The tie sets lots orders in the stage as it stands: ranked with NO stored draw, the engine names every one it would draw. */
async function lotsSets(stageId: string): Promise<number> {
  const inputs = await loadStageInputs(sql as never, stageId);
  return completeTableStage(toTableStage(inputs, new Map()), inputs.tableFixtures).newLotsDraws.length;
}

/** The stage ranked the old way: every stored draw read, newest per key - or the draws given (read before a write). */
async function rankedByEveryDraw(stageId: string, draws?: Awaited<ReturnType<typeof loadLotsDraws>>) {
  const inputs = await loadStageInputs(sql as never, stageId);
  const { tables } = completeTableStage(toTableStage(inputs, draws ?? (await loadLotsDraws(sql, stageId))), inputs.tableFixtures);
  return tables.pools.flatMap((p) => p.rows);
}

async function refoldCounted(orgId: string, stageId: string) {
  reads.on = true;
  const rows = await recomputeStandings(orgId, stageId);
  reads.on = false;
  return rows;
}

describe.skipIf(!HAS_DB)("B6 a refold reads the live draws and the tie sets it ranks, never the stage's whole draw history", () => {
  it("with hundreds of superseded draws stored, a refold reads at most the live draws plus its own tie sets, and ranks as the whole-history read does", async () => {
    const t = await started(8);
    const [A, B, C, D] = t.entrants as [string, string, string, string];
    await genericResult(t.auth, t.stageId, A, B, 0, 0);
    await genericResult(t.auth, t.stageId, C, D, 0, 0);
    const planted = await plantHistory(t.auth.orgId, t.stageId, t.entrants);
    expect(planted, "premise: a long history is stored").toBeGreaterThanOrEqual(150);
    const sets = await lotsSets(t.stageId);
    expect(sets, "premise: lots orders at least one tie set, so the refold ranks by stored draws").toBeGreaterThan(0);
    const live = await liveCount(t.stageId);
    const before = await storedCount(t.stageId);
    // Review M6: the oracle is ranked BEFORE the refold writes, from every draw stored then - read after, it would agree with
    // whatever the refold had just stored (a refold re-drawing a known tie set read as correct).
    const expected = await rankedByEveryDraw(t.stageId);

    const rows = await refoldCounted(t.auth.orgId, t.stageId);
    expect(reads.calls, "anti-vacuity: the refold read lots draws through the loaders").toBeGreaterThan(0);
    expect(reads.rows, `read at most ${live} live + 2 x ${sets} asked rows, of ${before} stored`).toBeLessThanOrEqual(live + 2 * sets);
    expect(reads.rows, "never the history").toBeLessThan(planted);
    expect(rows.length, "anti-vacuity: a table came back").toBe(8);
    expect(await storedCount(t.stageId), "every tie set it ranks was drawn before: the refold stores no new draw").toBe(before);
    expect(rows, "the same table the whole-history read ranked before the refold").toEqual(expected);
  }, 240_000);

  it("the sequence: a second refold stores nothing new, reads as little, and ranks the same; a further result moves the table and still reads only its tie sets", async () => {
    const t = await started(8);
    const [A, B, C, D, E, F] = t.entrants as [string, string, string, string, string, string];
    await genericResult(t.auth, t.stageId, A, B, 0, 0);
    const planted = await plantHistory(t.auth.orgId, t.stageId, t.entrants);
    const first = await refoldCounted(t.auth.orgId, t.stageId);
    const afterFirst = await storedCount(t.stageId);

    reads.rows = 0;
    const live = await liveCount(t.stageId);
    const again = await refoldCounted(t.auth.orgId, t.stageId);
    expect(again, "unchanged results, unchanged table").toEqual(first);
    expect(await storedCount(t.stageId), "nothing new stored").toBe(afterFirst);
    expect(reads.rows, "a refold of an unchanged table reads its live draws only").toBeLessThanOrEqual(live);

    await genericResult(t.auth, t.stageId, C, D, 0, 0);
    await genericResult(t.auth, t.stageId, E, F, 1, 0);
    const sets = await lotsSets(t.stageId);
    const live3 = await liveCount(t.stageId);
    const stored3 = await storedCount(t.stageId);
    const expected3 = await rankedByEveryDraw(t.stageId); // before the write (review M6)
    reads.rows = 0;
    const third = await refoldCounted(t.auth.orgId, t.stageId);
    expect(reads.rows).toBeLessThanOrEqual(live3 + 2 * sets);
    expect(reads.rows).toBeLessThan(planted);
    expect(await storedCount(t.stageId), "the results' own refolds drew every set: this one stores nothing").toBe(stored3);
    expect(third, "the same table the whole-history read ranked before the refold").toEqual(expected3);
  }, 240_000);

  it("a tie set that comes back after a split is served its own earlier draw, never drawn again (review M6)", async () => {
    // The branch the live read cannot cover: A-B 0-0 draws {A, B} and {C, D}; B-C 0-0 then ties {A, C}, whose draw supersedes
    // both (a stored draw that intersects a new one is superseded, `persistLotsDraws`); voiding B-C brings {A, B} and {C, D}
    // back - the first pass names them, and the refold must serve the draws it made before, never draw them again.
    const t = await started(4);
    const [A, B, C, D] = t.entrants as [string, string, string, string];
    await genericResult(t.auth, t.stageId, A, B, 0, 0);
    await genericResult(t.auth, t.stageId, B, C, 0, 0);
    const cdRows = await sql<{ superseded: boolean }[]>`
      select superseded_at is not null as superseded from stage_lots_draws
       where stage_id = ${t.stageId} and members_key in (${membersKeyOf([C, D])}, ${membersKeyOf([A, B])})`;
    const f = await between(t.stageId, B, C);
    const [result] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${f.id} and type = 'generic.result' order by seq desc limit 1`;
    const drawsBefore = await loadLotsDraws(sql, t.stageId); // the oracle's draws, read before any write below
    const storedBefore = await storedCount(t.stageId);
    if (cdRows.length === 0) {
      // Neither set was drawn before the split (nothing to come back): the branch is unreachable in this scene - fail loudly.
      expect(cdRows.length, "premise: {A, B} and {C, D} were drawn before the split").toBeGreaterThan(0);
    }
    expect(cdRows.length, "premise: both sets were drawn").toBe(2);
    expect(cdRows.every((r) => r.superseded), "premise: {A, C}'s draw superseded both, so the live read cannot cover them").toBe(true);

    await post(t.auth, f.id, "core.void", { event_id: result!.id }); // the tie comes back; this write refolds
    const rows = await refoldCounted(t.auth.orgId, t.stageId);
    expect(rows.length, "anti-vacuity: a table came back").toBe(4);
    expect(await storedCount(t.stageId), "the returning set is served its stored draw: nothing new is stored").toBe(storedBefore);
    expect(rows, "the table the draws stored BEFORE the void rank").toEqual(await rankedByEveryDraw(t.stageId, drawsBefore));
  }, 240_000);

  it("both refold reads find their rows through stage_lots_draws_stage_key (V541), never a scan of every stage's draws", async () => {
    // The statements explained are the loaders' own, as the driver sent them (`statementTexts`), planned GENERIC (no value bound).
    // Sequential scans are off so the answer does not depend on how many rows the test table holds; the pin is that the index on
    // (stage_id, md5(members_key)) serves the md5 condition - the expression the statement and the index must share.
    const t = await started(4);
    const [A, B] = t.entrants as [string, string];
    await genericResult(t.auth, t.stageId, A, B, 0, 0);
    type PlanRow = { "QUERY PLAN": string };
    const plans = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const from = statementTexts().length;
      await loadLiveLotsDraws(tx as never, t.stageId);
      await loadLotsDrawsFor(tx as never, t.stageId, [membersKeyOf([A, B])]);
      const sent = statementTexts().slice(from).filter((s) => /from stage_lots_draws/.test(s));
      const out: string[] = [];
      for (const text of sent) out.push((await tx.unsafe<PlanRow[]>(`explain (generic_plan) ${text}`)).map((r) => r["QUERY PLAN"]).join("\n"));
      return out;
    });
    expect(plans.length, "anti-vacuity: both loaders' statements were explained").toBe(2);
    for (const plan of plans) {
      expect(plan, plan).toMatch(/stage_lots_draws_stage_key/);
      expect(plan, plan).toMatch(/Index Cond: \(\(stage_id = \$1\) AND \(md5\(members_key\) = ANY/);
    }
  }, 120_000);

  it("the empty case: a stage with no result reads no draw and stores none", async () => {
    const t = await started(4);
    const rows = await refoldCounted(t.auth.orgId, t.stageId);
    expect(rows.length, "anti-vacuity: every entrant has a row").toBe(4);
    expect(reads.rows).toBe(0);
    expect(await storedCount(t.stageId)).toBe(0);
  }, 120_000);
});
