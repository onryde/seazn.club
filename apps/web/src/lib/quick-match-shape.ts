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

/**
 * The rows the list shows (spec §3, §12). League always. A knockout only where the variant may play one (C23,
 * `knockoutAllowed`) and from three sides (two sides: a league then a final between the same two is a repeat, so neither
 * knockout row is offered). Semi-finals need four: below that the row stays in the list, disabled, with its reason.
 */
export function shapesOffered(sides: number, knockoutAllowed: boolean): OfferedShape[] {
  const league: OfferedShape = { shape: "league", enabled: true, reason: null };
  if (!knockoutAllowed || sides < QUICK_MATCH_KNOCKOUT_MIN_SIDES) return [league];
  const semis = sides >= QUICK_MATCH_SEMIS_MIN_SIDES;
  return [
    league,
    { shape: "final", enabled: true, reason: null },
    { shape: "semis", enabled: semis, reason: semis ? null : "quickMatch.setup.shape.semisNeeds" },
  ];
}

/**
 * The choice that is posted and counted: the guest's own when the list still offers it, else the deepest choice still
 * offered that is not deeper than it (Semi-finals at three sides is Final; any knockout at two sides, or on a variant that may
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
