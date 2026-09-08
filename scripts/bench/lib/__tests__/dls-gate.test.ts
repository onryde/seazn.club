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

const NOT_PAID = { kind: "not_payment_refused" } as const;
const SHAPE_REFUSAL = { kind: "engine_rejection", status: 422, code: "INVALID_EVENT" } as const;

describe("classifyDlsGateCell — a not_payment_refused cell must have REACHED the gate", () => {
  const accepted = (status: number) =>
    classifyDlsGateCell("revise_with_target_community", NOT_PAID, { status, json: { ok: true, data: {} } } as never);

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
    const paid = classifyDlsGateCell("revise_with_target_community", NOT_PAID, {
      status: 402,
      json: { ok: false, error: { code: "PAYMENT_REQUIRED", feature_key: "cricket.dls" } },
    } as never);
    expect(paid.ok).toBe(false);
    expect(paid.detail).toContain("should NOT have blocked");
    expect(paid.detail).not.toContain("never reached the gate");
  });
});

// ---------------------------------------------------------------------------
// engine_rejection — the FREEDOM assertion. Scoring is free (owner ruling;
// V390__scoring_free.sql, V393:63-70 puts cricket.dls on community), so the
// empty-payload cell must reach the ENGINE and be refused on SHAPE. Reaching
// an engine-raised code at all is only possible past the entitlement door.
// ---------------------------------------------------------------------------

describe("classifyDlsGateCell — the freedom cell (engine_rejection)", () => {
  it("ok on EXACTLY the engine's own 422 INVALID_EVENT", () => {
    const out = classifyDlsGateCell("revise_no_target_community", SHAPE_REFUSAL, v1Error(422, "INVALID_EVENT"));
    expect(out.ok).toBe(true);
    expect(out.status).toBe(422);
    expect(out.detail).toContain("reached the ENGINE");
  });

  it("NOT ok on a 422 carrying a DIFFERENT code — WRONG_PHASE is also 422 and proves nothing about the door", () => {
    // The status alone is satisfied by a division left in `setup`
    // (scoring.ts's phase guard), which refuses BEFORE the payload is ever
    // parsed. Pinning the code is what makes this cell a freedom proof rather
    // than a coincidence of numbers.
    const out = classifyDlsGateCell("revise_no_target_community", SHAPE_REFUSAL, v1Error(422, "WRONG_PHASE"));
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("INVALID_EVENT");
  });

  it("NOT ok on a 402 — and says the paywall is the DEFECT, not the expectation", () => {
    // The regression this cell exists for: someone re-gates scoring. The
    // detail must send the next reader at the product, never at this test.
    const out = classifyDlsGateCell(
      "revise_no_target_community",
      SHAPE_REFUSAL,
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "cricket.dls" }),
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("scoring is FREE");
    expect(out.detail).toContain("never this expectation");
  });

  it("NOT ok on 401/403/404 — a cell that never reached the gate cannot witness freedom either", () => {
    for (const status of [401, 403, 404]) {
      const out = classifyDlsGateCell("revise_no_target_community", SHAPE_REFUSAL, v1Error(status, "FORBIDDEN"));
      expect(out.ok, `status ${status}`).toBe(false);
      expect(out.detail).toContain("never reached the gate");
    }
  });

  it("NOT ok on a 201 either — an engine that ACCEPTS a payload it should refuse on shape is its own regression", () => {
    expect(classifyDlsGateCell("revise_no_target_community", SHAPE_REFUSAL, v1Ok(201)).ok).toBe(false);
  });
});

describe("classifyDlsGateCell — the paywall cell (payment_refusal)", () => {
  it("ok when the refusal is EXACTLY 402/PAYMENT_REQUIRED/the expected key", () => {
    const out = classifyDlsGateCell(
      "gated_feature_refusal_names_its_key",
      { kind: "payment_refusal", featureKey: "officials.auto" },
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "officials.auto" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe(402);
    expect(out.featureKey).toBe("officials.auto");
  });

  it("NOT ok when the status is 402 but the feature_key names something else — pins WHAT gated it, not just that something did", () => {
    const out = classifyDlsGateCell(
      "gated_feature_refusal_names_its_key",
      { kind: "payment_refusal", featureKey: "officials.auto" },
      v1Error(402, "PAYMENT_REQUIRED", { feature_key: "some.other.feature" }),
    );
    expect(out.ok).toBe(false);
  });

  it("the expected key comes from the EXPECTATION, never a constant — the same response passes for one key and fails for another", () => {
    // The whole point of re-pointing this cell: which key is gated is derived
    // from the live matrix at call time. A classifier with "cricket.dls"
    // baked in would have to be edited every time the price list moves.
    const response = v1Error(402, "PAYMENT_REQUIRED", { feature_key: "officials.auto" });
    expect(classifyDlsGateCell("gated_feature_refusal_names_its_key", { kind: "payment_refusal", featureKey: "officials.auto" }, response).ok).toBe(true);
    expect(classifyDlsGateCell("gated_feature_refusal_names_its_key", { kind: "payment_refusal", featureKey: "cricket.dls" }, response).ok).toBe(false);
  });

  it("NOT ok when the request was accepted (no refusal at all)", () => {
    const out = classifyDlsGateCell(
      "gated_feature_refusal_names_its_key",
      { kind: "payment_refusal", featureKey: "officials.auto" },
      v1Ok(200),
    );
    expect(out.ok).toBe(false);
  });

  it("NOT ok on a 402 with the right code but NO feature_key at all", () => {
    const out = classifyDlsGateCell(
      "gated_feature_refusal_names_its_key",
      { kind: "payment_refusal", featureKey: "officials.auto" },
      v1Error(402, "PAYMENT_REQUIRED"),
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

/** The org's live billing state, SHARED between the fake `PlanSql` (which
 *  writes it, as `provisionPlan` does) and `fakeServer` (which resolves
 *  entitlements against it, as the product does). One box, two fakes: the
 *  paywall cell can then only pass if the probe drove it while the org was
 *  still on the free plan. A fake that hardcoded a 402 on that route would
 *  pass even if the probe provisioned first, which is the exact ordering
 *  mistake that would make the cell green here and red live. */
interface FakeOrgBilling {
  plan: string;
}
function freshOrgBilling(): FakeOrgBilling {
  return { plan: "community" };
}

function fakePlanSql(
  overrides: Partial<PlanSql> = {},
  billing: FakeOrgBilling = freshOrgBilling(),
): { sql: PlanSql; calls: string[] } {
  const calls: string[] = [];
  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      calls.push(`entitlementRows(${featureKey})`);
      // The REAL live catalog. `pro_plus` was retired into a new `enterprise`
      // plan (is_public = false, "Never self-serve" — V393:25-26) seeded by
      // copying every pro_plus row, and `pro` itself picked up officials.auto
      // in the same migration (step 3). `chooseGrantingPlanForCapabilities`
      // must land on "pro" — the only PUBLIC plan granting all three — never
      // on "enterprise", which is both more privileged AND sorts first
      // alphabetically.
      if (featureKey === "cricket.dls" || featureKey === "officials.auto" || featureKey === "stats.player") {
        return [
          // B05: `community` GRANTS `cricket.dls` and nothing else here —
          // V393__entitlements_v18.sql:63-70, "charge for leverage, never
          // correctness". Modelling that faithfully is load-bearing three
          // times: it is why no plan choice can produce a DLS-unentitled org,
          // it is what makes `officials.auto` (not `cricket.dls`) the key the
          // paywall cell derives, and it puts a public privilege-0 plan that
          // satisfies ONLY the primary capability at the head of
          // `publicGrantorsLeastPrivilegedFirst` — so a chooser that stopped
          // at the first ranked grantor would land on "community" and
          // silently drop officials.auto and stats.player.
          { plan_key: "community", bool_value: featureKey === "cricket.dls" },
          { plan_key: "pro", bool_value: true },
          { plan_key: "enterprise", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      return [];
    },
    async planCandidateInfo(planKeys) {
      calls.push(`planCandidateInfo(${planKeys.join(",")})`);
      // enterprise is a wholesale copy of pro_plus (V393 step 2) with every
      // cap loosened further — deliberately given a HIGHER privilege score
      // than pro here so a privilege-only (no is_public filter)
      // implementation would still pick the wrong plan, same as real life.
      const info: Record<string, { is_public: boolean; privilege: number }> = {
        community: { is_public: true, privilege: 0 },
        pro: { is_public: true, privilege: 10 },
        enterprise: { is_public: false, privilege: 50 },
      };
      return planKeys.filter((k) => k in info).map((k) => ({ plan_key: k, ...info[k]! }));
    },
    async getOrgSubscriptionId() {
      calls.push("getOrgSubscriptionId");
      return null;
    },
    async updateSubscriptionPlan(subscriptionId, plan) {
      calls.push(`updateSubscriptionPlan(${subscriptionId},${plan})`);
      billing.plan = plan;
    },
    async createSubscriptionForOrg(orgId, plan) {
      calls.push(`createSubscriptionForOrg(${orgId},${plan})`);
      billing.plan = plan;
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
 *  drives: two cricket divisions (3-fixture / 1-fixture leagues), the event
 *  route, and `/officials/auto`.
 *
 *  Two product rules are modelled rather than stubbed, because the probe's
 *  verdicts are meaningless without them:
 *
 *    * SCORING IS FREE. No plan check gates `/events` at all — the only
 *      refusal is the ENGINE's own, and `CricketRevise` needs `oversPerSide`
 *      and/or `target` (cricket.ts:259-266), so an empty revise payload is
 *      422 INVALID_EVENT on any plan. A fake that 402'd here would let the
 *      old paywall assertion pass forever.
 *    * `officials.auto` IS still sold. `/officials/auto` 402s while the org
 *      is on `community` and stops once `billing.plan` moves — pass the SAME
 *      `FakeOrgBilling` box into `fakePlanSql` or the plan flip is invisible
 *      here. */
function fakeServer(billing: FakeOrgBilling = freshOrgBilling()): {
  transport: ProbeTransport;
  calls: RecordedHttpCall[];
} {
  const calls: RecordedHttpCall[] = [];
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
      // The cache-bust round trip (`plan.ts#bustOrgEntitlements`). It grants
      // nothing: what an org is entitled to is a property of its PLAN, and a
      // bust only drops a cached copy of that answer.
      if (method === "POST" && path === "/api/admin/orgs/org-probe/entitlement-override") {
        return { ok: true } as never;
      }
      if (method === "DELETE" && path === "/api/admin/orgs/org-probe/entitlement-override") {
        return { ok: true } as never;
      }
      throw new Error(`fake server: unhandled request ${method} ${path}`);
    },
    raw: async (_base, _s, path, method = "GET", body) => {
      calls.push({ method, path, body });

      const auto = /^\/api\/v1\/divisions\/([^/]+)\/officials\/auto$/.exec(path);
      if (auto) {
        // `autoAssignOfficials`'s FIRST statement is `requireFeature(orgId,
        // "officials.auto", ...)` — before any division-state read, so the
        // only thing that matters here is the plan.
        if (billing.plan === "community") {
          return {
            status: 402,
            json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "officials.auto" } },
          } as never;
        }
        return { status: 200, json: { ok: true, data: { assignments: [] } } } as never;
      }

      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const fixtureId = m[1]!;
      const { type, payload } = body as { type: string; payload: { target?: unknown; oversPerSide?: unknown } };
      // No entitlement branch AT ALL on this route — that is the point.
      if (type === "cricket.revise" && payload?.target === undefined && payload?.oversPerSide === undefined) {
        return {
          status: 422,
          json: { ok: false, error: { code: "INVALID_EVENT", message: "revise needs oversPerSide and/or target" } },
        } as never;
      }
      appended.add(fixtureId);
      return { status: 201, json: { ok: true, data: { seq: 1 } } } as never;
    },
  };
  return { transport, calls };
}

describe("runDlsGateProbe", () => {
  it("drives every cell, proves scoring is FREE, and points the paywall cell at a key the live matrix still gates", async () => {
    // ONE billing box, both fakes — see `FakeOrgBilling`.
    const billing = freshOrgBilling();
    const { sql, calls: sqlCalls } = fakePlanSql({}, billing);
    const { transport, calls: httpCalls } = fakeServer(billing);

    const result = await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7",
      sql,
      transport,
    });

    expect(result.cells.map((c) => c.cell)).toEqual([
      "revise_no_target_community",
      "revise_with_target_community",
      "revise_dls_off_community",
      "other_event_community",
      "gated_feature_refusal_names_its_key",
      "revise_no_target_after_plan",
    ]);
    expect(result.cells.map((c) => c.ok)).toEqual([true, true, true, true, true, true]);

    // THE PROMISE over HTTP: the empty-payload revise reached the ENGINE and
    // was refused on SHAPE, on a free-plan org. A 402 here would mean scoring
    // has been re-gated.
    expect(result.cells[0]!.status).toBe(422);
    expect(result.cells[0]!.detail).toContain("reached the ENGINE");
    // And identically AFTER a paid plan is provisioned: buying something
    // changes nothing about a free feature, in either direction.
    expect(result.cells[5]!.status).toBe(422);

    // THE PROMISE at the matrix, read from `plan_entitlements` at call time.
    expect(result.dlsFreeOnCommunityPlan).toBe(true);

    // THE PAYWALL ASSERTION, re-pointed: derived from the live rows, and
    // still checking all three of status, code and feature_key.
    expect(result.gatedFeatureProbed).toBe("officials.auto");
    expect(result.cells[4]!.status).toBe(402);
    expect(result.cells[4]!.featureKey).toBe("officials.auto");

    // It was driven while the org was STILL on the free plan. The fake
    // 402s that route only for `community`, and `billing.plan` has moved by
    // the end of the run — so a probe that provisioned first would have got a
    // 200 and this cell would be false.
    expect(billing.plan).toBe("pro");

    // B05 T0: the fake's rows are the REAL live catalog shape. `enterprise`
    // is `is_public = false` (V393:25-26) AND the more privileged of the two
    // full grantors; `community` is public and privilege-0 but satisfies only
    // `cricket.dls`. Only the is_public filter plus the multi-capability
    // walk explains "pro" winning here.
    expect(result.provisionedPlan).toBe("pro");
    expect(result.officialsAutoGranted).toBe(true);
    expect(result.statsPlayerGranted).toBe(true);
    expect(result.unsatisfiedCapabilities).toEqual([]);

    // The plan derivation queried every feature key BEFORE provisioning
    // anything, fetched candidate info for the union of plan_keys named, and
    // provisioned via the seam — never a hardcoded plan string.
    expect(sqlCalls).toContain("entitlementRows(cricket.dls)");
    expect(sqlCalls).toContain("entitlementRows(officials.auto)");
    const provisionAt = sqlCalls.findIndex(
      (c) => c.startsWith("updateSubscriptionPlan") || c.startsWith("createSubscriptionForOrg"),
    );
    expect(sqlCalls.indexOf("entitlementRows(officials.auto)")).toBeLessThan(provisionAt);
    const candidateInfoCall = sqlCalls.find((c) => c.startsWith("planCandidateInfo("));
    expect(candidateInfoCall).toBeDefined();
    expect(candidateInfoCall).toContain("enterprise");
    expect(sqlCalls.indexOf(candidateInfoCall!)).toBeLessThan(provisionAt);
    expect(sqlCalls).toContain("createSubscriptionForOrg(org-probe,pro)");

    // `officials.auto`'s rows were read ONCE and reused for both the plan
    // choice and the paywall derivation — not fetched a second time.
    expect(sqlCalls.filter((c) => c === "entitlementRows(officials.auto)")).toHaveLength(1);

    // One fixture per cell — never a shared one (see dls-gate.ts header).
    // 3 fixtures on the dls-on division + 1 on dls-off = 4 distinct fixture
    // ids across the 5 event calls (the freedom cell and its after-plan
    // replay share ONE).
    const eventCalls = httpCalls.filter((c) => /\/events$/.test(c.path));
    expect(eventCalls).toHaveLength(5);
    expect(new Set(eventCalls.map((c) => c.path)).size).toBe(4);

    // B03 review F4: every one of these calls is the FIRST event on its
    // fixture — a 422 shape refusal appends nothing, and each other cell
    // mints its own fresh fixture — so `expected_seq` must be 0 on every one.
    for (const call of eventCalls) {
      expect((call.body as { expected_seq: number }).expected_seq).toBe(0);
    }

    // The paywall cell went to a route the bench already drives, with a
    // schema-valid body: `AssignPolicy.roles` is `min(1)`, and a body that
    // failed zod would 400 ahead of the gate.
    const autoCalls = httpCalls.filter((c) => /\/officials\/auto$/.test(c.path));
    expect(autoCalls).toHaveLength(1);
    expect(autoCalls[0]!.body).toEqual({ policy: { roles: ["umpire"] } });
  });

  it("RETIRES the paywall cell rather than faking one when the live matrix has freed every key this probe can provoke", async () => {
    // The direction the product has already moved once: a key stops being
    // sold. The cell must disappear and SAY SO (`gatedFeatureProbed: null`),
    // never quietly pass, and never manufacture a refusal — an
    // `org_entitlement_overrides` deny would still 402 here and would be a
    // lie about what a customer can hit.
    const billing = freshOrgBilling();
    const { sql } = fakePlanSql(
      {
        async entitlementRows(featureKey) {
          if (featureKey === "cricket.dls" || featureKey === "officials.auto") {
            // Free on the free plan — nothing left to refuse.
            return [
              { plan_key: "community", bool_value: true },
              { plan_key: "pro", bool_value: true },
            ];
          }
          if (featureKey === "stats.player") {
            return [
              { plan_key: "community", bool_value: false },
              { plan_key: "pro", bool_value: true },
            ];
          }
          return [];
        },
      },
      billing,
    );
    const { transport, calls: httpCalls } = fakeServer(billing);

    const result = await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7-free",
      sql,
      transport,
    });

    expect(result.gatedFeatureProbed).toBeNull();
    expect(result.cells.map((c) => c.cell)).not.toContain("gated_feature_refusal_names_its_key");
    // And it did not go knocking on the route either — a 200 read as a pass
    // would be the vacuous green this whole probe exists to prevent.
    expect(httpCalls.filter((c) => /\/officials\/auto$/.test(c.path))).toHaveLength(0);
    // Everything else still runs.
    expect(result.cells.map((c) => c.ok)).toEqual([true, true, true, true, true]);
  });

  it("reports dlsFreeOnCommunityPlan FALSE when the free plan loses its cricket.dls grant — the re-gating witness at the matrix", async () => {
    // Derived from `plan_entitlements`, never from a constant: this is the
    // assertion that reds if a later migration puts scoring back behind a
    // price, which is what the owner's "all scoring is free" ruling deserves.
    const billing = freshOrgBilling();
    const { sql } = fakePlanSql(
      {
        async entitlementRows(featureKey) {
          if (featureKey === "cricket.dls" || featureKey === "officials.auto" || featureKey === "stats.player") {
            return [
              { plan_key: "community", bool_value: false },
              { plan_key: "pro", bool_value: true },
            ];
          }
          return [];
        },
      },
      billing,
    );
    const { transport } = fakeServer(billing);

    const result = await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7-regated",
      sql,
      transport,
    });

    expect(result.dlsFreeOnCommunityPlan).toBe(false);
    // The complement, on the same run: the fixture that DOES grant it reports
    // true (asserted in the first test), so this is not a field stuck on one
    // value.
    expect(result.provisionedPlan).toBe("pro");
  });

  it("no single PUBLIC plan grants BOTH capabilities: still provisions the required one (cricket.dls) and REPORTS the gap, never silently drops it", async () => {
    // A catalog where the capabilities have NO PUBLIC plan in common —
    // officials.auto only on the non-public "enterprise". A legitimate
    // outcome (B03 review F1(a)'s fix text: "must be reported honestly ...
    // not silently downgraded"), not a bug in the chooser — and "enterprise"
    // must never be chosen even though IT alone would satisfy everything.
    const billing = freshOrgBilling();
    const { sql } = fakePlanSql(
      {
        async entitlementRows(featureKey) {
          if (featureKey === "cricket.dls") {
            return [
              { plan_key: "community", bool_value: true },
              { plan_key: "pro", bool_value: true },
            ];
          }
          if (featureKey === "officials.auto") {
            return [
              { plan_key: "community", bool_value: false },
              { plan_key: "enterprise", bool_value: true },
            ];
          }
          // Granted by the plan this catalog forces (`pro`), so the ONLY
          // unsatisfied capability stays `officials.auto` — which keeps this
          // test about the split it was written for rather than about
          // `stats.player` incidentally going missing too.
          if (featureKey === "stats.player") {
            return [
              { plan_key: "community", bool_value: false },
              { plan_key: "pro", bool_value: true },
            ];
          }
          return [];
        },
      },
      billing,
    );
    const { transport } = fakeServer(billing);

    const result = await runDlsGateProbe({
      base: "http://bench.example",
      email: "bench-probe@example.com",
      runTag: "t7b",
      sql,
      transport,
    });

    // cricket.dls is REQUIRED — the probe cannot function without a plan
    // granting it — so "pro" is still chosen even though it grants nothing
    // else this probe wanted. (`community` grants it too and is cheaper, but
    // satisfies neither desired capability, so the walk moves past it.)
    expect(result.provisionedPlan).toBe("pro");
    expect(result.officialsAutoGranted).toBe(false);
    expect(result.unsatisfiedCapabilities).toEqual(["officials.auto"]);
  });

  it("force-activates BOTH divisions via the SQL seam before probing — a division left in setup would WRONG_PHASE every cell", async () => {
    const billing = freshOrgBilling();
    const { sql, calls: sqlCalls } = fakePlanSql({}, billing);
    const { transport } = fakeServer(billing);

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
