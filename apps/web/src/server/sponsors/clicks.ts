import "server-only";
// server/sponsors/clicks.ts — R4 sponsors on stream, S10: click attribution (spec 2026-10-27 §3.7; owner rulings D15
// and R7; controller addenda 2026-10-31). The conversion half of the sponsor report: S13/S14 read the rows this writes.
//
// `/s/[key]` (app/s/[key]/route.ts) serves TWO shapes, told apart by shape alone (`classifySponsorLink`), so a key is
// never tried against both tables:
//   • a sponsor uuid — the public boards' links, tagged `?f=<fixtureId>&src=match|site` (parseClickTag); a `stream`
//     claim reads `unknown` (owner ruling R7 "a": stream clicks come only through a code);
//   • a short code (R7) — what the stream prints. S5 minted it server-side for one (sponsor, fixture), so the code IS
//     the tag: that sponsor, that fixture, `stream`. A query string on a code is ignored; a lowercase code folds.
//
// THE REDIRECT TARGET is only ever the sponsor row's stored url, and only when it is http(s) — never anything from the
// request (no open redirect), and never `javascript:` / `data:` (a stored url is organiser input: zod's `.url()`
// accepts both). The sponsor must be active, as `resolveSponsors` reads it ('active'); anything else is a 404.
//
// THE WRITE is tail work (the route defers it, so the redirect never waits on it): `click_count + 1` and the
// `sponsor_clicks` row in ONE statement — one round trip, and never a count without its row or a row without its count.
// `f` is kept only when it is a fixture of the SPONSOR's org — and, for a competition-scoped sponsor, of THAT
// competition (fix round 1, m3); otherwise the click is recorded with fixture null and source `unknown` — a link that
// names a match the sponsor was never shown on does not get to claim it. The database does not enforce this (no
// composite foreign keys, S3), so this statement does.
//
// PRIVILEGED path, like every public read: the visitor has no tenant, and app_user may only READ sponsor_clicks.
//
// WHICH requests count (fix round 1, I3) — the WRITE is filtered, never the redirect: a HEAD (Next answers HEAD from
// GET) and a link unfurler / crawler (`CLICK_BOT_UA`) are redirected but never counted, and one visitor's repeat taps
// on one link within `CLICK_DEDUPE_WINDOW_SECONDS` count once (`recordClickOnce`, over the Redis window the rate
// limiter uses; inert without Redis, so every click counts there). The visitor's IP is only ever kept as a sha256
// digest inside a self-expiring Redis key. Clicks stay unauthenticated, so S13 shows them as clicks, not visitors.
import { createHash } from "node:crypto";
import { incrWindow } from "@/lib/cache";
import { sql } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { classifySponsorLink, parseClickTag, redirectTarget, type ClickSource } from "@/lib/sponsor-clicks";
import { log } from "@/server/logger";

/** What a click claims: the fixture it names (or none) and where the link sat. */
export interface ClickTag {
  fixtureId: string | null;
  source: ClickSource;
}

/** Where `/s/[key]` sends the visitor, and what its click records. `key` is the link in its canonical form (the
 *  stored uppercase code, or the lowercase uuid) — what a repeat tap is recognised by. */
export interface SponsorLink {
  sponsorId: string;
  key: string;
  url: string;
  tag: ClickTag;
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
    return url === null ? null : { sponsorId: shape.sponsorId, key: shape.sponsorId.toLowerCase(), url, tag: parseClickTag(query) };
  }
  const [row] = await sql<{ sponsor_id: string; fixture_id: string | null; url: string | null }[]>`
    select c.sponsor_id, c.fixture_id, sp.url
      from sponsor_short_codes c
      join sponsors sp on sp.id = c.sponsor_id and sp.org_id = c.org_id and sp.status = 'active'
     where c.code = ${shape.code}`;
  if (row === undefined) return null;
  const url = redirectTarget(row.url);
  return url === null ? null : { sponsorId: row.sponsor_id, key: shape.code, url, tag: { fixtureId: row.fixture_id, source: "stream" } };
}

/**
 * One click: `click_count + 1` and its `sponsor_clicks` row, in one statement. Writes nothing for a sponsor that is no
 * longer active (deactivated between the redirect and this tail write). A fixture the sponsor could not have been shown
 * on — another org's, another competition's when the sponsor is scoped to one, or no fixture at all — is recorded as
 * fixture null, source `unknown`. No fixture named keeps the source. A code's fixture goes through the same check: S5
 * mints only for fixtures the sponsor was resolved for, so a code it minted always passes it.
 */
export async function recordClick(sponsorId: string, tag: ClickTag): Promise<void> {
  await sql`
    with bumped as (
      update sponsors set click_count = click_count + 1
       where id = ${sponsorId} and status = 'active'
      returning id, org_id, competition_id
    )
    insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source)
    select b.org_id, b.id, f.id,
           case when ${tag.fixtureId}::uuid is not null and f.id is null then 'unknown' else ${tag.source}::text end
      from bumped b
      left join lateral (
        select fx.id
          from fixtures fx
          join divisions d on d.id = fx.division_id
         where fx.id = ${tag.fixtureId}::uuid and fx.org_id = b.org_id
           and (b.competition_id is null or d.competition_id = b.competition_id)
      ) f on true`;
}

/** User agents whose GET is a machine's, not a person's tap: crawlers, and the link unfurlers of the apps a `/s/` link
 *  is pasted into. They are redirected like anyone, but never counted. ONE constant: extend it here. */
export const CLICK_BOT_UA =
  /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|discord|telegram|embedly|skype/i;

/** One visitor's repeat taps on one link inside this window count once. */
export const CLICK_DEDUPE_WINDOW_SECONDS = 30;

/** Whether a request to `/s/[key]` is a click at all: a GET (Next answers HEAD from GET, and a HEAD is a probe) from a
 *  user agent that is not a bot or an unfurler. The redirect never depends on this. */
export function countsAsClick(req: Request): boolean {
  return req.method === "GET" && !CLICK_BOT_UA.test(req.headers.get("user-agent") ?? "");
}

/** The visitor's IP as it may be kept: a sha256 digest, never the address. */
export function clientIpDigest(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/**
 * The tail work behind one counted redirect: the repeat check, then `recordClick`. A repeat — the same link from the
 * same IP inside `CLICK_DEDUPE_WINDOW_SECONDS` — is dropped; without Redis (`incrWindow` answers null) nothing is a
 * repeat. A failed write is logged at ERROR and sent to Sentry here, never thrown: the visitor is already on the
 * sponsor's site, and `deferred()` would only have logged it as a warning.
 */
export async function recordClickOnce(link: SponsorLink, ip: string): Promise<void> {
  try {
    const seen = await incrWindow(`sclick:${link.key}:${clientIpDigest(ip)}`, CLICK_DEDUPE_WINDOW_SECONDS);
    if (seen !== null && seen.count > 1) return;
    await recordClick(link.sponsorId, link.tag);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), sponsorId: link.sponsorId, source: link.tag.source },
      "sponsor click: the write failed",
    );
    captureError(err, { route: "/s/[key]", extra: { sponsorId: link.sponsorId, source: link.tag.source } });
  }
}
