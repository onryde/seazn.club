// W2c Task 12, fix round 1 (R-T12-1; owner Q7: a knockout's deciders are "preselected, can be turned off") — how a
// STAGE says "this decider is off" when the engine's own off is `null`.
//
// The period sports' overtime and shoot-out (ice hockey's both, hockey's shoot-out) are `null | {…}` in the engine: null
// is OFF. A stage's rules cannot say that with null, because a null there already means INHERIT (key absence: the stage
// plays the division's value). So a stage switches such a decider off with an explicit `false`, and `stageRulesOverlay`
// below reads that `false` as the engine's `null`. The engine's `configSchema` is unchanged: `false` never reaches it.
//
// WHICH keys take that `false` is read from the engine, never listed here: a whole decider the sport declares
// (`ruleKeys[key].decider`) whose schema takes null at that key. That is exactly the period sports' three today
// (football's shoot-out and the super over are booleans, which refuse null and take `false` as their own value, stored
// and read as itself; chess's rung list and carrom's tie board refuse null too). Anywhere else a `false` reaches the
// sport's schema unmapped and is refused there by name (CONFIG_INVALID), as any other value it does not take.
//
// `stageRulesOverlay` is THE one mapping of a stage's stored rules onto its division (R-T12-3). Since fix round 2 (review
// M-3) this module also holds the rest of the stage-cfg COMPOSITION, so the product and the format-matrix harness
// (`tools/matrix/lib/sport-cfg.ts`) run the same code rather than a copy each:
// - `storedStageRules`: the rules a new stage stores (`usecases/stage-defaults.ts` `withStageDefaults` calls it);
// - `mergedStageRules`: how a save merges (`usecases/stage-rules-merge.ts` re-exports it);
// - `stageScopedCfgOf` / `liveStageCfg`: the resolver's stage overlay and bracket deciders (`engine-db/stage-cfg.ts`
//   `stageScopedCfg` and `engine-db/fixture-cfg.ts` `liveCfg` call them).
// The module imports nothing but the engine's barrels (bare packages), so the harness loads it under plain node (pinned in
// tools/matrix/__tests__/boundary.test.ts), and the e2e rig helper (`e2e/stage-deciders.ts`) asks the same questions.
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { deciderKeysFor, stageDefaultsFor, type AnySportModule, type RuleKeys } from "@seazn/engine/sport";

/** The two members of a sport module the question needs; every SportModule satisfies it. */
export interface DeciderOffSource {
  readonly configSchema: { safeParse(v: unknown): { success: boolean } };
  readonly ruleKeys?: RuleKeys;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether a stage's `false` at `key` means the engine's `null` (off): a declared whole decider whose schema, over this
 *  division's config, takes null there. A key the sport does not own ("toString") never does. */
export function offByFalse(module: DeciderOffSource, divisionCfg: unknown, key: string): boolean {
  const keys = module.ruleKeys ?? {};
  if (!Object.hasOwn(keys, key) || keys[key]!.decider !== true) return false;
  return module.configSchema.safeParse({ ...(isObj(divisionCfg) ? divisionCfg : {}), [key]: null }).success;
}

/** What a stage's stored `rules` lay over its division's config, key by key. "Inherit" is key ABSENCE, never an explicit
 *  null: a spread copies nulls, so a null reaching the division would BLANK its value instead of leaving it alone (the
 *  endpoint strips nulls on the way in; this is the second half of that contract, for rows written before it). A
 *  `false` where `offByFalse` holds is the engine's `null` (off). Every other value as stored. Without a module (a caller
 *  that has none) nothing is mapped. Rules that are not an object overlay nothing. */
export function stageRulesOverlay(module: DeciderOffSource | null, divisionCfg: unknown, rules: unknown): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  if (!isObj(rules)) return overlay;
  for (const [k, v] of Object.entries(rules)) {
    if (v === false && module !== null && offByFalse(module, divisionCfg, k)) overlay[k] = null;
    else if (v !== null && v !== undefined) overlay[k] = v;
  }
  return overlay;
}

/** `config.rules` for a stage of `kind` with every decider the stage can switch off switched off (X-SR-6's held arm, an
 *  organiser's own choice). Built from the engine's declarations (`deciderKeysFor`, the variant's parsed config), never
 *  a literal:
 *  - `false` where the engine's off is null (`offByFalse`: ice hockey's overtime and shoot-out, hockey's shoot-out);
 *  - else the division variant's OWN value: football's and cricket's deciders are off in their variants' configs;
 *  - else null, where the variant sets no value. That removes the preset key, so the stage inherits the engine's
 *    default, which may PLAY (boardgame's tie-break rungs: a chess knockout always takes its tie-break, BG-KO-1).
 *  So this is "held" only where the result can actually end level. Callers that need a held level result must check
 *  that. The matrix's positive-pairs test (tools/matrix/__tests__/sport-cfg-stage-presets.test.ts) pins the variants
 *  whose held cfg reaches level, and fails an unnamed one that does not. Throws for a variant the module does not
 *  declare. */
export function decidersOffRules(module: AnySportModule, variant: string, kind: StageKind = "knockout"): Record<string, unknown> {
  if (!Object.hasOwn(module.variants, variant)) throw new Error(`decidersOffRules: ${module.key} declares no variant '${variant}'`);
  const division = module.configSchema.parse(module.variants[variant]) as Record<string, unknown>;
  return Object.fromEntries(deciderKeysFor(module, kind, variant).map((k) => [k, offByFalse(module, division, k) ? false : (division[k] ?? null)]));
}

/** The rules as the overlay reads them: a null or undefined value is "inherit" (`stageRulesOverlay`), never a value. */
export const withoutNulls = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/**
 * The rules a stage carries AFTER a save, or null when it carries none (carry I2 of Task 8's review).
 *
 * A save MERGES into what is stored: a key the body omits is kept, a key it names is replaced, and a null VALUE removes
 * that key ("inherit" is key ABSENCE, never a stored null: the resolver's overlay spreads what it is given, so a null
 * reaching the column would BLANK the division's value). An EMPTY list is a value (chess's `tiebreakRungs: []`, "held for
 * the organiser") and is stored as sent. `rules: null` and `{}` clear everything: they are the one way to say "all of it".
 * Stored nulls (rows written before the strip) are dropped on the way through. Whatever is left empty is null.
 *
 * Keys must have passed `refuseUnsettableKeys` first: the loop writes a body key into a fresh object by name.
 */
export function mergedStageRules(
  stored: unknown,
  sent: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (sent === null || Object.keys(sent).length === 0) return null;
  const out: Record<string, unknown> = isObj(stored) ? withoutNulls(stored) : {};
  for (const [k, v] of Object.entries(sent)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * W2c Task 12 — the rules a NEW stage stores, or null for none: a BASE, then the rules `sent` with the create, merged as
 * a save merges (`mergedStageRules`). Absent, null or `{}` rules keep the base whole: a create has nothing stored to
 * clear. The base is the sport's preset for this kind and variant, UNLESS `replaceStages` matched this slot to a stage
 * it is replacing (`carried`, the old stage's stored rules): then the carry IS the base, and the preset is not laid under
 * it (fix round 2, R-T12-4). A matched slot's stored rules are its whole format, so a preset key absent from them, or no
 * stored rules at all (`{}`, "Same as division"), is the organiser's clear. A genuinely new slot (`carried` null) starts
 * from its preset.
 */
export function storedStageRules(
  module: AnySportModule,
  kind: StageKind,
  variant: string | null,
  sent: unknown,
  carried: Record<string, unknown> | null = null,
): Record<string, unknown> | null {
  // A stored null is inherit, the same as the key's absence (the PUT never stores one; a legacy row might).
  const base = carried !== null ? withoutNulls(carried) : stageDefaultsFor(module, kind, variant);
  const provided = isObj(sent) ? sent : {};
  const rules = Object.keys(provided).length === 0 ? base : mergedStageRules(base, provided);
  return rules;
}

/** A stage, as the resolver reads it: its kind (the bracket overlay's switch) and its config (the stage overlay). */
export interface StageCfgSource {
  readonly kind: string | null | undefined;
  readonly config: Record<string, unknown> | null | undefined;
}
/** The members of a sport module the composition needs; every SportModule satisfies it. */
export interface BracketDeciderSource extends DeciderOffSource {
  readonly configSchema: { safeParse(v: unknown): { success: boolean; data?: unknown } };
  bracketDeciders(cfg: never): Record<string, unknown>;
}

/** PROMPT-61 §2 and design 2026-09-17 §T1 — the stage-scoped cfg: `{...division, ...rules}`, the stage's stored `rules`
 *  laid over its division through the one mapping (`stageRulesOverlay`). W2c D3 (Task 13b): a stage's deciders are
 *  ordinary `rules` keys, gated on the way in by the write paths' `stageTopKeysFor` (Tasks 11, 12); nothing at the stage
 *  config's TOP level is read (the retired `shootout` / `extraTime` overlay). Identity when the stage overlays nothing,
 *  so callers pass the result on unconditionally. */
export function stageScopedCfgOf(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
  module: DeciderOffSource | null,
): unknown {
  if (stageCfg == null) return divisionCfg;
  const overlay = stageRulesOverlay(module, divisionCfg, stageCfg.rules);
  if (Object.keys(overlay).length === 0) return divisionCfg;
  return { ...(divisionCfg as Record<string, unknown>), ...overlay };
}

/** `division ⊕ stage.rules ⊕ bracketDeciders(kind)`: the cfg a fixture with no snapshot and no override folds (its
 *  STAGE's format; `engine-db/fixture-cfg.ts` `liveCfg`). A bracket stage kind (`forbidsLevelResult`) gets the sport's
 *  `bracketDeciders` over the safe-parse of the scoped cfg (W2a ruling 76): a throwing parse would make the read path
 *  stricter than the fold. A JSON-null division config stays as it is. */
export function liveStageCfg(
  divisionCfg: unknown,
  stage: StageCfgSource | null | undefined,
  module: BracketDeciderSource,
): unknown {
  const scoped = stageScopedCfgOf(divisionCfg, stage?.config, module);
  if (!forbidsLevelResult(stage?.kind)) return scoped;
  if (scoped === null || typeof scoped !== "object" || Array.isArray(scoped)) return scoped; // a JSON-null division config stays as it is
  const parsed = module.configSchema.safeParse(scoped);
  const overlay = module.bracketDeciders((parsed.success ? parsed.data : scoped) as never);
  return Object.keys(overlay).length === 0 ? scoped : { ...(scoped as Record<string, unknown>), ...overlay };
}

/** The cfg the fixtures of a stage CREATED with `rules` fold under before any edit, event or override: what the create
 *  door stores (`storedStageRules`, no carry) read through the resolver (`liveStageCfg`). The format-matrix harness's
 *  `stageCfg` is exactly this. The product reaches the same value through `validatedStageConfig` and `liveCfg`, which
 *  is the differential pinned in usecases/__tests__/stage-cfg-composition.test.ts. */
export function postedStageCfg(module: AnySportModule, divisionCfg: unknown, kind: StageKind, variant: string | null, rules?: unknown): unknown {
  const stored = storedStageRules(module, kind, variant, rules ?? null);
  return liveStageCfg(divisionCfg, { kind, config: stored === null ? {} : { rules: stored } }, module);
}
