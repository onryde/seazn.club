// Sponsor click tags (R4 sponsors on stream, spec 2026-10-27 §3.7; rulings R6, R7). CLIENT-SAFE: imports only the
// short-code pattern, so the overlay card (a client component), the public boards and the redirect route all read it.
// The server's `recordClick` lives in `server/sponsors/clicks.ts`, never here — a server import from a client file
// breaks the client build.
//
// ONE route, `/s/[key]`, serves two shapes (controller addendum 2026-10-31), told apart by SHAPE alone:
//   • a sponsor uuid — the boards' links, `/s/<sponsorId>?f=<fixtureId>&src=match|site`; an absent or unknown tag reads
//     as `unknown`, and so does `src=stream` (owner ruling R7 "a", 2026-10-31: no link prints it, so a link claiming it
//     is hand-made);
//   • a short code (R7) — what the stream prints, `seazn.club/s/<code>`; the code IS the tag (that sponsor, that
//     fixture, `stream`), so its query string is ignored. A viewer may type it in lowercase (a phone keyboard does):
//     ASCII letters fold to uppercase, which is injective because the alphabet has no 0/O, 1/I/L pairs.
// The four sources are the V483 CHECK on `sponsor_clicks.source` (`lib/__tests__/sponsor-clicks.test.ts` reads it back).
// Relative, with its extension: api-v1/schemas.ts imports this file under bare `node --experimental-strip-types`
// (openapi-gen), which resolves no `@/` alias.
import {
  SPONSOR_SHORT_CODE_MAX_LENGTH,
  SPONSOR_SHORT_CODE_MIN_LENGTH,
  SPONSOR_SHORT_CODE_PATTERN,
} from "./sponsor-short-code.ts";

export const CLICK_SOURCES = ["match", "stream", "site", "unknown"] as const;
export type ClickSource = (typeof CLICK_SOURCES)[number];

/** The sources a LINK may claim: a board's `match` or `site`. `stream` is a short code's alone (R7 "a"), and `unknown` is
 *  what anything else reads as — never a tag a link carries. */
const LINK_SOURCES: ReadonlySet<string> = new Set<ClickSource>(["match", "site"]);
/** `sponsor_clicks.fixture_id` is a uuid foreign key: anything else would fail the insert, so it is dropped here. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The host a short code prints under when the deployment names no public base url (owner ruling R7: `seazn.club/s/<code>`). */
export const SPONSOR_LINK_FALLBACK_HOST = "seazn.club";

/** The host the overlay prints a short code under: the app's own public base url's (final review D1), so a code printed on
 *  stg leads to stg. `NEXT_PUBLIC_BASE_URL` is BAKED into the client bundle at build (fly.toml / fly.stg.toml build args),
 *  so it is read by its literal name; unset, empty or unparseable falls back to seazn.club. */
export function sponsorLinkHost(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL;
  if (!base) return SPONSOR_LINK_FALLBACK_HOST;
  try {
    return new URL(base).host || SPONSOR_LINK_FALLBACK_HOST;
  } catch {
    return SPONSOR_LINK_FALLBACK_HOST;
  }
}

/** A click's tag, off its query. A repeated parameter reads its first value (`URLSearchParams.get`). */
export function parseClickTag(q: URLSearchParams): { fixtureId: string | null; source: ClickSource } {
  const f = q.get("f");
  const src = q.get("src");
  return {
    fixtureId: f !== null && UUID.test(f) ? f : null,
    source: src !== null && LINK_SOURCES.has(src) ? (src as ClickSource) : "unknown",
  };
}

/** What a public board's links claim: the competition page's (`site`) or a match page's, for that match (D15). */
export type BoardClickTag = { source: "site" } | { source: "match"; fixtureId: string };

/** A board's tracked link to a sponsor. Every part encoded, so none can add a parameter or a path segment. */
export function sponsorClickPath(sponsorId: string, tag: BoardClickTag): string {
  const q = new URLSearchParams(tag.source === "match" ? { f: tag.fixtureId, src: "match" } : { src: "site" });
  return `/s/${encodeURIComponent(sponsorId)}?${q.toString()}`;
}

/** A key that MAY be a typed code: ASCII letters and digits only, at a code's lengths. Spelled without the `i` and `u`
 *  flags on purpose — under a Unicode case fold "ſ" (U+017F) matches `s` and the Kelvin sign matches `k`. */
const CODE_CANDIDATE = new RegExp(`^[0-9A-Za-z]{${SPONSOR_SHORT_CODE_MIN_LENGTH},${SPONSOR_SHORT_CODE_MAX_LENGTH}}$`);

/** ASCII a–z to A–Z and nothing else. Only ever called on a CODE_CANDIDATE: `toUpperCase()` on arbitrary input turns
 *  "ﬀ" into "FF". */
const foldAsciiUpper = (key: string): string => key.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));

/** Which of the route's two shapes a `/s/[key]` key is, or null for neither (the route answers 404 without a query).
 *  The shapes cannot overlap: a uuid is 36 characters with hyphens, a code at most `SPONSOR_SHORT_CODE_MAX_LENGTH`
 *  alphabet characters. A code is matched case-insensitively (fix round 1, I2) and returned in its stored, uppercase
 *  form; a misread character stays out in either case (`o` folds to `O`, which the alphabet excludes). */
export function classifySponsorLink(
  key: string,
): { kind: "sponsor"; sponsorId: string } | { kind: "code"; code: string } | null {
  if (UUID.test(key)) return { kind: "sponsor", sponsorId: key };
  if (!CODE_CANDIDATE.test(key)) return null;
  const code = foldAsciiUpper(key);
  return SPONSOR_SHORT_CODE_PATTERN.test(code) ? { kind: "code", code } : null;
}

const REDIRECTABLE: ReadonlySet<string> = new Set(["http:", "https:"]);

/** A sponsor url as something a visitor may be SENT to — the redirect's target, a board's direct link: an absolute
 *  http(s) url, normalised by the URL parser, or null. Refused: every other scheme (`javascript:`, `data:` — zod's
 *  `.url()` accepts both), and relative or protocol-relative urls (the target must name its own host). The write
 *  schemas refuse the same set (fix round 1, m1), so a stored url should never need refusing here — this is the guard
 *  for rows written before them. */
/** The write schemas' refusal for a url `redirectTarget` would refuse (m1): API copy, English like its neighbours. */
export const SPONSOR_URL_HTTP_ONLY = "url must be an http:// or https:// address";

/** For a write schema's `.refine`: a url a visitor may be sent to. */
export const isRedirectableUrl = (url: string): boolean => redirectTarget(url) !== null;

export function redirectTarget(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(stored);
  } catch {
    return null;
  }
  return REDIRECTABLE.has(parsed.protocol) ? parsed.href : null;
}

/** What the card prints for a short code (R7), or null — no code, or one outside the pattern, prints nothing
 *  link-like: a viewer typing a code the redirect cannot resolve gets a dead page. */
export function sponsorShortLinkText(code: string | null | undefined): string | null {
  if (typeof code !== "string" || !SPONSOR_SHORT_CODE_PATTERN.test(code)) return null;
  return `${sponsorLinkHost()}/s/${code}`;
}
