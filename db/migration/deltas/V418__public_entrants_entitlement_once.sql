-- V418 — `public_entrants_v` asks the player-profiles entitlement once per
-- entrant row, not twice per member. Perf only: the view's output is unchanged.
--
-- Evidence (prod pg_stat_statements, 2026-09-18 → 24; plan of record
-- docs/superpowers/specs/2026-09-24-public-hub-query-perf.md): the by-division
-- read of this view was the hottest public query — 12,292 calls, 24 ms mean on
-- 67 entrant rows — and EXPLAIN ANALYZE put almost all of the members subplan
-- in `org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)`. That
-- function is STABLE SECURITY DEFINER with a pinned search_path, so the planner
-- can never inline it; V416 called it inside `jsonb_build_object` once for the
-- photo arm and once for the person_id arm of every consenting member (~0.1 ms
-- and 14 buffer hits a call). Its answer depends only on the competition.
--
-- So it moves into a LATERAL beside `competitions`, and both arms read
-- `f.profiles_on`. The `offset 0` is load-bearing, not decoration: without it
-- the planner pulls the one-row subquery up and substitutes the function call
-- back into every place `f.profiles_on` is referenced — measured on a fresh
-- schema, the un-fenced form made exactly V416's 5 calls for a 2-entrant,
-- 5-member division; the fenced form makes 2. A reader that does not select
-- `members` pays nothing: the planner drops the lateral's unused output.
--
-- One trade, stated rather than hidden: V416's `consent AND org_has_feature`
-- stopped at a false consent, so an entrant with NO consenting member cost zero
-- calls; it now costs one. The bound is one call per entrant row, against
-- V416's up to two per member.
--
-- NOTHING ELSE CHANGES. The body is V416's verbatim — the consent masking of
-- member names, the photo and person_id entitlement gates (same predicate,
-- read once), the `merged_into` tombstone exclusion, the member ORDER BY, the
-- `show_seeds` seed gate, the team display, the visibility gate, the same
-- column list in the same order and types. `create or replace` keeps the
-- existing grants (V239/V242) and ownership; the view has never carried
-- reloptions, and nothing else depends on it. Copying any OLDER definition
-- would silently revert V350/V412/V416 (V350 records why).
--
-- No index for `competition_passes (competition_id, org_id)` here, although the
-- plan listed one: `competition_id` is that table's PRIMARY KEY (V271), so the
-- pass arm of `org_has_feature` is already a unique-index probe returning at
-- most one row, and a composite would only duplicate it (and tax every write).

create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name,
         case when d.show_seeds then e.seed end as seed,
         e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and f.profiles_on
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and f.profiles_on
                                then p.id else null end,
              'squad_number', em.squad_number,
              'position', em.default_position_key)
              order by em.squad_number nulls last, p.full_name)
            from entrant_members em
            join persons p on p.id = em.person_id
            where em.entrant_id = e.id
              -- #404: an absorbed duplicate leaves the roster the moment it is
              -- tombstoned, not when its entrant_members row is repointed.
              and p.merged_into is null),
           '[]'::jsonb) as members,
         case when e.team_id is not null then
           (select jsonb_build_object(
              'club_id',    td.club_id,
              'club_name',  td.club_name,
              'logo_path',  td.logo_path,
              'colors',     td.colors)
            from team_display_v td where td.team_id = e.team_id)
         end as team_display,
         e.badge_url
  from entrants e
  join divisions d    on d.id = e.division_id
  join competitions c on c.id = d.competition_id
  -- Once per entrant row; `offset 0` fences it from pull-up (see header).
  cross join lateral (
    select org_has_feature(c.org_id, 'dashboard.player_profiles', c.id) as profiles_on
    offset 0
  ) f
  where c.visibility in ('public','unlisted');

-- Public fixture lists read a division's fixtures in draw order
-- (`public_fixtures_v where division_id = … order by round_no, seq_in_round`:
-- data.ts getPublicDivision, embed-data.ts). The existing division indexes lead with
-- `scheduled_at` or `fixture_no`, and the round-ordered one leads with
-- `stage_id`, so none serves that read without a sort. Plain form, as V254/V275
-- (small tables; prefer CONCURRENTLY outside Flyway on a large populated DB).
create index if not exists fixtures_division_round_idx
  on fixtures (division_id, round_no, seq_in_round);
