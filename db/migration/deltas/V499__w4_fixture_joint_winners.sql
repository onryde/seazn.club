-- =============================================================================
-- V499 — W4 app B, Task 12 (X-CH-4, X-CH-6; Q4): "Declare joint winners" on an unplayed final.
--
-- The engine's MatchOutcome kinds are closed, so a joint title is no outcome: it is a fixture column. The final is
-- stored `status = 'decided'`, `outcome = null`, `joint_winners_at = <when>`; the status/outcome it held before is kept
-- in a division-ledger row (`joint_winners_declared`) for the Undo. NO DATA CHANGE: the column starts null everywhere.
--
-- The check is the database's own floor of the declaration's shape (the usecase, `jointWinnersOffered`, is the gate): a
-- declared fixture is decided, holds no outcome and seats BOTH finalists.
--
-- `public_fixtures_v` is redefined IN FULL with `joint_winners_at` appended LAST (`create or replace view` may only
-- APPEND columns; V243/V369/V401's note): the body is V401__fixture_stream_url.sql:21 verbatim plus the one trailing
-- column. The public read (`getPublicDivision`, the hub, the OG card) crowns a joint title from it (`champion.ts`).
-- =============================================================================

alter table fixtures add column if not exists joint_winners_at timestamptz null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixtures_joint_winners_shape_check') then
    alter table fixtures add constraint fixtures_joint_winners_shape_check
      check (joint_winners_at is null
             or (status = 'decided' and outcome is null and home_entrant_id is not null and away_entrant_id is not null));
  end if;
end $$;

comment on column fixtures.joint_winners_at is
  'W4 (X-CH-4): when the organiser ruled this unplayed final joint winners. Decided, no outcome, both finalists seated (check).';

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
         f.lane, f.is_final, f.third_place, f.conditional,
         case when d.status = 'setup' then null else f.stream_url end as stream_url,
         f.joint_winners_at
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
