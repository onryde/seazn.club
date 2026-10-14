/** Which entrant plays White, read off the folded `match_states.state` — the one rule the game's creation
 *  (`whiteSideOf`, guard.ts) and the public page's start position (option B, `loadPublicPairedWhiteSide`) both read.
 *
 *  `colorOfHome` absent, null, or no fold at all reads as White-on-home, because that is Swiss's own default
 *  (chess.md §2, `packages/engine/src/scheduling/swiss.ts:42`: "home: EntrantId // chess: White") and the boardgame
 *  module's `init` agrees (`colorOfHome: cfg.colors ? "W" : null` — colours-on is itself the schema default, so a
 *  fresh fold before any pairing card already reads "W", never null). Only a `boardgame.pairing` card recording
 *  Black on home makes the away entrant White. */
export function whiteSideOfFold(state: unknown): "home" | "away" {
  if (state === null || typeof state !== "object") return "home";
  return (state as { colorOfHome?: unknown }).colorOfHome === "B" ? "away" : "home";
}
