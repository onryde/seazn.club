// W2c (spec §4.1 as amended; plan D1) — the helpers every allowlist, form and label derives its keys from, and the
// one check a match override passes (X-SR-2). Each reads a module's own `ruleKeys`; none hand-lists a key.
import type { StageKind } from "../core/types.ts";
import type { AnySportModule, RuleKeyFact, RuleScope } from "./module.ts";

/** Whether a declared key applies to a stage kind and variant. A null kind (the division level, before any stage)
 *  or a null variant is never narrowed. */
export function ruleKeyApplies(fact: RuleKeyFact, kind: StageKind | null, variant: string | null): boolean {
  const kinds = fact.appliesTo?.stageKinds;
  const variants = fact.appliesTo?.variants;
  return (kinds === undefined || kind === null || kinds.includes(kind))
    && (variants === undefined || variant === null || variants.includes(variant));
}

const keysWhere = (m: AnySportModule, kind: StageKind | null, variant: string | null, scopes: readonly RuleScope[]): readonly string[] =>
  Object.entries(m.ruleKeys ?? {}).filter(([, f]) => scopes.includes(f.scope) && ruleKeyApplies(f, kind, variant)).map(([k]) => k);
const topOf = (key: string): string => key.split(".")[0]!;

/** Keys a stage of this kind and variant may set: scope `stage` and `match`. */
export const stageKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null): readonly string[] =>
  keysWhere(m, kind, variant, ["stage", "match"]);
/** Keys one match may set: scope `match` only (always a subset of `stageKeysFor`). */
export const fixtureKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null): readonly string[] =>
  keysWhere(m, kind, variant, ["match"]);
/** The stage's table-points keys (D11): the points screen, never the rules picker. */
export const pointsKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null): readonly string[] =>
  keysWhere(m, kind, variant, ["points"]);
/** First segments of `stageKeysFor` — the top-level cfg keys a stage's rules fragment may carry. */
export const stageTopKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null): ReadonlySet<string> =>
  new Set(stageKeysFor(m, kind, variant).map(topOf));
/** First segments of every declared key, whatever its scope. */
export const sportTopKeys = (m: AnySportModule): ReadonlySet<string> => new Set(Object.keys(m.ruleKeys ?? {}).map(topOf));

/** The declaration that owns a cfg path: the most specific declared prefix ("overtime.minutes" over "overtime").
 *  Only the module's OWN keys count — an inherited property name ("toString") is never a rule key. */
export function ruleKeyOwning(m: AnySportModule, path: readonly string[]): { key: string; fact: RuleKeyFact } | null {
  const keys = m.ruleKeys ?? {};
  for (let n = path.length; n >= 1; n--) {
    const key = path.slice(0, n).join(".");
    if (Object.hasOwn(keys, key)) return { key, fact: keys[key]! };
  }
  return null;
}

/** The rules a new stage of this kind starts with (spec §4.2); `{}` for a sport that declares none. */
export const stageDefaultsFor = (m: AnySportModule, kind: StageKind, variant: string | null): Record<string, unknown> =>
  (m.stageDefaults?.(kind, variant) ?? {}) as Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The paths of the leaves that differ. A list, or a value that changes shape, is ONE leaf; only an object on BOTH
 *  sides is descended. */
function changedLeaves(before: unknown, after: unknown, path: readonly string[]): (readonly string[])[] {
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => changedLeaves(before[k], after[k], [...path, k]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
}
/** The value at a declared key's path. Every prefix of a changed leaf is an object on both sides (`changedLeaves`
 *  only descends through objects), so no step can land on a non-object. */
const valueAt = (o: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], o);

const OFF_AT_STAGE = "it is off for this stage";
const NOT_LONGER = "it can only be shorter than the stage's";

/** RB2B-3 (X-SR-2): a match may switch the key off or shorten it, never switch it on or lengthen it. Reads the
 *  `{enabled, halfMinutes}` shape — the X-SR-1 sweep proves every `off_or_shorter` key has it. */
function offOrShorter(o: unknown, s: unknown): string | null {
  const ov = isObj(o) ? o : {};
  const st = isObj(s) ? s : {};
  if (ov.enabled !== true) return null;
  if (st.enabled !== true) return OFF_AT_STAGE;
  return Number(ov.halfMinutes) <= Number(st.halfMinutes) ? null : NOT_LONGER;
}

/** X-SR-2 (signed): a decider may only be switched off or shortened for one match. `o` and `s` are the override's and
 *  the stage's values at the decider's key; the X-SR-1 sweep proves each bound's shape. */
function deciderBound(bound: NonNullable<RuleKeyFact["matchBound"]>, o: unknown, s: unknown): string | null {
  if (bound === "off_or_shorter") return offOrShorter(o, s);
  if (bound === "off") return o === false ? null : s === true ? "it can only be switched off for one match" : OFF_AT_STAGE;
  if (typeof s !== "number") return OFF_AT_STAGE;
  return typeof o === "number" && o <= s ? null : NOT_LONGER;
}

export type OverrideCheck =
  | { readonly ok: true; readonly changed: readonly string[] } // dotted leaves
  | { readonly ok: false; readonly code: "UNKNOWN_RULE_KEY" | "RULE_NOT_SETTABLE"; readonly path: string; readonly reason: string };

const notSettable = (path: string, reason: string): OverrideCheck => ({ ok: false, code: "RULE_NOT_SETTABLE", path, reason });

/**
 * X-SR-2 — may this match differ from its stage by `override`? `override` carries whole top-level values (the
 * resolver lays it over the stage's); `stageResolved` is the cfg the stage resolves to. Every leaf that differs must
 * be owned by a `match`-scope key that applies to this kind and variant, and a decider (a key with a `matchBound`) may
 * only go off or shorter — never on where its stage has it off. Any other match key is a FORMAT key and may differ
 * even where the stage carries none (cricket's bowler limit). A key the sport never declares is `UNKNOWN_RULE_KEY`,
 * checked first. `changed` lists the dotted leaves that differ, in override order.
 */
export function checkFixtureOverride(
  m: AnySportModule, kind: StageKind | null, variant: string | null,
  stageResolved: Record<string, unknown>, override: Record<string, unknown>,
): OverrideCheck {
  const known = sportTopKeys(m);
  for (const top of Object.keys(override))
    if (!known.has(top)) return { ok: false, code: "UNKNOWN_RULE_KEY", path: top, reason: `${top} is not a ${m.key} rule` };
  const changed: string[] = [];
  for (const top of Object.keys(override))
    for (const leaf of changedLeaves(stageResolved[top], override[top], [top])) {
      const path = leaf.join(".");
      const owner = ruleKeyOwning(m, leaf);
      if (owner === null || owner.fact.scope !== "match" || !ruleKeyApplies(owner.fact, kind, variant))
        return notSettable(path, "it can be set per stage, not per match");
      if (owner.fact.matchBound !== undefined) {
        const why = deciderBound(owner.fact.matchBound, valueAt(override, owner.key), valueAt(stageResolved, owner.key));
        if (why !== null) return notSettable(owner.key, why);
      }
      changed.push(path);
    }
  return { ok: true, changed };
}
