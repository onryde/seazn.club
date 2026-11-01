// R4 sponsors on stream, S3: the stream tables' constraints are only real if something tries to violate them
// (AGENTS.md class 3). Every refusal names its CONSTRAINT, not just its SQLSTATE, and sits beside its accepted twin in
// the same `it` (TEST-STRATEGY: a negative assertion owes its positive pair), so a test that passes on an EMPTY schema
// cannot exist — the twin fails first with "relation does not exist".
//
// Expected values are the spec's / brief's literals (§4 sets, R16's delete rules, R7's alphabet rule) or a declared
// constant (SPONSOR_TIERS, SPONSOR_SHORT_CODE_*), never read back from the migration. Real Postgres required (skipped
// without DATABASE_URL like every DB suite under src/server).
//
// Rows are written on the privileged `sql` client (the overlay read path, the relay heartbeat and the /s/ redirect all
// write there); the tenant reads go through `withTenant`, which drops to app_user.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant, type Tx } from "@/lib/db";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";
import {
  SPONSOR_SHORT_CODE_ALPHABET,
  SPONSOR_SHORT_CODE_MAX_LENGTH,
  SPONSOR_SHORT_CODE_MIN_LENGTH,
  SPONSOR_SHORT_CODE_PATTERN,
} from "@/lib/sponsor-short-code";
import type { AuthCtx } from "@/server/api-v1/auth";
import { SponsorTier as ApiSponsorTier } from "@/server/api-v1/schemas";
import { CreateSponsorInput, SPONSOR_TIERS as USECASE_TIERS, createSponsor, deleteSponsor } from "@/server/usecases/sponsors";
import { rigUser, streamRig } from "@/server/relay/__tests__/_session-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec / brief literals ----------------------------------------------------------------------------------------
/** The seven TENANT tables V483 creates (brief S3 + the coordinator's R7 addition). */
const NEW_TABLES = [
  "sponsor_stream_settings", "sponsor_assignments", "sponsor_airings", "sponsor_airing_frames",
  "sponsor_clicks", "sponsor_report_links", "sponsor_short_codes",
] as const;
/** And its one SEALED table (S9 review m8): the frame objects whose rows went — no org, no policy, no grant. */
const SEALED_TABLES = ["sponsor_frame_tombstones"] as const;
/** The R4 delta, found by SUFFIX, never by number (final review m1): a renumber before merge is then a pure `git mv`. */
const DELTAS_DIR = resolve(__dirname, "../../../../../../db/migration/deltas");
const SPONSOR_ROTATION_DELTA = /^V\d+__sponsor_rotation\.sql$/;
const V483_MATCHES = readdirSync(DELTAS_DIR).filter((f) => SPONSOR_ROTATION_DELTA.test(f));
const V483_FILE = resolve(DELTAS_DIR, V483_MATCHES[0] ?? "the-sponsor-rotation-delta-is-missing.sql");
/** Tables the console writes under withTenant (S12 settings PUT, S13 create/revoke a link). */
const TENANT_WRITTEN = new Set<string>(["sponsor_stream_settings", "sponsor_report_links"]);
const FREQUENCIES = ["light", "normal", "busy"];
const ASSIGNMENT_SOURCES = ["rotation", "operator"];
const AIRING_SOURCES = ["rotation", "scene", "operator"];
const STYLES = ["lower_third", "banner"];
const CLICK_SOURCES = ["match", "stream", "site", "unknown"];
/** Every FK whose parent the app deletes (a sponsor, a fixture, a session, a competition). Each delete walks it, so each
 *  has an index led by that column (V483 header). */
const WALKED_FKS = [
  "sponsor_stream_settings.competition_id",
  "sponsor_assignments.fixture_id", "sponsor_assignments.sponsor_id",
  "sponsor_airings.sponsor_id", "sponsor_airings.fixture_id", "sponsor_airings.session_id",
  "sponsor_airing_frames.session_id",
  "sponsor_clicks.sponsor_id", "sponsor_clicks.fixture_id",
  "sponsor_report_links.sponsor_id", "sponsor_report_links.competition_id",
  "sponsor_short_codes.sponsor_id", "sponsor_short_codes.fixture_id",
];
/** Unindexed by design: organizations and users are deleted rarely and by staff, and each such delete scans a table once. */
const UNINDEXED_PARENTS = new Set(["organizations", "users"]);
/** F6: Connect stores no viewer counts, so the airing carries none of these. */
const F6_DROPPED = ["viewers", "video_id", "youtube_refreshed_at"];

const uniq = () => randomUUID().slice(0, 8);
/** `n` random characters from the R7 alphabet: short codes are a GLOBAL primary key, so a fixed literal would collide
 *  on a second run against a long-lived database. */
const randomCode = (n: number): string =>
  [...randomBytes(n)].map((b) => SPONSOR_SHORT_CODE_ALPHABET[b % SPONSOR_SHORT_CODE_ALPHABET.length]).join("");

// ---- rig ----------------------------------------------------------------------------------------------------------
interface World {
  orgId: string;
  auth: AuthCtx;
  fixtureIds: string[];
  competitionId: string;
  session(fixtureId: string): Promise<string>;
}

async function world(): Promise<World> {
  const r = await streamRig({ fixtures: 2 });
  const [c] = await sql<{ competition_id: string }[]>`
    select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${r.fixtureIds[0]!}`;
  return {
    orgId: r.orgId,
    auth: { orgId: r.orgId, via: "session", userId: null, role: "owner", keyId: null },
    fixtureIds: r.fixtureIds,
    competitionId: c!.competition_id,
    session: (fixtureId) => r.session(fixtureId, "live"),
  };
}

async function sponsor(w: Pick<World, "orgId">, name = `Acme ${uniq()}`): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into sponsors (org_id, name) values (${w.orgId}, ${name}) returning id`;
  return row!.id;
}

async function emptyCompetition(w: Pick<World, "orgId">): Promise<string> {
  const slug = `sp-${uniq()}`;
  const [row] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${w.orgId}, 'Sponsor Cup', ${slug}) returning id`;
  return row!.id;
}

type AssignmentOpts = {
  fixture: string; moment?: string; sponsor?: string | null; source: string; position: number | null; style?: string;
  /** The assign-time name snapshot (S5 writes it). `null` sends an explicit NULL, to reach the NOT NULL. */
  name?: string | null;
};
function assignment(w: Pick<World, "orgId">, o: AssignmentOpts) {
  return sql`
    insert into sponsor_assignments (fixture_id, moment_id, org_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style, hold_ms)
    values (${o.fixture}, ${o.moment ?? `m-${uniq()}`}, ${w.orgId}, 7, ${o.sponsor ?? null}, ${o.name === undefined ? "Acme" : o.name},
            ${o.position}, ${o.source}, 'over_end', ${o.style ?? "lower_third"}, 8000)`;
}

type AiringOpts = { sponsor: string | null; name?: string; fixture: string | null; session: string | null; moment?: string; source?: string; style?: string };
async function airing(w: Pick<World, "orgId">, o: AiringOpts): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style, started_at)
    values (${w.orgId}, ${o.sponsor}, ${o.name ?? "Acme"}, ${o.fixture}, ${o.session}, ${o.moment ?? `m-${uniq()}`},
            ${o.source ?? "rotation"}, 'over_end', ${o.style ?? "lower_third"}, now())
    returning id`;
  return row!.id;
}

function frame(w: Pick<World, "orgId">, session: string, moment: string, path = `frames/${uniq()}.jpg`) {
  return sql`insert into sponsor_airing_frames (session_id, moment_id, org_id, path) values (${session}, ${moment}, ${w.orgId}, ${path})`;
}

async function click(w: Pick<World, "orgId">, o: { sponsor: string; fixture: string | null; source?: string }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source) values (${w.orgId}, ${o.sponsor}, ${o.fixture}, ${o.source ?? "stream"})
    returning id`;
  return row!.id;
}

async function reportLink(
  w: Pick<World, "orgId">,
  o: { sponsor: string; competition?: string | null; from?: string; to?: string; hash?: Buffer; createdBy?: string | null },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_report_links (org_id, sponsor_id, competition_id, from_date, to_date, token_hash, created_by)
    values (${w.orgId}, ${o.sponsor}, ${o.competition ?? null}, ${o.from ?? "2026-01-01"}, ${o.to ?? "2026-12-31"},
            ${o.hash ?? randomBytes(32)}, ${o.createdBy ?? null})
    returning id`;
  return row!.id;
}

async function shortCode(w: Pick<World, "orgId">, o: { code?: string; sponsor: string; fixture: string | null }): Promise<string> {
  const code = o.code ?? randomCode(SPONSOR_SHORT_CODE_MAX_LENGTH);
  await sql`insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id) values (${code}, ${w.orgId}, ${o.sponsor}, ${o.fixture})`;
  return code;
}

async function settings(w: Pick<World, "orgId">, competition: string | null, extra: { frequency?: string; updatedBy?: string } = {}): Promise<string> {
  const [row] = extra.frequency === undefined
    ? await sql<{ id: string }[]>`
        insert into sponsor_stream_settings (org_id, competition_id, updated_by) values (${w.orgId}, ${competition}, ${extra.updatedBy ?? null})
        returning id`
    : await sql<{ id: string }[]>`
        insert into sponsor_stream_settings (org_id, competition_id, frequency) values (${w.orgId}, ${competition}, ${extra.frequency})
        returning id`;
  return row!.id;
}

const refusedBy = (code: string, constraint: string) => ({ code, constraint_name: constraint });

/** Every FK the new tables declare, its parent, and whether some index LEADS with it and serves the parent delete's
 *  `col = $1`: a whole-table index, or a partial one whose predicate is exactly that column's `is not null` (S3 carry: a
 *  partial index with any other predicate - `where source = 'site'` - does not serve the delete, so it does not count). */
function fkIndexes(tx: typeof sql | Tx) {
  return tx<{ tbl: string; col: string; parent: string; cols: number; indexed: boolean }[]>`
    select t.relname as tbl, a.attname as col, p.relname as parent, cardinality(c.conkey) as cols,
           exists (select 1 from pg_index i
                    where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
                      and (i.indpred is null
                           or pg_get_expr(i.indpred, i.indrelid) = '(' || quote_ident(a.attname) || ' IS NOT NULL)')) as indexed
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_class p on p.oid = c.confrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and n.nspname = current_schema() and t.relname in ${tx(NEW_TABLES as unknown as string[])}`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

// ---- the tier authority (no DB needed for the identity half) -------------------------------------------------------
describe("the tier list has one authority (F10)", () => {
  it("usecases/sponsors.ts re-exports the lib's list — the same array, not a copy", () => {
    expect(USECASE_TIERS).toBe(SPONSOR_TIERS);
  });

  it("the API schema's tier enum lists the same tiers", () => {
    expect([...ApiSponsorTier.options]).toEqual([...SPONSOR_TIERS]);
  });
});

describe.skipIf(!HAS_DB)("V483 sponsors on stream — the constraints are real", () => {
  it("SPONSOR_TIERS equals every tier CHECK's set, read from information_schema (one authority; count reported)", async () => {
    const checks = await sql<{ table_name: string; check_clause: string }[]>`
      select ccu.table_name, cc.check_clause
        from information_schema.check_constraints cc
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_schema = cc.constraint_schema and ccu.constraint_name = cc.constraint_name
       where cc.constraint_schema = current_schema()
         and ccu.table_name in ('sponsors', 'sponsor_packages') and ccu.column_name = 'tier'
         -- PG18 lists NOT NULL as a check too; only the value checks are the tier authority's.
         and cc.check_clause not like '%IS NOT NULL'`;
    // V283 declares one on each table: sponsors.tier and sponsor_packages.tier.
    expect(checks.map((c) => c.table_name).sort(), "tier checks found").toEqual(["sponsor_packages", "sponsors"]);
    for (const c of checks) {
      const values = [...c.check_clause.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      expect(values.sort(), c.table_name).toEqual([...SPONSOR_TIERS].sort());
    }
  });

  it("an existing sponsor reads on_stream = false (greenfield, no backfill): the column is boolean NOT NULL default false, and the real producer leaves it off", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'sponsors' and column_name = 'on_stream'`;
    expect(col).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const w = await world();
    const created = await createSponsor(w.auth, CreateSponsorInput.parse({ name: "Acme Fresh" }));
    const [row] = await sql<{ on_stream: boolean }[]>`select on_stream from sponsors where id = ${created.id}`;
    expect(row!.on_stream).toBe(false);
    // The positive twin: the column takes `true` (the S12 tick).
    await sql`update sponsors set on_stream = true where id = ${created.id}`;
    const [after] = await sql<{ on_stream: boolean }[]>`select on_stream from sponsors where id = ${created.id}`;
    expect(after!.on_stream).toBe(true);
  });

  // ---- sponsor_stream_settings ------------------------------------------------------------------------------------
  it("one settings row per (org, null competition) and per (org, competition); another org has its own", async () => {
    const w = await world();
    const other = await world();
    await expect(settings(w, null)).resolves.toBeTruthy();
    await expect(settings(w, null)).rejects.toMatchObject(refusedBy("23505", "sponsor_stream_settings_scope_key"));
    await expect(settings(w, w.competitionId)).resolves.toBeTruthy();
    await expect(settings(w, w.competitionId)).rejects.toMatchObject(refusedBy("23505", "sponsor_stream_settings_scope_key"));
    await expect(settings(other, null)).resolves.toBeTruthy();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_stream_settings where org_id = ${w.orgId}`;
    expect(n!.n).toBe(2);
  });

  it("a settings row written with only its scope is OFF at Normal — R12's first tick must say enabled = true itself", async () => {
    const w = await world();
    const id = await settings(w, null);
    const [row] = await sql<{ enabled: boolean; frequency: string }[]>`select enabled, frequency from sponsor_stream_settings where id = ${id}`;
    expect(row).toEqual({ enabled: false, frequency: "normal" });
  });

  it("R12's first-tick upsert on the org row: a second call updates the one row, never adds a second (nulls not distinct is the arbiter)", async () => {
    const w = await world();
    const tick = () => sql`
      insert into sponsor_stream_settings (org_id, competition_id, enabled, frequency) values (${w.orgId}, null, true, 'normal')
      on conflict (org_id, competition_id) do update set enabled = excluded.enabled, updated_at = now()`;
    await tick();
    await tick();
    const rows = await sql<{ enabled: boolean; frequency: string }[]>`
      select enabled, frequency from sponsor_stream_settings where org_id = ${w.orgId} and competition_id is null`;
    expect(rows).toEqual([{ enabled: true, frequency: "normal" }]);
  });

  it("frequency is light | normal | busy: each accepted, anything else refused by name (count reported)", async () => {
    const w = await world();
    let accepted = 0;
    for (const f of FREQUENCIES) {
      // One competition each: (org, competition) is unique, so every accepted value needs a scope of its own.
      await expect(settings(w, await emptyCompetition(w), { frequency: f }), f).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(3);
    await expect(settings(w, null, { frequency: "hectic" })).rejects.toMatchObject(refusedBy("23514", "sponsor_stream_settings_frequency_check"));
  });

  it("deleting a competition deletes its settings row and keeps the org row; deleting the editor nulls updated_by", async () => {
    const w = await world();
    const comp = await emptyCompetition(w);
    const user = await rigUser();
    const orgRow = await settings(w, null, { updatedBy: user });
    const compRow = await settings(w, comp);
    await sql`delete from competitions where id = ${comp}`;
    expect(await sql`select 1 from sponsor_stream_settings where id = ${compRow}`).toHaveLength(0);
    await sql`delete from users where id = ${user}`;
    const [row] = await sql<{ updated_by: string | null }[]>`select updated_by from sponsor_stream_settings where id = ${orgRow}`;
    expect(row).toEqual({ updated_by: null });
  });

  // ---- sponsor_assignments ----------------------------------------------------------------------------------------
  it("a second assignment for the same (fixture, moment) is refused; two rotation rows of one org cannot share a position", async () => {
    const w = await world();
    const other = await world();
    const [f1, f2] = w.fixtureIds as [string, string];
    const moment = `m-${uniq()}`;
    await expect(assignment(w, { fixture: f1, moment, source: "rotation", position: 1 })).resolves.toBeTruthy();
    await expect(assignment(w, { fixture: f1, moment, source: "rotation", position: 2 })).rejects.toMatchObject(refusedBy("23505", "sponsor_assignments_pkey"));
    // Same moment id on ANOTHER fixture is a different break.
    await expect(assignment(w, { fixture: f2, moment, source: "rotation", position: 2 })).resolves.toBeTruthy();
    await expect(assignment(w, { fixture: f2, source: "rotation", position: 1 })).rejects.toMatchObject(refusedBy("23505", "sponsor_assignments_org_position_key"));
    // The position is per ORG: another org's rotation takes position 1 freely.
    await expect(assignment(other, { fixture: other.fixtureIds[0]!, source: "rotation", position: 1 })).resolves.toBeTruthy();
    // Operator rows carry no position, so any number of them coexist in one org.
    await expect(assignment(w, { fixture: f1, source: "operator", position: null })).resolves.toBeTruthy();
    await expect(assignment(w, { fixture: f2, source: "operator", position: null })).resolves.toBeTruthy();
  });

  it("a rotation assignment without a position, or an operator one with a position, is refused (MUTATE: drop sponsor_assignments_position_iff_rotation)", async () => {
    const w = await world();
    const f = w.fixtureIds[0]!;
    await expect(assignment(w, { fixture: f, source: "rotation", position: null })).rejects.toMatchObject(refusedBy("23514", "sponsor_assignments_position_iff_rotation"));
    await expect(assignment(w, { fixture: f, source: "operator", position: 5 })).rejects.toMatchObject(refusedBy("23514", "sponsor_assignments_position_iff_rotation"));
    await expect(assignment(w, { fixture: f, source: "rotation", position: 1 })).resolves.toBeTruthy();
    await expect(assignment(w, { fixture: f, source: "operator", position: null })).resolves.toBeTruthy();
  });

  it("an assignment's source and style are the spec's sets: each accepted, anything else refused by name (counts reported)", async () => {
    const w = await world();
    const f = w.fixtureIds[0]!;
    let checked = 0;
    for (const [i, source] of ASSIGNMENT_SOURCES.entries()) {
      for (const [j, style] of STYLES.entries()) {
        const position = source === "rotation" ? 10 + i * 10 + j : null;
        await expect(assignment(w, { fixture: f, source, position, style }), `${source}/${style}`).resolves.toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBe(ASSIGNMENT_SOURCES.length * STYLES.length);
    await expect(assignment(w, { fixture: f, source: "deal", position: null })).rejects.toMatchObject(refusedBy("23514", "sponsor_assignments_source_check"));
    await expect(assignment(w, { fixture: f, source: "operator", position: null, style: "fullscreen" })).rejects.toMatchObject(refusedBy("23514", "sponsor_assignments_style_check"));
  });

  it("an assignment carries its sponsor's name, snapshotted at assign time: a row without one is refused, a row with one reads it back", async () => {
    const w = await world();
    const f = w.fixtureIds[0]!;
    await expect(assignment(w, { fixture: f, source: "operator", position: null, name: null })).rejects.toMatchObject({ code: "23502", column_name: "sponsor_name" });
    const moment = `m-${uniq()}`;
    await expect(assignment(w, { fixture: f, moment, source: "operator", position: null, name: "Snapshot Ltd" })).resolves.toBeTruthy();
    const [row] = await sql<{ sponsor_name: string }[]>`select sponsor_name from sponsor_assignments where fixture_id = ${f} and moment_id = ${moment}`;
    expect(row).toEqual({ sponsor_name: "Snapshot Ltd" });
  });

  // ---- sponsor_airings / frames -----------------------------------------------------------------------------------
  it("a second airing for the same (session, moment) is refused; the same moment on another session, or another moment, is a new airing", async () => {
    const w = await world();
    const [f1, f2] = w.fixtureIds as [string, string];
    const s1 = await w.session(f1);
    const s2 = await w.session(f2);
    const sp = await sponsor(w);
    const moment = `m-${uniq()}`;
    await expect(airing(w, { sponsor: sp, fixture: f1, session: s1, moment })).resolves.toBeTruthy();
    await expect(airing(w, { sponsor: sp, fixture: f1, session: s1, moment })).rejects.toMatchObject(refusedBy("23505", "sponsor_airings_session_moment_key"));
    await expect(airing(w, { sponsor: sp, fixture: f2, session: s2, moment })).resolves.toBeTruthy();
    await expect(airing(w, { sponsor: sp, fixture: f1, session: s1 })).resolves.toBeTruthy();
  });

  it("an airing's source and style are the spec's sets (counts reported), its flags start false and open, and it has no F6 columns", async () => {
    const w = await world();
    const f = w.fixtureIds[0]!;
    const s = await w.session(f);
    let checked = 0;
    for (const source of AIRING_SOURCES) {
      for (const style of STYLES) {
        await expect(airing(w, { sponsor: null, fixture: f, session: s, source, style }), `${source}/${style}`).resolves.toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBe(AIRING_SOURCES.length * STYLES.length);
    await expect(airing(w, { sponsor: null, fixture: f, session: s, source: "deal" })).rejects.toMatchObject(refusedBy("23514", "sponsor_airings_source_check"));
    await expect(airing(w, { sponsor: null, fixture: f, session: s, style: "fullscreen" })).rejects.toMatchObject(refusedBy("23514", "sponsor_airings_style_check"));
    const id = await airing(w, { sponsor: null, fixture: f, session: s });
    const [row] = await sql<{ ended_at: Date | null; cut_short: boolean; skipped: boolean; ended_estimated: boolean }[]>`
      select ended_at, cut_short, skipped, ended_estimated from sponsor_airings where id = ${id}`;
    expect(row).toEqual({ ended_at: null, cut_short: false, skipped: false, ended_estimated: false });
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'sponsor_airings'`;
    expect(cols.length, "read the airing's columns").toBeGreaterThan(10);
    expect(cols.map((c) => c.column_name).filter((c) => F6_DROPPED.includes(c))).toEqual([]);
  });

  it("a frame may land before its airing row (P4), and one (session, moment) holds one frame", async () => {
    const w = await world();
    const s = await w.session(w.fixtureIds[0]!);
    const moment = `m-${uniq()}`;
    // No airing exists for this moment yet — the frame is posted 1.5 s after `start`, the row comes on the next beat.
    await expect(frame(w, s, moment)).resolves.toBeTruthy();
    await expect(frame(w, s, moment)).rejects.toMatchObject(refusedBy("23505", "sponsor_airing_frames_pkey"));
    await expect(frame(w, s, `m-${uniq()}`)).resolves.toBeTruthy();
  });

  it("S9 carry: one storage object, one row - a path another (session, moment) already names is refused by name; the same row's own replace and a fresh path are not", async () => {
    const w = await world();
    const s = await w.session(w.fixtureIds[0]!);
    const t = await w.session(w.fixtureIds[1]!);
    const path = `frames/${uniq()}.jpg`;
    await expect(frame(w, s, "m1", path)).resolves.toBeTruthy();
    await expect(frame(w, s, "m2", path), "another moment").rejects.toMatchObject(refusedBy("23505", "sponsor_airing_frames_path_key"));
    await expect(frame(w, t, "m1", path), "another session").rejects.toMatchObject(refusedBy("23505", "sponsor_airing_frames_path_key"));
    // The positive pairs: the writer's replace (same row, same path) and a fresh path for the other moment.
    await expect(sql`
      insert into sponsor_airing_frames (session_id, moment_id, org_id, path) values (${s}, 'm1', ${w.orgId}, ${path})
      on conflict (session_id, moment_id) do update set path = excluded.path, created_at = now()`).resolves.toBeTruthy();
    await expect(frame(w, s, "m2")).resolves.toBeTruthy();
  });

  // ---- R16: deletes never take the proof of display with them ------------------------------------------------------
  it("R16: deleting a session that has aired a card succeeds; the airing stays (session null, name kept) and its frame goes", async () => {
    const w = await world();
    const f = w.fixtureIds[0]!;
    const s = await w.session(f);
    const sp = await sponsor(w, "Aired Ltd");
    const moment = `m-${uniq()}`;
    const id = await airing(w, { sponsor: sp, name: "Aired Ltd", fixture: f, session: s, moment });
    await frame(w, s, moment);
    await sql`delete from fixture_stream_sessions where id = ${s}`;
    const [row] = await sql<{ session_id: string | null; fixture_id: string | null; sponsor_name: string }[]>`
      select session_id, fixture_id, sponsor_name from sponsor_airings where id = ${id}`;
    expect(row).toEqual({ session_id: null, fixture_id: f, sponsor_name: "Aired Ltd" });
    expect(await sql`select 1 from sponsor_airing_frames where session_id = ${s}`).toHaveLength(0);
  });

  it("R16: deleting a fixture succeeds; its airing, click and short code stay with fixture null, its assignment goes", async () => {
    const w = await world();
    const [f1, f2] = w.fixtureIds as [string, string];
    const s = await w.session(f1);
    const sp = await sponsor(w, "Fixture Gone");
    const airingId = await airing(w, { sponsor: sp, name: "Fixture Gone", fixture: f1, session: s });
    const clickId = await click(w, { sponsor: sp, fixture: f1 });
    const code = await shortCode(w, { sponsor: sp, fixture: f1 });
    await assignment(w, { fixture: f1, sponsor: sp, source: "rotation", position: 1 });
    // The untouched twin on the other fixture.
    await assignment(w, { fixture: f2, sponsor: sp, source: "rotation", position: 2 });
    await sql`delete from fixtures where id = ${f1}`;
    const [a] = await sql<{ fixture_id: string | null; session_id: string | null; sponsor_name: string }[]>`
      select fixture_id, session_id, sponsor_name from sponsor_airings where id = ${airingId}`;
    expect(a).toEqual({ fixture_id: null, session_id: s, sponsor_name: "Fixture Gone" });
    const [c] = await sql<{ fixture_id: string | null }[]>`select fixture_id from sponsor_clicks where id = ${clickId}`;
    expect(c).toEqual({ fixture_id: null });
    const [k] = await sql<{ fixture_id: string | null }[]>`select fixture_id from sponsor_short_codes where code = ${code}`;
    expect(k).toEqual({ fixture_id: null });
    const left = await sql<{ fixture_id: string }[]>`select fixture_id from sponsor_assignments where org_id = ${w.orgId}`;
    expect(left).toEqual([{ fixture_id: f2 }]);
  });

  it("R16 (revised): deleting a competition deletes the link scoped to it — a scoped bearer link never widens to org-wide — while the same sponsor's org-wide link survives; deleting the author nulls created_by (MUTATE: competition_id back to set null)", async () => {
    const w = await world();
    const comp = await emptyCompetition(w);
    const user = await rigUser();
    const sp = await sponsor(w);
    const scoped = await reportLink(w, { sponsor: sp, competition: comp, createdBy: user });
    const orgWide = await reportLink(w, { sponsor: sp, competition: null, createdBy: user });
    await sql`delete from competitions where id = ${comp}`;
    expect(await sql`select 1 from sponsor_report_links where id = ${scoped}`, "the scoped link").toHaveLength(0);
    await sql`delete from users where id = ${user}`;
    const rows = await sql<{ id: string; competition_id: string | null; created_by: string | null }[]>`
      select id, competition_id, created_by from sponsor_report_links where sponsor_id = ${sp}`;
    expect(rows).toEqual([{ id: orgWide, competition_id: null, created_by: null }]);
  });

  // ---- deleting a sponsor (through the real deleter, as app_user) ---------------------------------------------------
  it("deleting a sponsor sets the airing's and assignment's sponsor_id null and both keep sponsor_name; it deletes its clicks, links and short codes", async () => {
    const w = await world();
    const f = w.fixtureIds[0]!;
    const s = await w.session(f);
    const gone = await sponsor(w, "Gone & Co");
    const kept = await sponsor(w, "Kept plc");
    const airingId = await airing(w, { sponsor: gone, name: "Gone & Co", fixture: f, session: s });
    await assignment(w, { fixture: f, moment: "m-gone", sponsor: gone, name: "Gone & Co", source: "rotation", position: 1 });
    await click(w, { sponsor: gone, fixture: f });
    await reportLink(w, { sponsor: gone });
    await shortCode(w, { sponsor: gone, fixture: f });
    // The other sponsor's rows are the twin: they must survive the delete untouched.
    await click(w, { sponsor: kept, fixture: f });
    await reportLink(w, { sponsor: kept });
    await shortCode(w, { sponsor: kept, fixture: f });

    await deleteSponsor(w.auth, gone);

    const [a] = await sql<{ sponsor_id: string | null; sponsor_name: string }[]>`select sponsor_id, sponsor_name from sponsor_airings where id = ${airingId}`;
    expect(a).toEqual({ sponsor_id: null, sponsor_name: "Gone & Co" });
    // The assignment keeps its assign-time name snapshot, so an airing START for this card (S8) still has a name.
    const [asg] = await sql<{ sponsor_id: string | null; sponsor_name: string; position: number }[]>`
      select sponsor_id, sponsor_name, position from sponsor_assignments where fixture_id = ${f} and moment_id = 'm-gone'`;
    expect(asg).toEqual({ sponsor_id: null, sponsor_name: "Gone & Co", position: 1 });
    for (const table of ["sponsor_clicks", "sponsor_report_links", "sponsor_short_codes"]) {
      const [gn] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where sponsor_id = ${gone}`;
      const [kn] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where sponsor_id = ${kept}`;
      expect({ table, gone: gn!.n, kept: kn!.n }).toEqual({ table, gone: 0, kept: 1 });
    }
  });

  // ---- sponsor_clicks / sponsor_report_links ----------------------------------------------------------------------
  it("a click's source is match | stream | site | unknown: each accepted, anything else refused by name (count reported)", async () => {
    const w = await world();
    const sp = await sponsor(w);
    let accepted = 0;
    for (const source of CLICK_SOURCES) {
      await expect(click(w, { sponsor: sp, fixture: null, source }), source).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(4);
    await expect(click(w, { sponsor: sp, fixture: null, source: "email" })).rejects.toMatchObject(refusedBy("23514", "sponsor_clicks_source_check"));
  });

  it("a report link's period runs forwards (one day allowed), its token hash is unique, and it starts unrevoked", async () => {
    const w = await world();
    const sp = await sponsor(w);
    await expect(reportLink(w, { sponsor: sp, from: "2026-05-02", to: "2026-05-01" })).rejects.toMatchObject(refusedBy("23514", "sponsor_report_links_period_check"));
    const oneDay = await reportLink(w, { sponsor: sp, from: "2026-05-01", to: "2026-05-01" });
    const hash = randomBytes(32);
    await expect(reportLink(w, { sponsor: sp, hash })).resolves.toBeTruthy();
    await expect(reportLink(w, { sponsor: sp, hash })).rejects.toMatchObject(refusedBy("23505", "sponsor_report_links_token_hash_key"));
    const [row] = await sql<{ revoked_at: Date | null }[]>`select revoked_at from sponsor_report_links where id = ${oneDay}`;
    expect(row).toEqual({ revoked_at: null });
  });

  // ---- sponsor_short_codes (R7 addition) --------------------------------------------------------------------------
  it("R7: the code CHECK is the lib's pattern, and it accepts every alphabet character and refuses every other one (counts reported)", async () => {
    const [def] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'sponsor_short_codes'::regclass and conname = 'sponsor_short_codes_code_check'`;
    expect(def, "the named code CHECK exists").toBeDefined();
    const dbPattern = /~ '([^']+)'/.exec(def!.def)?.[1];
    expect(dbPattern, def!.def).toBe(SPONSOR_SHORT_CODE_PATTERN.source);

    const w = await world();
    const sp = await sponsor(w);
    // One row per accepted character: fixture null, so unique(sponsor, fixture) never binds (nulls are distinct).
    let accepted = 0;
    for (const c of SPONSOR_SHORT_CODE_ALPHABET) {
      await expect(shortCode(w, { sponsor: sp, fixture: null, code: `${c}${randomCode(SPONSOR_SHORT_CODE_MAX_LENGTH - 1)}` }), c).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted, "alphabet characters accepted").toBe(SPONSOR_SHORT_CODE_ALPHABET.length);
    expect(accepted).toBeGreaterThan(0);
    // Every printable ASCII character OUTSIDE the alphabet — the five ambiguous ones and lowercase among them.
    const outside = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
      .filter((c) => !SPONSOR_SHORT_CODE_ALPHABET.includes(c));
    let refused = 0;
    for (const c of outside) {
      await expect(shortCode(w, { sponsor: sp, fixture: null, code: `${randomCode(2)}${c}${randomCode(2)}` }), JSON.stringify(c))
        .rejects.toMatchObject(refusedBy("23514", "sponsor_short_codes_code_check"));
      refused++;
    }
    for (const c of ["0", "O", "1", "I", "L", "a"]) expect(outside, c).toContain(c);
    expect(refused, "characters refused").toBe(outside.length);
    // Length: the ruling's bounds are inclusive.
    const lengths: Array<[number, boolean]> = [
      [SPONSOR_SHORT_CODE_MIN_LENGTH - 1, false], [SPONSOR_SHORT_CODE_MIN_LENGTH, true],
      [SPONSOR_SHORT_CODE_MAX_LENGTH, true], [SPONSOR_SHORT_CODE_MAX_LENGTH + 1, false],
    ];
    for (const [n, ok] of lengths) {
      const p = shortCode(w, { sponsor: sp, fixture: null, code: randomCode(n) });
      if (ok) await expect(p, `${n} chars`).resolves.toBeTruthy();
      else await expect(p, `${n} chars`).rejects.toMatchObject(refusedBy("23514", "sponsor_short_codes_code_check"));
    }
  });

  it("R7: one code per (sponsor, fixture); another fixture or another sponsor takes its own; a code is globally unique", async () => {
    const w = await world();
    const [f1, f2] = w.fixtureIds as [string, string];
    const a = await sponsor(w);
    const b = await sponsor(w);
    const code = await shortCode(w, { sponsor: a, fixture: f1 });
    await expect(shortCode(w, { sponsor: a, fixture: f1 })).rejects.toMatchObject(refusedBy("23505", "sponsor_short_codes_sponsor_fixture_key"));
    await expect(shortCode(w, { sponsor: a, fixture: f2 })).resolves.toBeTruthy();
    await expect(shortCode(w, { sponsor: b, fixture: f1 })).resolves.toBeTruthy();
    await expect(shortCode(w, { sponsor: b, fixture: f2, code })).rejects.toMatchObject(refusedBy("23505", "sponsor_short_codes_pkey"));
  });

  it("R7: deleting BOTH fixtures a sponsor has codes for succeeds — the second delete is not refused by (sponsor, null) — and both codes survive", async () => {
    const w = await world();
    const [f1, f2] = w.fixtureIds as [string, string];
    const sp = await sponsor(w);
    const c1 = await shortCode(w, { sponsor: sp, fixture: f1 });
    const c2 = await shortCode(w, { sponsor: sp, fixture: f2 });
    await sql`delete from fixtures where id = ${f1}`;
    await sql`delete from fixtures where id = ${f2}`;
    const rows = await sql<{ code: string; fixture_id: string | null }[]>`
      select code, fixture_id from sponsor_short_codes where sponsor_id = ${sp} order by code`;
    expect(rows).toEqual([c1, c2].sort().map((code) => ({ code, fixture_id: null })));
  });

  // ---- tenancy ----------------------------------------------------------------------------------------------------
  it("the R4 delta is found by its suffix: exactly one file matches, whatever its number", () => {
    expect(V483_MATCHES, "exactly one sponsor_rotation delta").toHaveLength(1);
    expect(V483_FILE.endsWith("__sponsor_rotation.sql")).toBe(true);
  });

  it("V483 creates exactly the tenant tables and the sealed one this file classifies — a table added later is classified or this reds (count reported)", () => {
    const created = [...readFileSync(V483_FILE, "utf8").matchAll(/^create table (\w+)/gm)].map((m) => m[1]!);
    expect(created.length, "tables read from the file").toBeGreaterThan(0);
    expect([...created].sort()).toEqual([...NEW_TABLES, ...SEALED_TABLES].sort());
  });

  it("the tombstone table is SEALED (S9 review m8): RLS enabled and forced, no policy, no grant — app_user can neither read nor write it", async () => {
    let checked = 0;
    for (const table of SEALED_TABLES) {
      const [flags] = await sql<{ enabled: boolean; forced: boolean; policies: number; grants: number }[]>`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
               (select count(*)::int from pg_policies p where p.schemaname = current_schema() and p.tablename = c.relname) as policies,
               (select count(*)::int from information_schema.role_table_grants g
                 where g.table_schema = current_schema() and g.table_name = c.relname and g.grantee = 'app_user') as grants
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relname = ${table}`;
      expect({ table, ...flags }).toEqual({ table, enabled: true, forced: true, policies: 0, grants: 0 });
      const w = await world();
      await expect(withTenant(w.orgId, (tx) => tx`select count(*) from ${tx(table)}`), `${table} read`).rejects.toMatchObject({ code: "42501" });
      await expect(withTenant(w.orgId, (tx) => tx`insert into ${tx(table)} (path) values (${`${w.orgId}/x.jpg`})`), `${table} write`).rejects.toMatchObject({ code: "42501" });
      checked++;
    }
    expect(checked).toBe(SEALED_TABLES.length);
  });

  it("RLS: every new table is enabled AND forced, and org B reads none of org A's rows while org A reads its own (count reported, 0 tables checked ⇒ fail)", async () => {
    const a = await world();
    const b = await world();
    const f = a.fixtureIds[0]!;
    const s = await a.session(f);
    const sp = await sponsor(a);
    const moment = `m-${uniq()}`;
    await settings(a, null);
    await assignment(a, { fixture: f, sponsor: sp, source: "rotation", position: 1 });
    await airing(a, { sponsor: sp, fixture: f, session: s, moment });
    await frame(a, s, moment);
    await click(a, { sponsor: sp, fixture: f });
    await reportLink(a, { sponsor: sp });
    await shortCode(a, { sponsor: sp, fixture: f });

    const flags = await sql<{ relname: string; enabled: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.schemaname = current_schema() and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname in ${sql(NEW_TABLES as unknown as string[])}`;
    expect(flags.map((r) => r.relname).sort(), "every new table exists").toEqual([...NEW_TABLES].sort());

    let checked = 0;
    for (const table of NEW_TABLES) {
      const flag = flags.find((r) => r.relname === table)!;
      expect({ table, enabled: flag.enabled, forced: flag.forced, policy: flag.policies > 0 }).toEqual({ table, enabled: true, forced: true, policy: true });
      const count = (org: string) => withTenant(org, async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)}`)[0]!.n);
      expect({ table, seen: await count(b.orgId) }, "org B reads org A's rows").toEqual({ table, seen: 0 });
      expect(await count(a.orgId), `org A reads its own ${table}`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, "tables checked").toBe(NEW_TABLES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("RLS writes: the console's two tables refuse a row for another org; the privileged-written five refuse every app_user insert (count reported)", async () => {
    const a = await world();
    const b = await world();
    // Tenant-written: org B may write its own settings row and its own link, and may write neither for org A.
    await expect(withTenant(b.orgId, (tx) => tx`insert into sponsor_stream_settings (org_id) values (${b.orgId})`)).resolves.toBeTruthy();
    await expect(withTenant(b.orgId, (tx) => tx`insert into sponsor_stream_settings (org_id) values (${a.orgId})`)).rejects.toMatchObject({ code: "42501" });
    const sp = await sponsor(b);
    const spA = await sponsor(a);
    const link = (org: string, sponsorId: string) => withTenant(b.orgId, (tx) => tx`
      insert into sponsor_report_links (org_id, sponsor_id, from_date, to_date, token_hash)
      values (${org}, ${sponsorId}, '2026-01-01', '2026-01-31', ${randomBytes(32)})`);
    await expect(link(b.orgId, sp)).resolves.toBeTruthy();
    await expect(link(a.orgId, spA)).rejects.toMatchObject({ code: "42501" });
    // Privileged-written: no insert grant to app_user at all (the overlay path, the relay and /s/ write on `sql`).
    const f = b.fixtureIds[0]!;
    const s = await b.session(f);
    const attempts: Record<string, () => Promise<unknown>> = {
      sponsor_assignments: () => withTenant(b.orgId, (tx) => tx`
        insert into sponsor_assignments (fixture_id, moment_id, org_id, seq, sponsor_name, position, source, break_kind, style, hold_ms)
        values (${f}, 'm', ${b.orgId}, 1, 'X', 1, 'rotation', 'over_end', 'banner', 8000)`),
      sponsor_airings: () => withTenant(b.orgId, (tx) => tx`
        insert into sponsor_airings (org_id, sponsor_name, moment_id, source, style, started_at)
        values (${b.orgId}, 'X', 'm', 'scene', 'banner', now())`),
      sponsor_airing_frames: () => withTenant(b.orgId, (tx) => tx`
        insert into sponsor_airing_frames (session_id, moment_id, org_id, path) values (${s}, 'm', ${b.orgId}, 'p')`),
      sponsor_clicks: () => withTenant(b.orgId, (tx) => tx`
        insert into sponsor_clicks (org_id, sponsor_id, source) values (${b.orgId}, ${sp}, 'site')`),
      sponsor_short_codes: () => withTenant(b.orgId, (tx) => tx`
        insert into sponsor_short_codes (code, org_id, sponsor_id) values (${randomCode(8)}, ${b.orgId}, ${sp})`),
    };
    let refused = 0;
    for (const table of NEW_TABLES.filter((t) => !TENANT_WRITTEN.has(t))) {
      await expect(attempts[table]!(), table).rejects.toMatchObject({ code: "42501" });
      refused++;
    }
    expect(refused, "privileged-only tables checked").toBe(NEW_TABLES.length - TENANT_WRITTEN.size);
  });

  it("the readers' composite indexes exist - the brief's two and the Overview's org-window click index (S13) (count reported)", async () => {
    const wanted: Array<[string, string]> = [
      ["sponsor_airings", "(org_id, sponsor_id, started_at)"],
      ["sponsor_clicks", "(sponsor_id, at)"],
      ["sponsor_clicks", "(org_id, at)"],
    ];
    const defs = await sql<{ tablename: string; indexdef: string }[]>`
      select tablename, indexdef from pg_indexes where schemaname = current_schema() and tablename in ${sql(NEW_TABLES as unknown as string[])}`;
    let found = 0;
    for (const [table, cols] of wanted) {
      expect(defs.some((d) => d.tablename === table && d.indexdef.includes(`USING btree ${cols}`)), `${table} ${cols}`).toBe(true);
      found++;
    }
    expect(found).toBe(wanted.length);
  });

  it("every foreign key to a parent the app deletes has an index led by its column; org and user keys are the only unindexed ones (counts reported; MUTATE: drop sponsor_clicks_fixture_idx)", async () => {
    const fks = await fkIndexes(sql);
    expect(fks.every((k) => k.cols === 1), "every key is single-column").toBe(true);
    const unclassified = fks.filter((k) => !UNINDEXED_PARENTS.has(k.parent) && !WALKED_FKS.includes(`${k.tbl}.${k.col}`));
    expect(unclassified.map((k) => `${k.tbl}.${k.col} → ${k.parent}`), "an FK nobody classified").toEqual([]);
    const walked = fks.filter((k) => !UNINDEXED_PARENTS.has(k.parent));
    expect(walked.map((k) => `${k.tbl}.${k.col}`).sort(), "the walked keys are the declared list").toEqual([...WALKED_FKS].sort());
    let checked = 0;
    for (const k of walked) {
      expect({ fk: `${k.tbl}.${k.col}`, indexed: k.indexed }).toEqual({ fk: `${k.tbl}.${k.col}`, indexed: true });
      checked++;
    }
    expect(checked, "walked FKs checked").toBe(WALKED_FKS.length);
    expect(checked).toBeGreaterThan(0);
    // The excluded side: one org key per table, plus settings.updated_by and report_links.created_by.
    const excluded = fks.filter((k) => UNINDEXED_PARENTS.has(k.parent)).map((k) => `${k.tbl}.${k.col}`).sort();
    expect(excluded).toEqual([...NEW_TABLES.map((t) => `${t}.org_id`), "sponsor_report_links.created_by", "sponsor_stream_settings.updated_by"].sort());
  });

  it("S3 carry: the sweep counts a PARTIAL index only when its predicate is the key's own `is not null` - a partial index with an unrelated predicate does not serve the delete and does not count (planted in a rolled-back transaction)", async () => {
    const ROLLBACK = new Error("rolled back on purpose");
    const key = "sponsor_clicks.fixture_id";
    type Fk = { tbl: string; col: string; indexed: boolean };
    let planted: Fk[] = [];
    let kept: Fk[] = [];
    await expect(sql.begin(async (tx) => {
      await tx`drop index sponsor_clicks_fixture_idx`;
      await tx`create index sponsor_clicks_fixture_site_idx on sponsor_clicks (fixture_id) where source = 'site'`;
      planted = [...(await fkIndexes(tx))];
      await tx`drop index sponsor_clicks_fixture_site_idx`;
      await tx`create index sponsor_clicks_fixture_nn_idx on sponsor_clicks (fixture_id) where fixture_id is not null`;
      kept = [...(await fkIndexes(tx))];
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    const indexedIn = (rows: readonly Fk[]) => rows.find((k) => `${k.tbl}.${k.col}` === key)?.indexed;
    expect(planted.length, "premise: the sweep read the keys").toBe(kept.length);
    expect(planted.length).toBeGreaterThan(0);
    expect(indexedIn(planted), "an unrelated predicate: not served").toBe(false);
    expect(indexedIn(kept), "the key's own `is not null`: served").toBe(true);
    // ...and the rollback restored the real index.
    expect(indexedIn(await fkIndexes(sql))).toBe(true);
  });
});
