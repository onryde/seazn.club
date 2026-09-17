// The slice of the public dictionary that crosses into the player page's match
// lines island — `hub-dict.ts`'s pattern, for the reason that file records: a
// `"use client"` component's `dict` prop is serialised into the RSC payload,
// so handing it all of `public.json` ships every string on the site to every
// spectator, and makes any "this copy must not appear" check on the page
// meaningless.
//
// As with the hub, the list is not the guarantee.
// `lib/__tests__/player-matches-dict.test.tsx` renders the island with the full
// dictionary and with this slice, across its empty, live and settled states,
// and requires identical markup.
import type { Dict } from "@/lib/i18n-constants";

/** Key prefixes the island reads: every result chip and the live pill. */
export const PLAYER_MATCHES_DICT_PREFIXES = ["player.result."] as const;

/** Exact keys the island reads outside the prefixes. `matchCentre.updatedAgo`
 *  is the match centre's freshness sentence, reused rather than restated. */
export const PLAYER_MATCHES_DICT_KEYS = [
  "player.matches.empty",
  "player.opponent",
  "matchCentre.updatedAgo",
] as const;

/** The subset of `dict` the player matches island may read. */
export function playerMatchesDict(dict: Dict): Dict {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(dict)) {
    const read =
      PLAYER_MATCHES_DICT_PREFIXES.some((p) => key.startsWith(p)) ||
      (PLAYER_MATCHES_DICT_KEYS as readonly string[]).includes(key);
    if (read) out[key] = dict[key];
  }
  return out;
}
