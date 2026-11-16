import { footballPadRules, hockeyPadRules, icehockeyPadRules } from "@seazn/engine/pad";

/**
 * The goal sports with a demo, and the card each demo's pad records: the first class the engine itself offers for the
 * sport (a yellow card in football, a green card in hockey, a minor penalty in ice hockey).
 *
 * SERVER ONLY, like rally-rules.ts: the page reads this and hands a plain string to the island.
 */
export const GOAL_SPORTS = ["football", "hockey", "icehockey"] as const;
export type GoalSport = (typeof GOAL_SPORTS)[number];

export const GOAL_RULES: Record<GoalSport, { card: string }> = {
  football: { card: footballPadRules.cardColors[0]! },
  hockey: { card: hockeyPadRules.suspensionClasses({})[0]! },
  icehockey: { card: icehockeyPadRules.suspensionClasses({})[0]! },
};
