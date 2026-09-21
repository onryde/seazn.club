-- V412 — a withdrawn entrant keeps their NAME on the public board.
--
-- Found by driving the product (2026-09-21, F10 in
-- docs/superpowers/specs/2026-09-20-swiss-withdrawal-customer-walkthrough-findings.md):
-- the public standings table printed
--
--   4 * ?f8001cf4-f592-4b5e-a77c-c94520efed0f 1 1 0 0 0 2
--
-- where a withdrawn entrant's name belongs. A spectator saw an internal UUID in
-- a results table.
--
-- The cause is here, not in the page. A withdrawal settles the matches an
-- entrant had left and LEAVES the ones they actually played, so the standings
-- snapshot — keyed by entrant id and built from results, never from the roster
-- — still carries their row. This view, though, filtered
-- `status in ('registered','confirmed')`, so the page's own `entrants` load
-- never saw them and `entrantNames` had no entry to print.
--
-- So the filter moves OUT of the view and INTO the callers that actually mean
-- "the current field". The view's job is to publish an entrant safely; deciding
-- who is still competing is the caller's question, and the two answers differ
-- per surface: the standings table and the fixture list must NAME everyone who
-- ever played, while the entrants tab, the entrant COUNT, the kiosk, and the
-- ICS and poster exports mean the field and filter for it themselves.
--
-- `status` was already a published column of this view, so every caller can ask.
--
-- NOTHING ELSE CHANGES. Every masking rule is copied verbatim from V350 (the
-- current definition — V350 itself records why copying an older one would
-- silently revert the Event Pass entitlement fix): `public_person_name` by
-- consent, the photo and person_id entitlement gates, the `merged_into`
-- tombstone exclusion, the same column list in the same order. The visibility
-- gate is untouched: a private competition publishes nothing, withdrawn or not.
--
-- No new person data becomes public. These are the same entrants, under the
-- same masking, that this view already published while they were registered.

create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name, e.seed, e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)
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
  where c.visibility in ('public','unlisted');
