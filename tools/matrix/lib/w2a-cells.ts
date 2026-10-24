// Which (row, sport) cells a W2a bracket-finish scenario is planned on (Task 14 Step 4). Everything here is derived,
// never listed: the rows are the catalogue's whose ROOT stage is a bracket kind (forbidsLevelResult), and a sport is
// applicable when its stream generator can BUILD the path the scenario forces — the generator's own declaration
// (OutcomeUnreachable / GeneratorUnsupported), asked under the stage-overlaid cfg a bracket fixture folds under. Two
// scenarios are about one sport's rule and say so (carrom's extra board, CA-KO-1; generic's refused draw, GN-KO-1).
//
// The scenarios are OPT-IN: --set w1-driving plans them only when --scenario names one (w1-driving-set.ts), so no
// committed plan holds a cell of theirs.
import { SETTLE_METHODS, forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "./catalogue.ts";
import { decidersOffRulesFor, drawsAllowed, resolveSportCfg, stageCfg } from "./sport-cfg.ts";
import { generateStream } from "./streams/index.ts";
import { GeneratorUnsupported, OutcomeUnreachable, type RequestedOutcome } from "./streams/types.ts";
import { HOLD_PATH_SCENARIOS, type W2aScenarioKey } from "./scenarios/types.ts";
import { offlineBuilderDefault } from "./variants.ts";

/** The rows whose first (root) stage is a bracket kind: the scenarios' probe runs through the round hooks playDivision
 *  gives stage 1 only (D12), and a bracket behind a table is LIFECYCLE's. The scenarios' pick decides the bracket
 *  matches of every stage of such a row (ko_plate's plate, qualifying_main's main) and of a ladder. */
export function bracketRootRows(): RowKey[] {
  return ROW_KEYS.filter((row) => forbidsLevelResult(stagesForRow(row)[0].kind as StageKind));
}

/** The cfg a bracket fixture of `sport` folds under in `key`'s cases, on the variant the planner uses (the offline
 *  builder default): the stage's presets, and on a hold-path scenario (HOLD_PATH_SCENARIOS, R-T12-3) the every-decider-off
 *  rules its cases post — the same rules `setUpDivision` posts, so the plan asks the cfg the case plays. */
export function bracketCfgOf(sport: string, key: W2aScenarioKey): unknown {
  const variant = offlineBuilderDefault(sport);
  const rules = HOLD_PATH_SCENARIOS.has(key) ? decidersOffRulesFor(sport, variant, "knockout") : undefined;
  return stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant, rules);
}

/** Whether the sport's generator builds `outcome` in a bracket under `key`'s overlaid cfg. A declaration of unreachable
 *  is an answer; any other error is a bug and propagates. */
function generatorBuilds(sport: string, key: W2aScenarioKey, outcome: RequestedOutcome): boolean {
  try {
    generateStream({ sportKey: sport, cfg: bracketCfgOf(sport, key), stageKind: "knockout", home: "h", away: "a", outcome });
    return true;
  } catch (e) {
    if (e instanceof OutcomeUnreachable || e instanceof GeneratorUnsupported) return false;
    throw e;
  }
}

/** The scenario's applicability on a sport, with the one-line reason of each rule that is one sport's. */
export function w2aApplies(key: W2aScenarioKey, sport: string): boolean {
  switch (key) {
    case "BRACKET_SETTLE_LEVEL": return generatorBuilds(sport, key, { kind: "settle", then: "home", method: SETTLE_METHODS[0], after: "level" });
    case "BRACKET_SETTLE_ABANDON": return generatorBuilds(sport, key, { kind: "settle", then: "home", method: SETTLE_METHODS[0], after: "abandon" });
    case "BRACKET_TIEBREAK": return generatorBuilds(sport, key, { kind: "tiebreak", rung: TIEBREAK_RUNGS[0], winner: "home" });
    // single-sport: CA-KO-1 is carrom's rule (the ICF extra board); no other sport plays one.
    case "BRACKET_EXTRA_BOARD": return sport === "carrom";
    // single-sport: GN-KO-1 is generic's rule; and the refusal needs a draw that exists in a league to be posted at the bracket.
    case "BRACKET_NO_DRAW_GENERIC": return sport === "generic" && drawsAllowed(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "league");
  }
}

export interface W2aCell { readonly row: RowKey; readonly sport: string }

/** The cells a scenario is planned on: every bracket-root row × every applicable sport, less the cells the committed
 *  drop list drops from LIFECYCLE (`isDropped`) — a cell that cannot be played at all is not a bracket-finish cell. */
export function w2aCells(key: W2aScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W2aCell[] {
  const sports = SPORT_KEYS.filter((s) => w2aApplies(key, s));
  return bracketRootRows().flatMap((row) => sports.filter((sport) => !isDropped(row, sport)).map((sport) => ({ row, sport })));
}
