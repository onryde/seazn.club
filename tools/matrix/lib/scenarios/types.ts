// A scenario turns OrganiserDriver calls into an ObservedRun for the invariants
// to judge, plus its own assertions (design §6.2). run.ts (Task 9) calls them;
// Task 11 drives them live.
import type { RowKey } from "../catalogue.ts";
import type { OrganiserDriver } from "../driver/types.ts";
import type { ObservedRun } from "../observed.ts";
import type { CheckResult } from "../results.ts";

/** W2a (Task 14): the opt-in bracket-finish scenarios. They are planned ONLY when `--set w1-driving --scenario <key>`
 *  names one, so no committed plan holds them. Defined here, beside the type that names them, so the key list has
 *  one authority (w2a-bracket-finish.ts re-exports it as W2A_SCENARIOS). */
export const W2A_SCENARIO_KEYS = ["BRACKET_SETTLE_LEVEL", "BRACKET_SETTLE_ABANDON", "BRACKET_TIEBREAK", "BRACKET_EXTRA_BOARD", "BRACKET_NO_DRAW_GENERIC"] as const;
export type W2aScenarioKey = (typeof W2A_SCENARIO_KEYS)[number];

export type ScenarioKey = "LIFECYCLE" | "M1" | "R4" | "F1" | "DENIED" | "PADPROOF" | "VOIDPROOF" | W2aScenarioKey;

/** `row` is any catalogue row, API-only ones included (W1b Task 3 carry):
 *  stagesForRow builds every one. `deny` (ruling 24) lists the feature keys
 *  the case org is denied through `org_entitlement_overrides`. `overrides`
 *  (W1b Task 10) is a committed variant case's rule override: the division is
 *  created with it as `config`, and the case scores under preset + override. */
export interface CaseSpec {
  caseId: string; row: RowKey; sport: string; variant: string; scenario: ScenarioKey; canary: boolean;
  deny?: readonly string[];
  overrides?: Readonly<Record<string, unknown>>;
  /** W1-driving Task 13 (ruling 47, D11): the catalog template whose gallery
   *  card builds this case's division (lib/templates.ts) — set by the planner
   *  on the two template-only cells, absent everywhere else. */
  template?: string;
  /** W1d Task 14 (item 15c, D17): the case is a MATCH DAY. LIFECYCLE dates the division's first fixtures NOW
   *  (OrganiserDriver.scheduleFixtureNow) before any is played, so the division is on its match day when its run
   *  sheet first loads, and the browser reads the filter the sheet OPENS on. Set by the match-day set's planner
   *  only; absent everywhere else, so every committed plan is unchanged. */
  matchDay?: true;
}

/** `denied`: the feature keys prepareCaseOrg actually denied the case org
 *  (each one's read-back held) — what the org IS, where `spec.deny` is only
 *  what the plan asked for. */
export interface ScenarioContext { driver: OrganiserDriver; spec: CaseSpec; orgSlug: string; cfg: unknown; tag: string; denied: readonly string[] }

export interface ScenarioOutput {
  observed: ObservedRun;
  assertions: CheckResult[];
  /** Events the harness posted (PF8): run.ts writes it to counts.events. */
  events: number;
  /** Final review m-5: what the scenario noticed on the way (a refused
   *  complete, foreign events, the loop cap, the stage status after start).
   *  run.ts writes them, redacted and capped, to the case's `notes`. */
  notes: string[];
}

export interface Scenario {
  key: ScenarioKey;
  entrantCount: number;
  /** The one check a canary run must turn red; null for a scenario with no canary. */
  canaryCheck: string | null;
  /** ⛔: the case's expected state is `refused` (decideState's `mandated`). */
  mandatedRefusal?: (spec: CaseSpec) => string;
  /** false: the fixture invariants do not apply (no stage was ever built). Default true. */
  evaluatesInvariants?: boolean;
  /** Which scores a browser case taps on the pad (W1c Task 7; mixed.ts
   *  PadPolicy): "first" per case (ruling 15), or "all" (PADPROOF, D3).
   *  Default "first". run.ts hands it to the case's BrowserDriver. */
  padPolicy?: "first" | "all";
  run(ctx: ScenarioContext): Promise<ScenarioOutput>;
}

/** A named deferral: the case renders ⏳ with the owning wave, never ░ or ✅. */
export class ScenarioUnsupported extends Error {
  readonly wave: string;
  constructor(wave: string, reason: string) {
    super(reason);
    this.name = "ScenarioUnsupported";
    this.wave = wave;
  }
}
