// W1c Task 13: parity — the HTTP and the browser verdicts compared per case
// (ruling 37: one verdict pipeline, so parity is a JSON diff).
//
// The cases' expected values come from the committed evidence (the
// walkthrough-a runs and Task 8's hand comparison in their README, W1b's v2
// slice), from the real planners (layers.ts planL2 over the committed
// l2-pairs.json, slice.ts planSliceCases) and from the catalogue's own
// atom→script declaration — never from lib/parity.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cellId } from "../lib/catalogue.ts";
import { identityOf, layerCaseId, planL2 } from "../lib/layers.ts";
import { padProofPlanner } from "../lib/pad-proof-set.ts";
import { loadL2Pairs } from "../lib/pairs.ts";
import {
  BROWSER_ONLY_PREFIXES, DuplicateId, WidthSuffixMismatch, WrongDriver,
  compareRuns, headerLine, httpKeyOf, isBrowserOnly, parityVerdict, renderParity, type ParityReport,
} from "../lib/parity.ts";
import { CASE_STATES, decideState, parseResults, type AnyRunResults, type CaseResult, type CheckResult, type DriverKind, type Verdict } from "../lib/results.ts";
import { SLICE_ROWS, SLICE_SPORTS, planSliceCases } from "../lib/slice.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");
const TRUTH = join(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs");
const WA = join(TRUTH, "w1c-walkthrough-a");
const readRun = (path: string): AnyRunResults => parseResults(JSON.parse(readFileSync(path, "utf8")));

const A = "league|generic|score|LIFECYCLE";
const B = "knockout|generic|score|LIFECYCLE";
const C = "swiss|generic|score|LIFECYCLE";
const RUNS = { http: "r-http", browser: "r-browser" };
/** A report with nothing outside the browser plan and nothing planned without a script. */
const NONE = { notDriven: [], outsidePlan: [] };

const chk = (id: string, verdict: Verdict = "pass", checked = 2): CheckResult => ({ id, kind: "assertion", verdict, checked, reason: "", evidence: [] });
/** Checks both drivers run (ids as the committed runs name them). */
const COMMON = (): CheckResult[] => [chk("I1-rr-pair-once-per-leg", "pass", 28), chk("life-fold-parity", "pass", 28), chk("life-draw-path-exercised", "abstain", 0)];
/** Browser-only checks, ids as the committed walkthrough-a browser runs record them. */
const BROWSER_EXTRA = (): CheckResult[] => [
  chk("organiser-ui-path", "pass", 1), chk("builder-posted-as-harness", "pass", 1), chk("ui-standings-match", "pass", 1),
  chk("pad-ledger-as-generated", "pass", 2), chk("mixed-driver-coverage", "pass", 9), chk("visual-evidence", "pass", 19), chk("no-horizontal-scroll", "pass", 19),
];

/** A v3 case as the runner writes it; `caseId` is taken as given (a browser one carries its `@<width>`). */
function aCase(caseId: string, driver: DriverKind, width: number | null, over: Partial<CaseResult> = {}): CaseResult {
  const [row = "league", sport = "generic", variant = "score", scenario = "LIFECYCLE"] = caseId.replace(/@\d+$/, "").split("|");
  return {
    caseId, row, sport, variant, scenario, canary: false, state: "works", reason: "",
    checks: driver === "http" ? COMMON() : [...COMMON(), ...BROWSER_EXTRA()],
    counts: { calls: 1, fixtures: 1, events: 1 }, durationMs: 1, notes: [],
    layer: driver === "http" ? "L3" : width === 1280 ? "L1" : "L2", driver, width, ...over,
  };
}
const httpCase = (caseId: string, over: Partial<CaseResult> = {}) => aCase(caseId, "http", null, over);
const browserCase = (caseId: string, width: number, over: Partial<CaseResult> = {}) => aCase(`${caseId}@${width}`, "browser", width, over);
/** Through the real schema, so a fixture that drifted from results.json's shape reds here, not in parity. */
const runOf = (driver: DriverKind, cases: readonly CaseResult[]): AnyRunResults => parseResults({
  schemaVersion: 3, runId: `r-${driver}`, harnessCommit: "abc", startedAt: "s", finishedAt: "f",
  grid: { rows: ["league", "knockout", "swiss"], sports: ["generic", "badminton"] },
  layer: driver === "http" ? "L3" : "L1", driver, cases,
});

/** Walkthrough-a: each HTTP run and the browser legs of the same cell (Task 8). */
const WA_PAIRS: readonly (readonly [string, string])[] = ["generic", "badminton"].flatMap((sport) =>
  ["1280-f", "320a", "320b", "320c"].map((leg) => [`w1c-wa-http-f-${sport}`, `w1c-wa-${leg}-${sport}`] as const));
/** Task 8's hand comparison, walkthrough-a README.md line 16: "Parity (HTTP vs
 *  browser, 17 common checks): identical in every run." */
const WA_COMMON_CHECKS = 17;
/** Every check id a committed walkthrough-a browser leg records that its HTTP run does not. */
function walkthroughBrowserOnly(): { browserOnly: Set<string>; httpIds: Set<string>; pairs: number } {
  const browserOnly = new Set<string>(), httpIds = new Set<string>();
  let pairs = 0;
  for (const [h, b] of WA_PAIRS) {
    const own = new Set(readRun(join(WA, h, "results.json")).cases.flatMap((c) => c.checks.map((k) => k.id)));
    for (const id of own) httpIds.add(id);
    for (const c of readRun(join(WA, b, "results.json")).cases) for (const k of c.checks) if (!own.has(k.id)) browserOnly.add(k.id);
    pairs++;
  }
  return { browserOnly, httpIds, pairs };
}

describe("compareRuns", () => {
  it("empty case first: two results with no common case is exit 1 'compared 0' — never parity", () => {
    const empty = compareRuns(runOf("http", []), runOf("browser", []));
    expect(empty).toEqual({ compared: 0, checks: 0, diffs: [], ...NONE });
    // No difference at all, and still not parity: nothing was compared.
    expect(parityVerdict(empty).code).toBe(1);
    expect(parityVerdict(empty).line).toMatch(/compared 0/);
    expect(renderParity(empty, RUNS)).toContain("compared 0 cases, 0 common checks, 0 differences");
    // Two runs that each hold a case, and share none: the browser case is a
    // missing row, the HTTP case lies outside the browser plan (listed, not a
    // diff), and it is still "compared 0".
    const apart = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(B, 1280)]));
    expect(apart.compared).toBe(0);
    expect(apart.diffs.map((d) => [d.kind, d.caseId])).toEqual([["missing", `${B}@1280`]]);
    expect(apart.outsidePlan).toEqual([A]);
    expect(parityVerdict(apart).code).toBe(1);
    expect(parityVerdict(apart).line).toMatch(/compared 0/);
  });

  it("anti-vacuity: a pair with no common check is a `vacuous` row unless both its state and its reason match; a run with no common check at all is never parity", () => {
    const later = { state: "later" as const, reason: "W1-driving: deferred", checks: [] };
    // One pair, the same deferral on both drivers: no row — but nothing was
    // compared, so the run is never parity.
    const none = compareRuns(runOf("http", [httpCase(A, later)]), runOf("browser", [browserCase(A, 1280, later)]));
    expect(none).toEqual({ compared: 1, checks: 0, diffs: [], ...NONE });
    expect(parityVerdict(none).code).toBe(1);
    expect(parityVerdict(none).line).toMatch(/0 common checks/);
    // Review I-1: beside a good pair, a pair that errored on BOTH drivers for
    // different reasons is a row. The same state label is not the same verdict.
    const errored = (reason: string) => ({ state: "red" as const, reason, checks: [] });
    const both = compareRuns(
      runOf("http", [httpCase(A), httpCase(B, errored("error: HTTP 500 on POST /stages"))]),
      runOf("browser", [browserCase(A, 1280), browserCase(B, 1280, errored("error: selector timeout stage-rail"))]),
    );
    expect(both.compared).toBe(2);
    expect(both.checks).toBe(COMMON().length);
    expect(both.diffs).toEqual([{ caseId: `${B}@1280`, kind: "vacuous", id: null, http: "red: error: HTTP 500 on POST /stages", browser: "red: error: selector timeout stage-rail" }]);
    expect(parityVerdict(both).code).toBe(1);
    // The same state, a different reason (each driver deferred to another wave): a row too.
    const waves = compareRuns(runOf("http", [httpCase(A), httpCase(B, later)]), runOf("browser", [browserCase(A, 1280), browserCase(B, 1280, { ...later, reason: "W4: deferred" })]));
    expect(waves.diffs.map((d) => [d.kind, d.caseId])).toEqual([["vacuous", `${B}@1280`]]);
    // Positive pairs: the same deferral beside a good pair is agreed, no row, parity;
    // and one common check on its own is parity.
    const agreed = compareRuns(runOf("http", [httpCase(A), httpCase(B, later)]), runOf("browser", [browserCase(A, 1280), browserCase(B, 1280, later)]));
    expect(agreed).toEqual({ compared: 2, checks: COMMON().length, diffs: [], ...NONE });
    expect(parityVerdict(agreed)).toEqual({ code: 0, line: "PARITY" });
    const one = compareRuns(runOf("http", [httpCase(A, { checks: [chk("life-loop-bounded")] })]), runOf("browser", [browserCase(A, 1280, { checks: [chk("life-loop-bounded")] })]));
    expect(one).toEqual({ compared: 1, checks: 1, diffs: [], ...NONE });
    expect(parityVerdict(one)).toEqual({ code: 0, line: "PARITY" });
  });

  it("caseIds match after stripping @width; one browser width per http case is compared, and several widths each compared", () => {
    const one = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280)]));
    expect(one).toEqual({ compared: 1, checks: COMMON().length, diffs: [], ...NONE });
    expect(parityVerdict(one)).toEqual({ code: 0, line: "PARITY" });
    // Several widths of one HTTP case: each is compared on its own, and a
    // difference at one width names that width's case.
    const widths = [320, 375, 1280];
    const several = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", widths.map((w) => browserCase(A, w, w === 375 ? { state: "red" } : {}))));
    expect(several.compared).toBe(widths.length);
    expect(several.checks).toBe(widths.length * COMMON().length);
    expect(several.diffs).toEqual([{ caseId: `${A}@375`, kind: "state", id: null, http: "works", browser: "red" }]);
    // The suffix stripped is the case's OWN width: an id at one width recorded
    // at another, or no suffix at all, cannot be paired and is refused by name.
    expect(() => compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [aCase(`${A}@320`, "browser", 375)]))).toThrow(WidthSuffixMismatch);
    expect(() => compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [aCase(A, "browser", 1280)]))).toThrow(/league\|generic\|score\|LIFECYCLE.*1280/);
  });

  it("a state difference is a row; a common check whose verdict OR checked differs is a row", () => {
    const h = httpCase(A, { checks: [chk("I1-rr-pair-once-per-leg", "pass", 28), chk("I3-table-points-equal-declared", "pass", 8), chk("I4-nothing-ends-stuck", "pass", 37), chk("I5-config-edit-never-rescores", "pass", 28)] });
    const b = browserCase(A, 1280, {
      state: "red",
      checks: [
        chk("I1-rr-pair-once-per-leg", "pass", 28), // the same: no row
        chk("I3-table-points-equal-declared", "fail", 8), // the verdict differs
        chk("I4-nothing-ends-stuck", "pass", 36), // only `checked` differs: a run that checked fewer items is not the same verdict
        chk("I5-config-edit-never-rescores", "fail", 27), // both differ: one row
        ...BROWSER_EXTRA(),
      ],
    });
    const r = compareRuns(runOf("http", [h]), runOf("browser", [b]));
    expect(r.compared).toBe(1);
    expect(r.checks).toBe(4);
    const at = `${A}@1280`;
    expect(r.diffs).toEqual([
      { caseId: at, kind: "state", id: null, http: "works", browser: "red" },
      { caseId: at, kind: "check", id: "I3-table-points-equal-declared", http: "pass/8", browser: "fail/8" },
      { caseId: at, kind: "check", id: "I4-nothing-ends-stuck", http: "pass/37", browser: "pass/36" },
      { caseId: at, kind: "check", id: "I5-config-edit-never-rescores", http: "pass/28", browser: "fail/27" },
    ]);
    expect(parityVerdict(r).code).toBe(1);
  });

  it("browser-only checks are ignored by prefix, and a browser-only check appearing in the http run is itself a diff", () => {
    // In the browser run: ignored, and never counted as common.
    const extra = [...COMMON(), ...BROWSER_EXTRA(), chk("ui-champion-shown", "abstain", 0), chk("pad-route", "abstain", 0), chk("finalize-ledger-row", "pass", 3)];
    const ignored = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280, { checks: extra })]));
    expect(ignored).toEqual({ compared: 1, checks: COMMON().length, diffs: [], ...NONE });
    // In the HTTP run: a row, whatever the browser recorded. The HTTP driver
    // never emits one, so its presence means the run was mislabeled.
    const mislabeled = compareRuns(runOf("http", [httpCase(A, { checks: [...COMMON(), chk("ui-standings-match", "pass", 1)] })]), runOf("browser", [browserCase(A, 1280)]));
    expect(mislabeled.diffs).toEqual([{ caseId: `${A}@1280`, kind: "check", id: "ui-standings-match", http: expect.stringMatching(/^pass\/1 .*browser-only/), browser: "pass/1" }]);
    expect(mislabeled.checks).toBe(COMMON().length);
    // A check that is NOT browser-only, run on one side only, is a row either way.
    const onlyBrowser = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280, { checks: [...COMMON(), ...BROWSER_EXTRA(), chk("life-stage-completed", "pass", 1)] })]));
    expect(onlyBrowser.diffs).toEqual([{ caseId: `${A}@1280`, kind: "check", id: "life-stage-completed", http: "absent", browser: "pass/1" }]);
    const onlyHttp = compareRuns(runOf("http", [httpCase(A, { checks: [...COMMON(), chk("life-stage-completed", "pass", 1)] })]), runOf("browser", [browserCase(A, 1280)]));
    expect(onlyHttp.diffs).toEqual([{ caseId: `${A}@1280`, kind: "check", id: "life-stage-completed", http: "pass/1", browser: "absent" }]);
  });

  it("a browser case absent from the HTTP run is a `missing` row; an HTTP case outside the browser plan is listed, never a diff", () => {
    const r = compareRuns(runOf("http", [httpCase(A), httpCase(B)]), runOf("browser", [browserCase(A, 1280), browserCase(C, 1280)]));
    expect(r.compared).toBe(1);
    expect(r.diffs).toEqual([{ caseId: `${C}@1280`, kind: "missing", id: null, http: "absent", browser: "works" }]);
    expect(r.outsidePlan).toEqual([B]);
    expect(r.notDriven).toEqual([]);
    expect(parityVerdict(r).code).toBe(1);
    // The controller's scope ruling: parity compares the BROWSER run's plan. An
    // HTTP case outside it is listed by id (results.json names no plan, so the
    // ids are the only way to see a mis-paired HTTP file) and costs no exit.
    const outside = compareRuns(runOf("http", [httpCase(A), httpCase(B)]), runOf("browser", [browserCase(A, 1280)]));
    expect(outside).toEqual({ compared: 1, checks: COMMON().length, diffs: [], notDriven: [], outsidePlan: [B] });
    expect(parityVerdict(outside)).toEqual({ code: 0, line: "PARITY" });
  });

  // The scope ruling's exemption: a browser case is "planned, not driven" only
  // when all three hold — it maps to no harness script, its state is 🚫 or ░,
  // and it carries no check (run.ts recordPlanned's exact shape).
  const PLANNED = ["no_path", "not_run"] as const;
  it("an unmapped browser case is 'not driven' only when 🚫/░ with no check; in any other state it stays `missing` (a PADPROOF run fed to parity)", () => {
    const atom = (n: number) => `swiss|generic|score|X${n}`;
    let checked = 0;
    for (const [i, state] of CASE_STATES.entries()) {
      const r = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280), browserCase(atom(i), 375, { state, reason: "r", checks: [] })]));
      if ((PLANNED as readonly string[]).includes(state)) {
        expect({ state, notDriven: r.notDriven, diffs: r.diffs }).toEqual({ state, notDriven: [{ caseId: `${atom(i)}@375`, state }], diffs: [] });
      } else {
        expect({ state, notDriven: r.notDriven }).toEqual({ state, notDriven: [] });
        expect(r.diffs, state).toEqual([{ caseId: `${atom(i)}@375`, kind: "missing", id: null, http: "absent", browser: expect.stringMatching(new RegExp(`^${state} — .*no harness script`)) }]);
      }
      checked++;
    }
    expect(checked).toBe(CASE_STATES.length);
    // The real pad-proof plan: every case is PADPROOF, unmapped, and works with checks.
    const pad = padProofPlanner({}).plan(() => "default").map((s) => aCase(`${s.caseId}@1280`, "browser", 1280));
    expect(pad.length).toBeGreaterThan(0);
    const padR = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", pad));
    expect(padR.notDriven).toEqual([]);
    expect(padR.diffs.map((d) => d.kind)).toEqual(pad.map(() => "missing"));
  });

  it("an unmapped ░ case that carries a check is still `missing` — a planned case never ran one", () => {
    const planned = browserCase("swiss|generic|score|X9", 375, { state: "not_run", reason: "no scenario script yet (atom X9)", checks: [chk("life-loop-bounded")] });
    const r = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280), planned]));
    expect(r.notDriven).toEqual([]);
    expect(r.diffs.map((d) => [d.kind, d.caseId])).toEqual([["missing", planned.caseId]]);
  });

  // W1d item 3 (m-6): recordPlanned writes `planned: true`, and parity keys on
  // it first. The LIFECYCLE mapping alone read an API-only row's planned 🚫 —
  // whose scenario IS scripted, so its key maps — as a "missing" HTTP case.
  describe("the planned marker (W1d item 3)", () => {
    const API_ONLY = "page_playoff_only|generic|score|LIFECYCLE";
    const reason = "W4: no organiser control builds page_playoff_only";
    const plannedRow = (over: Partial<CaseResult> = {}) => browserCase(API_ONLY, 1280, { state: "no_path", reason, checks: [], ...over });

    it("a browser case carrying planned: true is notDriven even when its key maps; the same case without the marker is a `missing` row", () => {
      const http = runOf("http", [httpCase(A)]);
      const marked = compareRuns(http, runOf("browser", [browserCase(A, 1280), plannedRow({ planned: true })]));
      expect(marked).toEqual({ compared: 1, checks: COMMON().length, diffs: [], notDriven: [{ caseId: `${API_ONLY}@1280`, state: "no_path" }], outsidePlan: [] });
      // The control: a mapped key is the only difference, so this is the shape the marker exists for.
      expect(httpKeyOf(plannedRow())).toEqual({ key: API_ONLY });
      const unmarked = compareRuns(http, runOf("browser", [browserCase(A, 1280), plannedRow()]));
      expect(unmarked.notDriven).toEqual([]);
      expect(unmarked.diffs).toEqual([{ caseId: `${API_ONLY}@1280`, kind: "missing", id: null, http: "absent", browser: "no_path" }]);
    });

    it("a case with no checks, ░, and NO marker on an unmapped key is still notDriven (old evidence keeps its meaning)", () => {
      const old = browserCase("swiss|generic|score|X7", 375, { state: "not_run", reason: "no scenario script yet (atom X7)", checks: [] });
      expect("planned" in old).toBe(false);
      expect(httpKeyOf(old)).toHaveProperty("unmapped");
      const r = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280), old]));
      expect({ compared: r.compared, diffs: r.diffs, notDriven: r.notDriven }).toEqual({ compared: 1, diffs: [], notDriven: [{ caseId: old.caseId, state: "not_run" }] });
    });

    it("the marker exempts only recordPlanned's exact shape: a marked case with a check, or in a state recordPlanned never writes, is compared (a suppressed red is not a quiet one)", () => {
      const http = runOf("http", [httpCase(A)]);
      const cases: [string, Partial<CaseResult>][] = [
        ["a check", { planned: true, checks: [chk("life-loop-bounded")] }],
        ["a works state", { planned: true, state: "works", reason: "1 checks, 2 items" }],
        ["a red state", { planned: true, state: "red", reason: "error: boom" }],
      ];
      let checked = 0;
      for (const [what, over] of cases) {
        const r = compareRuns(http, runOf("browser", [browserCase(A, 1280), plannedRow(over)]));
        expect(r.notDriven, what).toEqual([]);
        expect(r.diffs.map((d) => [d.kind, d.caseId]), what).toEqual([["missing", `${API_ONLY}@1280`]]);
        checked++;
      }
      expect(checked).toBe(cases.length);
    });

    it("a marked ⛔/░ mix beside driven cases: every marked case is listed, none compared, and the count of each is exact", () => {
      // Both keys MAP (LIFECYCLE is scripted) and neither is in the HTTP run, so only the marker keeps them out of `diffs`.
      const marked = [["no_path", "page_playoff_only"], ["not_run", "stepladder_only"]].map(([state, row]) => browserCase(`${row}|generic|score|LIFECYCLE`, 1280, { state: state as CaseResult["state"], reason: `r-${row}`, checks: [], planned: true }));
      const r = compareRuns(runOf("http", [httpCase(A), httpCase(B)]), runOf("browser", [browserCase(A, 1280), browserCase(B, 1280), ...marked]));
      expect({ compared: r.compared, diffs: r.diffs, notDriven: r.notDriven.map((n) => n.state) }).toEqual({ compared: 2, diffs: [], notDriven: ["no_path", "not_run"] });
    });
  });

  it("a MAPPED case that hit no_path at runtime is compared: against HTTP works it is one state row (m-3: no absent-check rows beside it)", () => {
    const runtime = browserCase(A, 1280, { state: "no_path", reason: "W5: no organiser path", checks: [] });
    const r = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [runtime]));
    expect(r.compared).toBe(1);
    expect(r.notDriven).toEqual([]);
    expect(r.diffs).toEqual([{ caseId: `${A}@1280`, kind: "state", id: null, http: "works", browser: "no_path" }]);
    // Same for a checkless HTTP side: one fact, one row.
    const httpErr = compareRuns(runOf("http", [httpCase(A, { state: "red", reason: "error: HTTP 500", checks: [] })]), runOf("browser", [browserCase(A, 1280)]));
    expect(httpErr.diffs).toEqual([{ caseId: `${A}@1280`, kind: "state", id: null, http: "red", browser: "works" }]);
    // Both sides with checks keep their per-check rows (the quiet rule is only for a checkless side).
    const withChecks = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280, { state: "red", checks: [chk("I1-rr-pair-once-per-leg", "pass", 28), ...BROWSER_EXTRA()] })]));
    expect(withChecks.diffs.map((d) => d.kind)).toEqual(["state", "check", "check"]);
  });

  // W1d item 10 (Task 13). `quiet` is the rule that a state row already says what a checkless side cannot: it holds only
  // when ONE side ran no check AND the two states differ. The two tests below are its two edges.
  describe("compareChecks' quiet rule (W1d item 10)", () => {
    const errorRed = (checks: CheckResult[]): Partial<CaseResult> => {
      const { state, reason } = decideState({ checks, deferred: null, error: "TimeoutError: locator.waitFor: Timeout 15000ms exceeded.", mandated: null, noPath: null });
      return { state, reason, checks };
    };

    it("a browser error red that KEPT its checks, against an HTTP works case, lists the state row and each check row (the http checks it never reached are absent rows)", () => {
      // The browser threw after two checks: it kept the common one and its own browser-only one.
      const kept = [chk("I1-rr-pair-once-per-leg", "pass", 28), chk("organiser-ui-path", "pass", 1)];
      const over = errorRed(kept);
      expect(over.state, "the premise: the shape is an error red").toBe("red");
      expect(over.reason).toMatch(/^error: TimeoutError/);
      const r = compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280, over)]));
      // The http works case ran I1 (pass/28, matched), life-fold-parity (pass/28) and life-draw-path-exercised (abstain/0).
      expect(r.diffs).toEqual([
        { caseId: `${A}@1280`, kind: "state", id: null, http: "works", browser: "red" },
        { caseId: `${A}@1280`, kind: "check", id: "life-fold-parity", http: "pass/28", browser: "absent" },
        { caseId: `${A}@1280`, kind: "check", id: "life-draw-path-exercised", http: "abstain/0", browser: "absent" },
      ]);
      // The one matched check is counted, and the browser-only one is neither a row nor common.
      expect(r.checks).toBe(1);
    });

    it("equal states with one side check-less is NOT quiet: nothing else says the missing checks are missing", () => {
      // Both red, so there is no state row; the checkless side's absent rows are the only difference there is.
      const both = errorRed([chk("I1-rr-pair-once-per-leg", "pass", 28), chk("life-fold-parity", "pass", 28)]);
      const none = errorRed([]);
      expect(none.state).toBe(both.state);
      const httpEmpty = compareRuns(runOf("http", [httpCase(A, none)]), runOf("browser", [browserCase(A, 1280, { ...both, checks: [...both.checks!, chk("organiser-ui-path", "pass", 1)] })]));
      expect(httpEmpty.diffs).toEqual([
        { caseId: `${A}@1280`, kind: "check", id: "I1-rr-pair-once-per-leg", http: "absent", browser: "pass/28" },
        { caseId: `${A}@1280`, kind: "check", id: "life-fold-parity", http: "absent", browser: "pass/28" },
      ]);
      const browserEmpty = compareRuns(runOf("http", [httpCase(A, both)]), runOf("browser", [browserCase(A, 1280, none)]));
      expect(browserEmpty.diffs).toEqual([
        { caseId: `${A}@1280`, kind: "check", id: "I1-rr-pair-once-per-leg", http: "pass/28", browser: "absent" },
        { caseId: `${A}@1280`, kind: "check", id: "life-fold-parity", http: "pass/28", browser: "absent" },
      ]);
      // The control pair: the same two sides in DIFFERENT states are quiet — one state row, no check rows.
      const differ = compareRuns(runOf("http", [httpCase(A, { state: "works", reason: "2 checks, 56 items", checks: both.checks })]), runOf("browser", [browserCase(A, 1280, none)]));
      expect(differ.diffs).toEqual([{ caseId: `${A}@1280`, kind: "state", id: null, http: "works", browser: "red" }]);
    });
  });

  it("an all-🚫/░ browser run is 'compared 0' and never parity", () => {
    const r = compareRuns(runOf("http", [httpCase(A), httpCase(B)]), runOf("browser", [
      browserCase("swiss|generic|score|X1", 375, { state: "no_path", reason: "W4: none", checks: [] }),
      browserCase("swiss|generic|score|X2", 390, { state: "not_run", reason: "no scenario script yet (atom X2)", checks: [] }),
    ]));
    expect(r).toEqual({ compared: 0, checks: 0, diffs: [], notDriven: [{ caseId: "swiss|generic|score|X1@375", state: "no_path" }, { caseId: "swiss|generic|score|X2@390", state: "not_run" }], outsidePlan: [A, B] });
    expect(parityVerdict(r).code).toBe(1);
    expect(parityVerdict(r).line).toMatch(/compared 0/);
  });

  it("v2 http evidence (no layer/driver/width) parses as http", () => {
    const v2 = readRun(join(TRUTH, "w1b-slice", "results.json"));
    expect(v2.schemaVersion).toBe(2);
    expect(v2.cases.length).toBeGreaterThan(0);
    expect(v2.cases.filter((c) => "width" in c || "driver" in c || "layer" in c)).toEqual([]);
    // Its browser twin at 1280: the same verdicts, plus the browser's own checks.
    const twin = (edit: (c: CaseResult, i: number) => CaseResult = (c) => c) => runOf("browser", v2.cases.map((c, i) =>
      edit({ ...c, caseId: `${c.caseId}@1280`, checks: [...c.checks, ...BROWSER_EXTRA()], layer: "L1", driver: "browser", width: 1280 }, i)));
    const r = compareRuns(v2, twin());
    expect(r).toEqual({ compared: v2.cases.length, checks: v2.cases.reduce((n, c) => n + c.checks.length, 0), diffs: [], ...NONE });
    expect(parityVerdict(r).code).toBe(0);
    // The committed checks were read, not skipped: one `checked` moved on the browser side is a row.
    const first = v2.cases[0]!.checks[0]!;
    const moved = compareRuns(v2, twin((c, i) => (i === 0 ? { ...c, checks: [{ ...first, checked: first.checked + 1 }, ...c.checks.slice(1)] } : c)));
    expect(moved.diffs).toEqual([{ caseId: `${v2.cases[0]!.caseId}@1280`, kind: "check", id: first.id, http: `${first.verdict}/${first.checked}`, browser: `${first.verdict}/${first.checked + 1}` }]);
    // The slots: a v2 run is an HTTP run, so it cannot be the browser side, and a browser run cannot be the HTTP side.
    expect(() => compareRuns(v2, v2)).toThrow(WrongDriver);
    expect(() => compareRuns(twin(), twin())).toThrow(WrongDriver);
    expect(() => compareRuns(twin(), v2)).toThrow(/http run/);
  });

  it("ruling (a) and the scope ruling: a committed L2 run's atom pairs with the HTTP script the catalogue maps it to; a scriptless 🚫/░ case is listed as not driven, never dropped and never a diff", () => {
    const cells = new Set(SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => cellId(r, s))));
    const planned = planL2(loadL2Pairs(), cells);
    const driven = planned.filter((c) => c.spec !== null);
    const scriptless = planned.filter((c) => c.spec === null);
    // The atoms whose script has another name (R4a runs as R4): the case this ruling exists for.
    const renamed = driven.filter((c) => c.run !== null && c.spec !== null && c.run.scenario !== c.spec.scenario);
    console.info(`parity: ${planned.length} committed L2 runs on the slice — ${driven.length} driven (${renamed.length} renamed atom), ${scriptless.length} with no script`);
    expect(renamed.length).toBeGreaterThan(0);
    expect(scriptless.length).toBeGreaterThan(0);
    // The HTTP side: the slice as L3 plans it, at the variants the committed
    // W1b slice ran (review m-2: never read back from l2-pairs.json, so a
    // committed preset that drifts from the builder default reds here).
    const ranVariant = new Map(readRun(join(TRUTH, "w1b-slice", "results.json")).cases.map((c) => [c.sport, c.variant]));
    const presetOf = (sport: string): string => {
      const v = ranVariant.get(sport);
      if (v === undefined) throw new Error(`test: the committed w1b-slice ran no ${sport} case`);
      return v;
    };
    const httpCases = planSliceCases(presetOf).map((s) => httpCase(s.caseId, { scenario: s.scenario }));
    // The browser side: every planned case under the id the runner writes, the
    // 🚫/░ ones in run.ts recordPlanned's shape. With the renamed atoms red,
    // each pairing shows up as a state row naming ITS case.
    const browserCases = (renamedState: "red" | "works") => planned.map((c) => aCase(layerCaseId(c), "browser", c.width, c.spec === null
      ? { scenario: identityOf(c).scenario, state: c.noPath !== null ? "no_path" : "not_run", checks: [] }
      : { scenario: c.spec.scenario, state: renamed.includes(c) ? renamedState : "works" }));
    const r = compareRuns(runOf("http", httpCases), runOf("browser", browserCases("red")));
    expect(r.compared).toBe(driven.length);
    expect(r.diffs.filter((d) => d.kind === "state")).toEqual(renamed.map((c) => ({ caseId: layerCaseId(c), kind: "state", id: null, http: "works", browser: "red" })));
    expect(r.diffs.filter((d) => d.kind !== "state")).toEqual([]);
    // Every scriptless atom is listed as not driven, with its planned state —
    // none dropped, none a diff.
    expect(r.notDriven).toEqual(scriptless.map((c) => ({ caseId: layerCaseId(c), state: c.noPath !== null ? "no_path" : "not_run" })));
    // And every HTTP case no L2 run drove lies outside the browser plan. The
    // keys paired are the planner's own (spec.scenario is the script).
    const paired = new Set(driven.map((c) => [c.spec!.row, c.spec!.sport, c.spec!.variant, c.spec!.scenario].join("|")));
    expect([...paired].filter((k) => !httpCases.some((h) => h.caseId === k))).toEqual([]);
    expect(r.outsidePlan).toEqual(httpCases.map((h) => h.caseId).filter((id) => !paired.has(id)));
    expect(r.outsidePlan.length).toBeGreaterThan(0);
    // Positive: the same L2 run with the driven cases agreeing is parity, exit 0.
    const agreed = compareRuns(runOf("http", httpCases), runOf("browser", browserCases("works")));
    expect({ compared: agreed.compared, diffs: agreed.diffs, notDriven: agreed.notDriven.length, outsidePlan: agreed.outsidePlan.length })
      .toEqual({ compared: driven.length, diffs: [], notDriven: scriptless.length, outsidePlan: httpCases.length - paired.size });
    expect(parityVerdict(agreed)).toEqual({ code: 0, line: "PARITY" });
  });

  it("ruling (b): the committed walkthrough-a legs, each against its HTTP run — 1 case, 17 common checks, 0 differences (Task 8's hand parity)", () => {
    let pairs = 0, l1At320 = 0;
    for (const [h, b] of WA_PAIRS) {
      const http = readRun(join(WA, h, "results.json"));
      const browser = readRun(join(WA, b, "results.json"));
      // The README's 17 is every check the HTTP case ran.
      expect(http.cases.map((c) => c.checks.length), h).toEqual([WA_COMMON_CHECKS]);
      const r = compareRuns(http, browser);
      expect({ b, ...r }).toEqual({ b, compared: 1, checks: WA_COMMON_CHECKS, diffs: [], ...NONE });
      expect(parityVerdict(r).code, b).toBe(0);
      l1At320 += browser.schemaVersion === 3 ? browser.cases.filter((c) => c.layer === "L1" && c.width === 320).length : 0;
      pairs++;
    }
    expect(pairs).toBe(8);
    // The witness that parity never compares the layer: the 320 legs were
    // written before Task 12's fix and label themselves L1 at 320.
    expect(l1At320).toBe(6);
  });

  it("ruling (c): every browser-only check id the committed walkthrough-a legs record is covered by a prefix, and no HTTP check id is", () => {
    const { browserOnly, httpIds, pairs } = walkthroughBrowserOnly();
    console.info(`parity: ${pairs} walkthrough-a pairs, ${browserOnly.size} browser-only ids, ${httpIds.size} HTTP ids`);
    expect(pairs).toBe(8);
    expect(browserOnly.size).toBeGreaterThan(0);
    expect(httpIds.size).toBeGreaterThan(0);
    expect([...browserOnly].filter((id) => !isBrowserOnly(id))).toEqual([]);
    expect([...httpIds].filter((id) => isBrowserOnly(id))).toEqual([]);
    // Review m-8: the inverse half over EVERY committed HTTP run (W1a, W1b,
    // W1c; every scenario and invariant), not only LIFECYCLE's ids. Tracked
    // files only, so an untracked local run cannot change the answer.
    const tracked = execFileSync("git", ["ls-files", "--", "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/*results.json"], { cwd: REPO, encoding: "utf8" }).split("\n").filter((f) => f !== "");
    const httpRuns = tracked.map((f) => readRun(join(REPO, f))).filter((r) => r.schemaVersion === 2 || r.driver === "http");
    const everyHttpId = new Set(httpRuns.flatMap((r) => r.cases.flatMap((c) => c.checks.map((k) => k.id))));
    console.info(`parity: ${tracked.length} committed results.json, ${httpRuns.length} HTTP runs, ${everyHttpId.size} HTTP check ids`);
    expect(httpRuns.length).toBeGreaterThan(2);
    expect(everyHttpId.size).toBeGreaterThan(httpIds.size);
    expect([...everyHttpId].filter((id) => isBrowserOnly(id))).toEqual([]);
  });

  // The browser driver is the authority on what it emits; each of these
  // modules runs only under --driver browser. finalize-ledger-row is its proof
  // of the console's Finalize route (controller ruling D: parity compares the
  // recorded outcome, never the route), so no HTTP case has one to compare.
  // The PADPROOF scenario runs only in --set pad-proof, which needs the browser
  // (pad-proof-set.ts needsBrowser); its OWN literal ids are scanned (review
  // m-1) — the life-* checks it borrows from assertions.ts are common ones.
  const EMITTERS = ["lib/driver/browser-driver.ts", "lib/driver/mixed.ts", "lib/browser/evidence.ts", "lib/scenarios/pad-proof.ts"];
  const CHECK_ID = /(?:\bassertion\(\s*|\bid:\s*|\bconst id = )"([a-z0-9]+(?:-[a-z0-9]+)+)"/g;
  it("every check id the browser driver's own modules emit is browser-only — finalize-ledger-row included — and every prefix covers one", () => {
    const ids = new Set<string>();
    for (const f of EMITTERS) for (const m of readFileSync(join(MATRIX, f), "utf8").matchAll(CHECK_ID)) ids.add(m[1]!);
    console.info(`parity: ${EMITTERS.length} browser emitters, ${ids.size} check ids`);
    expect(ids.size).toBeGreaterThan(0);
    expect([...ids].filter((id) => !isBrowserOnly(id))).toEqual([]);
    expect(ids).toContain("finalize-ledger-row");
    // Positive pair: the scan reads what the runs record.
    expect([...walkthroughBrowserOnly().browserOnly].filter((id) => !ids.has(id))).toEqual([]);
    // No decorative prefix: each one covers an id the driver emits.
    expect(BROWSER_ONLY_PREFIXES.filter((p) => ![...ids].some((id) => id.startsWith(p)))).toEqual([]);
  });

  it("a case id or a check id that repeats in one run is refused by name — a map would keep one and drop the other", () => {
    expect(() => compareRuns(runOf("http", [httpCase(A), httpCase(A)]), runOf("browser", [browserCase(A, 1280)]))).toThrow(DuplicateId);
    expect(() => compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280), browserCase(A, 1280)]))).toThrow(/league\|generic\|score\|LIFECYCLE@1280/);
    const twice = [...COMMON(), chk("I1-rr-pair-once-per-leg", "pass", 28)];
    expect(() => compareRuns(runOf("http", [httpCase(A, { checks: twice })]), runOf("browser", [browserCase(A, 1280)]))).toThrow(/I1-rr-pair-once-per-leg/);
    expect(() => compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280, { checks: [...twice, ...BROWSER_EXTRA()] })]))).toThrow(DuplicateId);
    // Positive pair: one case at two widths is two cases, not a repeat.
    expect(compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 320), browserCase(A, 1280)])).compared).toBe(2);
  });
});

describe("renderParity", () => {
  /** A markdown table row's cells: split on the pipes that are not escaped. */
  const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  const section = (md: string, heading: string): string => md.split(/^## /m).find((s) => s.startsWith(heading)) ?? "";
  const bodyRows = (s: string): string[] => s.split("\n").filter((l) => l.startsWith("|")).slice(2);

  it("writes the header line, then one table per diff kind and the two listed-not-compared sets; a case id's pipes are escaped, so each row keeps its columns", () => {
    const D = "swiss|generic|score|M1";
    const NOT_DRIVEN = "swiss|generic|score|X9@375";
    const r: ParityReport = compareRuns(
      runOf("http", [httpCase(A, { checks: [...COMMON(), chk("I4-nothing-ends-stuck", "pass", 37)] }), httpCase(B), httpCase(D, { state: "red", reason: "error: HTTP 500", checks: [] })]),
      runOf("browser", [
        browserCase(A, 1280, { state: "red", checks: [...COMMON(), chk("I4-nothing-ends-stuck", "pass", 36), ...BROWSER_EXTRA()] }),
        browserCase(C, 1280),
        browserCase(D, 1280, { state: "red", reason: "error: selector timeout", checks: [] }),
        aCase(NOT_DRIVEN, "browser", 375, { state: "not_run", reason: "no scenario script yet (atom X9)", checks: [] }),
      ]),
    );
    const kinds = ["state", "check", "missing", "vacuous"] as const;
    expect(kinds.map((k) => r.diffs.filter((d) => d.kind === k).length)).toEqual([1, 1, 1, 1]);
    expect(r.outsidePlan).toEqual([B]);
    expect(r.notDriven).toEqual([{ caseId: NOT_DRIVEN, state: "not_run" }]);
    const md = renderParity(r, RUNS);
    // The brief's header line, then the scope ruling's two counts, exactly.
    expect(headerLine(r)).toBe(`compared ${r.compared} cases, ${r.checks} common checks, ${r.diffs.length} differences; 1 HTTP cases outside the browser plan; 1 planned without a harness script (🚫/░)`);
    expect(md).toContain(headerLine(r));
    expect(md).toContain(parityVerdict(r).line);
    let rows = 0;
    for (const [heading, kind, width] of [["State differences", "state", 3], ["Check differences", "check", 4], ["Missing cases", "missing", 3], ["Vacuous pairs", "vacuous", 3]] as const) {
      const s = section(md, heading);
      expect(s, heading).not.toBe("");
      const body = bodyRows(s);
      expect(body.length, heading).toBe(r.diffs.filter((d) => d.kind === kind).length);
      for (const row of body) {
        expect(cells(row).length, row).toBe(width);
        expect(cells(row)[0]!.trim(), row).toMatch(/^(league|knockout|swiss)\\\|generic\\\|score\\\|(LIFECYCLE|M1)(@1280)?$/);
        rows++;
      }
    }
    expect(rows).toBe(r.diffs.length);
    // The listed sets name every id, not only a count (results.json names no plan).
    expect(section(md, "Outside the browser plan (1)")).toContain(`- \`${B}\``);
    expect(section(md, "Planned, not driven (🚫/░) (1)")).toContain(`- \`${NOT_DRIVEN}\` — not_run`);
    // An empty kind or set says so rather than printing an empty table.
    const clean = renderParity(compareRuns(runOf("http", [httpCase(A)]), runOf("browser", [browserCase(A, 1280)])), RUNS);
    const empty = ["State differences (0)", "Check differences (0)", "Missing cases (0)", "Vacuous pairs (0)", "Outside the browser plan (0)", "Planned, not driven (🚫/░) (0)"];
    for (const heading of empty) expect(clean).toContain(`## ${heading}\n\nNone.`);
    expect(clean).toContain("PARITY");
  });
});

// ---------------------------------------------------------------------------
// The CLI, spawned as its package script (the preload included), under a
// derived budget (spawn-budget.ts, T2(d)).
const SCRIPT = "matrix:parity";
const PACKAGE_LINE = "node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/parity.ts";
const scripts = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("parity CLI, run as its package script", () => {
  const meter = new SpawnMeter(6);
  beforeEach(() => meter.reset());
  const cli = (...args: string[]) => {
    meter.tick();
    const words = (scripts[SCRIPT] ?? "").split(" ");
    expect(words[0], `${SCRIPT} runs node`).toBe("node");
    return spawnSync(process.execPath, [...words.slice(1), ...args], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  };
  const dir = mkdtempSync(join(tmpdir(), "w1c-parity-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body: unknown): string => {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    return join(dir, name);
  };
  const results = (driver: DriverKind, cases: readonly CaseResult[]) => ({
    schemaVersion: 3, runId: `cli-${driver}`, harnessCommit: "abc", startedAt: "s", finishedAt: "f",
    grid: { rows: ["league", "knockout", "swiss"], sports: ["generic"] }, layer: driver === "http" ? "L3" : "L1", driver, cases,
  });
  const HTTP = put("http.json", results("http", [httpCase(A)]));
  const SAME = put("browser-same.json", results("browser", [browserCase(A, 1280)]));
  const DIFFERENT = put("browser-diff.json", results("browser", [browserCase(A, 1280, { state: "red" })]));
  const ELSEWHERE = put("browser-apart.json", results("browser", [browserCase(B, 1280)]));

  it("the package script preloads crash-exit.ts, then runs parity.ts", () => {
    expect(scripts[SCRIPT]).toBe(PACKAGE_LINE);
    expect(existsSync(join(REPO, "tools/matrix/parity.ts"))).toBe(true);
  });

  it("exit 0: parity — the report goes where --out says; without --out, to stdout; the pnpm form's bare `--` is dropped", { timeout: meter.budget }, () => {
    const out = join(dir, "sub", "parity.md");
    const r = cli(HTTP, SAME, "--out", out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("compared 1 cases, 3 common checks, 0 differences");
    expect(readFileSync(out, "utf8")).toContain("compared 1 cases, 3 common checks, 0 differences");
    const toStdout = cli(HTTP, SAME);
    expect(toStdout.status, toStdout.stderr).toBe(0);
    expect(toStdout.stdout).toContain("## Missing cases (0)");
    // `pnpm run matrix:parity -- a b --out c` hands node the `--` (pnpm 10).
    const dashed = cli("--", HTTP, SAME, "--out", join(dir, "dashed.md"));
    expect(dashed.status, dashed.stderr).toBe(0);
    expect(existsSync(join(dir, "dashed.md"))).toBe(true);
  });

  it("exit 1: a difference — the report is still written; and compared 0, which is never parity", { timeout: meter.budget }, () => {
    const out = join(dir, "diff.md");
    const r = cli(HTTP, DIFFERENT, "--out", out);
    expect(r.status, r.stderr).toBe(1);
    expect(readFileSync(out, "utf8")).toMatch(/## State differences \(1\)/);
    const apart = cli(HTTP, ELSEWHERE, "--out", join(dir, "apart.md"));
    expect(apart.status, apart.stderr).toBe(1);
    expect(apart.stdout).toMatch(/compared 0/);
  });

  it("exit 2: usage — no file, one file, three files, an unknown flag, the runs in the wrong slots; nothing written", { timeout: meter.budget }, () => {
    const out = join(dir, "never-usage.md");
    const rows: readonly (readonly [string, readonly string[], RegExp])[] = [
      ["no file", ["--out", out], /usage: parity\.ts/],
      ["one file", [HTTP, "--out", out], /usage: parity\.ts/],
      ["three files", [HTTP, SAME, SAME, "--out", out], /usage: parity\.ts/],
      ["an unknown flag", [HTTP, SAME, "--output", out], /usage: parity\.ts/],
      ["the browser run in the http slot", [SAME, HTTP, "--out", out], /WrongDriver/],
    ];
    for (const [what, args, why] of rows) {
      const r = cli(...args);
      expect({ what, status: r.status }, r.stderr).toEqual({ what, status: 2 });
      expect(r.stderr, what).toMatch(why);
      expect(r.stderr, what).not.toContain("crashed");
    }
    expect(existsSync(out)).toBe(false);
  });

  // D8 (W1d item 6): unreadable input is a REFUSAL, exit 2 — the same code merge-shards, render and lock-check use. It was 3
  // here, the code for an abort or a crash while loading, so a wrapper switching on the code read a bad file as a crash.
  it("exit 2: unreadable input — a missing file, bad JSON, results the schema refuses, a repeated case id; nothing written, nothing secret printed", { timeout: meter.budget }, () => {
    const out = join(dir, "never-input.md");
    for (const [what, file, why] of [
      ["a missing file", join(dir, "nope.json"), /ENOENT/],
      ["bad JSON", put("bad.json", "{not json"), /SyntaxError/],
      ["results the schema refuses", put("v1.json", { ...results("browser", []), schemaVersion: 1 }), /ZodError/],
      ["a repeated case id", put("twice.json", results("browser", [browserCase(A, 1280), browserCase(A, 1280)])), /DuplicateId/],
      // V8 quotes input this short in full: the message is redacted (R14a).
      ["a secret in bad JSON", put("secret.json", "token=abc123secret"), /\[redacted\]/],
    ] as const) {
      const r = cli(HTTP, file, "--out", out);
      expect({ what, status: r.status }, r.stderr).toEqual({ what, status: 2 });
      expect(r.stderr, what).toMatch(why);
      expect(r.stderr, what).not.toContain("abc123secret");
      expect(r.stderr, what).not.toContain("crashed");
    }
    expect(existsSync(out)).toBe(false);
  });
});
