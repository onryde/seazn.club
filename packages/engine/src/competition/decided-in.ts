// W2d (spec §5.1, §5.2, D4) — how a decided match was decided, as the table reads it: a pure function of the stored
// outcome (`fixtures.outcome`), evaluated at standings time. No column holds it.
import type { MatchOutcome } from "../core/types.ts";
import type { AnySportModule, DecidedIn } from "../sport/module.ts";

export type { DecidedIn } from "../sport/module.ts";

/** Every decidedIn value, in the order a points editor lists them. */
export const DECIDED_IN: readonly DecidedIn[] = Object.freeze(["regulation", "ot", "so"]);

/**
 * How a won match was decided. null for every outcome kind except `win` (a draw, a tie, a no result, an award, a double
 * walkover) and for an undecided fixture (no outcome yet). A win that names no method is a regulation result — the same
 * reading every `standingsDelta` gives it. Throws CONFIG_INVALID (from `decidedInOf`) for a method the module does not
 * declare, never maps it to regulation.
 */
export function decidedInFor(
  module: Pick<AnySportModule, "decidedInOf">,
  outcome: MatchOutcome | null | undefined,
): DecidedIn | null {
  if (outcome == null || outcome.kind !== "win") return null;
  if (outcome.method === undefined) return "regulation";
  return module.decidedInOf(outcome.method);
}
