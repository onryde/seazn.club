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
// `stageRulesOverlay` is THE one mapping of a stage's stored rules onto its division (R-T12-3): the product's resolver
// (`stageScopedCfg`, server/engine-db/stage-cfg.ts) and the format-matrix harness (`tools/matrix/lib/sport-cfg.ts`) both
// call it, so neither keeps a copy. Its own module, importing nothing but the engine's sport barrel (a bare package; the
// harness loads it under plain node, pinned in tools/matrix/__tests__/boundary.test.ts), so the e2e rig helper
// (`e2e/stage-deciders.ts`) and the harness ask the same questions.
import type { StageKind } from "@seazn/engine/core";
import { deciderKeysFor, type AnySportModule, type RuleKeys } from "@seazn/engine/sport";

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
