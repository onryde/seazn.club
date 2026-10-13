// Helpers more than one sport file (or the registry) needs. Nothing here
// knows a sport's rules except `WIN_BY`, the one field three sets-based sports
// share verbatim. Client-safe like the rest of this directory.
import type { RuleField } from "./types.ts";

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
  help: "How many clear points are needed to win a set.",
  kind: "number",
  min: 1,
  max: 2,
  build: (v) => ({ winBy: Number(v) }),
  read: readNumber("winBy"),
};
