// Football SportModule — spec 04 §1 + engine/sports/football.md (PROMPT-04).
export {
  football,
  FootballCfg,
  FootballEv,
  FootballGoal,
  FootballCard,
  FootballSub,
  FootballPeriod,
  FootballShootoutKick,
  FOOTBALL_TIEBREAKERS,
  type FootballState,
} from "./football.ts";
// R3.5 — the pad needs football's own alternation and tally rules
// (`footballNextKicker`/`shootoutTally`, plus the kick shape both take; W2e:
// the shared `expectedKicker` takes an order and the attempts, which the pad,
// reading state alone, does not hold, so football binds its own). Re-
// exported from football rather than imported by the pad out of
// `sports/period`: a skin must not reach into another sport family's
// folder, and football is where the pad's contract with these rules
// belongs (the same reason `sports/cricket` re-exports `eligibleBowlers`/
// `nextBattingSide`/`reviewsRemaining` instead of the pad importing
// `sports/core` directly).
export { shootoutTally, type ShootoutKick } from "../period/shootout.ts";
export { footballNextKicker } from "./football.ts";
