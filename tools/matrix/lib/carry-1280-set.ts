// --set carry8-1280 (W1d Task 14, item 15f): forfeit and withdraw, in the
// browser, at 1280. M1 is the walkover (the console's forfeit) and R4 the
// withdrawal (the entrants tab's withdraw and its cascade); each runs on a
// league (generic) and on a knockout (badminton) — the slice's own cells and
// specs, exactly as the committed M1/R4 runs plan them, here at L1.
//
// Layered (run.ts LayeredPlanner), browser only, takes no filter and no --width
// other than its own 1280.
import { L1_WIDTH, type DrivenLayerCase } from "./layers.ts";
import { SetTakesNoFilter } from "./probe-set.ts";
import { planSliceCases } from "./slice.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanLayers } from "../run.ts";

export const CARRY8_1280_SET = "carry8-1280";

/** The cells, in plan order, and the scripts each one runs. */
const CELLS = Object.freeze(["league|generic", "knockout|badminton"] as const);
const SCRIPTS = Object.freeze(["M1", "R4"] as const);

export const carry8Planner: PlanLayers = (cli) => {
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(CARRY8_1280_SET, cli);
  return {
    sports: [...new Set(CELLS.map((c) => c.split("|")[1]))], deniesFeatures: false, layer: "L1", label: `--set ${CARRY8_1280_SET}`, acceptsWidth: L1_WIDTH,
    layered: (variantFor) => CELLS.flatMap((cell) => SCRIPTS.map((scenario): DrivenLayerCase => {
      const [spec] = planSliceCases(variantFor, { only: cell, scenario });
      if (spec === undefined) throw new Error(`carry8-1280: the slice plans no ${cell} ${scenario} case`);
      return { spec, layer: "L1", width: L1_WIDTH, noPath: null, notRun: null, run: null };
    })),
  };
};
