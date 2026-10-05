// W1d ruling T2-PRED: ONE predicate for "this case has the shape recordPlanned
// writes" (state 🚫 or ░, and no check), exported from results.ts and used by
// every reader that must tell a planned case from a driven one — parity.ts,
// committed-plans.ts and merge.ts today, judge.ts and the summary after.
// Its expected values come from the engine's own declaration of what a planned
// case IS: decideState's answer for a 🚫 plan and a ░ plan, never a list typed
// here (TEST-STRATEGY 3).
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASE_STATES, decideState, isPlannedShape, parseResults, type CaseState, type CheckResult, type RunResults } from "../lib/results.ts";
import { runSlice } from "../run.ts";
import { deps, fakeBrowserRun } from "./run-deps.ts";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => { vi.restoreAllMocks(); });

/** The states decideState gives a case that is planned (🚫: the cell has no path; ░: planned, never run). */
const PLANNED: ReadonlySet<CaseState> = new Set([
  decideState({ checks: [], deferred: null, error: null, noPath: { wave: "W4", reason: "no path" } }).state,
  decideState({ checks: [], deferred: null, error: null, notRun: "no script yet" }).state,
]);
const check: CheckResult = { id: "I1", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence: [] };

describe("isPlannedShape", () => {
  it("the planned states are two and distinct (the sweep below would pass vacuously on an empty or single set)", () => {
    expect(PLANNED.size).toBe(2);
  });

  it("every state x {no check, one check}: planned exactly when the state is one decideState gives a planned case AND there is no check", () => {
    let checked = 0;
    for (const state of CASE_STATES) {
      for (const checks of [[], [check]]) {
        expect(isPlannedShape({ state, checks }), `${state} with ${checks.length} check(s)`).toBe(PLANNED.has(state) && checks.length === 0);
        checked++;
      }
    }
    expect(checked).toBe(CASE_STATES.length * 2);
    expect(CASE_STATES.filter((s) => PLANNED.has(s))).toHaveLength(2);
  });

  it("the empty case first: a case with no check in a driven state is NOT planned (the empty check list does not make a case planned)", () => {
    for (const state of CASE_STATES.filter((s) => !PLANNED.has(s))) expect(isPlannedShape({ state, checks: [] }), state).toBe(false);
  });

  it("it reads the shape only: the planned marker neither makes a driven case planned nor stops a planned-shaped one being so", () => {
    expect(isPlannedShape({ state: "works", checks: [check], planned: true } as never)).toBe(false);
    expect(isPlannedShape({ state: "not_run", checks: [] })).toBe(true);
  });
});

describe("through the real producer: what run.ts recordPlanned writes IS the shape, and a driven case with checks is not", () => {
  it("every marked case of a real --layer L2 run has the planned shape; every case with a check does not; both kinds were seen", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "w1d-ps-"));
    expect(await runSlice(deps({ openBrowserRun: async () => fakeBrowserRun().run }), ["--driver", "browser", "--layer", "L2", "--run-id", "ps1", "--report-dir", dir])).toBe(0);
    const r = parseResults(JSON.parse(readFileSync(join(dir, "ps1", "results.json"), "utf8"))) as RunResults;
    const marked = r.cases.filter((c) => c.planned === true);
    const withChecks = r.cases.filter((c) => c.checks.length > 0);
    expect(marked.length).toBeGreaterThan(0);
    expect(withChecks.length).toBeGreaterThan(0);
    expect(marked.every((c) => isPlannedShape(c))).toBe(true);
    expect(withChecks.some((c) => isPlannedShape(c))).toBe(false);
  });
});

describe("one predicate, not copies (T2-PRED)", () => {
  const read = (rel: string): string => readFileSync(join(MATRIX, rel), "utf8");
  const tsIn = (rel: string): string[] => readdirSync(join(MATRIX, rel), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => `${rel}/${e.name}`);
  const files = [...tsIn("lib"), ...tsIn("."), "__tests__/committed-plans.ts"];
  // The set of planned states, written as a literal anywhere is a second predicate.
  const COPY = /new Set(?:<[^>]*>)?\(\s*\[\s*"(?:no_path|not_run)"\s*,\s*"(?:no_path|not_run)"\s*\]\s*\)/;

  it("the planned-state set is written once, in results.ts (the scan saw the files, and finds its own positive control)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(COPY.test('const X = new Set<CaseState>(["no_path", "not_run"]);')).toBe(true);
    expect(files.filter((f) => COPY.test(read(f)))).toEqual(["lib/results.ts"]);
  });

  it("parity.ts, committed-plans.ts, merge.ts and judge.ts each ask isPlannedShape", () => {
    for (const f of ["lib/parity.ts", "__tests__/committed-plans.ts", "lib/merge.ts", "lib/judge.ts"]) expect(read(f), f).toMatch(/\bisPlannedShape\(/);
  });
});
