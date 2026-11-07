// Quick match plan 1, Task 1 — the `V*__quick_matches.sql` migration (spec 2026-11-03-quick-match-design.md §7.1-7.2).
// The table holds every guest-specific fact; the system org and its user are the one tenant and the one actor every guest
// row belongs to. Behaviour only: the entitlement values the create path needs are proven by the tests that need them
// (Task 5's quota, Task 8's device link), never pinned here (pre-flight D6; standing rule, owner 2026-10-20).
//
// Catalog reads are scoped to current_schema(): a shared database may hold the same table in another schema.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  QUICK_MATCH_SYSTEM_ORG_ID,
  QUICK_MATCH_SYSTEM_USER_EMAIL,
  QUICK_MATCH_SYSTEM_USER_ID,
} from "@/lib/quick-match-constants";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("quick_matches migration", () => {
  it("creates the table with RLS forced and the tenant policy", async () => {
    const [t] = await sql`
      select c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relname = 'quick_matches'`;
    expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await sql`
      select policyname from pg_policies where schemaname = current_schema() and tablename = 'quick_matches'`;
    expect(pol.map((p) => p.policyname)).toEqual(["quick_matches_tenant"]);
  });

  it("seeds the system org and its user, with no members", async () => {
    const [org] = await sql`select name, slug, created_by from organizations where id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(org).toEqual({
      name: "Seazn quick matches",
      slug: "seazn-quick-matches",
      created_by: QUICK_MATCH_SYSTEM_USER_ID,
    });
    const members = await sql`select 1 from org_members where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(members).toHaveLength(0);
  });

  it("the system user has no sign-in credential", async () => {
    const [u] = await sql`
      select email, password_hash, google_sub, email_verified from users where id = ${QUICK_MATCH_SYSTEM_USER_ID}`;
    expect(u).toEqual({
      email: QUICK_MATCH_SYSTEM_USER_EMAIL,
      password_hash: null,
      google_sub: null,
      email_verified: false,
    });
  });
});
