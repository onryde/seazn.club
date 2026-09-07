// DB-free unit coverage for lib/plan.ts's pure derivation helpers and the
// provisionPlan/bustOrgEntitlements orchestration — every SQL call and every
// HTTP call is injected (PlanSql / SeedTransport), matching lib/env.ts's own
// PreflightProbes precedent (see plan.ts's header comment). No live Postgres
// or server anywhere in this file.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newSession, BenchHttpError, type Session } from "../http.ts";
import type { SeedTransport } from "../seed.ts";
import {
  bustOrgEntitlements,
  chooseGrantingPlan,
  chooseGrantingPlanForCapabilities,
  planGrants,
  provisionPlan,
  type PlanCandidateInfo,
  type PlanEntitlementRow,
  type PlanSql,
} from "../plan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function publicPlan(planKey: string, privilege = 0): PlanCandidateInfo {
  return { plan_key: planKey, is_public: true, privilege };
}
function privatePlan(planKey: string, privilege = 0): PlanCandidateInfo {
  return { plan_key: planKey, is_public: false, privilege };
}

// ---------------------------------------------------------------------------
// chooseGrantingPlan / planGrants — pure
// ---------------------------------------------------------------------------

describe("chooseGrantingPlan", () => {
  it("picks the LEAST-PRIVILEGED public plan among several that grant the feature", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "pro", bool_value: true },
      { plan_key: "event_pass", bool_value: true },
    ];
    expect(chooseGrantingPlan(rows, [publicPlan("pro", 20), publicPlan("event_pass", 3)])).toBe("event_pass");
  });

  it("prefers lower privilege even when it sorts alphabetically LATER — privilege drives the choice, not the name", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "aaa_broad_plan", bool_value: true },
      { plan_key: "zzz_narrow_plan", bool_value: true },
    ];
    expect(
      chooseGrantingPlan(rows, [publicPlan("aaa_broad_plan", 50), publicPlan("zzz_narrow_plan", 2)]),
    ).toBe("zzz_narrow_plan");
  });

  // B05 T0 — the real regression, verified on main: V393__entitlements_v18
  // .sql:25-26 inserts `enterprise` with `is_public = false` and copies every
  // `pro_plus` row onto it, so on the live catalog `cricket.dls` is granted
  // by {community=false, enterprise=true, pro=true}. The OLD lexicographic
  // chooser landed on "enterprise" (it sorts before "pro") — a plan no
  // customer can buy, with unlimited caps. This must always resolve to
  // "pro", the only PUBLIC grantor, no matter how privileged `enterprise` is.
  it("NEVER selects a non-public plan — real regression: V393's enterprise plan sorts before pro and grants everything", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "enterprise", bool_value: true },
      { plan_key: "pro", bool_value: true },
    ];
    // enterprise is deliberately given LOWER privilege than pro here too, so
    // this test cannot be satisfied by the privilege rule alone — only the
    // is_public filter explains "pro" winning.
    expect(chooseGrantingPlan(rows, [privatePlan("enterprise", 5), publicPlan("pro", 20)])).toBe("pro");
  });

  it("throws, naming that grants exist but none are public, when every grantor is is_public=false", () => {
    const rows: PlanEntitlementRow[] = [{ plan_key: "enterprise", bool_value: true }];
    expect(() => chooseGrantingPlan(rows, [privatePlan("enterprise", 40)])).toThrow(/none is public/);
  });

  it("treats a plan_key missing from candidates as NOT public — never assumes safety without evidence", () => {
    const rows: PlanEntitlementRow[] = [{ plan_key: "some_new_plan", bool_value: true }];
    expect(() => chooseGrantingPlan(rows, [])).toThrow(/none is public/);
  });

  it("ignores false and null rows entirely", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "enterprise", bool_value: null },
      { plan_key: "zzz_only_grantor", bool_value: true },
    ];
    expect(chooseGrantingPlan(rows, [publicPlan("zzz_only_grantor")])).toBe("zzz_only_grantor");
  });

  it("throws, naming the reason, when NO plan grants the feature", () => {
    const rows: PlanEntitlementRow[] = [{ plan_key: "community", bool_value: false }];
    expect(() => chooseGrantingPlan(rows, [])).toThrow(/no plan_entitlements row grants/);
  });

  it("throws on an empty row set — a feature key that maps to no plan at all", () => {
    expect(() => chooseGrantingPlan([], [])).toThrow(/no plan_entitlements row grants/);
  });

  it("dedupes a repeated plan_key rather than being confused by it", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "pro", bool_value: true },
      { plan_key: "pro", bool_value: true },
    ];
    expect(chooseGrantingPlan(rows, [publicPlan("pro")])).toBe("pro");
  });

  it("breaks a privilege tie lexicographically — deterministic, never DB order", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "zzz_only_grantor", bool_value: true },
      { plan_key: "aaa_also_grants", bool_value: true },
    ];
    expect(
      chooseGrantingPlan(rows, [publicPlan("zzz_only_grantor", 3), publicPlan("aaa_also_grants", 3)]),
    ).toBe("aaa_also_grants");
  });
});

// ---------------------------------------------------------------------------
// chooseGrantingPlanForCapabilities — the B03 review F1(a) fix: choose a
// plan that grants EVERY capability the run needs, never one feature and a
// hope.
// ---------------------------------------------------------------------------

describe("chooseGrantingPlanForCapabilities", () => {
  it("picks the plan that grants BOTH the required and every desired capability, when one exists — the real production shape", () => {
    // The REAL live catalog post-V393: cricket.dls is granted by BOTH pro
    // AND enterprise; officials.auto likewise (V393 step 3 gives pro
    // officials.auto too; enterprise inherited it from pro_plus in step 2).
    // enterprise is `is_public = false` (V393:25-26) and MORE privileged
    // (it is pro_plus's superset, copied wholesale) — this function must
    // still land on "pro", the only PUBLIC grantor, never on enterprise no
    // matter how completely it satisfies every desired capability.
    const cricketDls: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "pro", bool_value: true },
      { plan_key: "enterprise", bool_value: true },
    ];
    const officialsAuto: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "pro", bool_value: true },
      { plan_key: "enterprise", bool_value: true },
    ];
    const candidates: PlanCandidateInfo[] = [publicPlan("pro", 20), privatePlan("enterprise", 60)];
    const result = chooseGrantingPlanForCapabilities(
      [
        { featureKey: "cricket.dls", rows: cricketDls },
        { featureKey: "officials.auto", rows: officialsAuto },
      ],
      candidates,
    );
    expect(result.plan).toBe("pro");
    expect(result.unsatisfied).toEqual([]);
  });

  it("among two PUBLIC candidates that both satisfy everything, prefers the LEAST privileged — never an alphabetical accident", () => {
    // Both "beta_wide" and "alpha_narrow" grant every requested capability
    // (unsatisfied.length ties at 0 for both), so before this fix the
    // alphabetically-first ("alpha_narrow") would win by iteration order
    // alone. Here "alpha_narrow" is also the CORRECT answer (lowest
    // privilege) — see the next test for the case where alphabetical and
    // privilege order disagree.
    const primary: PlanEntitlementRow[] = [
      { plan_key: "alpha_narrow", bool_value: true },
      { plan_key: "beta_wide", bool_value: true },
    ];
    const desired: PlanEntitlementRow[] = [
      { plan_key: "alpha_narrow", bool_value: true },
      { plan_key: "beta_wide", bool_value: true },
    ];
    const candidates: PlanCandidateInfo[] = [publicPlan("alpha_narrow", 4), publicPlan("beta_wide", 30)];
    const result = chooseGrantingPlanForCapabilities(
      [
        { featureKey: "required", rows: primary },
        { featureKey: "desired", rows: desired },
      ],
      candidates,
    );
    expect(result.plan).toBe("alpha_narrow");
    expect(result.unsatisfied).toEqual([]);
  });

  it("privilege order can disagree with alphabetical order, and privilege wins", () => {
    // "zzz_narrow" sorts LAST alphabetically but has the LOWEST privilege —
    // proves the ranking is privilege-driven, not incidentally alphabetical.
    const primary: PlanEntitlementRow[] = [
      { plan_key: "aaa_wide", bool_value: true },
      { plan_key: "zzz_narrow", bool_value: true },
    ];
    const desired: PlanEntitlementRow[] = [
      { plan_key: "aaa_wide", bool_value: true },
      { plan_key: "zzz_narrow", bool_value: true },
    ];
    const candidates: PlanCandidateInfo[] = [publicPlan("aaa_wide", 40), publicPlan("zzz_narrow", 1)];
    const result = chooseGrantingPlanForCapabilities(
      [
        { featureKey: "required", rows: primary },
        { featureKey: "desired", rows: desired },
      ],
      candidates,
    );
    expect(result.plan).toBe("zzz_narrow");
  });

  it("reports which capability forced the gap, never silently downgrading, when NO single PUBLIC plan grants everything", () => {
    // No PUBLIC plan on this catalog grants both — cricket.dls only "pro",
    // officials.auto only the non-public "enterprise". The REQUIRED
    // capability (requirements[0]) still has to be honoured, so the chosen
    // plan is the one that grants it; the gap is named, not hidden, and
    // "enterprise" is never chosen even though IT would satisfy everything.
    const cricketDls: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "pro", bool_value: true },
    ];
    const officialsAuto: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "enterprise", bool_value: true },
    ];
    const candidates: PlanCandidateInfo[] = [publicPlan("pro", 10), privatePlan("enterprise", 60)];
    const result = chooseGrantingPlanForCapabilities(
      [
        { featureKey: "cricket.dls", rows: cricketDls },
        { featureKey: "officials.auto", rows: officialsAuto },
      ],
      candidates,
    );
    expect(result.plan).toBe("pro");
    expect(result.unsatisfied).toEqual(["officials.auto"]);
  });

  it("among several candidates for the required feature, prefers the one satisfying the MOST desired capabilities", () => {
    const primary: PlanEntitlementRow[] = [
      { plan_key: "alpha", bool_value: true },
      { plan_key: "beta", bool_value: true },
      { plan_key: "gamma", bool_value: true },
    ];
    // "alpha" grants neither desired feature; "beta" grants one; "gamma"
    // grants both. Only "gamma" should win, even though "alpha" sorts first
    // AND is given the lowest privilege score — satisfying MORE desired
    // capabilities always outranks privilege.
    const desired1: PlanEntitlementRow[] = [
      { plan_key: "beta", bool_value: true },
      { plan_key: "gamma", bool_value: true },
    ];
    const desired2: PlanEntitlementRow[] = [{ plan_key: "gamma", bool_value: true }];
    const candidates: PlanCandidateInfo[] = [publicPlan("alpha", 1), publicPlan("beta", 5), publicPlan("gamma", 9)];
    const result = chooseGrantingPlanForCapabilities(
      [
        { featureKey: "required", rows: primary },
        { featureKey: "desired1", rows: desired1 },
        { featureKey: "desired2", rows: desired2 },
      ],
      candidates,
    );
    expect(result.plan).toBe("gamma");
    expect(result.unsatisfied).toEqual([]);
  });

  it("breaks a tie between equally-unsatisfying candidates lexicographically, same determinism precedent as chooseGrantingPlan", () => {
    const primary: PlanEntitlementRow[] = [
      { plan_key: "zzz_only_grantor", bool_value: true },
      { plan_key: "aaa_also_grants", bool_value: true },
    ];
    // Neither candidate grants the desired feature at all — both tie at one
    // unsatisfied capability AND at the same privilege score, so the
    // lexicographically-first wins.
    const desired: PlanEntitlementRow[] = [{ plan_key: "some_other_plan", bool_value: true }];
    const candidates: PlanCandidateInfo[] = [publicPlan("zzz_only_grantor", 7), publicPlan("aaa_also_grants", 7)];
    const result = chooseGrantingPlanForCapabilities(
      [
        { featureKey: "required", rows: primary },
        { featureKey: "desired", rows: desired },
      ],
      candidates,
    );
    expect(result.plan).toBe("aaa_also_grants");
    expect(result.unsatisfied).toEqual(["desired"]);
  });

  it("throws, naming the required feature, when NO plan grants it — same message chooseGrantingPlan itself throws", () => {
    expect(() =>
      chooseGrantingPlanForCapabilities(
        [
          { featureKey: "cricket.dls", rows: [{ plan_key: "community", bool_value: false }] },
          { featureKey: "officials.auto", rows: [{ plan_key: "enterprise", bool_value: true }] },
        ],
        [],
      ),
    ).toThrow(/no plan_entitlements row grants/);
  });

  it("throws, naming that grants exist but none are public, when only a non-public plan grants the REQUIRED capability", () => {
    expect(() =>
      chooseGrantingPlanForCapabilities(
        [{ featureKey: "cricket.dls", rows: [{ plan_key: "enterprise", bool_value: true }] }],
        [privatePlan("enterprise", 60)],
      ),
    ).toThrow(/none is public/);
  });

  it("degenerates to a single-feature choice with an empty unsatisfied list when only one requirement is given", () => {
    const rows: PlanEntitlementRow[] = [
      { plan_key: "community", bool_value: false },
      { plan_key: "pro", bool_value: true },
    ];
    const result = chooseGrantingPlanForCapabilities([{ featureKey: "cricket.dls", rows }], [publicPlan("pro")]);
    expect(result.plan).toBe("pro");
    expect(result.unsatisfied).toEqual([]);
  });

  it("throws on an empty requirements list — nothing to provision", () => {
    expect(() => chooseGrantingPlanForCapabilities([], [])).toThrow(/no capability requirements given/);
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
    async planCandidateInfo(planKeys) {
      calls.push({ op: "planCandidateInfo", args: [planKeys] });
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

// ---------------------------------------------------------------------------
// Guard: this file's (and dls-gate.test.ts's) "mirrors the live catalog"
// fixtures must never assert a plan_key the live migrations do not actually
// have. `pro_plus` — used by both files as the plan granting
// officials.auto/stats.player — was deleted by V393__entitlements_v18.sql,
// and nothing here noticed until this task: the fixtures still injected rows
// naming it, unit-green, forever (plan.ts's own header comment on this exact
// hazard: "the file has no way to notice it stopped being true").
//
// The LIVE plan set is DERIVED from db/migration/deltas/*.sql (every
// `insert into plans` minus every `delete from plans`, applied in ascending
// version order) rather than hand-typed — a hand-typed "these plans exist
// today" constant would go stale exactly the way `pro_plus` did. What IS
// hand-typed below is only WHICH plan_keys this suite's fixtures claim are
// real (as opposed to the synthetic alpha/beta/gamma/zzz_* keys used all
// over this file to exercise the pure selection algorithm on data that never
// claims to model a real plan).
// ---------------------------------------------------------------------------

const DELTAS_DIR = path.resolve(HERE, "..", "..", "..", "..", "db", "migration", "deltas");

/** `key` is always the first column in every `insert into plans (...)
 *  values (...)` statement in this codebase (checked: V101, V112, V270,
 *  V290, V341, V393 all agree) — so the first quoted literal inside each
 *  parenthesised VALUES row is the plan key. */
function deriveLivePlanKeysFromMigrations(): ReadonlySet<string> {
  const files = readdirSync(DELTAS_DIR)
    .filter((f) => /^V\d+__.+\.sql$/.test(f))
    .sort((a, b) => Number(a.slice(1, a.indexOf("__"))) - Number(b.slice(1, b.indexOf("__"))));
  const live = new Set<string>();
  for (const file of files) {
    const text = readFileSync(path.join(DELTAS_DIR, file), "utf8");
    for (const stmt of text.matchAll(/insert\s+into\s+plans\s*\([^)]*\)\s*values\s*([\s\S]*?);/gi)) {
      for (const row of stmt[1]!.matchAll(/\(\s*'([^']+)'/g)) {
        live.add(row[1]!);
      }
    }
    for (const del of text.matchAll(/delete\s+from\s+plans\s+where\s+key\s*=\s*'([^']+)'/gi)) {
      live.delete(del[1]!);
    }
  }
  return live;
}

// Every plan_key this file's (and dls-gate.test.ts's) "real catalog"
// fixtures assert exists today.
const PLAN_KEYS_ASSERTED_AS_REAL_IN_FIXTURES = ["community", "pro", "enterprise"] as const;

describe("this suite's \"real catalog\" fixtures stay honest against the live migrations", () => {
  it("every plan_key asserted as real in a fixture still exists (inserts minus deletes, derived, never hand-typed)", () => {
    const live = deriveLivePlanKeysFromMigrations();
    for (const key of PLAN_KEYS_ASSERTED_AS_REAL_IN_FIXTURES) {
      expect(live.has(key), `"${key}" is asserted as a real plan by a fixture but is absent from the derived live set`).toBe(
        true,
      );
    }
  });

  it("sanity: the derivation actually EXCLUDES a retired plan — pro_plus and business were both inserted then deleted", () => {
    // Proves this guard is not vacuously true (a parser that always returns
    // "everything exists" would pass the test above for the wrong reason).
    // `pro_plus` (V290__pro_plus_plan.sql:13, deleted V393:146) is exactly
    // the plan this file's own fixtures went stale asserting.
    const live = deriveLivePlanKeysFromMigrations();
    expect(live.has("pro_plus")).toBe(false);
    expect(live.has("business")).toBe(false);
  });
});
