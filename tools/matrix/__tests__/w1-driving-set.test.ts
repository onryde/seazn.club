// W1-driving Task 12: the w1-driving set — every catalogue cell × the four
// scripted scenarios, less the committed drop list, plus every committed
// cricket `test` variant case. Every expected value here is read from the
// catalogue registry (ROW_KEYS, SPORT_KEYS, API_ONLY_ROWS) or a COMMITTED
// file (drop-list.json, variants.json), never from the planner under test.
// The empty case first: a filter that matches nothing is refused by name.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { BoundVariantUnscorable, probeRows } from "../lib/probe-set.ts";
import { HARNESS_SCENARIO, LIFECYCLE_ID } from "../lib/scenario-catalogue.ts";
import { UnknownFilter } from "../lib/slice.ts";
import { offlineBuilderDefault, type VariantCase } from "../lib/variants.ts";
import {
  DropListUnreadable, NoTestVariantCases, ScriptAtomMismatch, W1_DRIVING_SCENARIOS, W1_DRIVING_SET, W1DrivingPlansNothing, W1DrivingTakesNoCanary, atomsOf, dropIndexOf, makeW1DrivingPlanner,
  planW1Driving, readDropIndex, readVariantsFile,
} from "../lib/w1-driving-set.ts";
import { slicePlanner } from "../run.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const variantFor = offlineBuilderDefault;

// The committed files, read here as plain JSON — the expected values' source.
interface DropGroup { scenario: string; kind: string; reason: string; cells: Record<string, string[]> }
const dropFile = (): { groups: DropGroup[] } => JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/drop-list.json"), "utf8")) as { groups: DropGroup[] };
const variantsFile = (): { sports: { sport: string; cases: VariantCase[] }[] } =>
  JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/variants.json"), "utf8")) as { sports: { sport: string; cases: VariantCase[] }[] };
const cricketTests = (): VariantCase[] => variantsFile().sports.find((s) => s.sport === "cricket")!.cases.filter((c) => c.preset === "test");
/** Each script's catalogue atom (the brief's map); cross-checked below against
 *  the scenario catalogue's own HARNESS_SCENARIO. */
const ATOM_OF = { LIFECYCLE: LIFECYCLE_ID, M1: "M1", R4: "R4a", F1: "F1" } as const;
const dropped = (atom: string, row: string, sport: string): boolean =>
  dropFile().groups.some((g) => g.scenario === atom && (g.cells[row] ?? []).includes(sport));

describe("planW1Driving — empty and unknown first", () => {
  it("empty case first: --only naming no catalogue cell is UnknownFilter, never an empty plan", () => {
    let refused = 0;
    for (const only of ["nope|generic", "league|nope", "", "league", "league|", "|generic", "league|generic|x"]) {
      expect(() => planW1Driving(variantFor, { only }), only).toThrow(UnknownFilter);
      refused++;
    }
    expect(refused).toBe(7);
  });
  it("an unknown or empty --scenario is UnknownFilter (DENIED and PADPROOF are not this set's)", () => {
    for (const scenario of ["M9", "", "DENIED", "PADPROOF", "R4a"]) expect(() => planW1Driving(variantFor, { scenario }), scenario).toThrow(UnknownFilter);
  });
  it("a real cell and a real scenario the committed drop list drops is refused by name with the drop's reason — never an empty plan", () => {
    const g = dropFile().groups.find((x) => x.scenario === "F1" && (x.cells.page_playoff_only ?? []).includes("generic"));
    expect(g, "the committed drop list drops F1 on page_playoff_only|generic").toBeDefined();
    expect(() => planW1Driving(variantFor, { only: "page_playoff_only|generic", scenario: "F1" })).toThrow(W1DrivingPlansNothing);
    expect(() => planW1Driving(variantFor, { only: "page_playoff_only|generic", scenario: "F1" })).toThrow(g!.reason);
  });
  it("the set's scenarios are the four scripted ones, each the script of its catalogue atom", () => {
    expect([...W1_DRIVING_SCENARIOS]).toEqual(["LIFECYCLE", "M1", "R4", "F1"]);
    for (const s of W1_DRIVING_SCENARIOS) expect(HARNESS_SCENARIO[ATOM_OF[s]], s).toBe(s);
    expect(W1_DRIVING_SET).toBe("w1-driving");
  });
});

describe("planW1Driving — the whole set", () => {
  it("plans every applicable (cell, scenario) of the four scripts plus the cricket test cases — the count DERIVED from the committed drop list", () => {
    let expected = 0;
    let drops = 0;
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) for (const s of W1_DRIVING_SCENARIOS) {
      if (dropped(ATOM_OF[s], row, sport)) drops++;
      else expected++;
    }
    const testCases = cricketTests().filter((c) => c.scorable === null).length;
    const plan = planW1Driving(variantFor, {});
    expect(drops).toBe(11);
    expect(testCases).toBe(24);
    expect(cricketTests().length).toBe(testCases);
    expect(plan.length).toBe(expected + testCases);
    // 231×4 − 11 (F1 page_playoff_only, Task 2) + 24 — the typed pin must equal the derivation.
    expect(ROW_KEYS.length * SPORT_KEYS.length).toBe(231);
    expect(plan.length).toBe(937);
    expect(new Set(plan.map((c) => c.caseId)).size).toBe(plan.length);
  });
  it("no case on a dropped (atom, cell) and every undropped one present — both directions, counted", () => {
    const ids = new Set(planW1Driving(variantFor, {}).map((c) => c.caseId));
    let absent = 0;
    let present = 0;
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) for (const s of W1_DRIVING_SCENARIOS) {
      const id = `${row}|${sport}|${variantFor(sport)}|${s}`;
      if (dropped(ATOM_OF[s], row, sport)) { expect(ids.has(id), id).toBe(false); absent++; }
      else { expect(ids.has(id), id).toBe(true); present++; }
    }
    expect(absent).toBeGreaterThan(0);
    expect(present).toBeGreaterThan(0);
  });
  it("plan order is row × sport × scenario, then the variant cases in committed order — stable across calls", () => {
    const plan = planW1Driving(variantFor, {});
    const grid: string[] = [];
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) for (const s of W1_DRIVING_SCENARIOS) {
      if (!dropped(ATOM_OF[s], row, sport)) grid.push(`${row}|${sport}|${variantFor(sport)}|${s}`);
    }
    const tail = cricketTests().map((vc) => `${vc.row}|cricket|test|LIFECYCLE|${vc.id}`);
    expect(plan.map((c) => c.caseId)).toEqual([...grid, ...tail]);
    expect(planW1Driving(variantFor, {}).map((c) => c.caseId)).toEqual(plan.map((c) => c.caseId));
  });
  it("each cricket test case carries its committed override on the wire, exactly probe-set's variant shape", () => {
    const byId = new Map(planW1Driving(variantFor, {}).filter((c) => c.variant === "test").map((c) => [c.caseId, c]));
    let checked = 0;
    for (const vc of cricketTests()) {
      const c = byId.get(`${vc.row}|cricket|test|LIFECYCLE|${vc.id}`);
      expect(c, vc.id).toEqual({ caseId: `${vc.row}|cricket|test|LIFECYCLE|${vc.id}`, row: vc.row, sport: "cricket", variant: "test", scenario: "LIFECYCLE", canary: false, overrides: vc.overrides });
      checked++;
    }
    expect(checked).toBe(24);
    // The grid's cricket cases ride the builder default, not `test` (else the count above would double-count).
    expect(variantFor("cricket")).not.toBe("test");
  });
  it("every API-only row the probe set leaves out is planned by the w1-driving set, counted", () => {
    const left = API_ONLY_ROWS.filter((r) => !probeRows().api.includes(r));
    const plan = planW1Driving(variantFor, {});
    for (const row of left) {
      let lifecycle = 0;
      for (const sport of SPORT_KEYS) if (plan.some((c) => c.row === row && c.sport === sport && c.scenario === "LIFECYCLE" && c.variant === variantFor(sport))) lifecycle++;
      expect(lifecycle, row).toBe(SPORT_KEYS.length);
    }
    expect(left.length).toBeGreaterThan(0);
    expect(left).toContain("group_group_ko");
  });
});

describe("planW1Driving — --only and --scenario", () => {
  it("--only a non-slice cell plans that cell's four scenarios (and its test cases if cricket); --scenario narrows", () => {
    expect(planW1Driving(variantFor, { only: "league_ko|football" }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "R4", "F1"]);
    expect(planW1Driving(variantFor, { only: "page_playoff_only|generic" }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "R4"]);
    const leagueTests = cricketTests().filter((c) => c.row === "league");
    expect(leagueTests.length).toBe(3);
    const lc = planW1Driving(variantFor, { only: "league|cricket", scenario: "LIFECYCLE" });
    expect(lc.filter((c) => c.variant === "test").map((c) => c.caseId)).toEqual(leagueTests.map((vc) => `league|cricket|test|LIFECYCLE|${vc.id}`));
    expect(lc.filter((c) => c.variant !== "test").map((c) => c.caseId)).toEqual([`league|cricket|${variantFor("cricket")}|LIFECYCLE`]);
    // Without --scenario: the four grid cases, then the cell's test cases.
    expect(planW1Driving(variantFor, { only: "league|cricket" }).length).toBe(4 + leagueTests.length);
    // A scenario the test cases do not run: the grid case alone.
    expect(planW1Driving(variantFor, { only: "league|cricket", scenario: "M1" }).map((c) => c.caseId)).toEqual([`league|cricket|${variantFor("cricket")}|M1`]);
  });
  it("--scenario alone narrows the whole grid to that scenario (and keeps the test cases only for LIFECYCLE)", () => {
    const cells = ROW_KEYS.length * SPORT_KEYS.length;
    expect(planW1Driving(variantFor, { scenario: "M1" }).length).toBe(cells);
    expect(planW1Driving(variantFor, { scenario: "F1" }).length).toBe(cells - 11);
    expect(planW1Driving(variantFor, { scenario: "LIFECYCLE" }).length).toBe(cells + 24);
  });
  it("every sport of the registry, one row: --only <row>|<sport> plans its four scenarios on that sport's variant (and cricket its test case)", () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const plan = planW1Driving(variantFor, { only: `league_ko|${sport}` });
      const grid = W1_DRIVING_SCENARIOS.map((s) => `league_ko|${sport}|${variantFor(sport)}|${s}`);
      const tests = sport === "cricket" ? cricketTests().filter((c) => c.row === "league_ko").map((vc) => `league_ko|cricket|test|LIFECYCLE|${vc.id}`) : [];
      expect(plan.map((c) => c.caseId), sport).toEqual([...grid, ...tests]);
      checked++;
    }
    expect(checked).toBe(SPORT_KEYS.length);
    expect(checked).toBeGreaterThan(1);
  });
  it("a second call with another filter is independent of the first", () => {
    const a = planW1Driving(variantFor, { only: "ladder|generic", scenario: "R4" }).map((c) => c.caseId);
    const b = planW1Driving(variantFor, { only: "mexicano|generic", scenario: "M1" }).map((c) => c.caseId);
    expect(a).toEqual([`ladder|generic|${variantFor("generic")}|R4`]);
    expect(b).toEqual([`mexicano|generic|${variantFor("generic")}|M1`]);
    expect(planW1Driving(variantFor, { only: "ladder|generic", scenario: "R4" }).map((c) => c.caseId)).toEqual(a);
  });
});

describe("planW1Driving — its guards", () => {
  const withTests = (f: (c: VariantCase) => VariantCase) => () => {
    const file = readVariantsFile();
    return { sports: file.sports.map((s) => (s.sport === "cricket" ? { ...s, cases: s.cases.map((c) => (c.preset === "test" ? f(c) : c)) } : s)) };
  };
  it("a cricket test case the committed file marks unscorable is refused by name (BoundVariantUnscorable)", () => {
    const first = cricketTests()[0]!;
    const variants = withTests((c) => (c.id === first.id ? { ...c, scorable: "no decider" } : c));
    expect(() => planW1Driving(variantFor, {}, { variants })).toThrow(BoundVariantUnscorable);
    expect(() => planW1Driving(variantFor, {}, { variants })).toThrow(first.id);
  });
  it("…and one the engine refuses on a re-score today is refused too", () => {
    const first = cricketTests()[0]!;
    const rescore = (vc: VariantCase) => (vc.id === first.id ? "fold refused" : null);
    expect(() => planW1Driving(variantFor, {}, { rescore })).toThrow(`re-scored now: fold refused`);
  });
  it("an --only on another cell never re-scores cricket's test cases", () => {
    let rescored = 0;
    const rescore = () => { rescored++; return null; };
    planW1Driving(variantFor, { only: "league_ko|football" }, { rescore });
    expect(rescored).toBe(0);
    planW1Driving(variantFor, { only: "league|cricket" }, { rescore });
    expect(rescored).toBe(3);
  });
  it("the atom map is checked against the scenario catalogue: an atom mapped to another script is refused by name", () => {
    expect(atomsOf()).toEqual(ATOM_OF);
    expect(() => atomsOf({ ...HARNESS_SCENARIO, R4a: "M1" })).toThrow(ScriptAtomMismatch);
    expect(() => atomsOf({ ...HARNESS_SCENARIO, R4a: "M1" })).toThrow("atom R4a drives M1 in HARNESS_SCENARIO, but the set plans it as R4");
    const { F1: _gone, ...noF1 } = HARNESS_SCENARIO;
    expect(() => atomsOf(noF1)).toThrow("atom F1 drives no script");
    // A new atom mapped onto an existing script (tomorrow's W3) leaves the set's map intact.
    expect(atomsOf({ ...HARNESS_SCENARIO, M2: "M1" })).toEqual(ATOM_OF);
  });
  it("the whole set with no committed cricket test case is refused by name (ruling 48's 24 never silently missing)", () => {
    const variants = () => ({ sports: readVariantsFile().sports.map((s) => (s.sport === "cricket" ? { ...s, cases: s.cases.filter((c) => c.preset !== "test") } : s)) });
    expect(() => planW1Driving(variantFor, {}, { variants })).toThrow(NoTestVariantCases);
    // A filtered run is not the whole set: a non-cricket cell never needs them.
    expect(planW1Driving(variantFor, { only: "league|generic" }, { variants }).length).toBe(4);
  });
  it("drops are read under the catalogue ATOM (R4a), never the script name (R4) — the one scenario where they differ", () => {
    expect(ATOM_OF.R4).not.toBe("R4");
    const byAtom = dropIndexOf({ groups: [{ scenario: ATOM_OF.R4, reason: "atom drop", cells: { ladder: ["generic"] } }] });
    expect(planW1Driving(variantFor, { only: "ladder|generic" }, { drops: () => byAtom }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "F1"]);
    const byScript = dropIndexOf({ groups: [{ scenario: "R4", reason: "script-named drop", cells: { ladder: ["generic"] } }] });
    expect(planW1Driving(variantFor, { only: "ladder|generic" }, { drops: () => byScript }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "R4", "F1"]);
  });
  it("an injected drop list is the one honoured (drops: what the set reads, not a constant)", () => {
    const drops = dropIndexOf({ groups: [{ scenario: "M1", reason: "test drop", cells: { league_ko: ["football"] } }] });
    expect(planW1Driving(variantFor, { only: "league_ko|football" }, { drops: () => drops }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "R4", "F1"]);
    // …and with it, page_playoff_only's F1 is no longer dropped.
    expect(planW1Driving(variantFor, { only: "page_playoff_only|generic" }, { drops: () => drops }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "R4", "F1"]);
  });
});

describe("the committed-file readers (PF-11)", () => {
  it("readDropIndex reads the committed drop list: the one F1 group answers, a cell outside it does not", () => {
    const idx = readDropIndex();
    let hits = 0;
    for (const g of dropFile().groups) for (const [row, sports] of Object.entries(g.cells)) for (const sport of sports) {
      expect(idx.has(g.scenario, row, sport)).toBe(true);
      expect(idx.reason(g.scenario, row, sport)).toBe(g.reason);
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
    expect(idx.has("F1", "league", "generic")).toBe(false);
    expect(idx.reason("F1", "league", "generic")).toBeUndefined();
  });
  it("a drop list without groups[] of {scenario, reason, cells: {row: sport[]}} is refused by name", () => {
    for (const bad of [{}, { groups: "x" }, { groups: [{ scenario: "F1", reason: "r", cells: { league: "generic" } }] }, { groups: [{ reason: "r", cells: {} }] }]) {
      expect(() => dropIndexOf(bad), JSON.stringify(bad)).toThrow(DropListUnreadable);
    }
  });
  it("readVariantsFile reads the committed variants: every sport, cricket's 24 test cases among them", () => {
    const f = readVariantsFile();
    expect(f.sports.map((s) => s.sport).sort()).toEqual([...SPORT_KEYS].sort());
    expect(f.sports.find((s) => s.sport === "cricket")!.cases.filter((c) => c.preset === "test").length).toBe(cricketTests().length);
  });
});

describe("the w1-driving planner (run.ts --set w1-driving) and the slice planner's fall-through", () => {
  it("the set ACCEPTS --only and --scenario, refuses --canary by name, and reads only the sports it plans", () => {
    const whole = makeW1DrivingPlanner()({});
    expect([...whole.sports]).toEqual([...SPORT_KEYS]);
    expect(whole.deniesFeatures).toBe(false);
    expect(whole.plan(variantFor).length).toBe(937);
    const one = makeW1DrivingPlanner()({ only: "league_ko|football", scenario: "LIFECYCLE" });
    expect([...one.sports]).toEqual(["football"]);
    expect(one.plan(variantFor).map((c) => c.caseId)).toEqual([`league_ko|football|${variantFor("football")}|LIFECYCLE`]);
    expect(() => makeW1DrivingPlanner()({ canary: "M1" })).toThrow(W1DrivingTakesNoCanary);
  });
  it("a bad filter is refused when the planner is BUILT (before the DB), not when it plans", () => {
    expect(() => makeW1DrivingPlanner()({ only: "league_ko|nope" })).toThrow(UnknownFilter);
    expect(() => makeW1DrivingPlanner()({ only: "page_playoff_only|generic", scenario: "F1" })).toThrow(W1DrivingPlansNothing);
  });
  it("the slice planner's slice-cell output is unchanged (committed plans stay frozen)", () => {
    const p = slicePlanner({ only: "league|generic" });
    expect([...p.sports]).toEqual(["generic", "badminton"]);
    expect(p.plan(variantFor).map((c) => c.caseId)).toEqual(["LIFECYCLE", "M1", "R4", "F1"].map((s) => `league|generic|${variantFor("generic")}|${s}`));
    expect(slicePlanner({}).plan(variantFor).length).toBe(24);
  });
  it("the slice planner given a catalogue cell outside the slice plans that cell (and declares its sport)", () => {
    const p = slicePlanner({ only: "league_ko|football" });
    expect([...p.sports]).toEqual(["football"]);
    expect(p.plan(variantFor).map((c) => c.caseId)).toEqual(["LIFECYCLE", "M1", "R4", "F1"].map((s) => `league_ko|football|${variantFor("football")}|${s}`));
    const q = slicePlanner({ only: "group_group_ko|generic", scenario: "LIFECYCLE" });
    expect(q.plan(variantFor).map((c) => c.caseId)).toEqual([`group_group_ko|generic|${variantFor("generic")}|LIFECYCLE`]);
    expect(() => slicePlanner({ only: "nope|generic" })).toThrow(UnknownFilter);
  });
});
