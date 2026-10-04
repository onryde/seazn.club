// W1c Task 12: the layer planners (design §6; plan D1 as ruled 39, D5, D7).
//
//  - L1 (planL1, `--layer L1`): the slice's cells × one scenario (LIFECYCLE
//    unless --scenario names another) at 1280 ONLY. Ruling 39: L1 proves the
//    organiser's desk; the phone path is proven by L2, the width sweep and
//    pad proof at 320.
//  - L2 (planL2, `--layer L2`): the COMMITTED l2-pairs.json rotation, filtered
//    to the slice's cells and never re-planned — each run keeps its own n,
//    atom, row, sport, preset and width. A run whose atom has a harness script
//    (HARNESS_SCENARIO) is driven; one whose atom has a known path gap
//    (knownNoPath, else l2NoPath) is 🚫 naming that wave; every other run is
//    ░ "no scenario script yet" (D5 — W1c writes no new scenario script).
//  - `--scope grid` (W1d Task 3, owner ruling 64): the FULL grid of each layer.
//    L1 (planL1Grid, `--layer L1 --scope grid`) is one LIFECYCLE case per
//    catalogue cell at 1280 — 231: a builder row and every API-only cell a
//    catalog template reaches are driven, the rest are 🚫 naming their wave.
//    L2 (`--layer L2 --scope grid`) is planL2 over every cell, i.e. every run of
//    l2-pairs.json (1,731), each driven, 🚫 or ░ exactly as the slice's are.
//    `--scope slice` (the default, so a bare `--layer L1` is unchanged) is the
//    two planners above; the grid planners sit in their own table
//    (LAYER_GRID_PLANNERS) and take no filter.
//  - `--set width-sweep`: knockout|badminton LIFECYCLE at every L2 width, in
//    order (ruling 39: the stage-rail fold at 320 and at the md breakpoint;
//    owner ruling 43(a) moved it off ruling 39's league cell, because
//    knockout was otherwise never driven below 1280).
//  - `--set api-only-browser`: one case per API-only row on generic, PLANNED
//    🚫 naming the wave that owns its organiser control (D7 as ruled; the
//    controller's Task 12 ruling). No builder control reaches these rows, so
//    the browser layer records them without running them — never a silent
//    pass, never an error red.
//  - `--set w1-driving-l1` (W1-driving Task 13, ruling 47, D11, D13): one L1
//    cell per capability W1-driving added (team rosters, the seed advance, the
//    ladder, americano, mexicano), then the two template-only cells, each
//    carrying its catalog template so its case sets up through the gallery
//    card — at 1280, LIFECYCLE, driven.
//
// A PLANNED case (🚫/░) is recorded by run.ts without a driver, an org or a
// check (N-3), so it reaches results.json and MATRIX.md as its state and is
// never dropped (R13).
//
// run.ts value-imports this module, so its static closure must stay clear of
// lib/browser and lib/pads (boundary.test.ts): the D7 wave table comes from
// the leaf api-only-ui.ts, never from browser-driver.ts.
import { API_ONLY_ROWS, ROW_KEYS, SPORT_KEYS, cellId, type ApiOnlyRowKey, type RowKey } from "./catalogue.ts";
import { apiOnlyUiPath } from "./api-only-ui.ts";
import { templateField, templateRow } from "./templates.ts";
import { loadL2Pairs, type L2Run } from "./pairs.ts";
import { SetTakesNoFilter } from "./probe-set.ts";
import { ATOMIC, HARNESS_SCENARIO, type AtomicScenario } from "./scenario-catalogue.ts";
import { SLICE_ROWS, SLICE_SPORTS, checkSliceFilter, planSliceCases } from "./slice.ts";
import { L2_WIDTHS, type BrowserWidth } from "./widths.ts";
import type { CaseSpec, ScenarioKey } from "./scenarios/types.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanLayers, PlannerCli } from "../run.ts";

/** Ruling 39: L1 runs at the organiser's desk width only. */
export const L1_WIDTH = 1280 satisfies BrowserWidth;

/** A width that is neither ruling 39's L1 width nor one of L2_WIDTHS: no layer runs there. */
export class NoLayerForWidth extends Error {
  readonly width: number;
  constructor(width: number) {
    super(`layers: width ${width} is neither L1's ${L1_WIDTH} (ruling 39) nor one of L2_WIDTHS (${L2_WIDTHS.join(", ")}), so no layer runs there`);
    this.name = "NoLayerForWidth";
    this.width = width;
  }
}

/** A PLAIN (unlayered) browser run's layer (Task 12 review fix round 1: it
 *  read L1 at every width). The results schema's layers are L1/L2/L3 only,
 *  none of them "unlayered"; ruling 39 makes L1 the 1280 layer and L2 runs at
 *  the phone widths, so a plain run is labelled by its width — what `--layer
 *  L1` and the width sweep record at that same width. */
export function layerOfWidth(width: BrowserWidth): "L1" | "L2" {
  if (width === L1_WIDTH) return "L1";
  if ((L2_WIDTHS as readonly number[]).includes(width)) return "L2";
  throw new NoLayerForWidth(width);
}

/** 🚫: the wave that owes the path, and why there is none in this layer
 *  (decideState's DecideInput shape — its reason reads `<wave>: <reason>`). */
export interface NoPath { readonly wave: string; readonly reason: string }

/** A case as results.json names it, before the runner's `@<width>`. A driven
 *  case's identity is its spec; a planned one has only this, and its scenario
 *  may be an atom no harness script runs. */
export interface CaseIdentity { readonly caseId: string; readonly row: RowKey; readonly sport: string; readonly variant: string; readonly scenario: string }

interface LayerCaseBase {
  readonly layer: "L1" | "L2";
  readonly width: BrowserWidth;
  /** L2: the committed l2-pairs.json run this case IS, as parsed; null otherwise. */
  readonly run: L2Run | null;
}
/** Driven through the browser at `width`. */
export interface DrivenLayerCase extends LayerCaseBase { readonly spec: CaseSpec; readonly noPath: null; readonly notRun: null }
/** Recorded without a driver: 🚫 or ░, exactly one of them. */
export type PlannedLayerCase = LayerCaseBase & { readonly spec: null; readonly identity: CaseIdentity }
  & ({ readonly noPath: NoPath; readonly notRun: null } | { readonly noPath: null; readonly notRun: string });
export type LayerCase = DrivenLayerCase | PlannedLayerCase;

export const identityOf = (c: LayerCase): CaseIdentity => (c.spec !== null ? c.spec : c.identity);

/** A browser case's result id: its case id at its width (an HTTP case, width null, keeps its id). */
export const atWidth = (caseId: string, width: number | null): string => (width === null ? caseId : `${caseId}@${width}`);
export const layerCaseId = (c: LayerCase): string => atWidth(identityOf(c).caseId, c.width);

const LIFECYCLE: ScenarioKey = "LIFECYCLE";

/** L1: the slice's cells × one scenario, at L1_WIDTH (ruling 39). The filter
 *  is the slice's own (UnknownFilter for a value the slice does not hold). */
export function planL1(variantFor: (sport: string) => string, filter: { only?: string; scenario?: string } = {}): DrivenLayerCase[] {
  return planSliceCases(variantFor, { only: filter.only, scenario: filter.scenario ?? LIFECYCLE })
    .map((spec) => ({ spec, layer: "L1", width: L1_WIDTH, noPath: null, notRun: null, run: null }));
}

/** An L2 run naming an atom the scenario catalogue does not hold: the file and
 *  the catalogue have drifted, and a ░ planned from it would name nothing. */
export class UnknownL2Atom extends Error {
  readonly n: number;
  readonly atom: string;
  constructor(run: L2Run) {
    super(`layers: l2-pairs.json run ${run.n} names atom '${run.scenario}', which the scenario catalogue (ATOMIC) does not hold — the committed file and the catalogue have drifted`);
    this.name = "UnknownL2Atom";
    this.n = run.n;
    this.atom = run.scenario;
  }
}

/** A run that would be DRIVEN binds a variant override. None does today (every
 *  scripted atom's committed run is unbound); driving one would need its
 *  committed override on the wire, which this planner does not build. */
export class L2BoundRun extends Error {
  readonly n: number;
  constructor(run: L2Run) {
    super(`layers: l2-pairs.json run ${run.n} (${run.scenario} at ${run.row}|${run.sport}) has a harness script and binds variant ${run.bound}; an L2 run's bound override is not built — it would run under the preset alone`);
    this.name = "L2BoundRun";
    this.n = run.n;
  }
}

const ATOM: ReadonlyMap<string, AtomicScenario> = new Map(ATOMIC.map((a) => [a.id, a]));
const scriptFor = (atom: string): ScenarioKey | null => (Object.prototype.hasOwnProperty.call(HARNESS_SCENARIO, atom) ? HARNESS_SCENARIO[atom] : null);
const l2CaseId = (r: L2Run): string => `${r.row}|${r.sport}|${r.preset}|${r.scenario}${r.bound === null ? "" : `|${r.bound}`}`;
/** Why a known-gap atom has no path here (design §4's two lists). */
const noPathReason = (a: AtomicScenario): string => (a.knownNoPath !== null
  ? `no organiser path, known at design time (design §4): ${a.title}`
  : `the HTTP route exists and no screen sends it (design §4, ruling 30): ${a.title}`);

/** L2: the committed runs in `cells`, in file order, each exactly as committed. */
export function planL2(pairs: { readonly runs: readonly L2Run[] }, cells: ReadonlySet<string>): LayerCase[] {
  const out: LayerCase[] = [];
  for (const run of pairs.runs) {
    if (!cells.has(cellId(run.row, run.sport))) continue;
    const atom = ATOM.get(run.scenario);
    if (atom === undefined) throw new UnknownL2Atom(run);
    const identity: CaseIdentity = { caseId: l2CaseId(run), row: run.row, sport: run.sport, variant: run.preset, scenario: run.scenario };
    const base = { layer: "L2", width: run.width, run } as const;
    const script = scriptFor(run.scenario);
    if (script !== null) {
      if (run.bound !== null) throw new L2BoundRun(run);
      out.push({ ...base, spec: { ...identity, scenario: script, canary: false }, noPath: null, notRun: null });
      continue;
    }
    const wave = atom.knownNoPath ?? atom.l2NoPath;
    out.push(wave !== null
      ? { ...base, spec: null, identity, noPath: { wave, reason: noPathReason(atom) }, notRun: null }
      : { ...base, spec: null, identity, noPath: null, notRun: `no scenario script yet (atom ${run.scenario})` });
  }
  return out;
}

const SLICE_CELLS: readonly string[] = SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => cellId(r, s)));

/** `--layer L2 --scenario`: L2's scenarios are the committed file's atoms, so
 *  a scenario filter would be silently ignored. parseCli refuses it first. */
export class L2TakesNoScenario extends Error {
  constructor(scenario: string) {
    super(`layers: --layer L2 plans the committed l2-pairs.json runs; it takes no --scenario (got '${scenario}')`);
    this.name = "L2TakesNoScenario";
  }
}

/** `--layer L1`: the slice at 1280; --only / --scenario narrow it. */
export const l1Planner: PlanLayers = (cli: PlannerCli) => {
  checkSliceFilter({ only: cli.only, scenario: cli.scenario });
  return {
    sports: SLICE_SPORTS, deniesFeatures: false, layer: "L1", label: "--layer L1", acceptsWidth: L1_WIDTH,
    layered: (variantFor) => planL1(variantFor, { only: cli.only, scenario: cli.scenario }),
  };
};

/** `--layer L2`: the committed file over the slice's cells (--only narrows to
 *  one). Read and planned HERE, at construction, so a file that does not parse
 *  refuses the run before the DB. The builder default is checked for the
 *  driven cases' sports only: a planned case posts nothing. */
export const l2Planner: PlanLayers = (cli: PlannerCli) => {
  if (cli.scenario !== undefined) throw new L2TakesNoScenario(cli.scenario);
  checkSliceFilter({ only: cli.only });
  const cells = new Set(SLICE_CELLS.filter((c) => cli.only === undefined || c === cli.only));
  const cases = planL2(loadL2Pairs(), cells);
  const sports = [...new Set(cases.flatMap((c) => (c.spec === null ? [] : [c.spec.sport])))];
  return { sports, deniesFeatures: false, layer: "L2", label: "--layer L2", acceptsWidth: null, layered: () => cases };
};

export const LAYER_PLANNERS: Readonly<Record<"L1" | "L2", PlanLayers>> = Object.freeze({ L1: l1Planner, L2: l2Planner });

/** What `--layer` covers: the slice (W1c's six cells and their committed runs,
 *  the default) or the whole grid (W1d, ruling 64). `--scope` chooses it. */
export type LayerScope = "slice" | "grid";

/** Every catalogue cell (ruling 64's full grid), in ROW_KEYS × SPORT_KEYS order. */
export const ALL_CELLS: ReadonlySet<string> = new Set(ROW_KEYS.flatMap((r) => SPORT_KEYS.map((s) => cellId(r, s))));
const isApiOnly = (row: RowKey): row is ApiOnlyRowKey => (API_ONLY_ROWS as readonly string[]).includes(row);

/** A full-grid planner was handed a filter: the grid is the whole grid, so a
 *  filter would be silently ignored. Named for the planner, not for `--set`
 *  (SetTakesNoFilter's words), because the user typed `--layer … --scope grid`. */
export class GridTakesNoFilter extends Error {
  readonly label: string;
  constructor(label: string, cli: PlannerCli) {
    const given = (["only", "scenario", "canary"] as const).filter((k) => cli[k] !== undefined).map((k) => `--${k}`);
    super(`layers: ${label} runs the whole grid; it takes no ${given.join(", ")}`);
    this.name = "GridTakesNoFilter";
    this.label = label;
  }
}
const refuseGridFilters = (label: string, cli: PlannerCli): void => {
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new GridTakesNoFilter(label, cli);
};

/** Ruling 64: the full L1 grid — one LIFECYCLE case per cell at 1280, in ROW_KEYS
 *  × SPORT_KEYS order. A builder row drives with variantFor's variant; an API-only
 *  cell a catalog template reaches drives through that template (its own sport and
 *  variant, D11, as planW1DrivingL1 does); every other API-only cell is 🚫 naming
 *  the wave that owes its organiser control (api-only-ui.ts). */
export function planL1Grid(variantFor: (sport: string) => string): LayerCase[] {
  const at = (spec: CaseSpec): DrivenLayerCase => ({ spec, layer: "L1", width: L1_WIDTH, noPath: null, notRun: null, run: null });
  return ROW_KEYS.flatMap((row) => SPORT_KEYS.map((sport): LayerCase => {
    if (!isApiOnly(row)) {
      const variant = variantFor(sport);
      return at({ caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false });
    }
    const p = apiOnlyUiPath(row, sport);
    if (p.reachable) {
      const { variant } = templateField(p.template);
      return at({ caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false, template: p.template });
    }
    const variant = variantFor(sport);
    return {
      spec: null, identity: { caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE },
      layer: "L1", width: L1_WIDTH, noPath: { wave: p.wave, reason: p.reason }, notRun: null, run: null,
    };
  }));
}

/** `--layer L1 --scope grid`: every cell at 1280, every sport's variant order read once. */
export const l1GridPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseGridFilters("--layer L1 --scope grid", cli);
  return { sports: SPORT_KEYS, deniesFeatures: false, layer: "L1", label: "--layer L1 --scope grid", acceptsWidth: L1_WIDTH, layered: planL1Grid };
};

/** `--layer L2 --scope grid`: planL2 over every cell — every committed run, each
 *  exactly as committed. Read and planned HERE, at construction, as l2Planner
 *  does, so a file that does not parse refuses the run before the DB. */
export const l2GridPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseGridFilters("--layer L2 --scope grid", cli);
  const cases = planL2(loadL2Pairs(), ALL_CELLS);
  const sports = [...new Set(cases.flatMap((c) => (c.spec === null ? [] : [c.spec.sport])))];
  return { sports, deniesFeatures: false, layer: "L2", label: "--layer L2 --scope grid", acceptsWidth: null, layered: () => cases };
};

export const LAYER_GRID_PLANNERS: Readonly<Record<"L1" | "L2", PlanLayers>> = Object.freeze({ L1: l1GridPlanner, L2: l2GridPlanner });

export const WIDTH_SWEEP_SET = "width-sweep";
export const API_ONLY_BROWSER_SET = "api-only-browser";
export const W1_DRIVING_L1_SET = "w1-driving-l1";

const refuseFilters = (set: string, cli: PlannerCli): void => {
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(set, cli);
};

/** Ruling 39's one-off sweep, on the cell owner ruling 43(a) chose: the
 *  organiser lifecycle on knockout|badminton at every L2 width, in order —
 *  the committed `w1c-sweep-ko` evidence. Labelled L2: it runs at L2's widths,
 *  and L1 is 1280 only. */
export const widthSweepPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseFilters(WIDTH_SWEEP_SET, cli);
  const row = "knockout", sport = "badminton";
  return {
    sports: [sport], deniesFeatures: false, layer: "L2", label: `--set ${WIDTH_SWEEP_SET}`, acceptsWidth: null,
    layered: (variantFor) => {
      const variant = variantFor(sport);
      return L2_WIDTHS.map((width): DrivenLayerCase => ({
        spec: { caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false },
        layer: "L2", width, noPath: null, notRun: null, run: null,
      }));
    },
  };
};

/** A 🚫 asked for a cell a catalog template reaches: the cell has an organiser
 *  path (its card), so planning it 🚫 would name a wave that owes nothing. */
export class TemplateReachable extends Error {
  readonly cell: string;
  constructor(row: string, sport: string, template: string) {
    super(`layers: ${row}|${sport} is reachable through catalog template ${template}'s card — plan it driven with that template (--set ${W1_DRIVING_L1_SET}), never 🚫`);
    this.name = "TemplateReachable";
    this.cell = `${row}|${sport}`;
  }
}

/** The 🚫 an API-only cell is planned with (api-only-ui.ts), refusing a cell a template reaches. */
export function apiOnlyNoPath(row: (typeof API_ONLY_ROWS)[number], sport: string): NoPath {
  const p = apiOnlyUiPath(row, sport);
  if (p.reachable) throw new TemplateReachable(row, sport, p.template);
  return { wave: p.wave, reason: p.reason };
}

/** D7 as ruled: each API-only row, on generic, at 1280 — planned 🚫 naming the
 *  wave that owns its organiser control (api-only-ui.ts). */
export const apiOnlyBrowserPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseFilters(API_ONLY_BROWSER_SET, cli);
  const sport = "generic";
  return {
    sports: [sport], deniesFeatures: false, layer: "L1", label: `--set ${API_ONLY_BROWSER_SET}`, acceptsWidth: L1_WIDTH,
    layered: (variantFor) => {
      const variant = variantFor(sport);
      return API_ONLY_ROWS.map((row): PlannedLayerCase => ({
        spec: null, identity: { caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE },
        layer: "L1", width: L1_WIDTH, noPath: apiOnlyNoPath(row, sport), notRun: null, run: null,
      }));
    },
  };
};

/** W1-driving Task 13: the capability cells, each the capability's first L1
 *  proof (the wave's tasks name them): team rosters on football (Task 4 —
 *  carry G-1: the pad adapters' first lineup fixtures), the multi-stage seed
 *  advance on groups_ko (Task 6), the ladder's challenges (Task 7), americano
 *  and mexicano (Task 8). D13: no cricket `test` case — its pad adapter has
 *  no route for the two-innings events (W1d). */
const W1_DRIVING_L1_CELLS: readonly { readonly row: RowKey; readonly sport: string }[] = Object.freeze([
  { row: "league", sport: "football" }, { row: "groups_ko", sport: "badminton" }, { row: "ladder", sport: "generic" },
  { row: "americano", sport: "badminton" }, { row: "mexicano", sport: "generic" },
]);
/** The two template-only cells (ruling 47), by their template: each case's
 *  row is the one the template builds (templateRow, which refuses a drifted
 *  catalog) and its sport and variant are the template's own (templateField,
 *  D11) — never variantFor's builder default. */
const W1_DRIVING_L1_TEMPLATES: readonly string[] = Object.freeze(["box-league", "t20-super8"]);

export function planW1DrivingL1(variantFor: (sport: string) => string): DrivenLayerCase[] {
  const at = (spec: CaseSpec): DrivenLayerCase => ({ spec, layer: "L1", width: L1_WIDTH, noPath: null, notRun: null, run: null });
  const cells = W1_DRIVING_L1_CELLS.map(({ row, sport }) => {
    const variant = variantFor(sport);
    return at({ caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false });
  });
  const templates = W1_DRIVING_L1_TEMPLATES.map((template) => {
    const row = templateRow(template);
    const { sport, variant } = templateField(template);
    return at({ caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false, template });
  });
  return [...cells, ...templates];
}

/** `--set w1-driving-l1`: the seven cases above. Its sports are its cases'
 *  (the template cells' too, so the runner reads their variants as well). */
export const w1DrivingL1Planner: PlanLayers = (cli: PlannerCli) => {
  refuseFilters(W1_DRIVING_L1_SET, cli);
  const sports = [...new Set([...W1_DRIVING_L1_CELLS.map((c) => c.sport), ...W1_DRIVING_L1_TEMPLATES.map((t) => templateField(t).sport)])];
  return {
    sports, deniesFeatures: false, layer: "L1", label: `--set ${W1_DRIVING_L1_SET}`, acceptsWidth: L1_WIDTH,
    layered: (variantFor) => planW1DrivingL1(variantFor),
  };
};
