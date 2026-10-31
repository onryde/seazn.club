import "server-only";
// server/sponsors/clicks.ts — R4 sponsors on stream, S10: click attribution (spec 2026-10-27 §3.7; owner rulings D15
// and R7; controller addenda 2026-10-31). The conversion half of the sponsor report: S13/S14 read the rows this writes.
//
// `/s/[key]` (app/s/[key]/route.ts) serves TWO shapes, told apart by shape alone (`classifySponsorLink`), so a key is
// never tried against both tables:
//   • a sponsor uuid — the public boards' links, tagged `?f=<fixtureId>&src=match|site` (parseClickTag);
//   • a short code (R7) — what the stream prints. S5 minted it server-side for one (sponsor, fixture), so the code IS
//     the tag: that sponsor, that fixture, `stream`. A query string on a code is ignored.
//
// THE REDIRECT TARGET is only ever the sponsor row's stored url, and only when it is http(s) — never anything from the
// request (no open redirect), and never `javascript:` / `data:` (a stored url is organiser input: zod's `.url()`
// accepts both). The sponsor must be active, as `resolveSponsors` reads it ('active'); anything else is a 404.
//
// THE WRITE is tail work (the route defers it, so the redirect never waits on it): `click_count + 1` and the
// `sponsor_clicks` row in ONE statement — one round trip, and never a count without its row or a row without its count.
// `f` is kept only when it is a fixture of the SPONSOR's org; otherwise the click is recorded with fixture null and
// source `unknown` — a link that names another org's match does not get to claim it. The database does not enforce
// this (no composite foreign keys, S3), so this statement does.
//
// PRIVILEGED path, like every public read: the visitor has no tenant, and app_user may only READ sponsor_clicks.
//
// Clicks are unauthenticated and not rate limited (the route had no limiter, and the addendum adds none): one visitor
// can inflate a count by reloading. S13 shows the numbers as clicks, not unique visitors.
import { sql } from "@/lib/db";
import { classifySponsorLink, parseClickTag, type ClickSource } from "@/lib/sponsor-clicks";

/** What a click claims: the fixture it names (or none) and where the link sat. */
export interface ClickTag {
  fixtureId: string | null;
  source: ClickSource;
}

/** Where `/s/[key]` sends the visitor, and what its click records. */
export interface SponsorLink {
  sponsorId: string;
  url: string;
  tag: ClickTag;
}

const REDIRECTABLE: ReadonlySet<string> = new Set(["http:", "https:"]);

/** The stored url as a redirect target: an absolute http(s) url, normalised by the URL parser, or null. Relative and
 *  protocol-relative urls are refused too — the target must name its own host. */
export function redirectTarget(stored: string | null): string | null {
  if (stored === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(stored);
  } catch {
    return null;
  }
  return REDIRECTABLE.has(parsed.protocol) ? parsed.href : null;
}

/**
 * The redirect for `/s/[key]`, or null (the route's 404). One read for either shape, none for a key of neither:
 *   • uuid → the active sponsor with that id; the tag is the link's own query (parseClickTag);
 *   • code → the code's sponsor, which must be active AND the code's own org's (the mint checks that; a row written
 *     any other way is refused here); the tag is the code's fixture, `stream`.
 */
export async function resolveSponsorLink(key: string, query: URLSearchParams): Promise<SponsorLink | null> {
  const shape = classifySponsorLink(key);
  if (shape === null) return null;
  if (shape.kind === "sponsor") {
    const [row] = await sql<{ url: string | null }[]>`
      select url from sponsors where id = ${shape.sponsorId} and status = 'active'`;
    const url = redirectTarget(row?.url ?? null);
    return url === null ? null : { sponsorId: shape.sponsorId, url, tag: parseClickTag(query) };
  }
  const [row] = await sql<{ sponsor_id: string; fixture_id: string | null; url: string | null }[]>`
    select c.sponsor_id, c.fixture_id, sp.url
      from sponsor_short_codes c
      join sponsors sp on sp.id = c.sponsor_id and sp.org_id = c.org_id and sp.status = 'active'
     where c.code = ${shape.code}`;
  if (row === undefined) return null;
  const url = redirectTarget(row.url);
  return url === null ? null : { sponsorId: row.sponsor_id, url, tag: { fixtureId: row.fixture_id, source: "stream" } };
}

/**
 * One click: `click_count + 1` and its `sponsor_clicks` row, in one statement. Writes nothing for a sponsor that is no
 * longer active (deactivated between the redirect and this tail write). A fixture outside the sponsor's org — another
 * org's, or no fixture at all — is recorded as fixture null, source `unknown`. No fixture named keeps the source.
 */
export async function recordClick(sponsorId: string, tag: ClickTag): Promise<void> {
  await sql`
    with bumped as (
      update sponsors set click_count = click_count + 1
       where id = ${sponsorId} and status = 'active'
      returning id, org_id
    )
    insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source)
    select b.org_id, b.id, f.id,
           case when ${tag.fixtureId}::uuid is not null and f.id is null then 'unknown' else ${tag.source}::text end
      from bumped b
      left join fixtures f on f.id = ${tag.fixtureId}::uuid and f.org_id = b.org_id`;
}
