// Realtime push-nudges §4.5 — the subscriber JWTs this app mints carry
// `role: authenticated` and work with the public anon key against PostgREST,
// on many phones. They must never be able to read more than the anon key
// alone. Three invariants, swept over every migration (and, where the
// database is a Supabase one, over the live catalog):
//
//   (a) no policy outside `realtime.messages` lists `authenticated`, `anon`
//       or `public` in its roles (a policy with no TO clause applies to
//       PUBLIC, so it counts);
//   (b) every SELECT granted to `authenticated` is also granted to `anon`
//       (a token never widens anon);
//   (c) every `realtime.messages` policy keys on exactly one JWT claim
//       (`auth.jwt() ->> '<claim>'`, or `-> '<claim>'` for a jsonb array),
//       and no two policies share one (the V452 rule).
//
// Anti-vacuity: each half reports what it scanned (files, policies, grants);
// zero files, zero policies, zero grants, or fewer than two realtime policies
// fails. The checkers are also run on synthetic SQL, both ways, so a
// checker that can never fire cannot pass here.
//
// The DB-level half runs only with DATABASE_URL set AND an `authenticated`
// role present (a Supabase database). A plain Postgres — local labels, CI —
// has no such role, so the half skips and says why.
//
// Applies to another sport: N/A (no sport rules).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectionOptions } from "@/lib/db";

const MIGRATIONS = resolve(__dirname, "../../../../../db/migration");
/** The roles a minted token (or the anon key) acts as. */
const TOKEN_ROLES = new Set(["authenticated", "anon", "public"]);
const REALTIME_TABLE = "realtime.messages";

type Policy = { file: string; name: string; table: string; roles: string[]; text: string };
type Grant = { file: string; privileges: string[]; objects: string[]; grantees: string[] };

/** Every `V*.sql` under `dir`, recursively. */
function migrationFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return migrationFiles(path);
    return /^V\d.*\.sql$/.test(entry) ? [path] : [];
  });
}

/** SQL without its comments, so a `create policy` in a comment is not a policy. */
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const unquote = (s: string) => s.trim().replace(/^"|"$/g, "").toLowerCase();

/** The text of each statement starting at `start`: up to the next `;` or `$sql$` (a statement run by `execute`). */
function statements(sql: string, start: RegExp): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(start)) {
    const rest = sql.slice(m.index);
    const end = rest.search(/;|\$sql\$/);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

function parsePolicies(file: string, raw: string): Policy[] {
  return statements(stripComments(raw), /\bcreate\s+policy\b/gi).map((text) => {
    const m = /^create\s+policy\s+("(?:[^"]|"")+"|\S+)\s+on\s+(\S+)([\s\S]*)$/i.exec(text);
    if (!m) throw new Error(`${file}: unparsed create policy: ${text.slice(0, 120)}`);
    const head = m[3]!.split(/\busing\b|\bwith\s+check\b/i)[0]!;
    const to = /\bto\s+([\s\S]+)$/i.exec(head);
    // PostgreSQL: a policy with no TO clause applies to PUBLIC.
    const roles = to ? to[1]!.split(",").map(unquote).filter(Boolean) : ["public"];
    return { file, name: unquote(m[1]!), table: unquote(m[2]!), roles, text };
  });
}

function parseGrants(file: string, raw: string): Grant[] {
  return statements(stripComments(raw), /\bgrant\s+(?!option\b)/gi).flatMap((text) => {
    const m = /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*$/i.exec(
      text.trim(),
    );
    if (!m) return []; // `grant <role> to <role>`: membership, not a privilege on an object
    const objects = m[2]!.trim().toLowerCase().replace(/\s+/g, " ").replace(/^table /, "");
    return [
      {
        file,
        privileges: m[1]!.split(",").map((p) => p.trim().toLowerCase().replace(/\s+/g, " ")),
        objects: objects.startsWith("all ") ? [objects] : objects.split(",").map(unquote),
        grantees: m[3]!.split(",").map(unquote),
      },
    ];
  });
}

/** The JWT claims a policy's text reads: `auth.jwt() ->> 'x'`, `(select auth.jwt()) -> 'x'`. */
const claimsRead = (text: string) =>
  [...text.matchAll(/auth\.jwt\(\)\s*\)?\s*->>?\s*'([^']+)'/gi)].map((m) => m[1]!.toLowerCase());

const grantsSelect = (g: Grant) => g.privileges.some((p) => p === "select" || p === "all" || p === "all privileges");

/** (a) Policies outside realtime.messages that name a token role. */
function tokenRolePolicies(policies: Policy[]): string[] {
  return policies
    .filter((p) => p.table !== REALTIME_TABLE && p.roles.some((r) => TOKEN_ROLES.has(r)))
    .map((p) => `${p.file}: policy ${p.name} on ${p.table} to ${p.roles.join(", ")}`);
}

/** (b) Objects whose SELECT goes to `authenticated` with no SELECT to `anon`. */
function authenticatedOnlySelects(grants: Grant[]): { checked: number; failures: string[] } {
  const anon = new Set(
    grants.filter((g) => grantsSelect(g) && g.grantees.includes("anon")).flatMap((g) => g.objects),
  );
  const authed = grants.filter((g) => grantsSelect(g) && g.grantees.includes("authenticated"));
  const failures = authed.flatMap((g) =>
    g.objects.filter((o) => !anon.has(o)).map((o) => `${g.file}: select on ${o} to authenticated, not to anon`),
  );
  return { checked: authed.length, failures };
}

/** (c) Realtime policies that read other than one claim, or share a claim with another policy. */
function realtimeClaimFailures(policies: Policy[]): { realtime: number; failures: string[] } {
  const realtime = policies.filter((p) => p.table === REALTIME_TABLE);
  const failures: string[] = [];
  const owners = new Map<string, Set<string>>();
  for (const p of realtime) {
    const claims = claimsRead(p.text);
    if (claims.length !== 1) failures.push(`${p.file}: ${p.name} reads ${claims.length} claims (${claims.join(", ")})`);
    // The same policy re-created by a later migration (V537 over V403/V452) is one owner.
    for (const c of claims) owners.set(c, (owners.get(c) ?? new Set()).add(p.name));
  }
  for (const [claim, names] of owners) {
    if (names.size > 1) failures.push(`claim ${claim} shared by ${[...names].join(" and ")}`);
  }
  return { realtime: realtime.length, failures };
}

describe("§4.5 role sweep — the checkers fire (synthetic SQL, both ways)", () => {
  const pol = (sql: string) => parsePolicies("synthetic.sql", sql);
  const grt = (sql: string) => parseGrants("synthetic.sql", sql);

  it("(a) flags a token role on an app table, a policy with no TO clause, and a list; passes app_user and realtime.messages", () => {
    expect(tokenRolePolicies(pol("create policy p on public.fixtures for select to authenticated using (true);"))).toHaveLength(1);
    expect(tokenRolePolicies(pol("create policy p on fixtures using (true);")), "no TO clause = PUBLIC").toHaveLength(1);
    expect(tokenRolePolicies(pol('create policy "p q" on fixtures for all to app_user, "anon" using (true);'))).toHaveLength(1);
    expect(tokenRolePolicies(pol("create policy p on fixtures for all to app_user using (org_id = x) with check (true);"))).toEqual([]);
    expect(
      tokenRolePolicies(pol("execute $sql$ create policy \"r\" on realtime.messages for select to authenticated using (true) $sql$;")),
    ).toEqual([]);
    // A policy named in a comment is not a policy.
    expect(pol("-- create policy p on fixtures to anon\nselect 1;")).toEqual([]);
  });

  it("(b) flags an authenticated-only SELECT; passes one shared with anon in the same or another statement", () => {
    expect(authenticatedOnlySelects(grt("grant select on public_x_v to authenticated;")).failures).toHaveLength(1);
    expect(authenticatedOnlySelects(grt("grant all on table t to authenticated;")).failures).toHaveLength(1);
    expect(authenticatedOnlySelects(grt("grant select on public_x_v to anon, authenticated;")).failures).toEqual([]);
    const split = authenticatedOnlySelects(grt("grant select on v to authenticated;\ngrant select on v to anon;"));
    expect(split).toEqual({ checked: 1, failures: [] });
    expect(authenticatedOnlySelects(grt("grant select on a, b to authenticated; grant select on a to anon;")).failures).toEqual([
      "synthetic.sql: select on b to authenticated, not to anon",
    ]);
    // Role membership and `with grant option` are not new statements.
    expect(grt("grant app_user to postgres;")).toEqual([]);
    expect(grt("grant select on t to app_user with grant option;")).toHaveLength(1);
  });

  it("(c) flags zero claims, two claims, and a shared claim; passes one claim per policy and a re-created policy", () => {
    const rt = (name: string, using: string) =>
      `create policy "${name}" on realtime.messages for select to authenticated using (${using}) $sql$;`;
    expect(realtimeClaimFailures(pol(rt("a", "true"))).failures).toHaveLength(1);
    expect(
      realtimeClaimFailures(pol(rt("a", "(select auth.jwt() ->> 'x') = (select auth.jwt() ->> 'y')"))).failures,
    ).toHaveLength(1);
    expect(
      realtimeClaimFailures(pol(rt("a", "(select auth.jwt() ->> 'x') = 'a'") + rt("b", "(select auth.jwt() ->> 'x') = 'b'"))).failures,
    ).toEqual(["claim x shared by a and b"]);
    expect(
      realtimeClaimFailures(pol(rt("a", "(select auth.jwt() ->> 'x') = 'a'") + rt("a", "(select auth.jwt() ->> 'x') = 'a'"))),
    ).toEqual({ realtime: 2, failures: [] });
    // V556's shape: a jsonb array claim read with `->`.
    expect(claimsRead("((select auth.jwt()) -> 'division_ids') ? substr((select realtime.topic()), 10)")).toEqual([
      "division_ids",
    ]);
  });
});

describe("§4.5 role sweep — every migration (static)", () => {
  const files = migrationFiles(MIGRATIONS);
  const policies = files.flatMap((f) => parsePolicies(relative(MIGRATIONS, f), readFileSync(f, "utf8")));
  const grants = files.flatMap((f) => parseGrants(relative(MIGRATIONS, f), readFileSync(f, "utf8")));

  it("scans every migration: files, policies and grants all non-zero", () => {
    const b = authenticatedOnlySelects(grants);
    const c = realtimeClaimFailures(policies);
    console.log(
      `[role-sweep static] files: ${files.length}, policies: ${policies.length} (realtime.messages: ${c.realtime}), ` +
        `grants: ${grants.length} (SELECT to authenticated: ${b.checked})`,
    );
    expect(files.length, "migration files scanned").toBeGreaterThan(0);
    expect(policies.length, "create policy statements scanned").toBeGreaterThan(0);
    expect(grants.length, "grant statements scanned").toBeGreaterThan(0);
    // V403 and V452 (each re-created by V537): fewer than two means the parser lost them.
    expect(c.realtime, "realtime.messages policies scanned").toBeGreaterThanOrEqual(2);
  });

  it("(a) no policy outside realtime.messages names authenticated, anon or public", () => {
    expect(tokenRolePolicies(policies)).toEqual([]);
  });

  it("(b) every SELECT granted to authenticated is also granted to anon", () => {
    expect(authenticatedOnlySelects(grants).failures).toEqual([]);
  });

  it("(c) every realtime.messages policy keys on exactly one claim, and no two share one", () => {
    expect(realtimeClaimFailures(policies).failures).toEqual([]);
  });
});

describe("§4.5 role sweep — the live catalog (Supabase databases only)", () => {
  it("(a) on pg_policies and (b) on information_schema.role_table_grants", async (ctx) => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      const why = "DB-level half skipped: DATABASE_URL is not set";
      console.log(`[role-sweep] ${why}`);
      return ctx.skip(why);
    }
    const { ssl } = connectionOptions(url);
    const client = postgres(url, { max: 1, ssl, onnotice: () => {} });
    try {
      const [role] = await client<{ present: boolean }[]>`
        select exists (select 1 from pg_roles where rolname = 'authenticated') as present`;
      if (!role!.present) {
        const why =
          "DB-level half skipped: no `authenticated` role in this database (plain Postgres, not Supabase — " +
          "no minted token can act here)";
        console.log(`[role-sweep] ${why}`);
        return ctx.skip(why);
      }

      const policies = await client<{ schemaname: string; tablename: string; policyname: string; roles: string[] }[]>`
        select schemaname, tablename, policyname, roles::text[] as roles from pg_policies`;
      const tokenRole = policies
        .filter((p) => !(p.schemaname === "realtime" && p.tablename === "messages"))
        .filter((p) => p.roles.some((r) => TOKEN_ROLES.has(r)))
        .map((p) => `${p.schemaname}.${p.tablename}: policy ${p.policyname} to ${p.roles.join(", ")}`);

      const grants = await client<{ table_schema: string; table_name: string; grantee: string }[]>`
        select table_schema, table_name, grantee from information_schema.role_table_grants
        where privilege_type = 'SELECT' and grantee in ('authenticated', 'anon')`;
      const [scanned] = await client<{ n: number }[]>`
        select count(*)::int as n from information_schema.role_table_grants`;
      const anon = new Set(grants.filter((g) => g.grantee === "anon").map((g) => `${g.table_schema}.${g.table_name}`));
      const authed = grants.filter((g) => g.grantee === "authenticated").map((g) => `${g.table_schema}.${g.table_name}`);
      const widening = authed.filter((t) => !anon.has(t)).map((t) => `${t}: select to authenticated, not to anon`);

      console.log(
        `[role-sweep live] policies: ${policies.length}, table grants: ${scanned!.n} ` +
          `(SELECT to authenticated: ${authed.length})`,
      );
      expect(policies.length, "pg_policies rows scanned").toBeGreaterThan(0);
      expect(scanned!.n, "role_table_grants rows scanned").toBeGreaterThan(0);
      expect(tokenRole, "(a) a token role on a policy outside realtime.messages").toEqual([]);
      expect(widening, "(b) an authenticated SELECT that anon does not have").toEqual([]);
    } finally {
      await client.end({ timeout: 2 });
    }
  });
});
