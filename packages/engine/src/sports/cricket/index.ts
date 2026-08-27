// Cricket SportModule — spec 04 §2 + engine/sports/cricket.md (PROMPT-05).
export {
  cricket,
  CricketCfg,
  CricketEv,
  CricketBall,
  CricketInningsSummary,
  CricketToss,
  CricketRevise,
  CricketPlayerLine,
  // W4 domain audit — see DOMAIN.md.
  CricketClose,
  CricketWicket,
  CricketRetire,
  CricketNewBall,
  CricketPowerplay,
  CricketReview,
  // R2b-next — apps/web's next-innings targeting fix (a public mirror of the
  // private battingSideAt/maxInningsCount innings-sequencing rule).
  nextBattingSide,
  // R2c — two rules the v3 pad must mirror rather than fork, so it can refuse
  // an illegal pick BEFORE the tap instead of surfacing a generic 422 after it.
  eligibleBowlers,
  reviewsRemaining,
  // R3.5 — the pad must not re-derive "which innings is being played". Same
  // posture as nextBattingSide/eligibleBowlers/reviewsRemaining above: a
  // public mirror of a private rule, so the pad mirrors rather than forks.
  activeInnings,
  // R3.5 Task S — the ICC super-over alternation rule, the one member of
  // this family still missing its export; see its own doc (cricket.ts) for
  // the live 422 that gap caused.
  soBattingSideAt,
  // R3.5 F1 (review finding) — the super-over batter-eligibility predicate,
  // exported so the pad's default-picker reuses it instead of forking a
  // third copy; see its own doc (cricket.ts) for the live 422 that caused.
  soEligibleBatters,
  type ActiveInnings,
  type OverBowlerFacts,
  type CricketBallEv,
  type CricketState,
  type InningsState,
  type FieldingCredit,
  type PowerplayBlock,
  type ReviewLedger,
} from "./cricket.ts";
// `resources` is the RAW table primitive (six-ball overs, ten-wicket innings).
// Anything holding cfg-scaled quantities must use `resourcesFromBalls` (#451).
export {
  DLS_STANDARD_TABLE,
  DLS_G50,
  DLS_EDITION,
  DLS_TABLE_BALLS_PER_OVER,
  DLS_TABLE_WICKETS,
  resources,
  resourcesFromBalls,
  dlsTarget,
  dlsPar,
} from "./dls.ts";
