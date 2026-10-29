// Helpers more than one sport file (or the registry) needs. Nothing here
// knows a sport's rules except `WIN_BY`, the one field three sets-based sports
// share verbatim. Client-safe like the rest of this directory.
import type { AnySportModule } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import type { RuleField, RuleFieldOption } from "./types.ts";

/**
 * The inverse of the `build: (v) => ({ <key>: Number(v) })` shape that thirteen
 * of the sets-based fields share. Deliberately reports ONLY what the config it
 * is handed actually carries: `hydrateRuleValues` is fed a stage's rules
 * FRAGMENT, and a `read` that fell back to a default would make every field
 * look overridden and turn the organiser's first save into a pin of the whole
 * division format. A value of the wrong type reads as blank rather than as a
 * confident wrong number.
 */
export const readNumber =
  (key: string) =>
  (config: Record<string, unknown>): string | undefined =>
    typeof config[key] === "number" ? String(config[key]) : undefined;

/** The inverse of `{ <key>: v === "on" }`: "on" / "off" for a boolean the config carries, blank for anything else (a
 *  string "true" is not a boolean, and a missing key is not "off"). */
export const readBool =
  (key: string) =>
  (config: Record<string, unknown>): string | undefined =>
    config[key] === true ? "on" : config[key] === false ? "off" : undefined;

/** The inverse of `{ <key>: v }` for a select whose value is a string: the string the config carries, else blank. */
export const readText =
  (key: string) =>
  (config: Record<string, unknown>): string | undefined =>
    typeof config[key] === "string" ? config[key] : undefined;

/** The nested object at `key`, or undefined when the config carries anything else there (null, an array, a scalar). */
export function recordAt(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = config[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The inverse of a `build` that writes one NUMBER leaf of a nested object (`periods.minutes`, `clock.increment`). */
export const readNestedNumber =
  (key: string, leaf: string) =>
  (config: Record<string, unknown>): string | undefined => {
    const n = recordAt(config, key)?.[leaf];
    return typeof n === "number" ? String(n) : undefined;
  };

/**
 * `shapes[v] ?? fallback` is NOT a fall-through for an inherited key: a plain
 * object answers `constructor`, `toString` and friends from `Object.prototype`,
 * and those answers are not `undefined`, so `??` never fires. `build("constructor")`
 * therefore yielded `{ set: {} }` for `setType`, and for `finalSet` a Function
 * that `JSON.stringify` DROPS on the way into jsonb — silence, not an error.
 *
 * Not product-reachable (values come only from the rendered select), but the
 * commit that introduced these tables claimed the fall-through was preserved,
 * and a claim broader than its test is how the next reader gets it wrong.
 * `Object.hasOwn` makes "unknown" mean unknown for every string.
 */
export function ownOr<T>(table: Record<string, T>, key: string, fallback: T): T {
  return Object.hasOwn(table, key) ? table[key]! : fallback;
}

/**
 * Exact match on a whole nested object, extra keys included. A config carrying
 * a shape no option declares (hand-edited, or written by another path) must
 * hydrate blank rather than be rounded to the nearest option and then silently
 * rewritten to it on the next save.
 */
export function sameShape(shape: Record<string, unknown>, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(shape);
  return keys.length === Object.keys(v).length && keys.every((k) => v[k] === shape[k]);
}

/** The option whose declared shape the config carries, or `undefined`. */
export function readShape(
  shapes: Record<string, unknown>,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  for (const [option, shape] of Object.entries(shapes)) {
    if (typeof shape === "object" && shape !== null) {
      if (sameShape(shape as Record<string, unknown>, value)) return option;
    } else if (shape === value) return option;
  }
  return undefined;
}

export const WIN_BY: RuleField = {
  key: "winBy",
  label: "Win margin (points)",
  labelKey: "rules.field.winBy.label",
  help: "How many clear points are needed to win a set.",
  helpKey: "rules.field.winBy.help",
  edits: ["winBy"],
  kind: "number",
  min: 1,
  max: 2,
  build: (v) => ({ winBy: Number(v) }),
  read: readNumber("winBy"),
};

/**
 * W2c D9 — the English picker label for each abandon policy the engine can name (`abandonPolicy`'s vocabulary). A lookup
 * table, not an if/else per sport: which of them a sport OFFERS is the module's own `abandonOptions` list, so adding a
 * policy is one engine value and one row here. Canonical English like every rule label (design 2026-09-17).
 */
export const ABANDON_LABELS: Readonly<Record<string, string>> = {
  replay: "Replay the match",
  award: "Result stands",
  q4_stands: "Result stands from the 4th quarter, otherwise replay",
  share: "Share the points",
};

/** W2e Task 33a — `ABANDON_LABELS`' dictionary keys, one per policy, so the picker reads in the viewer's language. */
export const ABANDON_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  replay: "rules.field.abandon.option.replay",
  award: "rules.field.abandon.option.award",
  q4_stands: "rules.field.abandon.option.q4_stands",
  share: "rules.field.abandon.option.share",
};

/**
 * The abandon picker's options for a sport: the module's own declared list (`SportModule.abandonOptions`), in its
 * order, each through `ABANDON_LABELS`. A module that declares none offers none. A policy the table cannot label is a
 * programming error (an engine value added without its row), so it throws instead of rendering a blank option.
 */
export function abandonOptions(module: AnySportModule): RuleFieldOption[] {
  return (module.abandonOptions ?? []).map((value) => {
    if (!Object.hasOwn(ABANDON_LABELS, value) || !Object.hasOwn(ABANDON_LABEL_KEYS, value)) {
      throw new Error(`${module.key}: no label for abandon policy "${value}"`);
    }
    return { value, label: ABANDON_LABELS[value]!, labelKey: ABANDON_LABEL_KEYS[value]! };
  });
}

/** W2e Task 33a — the "Best of N" choices the sets- and games-based sports share: English `Best of N`, localized through
 *  `rules.field.bestOf.option.N`. Only the odd counts a sport plays exist as keys; a count with no key is a type error. */
const BEST_OF_OPTION_KEYS = {
  1: "rules.field.bestOf.option.1",
  3: "rules.field.bestOf.option.3",
  5: "rules.field.bestOf.option.5",
  7: "rules.field.bestOf.option.7",
} as const satisfies Record<number, MessageKey>;

export function bestOfOptions(counts: readonly (keyof typeof BEST_OF_OPTION_KEYS)[]): RuleFieldOption[] {
  return counts.map((n) => ({ value: String(n), label: `Best of ${n}`, labelKey: BEST_OF_OPTION_KEYS[n] }));
}
