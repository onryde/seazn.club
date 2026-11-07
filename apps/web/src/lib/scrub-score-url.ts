// Device-link tokens stay out of telemetry (scorer sheets final review, I2).
//
// A device link's secret IS its URL: `/score/<token>`. The pad also sends the
// same token as `Authorization: Bearer dl_…` on every scoring call. Since
// scorer sheets, a token lives until its match is over and is printed on
// paper. Any telemetry that records a URL (a pageview, an error's request, a
// breadcrumb, a replay's URL list) would send a working scoring credential to
// a third party. Every helper here swaps the token for a fixed placeholder and
// leaves the rest of the value as it was.
//
// The stream overlay's realtime KEY rides a URL the same way (lane-close re-review M-2): the OBS URL the organiser's
// panel copies (`/overlay/fixtures/{id}?…&key=…`) and the overlay's token request (`/realtime-token?purpose=overlay&
// key=…`). It grants a realtime subscription to one public fixture, retired only by rotating AUTH_SECRET, so it is
// scrubbed with the same care: every `key=` QUERY PARAMETER value becomes `[key]`, plain or URL-encoded.
//
// Capture QR v2 §10.2 (A18): the phone routes `/api/v1/capture/codes/{code}…` carry half their credential in the path
// (the code) and the other half as `Authorization: Bearer <tok>`; the beat's body names the code again. Every string's
// `/capture/codes/<code>` becomes `/capture/codes/[code]` (plain or encoded), and a capture route's Sentry event also
// loses its Bearer (`Bearer [tok]`) and its request body. Every other event keeps its headers and body.
//
// R2005 (review round 1, item 1): the compositor's relay PAGE token rides its URL the same way — the composed session's
// `overlayUrl` (`/overlay/fixtures/{id}?sid=…&st=…&host=compositor…`) and the relay page's live-data poll, sent every
// STREAM_POLL_MS (`overlayPollPath`: `/api/v1/public/fixtures/{id}/overlay?sid=…&st=…`). A `relay-page` token opens a
// NON-public fixture's overlay until its session ends, so every `st=` QUERY PARAMETER value becomes `[st]`, plain or
// URL-encoded, by the `key=` rules. `sid` names a session and is not a credential: it stays.
//
// The personal match-room link (chess external play, spec §12.1) is the same kind of secret: `…/play?t=<token>`, a 24-hour
// HS256 JWT that IDENTIFIES the player to the room without a session. Signing in to link Lichess from that room carries
// the whole room path inside a `next` parameter (the Lichess start URL, then /login?next=, /magic-link?token=…&next= and
// /verify-email?token=…&next=), so the token sits in a URL at three encoding depths: `?t=`, `%3Ft%3D` and `%253Ft%253D`.
// Every `t=` QUERY PARAMETER whose value is shaped like a JWT becomes `[token]`, plain or URL-encoded at any depth. A `t=`
// that is not a JWT (`?t=90s`, `?t=1.2.3`) is left alone: the discriminator is the value's shape, three base64url segments.
//
// A one-time sign-in token rides a URL the same way, and reaches telemetry BEFORE it is spent. The emailed link is
// `/magic-link?token=<one-time>&next=…` (login-link.ts, 15 minutes) or `/verify-email?token=<one-time>&next=…`
// (verification.ts, 24 hours); the page lands, PostHog's `$pageview` fires on landing, and only then does the island POST the
// token to be consumed. Until then the URL holds a working credential, and so do Sentry's request URL, its bare
// `request.query_string`, its breadcrumbs and a replay's URL list. A `token=` QUERY PARAMETER value on one of the routes in
// `ONE_TIME_TOKEN_ROUTES` becomes `token=[token]`, plain or URL-encoded at any depth, either hex case (inside a login's
// `next=`, a referrer). The scope is the ROUTE, not the parameter name: a `token=` on any other path stays (the registration
// status page's access token is reusable and is not one of these). The routes are the ones whose links the app builds with
// a single-use token: also the funnel's `/start/claim`, a staff `/admin/impersonate` hand-off and
// `/api/auth/change-email/confirm`. Sentry's `request.query_string` has no path to scope by, so it is scrubbed when the
// event's URL or transaction names one of those routes, the way a capture route's request is recognised (`isCaptureEvent`).
//
// Five more credentials carry themselves in the PATH, and become `[token]` after their prefix, plain or URL-encoded at
// any depth, by the `/capture/codes/` rules (`SECRET_PATH_ROUTES`). Each is a ROUTE ROOT and is matched only there (the start
// of a path, after an origin, or after the marketing locale prefix): a club or competition slug is free text, so
// `/o/x/c/join/d/claim` is an address and not a secret (`ROUTE_ROOT`):
//  - the profile-claim link `/claim/<secret>` (routes.claim; `pc_` + 43 base64url, 14 days; person-claims.ts) and the
//    accept call its button makes, `/api/claims/<secret>/accept`: whoever holds it links the profile to their account;
//  - the org invite `/join/<token>` (24 random bytes; 1 hour to never; up to 1000 uses, 0 = unlimited; the role is admin
//    or viewer; invites.ts) and its calls `/api/invites/<token>[/accept|/claim]`, `/api/orgs/<id>/invites/<token>/revoke`.
//    An email invite also mints a SESSION for a new or unverified invitee (`/claim`), as a magic link does; the team
//    screen masks the token on purpose;
//  - the fixture check-in code `/checkin/<token>` and `/api/checkin/<token>` (an HS256 JWT valid until the fixture's local
//    midnight; checkin-token.ts): it is the proof of presence at the venue, so it is a credential, not a public address;
//  - the Match Day code `/day/<token>` (`md_` + 43 base64url, one day; match-day-codes.ts): it lists a competition's matches
//    and opens their scoring links in the Seazn Club app, and a phone's camera lands on the page with it;
//  - the sponsor report link `/r/sponsor/<token>` (32 random bytes, base64url; until the club revokes it; R4 S14): whoever
//    holds it reads that sponsor's figures and frames, with no login - a bearer credential, though it sits under `/r/`;
//  - a quick match's home `/q/<home token>` (`qm_` + 43 base64url; quick-match-tokens.ts): whoever holds it can score
//    every match of that quick match (quick match spec O3, C19). The scoring pad links back to it (C12), so it is in the
//    pad's DOM and in the navigation a click starts.
// Left alone: the registration reference `/r/<ref>` (a
// lookup, not auth; the emailed `token` is what authorises a withdrawal) - a reference literally `sponsor` included, since
// only a segment AFTER `/r/sponsor/` is a credential.
//
// A team's JOIN CODE is a capability too (`generateRefCode`, 30^6): whoever holds it can join the entry. It rides the register
// pages as `?join_code=<code>[&player_id=…]` (the join page and its preview request) and as `?join=<code>` (the register
// page's deep link and the Lichess return path), and is in the join POST's body. Every `join_code=` / `join=` QUERY PARAMETER
// value becomes `[code]`, plain or URL-encoded at any depth, by name (a join code has no route of its own to scope by).
//
// Left visible, on purpose: the OAuth `code=` / `state=` on `/api/auth/google/callback` and `/api/auth/lichess/callback`. The
// authorization code is single-use and is redeemed only WITH a secret that never leaves the server (Google: the client
// secret; Lichess: the PKCE `code_verifier`, in an httpOnly cookie), and `state` is compared to an httpOnly cookie, so
// neither is worth anything to whoever reads the URL. (The verdict table is in lib/__tests__/scrub-query-credentials.test.ts.)
//
// A credential also rides a request BODY, which no URL rule sees: the POST that spends a one-time token sends it as JSON
// (`{ token, next }`), so a Sentry error on that route carries the working credential in `request.data`. A Sentry event
// whose request URL or transaction names such a route loses its body, the way a capture route's does (`isCaptureEvent`):
// the POST routes in `BODY_CREDENTIAL_ROUTES` (sign-in consume, email verification, email-change confirmation, funnel
// claim, a registrant's withdraw / checkout / resend, and a team's join POST) and every route with a secret in its path (`SECRET_PATH_ROUTES`: the invite and claim
// accepts, check-in, revoke). Only a Sentry event has a body to drop.
//
// A sampled TRANSACTION carries the request's query string a second time, in its span data, WITH its `?` and beside a URL
// that has none: `http.query` in `contexts.trace.data` and an outgoing request's breadcrumb (@sentry/opentelemetry
// `getRequestSpanData`), `url.query` in a span's data (@sentry/core `getHttpSpanDetailsFromUrlObject`). Where the event, or
// the span's own sibling url (`url.full`, `url.path`, `http.route`, `http.target`, `url`), names a one-time route, that query
// loses its `token=` like `request.query_string` does; where it names a body-credential route, the serialised body in
// `http.request.body.data` goes with the request body (`scrubSpanData`).
import type * as Sentry from "@sentry/nextjs";
import type { CaptureResult } from "posthog-js";
import { LOCALES } from "./i18n-constants";
import { OVERLAY_KEY_PARAM } from "./realtime-purpose";

// @sentry/nextjs re-exports `Event` but not `Integration` (that lives in
// @sentry/core, which is not a dependency here), so take it from a signature.
type Event = Sentry.Event;
type Integration = Parameters<typeof Sentry.addIntegration>[0];

/** `/score/` plus the token: everything up to the next `/`, `?`, `#`, quote, angle bracket or space. */
const SCORE_PATH = /\/score\/[^/?#\s"'<>]+/g;
/**
 * The same path URL-ENCODED inside another URL (a login `next=`, a referrer
 * carried as a param): `%2Fscore%2F<token>`, at any encoding depth (`%252F`…),
 * either hex case. The token ends at the next `%` (its encoded delimiter), `&`,
 * `/`, `?`, `#`, quote, angle bracket or space. The prefix is kept as it was.
 */
const ENCODED_SCORE_PATH = /(%(?:25)*2[Ff]score%(?:25)*2[Ff])[^%&/?#\s"'<>]+/g;
/**
 * A bare secret, e.g. in an `Authorization` header. `mintDeviceLinkSecret`
 * makes `dl_` + 43 base64url chars, and a Match Day code (MD-1 review I3,
 * `match-day-codes.ts`) is `md_` + 43 more, sent as `Bearer md_…` the same way.
 * The prefix is kept (`dl_[token]`, `md_[token]`). No `\b` in front: a secret
 * glued to a word character (`x_dl_…`, `%2Fmd_…`) has no word boundary before
 * its prefix. The 32-character floor is what keeps ordinary words
 * (`model_dl_config`, `handl_…`, `cmd_md_config`) from being eaten.
 */
const BARE_TOKEN = /(dl|md)_[A-Za-z0-9_-]{32,}/g;
/**
 * The overlay key as a query parameter: `key=` at the start of a query string (Sentry's `request.query_string` carries
 * no `?`) or after `?` / `&`, never inside another name (`monkey=`, `apikey=`). The value ends at the next `&`, `#`,
 * quote, angle bracket or space. Any value, not only the key's own length: a tampered or foreign key is scrubbed too.
 */
const OVERLAY_KEY_QUERY = new RegExp(`((?:^|[?&])${OVERLAY_KEY_PARAM}=)[^&#\\s"'<>]+`, "g");
/** The same parameter URL-ENCODED inside another URL: `%3Fkey%3D` / `%26key%3D`, at any encoding depth, either hex case. */
const ENCODED_OVERLAY_KEY = new RegExp(`(%(?:25)*(?:3[Ff]|26)${OVERLAY_KEY_PARAM}%(?:25)*3[Dd])[^%&#\\s"'<>]+`, "g");
/** The relay page token's query parameter (R2005): the name `relayParamsOf` reads and both producers write. */
const RELAY_PAGE_TOKEN_PARAM = "st";
/** `st=` as a query parameter, by `OVERLAY_KEY_QUERY`'s rules: never inside another name (`test=`, `best=`). */
const RELAY_PAGE_TOKEN_QUERY = new RegExp(`((?:^|[?&])${RELAY_PAGE_TOKEN_PARAM}=)[^&#\\s"'<>]+`, "g");
/** The same parameter URL-ENCODED inside another URL: `%3Fst%3D` / `%26st%3D`, at any encoding depth, either hex case. */
const ENCODED_RELAY_PAGE_TOKEN = new RegExp(`(%(?:25)*(?:3[Ff]|26)${RELAY_PAGE_TOKEN_PARAM}%(?:25)*3[Dd])[^%&#\\s"'<>]+`, "g");
/**
 * A team's join code (M3, review of PR 988): the register pages' `join_code` and the register deep link's `join`. Both names
 * are listed here and nowhere else, so a test can follow them.
 */
export const JOIN_CODE_PARAMS = ["join_code", "join"] as const;
const JOIN_CODE_NAMES = JOIN_CODE_PARAMS.join("|");
/** `join_code=` / `join=` as a query parameter: first in a bare query string or after `?` / `&`, never inside another name (`rejoin=`). */
const JOIN_CODE_QUERY = new RegExp(`((?:^|[?&])(?:${JOIN_CODE_NAMES})=)[^&#\\s"'<>]+`, "g");
/** The same parameter URL-ENCODED inside another URL: `%3Fjoin_code%3D` / `%26join%3D`, at any encoding depth, either hex case. */
const ENCODED_JOIN_CODE = new RegExp(`(%(?:25)*(?:3[Ff]|26)(?:${JOIN_CODE_NAMES})%(?:25)*3[Dd])[^%&#\\s"'<>]+`, "g");
/** A capture code in a phone route's path: everything up to the next `/`, `?`, `#`, quote, angle bracket or space. */
const CAPTURE_PATH = /(\/capture\/codes\/)[^/?#\s"'<>]+/g;
/** The same path URL-ENCODED inside another URL, at any encoding depth, either hex case. */
const ENCODED_CAPTURE_PATH = /(%(?:25)*2[Ff]capture%(?:25)*2[Ff]codes%(?:25)*2[Ff])[^%&/?#\s"'<>]+/g;
/**
 * A JWT's shape: three base64url segments, each at least 8 characters (the match-room token's header alone is ~50, its
 * payload ~170, its HS256 signature 43). The floor is what keeps a version (`1.2.3`), a date (`2026.10.19`) or a time
 * offset (`90s`) from being read as a credential.
 */
const JWT_SHAPE = "[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}";
/** The personal match-room token as the query parameter `t`, with a JWT-shaped value: at the start of a query string
 *  (Sentry's `request.query_string` carries no `?`) or after `?` / `&`, never inside another name (`at=`, `utm_t=`). */
const ROOM_TOKEN_QUERY = new RegExp(`((?:^|[?&])t=)${JWT_SHAPE}`, "g");
/** The same parameter URL-ENCODED inside another URL (the room path in a `next=`): `%3Ft%3D` / `%26t%3D`, at any
 *  encoding depth, either hex case. The token ends at its first non-JWT character, so its encoded delimiter stays. */
const ENCODED_ROOM_TOKEN = new RegExp(`(%(?:25)*(?:3[Ff]|26)t%(?:25)*3[Dd])${JWT_SHAPE}`, "g");
/**
 * Route prefixes whose NEXT segment is a credential: the profile-claim secret (`/claim/<secret>` and the accept call
 * `/api/claims/<secret>/accept`), the org-invite token (`/join/<token>` and `/api/invites/<token>[/accept|/claim]`; the
 * revoke call `/api/orgs/<id>/invites/<token>/revoke`), the day's check-in code (`/checkin/<token>`,
 * `/api/checkin/<token>`), the sponsor report link (`/r/sponsor/<token>`, R4 S14), the sponsor invoice link
 * (`/r/sponsor/invoice/<token>`, its `/pdf` and `/pay`: sponsor deals T22) and a quick match's home token (`/q/<token>`,
 * and every call under it). Each is spelled with its trailing slash, so `/claims/…`, `/joined/…`, `/checkin-link`,
 * `/quick/…` and `/register/join` (a public page with nothing after it) do not match, and `[id]` stands for one path segment.
 *
 * Every one is a ROUTE ROOT, and is matched there only (`ROUTE_ROOT`): a club or competition slug is free text, so
 * `/o/x/c/join/d/claim` is an address and not a secret. They are spelled in full, not by their shortest tail, for the same
 * reason: `/invites/` alone would match any segment named `invites` anywhere.
 * Not here, on purpose: the registration reference `/r/<ref>` (a
 * lookup, not auth; `/r/sponsor/` above is the one credential under `/r/`, and a reference that reads `sponsor` has nothing
 * after it).
 */
const SECRET_PATH_ROUTES = [
  "/claim/",
  "/api/claims/",
  "/join/",
  "/checkin/",
  "/api/checkin/",
  "/api/invites/",
  "/api/orgs/[id]/invites/",
  // BEFORE "/r/sponsor/" (F21): the alternation takes the FIRST prefix that matches, and "/r/sponsor/" would take the segment
  // `invoice` for the credential and leave the invoice token in the URL.
  "/r/sponsor/invoice/",
  "/r/sponsor/",
  // Quick match (plan 1 Task 9): the home token. A one-letter root, which is why every root here is matched at the root
  // only: a competition slug `q` (`/o/x/c/q/…`) is an address, not this route.
  "/q/",
  "/day/",
] as const;
/** The marketing locale prefix (`/fr/pricing`): a route root may follow it. */
const LOCALE_PREFIX = LOCALES.join("|");
/**
 * Where a route root may start, consumed as the front of the match (no lookbehind: it is a syntax error in Safari before
 * 16.4, and this module loads in every browser): the start of the string, whitespace or a delimiter (a transaction
 * name's `GET `, a quote or backtick, `=`, `&`, `?`, `#`, `:`, `{`, `[`, `|`), or an origin; then an optional locale prefix. An origin
 * is `//host` (`https://host:3000`, `HTTPS://host`, protocol-relative `//host`: the scheme needs no pattern of its own, so
 * its letter case cannot matter). A `/` that follows a path segment (`/o/x/join/…`) is not a root.
 */
const ROUTE_ROOT = `(?:^|[\\s"'\`<>=(,;&?#:{|\\[]|\\/\\/[^/\\s"'<>?#]+)(?:\\/(?:${LOCALE_PREFIX}))?`;
/** The same root inside a URL-ENCODED string, at any depth, either hex case: the start, a plain delimiter, an encoded one
 *  (`=` `&` `?` `,` `:` `{` `[` `|` backtick, and a space: `%20`), an encoded origin (`%2F%2Fhost`: `https%3A%2F%2Fhost%3A3000`, `HTTPS%3A…`,
 *  protocol-relative), then the encoded locale prefix. */
const ENCODED_ROUTE_ROOT = `(?:^|[\\s"'\`<>=(,;&?#:{|\\[]|%(?:25)*(?:3[Dd]|26|3[Ff]|2[Cc]|3[Aa]|7[Bb]|7[Cc]|60|5[Bb]|20)|%(?:25)*2[Ff]%(?:25)*2[Ff](?:[^%/\\s"'<>?#&]|%(?:25)*3[Aa])+)(?:%(?:25)*2[Ff](?:${LOCALE_PREFIX}))?`;
/** The routes with each `/` spelled as given and `[id]` as one segment: `\/claim\/` plain, `%(?:25)*2[Ff]claim%(?:25)*2[Ff]` encoded. */
const prefixAlternation = (slash: string, segment = "[^/?#\\s\"'<>]+") =>
  SECRET_PATH_ROUTES.map((r) =>
    r
      .split("/")
      .map((seg) => (seg === "[id]" ? segment : seg))
      .join(slash),
  ).join("|");
/** A route root, its prefix, and the secret after it: base64url, so up to the next `/`, `?`, `#`, `&`, `=`, quote, angle bracket or space. */
const SECRET_PATH = new RegExp(`(${ROUTE_ROOT}(?:${prefixAlternation("\\/")}))[^/?#&=\\s"'<>]+`, "g");
/** The same path URL-ENCODED inside another URL (a sign-in `next=/claim/<secret>`), at any encoding depth, either hex case. */
const ENCODED_SECRET_PATH = new RegExp(`(${ENCODED_ROUTE_ROOT}(?:${prefixAlternation("%(?:25)*2[Ff]", "[^%&/?#\\s\"'<>]+")}))[^%&=/?#\\s"'<>]+`, "g");

/**
 * The routes whose emailed link carries a SINGLE-USE token in its `token` query parameter to a page that spends it: the
 * sign-in link, the email-verification link, the funnel claim (it signs the visitor in), a staff
 * impersonation hand-off and an email-change confirmation. A `token=` is scrubbed only when it is a parameter of one of
 * these. Not here, on purpose: the registration status page's `?token=` is a reusable access token for a cart.
 */
const ONE_TIME_TOKEN_ROUTES = [
  "/magic-link",
  "/verify-email",
  "/start/claim",
  "/admin/impersonate",
  "/api/auth/change-email/confirm",
] as const;
/** The routes as one regex alternation (`magic-link|verify-email|start\/claim|…`), the path separator spelled as given. */
const routeAlternation = (slash: string) => ONE_TIME_TOKEN_ROUTES.map((r) => r.slice(1).split("/").join(slash)).join("|");
/** `/magic-link`, `/start/claim`, …: plain, and with the separators URL-encoded at any depth, either hex case. */
const ONE_TIME_ROUTE = `\\/(?:${routeAlternation("\\/")})`;
const ENCODED_ONE_TIME_ROUTE = `%(?:25)*2[Ff](?:${routeAlternation("%(?:25)*2[Ff]")})`;
/**
 * A one-time route and its query, up to the end of the URL (the next `#`, quote, angle bracket or space): group 1 is
 * `<route>?` (a trailing slash allowed), group 2 the query. A route that only STARTS with one of the names
 * (`/magic-linkage?`) does not match: the `?` must follow it.
 */
const ONE_TIME_ROUTE_QUERY = new RegExp(`(${ONE_TIME_ROUTE}\\/?\\?)([^#\\s"'<>]*)`, "g");
/**
 * The same URL-ENCODED inside another URL, at any encoding depth. Its query ends at the first plain `&` (the carrying
 * URL's own next parameter); the nested URL's own parameters are separated by an encoded `&`, so they stay inside.
 */
const ENCODED_ONE_TIME_ROUTE_QUERY = new RegExp(`(${ENCODED_ONE_TIME_ROUTE}(?:%(?:25)*2[Ff])?%(?:25)*3[Ff])([^&#\\s"'<>]*)`, "g");
/** `token=` as a parameter of a bare query string: first, or after `&`; never inside another name (`mytoken=`). An empty value has nothing to leak and is kept. */
const TOKEN_PARAM = /(^|&)(token=)[^&]+/g;
/** The same parameter in an ENCODED query: first, or after an encoded `&`; the value ends at its encoded delimiter. */
const ENCODED_TOKEN_PARAM = /(^|%(?:25)*26)(token%(?:25)*3[Dd])[^%]+/g;
/** Cheap pre-check: nothing any of the patterns could match. */
const MAYBE_TOKEN = new RegExp(
  [
    "\\/score\\/",
    "%(?:25)*2[Ff]score%",
    "dl_",
    "md_",
    `${OVERLAY_KEY_PARAM}=`,
    `${OVERLAY_KEY_PARAM}%`,
    `${RELAY_PAGE_TOKEN_PARAM}=`,
    `${RELAY_PAGE_TOKEN_PARAM}%`,
    "\\/capture\\/codes\\/",
    "capture%(?:25)*2[Ff]codes%",
    `(?:${JOIN_CODE_NAMES})=`,
    `(?:${JOIN_CODE_NAMES})%`,
    "(?:^|[?&])t=",
    "%(?:25)*(?:3[Ff]|26)t%",
    prefixAlternation("\\/"),
    prefixAlternation("%(?:25)*2[Ff]"),
    ONE_TIME_ROUTE,
    ENCODED_ONE_TIME_ROUTE,
  ].join("|"),
);

/** A bare query string with every `token=` value swapped for the placeholder (no `?`: Sentry's `request.query_string`). */
export function scrubTokenQuery(query: string): string {
  return query.replace(TOKEN_PARAM, "$1$2[token]");
}

/** One string: `/score/<token>` (plain or encoded) becomes `/score/[token]`, a bare `dl_…` / `md_…` secret becomes `dl_[token]` / `md_[token]`,
 *  an overlay `key=` query value (plain or encoded) becomes `[key]`, a relay page token's `st=` value (plain or
 *  encoded) becomes `[st]`, a capture code in `/capture/codes/<code>` (plain or encoded) becomes `[code]`, a
 *  match-room token in a `t=` query value (plain or encoded) becomes `[token]`, a team's join code in a
 *  `join_code=` / `join=` query value (plain or encoded) becomes `[code]`, the secret after a
 *  `SECRET_PATH_ROUTES` route root (`/claim/`, `/join/`, `/checkin/`, …; plain or encoded) becomes `[token]`, and a
 *  one-time sign-in token in the `token=` query value of a one-time route (plain or encoded) becomes `[token]`. */
export function scrubScoreUrl(value: string): string {
  if (!MAYBE_TOKEN.test(value)) return value;
  return value
    // First: a room JWT is random base64url and can contain a `dl_` run, which BARE_TOKEN would half-eat and so break the JWT shape (C43).
    .replace(ROOM_TOKEN_QUERY, "$1[token]")
    .replace(ENCODED_ROOM_TOKEN, "$1[token]")
    .replace(SCORE_PATH, "/score/[token]")
    .replace(ENCODED_SCORE_PATH, "$1[token]")
    .replace(BARE_TOKEN, "$1_[token]")
    .replace(OVERLAY_KEY_QUERY, "$1[key]")
    .replace(ENCODED_OVERLAY_KEY, "$1[key]")
    .replace(RELAY_PAGE_TOKEN_QUERY, "$1[st]")
    .replace(ENCODED_RELAY_PAGE_TOKEN, "$1[st]")
    .replace(JOIN_CODE_QUERY, "$1[code]")
    .replace(ENCODED_JOIN_CODE, "$1[code]")
    .replace(CAPTURE_PATH, "$1[code]")
    .replace(ENCODED_CAPTURE_PATH, "$1[code]")
    .replace(SECRET_PATH, "$1[token]")
    .replace(ENCODED_SECRET_PATH, "$1[token]")
    .replace(ONE_TIME_ROUTE_QUERY, (_m, head: string, query: string) => head + scrubTokenQuery(query))
    .replace(ENCODED_ONE_TIME_ROUTE_QUERY, (_m, head: string, query: string) => head + query.replace(ENCODED_TOKEN_PARAM, "$1$2[token]"));
}

/**
 * Scrub every string inside a JSON-like value: plain objects and arrays, at any
 * depth. Anything else (a Date, a class instance) is returned as it was. The
 * input is never mutated. A branch with nothing to scrub keeps its original
 * reference, so a clean event costs a walk and no copies.
 */
export function scrubScoreTokens<T>(value: T): T {
  return deep(value, new WeakMap()) as T;
}

function deep(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return scrubScoreUrl(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    seen.set(value, value);
    let copy: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = deep(item, seen);
      if (!Object.is(next, item)) (copy ??= value.slice())[i] = next;
    });
    const out = copy ?? value;
    seen.set(value, out);
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  seen.set(value, value);
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = deep(item, seen);
    if (!Object.is(next, item)) (copy ??= { ...value })[key] = next;
  }
  const out = copy ?? value;
  seen.set(value, out);
  return out;
}

/**
 * Staff pages (fix batch 7, owner-approved 2026-09-25): the route is app/admin
 * at the top level, not under [lang], so the match is exact. It is "/admin"
 * itself or anything under "/admin/", never "/administrators" or "/o/admin-club".
 */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * The app's PostHog `before_send`. It runs in `capture()` on every event:
 * pageview, pageleave, autocapture (`$elements` hrefs, `$external_click_url`),
 * custom captures and `$snapshot`.
 *  1. It drops every event from a staff page. posthog-js stamps `$pathname` on
 *     every event it builds, cookie-consent's manual `$pageview` included.
 *     Server-side captureServer is not involved: staff are filtered there
 *     through PostHog's internal-user filter.
 *  2. It scrubs device-link tokens from the properties plus `$set` /
 *     `$set_once`, where the `$initial_*` URLs live.
 * A dropped event (null) stays dropped.
 */
export function posthogBeforeSend(event: CaptureResult | null): CaptureResult | null {
  if (event === null) return null;
  const pathname: unknown = event.properties?.$pathname;
  if (typeof pathname === "string" && isAdminPath(pathname)) return null;
  return scrubScoreTokens(event);
}

/** A phone route's event (capture QR v2 §6.3): its request URL or its transaction names `/api/v1/capture/`. */
const CAPTURE_ROUTE = /\/api\/v1\/capture\//;
/** An event names a route when its request URL or its transaction (`POST /api/funnel/claim`) matches it. */
function eventNames(event: Event, route: RegExp): boolean {
  return [event.request?.url, event.transaction].some((v) => typeof v === "string" && route.test(v));
}
function isCaptureEvent(event: Event): boolean {
  return eventNames(event, CAPTURE_ROUTE);
}

/** A capture route's request loses its body and its Bearer (A18). A copy: the input is never mutated. */
function dropCaptureSecrets<E extends Event>(event: E): E {
  if (!event.request) return event;
  const request = { ...event.request };
  delete request.data;
  if (request.headers) {
    request.headers = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k, k.toLowerCase() === "authorization" ? "Bearer [tok]" : v]),
    );
  }
  return { ...event, request };
}

/** A one-time-token route's event: its request URL or its transaction names the route (`/magic-link`, `GET /verify-email`). */
const ONE_TIME_ROUTE_EVENT = new RegExp(`${ONE_TIME_ROUTE}\\/?(?:[?#]|$)`);
function isOneTimeTokenEvent(event: Event): boolean {
  return eventNames(event, ONE_TIME_ROUTE_EVENT);
}

/**
 * The POST routes that read a CREDENTIAL from the request body, as Next route templates (`[id]` is one path segment):
 * the sign-in consume `{ token, next }`, the email verification `{ token, next }`, the email-change confirmation (its
 * token rides the query; any body goes with it), the funnel claim `{ token }`, the registrant's access-token calls
 * (withdraw, checkout, resend), and the team join POST, whose body carries the join code (`{ join_code, … }`). There is
 * no password route any more (password sign-in was removed 2026-10-19); one added later must be listed here again, and
 * scrub-request-body.test.ts fails until it is. A route whose secret is in its PATH is not listed:
 * `SECRET_PATH_ROUTES` covers it. Exported so a test can compare the list with the route files, which are where it
 * comes from: a route that takes a token or a password in its body and is missing here fails that test.
 */
export const BODY_CREDENTIAL_ROUTES = [
  "/api/auth/magic-link/consume",
  "/api/auth/verify-email",
  "/api/auth/change-email/confirm",
  "/api/funnel/claim",
  "/api/v1/public/registrations/[id]/checkout",
  "/api/v1/public/registrations/[id]/withdraw",
  "/api/v1/public/registrations/by-ref/[ref]/withdraw",
  "/api/v1/public/registrations/groups/[id]/resend",
  "/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join",
] as const;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A route template as a regex source: a `[param]` segment is any one segment (a real id, or the literal `[id]` of a transaction). */
const routePattern = (route: string) => route.split("/").map((seg) => (/^\[.+\]$/.test(seg) ? "[^/?#\\s]+" : escapeRegExp(seg))).join("\\/");
/** A body-credential route's event: the route ends the URL (a query string or fragment may follow), so `/verify-emails` is not it. */
const BODY_ROUTE_EVENT = new RegExp(`(?:${BODY_CREDENTIAL_ROUTES.map(routePattern).join("|")})\\/?(?:[?#]|$)`);
/** The same prefixes as `SECRET_PATH`, not global (a global regex's `lastIndex` makes `test` stateful), for an event's URL or transaction. */
const SECRET_PATH_EVENT = new RegExp(`${ROUTE_ROOT}(?:${prefixAlternation("\\/")})[^/?#&=\\s"'<>]+`);
function holdsCredentialBody(event: Event): boolean {
  return eventNames(event, BODY_ROUTE_EVENT) || eventNames(event, SECRET_PATH_EVENT);
}

/** A credential route's request loses its body. A copy: the input is never mutated. */
function dropRequestBody<E extends Event>(event: E): E {
  if (!event.request || !("data" in event.request)) return event;
  const request = { ...event.request };
  delete request.data;
  return { ...event, request };
}

type QueryString = NonNullable<Event["request"]>["query_string"];
/** Sentry types `query_string` as a string, an object or a list of pairs: the `token` entry of each loses its value. */
function scrubQueryString(query: QueryString): QueryString {
  if (typeof query === "string") return scrubTokenQuery(query);
  if (Array.isArray(query)) {
    return query.map((pair) => (Array.isArray(pair) && pair[0] === "token" && pair[1] ? ([pair[0], "[token]"] as [string, string]) : pair));
  }
  if (query && typeof query === "object") {
    return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, k === "token" && v ? "[token]" : v]));
  }
  return query;
}

/** A one-time route's request loses the token in its bare query string, which has no path to scrub it by. A copy: the input is never mutated. */
function dropOneTimeToken<E extends Event>(event: E): E {
  const query = event.request?.query_string;
  if (!event.request || !query) return event;
  const scrubbed = scrubQueryString(query);
  return scrubbed === query ? event : { ...event, request: { ...event.request, query_string: scrubbed } };
}

/** Span / breadcrumb data keys that hold the bare query string, WITH its `?` (the SDK's helpers write them; see the header). */
const SPAN_QUERY_KEYS = ["http.query", "url.query"] as const;
/**
 * The data keys that name the request a span belongs to, beside its query, as the SDK writes them: `url` (the sanitised url of
 * @sentry/opentelemetry `getRequestSpanData`), `url.full`, `url.path` and `http.route` (server) or `url.template` (client) from
 * @sentry/core `getHttpSpanDetailsFromUrlObject`, and the legacy `http.url` and `http.target` of an outgoing request's span.
 * Exported so a test can pin each key on its own against what the SDK's helpers really write.
 */
export const SPAN_URL_KEYS = ["url", "url.full", "url.path", "url.template", "http.url", "http.target", "http.route"] as const;
/** The data key that holds a serialised request body (@sentry/core `addNormalizedRequestDataToSpan`). */
const SPAN_BODY_KEY = "http.request.body.data";

type Data = Record<string, unknown>;
const isData = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);
/** Does any of a span's own request-naming keys match the route regex? */
const dataNames = (data: Data, route: RegExp): boolean => SPAN_URL_KEYS.some((key) => typeof data[key] === "string" && route.test(data[key]));

/**
 * One span's (or breadcrumb's) data: on a one-time route the bare query loses its `token=`, on a body-credential route the
 * serialised body goes. The route is the EVENT's (a transaction named for it) or the span's own sibling url, so a fetch span
 * from another page to `/magic-link?token=…` is covered. A copy; data with nothing to scrub keeps its reference.
 */
function scrubSpanData(data: Data, eventOneTime: boolean, eventBody: boolean): Data {
  const oneTime = eventOneTime || dataNames(data, ONE_TIME_ROUTE_EVENT);
  const body = eventBody || dataNames(data, BODY_ROUTE_EVENT) || dataNames(data, SECRET_PATH_EVENT);
  let copy: Data | undefined;
  if (oneTime) {
    for (const key of SPAN_QUERY_KEYS) {
      const query = data[key];
      if (typeof query !== "string") continue;
      // `?token=…` (the SDK keeps the `?`) or `token=…` (a Sentry query_string style value).
      const scrubbed = query.startsWith("?") ? `?${scrubTokenQuery(query.slice(1))}` : scrubTokenQuery(query);
      if (scrubbed !== query) (copy ??= { ...data })[key] = scrubbed;
    }
  }
  if (body && Object.hasOwn(data, SPAN_BODY_KEY)) {
    copy ??= { ...data };
    delete copy[SPAN_BODY_KEY];
  }
  return copy ?? data;
}

/** The trace context's data, every span's data and every breadcrumb's data, scrubbed by `scrubSpanData`. A copy; the input is never mutated. */
function scrubSpans<E extends Event>(event: E, oneTime: boolean, body: boolean): E {
  let next: E = event;
  const trace = event.contexts?.trace;
  if (trace && isData(trace.data)) {
    const data = scrubSpanData(trace.data, oneTime, body);
    if (data !== trace.data) next = { ...next, contexts: { ...next.contexts, trace: { ...trace, data } } };
  }
  const mapData = <T extends { data?: unknown }>(items: T[] | undefined): T[] | undefined => {
    let copy: T[] | undefined;
    items?.forEach((item, i) => {
      if (!isData(item.data)) return;
      const data = scrubSpanData(item.data, oneTime, body);
      if (data !== item.data) (copy ??= items.slice())[i] = { ...item, data };
    });
    return copy ?? items;
  };
  const spans = mapData(event.spans);
  if (spans !== event.spans) next = { ...next, spans };
  const breadcrumbs = mapData(event.breadcrumbs);
  if (breadcrumbs !== event.breadcrumbs) next = { ...next, breadcrumbs };
  return next;
}

/** `request.query_string` as an object or a list of pairs holds the join code under its own key; a string was scrubbed with every other string. */
function scrubJoinCodeKeys<E extends Event>(event: E): E {
  const query = event.request?.query_string;
  if (!event.request || !query || typeof query === "string") return event;
  const isJoinCode = (key: unknown) => JOIN_CODE_PARAMS.some((name) => name === key);
  const hit = { n: 0 };
  const mask = (key: unknown, value: unknown) => {
    if (!isJoinCode(key) || !value || value === "[code]") return value;
    hit.n++;
    return "[code]";
  };
  const scrubbed: typeof query = Array.isArray(query)
    ? query.map((pair): [string, string] => [pair[0], mask(pair[0], pair[1]) as string])
    : Object.fromEntries(Object.entries(query).map(([k, v]) => [k, mask(k, v) as string]));
  return hit.n ? { ...event, request: { ...event.request, query_string: scrubbed } } : event;
}

/** OUR Cloudflare zone's origin stamp: lib/client-ip.ts reads `x-seazn-origin-secret`, and this module (bundled for the
 *  browser, so it cannot import that node-only one) redacts every header whose name STARTS with this prefix, any case - so a
 *  rule whose name is mistyped (and so escapes the SDK's `secret` deny list) still never reaches Sentry in clear.
 *  client-ip.test.ts drives one header name through both modules. Its value is the CF_ORIGIN_SECRET; every server event
 *  carries its request's headers, and @sentry/nextjs copies them onto the root span. */
const ORIGIN_STAMP_PREFIX = "x-seazn-origin";
/** The root span attributes the SDK writes such a header into (`httpHeadersToSpanAttributes`: lower-cased, `-` → `_`). */
const ORIGIN_STAMP_ATTRIBUTE_PREFIX = `http.request.header.${ORIGIN_STAMP_PREFIX.replace(/-/g, "_")}`;
const STAMP_REDACTED = "[redacted]";

/** A key as the prefix check reads it: lower-cased, `_` as `-` (so `x_seazn_origin_secret` is the same header). */
const stampKey = (k: string): string => k.toLowerCase().replace(/_/g, "-");

/** `record` with every key that starts (any case, `_` or `-`) with `prefix` redacted - a copy - or `undefined` when none. */
function redactPrefixed<T extends Record<string, unknown>>(record: T, prefix: string): T | undefined {
  const want = stampKey(prefix);
  let copy: T | undefined;
  for (const k of Object.keys(record)) {
    if (stampKey(k).startsWith(want)) (copy ??= { ...record })[k as keyof T] = STAMP_REDACTED as T[keyof T];
  }
  return copy;
}

/**
 * Any event loses the origin stamp's VALUE wherever the SDK puts it: `request.headers`, and its `http.request.header.*`
 * attribute in the trace context's data and in every span's data (the SDK's deny list masks the right name; this does not
 * depend on it). The key stays, as "[redacted]". A copy: the input is never mutated.
 */
function dropOriginStamp<E extends Event>(event: E): E {
  let next: E = event;
  const headers = event.request?.headers ? redactPrefixed(event.request.headers, ORIGIN_STAMP_PREFIX) : undefined;
  if (headers) next = { ...next, request: { ...next.request, headers } };
  const trace = next.contexts?.trace;
  const traceData = trace && isData(trace.data) ? redactPrefixed(trace.data, ORIGIN_STAMP_ATTRIBUTE_PREFIX) : undefined;
  if (trace && traceData) next = { ...next, contexts: { ...next.contexts, trace: { ...trace, data: traceData } } };
  let spans: typeof event.spans;
  next.spans?.forEach((span, i) => {
    const data = isData(span.data) ? redactPrefixed(span.data, ORIGIN_STAMP_ATTRIBUTE_PREFIX) : undefined;
    if (data) (spans ??= next.spans!.slice())[i] = { ...span, data };
  });
  if (spans) next = { ...next, spans };
  return next;
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction`: scrubs the request URL and
 * headers (the Bearer secret), the transaction name, breadcrumbs, tags, stack
 * frames and span data. A capture route's event also loses its Bearer and its
 * request body (A18); a one-time-token route's event also loses the token in
 * its bare `request.query_string`; the event of a route that takes a credential
 * in its body (`BODY_CREDENTIAL_ROUTES`: a token or a join code) or in its path
 * loses `request.data`. Every event loses the origin stamp's value.
 */
export function scrubSentryEvent<E extends Event>(event: E): E {
  const oneTime = isOneTimeTokenEvent(event);
  const body = holdsCredentialBody(event);
  const scrubbed = scrubScoreTokens(event);
  const safe = isCaptureEvent(event) ? dropCaptureSecrets(scrubbed) : scrubbed;
  const queryScrubbed = oneTime ? dropOneTimeToken(safe) : safe;
  const withSpans = scrubSpans(scrubJoinCodeKeys(queryScrubbed), oneTime, body);
  return dropOriginStamp(body ? dropRequestBody(withSpans) : withSpans);
}

/**
 * The same scrub as an event processor. A Replay's `replay_event` carries the
 * page URLs it visited (`urls`). It goes through the client's event processors
 * (`prepareReplayEvent` calls core `prepareEvent`) but never through
 * `beforeSend`, so only a processor can reach it.
 */
export function scrubScoreTokensIntegration(): Integration {
  return { name: "ScrubScoreTokens", processEvent: (event) => scrubSentryEvent(event) };
}

/**
 * Sentry Replay `beforeAddRecordingEvent`. The SDK passes only CUSTOM frames to
 * it: breadcrumbs (navigation from/to, console) and performance spans (fetch
 * and navigation URLs). @sentry/replay 10.62 gates it with `isCustomEvent`.
 * rrweb's own meta frame (`href`) and DOM snapshots never reach this hook, which
 * is why the replay must not run on a page `holdsCredential` (lib/replay-guard.ts).
 */
export function scrubRecordingEvent<T>(event: T): T {
  return scrubScoreTokens(event);
}

/**
 * Does a page URL carry a credential? The scrubber is its own authority: a URL it would change holds one (a device-link,
 * check-in or claim token, an invite, a join code, a one-time `?token=`, a room token, …), so no list is kept here to drift
 * from the rules. Sentry Replay records the page's URL in places no hook reaches (rrweb's Meta frame, the DOM), so it must
 * not run on such a page.
 */
export function holdsCredential(url: string): boolean {
  return scrubScoreUrl(url) !== url;
}
