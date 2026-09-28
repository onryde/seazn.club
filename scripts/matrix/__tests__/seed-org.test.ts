import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawResult, Session } from "../../bench/lib/http.ts";
import type { Transport } from "../lib/driver/http-driver.ts";
import {
  DataDirMismatch, DataDirUnset, NoPublicPlan, ORG_COOKIE, OrgSwitchFailed, chooseTopPublicPlan, createRealMatrixSql, gateOnOwnDataDir,
  matrixSqlOver, ownerEmail, prepareCaseOrg, requireOwnDataDir, switchToCaseOrg, type MatrixSql,
} from "../lib/seed-org.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AUTH = readFileSync(resolve(REPO, "apps/web/src/lib/auth.ts"), "utf8");
/** The active-org cookie's name as the PRODUCT spells it (auth.ts), never typed
 *  here: the fakes write this name, so a seed-org constant that drifts from it
 *  fails the switch tests as well as the pin below. */
const PRODUCT_ORG_COOKIE = /\nconst ORG_COOKIE = "([^"]+)";/.exec(AUTH)?.[1] ?? "(ORG_COOKIE not found in auth.ts)";
const fresh = (): Session => ({ cookies: {} });
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
  // Construction is all this can show: the client is built inside, so no fake
  // can count connects. That no query runs before the proof is shown over a
  // fake client in the matrixSqlOver block below.
  it("with both set it constructs without throwing, and dispose settles (nothing listens on the port)", async () => {
    const { dispose } = createRealMatrixSql({ BENCH_EXPECTED_DATA_DIR: "/tmp/pg-fm", DATABASE_URL: "postgres://matrix@localhost:1/none" });
    await expect(dispose()).resolves.toBeUndefined();
  });
});

// A stand-in for the postgres.js client: a tagged template that records each
// statement (whitespace-folded, parameters as `$`) and whether it ran on the
// client or inside `begin`'s transaction. Test files are outside
// tsconfig.scripts.json, so the cast costs no type safety in shipped code.
type Stmt = { via: "db" | "tx"; text: string; values: unknown[] };
/** `txDataDir` is what `show data_directory` answers INSIDE a transaction —
 *  standing in for the connection postgres.js silently reconnected to. */
function fakeClient(dataDir: string | null, rows: (text: string) => unknown[] = () => [], txDataDir: string | null = dataDir) {
  const seen: (Stmt | "BEGIN" | "COMMIT" | "ROLLBACK")[] = [];
  const tag = (via: "db" | "tx") => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    seen.push({ via, text, values });
    const dir = via === "db" ? dataDir : txDataDir;
    if (text === "show data_directory") return Promise.resolve(dir === null ? [] : [{ data_directory: dir }]);
    return Promise.resolve(rows(text));
  };
  const db = Object.assign(tag("db"), {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => {
      seen.push("BEGIN");
      try { const out = await cb(tag("tx")); seen.push("COMMIT"); return out; } catch (e) { seen.push("ROLLBACK"); throw e; }
    },
    end: async () => {},
  });
  return { db: db as unknown as Parameters<typeof matrixSqlOver>[0], seen };
}
const PROBE: Stmt = { via: "db", text: "show data_directory", values: [] };
const INSERT_ROWS = (text: string): unknown[] =>
  text.startsWith("insert into subscriptions") ? [{ id: "s1" }]
  : text.startsWith("insert into organizations") ? [{ id: "o1", slug: "m-r-1" }]
  : [];
const shape = (seen: ReturnType<typeof fakeClient>["seen"]) => seen.map((s) => (typeof s === "string" ? s : `${s.via} ${s.text.split(" (")[0]}`));

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
    const { db, seen } = fakeClient("/tmp/pg-fm", INSERT_ROWS);
    const out = await matrixSqlOver(db, "/tmp/pg-fm").insertCaseOrg({ userId: "u1", name: "Matrix 1", slug: "m-r-1" });
    expect(out).toEqual({ orgId: "o1", orgSlug: "m-r-1" });
    expect(shape(seen)).toEqual([
      "db show data_directory", "BEGIN", "tx show data_directory", "tx insert into subscriptions", "tx insert into organizations", "tx insert into org_members", "COMMIT",
    ]);
    const stmts = seen.filter((s): s is Stmt => typeof s !== "string");
    expect(stmts.map((s) => s.values)).toEqual([[], [], ["u1"], ["Matrix 1", "m-r-1", "u1", "s1", null], ["o1", "u1"]]);
    expect(stmts[4]!.text).toMatch(/values \(\$, \$, 'owner'\)$/);
  });

  it("insertCaseOrg re-proves the data dir on the transaction's own connection: a reconnect to a foreign server aborts before any insert", async () => {
    // The memoised client-level proof passed; the connection the writes ride
    // on now answers another server's directory.
    const { db, seen } = fakeClient("/tmp/pg-fm", INSERT_ROWS, "/usr/local/var/postgres");
    await expect(matrixSqlOver(db, "/tmp/pg-fm").insertCaseOrg({ userId: "u1", name: "n", slug: "s" })).rejects.toBeInstanceOf(DataDirMismatch);
    expect(shape(seen)).toEqual(["db show data_directory", "BEGIN", "tx show data_directory", "ROLLBACK"]);
  });

  it("insertCaseOrg: the transaction's probe answering no row is a mismatch too, not a pass", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", INSERT_ROWS, null);
    await expect(matrixSqlOver(db, "/tmp/pg-fm").insertCaseOrg({ userId: "u1", name: "n", slug: "s" })).rejects.toBeInstanceOf(DataDirMismatch);
    expect(shape(seen)).toEqual(["db show data_directory", "BEGIN", "tx show data_directory", "ROLLBACK"]);
  });

  it("insertCaseOrg proves EVERY case's transaction, not just the first", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", INSERT_ROWS);
    const sql = matrixSqlOver(db, "/tmp/pg-fm");
    await sql.insertCaseOrg({ userId: "u1", name: "Matrix 1", slug: "m-r-1" });
    await sql.insertCaseOrg({ userId: "u1", name: "Matrix 2", slug: "m-r-2" });
    expect(shape(seen).filter((s) => s.endsWith("show data_directory"))).toEqual(["db show data_directory", "tx show data_directory", "tx show data_directory"]);
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

describe("switchToCaseOrg (Review Focus 4) — the switch holds only if the session carries the org cookie", () => {
  // What the switch changes is ONE cookie: setActiveOrgId writes the product's
  // ORG_COOKIE (auth.ts) and bench raw() copies each Set-Cookie into the
  // session jar. `sets` is what this fake answer's Set-Cookie would write.
  const transport = (switched: RawResult, sets: (orgId: string) => string | undefined = (orgId) => orgId) => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const t: Transport = {
      async raw(_b, s, path, method = "GET", body) {
        calls.push({ method, path, body });
        const value = sets((body as { org_id: string }).org_id);
        if (value !== undefined) s.cookies[PRODUCT_ORG_COOKIE] = value;
        return switched;
      },
    };
    return { t, calls };
  };

  it("posts the product's body once, and the session then carries the org cookie for that org", async () => {
    const { t, calls } = transport(okData({ ok: true }));
    const s = fresh();
    await switchToCaseOrg(t, "http://localhost:1", s, "o2");
    expect(calls).toEqual([{ method: "POST", path: "/api/orgs/active", body: { org_id: "o2" } }]);
    expect(s.cookies[PRODUCT_ORG_COOKIE]).toBe("o2");
  });
  it("200 {ok:true} that sets no cookie is OrgSwitchFailed — the next call would act in another org", async () => {
    const { t } = transport(okData({ ok: true }), () => undefined);
    const err = await switchToCaseOrg(t, "http://localhost:1", fresh(), "o2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSwitchFailed);
    expect((err as Error).message).toMatch(/cookie is unset/);
  });
  it("a cookie for a different org is OrgSwitchFailed", async () => {
    const { t } = transport(okData({ ok: true }), () => "o1");
    const err = await switchToCaseOrg(t, "http://localhost:1", fresh(), "o2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSwitchFailed);
    expect((err as Error).message).toMatch(/cookie is "o1"/);
  });
  it("a cookie already holding this org does not count: only THIS answer's Set-Cookie proves the switch", async () => {
    const { t } = transport(okData({ ok: true }), () => undefined);
    const s: Session = { cookies: { [PRODUCT_ORG_COOKIE]: "o2" } };
    await expect(switchToCaseOrg(t, "http://localhost:1", s, "o2")).rejects.toBeInstanceOf(OrgSwitchFailed);
  });
  it("a refused switch is OrgSwitchFailed carrying the product's (redacted) reason and naming the user-orgs cache", async () => {
    // What a stale orgs:<uid> cache actually produces: getOrgRole misses the
    // SQL-seeded org, the route throws a plain Error, the handler answers 500.
    const { t, calls } = transport(reply(500, { ok: false, error: "You are not a member of this organization token=abc123secret" }), () => undefined);
    const err = await switchToCaseOrg(t, "http://localhost:1", fresh(), "o2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSwitchFailed);
    expect((err as Error).message).toMatch(/POST \/api\/orgs\/active → 500: You are not a member of this organization/);
    expect((err as Error).message).toMatch(/orgs:<uid>/);
    expect((err as Error).message).not.toContain("abc123secret");
    expect(calls).toHaveLength(1);
  });
  it("a 2xx that is not the handler's ok envelope (a followed redirect, raw()'s 'no json') is a refused switch, cookie or not", async () => {
    const { t } = transport(reply(200, { ok: false, error: "no json" }));
    await expect(switchToCaseOrg(t, "http://localhost:1", fresh(), "o2")).rejects.toThrow(/POST \/api\/orgs\/active → 200: no json/);
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
    const t: Transport = { async raw(_b, s, path, method = "GET", body) { order.push(`${method} ${path}`); s.cookies[PRODUCT_ORG_COOKIE] = (body as { org_id: string }).org_id; return okData({ ok: true }); } };
    const out = await prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async (o, p) => { order.push(`provision ${o} ${p}`); } }, { name: "Matrix 1", slug: "m-r-1" });
    expect(out).toEqual({ orgId: "o9", orgSlug: "m-r-1" });
    expect(order).toEqual(["insert u1 Matrix 1 m-r-1", "POST /api/orgs/active", "provision o9 pro"]);
  });
  it("a failed switch never provisions (provisioning elevates the owner to superadmin in SQL)", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, _s, path, method = "GET") { order.push(`${method} ${path}`); return okData({ ok: true }); } }; // sets no cookie
    await expect(prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async () => { order.push("provision"); } }, { name: "Matrix 1", slug: "m-r-1" })).rejects.toBeInstanceOf(OrgSwitchFailed);
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

describe("mirror pin: the active-org cookie (auth.ts ORG_COOKIE → setActiveOrgId ← POST /api/orgs/active)", () => {
  it("seed-org checks the product's cookie, the product writes the org id into it, and the switch route calls that writer", () => {
    expect(PRODUCT_ORG_COOKIE, "auth.ts no longer declares ORG_COOKIE").not.toMatch(/not found/);
    expect(ORG_COOKIE).toBe(PRODUCT_ORG_COOKIE);
    expect(fnBody(AUTH, "export async function setActiveOrgId")).toMatch(/jar\.set\(ORG_COOKIE, orgId,/);
    const ROUTE = readFileSync(resolve(REPO, "apps/web/src/app/api/orgs/active/route.ts"), "utf8");
    expect(ROUTE).toMatch(/await setActiveOrgId\(org_id\);/);
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
