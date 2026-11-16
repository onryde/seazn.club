import { badmintonPadRules, tabletennisPadRules, volleyballPadRules } from "@seazn/engine/pad";
import type { RallyRules } from "./rally-match";

/**
 * The rally sports with a demo, and the rules each demo plays to, read from the engine's own declarations so a demo
 * cannot drift from the real pad: the target of every set (the deciding set has its own in volleyball), the match
 * length, and the score bound.
 *
 * SERVER ONLY, like cricket-chase-rules.ts: the page reads these and hands plain numbers to the island. Importing the
 * engine on the island's side puts hundreds of kilobytes of script on a public page.
 */
export const RALLY_SPORTS = ["badminton", "tabletennis", "volleyball"] as const;
export type RallySport = (typeof RALLY_SPORTS)[number];

const ENGINE = { badminton: badmintonPadRules, tabletennis: tabletennisPadRules, volleyball: volleyballPadRules } as const;

function rulesOf(sport: RallySport): RallyRules {
  const e = ENGINE[sport];
  const bestOf = e.bestOf({});
  return { bestOf, targets: Array.from({ length: bestOf }, (_, i) => e.setTarget({}, i)), bound: e.scoreBound({}) };
}

export const RALLY_RULES: Record<RallySport, RallyRules> = {
  badminton: rulesOf("badminton"),
  tabletennis: rulesOf("tabletennis"),
  volleyball: rulesOf("volleyball"),
};
