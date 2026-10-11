// Where "Link your Lichess account" points (T20). Client-safe: the settings card and the registration stepper both
// build the start URL here, and the start route reads the same parameter name, so the two cannot drift.
//
// The start names the CLUB the link is for: linking is how online chess starts for a player, and online chess is
// offered per club (the PostHog flag `online-chess`), so `/api/auth/lichess` refuses — 403 ONLINE_CHESS_DISABLED —
// a start that names no club, an unknown one, or one not offered online chess.
export const LICHESS_LINK_START_PATH = "/api/auth/lichess";
/** The query parameter carrying the club's slug. */
export const LICHESS_LINK_ORG_PARAM = "org";

/** The start URL for linking a Lichess account for `orgSlug`'s online chess, returning to `next` (a same-origin
 *  path; the route re-validates it) when given. */
export function lichessLinkStartHref(orgSlug: string, next?: string): string {
  const q = new URLSearchParams({ [LICHESS_LINK_ORG_PARAM]: orgSlug });
  if (next) q.set("next", next);
  return `${LICHESS_LINK_START_PATH}?${q.toString()}`;
}
