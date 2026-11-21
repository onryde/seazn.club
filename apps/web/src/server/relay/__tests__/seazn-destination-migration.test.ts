// V540 (Seazn-hosted video, Phase 1, Task 9): every org holds exactly one `kind = 'seazn'` destination row, made by a
// trigger on organizations (and once for every org that already existed). The row carries no source of its own, so the
// one-source check grows a seazn arm; a Seazn session is not exclusive per target, so the V479 one-active index grows a
// `destination_kind` arm. Two mark tables (seazn_held_alerts, seazn_locked_videos) and two fixture_stream_inputs columns
// land beside them. Each refusal has its accepted twin in the same `it`, so an empty schema cannot pass (AGENTS.md
// class 3): the twin fails with "relation/column does not exist" first.
//
// Real Postgres required; skipped without DATABASE_URL like every DB suite here. The stream tables are reached through the
// plain `sql` client: RLS is FORCEd with zero policies (the V430 pattern), so app_user would see nothing.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const failure = async (p: PromiseLike<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    return `${err.code ?? "thrown"}:${err.constraint_name ?? ""}`;
  }
  return "landed";
};

/** Runs `fn` in a transaction that is ALWAYS rolled back: a probe that deletes an org's seazn row can never leave that org
 *  without one, even if the run dies mid-test, so the every-org sweep below never sees a half-state (review m3). */
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

type TargetRow = { kind: string; label: string; watch_url: string | null; rtmp: boolean; conn: boolean; archived: boolean };
const seaznRows = (orgId: string) => sql<TargetRow[]>`
  select kind, label, watch_url, rtmp_enc is not null as rtmp, youtube_connection_id is not null as conn,
         archived_at is not null as archived
    from org_stream_targets where org_id = ${orgId} and kind = 'seazn'`;

async function rig() {
  const { auth } = await seedOrg();
  // Four entrants, one round robin = six fixtures: fixture_stream_sessions_one_active (V410) allows one active session per
  // FIXTURE, so each session below takes its own fixture and only the per-TARGET index can be the one refusing.
  const { fixtureIds } = await divisionRig(auth, { entrants: 4 });
  expect(fixtureIds.length).toBeGreaterThanOrEqual(4);
  const fixtureId = fixtureIds[0]!;
  const [src] = await sql<{ division_id: string; competition_id: string; sport_key: string }[]>`
    select f.division_id, d.competition_id, d.sport_key from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  const [pasted] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc)
    values (${auth.orgId}, 'youtube', 'Club channel', ${Buffer.from("not-a-real-envelope")}) returning id`;
  return {
    orgId: auth.orgId, userId: randomUUID(), fixtureId, fixtureIds, seaznId: seazn?.id, pastedId: pasted!.id,
    divisionId: src!.division_id, competitionId: src!.competition_id, sportKey: src!.sport_key,
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** A session row, with `destination_kind` copied from the target as start.ts does at admission. */
async function insertSession(r: Rig, targetId: string, destinationKind: string, fixtureId = r.fixtureId, state = "live") {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, destination_kind,
                                         sport_key, competition_id, division_id, entitlement_via_override)
    values (${fixtureId}, ${r.orgId}, 'passthrough', ${state}, ${targetId}, ${r.userId}, ${destinationKind},
            ${r.sportKey}, ${r.competitionId}, ${r.divisionId}, true)
    returning id`;
  return row!.id;
}

describe.skipIf(!HAS_DB)("V540__seazn_destination.sql — the Seazn destination row is real", () => {
  it("a new org gets exactly one seazn row: label 'Seazn', no watch url, no key, no connection, not archived", async () => {
    const { auth } = await seedOrg();
    expect(await seaznRows(auth.orgId)).toEqual([
      { kind: "seazn", label: "Seazn", watch_url: null, rtmp: false, conn: false, archived: false },
    ]);
  });

  it("every org holds exactly one seazn row (the backfill and the trigger together), counted over every org", async () => {
    await seedOrg();
    const [{ orgs, wrong }] = await sql<{ orgs: number; wrong: number }[]>`
      select count(*)::int as orgs,
             count(*) filter (where (select count(*) from org_stream_targets t where t.org_id = o.id and t.kind = 'seazn') <> 1)::int as wrong
        from organizations o`;
    expect(orgs, "orgs checked").toBeGreaterThan(0);
    expect(wrong).toBe(0);
  });

  it("a second seazn row for one org is refused by org_stream_targets_one_seazn; another org's is its own key", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    let probes = 0;
    await rolledBack(async (tx) => {
      const insertSeazn = (orgId: string) => probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label) values (${orgId}, 'seazn', 'Seazn')`);
      expect(await insertSeazn(a.auth.orgId), "a second row on org a").toBe("23505:org_stream_targets_one_seazn");
      await tx`delete from org_stream_targets where org_id = ${b.auth.orgId} and kind = 'seazn'`;
      expect(await insertSeazn(b.auth.orgId), "org b's slot once freed").toBe("landed");
      probes = 2;
    });
    expect(probes, "probes run").toBe(2);
  });

  it("one_source: a seazn row may hold no key and no connection; any other kind still needs exactly one source", async () => {
    const { auth } = await seedOrg();
    const orgId = auth.orgId;
    const key = Buffer.from("not-a-real-envelope");
    let probes = 0;
    await rolledBack(async (tx) => {
      await tx`delete from org_stream_targets where org_id = ${orgId} and kind = 'seazn'`;
      expect(await probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'seazn', 'Seazn', ${key})`),
        "a seazn row with a key").toBe("23514:org_stream_targets_one_source");
      expect(await probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label) values (${orgId}, 'youtube', 'No source')`),
        "a youtube row with neither source (the regression)").toBe("23514:org_stream_targets_one_source");
      expect(await probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label) values (${orgId}, 'seazn', 'Seazn')`),
        "a seazn row with neither source").toBe("landed");
      expect(await probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'youtube', 'Pasted', ${key})`),
        "a pasted youtube row").toBe("landed");
      expect(await probe(tx, (sp) => sp`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'ufo', 'x', ${key})`),
        "an unknown kind").toBe("23514:org_stream_targets_kind_check");
      probes = 5;
    });
    expect(probes, "probes run").toBe(5);
    expect(await seaznRows(orgId), "the rollback restored the org's one seazn row").toHaveLength(1);
  });

  it("two live sessions on one seazn target both land; two on one pasted target still collide on one_active_target", async () => {
    const r = await rig();
    expect(r.seaznId, "the rig org's seazn row").toBeDefined();
    const [f1, f2, f3, f4] = r.fixtureIds;
    expect(await failure(insertSession(r, r.seaznId!, "seazn", f1)), "first seazn session").toBe("landed");
    expect(await failure(insertSession(r, r.seaznId!, "seazn", f2)), "second seazn session").toBe("landed");
    expect(await failure(insertSession(r, r.pastedId, "youtube", f3)), "first pasted session").toBe("landed");
    expect(await failure(insertSession(r, r.pastedId, "youtube", f4)), "second pasted session")
      .toBe("23505:fixture_stream_sessions_one_active_target");
  });

  it("an org inserted as app_user (the app role) commits and gets its seazn row: the trigger runs as its definer", async () => {
    const orgId = randomUUID();
    const suffix = orgId.slice(0, 8);
    await sql.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${orgId}, true)`;
      await tx`set local role app_user`;
      await tx`insert into organizations (id, name, slug) values (${orgId}, ${"Seazn " + suffix}, ${"seazn-" + suffix})`;
    });
    expect(await seaznRows(orgId)).toEqual([
      { kind: "seazn", label: "Seazn", watch_url: null, rtmp: false, conn: false, archived: false },
    ]);
    const [fn] = await sql<{ definer: boolean; config: string[] | null }[]>`
      select p.prosecdef as definer, p.proconfig as config from pg_proc p
       where p.proname = 'ensure_seazn_target' and p.pronamespace = current_schema()::regnamespace`;
    expect(fn?.definer).toBe(true);
    expect(fn?.config?.some((c) => /^search_path=.*pg_temp/.test(c))).toBe(true);
    // The definer function is off the execute list (review m4): neither app_user nor PUBLIC holds EXECUTE on it. A NULL proacl is
    // the default grant, which includes PUBLIC, so it reads TRUE here (never coalesced to the safe answer).
    const [priv] = await sql<{ app_user: boolean; public_x: boolean }[]>`
      select has_function_privilege('app_user', p.oid, 'execute') as app_user,
             (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) as public_x
        from pg_proc p where p.proname = 'ensure_seazn_target' and p.pronamespace = current_schema()::regnamespace`;
    expect(priv).toEqual({ app_user: false, public_x: false });
  });

  it("seazn_held_alerts and seazn_locked_videos exist with RLS enabled AND forced, no policy, and RESTRICT foreign keys", async () => {
    const tables = ["seazn_held_alerts", "seazn_locked_videos"];
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname = any(${tables}) order by c.relname`;
    expect(rows).toEqual(tables.map((relname) => ({ relname, rls: true, forced: true, policies: 0 })));
    const fks = await sql<{ rel: string; target: string; del: string }[]>`
      select conrelid::regclass::text as rel, confrelid::regclass::text as target, confdeltype as del from pg_constraint
       where contype = 'f' and conrelid in ('seazn_held_alerts'::regclass, 'seazn_locked_videos'::regclass) order by rel`;
    expect(fks.map((f) => [f.rel.replace(/^.*\./, ""), f.target.replace(/^.*\./, ""), f.del])).toEqual([
      ["seazn_held_alerts", "fixture_stream_sessions", "r"],
      ["seazn_locked_videos", "fixture_stream_inputs", "r"],
    ]);
  });

  it("one mark per recording: a second alert or lock for one cf_video_id is refused; the inputs gain access and recordings_locked_at", async () => {
    const r = await rig();
    const sid = await insertSession(r, r.seaznId!, "seazn");
    const access = { signed: true, allowedOrigins: ["seazn.club"] };
    const [input] = await sql<{ id: string }[]>`
      insert into fixture_stream_inputs (session_id, slot, access) values (${sid}, 0, ${sql.json(access)}) returning id`;
    const [row] = await sql<{ access: unknown; recordings_locked_at: Date | null }[]>`
      select access, recordings_locked_at from fixture_stream_inputs where id = ${input!.id}`;
    expect(row).toEqual({ access, recordings_locked_at: null });

    const video = `vid-${randomUUID()}`;
    expect(await failure(sql`insert into seazn_held_alerts (cf_video_id, session_id) values (${video}, ${sid})`), "first alert").toBe("landed");
    expect(await failure(sql`insert into seazn_held_alerts (cf_video_id, session_id) values (${video}, ${sid})`), "second alert")
      .toBe("23505:seazn_held_alerts_pkey");
    expect(await failure(sql`insert into seazn_locked_videos (cf_video_id, input_row_id) values (${video}, ${input!.id})`), "first lock").toBe("landed");
    expect(await failure(sql`insert into seazn_locked_videos (cf_video_id, input_row_id) values (${video}, ${input!.id})`), "second lock")
      .toBe("23505:seazn_locked_videos_pkey");
    expect(await failure(sql`delete from fixture_stream_inputs where id = ${input!.id}`), "a locked input cannot be deleted").toMatch(/^23503:/);
  });

  it("written once is a guard: a session's destination_kind cannot change; an input's access goes null -> value once and is then fixed", async () => {
    const r = await rig();
    const sid = await insertSession(r, r.pastedId, "youtube");
    expect(await failure(sql`update fixture_stream_sessions set destination_kind = 'seazn' where id = ${sid}`), "youtube -> seazn")
      .toBe("23514:fixture_stream_sessions_destination_kind_fixed");
    expect(await failure(sql`update fixture_stream_sessions set destination_kind = null where id = ${sid}`), "youtube -> null")
      .toBe("23514:fixture_stream_sessions_destination_kind_fixed");
    expect(await failure(sql`update fixture_stream_sessions set destination_kind = 'youtube', state = 'ending' where id = ${sid}`),
      "the same value, beside another column").toBe("landed");

    const [input] = await sql<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 0) returning id`;
    const first = { signed: true, allowedOrigins: ["seazn.club"] };
    expect(await failure(sql`update fixture_stream_inputs set access = ${sql.json(first)} where id = ${input!.id}`), "null -> value")
      .toBe("landed");
    expect(await failure(sql`update fixture_stream_inputs set access = ${sql.json({ signed: false })} where id = ${input!.id}`), "value -> other value")
      .toBe("23514:fixture_stream_inputs_access_fixed");
    expect(await failure(sql`update fixture_stream_inputs set access = null where id = ${input!.id}`), "value -> null")
      .toBe("23514:fixture_stream_inputs_access_fixed");
    expect(await failure(sql`update fixture_stream_inputs set access = ${sql.json(first)}, recordings_locked_at = now() where id = ${input!.id}`),
      "the same value, beside another column").toBe("landed");
  });
});
