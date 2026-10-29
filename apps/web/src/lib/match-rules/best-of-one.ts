// ---------------------------------------------------------------------------
// Best of 1 — ONE "Points to win" field (owner ruling 2026-09-25, Option A;
// docs/superpowers/specs/2026-09-25-bo1-points-editor-trap.md).
//
// The set-based kernel plays the LAST possible set to `finalSetTo`
// (`setTarget`: setIndex === bestOf-1), and on best of 1 the only set IS the
// last, so `setTo` is never read. The editor used to offer "Points to win a
// set" first — the field an organiser naturally edits — and it did nothing.
//
// So on an EFFECTIVE best of 1 the editor shows one field, bound to
// `finalSetTo` (reopen therefore shows the number actually played, even over
// mismatched data), labelled "Points to win", and a save writes that number to
// BOTH keys. Everywhere else the editor is exactly the table. No engine
// change: rejected alternatives were greying the dead field out (B) and
// playing best of 1 to `setTo` (C — changes every existing config and frozen
// snapshot).
//
// "Effective" matters for the stage editor, whose values are a FRAGMENT: a
// stage that names no best-of plays at the division's, so callers pass the
// config their values inherit from. Which sports collapse is derived from the
// table (a `bestOf` picker plus both points keys) — badminton, table tennis,
// volleyball; never tennis or carrom.
//
// This file holds the cross-sport logic and is deliberately blind to the
// registry: it must not import `./index`, so the two entry points that take a
// SPORT KEY (`showsOnePointsField`, `alignBestOfOnePoints`) live in `./index`,
// which owns the table, and delegate here with the sport's field list. The
// public surface is unchanged.
// ---------------------------------------------------------------------------
import type { MessageKey } from "@/lib/messages";
import type { RuleField } from "./types.ts";

/** The one points field's label on best of 1. Sport-rules vocabulary, canonical
 *  English like every label in this table (per-stage rules ruling D4). */
export const SINGLE_SET_POINTS_LABEL = "Points to win";

/** `SINGLE_SET_POINTS_LABEL`'s dictionary key (W2e Task 33a): the relabelled field is a COPY of `finalSetTo`, so the copy has
 *  to name the new text's key too, or it would keep reading "Points in the deciding set" in every language but English. */
export const SINGLE_SET_POINTS_LABEL_KEY: MessageKey = "rules.field.pointsToWin.label";

/** The pair: `shown` is the key the engine plays at best of 1 and the one the
 *  single field is bound to; `shadow` is hidden and written to match it. */
export const BEST_OF_ONE_PAIR = { shown: "finalSetTo", shadow: "setTo" } as const;

function declaresPointsPair(fields: readonly RuleField[]): boolean {
  const keys = new Set(fields.map((f) => f.key));
  return keys.has("bestOf") && keys.has(BEST_OF_ONE_PAIR.shown) && keys.has(BEST_OF_ONE_PAIR.shadow);
}

/** The best-of these values will be played at: the edited value when there is
 *  one (blank is "Default", i.e. none), else the one they inherit. */
function effectiveBestOf(
  values: Record<string, string>,
  inherited: Record<string, unknown>,
): number | undefined {
  const raw = values.bestOf;
  if (raw !== undefined && raw !== "") return Number(raw);
  return typeof inherited.bestOf === "number" ? inherited.bestOf : undefined;
}

/** `showsOnePointsField` for a sport whose rule list is `fields` — see the
 *  public function in `./index` for what `inherited` means. */
export function showsOnePointsFieldIn(
  fields: readonly RuleField[],
  values: Record<string, string>,
  inherited: Record<string, unknown> = {},
): boolean {
  return declaresPointsPair(fields) && effectiveBestOf(values, inherited) === 1;
}

/** `alignBestOfOnePoints` for a sport whose rule list is `fields` — see the
 *  public function in `./index` for the contract. */
export function alignBestOfOnePointsIn(
  fields: readonly RuleField[],
  fragment: Record<string, unknown>,
  inherited: Record<string, unknown> = {},
): Record<string, unknown> {
  const bestOf = typeof fragment.bestOf === "number" ? fragment.bestOf : inherited.bestOf;
  const shown = fragment[BEST_OF_ONE_PAIR.shown];
  if (!declaresPointsPair(fields) || bestOf !== 1 || typeof shown !== "number") return fragment;
  if (!Object.hasOwn(fragment, BEST_OF_ONE_PAIR.shadow) || fragment[BEST_OF_ONE_PAIR.shadow] === shown)
    return fragment;
  return { ...fragment, [BEST_OF_ONE_PAIR.shadow]: shown };
}
