// W5 app-A Task 5 — V526 (`entrants.table_waiting_stage_id`, plus its LOUD backfill). Read by GLOB, never by number (deltas are
// renumbered at merge). The schema half is read from the live catalogue; the backfill's own UPDATE runs here inside a rolled-back
// transaction on a dedicated client — it acts on the whole shared test DB, and a committed run would rewrite sibling suites' rows.
// Every assertion reads this test's own rows, so a sibling suite's rows cannot answer it.
//
// Expected values: the controller's ruling (2026-11-16) and RB5-L1/L8 — only an entrant still in the field, seated in none of the
// lines of a RUNNING root league or group of a started division, is flagged; a finished table takes no one; a fed table, a seated
// entrant, a departed one and a division not yet started are left alone.
//
// single-sport: badminton — the delta reads stage kind/seq/status/progression/config, division status, entrant status and fixture
// seats; no sport field.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions, sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../../db/migration/deltas");
const NAME = /^V\d+__w5_table_waiting\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a check meant for the SQL. */
const code = text.replace(/--.*$/gm, "").trim();
const statements = code.split(";").map((s) => s.trim()).filter((s) => s !== "");

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema } });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

describe("W5 delta V526: the file", () => {
  it("exactly one delta carries the name; it is LOUD, quotes the census, and is the column, its index and one UPDATE of entrants", () => {
    expect(files, "one delta named *__w5_table_waiting.sql").toHaveLength(1);
    expect(text, "the header announces the data change").toMatch(/DATA CHANGE \(LOUD\)/);
    expect(text, "the header quotes the pre-flight count").toMatch(/stg 4 rows/);
    expect(statements, "alter + index + backfill").toHaveLength(3);
    expect(statements[0]).toMatch(/^alter table entrants add column if not exists table_waiting_stage_id uuid/);
    expect(statements[1]).toMatch(/^create index if not exists entrants_table_waiting_stage_idx/);
    expect(statements[2]).toMatch(/^update entrants e/);
  });
});

describe.skipIf(!HAS_DB)("W5 delta V526: the column", () => {
  it("entrants.table_waiting_stage_id exists, is a nullable uuid, references stages with on delete set null, and is indexed", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable from information_schema.columns
       where table_schema = current_schema() and table_name = 'entrants' and column_name = 'table_waiting_stage_id'`;
    expect(col, "the column exists").toEqual({ data_type: "uuid", is_nullable: "YES" });
    const fks = await sql<{ target: string; on_delete: string }[]>`
      select c.confrelid::regclass::text as target, c.confdeltype::text as on_delete
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.contype = 'f' and c.conrelid = 'entrants'::regclass and a.attname = 'table_waiting_stage_id'`;
    expect(fks.map((f) => ({ target: f.target.replace(/^.*\./, ""), on_delete: f.on_delete })), "one FK to stages, set null").toEqual([
      { target: "stages", on_delete: "n" },
    ]);
    const [idx] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where schemaname = current_schema() and indexname = 'entrants_table_waiting_stage_idx'`;
    expect(idx?.def).toMatch(/where \(table_waiting_stage_id is not null\)/i);
  });

  it("deleting the stage nulls the marker (on delete set null, the storage table's cleanup)", async () => {
    const r = await rig("league", { start: true });
    const late = await rawEntrant(r.divisionId, "Waiting");
    await sql`update entrants set table_waiting_stage_id = ${r.stageId} where id = ${late}`;
    await sql`delete from fixtures where stage_id = ${r.stageId}`;
    await sql`delete from stages where id = ${r.stageId}`;
    const [row] = await sql<{ w: string | null }[]>`select table_waiting_stage_id as w from entrants where id = ${late}`;
    expect(row).toEqual({ w: null });
  });
});

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  seated: string;
}

/** A badminton division of four seeded entrants and one stage (`kind`, seq 1 unless `behind` puts a double elimination first). */
async function rig(kind: "league" | "group", opts: { start: boolean; behind?: boolean }): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 V526 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  let seq = 1;
  if (opts.behind) await createStages(auth, d.id, { seq: seq++, kind: "double_elim", name: "Double", config: {}, progression: null });
  const [stage] = await createStages(auth, d.id, {
    seq,
    kind,
    name: "Table",
    config: kind === "group" ? { legs: 1, pools: { count: 1 } } : { legs: 1 },
    progression: null,
  });
  if (opts.start) await startDivision(auth, d.id);
  return { auth, divisionId: d.id, stageId: stage!.id, seated: es[0]!.id };
}

/** An entrant written straight to the table — no admission ran: the stranded shape the backfill exists for. */
async function rawEntrant(divisionId: string, name: string, status = "confirmed"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, status) values (${divisionId}, 'individual', ${name}, ${status}) returning id`;
  return row!.id;
}

describe.skipIf(!HAS_DB)("W5 delta V526: the LOUD backfill", () => {
  it("flags a seatless entrant of a running root table; leaves the complete, fed, unstarted, seated and departed ones alone", async () => {
    const league = await rig("league", { start: true });
    const group = await rig("group", { start: true });
    const complete = await rig("league", { start: true });
    await sql`update stages set status = 'complete' where id = ${complete.stageId}`;
    const fed = await rig("league", { start: true, behind: true });
    const unstarted = await rig("league", { start: false });

    const flagged = [await rawEntrant(league.divisionId, "L late"), await rawEntrant(group.divisionId, "G late", "registered")];
    const expectStage = [league.stageId, group.stageId];
    const untouched = [
      await rawEntrant(complete.divisionId, "complete"), // RB5-L8: a finished table takes no one
      await rawEntrant(fed.divisionId, "behind a bracket"), // not the entry stage
      await rawEntrant(unstarted.divisionId, "pre-Start"), // Generate reconciles before Start
      await rawEntrant(league.divisionId, "withdrawn", "withdrawn"), // left the field
      league.seated, // already plays in the table
    ];
    const ids = [...flagged, ...untouched];
    const stmt = statements[2]!;
    const after = await rolledBack(async (tx) => {
      await tx.unsafe(stmt);
      return tx<{ id: string; w: string | null }[]>`select id, table_waiting_stage_id as w from entrants where id in ${tx(ids)}`;
    });
    const byId = new Map(after.map((r) => [r.id, r.w]));
    expect(flagged.map((id) => byId.get(id)), "the two stranded entrants wait on their table").toEqual(expectStage);
    expect(untouched.map((id) => byId.get(id)), "nobody else is flagged").toEqual(untouched.map(() => null));
    expect(after, "anti-vacuity: every row was read back").toHaveLength(ids.length);

    // Idempotent: a second run over an already-flagged row changes nothing (it touches only rows still null).
    const twice = await rolledBack(async (tx) => {
      await tx.unsafe(stmt);
      const second = await tx.unsafe(stmt);
      return second.count;
    });
    expect(twice, "the second run flags nothing new among this test's rows or any other").toBe(0);
  });
});
