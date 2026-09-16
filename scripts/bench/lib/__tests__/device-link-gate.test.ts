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
  type DeviceLinkGateInput,
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
  // Synthetic too: a PUBLIC plan that sells device links but fewer of the
  // other capabilities than `pro` — what a count-based chooser trades away.
  zzz_links_plus: { is_public: true, privilege: 30 },
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

interface ServerOptions {
  /** Answer every revoke with this instead of the route's own 200/404. */
  readonly revokeAnswer?: RawResult;
}

/** The links the fake minted and the ones a DELETE revoked, by id. */
interface LinkLedger {
  readonly minted: string[];
  readonly revoked: string[];
}

function fakeServer(
  catalog: Catalog,
  billing: Billing,
  seededFixtures: readonly string[] = [],
  serverOpts: ServerOptions = {},
): { transport: ProbeTransport; calls: HttpCall[]; links: LinkLedger } {
  const calls: HttpCall[] = [];
  const links: LinkLedger = { minted: [], revoked: [] };
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
        links.minted.push(`dl-row-${n}`);
        return {
          status: 201,
          json: { ok: true, data: { id: `dl-row-${n}`, fixture_id: mint[1], label: null, secret: `dl_secret${n}` } } as never,
        };
      }

      // The revoke route (api/v1/fixtures/[id]/device-links/[linkId]/route.ts):
      // DELETE, `revokeDeviceLink` 404s a link that is not on that fixture and
      // returns the row, which v1 wraps as a 200 `{ ok: true, data }`.
      const revoke = /^\/api\/v1\/fixtures\/([^/]+)\/device-links\/([^/]+)$/.exec(path);
      if (revoke && method === "DELETE") {
        if (serverOpts.revokeAnswer !== undefined) return serverOpts.revokeAnswer;
        if (!links.minted.includes(revoke[2]!)) {
          return { status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "device link not found" } } as never };
        }
        links.revoked.push(revoke[2]!);
        return {
          status: 200,
          json: { ok: true, data: { id: revoke[2], fixture_id: revoke[1], revoked_at: "2026-09-14T12:00:00Z" } } as never,
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
  return { transport, calls, links };
}

/** The brief's `fakeTransportRefusingThenAllowing()`: the live catalog, one
 *  known fixture, and an org on the free plan — so the mint route refuses
 *  until something moves `billing.plan`. */
function fakeTransportRefusingThenAllowing(catalog: Catalog = LIVE_CATALOG, serverOpts: ServerOptions = {}) {
  const billing: Billing = { plan: "community" };
  const fixtureId = "fx-seeded";
  const { transport, calls, links } = fakeServer(catalog, billing, [fixtureId], serverOpts);
  return { transport, calls, links, billing, fixtureId };
}

/** The mint POSTs only — a revoke's path carries the link id after `/device-links`. */
function deviceLinkCalls(calls: readonly HttpCall[]): HttpCall[] {
  return calls.filter((c) => /\/device-links$/.test(c.path));
}

function revokeCalls(calls: readonly HttpCall[]): HttpCall[] {
  return calls.filter((c) => c.method === "DELETE" && /\/device-links\/[^/]+$/.test(c.path));
}

/** Answer the i-th mint POST with `answers[i]` when one is given; every other
 *  call, and every mint with no scripted answer, goes to `inner`. */
function scriptMints(inner: ProbeTransport, answers: readonly (RawResult | undefined)[]): ProbeTransport {
  let mints = 0;
  return {
    ...inner,
    raw: async (base, s, path, method, body) => {
      if (method === "POST" && /\/device-links$/.test(path)) {
        const answer = answers[mints];
        mints += 1;
        if (answer !== undefined) return answer;
      }
      return inner.raw(base, s, path, method, body);
    },
  };
}

function v1Error(status: number, code: string, extra: Record<string, unknown> = {}): RawResult {
  return { status, json: { ok: false, error: { code, message: code.toLowerCase(), ...extra } } as never };
}

async function probe(catalog: Catalog) {
  const billing: Billing = { plan: "community" };
  const { sql, calls: sqlCalls } = fakeSql(catalog, billing);
  const { transport, calls: httpCalls, links } = fakeServer(catalog, billing);
  const result = await runDlsGateProbe({
    base: BASE,
    email: "delivered+bench-t11@resend.dev",
    runTag: "t11",
    sql,
    transport,
  });
  return { result, billing, sql, sqlCalls, httpCalls, links };
}

/** `proveDeviceLinkGate`'s input on the seeded fixture, in the live shape unless
 *  told otherwise: paywalled on the free plan, then `pro` provisioned (moving
 *  `billing`) and granting the key. */
function gateInput(
  transport: ProbeTransport,
  billing: Billing,
  fixtureId: string,
  over: Partial<Pick<DeviceLinkGateInput, "onFreePlan" | "publicPlansSelling">> & {
    readonly onProvision?: () => void;
  } = {},
): DeviceLinkGateInput {
  return {
    base: BASE,
    session: newSession(),
    transport,
    ids: { divisionId: "div-seeded", fixtureId },
    onFreePlan: over.onFreePlan ?? "paywalled",
    publicPlansSelling: over.publicPlansSelling ?? ["pro"],
    provision: async () => {
      over.onProvision?.();
      billing.plan = "pro";
      return { plan: "pro", grantsDeviceLinks: true };
    },
  };
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
      onFreePlan: "paywalled",
      publicPlansSelling: ["pro"],
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

  it("a plan that does not sell device links, and NO public plan does: the mint is never sent, and the cell FAILS rather than passing on a skipped mint", async () => {
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
      onFreePlan: "paywalled",
      // `enterprise` sells it, but is not public: no customer can buy it.
      publicPlansSelling: [],
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
    // The discriminating fact (R55 m1): nobody sells it publicly, so this is
    // a red and not a warning.
    expect(result.mintSkipped).toEqual({ plan: "pro", publicPlansSelling: [] });
    expect(result.warnings).toEqual([]);
  });

  it("a plan that does not sell device links, but a PUBLIC plan does: the chooser traded them away — no minted cell, no red, and a warning naming the plan that sells them", async () => {
    const catalog: Catalog = {
      ...LIVE_CATALOG,
      [DEVICE_LINKS]: [
        { plan_key: "community", bool_value: false },
        { plan_key: "pro", bool_value: false },
        { plan_key: "zzz_links_plus", bool_value: true },
      ],
    };
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing(catalog);

    const result = await proveDeviceLinkGate({
      base: BASE,
      session: newSession(),
      transport,
      ids: { divisionId: "div-seeded", fixtureId },
      onFreePlan: "paywalled",
      publicPlansSelling: ["zzz_links_plus"],
      provision: async () => {
        billing.plan = "pro";
        return { plan: "pro", grantsDeviceLinks: false };
      },
    });

    expect(result.mintSkipped).toEqual({ plan: "pro", publicPlansSelling: ["zzz_links_plus"] });
    // The refusal before the flip still stands on its own.
    expect(result.cells.map((c) => [c.cell, c.ok])).toEqual([["device_link_refused_before_plan", true]]);
    expect(result.warnings.filter((w) => w.includes('"zzz_links_plus"'))).toHaveLength(1);
    expect(result.mintedAfterProvision).toBe(false);
    expect(deviceLinkCalls(calls)).toHaveLength(1);
  });

  it("unsold (no plan grants it, not even the free one): nothing is sent, no cell is emitted, and the plan is still provisioned exactly once", async () => {
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing();
    let flips = 0;

    const result = await proveDeviceLinkGate({
      base: BASE,
      session: newSession(),
      transport,
      ids: { divisionId: "div-seeded", fixtureId },
      onFreePlan: "unsold",
      publicPlansSelling: [],
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

// ---------------------------------------------------------------------------
// n2 — the pre-flip mint goes through the SAME revoking wrapper as every
// other mint, even when the gate is open before the flip (an Event Pass, a
// catalog/code divergence, a stale entitlement cache). `mint()` wraps every
// call `proveDeviceLinkGate` makes, including the "before" one — this is the
// mirror of the "FAILS when the product refuses a mint the catalog says is
// free" case above (:569): there, the catalog says free and the probe is
// told paywalled; here the catalog ALREADY grants the key on `community` (a
// real 201, not a scripted one, so the fake server's own link ledger tracks
// it) while the probe is still told `onFreePlan: "paywalled"`.
// ---------------------------------------------------------------------------

describe("proveDeviceLinkGate — the pre-flip mint is revoked like any other (n2)", () => {
  it("a catalog that already grants the key before the flip answers the pre-flip mint 201 — the refusal cell reports it, and the link is still revoked through the wrapper", async () => {
    const catalog: Catalog = { ...LIVE_CATALOG, [DEVICE_LINKS]: soldOnPro({ community: true }) };
    const { transport, links, billing, fixtureId } = fakeTransportRefusingThenAllowing(catalog);

    const result = await proveDeviceLinkGate(gateInput(transport, billing, fixtureId, { onFreePlan: "paywalled" }));

    // The refusal cell correctly reports the mismatch: a 201 is not the
    // payment_refusal it expected, so it is NOT waved through as ok.
    const refused = result.cells[0]!;
    expect(refused.cell).toBe("device_link_refused_before_plan");
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(201);

    // Both mints (before AND after the flip) created a live scoring
    // credential, and `mint()`'s revoking wrapper — which every mint in this
    // function runs through, including the pre-flip one — must have cleaned
    // up both, not just the one after the flip.
    expect(links.minted.length).toBe(2);
    expect(links.revoked).toEqual(links.minted);
  });
});

// ---------------------------------------------------------------------------
// The refusal cell can FAIL — every pre-flip answer that is not the paywall
// ---------------------------------------------------------------------------

describe("proveDeviceLinkGate — the refusal cell FAILS on anything but a 402 naming scoring.device_links", () => {
  it("a 404: the probe's fixture does not exist, so the route refused before the gate was ever reached", async () => {
    const billing: Billing = { plan: "community" };
    // Nothing seeded: the fake's own route order 404s ahead of its gate.
    const { transport, calls } = fakeServer(LIVE_CATALOG, billing, []);

    const result = await proveDeviceLinkGate(gateInput(transport, billing, "fx-never-seeded"));

    const refused = result.cells[0]!;
    expect(refused.cell).toBe("device_link_refused_before_plan");
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("status 404");
    expect(result.refusedStatus).toBe(404);
    // It really was SENT, on the free plan — the 404 is an answer, not a skip.
    expect(deviceLinkCalls(calls)[0]!.planAtCall).toBe("community");
  });

  const WRONG_REFUSALS: readonly { readonly name: string; readonly answer: RawResult }[] = [
    { name: "a 402 naming a DIFFERENT feature key", answer: refusal("officials.auto") },
    { name: "a 403 (a session that is not an editor)", answer: v1Error(403, "FORBIDDEN") },
    { name: "a 429 (the mint route's rate limit, 10 a minute per IP)", answer: v1Error(429, "RATE_LIMITED") },
  ];

  it.each(WRONG_REFUSALS)("$name", async ({ answer }) => {
    const { transport, billing, fixtureId } = fakeTransportRefusingThenAllowing();

    const result = await proveDeviceLinkGate(gateInput(scriptMints(transport, [answer]), billing, fixtureId));

    const refused = result.cells[0]!;
    expect(refused.cell).toBe("device_link_refused_before_plan");
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain(`status ${answer.status}`);
    expect(result.refusedStatus).toBe(answer.status);
    // Only the refusal was wrong: the mint after the flip still went through.
    expect(result.cells[1]).toMatchObject({ cell: "device_link_minted_after_plan", ok: true });
  });
});

// ---------------------------------------------------------------------------
// Device links FREE on the free plan — the mint is still the product witnessed
// ---------------------------------------------------------------------------

describe("proveDeviceLinkGate — free on the free plan: the mint is still sent, before the flip, and must succeed", () => {
  const FREED: Catalog = { ...LIVE_CATALOG, [DEVICE_LINKS]: soldOnPro({ community: true }) };

  it("mints on the free plan BEFORE provisioning, requires a 201 with a secret, and emits no refusal pair", async () => {
    const { transport, calls, links, billing, fixtureId } = fakeTransportRefusingThenAllowing(FREED);
    let flips = 0;

    const result = await proveDeviceLinkGate(
      gateInput(transport, billing, fixtureId, {
        onFreePlan: "free",
        publicPlansSelling: ["community", "pro"],
        onProvision: () => {
          flips += 1;
        },
      }),
    );

    expect(result.cells.map((c) => [c.cell, c.ok, c.status])).toEqual([["device_link_minted_on_free_plan", true, 201]]);
    expect(deviceLinkCalls(calls).map((c) => c.planAtCall)).toEqual(["community"]);
    expect(flips).toBe(1);
    expect(result.refusedStatus).toBeNull();
    expect(result.mintedAfterProvision).toBe(false);
    // Nothing was provisioned before this mint, so its verdict must not say
    // provisioning cleared anything.
    expect(result.cells[0]!.detail).not.toContain("provisioning");
    // And what it minted, it revoked.
    expect(links.minted).toHaveLength(1);
    expect(links.revoked).toEqual(links.minted);
  });

  it("FAILS when the product refuses a mint the catalog says is free", async () => {
    // The probe is told the key is free; the server still gates it on community.
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing(LIVE_CATALOG);

    const result = await proveDeviceLinkGate(
      gateInput(transport, billing, fixtureId, { onFreePlan: "free", publicPlansSelling: ["pro"] }),
    );

    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toMatchObject({ cell: "device_link_minted_on_free_plan", ok: false, status: 402 });
    expect(deviceLinkCalls(calls).map((c) => c.planAtCall)).toEqual(["community"]);
  });
});

// ---------------------------------------------------------------------------
// Every link the probe mints, it revokes — and a failed revoke only warns
// ---------------------------------------------------------------------------

describe("proveDeviceLinkGate — every link it mints, it revokes", () => {
  it("revokes the link the 201 named, by DELETE on that link's own route, after the mint", async () => {
    const { transport, calls, links, billing, fixtureId } = fakeTransportRefusingThenAllowing();

    const result = await proveDeviceLinkGate(gateInput(transport, billing, fixtureId));

    expect(result.cells.map((c) => [c.cell, c.ok])).toEqual([
      ["device_link_refused_before_plan", true],
      ["device_link_minted_after_plan", true],
    ]);
    // One link minted (the refusal created none), and exactly that one revoked.
    expect(links.minted).toHaveLength(1);
    expect(links.revoked).toEqual(links.minted);
    const revokes = revokeCalls(calls);
    expect(revokes.map((c) => c.path)).toEqual([`/api/v1/fixtures/${fixtureId}/device-links/${links.minted[0]}`]);
    expect(calls.indexOf(revokes[0]!)).toBeGreaterThan(calls.indexOf(deviceLinkCalls(calls)[1]!));
    expect(result.warnings).toEqual([]);
  });

  const FAILED_REVOKES: readonly { readonly name: string; readonly answer: RawResult }[] = [
    { name: "a 404 (no such link on that fixture)", answer: v1Error(404, "NOT_FOUND") },
    { name: "a 500", answer: v1Error(500, "INTERNAL") },
  ];

  it.each(FAILED_REVOKES)("a revoke answering $name is a WARNING — never a failed cell, never the secret", async ({ answer }) => {
    const { transport, calls, links, billing, fixtureId } = fakeTransportRefusingThenAllowing(LIVE_CATALOG, {
      revokeAnswer: answer,
    });

    const result = await proveDeviceLinkGate(gateInput(transport, billing, fixtureId));

    expect(result.cells.map((c) => [c.cell, c.ok])).toEqual([
      ["device_link_refused_before_plan", true],
      ["device_link_minted_after_plan", true],
    ]);
    expect(revokeCalls(calls)).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`status ${answer.status}`);
    expect(result.warnings[0]).toContain(links.minted[0]!);
    expect(result.warnings.join("\n")).not.toContain("dl_secret");
  });

  it("a 201 that names no link id cannot be revoked: a WARNING, no DELETE sent, and never the secret", async () => {
    const { transport, calls, billing, fixtureId } = fakeTransportRefusingThenAllowing();
    const noId: RawResult = { status: 201, json: { ok: true, data: { secret: "dl_secret_without_an_id" } } as never };

    const result = await proveDeviceLinkGate(gateInput(scriptMints(transport, [undefined, noId]), billing, fixtureId));

    expect(result.cells[1]).toMatchObject({ cell: "device_link_minted_after_plan", ok: true });
    expect(revokeCalls(calls)).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join("\n")).not.toContain("dl_secret_without_an_id");
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
    const { result, billing, sqlCalls, httpCalls, links: ledger } = await probe(LIVE_CATALOG);

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

    // The link the probe minted does not outlive the probe.
    expect(ledger.minted).toHaveLength(1);
    expect(ledger.revoked).toEqual(ledger.minted);
    expect(result.deviceLinkWarnings).toEqual([]);
  });

  it("a catalog that frees device links on the free plan retires the paywall pair and says so — and still witnesses the mint, on the free plan", async () => {
    const catalog: Catalog = { ...LIVE_CATALOG, [DEVICE_LINKS]: soldOnPro({ community: true }) };
    const { result, sql, httpCalls, links } = await probe(catalog);

    expect(await provocableFeatureKeys(sql)).not.toContain(DEVICE_LINKS);
    const names = result.cells.map((c) => c.cell);
    expect(names).not.toContain("device_link_refused_before_plan");
    expect(names).not.toContain("device_link_minted_after_plan");
    expect(result.deviceLinkGateProbed).toBe(false);

    // The mint is the product being witnessed either way: one POST, sent on
    // the free plan, a 201, and revoked.
    expect(result.cells.find((c) => c.cell === "device_link_minted_on_free_plan")).toMatchObject({ ok: true, status: 201 });
    expect(deviceLinkCalls(httpCalls).map((c) => c.planAtCall)).toEqual(["community"]);
    expect(links.minted).toHaveLength(1);
    expect(links.revoked).toEqual(links.minted);

    // Retired, not broken: the chosen plan still grants the key, and every
    // other cell still runs.
    expect(result.deviceLinksGranted).toBe(true);
    expect(result.cells).toHaveLength(7);
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
    // `enterprise` sells it but is not public, so nothing is downgraded to a
    // warning: no customer can buy device links on this catalog.
    expect(result.deviceLinkWarnings).toEqual([]);
  });

  it("a PUBLIC plan sells device links but the chooser traded them for other capabilities: the refusal still stands, no minted cell, no red, and a warning names the public seller", async () => {
    // A public plan sells cricket.dls, officials.auto and device links; `pro`
    // sells cricket.dls and the other three but not device links. The
    // count-based chooser lands on `pro` (three desired capabilities to two).
    const catalog: Catalog = {
      "cricket.dls": [...soldOnPro({ community: true }), { plan_key: "zzz_links_plus", bool_value: true }],
      "officials.auto": [...soldOnPro(), { plan_key: "zzz_links_plus", bool_value: true }],
      "stats.player": soldOnPro(),
      "news.auto": soldOnPro(),
      [DEVICE_LINKS]: [
        { plan_key: "community", bool_value: false },
        { plan_key: "pro", bool_value: false },
        { plan_key: "enterprise", bool_value: true },
        { plan_key: "zzz_links_plus", bool_value: true },
      ],
    };
    const { result, httpCalls } = await probe(catalog);

    expect(result.provisionedPlan).toBe("pro");
    expect(result.deviceLinksGranted).toBe(false);
    const names = result.cells.map((c) => c.cell);
    expect(names).toContain("device_link_refused_before_plan");
    expect(names).not.toContain("device_link_minted_after_plan");
    expect(result.cells.filter((c) => !c.ok).map((c) => c.cell)).toEqual([]);
    // Named: the plan a customer can buy. Not named: the one they cannot.
    expect(result.deviceLinkWarnings.filter((w) => w.includes('"zzz_links_plus"'))).toHaveLength(1);
    expect(result.deviceLinkWarnings.join("\n")).not.toContain('"enterprise"');
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

  // n3 — `candidatePlanKeys` (dls-gate.ts:960-962) is a union over FIVE rows,
  // `deviceLinkRows` among them. The test above (`zzz_links_plus`, "the
  // chooser traded them away") also grants that plan `cricket.dls` and
  // `officials.auto`, so it does not isolate the `deviceLinkRows` member's
  // own contribution — dropping it from the union would still leave
  // `zzz_links_plus` reachable through the other four rows, and would not be
  // caught. Here `zzz_links_plus` has NO row at all in the other four
  // catalog entries, so it can only ever reach `candidates` (and therefore
  // `publicPlansSelling`) through `deviceLinkRows` itself.
  it("n3: a plan visible ONLY via its device-link row still becomes a named public seller — isolating deviceLinkRows' own contribution to candidatePlanKeys", async () => {
    const catalog: Catalog = {
      "cricket.dls": soldOnPro({ community: true }),
      "officials.auto": soldOnPro(),
      "stats.player": soldOnPro(),
      "news.auto": soldOnPro(),
      [DEVICE_LINKS]: [
        { plan_key: "community", bool_value: false },
        { plan_key: "pro", bool_value: false },
        { plan_key: "zzz_links_plus", bool_value: true },
      ],
    };
    const { result, httpCalls } = await probe(catalog);

    expect(result.provisionedPlan).toBe("pro");
    expect(result.deviceLinksGranted).toBe(false);
    // Named: the plan a customer can buy — reachable only via deviceLinkRows.
    expect(result.deviceLinkWarnings.filter((w) => w.includes('"zzz_links_plus"'))).toHaveLength(1);
    expect(result.cells.filter((c) => !c.ok)).toEqual([]);
    expect(result.cells.map((c) => c.cell)).not.toContain("device_link_minted_after_plan");
    expect(deviceLinkCalls(httpCalls)).toHaveLength(1);
  });
});
