// V546 (Seazn-hosted video, Phase 3, Task 29): `fixture_video_delivery`, one row per Seazn session holding the minutes viewers
// watched of it — live (Cloudflare analytics) and replay (Bunny statistics) — each with the last day it was measured through, so
// the daily pass (Task 31) never counts a day twice. The minutes are `numeric(12,1)`: tenths of a minute, up to 99,999,999,999.9.
// The session is `on delete restrict`: a measured session cannot vanish under the cost record (and with it, since sessions
// cascade from their org, neither can the org). RLS is V430's pattern: enable + force, no policy, no grant to app_user.
//
// The expected shape is typed here from the plan (Task 29), never read off the migration. Each refusal has its accepted twin in
// the same `it`, so an empty schema cannot pass (AGENTS.md class 3): the twin fails with "relation does not exist" first. Real
// Postgres required for the schema half; skipped without DATABASE_URL like every DB suite here. The text half runs everywhere.
// Sport-agnostic (a session row is the same for every sport), so no registry sweep: the rig's default sport stands in for all.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { STREAM_DELTA_FILES, stripSqlComments } from "./_stream-migration";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
const V546 = readdirSync(DELTAS).find((f) => /^V546__.+\.sql$/.test(f));
const V546_SQL = V546 ? stripSqlComments(readFileSync(join(DELTAS, V546), "utf8")) : "";
const TABLE = "fixture_video_delivery";

/** The table's columns, in declaration order, as the plan states them (Task 29). */
const COLUMNS = [
  { column_name: "session_id", data_type: "uuid", numeric_precision: null, numeric_scale: null, is_nullable: "NO", column_default: null },
  { column_name: "org_id", data_type: "uuid", numeric_precision: null, numeric_scale: null, is_nullable: "NO", column_default: null },
  { column_name: "live_minutes", data_type: "numeric", numeric_precision: 12, numeric_scale: 1, is_nullable: "NO", column_default: "0" },
  { column_name: "replay_minutes", data_type: "numeric", numeric_precision: 12, numeric_scale: 1, is_nullable: "NO", column_default: "0" },
  { column_name: "live_measured_through", data_type: "date", numeric_precision: null, numeric_scale: null, is_nullable: "YES", column_default: null },
  { column_name: "replay_measured_through", data_type: "date", numeric_precision: null, numeric_scale: null, is_nullable: "YES", column_default: null },
  { column_name: "updated_at", data_type: "timestamp with time zone", numeric_precision: null, numeric_scale: null, is_nullable: "NO", column_default: "now()" },
] as const;
/** The two minute columns. */
const MINUTES = ["live_minutes", "replay_minutes"] as const;
/** numeric(12,1)'s largest value: eleven integer digits and one decimal. */
const MAX_MINUTES = "99999999999.9";

const failure = async (p: PromiseLike<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    return `${err.code ?? "thrown"}:${err.constraint_name ?? ""}`;
  }
  return "landed";
};
const ROLLBACK = new Error("rollback: probes leave nothing behind");
async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}
/** One statement under a savepoint, so a refusal leaves the surrounding transaction usable for the next probe. */
const probe = (tx: Tx, q: (sp: Tx) => PromiseLike<unknown>): Promise<string> => failure(tx.savepoint((sp) => q(sp as Tx)));

/** An org, a started fixture and `n` raw ended sessions on it, written inside `tx`. */
async function sessions(tx: Tx, n = 1): Promise<{ orgId: string; sessionIds: string[] }> {
  const { auth } = await seedOrg();
  const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
  const fixtureId = fixtureIds[0]!;
  const [t] = await tx<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'youtube', 'V546', ${Buffer.from("not-a-real-envelope")}) returning id`;
  const sessionIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const [s] = await tx<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override, ended_at)
      select f.id, ${auth.orgId}, 'passthrough', 'completed', ${t!.id}, ${randomUUID()}, d.sport_key, d.competition_id, f.division_id, true, now()
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
      returning id`;
    sessionIds.push(s!.id);
  }
  expect(sessionIds.length, "PREMISE: the rig made the sessions asked for").toBe(n);
  return { orgId: auth.orgId, sessionIds };
}

describe("V546: the migration text", () => {
  it("exists, is in the stream fold (its name says seazn), creates the table, and enables AND forces RLS on it with no policy or grant", () => {
    expect(V546, "V546's delta file").toBeDefined();
    expect(STREAM_DELTA_FILES, "the fold reads V546, so rls-static and migration-shape scan its table").toContain(V546);
    expect(V546_SQL).toMatch(new RegExp(`^create table ${TABLE} \\(`, "m"));
    expect(V546_SQL).toMatch(new RegExp(`alter table ${TABLE}\\s+enable\\s+row level security;`));
    expect(V546_SQL).toMatch(new RegExp(`alter table ${TABLE}\\s+force\\s+row level security;`));
    expect(V546_SQL).not.toMatch(/create policy/i);
    expect(V546_SQL).not.toMatch(/grant /i);
  });
});

describe.skipIf(!HAS_DB)("V546: the schema", () => {
  it("the table has the plan's seven columns, in order: the minutes numeric(12,1) not null default 0, the measured-through days nullable dates", async () => {
    const cols = await sql<Record<string, unknown>[]>`
      select column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
        from information_schema.columns
       where table_schema = current_schema() and table_name = ${TABLE} order by ordinal_position`;
    expect(cols).toEqual(COLUMNS.map((c) => ({ ...c })));
    expect(cols.length, "columns checked").toBe(7);
  });

  it("the primary key is session_id alone; the one foreign key is session_id → fixture_stream_sessions, ON DELETE RESTRICT", async () => {
    const keys = await sql<{ type: string; cols: string[]; target: string | null; del: string }[]>`
      select c.contype as type,
             array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k order by a.attname)::text[] as cols,
             case when c.contype = 'f' then c.confrelid::regclass::text end as target, c.confdeltype as del
        from pg_constraint c
       where c.conrelid = ${TABLE}::regclass and c.contype in ('p','f')
       order by c.contype desc`;
    expect(keys.map((k) => ({ ...k, target: k.target?.replace(/^.*\./, "") ?? null }))).toEqual([
      { type: "p", cols: ["session_id"], target: null, del: " " },
      { type: "f", cols: ["session_id"], target: "fixture_stream_sessions", del: "r" },
    ]);
  });

  it("a fresh row is the empty measurement: zero minutes, measured through no day, stamped now; a second row for one session is refused (23505), one for another session lands", async () => {
    await rolledBack(async (tx) => {
      const { orgId, sessionIds: [a, b] } = await sessions(tx, 2);
      expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id) values (${a!}, ${orgId})`), "the first row").toBe("landed");
      const [fresh] = await tx<Record<string, unknown>[]>`
        select live_minutes::text as live, replay_minutes::text as replay, live_measured_through, replay_measured_through,
               updated_at = now() as stamped_now
          from fixture_video_delivery where session_id = ${a!}`;
      expect(fresh).toEqual({ live: "0.0", replay: "0.0", live_measured_through: null, replay_measured_through: null, stamped_now: true });
      expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id) values (${a!}, ${orgId})`), "the same session again")
        .toBe(`23505:${TABLE}_pkey`);
      expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id) values (${b!}, ${orgId})`), "another session").toBe("landed");
    });
  });

  it("each minute column holds tenths: a value is rounded to one decimal, the maximum lands, one more integer digit is refused (22003), and null is refused (23502)", async () => {
    let checked = 0;
    await rolledBack(async (tx) => {
      const { orgId, sessionIds: [sid] } = await sessions(tx, 1);
      await tx`insert into fixture_video_delivery (session_id, org_id) values (${sid!}, ${orgId})`;
      const set = (sp: Tx, col: string, v: string | null) => sp`update fixture_video_delivery set ${sp(col)} = ${v}::numeric where session_id = ${sid!}`;
      const read = async (col: string) => (await tx<{ v: string }[]>`select ${tx(col)}::text as v from fixture_video_delivery where session_id = ${sid!}`)[0]!.v;
      for (const col of MINUTES) {
        // Task 31's worked example: 12.5 + 3 live minutes is stored as 15.5.
        for (const [given, stored] of [["15.5", "15.5"], ["15.55", "15.6"], ["15.54", "15.5"], ["0.04", "0.0"], [MAX_MINUTES, MAX_MINUTES]] as const) {
          expect(await probe(tx, (sp) => set(sp, col, given)), `${col} = ${given}`).toBe("landed");
          expect(await read(col), `${col} = ${given} is stored as`).toBe(stored);
          checked++;
        }
        expect(await probe(tx, (sp) => set(sp, col, "100000000000")), `${col}: twelve integer digits`).toBe("22003:");
        expect(await probe(tx, (sp) => set(sp, col, null)), `${col} = null`).toBe(`23502:`);
        checked += 2;
      }
    });
    expect(checked, "minute probes run (seven per column)").toBe(7 * MINUTES.length);
  });

  // Controller ruling 2026-11-23: a minute count is never negative, so a negative analytics answer is refused by the schema,
  // by a constraint NAMED for its column (the refusal says which reading was wrong).
  it("neither minute column holds a negative: -0.1 and -15.5 are refused by that column's own constraint (23514), on insert and update; 0 lands", async () => {
    let checked = 0;
    await rolledBack(async (tx) => {
      const { orgId, sessionIds: [a, b] } = await sessions(tx, 2);
      await tx`insert into fixture_video_delivery (session_id, org_id) values (${a!}, ${orgId})`;
      for (const col of MINUTES) {
        const constraint = `${TABLE}_${col}_nonnegative`;
        // The accepted twin first: zero is a real measurement (nobody watched).
        expect(await probe(tx, (sp) => sp`update fixture_video_delivery set ${sp(col)} = 0 where session_id = ${a!}`), `${col} = 0`).toBe("landed");
        for (const v of ["-0.1", "-15.5"]) {
          expect(await probe(tx, (sp) => sp`update fixture_video_delivery set ${sp(col)} = ${v}::numeric where session_id = ${a!}`), `update ${col} = ${v}`)
            .toBe(`23514:${constraint}`);
          expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id, ${sp(col)}) values (${b!}, ${orgId}, ${v}::numeric)`), `insert ${col} = ${v}`)
            .toBe(`23514:${constraint}`);
          checked += 2;
        }
      }
    });
    expect(checked, "negative probes run (four per column)").toBe(4 * MINUTES.length);
  });

  it("org_id is required (23502); a session that does not exist is refused (23503)", async () => {
    await rolledBack(async (tx) => {
      const { orgId, sessionIds: [sid] } = await sessions(tx, 1);
      expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id) values (${sid!}, null)`), "no org").toBe("23502:");
      expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id) values (${randomUUID()}, ${orgId})`), "an unknown session")
        .toBe(`23503:${TABLE}_session_id_fkey`);
      expect(await probe(tx, (sp) => sp`insert into fixture_video_delivery (session_id, org_id) values (${sid!}, ${orgId})`), "the real session").toBe("landed");
    });
  });

  it("a measured session cannot be deleted, nor its org (the session cascade meets RESTRICT, 23503); with the row gone, both deletes land", async () => {
    await rolledBack(async (tx) => {
      const { orgId, sessionIds: [sid] } = await sessions(tx, 1);
      await tx`insert into fixture_video_delivery (session_id, org_id, live_minutes) values (${sid!}, ${orgId}, 15.5)`;
      expect(await probe(tx, (sp) => sp`delete from fixture_stream_sessions where id = ${sid!}`), "the session").toBe(`23503:${TABLE}_session_id_fkey`);
      expect(await probe(tx, (sp) => sp`delete from organizations where id = ${orgId}`), "its org").toBe(`23503:${TABLE}_session_id_fkey`);
      await tx`delete from fixture_video_delivery where session_id = ${sid!}`;
      expect(await probe(tx, (sp) => sp`delete from fixture_stream_sessions where id = ${sid!}`), "the session, unmeasured").toBe("landed");
      expect(await probe(tx, (sp) => sp`delete from organizations where id = ${orgId}`), "its org, unmeasured").toBe("landed");
    });
  });

  it("RLS is enabled AND forced with no policy, and app_user holds nothing on the table", async () => {
    const [row] = await sql<{ rls: boolean; forced: boolean; policies: number }[]>`
      select c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname = ${TABLE}`;
    expect(row).toEqual({ rls: true, forced: true, policies: 0 });
    const granted = async (rel: string) => (await sql<{ ok: boolean }[]>`
      select (has_table_privilege('app_user', ${rel}::text, 'select') or has_table_privilege('app_user', ${rel}::text, 'insert')
           or has_table_privilege('app_user', ${rel}::text, 'update') or has_table_privilege('app_user', ${rel}::text, 'delete')) as ok`)[0]!.ok;
    expect(await granted("public_fixtures_v"), "the probe must be able to see a grant").toBe(true);
    expect(await granted(TABLE), `app_user must hold nothing on ${TABLE}`).toBe(false);
  });
});
