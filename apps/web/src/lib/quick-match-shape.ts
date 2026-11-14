// The setup screen's format choice (quick match plan 5 D1, Task 6; spec docs/superpowers/specs/
// 2026-11-12-quick-match-league-knockout-design.md §3, §12): a stacked list of three whole choices, League | League → Final
// (the top 2) | League → Semi-finals → Final (the top 4). The form posts ONE radio, `shape`; the create route maps it to the
// create's `format` + `qualifiers` (`shapeToFormat`), so the page without its script needs no paired fields.
//
// Pure and import-light: the setup island (a client component, which may not value-import @/server) and the create route
// both read it, so the list the guest sees and the post the route accepts are one rule.
import type { DictionaryKey } from "@/lib/i18n-keys";
import {
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MIN_SIDES,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SEMIS_MIN_SIDES,
} from "@/lib/quick-match-constants";

/** The list's three choices, in the order it shows them (spec §12). */
export const SETUP_SHAPES = ["league", "final", "semis"] as const;
export type SetupShape = (typeof SETUP_SHAPES)[number];

type Qualifiers = (typeof QUICK_MATCH_QUALIFIERS)[number];
/** What the create takes for a shape: `league` with no count, or `league_knockout` with how many go through. */
export type ShapeFormat = { format: "league"; qualifiers: null } | { format: "league_knockout"; qualifiers: Qualifiers };

const FORMAT_OF: Record<SetupShape, ShapeFormat> = {
  league: { format: "league", qualifiers: null },
  final: { format: "league_knockout", qualifiers: 2 },
  semis: { format: "league_knockout", qualifiers: 4 },
};

/** A posted word is one of the three, by membership (never an object lookup, which `__proto__` would answer). */
export function isSetupShape(value: string): value is SetupShape {
  return (SETUP_SHAPES as readonly string[]).includes(value);
}

/** The create's fields for a shape (plan 5 D1): a fresh object, so a caller may spread it. */
export function shapeToFormat(shape: SetupShape): ShapeFormat {
  return { ...FORMAT_OF[shape] };
}

/** How many go through for a shape, or null for a plain league: the hint's `{count}`. */
export function qualifiersOf(shape: SetupShape): Qualifiers | null {
  return FORMAT_OF[shape].qualifiers;
}

export interface OfferedShape {
  shape: SetupShape;
  enabled: boolean;
  /** Why a row is shown but cannot be picked (its one line under the hint), or null when it can. */
  reason: DictionaryKey | null;
}

/** The fewest sides each choice is played with (spec §3): a knockout from three (two sides would replay the league as its
 *  final), Semi-finals from four. A row below its minimum says so, with this number as its reason's `{min}`. */
const MIN_SIDES: Record<SetupShape, number> = {
  league: QUICK_MATCH_MIN_SIDES,
  final: QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  semis: QUICK_MATCH_SEMIS_MIN_SIDES,
};
export function minSidesOf(shape: SetupShape): number {
  return MIN_SIDES[shape];
}

/** Each knockout row's reason below its minimum ("Needs {min} or more sides"). */
const NEEDS_SIDES: Record<Exclude<SetupShape, "league">, DictionaryKey> = {
  final: "quickMatch.setup.shape.finalNeeds",
  semis: "quickMatch.setup.shape.semisNeeds",
};

/**
 * The rows the list shows (spec §3, §12; owner 2026-11-14: "show default and disable like semifinal, other user doesn't know
 * what format we have"): always all three, in the list's order, so a guest sees every format there is. League can always be
 * picked. A knockout row is disabled, with its one-line reason, where the variant may never play one (C23,
 * `knockoutAllowed`: "Not available for this sport") or below its minimum sides ("Needs {min} or more sides"). The rules'
 * reason wins: one more side would not make that row playable.
 */
export function shapesOffered(sides: number, knockoutAllowed: boolean): OfferedShape[] {
  return SETUP_SHAPES.map((shape): OfferedShape => {
    if (shape === "league") return { shape, enabled: true, reason: null };
    if (!knockoutAllowed) return { shape, enabled: false, reason: "quickMatch.setup.shape.notForSport" };
    if (sides < MIN_SIDES[shape]) return { shape, enabled: false, reason: NEEDS_SIDES[shape] };
    return { shape, enabled: true, reason: null };
  });
}

/**
 * The choice that is posted and counted: the guest's own when its row can still be picked, else the deepest choice that can
 * be picked that is not deeper than it (Semi-finals at three sides is Final; any knockout at two sides, or on a variant that may
 * only play League, is League). Derived on every render, so it never needs a reset when the sides or the rules change, and
 * putting the side back brings the guest's choice back.
 */
export function effectiveShape(chosen: SetupShape, offered: readonly OfferedShape[]): SetupShape {
  const at = SETUP_SHAPES.indexOf(chosen);
  for (let k = at; k >= 0; k--) {
    const shape = SETUP_SHAPES[k]!;
    if (offered.some((o) => o.shape === shape && o.enabled)) return shape;
  }
  return "league";
}
