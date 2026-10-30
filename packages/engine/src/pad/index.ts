// @seazn/engine/pad - the rule facts the ScoringPad v3 skins used to copy, declared once in the engine (pad wave, spec
// 2026-10-29-pad-wave-and-2b-design.md section 3). A facade, not a second source: each later export is the same object the fold
// reads or a pure derivation of it. Phone-safe (listed in phone-subpaths.json): no node:*, no React, no display strings.
//
// P0.1 ships the per-sport record types and the PadSpec lookups. Each later batch adds `export const <sport>PadRules: <Type>` below
// (P4 also adds POST_PHASES).
export type * from "./types.ts";
export { padFieldOf, padEnumValues, padNumberBound } from "./spec-lookup.ts";
export type { PadFieldScope } from "./spec-lookup.ts";

// One region per batch: P1, P2 and P3 run in parallel, so each appends its exports under its own marker (a blank line
// apart) and the merges do not touch one another's lines.

// P1: period + football
// Load-time work in a record runs when THIS barrel is imported, outside every error boundary: v3/registry.ts imports every skin,
// scorepad/registry.tsx imports that, and fixture-console.tsx and device-score-pad.tsx import it, so a throw here would break the
// fixture page and /score/[token] for EVERY sport, server render and client alike - not one sport's pad. (hockey/icehockey parse
// their default and each declared variant cfg when built.) The rule for every later batch: load-time work reads engine constants
// only ({}, module.variants, the module's own tables), never env or stored data, so a refusal is deterministic and fails every suite
// that imports the barrel at collection. Keep the records eager: a lazy build would only move that throw to a sport's first render.
export { hockeyPadRules, icehockeyPadRules } from "./period.ts";
export { footballPadRules } from "./football.ts";

// P2: cricket
import {
  BOWLER_CREDITED_KINDS,
  CRICKET_FIDELITY,
  CricketBall,
  CricketCfg,
  CricketClose,
  CricketRetire,
  CricketReview,
  CricketToss,
  ExtraKind,
  FIELDER_CREDIT_COLUMN,
  FIELDER_OPTIONAL_KINDS,
  FREE_HIT_DISMISSAL_KINDS,
  NO_BALL_DEFAULT_RUNS,
  PENALTY_RUNS,
  SUPER_OVER_EVENT_TYPES,
  VARIABLE_OUT_KINDS,
  WIDE_DEFAULT_RUNS,
  WicketKind,
} from "../sports/cricket/cricket.ts";
import type { CricketPadRules } from "./types.ts";

/** Cricket. Each field is the declaration the fold (or padSpec) reads in sports/cricket/cricket.ts, or a frozen copy of one of
 *  its sets; `ballsPerOver` reads the one key through its own schema, so an absent key is the schema default and a bad one throws. */
export const cricketPadRules: CricketPadRules = Object.freeze({
  eventBands: CRICKET_FIDELITY,
  wicketKinds: WicketKind.options,
  extraKinds: ExtraKind.options,
  fielderCreditedKinds: Object.freeze(Object.keys(FIELDER_CREDIT_COLUMN)),
  fielderOptionalKinds: Object.freeze([...FIELDER_OPTIONAL_KINDS]),
  freeHitDismissalKinds: Object.freeze([...FREE_HIT_DISMISSAL_KINDS]),
  bowlerCreditedKinds: Object.freeze([...BOWLER_CREDITED_KINDS]),
  variableOutKinds: Object.freeze([...VARIABLE_OUT_KINDS]),
  boundaryValues: Object.freeze(CricketBall.shape.boundary.unwrap().options.map((literal) => literal.value)),
  tossElections: CricketToss.shape.elected.options,
  inningsCloseReasons: CricketClose.shape.reason.unwrap().options,
  retireReasons: CricketRetire.shape.reason.options,
  reviewKinds: CricketReview.shape.kind.options,
  reviewOutcomes: CricketReview.shape.outcome.options,
  penaltyRuns: PENALTY_RUNS,
  wideDefaultRuns: WIDE_DEFAULT_RUNS,
  noBallDefaultRuns: NO_BALL_DEFAULT_RUNS,
  superOverEventTypes: Object.freeze([...SUPER_OVER_EVENT_TYPES]),
  ballsPerOver: (cfg: unknown): number =>
    CricketCfg.shape.ballsPerOver.parse(cfg !== null && typeof cfg === "object" ? (cfg as { ballsPerOver?: unknown }).ballsPerOver : undefined),
});

// P3: set-based + tennis
export { badmintonPadRules, tabletennisPadRules, volleyballPadRules } from "./setbased.ts";
export { tennisPadRules } from "./tennis.ts";

// P4: carrom, boardgame, generic, POST_PHASES
export { boardgamePadRules, carromPadRules, genericPadRules } from "./small-sports.ts";
