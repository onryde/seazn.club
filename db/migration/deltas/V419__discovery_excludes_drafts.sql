-- V419 — a DRAFT competition is unlisted until it is published.
--
-- Owner decision 2026-09-27. A competition is created with `status = 'draft'`
-- (V207) and, since V396, `visibility = 'public'` by default, so it was live
-- AND listed the moment it existed. The ruling: a draft stays reachable by
-- direct link (hub, divisions, fixtures, poster, kiosk, embed, registration
-- all keep working) but is enumerated on NO listing surface until the
-- organiser publishes it. A draft behaves like `unlisted` for listing
-- purposes; `archived` is unchanged (still public and listed as "Finished").
--
-- `public_discovery_v` is one of those listing surfaces — /discover, the
-- per-sport landings, the marketing live wall, the sitemap's sport entries and
-- GET /api/v1/public/discovery all read it and nothing else. Its latest body
-- (V306) gates on consent (`discoverable`), visibility, the staff block, the
-- org's status and a quality floor, but never on the competition's status —
-- and the floor's second arm ("a division past setup") is met by a draft whose
-- schedule is already published. So a discoverable draft could be showcased.
--
-- ONLY CHANGE: `and c.status <> 'draft'` in the WHERE clause. The body is
-- copied VERBATIM from V306 (its current definition — V307/V314/V328/V332/
-- V334/V338 each record it as unchanged), same columns in the same order:
-- `create or replace view` may only append columns, and none is added here.
-- `<> 'draft'`, not an allow-list, so `archived` and `completed` stay listed
-- exactly as before.
--
-- `create or replace view` keeps the view's existing privileges; the V239
-- grant is re-stated below anyway so this file is self-evidently safe to read.

create or replace view public_discovery_v as
select c.id,
       c.name,
       c.slug,
       c.starts_on,
       c.ends_on,
       c.status,
       c.created_at,
       c.discovery->>'city'    as city,
       c.discovery->>'country' as country,
       -- Presentation depth is the paid layer (doc 15 §5).
       case when org_has_feature(c.org_id, 'discovery.branding', c.id)
            then c.discovery->>'tagline' end as tagline,
       case when org_has_feature(c.org_id, 'discovery.branding', c.id)
            then c.discovery->>'hero_image_path' end as hero_image_path,
       -- Staff-curated featured flag, honoured only while the org holds the
       -- Pro perk (doc 15 §3 — eligible, not guaranteed).
       (c.discovery_featured
         and org_has_feature(c.org_id, 'discovery.featured', c.id)) as featured,
       o.name as org_name,
       o.slug as org_slug,
       (select array_agg(distinct d.sport_key)
          from divisions d where d.competition_id = c.id)     as sports,
       (select count(*)::int from entrants e
          join divisions d on d.id = e.division_id
         where d.competition_id = c.id
           and e.status in ('registered','confirmed'))        as entrant_count,
       (select count(*)::int from fixtures f
         where f.division_id in (select id from divisions d where d.competition_id = c.id)
           and f.status = 'in_play')                          as in_play_count,
       (select min(f.scheduled_at) from fixtures f
          join divisions d on d.id = f.division_id
         where d.competition_id = c.id
           and d.status <> 'setup'                            -- publish-gated (doc 12 §1)
           and f.status = 'scheduled'
           and f.scheduled_at >= now())                       as next_fixture_at
from competitions c
join organizations o on o.id = c.org_id
where c.discoverable
  and c.visibility = 'public'
  -- V419: a draft is unlisted until published (owner decision 2026-09-27).
  and c.status <> 'draft'
  and not c.discovery_blocked
  and o.status = 'active'
  -- Quality floor (doc 15 §3): email-verified owner…
  and exists (select 1 from org_members m join users u on u.id = m.user_id
               where m.org_id = o.id and m.role = 'owner' and u.email_verified)
  -- …and ≥1 decided fixture or a published schedule (division past setup).
  and (exists (select 1 from fixtures f join divisions d on d.id = f.division_id
                where d.competition_id = c.id
                  and f.status in ('decided','finalized'))
    or exists (select 1 from divisions d
                where d.competition_id = c.id
                  and d.status in ('scheduled','active','completed')));

grant select on public_discovery_v to app_user;
