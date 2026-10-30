// footballPadRules (pad wave P1.2): the football facts the v3 football skin used to copy, as one frozen record. A facade, not a second
// source: each member is the object football.ts and its fold declare (toBe), or a function over them. The one thing this file adds is
// the cfg read: every function takes the stored cfg as `unknown` and reads it through football's own configSchema (defaults applied,
// the schema's refusal for an invalid cfg), per the contract in ./types.ts - no fallback typed here.
import {
  CardColor,
  CardReason,
  EVENT_PHASES,
  FOOTBALL_FIDELITY,
  FOOTBALL_TEAM_SIZE,
  FootballCfg,
  PLAY_PHASES,
  PenaltyOffence,
  PenaltyOutcome,
  eventAllowedInPhase,
  legalPeriodMarkers,
  periodMarkers,
  reentryAllowed,
  subWindowsCap,
} from "../sports/football/football.ts";
import type { FootballPadRules } from "./types.ts";

/** The stored cfg, read through the module's own schema: `halves` defaults to 2, `extraTime` to disabled, `rollingSubs` / `subWindows` stay
 *  absent. An invalid cfg throws the schema's own error, as it does everywhere else the cfg is read. */
const resolve = (cfg: unknown): FootballCfg => FootballCfg.parse(cfg);

/** One of football's own event types (EVENT_PHASES' keys, plus `football.period`, the one whose gate reads the cfg), or a throw naming
 *  it - the period records' contract (./types.ts). The fold's own `eventAllowedInPhase` fails open for a type it does not gate; the
 *  record does not, because `true` for `core.start` in H1 would be an answer the fold contradicts. A skin filters first. */
const ownType = (eventType: string): string => {
  if (eventType !== "football.period" && !Object.hasOwn(EVENT_PHASES, eventType)) {
    throw new Error(`footballPadRules.eventAllowedInPhase: "${eventType}" is not one of the football module's own event types`);
  }
  return eventType;
};

export const footballPadRules: FootballPadRules = Object.freeze<FootballPadRules>({
  eventBands: FOOTBALL_FIDELITY,
  cardColors: CardColor.options,
  cardReasons: CardReason.options,
  penaltyOutcomes: PenaltyOutcome.options,
  penaltyOffences: PenaltyOffence.options,
  playPhases: PLAY_PHASES,
  teamSizeDefault: FOOTBALL_TEAM_SIZE,
  subWindowsCap: (cfg) => subWindowsCap(resolve(cfg)),
  eventAllowedInPhase: (eventType, phase, cfg) => eventAllowedInPhase(ownType(eventType), phase, resolve(cfg)),
  periodMarkers: (cfg) => periodMarkers(resolve(cfg)),
  legalPeriodMarkers: (phase, cfg) => legalPeriodMarkers(phase, resolve(cfg)),
  reentryAllowed: (cfg) => reentryAllowed(resolve(cfg)),
});
