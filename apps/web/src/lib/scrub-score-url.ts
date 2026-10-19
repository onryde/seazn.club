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
// a single-use token: also `/reset-password`, the funnel's `/start/claim`, a staff `/admin/impersonate` hand-off and
// `/api/auth/change-email/confirm`. Sentry's `request.query_string` has no path to scope by, so it is scrubbed when the
// event's URL or transaction names one of those routes, the way a capture route's request is recognised (`isCaptureEvent`).
//
// The profile-claim link `/claim/<secret>` (routes.claim, `pc_` + 43 base64url, 14 days; person-claims.ts) carries its
// secret in the PATH, and so does the accept call the claim page's button makes, `/api/claims/<secret>/accept`. Each
// secret becomes `[token]`, plain or URL-encoded at any depth, by the `/capture/codes/` rules.
import type * as Sentry from "@sentry/nextjs";
import type { CaptureResult } from "posthog-js";
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
 * makes `dl_` + 43 base64url chars. No `\b` in front: a secret glued to a word
 * character (`x_dl_…`, `%2Fdl_…`) has no word boundary before its `d`. The
 * 32-character floor is what keeps ordinary words (`model_dl_config`,
 * `handl_…`) from being eaten.
 */
const BARE_TOKEN = /dl_[A-Za-z0-9_-]{32,}/g;
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
/** A profile-claim secret in the claim page's path, `/claim/<secret>`: everything up to the next `/`, `?`, `#`, quote, angle bracket or space. */
const CLAIM_PATH = /(\/claim\/)[^/?#\s"'<>]+/g;
/** The same path URL-ENCODED inside another URL (a sign-in `next=/claim/<secret>`), at any encoding depth, either hex case. */
const ENCODED_CLAIM_PATH = /(%(?:25)*2[Ff]claim%(?:25)*2[Ff])[^%&/?#\s"'<>]+/g;
/** The same secret in the claim API's path, `/api/claims/<secret>` and `/api/claims/<secret>/accept`. `/claims/` is its own segment: `/claim/` does not match it. */
const CLAIM_API_PATH = /(\/api\/claims\/)[^/?#\s"'<>]+/g;
/** The same path URL-ENCODED inside another URL, at any encoding depth, either hex case. */
const ENCODED_CLAIM_API_PATH = /(%(?:25)*2[Ff]api%(?:25)*2[Ff]claims%(?:25)*2[Ff])[^%&/?#\s"'<>]+/g;

/**
 * The routes whose emailed link carries a SINGLE-USE token in its `token` query parameter to a page that spends it: the
 * sign-in link, the email-verification link, the password reset, the funnel claim (it signs the visitor in), a staff
 * impersonation hand-off and an email-change confirmation. A `token=` is scrubbed only when it is a parameter of one of
 * these. Not here, on purpose: the registration status page's `?token=` is a reusable access token for a cart.
 */
const ONE_TIME_TOKEN_ROUTES = [
  "/magic-link",
  "/verify-email",
  "/reset-password",
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
    `${OVERLAY_KEY_PARAM}=`,
    `${OVERLAY_KEY_PARAM}%`,
    `${RELAY_PAGE_TOKEN_PARAM}=`,
    `${RELAY_PAGE_TOKEN_PARAM}%`,
    "\\/capture\\/codes\\/",
    "capture%(?:25)*2[Ff]codes%",
    "(?:^|[?&])t=",
    "%(?:25)*(?:3[Ff]|26)t%",
    "\\/claim\\/",
    "%(?:25)*2[Ff]claim%",
    "\\/api\\/claims\\/",
    "%(?:25)*2[Ff]api%(?:25)*2[Ff]claims%",
    ONE_TIME_ROUTE,
    ENCODED_ONE_TIME_ROUTE,
  ].join("|"),
);

/** A bare query string with every `token=` value swapped for the placeholder (no `?`: Sentry's `request.query_string`). */
export function scrubTokenQuery(query: string): string {
  return query.replace(TOKEN_PARAM, "$1$2[token]");
}

/** One string: `/score/<token>` (plain or encoded) becomes `/score/[token]`, a bare `dl_…` secret becomes `dl_[token]`,
 *  an overlay `key=` query value (plain or encoded) becomes `[key]`, a relay page token's `st=` value (plain or
 *  encoded) becomes `[st]`, a capture code in `/capture/codes/<code>` (plain or encoded) becomes `[code]`, a
 *  match-room token in a `t=` query value (plain or encoded) becomes `[token]`, a profile-claim secret in
 *  `/claim/<secret>` or `/api/claims/<secret>` (plain or encoded) becomes `[token]`, and a one-time sign-in token in
 *  the `token=` query value of a one-time route (plain or encoded) becomes `[token]`. */
export function scrubScoreUrl(value: string): string {
  if (!MAYBE_TOKEN.test(value)) return value;
  return value
    .replace(SCORE_PATH, "/score/[token]")
    .replace(ENCODED_SCORE_PATH, "$1[token]")
    .replace(BARE_TOKEN, "dl_[token]")
    .replace(OVERLAY_KEY_QUERY, "$1[key]")
    .replace(ENCODED_OVERLAY_KEY, "$1[key]")
    .replace(RELAY_PAGE_TOKEN_QUERY, "$1[st]")
    .replace(ENCODED_RELAY_PAGE_TOKEN, "$1[st]")
    .replace(CAPTURE_PATH, "$1[code]")
    .replace(ENCODED_CAPTURE_PATH, "$1[code]")
    .replace(ROOM_TOKEN_QUERY, "$1[token]")
    .replace(ENCODED_ROOM_TOKEN, "$1[token]")
    .replace(CLAIM_PATH, "$1[token]")
    .replace(ENCODED_CLAIM_PATH, "$1[token]")
    .replace(CLAIM_API_PATH, "$1[token]")
    .replace(ENCODED_CLAIM_API_PATH, "$1[token]")
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
function isCaptureEvent(event: Event): boolean {
  return [event.request?.url, event.transaction].some((v) => typeof v === "string" && CAPTURE_ROUTE.test(v));
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
  return [event.request?.url, event.transaction].some((v) => typeof v === "string" && ONE_TIME_ROUTE_EVENT.test(v));
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

/**
 * Sentry `beforeSend` / `beforeSendTransaction`: scrubs the request URL and
 * headers (the Bearer secret), the transaction name, breadcrumbs, tags, stack
 * frames and span data. A capture route's event also loses its Bearer and its
 * request body (A18); a one-time-token route's event also loses the token in
 * its bare `request.query_string`.
 */
export function scrubSentryEvent<E extends Event>(event: E): E {
  const scrubbed = scrubScoreTokens(event);
  const safe = isCaptureEvent(event) ? dropCaptureSecrets(scrubbed) : scrubbed;
  return isOneTimeTokenEvent(event) ? dropOneTimeToken(safe) : safe;
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
 * rrweb's own meta frame (`href`) and DOM snapshots never reach this hook.
 */
export function scrubRecordingEvent<T>(event: T): T {
  return scrubScoreTokens(event);
}
