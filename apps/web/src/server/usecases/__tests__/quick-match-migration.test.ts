// Quick match plan 1, Task 1 — the `V*__quick_matches.sql` migration (spec 2026-11-03-quick-match-design.md §7.1-7.2), and
// plan 5 Task 1's V517 (the League + Knockout format and the cut decision column).
// The table holds every guest-specific fact; the system org and its user are the one tenant and the one actor every guest
// row belongs to. Behavior only: the entitlement values the create path needs are proven by the tests that need them
// (Task 5's quota, Task 8's device link), never pinned here (pre-flight D6; standing rule, owner 2026-10-20).
//
// Catalog reads are scoped to current_schema(): a shared database may hold the same table in another schema.
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  QUICK_MATCH_SYSTEM_ORG_ID,
  QUICK_MATCH_SYSTEM_ORG_SLUG,
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
    // The literal above is the migration's own value; this ties the code's constant to the seeded row, so the two cannot
    // drift apart (the constants file says "change one and you change both").
    expect(org!.slug, "QUICK_MATCH_SYSTEM_ORG_SLUG names the seeded org").toBe(QUICK_MATCH_SYSTEM_ORG_SLUG);
    const members = await sql`select 1 from org_members where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(members).toHaveLength(0);
  });

  // Plan 5 Task 1 (V517; spec 2026-11-12-quick-match-league-knockout §5, §11; D1, D5): the League + Knockout format, and the
  // guests' one answer to a tie at the cut. Each case inserts a real row (a competition of its own, the system org) inside
  // one transaction that is rolled back, each statement in its own savepoint so a refused one does not abort the rest.
  // [case, format, cut_decision as JSON text (null: SQL null), the constraint that refuses it (null: accepted)].
  // A stored decision is D5's shape: {how: "pick" | "toss", through: [ids], tie: [ids], at: iso}. Each refused shape below
  // drops or bends ONE field of an otherwise whole decision, so the case that refuses it can only be that field's clause.
  const at = '"at":"2026-11-13T20:00:00Z"';
  const D = "quick_matches_cut_decision_object";
  const V517: [string, string, string | null, string | null][] = [
    // The empty case first: today's league with no decision.
    ["a league with no decision", "league", null, null],
    ["the legacy knockout format, kept for its rows", "knockout", null, null],
    ["league_knockout with no decision yet", "league_knockout", null, null],
    ["league_knockout with a toss decision (D5's shape)", "league_knockout", `{"how":"toss","through":["a"],"tie":["a","b"],${at}}`, null],
    ["league_knockout with a pick decision (D5's shape)", "league_knockout", `{"how":"pick","through":["c"],"tie":["b","c"],${at}}`, null],
    ["an unknown format", "swiss", null, "quick_matches_format_check"],
    ["a decision that is an array", "league_knockout", "[]", D],
    ["a decision that is a string", "league_knockout", '"pick"', D],
    ["a decision that is a number", "league_knockout", "2", D],
    ["a decision that is JSON null (not SQL null)", "league_knockout", "null", D],
    ["a decision that is an empty object", "league_knockout", "{}", D],
    // A missing key reads as SQL NULL, and a CHECK that evaluates to NULL PASSES: these are the cases that prove it can't.
    ["a decision with no how", "league_knockout", `{"through":["a"],"tie":["a","b"],${at}}`, D],
    ["a decision whose how is neither pick nor toss", "league_knockout", `{"how":"coin","through":["a"],"tie":["a","b"],${at}}`, D],
    ["a decision whose through is not an array", "league_knockout", `{"how":"toss","through":"a","tie":["a","b"],${at}}`, D],
    ["a decision with no tie", "league_knockout", `{"how":"toss","through":["a"],${at}}`, D],
    ["a decision whose at is not a string", "league_knockout", '{"how":"toss","through":["a"],"tie":["a","b"],"at":20261113}', D],
  ];

  it("V517: quick_matches takes league_knockout and a cut decision that is null or D5's shape, nothing else (counted)", async () => {
    const ROLLBACK = new Error("rollback");
    const seen: string[] = [];
    await sql
      .begin(async (tx) => {
        for (const [name, format, decision, refusedBy] of V517) {
          const attempt = tx.savepoint(async (sp) => {
            const [comp] = await sp<{ id: string }[]>`
              insert into competitions (org_id, name, slug)
              values (${QUICK_MATCH_SYSTEM_ORG_ID}, 'V517 probe', ${`v517-${randomUUID().slice(0, 8)}`}) returning id`;
            const [row] = await sp<{ format: string; cut_decision: unknown }[]>`
              insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, cut_decision)
              values (${QUICK_MATCH_SYSTEM_ORG_ID}, ${comp!.id}, 'V517 probe', ${format}, ${randomBytes(32).toString("hex")},
                      ${randomBytes(48)}, ${randomBytes(32).toString("hex")}, ${decision}::text::jsonb)
              returning format, cut_decision`;
            return row!;
          });
          if (refusedBy === null) {
            const row = await attempt;
            expect(row.format, name).toBe(format);
            expect(row.cut_decision, name).toEqual(decision === null ? null : JSON.parse(decision));
          } else {
            await expect(attempt, name).rejects.toMatchObject({ code: "23514", constraint_name: refusedBy });
          }
          seen.push(name);
        }
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
    expect(seen, "anti-vacuity: every case ran").toEqual(V517.map(([name]) => name));
    expect(V517).toHaveLength(16);
  });

  it("V517: the decision column is nullable jsonb with no default, so a new match has none (D5: the first write wins)", async () => {
    const [col] = await sql`
      select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = current_schema() and table_name = 'quick_matches' and column_name = 'cut_decision'`;
    expect(col).toEqual({ data_type: "jsonb", is_nullable: "YES", column_default: null });
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
