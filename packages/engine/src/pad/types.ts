// @seazn/engine/pad - the per-sport rule records the ScoringPad skins read (pad wave P0.1).
//
// TYPES ONLY. The batches that follow (P1 period sports and football, P2 cricket, P3 set-based sports and tennis, P4 carrom,
// boardgame and generic) each fill one record and export it from index.ts as `<sport>PadRules`. A field here is either the very
// object the fold reads (`toBe`) or a pure derivation of a declaration that lives in the sport's own module: the facade is not a
// second source (spec 2026-10-29 section 3.1). Nothing here is presentation (labels, tones, order, dock presets) or a display string.
//
// Phone-safe like ./sport: a type-only import of the module contract, no value import, no node:*, no React.
//
// THE cfg PARAMETER. Every `cfg: unknown` below is the stored cfg the pad holds (`PadHostView.cfg`). Each function reads it through the
// module's own configSchema (defaults applied) and never invents a fallback the schema does not declare: an absent key is the schema's
// default or an error, never a number typed here. A fact that depends on the cfg is a function of it; a field is static only where
// every cfg a sport can declare agrees.
import type { FidelityBand } from "../sport/module.ts";

/** Shared by every sport record. */
export interface PadRulesBase {
  /** The module's own `fidelity` map: `toBe(module.fidelity)`. */
  readonly eventBands: Readonly<Record<string, FidelityBand>>;
}

/** hockey, icehockey (P1). */
export interface PeriodPadRules extends PadRulesBase {
  readonly suspensionReasons: readonly string[];
  /** The static CATALOGUE: every class any preset of the sport declares. It keys a tone map (icehockey.tsx's `ICEHOCKEY_CLASSES`); it is
   *  NOT what a fixture is offered. icehockey's recreational cfg offers `minor` and `bench_minor` only, iihf all seven. */
  readonly suspensionClassKeys: readonly string[];
  readonly goalKindRequired: boolean;
  readonly assistsMax: number;
  /** (c) a fact the engine never declared before this wave. */
  readonly swapBand: FidelityBand;
  /** `fallback` is (c). */
  suspensionMinutes(cfg: unknown): { readonly min: number; readonly max: number; readonly fallback: number };
  /** The classes a fixture with this cfg is offered: equals the padSpec suspension `class` enum for the cfg. */
  suspensionClasses(cfg: unknown): readonly string[];
  goalKinds(cfg: unknown): readonly string[];
  /** Takes the cfg because the fold's phase guards do: the scoring phases and the expected advance both read it. */
  eventAllowedInPhase(eventType: string, phase: string, cfg: unknown): boolean;
}

/** football (P1). */
export interface FootballPadRules extends PadRulesBase {
  readonly cardColors: readonly string[];
  readonly cardReasons: readonly string[];
  readonly penaltyOutcomes: readonly string[];
  readonly penaltyOffences: readonly string[];
  readonly playPhases: readonly string[];
  readonly teamSizeDefault: number;
  subWindowsCap(cfg: unknown): number | undefined;
  /** `football.*` event types only: a `core.*` type is not answered (true), football's `applyEvent` refuses those by phase itself. Takes the cfg because the fold's period-marker refusals do (`cfg.halves`). */
  eventAllowedInPhase(eventType: string, phase: string, cfg: unknown): boolean;
  /** The `football.period` markers this cfg offers, in offer order (halves HT/FT, quarters QT/HT/3QT/FT, plus ET_HT/ET_FT with extra time). Added by P1.2. */
  periodMarkers(cfg: unknown): readonly string[];
  /** The marker(s) the fold accepts in `phase` under this cfg: at most one, none outside the in-play phases. Added by P1.2. */
  legalPeriodMarkers(phase: string, cfg: unknown): readonly string[];
  /** Whether the fold lets a substituted-off player come back on (football's `lineupPolicy(cfg).reentry`; false under the Laws, true under `rollingSubs`). Added by P1.2. */
  reentryAllowed(cfg: unknown): boolean;
}

/** cricket (P2). */
export interface CricketPadRules extends PadRulesBase {
  readonly wicketKinds: readonly string[];
  readonly extraKinds: readonly string[];
  /** Keys of FIELDER_CREDIT_COLUMN. */
  readonly fielderCreditedKinds: readonly string[];
  readonly freeHitDismissalKinds: readonly string[];
  readonly bowlerCreditedKinds: readonly string[];
  /** (c) - Q1b. */
  readonly variableOutKinds: readonly string[];
  readonly boundaryValues: readonly number[];
  readonly tossElections: readonly string[];
  readonly inningsCloseReasons: readonly string[];
  readonly retireReasons: readonly string[];
  readonly reviewKinds: readonly string[];
  readonly reviewOutcomes: readonly string[];
  /** (c) Law 41: 5. */
  readonly penaltyRuns: number;
  /** (c) Law 22: 1. */
  readonly wideDefaultRuns: number;
  ballsPerOver(cfg: unknown): number;
}

/** badminton, tabletennis, volleyball (P3). */
export interface SetBasedPadRules extends PadRulesBase {
  readonly sanctionLevels: readonly string[];
  bestOf(cfg: unknown): number;
  setTo(cfg: unknown): number;
  scoreBound(cfg: unknown): number;
  /** (c) "golden point" / "setting" / null for the open game. */
  deuceNote(state: unknown, cfg: unknown): "goldenPoint" | "setting" | null;
}

export interface BadmintonPadRules extends SetBasedPadRules {
  /** (c) ceil(target/2). */
  intervalMark(cfg: unknown, setIndex: number): number;
}

export interface TableTennisPadRules extends SetBasedPadRules {
  /** toBe-equal to the kernel's EXPEDITE_RETURNS. */
  readonly expediteReturns: number;
  /** (c) 9. */
  readonly expediteScoreFloor: number;
}

export interface VolleyballPadRules extends SetBasedPadRules {
  /** (c). */
  readonly liberoBand: FidelityBand;
  rotationCycle(cfg: unknown): number;
}

/** tennis (P3). */
export interface TennisPadRules extends PadRulesBase {
  readonly pointKinds: readonly string[];
  readonly interruptionKinds: readonly string[];
  readonly sanctionLevels: readonly string[];
  /** (c) 3600. */
  readonly interruptionMaxSeconds: number;
  /** (c) ["0","15","30","40"]. */
  readonly pointCalls: readonly string[];
  /** (c). */
  endsChanged(state: unknown): boolean;
  gamesFieldBound(cfg: unknown): number;
  tiebreakFieldBound(cfg: unknown): number;
}

/** carrom (P4). */
export interface CarromPadRules extends PadRulesBase {
  readonly adjustReasons: readonly string[];
  readonly opponentCoinsMax: number;
  bestOf(cfg: unknown): number;
  gameTo(cfg: unknown): number;
}

/** boardgame (P4). */
export interface BoardgamePadRules extends PadRulesBase {
  readonly boardMax: number;
  readonly tiebreakScores: readonly (string | null)[];
}

/** generic (P4). */
export interface GenericPadRules extends PadRulesBase {
  readonly maxPlausibleScore: number;
  readonly maxTallyStep: number;
}

export interface PadRulesBySport {
  hockey: PeriodPadRules;
  icehockey: PeriodPadRules;
  football: FootballPadRules;
  cricket: CricketPadRules;
  badminton: BadmintonPadRules;
  tabletennis: TableTennisPadRules;
  volleyball: VolleyballPadRules;
  tennis: TennisPadRules;
  carrom: CarromPadRules;
  boardgame: BoardgamePadRules;
  generic: GenericPadRules;
}
