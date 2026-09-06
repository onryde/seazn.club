// The /pricing "box office board" — R14 (entitlements v18 W3), design of
// record docs/superpowers/specs/mockups/2026-09-02-entitlements-v18/
// pricing-option-a-rail.html. A box office does not describe what it sells;
// it prints the running order on a board behind the counter. Ten sports in
// hairline-ruled slots, `generic` as the board's FOOT LINE rather than an
// eleventh sport.
import type { SportKey } from "@/lib/scoring-vocab";
import type { TKey } from "@/lib/i18n-runtime";

/**
 * The nine sports on the board, in the mockup's EDITORIAL order — football,
 * cricket, tennis, badminton, table tennis, volleyball, hockey, ice hockey,
 * board games. Deliberately NOT alphabetical (pricing-rail-notes.md); do not
 * "tidy" this into sorted order.
 *
 * NINE, not ten (owner ruling, W3 fix round 2): carrom no longer gets its own
 * slot — it is covered by "Board games" (`PRICING_RAIL_COVERAGE` below), and
 * nine divides into even 3x3 rows where ten did not.
 *
 * `satisfies readonly SportKey[]` rather than `: SportKey[]` so the literal
 * keeps its own tuple type (order intact) while a member that is not a real
 * sport key is still a compile error — a typo here is caught by `tsc`, not by
 * a reader noticing the board is missing a sport.
 *
 * MEMBERSHIP is no longer a 1:1 mirror of the catalogue — see
 * `PRICING_RAIL_COVERAGE`, which is what `__tests__/pricing-rail.test.ts` pins
 * against `SPORT_KEY` (lib/scoring-vocab.ts), itself already pinned 1:1 to the
 * engine's `builtinModules` by `scoring-vocab.test.ts`.
 */
export const PRICING_RAIL_SPORTS = [
  "football",
  "cricket",
  "tennis",
  "badminton",
  "tabletennis",
  "volleyball",
  "hockey",
  "icehockey",
  "boardgame",
] as const satisfies readonly SportKey[];

export type PricingRailSport = (typeof PRICING_RAIL_SPORTS)[number];

/**
 * Which rail slot covers a given catalogue sport (W3 fix round 2, owner
 * ruling: "carrom is covered by 'Board games' on this rail").
 *
 * Replaces a straight equality check against the catalogue, which would
 * break the day a sport is deliberately folded into another slot rather than
 * given its own — equality cannot express "covered by", only "identical to".
 * A `Record<Exclude<SportKey, "generic">, PricingRailSport>` still gets the
 * same compile-time floor equality had: every catalogue sport (bar `generic`,
 * the board's foot line) MUST be a key here, and `tsc` fails the day a new
 * sport is added to `SPORT_KEY` without a decision being made about it.
 *
 * `__tests__/pricing-rail.test.ts` adds the runtime half TypeScript cannot
 * express: every VALUE here must actually be a rail slot (not just typed as
 * one), and every rail slot must be reachable from at least one sport — a
 * dead slot nothing points at would otherwise hide behind this map forever.
 */
export const PRICING_RAIL_COVERAGE: Record<Exclude<SportKey, "generic">, PricingRailSport> = {
  football: "football",
  cricket: "cricket",
  tennis: "tennis",
  badminton: "badminton",
  tabletennis: "tabletennis",
  volleyball: "volleyball",
  hockey: "hockey",
  icehockey: "icehockey",
  // Owner ruling (W3 fix round 2): carrom is a board game for this rail's
  // purposes, so it does not get its own slot — folded into "Board games"
  // rather than dropped, so the catalogue coverage stays complete.
  carrom: "boardgame",
  boardgame: "boardgame",
};

/** `pricing.rail.<sportKey>` — the dictionary key for one rail slot. Sentence
 *  case, translated in all four locales: NOT the DB's English `name` column,
 *  and NOT a CSS text-transform (CSS cannot turn "Table Tennis" into "Table
 *  tennis"). */
export function pricingRailKey(sport: PricingRailSport): TKey {
  return `pricing.rail.${sport}`;
}

/** The board's foot line — "and any sport you can score". `generic` is never
 *  rendered as a twelfth rail slot; this is its own key, in its own voice. */
export const PRICING_RAIL_FOOTER_KEY: TKey = "pricing.rail.footer";
