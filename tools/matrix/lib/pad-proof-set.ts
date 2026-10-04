// --set pad-proof (W1c Task 7): one league|<sport>|PADPROOF case per sport with a
// pad adapter, at the builder default the DB's variant order gives it. The set
// reads the sports from lib/pad-sports.ts, a leaf, and never from
// lib/pads/index.ts: run.ts value-imports this module, and the browser layer
// must stay out of its static closure (boundary.test.ts). The set drives the
// pad, so it runs under --driver browser only (CasePlanner.needsBrowser).
import { PAD_SPORTS } from "./pad-sports.ts";
import { SetTakesNoFilter } from "./probe-set.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanCases } from "../run.ts";

export const PAD_PROOF_SET = "pad-proof";

export const padProofPlanner: PlanCases = (cli) => {
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(PAD_PROOF_SET, cli);
  return {
    sports: PAD_SPORTS,
    deniesFeatures: false,
    needsBrowser: true,
    plan: (variantFor) => PAD_SPORTS.map((sport) => {
      const variant = variantFor(sport);
      return { caseId: `league|${sport}|${variant}|PADPROOF`, row: "league", sport, variant, scenario: "PADPROOF", canary: false };
    }),
  };
};
