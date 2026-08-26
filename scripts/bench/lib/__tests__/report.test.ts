import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchReport, gateOf, renderMarkdown, resolveRunId, writeReport, type BenchReport as BenchReportType } from "../report.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-report-test-"));
  dirs.push(dir);
  return dir;
}

function fullReport(): BenchReportType {
  return {
    runId: "abc1234",
    startedAt: "2026-08-26T00:00:00.000Z",
    finishedAt: "2026-08-26T00:05:00.000Z",
    engine: "optimized",
    base: "http://localhost:54301",
    preflight: {
      ok: true,
      refusals: [],
      placement: { status: "live", detail: "answered" },
    },
    suites: [
      {
        suite: "_tiny",
        gate: "green",
        timings: { seedMs: 120, scheduleMs: 45 },
        solver: { engine: "greedy", requestedEngine: "greedy", status: "ok" },
        conflictCount: 0,
        believabilityMetrics: { gapDispersion: 0.5 },
        oracles: [{ name: "zero blocking conflicts", passed: true, detail: "0 conflicts" }],
        provenancePct: 100,
        claims: { total: 0, accepted: 0 },
        officials: { assigned: 0, conflicts: 0 },
        news: { drafted: 0, published: 0 },
        adaptations: [],
      },
    ],
    gate: "green",
  };
}

describe("report schema round-trip", () => {
  it("write then parse-back equals what was written", async () => {
    const dir = await tempDir();
    const report = fullReport();

    const written = await writeReport(dir, report);
    const onDisk: unknown = JSON.parse(await readFile(written.jsonPath, "utf8"));
    const reparsed = BenchReport.parse(onDisk);

    // JSON.stringify drops undefined-valued keys (e.g. a suite with no
    // `errors`), so compare against what serialize/deserialize actually
    // produces from the same input, not the literal input object.
    const expected: unknown = JSON.parse(JSON.stringify(report));
    expect(reparsed).toEqual(expected);
  });

  it("round-trips a preflight-refused report with no suites too", async () => {
    const dir = await tempDir();
    const report: BenchReportType = {
      runId: "def5678",
      startedAt: "2026-08-26T00:00:00.000Z",
      engine: "both",
      base: "http://localhost:54301",
      preflight: {
        ok: false,
        refusals: [{ reason: "base_port_forbidden", detail: "port 3000 refused" }],
        placement: { status: "absent", detail: "unreachable" },
      },
      suites: [],
      gate: "red",
    };

    const written = await writeReport(dir, report);
    const onDisk: unknown = JSON.parse(await readFile(written.jsonPath, "utf8"));
    const reparsed = BenchReport.parse(onDisk);
    expect(reparsed).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it("rejects a malformed report rather than writing it silently", async () => {
    const dir = await tempDir();
    const bad = { ...fullReport(), gate: "purple" } as unknown as BenchReportType;
    await expect(writeReport(dir, bad)).rejects.toThrow();
  });
});

describe("resolveRunId", () => {
  it("prefers the explicit CLI arg over the git sha", () => {
    expect(resolveRunId("custom-run", "deadbeef")).toBe("custom-run");
  });

  it("falls back to the git sha when no CLI arg is given", () => {
    expect(resolveRunId(undefined, "deadbeef")).toBe("deadbeef");
  });

  it("falls back to the git sha on an empty-string CLI arg", () => {
    expect(resolveRunId("", "deadbeef")).toBe("deadbeef");
  });
});

describe("gateOf", () => {
  it("is red when preflight refused, even with no suites run", () => {
    expect(
      gateOf({
        preflight: { ok: false, refusals: [], placement: { status: "absent", detail: "" } },
        suites: [],
      }),
    ).toBe("red");
  });

  it("is red when any suite gate is red", () => {
    expect(
      gateOf({
        preflight: { ok: true, refusals: [], placement: { status: "live", detail: "" } },
        suites: [{ suite: "_tiny", gate: "red", timings: {} }],
      }),
    ).toBe("red");
  });

  it("is green when preflight passed and every suite is green", () => {
    expect(
      gateOf({
        preflight: { ok: true, refusals: [], placement: { status: "live", detail: "" } },
        suites: [{ suite: "_tiny", gate: "green", timings: {} }],
      }),
    ).toBe("green");
  });
});

describe("renderMarkdown", () => {
  it("includes the gate, run id, and each suite name", () => {
    const md = renderMarkdown(fullReport());
    expect(md).toContain("abc1234");
    expect(md).toContain("GREEN");
    expect(md).toContain("_tiny");
  });

  it("renders a no-suites report without crashing", () => {
    const report = { ...fullReport(), suites: [] };
    const md = renderMarkdown(report);
    expect(md).toContain("(none ran)");
  });
});
