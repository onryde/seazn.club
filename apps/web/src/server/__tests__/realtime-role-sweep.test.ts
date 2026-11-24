// Realtime push-nudges §4.5 — the subscriber JWTs this app mints carry
// `role: authenticated` and work with the public anon key against PostgREST,
// on many phones. They must never be able to read more than the anon key
// alone. Three invariants, swept over every migration (and, where the
// database is a Supabase one, over the live catalog):
//
//   (a) no policy outside `realtime.messages` lists `authenticated`, `anon`
//       or `public` in its roles — `create policy` or `alter policy … to`
//       (a create with no TO clause applies to PUBLIC, so it counts);
//   (b) every privilege granted to `authenticated` is also granted to `anon`
//       (a token never widens anon): compared privilege by privilege —
//       table privileges column by column, EXECUTE, USAGE, and `all`
//       expanded by object kind;
//   (c) every `realtime.messages` policy keys on exactly one JWT claim
//       (`auth.jwt() ->> '<claim>'`, or `-> '<claim>'` for a jsonb array),
//       and no two policies share one (the V452 rule).
//
// Backstop: any non-comment `authenticated` or `anon` anywhere else in a
// migration fails, so a shape the parsers miss (`execute format('grant …')`, a
// revoke from anon, default privileges, a role-membership grant, `granted by`)
// still reds. The mentions inside realtime.messages policies are pinned by
// file and policy.
//
// Known blind spot: the comment stripper does not know string literals, so a
// `--` or `/*` INSIDE a quoted string is read as the start of a comment and
// the rest of that line (or up to the next `*/`) is dropped. Contrived — no
// policy or grant sits after such a string today — and an unparseable
// `create policy` throws at collection rather than passing.
//
// Anti-vacuity: each half reports what it scanned (files, policies, grants);
// zero files, zero policies or zero grants fails, and the realtime.messages
// policy statements are pinned at an EXACT count (6 since V555), so one more
// or one fewer fails until the pin moves on purpose. The checkers are also
// run on synthetic SQL, both ways, so a checker that can never fire cannot
// pass here.
//
// The DB-level half runs only with DATABASE_URL set AND the `authenticated`
// and `anon` roles present (a Supabase database). A plain Postgres — local
// labels, CI — has neither, so the half skips and says why. It reads the
// ACLs through has_*_privilege, which answers for the role whoever asks and
// counts PUBLIC, inherited and column grants (information_schema views show
// only grants the caller is party to).
//
// Applies to another sport: N/A (no sport rules).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Every Flyway migration under `dir`, recursively: versioned `V<n>…sql` and repeatable `R__…sql`. */
function migrationFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return migrationFiles(path);
    return /^(?:V\d|R__).*\.sql$/.test(entry) ? [path] : [];
  });
}

/** SQL without its comments, so a `create policy` in a comment is not a policy. */
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const unquote = (s: string) => s.trim().replace(/^"|"$/g, "").toLowerCase();

/** A possibly schema-qualified identifier with each dotted part unquoted: `"realtime"."messages"` → `realtime.messages`. */
const unquoteIdent = (s: string) =>
  (s.trim().match(/"(?:[^"]|"")*"|[^."]+/g) ?? []).map((part) => unquote(part).replace(/""/g, '"')).join(".");

/** Each statement starting at `start`, with where it starts: up to the next `;` or `$sql$` (a statement run by `execute`). */
function statements(sql: string, start: RegExp): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  for (const m of sql.matchAll(start)) {
    const rest = sql.slice(m.index);
    const end = rest.search(/;|\$sql\$/);
    out.push({ index: m.index, text: end === -1 ? rest : rest.slice(0, end) });
  }
  return out;
}

/** `s` split on `sep` outside parentheses: `select (id, name), insert` is two privileges, not three. */
function splitTopLevel(s: string, sep = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Every `create policy` and `alter policy`, with its span in the comment-stripped text. A create with no TO
 *  clause applies to PUBLIC; an alter with no TO clause (or a rename) changes no roles, so it lists none. */
function policyStatements(file: string, sql: string): (Policy & { start: number; end: number })[] {
  return statements(sql, /\b(?:create|alter)\s+policy\b/gi).map(({ index, text }) => {
    const m = /^(create|alter)\s+policy\s+("(?:[^"]|"")+"|\S+)\s+on\s+(\S+)([\s\S]*)$/i.exec(text);
    if (!m) throw new Error(`${file}: unparsed policy statement: ${text.slice(0, 120)}`);
    const create = m[1]!.toLowerCase() === "create";
    const rest = m[4]!;
    const head = rest.split(/\busing\b|\bwith\s+check\b/i)[0]!;
    const to = /^\s*rename\s+to\b/i.test(rest) ? null : /\bto\s+([\s\S]+)$/i.exec(head);
    const roles = to ? to[1]!.split(",").map(unquote).filter(Boolean) : create ? ["public"] : [];
    return { file, name: unquote(m[2]!), table: unquoteIdent(m[3]!), roles, text, start: index, end: index + text.length };
  });
}

function parsePolicies(file: string, raw: string): Policy[] {
  return policyStatements(file, stripComments(raw));
}

function parseGrants(file: string, raw: string): Grant[] {
  return statements(stripComments(raw), /\bgrant\s+(?!option\b)/gi).flatMap(({ text }) => {
    const m =
      /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?(?:\s+granted\s+by\s+\S+)?\s*$/i.exec(
        text.trim(),
      );
    if (!m) return []; // `grant <role> to <role>`: membership, not a privilege on an object (the backstop sees it)
    return [
      {
        file,
        privileges: splitTopLevel(m[1]!).map((p) => p.toLowerCase().replace(/\s+/g, " ")),
        // The whole object list; `objectsOf` splits it (outside parentheses, by kind).
        objects: [m[2]!.trim().toLowerCase().replace(/\s+/g, " ")],
        grantees: m[3]!.split(",").map(unquote),
      },
    ];
  });
}

/**
 * Backstop: every non-comment `authenticated` / `anon` in a migration. Inside a realtime.messages policy it is a
 * hit (pinned by file and policy below); anywhere else it fails — whatever the shape: `execute format('grant …')`,
 * a revoke from anon, default privileges, a role-membership grant, `granted by`, a policy the parsers miss.
 */
function tokenRoleMentions(file: string, raw: string): { hits: { file: string; policy: string }[]; failures: string[] } {
  const sql = stripComments(raw);
  const realtime = policyStatements(file, sql).filter((p) => p.table === REALTIME_TABLE);
  const hits: { file: string; policy: string }[] = [];
  const failures: string[] = [];
  for (const m of sql.matchAll(/\b(authenticated|anon)\b/gi)) {
    const inside = realtime.find((p) => m.index >= p.start && m.index < p.end);
    if (inside) hits.push({ file, policy: inside.name });
    else failures.push(`${file}: '${m[1]}' outside a realtime.messages policy: …${sql.slice(Math.max(0, m.index - 60), m.index + 30).replace(/\s+/g, " ")}…`);
  }
  return { hits, failures };
}

/** The distinct JWT claims a policy's text reads: `auth.jwt() ->> 'x'`, `(select auth.jwt()) -> 'x'`. One
 *  claim read twice is one claim. */
const claimsRead = (text: string) => [
  ...new Set([...text.matchAll(/auth\.jwt\(\)\s*\)?\s*->>?\s*'([^']+)'/gi)].map((m) => m[1]!.toLowerCase())),
];

/** (a) Policies outside realtime.messages that name a token role. */
function tokenRolePolicies(policies: Policy[]): string[] {
  return policies
    .filter((p) => p.table !== REALTIME_TABLE && p.roles.some((r) => TOKEN_ROLES.has(r)))
    .map((p) => `${p.file}: policy ${p.name} on ${p.table} to ${p.roles.join(", ")}`);
}

/** The privileges `grant all` means on a table (PostgreSQL 17, GRANT; MAINTAIN is new in 17). */
const TABLE_PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"];
/** …and on every other kind of object. */
const ALL_PRIVILEGES: Record<string, string[]> = {
  table: TABLE_PRIVILEGES,
  sequence: ["usage", "select", "update"],
  function: ["execute"],
  schema: ["usage", "create"],
  database: ["create", "connect", "temporary"],
  usage: ["usage"],
  "large object": ["select", "update"],
  tablespace: ["create"],
};
/** `grant all (cols)`: the privileges a column can carry. */
const COLUMN_PRIVILEGES = ["select", "insert", "update", "references"];
const KIND: Record<string, string> = {
  table: "table",
  tables: "table",
  sequence: "sequence",
  sequences: "sequence",
  function: "function",
  functions: "function",
  procedure: "function",
  procedures: "function",
  routine: "function",
  routines: "function",
  schema: "schema",
  schemas: "schema",
  database: "database",
  type: "usage",
  types: "usage",
  domain: "usage",
  language: "usage",
  "foreign data wrapper": "usage",
  "foreign server": "usage",
  "large object": "large object",
  tablespace: "tablespace",
};

/** An object list's kind and one key per object: `function f(int, text), g()` → `function f(int, text)`,
 *  `function g()`; a bare name is a table; `all tables in schema s` and default privileges' `tables` stay whole. */
function objectsOf(objects: string): { kind: string; keys: string[] } {
  const o = objects.trim().toLowerCase().replace(/\s+/g, " ");
  const inSchema = /^all (tables|sequences|functions|procedures|routines) in schema /.exec(o);
  if (inSchema) return { kind: KIND[inSchema[1]!]!, keys: [o] };
  if (/^(tables|sequences|functions|procedures|routines|types|schemas)$/.test(o)) return { kind: KIND[o]!, keys: [`default ${o}`] };
  const prefixed =
    /^(table|sequence|function|procedure|routine|schema|database|type|domain|language|foreign data wrapper|foreign server|large object|tablespace) (.+)$/.exec(
      o,
    );
  const word = prefixed?.[1] ?? "table";
  const names = splitTopLevel(prefixed?.[2] ?? o).map(unquoteIdent);
  return { kind: KIND[word]!, keys: names.map((n) => (word === "table" ? n : `${word} ${n}`)) };
}

/** One grant's (object, privilege, column) triples for one grantee; `*` is the whole object. */
function grantedTriples(g: Grant, grantee: string): { key: string; priv: string; col: string }[] {
  if (!g.grantees.includes(grantee)) return [];
  const out: { key: string; priv: string; col: string }[] = [];
  for (const objects of g.objects) {
    const { kind, keys } = objectsOf(objects);
    for (const entry of g.privileges) {
      const m = /^([a-z ]+?)\s*(?:\((.*)\))?$/.exec(entry);
      if (!m) throw new Error(`${g.file}: unparsed privilege ${entry}`);
      const name = m[1] === "all privileges" ? "all" : m[1] === "temp" ? "temporary" : m[1]!;
      const cols = m[2] === undefined ? ["*"] : splitTopLevel(m[2]).map(unquote);
      const privs = name === "all" ? (m[2] === undefined ? ALL_PRIVILEGES[kind]! : COLUMN_PRIVILEGES) : [name];
      for (const key of keys) for (const priv of privs) for (const col of cols) out.push({ key, priv, col });
    }
  }
  return out;
}

/** (b) Every privilege granted to `authenticated` that `anon` lacks, one privilege (and column) at a time. A
 *  whole-object grant to anon covers every column; a column grant to anon covers only that column. */
function authenticatedWidening(grants: Grant[]): { checked: number; failures: string[] } {
  const anon = new Set(grants.flatMap((g) => grantedTriples(g, "anon")).map((t) => `${t.key}|${t.priv}|${t.col}`));
  const authed = grants.flatMap((g) => grantedTriples(g, "authenticated").map((t) => ({ ...t, file: g.file })));
  const failures = authed
    .filter((t) => !anon.has(`${t.key}|${t.priv}|*`) && !(t.col !== "*" && anon.has(`${t.key}|${t.priv}|${t.col}`)))
    .map((t) => `${t.file}: ${t.priv}${t.col === "*" ? "" : ` (${t.col})`} on ${t.key} to authenticated, not to anon`);
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

describe("§4.5 role sweep — which files are migrations", () => {
  it("versioned V*.sql and repeatable R__*.sql, in every subdirectory; nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-sweep-"));
    try {
      mkdirSync(join(dir, "deltas"));
      for (const f of ["V1__a.sql", "R__b.sql", "deltas/R__c.sql", "deltas/V2__d.sql", "x.sql", "README.md", "R_e.sql"]) {
        writeFileSync(join(dir, f), "select 1;");
      }
      expect(migrationFiles(dir).map((f) => relative(dir, f)).sort()).toEqual([
        "R__b.sql",
        "V1__a.sql",
        "deltas/R__c.sql",
        "deltas/V2__d.sql",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    // A quoted, dotted name is the same table: each part unquoted.
    expect(pol('create policy p on "realtime"."messages" for select to authenticated using (true);')[0]!.table).toBe(
      "realtime.messages",
    );
    expect(tokenRolePolicies(pol('create policy p on "realtime".messages to anon using (true);'))).toEqual([]);
    expect(tokenRolePolicies(pol('create policy p on "public"."fixtures" to anon using (true);'))).toEqual([
      "synthetic.sql: policy p on public.fixtures to anon",
    ]);
    // A policy named in a comment is not a policy.
    expect(pol("-- create policy p on fixtures to anon\nselect 1;")).toEqual([]);
  });

  it("(b) flags an authenticated-only SELECT; passes one shared with anon in the same or another statement", () => {
    expect(authenticatedWidening(grt("grant select on public_x_v to authenticated;")).failures).toHaveLength(1);
    expect(authenticatedWidening(grt("grant all on table t to authenticated;")).failures).toHaveLength(TABLE_PRIVILEGES.length);
    expect(authenticatedWidening(grt("grant select on public_x_v to anon, authenticated;")).failures).toEqual([]);
    const split = authenticatedWidening(grt("grant select on v to authenticated;\ngrant select on v to anon;"));
    expect(split).toEqual({ checked: 1, failures: [] });
    expect(authenticatedWidening(grt("grant select on a, b to authenticated; grant select on a to anon;")).failures).toEqual([
      "synthetic.sql: select on b to authenticated, not to anon",
    ]);
    // Role membership and `with grant option` are not new statements.
    expect(grt("grant app_user to postgres;")).toEqual([]);
    expect(grt("grant select on t to app_user with grant option;")).toHaveLength(1);
  });

  it("(a) reads `alter policy … to …` too; a rename or an alter with no TO changes no roles", () => {
    expect(tokenRolePolicies(pol("alter policy p on public.fixtures to authenticated;"))).toHaveLength(1);
    expect(tokenRolePolicies(pol("alter policy p on fixtures to app_user, anon using (true);"))).toHaveLength(1);
    expect(tokenRolePolicies(pol("alter policy p on fixtures rename to q;"))).toEqual([]);
    // A rename TO a token role's name is still a rename: without the rename guard this reads as `to anon`.
    expect(tokenRolePolicies(pol("alter policy p on t rename to anon;"))).toEqual([]);
    expect(tokenRolePolicies(pol("alter policy p on fixtures using (org_id = x);"))).toEqual([]);
  });

  it("(b) every privilege, one by one: ALL expands by object kind, a column grant covers only its columns", () => {
    const w = (sql: string) => authenticatedWidening(grt(sql)).failures;
    // Tables: ALL is the eight table privileges (PostgreSQL 17, GRANT).
    expect(TABLE_PRIVILEGES).toEqual(["select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"]);
    expect(w("grant all on t to authenticated; grant select, insert, update, delete, truncate, references, trigger, maintain on t to anon;")).toEqual([]);
    expect(w("grant all privileges on t to authenticated; grant select on t to anon;")).toHaveLength(7);
    expect(w("grant insert on t to authenticated; grant select on t to anon;")).toEqual([
      "synthetic.sql: insert on t to authenticated, not to anon",
    ]);
    expect(w("grant delete on t to authenticated; grant all on t to anon;")).toEqual([]);
    // Columns: anon's table-wide grant covers every column; a column grant covers only its own.
    expect(w("grant select (a) on t to authenticated; grant select on t to anon;")).toEqual([]);
    expect(w("grant select (a, b) on t to authenticated; grant select (a) on t to anon;")).toEqual([
      "synthetic.sql: select (b) on t to authenticated, not to anon",
    ]);
    expect(w("grant select on t to authenticated; grant select (a) on t to anon;")).toHaveLength(1);
    expect(w("grant update (a) on t to authenticated;")).toHaveLength(1);
    // Functions, sequences, schemas.
    expect(w("grant execute on function f(int, text) to authenticated;")).toEqual([
      "synthetic.sql: execute on function f(int, text) to authenticated, not to anon",
    ]);
    expect(w("grant execute on function f(int, text) to anon, authenticated;")).toEqual([]);
    expect(w("grant all on function f() to authenticated; grant execute on function f() to anon;")).toEqual([]);
    expect(w("grant usage on schema s to authenticated;")).toHaveLength(1);
    expect(w("grant all on schema s to authenticated; grant usage, create on schema s to anon;")).toEqual([]);
    expect(w("grant all on sequence q to authenticated; grant usage, select, update on sequence q to anon;")).toEqual([]);
    expect(w("grant usage on sequence q to authenticated;")).toHaveLength(1);
    expect(w("alter default privileges grant execute on functions to authenticated;")).toHaveLength(1);
  });

  it("(b) reads a column-list SELECT and strips `granted by`", () => {
    expect(authenticatedWidening(grt("grant select (id, name) on x to authenticated;")).failures).toEqual([
      "synthetic.sql: select (id) on x to authenticated, not to anon",
      "synthetic.sql: select (name) on x to authenticated, not to anon",
    ]);
    expect(grt("grant select (id, name), insert on x to app_user;")[0]!.privileges).toEqual(["select (id, name)", "insert"]);
    expect(authenticatedWidening(grt("grant select on x to authenticated granted by postgres;")).failures).toHaveLength(1);
  });

  it("backstop: authenticated/anon anywhere outside a realtime.messages policy fails — every shape a parser could miss", () => {
    const mention = (sql: string) => tokenRoleMentions("synthetic.sql", sql);
    const SHAPES = [
      "do $$ begin execute format('grant select on %I to authenticated', 't'); end $$;",
      "revoke select on public_x_v from anon;",
      "alter default privileges in schema public grant select on tables to authenticated;",
      "grant authenticated to app_user;",
      "grant select on x to app_user granted by anon;",
      "create policy p on fixtures for select to anon using (true);",
    ];
    let checked = 0;
    for (const sql of SHAPES) {
      expect(mention(sql).failures, sql).toHaveLength(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every shape").toBe(SHAPES.length);
    // Inside a realtime.messages policy it is a hit with its policy, not a failure; a comment is nothing.
    expect(
      mention('execute $sql$ create policy "r p" on realtime.messages for select to authenticated using (true) $sql$;'),
    ).toEqual({ hits: [{ file: "synthetic.sql", policy: "r p" }], failures: [] });
    expect(mention("-- grant select on x to anon\nselect 1;")).toEqual({ hits: [], failures: [] });
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
    // The same claim read twice is still ONE claim.
    expect(
      realtimeClaimFailures(pol(rt("a", "(select auth.jwt() ->> 'x') is not null and topic = (select auth.jwt() ->> 'x')")))
        .failures,
    ).toEqual([]);
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

  it("scans every migration: files, policies and grants non-zero; realtime.messages policies exactly 6", () => {
    const b = authenticatedWidening(grants);
    const c = realtimeClaimFailures(policies);
    const repeatable = files.filter((f) => /(^|\/)R__[^/]*$/.test(f)).length;
    console.log(
      `[role-sweep static] files: ${files.length} (repeatable R__: ${repeatable}), ` +
        `policies: ${policies.length} (realtime.messages: ${c.realtime}), ` +
        `grants: ${grants.length} (privileges to authenticated: ${b.checked})`,
    );
    expect(files.length, "migration files scanned").toBeGreaterThan(0);
    expect(policies.length, "create policy statements scanned").toBeGreaterThan(0);
    expect(grants.length, "grant statements scanned").toBeGreaterThan(0);
    // V403 and V452, each re-created by V537, plus V554's capture pairing policy and V555's match day policy.
    // Pinned: a new realtime policy (V556) moves this on purpose.
    expect(c.realtime, "realtime.messages policy statements scanned").toBe(6);
  });

  it("(a) no policy outside realtime.messages names authenticated, anon or public", () => {
    expect(tokenRolePolicies(policies)).toEqual([]);
  });

  it("(b) every privilege granted to authenticated is also granted to anon", () => {
    expect(authenticatedWidening(grants).failures).toEqual([]);
  });

  it("(c) every realtime.messages policy keys on exactly one claim, and no two share one", () => {
    expect(realtimeClaimFailures(policies).failures).toEqual([]);
  });

  it("backstop: authenticated/anon appear only inside the six known realtime.messages policy statements", () => {
    const all = files.map((f) => tokenRoleMentions(relative(MIGRATIONS, f), readFileSync(f, "utf8")));
    const hits = all.flatMap((m) => m.hits).map((h) => `${h.file} :: ${h.policy}`);
    console.log(`[role-sweep static] authenticated/anon mentions: ${hits.length} (all inside realtime.messages policies)`);
    expect(all.flatMap((m) => m.failures)).toEqual([]);
    // Pinned by file and policy: a new realtime policy (V556) adds its line here on purpose.
    expect(hits.sort()).toEqual([
      "deltas/V403__realtime_fixture_broadcast_policy.sql :: fixture broadcast read by claim",
      "deltas/V452__online_chess_realtime_policy.sql :: external play lobby read by claim",
      "deltas/V537__org_has_feature_plpgsql.sql :: external play lobby read by claim",
      "deltas/V537__org_has_feature_plpgsql.sql :: fixture broadcast read by claim",
      "deltas/V554__pairing_realtime_policy.sql :: capture pairing read by claim",
      "deltas/V555__match_day_realtime_policy.sql :: match day code read by claim",
    ]);
  });
});

describe("§4.5 role sweep — the live catalog (Supabase databases only)", () => {
  it("(a) on pg_policies and (b), every privilege, on the ACLs themselves (has_*_privilege)", async (ctx) => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      const why = "DB-level half skipped: DATABASE_URL is not set";
      console.log(`[role-sweep] ${why}`);
      return ctx.skip(why);
    }
    const { ssl } = connectionOptions(url);
    const client = postgres(url, { max: 1, ssl, onnotice: () => {} });
    try {
      const [roles] = await client<{ present: number }[]>`
        select count(*)::int as present from pg_roles where rolname in ('authenticated', 'anon')`;
      if (roles!.present < 2) {
        const why =
          "DB-level half skipped: no `authenticated`/`anon` roles in this database (plain Postgres, not " +
          "Supabase — no minted token can act here)";
        console.log(`[role-sweep] ${why}`);
        return ctx.skip(why);
      }

      const policies = await client<{ schemaname: string; tablename: string; policyname: string; roles: string[] }[]>`
        select schemaname, tablename, policyname, roles::text[] as roles from pg_policies`;
      const tokenRole = policies
        .filter((p) => !(p.schemaname === "realtime" && p.tablename === "messages"))
        .filter((p) => p.roles.some((r) => TOKEN_ROLES.has(r)))
        .map((p) => `${p.schemaname}.${p.tablename}: policy ${p.policyname} to ${p.roles.join(", ")}`);

      // The ACLs themselves, whoever is asking: has_*_privilege counts PUBLIC and inherited (member-of) grants,
      // and column grants — none of which information_schema.role_table_grants shows to a non-member caller.
      // Every privilege, one at a time: table privileges (MAINTAIN from PostgreSQL 17) and, per column, the four a
      // column carries; EXECUTE on functions; sequence and schema privileges.
      const [version] = await client<{ n: number }[]>`select current_setting('server_version_num')::int as n`;
      const tablePrivs = TABLE_PRIVILEGES.filter((p) => p !== "maintain" || version!.n >= 170000).map((p) =>
        p.toUpperCase(),
      );
      const kinds = await client<{ kind: string; checked: number; anon_select: number; widening: string[] }[]>`
        with ns as (
          select oid, nspname from pg_namespace
          where nspname not in ('pg_catalog', 'information_schema') and nspname !~ '^pg_(toast|temp)'
        ), rel as (
          select c.oid, c.relkind, quote_ident(ns.nspname) || '.' || quote_ident(c.relname) as obj
          from pg_class c join ns on ns.oid = c.relnamespace
        ), checks as (
          select 'table' as kind, rel.obj as object, p as privilege,
                 has_table_privilege('anon', rel.oid, p) as anon,
                 has_table_privilege('authenticated', rel.oid, p) as authed
          from rel cross join unnest(${client.array(tablePrivs)}::text[]) p
          where rel.relkind in ('r', 'v', 'm', 'f', 'p')
          union all
          select 'column', rel.obj || '.' || quote_ident(a.attname), p,
                 has_column_privilege('anon', rel.oid, a.attnum, p),
                 has_column_privilege('authenticated', rel.oid, a.attnum, p)
          from rel join pg_attribute a on a.attrelid = rel.oid and a.attnum > 0 and not a.attisdropped
          cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
          where rel.relkind in ('r', 'v', 'm', 'f', 'p')
          union all
          select 'sequence', rel.obj, p,
                 has_sequence_privilege('anon', rel.oid, p), has_sequence_privilege('authenticated', rel.oid, p)
          from rel cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) p
          where rel.relkind = 'S'
          union all
          select 'function', pr.oid::regprocedure::text, 'EXECUTE',
                 has_function_privilege('anon', pr.oid, 'EXECUTE'),
                 has_function_privilege('authenticated', pr.oid, 'EXECUTE')
          from pg_proc pr join ns on ns.oid = pr.pronamespace
          union all
          select 'schema', quote_ident(ns.nspname), p,
                 has_schema_privilege('anon', ns.oid, p), has_schema_privilege('authenticated', ns.oid, p)
          from ns cross join unnest(array['USAGE', 'CREATE']) p
        )
        select kind, count(*)::int as checked,
               (count(*) filter (where anon and privilege = 'SELECT'))::int as anon_select,
               coalesce(array_agg(kind || ' ' || object || ' ' || privilege order by object, privilege)
                 filter (where authed and not anon), '{}') as widening
        from checks group by kind order by kind`;
      const checked = Object.fromEntries(kinds.map((k) => [k.kind, k.checked]));
      const anonSelect = kinds.reduce((n, k) => n + k.anon_select, 0);
      const widening = kinds.flatMap((k) => k.widening);

      console.log(
        `[role-sweep live] policies: ${policies.length}, privileges checked ${JSON.stringify(checked)}, ` +
          `SELECT anon has (table or column): ${anonSelect}`,
      );
      expect(policies.length, "pg_policies rows scanned").toBeGreaterThan(0);
      for (const kind of ["table", "column", "function", "schema"]) {
        expect(checked[kind] ?? 0, `${kind} privileges checked`).toBeGreaterThan(0);
      }
      expect(anonSelect, "SELECT anon has (Supabase grants anon some)").toBeGreaterThan(0);
      expect(tokenRole, "(a) a token role on a policy outside realtime.messages").toEqual([]);
      expect(widening, "(b) a privilege authenticated has and anon does not").toEqual([]);
    } finally {
      await client.end({ timeout: 2 });
    }
  });
});
