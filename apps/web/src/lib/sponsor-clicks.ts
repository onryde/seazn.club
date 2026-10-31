// Sponsor click tags (R4 sponsors on stream, spec 2026-10-27 §3.7; ruling R6). CLIENT-SAFE: imports only the short-code
// pattern, so the overlay card (a client component) and the redirect route can both read it. S10 adds the server's
// `recordClick` in `server/`, never here — a server import from a client file breaks the client build.
//
// `/s/[sponsorId]?f=<fixtureId>&src=match|stream|site` tags a click; anything else is `unknown`. The four sources are
// the V483 CHECK on `sponsor_clicks.source` (`lib/__tests__/sponsor-clicks.test.ts` reads it back).
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

/** The tracked path for a sponsor seen on a fixture's stream (§3.7). Both parts encoded, so neither can add a
 *  parameter. */
export function streamClickPath(sponsorId: string, fixtureId: string): string {
  return `/s/${encodeURIComponent(sponsorId)}?f=${encodeURIComponent(fixtureId)}&src=stream`;
}

/** What the card prints for a short code (R7), or null — no code, or one outside the pattern, prints nothing
 *  link-like: a viewer typing a code the redirect cannot resolve gets a dead page. */
export function sponsorShortLinkText(code: string | null | undefined): string | null {
  if (typeof code !== "string" || !SPONSOR_SHORT_CODE_PATTERN.test(code)) return null;
  return `${SPONSOR_LINK_HOST}/s/${code}`;
}
