// footballPadRules (pad wave P1.2): the football facts the v3 football skin used to copy, as one record. A facade, not a second source: each
// member is the object football.ts and its fold declare (toBe), or a function over them. The one thing this file adds is the cfg coercion:
// the skin hands a view's `cfg` over as `unknown` (an unfolded pad, a unit fixture and a resolved cfg all reach it), so a missing or
// non-object cfg reads as `{}` - halves mode, no extra time, no caps - exactly as the skin's own `asCfg` did.
import {
  CardColor,
  CardReason,
  FOOTBALL_FIDELITY,
  FOOTBALL_TEAM_SIZE,
  PLAY_PHASES,
  PenaltyOffence,
  PenaltyOutcome,
  eventAllowedInPhase,
  legalPeriodMarkers,
  periodMarkers,
  reentryAllowed,
  subWindowsCap,
  type FootballCfg,
} from "../sports/football/football.ts";
import type { FootballPadRules } from "./types.ts";

/** The leaves of a football cfg the pad reads. A resolved FootballCfg is one; so is `{}`. */
type PartialCfg = Partial<Pick<FootballCfg, "halves" | "extraTime" | "rollingSubs" | "subWindows">>;

function cfgOf(cfg: unknown): PartialCfg {
  return cfg !== null && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
}

export const footballPadRules: FootballPadRules = {
  eventBands: FOOTBALL_FIDELITY,
  cardColors: CardColor.options,
  cardReasons: CardReason.options,
  penaltyOutcomes: PenaltyOutcome.options,
  penaltyOffences: PenaltyOffence.options,
  playPhases: PLAY_PHASES,
  teamSizeDefault: FOOTBALL_TEAM_SIZE,
  subWindowsCap: (cfg) => subWindowsCap(cfgOf(cfg)),
  eventAllowedInPhase: (eventType, phase, cfg) => eventAllowedInPhase(eventType, phase, cfgOf(cfg)),
  periodMarkers: (cfg) => periodMarkers(cfgOf(cfg)),
  legalPeriodMarkers: (phase, cfg) => legalPeriodMarkers(phase, cfgOf(cfg)),
  reentryAllowed: (cfg) => reentryAllowed(cfgOf(cfg)),
};
