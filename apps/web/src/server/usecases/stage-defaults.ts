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
// `createStages` and `replaceStages` (both through `insertStageBatch`; replaceStages asks it inside the one transaction
// that also holds its delete, so a refusal rolls the delete back and the division keeps its stages, R-T13-3) and template
// instantiation.
import type { StageKind } from "@seazn/engine/core";
import { PointsRule } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { HttpError } from "@/lib/errors";
import { TOP_LEVEL_STAGE_DECIDERS } from "@/lib/top-level-stage-deciders";
import { STAGE_DECIDER_MOVED } from "@/server/api-v1/schemas";
import { storedStageRules } from "@/lib/stage-decider-off";
import { defaultSwissChess } from "@/lib/swiss-draw";
import { randomInt } from "node:crypto";
import { refuseStagePoints, refuseUnsettableKeys, stageRulesProblem, stageSaveRefusal } from "./stage-rules-merge";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Batch 4 review M6 (ruling M6) — `config.points: null` in a stage input is "no points for this slot": the same word the
 * stage PUT uses (`{points: null}` removes the rule), and no rule to validate, gate, store or carry. Before, the API's
 * schema let the null through (`points: z.unknown()`) and `PointsRule.parse(null)` threw a raw ZodError at the batch gates,
 * which with R-T13-1's carry left an Apply no way to clear a slot's carried points. The one reading of the sent value:
 * `undefined` for absent AND null (nothing to ask), the value otherwise. `replaceStages` carries a slot's stored points only
 * when the body says nothing (`stageConfigsAtCreate`: `sent.points === undefined`), so a null drops the carry.
 */
export const sentPoints = (config: Record<string, unknown> | undefined): unknown => config?.points ?? undefined;

/** `config` as the door stores it: a null `points` is not stored (the stage PUT deletes the key, never stores a null), nor
 *  (W2d Task 10) a null own order — null is "inherit", which is the key's absence. */
const NULL_IS_ABSENT: ReadonlySet<string> = new Set(["points", "tiebreakers", "crossGroupTiebreakers"]);
const withoutNullPoints = (config: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(config).filter(([k, v]) => !(v === null && NULL_IS_ABSENT.has(k))));

/** W2d Task 10 (spec §5.4 "Storage", §5.8) — a new stage's lots seed, when the door sends none: a random 31-bit integer,
 *  stored in `config.rngSeed`, so a drawing of lots on this stage is its own (never the shared seed 0 every stage read
 *  while the key was usually absent). A seed sent is kept. */
const withRngSeed = (config: Record<string, unknown>): Record<string, unknown> =>
  config.rngSeed === undefined || config.rngSeed === null ? { ...config, rngSeed: randomInt(0, 2 ** 31) } : config;

/** W3 Task 8 (BG-SW-1, REC RB3-10; SW-H3) — a NEW Swiss stage on a chess division is stored with `chess: true` when the
 *  create sends no `chess` (one sent, `false` included, is kept). Here, beside `withRngSeed`, because this is the one door
 *  every create path shares (`createStages` and `replaceStages` through `stageConfigsAtCreate`, and a template's stages
 *  through `instantiateTemplate` — the boardgame `swiss11` template among them), so there is one default, never a second.
 *  Pair reads the STORED value (`cfg.chess === true`), so a stage stored before this default with `chess` unset keeps its
 *  colours off (orchestrator ruling m5). */
const withSwissChessDefault = (sportKey: string, kind: StageKind, config: Record<string, unknown>): Record<string, unknown> =>
  kind === "swiss" && config.chess === undefined && defaultSwissChess(sportKey) ? { ...config, chess: true } : config;

/** W2c Task 13b (R-13b-1; D3) — every whole decider any sport declares, refused at a stage config's TOP level. The
 *  engine-derived set lives in `lib/top-level-stage-deciders.ts`, shared with the API schema's named refusals, so the
 *  door and the zod layer refuse the same keys. */
const TOP_LEVEL_DECIDERS: ReadonlySet<string> = new Set(TOP_LEVEL_STAGE_DECIDERS);

/**
 * The stage config with its rules as a new stage stores them: a BASE, then the rules sent with the create, merged the
 * way the stage PUT merges a save (`mergedStageRules`): a key sent wins, a key sent as null REMOVES that key (the stage
 * inherits the division's value), a key not sent is kept. Absent, null or `{}` rules keep the base whole: a create has
 * nothing stored to clear. No rules key at all when nothing is left.
 *
 * The base is the sport's preset for this kind and variant, UNLESS `replaceStages` matched this slot to a stage it is
 * replacing (`carried`, the old stage's stored rules): then the carry IS the base and the preset is not laid under it
 * (fix round 2, R-T12-4, R-T12-2's meaning: an organiser's removal is kept). A matched slot's stored rules are its whole
 * format, so a preset key absent from them — or no stored rules at all (`{}`), "Same as division" — is the organiser's
 * clear, never a gap to re-seed. A genuinely new slot (`carried` null) starts from its preset.
 */
export function withStageDefaults(
  module: AnySportModule,
  kind: StageKind,
  variant: string | null,
  config: Record<string, unknown>,
  carried: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const { rules: sent, ...rest } = config;
  // lib/stage-decider-off.ts `storedStageRules` (fix round 2, review M-3): the base and the merge, shared with the
  // format-matrix harness.
  const rules = storedStageRules(module, kind, variant, sent, carried);
  return rules !== null && Object.keys(rules).length > 0 ? { ...rest, rules } : rest;
}

/**
 * `withStageDefaults`, validated (SC-P8: a create takes `config.rules` on the stage PUT's terms). Throws, writing
 * nothing: VALIDATION (400, `field`) for a decider at the config's top level (`shootout`, `extraTime`, `overtime`, …: any
 * the engine declares, `TOP_LEVEL_DECIDERS`; moved to `config.rules`), from any caller; UNKNOWN_RULE_KEY / RULE_NOT_SETTABLE (400) for a key sent that the sport never declares or this kind and
 * variant cannot set; CONFIG_INVALID (422, the engine's `issues`) when the division's config under the rules the stage
 * would store is one the sport refuses. The merged parse runs on the rules as STORED (the preset or the carry included),
 * so a preset the division cannot take is refused at the door rather than at the first whistle. (Whether the stage's
 * points pay every set score its rules reach is the table guard's coverage question, asked by the caller over the
 * config this returns: `refuseNewStageTable`, W2d Task 10.)
 *
 * W2c Task 13 (ST-G8): `config.points` is asked the stage PUT's points questions too (`refuseStagePoints`): RULE_NOT_SETTABLE
 * on a bracket kind or for a walkover score the sport's table never reads, CONFIG_INVALID for metrics the sport does not
 * emit. Stored as sent, as before. W2d Task 10: a config with no `rngSeed` is given one (`withRngSeed`). W3 Task 8: a
 * Swiss stage on a chess division with no `chess` is given `chess: true` (`withSwissChessDefault`).
 */
export function validatedStageConfig(
  module: AnySportModule,
  sportKey: string,
  kind: StageKind,
  variant: string | null,
  divisionConfig: unknown,
  sentConfig: Record<string, unknown>,
  carried: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const config = withoutNullPoints(sentConfig);
  // Fix round 2 (review gap hunt): the API's schema refuses a top-level decider, but an internal caller reaches this
  // door with no schema in front of it, so the door refuses it too, by name, before anything is merged or written.
  // Task 13b: every decider the engine declares, not the two the retired top-level overlay read.
  for (const key of Object.keys(config)) {
    if (TOP_LEVEL_DECIDERS.has(key)) {
      throw new HttpError(400, `config.${key}: ${STAGE_DECIDER_MOVED}`, "VALIDATION", { field: `config.${key}` });
    }
  }
  const sent = isObj(config.rules) ? config.rules : {};
  refuseUnsettableKeys(module, sportKey, kind, variant, divisionConfig, Object.keys(sent));
  const out = withStageDefaults(module, kind, variant, config, carried);
  if (isObj(out.rules)) {
    const problem = stageRulesProblem(module, divisionConfig, out.rules);
    if (problem !== null) throw stageSaveRefusal(problem, sportKey);
  }
  const points = sentPoints(config);
  if (points !== undefined) refuseStagePoints(module, kind, PointsRule.parse(points));
  return withSwissChessDefault(sportKey, kind, withRngSeed(out));
}
