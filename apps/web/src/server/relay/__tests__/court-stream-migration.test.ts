// V525 (court stream, spec docs/specs/2026-11-14-court-stream-design.md in the capture repo): a court link for a day, its
// code as a row of fixture_stream_codes with no fixture, the per-fixture court_stream switch, the session's court_link_id,
// and a capture record with no fixture. Each refusal has its accepted twin in the same `it`, so an empty schema cannot
// pass (AGENTS.md class 3): the twin fails with "relation/column does not exist" first.
//
// Real Postgres required; skipped without DATABASE_URL like every DB suite here. The tables are reached through the plain
// `sql` client: RLS is FORCEd with zero policies (the V430 pattern), so app_user would see nothing.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const newCode = (): string => Array.from(randomBytes(12), (b) => CROCKFORD[b % 32]).join("");
const tokHash = (): string => createHash("sha256").update(randomBytes(16)).digest("hex");

async function rig() {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  const [src] = await sql<{ competition_id: string }[]>`
    select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
  const [target] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc)
    values (${auth.orgId}, 'youtube', 'Club channel', ${Buffer.from("not-a-real-envelope")}) returning id`;
  const [venue] = await sql<{ id: string }[]>`insert into venues (org_id, name) values (${auth.orgId}, 'Main Arena') returning id`;
  const [court] = await sql<{ id: string }[]>`
    insert into courts (venue_id, org_id, name) values (${venue!.id}, ${auth.orgId}, 'Court 1') returning id`;
  return {
    orgId: auth.orgId, userId: randomUUID(), fixtureId, competitionId: src!.competition_id,
    targetId: target!.id, venueId: venue!.id, courtId: court!.id,
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function insertLink(r: Rig, over: { courtId?: string; orgId?: string; day?: string } = {}) {
  const [row] = await sql<{ id: string }[]>`
    insert into court_stream_links (org_id, competition_id, court_id, day, tz, opens_at, expires_at, target_id, created_by)
    values (${over.orgId ?? r.orgId}, ${r.competitionId}, ${over.courtId ?? r.courtId}, ${over.day ?? "2026-11-15"}, 'Europe/London',
            '2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z', ${r.targetId}, ${r.userId})
    returning id`;
  return row!.id;
}

async function insertCode(r: Rig, owner: { fixtureId: string | null; courtLinkId: string | null }) {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_codes (org_id, fixture_id, court_link_id, code, tok_hash, tok_enc, issued_by)
    values (${r.orgId}, ${owner.fixtureId}, ${owner.courtLinkId}, ${newCode()}, ${tokHash()}, ${Buffer.from("sealed")}, ${r.userId})
    returning id`;
  return row!.id;
}

const failure = async (p: PromiseLike<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    return `${err.code ?? "thrown"}:${err.constraint_name ?? ""}`;
  }
  return "landed";
};

describe.skipIf(!HAS_DB)("V525__court_stream_links.sql — the constraints are real", () => {
  it("court_stream_links exists with RLS enabled AND forced, no policy and no trg_set_org (the V430 pattern)", async () => {
    const rows = await sql<{ rls: boolean; forced: boolean; policies: number; triggers: number }[]>`
      select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)::int as policies,
             (select count(*) from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'trg_set_org')::int as triggers
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname = 'court_stream_links'`;
    expect(rows).toEqual([{ rls: true, forced: true, policies: 0, triggers: 0 }]);
  });

  it("a code row names exactly one owner: neither and both are refused by fixture_stream_codes_one_owner; a fixture code and a court code each land", async () => {
    const r = await rig();
    const link = await insertLink(r);
    expect(await failure(insertCode(r, { fixtureId: null, courtLinkId: null })), "no owner").toBe("23514:fixture_stream_codes_one_owner");
    expect(await failure(insertCode(r, { fixtureId: r.fixtureId, courtLinkId: link })), "two owners").toBe("23514:fixture_stream_codes_one_owner");
    expect(await failure(insertCode(r, { fixtureId: r.fixtureId, courtLinkId: null })), "a fixture's code").toBe("landed");
    expect(await failure(insertCode(r, { fixtureId: null, courtLinkId: link })), "a court's code").toBe("landed");
  });

  it("one live link per court and day; a withdrawn one frees the slot; another day or court is another key", async () => {
    const r = await rig();
    const first = await insertLink(r);
    expect(await failure(insertLink(r)), "a second live link on (court, day)").toBe("23505:court_stream_links_one_live");
    expect(await failure(insertLink(r, { day: "2026-11-16" })), "the next day").toBe("landed");
    await expect(sql`update court_stream_links set withdrawn_at = now() where id = ${first}`, "withdrawn_at without withdrawn_by")
      .rejects.toMatchObject({ code: "23514" });
    await sql`update court_stream_links set withdrawn_at = now(), withdrawn_by = ${r.userId} where id = ${first}`;
    expect(await failure(insertLink(r)), "the slot is free once the first is withdrawn").toBe("landed");
  });

  it("a link's court must be its org's (the composite FK), and opens_at < expires_at", async () => {
    const r = await rig();
    const other = await rig();
    expect(await failure(insertLink(r, { courtId: other.courtId })), "another org's court").toMatch(/^23503:/);
    await expect(sql`
      insert into court_stream_links (org_id, competition_id, court_id, day, tz, opens_at, expires_at, target_id, created_by)
      values (${r.orgId}, ${r.competitionId}, ${r.courtId}, '2026-11-20', 'Europe/London',
              '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', ${r.targetId}, ${r.userId})`, "opens_at = expires_at")
      .rejects.toMatchObject({ code: "23514" });
  });

  it("one active code per court link: a second is refused by fixture_stream_codes_one_active_court; an ended one never collides", async () => {
    const r = await rig();
    const link = await insertLink(r);
    const first = await insertCode(r, { fixtureId: null, courtLinkId: link });
    expect(await failure(insertCode(r, { fixtureId: null, courtLinkId: link })), "a second active court code")
      .toBe("23505:fixture_stream_codes_one_active_court");
    await sql`update fixture_stream_codes set ended_at = now(), end_cause = 'reissued', tok_enc = null where id = ${first}`;
    expect(await failure(insertCode(r, { fixtureId: null, courtLinkId: link })), "after the first ended").toBe("landed");
  });

  it("end_cause admits withdrawn (and still refuses an unknown word)", async () => {
    const r = await rig();
    const link = await insertLink(r);
    const id = await insertCode(r, { fixtureId: null, courtLinkId: link });
    await expect(sql`update fixture_stream_codes set ended_at = now(), end_cause = 'stolen', tok_enc = null where id = ${id}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "fixture_stream_codes_end_cause_check" });
    await sql`update fixture_stream_codes set ended_at = now(), end_cause = 'withdrawn', tok_enc = null where id = ${id}`;
    const [row] = await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where id = ${id}`;
    expect(row!.end_cause).toBe("withdrawn");
  });

  it("court_stream defaults false on a settings row that does not name it, and refuses null", async () => {
    const r = await rig();
    await sql`insert into fixture_stream_settings (fixture_id, org_id) values (${r.fixtureId}, ${r.orgId})`;
    const [row] = await sql<{ court_stream: boolean }[]>`select court_stream from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect(row!.court_stream).toBe(false);
    await expect(sql`update fixture_stream_settings set court_stream = null where fixture_id = ${r.fixtureId}`)
      .rejects.toMatchObject({ code: "23502" });
    await sql`update fixture_stream_settings set court_stream = true where fixture_id = ${r.fixtureId}`;
  });

  it("deleting a link cascades to its codes and sets a session's court_link_id null; a capture record may have no fixture", async () => {
    const shape = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
      select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = current_schema()
         and ((table_name = 'fixture_stream_sessions' and column_name = 'court_link_id')
           or (table_name = 'capture_records' and column_name = 'fixture_id')
           or (table_name = 'fixture_stream_codes' and column_name in ('fixture_id', 'court_link_id')))
       order by table_name, column_name`;
    expect(shape).toEqual([
      { table_name: "capture_records", column_name: "fixture_id", is_nullable: "YES" },
      { table_name: "fixture_stream_codes", column_name: "court_link_id", is_nullable: "YES" },
      { table_name: "fixture_stream_codes", column_name: "fixture_id", is_nullable: "YES" },
      { table_name: "fixture_stream_sessions", column_name: "court_link_id", is_nullable: "YES" },
    ]);
    const rules = await sql<{ conname: string; confdeltype: string }[]>`
      select conname, confdeltype from pg_constraint
       where contype = 'f' and confrelid = 'court_stream_links'::regclass order by conname`;
    expect(rules.map((x) => [x.conname, x.confdeltype])).toEqual([
      ["fixture_stream_codes_court_link_id_fkey", "c"],
      ["fixture_stream_sessions_court_link_id_fkey", "n"],
    ]);
    const r = await rig();
    const link = await insertLink(r);
    const code = await insertCode(r, { fixtureId: null, courtLinkId: link });
    await sql`delete from court_stream_links where id = ${link}`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where id = ${code}`;
    expect(n).toBe(0);
  });
});
