// Unit coverage for bench.ts's argv parsing — pure, no process spawned, no
// network/DB touched. Lives under lib/__tests__ (rather than a top-level
// scripts/bench/__tests__) purely so every bench test collects from one
// glob; it tests ../../bench.ts, one level up from the other lib tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, resolveCaptureDirs, runSuite } from "../../bench.ts";
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

  // B03r task 6: `--entry admin|registration` (design §3) — parsed here,
  // resolved per-division by `register.ts`'s `resolveEntryMode` (see its
  // own test file for the mode-resolution table this flag ultimately
  // drives). This file only proves the CLI's OWN contract: unset by
  // default, each legal value accepted, anything else rejected.
  it("--entry is undefined by default (no flag ⇒ each division keeps its own declared entry)", () => {
    expect(parseCliArgs([]).entry).toBeUndefined();
  });

  it("accepts each valid --entry value", () => {
    expect(parseCliArgs(["--entry", "admin"]).entry).toBe("admin");
    expect(parseCliArgs(["--entry", "registration"]).entry).toBe("registration");
  });

  it("rejects an invalid --entry value", () => {
    // Specifically NOT "registration-api"/"registration-ui" — those are
    // resolveEntryMode's OUTPUT vocabulary (EntryMode), never a legal CLI
    // input (CliEntryFlag only has "admin"/"registration").
    expect(() => parseCliArgs(["--entry", "registration-api"])).toThrow(/--entry must be one of/);
  });

  // R86 (owner: "watch the bench play a match") — --record-video/--trace are
  // node:util parseArgs cannot express on its own: a boolean-or-string flag
  // (bare = default dir, valued = explicit one). `extractOptionalValueFlag`
  // pulls both out of argv BEFORE parseArgs ever runs, so these also prove
  // that extraction never confuses a flag's OWN value with the next flag.
  describe("--record-video / --trace", () => {
    it("both absent by default — OFF means off, not present-with-no-dir", () => {
      const config = parseCliArgs([]);
      expect(config.recordVideo).toBeUndefined();
      expect(config.trace).toBeUndefined();
    });

    it("a bare flag turns capture on with no explicit dir", () => {
      expect(parseCliArgs(["--record-video"]).recordVideo).toEqual({});
      expect(parseCliArgs(["--trace"]).trace).toEqual({});
    });

    it("a space-separated value is the explicit dir", () => {
      expect(parseCliArgs(["--record-video", "/tmp/my-videos"]).recordVideo).toEqual({ dir: "/tmp/my-videos" });
      expect(parseCliArgs(["--trace", "/tmp/my-traces"]).trace).toEqual({ dir: "/tmp/my-traces" });
    });

    it("an --opt=value form is the explicit dir too", () => {
      expect(parseCliArgs(["--record-video=/tmp/my-videos"]).recordVideo).toEqual({ dir: "/tmp/my-videos" });
      expect(parseCliArgs(["--trace=/tmp/my-traces"]).trace).toEqual({ dir: "/tmp/my-traces" });
    });

    it("a bare flag immediately followed by another flag stays bare — it does not eat the next flag as its value", () => {
      const config = parseCliArgs(["--record-video", "--trace", "--wipe"]);
      expect(config.recordVideo).toEqual({});
      expect(config.trace).toEqual({});
      expect(config.keep).toBe(false);
    });

    it("both flags together, independently, in either order", () => {
      const a = parseCliArgs(["--record-video", "/tmp/v", "--trace", "/tmp/t"]);
      expect(a.recordVideo).toEqual({ dir: "/tmp/v" });
      expect(a.trace).toEqual({ dir: "/tmp/t" });
      const b = parseCliArgs(["--trace", "/tmp/t2", "--record-video", "/tmp/v2"]);
      expect(b.recordVideo).toEqual({ dir: "/tmp/v2" });
      expect(b.trace).toEqual({ dir: "/tmp/t2" });
    });

    it("still rejects an actually-unknown flag — extraction did not widen strict mode", () => {
      expect(() => parseCliArgs(["--record-video", "--not-a-real-flag"])).toThrow();
    });
  });
});

describe("resolveCaptureDirs — R86", () => {
  const config = (extra: string[] = []): ReturnType<typeof parseCliArgs> =>
    parseCliArgs(["--base", "http://bench.example", ...extra]);

  it("both absent when neither CLI flag was given — no directory implied at all", () => {
    expect(resolveCaptureDirs(config(), "run-a")).toEqual({});
  });

  it("defaults under <report-dir>/<run-id>/{video,trace} when the flag was bare", () => {
    const c = config(["--record-video", "--trace", "--report-dir", "/tmp/bench-report"]);
    expect(resolveCaptureDirs(c, "run-a")).toEqual({
      recordVideoDir: "/tmp/bench-report/run-a/video",
      traceDir: "/tmp/bench-report/run-a/trace",
    });
  });

  it("two different run ids resolve to two different directories — the concurrency guard", () => {
    const c = config(["--record-video", "--report-dir", "/tmp/bench-report"]);
    const a = resolveCaptureDirs(c, "leg-a-optimized");
    const b = resolveCaptureDirs(c, "leg-b-greedy");
    expect(a.recordVideoDir).not.toBe(b.recordVideoDir);
    expect(a.recordVideoDir).toBe("/tmp/bench-report/leg-a-optimized/video");
    expect(b.recordVideoDir).toBe("/tmp/bench-report/leg-b-greedy/video");
  });

  it("an explicit dir wins outright, ignoring reportDir/runId entirely", () => {
    const c = config(["--record-video", "/explicit/videos", "--report-dir", "/tmp/bench-report"]);
    expect(resolveCaptureDirs(c, "run-a")).toEqual({ recordVideoDir: "/explicit/videos" });
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
      async planCandidateInfo() {
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

    // `runId` is the RESOLVED one `main()` computes — a literal here, since
    // this test never writes a report and no artifact directory is created
    // (`_tiny`'s engine artifact only lands once a run reaches the scheduling
    // layer, which this fake's sentinel throw happens long before).
    const report = await runSuite("_tiny", config, "test-run-id", sql, transport, transport);

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("SENTINEL");
  });

  // B06a Task 1 — the dispatch is a registry lookup, and its refusal names the
  // keys the registry actually holds rather than a hardcoded "_tiny". The old
  // message ("only \"_tiny\" exists until B02+ lands real packs") outlived the
  // packs it was waiting for; deriving it means it cannot go stale again.
  it("refuses an unknown suite key and names the known ones", async () => {
    const config = parseCliArgs(["--base", "http://bench.example", "--wipe"]);
    await expect(
      runSuite("nope", config, "test-run-id", {} as PlanSql),
    ).rejects.toThrow(/unknown suite "nope".*_tiny/s);
  });
});

// ---------------------------------------------------------------------------
// B04 T6 — `runSuite` forwards the RESOLVED run id and the report directory
//
// Both are new parameters, both are read only at the very end of a suite run
// (`writeEngineArtifact`/`readEngineArtifacts`), and neither is observable
// from a run that dies at the sentinel above. So this test replaces the suite
// module itself and reads what it was handed: delete either forward in
// `bench.ts` and exactly this reds.
//
// The identity matters more than the plumbing. `report.json` and
// `engine-<engine>.json` have to land in the SAME directory or the second leg
// of a two-engine run writes somewhere the first never looks — which is why
// `main()` resolves the run id ONCE and passes it down, rather than letting
// the suite re-derive it from `config.runId` (the raw CLI arg, usually
// undefined).
// ---------------------------------------------------------------------------
describe("runSuite — B04 forwards reportDir and the resolved runId", () => {
  it("hands the suite the run id it was given, not config.runId", async () => {
    vi.resetModules();
    const seen: Record<string, unknown>[] = [];
    vi.doMock("../suites/tiny.ts", () => ({
      // B06a: the registry imports TINY_PACK_PATH from this module too.
      TINY_PACK_PATH: "/fake/packs/_tiny.json",
      runTinySuite: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { suite: "_tiny", gate: "green" as const, timings: {}, keep: false };
      },
    }));
    const fresh = await import("../../bench.ts");
    // NO `--run-id`, so `config.runId` is undefined — the only way the suite
    // can learn the identity is the parameter.
    const config = fresh.parseCliArgs([
      "--suite",
      "_tiny",
      "--base",
      "http://bench.example",
      "--report-dir",
      "/tmp/bench-report-under-test",
    ]);
    expect(config.runId).toBeUndefined();

    await fresh.runSuite("_tiny", config, "resolved-sha", {} as PlanSql);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe("resolved-sha");
    expect(seen[0]!.reportDir).toBe("/tmp/bench-report-under-test");
    // And the engine assertion travels with them — `--engine` is honoured as
    // an assertion by the scheduling layer, so the value has to arrive.
    expect(seen[0]!.engine).toBe("optimized");
    // R86 — off means off: no capture flag was passed, so `runSuite` was
    // never given a recordVideoDir/traceDir, and the key must be ABSENT
    // from the suite input, not present-with-`undefined`.
    expect(seen[0]!).not.toHaveProperty("recordVideoDir");
    expect(seen[0]!).not.toHaveProperty("traceDir");

    vi.doUnmock("../suites/tiny.ts");
    vi.resetModules();
  });

  // R86 — the SAME forwarding hop as runId/reportDir above, one step
  // earlier: bench.ts's `main()` resolves `recordVideoDir`/`traceDir` once
  // (`resolveCaptureDirs`) and passes them as `runSuite`'s own trailing
  // params; this proves THAT forward, independent of `main()` itself (which
  // needs a live preflight to reach the loop at all).
  it("forwards recordVideoDir/traceDir into the suite input when the caller supplies them", async () => {
    vi.resetModules();
    const seen: Record<string, unknown>[] = [];
    vi.doMock("../suites/tiny.ts", () => ({
      TINY_PACK_PATH: "/fake/packs/_tiny.json",
      runTinySuite: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { suite: "_tiny", gate: "green" as const, timings: {}, keep: false };
      },
    }));
    const fresh = await import("../../bench.ts");
    const config = fresh.parseCliArgs(["--suite", "_tiny", "--base", "http://bench.example"]);

    await fresh.runSuite(
      "_tiny",
      config,
      "resolved-sha",
      {} as PlanSql,
      undefined,
      undefined,
      "/tmp/bench-report/resolved-sha/video",
      "/tmp/bench-report/resolved-sha/trace",
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.recordVideoDir).toBe("/tmp/bench-report/resolved-sha/video");
    expect(seen[0]!.traceDir).toBe("/tmp/bench-report/resolved-sha/trace");

    vi.doUnmock("../suites/tiny.ts");
    vi.resetModules();
  });
});
