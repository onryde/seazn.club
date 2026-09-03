// Unit coverage for bench.ts's argv parsing — pure, no process spawned, no
// network/DB touched. Lives under lib/__tests__ (rather than a top-level
// scripts/bench/__tests__) purely so every bench test collects from one
// glob; it tests ../../bench.ts, one level up from the other lib tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs, runSuite } from "../../bench.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanSql } from "../plan.ts";

describe("parseCliArgs", () => {
  // --base is required (no default — see the dedicated test below for why).
  // Every test that isn't specifically exercising that requirement sets
  // SMOKE_BASE so it doesn't have to pass --base on every single call,
  // mirroring how a real invocation gets it (seazn-env.sh's `env --label`).
  const ORIGINAL_SMOKE_BASE = process.env.SMOKE_BASE;
  beforeEach(() => {
    process.env.SMOKE_BASE = "http://localhost:54301";
  });
  afterEach(() => {
    if (ORIGINAL_SMOKE_BASE === undefined) delete process.env.SMOKE_BASE;
    else process.env.SMOKE_BASE = ORIGINAL_SMOKE_BASE;
  });

  it("--base is required — no default, and specifically no :3000 default", () => {
    delete process.env.SMOKE_BASE;
    // A default of :3000 would collide with lib/env.ts's own
    // FORBIDDEN_BASE_PORTS and make the CLI's own default invocation
    // permanently unrunnable — this is a regression test for exactly that.
    expect(() => parseCliArgs([])).toThrow(/--base is required/);
  });

  it("defaults: no suites, optimized engine, keep=true, bench-report dir", () => {
    const config = parseCliArgs([]);
    expect(config.suites).toEqual([]);
    expect(config.engine).toBe("optimized");
    expect(config.keep).toBe(true);
    expect(config.reportDir).toBe("bench-report");
    expect(config.runId).toBeUndefined();
  });

  it("--suite is repeatable and collects into an array, in order", () => {
    const config = parseCliArgs(["--suite", "_tiny", "--suite", "_tiny"]);
    expect(config.suites).toEqual(["_tiny", "_tiny"]);
  });

  it("rejects an unknown --suite value before anything runs", () => {
    // Validated at parse time, not inside the run loop — a typo must never
    // lose an earlier, already-completed suite's results (bench.ts's main()
    // writes exactly one report, after the whole loop finishes).
    expect(() => parseCliArgs(["--suite", "_tiny", "--suite", "cricket"])).toThrow(/unknown --suite value\(s\): cricket/);
  });

  it("accepts each valid --engine value", () => {
    expect(parseCliArgs(["--engine", "optimized"]).engine).toBe("optimized");
    expect(parseCliArgs(["--engine", "greedy"]).engine).toBe("greedy");
    expect(parseCliArgs(["--engine", "both"]).engine).toBe("both");
  });

  it("rejects an invalid --engine value", () => {
    expect(() => parseCliArgs(["--engine", "quantum"])).toThrow(/--engine must be one of/);
  });

  it("--wipe flips keep to false", () => {
    expect(parseCliArgs(["--wipe"]).keep).toBe(false);
  });

  it("--keep (explicit) keeps keep=true", () => {
    expect(parseCliArgs(["--keep"]).keep).toBe(true);
  });

  it("rejects --keep and --wipe together", () => {
    expect(() => parseCliArgs(["--keep", "--wipe"])).toThrow(/mutually exclusive/);
  });

  it("--report-dir overrides the default", () => {
    expect(parseCliArgs(["--report-dir", "/tmp/custom-bench-report"]).reportDir).toBe("/tmp/custom-bench-report");
  });

  it("--run-id is passed through", () => {
    expect(parseCliArgs(["--run-id", "my-run"]).runId).toBe("my-run");
  });

  it("--base overrides SMOKE_BASE", () => {
    expect(parseCliArgs(["--base", "http://localhost:54999"]).base).toBe("http://localhost:54999");
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--not-a-real-flag"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runSuite — B03 T7: `main()` always constructs the REAL plan-provisioning
// SQL seam (`createRealPlanSql`) and forwards it into `runSuite`, which
// forwards it into `runTinySuite`. That forwarding is the ONE thing this
// file can test without a live DB/server (`main()` itself needs both) — a
// minimal fake ProbeTransport/PlanSql that only implements enough of the
// real API surface to reach `PlanSql.setDivisionActive` (the FIRST sql call
// `runDlsGateProbe` makes — see dls-gate.ts), then throws a sentinel from
// it. `runTinySuite`'s own top-level try/catch turns that throw into a RED
// gate with the sentinel in `errors`, rather than a rejected promise — so
// this test asserts on the returned report, not `.rejects`.
//
// If either the `sql:` or the `probeTransport:`/`transport:` forward in
// bench.ts's `runSuite` were deleted, `input.sql`/`input.transport` would be
// `undefined` inside `runTinySuite`, the probe block would be skipped
// entirely (see `TinySuiteInput.sql`'s own doc comment), and this test would
// see a GREEN report with no sentinel — a clean, specific red.
// ---------------------------------------------------------------------------
describe("runSuite — B03 T7 forwards sql/transport into runTinySuite", () => {
  function reachSentinelFake(): { transport: ProbeTransport; sql: PlanSql } {
    const transport: ProbeTransport = {
      async signIn() {
        return { has_org: true, org_id: "org-x", redirect: "/" };
      },
      async request<T>(_base: string, _s, path: string, opts?: { method?: string }) {
        const method = opts?.method ?? "GET";
        if (method === "POST" && path === "/api/v1/competitions") return { id: "comp-x" } as T;
        if (method === "POST" && /\/divisions$/.test(path)) return { id: "div-x" } as T;
        if (method === "POST" && /\/entrants$/.test(path)) return [{ id: "e1" }, { id: "e2" }] as unknown as T;
        if (method === "POST" && /\/stages$/.test(path)) return [{ id: "stage-x" }] as unknown as T;
        if (method === "POST" && /\/generate$/.test(path)) {
          return { fixtures: [{ id: "fx-1" }, { id: "fx-2" }, { id: "fx-3" }] } as unknown as T;
        }
        throw new Error(`reachSentinelFake: unexpected request ${method} ${path}`);
      },
      async raw() {
        throw new Error("reachSentinelFake: should never reach raw() — the sentinel fires before any event probe");
      },
    };
    const sql: PlanSql = {
      async entitlementRows() {
        return [];
      },
      async getOrgSubscriptionId() {
        return null;
      },
      async updateSubscriptionPlan() {},
      async createSubscriptionForOrg() {
        return "sub-x";
      },
      async setOwnerStaff() {},
      async setDivisionActive() {
        throw new Error("SENTINEL: PlanSql.setDivisionActive reached — sql AND transport both made it through runSuite");
      },
    };
    return { transport, sql };
  }

  it("a real _tiny run reaches the DLS-gate probe's SQL seam — proof the forward isn't dead", async () => {
    const { transport, sql } = reachSentinelFake();
    // --wipe: skips the --keep `GET /api/v1/competitions` lookup this
    // minimal fake does not implement — irrelevant to what this test proves
    // (the sql/transport forward), so left unhandled on purpose.
    const config = parseCliArgs(["--suite", "_tiny", "--base", "http://bench.example", "--wipe"]);

    const report = await runSuite("_tiny", config, sql, transport, transport);

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("SENTINEL");
  });
});
