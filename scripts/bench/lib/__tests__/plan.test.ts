// DB-free unit coverage for lib/plan.ts's pure derivation helpers and the
// provisionPlan/bustOrgEntitlements orchestration — every SQL call and every
// HTTP call is injected (PlanSql / SeedTransport), matching lib/env.ts's own
// PreflightProbes precedent (see plan.ts's header comment). No live Postgres
// or server anywhere in this file.
import { describe, expect, it } from "vitest";
import { newSession, BenchHttpError, type Session } from "../http.ts";
import type { SeedTransport } from "../seed.ts";
import {
  bustOrgEntitlements,
  chooseGrantingPlan,
  planGrants,
  provisionPlan,
  type PlanEntitlementRow,
  type PlanSql,
} from "../plan.ts";

// ---------------------------------------------------------------------------
// chooseGrantingPlan / planGrants — pure
// ---------------------------------------------------------------------------

describe("chooseGrantingPlan", () => {
  it("picks the lexicographically FIRST plan with an explicit bool_value=true row", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "pro_plus", bool_value: true },
      { plan_key: "pro", bool_value: true },
    ];
    // "pro" < "pro_plus" lexicographically — deterministic, never DB order.
    expect(chooseGrantingPlan(rows)).toBe("pro");
  });

  it("ignores false and null rows entirely", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "enterprise", bool_value: null },
      { plan_key: "zzz_only_grantor", bool_value: true },
    ];
    expect(chooseGrantingPlan(rows)).toBe("zzz_only_grantor");
  });

  it("throws, naming the reason, when NO plan grants the feature", () => {
    const rows: PlanEntitlementRow[] = [{ plan_key: "community", bool_value: false }];
    expect(() => chooseGrantingPlan(rows)).toThrow(/no plan_entitlements row grants/);
  });

  it("throws on an empty row set — a feature key that maps to no plan at all", () => {
    expect(() => chooseGrantingPlan([])).toThrow(/no plan_entitlements row grants/);
  });

  it("dedupes a repeated plan_key rather than being confused by it", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "pro", bool_value: true },
      { plan_key: "pro", bool_value: true },
    ];
    expect(chooseGrantingPlan(rows)).toBe("pro");
  });
});

describe("planGrants", () => {
  const rows: PlanEntitlementRow[] = [
    { plan_key: "community", bool_value: false },
    { plan_key: "pro", bool_value: true },
  ];

  it("true when the named plan has an explicit true row", () => {
    expect(planGrants(rows, "pro")).toBe(true);
  });

  it("false when the named plan has an explicit false row", () => {
    expect(planGrants(rows, "community")).toBe(false);
  });

  it("false when the named plan has NO row at all (a pass tier) — absent reads the same as denied here", () => {
    expect(planGrants(rows, "event_pass")).toBe(false);
  });

  it("false when the row is explicitly NULL, not just false — pins ===true, not !==false", () => {
    // A regression net for a specific mutant: `bool_value !== false` reads a
    // null row as a grant (null !== false), which is wrong — null means "no
    // opinion", never "granted". Only `=== true` is a real grant.
    const withNull: PlanEntitlementRow[] = [{ plan_key: "enterprise", bool_value: null }];
    expect(planGrants(withNull, "enterprise")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// provisionPlan / bustOrgEntitlements — orchestration over fakes
// ---------------------------------------------------------------------------

interface RecordedSqlCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

function fakePlanSql(overrides: Partial<PlanSql> = {}): { sql: PlanSql; calls: RecordedSqlCall[] } {
  const calls: RecordedSqlCall[] = [];
  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      calls.push({ op: "entitlementRows", args: [featureKey] });
      return [];
    },
    async getOrgSubscriptionId(orgId) {
      calls.push({ op: "getOrgSubscriptionId", args: [orgId] });
      return null;
    },
    async updateSubscriptionPlan(subscriptionId, plan) {
      calls.push({ op: "updateSubscriptionPlan", args: [subscriptionId, plan] });
    },
    async createSubscriptionForOrg(orgId, plan) {
      calls.push({ op: "createSubscriptionForOrg", args: [orgId, plan] });
      return "new-sub-id";
    },
    async setOwnerStaff(orgId, on) {
      calls.push({ op: "setOwnerStaff", args: [orgId, on] });
    },
    async setDivisionActive(divisionId) {
      calls.push({ op: "setDivisionActive", args: [divisionId] });
    },
    ...overrides,
  };
  return { sql, calls };
}

interface RecordedHttpCall {
  readonly path: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function fakeTransport(opts: { throwOnPath?: string } = {}): { transport: SeedTransport; calls: RecordedHttpCall[] } {
  const calls: RecordedHttpCall[] = [];
  const transport: SeedTransport = {
    signIn: async () => ({ has_org: true, org_id: "org-1", redirect: "/" }),
    request: async (_base, _s, path, requestOpts) => {
      calls.push({ path, method: requestOpts?.method, body: requestOpts?.body });
      if (opts.throwOnPath && path.includes(opts.throwOnPath) && requestOpts?.method === "POST") {
        throw new BenchHttpError(path, 500, { ok: false, error: "boom" });
      }
      return undefined as never;
    },
  };
  return { transport, calls };
}

describe("bustOrgEntitlements", () => {
  const ownerSession: Session = newSession();

  it("elevates, posts an override, deletes it, then demotes — in that order", async () => {
    const { sql, calls: sqlCalls } = fakePlanSql();
    const { transport, calls: httpCalls } = fakeTransport();

    await bustOrgEntitlements({ base: "http://bench.example", orgId: "org-1", ownerSession, sql, transport });

    expect(sqlCalls.map((c) => c.op)).toEqual(["setOwnerStaff", "setOwnerStaff"]);
    expect(sqlCalls[0]!.args).toEqual(["org-1", true]);
    expect(sqlCalls[1]!.args).toEqual(["org-1", false]);
    expect(httpCalls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(httpCalls[0]!.path).toBe("/api/admin/orgs/org-1/entitlement-override");
    expect(httpCalls[1]!.path).toBe("/api/admin/orgs/org-1/entitlement-override");
  });

  // Load-bearing: mirrors smoke.ts's own reasoning almost verbatim (plan.ts's
  // header comment on `bustOrgEntitlements`) — the elevate is INSIDE the try
  // specifically so a throw between the POST and the DELETE still demotes.
  // Deleting the `finally` (or moving the demote above the try, so it never
  // re-runs after a throw) is exactly the regression this test exists to
  // catch — mutated by hand below and confirmed red (see task report).
  it("still demotes the owner when the HTTP call throws mid-bust", async () => {
    const { sql, calls: sqlCalls } = fakePlanSql();
    const { transport } = fakeTransport({ throwOnPath: "entitlement-override" });

    await expect(
      bustOrgEntitlements({ base: "http://bench.example", orgId: "org-1", ownerSession, sql, transport }),
    ).rejects.toThrow();

    expect(sqlCalls.map((c) => c.op)).toEqual(["setOwnerStaff", "setOwnerStaff"]);
    expect(sqlCalls[1]!.args).toEqual(["org-1", false]);
  });
});

describe("provisionPlan", () => {
  const ownerSession: Session = newSession();

  it("repoints the EXISTING subscription when the org already bills through one", async () => {
    const { sql, calls } = fakePlanSql({
      async getOrgSubscriptionId() {
        return "sub-existing";
      },
    });
    const { transport } = fakeTransport();

    await provisionPlan({ base: "http://bench.example", orgId: "org-1", plan: "pro", ownerSession, sql, transport });

    const ops = calls.map((c) => c.op);
    expect(ops).toContain("updateSubscriptionPlan");
    expect(ops).not.toContain("createSubscriptionForOrg");
    const update = calls.find((c) => c.op === "updateSubscriptionPlan")!;
    expect(update.args).toEqual(["sub-existing", "pro"]);
  });

  it("mints a fresh subscription when the org has NONE yet", async () => {
    const { sql, calls } = fakePlanSql({
      async getOrgSubscriptionId() {
        return null;
      },
    });
    const { transport } = fakeTransport();

    await provisionPlan({ base: "http://bench.example", orgId: "org-1", plan: "pro", ownerSession, sql, transport });

    const ops = calls.map((c) => c.op);
    expect(ops).toContain("createSubscriptionForOrg");
    expect(ops).not.toContain("updateSubscriptionPlan");
    const create = calls.find((c) => c.op === "createSubscriptionForOrg")!;
    expect(create.args).toEqual(["org-1", "pro"]);
  });

  it("always busts the cache after the write", async () => {
    const { sql, calls } = fakePlanSql({ async getOrgSubscriptionId() { return null; } });
    const { transport, calls: httpCalls } = fakeTransport();

    await provisionPlan({ base: "http://bench.example", orgId: "org-1", plan: "pro", ownerSession, sql, transport });

    expect(calls.map((c) => c.op)).toContain("setOwnerStaff");
    expect(httpCalls.some((c) => c.path.includes("entitlement-override"))).toBe(true);
  });
});
