import "server-only";
// Public read model (doc 08 §3 public block, §6 caching). No auth: every query
// goes through the consent-filtered public_*_v views ONLY (superuser
// connection — the views strip person data per consent). Redis cache-aside in
// front; scoring writes invalidate the same keys they make stale.
//
// WHAT THE VIEWS ACTUALLY ADMIT, because this comment used to say otherwise and
// a whole entitlement was built on the wrong sentence. It read "the views
// themselves restrict to visibility='public'". They do not:
// `public_competitions_v` is `where visibility = any(array['public',
// 'unlisted'])` — confirmed with `pg_get_viewdef`, not inferred. So an UNLISTED
// competition is served the same field set as a public one by both
// `getPublicCompetition` and the /api/v1 reader; the only thing `unlisted`
// withholds is a place in `getPublicOrg`'s landing LIST. A private one is 404
// in both.
//
// The cost of the wrong sentence: `dashboard.public.max` was written to count
// `visibility = 'public'`, so any org could hold unlimited public dashboards by
// choosing "unlisted" — the cap was a one-word bypass away from meaningless.
// `PUBLICLY_READABLE_VISIBILITIES` (usecases/entitlement-freeze.ts) is now the
// single authority for "readable by anyone with the link", and it is what the
// quota, the create path, the PATCH guard and both usage meters read.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { cacheGet, cacheSet } from "@/lib/cache";
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import {
  listOrgHomeCompetitions,
  maskPublicEntrantNames,
  publicPlayerGate,
  withCourtVenueName,
  withCourtVenueNames,
  type PublicEntrantMember,
  type PublicFixture,
} from "@/server/public-site/data";
import { PublicOrgLive, type PublicOrgLiveT } from "@/server/api-v1/schemas";
import { loadMatchCentre, type MatchCentreLoadCtx } from "@/server/public-site/match-centre-load";
import { variantLabel } from "@/server/public-site/variant-label";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { readPlayerMatchLines } from "@/server/public-site/public-player-matches";
import { playerMatchesGenKey, playerMatchesKey } from "@/server/public-site/player-matches-cache-keys";
import {
  PublicPlayerMatches,
  type PublicPlayerMatchesT,
} from "@/server/public-site/player-matches-schema";
import { hasFeature } from "@/lib/entitlements";
import { reconcilePlayerStatsOnRead } from "@/server/usecases/player-stats-refresh";
// The first TYPED public usecase in this file — review note N5. Every other
// reader here returns `unknown` because it hands back a raw row set with no
// schema; the hub has one, so Task 5's route need not re-narrow it.
import {
  CompetitionHubDoc,
  type CompetitionHubDocT,
} from "@/server/public-site/competition-hub-schema";

// s-maxage=30 at the edge (doc 08 §6); Redis mirrors that window.
export const PUBLIC_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=300";
const TTL_SECONDS = 30;

/** Per-IP limit for unauthenticated reads (doc 08 §6: 60/min). */
export async function publicRateLimit(req: Request): Promise<void> {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  await rateLimit(`pubv1:${ip}`, { max: 60, windowSeconds: 60 });
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  return cachedFor(key, TTL_SECONDS, load);
}

/**
 * `cached` with an explicit TTL — the same cache-aside, for a document whose
 * staleness window is not this file's 30-second default.
 *
 * `cached` above now delegates here rather than keeping its own copy of the
 * three lines: two cache-aside implementations in one file is two places for
 * a `cacheSet` to be forgotten, and the whole point of the layer is that a
 * write invalidates exactly what a read populated.
 */
async function cachedFor<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  /** Optional shape check for what came BACK from Redis. `cacheGet<T>` is a
   *  cast, not a parse: the entry was written by whatever code was deployed
   *  when it landed, so a schema change mid-rollout, or an older build still
   *  serving, leaves a document of the previous shape under a key this build
   *  reads as current. A caller that can validate should, and a failure is
   *  treated as a MISS rather than an error — a poisoned entry must not be
   *  able to take the page down for the rest of its TTL. */
  isValid?: (hit: unknown) => boolean,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null && (!isValid || isValid(hit))) return hit;
  const fresh = await load();
  await cacheSet(key, fresh, ttlSeconds);
  return fresh;
}

interface PublicCompetition {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  branding: unknown;
  status: string;
}

async function findCompetition(orgSlug: string, slug: string): Promise<PublicCompetition> {
  const [row] = await sql<PublicCompetition[]>`
    select c.id, c.org_id, c.name, c.slug, c.description, c.starts_on, c.ends_on,
           c.branding, c.status
    from public_competitions_v c
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${slug} limit 1`;
  if (!row) throw new HttpError(404, "competition not found");
  return row;
}

async function findDivision(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<{ id: string; competition_id: string }> {
  const [row] = await sql<{ id: string; competition_id: string }[]>`
    select d.id, d.competition_id
    from public_divisions_v d
    join public_competitions_v c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${compSlug} and d.slug = ${divSlug} limit 1`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

/** Competition landing: description + its divisions. */
export async function publicCompetition(orgSlug: string, slug: string): Promise<unknown> {
  return cached(`pub:v1:comp:${orgSlug}:${slug}`, async () => {
    const full = await findCompetition(orgSlug, slug);
    const competition = { ...full, org_id: undefined };
    const divisions = await sql`
      select id, name, slug, sport_key, variant_key, status
      from public_divisions_v where competition_id = ${competition.id}
      order by created_at, id`;
    return { ...competition, divisions };
  });
}

/** How long the hub document may be served stale. Shorter than this file's
 *  30 s default: the hub carries LIVE scores across every division of a
 *  competition, so it is the one public document whose staleness a spectator
 *  watching a match actually feels. Both write paths delete the key outright
 *  (`invalidatePublicCache`, `afterScheduleWrite`), so this is a ceiling on
 *  how wrong a MISSED invalidation can leave the page, not the refresh rate.
 *  Exported for `hub-push-retry-ttl.test.ts`, which pins the client hook's
 *  last push retry above it (R10c m2); the hook cannot import this file. */
export const HUB_TTL_SECONDS = 15;

/**
 * The competition hub document (spectator W2) — the API half of the same
 * `loadCompetitionHub` the page renders from, so a first paint and every
 * subsequent poll agree.
 *
 * `findCompetition` runs FIRST and throws its own 404 for a competition that
 * is private or does not exist, before the cache is touched: that keeps the
 * refusal identical to every other endpoint in this file. A null document
 * after a positive `findCompetition` is a 404 too — the visibility rules the
 * two readers apply are the same, so it should be unreachable, and if the two
 * ever disagree a 404 is the honest answer rather than a `null` body.
 */
export async function publicCompetitionHub(
  orgSlug: string,
  slug: string,
): Promise<CompetitionHubDocT> {
  const full = await findCompetition(orgSlug, slug);
  const doc = await cachedHub(orgSlug, slug, full);
  // The leader boards serve the snapshot as they stand; after the response,
  // each division is checked and its refresh queued if the snapshot is behind a
  // result, so a refresh lost to a restart heals on the page's next poll (owner
  // ruling 2026-09-17, m8). HERE, at route level, and never in the loader:
  // the loader also runs inside `unstable_cache` and ISR regenerations, where
  // `after()` never runs (final review I1). A division whose sport keeps no
  // player stats is never owed (`playerStatsOwed`).
  reconcilePlayerStatsOnRead(
    full.org_id,
    doc.divisions.map((d) => d.id),
    { allowed: () => hasFeature(full.org_id, "stats.player", full.id) },
  );
  return doc;
}

async function cachedHub(orgSlug: string, slug: string, full: PublicCompetition): Promise<CompetitionHubDocT> {
  return cachedFor(
    `pub:v1:hub:${full.id}`,
    HUB_TTL_SECONDS,
    async () => {
      const doc = await loadCompetitionHub(orgSlug, slug);
      if (!doc) throw new HttpError(404, "competition not found");
      // Final-review fix F3 — `isValid` below only checks what comes BACK
      // from Redis on a HIT. Without this, a freshly built document that
      // fails `CompetitionHubDoc` is served and CACHED anyway, and every
      // subsequent read within the TTL re-fails the same `isValid` check,
      // pays a full rebuild, and re-writes the same bad entry — a permanent
      // silent cache miss with nothing in the logs to say why. This does not
      // throw: a hard failure is worse on a public page than an unvalidated
      // document, which is what this endpoint served before the check
      // existed at all.
      const parsed = CompetitionHubDoc.safeParse(doc);
      if (!parsed.success) {
        log.error(
          { competitionId: full.id, orgSlug, slug, issues: parsed.error.issues },
          "publicCompetitionHub: freshly built document failed CompetitionHubDoc — serving and caching it anyway",
        );
      }
      return doc;
    },
    (hit) => CompetitionHubDoc.safeParse(hit).success,
  );
}

/** How long the player page's match lines may be served stale. The hub's
 *  number and the hub's reason — these lines carry a live match's figures.
 *  The key is per person, and a scoring write knows the fixture, not everyone
 *  who played in it, so no writer can name it. Instead every document embeds
 *  its competition's GENERATION (`player-matches-cache-keys.ts`), and a writer
 *  deletes that one literal key: scoring's `invalidatePublicCache` in its
 *  existing DEL, and a consent change (`setMyConsent`). So this TTL is a
 *  ceiling on a failed delete, and the whole bound for a write that deletes
 *  nothing here (a reschedule: `afterScheduleWrite` drops the hub and fixture
 *  keys only). */
export const PLAYER_MATCHES_TTL_SECONDS = 15;

/** How long a minted generation token lives. Any value above the document TTL
 *  is correct — a token that expires is simply re-minted, one miss per
 *  person — so this only trades an idle competition's stored key against one
 *  extra SET a day. */
export const PLAYER_MATCHES_GEN_TTL_SECONDS = 86_400;

/**
 * The competition's current player-matches generation, minted when absent.
 *
 * Correct without SET NX. A token is random and written once, by its minter,
 * and a reader keys a document under a token only AFTER it has seen that token
 * in Redis (its own GET, or its own completed SET). So a document built before
 * a write committed sits under a token that existed before that write's DEL —
 * which the DEL removed, and nothing ever sets again. Two readers minting at
 * once just overwrite each other: one extra miss, never a stale hit. That is
 * also why the token is minted BEFORE the load and never after it: a token set
 * after a slow load could land after a write's DEL and front a pre-write
 * document. (A refused read therefore may leave a token behind — it names no
 * person, and `findCompetition` has already 404'd an unknown competition.)
 *
 * Cost: one GET per poll on top of the document's own (two round trips where
 * the hub has one), plus one SET on the first poll after each delete. Fail-open
 * with the rest of cache.ts: with Redis down the GET misses, the SET no-ops, and
 * the document read misses too.
 */
async function playerMatchesGeneration(competitionId: string): Promise<string> {
  const key = playerMatchesGenKey(competitionId);
  const held = await cacheGet<unknown>(key);
  if (typeof held === "string" && held !== "") return held;
  const minted = randomUUID();
  await cacheSet(key, minted, PLAYER_MATCHES_GEN_TTL_SECONDS);
  return minted;
}

/**
 * Spectator W2, Task 14 — the public player page's match lines, the document
 * its client island polls while a spectator has the page open (R10).
 *
 * A GATE, THEN ONE READ. `publicPlayerGate` is the page's own refusal —
 * `getPublicPlayer` is built on it — so the consent view and the
 * `dashboard.player_profiles` entitlement decide here exactly what they decide
 * for the page, and a person whose page 404s cannot be read through this
 * endpoint either. It folds nothing. `readPlayerMatchLines` is the DATA, read
 * once per rebuild. Never `getPublicPlayer` itself: it would fold every line a
 * second time, and its lines sit behind an `unstable_cache` entry that a score
 * write only marks stale-while-revalidate (`fireScoreRevalidate`, competition
 * tag 'max'), so the first read after a wicket still answers the figures from
 * before it — the thing a poll exists to move past.
 *
 * Same refusal order as `publicCompetitionHub`: `findCompetition` 404s a
 * private or unknown competition before the cache is touched. A 404 inside
 * the loader throws before `cacheSet`, so a refusal is never cached.
 *
 * The key embeds the competition's generation (`playerMatchesGeneration`), so
 * one DEL of the generation key retires every person's document at once.
 */
export async function publicPlayerMatches(
  orgSlug: string,
  slug: string,
  personId: string,
): Promise<PublicPlayerMatchesT> {
  const full = await findCompetition(orgSlug, slug);
  const generation = await playerMatchesGeneration(full.id);
  return cachedFor(
    playerMatchesKey(full.id, generation, personId),
    PLAYER_MATCHES_TTL_SECONDS,
    async () => {
      const gate = await publicPlayerGate(orgSlug, slug, personId);
      if (!gate) throw new HttpError(404, "player not found");
      const matches = await readPlayerMatchLines(sql, {
        personId,
        competitionId: full.id,
        orgSlug,
        compSlug: slug,
        // The page's locale — the org's, never the viewer's (the page is ISR).
        locale: toLocale(gate.org.default_locale),
      });
      return { matches, generatedAt: new Date().toISOString() };
    },
    (hit) => PublicPlayerMatches.safeParse(hit).success,
  );
}

/** How long the org home's live poll may be served stale — the hub's window,
 *  for the hub's reason: it is what a spectator watching for a match to start
 *  feels. A scoring write deletes the key outright (`invalidatePublicCache`),
 *  so this bounds a missed invalidation, not the refresh rate. */
export const ORG_LIVE_TTL_SECONDS = 15;

/**
 * The org home's chip island poll (spectator W2, Task 15, R10): for every
 * competition the org home LISTS, its status and in-play count.
 *
 * The list and the counts come from `listOrgHomeCompetitions`, the same query
 * `getPublicOrg` renders the page from, so the poll can never name a
 * competition the page does not list (an unlisted or private one) or count a
 * match the page would not.
 *
 * The org lookup runs FIRST and throws its own 404, before the cache is
 * touched — the same order `publicCompetitionHub` keeps. A Redis hit is
 * PARSED before it is served (`cachedFor`'s `isValid`): an entry of another
 * shape, left by an older build, is a miss and is rewritten, never served.
 */
export async function publicOrgLive(orgSlug: string): Promise<PublicOrgLiveT> {
  const [org] = await sql<{ id: string }[]>`
    select id from organizations where slug = ${orgSlug} limit 1`;
  if (!org) throw new HttpError(404, "organization not found");
  return cachedFor(
    `pub:v1:org-live:${org.id}`,
    ORG_LIVE_TTL_SECONDS,
    async () => {
      const competitions = await listOrgHomeCompetitions(org.id);
      return {
        competitions: competitions.map((c) => ({
          id: c.id,
          status: c.status as PublicOrgLiveT["competitions"][number]["status"],
          in_play: c.in_play,
        })),
      };
    },
    (hit) => PublicOrgLive.safeParse(hit).success,
  );
}

export async function publicSchedule(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<unknown> {
  const division = await findDivision(orgSlug, compSlug, divSlug);
  return cached(`pub:v1:div:${division.id}:schedule`, async () => {
    // Fix round 3 (Gap 9): home_slot_label/away_slot_label were on
    // public_fixtures_v since V362 but never selected here, so an API v1
    // consumer saw nothing where the HTML schedule page (public-site/data.ts)
    // already shows a label.
    const rawFixtures = await sql<
      Pick<
        PublicFixture,
        | "id"
        | "stage_id"
        | "pool_id"
        | "round_no"
        | "seq_in_round"
        | "home_entrant_id"
        | "away_entrant_id"
        | "home_slot_label"
        | "away_slot_label"
        | "scheduled_at"
        | "venue"
        | "court_label"
        | "status"
        | "outcome"
        | "summary"
      >[]
    >`
      select id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id,
             away_entrant_id, home_slot_label, away_slot_label,
             scheduled_at, venue, court_label, status, outcome, summary
      from public_fixtures_v where division_id = ${division.id}
      order by round_no, seq_in_round`;
    // P9 cutover (finding #2): venue/court_label are frozen since the
    // venues/courts entities cutover — every consumer of this endpoint saw
    // null for both. venue_name/court_name (derived, disambiguated via
    // public-site/data.ts's withCourtVenueNames — same helper the HTML
    // schedule page uses) are what a consumer should render instead.
    const fixtures = await withCourtVenueNames(rawFixtures);
    return { division_id: division.id, fixtures };
  });
}

export async function publicStandings(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<unknown> {
  const division = await findDivision(orgSlug, compSlug, divSlug);
  return cached(`pub:v1:div:${division.id}:standings`, async () => {
    const standings = await sql`
      select stage_id, pool_id, rows, updated_at
      from public_standings_v where division_id = ${division.id}`;
    return { division_id: division.id, standings };
  });
}

export async function publicEntrants(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<unknown> {
  const division = await findDivision(orgSlug, compSlug, divSlug);
  return cached(`pub:v1:div:${division.id}:entrants`, async () => {
    const entrants = await sql<
      {
        id: string;
        kind: string;
        display_name: string;
        seed: number | null;
        status: string;
        members: PublicEntrantMember[];
      }[]
    >`
      select id, kind, display_name, seed, status, members
      from public_entrants_v where division_id = ${division.id}
      order by seed nulls last, display_name`;
    const [priv] = await sql<{ youth: boolean; player_name_display: string | null }[]>`
      select youth, player_name_display from divisions where id = ${division.id}`;
    // Code-review fix (2026-08-30, item 5): this used to reimplement
    // maskPublicEntrantNames's own query+masking inline for display_name
    // (youth+consent), while members[].name kept coming from the SQL-side
    // public_person_name() — a masking convention with the OPPOSITE default
    // polarity (absent consent masks there, never masks here) and no youth
    // awareness. One shared helper now, covering both fields the same way
    // embed-data.ts's embedDivisionData already does.
    const masked = await maskPublicEntrantNames(entrants, {
      youth: priv?.youth ?? false,
      player_name_display: priv?.player_name_display ?? null,
    });
    return { division_id: division.id, entrants: masked };
  });
}

// ---------------------------------------------------------------------------
// Discovery directory (doc 15 §4, PROMPT-19). One SELECT on public_discovery_v
// — the view already applies consent (no person data), opt-in, block, org
// status and the quality floor. Redis 30 s in front; the route adds
// s-maxage=60. Anonymous homepage traffic never touches hot tenant paths.
// ---------------------------------------------------------------------------

export interface DiscoveryEntry {
  id: string;
  name: string;
  slug: string;
  starts_on: string | null;
  ends_on: string | null;
  status: string;
  city: string | null;
  country: string | null;
  tagline: string | null;
  hero_image_path: string | null;
  featured: boolean;
  org_name: string;
  org_slug: string;
  sports: string[] | null;
  entrant_count: number;
  in_play_count: number;
  next_fixture_at: string | null;
}

export interface DiscoveryQuery {
  sport?: string;
  country?: string;
  status?: "live" | "upcoming";
  q?: string;
  offset?: number;
  limit?: number;
}

const DISCOVERY_MAX_LIMIT = 48;

/** Doc 15 §3 default ordering: featured row first, then in-play, then start-
 *  date proximity; ties by entrant count. Offset paging (rank order is not
 *  keyset-able); the route wraps the offset in the opaque cursor. */
export async function discoveryList(
  query: DiscoveryQuery,
): Promise<{ items: DiscoveryEntry[]; nextOffset: number | null }> {
  const limit = Math.min(Math.max(query.limit ?? 24, 1), DISCOVERY_MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const key =
    `pub:v1:discovery:${query.sport ?? ""}:${query.country ?? ""}:` +
    `${query.status ?? ""}:${query.q ?? ""}:${offset}:${limit}`;
  return cached(key, async () => {
    const rows = await sql<DiscoveryEntry[]>`
      select * from public_discovery_v
      where true
        ${query.sport ? sql`and ${query.sport} = any(sports)` : sql``}
        ${query.country ? sql`and lower(country) = lower(${query.country})` : sql``}
        ${query.q ? sql`and (name ilike ${"%" + query.q + "%"} or org_name ilike ${"%" + query.q + "%"})` : sql``}
        ${
          query.status === "live"
            ? sql`and in_play_count > 0`
            : query.status === "upcoming"
              ? sql`and in_play_count = 0
                    and (starts_on >= current_date or next_fixture_at is not null)`
              : sql``
        }
      order by featured desc,
               (in_play_count > 0) desc,
               abs(extract(epoch from (coalesce(starts_on, current_date + 3650)::timestamp - now()))) asc,
               entrant_count desc, id
      limit ${limit + 1} offset ${offset}`;
    const items = rows.slice(0, limit);
    return { items, nextOffset: rows.length > limit ? offset + limit : null };
  });
}

/**
 * Task 9 — the division/org/competition/stage context `loadMatchCentre`
 * needs, gathered in one place for the API usecase (which, unlike the page
 * data loader below, has none of this in memory already: `publicFixture`
 * takes a bare fixture id with no org/competition/division route params).
 * Base-table reads (`divisions`/`organizations`/`schedule_settings`/
 * `stages`), same convention `engine-db/fold.ts`'s own division/stage
 * lookups and `data.ts`'s `withCourtVenueNames` use for non-consent
 * metadata not exposed by a `public_*_v` view — the caller has already
 * confirmed the fixture's own division/competition are public/unlisted (the
 * row came from `public_fixtures_v`, which filters on that), so no
 * additional visibility check is needed here.
 */
async function loadFixtureMatchCentreCtx(
  divisionId: string,
  stageId: string,
): Promise<MatchCentreLoadCtx> {
  const [row] = await sql<
    {
      sport_key: string;
      module_version: string;
      variant_key: string;
      variant_name: string | null;
      youth: boolean;
      player_name_display: string | null;
      division_tz: string | null;
      org_slug: string;
      org_tz: string | null;
      org_default_locale: string;
      competition_slug: string;
      division_slug: string;
    }[]
  >`
    select d.sport_key, d.module_version, d.variant_key,
           -- T16b fix round 3: the stored format name, scoped like
           -- getPublicFixture's (system rows and this org's own, org first) —
           -- the fallback for a variant variant-label.ts does not name.
           (select v.name from sport_variants v
             where v.sport_key = d.sport_key and v.key = d.variant_key
               and (v.org_id is null or v.org_id = d.org_id)
             order by v.org_id nulls last
             limit 1) as variant_name,
           d.youth, d.player_name_display,
           ss.tz as division_tz,
           o.slug as org_slug, o.timezone as org_tz, o.default_locale as org_default_locale,
           c.slug as competition_slug, d.slug as division_slug
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = d.org_id
    left join schedule_settings ss on ss.division_id = d.id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "fixture not found");
  const [stageRow] = await sql<{ name: string }[]>`select name from stages where id = ${stageId}`;
  const locale = toLocale(row.org_default_locale);
  const basePath = `/shared/${row.org_slug}/${row.competition_slug}/${row.division_slug}`;
  return {
    orgTz: row.org_tz,
    division: {
      sportKey: row.sport_key,
      moduleVersion: row.module_version,
      // T16b fix round 3: the same word the page's own loader prints
      // (getPublicFixture) — this document replaces the page's on every poll.
      formatLabel: variantLabel(
        { sportKey: row.sport_key, variantKey: row.variant_key, storedName: row.variant_name },
        (key) => msgFor(locale, key),
      ),
      tz: row.division_tz,
      youth: row.youth,
      playerNameDisplay: row.player_name_display,
    },
    locale,
    hrefs: { division: basePath, competition: `/shared/${row.org_slug}/${row.competition_slug}`, calendar: `${basePath}/calendar.ics` },
    stage: stageRow ? { name: stageRow.name, roundLabel: null } : null,
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars),
  };
}

/** Live public fixture summary (the score widget). */
export async function publicFixture(fixtureId: string): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) throw new HttpError(404, "fixture not found");
  return cached(`pub:v1:fixture:${fixtureId}`, async () => {
    // Fix round 3 (Gap 9): same gap as publicSchedule above.
    // Task 9 — `pool_id` added to this Pick (was absent): `loadMatchCentre`
    // takes a full `PublicFixture` (match-centre.ts's own `MatchCentreInput`
    // signature, frozen/reviewed — not this task's to narrow), which
    // declares `pool_id` required, unlike `lane`/`is_final`/`third_place`/
    // `conditional` below it, which are `?`-optional and so needed no
    // change here.
    const [row] = await sql<
      Pick<
        PublicFixture,
        | "id"
        | "division_id"
        | "stage_id"
        | "pool_id"
        | "round_no"
        | "seq_in_round"
        | "home_entrant_id"
        | "away_entrant_id"
        | "home_slot_label"
        | "away_slot_label"
        | "scheduled_at"
        | "venue"
        | "court_label"
        | "status"
        | "outcome"
        | "summary"
        | "last_seq"
        | "stream_url"
      >[]
    >`
      select id, division_id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id,
             away_entrant_id, home_slot_label, away_slot_label,
             scheduled_at, venue, court_label, status, outcome,
             summary, last_seq, stream_url
      from public_fixtures_v where id = ${fixtureId} limit 1`;
    if (!row) throw new HttpError(404, "fixture not found");
    // P9 cutover (finding #2): same treatment as publicSchedule above —
    // venue_name/court_name replace the frozen venue/court_label.
    const fixture = await withCourtVenueName(row);
    // Task 9 — the match-centre view model, built by the SAME loader
    // `getPublicFixture` (public-site/data.ts) uses. venue_name/court_name
    // must already be resolved on `fixture` before this call: the Info
    // tab's venue row reads them straight off the fixture object.
    const ctx = await loadFixtureMatchCentreCtx(fixture.division_id, fixture.stage_id);
    const match_centre = await loadMatchCentre(sql, fixture, ctx);
    return { ...fixture, match_centre };
  });
}
