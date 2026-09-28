import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawResult, Session } from "../../bench/lib/http.ts";
import type { Transport } from "../lib/driver/http-driver.ts";
import { slugify as productSlugify } from "../../../apps/web/src/server/usecases/slugs.ts";
import {
  CASE_ORG_SLUG_LIKE, CASE_OWNER_EMAIL_LIKE, DataDirMismatch, DataDirUnset, NoPublicPlan, NotACaseOrg, ORG_COOKIE, OrgSwitchFailed, caseOrgSlug,
  chooseTopPublicPlan, createRealMatrixSql, gateOnOwnDataDir, matrixSqlOver, ownerEmail, prepareCaseOrg, requireOwnDataDir, switchToCaseOrg, type MatrixSql,
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
      async denyFeature() { calls.push("denyFeature"); },
      async planGrants() { calls.push("planGrants"); return ["formats.double_elim"]; },
    };
    return { calls, inner };
  };
  const everyMethod = (sql: MatrixSql) => [
    () => sql.userIdForEmail("a@b.c"),
    () => sql.insertCaseOrg({ userId: "u1", name: "n", slug: "s" }),
    () => sql.listPlanKeys(),
    () => sql.variantKeysInBuilderOrder("badminton"),
    () => sql.denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" }),
    () => sql.planGrants("pro"),
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
    expect(calls).toEqual(["userIdForEmail", "insertCaseOrg", "listPlanKeys", "variantKeysInBuilderOrder", "denyFeature", "planGrants"]);
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
function fakeClient(dataDir: string | null, rows: (text: string, values: unknown[]) => unknown[] = () => [], txDataDir: string | null = dataDir) {
  const seen: (Stmt | "BEGIN" | "COMMIT" | "ROLLBACK")[] = [];
  const tag = (via: "db" | "tx") => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    seen.push({ via, text, values });
    const dir = via === "db" ? dataDir : txDataDir;
    if (text === "show data_directory") return Promise.resolve(dir === null ? [] : [{ data_directory: dir }]);
    return Promise.resolve(rows(text, values));
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
    await expect(sql.planGrants("pro")).rejects.toBeInstanceOf(DataDirMismatch);
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

  // Fix round 2, RR-1: the plan's grants, read as the product's resolver reads
  // a plan. Every name below is lifted from lib/entitlements.ts, never typed.
  const ENT = readFileSync(resolve(REPO, "apps/web/src/lib/entitlements.ts"), "utf8");
  const fold = (s: string) => s.replace(/\s+/g, " ").trim();
  const planRead = fold(/const \[planRow\] = await sql<Resolved\[\]>`([^`]*)`/.exec(ENT)?.[1] ?? "");
  const parts = /^select (\w+), \w+ from (\w+) where (\w+) = \$\{planKey\} and (\w+) = \$\{featureKey\}$/.exec(planRead);
  const hasFeature = /export async function hasFeature\([\s\S]*?\n}\n/.exec(ENT)?.[0] ?? "";
  const grantTest = /return row\?\.(\w+) === (true);/.exec(hasFeature);
  it("text pin: the product resolves a plan's bool from ONE plan_entitlements row, granted only when exactly true, and that row is the base", () => {
    expect(parts, `resolveFromDb's plan read changed shape: ${planRead}`).not.toBeNull();
    expect(grantTest, "hasFeature no longer grants on `row?.<col> === true`").not.toBeNull();
    // The column hasFeature tests is the one the plan read selects.
    expect(grantTest![1]).toBe(parts![1]);
    // No pass and no override on a case org (only its own deny): the plan row IS the answer.
    expect(ENT).toMatch(/let base: Resolved \| null = planRow \?\? null;/);
  });
  it("planGrants selects the plan's feature keys whose grant column is exactly true — the resolver's own table, columns and predicate", async () => {
    const [, grantCol, table, planCol, featureCol] = parts ?? [];
    const want = `select ${featureCol} from ${table} where ${planCol} = $ and ${grantCol} = ${grantTest?.[2]} order by ${featureCol}`;
    const { db, seen } = fakeClient("/tmp/pg-fm", (text) => (text === want ? [{ feature_key: "formats.advanced" }, { feature_key: "formats.double_elim" }] : []));
    expect(await matrixSqlOver(db, "/tmp/pg-fm").planGrants("pro")).toEqual(["formats.advanced", "formats.double_elim"]);
    expect(seen[1]).toEqual({ via: "db", text: want, values: ["pro"] });
  });
  it("…a plan with no granted key reads as an empty list (the guard then refuses every gate), not an error", async () => {
    const { db } = fakeClient("/tmp/pg-fm", () => []);
    expect(await matrixSqlOver(db, "/tmp/pg-fm").planGrants("community")).toEqual([]);
  });
});

/** The deny upsert, as the fake reads it: its WHERE is exactly these three
 *  conjuncts, bound in this order (pinned by the "one transaction" test). */
const DENY_UPSERT = "insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) select o.id, $, false, $ from organizations o join users u on u.id = o.created_by where o.id = $ and o.slug like $ and u.email like $ on conflict (org_id, feature_key) do update set bool_value = false, int_value = null, reason = excluded.reason, expires_at = null returning org_id";

describe("denyFeature (ruling 24) — gated, upserted, read back", () => {
  // The upsert confirms a case org (one row back); the read-back answers a live false.
  const DENY_ROWS = (text: string): unknown[] =>
    text.startsWith("insert into org_entitlement_overrides") ? [{ org_id: "o1" }]
    : text.startsWith("select bool_value") ? [{ bool_value: false, expires_at: null }] : [];
  it("a foreign data_directory refuses it and runs nothing but the one probe", async () => {
    const { db, seen } = fakeClient("/usr/local/var/postgres");
    await expect(matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.double_elim", reason: "matrix denied" })).rejects.toBeInstanceOf(DataDirMismatch);
    expect(seen).toEqual([PROBE]);
  });
  it("one transaction: re-prove, upsert false with no expiry, read back", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", DENY_ROWS);
    await matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.double_elim", reason: "matrix denied" });
    expect(shape(seen)).toEqual(["db show data_directory", "BEGIN", "tx show data_directory", "tx insert into org_entitlement_overrides", "tx select bool_value, expires_at from org_entitlement_overrides where org_id = $ and feature_key = $", "COMMIT"]);
    const ins = seen.filter((s): s is Stmt => typeof s !== "string")[2]!;
    // m-2: the case-org identity is BOUND (never spliced into the text).
    expect(ins.values).toEqual(["formats.double_elim", "matrix denied", "o1", CASE_ORG_SLUG_LIKE, CASE_OWNER_EMAIL_LIKE]);
    expect(ins.text).toBe(DENY_UPSERT);
    const back = seen.filter((s): s is Stmt => typeof s !== "string")[3]!;
    expect(back.values).toEqual(["o1", "formats.double_elim"]);
  });
  it("the transaction's own probe answering a foreign dir aborts before the upsert (a reconnect)", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", DENY_ROWS, "/usr/local/var/postgres");
    await expect(matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" })).rejects.toBeInstanceOf(DataDirMismatch);
    expect(shape(seen)).toEqual(["db show data_directory", "BEGIN", "tx show data_directory", "ROLLBACK"]);
  });
  it("a second deny of the same key is the same upsert, re-proved on its own transaction", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", DENY_ROWS);
    const sql = matrixSqlOver(db, "/tmp/pg-fm");
    await sql.denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" });
    await sql.denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" });
    expect(shape(seen).filter((s) => s.startsWith("tx insert"))).toHaveLength(2);
    expect(shape(seen).filter((s) => s === "tx show data_directory")).toHaveLength(2);
  });
  it("a read-back that is not a live false refuses (and rolls back)", async () => {
    let judged = 0;
    for (const row of [[], [{ bool_value: true, expires_at: null }], [{ bool_value: null, expires_at: null }], [{ bool_value: false, expires_at: "2030-01-01T00:00:00Z" }]]) {
      const { db, seen } = fakeClient("/tmp/pg-fm", (t) => (t.startsWith("insert into") ? [{ org_id: "o1" }] : t.startsWith("select bool_value") ? row : []));
      await expect(matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" })).rejects.toThrow(/deny did not hold/);
      expect(seen.at(-1)).toBe("ROLLBACK");
      judged++;
    }
    expect(judged).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (m-2): the deny is confined IN THE SQL to a case org — slug
// stamped by caseOrgSlug, created by the run's ownerEmail — whatever org id
// reaches it. The fake below holds real org rows and evaluates the bound LIKE
// patterns the way Postgres does, and keeps the overrides it was given, so
// the read-back sees only what the upsert actually wrote.
// ---------------------------------------------------------------------------

/** SQL LIKE with the default escape: `%` any run, `_` one character, the rest literal and case-sensitive. */
const like = (s: string, pattern: string): boolean =>
  new RegExp(`^${[...pattern].map((c) => (c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "s").test(s);

interface OrgRow { id: string; slug: string; ownerEmail: string }
function orgsDb(orgs: readonly OrgRow[]) {
  const overrides = new Map<string, { bool_value: boolean; expires_at: null }>();
  const client = fakeClient("/tmp/pg-fm", (text, values) => {
    if (text.startsWith("insert into org_entitlement_overrides")) {
      if (text !== DENY_UPSERT) throw new Error(`fake: the deny upsert changed shape: ${text}`);
      const [featureKey, , orgId, slugLike, emailLike] = values as string[];
      const hit = orgs.find((o) => o.id === orgId && like(o.slug, slugLike ?? "") && like(o.ownerEmail, emailLike ?? ""));
      if (hit === undefined) return [];
      overrides.set(`${hit.id}|${featureKey ?? ""}`, { bool_value: false, expires_at: null });
      return [{ org_id: hit.id }];
    }
    if (text.startsWith("select bool_value")) {
      const row = overrides.get(`${String(values[0])}|${String(values[1])}`);
      return row === undefined ? [] : [row];
    }
    return [];
  });
  return { ...client, overrides };
}

const HELPERS = readFileSync(resolve(REPO, "apps/web/e2e/helpers.ts"), "utf8");
/** The e2e suite's signed-in identities (AUTH_STATE is the PRO one), read from helpers.ts. */
const E2E_EMAIL_PREFIXES = [...HELPERS.matchAll(/\nexport const (\w+)_EMAIL_PREFIX = "([^"]+)";/g)].map((m) => ({ who: m[1] ?? "", prefix: m[2] ?? "" }));
const E2E_EMAIL_DOMAIN = /\nexport const proEmail = \(\) => `\$\{PRO_EMAIL_PREFIX\}\$\{TAG\}(@[a-z.]+)`;/.exec(HELPERS)?.[1] ?? "(proEmail moved)";
/** The org a first sign-in auto-provisions (auth.ts), whose slug the product derives from its name. */
const SIGNUP_ORG_NAME = /\n\s+const created = await createOrgForUser\(userId, "([^"]+)"/.exec(AUTH)?.[1] ?? "(createOrgForUser call moved)";
const SIGNUP_SLUGS = [productSlugify(SIGNUP_ORG_NAME), `${productSlugify(SIGNUP_ORG_NAME)}-2`];

describe("denyFeature confinement (m-2) — only a case org can be denied, in the SQL itself", () => {
  const CASE: OrgRow = { id: "o-case", slug: caseOrgSlug("fm-r1", 1), ownerEmail: ownerEmail("fm-r1") };
  const deny = (db: ReturnType<typeof orgsDb>["db"], orgId: string) =>
    matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId, featureKey: "formats.double_elim", reason: "matrix denied" });

  it("the identities are read from the product and the e2e helpers, not typed", () => {
    expect(E2E_EMAIL_PREFIXES.map((e) => e.who)).toContain("PRO");
    expect(E2E_EMAIL_PREFIXES.length).toBeGreaterThanOrEqual(2);
    expect(E2E_EMAIL_DOMAIN).toMatch(/^@[a-z.]+$/);
    expect(SIGNUP_ORG_NAME).not.toMatch(/moved/);
    expect(SIGNUP_SLUGS[0]).toMatch(/^[a-z0-9-]+$/);
  });
  it("the case org — slug from caseOrgSlug, owner from ownerEmail — is denied, and the read-back sees it", async () => {
    const { db, seen, overrides } = orgsDb([CASE]);
    await deny(db, CASE.id);
    expect(overrides.get("o-case|formats.double_elim")).toEqual({ bool_value: false, expires_at: null });
    expect(seen.at(-1)).toBe("COMMIT");
  });
  it("the shared AUTH_STATE org (and every other e2e identity's sign-up org) cannot be hit: NotACaseOrg, nothing written, rolled back", async () => {
    let n = 0;
    for (const { prefix } of E2E_EMAIL_PREFIXES) for (const slug of SIGNUP_SLUGS) {
      const e2e: OrgRow = { id: "o-e2e", slug, ownerEmail: `${prefix}t1759000000${E2E_EMAIL_DOMAIN}` };
      const { db, seen, overrides } = orgsDb([CASE, e2e]);
      const err = await deny(db, e2e.id).catch((e: unknown) => e);
      expect(err, `${slug} / ${e2e.ownerEmail}`).toBeInstanceOf(NotACaseOrg);
      expect(overrides.size).toBe(0);
      expect(seen.at(-1)).toBe("ROLLBACK");
      expect(shape(seen).some((s) => s.startsWith("tx select bool_value"))).toBe(false);
      n++;
    }
    expect(n).toBe(E2E_EMAIL_PREFIXES.length * SIGNUP_SLUGS.length);
    expect(n).toBeGreaterThan(0);
  });
  it("each conjunct refuses on its own: a case slug with a foreign owner, the matrix owner with a foreign slug, an unknown id", async () => {
    const proPrefix = E2E_EMAIL_PREFIXES.find((e) => e.who === "PRO")?.prefix ?? "(PRO prefix missing)";
    const cases: [string, OrgRow[], string][] = [
      ["slug holds, owner does not", [{ id: "o-x", slug: caseOrgSlug("fm-r1", 2), ownerEmail: `${proPrefix}t1${E2E_EMAIL_DOMAIN}` }], "o-x"],
      ["owner holds, slug does not", [{ id: "o-x", slug: SIGNUP_SLUGS[0] ?? "", ownerEmail: ownerEmail("fm-r1") }], "o-x"],
      ["no such org (the case org exists under another id)", [CASE], "o-missing"],
    ];
    let n = 0;
    for (const [why, orgs, id] of cases) {
      const { db, overrides } = orgsDb(orgs);
      await expect(deny(db, id), why).rejects.toBeInstanceOf(NotACaseOrg);
      expect(overrides.size, why).toBe(0);
      n++;
    }
    expect(n).toBe(3);
  });
  it("the stamps satisfy the patterns, which carry no LIKE wildcard but their one %", () => {
    for (const runId of ["fm-r1", "fm-w1b-a", "a"]) {
      expect(like(caseOrgSlug(runId, 1), CASE_ORG_SLUG_LIKE), runId).toBe(true);
      expect(like(ownerEmail(runId), CASE_OWNER_EMAIL_LIKE), runId).toBe(true);
    }
    for (const p of [CASE_ORG_SLUG_LIKE, CASE_OWNER_EMAIL_LIKE]) {
      expect(p.split("%")).toHaveLength(2);
      expect(p).not.toMatch(/[_\\]/);
    }
  });
  it("NotACaseOrg redacts what it echoes", async () => {
    const { db } = orgsDb([CASE]);
    const err = await deny(db, "token=abc123secret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotACaseOrg);
    expect((err as Error).message).not.toContain("abc123secret");
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
    async denyFeature(i) { order.push(`deny ${i.orgId} ${i.featureKey}`); },
    async planGrants() { return []; },
  });

  it("inserts, switches, then provisions — in that order", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, s, path, method = "GET", body) { order.push(`${method} ${path}`); s.cookies[PRODUCT_ORG_COOKIE] = (body as { org_id: string }).org_id; return okData({ ok: true }); } };
    const out = await prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async (o, p) => { order.push(`provision ${o} ${p}`); } }, { name: "Matrix 1", slug: "m-r-1" });
    expect(out).toEqual({ orgId: "o9", orgSlug: "m-r-1", denied: [] });
    expect(order).toEqual(["insert u1 Matrix 1 m-r-1", "POST /api/orgs/active", "provision o9 pro"]);
  });
  it("a failed switch never provisions (provisioning elevates the owner to superadmin in SQL)", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, _s, path, method = "GET") { order.push(`${method} ${path}`); return okData({ ok: true }); } }; // sets no cookie
    await expect(prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async () => { order.push("provision"); } }, { name: "Matrix 1", slug: "m-r-1" })).rejects.toBeInstanceOf(OrgSwitchFailed);
    expect(order).not.toContain("provision");
  });
  it("denies AFTER provisioning, each key once, in order; no deny → no deny call (ruling 24)", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, s, path, method = "GET", body) { order.push(`${method} ${path}`); s.cookies[PRODUCT_ORG_COOKIE] = (body as { org_id: string }).org_id; return okData({ ok: true }); } };
    const deps = { sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async (o: string, p: string) => { order.push(`provision ${o} ${p}`); } };
    const out = await prepareCaseOrg(deps, { name: "Matrix 1", slug: "m-r-1", deny: ["formats.double_elim", "formats.advanced"] });
    expect(order).toEqual(["insert u1 Matrix 1 m-r-1", "POST /api/orgs/active", "provision o9 pro", "deny o9 formats.double_elim", "deny o9 formats.advanced"]);
    expect(out.denied).toEqual(["formats.double_elim", "formats.advanced"]);
    order.length = 0;
    await prepareCaseOrg({ ...deps, session: fresh() }, { name: "Matrix 1", slug: "m-r-1" });
    expect(order.some((l) => l.startsWith("deny"))).toBe(false);
    expect(order).toHaveLength(3);
    order.length = 0;
    await prepareCaseOrg({ ...deps, session: fresh() }, { name: "Matrix 1", slug: "m-r-1", deny: [] });
    expect(order.some((l) => l.startsWith("deny"))).toBe(false);
    expect(order).toHaveLength(3);
  });
  it("a failed provision never denies (the deny would land on an org that is not set up)", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, s, _p, _m, body) { s.cookies[PRODUCT_ORG_COOKIE] = (body as { org_id: string }).org_id; return okData({ ok: true }); } };
    await expect(prepareCaseOrg({ sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async () => { throw new Error("provision failed"); } }, { name: "Matrix 1", slug: "m-r-1", deny: ["formats.advanced"] })).rejects.toThrow(/provision failed/);
    expect(order.some((l) => l.startsWith("deny"))).toBe(false);
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

  // Task 9: matrixSqlOver also holds ONE insert that mirrors nothing — the
  // ruling-24 deny upsert, an `insert … select` since fix round 1 (m-2), so
  // the values parser does not read it. Every insert is counted by table
  // below, parsed or not: any other new one still reds the guard.
  it("parser discovery guard: the product's three inserts; seed-org's three mirrors, plus the one deny upsert among ALL its inserts (none parsed would pass vacuously)", () => {
    expect(insertsIn(body).map((i) => i.table)).toEqual(["subscriptions", "organizations", "org_members"]);
    const seed = fnBody(SEED, "export function matrixSqlOver");
    expect(insertsIn(seed).map((i) => i.table)).toEqual(["subscriptions", "organizations", "org_members"]);
    expect([...seed.matchAll(/insert into (\w+)/g)].map((m) => m[1])).toEqual(["subscriptions", "organizations", "org_members", "org_entitlement_overrides"]);
  });

  it("seed-org's inserts equal the product's: same tables, same columns, same literal values ('owner', 'community', 'active', 1)", () => {
    expect(insertsIn(fnBody(SEED, "export function matrixSqlOver"))).toEqual(insertsIn(body));
  });
});

describe("mirror pin: the deny is what the product's resolver reads as a live false (lib/entitlements.ts; ruling 24)", () => {
  const ENT = readFileSync(resolve(REPO, "apps/web/src/lib/entitlements.ts"), "utf8");
  it("overrideRow reads a null expires_at as live, the overlay lets a false beat the plan, and hasFeature wants === true", () => {
    expect(fnBody(ENT, "export async function overrideRow")).toMatch(/from org_entitlement_overrides\s+where org_id = \$\{orgId\} and feature_key = \$\{featureKey\}\s+and \(expires_at is null or expires_at > now\(\)\)/);
    // `??`, not `||`: a false override is an answer, so it wins over any plan value.
    expect(ENT).toContain("bool_value: ov.bool_value ?? base?.bool_value ?? null,");
    expect(fnBody(ENT, "export async function hasFeature")).toContain("return row?.bool_value === true;");
    expect(fnBody(ENT, "export async function requireFeature")).toMatch(/if \(!enabled\) throw new PaymentRequiredError\(featureKey\);/);
  });
  // Fix round 1 (m-3): EVERY migration flyway applies is swept (its locations
  // read from db/flyway.toml), and every mention of the table must be
  // understood: a read or write (DML), a `create table`, or an `alter table`
  // whose every action adds a nullable column. Anything else — a trigger, an
  // index, a policy, a constraint, a rename, a drop, a NOT NULL column — reds,
  // naming the file. The deny's own columns are read from seed-org's SQL.
  it("the deny upsert holds against the table as EVERY migration that touches it defines it", () => {
    const TABLE = "org_entitlement_overrides";
    const locations = [...readFileSync(resolve(REPO, "db/flyway.toml"), "utf8").matchAll(/"filesystem:([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(locations.length).toBeGreaterThan(0);
    const files = locations.flatMap((dir) => readdirSync(resolve(REPO, dir), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".sql")).map((f) => join(dir, f)).sort());
    expect(files.length).toBeGreaterThan(0);

    /** Split at top-level commas (a type like numeric(5, 2) stays whole). */
    const topLevel = (s: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let cur = "";
      for (const c of s) {
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
      }
      return [...out, cur.trim()].filter((x) => x !== "");
    };
    const unknown: string[] = [];
    const creates: { file: string; cols: Map<string, { notNull: boolean; hasDefault: boolean }>; pk: string[] }[] = [];
    const added = new Map<string, string>();
    let dml = 0;
    let mentions = 0;
    for (const file of files) {
      const sql = readFileSync(resolve(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();
      for (const m of sql.matchAll(new RegExp(`\\b${TABLE}\\b`, "g"))) {
        mentions++;
        const at = m.index;
        const before = sql.slice(Math.max(0, at - 40), at);
        const end = sql.indexOf(";", at);
        const rest = sql.slice(at + TABLE.length, end < 0 ? undefined : end).trim();
        if (/\b(insert into|delete from|from|join|update) (public\.)?$/.test(before)) { dml++; continue; }
        if (/\bcreate table (if not exists )?(public\.)?$/.test(before)) {
          const body = /^\((.*)\)$/.exec(rest)?.[1];
          if (body === undefined) { unknown.push(`${file}: create table ${TABLE} ${rest.slice(0, 80)}`); continue; }
          const cols = new Map<string, { notNull: boolean; hasDefault: boolean }>();
          let pk: string[] = [];
          for (const el of topLevel(body)) {
            const key = /^primary key \(([^)]*)\)$/.exec(el);
            if (key) { pk = (key[1] ?? "").split(",").map((c) => c.trim()); continue; }
            const col = /^(\w+) (\w+)(.*)$/.exec(el);
            if (col === null || ["constraint", "unique", "check", "foreign", "exclude", "like"].includes(col[1] ?? "")) { unknown.push(`${file}: create table element "${el}"`); continue; }
            cols.set(col[1] ?? "", { notNull: /\bnot null\b/.test(col[3] ?? ""), hasDefault: /\bdefault\b/.test(col[3] ?? "") });
            if (/\bprimary key\b/.test(col[3] ?? "")) pk = [col[1] ?? ""];
          }
          creates.push({ file, cols, pk });
          continue;
        }
        if (/\balter table (if exists )?(only )?(public\.)?$/.test(before)) {
          for (const action of topLevel(rest)) {
            const add = /^add column (if not exists )?(\w+) (timestamptz|timestamp with time zone|text|boolean|integer|bigint|jsonb|uuid|date)$/.exec(action);
            if (add === null) unknown.push(`${file}: alter table ${TABLE} ${action}`);
            else added.set(add[2] ?? "", file);
          }
          continue;
        }
        unknown.push(`${file}: …${before}${TABLE} ${rest.slice(0, 60)}`);
      }
    }
    // Anti-vacuity: the sweep saw the table, and each kind it judges at least once.
    expect(mentions).toBeGreaterThan(0);
    expect(dml).toBeGreaterThan(0);
    expect(creates.length).toBeGreaterThan(0);
    expect(added.size).toBeGreaterThan(0);
    expect(unknown, "a migration changes org_entitlement_overrides in a way this pin does not understand").toEqual([]);

    // What the deny needs, read from its own SQL.
    const seed = fnBody(SEED, "export function matrixSqlOver").replace(/\s+/g, " ");
    const upsert = /insert into org_entitlement_overrides [^`]*`/.exec(seed)?.[0] ?? "(the deny upsert moved)";
    const insertCols = (/insert into org_entitlement_overrides \(([^)]*)\)/.exec(upsert)?.[1] ?? "").split(",").map((c) => c.trim());
    const target = (/on conflict \(([^)]*)\) do update set /.exec(upsert)?.[1] ?? "").split(",").map((c) => c.trim());
    const setCols = [...(/do update set (.*?) returning /.exec(upsert)?.[1] ?? "").matchAll(/(\w+) = /g)].map((x) => x[1] ?? "");
    const returning = /returning (\w+)`/.exec(upsert)?.[1] ?? "";
    const readBack = (/select ([\w, ]+) from org_entitlement_overrides where/.exec(seed)?.[1] ?? "").split(",").map((c) => c.trim());
    const named = [...insertCols, ...target, ...setCols, returning, ...readBack];
    expect(insertCols).toEqual(["org_id", "feature_key", "bool_value", "reason"]);
    expect(setCols).toEqual(["bool_value", "int_value", "reason", "expires_at"]);
    expect([returning, ...readBack]).toEqual(["org_id", "bool_value", "expires_at"]);
    expect(named.length).toBeGreaterThan(0);
    let judged = 0;
    for (const c of creates) {
      // Whichever create ran first defines the table (both are `if not exists`).
      expect([...c.pk].sort(), `${c.file}: the conflict target must be the primary key`).toEqual([...target].sort());
      const columns = new Set([...c.cols.keys(), ...added.keys()]);
      for (const col of named) expect(columns.has(col), `${c.file}: ${col} does not exist`).toBe(true);
      for (const [col, f] of c.cols) if (f.notNull && !f.hasDefault) expect(insertCols, `${c.file}: NOT NULL ${col} is not written`).toContain(col);
      judged++;
    }
    expect(judged).toBe(creates.length);
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
