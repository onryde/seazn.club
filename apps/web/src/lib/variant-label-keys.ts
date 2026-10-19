// A division's variant key, as a word: the closed per-sport map of dictionary keys the engine's variants resolve to.
//
// Lives apart from `server/public-site/variant-label.ts` (which is `server-only`, because it reads the online-play
// clock) so a CLIENT island — the division settings' format summary — names a variant the same way the server pages
// do, from the one map, instead of printing the stored key. `variant-label.ts` re-exports the map unchanged;
// `__tests__/variant-label.test.ts` enumerates every variant every shipped module declares against it.
import type { MessageKey } from "@/lib/messages";

export const VARIANT_LABEL_KEYS: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
  badminton: { bwf: "variant.badminton.bwf", short: "variant.badminton.short" },
  boardgame: {
    classical: "variant.boardgame.classical",
    rapid: "variant.boardgame.rapid",
    blitz: "variant.boardgame.blitz",
  },
  carrom: { icf: "variant.carrom.icf", "club-29": "variant.carrom.club29" },
  cricket: {
    t20: "variant.cricket.t20",
    odi: "variant.cricket.odi",
    hundred: "variant.cricket.hundred",
    test: "variant.cricket.test",
  },
  football: {
    "11-a-side": "variant.football.elevenASide",
    youth: "variant.football.youth",
    "small-sided": "variant.football.smallSided",
    "mini-soccer": "variant.football.miniSoccer",
  },
  generic: { win_loss: "variant.generic.winLoss", score: "variant.generic.score" },
  hockey: {
    "fih-outdoor": "variant.hockey.fihOutdoor",
    "fih-shootout": "variant.hockey.fihShootout",
    youth: "variant.hockey.youth",
  },
  icehockey: { iihf: "variant.icehockey.iihf", recreational: "variant.icehockey.recreational" },
  tabletennis: {
    bo5: "variant.tabletennis.bo5",
    bo7: "variant.tabletennis.bo7",
    "hardbat-21": "variant.tabletennis.hardbat21",
  },
  tennis: {
    tour: "variant.tennis.tour",
    "grand-slam": "variant.tennis.grandSlam",
    fast4: "variant.tennis.fast4",
    "doubles-noad-mtb10": "variant.tennis.doublesNoAdMatchTiebreak",
  },
  volleyball: { indoor: "variant.volleyball.indoor", beach: "variant.volleyball.beach" },
};

/** The dictionary key naming `variantKey` of `sportKey`, or undefined for a key the map lacks (an org's custom
 *  variant). `Object.hasOwn` on both levels: a stored key like `constructor` is not a variant. */
export function variantWordKey(sportKey: string, variantKey: string): MessageKey | undefined {
  if (!Object.hasOwn(VARIANT_LABEL_KEYS, sportKey)) return undefined;
  const bySport = VARIANT_LABEL_KEYS[sportKey]!;
  return Object.hasOwn(bySport, variantKey) ? bySport[variantKey] : undefined;
}

/** The variant's word in the caller's locale; the stored key itself when nothing names it. */
export function variantWord(sportKey: string, variantKey: string, msg: (key: MessageKey) => string): string {
  const key = variantWordKey(sportKey, variantKey);
  return key !== undefined ? msg(key) : variantKey;
}
