// W1d Task 6 (ruling 61, D6, D8, item 6; Review Focus 3, 4): the judge.
//
// Harness-green is mechanical: every shard completed (merge-shards refuses the
// rest), every case reports a state, no harness fault, and the states are
// identical across the runs. Product reds are DATA. Ruling 65: a ░ on a case
// the plan only PLANS (`planned: true`) is not a fault; a ░ on a driven case is.
//
// Three layers of test, each one kind of seam:
//   - the pure functions, on small hand-built runs (the classes, the empty case);
//   - the REAL committed L3 evidence (TR/w1drv-l3: its 11 RefusedCall reds are data);
//   - the runner's OWN output, folded through the real merge into the judge
//     (class 1: a fixture on both ends proves the fixture).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { FAULT_KINDS, harnessFaults, matchPlanIds, parseJudgeOut, regressions, scopeOfPlan, statesAcross } from "../lib/judge.ts";
import { atWidth, identityOf, l1Planner, l2Planner } from "../lib/layers.ts";
import { mergeShards, type ShardInput } from "../lib/merge.ts";
import { EXIT_CODES } from "../lib/exit-codes.ts";
import { CASE_STATES, VACUOUS_REASONS, decideState, parseResults, type CaseResult, type CaseState, type CheckResult, type RunResults } from "../lib/results.ts";
import { planSliceCases } from "../lib/slice.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { main } from "../judge.ts";
import { planOf, runSlice, scopeOf } from "../run.ts";
import { REPO, TRUTH_RUNS, livePlan } from "./committed-plans.ts";
import { deps, fakeBrowserRun } from "./run-deps.ts";

// --- builders -----------------------------------------------------------------------------------------------

const chk = (): CheckResult => ({ id: "k1", kind: "invariant", verdict: "pass", checked: 3, reason: "", evidence: [] });

/** A v3 case. Planned-shaped by default (no time spent): a test that wants a case that RAN gives durationMs. */
function kase(caseId: string, state: CaseState = "works", reason = "", over: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId, row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, state, reason,
    checks: state === "works" || state === "refused" ? [chk()] : [], counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0, notes: [],
    layer: "L3", driver: "http", width: null, ...over,
  };
}
const ok = kase;

/** A merged v3 run. `plan` defaults to the slice cell below, so a run built from PLAN_IDS is identity-clean. */
function run(cases: CaseResult[], over: Partial<RunResults> = {}): RunResults {
  return {
    schemaVersion: 3, runId: "r1", harnessCommit: "abc1234", startedAt: "2026-10-05T00:00:00.000Z", finishedAt: "2026-10-05T00:10:00.000Z",
    grid: { rows: [...ROW_KEYS], sports: [...SPORT_KEYS] }, layer: "L3", driver: "http", plan: PLAN, cases, ...over,
  };
}

/** A real plan, small enough to hand-build states over: league|generic × the slice's four scenarios. */
const PLAN = "slice --only league|generic";
const PLAN_IDS = planSliceCases(offlineBuilderDefault, { only: "league|generic" }).map((c) => c.caseId);
/** The plan's cases, each in the state `states[i]` says (default works). */
function planRun(states: readonly (readonly [CaseState, string])[] = [], over: Partial<RunResults> = {}): RunResults {
  return run(PLAN_IDS.map((id, i) => kase(id, states[i]?.[0] ?? "works", states[i]?.[1] ?? "", { durationMs: 5 })), over);
}

/** The real L2 (slice) plan as a run: each driven case works, each planned case is recordPlanned's 🚫/░ with its marker. */
function layeredRun(layer: "L1" | "L2", over: Partial<RunResults> = {}): RunResults {
  const planner = layer === "L1" ? l1Planner({}) : l2Planner({});
  const cases = planner.layered(offlineBuilderDefault).map((c): CaseResult => {
    const id = identityOf(c);
    const base = { caseId: atWidth(id.caseId, c.width), row: id.row, sport: id.sport, variant: id.variant, scenario: id.scenario, layer: c.layer, driver: "browser" as const, width: c.width };
    if (c.spec !== null) return kase(base.caseId, "works", "", { ...base, durationMs: 10 });
    const d = decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun });
    return kase(base.caseId, d.state, d.reason, { ...base, planned: true });
  });
  return run(cases, { layer, driver: "browser", plan: `--layer ${layer}`, scope: `${layer} (slice)`, ...over });
}

// --- files + the CLI ------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "w1d-judge-"));
let n = 0;
const put = (name: string, body: unknown): string => { const p = join(dir, `${++n}-${name}`); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
/** A run written to a temp file. */
const f = (r: RunResults): string => put("run.json", r);
/** A JSON id list written to a temp file (the sample's `--expect` file). */
const ids = (list: string[]): string => put("expect.json", list);

let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
const said = (): string => `${out.join("")}${err.join("")}`;
const judgeCli = (argv: string[]): number => main(argv);

// --- harnessFaults (D6) -----------------------------------------------------------------------------------------

describe("harnessFaults (D6)", () => {
  it("the empty case: a run with zero cases is refused by the CLI, and has no faults by itself", () => {
    expect(harnessFaults(run([]), { plannedNotRun: "allow" })).toEqual([]);
  });

  it("names each class once, and a product refusal is data, not a fault", () => {
    const faults = harnessFaults(run([
      ok("a", "red", "error: crashed — TypeError: x is undefined"),
      ok("b", "red", "error: DriverMisuse: no such control"),
      ok("c", "red", "error: RefusedCall: POST /api/v1/stages/1/start → HTTP 422 WRONG_PHASE: not now"),
      ok("d", "red", VACUOUS_REASONS.none),
      ok("e", "not_run", "no scenario script yet (atom M7)"),
      ok("f", "not_run", "no scenario script yet (atom M7)", { planned: true }),
      ok("g", "later", "W4 owes the path"),
      ok("h", "red", "standings: expected 3, saw 2"),
      ok("i", "needs_ruling", "the rulebook is silent on …"),
      ok("j", "red", "error: SetupRefused: POST /api/v1/divisions/0b2c/entrants → HTTP 422 VALIDATION: members"),
      ok("k", "red", "error: RefusedCall: POST /api/v1/entrants/0b2c/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant"),
    ]), { plannedNotRun: "allow" });
    expect(faults.map((x) => [x.caseId, x.kind])).toEqual([["a", "crash"], ["b", "harness-error"], ["d", "vacuous"], ["e", "unplanned-not-run"], ["j", "setup-refused"]]);
    // Every kind the module declares was met by this table or the tests below: the list is not wider than its tests.
    expect(FAULT_KINDS).toEqual(["crash", "harness-error", "setup-refused", "vacuous", "unplanned-not-run", "planned-not-run", "marker-on-driven"]);
  });

  it("every vacuity reason decideState writes is a fault — read from decideState's OWN output, then from VACUOUS_REASONS (review I3)", () => {
    const abstain: CheckResult = { ...chk(), verdict: "abstain" };
    const empty: CheckResult = { ...chk(), id: "i1-standings", checked: 0 };
    const empty2: CheckResult = { ...chk(), id: "i4-complete", checked: 0 };
    // The writer's own three words — the judge reads the same strings the writer produced.
    const written = [
      decideState({ checks: [], deferred: null, error: null }),
      decideState({ checks: [abstain], deferred: null, error: null }),
      decideState({ checks: [empty, empty2], deferred: null, error: null }),
    ];
    expect(written.map((w) => w.state)).toEqual(["red", "red", "red"]);
    expect(written[0]!.reason).toBe(VACUOUS_REASONS.none);
    expect(written[1]!.reason).toBe(VACUOUS_REASONS.abstained);
    expect(written[2]!.reason).toBe(`${VACUOUS_REASONS.zeroItemsPrefix} i1-standings, i4-complete`);
    let judged = 0;
    for (const w of written) {
      expect(harnessFaults(run([ok("v", w.state, w.reason)]), { plannedNotRun: "allow" }).map((x) => x.kind), w.reason).toEqual(["vacuous"]);
      judged++;
    }
    expect(judged).toBe(3);
    // A check that failed on its own terms is data, whatever its id says: a vacuity word inside a failed check's reason is not vacuity.
    expect(harnessFaults(run([ok("v", "red", "i1-standings: expected 3, saw 2 (vacuous?)")]), { plannedNotRun: "allow" })).toEqual([]);
  });

  it("ruling 65: a planned ░ (L2's 1,505) is not a fault, and a ░ on a driven case still is", () => {
    const faults = harnessFaults(run([ok("p", "not_run", "no scenario script yet (atom M7)", { planned: true }), ok("q", "not_run", "lost result")]), { plannedNotRun: "allow" });
    expect(faults).toEqual([{ caseId: "q", kind: "unplanned-not-run", reason: "lost result" }]);
  });

  it("the 11 committed RefusedCall reds are data: no fault of ANY kind names one of them (11 checked)", () => {
    const real = parseResults(JSON.parse(readFileSync(join(REPO, TRUTH_RUNS, "w1drv-l3", "results.json"), "utf8")));
    const refused = real.cases.filter((c) => c.reason.startsWith("error: RefusedCall:"));
    expect(refused).toHaveLength(11);
    const refusedIds = new Set(refused.map((c) => c.caseId));
    // ANY kind: a broken RefusedCall exemption would make all 11 'harness-error', and a setup-refused-only filter would stay green (class 4).
    expect(harnessFaults(real, { plannedNotRun: "allow" }).filter((x) => refusedIds.has(x.caseId))).toEqual([]);
    // …and the whole committed L3 run: the judge reads 937 cases and finds no fault in a run whose 194 reds are all product data.
    expect(real.cases).toHaveLength(937);
    expect(harnessFaults(real, { plannedNotRun: "allow" })).toEqual([]);
  });

  it("a planned marker on a case that ran (durationMs > 0 or checks) is a fault under allow too (review 2, R2-m6) — and on any state the marker's shape cannot be", () => {
    const faults = harnessFaults(run([
      ok("m", "works", "", { planned: true, durationMs: 1200 }),
      ok("n", "not_run", "x", { planned: true, durationMs: 0 }),
      // 🚫 with a check: isPlannedShape (T2-PRED) says it was driven.
      ok("o", "no_path", "W4: x", { planned: true, checks: [chk()] }),
      // A ✅ that spent no time and kept no check is still not a planned state.
      ok("p", "works", "", { planned: true, checks: [] }),
      // The planned SHAPE (░, no check) with time spent: it ran, so the marker is a driven result relabelled.
      ok("q", "not_run", "x", { planned: true, durationMs: 40 }),
    ]), { plannedNotRun: "allow" });
    expect(faults.map((x) => [x.caseId, x.kind])).toEqual([["m", "marker-on-driven"], ["o", "marker-on-driven"], ["p", "marker-on-driven"], ["q", "marker-on-driven"]]);
  });

  it("the refuse lever (rejected alternative (c)) is what makes a planned ░ a fault — so allow is doing the work", () => {
    const planned = run([ok("f", "not_run", "x", { planned: true })]);
    expect(harnessFaults(planned, { plannedNotRun: "refuse" }).map((x) => x.kind)).toEqual(["planned-not-run"]);
    expect(harnessFaults(planned, { plannedNotRun: "allow" })).toEqual([]);
  });

  it("🚫 is data in both modes: only ░ is ever a planned-not-run fault", () => {
    const planned = run([ok("g", "no_path", "W4: API-only", { planned: true })]);
    expect(harnessFaults(planned, { plannedNotRun: "refuse" })).toEqual([]);
  });

  it("every state is classified: each of the seven, as a driven case with no reason of its own, is a fault only when it is ░ (the sweep covers the state enum)", () => {
    let judged = 0;
    for (const s of CASE_STATES) {
      const f = harnessFaults(run([ok("s", s, "a plain reason", { durationMs: 5 })]), { plannedNotRun: "allow" });
      expect(f.map((x) => x.kind), s).toEqual(s === "not_run" ? ["unplanned-not-run"] : []);
      judged++;
    }
    expect(judged).toBe(7);
  });
});

// --- statesAcross (ruling 61; Review Focus 3) -------------------------------------------------------------------

describe("statesAcross (ruling 61; Review Focus 3)", () => {
  it("the empty case: no runs, and runs with no case, compare nothing", () => {
    expect(statesAcross([])).toEqual({ compared: 0, differing: [], missing: [] });
    expect(statesAcross([run([]), run([]), run([])])).toEqual({ compared: 0, differing: [], missing: [] });
  });

  it("a case whose state differs in one run of three is named with all three states, in run order", () => {
    const r = statesAcross([run([ok("a"), ok("b")]), run([ok("a"), ok("b", "red", "x")]), run([ok("a"), ok("b")])]);
    expect(r.compared).toBe(2);
    expect(r.differing).toEqual([{ caseId: "b", states: ["works", "red", "works"] }]);
    // The odd run can be any of the three: the position is reported, not a majority.
    expect(statesAcross([run([ok("b", "red", "x")]), run([ok("b")]), run([ok("b")])]).differing).toEqual([{ caseId: "b", states: ["red", "works", "works"] }]);
    expect(statesAcross([run([ok("b")]), run([ok("b")]), run([ok("b", "red", "x")])]).differing).toEqual([{ caseId: "b", states: ["works", "works", "red"] }]);
  });

  it("a red that is the same red in all three runs is NOT a difference (product reds are data)", () => {
    const r = statesAcross([run([ok("a", "red", "x")]), run([ok("a", "red", "y")]), run([ok("a", "red", "x")])]);
    expect(r.differing).toEqual([]);
    expect(r.compared).toBe(1);
  });

  it("two states that differ in two runs of three, and all three different, are both differences", () => {
    const r = statesAcross([run([ok("a", "red", "x"), ok("b")]), run([ok("a", "later", "W4"), ok("b", "red", "y")]), run([ok("a", "red", "x"), ok("b", "later", "W4")])]);
    expect(r.differing).toEqual([{ caseId: "a", states: ["red", "later", "red"] }, { caseId: "b", states: ["works", "red", "later"] }]);
  });

  it("a case missing from one run is named with the runs that hold it, and is not compared", () => {
    const r = statesAcross([run([ok("a"), ok("b")]), run([ok("a")]), run([ok("a"), ok("b")])]);
    expect(r.missing).toEqual([{ caseId: "b", inRuns: [0, 2] }]);
    expect(r.compared).toBe(1);
    expect(r.differing).toEqual([]);
  });
});

// --- regressions (D13; Review Focus 4) --------------------------------------------------------------------------

describe("regressions (D13; Review Focus 4)", () => {
  it("known red stays red passes; ✅→❌ fails; ⛔→✅ is not a regression; an EXPECTED case missing from now is absent", () => {
    const base = run([ok("a", "red", "x"), ok("b"), ok("c", "refused", "422"), ok("d"), ok("e")]);
    const now = run([ok("a", "red", "x"), ok("b", "red", "y"), ok("c")]);
    const r = regressions(base, now, ["a", "b", "c", "d"]); // e: in the baseline, not planned by the sample → ignored
    expect(r.regressed.map((x) => x.caseId)).toEqual(["b"]);
    expect(r.regressed[0]).toEqual({ caseId: "b", was: "works", now: "red", reason: "y" });
    expect(r.absent).toEqual(["d"]);
    expect(r.compared).toBe(3);
  });

  it("⛔→❌ IS a regression: a held refusal that stops being held (the pair of '⛔→✅ is not')", () => {
    const r = regressions(run([ok("c", "refused", "422")]), run([ok("c", "red", "z")]), ["c"]);
    expect(r.regressed).toEqual([{ caseId: "c", was: "refused", now: "red", reason: "z" }]);
  });

  it("every non-held state in `now` is a regression of a held case, and no state is when the baseline did not hold it (the sweep covers the enum)", () => {
    let judged = 0;
    for (const s of CASE_STATES) {
      const held = s === "works" || s === "refused";
      expect(regressions(run([ok("x")]), run([ok("x", s, "r")]), ["x"]).regressed.map((x) => x.now), `works → ${s}`).toEqual(held ? [] : [s]);
      // A baseline that never held it cannot regress, whatever it becomes.
      expect(regressions(run([ok("x", "red", "r")]), run([ok("x", s, "r")]), ["x"]).regressed, `red → ${s}`).toEqual([]);
      judged++;
    }
    expect(judged).toBe(7);
  });

  it("an expected id the baseline does not hold is neither compared nor absent; and a case the sample did not plan is ignored even when it regressed", () => {
    const r = regressions(run([ok("a")]), run([ok("a"), ok("n", "red", "new")]), ["a", "n"]);
    expect(r).toEqual({ compared: 1, regressed: [], absent: [] });
    const ignored = regressions(run([ok("a"), ok("z")]), run([ok("a"), ok("z", "red", "q")]), ["a"]);
    expect(ignored.regressed).toEqual([]);
    expect(ignored.compared).toBe(1);
  });

  it("the empty expect list compares nothing", () => {
    expect(regressions(run([ok("a")]), run([ok("a", "red", "x")]), [])).toEqual({ compared: 0, regressed: [], absent: [] });
  });
});

// --- the plan's ids (T4-IDS) and the scope (T6-SCOPE) -----------------------------------------------------------

describe("scopeOfPlan: '<layer> (<scope>)' derived from the plan string — against the REAL producer (run.ts planOf and scopeOf)", () => {
  it("round trip: for every layer and scope the CLI accepts, what run.ts records as `scope` is what the plan string derives", () => {
    let checked = 0;
    for (const layer of ["L1", "L2"] as const) {
      for (const scope of [undefined, "slice", "grid"] as const) {
        const cli = { set: undefined, canary: undefined, layer, only: undefined, scenario: undefined, ...(scope === undefined ? {} : { scope }) };
        expect(scopeOfPlan(planOf(cli)), `${layer} ${scope}`).toBe(scopeOf(cli));
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("a plan that is no --layer plan has no scope: a slice, a set and a canary", () => {
    for (const plan of ["slice", "slice --only league|generic", "--set w1-driving", "--set pad-proof", "--canary M1"]) expect(scopeOfPlan(plan), plan).toBeNull();
  });
});

describe("matchPlanIds (T4-IDS): the run's case ids are exactly the planner's for its recorded plan", () => {
  it("the real planner's ids (L1 slice, L2 slice, the slice cell) match themselves, counted", () => {
    expect(matchPlanIds(layeredRun("L2")).compared).toBe(l2Planner({}).layered(offlineBuilderDefault).length);
    expect(matchPlanIds(layeredRun("L1")).compared).toBe(l1Planner({}).layered(offlineBuilderDefault).length);
    expect(matchPlanIds(planRun()).compared).toBe(PLAN_IDS.length);
    expect(PLAN_IDS.length).toBeGreaterThan(1);
  });

  it("a `--set` plan, from committed evidence: the w1drv L3 run (plan `--set w1-driving`) matches the ids its planner makes — the count is the planner's, and the evidence's own", () => {
    const real = parseResults(JSON.parse(readFileSync(join(REPO, TRUTH_RUNS, "w1drv-l3", "results.json"), "utf8")));
    const plan = livePlan("--set w1-driving");
    const asRun = { ...real, plan: "--set w1-driving" } as unknown as RunResults;
    // Two independent sources agree: the planner (derived from the registry) and the committed evidence.
    expect(plan.driven.size + plan.planned.size).toBe(real.cases.length);
    expect(matchPlanIds(asRun).compared).toBe(real.cases.length);
    expect(real.cases.length).toBeGreaterThan(900);
    // …and it is a real check: one case dropped from the committed run is refused.
    expect(() => matchPlanIds({ ...asRun, cases: asRun.cases.slice(1) })).toThrow(expect.objectContaining({ name: "PlanIdsMismatch" }));
  });

  it("a case dropped (one id missing) is refused PlanIdsMismatch, naming it and the count", () => {
    const r = planRun();
    const dropped = { ...r, cases: r.cases.slice(1) };
    // The key drops the variant (the planner has no DB to read the builder default from): league|generic|<scenario>.
    expect(() => matchPlanIds(dropped)).toThrow(expect.objectContaining({ name: "PlanIdsMismatch", message: expect.stringContaining(`missing 1: ${PLAN_IDS[0]!.replace("|score|", "|")}`) }));
  });

  it("a case that is not in the plan (an extra id) is refused, naming it", () => {
    const r = planRun();
    const extra = { ...r, cases: [...r.cases, kase("league|generic|score|F9", "works")] };
    expect(() => matchPlanIds(extra)).toThrow(expect.objectContaining({ name: "PlanIdsMismatch", message: expect.stringContaining("extra 1: league|generic|score|F9") }));
  });

  it("a shard's case replaced by a FOREIGN id (the count unchanged) is both missing and extra — the count alone would pass it", () => {
    const r = planRun();
    const swapped = { ...r, cases: r.cases.map((c, i) => (i === 0 ? { ...c, caseId: "league|generic|score|ZZ" } : c)) };
    expect(swapped.cases).toHaveLength(r.cases.length);
    expect(() => matchPlanIds(swapped)).toThrow(expect.objectContaining({ name: "PlanIdsMismatch", message: expect.stringMatching(/missing 1: .*extra 1: league\|generic\|score\|ZZ/) }));
  });

  it("a case that appears twice is refused too (the merge's CaseCollision seen from the other side)", () => {
    const r = planRun();
    const twice = { ...r, cases: [...r.cases, r.cases[0]!] };
    expect(() => matchPlanIds(twice)).toThrow(expect.objectContaining({ name: "PlanIdsMismatch", message: expect.stringContaining("repeated 1") }));
  });

  it("the variant is the builder default the planner could not know offline: the same cell under another variant is still the cell", () => {
    const r = planRun();
    const other = { ...r, cases: r.cases.map((c) => ({ ...c, caseId: c.caseId.replace("|score|", "|win_loss|") })) };
    expect(matchPlanIds(other).compared).toBe(PLAN_IDS.length);
  });

  it("a run with no plan, and a plan no planner builds, are refused by name", () => {
    expect(() => matchPlanIds({ ...planRun(), plan: undefined })).toThrow(expect.objectContaining({ name: "PlanMissing" }));
    expect(() => matchPlanIds({ ...planRun(), plan: "--set no-such-set" })).toThrow(expect.objectContaining({ name: "PlanUnknown" }));
  });

  it("a run with zero cases is refused NoCases before anything is compared (the empty case first)", () => {
    expect(() => matchPlanIds(run([]))).toThrow(expect.objectContaining({ name: "NoCases" }));
  });

  it("T6-SCOPE: a scope that is not the plan's is refused ScopeMismatch; a matching one, and an absent one, pass", () => {
    const l1 = layeredRun("L1");
    expect(matchPlanIds(l1).compared).toBeGreaterThan(0);
    expect(() => matchPlanIds({ ...l1, scope: "L1 (grid)" })).toThrow(expect.objectContaining({ name: "ScopeMismatch", message: expect.stringContaining('scope "L1 (grid)"') }));
    expect(() => matchPlanIds({ ...l1, scope: "L2 (slice)" })).toThrow(expect.objectContaining({ name: "ScopeMismatch" }));
    // A scope on a plan that has none (a slice run) is a mismatch too.
    expect(() => matchPlanIds({ ...planRun(), scope: "L1 (slice)" })).toThrow(expect.objectContaining({ name: "ScopeMismatch" }));
    // Absent: the ruling cross-checks a scope only when one is present.
    expect(matchPlanIds({ ...l1, scope: undefined }).compared).toBe(matchPlanIds(l1).compared);
  });

  it("the grid plan (--layer L1 --scope grid) is judged by the GRID planner: the slice's ids are not the grid's", () => {
    expect(livePlan("--layer L1 --scope grid").driven.size).toBeGreaterThan(livePlan("--layer L1").driven.size);
    const slice = layeredRun("L1", { plan: "--layer L1 --scope grid", scope: "L1 (grid)" });
    expect(() => matchPlanIds(slice)).toThrow(expect.objectContaining({ name: "PlanIdsMismatch" }));
  });
});

// --- the CLI: faults ----------------------------------------------------------------------------------------------

describe("judge faults <run.json> (D6, run on every merged run)", () => {
  it("exit 1 on one crash red, 0 on a run of product reds only, 2 on zero cases", () => {
    expect(judgeCli(["faults", f(planRun([["red", "error: crashed — x"]]))])).toBe(1);
    expect(said()).toMatch(/crash/);
    expect(judgeCli(["faults", f(planRun([["red", "standings: expected 3, saw 2"]]))])).toBe(0);
    out = [];
    err = [];
    expect(judgeCli(["faults", f(run([]))])).toBe(2);
    expect(said()).toMatch(/NoCases/);
  });

  it("a plan's ids that are not the run's are exit 2, nothing judged — a fault list over the wrong cases is no verdict", () => {
    const r = planRun([["red", "error: crashed — x"]]);
    expect(judgeCli(["faults", f({ ...r, cases: r.cases.slice(1) })])).toBe(2);
    expect(said()).toMatch(/PlanIdsMismatch: .*missing 1: /);
  });

  it("T6-SCOPE through the CLI: a scope that is not the plan's is exit 2, by name", () => {
    expect(judgeCli(["faults", f({ ...layeredRun("L1"), scope: "L1 (grid)" })])).toBe(2);
    expect(said()).toMatch(/ScopeMismatch/);
  });

  it("ruling 65 through the CLI, on the real L2 plan: its planned ░ is exit 0 under the default and under allow, and exit 1 under refuse", () => {
    const r = layeredRun("L2");
    const planned = r.cases.filter((c) => c.planned === true && c.state === "not_run").length;
    expect(planned).toBeGreaterThan(0);
    expect(judgeCli(["faults", f(r)])).toBe(0);
    expect(judgeCli(["faults", f(r), "--planned-not-run", "allow"])).toBe(0);
    out = [];
    expect(judgeCli(["faults", f(r), "--planned-not-run", "refuse"])).toBe(1);
    expect(out.join("")).toContain("planned-not-run");
    expect(out.join("")).toMatch(new RegExp(`${planned} faults?`));
    // A ░ on a DRIVEN case of the same plan is a fault under allow too.
    const driven = r.cases.findIndex((c) => c.planned !== true);
    const lost = { ...r, cases: r.cases.map((c, i) => (i === driven ? { ...c, state: "not_run" as const, reason: "lost result", checks: [] } : c)) };
    expect(judgeCli(["faults", f(lost), "--planned-not-run", "allow"])).toBe(1);
    expect(out.join("")).toContain("unplanned-not-run");
  });

  it("the verdict is printed with its count: compared N cases; F faults — and the D8 exit line", () => {
    out = [];
    expect(judgeCli(["faults", f(planRun([["works", ""], ["red", "error: crashed — x"], ["red", "error: DriverMisuse: y"], ["works", ""]]))])).toBe(1);
    const text = out.join("");
    expect(text).toContain(`compared ${PLAN_IDS.length} cases`);
    expect(text).toMatch(/2 faults/);
    expect(text).toContain(`exit 1: ${EXIT_CODES[1]}`);
    expect(text).toContain(PLAN_IDS[1]!);
  });

  it("unreadable input is exit 2 (D8), each by its own name: a missing file, bad JSON, a schema refusal, a v2 run", () => {
    expect(judgeCli(["faults", join(dir, "nope.json")])).toBe(2);
    expect(said()).toMatch(/RunUnreadable/);
    err = [];
    expect(judgeCli(["faults", put("bad.json", "{not json")])).toBe(2);
    expect(said()).toMatch(/RunUnreadable/);
    err = [];
    expect(judgeCli(["faults", put("v1.json", { ...planRun(), schemaVersion: 1 })])).toBe(2);
    expect(said()).toMatch(/RunUnreadable/);
    err = [];
    const { layer: _l, driver: _d, plan: _p, ...v2 } = planRun();
    expect(judgeCli(["faults", put("v2.json", { ...v2, schemaVersion: 2, cases: planRun().cases.map(({ layer: _a, driver: _b, width: _c, ...c }) => c) })])).toBe(2);
    expect(said()).toMatch(/RunNotV3/);
  });

  it("usage is exit 2: no mode, an unknown mode, no file, two files, an unknown flag, a flag that belongs to another mode, a bad --planned-not-run", () => {
    const r = f(planRun());
    for (const argv of [[], ["bogus", r], ["faults"], ["faults", r, r], ["faults", r, "--bogus"], ["faults", r, "--baseline", r], ["faults", r, "--planned-not-run", "maybe"], ["faults", r, "--planned-not-run"]]) {
      expect(judgeCli(argv), argv.join(" ")).toBe(2);
    }
  });
});

// --- the CLI: across ----------------------------------------------------------------------------------------------

describe("judge across <runA> <runB> <runC> (ruling 61)", () => {
  const three = (over: (i: number) => Partial<RunResults> = () => ({}), states: (i: number) => readonly (readonly [CaseState, string])[] = () => []): string[] =>
    [0, 1, 2].map((i) => f(planRun(states(i), { runId: `r${i + 1}`, ...over(i) })));

  it("three runs with identical states and no fault are harness-green: exit 0, compared N across 3 runs", () => {
    expect(judgeCli(["across", ...three()])).toBe(0);
    expect(out.join("")).toContain(`compared ${PLAN_IDS.length} cases across 3 runs; 0 differing; 0 faults`);
    expect(out.join("")).toContain(`exit 0: ${EXIT_CODES[0]}`);
  });

  it("a state that differs in ONE run of three is exit 1, the case named with its three states (the difference is not averaged away)", () => {
    expect(judgeCli(["across", ...three(() => ({}), (i) => (i === 1 ? [["works", ""], ["red", "standings: expected 3, saw 2"]] : []))])).toBe(1);
    const text = out.join("");
    expect(text).toContain("1 differing");
    expect(text).toContain(`${PLAN_IDS[1]}: works, red, works`);
  });

  it("the SAME product red in all three runs is data: exit 0 (a red is not a fault)", () => {
    expect(judgeCli(["across", ...three(() => ({}), () => [["works", ""], ["red", "standings: expected 3, saw 2"]])])).toBe(0);
  });

  it("a harness fault in ONE run, with identical states, is exit 1 and names the run — the faults are judged per run", () => {
    // The same state (red) in all three, but the third run's red is a crash: states identical, harness not green.
    const runs = [0, 1, 2].map((i) => f(planRun([["works", ""], ["red", i === 2 ? "error: crashed — boom" : "standings: x"]], { runId: `r${i + 1}` })));
    expect(judgeCli(["across", ...runs])).toBe(1);
    const text = out.join("");
    expect(text).toContain("0 differing; 1 faults");
    expect(text).toMatch(/crash.*r3.*boom|r3.*crash.*boom/);
  });

  it("ruling 65 across runs: a planned ░ in all three is green; a planned ░ is a fault under refuse", () => {
    const l2 = (i: number) => f({ ...layeredRun("L2"), runId: `l2-${i}` });
    expect(judgeCli(["across", l2(1), l2(2), l2(3)])).toBe(0);
    expect(judgeCli(["across", l2(1), l2(2), l2(3), "--planned-not-run", "refuse"])).toBe(1);
  });

  it("refused (exit 2) — fewer than 2 runs", () => {
    expect(judgeCli(["across"])).toBe(2);
    expect(judgeCli(["across", f(planRun())])).toBe(2);
    expect(said()).toMatch(/TooFewRuns/);
  });

  it("refused — one run given three times (the states are 'identical' because it is the same run)", () => {
    const one = f(planRun());
    expect(judgeCli(["across", one, one, one])).toBe(2);
    expect(said()).toMatch(/RunRepeated/);
  });

  it("refused — runs that are not runs of one product: a different harnessCommit (D21), plan, layer, driver or scope; each by name", () => {
    const base = (over: Partial<RunResults> = {}) => planRun([], { runId: `x${++n}`, ...over });
    const cases: readonly (readonly [string, Partial<RunResults>])[] = [
      ["harnessCommit", { harnessCommit: "def5678" }],
      ["plan", { plan: "slice --only league|generic --scenario LIFECYCLE" }],
      ["layer", { layer: "L1" }],
      ["driver", { driver: "browser" }],
    ];
    let refused = 0;
    for (const [what, over] of cases) {
      err = [];
      expect(judgeCli(["across", f(base()), f(base()), f(base(over))]), what).toBe(2);
      expect(said(), what).toMatch(new RegExp(`RunsDisagree: .*${what}`));
      refused++;
    }
    expect(refused).toBe(4);
    // scope, 1: one run of the three records no scope (matchPlanIds accepts an absent scope, so only the
    // agreement check can tell it from its siblings).
    err = [];
    expect(judgeCli(["across", f({ ...layeredRun("L1"), runId: "s1" }), f({ ...layeredRun("L1"), runId: "s2", scope: undefined }), f({ ...layeredRun("L1"), runId: "s3" })])).toBe(2);
    expect(said()).toMatch(/RunsDisagree: .*scope .*\(absent\)/);
    // scope, 2: two runs of one plan that recorded different scopes (one is not its plan's, too).
    err = [];
    expect(judgeCli(["across", f({ ...layeredRun("L1"), runId: "s4" }), f({ ...layeredRun("L1"), runId: "s5", scope: "L1 (grid)" })])).toBe(2);
    expect(said()).toMatch(/RunsDisagree: .*scope/);
  });

  it("refused — a run whose ids are not its plan's (T4-IDS): one run of the three lost a case; nothing is compared", () => {
    const short = planRun([], { runId: "short" });
    expect(judgeCli(["across", f(planRun([], { runId: "a" })), f(planRun([], { runId: "b" })), f({ ...short, cases: short.cases.slice(1) })])).toBe(2);
    expect(said()).toMatch(/PlanIdsMismatch/);
  });

  it("refused — zero cases compared (anti-vacuity: an empty run, three times over, is not harness-green)", () => {
    expect(judgeCli(["across", f(run([], { runId: "e1" })), f(run([], { runId: "e2" })), f(run([], { runId: "e3" }))])).toBe(2);
    expect(said()).toMatch(/NoCases/);
  });

  // Review I1 (ruling T6-I1). matchPlanIds' key drops the variant, and on a plain plan the width too, and AGREE checks
  // neither, while statesAcross compares FULL ids: three runs of one plan can each pass every other check and share no
  // case id at all. Before the fix that read "compared 0 cases across 3 runs" at exit 1 (a verdict), and with --json-out
  // JudgeOutSchema.parse threw an uncaught ZodError (`compared` is min 1) — exit 3, no file, nothing printed.
  /** A plain-plan BROWSER run (layer L2, widths 375/390 are L2): case i runs at `w(i)` and its id is suffixed @<width>, as the runner writes it. */
  const browserRun = (runId: string, w: (i: number) => number, layer: "L1" | "L2" = "L2"): RunResults => {
    const r = planRun([], { runId, layer, driver: "browser" });
    return { ...r, cases: r.cases.map((c, i) => ({ ...c, caseId: `${c.caseId}@${w(i)}`, layer, driver: "browser" as const, width: w(i) })) };
  };
  const otherVariant = (r: RunResults, only?: number): RunResults => ({
    ...r,
    cases: r.cases.map((c, i) => (only !== undefined && i !== only ? c : { ...c, caseId: c.caseId.replace("|score|", "|win_loss|"), variant: "win_loss" })),
  });
  /** Refused at exit 2, by `name`, both plain and with --json-out; the verdict file is never written and nothing throws. */
  const refusedBoth = (files: string[], name: string): void => {
    err = [];
    expect(judgeCli(["across", ...files])).toBe(2);
    expect(said(), `${name}, plain`).toContain(`${name}: `);
    expect(said(), "a refusal is not a verdict").not.toMatch(/compared \d+ cases across/);
    const p = join(dir, `i1-${++n}.json`);
    err = [];
    expect(judgeCli(["across", ...files, "--json-out", p])).toBe(2);
    expect(said(), `${name}, --json-out`).toContain(`${name}: `);
    expect(existsSync(p), "a refusal writes nothing").toBe(false);
  };

  it("I1: three runs of ONE plan at different widths (@375, @390, @375; the same layer) pass every other check — and share no case id: NoneCompared, exit 2, plain and with --json-out", () => {
    const runs = [browserRun("w1", () => 375), browserRun("w2", () => 390), browserRun("w3", () => 375)];
    // The precondition that makes it a repro: each run alone is identity-clean against the plan (a plain plan's key drops the width).
    let clean = 0;
    for (const r of runs) { expect(matchPlanIds(r).compared).toBe(PLAN_IDS.length); clean++; }
    expect(clean).toBe(3);
    // …and statesAcross, on the same runs, counts nothing in common.
    expect(statesAcross(runs).compared).toBe(0);
    refusedBoth(runs.map(f), "NoneCompared");
  });

  it("I1: …and a 1280 run among them (@375, @1280, @375) is a different layer too, so AGREE already refuses it by name — the same-layer widths are the gap", () => {
    err = [];
    expect(judgeCli(["across", f(browserRun("x1", () => 375)), f(browserRun("x2", () => 1280, "L1")), f(browserRun("x3", () => 375))])).toBe(2);
    expect(said()).toMatch(/RunsDisagree: .*layer/);
  });

  it("I1: runs of one plan whose cases differ ONLY by variant (the key drops it) share no id either: NoneCompared", () => {
    const runs = [planRun([], { runId: "v1" }), otherVariant(planRun([], { runId: "v2" })), planRun([], { runId: "v3" })];
    for (const r of runs) expect(matchPlanIds(r).compared).toBe(PLAN_IDS.length);
    expect(statesAcross(runs).compared).toBe(0);
    refusedBoth(runs.map(f), "NoneCompared");
  });

  it("I1: when SOME ids are shared and some are not, it is CaseIdsDiffer — a case id held by only some runs is not one product (width on one case, then variant on one case)", () => {
    const plain = (runId: string): RunResults => planRun([], { runId });
    const at375 = (runId: string): RunResults => browserRun(runId, () => 375);
    for (const [what, siblings, odd] of [
      ["width", at375, browserRun("p2", (i) => (i === 0 ? 390 : 375))],
      ["variant", plain, otherVariant(planRun([], { runId: "p2" }), 0)],
    ] as const) {
      const runs = [siblings("p1"), odd, siblings("p3")];
      expect(matchPlanIds(odd).compared, what).toBe(PLAN_IDS.length);
      const sa = statesAcross(runs);
      // The precondition: something IS compared (so this is not NoneCompared) and something is missing.
      expect(sa.compared, what).toBe(PLAN_IDS.length - 1);
      expect(sa.missing.length, what).toBeGreaterThan(0);
      refusedBoth(runs.map(f), "CaseIdsDiffer");
      expect(said(), what).toMatch(/CaseIdsDiffer: .*not in every run/);
    }
  });
});

// --- the CLI: regression ------------------------------------------------------------------------------------------

describe("judge regression --baseline B --now N --expect E [--rerun R] (D13; Review Focus 4)", () => {
  const reg = (base: RunResults, now: RunResults, expect_: string[], rerun?: RunResults, extra: string[] = []): number =>
    judgeCli(["regression", "--baseline", f(base), "--now", f(now), "--expect", ids(expect_), ...(rerun === undefined ? [] : ["--rerun", f(rerun)]), ...extra]);

  it("no regression is exit 0, counted; a held case that stops being held is exit 1, named with was → now and its reason", () => {
    expect(reg(run([ok("a", "red", "x"), ok("b")]), run([ok("a", "red", "x"), ok("b")]), ["a", "b"])).toBe(0);
    expect(out.join("")).toContain("compared 2 cases");
    out = [];
    expect(reg(run([ok("b")]), run([ok("b", "red", "y")]), ["b"])).toBe(1);
    expect(out.join("")).toMatch(/b: works → red — y/);
    expect(out.join("")).toContain(`exit 1: ${EXIT_CODES[1]}`);
  });

  it("a ✅ case that comes back ✅ on the single re-run is not reported (CLI --rerun)", () => {
    expect(reg(run([ok("b")]), run([ok("b", "red", "y")]), ["b"], run([ok("b")]))).toBe(0);
  });

  it("…and one that is red again on the re-run is exit 1, named", () => {
    expect(reg(run([ok("b")]), run([ok("b", "red", "y")]), ["b"], run([ok("b", "red", "y")]))).toBe(1);
    expect(out.join("")).toMatch(/b: works → red/);
  });

  it("the rerun keeps a regression that is any non-held state again (🚫 or ⏳ after ✅ is not 'back to ✅')", () => {
    expect(reg(run([ok("b")]), run([ok("b", "red", "y")]), ["b"], run([ok("b", "later", "W4 owes")]))).toBe(1);
    expect(reg(run([ok("b")]), run([ok("b", "no_path", "W4: x")]), ["b"], run([ok("b", "no_path", "W4: x")]))).toBe(1);
  });

  it("only the cases that regressed need the rerun: a rerun without a regressed case is exit 2; one that does not need it is never read for it", () => {
    expect(reg(run([ok("a"), ok("b")]), run([ok("a"), ok("b", "red", "y")]), ["a", "b"], run([ok("a")]))).toBe(2);
    expect(said()).toMatch(/RerunMissing/);
  });

  it("refused (exit 2) — an expected case absent from now, even when the baseline never held it", () => {
    expect(reg(run([ok("a")]), run([ok("a")]), ["a", "d"])).toBe(2);
    expect(said()).toMatch(/ExpectedAbsent: .*\bd\b/);
  });

  it("refused — an --expect that lists one id twice (a sample cannot plan a case twice): ExpectUnreadable, naming it", () => {
    const base = f(run([ok("a")]));
    const now = f(run([ok("a")]));
    expect(judgeCli(["regression", "--baseline", base, "--now", now, "--expect", ids(["a", "a"])])).toBe(2);
    expect(said()).toMatch(/ExpectUnreadable: .*a case id is listed twice/);
    // The positive pair: the same id listed once is judged.
    out = [];
    expect(judgeCli(["regression", "--baseline", base, "--now", now, "--expect", ids(["a"])])).toBe(0);
    expect(out.join("")).toContain("compared 1 cases");
  });

  it("refused — a case TWICE in --now, [red, works] for one id: regressions() keeps the last, so the red would be hidden; UnexpectedCase names it", () => {
    const hidden = run([ok("a", "red", "x"), ok("a")]);
    // What the guard stands in front of: handed straight to the function, the duplicate reads as a clean 'works'.
    expect(regressions(run([ok("a")]), hidden, ["a"]).regressed).toEqual([]);
    expect(reg(run([ok("a")]), hidden, ["a"])).toBe(2);
    expect(said()).toMatch(/UnexpectedCase: .*a case twice: a/);
    // The positive pair: one red `a` is the regression it is.
    expect(reg(run([ok("a")]), run([ok("a", "red", "x")]), ["a"])).toBe(1);
  });

  it("refused — a case twice in --rerun is refused the same way: [red, works] would clear a reproduced regression", () => {
    const hidden = run([ok("a", "red", "x"), ok("a")]);
    expect(reg(run([ok("a")]), run([ok("a", "red", "x")]), ["a"], hidden)).toBe(2);
    expect(said()).toMatch(/UnexpectedCase: .*--rerun.*a case twice: a/);
  });

  it("refused — a now case that is not in --expect (a sample that planned something else cannot pass by omission)", () => {
    expect(reg(run([ok("a")]), run([ok("a"), ok("zz")]), ["a"])).toBe(2);
    expect(said()).toMatch(/UnexpectedCase: .*\bzz\b/);
  });

  it("refused — a rerun that is not the sample (a case outside --expect) is refused the same way", () => {
    expect(reg(run([ok("a")]), run([ok("a", "red", "y")]), ["a"], run([ok("a", "red", "y"), ok("zz")]))).toBe(2);
    expect(said()).toMatch(/UnexpectedCase/);
  });

  it("refused — zero compared: an empty --expect, and an --expect the baseline does not hold at all", () => {
    expect(reg(run([ok("a")]), run([ok("a")]), [])).toBe(2);
    expect(said()).toMatch(/NoCases|NoneCompared/);
    err = [];
    expect(reg(run([ok("q")]), run([ok("a")]), ["a"])).toBe(2);
    expect(said()).toMatch(/NoneCompared/);
  });

  it("refused — an --expect that is not a JSON list of ids, an unreadable baseline, and the wrong flags", () => {
    const base = f(run([ok("a")]));
    expect(judgeCli(["regression", "--baseline", base, "--now", base, "--expect", put("bad.json", "{\"a\":1}")])).toBe(2);
    expect(said()).toMatch(/ExpectUnreadable/);
    err = [];
    expect(judgeCli(["regression", "--baseline", join(dir, "gone.json"), "--now", base, "--expect", ids(["a"])])).toBe(2);
    expect(said()).toMatch(/RunUnreadable/);
    for (const argv of [["regression"], ["regression", "--baseline", base], ["regression", "--baseline", base, "--now", base], ["regression", base], ["regression", "--baseline", base, "--now", base, "--expect", ids(["a"]), "--planned-not-run", "allow"]]) {
      expect(judgeCli(argv), argv.join(" ")).toBe(2);
    }
  });

  it("the baseline is restricted by EXACT id, never by cell: a baseline case sharing the sample's cell and scenario is not 'absent' (review C3c)", () => {
    // `league|cricket|test|LIFECYCLE|cricket#…` shares a cell and a scenario with the sample's `league|cricket|<variant>|LIFECYCLE`.
    const sibling = "league|cricket|test|LIFECYCLE|cricket#1";
    const sampled = "league|cricket|t20|LIFECYCLE";
    expect(reg(run([ok(sibling), ok(sampled)]), run([ok(sampled)]), [sampled])).toBe(0);
    expect(out.join("")).toContain("compared 1 cases");
  });
});

// --- --json-out (PF-1): the verdict T8's summary reads ------------------------------------------------------------

describe("--json-out <path> (PF-1): the judge's verdict as JSON, in the shape T8's summary reads", () => {
  const readOut = (p: string) => parseJudgeOut(JSON.parse(readFileSync(p, "utf8")));

  it("faults: written on exit 1 and on exit 0, and parsed back through the module's own schema", () => {
    const red = join(dir, `fo-${++n}.json`);
    expect(judgeCli(["faults", f(planRun([["red", "error: crashed — boom"]], { runId: "rf" })), "--json-out", red])).toBe(1);
    expect(readOut(red)).toMatchObject({ version: 1, mode: "faults", exit: 1, layer: "L3", runs: ["rf"], plannedNotRun: "allow", compared: PLAN_IDS.length, differing: [], missing: [], regressed: [], absent: [] });
    expect(readOut(red).faults).toEqual([{ run: "rf", caseId: PLAN_IDS[0], kind: "crash", reason: "error: crashed — boom" }]);
    const green = join(dir, `fo-${++n}.json`);
    expect(judgeCli(["faults", f(planRun([], { runId: "rg" })), "--json-out", green])).toBe(0);
    expect(readOut(green)).toMatchObject({ exit: 0, faults: [] });
  });

  it("what is written, and printed, is redacted: a synthetic bearer token in a fault's reason reaches neither the file nor stdout", () => {
    const secret = `Bearer ${"synthetic0".repeat(2)}`;
    const p = join(dir, `rd-${++n}.json`);
    expect(judgeCli(["faults", f(planRun([["red", `error: crashed — upstream said ${secret} refused`]], { runId: "rr" })), "--json-out", p])).toBe(1);
    const body = readFileSync(p, "utf8");
    expect(body).not.toContain("synthetic0");
    expect(body).toContain("[redacted]");
    expect(out.join("")).not.toContain("synthetic0");
    expect(out.join("")).toContain("[redacted]");
  });

  it("across: the differing cases, the faults of every run, and every run id are in the file", () => {
    const p = join(dir, `ac-${++n}.json`);
    const runs = [0, 1, 2].map((i) => f(planRun(i === 1 ? [["works", ""], ["red", "x"]] : [], { runId: `a${i + 1}` })));
    expect(judgeCli(["across", ...runs, "--json-out", p])).toBe(1);
    expect(readOut(p)).toMatchObject({ mode: "across", exit: 1, runs: ["a1", "a2", "a3"], compared: PLAN_IDS.length, differing: [{ caseId: PLAN_IDS[1], states: ["works", "red", "works"] }] });
  });

  it("regression: the reproduced regressions are in the file, with the rerun's state", () => {
    const p = join(dir, `rg-${++n}.json`);
    expect(judgeCli(["regression", "--baseline", f(run([ok("b")])), "--now", f(run([ok("b", "red", "y")], { runId: "now1" })), "--expect", ids(["b"]), "--rerun", f(run([ok("b", "later", "W4")], { runId: "now1-r" })), "--json-out", p])).toBe(1);
    expect(readOut(p)).toMatchObject({ mode: "regression", exit: 1, compared: 1, regressed: [{ caseId: "b", was: "works", now: "red", reason: "y", rerun: "later" }] });
  });

  it("a refusal (exit 2) writes nothing — and leaves a file already at that path as it was", () => {
    const fresh = join(dir, `no-${++n}.json`);
    expect(judgeCli(["faults", f(run([])), "--json-out", fresh])).toBe(2);
    expect(existsSync(fresh)).toBe(false);
    const prior = put("prior.json", "untouched");
    expect(judgeCli(["faults", f(run([])), "--json-out", prior])).toBe(2);
    expect(readFileSync(prior, "utf8")).toBe("untouched");
  });

  it("the schema refuses what the producer never writes: another version, an exit of 2, zero compared, an unknown field", () => {
    const good = { version: 1, mode: "faults", exit: 0, layer: "L3", runs: ["r"], plannedNotRun: "allow", compared: 1, faults: [], differing: [], missing: [], regressed: [], absent: [] };
    expect(parseJudgeOut(good)).toEqual(good);
    for (const bad of [{ ...good, version: 2 }, { ...good, exit: 2 }, { ...good, compared: 0 }, { ...good, extra: 1 }, { ...good, mode: "other" }]) expect(() => parseJudgeOut(bad)).toThrow();
  });

  it("--json-out takes a path: without one it is usage", () => {
    expect(judgeCli(["faults", f(planRun()), "--json-out"])).toBe(2);
  });
});

// --- the module guard ---------------------------------------------------------------------------------------------

describe("isMainModule: importing the judge runs nothing", () => {
  it("a fresh import of judge.ts writes nothing and sets no exit code — only the file started as a program runs its main", async () => {
    vi.resetModules();
    const before = process.exitCode;
    try {
      const fresh = await import("../judge.ts");
      expect(typeof fresh.main).toBe("function");
      expect(said()).toBe("");
      expect(process.exitCode).toBe(before);
    } finally {
      process.exitCode = before;
    }
  });
});

// --- the runner's own evidence through the judge (class 1) --------------------------------------------------------

/** The real runner's shard dirs for `args`, in the shape merge-shards reads. */
async function realShards(args: string[], of: number, tag: string): Promise<ShardInput[]> {
  const reportDir = mkdtempSync(join(tmpdir(), "w1d-judge-run-"));
  const inputs: ShardInput[] = [];
  for (let k = 1; k <= of; k++) {
    const code = await runSlice(deps({ openBrowserRun: async () => fakeBrowserRun().run }), [...args, "--shard", `${k}/${of}`, "--run-id", `${tag}-s${k}`, "--report-dir", reportDir]);
    inputs.push({ name: `${tag}-s${k}`, exit: `${code}\n`, results: JSON.parse(readFileSync(join(reportDir, `${tag}-s${k}`, "results.json"), "utf8")) });
  }
  return inputs;
}

describe("the seam, end to end: runSlice's own shards, through the real merge, into the judge (class 1)", () => {
  it("L1 slice in two shards: the merged header (plan, scope, shards) and the plan's ids pass T4-IDS and T6-SCOPE — the judge reads what the runner wrote", async () => {
    const { merged } = mergeShards(await realShards(["--driver", "browser", "--layer", "L1"], 2, "seam1"), "seam1-merged");
    expect(merged.shards).toBe(2);
    expect(merged.scope).toBe("L1 (slice)");
    expect(merged.plan).toBe("--layer L1");
    const want = l1Planner({}).layered(offlineBuilderDefault).length;
    expect(want).toBeGreaterThan(1);
    expect(merged.cases).toHaveLength(want);
    expect(matchPlanIds(merged).compared).toBe(want);
    // Through the CLI: not refused (0 or 1 by the faults the league-only fake's refused rows are), counted from the planner.
    const p = join(dir, `seam-${++n}.json`);
    const code = judgeCli(["faults", f(merged), "--json-out", p]);
    expect([0, 1]).toContain(code);
    const verdict = parseJudgeOut(JSON.parse(readFileSync(p, "utf8")));
    expect(verdict.compared).toBe(want);
    expect(verdict.faults.length === 0).toBe(code === 0);
    // The producer's own bytes, damaged one way each: a dropped case, and a scope the plan did not choose.
    expect(judgeCli(["faults", f({ ...merged, cases: merged.cases.slice(1) })])).toBe(2);
    expect(judgeCli(["faults", f({ ...merged, scope: "L1 (grid)" })])).toBe(2);
  }, 120_000);

  it("a PLAIN slice run at one width: the runner suffixes every id @<width>, the plan's ids carry none — the key drops the width (the real producer)", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "w1d-judge-width-"));
    expect(await runSlice(deps({ openBrowserRun: async () => fakeBrowserRun().run }), ["--only", "league|generic", "--driver", "browser", "--width", "375", "--run-id", "seamw", "--report-dir", reportDir])).toBe(0);
    const r = parseResults(JSON.parse(readFileSync(join(reportDir, "seamw", "results.json"), "utf8"))) as RunResults;
    expect(r.plan).toBe("slice --only league|generic");
    expect(r.cases.length).toBeGreaterThan(1);
    expect(r.cases.every((c) => c.caseId.endsWith("@375"))).toBe(true);
    expect(matchPlanIds(r).compared).toBe(PLAN_IDS.length);
    expect(r.cases).toHaveLength(PLAN_IDS.length);
  }, 120_000);

  it("L1 --scope grid, unsharded: 231 cases, scope 'L1 (grid)', identity clean against the GRID planner", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "w1d-judge-grid-"));
    const d = deps({ openBrowserRun: async () => fakeBrowserRun().run });
    const live = { ...d, openDb: async () => ({ ...(await d.openDb()), variantKeysInBuilderOrder: async (s: string) => [...(await import("../lib/variants.ts")).offlineVariantOrder(s)] }) };
    expect(await runSlice(live, ["--driver", "browser", "--layer", "L1", "--scope", "grid", "--run-id", "seamg", "--report-dir", reportDir])).toBe(0);
    const r = parseResults(JSON.parse(readFileSync(join(reportDir, "seamg", "results.json"), "utf8"))) as RunResults;
    expect(r.cases).toHaveLength(231);
    expect(r.scope).toBe("L1 (grid)");
    expect(matchPlanIds(r).compared).toBe(231);
    expect(judgeCli(["faults", f(r)])).not.toBe(2);
  }, 180_000);
});
