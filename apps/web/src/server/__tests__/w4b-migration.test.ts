// W4 knockout app PR B, Task 6 (Q8, ruling 270; X-FR-5, X-FR-4 history half) - the delta that re-ranks a FINISHED knockout's two
// semi-final losers to a shared 3rd. The delta is read by GLOB, never by number (it is renumbered at merge), and its OWN text
// runs here inside a rolled-back transaction on a dedicated client (it acts on the whole shared test DB; a committed run would
// rewrite sibling suites' rows). Every assertion reads this test's own stage.
//
// Seeding: a real bracket is played and completed through the usecases (so the stored snapshot is W4's (engine 5+): the ENGINE's own places,
// the oracle), then its snapshot is put back to the pre-W4 shape the delta exists for - strict 1..n, the semi-final loser of the
// larger seed 4th (RB4-S7 / Q1) - inside the rolled-back transaction.
// single-sport: badminton - the delta reads rank, outcome and round columns, no sport field.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions } from "@/lib/db";
import { bracketPlaceLabels } from "@/lib/bracket-places";
import { playBadminton, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { completeStage } from "@/server/usecases/stages";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w4_shared_third_history\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");
async function rolledBack<T>(body: (tx: Tx, notices: string[]) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema }, onnotice: (n) => notices.push(String(n.message)) });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx, notices);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

describe("W4 delta V496: the file", () => {
  it("exactly one delta carries the name; it is LOUD, quotes prod's count, counts before it writes and is a single DO block", () => {
    expect(files, "one delta named *__w4_shared_third_history.sql").toHaveLength(1);
    expect(text).toMatch(/DATA CHANGE \(LOUD\)/);
    expect(text).toMatch(/4 of 9 finished knockouts re-rank \(2 x 4-draw, 2 x 8-draw; the 5 final-only brackets are untouched; 3 of the 4 sit in\s+-- completed competitions\)/);
    expect(text.indexOf("1. Count first"), "counts precede the write").toBeLessThan(text.indexOf("2. Write"));
    expect(text, "the stg 'complete, no snapshot' line is LOUD").toMatch(/complete with no standings snapshot: skipped/);
    expect(text.match(/^do \$\$/gm)?.length).toBe(1);
  });
});

interface Snap { rows: { entrantId: string; rank?: number; [k: string]: unknown }[]; previous_rows: unknown; computed_through_seq: string; updated_at: Date }
interface Finished { stageId: string; places: { entrantId: string; rank: number }[]; losers: string[] }

async function finished(entrants: number, thirdPlace = false): Promise<Finished> {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants, ...(thirdPlace ? { stageConfig: { thirdPlace: true } } : {}) });
  for (let guard = 0; guard < 30; guard++) {
    const next = (await rowsOf(s.stageId)).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null);
    if (next === undefined) break;
    await playBadminton(s.auth, next.id, true);
  }
  const done = await completeStage(s.auth, s.stageId);
  expect(done.completed, "rig: the bracket completed").toBe(true);
  const ev = done.events.find((e) => e.type === "stage_completed") as unknown as { places: { entrantId: string; rank: number }[] };
  const rows = await rowsOf(s.stageId);
  const non3p = rows.filter((r) => r.ext_key !== null && !r.ext_key.endsWith("-3p"));
  const last = Math.max(...non3p.map((r) => r.round_no));
  const losers = non3p.filter((r) => r.round_no === last - 1 && r.outcome?.winner).map((r) => (r.outcome!.winner === r.home_entrant_id ? r.away_entrant_id! : r.home_entrant_id!)).sort();
  return { stageId: s.stageId, places: ev.places, losers };
}

const snapOf = async (tx: Tx, stageId: string): Promise<Snap> =>
  (await tx<Snap[]>`select rows, previous_rows, computed_through_seq::text, updated_at from standings_snapshots where stage_id = ${stageId} and pool_id is null`)[0]!;
const ranksOf = (s: Snap) => Object.fromEntries(s.rows.map((r) => [r.entrantId, r.rank]));

/** The pre-W4 shape: the semi-final loser of the larger seed ranked 4th, the rest as W4 stored them (pre-W4 was strict 1..n). */
async function downgradeTo3x(tx: Tx, f: Finished): Promise<void> {
  const seeds = await tx<{ id: string; seed: number }[]>`select id, seed from entrants where id in ${tx(f.losers)}`;
  const worse = [...seeds].sort((a, b) => b.seed - a.seed)[0]!.id;
  await tx`update standings_snapshots set rows = (select jsonb_agg(case when r->>'entrantId' = ${worse} then jsonb_set(r, '{rank}', '4'::jsonb) else r end order by ord) from jsonb_array_elements(rows) with ordinality t(r, ord)) where stage_id = ${f.stageId} and pool_id is null`;
}
/** Runs the delta; the notices it raised and the rows it reported changed. */
async function run(tx: Tx, notices: string[]): Promise<{ changed: number; notices: string[] }> {
  const from = notices.length;
  await tx.unsafe(text);
  const mine = notices.slice(from);
  const line = mine.find((n) => /snapshot\(s\) re-ranked/.test(n));
  return { changed: Number(line?.match(/: (\d+) snapshot/)?.[1] ?? NaN), notices: mine };
}

describe.runIf(HAS_DB)("W4 delta V496: finished knockouts re-rank to a shared 3rd", () => {
  it("X-FR-5 a finished 8-draw with no third-place match re-ranks its semi-final losers to a shared 3rd - the ranks equal the engine's own, and nothing else moves; a second run changes 0", async () => {
    const f = await finished(8);
    expect(f.places.filter((p) => p.rank === 3).length, "premise: the engine ranks the two semi-final losers level").toBe(2);
    const v = await rolledBack(async (tx, notices) => {
      await downgradeTo3x(tx, f);
      const before = await snapOf(tx, f.stageId);
      const first = await run(tx, notices);
      const after = await snapOf(tx, f.stageId);
      const second = await run(tx, notices);
      const again = await snapOf(tx, f.stageId);
      return { before, first, after, second, again };
    });
    expect(Object.values(ranksOf(v.before)).sort(), "premise: the seeded snapshot is the pre-W4 strict shape").toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.first.changed, "at least this stage").toBeGreaterThanOrEqual(1);
    const want = Object.fromEntries(f.places.map((p) => [p.entrantId, p.rank])); // R9: the engine is the oracle
    expect(ranksOf(v.after)).toEqual(want);
    // nothing but the rank: row order, every other key, previous_rows, the watermark and updated_at
    expect(v.after.rows.map((r) => r.entrantId)).toEqual(v.before.rows.map((r) => r.entrantId));
    expect(v.after.rows.map(({ rank: _r, ...rest }) => rest)).toEqual(v.before.rows.map(({ rank: _r, ...rest }) => rest));
    expect(v.after.previous_rows).toEqual(v.before.previous_rows);
    expect(v.after.computed_through_seq).toBe(v.before.computed_through_seq);
    expect(v.after.updated_at).toEqual(v.before.updated_at);
    expect(v.first.notices.some((n) => /to re-rank to a shared 3rd/.test(n)), "the delta is LOUD").toBe(true);
    // the sequence: a second run changes nothing (this stage is no longer a candidate)
    expect(v.second.changed).toBe(0);
    expect(v.again).toEqual(v.after);
    // X-FR-4 history: the readers' own helper now reads two shared 3rds off the migrated rows
    const labels = bracketPlaceLabels(v.after.rows as { entrantId: string; rank?: number }[]);
    expect([...labels].filter(([, l]) => l.shared).map(([id]) => id).sort()).toEqual(f.losers);
  }, 480_000);

  it("X-FR-5 a 4-draw (two semi-finals, a final) re-ranks too", async () => {
    const f = await finished(4);
    const v = await rolledBack(async (tx, notices) => {
      await downgradeTo3x(tx, f);
      await run(tx, notices);
      return snapOf(tx, f.stageId);
    });
    expect(ranksOf(v)).toEqual(Object.fromEntries(f.places.map((p) => [p.entrantId, p.rank])));
    expect(Object.values(ranksOf(v)).sort()).toEqual([1, 2, 3, 3]);
  }, 240_000);

  it("X-FR-5 a played third-place match keeps 3rd and 4th", async () => {
    const f = await finished(8, true);
    expect(f.places.map((p) => p.rank).sort(), "premise: the play-off decided 3rd and 4th").toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const v = await rolledBack(async (tx, notices) => {
      const before = await snapOf(tx, f.stageId);
      await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId) };
    });
    expect(v.after).toEqual(v.before);
  }, 480_000);

  it("X-FR-5 a VOIDED third-place line shares 3rd (m1: the engine ranks a voided play-off level, X-TP-3) - the delta re-ranks it", async () => {
    const shared = await finished(8);
    const f = await finished(8, true);
    const v = await rolledBack(async (tx, notices) => {
      // the play-off never ran: its line holds nobody and has no outcome; the snapshot is the pre-W4 seed split
      await tx`update fixtures set home_entrant_id = null, away_entrant_id = null, outcome = null, status = 'scheduled' where stage_id = ${f.stageId} and (third_place or ext_key like '%-3p')`;
      const before = await snapOf(tx, f.stageId);
      await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId) };
    });
    expect(Object.values(ranksOf(v.before)).sort(), "premise: the snapshot is the 3rd/4th split").toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // R9: the engine's own places for a no-play-off 8-draw are the oracle for the SHAPE; the two 3rds are this bracket's semi-final losers
    expect(Object.values(ranksOf(v.after)).sort()).toEqual(shared.places.map((p) => p.rank).sort());
    expect(v.after.rows.filter((r) => r.rank === 3).map((r) => r.entrantId).sort()).toEqual(f.losers);
  }, 480_000);

  it("X-FR-5 a semi-final settled by an abandon award (V432: abandoned counts as decided) re-ranks too (m2)", async () => {
    const f = await finished(4);
    const v = await rolledBack(async (tx, notices) => {
      await downgradeTo3x(tx, f);
      await tx`update fixtures set status = 'abandoned' where id = (select id from fixtures where stage_id = ${f.stageId} and round_no = (select max(round_no) - 1 from fixtures where stage_id = ${f.stageId}) order by seq_in_round limit 1)`;
      await run(tx, notices);
      return snapOf(tx, f.stageId);
    });
    expect(Object.values(ranksOf(v)).sort()).toEqual([1, 2, 3, 3]);
  }, 240_000);

  it("X-FR-5 a snapshot already shared (a completion after the bump) is skipped: the empty arm", async () => {
    const f = await finished(8);
    const v = await rolledBack(async (tx, notices) => {
      const before = await snapOf(tx, f.stageId);
      const r = await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId), r };
    });
    expect(v.after).toEqual(v.before);
    expect(ranksOf(v.after)).toEqual(Object.fromEntries(f.places.map((p) => [p.entrantId, p.rank])));
  }, 480_000);

  it("X-FR-5 n=3 (one real semi-final) is untouched", async () => {
    const f = await finished(3);
    expect(f.places.map((p) => p.rank).sort(), "premise: ranks 1, 2, 3").toEqual([1, 2, 3]);
    const v = await rolledBack(async (tx, notices) => {
      const before = await snapOf(tx, f.stageId);
      await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId) };
    });
    expect(v.after).toEqual(v.before);
  }, 240_000);

  it("X-FR-5 a finished 2-entrant knockout (final only) keeps ranks 1, 2 - V496 touches nothing, and says so (11-07 ruling)", async () => {
    const f = await finished(2);
    expect(f.places.map((p) => p.rank).sort(), "premise: ranks 1, 2").toEqual([1, 2]);
    const v = await rolledBack(async (tx, notices) => {
      const before = await snapOf(tx, f.stageId);
      const r = await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId), r };
    });
    expect(v.after).toEqual(v.before);
    const line = v.r.notices.find((n) => /final-only/.test(n));
    expect(Number(line?.match(/: (\d+) final-only/)?.[1]), "the final-only brackets are counted, this one included").toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("X-FR-5 a semi-final double walkover is untouched (no loser: the engine's strict-block call)", async () => {
    const f = await finished(4);
    const v = await rolledBack(async (tx, notices) => {
      await downgradeTo3x(tx, f);
      const semi = (await tx<{ id: string }[]>`select id from fixtures where stage_id = ${f.stageId} and round_no = (select max(round_no) - 1 from fixtures where stage_id = ${f.stageId}) order by seq_in_round limit 1`)[0]!;
      await tx`update fixtures set status = 'forfeited', outcome = ${tx.json({ kind: "double_walkover" } as never)} where id = ${semi.id}`;
      const before = await snapOf(tx, f.stageId);
      await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId) };
    });
    expect(Object.values(ranksOf(v.before)).sort(), "premise: still the strict pre-W4 shape").toEqual([1, 2, 3, 4]);
    expect(v.after).toEqual(v.before);
  }, 240_000);

  it("X-FR-5 a corrupted snapshot whose rank-4 row is not a semi-final loser is untouched", async () => {
    const f = await finished(8);
    const v = await rolledBack(async (tx, notices) => {
      await downgradeTo3x(tx, f);
      // swap the 4th with the 5th: the rank-4 holder is now a quarter-final loser
      const snap = await snapOf(tx, f.stageId);
      const four = snap.rows.find((r) => r.rank === 4)!.entrantId;
      const five = snap.rows.find((r) => r.rank === 5)!.entrantId;
      await tx`update standings_snapshots set rows = (select jsonb_agg(case when r->>'entrantId' = ${four} then jsonb_set(r, '{rank}', '5'::jsonb) when r->>'entrantId' = ${five} then jsonb_set(r, '{rank}', '4'::jsonb) else r end order by ord) from jsonb_array_elements(rows) with ordinality t(r, ord)) where stage_id = ${f.stageId} and pool_id is null`;
      const before = await snapOf(tx, f.stageId);
      await run(tx, notices);
      return { before, after: await snapOf(tx, f.stageId) };
    });
    expect(v.after).toEqual(v.before);
  }, 480_000);

  it("X-FR-5 a table stage, a stepladder, a page playoff and a double-elim are untouched (counted, 4)", async () => {
    const f = await finished(4);
    let checked = 0;
    await rolledBack(async (tx, notices) => {
      await downgradeTo3x(tx, f);
      for (const kind of ["league", "double_elim", "stepladder", "page_playoff"]) {
        await tx`update stages set kind = ${kind} where id = ${f.stageId}`;
        const before = await snapOf(tx, f.stageId);
        await run(tx, notices);
        expect(await snapOf(tx, f.stageId), kind).toEqual(before);
        checked++;
      }
    });
    expect(checked).toBe(4);
  }, 240_000);

  it("X-FR-5 a complete knockout with no standings snapshot is skipped, and the delta says so (stg's one)", async () => {
    const f = await finished(4);
    const v = await rolledBack(async (tx, notices) => {
      await tx`delete from standings_snapshots where stage_id = ${f.stageId}`;
      const r = await run(tx, notices);
      return { r, none: (await tx`select 1 from standings_snapshots where stage_id = ${f.stageId}`).length };
    });
    expect(v.none, "the delta wrote no snapshot").toBe(0);
    const line = v.r.notices.find((n) => /no standings snapshot: skipped/.test(n));
    expect(Number(line?.match(/: (\d+) complete/)?.[1]), "this stage is counted in the skipped line").toBeGreaterThanOrEqual(1);
  }, 240_000);
});
