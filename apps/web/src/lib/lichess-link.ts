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

/** The code in a `?lichess=` value a page was handed - `null` for anything that is not one of ours (a hand-typed value
 *  is no outcome anywhere). The ONE narrowing every page reads the parameter through: settings, /me, the registration
 *  stepper and the match room. */
export function lichessFlashCode(value: string | null | undefined): LichessFlashCode | null {
  return (LICHESS_FLASH_CODES as readonly string[]).includes(value ?? "") ? (value as LichessFlashCode) : null;
}

/** The sentence key for a `?lichess=` value a page was handed - `null` for anything that is not one of ours (a
 *  hand-typed value renders nothing). */
export function lichessFlashKey(value: string | null | undefined): `settings.account.lichess.flash.${LichessFlashCode}` | null {
  const code = lichessFlashCode(value);
  return code === null ? null : (`settings.account.lichess.flash.${code}` as const);
}

/** The outcomes that tell the player what to DO next, and the sentence that says it. A sentence alone is enough for
 *  most failures (try again; ask us); `already_linked` is the one a retry can never fix - that Lichess account belongs
 *  to ANOTHER Seazn account (unique provider + external id) - so it names the way out. The sentence never names that
 *  other account: the server does not know whose it is, and would not say. */
export const LICHESS_FLASH_NEXT_KEYS = {
  already_linked: "settings.account.lichess.flashNext.already_linked",
} as const satisfies Partial<Record<LichessFlashCode, string>>;

/** The next-step key for an outcome, `null` when it has none (or is not an outcome at all). */
export function lichessFlashNextKey(value: string | null | undefined): (typeof LICHESS_FLASH_NEXT_KEYS)[keyof typeof LICHESS_FLASH_NEXT_KEYS] | null {
  const code = lichessFlashCode(value);
  return code !== null && Object.hasOwn(LICHESS_FLASH_NEXT_KEYS, code) ? LICHESS_FLASH_NEXT_KEYS[code as keyof typeof LICHESS_FLASH_NEXT_KEYS] : null;
}

/** `href` (a path with its query and fragment) without any `lichess=` parameter - everything else kept byte for byte,
 *  in order, with its own encoding (the match room's personal link `t=` must survive untouched, so this does not
 *  round-trip the query through URLSearchParams). Unchanged when there is none. */
export function withoutLichessParam(href: string): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  if (queryAt === -1) return href;
  const path = rest.slice(0, queryAt);
  const parts = rest.slice(queryAt + 1).split("&");
  const kept = parts.filter((part) => part.split("=", 1)[0] !== "lichess");
  if (kept.length === parts.length) return href;
  return `${path}${kept.length > 0 ? `?${kept.join("&")}` : ""}${hash}`;
}
