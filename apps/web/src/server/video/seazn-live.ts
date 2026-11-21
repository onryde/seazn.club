import "server-only";
// server/video/seazn-live.ts — which matches are ON AIR to Seazn right now (Seazn-hosted video, Phase 1 Task 17). Two readers over one fact:
//
//   liveSeaznFixtureIds(orgId, ids)        the matches whose LATEST session (by creation) is a Seazn session in state `live`. This is the
//                                           very fact `seaznFixtureVideoForOrg` reads for its `live` (seazn-video.ts), so a board that says
//                                           "live on Seazn" always has a live to play. Match Day's board asks it for `live_seazn`.
//   seaznWatchUrls(orgId, ids, origin)     the same matches, each with the public match page's address on `origin` — the phone's
//                                           "Watch live" link (capture-matchday-day.v1 `live_seazn.watch_url`). Only a match whose page is
//                                           readable has one (public_fixtures_v, its division past setup: the redaction `seaznFixtureVideo`
//                                           applies), and only on an https origin: a local dev server gives no link rather than a value
//                                           the phone's strict contract refuses.
//
// Neither reads a flag (controller ruling 2026-11-20: SEAZN_HOSTED_LIVE gates new streams, never playback of one that exists), signs
// nothing, and carries no playback address or token: a boolean and a page address are all a polled board or a phone is given. The
// privileged `sql` client: fixture_stream_sessions is FORCE RLS with no policy (V410), the stream pattern (youtube/parts.ts). Org-scoped
// in the statement, so a stranger's ask for this organisation's match answers nothing.
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { siteOrigin } from "@/lib/site-origin";

/** The matches among `fixtureIds` that are on air to Seazn now. */
export async function liveSeaznFixtureIds(orgId: string, fixtureIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (fixtureIds.length === 0) return new Set();
  const rows = await sql<{ fixture_id: string }[]>`
    select s.fixture_id
      from (select distinct on (fixture_id) fixture_id, state, destination_kind
              from fixture_stream_sessions
             where org_id = ${orgId} and fixture_id in ${sql([...fixtureIds])}
             order by fixture_id, created_at desc, id desc) s
     where s.destination_kind = 'seazn' and s.state = 'live'`;
  return new Set(rows.map((r) => r.fixture_id));
}

/** Only https carries the phone's link: the contract's pattern (`CAPTURE_MATCHDAY_WATCH_URL_RE`) is an absolute https address. */
const isHttpsOrigin = (origin: string): boolean => {
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
};

/** The on-air matches among `fixtureIds` whose public page is readable, each with that page's address on `origin` (default: this
 *  deployment's own host). Empty for an origin that is not https. */
export async function seaznWatchUrls(
  orgId: string,
  fixtureIds: readonly string[],
  origin: string = siteOrigin(),
): Promise<ReadonlyMap<string, string>> {
  if (!isHttpsOrigin(origin)) return new Map();
  const onAir = [...(await liveSeaznFixtureIds(orgId, fixtureIds))];
  if (onAir.length === 0) return new Map();
  // The public read's own visibility rule (seaznFixtureVideo): in public_fixtures_v AND its division past setup.
  const rows = await sql<{ id: string; org_slug: string; comp_slug: string; div_slug: string }[]>`
    select v.id, o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
      from public_fixtures_v v
      join divisions d on d.id = v.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
     where v.id in ${sql(onAir)} and c.org_id = ${orgId} and d.status <> 'setup'`;
  const base = origin.replace(/\/$/, "");
  return new Map(rows.map((r) => [r.id, `${base}${routes.publicFixture(r.org_slug, r.comp_slug, r.div_slug, r.id)}`]));
}
