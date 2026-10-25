// The division Settings "Save rules" PATCH body, as a pure function (W2c Task 17, fix round 1, review I-2).
//
// It lived inline in `division-settings.tsx`'s `applyFormat`, where a node-environment test cannot reach it, and that is
// how a reset that sent nothing shipped: the control's "Use the default order" blanks the rung list, the save is built on
// `{...division.config}` and OMITS a blank field, so the stored list went back out in the PATCH and the reset did nothing.
// Moved here verbatim, plus the one new step (`clearedSequenceKeys`), so the door can be tested through its real inputs.
import { buildRuleOverride, clearedSequenceKeys } from "@/lib/match-rules";

export interface DivisionFormatPatchInput {
  sportKey: string;
  /** The division's saved config: the base every save starts from (the server merges preset + override). */
  divisionConfig: Record<string, unknown>;
  /** The variant the division has now, and the one the form holds. */
  savedVariantKey: string;
  variantKey: string;
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
  // variant-identity keys (resultMode/allowDraws) — schema-required keys
  // like progressScore live in the division's current config. Base the
  // override on that valid snapshot; on a variant change, drop the
  // identity keys so the new preset wins them.
  const override: Record<string, unknown> = { ...input.divisionConfig };
  if (input.variantKey !== input.savedVariantKey) {
    delete override.resultMode;
    delete override.allowDraws;
  }
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
  const { points: rulePoints, ...ruleOverrideRest } = buildRuleOverride(input.sportKey, input.ruleValues, input.divisionConfig);
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
  if (input.pointsFieldKeys.some((k) => input.pointsValues[k] !== undefined && input.pointsValues[k] !== "")) {
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
