// --set pad-proof (W1c Task 7): one league|<sport>|PADPROOF case per sport with a
// pad adapter, at the builder default the DB's variant order gives it. The set
// reads the sports from lib/pad-sports.ts, a leaf, and never from
// lib/pads/index.ts: run.ts value-imports this module, and the browser layer
// must stay out of its static closure (boundary.test.ts). The set drives the
// pad, so it runs under --driver browser only (CasePlanner.needsBrowser).
// W1d item 15b: `--only league|<sport>` scopes it to that one sport (a pad fault
// is re-run without the other sports' pads); no other filter is taken.
import { PAD_SPORTS } from "./pad-sports.ts";
import { SetTakesNoFilter } from "./probe-set.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanCases } from "../run.ts";

export const PAD_PROOF_SET = "pad-proof";

/** `--only` was not `league|<sport>` of a sport with a pad adapter. */
export class PadProofFilter extends Error {
  constructor(only: string) {
    super(`pad-proof: --only ${JSON.stringify(only)} is not league|<sport> of a sport with a pad adapter (allowed: ${PAD_SPORTS.map((s) => `league|${s}`).join(", ")})`);
    this.name = "PadProofFilter";
  }
}

/** W1d item 15b: the one sport a pad-proof `--only` names. Exactly one `|`, the
 *  `league` row (PADPROOF is a league scenario) and a sport in PAD_SPORTS —
 *  matched, never trimmed or case-folded, so what is planned is what was typed.
 *  The empty string is a value, not "no filter". */
export function padProofSport(only: string): string {
  const parts = only.split("|");
  const sport = PAD_SPORTS.find((s) => s === parts[1]);
  if (parts.length !== 2 || parts[0] !== "league" || sport === undefined) throw new PadProofFilter(only);
  return sport;
}

export const padProofPlanner: PlanCases = (cli) => {
  // A scenario is PADPROOF's own, and a canary is another plan: refused, naming what was given (never a --only that was fine).
  if (cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(PAD_PROOF_SET, { ...cli, only: undefined });
  const sports = cli.only === undefined ? PAD_SPORTS : [padProofSport(cli.only)];
  return {
    sports,
    deniesFeatures: false,
    needsBrowser: true,
    plan: (variantFor) => sports.map((sport) => {
      const variant = variantFor(sport);
      return { caseId: `league|${sport}|${variant}|PADPROOF`, row: "league", sport, variant, scenario: "PADPROOF", canary: false };
    }),
  };
};
