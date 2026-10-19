// T16 fix round 1, R2 — "is anyone signed in on this browser?", readable by the page's own scripts. The session cookie
// (`seazn_session`, lib/auth.ts) is HttpOnly and stays so; this companion carries NO identity and NO authority — "1" or
// absent — and only spares an anonymous viewer's browser a request it would be refused (the public fixture page's
// Your-board island asks the lobby only when it is set). The server never reads it: every door checks the session.
// Client-safe: no server-only, imported by the proxy and by a client island.

export const SESSION_HINT_COOKIE = "seazn_signed_in";

/** The session's life (lib/auth.ts mints its token and its cookie with it); the hint lives as long. */
export const SESSION_DAYS = 30;
export const SESSION_MAX_AGE_S = SESSION_DAYS * 24 * 60 * 60;

/** Exactly `seazn_signed_in=1` among a `document.cookie` / Cookie header's pairs. */
export function hasSessionHint(cookie: string): boolean {
  return cookie.split(";").some((pair) => pair.trim() === `${SESSION_HINT_COOKIE}=1`);
}
