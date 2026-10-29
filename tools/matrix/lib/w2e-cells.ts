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
import { GeneratorUnsupported, OutcomeUnreachable, PROBE_LINEUPS, canon, type DecidingPath } from "./streams/types.ts";
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

/** The division-config overrides under which the builder-default case of `sport` builds one of `key`'s paths: `{}` where the
 *  default does already, the overrides that turn it into the first other declared variant that does (the top-level cfg keys that
 *  differ, resolved back to that variant's cfg exactly), or null where no variant of the sport builds one. */
export function w2eOverridesFor(key: W2eScenarioKey, sport: string): Readonly<Record<string, unknown>> | null {
  // Task 24 (G12): a sanction ending forces no deciding path; a sport applies when its module declares a sanction that ends a match
  // and its generator builds one under the builder default's bracket presets (no variant is ever switched in).
  if (key === "W2E_SANCTION_END") return w2eSanctionBuilds(sport, w2eBracketCfgOf(sport)) ? {} : null;
  if (w2ePathUnder(key, sport, w2eBracketCfgOf(sport)) !== null) return {};
  const def = offlineBuilderDefault(sport);
  for (const variant of variantKeys(sport)) {
    if (variant === def) continue;
    const overrides = overridesToVariant(sport, variant);
    if (overrides === null || w2ePathUnder(key, sport, stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant)) === null) continue;
    return overrides;
  }
  return null;
}

/** The division-config overrides that turn the builder default of `sport` into `variant` (the top-level cfg keys that differ,
 *  resolved back to that variant's cfg exactly), or null when overrides cannot express it (a key the target lacks cannot be
 *  removed by an override). `resolve` is the cfg resolver (injected so a test can hand it a variant no shipped sport has: every
 *  shipped variant is expressible, so the null arm is otherwise unreached). */
export function overridesToVariant(sport: string, variant: string, resolve: typeof resolveSportCfg = resolveSportCfg): Readonly<Record<string, unknown>> | null {
  const def = offlineBuilderDefault(sport);
  const base = resolve(sport, def) as Record<string, unknown>;
  const target = resolve(sport, variant) as Record<string, unknown>;
  const overrides: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(target)])) if (canon(base[k]) !== canon(target[k])) overrides[k] = target[k];
  return canon(resolve(sport, def, { ...overrides })) === canon(target) ? overrides : null;
}

/** Task 23 M1/M7: the keys that play EVERY declared variant that builds one of their paths, not the first. Tennis's variants differ
 *  in the SHAPE of the tie-break that closes the set - the set tie-break (tour's 7-6), the slam's final-set tie-break to 10, the
 *  doubles norm's match tie-break, the short-set tie-break at the set's own margin (Fast4's 4-3, the short-sets variant's 5-4) - so
 *  the default alone would leave three of those shapes unplayed in the product. The other keys' variants differ in numbers (a
 *  target, a count), not in the shape of the path, and play the first. */
export const W2E_EVERY_VARIANT: ReadonlySet<W2eScenarioKey> = new Set<W2eScenarioKey>(["W2E_TB_SET", "W2E_SHORT_SETS"]);

/** Every overrides set `key` is played under on `sport`, in the engine's variant order: `[{}]` for the builder default as it is
 *  (where it builds a path), then the overrides of each other variant that builds one (only for W2E_EVERY_VARIANT keys; the other
 *  keys have the one `w2eOverridesFor` gives). Empty where the key does not apply. */
export function w2eOverridesSetsFor(key: W2eScenarioKey, sport: string): Readonly<Record<string, unknown>>[] {
  const first = w2eOverridesFor(key, sport);
  if (first === null) return [];
  if (!W2E_EVERY_VARIANT.has(key)) return [first];
  const def = offlineBuilderDefault(sport);
  const out: Readonly<Record<string, unknown>>[] = [];
  if (w2ePathUnder(key, sport, w2eBracketCfgOf(sport)) !== null) out.push({});
  for (const variant of variantKeys(sport)) {
    if (variant === def) continue;
    const overrides = overridesToVariant(sport, variant);
    if (overrides === null || w2ePathUnder(key, sport, stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant)) === null) continue;
    out.push(overrides);
  }
  return out;
}

/** Whether `key` applies to `sport`: its generator builds one of the key's paths under the bracket presets (of the builder default, or of another variant the case's overrides turn it into). */
export function w2eApplies(key: W2eScenarioKey, sport: string): boolean {
  return w2eOverridesFor(key, sport) !== null;
}

/** `asVariant`: the declared variant a cell's overrides turn the builder default into (set exactly when `overrides` is). */
export interface W2eCell { readonly row: RowKey; readonly sport: string; readonly overrides?: Readonly<Record<string, unknown>>; readonly asVariant?: string }

/** The declared variant of `sport` that the builder default under `overrides` resolves to EXACTLY, or null when none does. */
export function w2eVariantOf(sport: string, overrides: Readonly<Record<string, unknown>>): string | null {
  const want = canon(resolveSportCfg(sport, offlineBuilderDefault(sport), { ...overrides }));
  return variantKeys(sport).find((v) => canon(resolveSportCfg(sport, v)) === want) ?? null;
}

/** The variant an overrides cell plays, by name; overrides that resolve to none are a defect of the derivation, refused by name. */
export function w2eNameVariant(sport: string, overrides: Readonly<Record<string, unknown>>): string {
  const variant = w2eVariantOf(sport, overrides);
  if (variant === null) throw new W2eOverridesNameNoVariant(sport, overrides);
  return variant;
}

/** An overrides set that resolves to no declared variant (see w2eNameVariant). */
export class W2eOverridesNameNoVariant extends Error {
  constructor(sport: string, overrides: Readonly<Record<string, unknown>>) {
    super(`w2e-cells: ${sport}'s overrides ${JSON.stringify(overrides)} resolve to no declared variant, so the case could not say which it plays`);
    this.name = "W2eOverridesNameNoVariant";
  }
}

/** Every bracket-root row × every applicable sport, less the cells the committed drop list drops from LIFECYCLE. */
export function w2eCells(key: W2eScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W2eCell[] {
  const sports = SPORT_KEYS.flatMap((sport) => w2eOverridesSetsFor(key, sport).map((overrides) => ({ sport, overrides })));
  return bracketRootRows().flatMap((row) => sports.filter((c) => !isDropped(row, c.sport)).map((c): W2eCell => {
    if (Object.keys(c.overrides).length === 0) return { row, sport: c.sport };
    return { row, sport: c.sport, overrides: c.overrides, asVariant: w2eNameVariant(c.sport, c.overrides) };
  }));
}
