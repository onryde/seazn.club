// DB-free unit coverage for lib/dls-gate.ts — the classifyDlsGateCell pure
// verdict function, plus the full runDlsGateProbe HTTP orchestration driven
// through a fake ProbeTransport (signIn/request/raw) and a fake PlanSql.
// No live Postgres or server anywhere in this file — same DI shape as
// lib/__tests__/seed.test.ts uses for seedSuite itself.
import { describe, expect, it } from "vitest";
import type { RawResult } from "../http.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { classifyDlsGateCell, runDlsGateProbe, type ProbeTransport } from "../dls-gate.ts";

// ---------------------------------------------------------------------------
// classifyDlsGateCell — pure
// ---------------------------------------------------------------------------

function v1Error(status: number, code: string, extra: Record<string, unknown> = {}): RawResult {
  return { status, json: { ok: false, error: { code, message: "nope", ...extra } } as never };
}
function v1Ok(status = 201): RawResult {
  return { status, json: { ok: true, data: { seq: 1 } } as never };
}

describe("classifyDlsGateCell — an accepted cell must have REACHED the gate", () => {
  const accepted = (status: number) =>
    classifyDlsGateCell("dlsOnManualTarget", false, { status, json: { ok: true, data: {} } } as never);

  it("passes on an engine-level rejection — assertEntitledToScore runs BEFORE the fold", () => {
    // 422 from the engine means the entitlement door was already passed, which
    // is exactly why these cells can assert something weaker than 201.
    expect(accepted(422).ok).toBe(true);
    expect(accepted(400).ok).toBe(true);
    expect(accepted(201).ok).toBe(true);
  });

  it("FAILS on 401/403/404 — those come from guards that run before the gate", () => {
    // Without this the probe reports green having never reached the thing it
    // exists to test: a broken setup (wrong actor, absent fixture) refuses
    // early, and "not 402" was satisfied by that refusal.
    for (const status of [401, 403, 404]) {
      const outcome = accepted(status);
      expect(outcome.ok, `status ${status} must not count as a cleared gate`).toBe(false);
      expect(outcome.detail).toContain("never reached the gate");
    }
  });

  it("still fails a 402, and says so differently from a never-reached status", () => {
    const paid = classifyDlsGateCell("dlsOnManualTarget", false, {
      status: 402,
      json: { ok: false, error: { code: "PAYMENT_REQUIRED", feature_key: "cricket.dls" } },
    } as never);
    expect(paid.ok).toBe(false);
    expect(paid.detail).toContain("should NOT have blocked");
    expect(paid.detail).not.toContain("never reached the gate");
  });
});

describe("classifyDlsGateCell — the refused cell", () => {
  it("ok when the refusal is EXACTLY 402/PAYMENT_REQUIRED/cricket.dls", () => {
    const out = classifyDlsGateCell(
      "revise_no_target_unentitled",
      true,
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "cricket.dls" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe(402);
    expect(out.featureKey).toBe("cricket.dls");
  });

  it("NOT ok when the status is 402 but the feature_key names something else — pins WHAT gated it, not just that something did", () => {
    const out = classifyDlsGateCell(
      "revise_no_target_unentitled",
      true,
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "some.other.feature" }),
    );
    expect(out.ok).toBe(false);
  });

  it("NOT ok when the request was accepted (no refusal at all)", () => {
    const out = classifyDlsGateCell("revise_no_target_unentitled", true, v1Ok(422));
    expect(out.ok).toBe(false);
  });

  it("NOT ok on a 402 with the right code but NO feature_key at all", () => {
    const out = classifyDlsGateCell("revise_no_target_unentitled", true, v1Error(402, "PAYMENT_REQUIRED"));
    expect(out.ok).toBe(false);
  });
});

describe("classifyDlsGateCell — the accepted cells", () => {
  it("ok on any non-402 status — the gate proof is 'not blocked for payment', never a business-valid 201 (see dls-gate.ts header)", () => {
    expect(classifyDlsGateCell("other_event_unentitled", false, v1Ok(201)).ok).toBe(true);
    expect(classifyDlsGateCell("other_event_unentitled", false, v1Error(422, "WRONG_PHASE")).ok).toBe(true);
  });

  it("NOT ok on a 402 naming cricket.dls — the gate should never have fired here", () => {
    const out = classifyDlsGateCell(
      "revise_with_target_unentitled",
      false,
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "cricket.dls" }),
    );
    expect(out.ok).toBe(false);
  });

  it("NOT ok on a 402 naming a DIFFERENT feature either — any payment refusal fails an 'accepted' cell", () => {
    const out = classifyDlsGateCell(
      "revise_with_target_unentitled",
      false,
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "scoring.something" }),
    );
    expect(out.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDlsGateProbe — orchestration over a fake ProbeTransport + PlanSql
// ---------------------------------------------------------------------------

interface RecordedHttpCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function fakePlanSql(overrides: Partial<PlanSql> = {}): { sql: PlanSql; calls: string[] } {
  const calls: string[] = [];
  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      calls.push(`entitlementRows(${featureKey})`);
      // The REAL live catalog the B03 review quoted: cricket.dls is granted
      // by BOTH pro and pro_plus; officials.auto is granted ONLY by
      // pro_plus. `chooseGrantingPlanForCapabilities` must land on
      // "pro_plus" — the one plan that grants everything this probe wants —
      // never "pro" (the old single-feature choice's answer, which does not
      // grant officials.auto).
      if (featureKey === "cricket.dls") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
          { plan_key: "pro_plus", bool_value: true },
        ];
      }
      if (featureKey === "officials.auto") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: false },
          { plan_key: "pro_plus", bool_value: true },
        ] as PlanEntitlementRow[];
      }
      return [];
    },
    async getOrgSubscriptionId() {
      calls.push("getOrgSubscriptionId");
      return null;
    },
    async updateSubscriptionPlan(subscriptionId, plan) {
      calls.push(`updateSubscriptionPlan(${subscriptionId},${plan})`);
    },
    async createSubscriptionForOrg(orgId, plan) {
      calls.push(`createSubscriptionForOrg(${orgId},${plan})`);
      return "sub-new";
    },
    async setOwnerStaff(orgId, on) {
      calls.push(`setOwnerStaff(${orgId},${on})`);
    },
    async setDivisionActive(divisionId) {
      calls.push(`setDivisionActive(${divisionId})`);
    },
    ...overrides,
  };
  return { sql, calls };
}

/** A minimal but faithful fake of the real API surface `runDlsGateProbe`
 *  drives: two cricket divisions (3-fixture / 1-fixture leagues), and the
 *  five event probes keyed on WHICH fixture + WHETHER the org has been
 *  provisioned yet (`entitled`, flipped by the fake admin-override POST —
 *  same "the write actually changes the next read" shape a real cache-bust
 *  proves, just modelled in-memory rather than over Redis). */
function fakeServer(): { transport: ProbeTransport; calls: RecordedHttpCall[] } {
  const calls: RecordedHttpCall[] = [];
  let entitled = false;
  let divisionCounter = 0;
  let fixtureCounter = 0;
  const dlsByDivision = new Map<string, boolean>();
  const fixturesByDivision = new Map<string, string[]>();
  const fixtureDivision = new Map<string, string>();
  const legsByStage = new Map<string, { divisionId: string; legs: number }>();
  let stageCounter = 0;
  const appended = new Set<string>(); // fixtures a "successful" write has touched

  const transport: ProbeTransport = {
    signIn: async () => ({ has_org: true, org_id: "org-probe", redirect: "/" }),
    request: async (_base, _s, path, opts) => {
      const method = opts?.method ?? "GET";
      calls.push({ method, path, body: opts?.body });
      if (method === "POST" && path === "/api/v1/competitions") {
        return { id: "comp-probe" } as never;
      }
      if (method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(path)) {
        const body = opts?.body as { config: { dls: { enabled: boolean } } };
        const id = `div-${++divisionCounter}`;
        dlsByDivision.set(id, body.config.dls.enabled);
        fixturesByDivision.set(id, []);
        return { id } as never;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/entrants$/.test(path)) {
        return [{ id: "ent-1" }, { id: "ent-2" }] as never;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/([^/]+)\/stages$/.test(path)) {
        const divisionId = path.split("/")[4]!;
        const body = opts?.body as { config: { legs: number } }[];
        const stageId = `stage-${++stageCounter}`;
        legsByStage.set(stageId, { divisionId, legs: body[0]!.config.legs });
        return [{ id: stageId }] as never;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/generate$/.test(path)) {
        const stageId = path.split("/")[4]!;
        const { divisionId, legs } = legsByStage.get(stageId)!;
        const fixtures = Array.from({ length: legs }, () => {
          const id = `fx-${++fixtureCounter}`;
          fixtureDivision.set(id, divisionId);
          return { id };
        });
        fixturesByDivision.set(divisionId, fixtures.map((f) => f.id));
        return { fixtures } as never;
      }
      if (method === "POST" && path === "/api/admin/orgs/org-probe/entitlement-override") {
        entitled = true;
        return { ok: true } as never;
      }
      if (method === "DELETE" && path === "/api/admin/orgs/org-probe/entitlement-override") {
        return { ok: true } as never;
      }
      throw new Error(`fake server: unhandled request ${method} ${path}`);
    },
    raw: async (_base, _s, path, method = "GET", body) => {
      calls.push({ method, path, body });
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const fixtureId = m[1]!;
      const divisionId = fixtureDivision.get(fixtureId)!;
      const dlsEnabled = dlsByDivision.get(divisionId) === true;
      const { type, payload } = body as { type: string; payload: { target?: unknown } };
      const manualTarget = payload?.target !== undefined;
      const requiresDls = type === "cricket.revise" && dlsEnabled && !manualTarget;
      if (requiresDls && !entitled) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "cricket.dls" } },
        } as never;
      }
      appended.add(fixtureId);
      return { status: 201, json: { ok: true, data: { seq: 1 } } } as never;
    },
  };
  return { transport, calls };
}

describe("runDlsGateProbe", () => {
  it("drives all 5 cells, chooses a plan granting EVERY capability this probe needs, and derives officialsAutoGranted from IT", async () => {
    const { sql, calls: sqlCalls } = fakePlanSql();
    const { transport, calls: httpCalls } = fakeServer();

    const result = await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7",
      sql,
      transport,
    });

    expect(result.cells.map((c) => c.cell)).toEqual([
      "revise_no_target_unentitled",
      "revise_with_target_unentitled",
      "revise_dls_off_unentitled",
      "other_event_unentitled",
      "revise_no_target_entitled",
    ]);
    // The unentitled cell 1 is refused; every other cell (including the
    // replay after provisioning) is not.
    expect(result.cells.map((c) => c.ok)).toEqual([true, true, true, true, true]);
    expect(result.cells[0]!.status).toBe(402);
    expect(result.cells[4]!.status).toBe(201);

    // B03 review F1(a): the fake's rows (both `pro` and `pro_plus` grant
    // cricket.dls; only `pro_plus` grants officials.auto) are the REAL live
    // catalog shape quoted in the review. The OLD single-feature choice
    // (`chooseGrantingPlan` on cricket.dls rows alone) landed on "pro" — the
    // lexicographically-first cricket.dls grantor — and never even looked at
    // officials.auto until after provisioning it, by which point the wrong
    // plan was already chosen. `chooseGrantingPlanForCapabilities` must land
    // on "pro_plus" instead: the one plan that grants EVERYTHING this probe
    // asked for.
    expect(result.provisionedPlan).toBe("pro_plus");
    expect(result.officialsAutoGranted).toBe(true);
    expect(result.unsatisfiedCapabilities).toEqual([]);

    // The plan derivation queried BOTH feature keys BEFORE provisioning
    // anything, and provisioned via the seam, never a hardcoded plan string.
    expect(sqlCalls).toContain("entitlementRows(cricket.dls)");
    expect(sqlCalls).toContain("entitlementRows(officials.auto)");
    expect(sqlCalls.indexOf("entitlementRows(officials.auto)")).toBeLessThan(
      sqlCalls.findIndex((c) => c.startsWith("updateSubscriptionPlan") || c.startsWith("createSubscriptionForOrg")),
    );
    expect(sqlCalls.some((c) => c.includes("pro_plus"))).toBe(true);

    // One fixture per "must not be refused" cell — never a shared one (see
    // dls-gate.ts header comment). 3 fixtures on the dls-on division + 1 on
    // dls-off = 4 distinct fixture ids across the 5 event calls (cell 1 and
    // its replay share ONE).
    const eventCalls = httpCalls.filter((c) => /\/events$/.test(c.path));
    expect(eventCalls).toHaveLength(5);
    const fixtureIds = eventCalls.map((c) => c.path);
    expect(new Set(fixtureIds).size).toBe(4);
  });

  it("no single plan grants BOTH capabilities: still provisions the required one (cricket.dls) and REPORTS the gap, never silently drops it", async () => {
    // A catalog where the two features have NO plan in common — cricket.dls
    // only "pro", officials.auto only "pro_plus". A legitimate outcome (B03
    // review F1(a)'s fix text: "must be reported honestly ... not silently
    // downgraded"), not a bug in the chooser.
    const { sql } = fakePlanSql({
      async entitlementRows(featureKey) {
        if (featureKey === "cricket.dls") {
          return [
            { plan_key: "community", bool_value: false },
            { plan_key: "pro", bool_value: true },
          ];
        }
        if (featureKey === "officials.auto") {
          return [
            { plan_key: "community", bool_value: false },
            { plan_key: "pro_plus", bool_value: true },
          ];
        }
        return [];
      },
    });
    const { transport } = fakeServer();

    const result = await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7b",
      sql,
      transport,
    });

    // cricket.dls is REQUIRED — the probe cannot function without a plan
    // granting it — so "pro" is still chosen even though it grants nothing
    // else this probe wanted.
    expect(result.provisionedPlan).toBe("pro");
    expect(result.officialsAutoGranted).toBe(false);
    expect(result.unsatisfiedCapabilities).toEqual(["officials.auto"]);
  });

  it("force-activates BOTH divisions via the SQL seam before probing — a division left in setup would WRONG_PHASE every cell", async () => {
    const { sql, calls: sqlCalls } = fakePlanSql();
    const { transport } = fakeServer();

    await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7c",
      sql,
      transport,
    });

    expect(sqlCalls.filter((c) => c.startsWith("setDivisionActive"))).toHaveLength(2);
  });
});
