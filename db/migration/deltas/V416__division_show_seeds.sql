-- V416 — a division can keep its seed numbers off the public site.
--
-- `divisions.show_seeds`, default TRUE: every division, new or existing, keeps
-- publishing its seeds exactly as before until an organiser turns it off in
-- the division's Settings tab (PATCH /api/v1/divisions/{id}).
--
-- The redaction lives HERE, in `public_entrants_v`, rather than in each reader.
-- Every public surface that prints an entrant reads this view — the hub
-- document's Teams cards, the division page (and the calendar/poster exports
-- built on its data), the website embed, and the anonymous
-- `/api/v1/public/.../entrants` document — so one predicate covers them all,
-- including any reader added later. A seed hidden only in the markup would
-- still reach every one of those documents.
--
-- The readers' own `order by seed nulls last, display_name` needs no change,
-- and that is load-bearing rather than incidental: with `seed` null for every
-- row of a hiding division, the sort falls through to the name. A list that
-- printed no numbers but kept its seed ORDER would publish the seeding anyway.
--
-- The organiser's own reads (`entrants` directly: the Entrants panel, the
-- Swiss pairing menu, seeding) never go through this view and keep every seed.
--
-- NOTHING ELSE CHANGES. The view body is V412's verbatim — the consent masking
-- of member names, the photo and person_id entitlement gates, the
-- `merged_into` tombstone exclusion, the visibility gate, the same column list
-- in the same order — with `e.seed` replaced by the gated expression. Copying
-- any older definition would silently revert those (V350 records why).

alter table divisions add column show_seeds boolean not null default true;

create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name,
         case when d.show_seeds then e.seed end as seed,
         e.status,
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
