-- =============================================================================
-- V369 — F1 Task 4: expose the round-role columns (V368) on the public
-- fixtures view.
--
-- V368 added fixtures.lane/is_final/third_place/conditional (the engine's
-- bracket-position role, persisted instead of re-derived per consumer) but
-- only touched the base `fixtures` table. Every public-facing fixture read
-- (public bracket, the /embed routes) goes through `public_fixtures_v`
-- instead of `fixtures` directly (V232, last redefined V362) — that view
-- never gained the four new columns, so the public bracket could not name a
-- double-elim round by lane without them. Org-console reads go straight to
-- `fixtures` via FIXTURE_COLS (usecases/stages.ts), updated separately.
--
-- Trailing columns only — `create or replace view` may only APPEND (V243's
-- own note, still true).
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
         f.home_slot_label, f.away_slot_label,
         f.lane, f.is_final, f.third_place, f.conditional
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
