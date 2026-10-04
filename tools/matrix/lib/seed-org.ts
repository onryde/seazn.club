// One org per case, seeded by SQL in the harness's OWN DB (design §6.4, §9;
// the bench's setPlan precedent). Why SQL rather than POST /api/orgs: that
// route is capped by `orgs.max_owned` per user, and a run needs one org per
// case. So this mirrors createOrgForUser (apps/web/src/lib/auth.ts) minus its
// quota check — pinned both ways by seed-org.test.ts.
//
// What the mirror deliberately leaves out of createOrgForUser:
//  - the advisory lock + assertMayOwnAnotherOrg (the quota — the whole reason);
//  - the AI-credit wallet bootstrap (best-effort there too; no format uses it);
//  - invalidateUserOrgs. The server caches a user's org list under
//    `orgs:<uid>` for 120s, but only when its REDIS_URL is set (lib/cache.ts;
//    the seazn-local-env recipe sets none, so every read is fresh). The harness
//    has no Redis client and no product route drops that key harmlessly, so on
//    a Redis-backed server the switch itself refuses loudly (its membership
//    check reads that list) until the entry expires. A stale list can only
//    LACK the new org, never invent one, so it cannot make a switch pass.
//
// Refuses to run on a DB it cannot prove is its own: BENCH_EXPECTED_DATA_DIR is
// MANDATORY here (the bench preflight compares data_directory only when it is
// set — env.ts checkOwnDatabase). The reads wait on one `show data_directory`
// comparison per client; every insertCaseOrg repeats it inside its own
// transaction, on the connection the writes use, because postgres.js
// reconnects silently and a reconnect can land on another server.
import postgres from "postgres";
import type { Session } from "../../../scripts/bench/lib/http.ts";
import type { PlanCandidateInfo } from "../../../scripts/bench/lib/plan.ts";
import type { Transport } from "./driver/http-driver.ts";
import { redact } from "./redact.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface MatrixSql {
  userIdForEmail(email: string): Promise<string>;
  insertCaseOrg(input: { userId: string; name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }>;
  listPlanKeys(): Promise<string[]>;
  variantKeysInBuilderOrder(sportKey: string): Promise<string[]>;
  /** ⛔ (ruling 24): a live `org_entitlement_overrides` deny for one feature. */
  denyFeature(input: { orgId: string; featureKey: string; reason: string }): Promise<void>;
  /** RR-1 (W1b T10 fix round 2): the feature keys a plan grants — its
   *  `plan_entitlements` rows whose bool is exactly true, read as the product's
   *  resolver reads a plan (lib/entitlements.ts resolveFromDb + hasFeature;
   *  pinned by seed-org.test.ts). An org on the plan with no pass and no
   *  override holds exactly these. */
  planGrants(planKey: string): Promise<string[]>;
  /** W1b T15 fix round 1 (b): a plan's numeric limit for one feature, read as
   *  the product's getLimit reads it (lib/entitlements.ts; pinned by
   *  seed-org.test.ts): its ONE `plan_entitlements` row's int_value, where a
   *  null is UNLIMITED (null here) and no row at all is 0. A case org on the
   *  plan with no pass, no override and no add-on holds exactly this. */
  planLimit(planKey: string, featureKey: string): Promise<number | null>;
}

export class DataDirUnset extends Error {
  constructor() {
    super(redact("seed-org: BENCH_EXPECTED_DATA_DIR is unset — the matrix refuses to touch a database it cannot prove is its own (R14; seazn-local-env `env`)"));
    this.name = "DataDirUnset";
  }
}

export class DataDirMismatch extends Error {
  constructor(expected: string, actual: string) {
    super(redact(`seed-org: show data_directory returned "${actual}", not BENCH_EXPECTED_DATA_DIR "${expected}" — this DATABASE_URL reaches someone else's Postgres; refusing every query`));
    this.name = "DataDirMismatch";
  }
}

export function requireOwnDataDir(env: Env): string {
  const dir = env.BENCH_EXPECTED_DATA_DIR?.trim();
  if (dir === undefined || dir === "") throw new DataDirUnset();
  return dir;
}

/** Wraps a MatrixSql so no query of its own runs until `show data_directory`
 *  has been read once and equals `expected`. A mismatch refuses that call and
 *  every later one (the rejected proof is kept). */
export function gateOnOwnDataDir(inner: MatrixSql, readDataDir: () => Promise<string>, expected: string): MatrixSql {
  if (expected.trim() === "") throw new DataDirUnset();
  let proof: Promise<void> | null = null;
  const proven = (): Promise<void> =>
    (proof ??= readDataDir().then((actual) => {
      if (actual !== expected) throw new DataDirMismatch(expected, actual);
    }));
  return {
    async userIdForEmail(email) { await proven(); return inner.userIdForEmail(email); },
    async insertCaseOrg(input) { await proven(); return inner.insertCaseOrg(input); },
    async listPlanKeys() { await proven(); return inner.listPlanKeys(); },
    async variantKeysInBuilderOrder(sportKey) { await proven(); return inner.variantKeysInBuilderOrder(sportKey); },
    async denyFeature(input) { await proven(); return inner.denyFeature(input); },
    async planGrants(planKey) { await proven(); return inner.planGrants(planKey); },
    async planLimit(planKey, featureKey) { await proven(); return inner.planLimit(planKey, featureKey); },
  };
}

export class NoPublicPlan extends Error {
  constructor(candidates: number) {
    super(redact(`seed-org: no public plan among ${candidates} candidate(s) — the plans catalogue is empty or all private (is this DB migrated?)`));
    this.name = "NoPublicPlan";
  }
}

/** The most-privileged plan a real customer can buy, so no format is refused
 *  for want of a feature (the ⛔ state is W1b's, with an explicit deny). */
export function chooseTopPublicPlan(candidates: readonly PlanCandidateInfo[]): string {
  const pub = candidates.filter((c) => c.is_public);
  const top = [...pub].sort((a, b) => b.privilege - a.privilege || (a.plan_key < b.plan_key ? -1 : a.plan_key > b.plan_key ? 1 : 0))[0];
  if (top === undefined) throw new NoPublicPlan(candidates.length);
  return top.plan_key;
}

export class OrgSwitchFailed extends Error {
  constructor(orgId: string, why: string) {
    super(redact(`seed-org: could not make ${orgId} the active org — ${why}`));
    this.name = "OrgSwitchFailed";
  }
}

/** The active-org cookie (apps/web/src/lib/auth.ts ORG_COOKIE; text-pinned by
 *  seed-org.test.ts). setActiveOrgId writes the org id into it, and every
 *  session-authenticated api-v1 call resolves its org from it. */
export const ORG_COOKIE = "seazn_org";

/** The legacy handler's success (lib/http.ts): 2xx AND `{ok:true}`. A 2xx
 *  without it is bench raw()'s non-JSON fallback — e.g. a followed redirect. */
function refusal(r: { status: number; json: unknown }): string | null {
  const body = r.json as { ok?: unknown; error?: unknown } | null;
  if (r.status >= 200 && r.status < 300 && body?.ok === true) return null;
  return `${r.status}: ${typeof body?.error === "string" ? body.error : "(no reason)"}`;
}

/** RF4: switch the session's active org and prove it held. What the switch
 *  changes is one cookie, which bench raw() copies into `session.cookies`;
 *  a switch that did not reach the jar would put the next case's rows in
 *  another org. The cookie is dropped first, so only THIS answer's Set-Cookie
 *  can satisfy the check. (GET /api/orgs cannot: the route authorises the
 *  switch from the same membership list, so a listing check is always true.) */
export async function switchToCaseOrg(t: Transport, base: string, session: Session, orgId: string): Promise<void> {
  delete session.cookies[ORG_COOKIE];
  const sw = await t.raw(base, session, "/api/orgs/active", "POST", { org_id: orgId });
  const refused = refusal(sw);
  if (refused !== null) {
    throw new OrgSwitchFailed(orgId, `POST /api/orgs/active → ${refused}. If the server has REDIS_URL set, its user-orgs cache (orgs:<uid>, 120s) may predate this SQL-seeded org`);
  }
  const held = session.cookies[ORG_COOKIE];
  if (held !== orgId) {
    throw new OrgSwitchFailed(orgId, `POST /api/orgs/active answered ok but the session's ${ORG_COOKIE} cookie is ${held === undefined ? "unset" : `"${held}"`}, so the next call would act in another org`);
  }
}

export interface PrepareCaseOrgDeps {
  sql: MatrixSql;
  transport: Transport;
  base: string;
  session: Session;
  userId: string;
  plan: string;
  provision: (orgId: string, plan: string) => Promise<void>;
}

/** `deny` (ruling 24): feature keys the case org is denied AFTER provisioning,
 *  so the plan write cannot touch them and the org holds the top plan with
 *  exactly these features off. `denied` is what was applied: a key joins it
 *  only once denyFeature's read-back held (it throws otherwise). */
export async function prepareCaseOrg(deps: PrepareCaseOrgDeps, input: { name: string; slug: string; deny?: readonly string[] }): Promise<{ orgId: string; orgSlug: string; denied: string[] }> {
  const org = await deps.sql.insertCaseOrg({ userId: deps.userId, name: input.name, slug: input.slug });
  await switchToCaseOrg(deps.transport, deps.base, deps.session, org.orgId);
  await deps.provision(org.orgId, deps.plan);
  const denied: string[] = [];
  for (const featureKey of input.deny ?? []) {
    await deps.sql.denyFeature({ orgId: org.orgId, featureKey, reason: "format-matrix denied state (ruling 24)" });
    denied.push(featureKey);
  }
  return { ...org, denied };
}

// A case org's identity: runCase stamps its slug with caseOrgSlug, and it is
// created by the run's owner, ownerEmail. denyFeature's SQL refuses any org
// that is not both (m-2), so a wrong id can never strip a feature from, say,
// the e2e suite's shared AUTH_STATE org on a local DB they share.
export const CASE_ORG_SLUG_PREFIX = "m-";
const OWNER_LOCAL_PREFIX = "delivered+matrix-";
const OWNER_DOMAIN = "@resend.dev";
/** LIKE patterns: one `%` each, and no `_` or `\`, so the rest is literal. */
export const CASE_ORG_SLUG_LIKE = `${CASE_ORG_SLUG_PREFIX}%`;
export const CASE_OWNER_EMAIL_LIKE = `${OWNER_LOCAL_PREFIX}%${OWNER_DOMAIN}`;

/** The case org's slug: the n-th case of run `runId`. */
export function caseOrgSlug(runId: string, n: number): string {
  return `${CASE_ORG_SLUG_PREFIX}${runId}-${n}`;
}

/** R14a: the run's owner is a synthetic resend.dev sink. The run id must be
 *  slug-safe, so nothing but `[a-z0-9-]` can reach the local part. */
export function ownerEmail(runId: string): string {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error(redact(`seed-org: run id "${runId}" is not slug-safe ([a-z0-9-]+)`));
  return `${OWNER_LOCAL_PREFIX}${runId}${OWNER_DOMAIN}`;
}

/** denyFeature was handed an org that is not a case org. Nothing was written. */
export class NotACaseOrg extends Error {
  constructor(orgId: string) {
    super(redact(`seed-org: org ${orgId} is not a case org (slug like '${CASE_ORG_SLUG_LIKE}', created by '${CASE_OWNER_EMAIL_LIKE}') — refusing to deny anything on it`));
    this.name = "NotACaseOrg";
  }
}

// seed-org.test.ts reads matrixSqlOver's source and compares every insert in it
// with createOrgForUser's, table by table — and drives it over a fake client.
/** The queries, over any client, handed out ONLY behind the data-dir gate. */
export function matrixSqlOver(db: ReturnType<typeof postgres>, expectedDataDir: string): MatrixSql {
  const sql: MatrixSql = {
    async userIdForEmail(email) {
      // The predicate the magic-link sign-in resolves its user by
      // (lib/users.ts resolveOrCreateUser) — the same row, never a case-folded twin.
      const [row] = await db<{ id: string }[]>`select id from users where email = ${email} and deleted_at is null`;
      if (row === undefined) throw new Error("seed-org: the signed-in owner has no users row");
      return row.id;
    },
    async insertCaseOrg({ userId, name, slug }) {
      return db.begin(async (tx) => {
        // Re-proven on THIS transaction's connection, before its first write.
        const [dir] = await tx<{ data_directory: string }[]>`show data_directory`;
        const actual = dir?.data_directory ?? "";
        if (actual !== expectedDataDir) throw new DataDirMismatch(expectedDataDir, actual);
        const [sub] = await tx<{ id: string }[]>`
          insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
          values (${userId}, 'community', 'active', 1)
          returning id`;
        if (sub === undefined) throw new Error("seed-org: subscriptions insert returned no row");
        const [org] = await tx<{ id: string; slug: string }[]>`
          insert into organizations (name, slug, created_by, subscription_id, referred_by_org_id)
          values (${name}, ${slug}, ${userId}, ${sub.id}, ${null})
          returning id, slug`;
        if (org === undefined) throw new Error("seed-org: organizations insert returned no row");
        await tx`
          insert into org_members (org_id, user_id, role)
          values (${org.id}, ${userId}, 'owner')`;
        return { orgId: org.id, orgSlug: org.slug };
      });
    },
    async listPlanKeys() {
      return (await db<{ key: string }[]>`select key from plans order by key`).map((r) => r.key);
    },
    async planGrants(planKey) {
      return (await db<{ feature_key: string }[]>`
        select feature_key from plan_entitlements where plan_key = ${planKey} and bool_value = true
        order by feature_key`).map((r) => r.feature_key);
    },
    async planLimit(planKey, featureKey) {
      const [row] = await db<{ int_value: number | null }[]>`
        select int_value from plan_entitlements where plan_key = ${planKey} and feature_key = ${featureKey}`;
      if (row === undefined) return 0;
      const v = row.int_value;
      if (v !== null && !Number.isInteger(v)) throw new Error(redact(`seed-org: plan ${planKey}'s ${featureKey} int_value is ${JSON.stringify(v)}, not an integer or null`));
      return v;
    },
    async variantKeysInBuilderOrder(sportKey) {
      // The division builder (app/o/[orgSlug]/c/[compSlug]/d/new/page.tsx)
      // selects every sport_variants row under withTenant, ordered
      // `is_system desc, name`, and filters by sport client-side. Its scoping
      // is RLS (V227: `org_id is null or org_id = current_org_id()`), which
      // this connection does not run under — so it is restated. A fresh case
      // org owns no presets, so what the builder shows it is `org_id is null`.
      return (await db<{ key: string }[]>`
        select key from sport_variants where sport_key = ${sportKey} and org_id is null
        order by is_system desc, name`).map((r) => r.key);
    },
    async denyFeature({ orgId, featureKey, reason }) {
      // Ruling 24: the denied state is an override deny (lib/entitlements.ts:
      // a live override wins over the plan — pinned by seed-org.test.ts).
      // Upsert, then read back: an expired or true row would let the gate
      // through and the case would read as an entitlement bug instead of the
      // harness's own miss.
      await db.begin(async (tx) => {
        // Re-proven on THIS transaction's connection, before its write.
        const [dir] = await tx<{ data_directory: string }[]>`show data_directory`;
        const actual = dir?.data_directory ?? "";
        if (actual !== expectedDataDir) throw new DataDirMismatch(expectedDataDir, actual);
        // m-2: the row is written only for a CASE org — the SELECT yields
        // nothing for any other id, so nothing is inserted or updated.
        const [held] = await tx<{ org_id: string }[]>`
          insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
          select o.id, ${featureKey}, false, ${reason}
          from organizations o join users u on u.id = o.created_by
          where o.id = ${orgId} and o.slug like ${CASE_ORG_SLUG_LIKE} and u.email like ${CASE_OWNER_EMAIL_LIKE}
          on conflict (org_id, feature_key) do update set bool_value = false, int_value = null, reason = excluded.reason, expires_at = null
          returning org_id`;
        if (held === undefined) throw new NotACaseOrg(orgId);
        const [row] = await tx<{ bool_value: boolean | null; expires_at: string | null }[]>`
          select bool_value, expires_at from org_entitlement_overrides where org_id = ${orgId} and feature_key = ${featureKey}`;
        if (row?.bool_value !== false || row.expires_at !== null) throw new Error(redact(`seed-org: deny did not hold for ${featureKey} (read back ${JSON.stringify(row ?? null)})`));
      });
    },
  };
  const readDataDir = async (): Promise<string> => {
    const [row] = await db<{ data_directory: string }[]>`show data_directory`;
    return row?.data_directory ?? "";
  };
  return gateOnOwnDataDir(sql, readDataDir, expectedDataDir);
}

export function createRealMatrixSql(env: Env = process.env): { sql: MatrixSql; dispose: () => Promise<void> } {
  const expected = requireOwnDataDir(env); // before a client is even configured
  const url = env.DATABASE_URL;
  if (!url) throw new Error("seed-org: DATABASE_URL is not set (seazn-local-env `env`)");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const db = postgres(url, {
    connection: { search_path: env.DB_SCHEMA ?? "seazn_club" },
    ssl: env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  return { sql: matrixSqlOver(db, expected), dispose: async () => { await db.end({ timeout: 5 }); } };
}
