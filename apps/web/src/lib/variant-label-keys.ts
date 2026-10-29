// A division's variant key, as a word: the closed per-sport map of dictionary keys the engine's variants resolve to.
//
// Lives apart from `server/public-site/variant-label.ts` (which is `server-only`, because it reads the online-play
// clock) so a CLIENT island — the division settings' format summary — names a variant the same way the server pages
// do, from the one map, instead of printing the stored key. `variant-label.ts` re-exports the map unchanged;
// `__tests__/variant-label.test.ts` enumerates every variant every shipped module declares against it.
import type { MessageKey } from "@/lib/messages";

export const VARIANT_LABEL_KEYS: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
  // `bwf-3x15` (W2e): the dictionary key drops the hyphen, as carrom's `club-29` and table tennis's `hardbat-21` do; so does
  // tennis's `short-sets` (W2e TN-SS-2, `shortSets`).
  badminton: {
    bwf: "variant.badminton.bwf",
    "bwf-3x15": "variant.badminton.bwf3x15",
    short: "variant.badminton.short",
  },
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
    "short-sets": "variant.tennis.shortSets",
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

/** A variant picker's option as the organiser reads it: the localized word where `VARIANT_LABEL_KEYS` names the variant,
 *  else the raw `sport_variants.name` (scripts/sync-sports.ts titleCases the key; an org preset keeps the name its
 *  organiser typed). An ORG's own preset (`system: false`) is never relabelled, even where it reuses a system key: the
 *  name is the organiser's. `system` absent = a system row (the builder and the Settings picker both pass what they know). */
export function variantOptionLabel(
  sportKey: string,
  variant: { key: string; name: string; system?: boolean },
  msg: (key: MessageKey) => string,
): string {
  if (variant.system === false) return variant.name;
  const key = variantWordKey(sportKey, variant.key);
  return key !== undefined ? msg(key) : variant.name;
}

/**
 * W2e D2: the note that sits under a variant picker, for the variants it is true of. BWF moves badminton to 3x15 on
 * 2027-01-04 while 3x21 is still the law until then, and new divisions default to 3x15 from the day W2e ships (the owner
 * accepted that gap), so the picker names both formats with the date. Closed per sport, like the label map; a variant
 * with no entry has no note. `Object.hasOwn` on both levels, as `variantWordKey`.
 */
export const VARIANT_HINT_KEYS: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
  badminton: {
    bwf: "variant.badminton.hint3x15",
    "bwf-3x15": "variant.badminton.hint3x15",
  },
};

export function variantHintKey(sportKey: string, variantKey: string): MessageKey | undefined {
  if (!Object.hasOwn(VARIANT_HINT_KEYS, sportKey)) return undefined;
  const bySport = VARIANT_HINT_KEYS[sportKey]!;
  return Object.hasOwn(bySport, variantKey) ? bySport[variantKey] : undefined;
}
