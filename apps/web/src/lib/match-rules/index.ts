// Match rules — curated per-sport fields that build the config override
// object (previously a raw-JSON textarea). Blank = keep the variant default;
// the pinned module's configSchema still validates server-side. Shared by
// the division builder and the division Settings tab (v8) so the two format
// editors can't drift. Field labels/options are sport-rules vocabulary, kept
// canonical/English like sport + format names; only the picker chrome
// (Default / On / Off) localizes — and that chrome lives in the client
// component `@/components/v2/match-rules`, which re-exports everything here.
//
// NO "use client", NO JSX, NO `@/components` import, on purpose (design
// 2026-09-17 §T0): the server derives the per-stage rules allowlist from this
// table, and a `"use client"` module hands a server importer client
// REFERENCES rather than values. A vitest unit test of the derivation passes
// either way (node env, no RSC boundary), so a server-graph importer is the
// only thing that proves the extraction.
//
// The table is split one file per sport (`./football`, `./cricket`, ...); this
// file is the registry that assembles them into `SPORT_RULES` and keeps the
// functions that work across sports. Its public surface is exactly what the
// single-file module exported, so importers keep using `@/lib/match-rules`.
//
// Every relative import in this directory carries its `.ts` extension, on
// purpose: tools/matrix loads this file under plain
// `node --experimental-strip-types`, which resolves no extensionless
// specifier (vitest and tsc would not notice). tools/matrix/__tests__/
// boundary.test.ts pins it.

import { BADMINTON_RULES } from "./badminton.ts";
import {
  BEST_OF_ONE_PAIR,
  SINGLE_SET_POINTS_LABEL,
  alignBestOfOnePointsIn,
  showsOnePointsFieldIn,
} from "./best-of-one.ts";
import { BOARDGAME_RULES } from "./boardgame.ts";
import { CARROM_RULES } from "./carrom.ts";
import { CRICKET_RULES } from "./cricket.ts";
import { FOOTBALL_RULES } from "./football.ts";
import { GENERIC_RULES } from "./generic.ts";
import { HOCKEY_RULES } from "./hockey.ts";
import { ICEHOCKEY_RULES } from "./icehockey.ts";
import { ownOr } from "./shared.ts";
import { TABLETENNIS_RULES } from "./tabletennis.ts";
import { TENNIS_RULES } from "./tennis.ts";
import type { RuleField } from "./types.ts";
import { VOLLEYBALL_RULES } from "./volleyball.ts";

export type { RuleField } from "./types.ts";
export { SINGLE_SET_POINTS_LABEL } from "./best-of-one.ts";

/** The same trap one level up, where it is a CRASH rather than a wrong value:
 *  `SPORT_RULES["constructor"] ?? []` answers the Object constructor, and
 *  `for (const f of <Function>)` throws "function is not iterable". */
export function rulesFor(sportKey: string): RuleField[] {
  return ownOr<RuleField[]>(SPORT_RULES, sportKey, []);
}

export const SPORT_RULES: Record<string, RuleField[]> = {
  football: FOOTBALL_RULES,
  cricket: CRICKET_RULES,
  volleyball: VOLLEYBALL_RULES,
  badminton: BADMINTON_RULES,
  tabletennis: TABLETENNIS_RULES,
  tennis: TENNIS_RULES,
  icehockey: ICEHOCKEY_RULES,
  hockey: HOCKEY_RULES,
  boardgame: BOARDGAME_RULES,
  carrom: CARROM_RULES,
  generic: GENERIC_RULES,
};

/**
 * Whether the editor shows ONE points field for these values. `inherited` is
 * the config the values fall back to — the division's for a stage fragment,
 * the saved config for division settings, nothing for the builder (whose blank
 * best-of is a variant default no shipped variant sets to 1).
 */
export function showsOnePointsField(
  sportKey: string,
  values: Record<string, string>,
  inherited: Record<string, unknown> = {},
): boolean {
  return showsOnePointsFieldIn(rulesFor(sportKey), values, inherited);
}

/** The fields the editor renders, in table order: the table itself, or — on
 *  best of 1 — the table without `setTo` and with `finalSetTo` relabelled. The
 *  table is never mutated; the relabelled field is a copy.
 *
 *  A `sequence` field (an ordered list, chess's tie-break rungs) IS shown, since W2c Task 17 built the control that
 *  edits one (`components/v2/stage-rules/sequence-field.tsx`). Until then it was filtered out: the grid would have
 *  rendered it as a single `<select>`, so an organiser could save a list of one rung, which dead-ends the scorer on a
 *  drawn knockout game (the pad offers only that rung). */
export function visibleRuleFields(
  sportKey: string,
  values: Record<string, string>,
  inherited: Record<string, unknown> = {},
): RuleField[] {
  const fields = rulesFor(sportKey);
  if (!showsOnePointsField(sportKey, values, inherited)) return fields;
  return fields
    .filter((f) => f.key !== BEST_OF_ONE_PAIR.shadow)
    .map((f) => (f.key === BEST_OF_ONE_PAIR.shown ? { ...f, label: SINGLE_SET_POINTS_LABEL } : f));
}

/** One edit to the editor's raw values. On best of 1 the single points field
 *  writes both keys, so switching back to best of 3 shows the number typed in
 *  both fields rather than a stale `setTo` the organiser never saw. */
export function setRuleValue(
  sportKey: string,
  values: Record<string, string>,
  key: string,
  raw: string,
  inherited: Record<string, unknown> = {},
): Record<string, string> {
  const next = { ...values, [key]: raw };
  if (key === BEST_OF_ONE_PAIR.shown && showsOnePointsField(sportKey, next, inherited))
    next[BEST_OF_ONE_PAIR.shadow] = raw;
  return next;
}

/**
 * The stage editor's untouched save re-sends the stored fragment verbatim
 * (`stageFormatSaveFragment`). On best of 1 that one save still writes the
 * played number to both keys, as every other save does: a fragment carrying
 * both, mismatched, comes back with `setTo` aligned to `finalSetTo`. Anything
 * else — including a fragment with `setTo` but no `finalSetTo`, where aligning
 * would pin an inherited value — comes back as the SAME object.
 */
export function alignBestOfOnePoints(
  sportKey: string,
  fragment: Record<string, unknown>,
  inherited: Record<string, unknown> = {},
): Record<string, unknown> {
  return alignBestOfOnePointsIn(rulesFor(sportKey), fragment, inherited);
}

/** Merge every non-blank field into one override object. On an effective best
 *  of 1 `setTo` is built from the single field's value, so the pair is always
 *  saved equal — and a blank single field saves neither key. */
export function buildRuleOverride(
  sportKey: string,
  values: Record<string, string>,
  inherited: Record<string, unknown> = {},
): Record<string, unknown> {
  const override: Record<string, unknown> = {};
  const single = showsOnePointsField(sportKey, values, inherited);
  for (const field of rulesFor(sportKey)) {
    const value =
      single && field.key === BEST_OF_ONE_PAIR.shadow
        ? values[BEST_OF_ONE_PAIR.shown]
        : values[field.key];
    if (value !== undefined && value !== "") {
      Object.assign(override, field.build(value, values));
    } else if (field.buildOnBlank) {
      Object.assign(override, field.buildOnBlank(values));
    }
  }
  return override;
}

/**
 * The config keys an ORDERED-LIST field (`kind: "sequence"`) edits whose raw value is BLANK: lists the organiser reset to
 * the engine's default ("Use the default order"). A blank is omitted by `buildRuleOverride` like any other, which is right
 * where the base is a stage's rules FRAGMENT (an absent key means "inherit") but wrong where the base is the division's
 * whole saved config (an omitted key rides along and the reset does nothing): the division door removes these keys
 * explicitly. Only a sequence field is read this way - a blank number or select keeps what is saved (F5's rule stands).
 */
export function clearedSequenceKeys(sportKey: string, values: Record<string, string>): string[] {
  const keys: string[] = [];
  for (const field of rulesFor(sportKey)) {
    if (field.kind !== "sequence") continue;
    if ((values[field.key] ?? "") === "") keys.push(...field.edits);
  }
  return keys;
}

/**
 * Initial `ruleValues` for MatchRuleFields, derived from the division's
 * saved config through the SAME field list `buildRuleOverride` uses — so a
 * field whose `build` nests/renames/scales its value only has to teach its
 * own `read` the inverse, once, instead of a caller hand-listing keys per
 * sport (R3.5/Task Q: `ruleValues` used to never hydrate at all, so every
 * field showed blank on reopen no matter what was saved — most visibly
 * Task I's shootoutWin/shootoutLoss, since a blank pair reads as "unset"
 * and the engine gate requires both to be defined for the split to apply).
 */
export function hydrateRuleValues(sportKey: string, config: unknown): Record<string, string> {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of rulesFor(sportKey)) {
    const value = field.read?.(cfg);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

/** Every value a field can produce, so a build() that BRANCHES on its value
 *  cannot hide a config key behind an option we never probed. */
function probeValuesFor(field: RuleField): string[] {
  if (field.kind === "select") return (field.options ?? []).map((o) => o.value);
  if (field.kind === "bool") return ["on", "off"];
  return [String(field.min ?? 1)];
}

/** The CONFIG keys an arbitrary field list can write. Exported separately from
 *  `configKeysFor` so a synthetic field — one whose `build` actually BRANCHES
 *  its key set on the value — can be passed in: no field of any in-scope sport
 *  does that today (carrom's `gameTo` is the only one in the whole table), so
 *  without such a test the probe loop above is an unwitnessed guard. */
export function keysEmittedBy(fields: RuleField[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const field of fields) {
    for (const probe of probeValuesFor(field))
      for (const k of Object.keys(field.build(probe, {}))) keys.add(k);
    if (field.buildOnBlank) for (const k of Object.keys(field.buildOnBlank({}))) keys.add(k);
  }
  return keys;
}

/** The CONFIG keys a sport's rule fields can write — NOT their field keys.
 *  `division-settings.tsx:273` maps `f.key`; copying that here would 400 four
 *  of tennis's five overrides, because `build` renames three of them. */
export function configKeysFor(sportKey: string): ReadonlySet<string> {
  return keysEmittedBy(rulesFor(sportKey));
}

/**
 * The picker label for a stored option VALUE — this sport's own if it declares
 * one, otherwise a peer sport's.
 *
 * Two surfaces show a value the sport's own picker cannot offer: the stage
 * card's summary line (`stageFormatHeadline`) and the synthetic `<option>`
 * D9 put inside `MatchRuleFields`. A module accepts more values than any
 * picker lists, so a stored config can always name one the list does not.
 * They shipped from two code paths and DISAGREED: the open dropdown read
 * `Default · 5 · Best of 1 · Best of 3` under a summary line saying
 * "Best of 5". One value, two labels, one screen. This is the one lookup both
 * now use.
 *
 * That original case was badminton `bestOf: 5` against a picker offering
 * [1, 3]. The owner ruled on 2026-09-20 that the PICKER was wrong rather than
 * the data, so badminton now declares [1, 3, 5] and 5 is answered by the
 * `own` branch below. The live unofferable values for badminton are 7 — which
 * tabletennis and volleyball declare and this borrows from — and anything no
 * in-scope sport declares at all, such as 9, which falls through to the bare
 * value.
 *
 * The borrow is deliberately narrow. It happens only from a peer that labels
 * the FIELD identically — so the day a sport relabels `bestOf`, the line falls
 * back to the bare value instead of rendering another sport's noun. (Carrom
 * calls it "Best of (games)", so it neither lends to nor borrows from the set
 * sports.) Until W2c Task 17 the peers were the four stage-rules sports
 * (`STAGE_RULES_SPORTS`, deleted with the gate); every sport is a peer now, and
 * the identical-label rule is what keeps that safe. Returns
 * `undefined` rather than a string when nothing declares the value, because
 * inventing copy for a value the table does not declare is a second lie — the
 * caller renders the raw value.
 */
export function ruleOptionLabel(
  sportKey: string,
  fieldKey: string,
  value: string,
): string | undefined {
  const field = rulesFor(sportKey).find((f) => f.key === fieldKey);
  if (field === undefined) return undefined;
  const own = field.options?.find((o) => o.value === value)?.label;
  if (own !== undefined) return own;
  const peers = Object.keys(SPORT_RULES)
    .filter((k) => k !== sportKey)
    .flatMap((k) => rulesFor(k).filter((f) => f.key === fieldKey));
  return borrowOptionLabel(field, peers, value);
}

/**
 * The borrow's own rule: take a peer's label for `value` only from a peer that
 * labels the FIELD identically.
 *
 * Exported, and taking its peers as an argument, because `ruleOptionLabel`
 * cannot witness the refusal — all four in-scope sports label `bestOf`
 * identically today, which `match-rules-labels.test.ts` pins. Without this
 * seam the agreement check would be a branch nothing could kill, i.e.
 * decoration (AGENTS.md failure class 3). With it, the day a sport relabels
 * the field the line falls back to the bare value instead of rendering
 * another sport's noun, and a test proves that is what happens.
 */
export function borrowOptionLabel(
  field: RuleField,
  peers: RuleField[],
  value: string,
): string | undefined {
  for (const peer of peers) {
    if (peer.label !== field.label) continue;
    const borrowed = peer.options?.find((o) => o.value === value)?.label;
    if (borrowed !== undefined) return borrowed;
  }
  return undefined;
}
