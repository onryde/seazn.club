// B03 T7 — plan/entitlement provisioning, over an injected SQL seam.
//
// Two false premises the task's own brief corrected before this file was
// written (see the dispatch): the scoring-door refusal this unblocks is a
// 402 PAYMENT_REQUIRED, never a 422 (apps/web/src/server/api-v1/http.ts's
// `PaymentRequiredError` branch); and the gate left at that door after
// entitlements v18 W1 is `requiresDlsEntitlement` (cricket.dls) — the old
// fidelity-band gate this file's ancestors might have expected is deleted.
//
// ---------------------------------------------------------------------------
// The precedent this hand-copies: scripts/smoke.ts's `setPlan` /
// `bustOrgEntitlements` (smoke.ts:17007-17043 / :16952+), read directly, not
// paraphrased. Never imported (_RULES.md §1 / B01 brief: the 13k-line
// monolith stays untouched) — the SQL text below is copied verbatim from
// those two functions; only the SHAPE changes, from smoke.ts's own top-level
// `postgres`/`raw` calls to an INJECTED seam, because this task's own brief
// requires the orchestration (`provisionPlan`/`bustOrgEntitlements`/the pure
// derivation helpers below) to be unit-testable without a live DB or server
// — the same DI split `lib/env.ts`'s `runPreflight`/`PreflightProbes`
// established for this directory (its own header comment: "so
// `runPreflight` itself is pure and unit-testable with fakes").
//
// ---------------------------------------------------------------------------
// Derive, never hardcode
// ---------------------------------------------------------------------------
// Grepping migrations for a plan key that "grants cricket.dls" gives the
// UNION of every plan that ever existed — `business` is seeded by V112 and
// is absent from a live DB (V290 retires it), and entitlements W2 (a
// concurrent programme, per agent memory) deletes `pro_plus` outright. A
// constant picked by reading migrations goes stale the moment either lands;
// `chooseGrantingPlan`/`planGrants` below read `plan_entitlements` itself, at
// call time, so they survive both without this file changing at all.
//
// `plan_entitlements` (V101__billing.sql:46-52): `(plan_key, feature_key)`
// primary key, `bool_value`/`int_value` both nullable. A plan with NO row for
// a feature (every pass tier, for `cricket.dls` and `officials.auto` alike —
// checked: no `('event_pass', ...)` or `('event_pass_l', ...)` insert for
// either key in db/migration/deltas) is excluded from a query scoped to that
// feature_key — never confused with a plan whose row explicitly says
// `bool_value = false` (community). Reaching for a pass tier via `bool_value
// IS NOT false` (or any query that treats "absent" and "false" alike) would
// "refuse" for the wrong reason — a missing row, not a denied one — which is
// exactly the false differential the T7 brief calls out.
import postgres from "postgres";
import { defaultTransport, type SeedTransport } from "./seed.ts";
import type { Session } from "./http.ts";

export interface PlanEntitlementRow {
  readonly plan_key: string;
  readonly bool_value: boolean | null;
}

/**
 * The SQL seam this file's orchestration is injected over — narrow, one
 * method per query `provisionPlan`/`bustOrgEntitlements`/the DLS-gate probe
 * (`lib/dls-gate.ts`) actually issue, mirroring `lib/env.ts`'s
 * `PreflightProbes` shape. `createRealPlanSql` below wires the real thing;
 * `lib/__tests__/plan.test.ts` and `lib/__tests__/dls-gate.test.ts` inject
 * fakes — no live Postgres anywhere in this directory's unit suite.
 */
export interface PlanSql {
  /** `select plan_key, bool_value from plan_entitlements where feature_key =
   *  $1` — every plan carrying an explicit row for this feature, granting or
   *  refusing; a pass tier with no row at all is simply absent from the
   *  result. */
  entitlementRows(featureKey: string): Promise<readonly PlanEntitlementRow[]>;
  /** `select subscription_id from organizations where id = $1`. `null` when
   *  the org bills through nothing yet (a fresh org — resolves to
   *  'community' per `lib/entitlements.ts`'s own fallback). */
  getOrgSubscriptionId(orgId: string): Promise<string | null>;
  /** `update subscriptions set plan_key = $2, status = 'active', updated_at
   *  = now() where id = $1` — smoke.ts's `setPlan`, the "org already bills
   *  through a group" branch. */
  updateSubscriptionPlan(subscriptionId: string, plan: string): Promise<void>;
  /** smoke.ts's `setPlan`, the "no subscription yet" branch: mints one with
   *  the org's owner as payer, points `organizations.subscription_id` at it,
   *  returns the new subscription id. */
  createSubscriptionForOrg(orgId: string, plan: string): Promise<string>;
  /** smoke.ts's `bustOrgEntitlements` elevate/demote — flips every owner of
   *  `orgId` to `is_staff`/`staff_role = 'superadmin'` (or back). */
  setOwnerStaff(orgId: string, on: boolean): Promise<void>;
  /**
   * Bench-only shortcut for `lib/dls-gate.ts`'s probe: forces a division
   * straight to `status = 'active'` without driving the real publish/start
   * gate (`POST /divisions/{id}/start` — courts, `schedule-settings`,
   * `schedule/auto`, `schedule/apply`, then start; `usecases/schedule.ts`'s
   * `startDivision`, "THE GATE"). That gate is a whole product feature this
   * task is not chartered to re-implement a second time (`lib/suites/
   * tiny.ts`'s `runTinySuite` already drives it, for `_tiny`'s own
   * division) — the DLS-gate probe only needs a fixture whose DIVISION is
   * past `setup`/`scheduled` so `assertEntitledToScore` reaches the
   * `requiresDlsEntitlement` check at all (scoring.ts:222-226, WRONG_PHASE
   * otherwise). Same "raw SQL behind the resolver's back because the real
   * path is infeasible to drive here" precedent as `setPlan` itself
   * (smoke.ts's own comment: "smoke targets a disposable DB and the billing
   * checkout path can't run without Stripe").
   */
  setDivisionActive(divisionId: string): Promise<void>;
}

/**
 * Picks the plan this feature is provisioned onto — the lexicographically
 * FIRST plan_key with an explicit `bool_value = true` row for `featureKey`.
 * Deterministic (never "whichever the DB happened to order first") and
 * derived from whatever the target actually has: on the schema this task
 * was briefed against that is "pro" for `cricket.dls` (community=false,
 * pro=true, pro_plus=true — "pro" sorts first), but nothing here assumes
 * that; a target where `pro_plus` is retired (entitlements W2) or where
 * `pro` itself changes still resolves correctly because the choice is read
 * off `rows`, not typed in.
 */
export function chooseGrantingPlan(rows: readonly PlanEntitlementRow[]): string {
  const granting = [...new Set(rows.filter((r) => r.bool_value === true).map((r) => r.plan_key))].sort();
  const chosen = granting[0];
  if (chosen === undefined) {
    throw new Error(
      "chooseGrantingPlan: no plan_entitlements row grants this feature (bool_value = true) — nothing to provision",
    );
  }
  return chosen;
}

/** Whether `planKey` carries an explicit `bool_value = true` row in `rows`
 *  (typically a fresh `entitlementRows` read for a DIFFERENT feature than
 *  whatever `rows` was originally fetched for — e.g. "does the plan this run
 *  just provisioned for cricket.dls ALSO grant officials.auto"). A plan with
 *  no row at all (a pass tier) or an explicit `false` both read `false`
 *  here — this function does not distinguish them, because "does THIS plan
 *  grant THIS feature" only has one true answer either way. */
export function planGrants(rows: readonly PlanEntitlementRow[], planKey: string): boolean {
  return rows.some((r) => r.plan_key === planKey && r.bool_value === true);
}

// ---------------------------------------------------------------------------
// Multi-capability selection (B03 review F1(a))
// ---------------------------------------------------------------------------
// `chooseGrantingPlan` above optimises for exactly one feature and stops —
// which is how this got broken the first time: `runDlsGateProbe` called it
// with only `cricket.dls`'s rows, got back "pro" (the lexicographically
// first of {pro, pro_plus} on the live catalog), and then separately asked
// whether "pro" ALSO happened to grant `officials.auto`. It does not — only
// `pro_plus` does — so `autoAssign` was false on every real run despite a
// plan genuinely existing (`pro_plus`) that grants BOTH. The derivation was
// honest; the PLAN CHOICE optimised for one feature and hoped.
//
// `chooseGrantingPlanForCapabilities` below fixes the CHOICE, not the read:
// it is handed every capability the run actually needs and picks a plan
// satisfying all of them when one exists.

/** One capability this run needs, plus the `plan_entitlements` rows for its
 *  own feature key (an `entitlementRows(featureKey)` read, already made by
 *  the caller — this function issues no I/O itself). */
export interface CapabilityRequirement {
  readonly featureKey: string;
  readonly rows: readonly PlanEntitlementRow[];
}

export interface CapabilityPlanChoice {
  readonly plan: string;
  /** Feature keys among `requirements` (never including `requirements[0]`'s
   *  own — that one is a hard requirement, not a candidate for this list)
   *  that the CHOSEN plan does not grant. Empty when one plan grants every
   *  capability requested. Non-empty is a legitimate outcome, not a bug:
   *  callers must REPORT it (log it, surface it in the bench report) rather
   *  than silently treat the chosen plan as granting everything — that
   *  silent treatment is exactly the bug this function replaces. */
  readonly unsatisfied: readonly string[];
}

function grantingPlanSet(rows: readonly PlanEntitlementRow[]): Set<string> {
  return new Set(rows.filter((r) => r.bool_value === true).map((r) => r.plan_key));
}

/**
 * Chooses one `plan_key` that grants every capability in `requirements`,
 * when such a plan exists — never a hardcoded key, same "derive, never
 * hardcode" precedent as `chooseGrantingPlan` (this file's header comment).
 *
 * `requirements[0]` is the run's REQUIRED capability — the one nothing here
 * can be provisioned without (for the DLS-gate probe, `cricket.dls`: the
 * whole trip exists to clear that gate). Exactly like `chooseGrantingPlan`,
 * this throws if NO plan grants it at all — reusing that function's own
 * throw for the identical message rather than duplicating it; its return
 * value is otherwise discarded here, because the picture this function needs
 * is the FULL set of plans granting the primary feature, not merely the
 * lexicographically-first one.
 *
 * Every requirement AFTER the first is DESIRED, not required: among the
 * plans that grant the primary feature, this picks the one that ALSO grants
 * the most of the rest (lexicographically-first plan_key breaks a tie, same
 * determinism precedent as `chooseGrantingPlan`), preferring a plan that
 * grants every one of them. When no single plan does, `unsatisfied` names
 * exactly which desired feature(s) the chosen plan lacks — reported, never
 * silently dropped (see `CapabilityPlanChoice.unsatisfied`'s own doc
 * comment). This is a legitimate outcome on a catalog where no plan happens
 * to bundle every capability a bench run wants; it is not this function's
 * job to invent one.
 */
export function chooseGrantingPlanForCapabilities(
  requirements: readonly CapabilityRequirement[],
): CapabilityPlanChoice {
  if (requirements.length === 0) {
    throw new Error("chooseGrantingPlanForCapabilities: no capability requirements given — nothing to provision");
  }
  const [primary, ...rest] = requirements;
  // Throws "no plan_entitlements row grants this feature" when nothing
  // grants the REQUIRED capability — same message as chooseGrantingPlan's
  // own single-feature callers see, deliberately not duplicated here.
  chooseGrantingPlan(primary.rows);

  const primaryGrantors = grantingPlanSet(primary.rows);
  const desired = rest.map((r) => ({ featureKey: r.featureKey, plans: grantingPlanSet(r.rows) }));

  let best: { plan: string; unsatisfied: string[] } | undefined;
  for (const plan of [...primaryGrantors].sort()) {
    const unsatisfied = desired.filter((d) => !d.plans.has(plan)).map((d) => d.featureKey);
    if (best === undefined || unsatisfied.length < best.unsatisfied.length) {
      best = { plan, unsatisfied };
      if (unsatisfied.length === 0) break; // nothing beats satisfying every requirement
    }
  }
  return best!;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionPlanInput {
  readonly base: string;
  readonly orgId: string;
  readonly plan: string;
  /** A live session for the org's OWNER — required, not optional, same
   *  reason `bustOrgEntitlements` requires it below: the raw-SQL plan flip
   *  goes behind the entitlement resolver's back, and busting its cache
   *  needs a superadmin call this session makes. */
  readonly ownerSession: Session;
  readonly sql: PlanSql;
  readonly transport?: SeedTransport;
}

/**
 * Flips `orgId` onto `plan` — smoke.ts's `setPlan`, faithfully: billing
 * lives on the GROUP an org bills through (V310), not the org row itself, so
 * this repoints the existing `subscriptions` row when the org already has
 * one and only mints a fresh one (owner as payer) when it does not, then
 * points `organizations.subscription_id` at it. Always followed by
 * `bustOrgEntitlements` — the write is raw SQL behind
 * `lib/entitlements.ts`'s cache-aside resolver, so a resolution from BEFORE
 * this call stays cached (300s TTL) on any Redis-backed target unless the
 * cache is explicitly dropped.
 */
export async function provisionPlan(input: ProvisionPlanInput): Promise<void> {
  const { base, orgId, plan, ownerSession, sql } = input;
  const existingSubscriptionId = await sql.getOrgSubscriptionId(orgId);
  if (existingSubscriptionId !== null) {
    await sql.updateSubscriptionPlan(existingSubscriptionId, plan);
  } else {
    await sql.createSubscriptionForOrg(orgId, plan);
  }
  await bustOrgEntitlements({ base, orgId, ownerSession, sql, transport: input.transport });
}

const CACHE_BUST_KEY = "bench.cache.bust";

export interface BustEntitlementsInput {
  readonly base: string;
  readonly orgId: string;
  readonly ownerSession: Session;
  readonly sql: PlanSql;
  readonly transport?: SeedTransport;
}

/**
 * smoke.ts's `bustOrgEntitlements`, faithfully: there is no public
 * invalidation endpoint, so this rides the superadmin entitlement-override
 * route (its POST and DELETE both call `invalidateOrgEntitlements`) — the
 * org's owner is flipped to superadmin in SQL for the two calls, then
 * restored.
 *
 * The elevate is INSIDE the try, matching smoke.ts's own reasoning exactly:
 * its SQL update commits before this function's next line runs, so anything
 * that throws between that commit and the try entering would leave the org
 * owner a live superadmin with nothing to restore it. `finally` runs whether
 * or not the elevate itself succeeded, and demoting an already-plain user is
 * a harmless no-op. Do not "simplify" this by moving the elevate above the
 * try — that is the exact bug this shape exists to prevent.
 *
 * One deliberate adaptation from smoke.ts's own body, not a paraphrase of
 * its INTENT: smoke.ts's `raw()` never throws on a non-2xx and
 * `bustOrgEntitlements` there manually checks `posted.status`/`deleted.status`
 * and throws itself. This directory's `lib/http.ts#request()` already throws
 * `BenchHttpError` on any unexpected 4xx/5xx (`seed.ts`'s own precedent,
 * every call site here), so the manual status checks are redundant — letting
 * `request()` throw natively keeps the same "a failed bust must stop the run
 * loudly, never silently leave a stale cache or a stranded override row"
 * property smoke.ts's comment describes, through this directory's own idiom
 * rather than smoke.ts's `raw()`-based one.
 */
export async function bustOrgEntitlements(input: BustEntitlementsInput): Promise<void> {
  const { base, orgId, ownerSession, sql } = input;
  const t = input.transport ?? defaultTransport;
  const path = `/api/admin/orgs/${orgId}/entitlement-override`;
  try {
    await sql.setOwnerStaff(orgId, true);
    await t.request(base, ownerSession, path, {
      method: "POST",
      body: { feature_key: CACHE_BUST_KEY, reason: "bench: drop cached entitlements after a raw plan write" },
    });
    await t.request(base, ownerSession, path, { method: "DELETE", body: { feature_key: CACHE_BUST_KEY } });
  } finally {
    await sql.setOwnerStaff(orgId, false);
  }
}

// ---------------------------------------------------------------------------
// Real implementation — the I/O boundary, deliberately untested at the unit
// level (needs a live Postgres), same split as `lib/env.ts`'s
// `createRealPreflightProbes`. Query text hand-copied from smoke.ts's
// `setPlan`/`bustOrgEntitlements`/`smokeDb()` (search_path, DATABASE_SSL
// convention).
// ---------------------------------------------------------------------------

export interface RealPlanSqlHandle {
  sql: PlanSql;
  /** Closes the DB connection this factory opened. Call once, after every
   *  plan-provisioning call (and the DLS-gate probe, which shares this same
   *  seam) is done with it.
   *
   *  A property with a function type, not a method shorthand — same reason as
   *  `RealProbesHandle.dispose`: this is destructured at its call site. */
  dispose: () => Promise<void>;
}

export function createRealPlanSql(): RealPlanSqlHandle {
  const databaseUrl = process.env.DATABASE_URL;
  let sqlClient: ReturnType<typeof postgres> | undefined;

  function getSql(): ReturnType<typeof postgres> {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is not set — plan provisioning needs the bench's own throwaway DB.");
    }
    if (!sqlClient) {
      const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
      sqlClient = postgres(databaseUrl, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
        prepare: !databaseUrl.includes(":6543"),
        max: 1,
      });
    }
    return sqlClient;
  }

  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      return getSql()<PlanEntitlementRow[]>`
        select plan_key, bool_value from plan_entitlements where feature_key = ${featureKey}`;
    },
    async getOrgSubscriptionId(orgId) {
      const [row] = await getSql()<{ subscription_id: string | null }[]>`
        select subscription_id from organizations where id = ${orgId}`;
      return row?.subscription_id ?? null;
    },
    async updateSubscriptionPlan(subscriptionId, plan) {
      await getSql()`
        update subscriptions set plan_key = ${plan}, status = 'active', updated_at = now()
        where id = ${subscriptionId}`;
    },
    async createSubscriptionForOrg(orgId, plan) {
      const s = getSql();
      const [group] = await s<{ id: string }[]>`
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce(
                 (select m.user_id from org_members m
                   where m.org_id = o.id and m.role = 'owner'
                   order by m.created_at limit 1),
                 o.created_by),
               ${plan}, 'active'
          from organizations o where o.id = ${orgId}
        returning id`;
      if (!group) {
        throw new Error(`createSubscriptionForOrg: organization "${orgId}" not found`);
      }
      await s`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
      return group.id;
    },
    async setOwnerStaff(orgId, on) {
      await getSql()`
        update users set is_staff = ${on}, staff_role = ${on ? "superadmin" : null}
        where id in (
          select user_id from org_members where org_id = ${orgId} and role = 'owner'
        )`;
    },
    async setDivisionActive(divisionId) {
      await getSql()`update divisions set status = 'active' where id = ${divisionId}`;
    },
  };

  return {
    sql,
    async dispose() {
      await sqlClient?.end();
    },
  };
}
