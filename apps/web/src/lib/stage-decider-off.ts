// W2c Task 12, fix round 1 (R-T12-1; owner Q7: a knockout's deciders are "preselected, can be turned off") — how a
// STAGE says "this decider is off" when the engine's own off is `null`.
//
// The period sports' overtime and shoot-out (ice hockey's both, hockey's shoot-out) are `null | {…}` in the engine: null
// is OFF. A stage's rules cannot say that with null, because a null there already means INHERIT (key absence: the stage
// plays the division's value, `stage-cfg.ts`). So a stage switches such a decider off with an explicit `false`, and the
// one resolver, `stageScopedCfg` (server/engine-db/stage-cfg.ts), reads that `false` as the engine's `null`. The engine's
// `configSchema` is unchanged: `false` never reaches it.
//
// WHICH keys take that `false` is read from the engine, never listed here: a whole decider the sport declares
// (`ruleKeys[key].decider`) whose schema takes null at that key. That is exactly the period sports' three today
// (football's shoot-out and the super over are booleans, which refuse null and take `false` as their own value, stored
// and read as itself; chess's rung list and carrom's tie board refuse null too). Anywhere else a `false` reaches the
// sport's schema unmapped and is refused there by name (CONFIG_INVALID), as any other value it does not take.
//
// Its own module, free of server-only imports, so the e2e rig helper (`e2e/stage-deciders.ts`) asks the same question.
import type { RuleKeys } from "@seazn/engine/sport";

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
