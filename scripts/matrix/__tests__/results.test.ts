import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { L2_WIDTHS } from "../lib/pairs.ts";
import { BaseNotUrl, LOCAL_BASE, baseScrubber, findSecrets, redact } from "../lib/redact.ts";
import { BROWSER_WIDTHS, CASE_STATES, GLYPH, SecretInResults, decideState, parseResults, writeResults, type CaseResult, type CaseResultV2, type CheckResult, type RunResults, type RunResultsV2 } from "../lib/results.ts";
import { baseLiteralsIn, loopbackLiteralsIn } from "./loopback-literals.ts";
import { MAX_WORKERS } from "../lib/workers.ts";

/** The base every writeResults call below scrubs (FB-1): no evidence here names it unless a test says so. */
const RUN_BASE = "http://localhost:3999";

const chk = (p: Partial<CheckResult>): CheckResult => ({ id: "c", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence: [], ...p });

describe("decideState — empty case first (R13, R25)", () => {
  it("no checks at all is red, not works", () => {
    const r = decideState({ checks: [], deferred: null, error: null });
    expect(r.state).toBe("red");
    // Its own reason, so the branch is not just "falls through to all-abstained".
    expect(r.reason).toMatch(/no checks ran/);
  });
  it("every check abstained is red: vacuous (Review Focus 1)", () => {
    const r = decideState({ checks: [chk({ verdict: "abstain", checked: 0 }), chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null });
    expect(r).toEqual({ state: "red", reason: expect.stringMatching(/vacuous/) });
  });
  it("a passing check that checked zero items is red", () => {
    expect(decideState({ checks: [chk({ checked: 0 })], deferred: null, error: null }).state).toBe("red");
  });
});

describe("decideState", () => {
  it("one applied pass with items → works", () => {
    expect(decideState({ checks: [chk({}), chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null }).state).toBe("works");
  });
  it("works reason counts APPLIED checks and their items, never the abstentions", () => {
    const r = decideState({ checks: [chk({ checked: 3 }), chk({ id: "b", checked: 2 }), chk({ id: "x", verdict: "abstain", checked: 0 })], deferred: null, error: null });
    expect(r).toEqual({ state: "works", reason: "2 checks, 5 items" });
  });
  it("any fail → red, naming the check", () => {
    const r = decideState({ checks: [chk({}), chk({ id: "i1", verdict: "fail", reason: "pair a-b met twice" })], deferred: null, error: null });
    expect(r.state).toBe("red");
    expect(r.reason).toContain("i1");
  });
  it("an error outranks everything; deferred → later with the wave", () => {
    expect(decideState({ checks: [chk({})], deferred: null, error: "boom" }).state).toBe("red");
    expect(decideState({ checks: [], deferred: { wave: "W1b", reason: "multi-stage" }, error: null })).toEqual({ state: "later", reason: "W1b: multi-stage" });
  });
  it("an error outranks a deferral too (a crash is never parked as ⏳)", () => {
    expect(decideState({ checks: [], deferred: { wave: "W1b", reason: "multi-stage" }, error: "boom" })).toEqual({ state: "red", reason: "error: boom" });
  });
});

// PF4: Task 9/11 separate an error-red (product/driver refusal — a finding)
// from a vacuous red by the `error:` prefix. So every error reason carries it,
// and no vacuous reason ever does.
describe("decideState — error reds vs vacuous reds (PF4)", () => {
  it("an error with zero checks is red with the `error:` reason, not vacuous", () => {
    const r = decideState({ checks: [], deferred: null, error: "RefusedCall: /api/v1/divisions/d1/stages → HTTP 400 VALIDATION: bad" });
    expect(r).toEqual({ state: "red", reason: "error: RefusedCall: /api/v1/divisions/d1/stages → HTTP 400 VALIDATION: bad" });
    expect(r.reason).not.toMatch(/vacuous/);
  });
  it("no vacuous or failed-check reason starts with `error:`", () => {
    const vacuous = [
      decideState({ checks: [], deferred: null, error: null }),
      decideState({ checks: [chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null }),
      decideState({ checks: [chk({ checked: 0 })], deferred: null, error: null }),
      decideState({ checks: [chk({ id: "i1", verdict: "fail", reason: "x" })], deferred: null, error: null }),
    ];
    for (const r of vacuous) {
      expect(r.state).toBe("red");
      expect(r.reason.startsWith("error:")).toBe(false);
    }
  });
});

// ⛔ (Task 9, ruling 24): `mandated` turns a green into `refused` and nothing
// else — every red and every deferral keeps its own state and reason.
describe("decideState — mandated refusal (⛔, Task 9)", () => {
  const pass = (id: string, checked = 1): CheckResult => ({ id, kind: "assertion", verdict: "pass", checked, reason: "", evidence: [] });
  it("empty case first: a mandated refusal with no checks is still vacuous red, never ⛔", () => {
    expect(decideState({ checks: [], deferred: null, error: null, mandated: "denied: formats.double_elim" }).state).toBe("red");
  });
  it("all checks pass → refused, carrying the mandate as the reason", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: "denied: formats.double_elim" })).toEqual({ state: "refused", reason: "denied: formats.double_elim" });
  });
  it("a failed check beats the mandate: red", () => {
    const failed: CheckResult = { ...pass("b"), verdict: "fail", reason: "stages deleted" };
    expect(decideState({ checks: [pass("a"), failed], deferred: null, error: null, mandated: "x" }).state).toBe("red");
  });
  it("a zero-item applied check beats the mandate: vacuous red", () => {
    expect(decideState({ checks: [pass("a", 0)], deferred: null, error: null, mandated: "x" }).state).toBe("red");
  });
  it("every check abstaining beats the mandate: vacuous red", () => {
    const abstain: CheckResult = { ...pass("a", 0), verdict: "abstain", reason: "n/a" };
    expect(decideState({ checks: [abstain], deferred: null, error: null, mandated: "x" })).toEqual({ state: "red", reason: expect.stringMatching(/vacuous/) });
  });
  it("an abstention beside an applied pass does not block ⛔ (the applied check carries it)", () => {
    const abstain: CheckResult = { ...pass("z", 0), verdict: "abstain", reason: "n/a" };
    expect(decideState({ checks: [pass("a"), abstain], deferred: null, error: null, mandated: "x" }).state).toBe("refused");
  });
  it("an error and a deferral each beat the mandate", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: "boom", mandated: "x" })).toEqual({ state: "red", reason: "error: boom" });
    expect(decideState({ checks: [pass("a")], deferred: { wave: "W9", reason: "later" }, error: null, mandated: "x" })).toEqual({ state: "later", reason: "W9: later" });
  });
  it("no mandate: unchanged — works", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: null }).state).toBe("works");
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: null }).state).toBe("works");
  });
});

// 🚫 / ░ (W1c Task 3): a layer planner (Task 12) records a cell it never runs —
// one with no UI path (🚫, naming the wave that owes it) or no scenario script
// yet (░). Precedence: an error, then a deferral, then 🚫, then ░, then the
// vacuity rules. Setting both is a planner bug, refused by name whatever else
// is set (the dispatch's contract: decideState throws when both are set).
describe("decideState — 🚫 no_path and ░ not_run (W1c Task 3)", () => {
  const pass = (id: string, checked = 1): CheckResult => ({ id, kind: "assertion", verdict: "pass", checked, reason: "", evidence: [] });
  it("empty case first: neither set (absent or null) changes nothing — no checks is still vacuous red, a pass still works", () => {
    expect(decideState({ checks: [], deferred: null, error: null, noPath: null, notRun: null })).toEqual({ state: "red", reason: "no checks ran (vacuous)" });
    expect(decideState({ checks: [pass("a", 2)], deferred: null, error: null, noPath: null, notRun: null })).toEqual({ state: "works", reason: "1 checks, 2 items" });
    expect(decideState({ checks: [pass("a", 2)], deferred: null, error: null })).toEqual({ state: "works", reason: "1 checks, 2 items" });
  });
  it("decideState: noPath yields 🚫 no_path naming the wave; notRun yields ░ not_run; both lose to an error and to a deferral", () => {
    expect(decideState({ checks: [], deferred: null, error: null, noPath: { wave: "W4", reason: "no route" } })).toEqual({ state: "no_path", reason: "W4: no route" });
    expect(decideState({ checks: [], deferred: null, error: null, notRun: "no scenario script yet" })).toEqual({ state: "not_run", reason: "no scenario script yet" });
    expect(decideState({ checks: [], deferred: null, error: "boom", noPath: { wave: "W4", reason: "x" } }).state).toBe("red");
    expect(decideState({ checks: [], deferred: { wave: "W1-driving", reason: "r" }, error: null, notRun: "x" }).state).toBe("later");
    // …and the other two pairings, with the winner's own reason.
    expect(decideState({ checks: [], deferred: null, error: "boom", notRun: "x" })).toEqual({ state: "red", reason: "error: boom" });
    expect(decideState({ checks: [], deferred: { wave: "W1-driving", reason: "r" }, error: null, noPath: { wave: "W4", reason: "x" } })).toEqual({ state: "later", reason: "W1-driving: r" });
  });
  it("🚫 and ░ outrank every check verdict and the mandate: the cell never ran, so no check decides it", () => {
    const failed: CheckResult = { ...pass("f"), verdict: "fail", reason: "wrong" };
    expect(decideState({ checks: [pass("a"), failed], deferred: null, error: null, noPath: { wave: "W6", reason: "no bracket UI" } })).toEqual({ state: "no_path", reason: "W6: no bracket UI" });
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: "denied: x", notRun: "no scenario script yet (atom A1)" })).toEqual({ state: "not_run", reason: "no scenario script yet (atom A1)" });
    expect(decideState({ checks: [pass("a", 0)], deferred: null, error: null, notRun: "r" }).state).toBe("not_run");
  });
  it("noPath and notRun are never set together (a named refusal)", () => {
    expect(() => decideState({ checks: [], deferred: null, error: null, noPath: { wave: "W4", reason: "x" }, notRun: "y" })).toThrow(/both/);
    // Whatever else is set: an error or a deferral does not launder a planner bug.
    expect(() => decideState({ checks: [], deferred: null, error: "boom", noPath: { wave: "W4", reason: "x" }, notRun: "y" })).toThrow(/noPath and notRun both set/);
    expect(() => decideState({ checks: [], deferred: { wave: "W9", reason: "r" }, error: null, noPath: { wave: "W4", reason: "x" }, notRun: "y" })).toThrow(/noPath and notRun both set/);
  });
});

describe("glyphs and schema", () => {
  it("every state has a distinct glyph", () => {
    expect(new Set(CASE_STATES.map((s) => GLYPH[s])).size).toBe(CASE_STATES.length);
    expect(GLYPH.works).toBe("✅");
    expect(GLYPH.not_run).toBe("░");
  });
  it("parseResults refuses a wrong schemaVersion, an unknown state, and a missing or malformed grid", () => {
    const ok: RunResultsV2 = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    expect(parseResults(ok)).toEqual(ok);
    // T11 review M4: the grid MATRIX.md renders from is part of the file, and a malformed one is refused.
    expect(() => parseResults((({ grid: _g, ...rest }) => rest)(ok))).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: [], sports: ["generic"] } })).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: ["league"], sports: [] } })).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: ["league", "league"], sports: ["generic"] } })).toThrow(/grid rows repeat a key/);
    expect(() => parseResults({ ...ok, grid: { rows: ["league"], sports: ["generic", "generic"] } })).toThrow(/grid sports repeat a key/);
    expect(() => parseResults({ ...ok, grid: { rows: [""], sports: ["generic"] } })).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: ["league"], sports: ["generic"], extra: 1 } })).toThrow();
    // v1 had no case notes (m-5): its files are refused, not read with notes missing.
    expect(() => parseResults({ ...ok, schemaVersion: 1 })).toThrow();
    // A v2 body relabelled v3 lacks the run's layer and driver (D9).
    expect(() => parseResults({ ...ok, schemaVersion: 3 })).toThrow();
    expect(() => parseResults({ ...ok, schemaVersion: 4 })).toThrow();
    expect(() => parseResults({ ...ok, cases: [{ state: "green" }] })).toThrow();
  });

  const FULL: CaseResultV2 = {
    caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
    state: "works", reason: "2 checks, 5 items",
    checks: [
      { id: "I1", kind: "invariant", verdict: "pass", checked: 3, reason: "every pair meets once", evidence: ["a~b met 1"] },
      { id: "lifecycle-complete", kind: "assertion", verdict: "abstain", checked: 0, reason: "", evidence: ["abstain: no bracket"] },
    ],
    counts: { calls: 12, fixtures: 6, events: 30 }, durationMs: 1234.5,
    notes: ["stage league status after start: active", "complete refused 409 STAGE_INCOMPLETE"],
  };
  const withCase = (c: unknown) => ({ schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [c] });

  it("a fully populated case round-trips unchanged (the schema carries every interface field)", () => {
    expect(parseResults(withCase(FULL))).toEqual(withCase(FULL));
  });
  it("an error-red with zero checks is representable (PF4)", () => {
    const err = { ...FULL, state: "red", reason: "error: RefusedCall: HTTP 400 VALIDATION", checks: [], counts: { calls: 1, fixtures: 0, events: 0 } };
    expect(parseResults(withCase(err)).cases[0]).toEqual(err);
  });
  it.each<[string, unknown]>([
    ["unknown case key", { ...FULL, extra: 1 }],
    ["unknown check key", { ...FULL, checks: [{ ...FULL.checks[0], extra: 1 }] }],
    ["unknown check kind", { ...FULL, checks: [{ ...FULL.checks[0], kind: "probe" }] }],
    ["unknown verdict", { ...FULL, checks: [{ ...FULL.checks[0], verdict: "maybe" }] }],
    ["negative checked", { ...FULL, checks: [{ ...FULL.checks[0], checked: -1 }] }],
    ["fractional checked", { ...FULL, checks: [{ ...FULL.checks[0], checked: 1.5 }] }],
    ["empty check id", { ...FULL, checks: [{ ...FULL.checks[0], id: "" }] }],
    ["empty caseId", { ...FULL, caseId: "" }],
    ["missing counts.events", { ...FULL, counts: { calls: 1, fixtures: 1 } }],
    ["negative durationMs", { ...FULL, durationMs: -1 }],
    ["canary not boolean", { ...FULL, canary: "no" }],
    ["missing notes (m-5)", (({ notes: _n, ...rest }) => rest)(FULL)],
    ["a note that is not a string", { ...FULL, notes: [1] }],
  ])("parseResults refuses %s", (_name, bad) => {
    expect(() => parseResults(withCase(bad))).toThrow();
  });
});

// D9 (W1c Task 3): results v3. Every case records the layer that ran it, the
// driver and the browser width (null over HTTP); the run records its layer and
// driver. Committed v2 evidence still parses, as v2. The widths are judged
// against the harness's declared set — 1280 (ruling 39: L1 runs there) and the
// seven L2 widths, which pairs.test.ts pins to apps/web/playwright.config.ts.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRUTH_RUNS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs";
/** The committed W1b slice (committed-matrix.test.ts:21-23): the v2 evidence the brief names. */
const W1B_SLICE_RESULTS = resolve(REPO, TRUTH_RUNS, "w1b-slice", "results.json");
/** Every committed results.json under truth-runs; at W1b's close three, all v2 (w1a-slice, w1b-probe, w1b-slice). */
const COMMITTED_RESULTS = readdirSync(resolve(REPO, TRUTH_RUNS), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name === "results.json").map((e) => join(e.parentPath, e.name));
const V2_FLOOR = 3;
/** The widths a browser case may run at: 1280 (ruling 39) first, then L2's seven in their own order. */
const DECLARED_WIDTHS: readonly number[] = [1280, ...L2_WIDTHS];

const V3_CASE: CaseResult = {
  caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
  state: "works", reason: "1 checks, 3 items",
  checks: [{ id: "I1", kind: "invariant", verdict: "pass", checked: 3, reason: "every pair meets once", evidence: ["a~b met 1"] }],
  counts: { calls: 12, fixtures: 6, events: 30 }, durationMs: 1234.5, notes: ["stage league status after start: active"],
  layer: "L3", driver: "http", width: null,
};
const V3_RUN: RunResults = { schemaVersion: 3, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, layer: "L3", driver: "http", cases: [V3_CASE] };
/** Every issue a refused parse raised, as `path: message` — union branches flattened. */
const issuesOf = (json: unknown): string[] => {
  try { parseResults(json); } catch (e) {
    const flat = (issues: readonly { path: readonly PropertyKey[]; message: string; errors?: readonly (readonly unknown[])[] }[]): string[] =>
      issues.flatMap((i) => [`${i.path.map(String).join(".")}: ${i.message}`, ...(i.errors ?? []).flatMap((b) => flat(b as never))]);
    return flat((e as { issues: never }).issues);
  }
  return [];
};

describe("results v3 — layer, driver, width (D9, W1c Task 3)", () => {
  it("empty case first: a v3 run with zero cases parses (the CLI, not the schema, refuses an empty run)", () => {
    expect(parseResults({ ...V3_RUN, cases: [] }).schemaVersion).toBe(3);
    expect(parseResults({ ...V3_RUN, cases: [] })).toEqual({ ...V3_RUN, cases: [] });
  });
  it("committed v2 evidence still parses as v2, every case kept — w1b-slice's 24 by name, and every committed results.json", () => {
    const v2 = JSON.parse(readFileSync(W1B_SLICE_RESULTS, "utf8"));
    const r = parseResults(v2);
    expect(r.schemaVersion).toBe(2);
    expect(r.cases.length).toBe(24);
    // v2 predates D9: none of its cases carries a layer, driver or width, and the parse invents none.
    expect(r).toEqual(v2);
    let v2Files = 0;
    for (const f of COMMITTED_RESULTS) {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { schemaVersion: number; cases: unknown[] };
      const parsed = parseResults(raw);
      expect(parsed.schemaVersion, f).toBe(raw.schemaVersion);
      expect(parsed.cases.length, f).toBe(raw.cases.length);
      if (parsed.schemaVersion === 2) v2Files++;
    }
    expect(COMMITTED_RESULTS.map((f) => basename(dirname(f))).sort()).toEqual(expect.arrayContaining(["w1a-slice", "w1b-probe", "w1b-slice"]));
    expect(v2Files, "committed v2 results files read").toBeGreaterThanOrEqual(V2_FLOOR);
  });
  it("a v3 case must carry layer, driver and width; http carries width null, browser a width from the seven or 1280", () => {
    expect(() => parseResults({ ...V3_RUN, cases: [{ ...V3_CASE, width: 1280, driver: "http" }] })).toThrow(/width/);
    expect(() => parseResults({ ...V3_RUN, cases: [{ ...V3_CASE, driver: "browser", width: 999 }] })).toThrow(/width/);
    const parsed = parseResults({ ...V3_RUN, cases: [{ ...V3_CASE, driver: "browser", width: 320, layer: "L1" }] }).cases[0]!;
    expect("width" in parsed ? parsed.width : "no width").toBe(320);
    // Each refusal is the v3 schema's own, on the case's width, naming the case — not a
    // v2 branch complaining about keys it has never heard of.
    expect(issuesOf({ ...V3_RUN, cases: [{ ...V3_CASE, width: 1280, driver: "http" }] })).toEqual([
      "cases.0.width: case league|generic|score|LIFECYCLE: an http case carries width null, got 1280",
    ]);
    expect(issuesOf({ ...V3_RUN, cases: [{ ...V3_CASE, driver: "browser", width: 999 }] })).toEqual([
      `cases.0.width: case league|generic|score|LIFECYCLE: a browser case runs at one of ${DECLARED_WIDTHS.join(", ")}, got 999`,
    ]);
    // Carry: each of the three is REQUIRED — refused by the schema's own
    // required-field issue, never only by the width refine (whose messages
    // name the case): an optional width would still be refused over http, as
    // "got undefined", and read as a width rule rather than a missing field.
    let missing = 0;
    for (const key of ["layer", "driver", "width"] as const) {
      const { [key]: _gone, ...rest } = V3_CASE;
      const issues = issuesOf({ ...V3_RUN, cases: [rest] });
      expect(issues, key).toHaveLength(1);
      expect(issues[0]!.startsWith(`cases.0.${key}:`), `${key}: ${issues[0]}`).toBe(true);
      expect(issues[0], key).not.toMatch(/: case league\|generic/);
      missing++;
    }
    expect(missing).toBe(3);
  });
  it("every declared browser width parses — 1280 and each L2 width; every other width, null or a fraction is refused", () => {
    let accepted = 0;
    for (const w of DECLARED_WIDTHS) {
      for (const layer of ["L1", "L2"] as const) {
        const c = parseResults({ ...V3_RUN, layer, driver: "browser", cases: [{ ...V3_CASE, layer, driver: "browser", width: w }] }).cases[0]!;
        expect("width" in c ? c.width : "no width").toBe(w);
      }
      accepted++;
    }
    expect(accepted).toBe(1 + L2_WIDTHS.length);
    let refused = 0;
    for (const w of [null, 0, -320, 319, 321, 1279, 1281, 1920, 320.5]) {
      expect(issuesOf({ ...V3_RUN, cases: [{ ...V3_CASE, driver: "browser", width: w }] }).some((i) => i.startsWith("cases.0.width:")), String(w)).toBe(true);
      refused++;
    }
    expect(refused).toBe(9);
    // http refuses every width, a declared one included.
    for (const w of [320, 1280, 0]) expect(issuesOf({ ...V3_RUN, cases: [{ ...V3_CASE, width: w }] }), String(w)).toEqual([`cases.0.width: case league|generic|score|LIFECYCLE: an http case carries width null, got ${w}`]);
  });
  it("BROWSER_WIDTHS is exactly [1280, ...L2_WIDTHS], in that order (Task 4's viewports read it)", () => {
    expect([...BROWSER_WIDTHS]).toEqual(DECLARED_WIDTHS);
    expect(Object.isFrozen(BROWSER_WIDTHS)).toBe(true);
  });
  it("an unknown layer or driver, on a case or on the run, is refused; the run must carry both", () => {
    const refusals: [string, unknown][] = [
      ["case layer L4", { ...V3_RUN, cases: [{ ...V3_CASE, layer: "L4" }] }],
      ["case driver playwright", { ...V3_RUN, cases: [{ ...V3_CASE, driver: "playwright", width: 320 }] }],
      ["run layer L0", { ...V3_RUN, layer: "L0" }],
      ["run driver ws", { ...V3_RUN, driver: "ws" }],
      ["run without layer", (({ layer: _l, ...rest }) => rest)(V3_RUN)],
      ["run without driver", (({ driver: _d, ...rest }) => rest)(V3_RUN)],
      ["an unknown run key", { ...V3_RUN, width: 320 }],
      ["an unknown case key", { ...V3_RUN, cases: [{ ...V3_CASE, viewport: 320 }] }],
    ];
    let checked = 0;
    for (const [name, bad] of refusals) {
      expect(() => parseResults(bad), name).toThrow();
      checked++;
    }
    expect(checked).toBe(refusals.length);
  });
  it("versions never cross: a v2 case carrying the v3 keys is refused, and so is a v3 case without them", () => {
    const { layer: _l, driver: _d, width: _w, ...v2Case } = V3_CASE;
    const v2Run = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] } };
    expect(parseResults({ ...v2Run, cases: [v2Case] }).schemaVersion).toBe(2);
    expect(() => parseResults({ ...v2Run, cases: [V3_CASE] })).toThrow();
    expect(() => parseResults({ ...v2Run, layer: "L3", driver: "http", cases: [] })).toThrow();
    expect(() => parseResults({ ...V3_RUN, cases: [v2Case] })).toThrow();
  });
  it("a fully populated v3 run round-trips unchanged, a browser case beside an http one", () => {
    const run: RunResults = { ...V3_RUN, layer: "L2", driver: "browser", cases: [V3_CASE, { ...V3_CASE, caseId: "b", layer: "L2", driver: "browser", width: 834 }] };
    expect(parseResults(run)).toEqual(run);
  });
  it("writeResults writes v3 only: a v2 run is refused and nothing is written; a v3 run is written as given", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const v2: RunResultsV2 = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    expect(() => writeResults(dir, v2 as unknown as RunResults, RUN_BASE)).toThrow();
    expect(existsSync(join(dir, "results.json"))).toBe(false);
    const { path, written } = writeResults(dir, V3_RUN, RUN_BASE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(V3_RUN);
    expect(written).toEqual(V3_RUN);
  });
});

// W1c Task 14 carry 6 (Task 12 review m-7): a results.json names the plan that
// produced it — "--layer L1", "--set pad-proof", "slice --only …" — so a
// reader never guesses the set from its case ids. v3 evidence written before
// the field (walkthrough-a, Task 8) has none, and still parses.
describe("results v3 — the plan that produced a run (W1c Task 14 carry 6)", () => {
  it("empty case first: a v3 run with no plan (written before the field) parses, and carries none", () => {
    const old = parseResults(V3_RUN);
    expect(old.schemaVersion).toBe(3);
    expect("plan" in old).toBe(false);
  });
  it("a plan parses and round-trips through writeResults unchanged", () => {
    const run: RunResults = { ...V3_RUN, plan: "--layer L1" };
    expect(parseResults(run)).toEqual(run);
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const { path, written } = writeResults(dir, { ...V3_RUN, plan: "--set pad-proof" }, RUN_BASE);
    expect(written.plan).toBe("--set pad-proof");
    expect((JSON.parse(readFileSync(path, "utf8")) as { plan: unknown }).plan).toBe("--set pad-proof");
  });
  it("an empty or non-string plan is refused by the v3 schema, on the field", () => {
    expect(issuesOf({ ...V3_RUN, plan: "" }).some((i) => i.startsWith("plan: "))).toBe(true);
    expect(issuesOf({ ...V3_RUN, plan: 3 }).some((i) => i.startsWith("plan: "))).toBe(true);
  });
  it("v2 evidence carries no plan: the v2 schema refuses one", () => {
    const v2: RunResultsV2 = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    expect(() => parseResults(v2)).not.toThrow();
    expect(() => parseResults({ ...v2, plan: "slice" })).toThrow();
  });
});

// W1-driving Task 11 (ruling 46): a run on N > 1 workers says so in its header.
// Every v3 file written before the field — all the committed v3 evidence —
// ran on one sign-in, so the field is optional to read, and absent means one.
describe("results v3 — the run's worker count (W1-driving T11, ruling 46)", () => {
  it("empty case first: a v3 run with no workers field (every run before T11, and every --workers 1 run) parses, and carries none", () => {
    const old = parseResults(V3_RUN);
    expect(old.schemaVersion).toBe(3);
    expect("workers" in old).toBe(false);
  });
  it("every committed v3 results.json still parses — none carries the field", () => {
    let v3Files = 0;
    for (const f of COMMITTED_RESULTS) {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { schemaVersion: number };
      if (raw.schemaVersion !== 3) continue;
      const parsed = parseResults(raw);
      expect("workers" in parsed, f).toBe(false);
      v3Files++;
    }
    expect(v3Files, "committed v3 results files read").toBeGreaterThan(0);
  });
  it("a worker count in 1..MAX_WORKERS parses and round-trips through writeResults unchanged", () => {
    let checked = 0;
    for (const workers of [2, MAX_WORKERS]) {
      const run: RunResults = { ...V3_RUN, workers };
      expect(parseResults(run)).toEqual(run);
      const { path, written } = writeResults(mkdtempSync(join(tmpdir(), "fm-")), run, RUN_BASE);
      expect(written.workers).toBe(workers);
      expect((JSON.parse(readFileSync(path, "utf8")) as { workers: unknown }).workers).toBe(workers);
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("a worker count outside 1..MAX_WORKERS, or not an integer, is refused by the v3 schema, on the field", () => {
    let checked = 0;
    for (const bad of [0, MAX_WORKERS + 1, 2.5, "3"]) {
      expect(issuesOf({ ...V3_RUN, workers: bad }).some((i) => i.startsWith("workers: ")), String(bad)).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("v2 evidence carries no worker count: the v2 schema refuses one", () => {
    const v2: RunResultsV2 = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    expect(() => parseResults({ ...v2, workers: 2 })).toThrow();
  });
});

// W1-driving fix round 2 (ruling T12-R3): a shared turn that outlived its
// deadline aborts the run, and the results say why — the turn and the case
// whose turn it was, or the worker whose sign-in it was. The case gets no red;
// the cases that finished are kept. Absent on every run that was not aborted.
describe("results v3 — an aborted run says why (W1-driving fix round 2, T12-R3)", () => {
  const PROVISION = { turn: "case-org provision (the owner's staff window)", deadlineMs: 120_000, caseId: "league|generic|score|LIFECYCLE", worker: null };
  const SIGN_IN = { turn: "workers' sign-in", deadlineMs: 120_000, caseId: null, worker: 2 };
  it("empty case first: a run with no aborted field (every run that finished) parses, and carries none; no committed v3 file carries one", () => {
    expect("aborted" in parseResults(V3_RUN)).toBe(false);
    let v3Files = 0;
    for (const f of COMMITTED_RESULTS) {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { schemaVersion: number };
      if (raw.schemaVersion !== 3) continue;
      expect("aborted" in parseResults(raw), f).toBe(false);
      v3Files++;
    }
    expect(v3Files).toBeGreaterThan(0);
  });
  it("a case's turn and a worker's sign-in each parse and round-trip through writeResults unchanged", () => {
    let checked = 0;
    for (const aborted of [PROVISION, SIGN_IN]) {
      const run: RunResults = { ...V3_RUN, aborted };
      expect(parseResults(run)).toEqual(run);
      const { path, written } = writeResults(mkdtempSync(join(tmpdir(), "fm-")), run, RUN_BASE);
      expect(written.aborted).toEqual(aborted);
      expect((JSON.parse(readFileSync(path, "utf8")) as { aborted: unknown }).aborted).toEqual(aborted);
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("an abort that names both a case and a worker, or neither, or no turn, or a bad deadline or worker, is refused on the field", () => {
    const bad: unknown[] = [
      { ...PROVISION, worker: 0 },
      { ...PROVISION, caseId: null },
      { ...PROVISION, turn: "" },
      { ...PROVISION, deadlineMs: 0 },
      { ...SIGN_IN, worker: -1 },
      { ...SIGN_IN, worker: MAX_WORKERS },
      { ...PROVISION, why: "extra key" },
    ];
    let checked = 0;
    for (const aborted of bad) {
      expect(issuesOf({ ...V3_RUN, aborted }).some((i) => i.startsWith("aborted")), JSON.stringify(aborted)).toBe(true);
      checked++;
    }
    expect(checked).toBe(bad.length);
  });
  it("v2 evidence carries no abort: the v2 schema refuses one", () => {
    const v2: RunResultsV2 = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    expect(() => parseResults({ ...v2, aborted: PROVISION })).toThrow();
  });
});

describe("redaction (R14a)", () => {
  it("scrubs tokens, JWTs, device-link secrets, DB URLs, stripe keys", () => {
    const dirty = 'token=abc123def cookie: sb-access=xyz eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl dl_ABCDEFGH12345 postgres://u:p@h/db sk_test_ABCDEFGHIJ';
    const clean = redact(dirty);
    expect(findSecrets(clean)).toEqual([]);
    expect(findSecrets(dirty).length).toBeGreaterThanOrEqual(5);
    expect(redact("plain words stay")).toBe("plain words stay");
    // The count alone survives losing any one pattern (six shapes, floor five):
    // pin every payload. Found by mutation — dropping the JWT or the short
    // dl_ pattern left this test green.
    for (const payload of ["abc123def", "sb-access=xyz", "c2lnbmF0dXJl", "ABCDEFGH12345", "u:p@h", "ABCDEFGHIJ"]) expect(clean).not.toContain(payload);
  });
  it("writeResults refuses to write a secret and writes a clean file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const base: RunResults = { schemaVersion: 3, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, layer: "L3", driver: "http", cases: [] };
    const bad = { ...base, runId: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl" };
    expect(() => writeResults(dir, bad, RUN_BASE)).toThrow(SecretInResults);
    const { path } = writeResults(dir, base, RUN_BASE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(base);
  });
});

// PF6: Task 9 maps every reason and evidence string through redact() before
// writeResults scans each RAW string, so findSecrets must (a) catch every
// credential shape this harness can meet, (b) leave ordinary evidence alone,
// and (c) find nothing in redact()'s own output. Each row is also driven
// through writeResults itself: refused raw, written once redacted (positives);
// written as-is (negatives). A negative needs its positive pair.
const TOKEN43 = "Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFu_Ab-9xYzQwE"; // synthetic; 43 base64url chars, the shape of randomBytes(32)
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJhdWQiOiJzZWF6biJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

/** [label, text, the secret payload that must not survive redact()] */
const SECRETS: readonly [string, string, string][] = [
  ["session cookie header (opaque value)", "cookie: seazn_session=Zm9vYmFyYmF6cXV4; seazn_org=3f2b8c1e", "Zm9vYmFyYmF6cXV4"],
  ["session cookie pair alone", "sent seazn_session=Zm9vYmFyYmF6cXV4 with the call", "Zm9vYmFyYmF6cXV4"],
  ["session cookie carrying a JWT", `Cookie: seazn_session=${JWT}`, JWT],
  ["set-cookie of a supabase token", "set-cookie: sb-abcd-auth-token=base64-Zm9vYmFyYmF6; Path=/; HttpOnly", "base64-Zm9vYmFyYmF6"],
  ["cookie header whose name is no key word", "Cookie: __Host-auth=Zm9vYmFyYmF6cXV4", "Zm9vYmFyYmF6cXV4"],
  ["chunked supabase cookie pair alone", "sb-abcd-auth-token.0=base64-Zm9vYmFyYmF6", "base64-Zm9vYmFyYmF6"],
  ["supabase cookie pair (brief shape) alone", "sb-access=Zm9vYmFyYmF6cXV4", "Zm9vYmFyYmF6cXV4"],
  ["authorization bearer header", "Authorization: Bearer Zm9vYmFyYmF6cXV4cXV1eA", "Zm9vYmFyYmF6cXV4cXV1eA"],
  ["authorization basic header", "authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["bare bearer token", "retried with Bearer Zm9vYmFyYmF6cXV4cXV1eA after 401", "Zm9vYmFyYmF6cXV4cXV1eA"],
  ["magic-link login_url", `{"login_url":"http://localhost:3000/magic-link?token=${TOKEN43}&next=%2Fo%2Fm-1"}`, TOKEN43],
  ["magic-link consume body", `POST /api/auth/magic-link/consume {"token":"${TOKEN43}"}`, TOKEN43],
  ["access_token query param", `callback?access_token=${TOKEN43}&type=magiclink`, TOKEN43],
  ["refresh_token json field", `{"refresh_token": "${TOKEN43}"}`, TOKEN43],
  ["token_hash param", `/auth/confirm?token_hash=${TOKEN43}&type=email`, TOKEN43],
  ["device-link secret", `Authorization: Bearer dl_${TOKEN43}`, TOKEN43],
  ["device-link secret glued to a word", `x_dl_${TOKEN43}`, TOKEN43],
  ["device-link secret, short or truncated", "scoring with dl_ABCDEFGH12345", "ABCDEFGH12345"],
  ["device-link score URL", `http://localhost:3000/score/dl_${TOKEN43}`, TOKEN43],
  ["postgres URL", "could not connect to postgres://bench:hunter22@localhost:55432/seazn_fm", "hunter22"],
  ["postgres URL with no credentials", "could not connect to postgres://localhost:55432/seazn_fm", "localhost:55432/seazn_fm"],
  ["postgresql URL", "postgresql://bench:hunter22@localhost/seazn_fm?sslmode=disable", "hunter22"],
  ["DATABASE_URL assignment", "DATABASE_URL=postgres://bench:hunter22@localhost:55432/seazn_fm", "hunter22"],
  ["DATABASE_URL non-postgres value", 'DATABASE_URL="mysql://bench:hunter22@db.internal/app"', "hunter22"],
  ["DATABASE_URL with no password in it", "DATABASE_URL=mysql://db.internal:3306/app", "db.internal:3306/app"],
  ["URL with password userinfo", "fetch https://svc:hunter22@api.example.test/v1 failed", "hunter22"],
  ["PGPASSWORD", "PGPASSWORD=hunter22 psql -h localhost", "hunter22"],
  ["JWT alone", `jwt ${JWT} expired`, JWT],
  ["stripe secret key", "sk_live_51HxYzAbCdEfGhIjKl", "51HxYzAbCdEfGhIjKl"],
  // Review I1: a secret at the start of a line or after a tab. JSON escaping
  // turns the newline into `\n`, erasing the \b these patterns anchor on.
  ["JWT at the start of a line", `line1\n${JWT}`, JWT],
  ["stripe key after a tab", "a\tsk_live_51HxYzAbCdEfGhIjKl", "51HxYzAbCdEfGhIjKl"],
  ["short dl_ secret after a newline", "x\ndl_ABCDEFGH12345", "ABCDEFGH12345"],
  ["postgres URL at the start of a line", "connect failed:\npostgres://localhost:55432/seazn_fm", "localhost:55432/seazn_fm"],
  // Review M3: a quoted value is redacted whole, spaces included.
  ["single-quoted password with a space", "password: 'hunter 22'", " 22"],
  ["double-quoted password with a space", '{"password": "hunter 22"}', " 22"],
  // Parked Task 4: an UNCLOSED quote (a truncated message) must not leave the tail.
  ["unclosed single-quoted password with a space", "password: 'hunter 22", " 22"],
  ["unclosed double-quoted password with a space", 'password: "hunter 22', " 22"],
  ["unclosed quoted password, text after it on the line", "refused: password: 'hunter 22 at login", " 22"],
  // Review M4's positive pairs: the word test must not cost these.
  ["plain-word password", "PGPASSWORD=hunter", "hunter"],
  ["short numeric token", "token=123456", "123456"],
  ["long all-letter api key", "api_key=abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
];

/** Ordinary evidence the harness writes on every run (PF6). */
const EVIDENCE: readonly [string, string][] = [
  ["uuid", "fixture 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b: completed/home"],
  ["org slug", "m-fm-w1a-a-3"],
  ["org name", "Matrix fm-w1a-a 3"],
  ["synthetic email", "delivered+matrix-fm-w1a-a@resend.dev"],
  ["synthetic person", "Matrix Player 7"],
  ["seq numbers", "HTTP 409 SEQ_CONFLICT: expected_seq 3, current_seq 4"],
  ["idempotency key", "idempotency_key: fm-w1a-a-3:0:retry"],
  ["harness commit", "888e054a5c3b2f1d0e9a8b7c6d5e4f3a2b1c0d9e"],
  ["case id", "league|generic|score|LIFECYCLE"],
  ["invariant evidence", "a~d met 0, expected 1; stage 2: generate refused 400 with no code"],
  ["api path", "http://localhost:3000/api/v1/divisions/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/stages → HTTP 400 VALIDATION: stage kind"],
  ["localhost with port", "SMOKE_BASE http://localhost:3123 answered 200"],
  ["notes", "stage league status after start: in_progress; config knockout: 400 FORMAT_LOCKED; loop cap 64 reached"],
  ["variant names", "doubles-noad-mtb10 bwf score"],
  // Review M4: an ordinary word under a key whose real values are minted.
  ["authorization: none", "request sent with authorization: none"],
  ["token_count", "token_count=abc"],
  ["cookie consent", "cookie_consent=granted; cookie_consent=accepted"],
  ["quoted consent flag", '{"cookie_consent": "granted"}'],
  ["single-quoted authorization word", "authorization: 'none'"],
  // …and the unclosed form keeps the word test: a truncated `'none` is still a word.
  ["unclosed single-quoted authorization word", "authorization: 'none"],
  ["unclosed double-quoted consent flag", 'cookie_consent: "granted'],
];

const base: RunResults = { schemaVersion: 3, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, layer: "L3", driver: "http", cases: [] };
const withEvidence = (evidence: string[]): RunResults => ({
  ...base,
  cases: [{
    caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
    state: "works", reason: "1 checks, 1 items", checks: [{ id: "I1", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence }],
    counts: { calls: 1, fixtures: 1, events: 1 }, durationMs: 1, notes: [], layer: "L3", driver: "http", width: null,
  }],
});
/** writeResults into a fresh dir: the thrown value (or null) and whether a file landed. */
const tryWrite = (r: RunResults, runBase: string = RUN_BASE): { error: unknown; wrote: boolean } => {
  const dir = mkdtempSync(join(tmpdir(), "fm-"));
  try { writeResults(dir, r, runBase); return { error: null, wrote: existsSync(join(dir, "results.json")) }; }
  catch (e) { return { error: e, wrote: existsSync(join(dir, "results.json")) }; }
};

describe("findSecrets / redact — positives (PF6)", () => {
  it("discovery guard: the tables are not empty", () => {
    expect(SECRETS.length).toBeGreaterThan(0);
    expect(EVIDENCE.length).toBeGreaterThan(0);
  });
  it.each(SECRETS)("%s is found, and redact() removes its payload", (_label, text, payload) => {
    expect(text).toContain(payload);
    expect(findSecrets(text).length).toBeGreaterThan(0);
    const clean = redact(text);
    expect(clean).not.toContain(payload);
    expect(clean).toContain("[redacted]");
  });
  it.each(SECRETS)("%s: redact() is a fixpoint", (_label, text) => {
    const clean = redact(text);
    expect(findSecrets(clean)).toEqual([]);
    expect(redact(clean)).toBe(clean);
  });
  it.each(SECRETS)("%s: writeResults refuses it raw (writing nothing) and writes it redacted", (_label, text) => {
    const raw = tryWrite(withEvidence([text]));
    expect(raw.error).toBeInstanceOf(SecretInResults);
    expect(raw.wrote).toBe(false);
    expect(tryWrite(withEvidence([redact(text)]))).toEqual({ error: null, wrote: true });
  });
});

describe("findSecrets / redact — negatives (PF6)", () => {
  it.each(EVIDENCE)("%s is not a secret, survives redact() unchanged, and writes", (_label, text) => {
    expect(findSecrets(text)).toEqual([]);
    expect(redact(text)).toBe(text);
    expect(tryWrite(withEvidence([text]))).toEqual({ error: null, wrote: true });
  });
  it("text that only LOOKS secret once JSON-escaped is written (the scan reads raw strings)", () => {
    // Raw, `token=ab` is under the 3-char floor and the URL's userinfo is cut
    // by a newline. Serialised, `\n` is `\` + `n` and would stretch both into
    // matches, so a body scan would throw the run away.
    for (const text of ["token=ab\ncd", "https://u:pa\nss@h/x"]) {
      expect(findSecrets(text)).toEqual([]);
      expect(tryWrite(withEvidence([text]))).toEqual({ error: null, wrote: true });
    }
  });
});

describe("findSecrets / redact — cost", () => {
  it("long repetitive input stays cheap (unanchored or unbounded runs took 1–23 s here)", () => {
    const inputs = [
      "token_".repeat(700), "x".repeat(20_000), "m-fm-w1a-a-".repeat(2_000), `sb-${"a-".repeat(2_000)}!`,
      // Review M1: an uncapped key suffix and an unanchored JWT start.
      "token.".repeat(10_000), "sb-a.".repeat(5_000), "eyJ-".repeat(10_000),
    ];
    const t0 = performance.now();
    for (const s of inputs) { findSecrets(s); redact(s); }
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("writeResults", () => {
  it("review I1: a secret after a newline or tab is refused, though JSON-escaping hides it from a body scan", () => {
    for (const secret of [`line1\n${JWT}`, "a\tsk_live_51HxYzAbCdEfGhIjKl", "x\ndl_ABCDEFGH12345"]) {
      const r = tryWrite(withEvidence([secret]));
      expect(r.error, secret).toBeInstanceOf(SecretInResults);
      expect(r.wrote).toBe(false);
    }
  });
  it("refuses a secret nested in check evidence, writes NOTHING, and does not echo the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const e = (() => { try { writeResults(dir, withEvidence([`cookie: seazn_session=${TOKEN43}`]), RUN_BASE); } catch (x) { return x; } return null; })();
    expect(e).toBeInstanceOf(SecretInResults);
    expect((e as Error).message).not.toContain(TOKEN43);
    expect(existsSync(join(dir, "results.json"))).toBe(false);
  });
  it("writes evidence that went through redact() (the Task 9 path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const clean = withEvidence([redact(`cookie: seazn_session=${TOKEN43}`), "Matrix Player 3", "delivered+matrix-r@resend.dev"]);
    expect(JSON.parse(readFileSync(writeResults(dir, clean, RUN_BASE).path, "utf8"))).toEqual(clean);
  });
  it("refuses results the schema refuses, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    expect(() => writeResults(dir, { ...base, schemaVersion: 1 } as unknown as RunResults, RUN_BASE)).toThrow();
    expect(existsSync(join(dir, "results.json"))).toBe(false);
  });
});

// T15 fix round 3, M-7, then final batch FB-1: a run drives a server on this
// machine, and its address is noise in a public repo. Every committed writer
// emits LOCAL_BASE for THE RUN'S OWN BASE — in any loopback spelling, on its
// port — and for nothing else: a database on 5433 or product prose that says
// "localhost" is not the server a run drove, and rewriting it misattributed a
// Postgres outage to the app server. The secret scan reads the text BEFORE
// the scrub, so the scrub can never launder a credential. Expected values are
// typed here (the spec), and "no base left" is judged by a literal list
// (loopback-literals.ts), never by the scrubber's own regex.
describe("the run's base (FB-1)", () => {
  const scrub = baseScrubber("http://localhost:3313");
  it("empty case first: text that does not name the run's base is unchanged — lookalikes, other ports and prose included", () => {
    const kept = [
      "", "Matrix Player 3", "delivered+matrix-r@resend.dev", "POST /api/v1/fixtures/f1/events → HTTP 409", "https://seazn.club/c/x", LOCAL_BASE,
      "localhostname", "mylocalhost", "127.0.0.10", "the base must not point at localhost", "user@localhost",
      "https://localhost.example.com/x", "127.0.0.1.nip.io", "localhost:33130", "localhost:331", "http://localhost:3314/x",
      "ECONNREFUSED 127.0.0.1:5433", "redis at 127.0.0.1:6379", "ws://localhost/3313", "mylocalhost:3313", "x127.0.0.1:3313", "a.localhost:3313",
    ];
    let checked = 0;
    for (const text of kept) {
      expect(scrub(text), text).toBe(text);
      checked++;
    }
    expect(checked).toBe(kept.length);
  });
  it("the base in every loopback spelling on its port becomes LOCAL_BASE, the path and any other port kept", () => {
    const cases: [string, string][] = [
      ["http://localhost:3313", LOCAL_BASE],
      ["https://127.0.0.1:3313/api/v1/x", `${LOCAL_BASE}/api/v1/x`],
      ["localhost:3313", LOCAL_BASE],
      ["LOCALHOST:3313", LOCAL_BASE],
      ["connect ECONNREFUSED ::1:3313", `connect ECONNREFUSED ${LOCAL_BASE}`],
      ["http://[::1]:3313/a", `${LOCAL_BASE}/a`],
      ["[::1]:3313", LOCAL_BASE],
      ["0.0.0.0:3313 answered", `${LOCAL_BASE} answered`],
      ["http://127.0.1.1:3313/b.", `${LOCAL_BASE}/b.`],
      ["GET http://localhost:3313/a then 127.0.0.1:5433", `GET ${LOCAL_BASE}/a then 127.0.0.1:5433`],
      ['{"base": "http://localhost:3313"}', `{"base": "${LOCAL_BASE}"}`],
      ["http://user@localhost:3313/x", `http://user@${LOCAL_BASE}/x`],
      ["ws://localhost:3313", `ws://${LOCAL_BASE}`],
    ];
    let checked = 0;
    for (const [dirty, clean] of cases) {
      expect(baseLiteralsIn(dirty, 3313).length, `${dirty}: the oracle sees the base`).toBeGreaterThan(0);
      expect(scrub(dirty), dirty).toBe(clean);
      expect(baseLiteralsIn(scrub(dirty), 3313), `${dirty}: no spelling of the base is left`).toEqual([]);
      expect(scrub(scrub(dirty)), `${dirty}: a fixpoint`).toBe(clean);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
  it("a base spelled in any loopback form scrubs every spelling on its port — and only its port", () => {
    let checked = 0;
    for (const base of ["http://[::1]:4000", "http://0.0.0.0:4000", "http://127.0.1.1:4000", "http://LOCALHOST:4000/"]) {
      const s = baseScrubber(base);
      expect(s("GET http://localhost:4000/x"), base).toBe(`GET ${LOCAL_BASE}/x`);
      expect(s("ECONNREFUSED ::1:4000"), base).toBe(`ECONNREFUSED ${LOCAL_BASE}`);
      expect(s("127.0.1.1:4000 and http://[::1]:4000/y"), base).toBe(`${LOCAL_BASE} and ${LOCAL_BASE}/y`);
      expect(s("localhost:3313 and 127.0.0.1:5433"), base).toBe("localhost:3313 and 127.0.0.1:5433");
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("a base with no port scrubs its origin, never the bare host (prose, another port)", () => {
    const s = baseScrubber("http://localhost");
    expect(s("GET http://localhost/api and http://localhost:80/b")).toBe(`GET ${LOCAL_BASE}/api and ${LOCAL_BASE}/b`);
    expect(s("http://localhost:3313/x and point at localhost")).toBe("http://localhost:3313/x and point at localhost");
  });
  it("a base that is not loopback is scrubbed as itself, and no loopback text with it", () => {
    const s = baseScrubber("https://staging.example.test");
    expect(s("GET https://staging.example.test/x")).toBe(`GET ${LOCAL_BASE}/x`);
    expect(s("https://staging.example.testing/x localhost:3313 https://stagingxexample.test")).toBe("https://staging.example.testing/x localhost:3313 https://stagingxexample.test");
  });
  it("refuses, by name, a base that is not a URL", () => {
    expect(() => baseScrubber("localhost:3313 nope")).toThrow(BaseNotUrl);
    expect(() => baseScrubber("")).toThrow(BaseNotUrl);
  });
  it("the secret semantics do not move: a local origin is no secret, redact leaves it, and the placeholder is none either", () => {
    expect(findSecrets("http://localhost:3313/api")).toEqual([]);
    expect(redact("http://localhost:3313/api")).toBe("http://localhost:3313/api");
    expect(findSecrets(LOCAL_BASE)).toEqual([]);
    expect(loopbackLiteralsIn(LOCAL_BASE)).toEqual([]);
  });
  it("writeResults writes LOCAL_BASE for the base in any string, returns exactly what it wrote, and nothing else changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const r = withEvidence(["GET http://localhost:3313/api/v1/x → 500", "from 127.0.0.1:5433", "Matrix Player 3"]);
    const out = writeResults(dir, r, "http://localhost:3313");
    const text = readFileSync(out.path, "utf8");
    expect(baseLiteralsIn(text, 3313)).toEqual([]);
    const want = withEvidence([`GET ${LOCAL_BASE}/api/v1/x → 500`, "from 127.0.0.1:5433", "Matrix Player 3"]);
    expect(JSON.parse(text)).toEqual(want);
    expect(out.written).toEqual(want);
  });
  it("…and the scan reads the text BEFORE the scrub: a credential the scrub would un-shape is still REFUSED (MZ6)", () => {
    // `https://localhost:hunter22@db.example.com` — a password URL whose
    // userinfo starts with the base: scrubbed first, it reads
    // `[local-base]:hunter22@…` and no longer looks like a credential.
    const witness = "https://localhost:hunter22@db.example.com";
    expect(findSecrets(witness).length, "the witness is a secret as written").toBeGreaterThan(0);
    expect(findSecrets(baseScrubber("https://localhost")(witness)), "…and not once scrubbed — so only the order refuses it").toEqual([]);
    let checked = 0;
    for (const [evidence, base] of [[witness, "https://localhost"], ["row from postgres://bench:hunter22@localhost:5433/seazn", "http://localhost:5433"]] as const) {
      const r = tryWrite(withEvidence([evidence]), base);
      expect(r.error, evidence).toBeInstanceOf(SecretInResults);
      expect(r.wrote, evidence).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
