// Sponsor click tags (R4 sponsors on stream, spec 2026-10-27 §3.7; rulings R6, R7). CLIENT-SAFE: imports only the
// short-code pattern, so the overlay card (a client component), the public boards and the redirect route all read it.
// The server's `recordClick` lives in `server/sponsors/clicks.ts`, never here — a server import from a client file
// breaks the client build.
//
// ONE route, `/s/[key]`, serves two shapes (controller addendum 2026-10-31), told apart by SHAPE alone:
//   • a sponsor uuid — the boards' links, `/s/<sponsorId>?f=<fixtureId>&src=match|site`; an absent or unknown tag reads
//     as `unknown`;
//   • a short code (R7) — what the stream prints, `seazn.club/s/<code>`; the code IS the tag (that sponsor, that
//     fixture, `stream`), so its query string is ignored.
// The four sources are the V483 CHECK on `sponsor_clicks.source` (`lib/__tests__/sponsor-clicks.test.ts` reads it back).
import { SPONSOR_SHORT_CODE_PATTERN } from "@/lib/sponsor-short-code";

export const CLICK_SOURCES = ["match", "stream", "site", "unknown"] as const;
export type ClickSource = (typeof CLICK_SOURCES)[number];

/** The sources a link may CLAIM. `unknown` is what anything else reads as — never a tag a link carries. */
const TAGGED: ReadonlySet<string> = new Set<ClickSource>(["match", "stream", "site"]);
/** `sponsor_clicks.fixture_id` is a uuid foreign key: anything else would fail the insert, so it is dropped here. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The host the overlay prints a short code under (owner ruling R7: `seazn.club/s/<code>`). */
export const SPONSOR_LINK_HOST = "seazn.club";

/** A click's tag, off its query. A repeated parameter reads its first value (`URLSearchParams.get`). */
export function parseClickTag(q: URLSearchParams): { fixtureId: string | null; source: ClickSource } {
  const f = q.get("f");
  const src = q.get("src");
  return {
    fixtureId: f !== null && UUID.test(f) ? f : null,
    source: src !== null && TAGGED.has(src) ? (src as ClickSource) : "unknown",
  };
}

/** What a public board's links claim: the competition page's (`site`) or a match page's, for that match (D15). */
export type BoardClickTag = { source: "site" } | { source: "match"; fixtureId: string };

/** A board's tracked link to a sponsor. Every part encoded, so none can add a parameter or a path segment. */
export function sponsorClickPath(sponsorId: string, tag: BoardClickTag): string {
  const q = new URLSearchParams(tag.source === "match" ? { f: tag.fixtureId, src: "match" } : { src: "site" });
  return `/s/${encodeURIComponent(sponsorId)}?${q.toString()}`;
}

/** Which of the route's two shapes a `/s/[key]` key is, or null for neither (the route answers 404 without a query).
 *  The shapes cannot overlap: a uuid is 36 characters with hyphens, a code at most `SPONSOR_SHORT_CODE_MAX_LENGTH`
 *  alphabet characters. The case rule is the short-code pattern's own (uppercase only). */
export function classifySponsorLink(
  key: string,
): { kind: "sponsor"; sponsorId: string } | { kind: "code"; code: string } | null {
  if (UUID.test(key)) return { kind: "sponsor", sponsorId: key };
  if (SPONSOR_SHORT_CODE_PATTERN.test(key)) return { kind: "code", code: key };
  return null;
}

/** What the card prints for a short code (R7), or null — no code, or one outside the pattern, prints nothing
 *  link-like: a viewer typing a code the redirect cannot resolve gets a dead page. */
export function sponsorShortLinkText(code: string | null | undefined): string | null {
  if (typeof code !== "string" || !SPONSOR_SHORT_CODE_PATTERN.test(code)) return null;
  return `${SPONSOR_LINK_HOST}/s/${code}`;
}
