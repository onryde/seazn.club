// The /pricing "box office board" — R14 (entitlements v18 W3), design of
// record docs/superpowers/specs/mockups/2026-09-02-entitlements-v18/
// pricing-option-a-rail.html. A box office does not describe what it sells;
// it prints the running order on a board behind the counter. Ten sports in
// hairline-ruled slots, `generic` as the board's FOOT LINE rather than an
// eleventh sport.
import type { SportKey } from "@/lib/scoring-vocab";
import type { TKey } from "@/lib/i18n-runtime";

/**
 * The ten sports on the board, in the mockup's EDITORIAL order — football,
 * cricket, tennis, badminton, table tennis, volleyball, hockey, ice hockey,
 * carrom, board games. Deliberately NOT alphabetical (pricing-rail-notes.md);
 * do not "tidy" this into sorted order.
 *
 * `satisfies readonly SportKey[]` rather than `: SportKey[]` so the literal
 * keeps its own tuple type (order intact) while a member that is not a real
 * sport key is still a compile error — a typo here is caught by `tsc`, not by
 * a reader noticing the board is missing a sport.
 *
 * MEMBERSHIP (not order) is pinned against the catalogue by
 * `__tests__/pricing-rail.test.ts`, which compares this set to `SPORT_KEY`
 * (lib/scoring-vocab.ts) — itself already pinned 1:1 to the engine's
 * `builtinModules` by `scoring-vocab.test.ts`. One authority, two hops away
 * from the database `sports` table `sync:sports` seeds from.
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
  "carrom",
  "boardgame",
] as const satisfies readonly SportKey[];

export type PricingRailSport = (typeof PRICING_RAIL_SPORTS)[number];

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
