// Which (row, sport) cells a W2e deciding-path scenario is planned on (Tasks 19–23, spec §10, D16). Derived, never
// listed, as W2a's are (w2a-cells.ts): the rows are the catalogue's whose ROOT stage is a bracket kind, and a sport
// applies when its stream generator BUILDS one of the key's paths under the cfg a bracket fixture folds under — the
// stage presets the create door writes (X-SR-6: a bracket plays its sport's deciders). The generator's own refusal
// (OutcomeUnreachable / GeneratorUnsupported) is the answer; any other error is a bug and propagates.
//
// OPT-IN: --set w1-driving plans them only when --scenario names one (w1-driving-set.ts), so no committed plan holds
// a cell of theirs.
//
// Task 23 (W2E_SHORT_SETS): a path can belong to a VARIANT the builder default is not (tennis's short-set tie-break is the
// Fast4 and short-sets variants'; the default, tour, has none). A case plays the builder default's variant, with the division
// config the editor would post (`overrides`, common.ts) - so where the default builds none of a key's paths, the cell carries the
// override that turns the default into the FIRST other variant (engine order) whose bracket cfg does: the top-level cfg keys where
// that variant's resolved cfg differs from the default's. Derived from the engine's own variants, never listed; checked by
// resolving it back, so a variant the overrides cannot express is skipped, not planned.
import { SPORT_KEYS, type RowKey } from "./catalogue.ts";
import { W2E_SCENARIO_PATHS, type W2eScenarioKey } from "./scenarios/types.ts";
import { resolveSportCfg, stageCfg, variantKeys } from "./sport-cfg.ts";
import { generateStream } from "./streams/index.ts";
import { endingLevelOf } from "./streams/sanction.ts";
import { GeneratorUnsupported, OutcomeUnreachable, PROBE_LINEUPS, type DecidingPath } from "./streams/types.ts";
import { offlineBuilderDefault } from "./variants.ts";
import { bracketRootRows } from "./w2a-cells.ts";

/** The cfg a bracket fixture of `sport` folds under in a W2e case: the builder default's knockout presets, under the case's
 *  division-config `overrides` (none for a case that plays the default as it is). W2e posts no stage rules (none of its keys is
 *  a hold-path scenario), so this is the cfg the case plays. */
export function w2eBracketCfgOf(sport: string, overrides: Readonly<Record<string, unknown>> = {}): unknown {
  const variant = offlineBuilderDefault(sport);
  return stageCfg(sport, resolveSportCfg(sport, variant, { ...overrides }), "knockout", variant);
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

/** Whether `sport`'s generator builds a sanction that ends the match under `cfg`: the module declares one and the stream is
 *  built (the generator's own refusal is the answer; any other error is a bug and propagates). */
export function w2eSanctionBuilds(sport: string, cfg: unknown): boolean {
  const level = endingLevelOf(sport);
  if (level === null) return false;
  try {
    generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "sanctionEnd", by: "home", level }, lineups: PROBE_LINEUPS });
    return true;
  } catch (e) {
    if (e instanceof OutcomeUnreachable || e instanceof GeneratorUnsupported) return false;
    throw e;
  }
}

/** A value as canonical JSON: object keys sorted (a cfg parsed from a preset and one parsed from overrides can differ in key order). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The division-config overrides under which the builder-default case of `sport` builds one of `key`'s paths: `{}` where the
 *  default does already, the overrides that turn it into the first other declared variant that does (the top-level cfg keys that
 *  differ, resolved back to that variant's cfg exactly), or null where no variant of the sport builds one. */
export function w2eOverridesFor(key: W2eScenarioKey, sport: string): Readonly<Record<string, unknown>> | null {
  // Task 24 (G12): a sanction ending forces no deciding path; a sport applies when its module declares a sanction that ends a match
  // and its generator builds one under the builder default's bracket presets (no variant is ever switched in).
  if (key === "W2E_SANCTION_END") return w2eSanctionBuilds(sport, w2eBracketCfgOf(sport)) ? {} : null;
  if (w2ePathUnder(key, sport, w2eBracketCfgOf(sport)) !== null) return {};
  const def = offlineBuilderDefault(sport);
  const base = resolveSportCfg(sport, def) as Record<string, unknown>;
  for (const variant of variantKeys(sport)) {
    if (variant === def) continue;
    const target = resolveSportCfg(sport, variant) as Record<string, unknown>;
    const overrides: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(target)])) if (canon(base[k]) !== canon(target[k])) overrides[k] = target[k];
    // The overrides must express the variant exactly (a key the target lacks cannot be removed by an override).
    if (canon(resolveSportCfg(sport, def, { ...overrides })) !== canon(target)) continue;
    if (w2ePathUnder(key, sport, stageCfg(sport, target, "knockout", variant)) === null) continue;
    return overrides;
  }
  return null;
}

/** Whether `key` applies to `sport`: its generator builds one of the key's paths under the bracket presets (of the builder default, or of another variant the case's overrides turn it into). */
export function w2eApplies(key: W2eScenarioKey, sport: string): boolean {
  return w2eOverridesFor(key, sport) !== null;
}

export interface W2eCell { readonly row: RowKey; readonly sport: string; readonly overrides?: Readonly<Record<string, unknown>> }

/** Every bracket-root row × every applicable sport, less the cells the committed drop list drops from LIFECYCLE. */
export function w2eCells(key: W2eScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W2eCell[] {
  const sports = SPORT_KEYS.flatMap((sport) => { const overrides = w2eOverridesFor(key, sport); return overrides === null ? [] : [{ sport, overrides }]; });
  return bracketRootRows().flatMap((row) => sports.filter((c) => !isDropped(row, c.sport)).map((c): W2eCell => (Object.keys(c.overrides).length === 0 ? { row, sport: c.sport } : { row, sport: c.sport, overrides: c.overrides })));
}
