// --set match-day and --set void-proof (W1d Task 14, items 15c-15e): the two
// browser sets that run league|badminton at BOTH ends of the width range — 1280
// (L1) and 320 (L2, a phone) — because each owes something to both:
//
//   match-day   LIFECYCLE on a division dated today. The run sheet's default
//               filter is "today" on a match day (D17), read on the rail's first
//               visit, before any page object widens it; and below 768 the rail
//               is folded, so the page object opens it (15d: fold-branch).
//   void-proof  VOIDPROOF: the first fixture's first score event is voided from
//               the console's Void last entry (15e), and the ledger and the fold
//               are held to it before the division plays on.
//
// Both are layered (each case carries its own width, run.ts LayeredPlanner) and
// run under --driver browser only. The run is labelled L2 — it holds a phone
// width — while each case keeps ruling 39's own layer (1280 is L1, a phone
// width L2: layerOfWidth). Neither takes a filter: one case per width has
// nothing to scope. Like pad-proof-set.ts this module imports nothing from
// lib/pads/index.ts (the browser layer stays out of run.ts's static closure,
// boundary.test.ts).
import { L1_WIDTH, layerOfWidth, type DrivenLayerCase } from "./layers.ts";
import { SetTakesNoFilter } from "./probe-set.ts";
import { planSliceCases } from "./slice.ts";
import type { CaseSpec } from "./scenarios/types.ts";
import type { BrowserWidth } from "./widths.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanLayers } from "../run.ts";

export const MATCH_DAY_SET = "match-day";
export const VOID_PROOF_SET = "void-proof";

/** The widths both sets run at, in order: the desktop layer first, then one phone (320, the narrowest of L2). */
const WIDTHS: readonly BrowserWidth[] = Object.freeze([L1_WIDTH, 320] as const);
const ROW = "league";
const SPORT = "badminton";

const at = (spec: CaseSpec, width: BrowserWidth): DrivenLayerCase => ({ spec, layer: layerOfWidth(width), width, noPath: null, notRun: null, run: null });

/** `--set match-day`: the slice's own league|badminton LIFECYCLE case, marked a match day, at each width. */
export const matchDayPlanner: PlanLayers = (cli) => {
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(MATCH_DAY_SET, cli);
  return {
    sports: [SPORT], deniesFeatures: false, layer: "L2", label: `--set ${MATCH_DAY_SET}`, acceptsWidth: null,
    layered: (variantFor) => {
      const [base] = planSliceCases(variantFor, { only: `${ROW}|${SPORT}`, scenario: "LIFECYCLE" });
      if (base === undefined) throw new Error(`match-day: the slice plans no ${ROW}|${SPORT} LIFECYCLE case`);
      return WIDTHS.map((w) => at({ ...base, matchDay: true }, w));
    },
  };
};

/** `--set void-proof`: league|badminton VOIDPROOF at each width. VOIDPROOF is no slice scenario (slice.ts
 *  SliceScenarioKey), so the spec is built here, as pad-proof-set.ts builds PADPROOF's. */
export const voidProofPlanner: PlanLayers = (cli) => {
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(VOID_PROOF_SET, cli);
  return {
    sports: [SPORT], deniesFeatures: false, layer: "L2", label: `--set ${VOID_PROOF_SET}`, acceptsWidth: null,
    layered: (variantFor) => {
      const variant = variantFor(SPORT);
      return WIDTHS.map((w) => at({ caseId: `${ROW}|${SPORT}|${variant}|VOIDPROOF`, row: ROW, sport: SPORT, variant, scenario: "VOIDPROOF", canary: false }, w));
    },
  };
};
