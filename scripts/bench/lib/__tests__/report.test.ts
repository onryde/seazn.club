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
  type DivisionScheduleReport,
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

  // T7e — `SuiteReport.gate` (unlike the run-level `BenchReport.gate`) accepts
  // a third value, "skipped": a `--keep` short circuit that skipped seeding
  // AND scheduling. Round-tripped here (not only asserted by `gateOf`/render
  // tests) because `writeReport` PARSES before it writes — the schema is the
  // real gate on whether this value can reach report.json at all, and
  // `BenchReport.parse` rejecting "skipped" is exactly the pre-fix failure
  // this test is written to catch.
  it("round-trips a suite gate of \"skipped\", distinct from the run-level green/red", async () => {
    const dir = await tempDir();
    const base = fullReport();
    const report: BenchReportType = {
      ...base,
      suites: [
        {
          ...(base.suites[0] as BenchReportType["suites"][number]),
          gate: "skipped",
          warnings: ["tiny: --keep reused existing seed — seeding and scheduling skipped this run"],
        },
      ],
      gate: "red",
    };

    const written = await writeReport(dir, report);
    const onDisk: unknown = JSON.parse(await readFile(written.jsonPath, "utf8"));
    const reparsed = BenchReport.parse(onDisk);
    expect(reparsed).toEqual(JSON.parse(JSON.stringify(report)));
    // The run-level `BenchReport.gate` stays the CLOSED two-value set — only
    // the per-suite gate carries the third state.
    expect(reparsed.gate).toBe("red");
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

  // T7e — a `--keep` short circuit that skipped seeding AND scheduling must
  // never read as an overall pass. `SuiteReport.gate: "skipped"` is a third,
  // non-green value precisely so this cannot be mistaken for the run having
  // measured anything.
  it("is red when any suite gate is skipped — a run that measured nothing has not passed", () => {
    expect(
      gateOf({
        preflight: { ok: true, refusals: [], placement: { status: "live", detail: "" } },
        suites: [{ suite: "_tiny", gate: "skipped", timings: {} }],
      }),
    ).toBe("red");
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

  // T7e — the whole point of the third gate value: a reader scanning the
  // suite header must see SKIPPED, never GREEN, for a `--keep` short circuit
  // that measured nothing. This is the render-side half of the fix; the gate
  // computation half is `gateOf`'s "is red when any suite gate is skipped"
  // test above.
  it("renders a skipped suite's header as SKIPPED, not GREEN", () => {
    const base = fullReport();
    const suite = { ...(base.suites[0] as BenchReportType["suites"][number]) };
    const report: BenchReportType = {
      ...base,
      suites: [{ ...suite, gate: "skipped", warnings: ["tiny: --keep reused existing seed"] }],
    };
    const md = renderMarkdown(report);
    expect(md).toContain(`### ${suite.suite} — SKIPPED`);
    expect(md).not.toContain(`### ${suite.suite} — GREEN`);
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

// ---------------------------------------------------------------------------
// B04 — the five scheduling sections
//
// Values are deliberately ALL-DISTINCT (no two numbers share a value), so a
// swapped column is witnessed by a wrong number landing in a specific cell
// rather than by "a number is present somewhere" — the same discipline the
// registration fixture above already uses.
// ---------------------------------------------------------------------------

function divisionSchedule(
  overrides: Partial<DivisionScheduleReport> = {},
): DivisionScheduleReport {
  return {
    divisionRef: "d-tiny",
    requestedEngine: "optimized",
    actualEngine: "greedy",
    solverStatus: "fallback",
    mode: "build",
    metrics: {
      makespanMinutes: 91,
      worstIdleGapMinutes: 12,
      courtImbalanceMinutes: 7,
      placed: 5,
      total: 6,
    },
    blockingCount: 0,
    warnKindTally: { court_gap: 4 },
    unplacedCount: 1,
    wallMs: 314,
    scheduleErrors: [],
    checker: {
      clean: true,
      findings: [],
      unchecked: [{ type: "gapMinutes", reason: "not modelled by the bench checker" }],
      // T7b — a real division always leaves rule 5 unexercised on `_tiny`
      // (its own comment: no `not_before`/`not_after` is declared), so this
      // default mirrors that rather than an empty list nothing can witness.
      unexercised: [
        {
          rule: "Rule 5 — not_before / not_after",
          reason: "no not_before/not_after hard rule matched a placed fixture's scope",
        },
      ],
    },
    certificate: {
      branch: "SKIPPED_NO_HISTORY",
      reason: "the pack declares no historicalAssignment for d-tiny",
      red: false,
      violations: [],
    },
    believability: {
      metrics: [
        { key: "restSpread", score: 88 },
        { key: "courtBalance", score: 73 },
      ],
    },
    red: false,
    reasons: [],
    ...overrides,
  };
}

function scheduledReport(rows: readonly DivisionScheduleReport[]): BenchReportType {
  const base = fullReport();
  return {
    ...base,
    suites: base.suites.map((s) => ({ ...s, scheduling: rows })),
  };
}

describe("renderMarkdown — B04 scheduling sections", () => {
  it("renders nothing at all for a report that scheduled nothing", () => {
    // A pre-B04 report, a `--keep` short circuit and a stage-0 refusal all
    // land here, and every one of them must render byte-identically to what
    // it rendered before this task.
    const md = renderMarkdown(fullReport());
    expect(md).not.toContain("## Scheduling");
    expect(md).not.toContain("## Checker");
    expect(md).not.toContain("## Feasibility certificate");
    expect(md).not.toContain("## Believability");
    expect(md).not.toContain("## Engine delta");
  });

  it("renders one scheduling row per division, with BOTH denominators in their own columns", () => {
    const md = renderMarkdown(
      scheduledReport([divisionSchedule(), divisionSchedule({ divisionRef: "d-badminton", wallMs: 271 })]),
    );
    expect(md).toContain("## Scheduling");
    // The requested engine and the one that actually answered, side by side —
    // the whole point of design §2.1's assertion is that they can differ.
    expect(md).toContain("| _tiny | d-tiny | optimized | greedy | fallback | build | 0 | 1 | 5/6 | 314ms |");
    expect(md).toContain("| _tiny | d-badminton | optimized | greedy | fallback | build | 0 | 1 | 5/6 | 271ms |");
    // `1` (the fetched board) and `5/6` (the proposal) are DIFFERENT cells.
    expect(md).toContain("Unplaced (board)");
    expect(md).toContain("Placed/Total (proposal)");
  });

  it("renders the checker's UNCHECKED list BESIDE its verdict", () => {
    // The requirement, not a layout preference: "checker clean" is a claim
    // about the constraints the checker modelled, and a report that prints
    // the verdict without the list lets that read as "every declared
    // constraint was verified".
    const md = renderMarkdown(scheduledReport([divisionSchedule()]));
    const section = md.slice(md.indexOf("## Checker"));
    expect(section).toContain("CLEAN");
    expect(section).toContain("Unchecked constraints (1)");
    expect(section).toContain("`gapMinutes`");
    // The verdict and the caveat are in the SAME section, so one cannot be
    // read without the other.
    expect(section.indexOf("CLEAN")).toBeLessThan(section.indexOf("gapMinutes"));
  });

  // -----------------------------------------------------------------------
  // T7b — the OPPOSITE direction: a rule the checker DOES model, but which
  // had nothing on this board to judge.
  // -----------------------------------------------------------------------

  it("renders the checker's UNEXERCISED list BESIDE its verdict too", () => {
    const md = renderMarkdown(scheduledReport([divisionSchedule()]));
    const section = md.slice(md.indexOf("## Checker"));
    expect(section).toContain("CLEAN");
    expect(section).toContain("Unexercised rules (1)");
    expect(section).toContain("`Rule 5 — not_before / not_after`");
    // Same section as the verdict, same requirement as `unchecked` above —
    // one cannot be read without the other.
    expect(section.indexOf("CLEAN")).toBeLessThan(section.indexOf("Rule 5"));
  });

  it("says so explicitly when NOTHING was left unchecked, rather than rendering silence", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({ checker: { clean: true, findings: [], unchecked: [], unexercised: [] } }),
      ]),
    );
    expect(md).toContain("Unchecked constraints: none");
  });

  it("says so explicitly when NOTHING was left unexercised, rather than rendering silence", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({ checker: { clean: true, findings: [], unchecked: [], unexercised: [] } }),
      ]),
    );
    expect(md).toContain("Unexercised rules: none");
  });

  it("names every checker finding, with both fixtures of a pairwise breach", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({
          checker: {
            clean: false,
            findings: [
              {
                kind: "court_double_booking",
                divisionRef: "d-tiny",
                fixtureIds: ["fx-1", "fx-2"],
                detail: "fx-1 and fx-2 overlap on court-1",
              },
            ],
            unchecked: [],
            unexercised: [],
          },
          red: true,
          reasons: ["d-tiny: checker findings = 1 (court_double_booking)"],
        }),
      ]),
    );
    expect(md).toContain("1 FINDING(S)");
    expect(md).toContain("`court_double_booking` [fx-1, fx-2]");
  });

  it("renders the certificate branch, its redness and its reason", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({
          certificate: {
            branch: "PACK_AUTHORING_BUG",
            reason: "history violates this pack's own encoding",
            red: true,
            violations: [
              {
                kind: "inside_blackout",
                divisionRef: "d-tiny",
                fixtureIds: ["fx-9"],
                detail: "fx-9 runs inside a blackout",
              },
            ],
          },
        }),
      ]),
    );
    expect(md).toContain("## Feasibility certificate");
    expect(md).toContain("| _tiny | d-tiny | `PACK_AUTHORING_BUG` | yes | history violates this pack's own encoding |");
    expect(md).toContain("History's own violations");
    expect(md).toContain("`inside_blackout` [fx-9]");
  });

  it("renders believability with its own denominator, and says it gates nothing", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({
          believability: {
            metrics: [{ key: "restSpread", score: 88 }],
            similarityToHistorical: {
              sameDayPct: 66,
              sameInstantPct: 33,
              comparedFixtures: 3,
              historicalRows: 9,
            },
          },
        }),
      ]),
    );
    expect(md).toContain("## Believability");
    expect(md).toContain("nothing here ever reds a run");
    expect(md).toContain("restSpread=88");
    // The denominator, stated: "66%" over three compared fixtures of nine
    // declared rows reads very differently from "66%" alone.
    expect(md).toContain("66% same day, 33% same instant over 3 compared fixture(s) of 9 declared row(s)");
  });

  it("prints the scheduling notes a bare table would hide", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({
          metrics: undefined,
          metricsNote: "auto returned no metrics for d-tiny, so the proposal is UNKNOWN",
          notSearchedReason: "placement service unreachable",
          budgetExpired: true,
          tiersCompleted: 2,
          tiersTotal: 5,
          scheduleErrors: ["d-tiny: schedule-settings DROPPED \"perEntrantMinRest\""],
          red: true,
          reasons: ["d-tiny: schedule errors = 1"],
        }),
      ]),
    );
    expect(md).toContain("UNKNOWN");
    expect(md).toContain("solver did not search — placement service unreachable");
    expect(md).toContain("solver budget expired (tiers 2/5)");
    expect(md).toContain("court_gap=4");
    expect(md).toContain("ERROR: d-tiny: schedule-settings DROPPED");
  });
});

describe("renderMarkdown — B04 engine delta", () => {
  const snapshot = (engine: "greedy" | "optimized", runId: string) => ({
    runId,
    requestedEngine: engine,
    engine,
    divisions: [
      {
        divisionRef: "d-tiny",
        blockingCount: 0,
        unplacedCount: 0,
        wallMs: 100,
      },
    ],
  });

  it("renders the note when there is no delta — so 'only greedy ran' cannot read as a tie", () => {
    const base = fullReport();
    const md = renderMarkdown({
      ...base,
      suites: base.suites.map((s) => ({
        ...s,
        engineDelta: { note: "engine delta omitted: only the greedy leg has an artifact for this run" },
      })),
    });
    expect(md).toContain("## Engine delta");
    expect(md).toContain("only the greedy leg has an artifact");
  });

  it("renders both sums with their sign, and the divisions they actually cover", () => {
    const base = fullReport();
    const md = renderMarkdown({
      ...base,
      suites: base.suites.map((s) => ({
        ...s,
        engineDelta: {
          delta: {
            greedy: snapshot("greedy", "sha-1"),
            optimized: snapshot("optimized", "sha-1"),
            makespanDeltaMinutes: 60,
            courtImbalanceDeltaMinutes: -5,
            comparedDivisionRefs: ["d-tiny", "d-badminton"],
          },
        },
      })),
    });
    expect(md).toContain("makespan 60min, court imbalance -5min");
    expect(md).toContain("over: d-tiny, d-badminton");
  });

  it("says the sums compared NOTHING when the two legs share no division", () => {
    // Two legs sharing no division produce 0 and 0, which reads identically
    // to "the engines tied". This line is what tells them apart.
    const base = fullReport();
    const md = renderMarkdown({
      ...base,
      suites: base.suites.map((s) => ({
        ...s,
        engineDelta: {
          delta: {
            greedy: snapshot("greedy", "sha-1"),
            optimized: snapshot("optimized", "sha-1"),
            makespanDeltaMinutes: 0,
            courtImbalanceDeltaMinutes: 0,
            comparedDivisionRefs: [],
          },
        },
      })),
    });
    expect(md).toContain("NO divisions in common");
  });
});

describe("report schema round-trip — B04", () => {
  it("write then parse-back keeps every scheduling field", async () => {
    // `writeReport` PARSES before it writes, and a `z.object` strips an
    // unknown key — so a field missing from the schema vanishes from
    // report.json and from report.md with it, silently. A renderer test alone
    // cannot see that: it renders the in-memory object.
    const dir = await tempDir();
    const report = scheduledReport([divisionSchedule()]);
    const written = await writeReport(dir, report);
    const onDisk: unknown = JSON.parse(await readFile(written.jsonPath, "utf8"));
    const reparsed = BenchReport.parse(onDisk);
    expect(reparsed).toEqual(JSON.parse(JSON.stringify(report)));
    // And specifically the fields whose loss would be invisible:
    const row = (reparsed.suites[0]?.scheduling ?? [])[0];
    expect(row?.checker?.unchecked).toHaveLength(1);
    // T7b — the opposite direction survives the round-trip too.
    expect(row?.checker?.unexercised).toHaveLength(1);
    expect(row?.checker?.unexercised[0]?.rule).toBe("Rule 5 — not_before / not_after");
    expect(row?.metrics?.placed).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// B04 review round — the post-officials re-check and the cross-division gate
// ---------------------------------------------------------------------------

describe("renderMarkdown — the post-officials checker verdict (F-T6-2)", () => {
  it("renders BOTH verdicts, and says which stage moved it", () => {
    // Both, never one: a single post-officials verdict would report a finding
    // without saying whether scheduling or officials introduced it.
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({
          checkerAfterOfficials: {
            clean: false,
            findings: [
              {
                kind: "official_double_booking",
                divisionRef: "d-tiny",
                fixtureIds: ["fx-1", "fx-2"],
                detail: "official o-1 is on fx-1 and fx-2, which overlap",
              },
            ],
            unchecked: [],
            // T7b — rule 7 (officials) went from unexercised to exercised
            // (and dirty) once officials auto-assign landed: the SAME
            // division's primary verdict below still carries "Rule 5" in its
            // own `unexercised`, so the two lists must render INDEPENDENTLY,
            // never as one shared list.
            unexercised: [],
          },
          red: true,
          reasons: ["d-tiny: checker findings AFTER officials auto-assign = 1"],
        }),
      ]),
    );
    const section = md.slice(md.indexOf("## Checker"));
    // The first verdict is still there…
    expect(section).toContain("CLEAN");
    // …with ITS OWN unexercised rule (rule 5, from the default fixture)…
    expect(section).toContain("Unexercised rules (1)");
    expect(section).toContain("`Rule 5 — not_before / not_after`");
    // …and the second is beside it, labelled as a CHANGE, with a DIFFERENT
    // (here, empty) unexercised list of its own.
    expect(section).toContain("After officials auto-assign — 1 FINDING(S)");
    expect(section).toContain("CHANGED from clean");
    expect(section).toContain("`official_double_booking` [fx-1, fx-2]");
    expect(section).toContain("Unexercised rules: none — every modelled rule had something to judge.");
  });

  it("says '(unchanged)' when the second pass agrees — a silent second pass is one nobody can tell ran", () => {
    const md = renderMarkdown(
      scheduledReport([
        divisionSchedule({
          checkerAfterOfficials: { clean: true, findings: [], unchecked: [], unexercised: [] },
        }),
      ]),
    );
    expect(md).toContain("After officials auto-assign — CLEAN (unchanged)");
  });

  it("renders no second verdict at all when auto-assign applied nothing", () => {
    const md = renderMarkdown(scheduledReport([divisionSchedule()]));
    expect(md).not.toContain("After officials auto-assign");
  });
});

describe("renderMarkdown — the cross-division court gate (F-T6-3)", () => {
  it("renders the section on ANY scheduled run, and says 'none' when it found nothing", () => {
    // Absence is the interesting state here: a reader who finds no section
    // cannot tell "checked, nothing found" from "never ran". So it renders
    // whenever a division was scheduled, not only when it fired.
    const md = renderMarkdown(scheduledReport([divisionSchedule()]));
    expect(md).toContain("## Cross-division court occupancy (run-level gate)");
    expect(md).toContain("none — checked across 1 division(s)");
  });

  it("names the court and BOTH sides of every clash", () => {
    const base = fullReport();
    const md = renderMarkdown({
      ...base,
      suites: base.suites.map((s) => ({
        ...s,
        scheduling: [divisionSchedule(), divisionSchedule({ divisionRef: "d-badminton" })],
        crossDivisionCourtClashes: [
          {
            courtId: "court-1",
            a: {
              divisionRef: "d-tiny",
              fixtureId: "fx-1",
              start: Date.parse("2099-01-01T09:00:00.000Z"),
              end: Date.parse("2099-01-01T09:30:00.000Z"),
            },
            b: {
              divisionRef: "d-badminton",
              fixtureId: "fx-bm-1",
              start: Date.parse("2099-01-01T09:15:00.000Z"),
              end: Date.parse("2099-01-01T09:45:00.000Z"),
            },
          },
        ],
      })),
    });
    expect(md).toContain("**1 clash(es)**");
    expect(md).toContain("court `court-1`");
    expect(md).toContain("d-tiny/fx-1");
    expect(md).toContain("d-badminton/fx-bm-1");
    // The instants, not merely the ids — a clash a reader cannot locate in
    // time is one they cannot act on.
    expect(md).toContain("2099-01-01T09:00:00.000Z .. 2099-01-01T09:30:00.000Z");
  });

  it("renders NOTHING for a report that scheduled nothing", () => {
    expect(renderMarkdown(fullReport())).not.toContain("Cross-division court occupancy");
  });
});
