// A scenario turns OrganiserDriver calls into an ObservedRun for the invariants
// to judge, plus its own assertions (design §6.2). run.ts (Task 9) calls them;
// Task 11 drives them live.
import type { TemplateRowKey } from "../catalogue.ts";
import type { OrganiserDriver } from "../driver/types.ts";
import type { ObservedRun } from "../observed.ts";
import type { CheckResult } from "../results.ts";

export type ScenarioKey = "LIFECYCLE" | "M1" | "R4" | "F1";

export interface CaseSpec { caseId: string; row: TemplateRowKey; sport: string; variant: string; scenario: ScenarioKey; canary: boolean }

export interface ScenarioContext { driver: OrganiserDriver; spec: CaseSpec; orgSlug: string; cfg: unknown; tag: string }

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
