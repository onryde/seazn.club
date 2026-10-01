// --set w1-driving (W1-driving Task 12, ruling 48): every catalogue cell
// (ROW_KEYS × SPORT_KEYS) × the four scripted scenarios, less what the
// COMMITTED drop list drops, then every committed cricket `test` variant case
// (LIFECYCLE, its override on the wire). Unlike the other named sets it takes
// `--only <row>|<sport>` and `--scenario KEY`, and the slice planner hands it
// any `--only` cell outside the slice (run.ts slicePlanner).
//
// Everything is derived: the cells from the catalogue registry, the drops
// from drop-list.json (keyed by catalogue ATOM — R4a — where the plan is keyed
// by script — R4), the variant cases from variants.json. A filter that plans
// nothing is refused by name (UnknownFilter, or W1DrivingPlansNothing with
// the drop's reason), never read as "run zero cases".
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROW_KEYS, SPORT_KEYS, type RowKey } from "./catalogue.ts";
import { requireScorable } from "./probe-set.ts";
import { HARNESS_SCENARIO, LIFECYCLE_ID } from "./scenario-catalogue.ts";
import type { CaseSpec, ScenarioKey } from "./scenarios/types.ts";
import { UnknownFilter, checkCellFilter } from "./slice.ts";
import { scorable, type VariantCase } from "./variants.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanCases } from "../run.ts";

export const W1_DRIVING_SET = "w1-driving";
export const W1_DRIVING_SCENARIOS = ["LIFECYCLE", "M1", "R4", "F1"] as const satisfies readonly ScenarioKey[];
export type W1DrivingScenario = (typeof W1_DRIVING_SCENARIOS)[number];

/** The catalogue atom each script drives — the key the drop list uses. */
const ATOM_OF: Readonly<Record<W1DrivingScenario, string>> = Object.freeze({ LIFECYCLE: LIFECYCLE_ID, M1: "M1", R4: "R4a", F1: "F1" });

/** The variant cases ruling 48 adds to the grid: cricket's `test` preset. */
const TEST_SPORT = "cricket";
const TEST_PRESET = "test";

const CATALOGUE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "catalogue");

/** The scenario catalogue no longer maps an atom to the script this set
 *  plans for it — the drop list would be read under the wrong key. */
export class ScriptAtomMismatch extends Error {
  constructor(script: string, atom: string, mapped: string | undefined) {
    super(`w1-driving: atom ${atom} drives ${mapped ?? "no script"} in HARNESS_SCENARIO, but the set plans it as ${script}`);
    this.name = "ScriptAtomMismatch";
  }
}

/** Each script's atom, checked against the scenario catalogue's own map. */
export function atomsOf(harness: Readonly<Record<string, string>> = HARNESS_SCENARIO): Readonly<Record<W1DrivingScenario, string>> {
  for (const s of W1_DRIVING_SCENARIOS) if (harness[ATOM_OF[s]] !== s) throw new ScriptAtomMismatch(s, ATOM_OF[s], harness[ATOM_OF[s]]);
  return ATOM_OF;
}

// --- the committed files (PF-11: tiny readers, each with its own test) -------

export interface DropIndex {
  has(atom: string, row: string, sport: string): boolean;
  /** The committed drop's reason, or undefined when the cell is not dropped. */
  reason(atom: string, row: string, sport: string): string | undefined;
}

export class DropListUnreadable extends Error {
  constructor(why: string) {
    super(`w1-driving: drop-list.json is not groups[] of {scenario, reason, cells: {row: sport[]}} — ${why}`);
    this.name = "DropListUnreadable";
  }
}

const DropListSchema = z.object({
  groups: z.array(z.object({ scenario: z.string().min(1), reason: z.string(), cells: z.record(z.string(), z.array(z.string())) })),
});

/** An index over a drop list's groups, keyed by (atom, row, sport). */
export function dropIndexOf(file: unknown): DropIndex {
  const parsed = DropListSchema.safeParse(file);
  if (!parsed.success) throw new DropListUnreadable(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  const reasons = new Map<string, string>();
  const key = (atom: string, row: string, sport: string) => `${atom}|${row}|${sport}`;
  for (const g of parsed.data.groups) for (const [row, sports] of Object.entries(g.cells)) for (const sport of sports) reasons.set(key(g.scenario, row, sport), g.reason);
  return { has: (a, r, s) => reasons.has(key(a, r, s)), reason: (a, r, s) => reasons.get(key(a, r, s)) };
}

export const readDropIndex = (): DropIndex => dropIndexOf(JSON.parse(readFileSync(resolve(CATALOGUE, "drop-list.json"), "utf8")));

export interface VariantsFile { readonly sports: readonly { readonly sport: string; readonly cases: readonly VariantCase[] }[] }

export const readVariantsFile = (): VariantsFile => JSON.parse(readFileSync(resolve(CATALOGUE, "variants.json"), "utf8")) as VariantsFile;

// --- the plan ------------------------------------------------------------------

/** A real cell and a real scenario that the committed drop list drops: the
 *  filter plans nothing, and the drop's reason says why. */
export class W1DrivingPlansNothing extends Error {
  constructor(filter: W1DrivingFilter, reasons: readonly string[]) {
    super(`w1-driving: --only ${filter.only ?? "(every cell)"} --scenario ${filter.scenario ?? "(every scenario)"} plans no case — ${reasons.length === 0 ? "nothing matched" : `the committed drop list drops it: ${reasons.join("; ")}`}`);
    this.name = "W1DrivingPlansNothing";
  }
}

/** The whole set found no cricket test case in the committed variants: ruling
 *  48's 24 would silently go missing from the evidence. */
export class NoTestVariantCases extends Error {
  constructor() {
    super(`w1-driving: the committed variants.json holds no ${TEST_SPORT} '${TEST_PRESET}' case`);
    this.name = "NoTestVariantCases";
  }
}

/** --set w1-driving takes --only and --scenario; a canary is the slice's. */
export class W1DrivingTakesNoCanary extends Error {
  constructor(canary: string) {
    super(`w1-driving: --set ${W1_DRIVING_SET} takes --only and --scenario; it takes no --canary (got '${canary}')`);
    this.name = "W1DrivingTakesNoCanary";
  }
}

export interface W1DrivingFilter { only?: string; scenario?: string }
export interface W1DrivingDeps {
  /** The committed drop list (default: catalogue/drop-list.json). */
  drops?: () => DropIndex;
  /** The committed variant set (default: catalogue/variants.json). */
  variants?: () => VariantsFile;
  /** Re-scores a bound case (default: variants.ts scorable). */
  rescore?: (vc: VariantCase) => string | null;
}

interface Selection {
  readonly cells: readonly { readonly row: RowKey; readonly sport: string; readonly scenario: W1DrivingScenario }[];
  readonly tests: readonly VariantCase[];
}

const scenarioOf = (s: string): W1DrivingScenario => {
  const k = W1_DRIVING_SCENARIOS.find((x) => x === s);
  if (k === undefined) throw new UnknownFilter("--scenario", s, W1_DRIVING_SCENARIOS);
  return k;
};

/** Everything but the variant names: checked filters, the drops applied, the
 *  bound test cases re-scored — all before the DB, at planner construction. */
function select(filter: W1DrivingFilter, deps: W1DrivingDeps): Selection {
  const cell = filter.only === undefined ? null : checkCellFilter(filter.only);
  const scenario = filter.scenario === undefined ? null : scenarioOf(filter.scenario);
  const atoms = atomsOf();
  const drops = (deps.drops ?? readDropIndex)();
  const cells: { row: RowKey; sport: string; scenario: W1DrivingScenario }[] = [];
  const reasons: string[] = [];
  for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) {
    if (cell !== null && (cell.row !== row || cell.sport !== sport)) continue;
    for (const s of W1_DRIVING_SCENARIOS) {
      if (scenario !== null && scenario !== s) continue;
      const why = drops.reason(atoms[s], row, sport);
      if (why === undefined) cells.push({ row, sport, scenario: s });
      else reasons.push(`${row}|${sport} ${atoms[s]}: ${why}`);
    }
  }
  // The test cases run LIFECYCLE on cricket: read (and re-score) them only when the filter keeps both.
  const wantsTests = (scenario === null || scenario === "LIFECYCLE") && (cell === null || cell.sport === TEST_SPORT);
  let tests: VariantCase[] = [];
  if (wantsTests) {
    const all = ((deps.variants ?? readVariantsFile)().sports.find((x) => x.sport === TEST_SPORT)?.cases ?? []).filter((c) => c.preset === TEST_PRESET);
    if (cell === null && all.length === 0) throw new NoTestVariantCases();
    tests = all.filter((c) => cell === null || c.row === cell.row).map((c) => requireScorable(c, deps.rescore ?? scorable));
  }
  if (cells.length + tests.length === 0) throw new W1DrivingPlansNothing(filter, reasons);
  return { cells, tests };
}

function toCases(sel: Selection, variantFor: (sport: string) => string): CaseSpec[] {
  const out: CaseSpec[] = [];
  for (const c of sel.cells) {
    const v = variantFor(c.sport);
    out.push({ caseId: `${c.row}|${c.sport}|${v}|${c.scenario}`, row: c.row, sport: c.sport, variant: v, scenario: c.scenario, canary: false });
  }
  // probe-set.ts's variant shape exactly.
  for (const vc of sel.tests) {
    out.push({ caseId: `${vc.row}|${vc.sport}|${vc.preset}|LIFECYCLE|${vc.id}`, row: vc.row, sport: vc.sport, variant: vc.preset, scenario: "LIFECYCLE", canary: false, overrides: vc.overrides });
  }
  return out;
}

/** The set's cases, in row × sport × scenario order, then the test cases in
 *  committed order. */
export function planW1Driving(variantFor: (sport: string) => string, filter: W1DrivingFilter, deps: W1DrivingDeps = {}): CaseSpec[] {
  return toCases(select(filter, deps), variantFor);
}

/** The planner run.ts's SETS["w1-driving"] and the slice's fall-through use.
 *  It declares only the sports it plans, so a one-cell run reads (and
 *  compares with the offline default) one sport's variant order, not eleven. */
export function makeW1DrivingPlanner(deps: W1DrivingDeps = {}): PlanCases {
  return (cli) => {
    if (cli.canary !== undefined) throw new W1DrivingTakesNoCanary(cli.canary);
    const sel = select({ only: cli.only, scenario: cli.scenario }, deps);
    const planned = new Set([...sel.cells.map((c) => c.sport), ...sel.tests.map((t) => t.sport)]);
    return {
      sports: SPORT_KEYS.filter((s) => planned.has(s)),
      deniesFeatures: false,
      plan: (variantFor) => toCases(sel, variantFor),
    };
  };
}

export const w1DrivingPlanner: PlanCases = makeW1DrivingPlanner();
