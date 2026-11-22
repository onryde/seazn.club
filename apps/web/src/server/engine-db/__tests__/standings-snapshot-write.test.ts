// W5 follow-ups B6 (perf-measure-report S5 fix 2(b)): a refold wrote every pool's snapshot with its own upsert, each one
// replacing the stored table whether it had changed or not - 26 statements per result for a 26-pool group, under the division
// lock. The refold now sends ONE statement for the stage, and a pool whose table did not change keeps its stored table (its
// `rows` and `previous_rows` are left as they are); only its watermark moves, so `GET /stages/{id}/standings` still reads every
// pool as folded through the division's latest seq.
//
// Real Postgres; results through `scoreEvent`, whose own refold is the write under test. The statement count is read from the
// driver's statement log (`statementTexts`), the expected tables from the stored rows before the write.
// single-sport (generic): the write is sport-blind.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql, statementTexts } from "@/lib/db";
import { startDivision } from "@/server/usecases/schedule";
import { generateStageFixtures } from "@/server/usecases/stages";
import { recomputeStandings } from "../competition";
import { genericResult, seatedFixtures, tableScene } from "./helpers/w2d-table-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Snap {
  pool_id: string | null;
  rows: unknown;
  previous_rows: unknown;
  seq: string;
  updated_at: string;
}
const snaps = async (stageId: string) =>
  new Map(
    (
      await sql<Snap[]>`
        select pool_id, rows, previous_rows, computed_through_seq::text as seq, to_json(updated_at) #>> '{}' as updated_at
          from standings_snapshots where stage_id = ${stageId}`
    ).map((s) => [s.pool_id, s]),
  );
const divisionSeq = async (divisionId: string) => (await sql<{ seq: string }[]>`select seq::text as seq from divisions where id = ${divisionId}`)[0]!.seq;

/** Snapshot writes sent while `run` ran. */
async function snapshotWrites(run: () => Promise<unknown>): Promise<number> {
  const before = statementTexts().length;
  await run();
  return statementTexts()
    .slice(before)
    .filter((t) => /insert\s+into\s+standings_snapshots/i.test(t)).length;
}

async function groups(pools: number) {
  const s = await tableScene({ entrants: pools * 3, stages: { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: pools } } } as never });
  const stageId = s.stageIds[0]!;
  await generateStageFixtures(s.auth, stageId);
  await startDivision(s.auth, s.divisionId);
  const byPool = await sql<{ id: string; pool_id: string; home: string; away: string }[]>`
    select id, pool_id, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
  return { ...s, stageId, fixtures: byPool };
}

describe.skipIf(!HAS_DB)("B6 a refold writes the stage's snapshots in one statement and rewrites only the tables that changed", () => {
  it("a result in one of four groups: one snapshot write; the other three keep their tables and move their watermark", async () => {
    const g = await groups(4);
    expect(new Set(g.fixtures.map((f) => f.pool_id)).size, "premise: four pools").toBe(4);
    const [f1, f2] = g.fixtures.filter((f) => f.pool_id === g.fixtures[0]!.pool_id);
    expect(f2, "premise: the pool has a second line").toBeDefined();
    await genericResult(g.auth, g.stageId, f1!.home, f1!.away, 2, 0);
    const before = await snaps(g.stageId);
    expect(before.size, "premise: every pool has a stored table").toBe(4);

    const writes = await snapshotWrites(() => genericResult(g.auth, g.stageId, f2!.home, f2!.away, 2, 0));
    expect(writes, "one snapshot write for the stage, not one per pool").toBe(1);

    const after = await snaps(g.stageId);
    const seq = await divisionSeq(g.divisionId);
    let unchanged = 0;
    for (const [pool, was] of before) {
      const now = after.get(pool)!;
      expect(now.seq, `pool ${pool}: folded through the division's latest seq`).toBe(seq);
      if (pool === f1!.pool_id) {
        expect(now.rows, "the played pool's table moved").not.toEqual(was.rows);
        expect(now.previous_rows, "a result rolls the played pool's previous table").toEqual(was.rows);
      } else {
        expect(now.rows, `pool ${pool}: table kept`).toEqual(was.rows);
        expect(now.previous_rows, `pool ${pool}: previous table kept`).toEqual(was.previous_rows);
        unchanged += 1;
      }
    }
    expect(unchanged, "anti-vacuity: three untouched pools checked").toBe(3);
  }, 240_000);

  it("the sequence and the one-table case: a league refold is one write too, and an idempotent rerun keeps the previous table", async () => {
    const s = await tableScene({ entrants: 4 });
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    const [f] = await seatedFixtures(stageId);
    await genericResult(s.auth, stageId, f!.home, f!.away, 2, 0);
    const first = (await snaps(stageId)).get(null)!;
    const writes = await snapshotWrites(() => recomputeStandings(s.auth.orgId, stageId, undefined, { cause: "result" }));
    expect(writes).toBe(1);
    const again = (await snaps(stageId)).get(null)!;
    expect(again.rows, "unchanged results, unchanged table").toEqual(first.rows);
    expect(again.previous_rows, "an idempotent rerun never rolls the previous table").toEqual(first.previous_rows);
  }, 240_000);
});
