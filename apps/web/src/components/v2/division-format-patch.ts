// The division Settings "Save rules" PATCH body, as a pure function (W2c Task 17, fix round 1, review I-2).
//
// It lived inline in `division-settings.tsx`'s `applyFormat`, where a node-environment test cannot reach it, and that is
// how a reset that sent nothing shipped: the control's "Use the default order" blanks the rung list, the save is built on
// `{...division.config}` and OMITS a blank field, so the stored list went back out in the PATCH and the reset did nothing.
// Moved here verbatim, plus the one new step (`clearedSequenceKeys`), so the door can be tested through its real inputs.
import { buildRuleOverride, clearedSequenceKeys, hydrateRuleValues, rulesFor } from "@/lib/match-rules";
import { moduleFor } from "@/lib/rule-scope";

/** A variant's preset as `sport_variants.config` stores it: ONLY the keys the variant declares (scripts/sync-sports.ts writes
 *  the engine's `variants[key]` as is), never a whole parsed config. */
export type VariantPreset = Readonly<Record<string, unknown>> | undefined;

/** The keys a variant switch hands back to the variants: everything either preset declares. The OLD variant's keys too,
 *  because a key the target does not declare falls back to the module's default, not to what the old variant had written
 *  (The Hundred's `ballsPerOver: 5` must not survive a switch to T20, which declares no over length of its own). */
function declaredKeys(...presets: VariantPreset[]): Set<string> {
  return new Set(presets.flatMap((p) => (p === undefined ? [] : Object.keys(p))));
}

/**
 * W2e Task 29 (Review Focus 3): the division's config as it reads UNDER `target`, when the form holds `target` and the
 * division was saved under `saved`. The saved config is the FULLY PARSED one (every default written out), so a switch that
 * kept it whole kept the old variant's `setTo: 21` beside the new variant's label, and the server's `{...preset, ...config}`
 * merge let the stored value win. Here the keys either preset declares leave the stored config and the target's own values
 * take their place; every other key (a customised cap, the entrants, a points map neither variant declares) stays.
 * The same variant (or no preset known for it) changes nothing.
 */
export function configUnderVariant(
  divisionConfig: Record<string, unknown>,
  savedPreset: VariantPreset,
  targetPreset: VariantPreset,
  sameVariant: boolean,
): Record<string, unknown> {
  if (sameVariant) return divisionConfig;
  const out: Record<string, unknown> = { ...divisionConfig };
  for (const key of declaredKeys(savedPreset, targetPreset)) delete out[key];
  return { ...out, ...(targetPreset ?? {}) };
}

/**
 * The rule fields' raw values after the organiser moved the variant select from `from` to `to`: a field the organiser has
 * not touched (it still reads what the config under `from` hydrates to) is re-read from the config under `to`, so the
 * grid shows the variant's own numbers (15 / 15 / cap 21 after 3x15, not the 21 it opened on); a field they HAVE typed in
 * is theirs and stays. Idempotent in the variant pair, so a second switch (3x21 -> 3x15 -> short) re-reads the same way.
 */
export function ruleValuesAfterVariantSwitch(input: {
  sportKey: string;
  ruleValues: Record<string, string>;
  divisionConfig: Record<string, unknown>;
  savedPreset: VariantPreset;
  fromPreset: VariantPreset;
  toPreset: VariantPreset;
  /** `from` / `to` are the variant KEYS, so "the same variant as saved" is asked of the keys, not the presets. */
  savedKey: string;
  fromKey: string;
  toKey: string;
}): Record<string, string> {
  const under = (preset: VariantPreset, key: string) =>
    configUnderVariant(input.divisionConfig, input.savedPreset, preset, key === input.savedKey);
  const fromConfig = under(input.fromPreset, input.fromKey);
  const toConfig = under(input.toPreset, input.toKey);
  const baseline = hydrateRuleValues(input.sportKey, fromConfig, fromConfig);
  const target = hydrateRuleValues(input.sportKey, toConfig, toConfig);
  const out: Record<string, string> = { ...input.ruleValues };
  for (const field of rulesFor(input.sportKey)) {
    const untouched = (input.ruleValues[field.key] ?? "") === (baseline[field.key] ?? "");
    if (!untouched) continue;
    const next = target[field.key];
    if (next === undefined) delete out[field.key];
    else out[field.key] = next;
  }
  return out;
}

export interface DivisionFormatPatchInput {
  sportKey: string;
  /** The division's saved config: the base every save starts from (the server merges preset + override). */
  divisionConfig: Record<string, unknown>;
  /** The variant the division has now, and the one the form holds. */
  savedVariantKey: string;
  variantKey: string;
  /** Their presets (`sport_variants.config`), which a switch needs: the keys a variant declares come from the variant, not
   *  from the stored config. Absent = none known (an org preset that stores none), which declares nothing. */
  savedVariantPreset?: VariantPreset;
  variantPreset?: VariantPreset;
  /** The rule fields' raw values (hydrated from the saved config, then edited). */
  ruleValues: Record<string, string>;
  /** The standings-points boxes this editor shows, their raw values, and the saved points they fall back to. */
  pointsFieldKeys: readonly string[];
  pointsValues: Record<string, string>;
  savedPoints: Record<string, number> | undefined;
  /** The "advanced" JSON the organiser typed, already parsed; laid on last. */
  advanced: Record<string, unknown> | null;
}

/** The `config` of `PATCH /divisions/{id}`: the saved config with the form's values laid over it. */
export function divisionFormatPatch(input: DivisionFormatPatchInput): Record<string, unknown> {
  // The server merges preset + override, but presets only carry the
  // variant-identity keys (resultMode/allowDraws) — the rest of the
  // schema's keys (a generic division's abandonPolicy, say) live in the
  // division's current config. Base the override on that valid snapshot;
  // on a variant change, drop the identity keys so the new preset wins them.
  const switched = input.variantKey !== input.savedVariantKey;
  const override: Record<string, unknown> = { ...input.divisionConfig };
  if (switched) {
    delete override.resultMode;
    delete override.allowDraws;
    // W2e Task 29: and every key either variant declares - the server lays this config over the target's preset, so a
    // stored `setTo: 21` left in here would beat 3x15's own 15.
    for (const key of declaredKeys(input.savedVariantPreset, input.variantPreset)) delete override[key];
  }
  // The config the rule fields fall back to and convert by (cricket's over length): under the TARGET variant after a switch.
  const inherited = configUnderVariant(input.divisionConfig, input.savedVariantPreset, input.variantPreset, !switched);
  // R3.5/Task Q — buildRuleOverride can return a nested `{ points: {...} }`
  // (the best-of-1 points field). A bare Object.assign of the
  // whole rule override would REPLACE override.points wholesale, dropping
  // whatever of the existing config's points (win/draw/loss, or a
  // shootout half the organiser isn't touching right now) the rule
  // fields didn't themselves resend. Merge points separately; everything
  // else a rule field returns is a fine top-level Object.assign, exactly
  // as before.
  // `division.config` as the inherited config: a blank best-of here keeps
  // the saved one (the `{...config}` base above), so it is also what
  // decides whether the single best-of-1 points field applies.
  const { points: rulePoints, ...ruleOverrideRest } = buildRuleOverride(input.sportKey, input.ruleValues, inherited);
  Object.assign(override, ruleOverrideRest);
  // An ordered list the organiser reset ("Use the default order") is a blank, and a blank is OMITTED by the build, so the
  // saved list would ride along from the base above: remove it explicitly. Every other blank field keeps what is saved.
  for (const key of clearedSequenceKeys(input.sportKey, input.ruleValues)) delete override[key];
  if (rulePoints && typeof rulePoints === "object") {
    const mergedPoints: Record<string, unknown> = {
      ...((override.points as Record<string, unknown>) ?? {}),
      ...(rulePoints as Record<string, unknown>),
    };
    // R3.5 review F5 — a rule field's build()/buildOnBlank() (no field
    // does today: football's shoot-out pair left in W2d) can ask to DELETE a key
    // from the nested object by setting it to `undefined` rather than
    // omitting it — omitting it would leave whatever `override.points`
    // already carried forward from the `{...division.config}` base at
    // the top of this function untouched. Resolve those markers into a
    // real deletion here, so the PATCH body (and any `toEqual`/
    // `toHaveProperty` assertion on it) is a clean object rather than
    // one holding `undefined`-valued keys.
    for (const key of Object.keys(mergedPoints)) {
      if (mergedPoints[key] === undefined) delete mergedPoints[key];
    }
    override.points = mergedPoints;
  }
  // A variant that declares its own points (cricket's test match) owns them after a switch: the boxes hold the OLD map.
  const pointsDeclared = switched && declaredKeys(input.savedVariantPreset, input.variantPreset).has("points");
  if (!pointsDeclared && input.pointsFieldKeys.some((k) => input.pointsValues[k] !== undefined && input.pointsValues[k] !== "")) {
    // Spread whatever survived above (shootout points included) rather
    // than replacing override.points outright, and write only the keys
    // THIS sport's schema actually declares — see editablePointsKeys.
    const pointsPatch: Record<string, unknown> = { ...((override.points as Record<string, unknown>) ?? {}) };
    for (const key of input.pointsFieldKeys) {
      const raw = input.pointsValues[key];
      pointsPatch[key] = raw === undefined || raw === "" ? (input.savedPoints?.[key] ?? 0) : Number(raw);
    }
    override.points = pointsPatch;
  }
  if (input.advanced !== null) Object.assign(override, input.advanced);
  return override;
}

/**
 * W2e Task 33 (B3-2): the example the Settings "Advanced overrides (JSON)" box shows before anything is typed. It used to be a
 * fixed `{ "progressScore": true }`, a key the engine deleted in W2e D6. It is now read from the division's OWN module: the
 * first key the module declares in `ruleKeys` (declaration order) that the division's saved config holds, with the value it
 * holds. Laid over that config it is a patch the module accepts that changes nothing, so pasting the example always works,
 * whatever the sport. The patch is shallow (`Object.assign` in `divisionFormatPatch`), so a dotted key (`overtime.minutes`) is
 * shown as its whole top-level object, never a half of it. `{}` where the config holds none of the declared keys (nothing to
 * copy) or the sport is unknown.
 */
export function advancedPlaceholder(sportKey: string, divisionConfig: Readonly<Record<string, unknown>>): string {
  for (const key of Object.keys(moduleFor(sportKey)?.ruleKeys ?? {})) {
    const top = key.split(".")[0]!;
    if (Object.hasOwn(divisionConfig, top) && divisionConfig[top] !== undefined) return JSON.stringify({ [top]: divisionConfig[top] });
  }
  return "{}";
}
