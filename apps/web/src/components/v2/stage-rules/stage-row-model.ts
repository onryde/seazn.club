// W2c Task 17 (review I9) - the decisions the stage format row makes, as pure functions with unit killers
// (`__tests__/stage-row-model.test.ts`). The row itself (`stages-panel.tsx`) renders what these answer; a test that
// needed a browser to reach one of these would be a Playwright-only witness, and `scripts/mutate.ts` has no Playwright
// mode.
//
// Client-safe like `lib/match-rules/**`: no "use client", no JSX, no `@/server` import except the one pure reader
// `server/public-site/describe-rules.ts` exports for exactly this (`deciderIsOn`: the public line and this editor read
// whether a decider is on through ONE table, so they cannot disagree).
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import {
  SHARE_NEEDS_DRAWN_GAME,
  SHARE_NEEDS_DRAWS,
  bracketMayEndLevel,
  deciderKeysFor,
  stageDefaultsFor,
  type AnySportModule,
} from "@seazn/engine/sport";
import { alignBestOfOnePoints, buildRuleOverride, showsOnePointsField, type RuleField } from "@/lib/match-rules";
import { BEST_OF_ONE_PAIR } from "@/lib/match-rules/best-of-one";
import type { MessageKey } from "@/lib/messages";
import { moduleFor, stageFieldsFor } from "@/lib/rule-scope";
import { liveStageCfg, offByFalse } from "@/lib/stage-decider-off";
import { deciderIsOn, describeAbandon, describeDeciders, describeMatchRules } from "@/server/public-site/describe-rules";
import type { RulesClause } from "@/lib/rules-line";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const topOf = (path: string): string => path.split(".")[0]!;

// ---------------------------------------------------------------------------
// Which fields the row shows, and in which section.
// ---------------------------------------------------------------------------

/** The stage row's fields for this sport, stage kind and variant (wraps Task 5's `stageFieldsFor`): every curated field
 *  whose every key the engine declares as a stage or match key. Every sport has a row since Task 17. */
export function stageFieldsShown(module: AnySportModule, kind: StageKind, variant: string | null): readonly RuleField[] {
  return stageFieldsFor({ module, stageKind: kind, variant });
}

export type StageSectionId = "format" | "deciders" | "abandon";
export interface StageSection {
  readonly id: StageSectionId;
  readonly fields: readonly RuleField[];
}

/**
 * The shown fields in the row's sections, in the order they appear: Match format, Deciders, If abandoned (Points is the
 * stage points screen's, Task 18). A field is the abandon section's when it edits `abandonPolicy`, a DECIDER's when
 * every key it edits is a decider the engine declares for this stage or a detail of one (`detailOf`: the kicks
 * of a shoot-out, the minutes of an overtime), else the format's. Read from the engine's `ruleKeys`, never a list of
 * field names. A section no field falls in is absent, not empty.
 */
export function stageSections(module: AnySportModule, kind: StageKind, variant: string | null): StageSection[] {
  const deciders = new Set(deciderKeysFor(module, kind, variant).map(topOf));
  const bounded = new Set(
    Object.entries(module.ruleKeys ?? {})
      .filter(([, fact]) => fact.detailOf !== undefined)
      .map(([key]) => topOf(key)),
  );
  const sectionOf = (f: RuleField): StageSectionId => {
    const tops = f.edits.map(topOf);
    if (tops.every((t) => t === "abandonPolicy")) return "abandon";
    if (tops.every((t) => deciders.has(t) || bounded.has(t))) return "deciders";
    return "format";
  };
  const shown = stageFieldsShown(module, kind, variant);
  return (["format", "deciders", "abandon"] as const)
    .map((id) => ({ id, fields: shown.filter((f) => sectionOf(f) === id) }))
    .filter((s) => s.fields.length > 0);
}

/**
 * The decider a field is a DETAIL of (the kicks of a shoot-out, the minutes of an overtime), as the engine declares it
 * (`RuleKeyFact.detailOf`): every key the field edits must name the SAME decider. Null for any other field, including one
 * that edits a decider's own key (a switch is not a detail) and one the engine declares nothing for.
 */
export function deciderOfDetail(module: AnySportModule, field: RuleField): string | null {
  const facts = module.ruleKeys ?? {};
  let owner: string | null = null;
  for (const key of field.edits) {
    const of = Object.hasOwn(facts, key) ? facts[key]!.detailOf : undefined;
    if (of === undefined || (owner !== null && owner !== of)) return null;
    owner = of;
  }
  return owner;
}

/**
 * Review M-4: a detail whose decider is OFF in the resolved cfg means nothing there, and for the period sports a save
 * drops it silently (switching the shoot-out off writes `shootout: null`, taking its kicks with it). The row holds such a
 * field instead. Read through `deciderIsOn`, the public line's own table, so the editor and the line agree on "off"; a cfg
 * the schema refuses (null) holds nothing, and a decider no describer knows is never read as off.
 */
export function detailIsInert(module: AnySportModule, field: RuleField, resolved: Record<string, unknown> | null): boolean {
  const decider = deciderOfDetail(module, field);
  return decider !== null && resolved !== null && !deciderIsOn(module, decider, resolved);
}

// ---------------------------------------------------------------------------
// The collapsed row's chips (review I-1).
// ---------------------------------------------------------------------------

/**
 * The EFFECTIVE format of a stage as clauses, for the collapsed row's chips: what the stage plays under its division and
 * its own rules (`resolvedStageCfg`), worded by the public line's own describers - the format (`describeMatchRules`),
 * how a tied match ends (`describeDeciders`, for this `kind`) and the abandon policy (`describeAbandon`) - so the row and
 * the public pages can never word one format two ways. The abandon clause is always said here (the public line says it only
 * where the stage changed it), because the row is where the organiser reads what happens. Nothing for a cfg the schema
 * refuses, and nothing a describer has no words for: no table of clauses is kept here.
 */
export function stageSummaryClauses(
  sportKey: string,
  module: AnySportModule,
  kind: StageKind,
  resolved: Record<string, unknown> | null,
): RulesClause[] {
  if (resolved === null) return [];
  return [
    ...(describeMatchRules(sportKey, module, resolved) ?? []),
    ...describeDeciders(module, kind, resolved),
    ...describeAbandon(module, resolved),
  ];
}

// ---------------------------------------------------------------------------
// The deciders notice (X-SR-6, review M-3).
// ---------------------------------------------------------------------------

/**
 * The cfg a stage of this kind would PLAY under these stored `rules`: its division, the rules laid over it, then the
 * sport's bracket overlay (`liveStageCfg`, the resolver's own composition), parsed so the schema's defaults are in.
 * Null when the schema refuses it (a half-typed edit), so no notice is shown over a cfg the engine would not take.
 *
 * Carry G1 (Task 4 re-review): the notice reads THIS, never `stage.rules` alone. Chess's `bracketDeciders` forces its
 * tie-break on, so a read of the raw rules would call a stage with an empty list and tie-breaks "off" while the engine
 * plays them - and a division whose tie-break is off while the bracket plays the default list.
 */
export function resolvedStageCfg(
  module: AnySportModule,
  divisionConfig: Record<string, unknown>,
  kind: StageKind,
  rules: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const config = rules === null || Object.keys(rules).length === 0 ? {} : { rules };
  const parsed = module.configSchema.safeParse(liveStageCfg(divisionConfig, { kind, config }, module));
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

/** The decider keys a stage of this kind carries in `c`: the ones the engine declares for the kind, and any the sport's
 *  bracket overlay forces (`describeDeciders` reads the same set). */
function decidersOf(module: AnySportModule, kind: StageKind, c: Record<string, unknown>): { keys: string[]; cfg: Record<string, unknown> } {
  const forced = typeof module.bracketDeciders === "function" ? (module.bracketDeciders(c as never) as Record<string, unknown>) : {};
  const applicable = new Set(deciderKeysFor(module, kind, null));
  const keys = deciderKeysFor(module, null, null).filter((k) => applicable.has(k) || Object.hasOwn(forced, k));
  return { keys, cfg: { ...c, ...forced } };
}

/**
 * True when the stage is a bracket kind and every decider its cfg carries is switched OFF in `values` (the RESOLVED cfg,
 * `resolvedStageCfg`): a level match there is held for the organiser. Off is read through `deciderIsOn`, the public
 * line's own table, so chess's rung LIST is off only when it is EMPTY - an absent list plays every rung (BG-KO-1) and a
 * list of one is a decider - never by truthiness. A table kind, a sport with no decider and a bracket where a decider is
 * forced on (carrom's extra board) are never "off".
 */
export function decidersAllOff(module: AnySportModule, kind: StageKind, values: Record<string, unknown>): boolean {
  const isBracket = forbidsLevelResult(kind);
  const { keys: deciders, cfg } = decidersOf(module, kind, values);
  return isBracket && deciders.length > 0 && deciders.every((key) => !deciderIsOn(module, key, cfg));
}

/**
 * Review M-3: a decider is on and a match can STILL end level behind it - extra time alone, an overtime with no
 * shoot-out, a super over that ties again. The engine says so (`SportModule.canEndLevel`, through `bracketMayEndLevel`),
 * so there is no table of which deciders settle in the web; this is the notice's second mode, beside "every decider
 * off", and the two never both hold.
 */
export function decidersMayEndLevel(module: AnySportModule, kind: StageKind, values: Record<string, unknown>): boolean {
  return !decidersAllOff(module, kind, values) && bracketMayEndLevel(module, kind, values);
}

/** Which notice the row shows for a resolved cfg: every decider off, a level match that can remain, or none. */
export function deciderNotice(module: AnySportModule, kind: StageKind, values: Record<string, unknown>): "off" | "level" | null {
  if (decidersAllOff(module, kind, values)) return "off";
  return decidersMayEndLevel(module, kind, values) ? "level" : null;
}

// ---------------------------------------------------------------------------
// If abandoned (owner P-5).
// ---------------------------------------------------------------------------

/** The engine's refusal sentences for sharing the points on an abandon, and the copy that says each. Keyed by the
 *  engine's own constants, so a reworded refusal moves with the engine. */
const SHARE_REASONS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  [SHARE_NEEDS_DRAWS, "stageRules.abandon.shareNeedsDraws"],
  [SHARE_NEEDS_DRAWN_GAME, "rules.err.shareNeedsDrawnGame"],
]);

export interface AbandonOptionState {
  readonly value: string;
  readonly disabled: boolean;
  readonly reasonKey: MessageKey | null;
}

/**
 * Owner P-5: each abandon option the sport offers, with whether it can be chosen. Asked of the engine, not of a rule
 * written here: an option is unavailable when the module's own schema refuses the cfg with it, on `abandonPolicy`, with
 * one of the share refusals (generic needs draws allowed; carrom needs the tie board to be 'Drawn game'). `values` is the
 * effective cfg; a partial one is filled from the module's first variant so the schema has a whole cfg to judge.
 */
export function abandonOptionStates(module: AnySportModule, values: Record<string, unknown>): readonly AbandonOptionState[] {
  const base = Object.values(module.variants)[0] ?? {};
  return (module.abandonOptions ?? []).map((value) => {
    const parsed = module.configSchema.safeParse({ ...base, ...values, abandonPolicy: value });
    // The two share refusals are raised only on `abandonPolicy` (generic.ts, carrom.ts), and the lookup is keyed on their
    // exact sentences, so any other issue the schema reports finds no reason and the option stays offered.
    const reasonKey = parsed.success ? null : (parsed.error.issues.map((i) => SHARE_REASONS.get(i.message)).find((k) => k !== undefined) ?? null);
    return { value, disabled: reasonKey !== null, reasonKey };
  });
}

// ---------------------------------------------------------------------------
// The preset label.
// ---------------------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameJson(a[k], b[k]));
  }
  return a === b;
}

/** Whether the stage's stored rules are exactly the preset a new stage of this kind starts with (the knockout defaults:
 *  extra time and a shoot-out, an overtime, a super over). A sport that declares none, and a stage with no rules, have
 *  no preset to name. */
export function isStagePreset(module: AnySportModule, kind: StageKind, variant: string | null, rules: Record<string, unknown>): boolean {
  const preset = stageDefaultsFor(module, kind, variant);
  return Object.keys(preset).length > 0 && sameJson(preset, rules);
}

// ---------------------------------------------------------------------------
// The fragment a Save sends.
// ---------------------------------------------------------------------------

/**
 * The fragment a Save PUTs to `/api/v1/stages/{id}/rules`. That endpoint MERGES it into the stored rules (Task 11): a key
 * the body omits is KEPT, a key it names is replaced, a null value REMOVES the key (the stage inherits the division
 * again), and `{}` or `rules: null` clears everything. So a fragment is exactly what the organiser CHANGED:
 *  - a key the fields now build to something different from what they built when the editor opened is sent as built;
 *  - a key the fields built when the editor opened and build no more (the organiser blanked the field) is sent as
 *    `null`, or the cleared field would silently survive;
 *  - a key whose build did not change is OMITTED, so a stored value no field can hydrate (a hand-edited extra time) is
 *    never rewritten by an edit to a sibling field;
 *  - a null a field BUILDS is "off" in the period sports (`{shootout: null}`), which a stage cannot say with null
 *    (that means inherit): it is sent as `false`, the stage spelling `offByFalse` reads back as the engine's null;
 *  - an `undefined` (`buildOnBlank`'s delete marker) is sent as `null`.
 * Nothing touched re-sends the stored fragment verbatim (a genuine no-op, aligned on a best of 1), and so does an edit
 * whose net change is empty: an empty fragment would CLEAR the stage's rules, which only "Use division rules" may do.
 */
export function stageFormatSaveFragment(
  sportKey: string,
  stored: Record<string, unknown>,
  opened: Record<string, string>,
  values: Record<string, string>,
  inherited: Record<string, unknown> = {},
): Record<string, unknown> {
  // Nothing touched needs no branch of its own: `now` and `before` build the same, so `out` is empty and the last line
  // re-sends the stored fragment verbatim.
  const sportModule = moduleFor(sportKey);
  const now = buildRuleOverride(sportKey, values, inherited);
  const before = buildRuleOverride(sportKey, opened, inherited);
  const sendable = (key: string, v: unknown): unknown => {
    if (v === undefined) return null;
    if (v === null) return sportModule !== null && offByFalse(sportModule, inherited, key) ? false : null;
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(now)) if (!sameJson(before[key], v)) out[key] = sendable(key, v);
  for (const key of Object.keys(before)) if (!Object.hasOwn(now, key)) out[key] = null;
  // On a best of 1 the one points field writes both keys, so a change to either moves the pair together.
  if (showsOnePointsField(sportKey, values, inherited) && (BEST_OF_ONE_PAIR.shown in out || BEST_OF_ONE_PAIR.shadow in out))
    for (const k of [BEST_OF_ONE_PAIR.shown, BEST_OF_ONE_PAIR.shadow]) if (Object.hasOwn(now, k)) out[k] = sendable(k, now[k]);
  return Object.keys(out).length === 0 ? alignBestOfOnePoints(sportKey, stored, inherited) : out;
}
