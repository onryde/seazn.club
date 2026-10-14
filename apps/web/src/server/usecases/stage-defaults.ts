import "server-only";
// W2c Task 12 (spec items 5, 6; §4.2; D3, D13; SC-P8; P7; X-SR-6) — the rules a NEW stage is written with.
//
// A bracket stage starts with its sport's deciders (the engine's `stageDefaults`: extra time and penalties in football,
// overtime and the shoot-out in ice hockey, the shoot-out in hockey, the super over in limited-overs cricket); a table
// stage starts with none (owner Q7 "B": preselected, the organiser's to switch off). The preset is WRITTEN into
// `stages.config.rules` at create, never inferred when a match resolves its format: what a stage plays is what it stores.
//
// `config.rules` sent with a create is validated exactly as the stage PUT validates a save, from the same pieces in
// `stage-rules-merge.ts` (never a second copy): the allowlist over the keys AS SENT, then the merged parse of
// `{division ⊕ the rules the stage will store}`. Every door that creates a stage calls `validatedStageConfig`:
// `createStages` (and through it `replaceStages`, which also asks it BEFORE its delete) and template instantiation.
import type { StageKind } from "@seazn/engine/core";
import { stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { mergedStageRules, refuseUnsettableKeys, setsBestOf, stageRulesProblem, stageSaveRefusal } from "./stage-rules-merge";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The stage config with its rules as a new stage stores them: the sport's preset for this kind and variant, then the
 * rules `replaceStages` carried for this slot (`carried`, an organiser's edits win over the preset), then the rules sent
 * with the create, merged the way the stage PUT merges a save (`mergedStageRules`): a key sent wins, a key sent as
 * null REMOVES that key (the stage inherits the division's value), a key not sent is kept. Absent, null or `{}` rules
 * keep the preset whole: a create has nothing stored to clear. No rules key at all when nothing is left.
 */
export function withStageDefaults(
  module: AnySportModule,
  kind: StageKind,
  variant: string | null,
  config: Record<string, unknown>,
  carried: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const { rules: sent, ...rest } = config;
  const preset = { ...stageDefaultsFor(module, kind, variant), ...carried };
  const provided = isObj(sent) ? sent : {};
  const rules = Object.keys(provided).length === 0 ? preset : mergedStageRules(preset, provided);
  return rules !== null && Object.keys(rules).length > 0 ? { ...rest, rules } : rest;
}

/**
 * `withStageDefaults`, validated (SC-P8: a create takes `config.rules` on the stage PUT's terms). Throws, writing
 * nothing: UNKNOWN_RULE_KEY / RULE_NOT_SETTABLE (400) for a key sent that the sport never declares or this kind and
 * variant cannot set; CONFIG_INVALID (422, the engine's `issues`) when the division's config under the rules the stage
 * would store is one the sport refuses; POINTS_MAP_INCOMPLETE (422) when the rules sent move `bestOf` past what the
 * division's points table answers. The merged parse runs on the rules as STORED (preset and carry included), so a
 * preset the division cannot take is refused at the door rather than at the first whistle.
 */
export function validatedStageConfig(
  module: AnySportModule,
  sportKey: string,
  kind: StageKind,
  variant: string | null,
  divisionConfig: unknown,
  config: Record<string, unknown>,
  carried: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const sent = isObj(config.rules) ? config.rules : {};
  refuseUnsettableKeys(module, sportKey, kind, variant, Object.keys(sent));
  const out = withStageDefaults(module, kind, variant, config, carried);
  if (isObj(out.rules)) {
    const problem = stageRulesProblem(module, divisionConfig, out.rules, setsBestOf(sent));
    if (problem !== null) throw stageSaveRefusal(problem, sportKey);
  }
  return out;
}
