// --set pad-innings (W1d Task 12, fix round 1; controller ruling T12-I1): the
// one case that REACHES cricket's two-innings pad route. Item 16 built the route
// and no committed plan took it: every committed `test` case carries a rule
// override, which the browser has no path for (OVERRIDE_ROUTE, W2), and the
// builder default is t20, which is one innings a side. A seam left for later
// ships inert, so this set plans the case that drives it — league|cricket, the
// `test` preset (two innings a side), NO override — under LIFECYCLE, whose pad
// policy is `first`: the streams the pad has no control for (the win/home
// follow-on, the draw's time close) go over http to the wave that owes them, and
// the first stream it CAN write (a plain four-innings win or tie) is tapped.
//
// It is a sibling of pad-proof-set.ts and holds the same line: no import from
// lib/pads/index.ts (run.ts value-imports this module, and the browser layer
// must stay out of its static closure — boundary.test.ts), and it runs under
// --driver browser only (CasePlanner.needsBrowser). It takes no filter: one
// case has nothing to scope. Not `--set pad-proof`, which scores every sport's
// fixtures on the pad under one scenario and is red by construction on `test`.
import { SetTakesNoFilter } from "./probe-set.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanCases } from "../run.ts";

export const PAD_INNINGS_SET = "pad-innings";

/** The preset the case plays. Two innings a side (the engine's cricket `test`
 *  preset); the builder default would plan one innings, which is another route. */
const PAD_INNINGS_VARIANT = "test";

export const padInningsPlanner: PlanCases = (cli) => {
  // The whole set is the one case: a filter would be silently ignored, so it is refused, naming what was given.
  if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(PAD_INNINGS_SET, cli);
  return {
    sports: ["cricket"],
    deniesFeatures: false,
    needsBrowser: true,
    // The variant is the preset's own, never `variantFor`'s: the harness answers the builder default.
    plan: () => [{ caseId: `league|cricket|${PAD_INNINGS_VARIANT}|LIFECYCLE`, row: "league", sport: "cricket", variant: PAD_INNINGS_VARIANT, scenario: "LIFECYCLE", canary: false }],
  };
};
