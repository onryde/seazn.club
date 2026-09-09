-- =============================================================================
-- V401 — Stream overlay W1: the club's own broadcast link on a fixture.
--
-- A club streams the match to YouTube / Facebook / Twitch / Kick and pastes the
-- link here; the public match page turns it into "Watch live" (and "Replay"
-- once decided). Video never touches seazn — this is a text column and an
-- anchor. Exact-host validation lives in `apps/web/src/lib/stream-url.ts`
-- (R16); the CHECK below is the database's own floor, not a substitute for it.
--
-- The view is redefined IN FULL with `stream_url` appended LAST: `create or
-- replace view` may only APPEND columns (V243's note, V369's note, still true).
-- The body below is V369__public_fixtures_round_role.sql:18 verbatim plus the
-- one trailing column, which carries the same per-row "setup" redaction the
-- scheduled_at/venue/court_label columns already use — an unreleased
-- division's stream link must not leak ahead of its schedule.
-- =============================================================================

alter table fixtures add column if not exists stream_url text
  check (stream_url is null or stream_url like 'https://%');

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
         case when d.status = 'setup' then null else f.stream_url end as stream_url
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
