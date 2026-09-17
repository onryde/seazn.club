import "server-only";
// A division's FORMAT, as a spectator reads it (T16b review, fix round 3).
//
// The variant keys are a closed set each engine module declares
// (`SportModule.variants`), so their words are dictionary copy, exactly like
// the standings metric headers (`standings-view.ts`'s METRIC_HEADER_KEYS).
// Keyed per SPORT, not per variant key: the keys collide across sports with
// different meanings — football's `youth` is 2×30 halves, hockey's a 7-a-side
// game — so a flat map would name one of them wrongly.
//
// `__tests__/variant-label.test.ts` enumerates every variant every shipped
// module declares and reds on a missing or stale entry.
//
// The keys live in `ui.json` because both match-centre loaders already read
// copy through `msgFor` (which reads `ui`), and the division page already
// loads the `ui` dictionary beside `public`.
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

export interface VariantRef {
  sportKey: string;
  variantKey: string;
  /** `sport_variants.name` (this org's row over the system row), when read. */
  storedName?: string | null;
}

/** The format's word in the caller's locale. The dictionary wins for every
 *  engine-declared variant; the stored catalog name is the fallback only for a
 *  key the map lacks (an org's custom variant), and the key itself after that,
 *  so a division pointing at a variant nobody names still says something. */
export function variantLabel(ref: VariantRef, msg: (key: MessageKey) => string): string {
  const bySport = Object.hasOwn(VARIANT_LABEL_KEYS, ref.sportKey) ? VARIANT_LABEL_KEYS[ref.sportKey]! : undefined;
  const key = bySport && Object.hasOwn(bySport, ref.variantKey) ? bySport[ref.variantKey]! : undefined;
  if (key !== undefined) return msg(key);
  return ref.storedName ?? ref.variantKey;
}
