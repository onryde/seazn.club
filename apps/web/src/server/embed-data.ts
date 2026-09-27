import "server-only";
// Embed data door (v3/10 #4): resolve a division ID to its public payload,
// honouring visibility (private → not_found — embeds must never become a
// side door) and the Pro embeds entitlement. Reads the SAME public_*_v views
// as the dashboard, but directly (no unstable_cache) — the /embed pages are
// ISR-cached themselves, and staying cache-free keeps this testable with
// plain Postgres. The outcome enum keeps failure modes explicit.
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { resolveSponsors, type ResolvedSponsor } from "@/server/usecases/sponsors";
import { maskPublicEntrantNames, withCourtVenueNames } from "@/server/public-site/data";
import type {
  PublicCompetition,
  PublicDivision,
  PublicEntrant,
  PublicFixture,
  PublicStage,
  PublicStandings,
} from "@/server/public-site/data";

export interface EmbedPayload {
  org: {
    id: string;
    slug: string;
    name: string;
    /** P6 fix round 1, finding #2 — spectator-facing locale (v5 i18n §4),
     *  same field PublicOrg.default_locale carries on every other public
     *  read model; embeds are visitor-facing too and were missing it. */
    default_locale: string;
  };
  competition: PublicCompetition;
  division: PublicDivision;
  stages: PublicStage[];
  pools: { id: string; stage_id: string; key: string; name: string }[];
  fixtures: PublicFixture[];
  standings: PublicStandings[];
  entrants: PublicEntrant[];
  /** Sponsor rows (v10) — data only; embed RENDERING of sponsors is v12. */
  sponsors: ResolvedSponsor[];
  /** Venue zone (V305): division override → org timezone → UTC. */
  tz: string;
}

export type EmbedResolution =
  | { ok: false; reason: "not_found" | "not_entitled" }
  | { ok: true; data: EmbedPayload };

const iso = <T extends { scheduled_at: unknown }>(f: T): T => ({
  ...f,
  scheduled_at: f.scheduled_at ? new Date(f.scheduled_at as string).toISOString() : null,
});

export async function embedDivisionData(divisionId: string): Promise<EmbedResolution> {
  if (!/^[0-9a-f-]{36}$/i.test(divisionId)) return { ok: false, reason: "not_found" };

  // public_divisions_v enforces visibility (private → no row) and hides
  // archived divisions — exactly the dashboard's rules.
  const [division] = await sql<PublicDivision[]>`
    select d.id, d.competition_id, d.name, d.slug, d.description,
           d.sport_key, d.variant_key, d.status, d.module_version, d.tiebreakers,
           s.name as sport_name, 0 as entrant_count,
           -- RS008 review fix #5: public_divisions_v does not expose these
           -- (see PublicDivision's own doc comment, public-site/data.ts) —
           -- a cheap primary-key join rather than widening that view.
           -- config (V414): the standings forecast's points bounds are
           -- derived from it, as on the division page (data.ts). (No
           -- backticks in here: this is inside a tagged template.)
           dv.youth, dv.player_name_display, dv.config
    from public_divisions_v d
    left join sports s on s.key = d.sport_key
    join divisions dv on dv.id = d.id
    where d.id = ${divisionId}`;
  if (!division) return { ok: false, reason: "not_found" };

  const [competition] = await sql<(PublicCompetition & { org_id: string })[]>`
    select id, org_id, name, slug, description, starts_on, ends_on, branding,
           status, visibility
    from public_competitions_v where id = ${division.competition_id}`;
  if (!competition) return { ok: false, reason: "not_found" };

  // The competition id is not optional here. V396 made `embeds.enabled` false
  // on Free and granted it on both Event Pass rungs, so this is now a
  // pass-lifted key: resolved org-wide it would fall straight through to the
  // community row and an Event Pass holder's embed — on the competition they
  // paid to unlock — would answer `not_entitled`. `pass-scoping-guard.test.ts`
  // enforces exactly this.
  if (!(await hasFeature(competition.org_id, "embeds.enabled", competition.id))) {
    return { ok: false, reason: "not_entitled" };
  }

  const [org] = await sql<{ id: string; slug: string; name: string; default_locale: string }[]>`
    select id, slug, name, default_locale from organizations where id = ${competition.org_id}`;
  if (!org) return { ok: false, reason: "not_found" };

  const [stages, pools, fixtures, standings, entrants, ssRows] = await Promise.all([
    sql<PublicStage[]>`
      select id, division_id, seq, kind, name, status,
             qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule,
             has_rank_overrides
      from public_stages_v where division_id = ${divisionId} order by seq`,
    sql<{ id: string; stage_id: string; key: string; name: string }[]>`
      select p.id, p.stage_id, p.key, p.name
      from public_pools_v p
      join public_stages_v s on s.id = p.stage_id
      where s.division_id = ${divisionId} order by p.key`,
    sql<PublicFixture[]>`
      select v.id, v.division_id, v.stage_id, v.pool_id, v.round_no, v.seq_in_round,
             v.home_entrant_id, v.away_entrant_id, v.home_slot_label, v.away_slot_label,
             v.scheduled_at, v.venue, v.court_label,
             v.status, v.outcome, v.summary, v.last_seq,
             v.lane, v.is_final, v.third_place, v.conditional,
             -- N1 fix round 1, M8: the generator's stable id, which alone tells a
             -- page playoff's rounds apart for the widget's round namer. The view
             -- has no such column; read it off the view row's own fixture, as
             -- getPublicDivision does.
             -- The bracket feed edges, read by the same rule as ext_key.
             -- PublicFixture declares them optional, so OMITTING them here
             -- compiles clean and reads undefined at runtime: the widget's
             -- namer would build an empty feed map and print "TBD" on a seat
             -- every other public surface names.
             -- One fenced LATERAL probe per row, not five subselects: see
             -- readPublicDivisionDetail (public-site/data.ts) on the offset 0,
             -- and on the ORDER BY ending on the stage seq and the id, which
             -- fixes the order of rows tied on (round_no, seq_in_round).
             -- (No backticks in here: this is inside a tagged template.)
             e.ext_key, e.winner_to_fixture, e.winner_to_slot, e.loser_to_fixture, e.loser_to_slot
      from public_fixtures_v v
      left join lateral (
        select x.ext_key, x.winner_to_fixture, x.winner_to_slot, x.loser_to_fixture, x.loser_to_slot
        from fixtures x where x.id = v.id
        offset 0
      ) e on true
      left join stages st on st.id = v.stage_id
      where v.division_id = ${divisionId}
      order by v.round_no, v.seq_in_round, st.seq, v.id`
      .then((rows) => rows.map(iso))
      // P9 cutover (finding #1): venue_name/court_name — public_fixtures_v
      // has not been extended with venue_id/court_id, so these are derived
      // the same way public-site/data.ts's own division/fixture reads
      // already do (withCourtVenueNames), not left frozen undefined.
      .then((rows) => withCourtVenueNames(rows)),
    sql<PublicStandings[]>`
      select stage_id, pool_id, rows, updated_at
      from public_standings_v where division_id = ${divisionId}`,
    sql<PublicEntrant[]>`
      select id, division_id, kind, display_name, seed, status, members, team_display, badge_url
      from public_entrants_v where division_id = ${divisionId}
      order by seed nulls last, display_name`
      // RS008 review fix #5 — this embeds door ran its own separate entrants
      // query (structurally identical to getPublicDivision's) with ZERO
      // masking, not even by youth. Reuses the SAME shared helper rather
      // than a parallel implementation.
      .then((rows) => maskPublicEntrantNames(rows, division)),
    // Venue lane (V305): the division's override, else the org's timezone.
    sql<{ tz: string }[]>`
      select coalesce(ss.tz, o.timezone, 'UTC') as tz
      from divisions d
      left join schedule_settings ss on ss.division_id = d.id
      left join organizations o on o.id = d.org_id
      where d.id = ${divisionId}`,
  ]);

  return {
    ok: true,
    data: {
      org, competition, division, stages, pools, fixtures, standings, entrants,
      sponsors: await resolveSponsors(org.id, competition.id),
      tz: ssRows[0]?.tz ?? "UTC",
    },
  };
}
