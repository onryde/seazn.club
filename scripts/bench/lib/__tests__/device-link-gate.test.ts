// B07a T11 — the device link is a paid feature: prove the refusal, provision,
// then prove the mint.
//
// Minting a device link runs `requireFeature(orgId, "scoring.device_links",
// ...)` (apps/web/src/server/usecases/device-links.ts:128) — a 402 for an org
// on the free plan — so every tap suite has a real entitlement to prove, the
// first outside cricket's DLS since v18 W1 deleted the fidelity gate.
//
// DB-free and server-free. The fake PlanSql and the fake transport share ONE
// billing box (dls-gate.test.ts's `FakeOrgBilling` precedent), and the fake
// server resolves every gate from the CATALOG ROWS for the org's current plan
// — the product's own rule — never from a hardcoded "community refuses"
// branch. So a refusal can only pass if it was sent before the flip, a mint
// only if it was sent after, and a test that edits the catalog edits what the
// server answers with it.
import { describe, expect, it } from "vitest";
import { newSession, type RawResult } from "../http.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import {
  classifyDlsGateCell,
  proveDeviceLinkGate,
  provocableFeatureKeys,
  runDlsGateProbe,
  type ProbeTransport,
} from "../dls-gate.ts";

const BASE = "http://bench.example";
const DEVICE_LINKS = "scoring.device_links";

type Catalog = Readonly<Record<string, readonly PlanEntitlementRow[]>>;

/** A key sold on `pro` and `enterprise`, and granted on `community` only when
 *  asked. `scoring.device_links` on the live DB is exactly the default:
 *  V117__device_links.sql:55-56 (community false, pro true), and `enterprise`
 *  inherits pro_plus's row through V393__entitlements_v18.sql step 2. The pass
 *  rungs' rows (V393:110-111) are left out — neither grants `cricket.dls`, the
 *  chooser's REQUIRED capability, so neither can ever be provisioned onto. */
function soldOnPro(opts: { community?: boolean } = {}): readonly PlanEntitlementRow[] {
  return [
    { plan_key: "community", bool_value: opts.community ?? false },
    { plan_key: "pro", bool_value: true },
    { plan_key: "enterprise", bool_value: true },
  ];
}

const LIVE_CATALOG: Catalog = {
  // Scoring is free (V393:63-70); the other three are leverage, and sold.
  "cricket.dls": soldOnPro({ community: true }),
  "officials.auto": soldOnPro(),
  "stats.player": soldOnPro(),
  "news.auto": soldOnPro(),
  [DEVICE_LINKS]: soldOnPro(),
};

const CANDIDATES: Readonly<Record<string, { is_public: boolean; privilege: number }>> = {
  community: { is_public: true, privilege: 0 },
  pro: { is_public: true, privilege: 10 },
  enterprise: { is_public: false, privilege: 50 },
  // Synthetic, never claimed to be a real plan (plan.test.ts's `zzz_*`
  // convention): a PUBLIC plan broader and dearer than `pro`.
  zzz_scoring_plus: { is_public: true, privilege: 20 },
};

interface Billing {
  plan: string;
}

function grants(catalog: Catalog, featureKey: string, plan: string): boolean {
  return (catalog[featureKey] ?? []).some((r) => r.plan_key === plan && r.bool_value === true);
}

function fakeSql(catalog: Catalog, billing: Billing): { sql: PlanSql; calls: string[] } {
  const calls: string[] = [];
  const sql = {
    async entitlementRows(featureKey: string) {
      calls.push(`entitlementRows(${featureKey})`);
      return catalog[featureKey] ?? [];
    },
    async planCandidateInfo(planKeys: readonly string[]) {
      calls.push(`planCandidateInfo(${planKeys.join(",")})`);
      return planKeys.filter((k) => k in CANDIDATES).map((k) => ({ plan_key: k, ...CANDIDATES[k]! }));
    },
    async getOrgSubscriptionId() {
      return null;
    },
    async updateSubscriptionPlan(_subscriptionId: string, plan: string) {
      calls.push(`provision(${plan})`);
      billing.plan = plan;
    },
    async createSubscriptionForOrg(_orgId: string, plan: string) {
      calls.push(`provision(${plan})`);
      billing.plan = plan;
      return "sub-new";
    },
    async setOwnerStaff() {},
    async setDivisionActive(divisionId: string) {
      calls.push(`setDivisionActive(${divisionId})`);
    },
  } as unknown as PlanSql;
  return { sql, calls };
}

/** The brief's `fakeCatalogSql()`: the live catalog, read the way the probe reads it. */
function fakeCatalogSql(catalog: Catalog = LIVE_CATALOG): PlanSql {
  return fakeSql(catalog, { plan: "community" }).sql;
}

interface HttpCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** The org's plan at the moment this call went out — the ordering witness. */
  readonly planAtCall: string;
}

function refusal(featureKey: string): RawResult {
  return {
    status: 402,
    json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "upgrade", feature_key: featureKey } } as never,
  };
}

function fakeServer(
  catalog: Catalog,
  billing: Billing,
  seededFixtures: readonly string[] = [],
): { transport: ProbeTransport; calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const fixtures = new Set<string>(seededFixtures);
  const legsByStage = new Map<string, number>();
  let n = 0;

  const transport: ProbeTransport = {
    signIn: async () => ({ has_org: true, org_id: "org-probe", redirect: "/" }),
    request: async (_base, _s, path, opts) => {
      const method = opts?.method ?? "GET";
      calls.push({ method, path, body: opts?.body, planAtCall: billing.plan });
      if (method === "POST" && path === "/api/v1/competitions") return { id: "comp-probe" } as never;
      if (method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(path)) {
        return { id: `div-${++n}` } as never;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/entrants$/.test(path)) {
        return [{ id: "ent-a" }, { id: "ent-b" }] as never;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/stages$/.test(path)) {
        const id = `stage-${++n}`;
        legsByStage.set(id, (opts?.body as { config: { legs: number } }[])[0]!.config.legs);
        return [{ id }] as never;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/generate$/.test(path)) {
        const legs = legsByStage.get(path.split("/")[4]!)!;
        const minted = Array.from({ length: legs }, () => {
          const id = `fx-${++n}`;
          fixtures.add(id);
          return { id };
        });
        return { fixtures: minted } as never;
      }
      if (path === "/api/admin/orgs/org-probe/entitlement-override" && (method === "POST" || method === "DELETE")) {
        return { ok: true } as never;
      }
      throw new Error(`fake server: unhandled request ${method} ${path}`);
    },
    raw: async (_base, _s, path, method = "GET", body) => {
      calls.push({ method, path, body, planAtCall: billing.plan });

      const mint = /^\/api\/v1\/fixtures\/([^/]+)\/device-links$/.exec(path);
      if (mint && method === "POST") {
        // The route's own order (api/v1/fixtures/[id]/device-links/route.ts):
        // parseBody(CreateDeviceLink) -> requireResourceAuth (an unknown
        // fixture never reaches the gate) -> createDeviceLink -> the gate.
        const label = (body as { label?: unknown } | null | undefined)?.label;
        if (typeof body !== "object" || body === null || (label != null && typeof label !== "string")) {
          return { status: 400, json: { ok: false, error: { code: "VALIDATION", message: "bad body" } } as never };
        }
        if (!fixtures.has(mint[1]!)) {
          return { status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "fixture not found" } } as never };
        }
        if (!grants(catalog, DEVICE_LINKS, billing.plan)) return refusal(DEVICE_LINKS);
        n += 1;
        return {
          status: 201,
          json: { ok: true, data: { id: `dl-row-${n}`, fixture_id: mint[1], label: null, secret: `dl_secret${n}` } } as never,
        };
      }

      if (/^\/api\/v1\/divisions\/[^/]+\/officials\/auto$/.test(path)) {
        return grants(catalog, "officials.auto", billing.plan)
          ? { status: 200, json: { ok: true, data: { assignments: [] } } as never }
          : refusal("officials.auto");
      }

      if (/^\/api\/v1\/fixtures\/[^/]+\/events$/.test(path)) {
        const { type, payload } = body as { type: string; payload: { target?: unknown; oversPerSide?: unknown } };
        if (type === "cricket.revise" && payload?.target === undefined && payload?.oversPerSide === undefined) {
          return {
            status: 422,
            json: { ok: false, error: { code: "INVALID_EVENT", message: "revise needs oversPerSide and/or target" } } as never,
          };
        }
        return { status: 201, json: { ok: true, data: { seq: 1 } } as never };
      }

      throw new Error(`fake server: unhandled raw ${method} ${path}`);
    },
  };
  return { transport, calls };
}

/** The brief's `fakeTransportRefusingThenAllowing()`: the live catalog, one
 *  known fixture, and an org on the free plan — so the mint route refuses
 *  until something moves `billing.plan`. */
function fakeTransportRefusingThenAllowing(catalog: Catalog = LIVE_CATALOG) {
  const billing: Billing = { plan: "community" };
  const fixtureId = "fx-seeded";
  const { transport, calls } = fakeServer(catalog, billing, [fixtureId]);
  return { transport, calls, billing, fixtureId };
}

function deviceLinkCalls(calls: readonly HttpCall[]): HttpCall[] {
  return calls.filter((c) => /\/device-links$/.test(c.path));
}

async function probe(catalog: Catalog) {
  const billing: Billing = { plan: "community" };
  const { sql, calls: sqlCalls } = fakeSql(catalog, billing);
  const { transport, calls: httpCalls } = fakeServer(catalog, billing);
  const result = await runDlsGateProbe({
    base: BASE,
    email: "delivered+bench-t11@resend.dev",
    runTag: "t11",
    sql,
    transport,
  });
  return { result, billing, sql, sqlCalls, httpCalls };
}

// ---------------------------------------------------------------------------
// provocableFeatureKeys — read off the catalog, never typed
// ---------------------------------------------------------------------------

describe("provocableFeatureKeys", () => {
  it("derives the device-link key from the live catalog rather than naming it", async () => {
    const keys = await provocableFeatureKeys(fakeCatalogSql());
    expect(keys).toContain("scoring.device_links");
  });

  it("a catalog that frees the key on the free plan drops it — and only it", async () => {
    const keys = await provocableFeatureKeys(
      fakeCatalogSql({ ...LIVE_CATALOG, [DEVICE_LINKS]: soldOnPro({ community: true }) }),
    );
    expect(keys).not.toContain(DEVICE_LINKS);
    // The positive pair: a function returning [] would pass the line above.
    expect(keys).toContain("officials.auto");
  });

  it("a key NO plan sells is not provocable either — there is nothing to refuse for", async () => {
    const keys = await provocableFeatureKeys(fakeCatalogSql({ ...LIVE_CATALOG, [DEVICE_LINKS]: [] }));
    expect(keys).not.toContain(DEVICE_LINKS);
    expect(keys).toContain("officials.auto");
  });
});

// ---------------------------------------------------------------------------
// proveDeviceLinkGate — refusal, flip, mint
// ---------------------------------------------------------------------------

describe("proveDeviceLinkGate", () => {
  it("proves the refusal before provisioning, and the mint after", async () => {
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing();
    let flips = 0;

    const result = await proveDeviceLinkGate({
      base: BASE,
      session: newSession(),
      transport,
      ids: { divisionId: "div-seeded", fixtureId },
      paywalledOnFreePlan: true,
      provision: async () => {
        flips += 1;
        billing.plan = "pro";
        return { plan: "pro", grantsDeviceLinks: true };
      },
    });

    expect(result.refusedStatus).toBe(402);
    expect(result.mintedAfterProvision).toBe(true);

    expect(result.cells.map((c) => [c.cell, c.ok])).toEqual([
      ["device_link_refused_before_plan", true],
      ["device_link_minted_after_plan", true],
    ]);
    expect(result.cells[0]!.featureKey).toBe(DEVICE_LINKS);

    // The ORDER is the proof. The refusal went out on the free plan, the mint
    // on the paid one, the flip ran exactly once between them — and both hit
    // the SAME real fixture with a schema-valid body.
    const links = deviceLinkCalls(calls);
    expect(links.map((c) => c.planAtCall)).toEqual(["community", "pro"]);
    expect(links.map((c) => c.path)).toEqual([
      `/api/v1/fixtures/${fixtureId}/device-links`,
      `/api/v1/fixtures/${fixtureId}/device-links`,
    ]);
    expect(links.map((c) => c.body)).toEqual([{}, {}]);
    expect(flips).toBe(1);
  });

  it("a plan that does not sell device links: the mint is never sent, and the cell FAILS rather than passing on a skipped mint", async () => {
    const catalog: Catalog = {
      ...LIVE_CATALOG,
      [DEVICE_LINKS]: [
        { plan_key: "community", bool_value: false },
        { plan_key: "enterprise", bool_value: true },
      ],
    };
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing(catalog);

    const result = await proveDeviceLinkGate({
      base: BASE,
      session: newSession(),
      transport,
      ids: { divisionId: "div-seeded", fixtureId },
      paywalledOnFreePlan: true,
      provision: async () => {
        billing.plan = "pro";
        return { plan: "pro", grantsDeviceLinks: false };
      },
    });

    expect(result.refusedStatus).toBe(402);
    expect(result.mintedAfterProvision).toBe(false);
    const minted = result.cells.find((c) => c.cell === "device_link_minted_after_plan");
    expect(minted, "the unsatisfied mint must be REPORTED as a cell, never dropped").toBeDefined();
    expect(minted!.ok).toBe(false);
    expect(minted!.status).toBeNull();
    expect(minted!.detail).toContain('"pro"');
    expect(minted!.detail).toContain(DEVICE_LINKS);
    // Only the refusal went out.
    expect(deviceLinkCalls(calls)).toHaveLength(1);
  });

  it("not paywalled on the free plan: nothing is sent, no cell is emitted, and the plan is still provisioned exactly once", async () => {
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing();
    let flips = 0;

    const result = await proveDeviceLinkGate({
      base: BASE,
      session: newSession(),
      transport,
      ids: { divisionId: "div-seeded", fixtureId },
      paywalledOnFreePlan: false,
      provision: async () => {
        flips += 1;
        billing.plan = "pro";
        return { plan: "pro", grantsDeviceLinks: true };
      },
    });

    expect(flips).toBe(1);
    expect(result.cells).toEqual([]);
    expect(result.refusedStatus).toBeNull();
    expect(result.mintedAfterProvision).toBe(false);
    expect(deviceLinkCalls(calls)).toHaveLength(0);
  });
});

describe("classifyDlsGateCell — minted_with_secret", () => {
  const MINTED = { kind: "minted_with_secret" } as const;
  const created = (status: number, data: unknown): RawResult => ({ status, json: { ok: true, data } as never });

  it("ok ONLY on a 201 carrying a non-empty secret", () => {
    expect(classifyDlsGateCell("device_link_minted_after_plan", MINTED, created(201, { secret: "dl_x" })).ok).toBe(true);
    expect(classifyDlsGateCell("device_link_minted_after_plan", MINTED, created(201, { secret: "" })).ok).toBe(false);
    expect(classifyDlsGateCell("device_link_minted_after_plan", MINTED, created(201, {})).ok).toBe(false);
    // The route replies 201 (`reply(201, ...)`); a 200 is some other handler.
    expect(classifyDlsGateCell("device_link_minted_after_plan", MINTED, created(200, { secret: "dl_x" })).ok).toBe(false);
  });

  it("never copies the secret into the detail — the report is not a place for a live scoring credential", () => {
    const out = classifyDlsGateCell("device_link_minted_after_plan", MINTED, created(201, { secret: "dl_live_token" }));
    expect(out.ok).toBe(true);
    expect(out.detail).not.toContain("dl_live_token");
  });

  it("a 402 after the flip says the plan did NOT clear the gate", () => {
    const out = classifyDlsGateCell("device_link_minted_after_plan", MINTED, refusal(DEVICE_LINKS));
    expect(out.ok).toBe(false);
    expect(out.featureKey).toBe(DEVICE_LINKS);
    expect(out.detail).toContain("still refused");
  });
});

// ---------------------------------------------------------------------------
// runDlsGateProbe — the device-link cells, driven through the real probe
// ---------------------------------------------------------------------------

describe("runDlsGateProbe — the device-link cells", () => {
  it("live catalog: refused before the plan flip, minted after, on the probe's own shape-refusal fixture", async () => {
    const { result, billing, sqlCalls, httpCalls } = await probe(LIVE_CATALOG);

    expect(result.cells.map((c) => c.cell)).toEqual([
      "revise_no_target_community",
      "revise_with_target_community",
      "revise_dls_off_community",
      "other_event_community",
      "gated_feature_refusal_names_its_key",
      "device_link_refused_before_plan",
      "device_link_minted_after_plan",
      "revise_no_target_after_plan",
    ]);
    expect(result.cells.filter((c) => !c.ok).map((c) => `${c.cell}: ${c.detail}`).join("\n")).toBe("");

    // officials.auto stays the "names its key" cell: the device-link cells sit
    // beside it rather than replacing it.
    expect(result.gatedFeatureProbed).toBe("officials.auto");
    expect(result.deviceLinkGateProbed).toBe(true);
    expect(result.deviceLinksGranted).toBe(true);
    expect(billing.plan).toBe("pro");

    const links = deviceLinkCalls(httpCalls);
    expect(links.map((c) => c.planAtCall)).toEqual(["community", "pro"]);
    // The fixture behind `revise_no_target_community` — the first event call.
    const shapeFixture = httpCalls.find((c) => /\/events$/.test(c.path))!.path.split("/")[4];
    expect(links.map((c) => c.path)).toEqual([
      `/api/v1/fixtures/${shapeFixture}/device-links`,
      `/api/v1/fixtures/${shapeFixture}/device-links`,
    ]);

    // One read of the device-link rows, shared by the paywall derivation and
    // the plan choice.
    expect(sqlCalls.filter((c) => c === `entitlementRows(${DEVICE_LINKS})`)).toHaveLength(1);
  });

  it("a catalog that frees device links on the free plan retires BOTH cells and says so — never a pass", async () => {
    const catalog: Catalog = { ...LIVE_CATALOG, [DEVICE_LINKS]: soldOnPro({ community: true }) };
    const { result, sql, httpCalls } = await probe(catalog);

    expect(await provocableFeatureKeys(sql)).not.toContain(DEVICE_LINKS);
    const names = result.cells.map((c) => c.cell);
    expect(names).not.toContain("device_link_refused_before_plan");
    expect(names).not.toContain("device_link_minted_after_plan");
    expect(result.deviceLinkGateProbed).toBe(false);
    expect(deviceLinkCalls(httpCalls)).toHaveLength(0);

    // Retired, not broken: the chosen plan still grants the key, and every
    // other cell still runs.
    expect(result.deviceLinksGranted).toBe(true);
    expect(result.cells).toHaveLength(6);
    expect(result.cells.every((c) => c.ok)).toBe(true);
  });

  it("no public plan sells device links: the refusal is still proven, the minted cell FAILS, deviceLinksGranted is false", async () => {
    const catalog: Catalog = {
      ...LIVE_CATALOG,
      [DEVICE_LINKS]: [
        { plan_key: "community", bool_value: false },
        { plan_key: "enterprise", bool_value: true },
      ],
    };
    const { result, httpCalls } = await probe(catalog);

    expect(result.provisionedPlan).toBe("pro");
    expect(result.unsatisfiedCapabilities).toEqual([DEVICE_LINKS]);
    expect(result.deviceLinksGranted).toBe(false);

    const byName = new Map(result.cells.map((c) => [c.cell, c] as const));
    expect(byName.get("device_link_refused_before_plan")?.ok).toBe(true);
    const minted = byName.get("device_link_minted_after_plan");
    expect(minted, "reported, never dropped").toBeDefined();
    expect(minted!.ok).toBe(false);
    expect(deviceLinkCalls(httpCalls)).toHaveLength(1);
  });

  it("the plan choice SELECTS for device links — a cheaper plan that lacks them loses to one that sells them", async () => {
    const plus = (rows: readonly PlanEntitlementRow[]): readonly PlanEntitlementRow[] => [
      ...rows,
      { plan_key: "zzz_scoring_plus", bool_value: true },
    ];
    const catalog: Catalog = {
      "cricket.dls": plus(soldOnPro({ community: true })),
      "officials.auto": plus(soldOnPro()),
      "stats.player": plus(soldOnPro()),
      "news.auto": plus(soldOnPro()),
      // `pro` is cheaper and sells every OTHER capability — so only a chooser
      // that asks about device links can land anywhere but `pro`.
      [DEVICE_LINKS]: [
        { plan_key: "community", bool_value: false },
        { plan_key: "pro", bool_value: false },
        { plan_key: "enterprise", bool_value: true },
        { plan_key: "zzz_scoring_plus", bool_value: true },
      ],
    };
    const { result, billing } = await probe(catalog);

    expect(result.provisionedPlan).toBe("zzz_scoring_plus");
    expect(billing.plan).toBe("zzz_scoring_plus");
    expect(result.unsatisfiedCapabilities).toEqual([]);
    expect(result.deviceLinksGranted).toBe(true);
    expect(result.cells.find((c) => c.cell === "device_link_minted_after_plan")?.ok).toBe(true);
  });
});
