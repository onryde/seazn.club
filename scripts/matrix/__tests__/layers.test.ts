// W1c Task 12: the layer planners. Every expected value comes from somewhere
// other than layers.ts: the COMMITTED l2-pairs.json read here as plain JSON,
// the scenario catalogue's own declarations (ATOMIC, HARNESS_SCENARIO), the
// slice's declared rows × sports, L2_WIDTHS, API_ONLY_ROWS, and design §8's
// wave table restated below (plan D7). Every planner test reports how many
// cases it checked, and zero checked is a failure.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, cellId, type ApiOnlyRowKey } from "../lib/catalogue.ts";
import {
  API_ONLY_BROWSER_SET, L1_WIDTH, L2BoundRun, L2TakesNoScenario, UnknownL2Atom, WIDTH_SWEEP_SET, apiOnlyBrowserPlanner, identityOf, l1Planner, l2Planner,
  layerCaseId, planL1, planL2, widthSweepPlanner, type LayerCase,
} from "../lib/layers.ts";
import { NotApiOnlyRow, apiOnlyUiPath } from "../lib/api-only-ui.ts";
import { loadL2Pairs, parseL2Pairs, type L2Run } from "../lib/pairs.ts";
import { SetTakesNoFilter } from "../lib/probe-set.ts";
import { decideState } from "../lib/results.ts";
import { ATOMIC, HARNESS_SCENARIO } from "../lib/scenario-catalogue.ts";
import { SLICE_ROWS, SLICE_SPORTS, UnknownFilter } from "../lib/slice.ts";
import { L2_WIDTHS } from "../lib/widths.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The committed file, read as plain JSON: never through layers.ts or pairs.ts. */
const RAW = JSON.parse(readFileSync(join(REPO, "scripts/matrix/catalogue/l2-pairs.json"), "utf8")) as { runs: L2Run[] };
/** The slice's cells, from its declared rows × sports (never a typed list). */
const SLICE_CELLS: ReadonlySet<string> = new Set(SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => cellId(r, s))));
/** The slice's committed L2 runs, in file order — 68 today (65 swiss|badminton,
 *  2 swiss|generic, 1 knockout|badminton). Only this filter's own length is
 *  asserted, so a regenerated catalogue moves the test, not the plan. */
const SLICE_RUNS = RAW.runs.filter((r) => SLICE_CELLS.has(cellId(r.row, r.sport)));
const ATOM = new Map(ATOMIC.map((a) => [a.id, a]));
const v = (s: string) => `v-${s}`;
/** The committed file through pairs.ts's parser: what the planner reads. */
const committed = loadL2Pairs();

describe("the committed l2-pairs.json, through pairs.ts's parser", () => {
  it("parses whole: every committed run, in file order, field for field", () => {
    expect(RAW.runs.length).toBeGreaterThan(0);
    expect(committed.runs).toStrictEqual(RAW.runs);
    console.info(`layers: l2-pairs.json parsed, ${committed.runs.length} runs`);
  });
  it("refuses a file the planner could only misread: a width off L2_WIDTHS, an unknown row or sport, a repeated n, an unknown key, another schema version", () => {
    const base = { schemaVersion: 1, generatedBy: "x", widths: [...L2_WIDTHS], targets: { rowScenario: 1, sportScenario: 1 }, runs: [RAW.runs[0]!] };
    expect(() => parseL2Pairs(base)).not.toThrow();
    const bad: Record<string, unknown> = {
      width: { ...base, runs: [{ ...RAW.runs[0]!, width: 1280 }] },
      row: { ...base, runs: [{ ...RAW.runs[0]!, row: "leage" }] },
      sport: { ...base, runs: [{ ...RAW.runs[0]!, sport: "curling" }] },
      repeatedN: { ...base, runs: [RAW.runs[0]!, { ...RAW.runs[1]!, n: RAW.runs[0]!.n }] },
      unknownKey: { ...base, runs: [{ ...RAW.runs[0]!, extra: 1 }] },
      version: { ...base, schemaVersion: 2 },
      fileWidths: { ...base, widths: [320] },
    };
    let checked = 0;
    for (const [shape, json] of Object.entries(bad)) {
      expect(() => parseL2Pairs(json), shape).toThrow();
      checked++;
    }
    expect(checked).toBe(Object.keys(bad).length);
  });
});

describe("planL2 — the committed rotation, filtered, never re-planned", () => {
  it("empty case first: an L2 filter that matches no cell plans zero runs (league|generic has no committed L2 run)", () => {
    const empty = "league|generic";
    // The premise, read from the file itself: the cell is on the slice and has no run.
    expect(SLICE_CELLS.has(empty)).toBe(true);
    expect(RAW.runs.filter((r) => cellId(r.row, r.sport) === empty)).toEqual([]);
    expect(planL2(committed, new Set([empty]))).toEqual([]);
    expect(planL2(committed, new Set())).toEqual([]);
    // …and the CLI's planner, narrowed to it by --only, plans nothing either (run.ts then refuses: run-cli.test.ts).
    expect(l2Planner({ only: empty }).layered(v)).toEqual([]);
    // Positive pair: the same file over the whole slice plans runs.
    expect(planL2(committed, SLICE_CELLS).length).toBeGreaterThan(0);
  });

  it("planL2 never re-plans: every planned run's n, scenario, row, sport, preset and width are the committed entry's, byte for byte", () => {
    const cases = planL2(committed, SLICE_CELLS);
    let checked = 0;
    for (const c of cases) {
      expect(c.run, "an L2 case carries its committed run").not.toBeNull();
      const raw = RAW.runs.find((r) => r.n === c.run!.n);
      expect(raw, `n ${c.run!.n} is in the file`).toBeDefined();
      expect(JSON.stringify(c.run)).toBe(JSON.stringify(raw));
      const id = identityOf(c);
      expect({ row: id.row, sport: id.sport, variant: id.variant, width: c.width, layer: c.layer }, `n ${raw!.n}`)
        .toEqual({ row: raw!.row, sport: raw!.sport, variant: raw!.preset, width: raw!.width, layer: "L2" });
      // A planned case names its atom; a driven one runs that atom's harness script and names the atom in its id.
      if (c.spec === null) expect(id.scenario).toBe(raw!.scenario);
      else expect(c.spec.scenario).toBe(HARNESS_SCENARIO[raw!.scenario]);
      expect(id.caseId).toBe(`${raw!.row}|${raw!.sport}|${raw!.preset}|${raw!.scenario}`);
      checked++;
    }
    console.info(`layers: planL2 slice — ${checked} runs compared with the committed entries`);
    expect(checked).toBe(SLICE_RUNS.length);
    expect(checked).toBeGreaterThan(0);
    // File order; none dropped, none added.
    expect(cases.map((c) => c.run!.n)).toEqual(SLICE_RUNS.map((r) => r.n));
    // Witness: the committed widths are NOT the plain (n - 1) % 7 rotation for some
    // slice run, so a planner that re-derived widths could not pass the loop above.
    expect(SLICE_RUNS.some((r) => r.width !== L2_WIDTHS[(r.n - 1) % L2_WIDTHS.length])).toBe(true);
  });

  it("slice L2 = 68 runs: 3 executed, and the rest carry 🚫 or ░ with a reason", () => {
    const cases = planL2(committed, SLICE_CELLS);
    expect(cases).toHaveLength(SLICE_RUNS.length);
    // The expected split, from the catalogue's own declarations.
    const exec = SLICE_RUNS.filter((r) => Object.hasOwn(HARNESS_SCENARIO, r.scenario));
    const owning = (r: L2Run) => { const a = ATOM.get(r.scenario)!; return a.knownNoPath ?? a.l2NoPath; };
    const noPath = SLICE_RUNS.filter((r) => !exec.includes(r) && owning(r) !== null);
    const notRun = SLICE_RUNS.filter((r) => !exec.includes(r) && owning(r) === null);
    // Non-vacuity: every branch has a run to witness it.
    expect(exec.length).toBeGreaterThan(0);
    expect(noPath.length).toBeGreaterThan(0);
    expect(notRun.length).toBeGreaterThan(0);
    const byN = new Map(cases.map((c) => [c.run!.n, c]));
    const hist: Record<string, number> = {};
    for (const r of SLICE_RUNS) {
      const c = byN.get(r.n)!;
      const atom = ATOM.get(r.scenario)!;
      const d = decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun });
      if (exec.includes(r)) {
        expect(c.spec, `n ${r.n} ${r.scenario} is driven`).not.toBeNull();
        expect(c.spec).toEqual({ caseId: `${r.row}|${r.sport}|${r.preset}|${r.scenario}`, row: r.row, sport: r.sport, variant: r.preset, scenario: HARNESS_SCENARIO[r.scenario], canary: false });
        expect([c.noPath, c.notRun]).toEqual([null, null]);
        hist.driven = (hist.driven ?? 0) + 1;
      } else if (noPath.includes(r)) {
        expect(c.spec).toBeNull();
        expect(c.notRun).toBeNull();
        expect(c.noPath?.wave, `n ${r.n} ${r.scenario}`).toBe(owning(r));
        expect(c.noPath?.reason).toContain(atom.title);
        expect(d.state).toBe("no_path");
        expect(d.reason.startsWith(`${owning(r)}: `), d.reason).toBe(true);
        hist.no_path = (hist.no_path ?? 0) + 1;
      } else {
        expect(c.spec).toBeNull();
        expect(c.noPath).toBeNull();
        expect(c.notRun).toBe(`no scenario script yet (atom ${r.scenario})`);
        expect(d).toEqual({ state: "not_run", reason: `no scenario script yet (atom ${r.scenario})` });
        hist.not_run = (hist.not_run ?? 0) + 1;
      }
    }
    console.info(`layers: slice L2 ${cases.length} runs — ${JSON.stringify(hist)}`);
    expect(hist).toEqual({ driven: exec.length, no_path: noPath.length, not_run: notRun.length });
    expect(exec.length + noPath.length + notRun.length).toBe(cases.length);
  });

  it("🚫 and ░ both set is impossible: planL2 never produces both, and decideState throws if handed both (T3's guard, reached from a real planner output)", () => {
    const cases = planL2(committed, SLICE_CELLS);
    let checked = 0;
    for (const c of cases) {
      const set = [c.noPath !== null, c.notRun !== null].filter(Boolean).length;
      expect(set, `n ${c.run!.n}`).toBe(c.spec === null ? 1 : 0);
      checked++;
    }
    expect(checked).toBe(SLICE_RUNS.length);
    const np = cases.find((c) => c.noPath !== null);
    const nr = cases.find((c) => c.notRun !== null);
    expect(np).toBeDefined();
    expect(nr).toBeDefined();
    expect(() => decideState({ checks: [], deferred: null, error: null, noPath: np!.noPath, notRun: nr!.notRun })).toThrow(/noPath and notRun both set/);
  });

  it("a run whose atom the catalogue does not hold is refused by name, never planned ░", () => {
    const runs = [{ ...SLICE_RUNS[0]!, scenario: "Z9" }];
    expect(() => planL2({ runs }, SLICE_CELLS)).toThrow(UnknownL2Atom);
    expect(() => planL2({ runs }, SLICE_CELLS)).toThrow(/Z9/);
  });

  it("a run that WOULD be driven but binds a variant override is refused by name (none is today; its override is not built)", () => {
    const driven = SLICE_RUNS.find((r) => Object.hasOwn(HARNESS_SCENARIO, r.scenario))!;
    // The premise, from the file: no committed run of a scripted atom is bound.
    expect(RAW.runs.filter((r) => Object.hasOwn(HARNESS_SCENARIO, r.scenario) && r.bound !== null)).toEqual([]);
    expect(() => planL2({ runs: [{ ...driven, bound: "badminton#001" }] }, SLICE_CELLS)).toThrow(L2BoundRun);
    // …a bound run that is only recorded (🚫/░) is fine: nothing drives it.
    const recorded = SLICE_RUNS.find((r) => !Object.hasOwn(HARNESS_SCENARIO, r.scenario))!;
    expect(planL2({ runs: [{ ...recorded, bound: "badminton#001" }] }, SLICE_CELLS)).toHaveLength(1);
  });

  it("the --layer L2 planner: the slice's cells, --only narrows to one, the committed file read, driven sports declared", () => {
    const whole = l2Planner({}).layered(v);
    expect(whole).toHaveLength(SLICE_RUNS.length);
    const p = l2Planner({ only: "swiss|badminton" });
    const narrowed = p.layered(v);
    const want = SLICE_RUNS.filter((r) => cellId(r.row, r.sport) === "swiss|badminton");
    expect(narrowed.map((c) => c.run!.n)).toEqual(want.map((r) => r.n));
    expect(want.length).toBeGreaterThan(0);
    expect(() => l2Planner({ only: "league|genric" })).toThrow(UnknownFilter);
    // A scenario filter would be silently ignored (the atoms are the file's): refused by name.
    expect(() => l2Planner({ scenario: "M1" })).toThrow(L2TakesNoScenario);
    // The sports whose builder default the run checks: those of the driven cases.
    const drivenSports = [...new Set(whole.flatMap((c) => (c.spec === null ? [] : [c.spec.sport])))];
    expect(drivenSports.length).toBeGreaterThan(0);
    expect(l2Planner({}).sports).toEqual(drivenSports);
    expect(l2Planner({}).layer).toBe("L2");
    expect(l2Planner({}).acceptsWidth).toBeNull();
  });
});

describe("planL1 — ruling 39: L1 runs at 1280 only", () => {
  it("planL1: 6 slice cells × 1 scenario at 1280 = 6 cases, caseIds suffixed @1280, layer L1", () => {
    const cells = SLICE_ROWS.length * SLICE_SPORTS.length;
    const cases = planL1(v);
    console.info(`layers: planL1 ${cases.length} cases (${cells} slice cells × LIFECYCLE)`);
    expect(cases).toHaveLength(cells);
    expect(L1_WIDTH).toBe(1280);
    expect(cases.map((c) => cellId(c.spec!.row, c.spec!.sport))).toEqual([...SLICE_CELLS]);
    let checked = 0;
    for (const c of cases) {
      expect({ layer: c.layer, width: c.width, noPath: c.noPath, notRun: c.notRun, run: c.run }).toEqual({ layer: "L1", width: 1280, noPath: null, notRun: null, run: null });
      expect(c.spec).toMatchObject({ scenario: "LIFECYCLE", variant: v(c.spec!.sport), canary: false });
      expect(layerCaseId(c)).toBe(`${c.spec!.caseId}@1280`);
      checked++;
    }
    expect(checked).toBe(cells);
    // A filter narrows it (the slice's own filter, refused the slice's way).
    expect(planL1(v, { only: "league|generic" }).map((c) => c.spec!.caseId)).toEqual(["league|generic|v-generic|LIFECYCLE"]);
    expect(planL1(v, { scenario: "M1" }).map((c) => c.spec!.scenario)).toEqual(Array.from({ length: cells }, () => "M1"));
    expect(() => planL1(v, { only: "league|genric" })).toThrow(UnknownFilter);
    // The CLI's planner accepts exactly 1280 as --width; the refusal of any other is run.ts's (run-cli.test.ts).
    const p = l1Planner({});
    expect({ layer: p.layer, acceptsWidth: p.acceptsWidth, sports: p.sports }).toEqual({ layer: "L1", acceptsWidth: 1280, sports: [...SLICE_SPORTS] });
    expect(p.layered(v)).toEqual(cases);
  });
});

describe("the layered sets", () => {
  it("width sweep: exactly L2_WIDTHS, in order, 320 included", () => {
    const p = widthSweepPlanner({ set: WIDTH_SWEEP_SET });
    const cases = p.layered(v);
    console.info(`layers: width sweep ${cases.length} cases`);
    expect(cases.map((c) => c.width)).toEqual([...L2_WIDTHS]);
    expect(cases.map((c) => c.width)).toContain(320);
    let checked = 0;
    for (const c of cases) {
      expect(c.spec).toEqual({ caseId: `league|badminton|${v("badminton")}|LIFECYCLE`, row: "league", sport: "badminton", variant: v("badminton"), scenario: "LIFECYCLE", canary: false });
      expect({ layer: c.layer, noPath: c.noPath, notRun: c.notRun }).toEqual({ layer: "L2", noPath: null, notRun: null });
      checked++;
    }
    expect(checked).toBe(L2_WIDTHS.length);
    expect(new Set(cases.map(layerCaseId)).size).toBe(cases.length);
    expect({ sports: p.sports, layer: p.layer, acceptsWidth: p.acceptsWidth }).toEqual({ sports: ["badminton"], layer: "L2", acceptsWidth: null });
    for (const cli of [{ only: "league|generic" }, { scenario: "LIFECYCLE" }, { canary: "M1" }]) expect(() => widthSweepPlanner(cli), JSON.stringify(cli)).toThrow(SetTakesNoFilter);
  });

  it("api-only browser set: one case per API_ONLY row, in catalogue order — each planned 🚫 naming its owning wave (D7 as ruled), never driven", () => {
    // Design §8 via plan D7, restated here rather than read from the harness.
    const WAVE: Readonly<Record<string, string>> = { knockout_third_place: "W4", page_playoff_only: "W4", stepladder_only: "W4", group_only: "W5", group_group_ko: "W5" };
    const p = apiOnlyBrowserPlanner({ set: API_ONLY_BROWSER_SET });
    const cases = p.layered(v);
    console.info(`layers: api-only browser set ${cases.length} cases`);
    expect(cases.map((c) => identityOf(c).row)).toEqual([...API_ONLY_ROWS]);
    let checked = 0;
    for (const c of cases) {
      const id = identityOf(c);
      expect(c.spec, id.row).toBeNull();
      expect(id).toEqual({ caseId: `${id.row}|generic|${v("generic")}|LIFECYCLE`, row: id.row, sport: "generic", variant: v("generic"), scenario: "LIFECYCLE" });
      expect({ layer: c.layer, width: c.width, notRun: c.notRun }).toEqual({ layer: "L1", width: 1280, notRun: null });
      expect(c.noPath?.wave, id.row).toBe(WAVE[id.row]);
      expect(c.noPath?.reason).toBe(`no organiser control builds ${id.row}`);
      expect(decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun })).toEqual({ state: "no_path", reason: `${WAVE[id.row]}: no organiser control builds ${id.row}` });
      checked++;
    }
    expect(checked).toBe(API_ONLY_ROWS.length);
    expect({ sports: p.sports, layer: p.layer, acceptsWidth: p.acceptsWidth }).toEqual({ sports: ["generic"], layer: "L1", acceptsWidth: 1280 });
    for (const cli of [{ only: "league|generic" }, { scenario: "LIFECYCLE" }, { canary: "M1" }]) expect(() => apiOnlyBrowserPlanner(cli), JSON.stringify(cli)).toThrow(SetTakesNoFilter);
  });

  it("the two API-only cells a catalog template reaches abstain to W1-driving (D7), not to the row's wave; the text the browser driver prints is the same fact", () => {
    const cells: [ApiOnlyRowKey, string, string][] = [["group_only", "badminton", "box-league"], ["group_group_ko", "cricket", "t20-super8"]];
    for (const [row, sport, template] of cells) {
      expect(apiOnlyUiPath(row, sport)).toEqual({ wave: "W1-driving", template, reason: `reachable only through catalog template ${template}; driving it` });
    }
    expect(apiOnlyUiPath("group_only", "generic")).toEqual({ wave: "W5", template: null, reason: "no organiser control builds group_only" });
    // A row the builder does build is refused by name, never answered `undefined` (strip-types runs no tsc).
    for (const row of ["league", "toString", "__proto__"]) expect(() => apiOnlyUiPath(row as ApiOnlyRowKey, "generic"), row).toThrow(NotApiOnlyRow);
  });

  it("every layered case's result id is unique within its plan", () => {
    const plans: [string, LayerCase[]][] = [
      ["L1", planL1(v)], ["L2", planL2(committed, SLICE_CELLS)],
      ["sweep", widthSweepPlanner({}).layered(v)], ["api-only", apiOnlyBrowserPlanner({}).layered(v)],
    ];
    let checked = 0;
    for (const [name, cases] of plans) {
      expect(cases.length, name).toBeGreaterThan(0);
      expect(new Set(cases.map(layerCaseId)).size, name).toBe(cases.length);
      checked += cases.length;
    }
    console.info(`layers: ${checked} result ids checked for uniqueness over ${plans.length} plans`);
  });
});
