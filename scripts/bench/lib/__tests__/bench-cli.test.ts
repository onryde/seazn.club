// Unit coverage for bench.ts's argv parsing — pure, no process spawned, no
// network/DB touched. Lives under lib/__tests__ (rather than a top-level
// scripts/bench/__tests__) purely so every bench test collects from one
// glob; it tests ../../bench.ts, one level up from the other lib tests.
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../bench.ts";

describe("parseCliArgs", () => {
  it("defaults: no suites, optimized engine, keep=true, bench-report dir", () => {
    const config = parseCliArgs([]);
    expect(config.suites).toEqual([]);
    expect(config.engine).toBe("optimized");
    expect(config.keep).toBe(true);
    expect(config.reportDir).toBe("bench-report");
    expect(config.runId).toBeUndefined();
  });

  it("--suite is repeatable and collects into an array, in order", () => {
    const config = parseCliArgs(["--suite", "_tiny", "--suite", "cricket"]);
    expect(config.suites).toEqual(["_tiny", "cricket"]);
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

  it("--base overrides the default", () => {
    expect(parseCliArgs(["--base", "http://localhost:54301"]).base).toBe("http://localhost:54301");
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--not-a-real-flag"])).toThrow();
  });
});
