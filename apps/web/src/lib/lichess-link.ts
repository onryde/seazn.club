// Where "Link your Lichess account" points (T20). Client-safe: the settings card and the registration stepper both
// build the start URL here, and the start route reads the same parameter name, so the two cannot drift.
//
// The start names the CLUB the link is for: linking is how online chess starts for a player, and online chess is
// offered per club (the PostHog flag `online-chess`), so `/api/auth/lichess` refuses a start that names no club, an
// unknown one, or one not offered online chess. A renamed club's old slug is followed once. The refusal is a
// navigation like the callback's own failures (fix round 1, m5): back to the page the start came from, or `/me`, with
// `?lichess=unavailable` — never a raw JSON body.
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

/** Every outcome the start route and the callback report on the page they land on, as `?lichess=<code>`. */
export const LICHESS_FLASH_CODES = [
  "linked",
  "oauth_state",
  "token",
  "account",
  "not_configured",
  "already_linked",
  "unavailable",
  // T17B fix 2 (D6): the server cannot seal the token (LICHESS_TOKEN_KEK unset or malformed) — external-accounts.ts's
  // own name for that failure. Nothing was linked; the grant is revoked.
  "key_unavailable",
] as const;
export type LichessFlashCode = (typeof LICHESS_FLASH_CODES)[number];

/** Where a linking flow lands: the validated `next` it started from, or `/me` (the player home — design §12) when
 *  there was none, carrying its outcome. `next` may already carry its own query (`/settings?tab=account`), so the
 *  separator is chosen rather than always `?`. One function for the start and the callback, so the two report alike. */
export function lichessLanding(next: string | null, code: LichessFlashCode): string {
  const base = next ?? "/me";
  return `${base}${base.includes("?") ? "&" : "?"}lichess=${code}`;
}

/** The sentence key for a `?lichess=` value a page was handed — `null` for anything that is not one of ours (a
 *  hand-typed value renders nothing). */
export function lichessFlashKey(value: string | null | undefined): `settings.account.lichess.flash.${LichessFlashCode}` | null {
  return (LICHESS_FLASH_CODES as readonly string[]).includes(value ?? "")
    ? (`settings.account.lichess.flash.${value as LichessFlashCode}` as const)
    : null;
}
