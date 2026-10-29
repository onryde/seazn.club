// Which (row, sport) cells a W2e deciding-path scenario is planned on (Tasks 19–23, spec §10, D16). Derived, never
// listed, as W2a's are (w2a-cells.ts): the rows are the catalogue's whose ROOT stage is a bracket kind, and a sport
// applies when its stream generator BUILDS one of the key's paths under the cfg a bracket fixture folds under — the
// stage presets the create door writes (X-SR-6: a bracket plays its sport's deciders). The generator's own refusal
// (OutcomeUnreachable / GeneratorUnsupported) is the answer; any other error is a bug and propagates.
//
// OPT-IN: --set w1-driving plans them only when --scenario names one (w1-driving-set.ts), so no committed plan holds
// a cell of theirs.
import { SPORT_KEYS, type RowKey } from "./catalogue.ts";
import { W2E_SCENARIO_PATHS, type W2eScenarioKey } from "./scenarios/types.ts";
import { resolveSportCfg, stageCfg } from "./sport-cfg.ts";
import { generateStream } from "./streams/index.ts";
import { GeneratorUnsupported, OutcomeUnreachable, PROBE_LINEUPS, type DecidingPath } from "./streams/types.ts";
import { offlineBuilderDefault } from "./variants.ts";
import { bracketRootRows } from "./w2a-cells.ts";

/** The cfg a bracket fixture of `sport` folds under in a W2e case: the builder default's knockout presets. W2e posts no
 *  stage rules (none of its keys is a hold-path scenario), so this is the cfg the case plays. */
export function w2eBracketCfgOf(sport: string): unknown {
  const variant = offlineBuilderDefault(sport);
  return stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant);
}

/** The first of `key`'s paths `sport`'s generator builds under `cfg`, or null when it builds none of them. */
export function w2ePathUnder(key: W2eScenarioKey, sport: string, cfg: unknown): DecidingPath | null {
  for (const path of W2E_SCENARIO_PATHS[key]) {
    try {
      // PROBE_LINEUPS: a path that names persons (cricket's super over) cannot be built without lineups, and the question here
      // is whether the generator builds the path, not whom it names; the case plays against the lineups it PUT (common.ts).
      generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "win", winner: "home", path }, lineups: PROBE_LINEUPS });
      return path;
    } catch (e) {
      if (e instanceof OutcomeUnreachable || e instanceof GeneratorUnsupported) continue;
      throw e;
    }
  }
  return null;
}

/** Whether `key` applies to `sport`: its generator builds one of the key's paths under the bracket presets. */
export function w2eApplies(key: W2eScenarioKey, sport: string): boolean {
  return w2ePathUnder(key, sport, w2eBracketCfgOf(sport)) !== null;
}

export interface W2eCell { readonly row: RowKey; readonly sport: string }

/** Every bracket-root row × every applicable sport, less the cells the committed drop list drops from LIFECYCLE. */
export function w2eCells(key: W2eScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W2eCell[] {
  const sports = SPORT_KEYS.filter((s) => w2eApplies(key, s));
  return bracketRootRows().flatMap((row) => sports.filter((sport) => !isDropped(row, sport)).map((sport) => ({ row, sport })));
}
