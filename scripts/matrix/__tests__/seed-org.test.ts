import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawResult, Session } from "../../bench/lib/http.ts";
import type { Transport } from "../lib/driver/http-driver.ts";
import {
  DataDirMismatch, DataDirUnset, NoPublicPlan, OrgSwitchFailed, chooseTopPublicPlan, createRealMatrixSql, gateOnOwnDataDir,
  matrixSqlOver, orgIdsFromListing, ownerEmail, prepareCaseOrg, requireOwnDataDir, switchToCaseOrg, type MatrixSql,
} from "../lib/seed-org.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const session: Session = { cookies: {} };
const reply = (status: number, json: unknown): RawResult => ({ status, json: json as never });
// The legacy `handler` envelope both /api/orgs routes answer through
// (apps/web/src/lib/http.ts handlerInner): `{ok:true, data}` or
// `{ok:false, error:"<string>"}` — never api-v1's `{error:{code}}`.
const okData = (data: unknown): RawResult => reply(200, { ok: true, data });

describe("requireOwnDataDir (Review Focus 3) — empty first", () => {
  it("unset, empty or blank refuses before any SQL", () => {
    expect(() => requireOwnDataDir({})).toThrow(DataDirUnset);
    expect(() => requireOwnDataDir({ BENCH_EXPECTED_DATA_DIR: "" })).toThrow(DataDirUnset);
    expect(() => requireOwnDataDir({ BENCH_EXPECTED_DATA_DIR: "  " })).toThrow(DataDirUnset);
  });
  it("set returns the dir (runPreflight and the SQL gate then compare it with show data_directory)", () => {
    expect(requireOwnDataDir({ BENCH_EXPECTED_DATA_DIR: "/tmp/pg-fm" })).toBe("/tmp/pg-fm");
  });
});

describe("gateOnOwnDataDir — every query waits on show data_directory (Review Focus 3)", () => {
  const recording = () => {
    const calls: string[] = [];
    const inner: MatrixSql = {
      async userIdForEmail() { calls.push("userIdForEmail"); return "u1"; },
      async insertCaseOrg(i) { calls.push("insertCaseOrg"); return { orgId: "o1", orgSlug: i.slug }; },
      async listPlanKeys() { calls.push("listPlanKeys"); return ["pro"]; },
      async variantKeysInBuilderOrder() { calls.push("variantKeysInBuilderOrder"); return ["bwf"]; },
    };
    return { calls, inner };
  };
  const everyMethod = (sql: MatrixSql) => [
    () => sql.userIdForEmail("a@b.c"),
    () => sql.insertCaseOrg({ userId: "u1", name: "n", slug: "s" }),
    () => sql.listPlanKeys(),
    () => sql.variantKeysInBuilderOrder("badminton"),
  ];

  it("a blank expected dir refuses at construction", () => {
    const { inner } = recording();
    expect(() => gateOnOwnDataDir(inner, async () => "/tmp/pg-fm", "  ")).toThrow(DataDirUnset);
  });
  it("a different data_directory refuses EVERY method, and no inner query runs", async () => {
    const { calls, inner } = recording();
    const sql = gateOnOwnDataDir(inner, async () => "/usr/local/var/postgres", "/tmp/pg-fm");
    for (const call of everyMethod(sql)) await expect(call()).rejects.toBeInstanceOf(DataDirMismatch);
    expect(calls).toEqual([]);
  });
  it("no row (an empty data_directory) is a mismatch, not a pass", async () => {
    const { calls, inner } = recording();
    const sql = gateOnOwnDataDir(inner, async () => "", "/tmp/pg-fm");
    await expect(sql.listPlanKeys()).rejects.toBeInstanceOf(DataDirMismatch);
    expect(calls).toEqual([]);
  });
  it("the matching dir lets every method through, and is read exactly once", async () => {
    const { calls, inner } = recording();
    let reads = 0;
    const sql = gateOnOwnDataDir(inner, async () => { reads++; return "/tmp/pg-fm"; }, "/tmp/pg-fm");
    for (const call of everyMethod(sql)) await call();
    expect(calls).toEqual(["userIdForEmail", "insertCaseOrg", "listPlanKeys", "variantKeysInBuilderOrder"]);
    expect(reads).toBe(1);
    expect(await sql.insertCaseOrg({ userId: "u1", name: "n", slug: "m-r-1" })).toEqual({ orgId: "o1", orgSlug: "m-r-1" });
  });
});

describe("createRealMatrixSql — refuses before it configures a client", () => {
  it("empty env: the data-dir refusal comes first, not the DATABASE_URL one", () => {
    expect(() => createRealMatrixSql({})).toThrow(DataDirUnset);
  });
  it("no BENCH_EXPECTED_DATA_DIR is DataDirUnset, even with a DATABASE_URL", () => {
    expect(() => createRealMatrixSql({ DATABASE_URL: "postgres://matrix@localhost:1/none" })).toThrow(DataDirUnset);
  });
  it("a dir but no DATABASE_URL names DATABASE_URL", () => {
    expect(() => createRealMatrixSql({ BENCH_EXPECTED_DATA_DIR: "/tmp/pg-fm" })).toThrow(/DATABASE_URL is not set/);
  });
  it("with both set it opens no connection until a query runs (dispose settles with nothing listening)", async () => {
    const { dispose } = createRealMatrixSql({ BENCH_EXPECTED_DATA_DIR: "/tmp/pg-fm", DATABASE_URL: "postgres://matrix@localhost:1/none" });
    await expect(dispose()).resolves.toBeUndefined();
  });
});

// A stand-in for the postgres.js client: a tagged template that records each
// statement (whitespace-folded, parameters as `$`) and whether it ran on the
// client or inside `begin`'s transaction. Test files are outside
// tsconfig.scripts.json, so the cast costs no type safety in shipped code.
type Stmt = { via: "db" | "tx"; text: string; values: unknown[] };
function fakeClient(dataDir: string | null, rows: (text: string) => unknown[] = () => []) {
  const seen: (Stmt | "BEGIN" | "COMMIT")[] = [];
  const tag = (via: "db" | "tx") => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    seen.push({ via, text, values });
    if (text === "show data_directory") return Promise.resolve(dataDir === null ? [] : [{ data_directory: dataDir }]);
    return Promise.resolve(rows(text));
  };
  const db = Object.assign(tag("db"), {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => { seen.push("BEGIN"); const out = await cb(tag("tx")); seen.push("COMMIT"); return out; },
    end: async () => {},
  });
  return { db: db as unknown as Parameters<typeof matrixSqlOver>[0], seen };
}
const PROBE: Stmt = { via: "db", text: "show data_directory", values: [] };

describe("matrixSqlOver — the real queries, driven over a fake client", () => {
  it("a foreign data_directory refuses every method and runs nothing but the one probe", async () => {
    const { db, seen } = fakeClient("/usr/local/var/postgres");
    const sql = matrixSqlOver(db, "/tmp/pg-fm");
    await expect(sql.insertCaseOrg({ userId: "u1", name: "n", slug: "s" })).rejects.toBeInstanceOf(DataDirMismatch);
    await expect(sql.userIdForEmail("a@b.c")).rejects.toBeInstanceOf(DataDirMismatch);
    await expect(sql.listPlanKeys()).rejects.toBeInstanceOf(DataDirMismatch);
    await expect(sql.variantKeysInBuilderOrder("badminton")).rejects.toBeInstanceOf(DataDirMismatch);
    expect(seen).toEqual([PROBE]);
  });

  it("insertCaseOrg: createOrgForUser's three inserts, in its order, in ONE transaction, owner bound", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", (text) =>
      text.startsWith("insert into subscriptions") ? [{ id: "s1" }]
      : text.startsWith("insert into organizations") ? [{ id: "o1", slug: "m-r-1" }]
      : []);
    const out = await matrixSqlOver(db, "/tmp/pg-fm").insertCaseOrg({ userId: "u1", name: "Matrix 1", slug: "m-r-1" });
    expect(out).toEqual({ orgId: "o1", orgSlug: "m-r-1" });
    expect(seen.map((s) => (typeof s === "string" ? s : `${s.via} ${s.text.split(" (")[0]}`))).toEqual([
      "db show data_directory", "BEGIN", "tx insert into subscriptions", "tx insert into organizations", "tx insert into org_members", "COMMIT",
    ]);
    const stmts = seen.filter((s): s is Stmt => typeof s !== "string");
    expect(stmts.map((s) => s.values)).toEqual([[], ["u1"], ["Matrix 1", "m-r-1", "u1", "s1", null], ["o1", "u1"]]);
    expect(stmts[3]!.text).toMatch(/values \(\$, \$, 'owner'\)$/);
  });

  it("show data_directory answering no row is a mismatch, and nothing else runs", async () => {
    const { db, seen } = fakeClient(null);
    await expect(matrixSqlOver(db, "/tmp/pg-fm").listPlanKeys()).rejects.toBeInstanceOf(DataDirMismatch);
    expect(seen).toEqual([PROBE]);
  });

  it("userIdForEmail binds the email and is loud when no users row answers, not an undefined id", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm");
    await expect(matrixSqlOver(db, "/tmp/pg-fm").userIdForEmail("delivered+matrix-x@resend.dev")).rejects.toThrow(/no users row/);
    expect(seen[1]).toMatchObject({ via: "db", values: ["delivered+matrix-x@resend.dev"] });
  });

  it("variantKeysInBuilderOrder restates the builder's RLS scope for a fresh org, in the builder's order", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", (text) => (text.startsWith("select key from sport_variants") ? [{ key: "bwf" }, { key: "short" }] : []));
    expect(await matrixSqlOver(db, "/tmp/pg-fm").variantKeysInBuilderOrder("badminton")).toEqual(["bwf", "short"]);
    expect(seen[1]).toEqual({ via: "db", text: "select key from sport_variants where sport_key = $ and org_id is null order by is_system desc, name", values: ["badminton"] });
  });

  it("listPlanKeys reads the whole plans catalogue", async () => {
    const { db } = fakeClient("/tmp/pg-fm", (text) => (text === "select key from plans order by key" ? [{ key: "community" }, { key: "pro" }] : []));
    expect(await matrixSqlOver(db, "/tmp/pg-fm").listPlanKeys()).toEqual(["community", "pro"]);
  });
});

describe("chooseTopPublicPlan — empty first", () => {
  it("no candidates, or none public, refuses", () => {
    expect(() => chooseTopPublicPlan([])).toThrow(NoPublicPlan);
    expect(() => chooseTopPublicPlan([{ plan_key: "staff", is_public: false, privilege: 99 }])).toThrow(NoPublicPlan);
  });
  it("highest privilege among PUBLIC plans; ties by codepoint key", () => {
    expect(chooseTopPublicPlan([
      { plan_key: "community", is_public: true, privilege: 3 },
      { plan_key: "secret", is_public: false, privilege: 50 },
      { plan_key: "pro", is_public: true, privilege: 9 },
      { plan_key: "org", is_public: true, privilege: 9 },
    ])).toBe("org");
  });
});

describe("switchToCaseOrg (Review Focus 4)", () => {
  const transport = (listing: RawResult, switched: RawResult = okData({ ok: true })) => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const t: Transport = {
      async raw(_b, _s, path, method = "GET", body) {
        calls.push({ method, path, body });
        return path === "/api/orgs/active" ? switched : listing;
      },
    };
    return { t, calls };
  };

  it("switches with the product's body, then proves the org is listed", async () => {
    const { t, calls } = transport(okData([{ id: "o1", role: "owner" }, { id: "o2", role: "owner" }]));
    await switchToCaseOrg(t, "http://localhost:1", session, "o2");
    expect(calls).toEqual([
      { method: "POST", path: "/api/orgs/active", body: { org_id: "o2" } },
      { method: "GET", path: "/api/orgs", body: undefined },
    ]);
  });
  it("a listing without the org is OrgSwitchFailed naming the user-orgs cache", async () => {
    const { t } = transport(okData([{ id: "o1", role: "owner" }]));
    const err = await switchToCaseOrg(t, "http://localhost:1", session, "o2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSwitchFailed);
    expect((err as Error).message).toMatch(/not in GET \/api\/orgs/);
    expect((err as Error).message).toMatch(/orgs:<uid>/);
  });
  it("a refused switch is OrgSwitchFailed carrying the product's (redacted) reason", async () => {
    // What a stale orgs:<uid> cache actually produces: getOrgRole misses the
    // SQL-seeded org, the route throws a plain Error, the handler answers 500.
    const { t, calls } = transport(okData([{ id: "o2" }]), reply(500, { ok: false, error: "You are not a member of this organization token=abc123secret" }));
    const err = await switchToCaseOrg(t, "http://localhost:1", session, "o2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSwitchFailed);
    expect((err as Error).message).toMatch(/POST \/api\/orgs\/active → 500: You are not a member of this organization/);
    expect((err as Error).message).not.toContain("abc123secret");
    expect(calls).toHaveLength(1);
  });
  it("a 2xx that is not the handler's ok envelope (a followed redirect, raw()'s 'no json') is a refused switch", async () => {
    const { t } = transport(okData([{ id: "o2" }]), reply(200, { ok: false, error: "no json" }));
    await expect(switchToCaseOrg(t, "http://localhost:1", session, "o2")).rejects.toThrow(/POST \/api\/orgs\/active → 200: no json/);
  });
  it("a failed listing is OrgSwitchFailed with its status and reason, not a shape error", async () => {
    const { t } = transport(reply(401, { ok: false, error: "Not signed in" }));
    const err = await switchToCaseOrg(t, "http://localhost:1", session, "o2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSwitchFailed);
    expect((err as Error).message).toMatch(/GET \/api\/orgs → 401: Not signed in/);
  });
  it("orgIdsFromListing accepts array, {orgs}, {data}; refuses anything else", () => {
    expect(orgIdsFromListing([{ id: "a" }])).toEqual(["a"]);
    expect(orgIdsFromListing({ orgs: [{ id: "b" }] })).toEqual(["b"]);
    expect(orgIdsFromListing({ data: [{ id: "c" }] })).toEqual(["c"]);
    // The named refusal, not a TypeError from mapping over null.
    expect(() => orgIdsFromListing({ nope: 1 })).toThrow(/unrecognised GET \/api\/orgs shape/);
  });
});

describe("prepareCaseOrg", () => {
  const fakeSql = (order: string[]): MatrixSql => ({
    async userIdForEmail() { return "u1"; },
    async insertCaseOrg(i) { order.push(`insert ${i.userId} ${i.name} ${i.slug}`); return { orgId: "o9", orgSlug: i.slug }; },
    async listPlanKeys() { return []; },
    async variantKeysInBuilderOrder() { return []; },
  });

  it("inserts, switches, then provisions — in that order", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, _s, path, method = "GET") { order.push(`${method} ${path}`); return path === "/api/orgs" ? okData([{ id: "o9", role: "owner" }]) : okData({ ok: true }); } };
    const out = await prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session, userId: "u1", plan: "pro", provision: async (o, p) => { order.push(`provision ${o} ${p}`); } }, { name: "Matrix 1", slug: "m-r-1" });
    expect(out).toEqual({ orgId: "o9", orgSlug: "m-r-1" });
    expect(order).toEqual(["insert u1 Matrix 1 m-r-1", "POST /api/orgs/active", "GET /api/orgs", "provision o9 pro"]);
  });
  it("a failed switch never provisions (provisioning elevates the owner to superadmin in SQL)", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, _s, path, method = "GET") { order.push(`${method} ${path}`); return okData([{ id: "o1" }]); } };
    await expect(prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session, userId: "u1", plan: "pro", provision: async () => { order.push("provision"); } }, { name: "Matrix 1", slug: "m-r-1" })).rejects.toBeInstanceOf(OrgSwitchFailed);
    expect(order).not.toContain("provision");
  });
});

describe("ownerEmail (R14a: synthetic identities only)", () => {
  it("is the synthetic resend.dev sink for a slug-safe run id", () => {
    expect(ownerEmail("fm-w1a-a")).toBe("delivered+matrix-fm-w1a-a@resend.dev");
  });
  it("refuses a run id that is not slug-safe — empty, or one that could smuggle a real address", () => {
    for (const bad of ["", "Run-1", "x@gmail.com", "a b", "a+b", "../x"]) expect(() => ownerEmail(bad), bad).toThrow(/run id/);
  });
});

describe("R14a: every seed-org error that echoes an input redacts it", () => {
  it("DataDirMismatch and the run-id refusal", async () => {
    const leak = "token=abc123secret";
    const gated = gateOnOwnDataDir({} as MatrixSql, async () => `/tmp/x ${leak}`, "/tmp/pg-fm");
    const mismatch = await gated.listPlanKeys().catch((e: unknown) => e);
    expect(mismatch).toBeInstanceOf(DataDirMismatch);
    expect((mismatch as Error).message).not.toContain("abc123secret");
    const runIdErr = (() => { try { ownerEmail(leak); return null; } catch (e) { return e as Error; } })();
    expect(runIdErr?.message).toMatch(/run id/);
    expect(runIdErr?.message).not.toContain("abc123secret");
  });
});

// ---------------------------------------------------------------------------
// The mirror pin. seed-org inserts a case org the way createOrgForUser does,
// minus the max_owned quota check (the reason SQL is used at all). A product
// change to those inserts must red here, and so must a harness edit that
// drifts from them — so both sides are read from source, never typed in.
// ---------------------------------------------------------------------------

const AUTH = readFileSync(resolve(REPO, "apps/web/src/lib/auth.ts"), "utf8");
const SEED = readFileSync(resolve(REPO, "scripts/matrix/lib/seed-org.ts"), "utf8");

/** From `start` to the next top-level `export` (or the end of the file). */
function fnBody(src: string, start: string): string {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`mirror pin: "${start}" not found`);
  const next = src.indexOf("\nexport ", at + start.length);
  return src.slice(at, next < 0 ? undefined : next);
}

interface Insert { table: string; columns: string[]; values: string[] }
const INSERT = /insert into (\w+)\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/g;
function insertsIn(body: string): Insert[] {
  return [...body.matchAll(INSERT)].map((m) => ({
    table: m[1]!,
    columns: m[2]!.split(",").map((c) => c.trim()),
    // A `${…}` is a bound parameter whatever expression feeds it; a literal
    // ('community', 'active', 1, 'owner') must match character for character.
    values: m[3]!.split(",").map((v) => v.trim()).map((v) => (v.startsWith("${") ? "$param" : v)),
  }));
}

describe("mirror pin: createOrgForUser's inserts (a product change reds here)", () => {
  const body = fnBody(AUTH, "export async function createOrgForUser");

  it("still inserts subscriptions, organizations, org_members with the columns seed-org mirrors", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/insert into subscriptions\s*\(\s*owner_user_id,\s*plan_key,\s*status,\s*quantity_paid\s*\)/);
    expect(body).toMatch(/insert into organizations\s*\(\s*name,\s*slug,\s*created_by,\s*subscription_id,\s*referred_by_org_id\s*\)/);
    expect(body).toMatch(/insert into org_members\s*\(\s*org_id,\s*user_id,\s*role\s*\)/);
  });

  it("parser discovery guard: exactly the three inserts on each side (none parsed would pass vacuously)", () => {
    expect(insertsIn(body).map((i) => i.table)).toEqual(["subscriptions", "organizations", "org_members"]);
    expect(insertsIn(fnBody(SEED, "export function matrixSqlOver")).map((i) => i.table)).toEqual(["subscriptions", "organizations", "org_members"]);
  });

  it("seed-org's inserts equal the product's: same tables, same columns, same literal values ('owner', 'community', 'active', 1)", () => {
    expect(insertsIn(fnBody(SEED, "export function matrixSqlOver"))).toEqual(insertsIn(body));
  });
});

describe("mirror pin: the owner lookup (lib/users.ts resolveOrCreateUser)", () => {
  it("seed-org finds the user by the predicate the magic-link sign-in resolved it by", () => {
    const USERS = readFileSync(resolve(REPO, "apps/web/src/lib/users.ts"), "utf8");
    const product = [...fnBody(USERS, "export async function resolveOrCreateUser").matchAll(/select id from users where (.+?) limit 1`/g)].map((m) => m[1]);
    const ours = /select id from users where (.+?)`/.exec(fnBody(SEED, "export function matrixSqlOver"))?.[1];
    expect(product, "resolveOrCreateUser's two reads").toHaveLength(2);
    expect(new Set(product).size).toBe(1);
    expect(ours).toBe(product[0]);
  });
});

describe("mirror pin: the division builder's variant list (d/new/page.tsx)", () => {
  const PAGE = readFileSync(resolve(REPO, "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/new/page.tsx"), "utf8");
  it("the builder still selects sport_variants with NO where of its own (RLS scopes it), and seed-org orders it the same way", () => {
    // No where between FROM and ORDER BY: the only scoping is V227's policy,
    // which seed-org restates. A product filter added here must red.
    const page = /select sport_key, key, name, is_system from sport_variants\s+order by ([^`]+)`/.exec(PAGE);
    const ours = /from sport_variants where sport_key = \$\{sportKey\} and org_id is null\s+order by ([^`]+)`/.exec(SEED);
    expect(page, "builder query moved or gained a filter").not.toBeNull();
    expect(ours, "seed-org's variant query moved").not.toBeNull();
    expect(ours![1]!.trim()).toBe(page![1]!.trim());
  });
});
