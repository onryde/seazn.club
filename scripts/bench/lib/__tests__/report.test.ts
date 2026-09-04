import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchReport,
  gateOf,
  renderMarkdown,
  resolveRunId,
  writeReport,
  type BenchReport as BenchReportType,
  type RegistrationDivisionReport,
} from "../report.ts";

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
        // B02 — a GREEN suite with something to say. Present in the canonical
        // fixture (not only in the render test) because `writeReport` PARSES
        // before it writes: a field missing from the schema is stripped from
        // report.json and from report.md with it, silently, and a renderer
        // test alone cannot see that — it renders the in-memory object.
        warnings: ["leaderboards.not_derived @ expected.leaderboards: not checked offline"],
      },
    ],
    gate: "green",
  };
}

// B03r task 8 — the registration-division fixture. Values are deliberately
// all-distinct (no two counts share a value) so a swapped-column mutation
// (e.g. eligibility/manual, or entries/paidCents) is witnessed by a wrong
// number landing in a specific cell, not just "a number is present somewhere".
function registrationDivision(overrides: Partial<RegistrationDivisionReport> = {}): RegistrationDivisionReport {
  return {
    divisionRef: "u16-singles",
    entries: 16,
    entrants: 13,
    waitlisted: 2,
    rejectedEligibility: 1,
    rejectedManual: 3,
    paidCents: 45600,
    organiserForceEligibilityProven: false,
    funnelWallMs: 8123,
    padWallMs: 91234,
    failures: [],
    ...overrides,
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

  // B03r task 8 — same discipline as the B02 comment above: `writeReport`
  // PARSES before it writes, so a registration field the schema does not
  // declare would be silently stripped from both report.json and report.md,
  // invisible to a renderer-only test.
  it("round-trips a suite's registration divisions and the run's entryMode", async () => {
    const dir = await tempDir();
    const base = fullReport();
    const report: BenchReportType = {
      ...base,
      entryMode: "registration",
      suites: [{ ...(base.suites[0] as BenchReportType["suites"][number]), registration: [registrationDivision()] }],
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

  // B02 — a suite may be GREEN and still have something to say. Stage 0 names
  // what it does not derive offline, and `_tiny` carries two such warnings on
  // every clean run; a channel that only printed beside a failure would be a
  // channel nobody reads.
  it("prints a green suite's warnings, and they do not touch the gate", () => {
    const base = fullReport();
    const suite = { ...(base.suites[0] as BenchReportType["suites"][number]) };
    const report: BenchReportType = {
      ...base,
      suites: [
        {
          ...suite,
          gate: "green",
          warnings: [
            "leaderboards.not_derived @ expected.leaderboards: 2 declared entries are NOT checked offline",
          ],
        },
      ],
    };
    const md = renderMarkdown(report);
    expect(md).toContain("Warnings (not gated)");
    expect(md).toContain("leaderboards.not_derived");
    expect(gateOf(report)).toBe("green");
  });
});

// B03r task 8 — registration-funnel report additions (design §7).
// `register.ts`'s real types (`FunnelResult`, `SUITE_13_KEY`, `CliEntryFlag`)
// are the source of truth this section renders from; this file only shapes
// and prints what a caller (bench.ts, out of B03r's scope) supplies.
describe("renderMarkdown — registration (B03r task 8)", () => {
  function withSuiteRegistration(divisions: RegistrationDivisionReport[]): BenchReportType {
    const base = fullReport();
    return {
      ...base,
      suites: [{ ...(base.suites[0] as BenchReportType["suites"][number]), registration: divisions }],
    };
  }

  it("renders entries/entrants/waitlisted/paid/timings, with eligibility and manual rejections in separate columns", () => {
    // rejectedEligibility (1) and rejectedManual (3) DIFFER — a swapped
    // mapping between the two columns is witnessed by this fixture, an
    // equal-counts fixture could not.
    const division = registrationDivision({ rejectedEligibility: 1, rejectedManual: 3 });
    const md = renderMarkdown(withSuiteRegistration([division]));

    expect(md).toContain("Rejected (eligibility)");
    expect(md).toContain("Rejected (manual)");
    // Exact row, columns in order — pins position, not just presence, so a
    // column swap reds this even though both numbers still appear somewhere.
    expect(md).toContain("| u16-singles | 16 | 13 | 2 | 1 | 3 | 45600 | 8123ms | 91234ms |");
  });

  it("renders paid cents from the division's own funnel total, never a group-level snapshot", () => {
    // A distinctive paidCents that shares no digits/relationship with the
    // other counts, so the cell can only be correct if it came from
    // `paidCents` itself — nothing else in this fixture could produce it.
    const division = registrationDivision({ entries: 7, entrants: 5, waitlisted: 0, rejectedEligibility: 1, rejectedManual: 1, paidCents: 305000 });
    const md = renderMarkdown(withSuiteRegistration([division]));
    expect(md).toContain("| u16-singles | 7 | 5 | 0 | 1 | 1 | 305000 | 8123ms | 91234ms |");
  });

  it("prints the organiser-force eligibility notice as unproven when the division says so", () => {
    const division = registrationDivision({ organiserForceEligibilityProven: false });
    const md = renderMarkdown(withSuiteRegistration([division]));
    expect(md).toContain("UNPROVEN");
    expect(md).toContain("gateRosterEligibility");
    expect(md).toContain("public-submit half");
  });

  it("omits the unproven notice when a division reports the organiser-force half as proven", () => {
    const division = registrationDivision({ organiserForceEligibilityProven: true });
    const md = renderMarkdown(withSuiteRegistration([division]));
    expect(md).not.toContain("UNPROVEN");
  });

  it("renders a failure artefact's response body, screenshot, and trace paths", () => {
    const division = registrationDivision({
      failures: [
        {
          detail: "checkout POST returned 500",
          responseBody: '{"error":"stripe_unreachable"}',
          screenshotPath: "artifacts/u16-singles-checkout.png",
          tracePath: "artifacts/u16-singles-checkout-trace.zip",
        },
      ],
    });
    const md = renderMarkdown(withSuiteRegistration([division]));
    expect(md).toContain("checkout POST returned 500");
    expect(md).toContain('{"error":"stripe_unreachable"}');
    expect(md).toContain("artifacts/u16-singles-checkout.png");
    expect(md).toContain("artifacts/u16-singles-checkout-trace.zip");
  });

  it('"Registration at volume" appears under entryMode "registration" and excludes suite 13', async () => {
    const { SUITE_13_KEY } = await import("../register.ts");
    const base = fullReport();
    const report: BenchReportType = {
      ...base,
      entryMode: "registration",
      suites: [
        { suite: "cricket-league", gate: "green", timings: {}, registration: [registrationDivision({ divisionRef: "at-volume-division" })] },
        { suite: SUITE_13_KEY, gate: "green", timings: {}, registration: [registrationDivision({ divisionRef: "club-open-division" })] },
      ],
    };
    const md = renderMarkdown(report);

    expect(md).toContain("Registration at volume");
    const sectionStart = md.indexOf("## Registration at volume");
    const nextHeading = md.indexOf("\n## ", sectionStart + 1);
    const section = md.slice(sectionStart, nextHeading === -1 ? md.length : nextHeading);
    expect(section).toContain("at-volume-division");
    expect(section).not.toContain("club-open-division");
    // Suite 13's own per-suite section still carries its table — the
    // exclusion is from the AT-VOLUME aggregate only, never a data loss.
    expect(md).toContain("club-open-division");
  });

  it('"Registration at volume" is absent when entryMode is not "registration"', () => {
    const withoutFlag = withSuiteRegistration([registrationDivision()]);
    const md = renderMarkdown(withoutFlag);
    expect(md).not.toContain("Registration at volume");

    const adminFlag: BenchReportType = { ...withoutFlag, entryMode: "admin" };
    expect(renderMarkdown(adminFlag)).not.toContain("Registration at volume");
  });
});
