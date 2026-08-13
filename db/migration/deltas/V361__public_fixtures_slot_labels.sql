-- =============================================================================
-- V361 — Stage progression UI (D4b / P6): expose the slot-label columns on
-- the public fixtures view.
--
-- V360 added fixtures.home_slot_label / away_slot_label (jsonb {key, params}
-- — an i18n pattern ref for a not-yet-filled slot, e.g. "Winner of Group A")
-- but only touched the base `fixtures` table. Every public-facing fixture
-- read (public schedule/bracket/results pages, the /embed routes, OG image
-- generation) goes through `public_fixtures_v` instead of `fixtures` directly
-- (V232, last redefined V243 to add `officials`) — that view never gained
-- the two new columns, so no public surface could read a slot label without
-- this. Org-console reads go straight to `fixtures` via FIXTURE_COLS
-- (usecases/stages.ts), already correct since V360.
--
-- Trailing columns only — `create or replace view` may only APPEND (V243's
-- own note, still true). No masking case/when needed: unlike scheduled_at/
-- venue/officials (hidden pre-publish or when officials names are hidden),
-- a slot label has no privacy story — it is exactly as public as the
-- entrant id it stands in for.
-- =============================================================================

create or replace view public_fixtures_v as
  select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
         f.home_entrant_id, f.away_entrant_id,
         case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
         case when d.status = 'setup' then null else f.venue end        as venue,
         case when d.status = 'setup' then null else f.court_label end as court_label,
         f.status, f.outcome, f.created_at,
         m.summary, m.last_seq,
         case when d.officials_hide_names or d.status = 'setup'
              then '[]'::jsonb else f.officials end as officials,
         f.home_slot_label, f.away_slot_label
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
