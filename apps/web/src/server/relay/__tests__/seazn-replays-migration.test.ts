// V542 (Seazn-hosted video, Phase 2, Task 23): the replay tables. `fixture_video_replays` is one row per Cloudflare recording
// moved to Bunny, numbered once at discovery (`part_no`, unique per fixture, never changed); `org_video_collections` is an org's
// Bunny collection; `bunny_webhook_events` is the dedupe mark for Bunny's EventId (Task 27). `public_fixture_seazn_replays_v`
// is the public read of the playable parts, under public_fixture_youtube_parts_v's redaction. The three carries ride the same
// migration: `stream_provider_calls.provider` admits `bunny` (Task 22 m8), an index serves the stream tick's per-minute Seazn
// pass (Task 13 m9), and `seazn_locked_videos` gains the recording's start, `recorded_at` (Task 14).
//
// Each refusal has its accepted twin in the same `it`, so an empty schema cannot pass (AGENTS.md class 3): the twin fails with
// "relation/column does not exist" first. Real Postgres required; skipped without DATABASE_URL like every DB suite here. The
// tables are reached through the plain `sql` client: RLS is FORCEd with zero policies (the V430 pattern), so app_user sees
// nothing. Every probe that could leave a half-state runs in a transaction that is always rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { BunnyReplayHost } from "@/server/video/replay-bunny";
import type { ProviderCallRecord } from "../ports";
import { recordProviderCall } from "../telemetry";

const HAS_DB = !!process.env.DATABASE_URL;

/** The three tables V542 creates, by name. */
const V542_TABLES = ["org_video_collections", "fixture_video_replays", "bunny_webhook_events"];
/** The replay states the brief declares, typed here (never read off the migration). */
const STATES = ["found", "downloading", "fetching", "encoding", "playable", "failed", "deleted"] as const;
/** The states a row may hold with no Bunny id: it has none yet (found, downloading, fetching), or lost it (failed, deleted). */
const NO_BUNNY_STATES = ["found", "downloading", "fetching", "failed", "deleted"] as const;

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
const probe = (tx: Tx, q: (sp: Tx) => PromiseLike<unknown>): Promise<string> =>
  failure(tx.savepoint((sp) => q(sp as Tx)));

/** An org, a started division with `fixtures` fixtures, and one ended Seazn session on the first fixture (V541's seazn row). */
async function rig(fixtures = 2) {
  const { auth } = await seedOrg();
  const { fixtureIds } = await divisionRig(auth, { entrants: fixtures <= 1 ? 2 : 4 });
  expect(fixtureIds.length, "PREMISE: the rig made the fixtures asked for").toBeGreaterThanOrEqual(fixtures);
  const fixtureId = fixtureIds[0]!;
  const [src] = await sql<{ division_id: string; competition_id: string; sport_key: string }[]>`
    select f.division_id, d.competition_id, d.sport_key from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  expect(seazn, "PREMISE: V541 gave the org its Seazn destination").toBeDefined();
  const [session] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, destination_kind,
                                         sport_key, competition_id, division_id, entitlement_via_override)
    values (${fixtureId}, ${auth.orgId}, 'composed', 'completed', ${seazn!.id}, ${randomUUID()}, 'seazn',
            ${src!.sport_key}, ${src!.competition_id}, ${src!.division_id}, true)
    returning id`;
  return {
    orgId: auth.orgId, fixtureId, fixtureIds, sessionId: session!.id,
    divisionId: src!.division_id, competitionId: src!.competition_id,
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

interface ReplayOpts {
  fixtureId?: string | null; partNo?: number; state?: string; bunny?: string | null; verified?: boolean;
  recordedAt?: Date; deletedReason?: string | null; cfVideoId?: string;
}
/** One replay row; the defaults are a `found` part 1 of the rig's first fixture. */
const insertReplay = (q: Tx | typeof sql, r: Rig, o: ReplayOpts = {}) => q<{ id: string }[]>`
  insert into fixture_video_replays (org_id, session_id, fixture_id, cf_video_id, recorded_at, part_no, state,
                                     bunny_video_id, verified_at, deleted_reason)
  values (${r.orgId}, ${r.sessionId}, ${o.fixtureId === undefined ? r.fixtureId : o.fixtureId}, ${o.cfVideoId ?? `cf-${randomUUID()}`},
          ${o.recordedAt ?? new Date()}, ${o.partNo ?? 1}, ${o.state ?? "found"}, ${o.bunny ?? null},
          ${o.verified ? new Date() : null}, ${o.deletedReason ?? null})
  returning id`;

describe.skipIf(!HAS_DB)("V542__seazn_replays.sql — the replay tables are real", () => {
  it("a playable row needs a Bunny id AND verified_at (23514 each); encoding needs a Bunny id; the no-Bunny states land without one", async () => {
    const r = await rig(1);
    let probes = 0;
    await rolledBack(async (tx) => {
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "playable", bunny: null, verified: true })), "playable, no Bunny id")
        .toBe("23514:fixture_video_replays_bunny_video_id");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "playable", bunny: `bn-${randomUUID()}`, verified: false })), "playable, not verified")
        .toBe("23514:fixture_video_replays_playable_verified");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "encoding", bunny: null })), "encoding, no Bunny id")
        .toBe("23514:fixture_video_replays_bunny_video_id");
      // With a Bunny id, so the state list is the only CHECK it breaks (Postgres tests CHECKs in name order).
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "ufo", bunny: `bn-${randomUUID()}` })), "an unknown state")
        .toBe("23514:fixture_video_replays_state_check");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "playable", bunny: `bn-${randomUUID()}`, verified: true, partNo: 1 })),
        "playable, with its Bunny id and verified").toBe("landed");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "encoding", bunny: `bn-${randomUUID()}`, partNo: 2 })), "encoding, with its Bunny id")
        .toBe("landed");
      probes = 6;
      let part = 10;
      for (const state of NO_BUNNY_STATES) {
        expect(await probe(tx, (sp) => insertReplay(sp, r, { state, bunny: null, partNo: part++ })), state).toBe("landed");
        probes++;
      }
    });
    expect(probes, "probes run (six, plus one per no-Bunny state)").toBe(6 + NO_BUNNY_STATES.length);
    expect(STATES.filter((s) => !(NO_BUNNY_STATES as readonly string[]).includes(s)), "PREMISE: two states hold a Bunny id")
      .toEqual(["encoding", "playable"]);
  });

  it("deleted_reason is organiser or org_deleted (or null); a row starts with no attempts, due now, and none of its marks set", async () => {
    const r = await rig(1);
    let probes = 0;
    await rolledBack(async (tx) => {
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "deleted", deletedReason: "staff" })), "an unknown reason")
        .toBe("23514:fixture_video_replays_deleted_reason_check");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "deleted", deletedReason: "organiser", partNo: 1 })), "organiser").toBe("landed");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { state: "deleted", deletedReason: "org_deleted", partNo: 2 })), "org_deleted").toBe("landed");
      probes = 3;
      const [row] = await insertReplay(tx, r, { partNo: 3 });
      const [fresh] = await tx<Record<string, unknown>[]>`
        select attempts, next_attempt_at <= now() as due, state_at is not null as stamped, bunny_video_id, length_seconds,
               cf_duration_seconds, cf_height, cf_deleted_at, verified_at, bunny_cleaned_at, deleted_at, deleted_by, deleted_reason
          from fixture_video_replays where id = ${row!.id}`;
      expect(fresh).toEqual({
        attempts: 0, due: true, stamped: true, bunny_video_id: null, length_seconds: null, cf_duration_seconds: null, cf_height: null,
        cf_deleted_at: null, verified_at: null, bunny_cleaned_at: null, deleted_at: null, deleted_by: null, deleted_reason: null,
      });
    });
    expect(probes).toBe(3);
  });

  it("one row per recording (cf_video_id 23505) and one part number per fixture ((fixture_id, part_no) 23505); another fixture's part 1, and parts whose fixture is gone, are their own", async () => {
    const r = await rig(2);
    const other = r.fixtureIds[1]!;
    let probes = 0;
    await rolledBack(async (tx) => {
      const cf = `cf-${randomUUID()}`;
      expect(await probe(tx, (sp) => insertReplay(sp, r, { cfVideoId: cf, partNo: 1 })), "first").toBe("landed");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { cfVideoId: cf, partNo: 2 })), "the same recording again")
        .toBe("23505:fixture_video_replays_cf_video_id_key");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { partNo: 1 })), "a second part 1 of the fixture")
        .toBe("23505:fixture_video_replays_fixture_id_part_no_key");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { fixtureId: other, partNo: 1 })), "another fixture's part 1").toBe("landed");
      // A deleted fixture sets fixture_id null (the FK below); two such parts must not collide on (null, 1).
      expect(await probe(tx, (sp) => insertReplay(sp, r, { fixtureId: null, partNo: 1 })), "a fixtureless part 1").toBe("landed");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { fixtureId: null, partNo: 1 })), "a second fixtureless part 1").toBe("landed");
      probes = 6;
    });
    expect(probes).toBe(6);
  });

  it("part numbers start at 1: part 0 and a negative part are refused (23514 by name); part 1 lands", async () => {
    // The public page shows the number as "Part n"; a `coalesce(max(part_no), 0)` slip in discovery would publish a Part 0.
    const r = await rig(1);
    let probes = 0;
    await rolledBack(async (tx) => {
      expect(await probe(tx, (sp) => insertReplay(sp, r, { partNo: 0 })), "part 0").toBe("23514:fixture_video_replays_part_no_check");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { partNo: -1 })), "part -1").toBe("23514:fixture_video_replays_part_no_check");
      expect(await probe(tx, (sp) => insertReplay(sp, r, { partNo: 1 })), "part 1").toBe("landed");
      probes = 3;
    });
    expect(probes).toBe(3);
  });

  it("a second bunny_webhook_events row with one event_id is refused (23505); another event lands", async () => {
    const id = `evt-${randomUUID()}`;
    expect(await failure(sql`insert into bunny_webhook_events (event_id) values (${id})`), "first").toBe("landed");
    expect(await failure(sql`insert into bunny_webhook_events (event_id) values (${id})`), "the same event again").toBe("23505:bunny_webhook_events_pkey");
    expect(await failure(sql`insert into bunny_webhook_events (event_id) values (${`evt-${randomUUID()}`})`), "another event").toBe("landed");
    const [row] = await sql<{ received: boolean }[]>`select received_at <= now() as received from bunny_webhook_events where event_id = ${id}`;
    expect(row).toEqual({ received: true });
  });

  it("an org with a replay, or with a Bunny collection, cannot be deleted (23503); the foreign keys are RESTRICT on org and session, SET NULL on fixture", async () => {
    const fks = await sql<{ rel: string; col: string; target: string; del: string }[]>`
      select c.conrelid::regclass::text as rel, a.attname as col, c.confrelid::regclass::text as target, c.confdeltype as del
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.conrelid in ('fixture_video_replays'::regclass, 'org_video_collections'::regclass)
       order by rel, col`;
    const bare = (s: string) => s.replace(/^.*\./, "");
    expect(fks.map((f) => [bare(f.rel), f.col, bare(f.target), f.del])).toEqual([
      ["fixture_video_replays", "fixture_id", "fixtures", "n"],
      ["fixture_video_replays", "org_id", "organizations", "r"],
      ["fixture_video_replays", "session_id", "fixture_stream_sessions", "r"],
      ["org_video_collections", "org_id", "organizations", "r"],
    ]);

    const r = await rig(1);
    let probes = 0;
    await rolledBack(async (tx) => {
      const deleteOrg = () => probe(tx, (sp) => sp`delete from organizations where id = ${r.orgId}`);
      await insertReplay(tx, r);
      expect(await deleteOrg(), "an org with a replay").toMatch(/^23503:fixture_video_replays_(org|session)_id_fkey$/);
      await tx`delete from fixture_video_replays where org_id = ${r.orgId}`;
      await tx`insert into org_video_collections (org_id, collection_id) values (${r.orgId}, ${`col-${randomUUID()}`})`;
      expect(await deleteOrg(), "an org with a collection").toBe("23503:org_video_collections_org_id_fkey");
      await tx`delete from org_video_collections where org_id = ${r.orgId}`;
      expect(await deleteOrg(), "the same org with neither: the refusals were the replay's and the collection's").toBe("landed");
      probes = 3;
    });
    expect(probes).toBe(3);
    const [kept] = await sql<{ n: number }[]>`select count(*)::int as n from organizations where id = ${r.orgId}`;
    expect(kept, "the rollback kept the org").toEqual({ n: 1 });
  });

  it("one collection per org: a second row for one org is refused (23505)", async () => {
    const { auth } = await seedOrg();
    expect(await failure(sql`insert into org_video_collections (org_id, collection_id) values (${auth.orgId}, 'col-a')`), "first").toBe("landed");
    expect(await failure(sql`insert into org_video_collections (org_id, collection_id) values (${auth.orgId}, 'col-b')`), "second")
      .toBe("23505:org_video_collections_pkey");
  });

  it("the public view lists playable parts with their STORED part_no (a gap while a part still encodes), and nothing for a private competition or a setup division", async () => {
    const r = await rig(2);
    const view = (fixtureId: string) => sql<{ fixture_id: string; part_no: number; bunny_video_id: string }[]>`
      select fixture_id, part_no, bunny_video_id from public_fixture_seazn_replays_v where fixture_id = ${fixtureId} order by part_no`;
    // The empty case first: a fixture with no replay has no part.
    expect(await view(r.fixtureId)).toEqual([]);

    const [b1, b2] = [`bn-${randomUUID()}`, `bn-${randomUUID()}`];
    const [p1] = await insertReplay(sql, r, { partNo: 1, state: "playable", bunny: b1, verified: true });
    await insertReplay(sql, r, { partNo: 2, state: "playable", bunny: b2, verified: true });
    await insertReplay(sql, r, { partNo: 3, state: "found" });
    await insertReplay(sql, r, { partNo: 4, state: "deleted", deletedReason: "organiser" });
    expect(await view(r.fixtureId)).toEqual([
      { fixture_id: r.fixtureId, part_no: 1, bunny_video_id: b1 },
      { fixture_id: r.fixtureId, part_no: 2, bunny_video_id: b2 },
    ]);
    expect(await view(r.fixtureIds[1]!), "another fixture lists none of this one's parts").toEqual([]);

    // Part 1 is re-encoding: part 2 keeps its number, never renumbered to 1.
    await sql`update fixture_video_replays set state = 'encoding', verified_at = null where id = ${p1!.id}`;
    expect(await view(r.fixtureId)).toEqual([{ fixture_id: r.fixtureId, part_no: 2, bunny_video_id: b2 }]);

    // The redaction is public_fixture_youtube_parts_v's: the competition's visibility, then the division's status.
    let seen = 0;
    for (const [visibility, expected] of [["private", 0], ["unlisted", 1], ["public", 1]] as const) {
      await sql`update competitions set visibility = ${visibility} where id = ${r.competitionId}`;
      expect((await view(r.fixtureId)).length, visibility).toBe(expected);
      seen++;
    }
    expect(seen).toBe(3);
    await sql`update divisions set status = 'setup' where id = ${r.divisionId}`;
    expect(await view(r.fixtureId), "a setup division").toEqual([]);
    await sql`update divisions set status = 'active' where id = ${r.divisionId}`;
    expect((await view(r.fixtureId)).length, "the redaction is the status, not a deletion").toBe(1);

    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'public_fixture_seazn_replays_v' order by ordinal_position`;
    expect(cols.map((x) => x.column_name)).toEqual(["fixture_id", "part_no", "bunny_video_id"]);
  });

  it("all three tables are RLS enabled AND forced with no policy; neither they nor the view are granted to app_user", async () => {
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname = any(${V542_TABLES}) order by c.relname`;
    expect(rows).toEqual([...V542_TABLES].sort().map((relname) => ({ relname, rls: true, forced: true, policies: 0 })));
    const granted = async (rel: string) => (await sql<{ ok: boolean }[]>`
      select (has_table_privilege('app_user', ${rel}::text, 'select') or has_table_privilege('app_user', ${rel}::text, 'insert')
           or has_table_privilege('app_user', ${rel}::text, 'update') or has_table_privilege('app_user', ${rel}::text, 'delete')) as ok`)[0]!.ok;
    expect(await granted("public_fixtures_v"), "the probe must be able to see a grant").toBe(true);
    let ungranted = 0;
    for (const rel of [...V542_TABLES, "public_fixture_seazn_replays_v"]) {
      expect(await granted(rel), `app_user must hold nothing on ${rel}`).toBe(false);
      ungranted++;
    }
    expect(ungranted).toBe(4);
  });

  // Task 24's claim WHERE, typed from the plan (Task 24, "Rows are claimed in a short transaction"). The due index's predicate is
  // this text, so a claim is answered from it and a row the claim never reads is not in it.
  const CLAIM = "state not in ('playable','deleted') or (state = 'playable' and cf_deleted_at is null) or (state = 'deleted' and bunny_cleaned_at is null)";
  /** The plan for `select id … where next_attempt_at <= now() and (<where>)`, with sequential scans priced out: a query the due
   *  index can answer names it; one it cannot falls back to the (disabled) sequential scan, since no other index has a qual. */
  async function planFor(where: string): Promise<string> {
    let plan = "";
    await rolledBack(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `explain select id from fixture_video_replays where next_attempt_at <= now() and (${where})`);
      plan = rows.map((x) => x["QUERY PLAN"]).join("\n");
    });
    return plan;
  }

  it("the mover's claim (Task 24's predicate) is served by the due index, and each of its three arms alone is too; the read's (fixture_id, recorded_at) index exists", async () => {
    let checked = 0;
    for (const where of [CLAIM, "state not in ('playable','deleted')", "state = 'playable' and cf_deleted_at is null", "state = 'deleted' and bunny_cleaned_at is null"]) {
      const plan = await planFor(where);
      expect(plan, `${where}\n${plan}`).toMatch(/fixture_video_replays_due_idx/);
      checked++;
    }
    expect(checked, "claims planned").toBe(4);
    const [idx] = await sql<{ def: string }[]>`select pg_get_indexdef('fixture_video_replays_fixture_recorded_idx'::regclass) as def`;
    expect(idx!.def).toMatch(/\(fixture_id, recorded_at\)$/);
  });

  it("the due index holds only rows the claim reads: a SETTLED playable row (verified, Cloudflare copy deleted) and a CLEANED deleted row are outside it — the planner cannot answer either from it", async () => {
    // Each settled shape still holds the column the brief's looser predicate admitted on (bunny_cleaned_at null on a playable row,
    // cf_deleted_at null on a cleaned one), so an index over that predicate WOULD answer these queries; this one must not.
    let checked = 0;
    for (const where of [
      "state = 'playable' and verified_at is not null and cf_deleted_at is not null and bunny_cleaned_at is null",
      "state = 'deleted' and bunny_cleaned_at is not null and cf_deleted_at is null",
    ]) {
      const plan = await planFor(where);
      expect(plan, `${where}\n${plan}`).not.toMatch(/fixture_video_replays_due_idx/);
      checked++;
    }
    expect(checked, "settled shapes planned").toBe(2);
  });

  it("fixture_stream_inputs gains replays_discovered_at and seazn_locked_videos gains recorded_at, both nullable timestamps", async () => {
    const cols = await sql<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>`
      select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_schema = current_schema()
         and ((table_name = 'fixture_stream_inputs' and column_name = 'replays_discovered_at')
           or (table_name = 'seazn_locked_videos' and column_name = 'recorded_at'))
       order by table_name`;
    expect(cols).toEqual([
      { table_name: "fixture_stream_inputs", column_name: "replays_discovered_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { table_name: "seazn_locked_videos", column_name: "recorded_at", data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
  });

  it("Task 13 m9: an index serves the Seazn pass — keyed on the join column, its predicate made of conditions the pass's own WHERE states", async () => {
    const [idx] = await sql<{ def: string }[]>`select pg_get_indexdef('fixture_stream_inputs_seazn_unlocked_idx'::regclass) as def`;
    expect(idx!.def).toMatch(/ON \S*fixture_stream_inputs USING btree \(session_id\) WHERE /);
    // Each conjunct of the index predicate must appear, on the input alias, in the pass's query: a predicate the pass does not
    // state cannot be proven by the planner, and the index would serve nothing.
    const pass = readFileSync(resolve(import.meta.dirname, "../../usecases/seazn-recordings.ts"), "utf8");
    const predicate = idx!.def.slice(idx!.def.indexOf(" WHERE ") + 7);
    const conjuncts = [
      ...[...predicate.matchAll(/\((\w+) = '([^']+)'::text\)/g)].map((m) => `i.${m[1]} = '${m[2]}'`),
      ...[...predicate.matchAll(/\((\w+) IS NULL\)/g)].map((m) => `i.${m[1]} is null`),
      ...[...predicate.matchAll(/\((\w+) IS NOT NULL\)/g)].map((m) => `i.${m[1]} is not null`),
    ];
    expect(conjuncts.sort(), "the predicate read off the index").toEqual(
      ["i.ingest_input_id is not null", "i.recordings_locked_at is null", "i.role = 'programme'"],
    );
    let checked = 0;
    for (const c of conjuncts) {
      expect(pass, c).toContain(c);
      checked++;
    }
    expect(checked, "conjuncts checked").toBe(3);
  });

  it("Task 22 m8: stream_provider_calls admits bunny — the real Bunny adapter's record lands, templated; an unknown provider is still refused", async () => {
    const guid = randomUUID();
    const pending: Promise<void>[] = [];
    const records: ProviderCallRecord[] = [];
    const host = new BunnyReplayHost(
      { libraryId: "424242", apiKey: "ZZ-api", readOnlyKey: "ZZ-ro", cdnHost: "vz-fake.b-cdn.net", tokenKey: "ZZ-token" },
      {
        fetchImpl: (async () => new Response(JSON.stringify({ status: 4, length: 30, availableResolutions: "360p,720p" }), { status: 200 })) as typeof fetch,
        recorder: { record: (c) => { records.push(c); const p = recordProviderCall(sql, c); pending.push(p); return p; } },
      },
    );
    await host.video(guid);
    await new Promise((done) => setImmediate(done));   // the adapter records fire-and-forget, one microtask on
    expect(records, "PREMISE: the adapter recorded its one call").toHaveLength(1);
    expect(await failure(Promise.all(pending)), "the Bunny record's insert").toBe("landed");
    const [row] = await sql<Record<string, unknown>[]>`
      select provider, operation, method, path_template, status from stream_provider_calls where subject_id = ${guid}`;
    expect(row).toEqual({ provider: "bunny", operation: "video", method: "GET", path_template: "/library/{id}/videos/{id}", status: 200 });
    expect(await failure(recordProviderCall(sql, { ...records[0]!, provider: "ufo" as "bunny", subjectId: randomUUID() })), "an unknown provider")
      .toBe("23514:stream_provider_calls_provider_check");
    // The swap is added NOT VALID and validated in its own statement (V530's shape); the validate must not be lost, or the
    // catalog carries an unchecked constraint for every later reader.
    const checks = await sql<{ validated: boolean }[]>`
      select convalidated as validated from pg_constraint
       where conrelid = 'stream_provider_calls'::regclass and conname = 'stream_provider_calls_provider_check'`;
    expect(checks, "one provider CHECK, validated").toEqual([{ validated: true }]);
  });
});
