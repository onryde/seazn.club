// Which (row, sport) cells a W2b forfeit-credit scenario is planned on (Task 2 Step 4). Derived, never listed: the
// rows come from the catalogue's own stage bodies (one per distinct ROOT stage kind, since the scenarios' hooks reach
// stage 1 only, D12), and a sport applies when its stream generator BUILDS the request the scenario posts — the
// generator's own declaration (OutcomeUnreachable / GeneratorUnsupported), asked under the cfg the root stage folds.
// AB-AWARD's two rules are the sports' own (an abandonPolicy the configSchema declares; cricket's minOversForResult)
// and are read off the resolved cfg.
//
// OPT-IN, as W2a's: --set w1-driving plans them only when --scenario names one (w1-driving-set.ts).
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "./catalogue.ts";
import { resolveSportCfg, sportModule, stageCfg } from "./sport-cfg.ts";
import { generateStream, partialPlay } from "./streams/index.ts";
import { GeneratorUnsupported, OutcomeUnreachable, type RequestedOutcome } from "./streams/types.ts";
import type { W2bScenarioKey } from "./scenarios/types.ts";
import { offlineBuilderDefault } from "./variants.ts";

const rootKind = (row: RowKey): StageKind => stagesForRow(row)[0].kind as StageKind;
const rootConfig = (row: RowKey): Record<string, unknown> => (stagesForRow(row)[0] as { config?: Record<string, unknown> }).config ?? {};

/** One row per distinct root stage kind, the first in catalogue order: "every stage kind" as the hooks can reach it. */
export function rootKindRows(): RowKey[] {
  const seen = new Set<string>();
  return ROW_KEYS.filter((row) => {
    const k = rootKind(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A root bracket that plays a third-place match (X-DW-3 names it beside the final): not a distinct stage kind, so
 *  rootKindRows misses it — the catalogue's knockout body that sets `thirdPlace`. */
export function thirdPlaceRows(): RowKey[] {
  return ROW_KEYS.filter((row) => rootKind(row) === "knockout" && rootConfig(row).thirdPlace === true);
}

const firstRoot = (pred: (k: StageKind) => boolean, what: string): RowKey => {
  const row = rootKindRows().find((r) => pred(rootKind(r)));
  if (row === undefined) throw new Error(`w2b-cells: the catalogue has no row whose root stage is ${what}`);
  return row;
};
/** The first row whose root is a TABLE (a level result stands): the credit is read off its standings. */
export const tableRootRow = (): RowKey => firstRoot((k) => !forbidsLevelResult(k), "a table kind");
/** The first row whose root is a BRACKET (forbidsLevelResult). */
export const bracketRootRow = (): RowKey => firstRoot((k) => forbidsLevelResult(k), "a bracket kind");
/** WD-CASC's choreography is a single-elimination one (quarter-final lines feeding semi-finals), so its row is the
 *  first whose root stage is a knockout. */
export const knockoutRootRow = (): RowKey => firstRoot((k) => k === "knockout", "a knockout");

/** The override AB-AWARD's goal sports run under: the abandon policy their configSchema declares (FB/HK/IH-AB-1). */
export const AWARD_POLICY = Object.freeze({ abandonPolicy: "award" });

/** The cfg a fixture of `sport` folds under on `row`'s root stage, on the planner's variant, with `overrides`. */
export function rootCfgOf(row: RowKey, sport: string, overrides: Record<string, unknown> = {}): unknown {
  return stageCfg(sport, resolveSportCfg(sport, offlineBuilderDefault(sport), overrides), rootKind(row), offlineBuilderDefault(sport));
}

function streamBuilds(sport: string, cfg: unknown, stageKind: StageKind, outcome: RequestedOutcome): boolean {
  try {
    generateStream({ sportKey: sport, cfg, stageKind, home: "h", away: "a", outcome });
    return true;
  } catch (e) {
    if (e instanceof OutcomeUnreachable || e instanceof GeneratorUnsupported) return false;
    throw e;
  }
}

/** RT-PART's in-match reasons for a sport under a stage's cfg, in the order its drives alternate them: the retirement
 *  and the disqualification (X-RT-1), each where the sport's generator builds it after START and partial play. Ruling
 *  113 refuses a retirement where nothing is played short of the result (chess), so there the disqualification is
 *  driven alone. */
export function inMatchReasons(sport: string, cfg: unknown, stageKind: StageKind): ("retired" | "disqualified")[] {
  return (["retired", "disqualified"] as const).filter((reason) => streamBuilds(sport, cfg, stageKind, { kind: "forfeit", by: "home", reason, at: "after_start" }));
}

/** CK-AB-1's override: a cricket result past the minimum overs is the DLS method's, which the cfg declares OFF by
 *  default (cricket.ts applyAbandon decides by DLS par only when `dls.enabled`). */
export const DLS_ON = Object.freeze({ dls: Object.freeze({ enabled: true, edition: "standard" }) });

/** The sport's configSchema declares `override`: parsing it keeps every key as given (a schema without the key strips
 *  it, or refuses it). */
function declares(sport: string, override: Readonly<Record<string, unknown>>): boolean {
  const base = resolveSportCfg(sport, offlineBuilderDefault(sport)) as Record<string, unknown>;
  const parsed = sportModule(sport).configSchema.safeParse({ ...base, ...override });
  return parsed.success && Object.entries(override).every(([k, v]) => JSON.stringify((parsed.data as Record<string, unknown>)[k]) === JSON.stringify(v));
}

/** The sport's configSchema declares an award abandon policy (FB/HK/IH-AB-1). */
export const declaresAwardPolicy = (sport: string): boolean => declares(sport, AWARD_POLICY);

interface CricketAbandonCfg { readonly minOversForResult?: unknown; readonly ballsPerOver?: unknown }

/** CK-AB-1 / CK-AB-2: the sport's cfg sets a minimum number of overs for a result, and the generator's partial play
 *  reaches it in the second innings (so an abandon after it is past the minimum) — a guard on the generator, never an
 *  assumption: a partial that stops short of the minimum leaves CK-AB-1 unreachable, and the sport is not planned. */
export function minOversRule(sport: string): { readonly minBalls: number; readonly partialBalls: number } | null {
  if (!declares(sport, DLS_ON)) return null;
  const row = tableRootRow();
  const cfg = rootCfgOf(row, sport, DLS_ON) as CricketAbandonCfg;
  if (typeof cfg.minOversForResult !== "number" || typeof cfg.ballsPerOver !== "number") return null;
  const play = partialPlay({ sportKey: sport, cfg, stageKind: rootKind(row), home: "h", away: "a", outcome: { kind: "abandon" } });
  const last = play.at(-1)?.payload as { legalBalls?: unknown } | undefined;
  return { minBalls: cfg.minOversForResult * cfg.ballsPerOver, partialBalls: typeof last?.legalBalls === "number" ? last.legalBalls : 0 };
}

/** The override an AB-AWARD case runs under — the rule that gives the sport's abandon a result, switched on — or null
 *  where the sport has no such rule (or the generator's partial play cannot reach the minimum overs). */
export function abandonOverride(sport: string): Readonly<Record<string, unknown>> | null {
  if (declaresAwardPolicy(sport)) return AWARD_POLICY;
  const overs = minOversRule(sport);
  return overs !== null && overs.partialBalls >= overs.minBalls ? DLS_ON : null;
}

export interface W2bCell { readonly row: RowKey; readonly sport: string; readonly overrides?: Readonly<Record<string, unknown>> }

/** The cells a scenario is planned on, less the cells LIFECYCLE's committed drops drop (`isDropped`): a cell that
 *  cannot be played at all is not a forfeit cell. */
export function w2bCells(key: W2bScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W2bCell[] {
  const keep = (cells: W2bCell[]) => cells.filter((c) => !isDropped(c.row, c.sport));
  switch (key) {
    // X-RS-1 / X-WO-1 / BG-WO-2: every sport (a walkover is the bare core.forfeit everywhere) × every root stage kind.
    case "WO-PRE":
      return keep(rootKindRows().flatMap((row) => SPORT_KEYS.map((sport) => ({ row, sport }))));
    // X-RT-1: a table and a bracket, every sport whose generator builds START + partial play + the retirement there,
    // or the in-match disqualification (ruling 113: a sport with nothing played short of its result — chess — cannot
    // retire, and its RT-PART drives the disqualification alone; inMatchReasons).
    case "RT-PART":
      return keep([tableRootRow(), bracketRootRow()].flatMap((row) => SPORT_KEYS.filter((sport) => inMatchReasons(sport, rootCfgOf(row, sport), rootKind(row)).length > 0).map((sport) => ({ row, sport }))));
    // X-DW-1..4: every sport × every root stage kind, plus the third-place row (a fixture with no next match).
    case "DW-ALL":
      return keep([...rootKindRows(), ...thirdPlaceRows()].flatMap((row) => SPORT_KEYS.map((sport) => ({ row, sport }))));
    // X-AB-1 / X-AB-2: the sports whose own rule gives an abandon a result — an award policy (FB/HK/IH-AB-1) and a
    // DLS result past the minimum overs (CK-AB-1/2) — in a table, each under the override that switches its rule on.
    case "AB-AWARD": {
      const row = tableRootRow();
      return keep(SPORT_KEYS.flatMap((sport) => { const overrides = abandonOverride(sport); return overrides === null ? [] : [{ row, sport, overrides }]; }));
    }
    // X-WD-1..5 / BG-WO-2/3: the knockout choreography, every sport.
    case "WD-CASC":
      return keep(SPORT_KEYS.map((sport) => ({ row: knockoutRootRow(), sport })));
  }
}

/** Whether `cell` is one `key` is planned on (before the drops): the scenario's own refusal reads it. */
export function w2bApplies(key: W2bScenarioKey, row: string, sport: string): boolean {
  return w2bCells(key).some((c) => c.row === row && c.sport === sport);
}
