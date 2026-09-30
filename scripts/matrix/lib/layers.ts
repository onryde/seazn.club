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
//  - `--set width-sweep`: knockout|badminton LIFECYCLE at every L2 width, in
//    order (ruling 39: the stage-rail fold at 320 and at the md breakpoint;
//    owner ruling 43(a) moved it off ruling 39's league cell, because
//    knockout was otherwise never driven below 1280).
//  - `--set api-only-browser`: one case per API-only row on generic, PLANNED
//    🚫 naming the wave that owns its organiser control (D7 as ruled; the
//    controller's Task 12 ruling). No builder control reaches these rows, so
//    the browser layer records them without running them — never a silent
//    pass, never an error red.
//
// A PLANNED case (🚫/░) is recorded by run.ts without a driver, an org or a
// check (N-3), so it reaches results.json and MATRIX.md as its state and is
// never dropped (R13).
//
// run.ts value-imports this module, so its static closure must stay clear of
// lib/browser and lib/pads (boundary.test.ts): the D7 wave table comes from
// the leaf api-only-ui.ts, never from browser-driver.ts.
import { API_ONLY_ROWS, cellId, type RowKey } from "./catalogue.ts";
import { apiOnlyUiPath } from "./api-only-ui.ts";
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

export const WIDTH_SWEEP_SET = "width-sweep";
export const API_ONLY_BROWSER_SET = "api-only-browser";

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

/** D7 as ruled: each API-only row, on generic, at 1280 — planned 🚫 naming the
 *  wave that owns its organiser control (api-only-ui.ts). */
export const apiOnlyBrowserPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseFilters(API_ONLY_BROWSER_SET, cli);
  const sport = "generic";
  return {
    sports: [sport], deniesFeatures: false, layer: "L1", label: `--set ${API_ONLY_BROWSER_SET}`, acceptsWidth: L1_WIDTH,
    layered: (variantFor) => {
      const variant = variantFor(sport);
      return API_ONLY_ROWS.map((row): PlannedLayerCase => {
        const p = apiOnlyUiPath(row, sport);
        return {
          spec: null, identity: { caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE },
          layer: "L1", width: L1_WIDTH, noPath: { wave: p.wave, reason: p.reason }, notRun: null, run: null,
        };
      });
    },
  };
};
