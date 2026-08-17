// RLS coverage — every tenant table isolated. Real Postgres required; skipped
// without DATABASE_URL.
//
// `scripts/check-rls.ts` is the same gate, but it runs ONLY in the smoke CI
// job, which is PR-only. This suite runs in the ordinary test job, so a new
// `org_id` table that forgets isolation fails on the first CI run rather than
// on whichever later run happens to include smoke.
//
// The guard it duplicates was itself dead for its whole life: it filtered on
// schema `public` while every table here lives in `seazn_club`, so it selected
// ZERO rows and printed "RLS guard OK". Hence the first assertion below — a
// coverage gate that can silently check nothing is worse than no gate, so this
// suite fails if it is ever looking at an empty table set.
import { describe, expect, it, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { SUPERUSER_ONLY } from "../../../../../scripts/rls-exempt.ts";

const HAS_DB = !!process.env.DATABASE_URL;
const SCHEMA = process.env.DB_SCHEMA ?? "seazn_club";

interface TenantTable {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: number;
}

async function tenantTables(): Promise<TenantTable[]> {
  return sql<TenantTable[]>`
    select
      c.relname                                   as table_name,
      c.relrowsecurity                            as rls_enabled,
      c.relforcerowsecurity                       as rls_forced,
      (select count(*)::int from pg_policies p
        where p.schemaname = ${SCHEMA} and p.tablename = c.relname) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${SCHEMA}
      and c.relkind = 'r'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = ${SCHEMA}
          and col.table_name = c.relname
          and col.column_name = 'org_id'
      )
    order by c.relname`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("RLS coverage (doc 03 §9)", () => {
  it("is actually looking at tenant tables — an empty set is a dead gate, not a pass", async () => {
    // The assertion that would have caught the schema bug on day one. The floor
    // is deliberately well below today's count (54) so it does not need editing
    // every time a table lands, but far above zero.
    const rows = await tenantTables();
    expect(rows.length).toBeGreaterThan(40);
  });

  it("every org_id table enables and FORCEs RLS and carries a policy", async () => {
    const rows = await tenantTables();
    const failures = rows
      .filter((r) => !SUPERUSER_ONLY.has(r.table_name))
      .filter((r) => !r.rls_enabled || !r.rls_forced || r.policies === 0)
      .map((r) =>
        !r.rls_enabled
          ? `${r.table_name}: RLS not enabled`
          : !r.rls_forced
            ? `${r.table_name}: RLS not FORCEd (owner bypasses)`
            : `${r.table_name}: no policy`,
      );
    // FORCE matters as much as ENABLE: without it the table owner bypasses its
    // own policy, and the app's migrations run as the owner.
    expect(failures).toEqual([]);
  });

  it("exempts only tables that exist — a stale name hides a real gap", async () => {
    // A renamed or dropped table left in SUPERUSER_ONLY is an exemption nobody
    // re-examines, and it silently covers for whatever takes its place.
    //
    // Existence, not membership of the tenant set: two entries
    // (`subscriptions`, `impersonation_sessions`) have no `org_id` column at
    // all today, so the guard never sees them and their exemption is currently
    // inert. That is deliberate and pre-emptive — the reason they are exempt
    // (superuser/admin-only, never a tenant session) holds whether or not they
    // ever grow an `org_id` — so asserting they are in the tenant set would
    // fail on a correct list.
    const existing = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = ${SCHEMA} and table_type = 'BASE TABLE'`;
    const present = new Set(existing.map((r) => r.table_name));
    const stale = [...SUPERUSER_ONLY].filter((t) => !present.has(t));
    expect(stale).toEqual([]);
  });
});
