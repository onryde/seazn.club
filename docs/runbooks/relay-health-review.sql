-- Relay health review: how one stream session's Machine did, beat by beat (R2002; the compositor's post-match review).
--
--   psql "$DATABASE_URL" -v sid=<session uuid> -c 'set search_path to seazn_club' -f docs/runbooks/relay-health-review.sql
--
-- Reads fixture_stream_samples.raw (every beat, sanitised: ruling 13) and fixture_stream_sessions.last_heartbeat (the
-- latest beat, whole). One row for a known session, none for an unknown id; a session with no beats is one row of
-- zeros and nulls.
--
-- Absent is not zero. A beat that omits a field measured nothing: it counts in `beats`, never as a phase, a link state,
-- a flag or a rung (`reported_beats` counts the beats that carried a programme phase), and it neither extends nor ends
-- a camera backoff run.
--
-- The counters (inputKicks, pipelineRebuilds, sinkSwaps) count per PROCESS: a restarted Machine (R2003's one retry)
-- starts them at 0 again, so the review shows each one's maximum, never a sum.
--
-- exit_reason / exit_detail are the latest the Machine reported (its final beat's, when it sent one). The history keeps
-- exit_detail cut at its first `?`; last_heartbeat keeps the final beat whole. The runner's own exit columns
-- (runner_exit_code and friends) are what was OBSERVED and stay the authority for how the session ended.
with beats as (
  select x.id, x.sampled_at, x.raw
    from fixture_stream_samples x
   where x.session_id = (:'sid')::uuid and x.source = 'heartbeat'
),
-- The camera link on the beats that reported it, numbered into runs of equal backoff-ness (gaps and islands).
links as (
  select b.sampled_at, b.raw->>'input' = 'backoff' as backoff,
         lead(b.sampled_at) over (order by b.sampled_at, b.id) as next_at,
         row_number() over (order by b.sampled_at, b.id)
           - row_number() over (partition by b.raw->>'input' = 'backoff' order by b.sampled_at, b.id) as run
    from beats b
   where jsonb_typeof(b.raw->'input') = 'string'
),
-- A backoff run lasts from its first beat to the first reported beat out of it; a run that never ended, to its last.
backoff_runs as (
  select extract(epoch from coalesce(max(l.next_at), max(l.sampled_at)) - min(l.sampled_at))::float8 as seconds
    from links l
   where l.backoff
   group by l.run
),
latest_exit as (
  select b.raw->>'exitReason' as exit_reason, b.raw->>'exitDetail' as exit_detail
    from beats b
   where jsonb_typeof(b.raw->'exitReason') = 'string'
   order by b.sampled_at desc, b.id desc
   limit 1
)
select s.id as session_id,
       s.mode,
       count(b.id)::int as beats,
       (count(b.id) filter (where jsonb_typeof(b.raw->'programmePhase') = 'string'))::int as reported_beats,
       (count(b.id) filter (where b.raw->>'programmePhase' = 'waiting'))::int as phase_waiting,
       (count(b.id) filter (where b.raw->>'programmePhase' = 'live'))::int as phase_live,
       (count(b.id) filter (where b.raw->>'programmePhase' = 'frozen'))::int as phase_frozen,
       (count(b.id) filter (where b.raw->>'programmePhase' = 'reconnecting'))::int as phase_reconnecting,
       (count(b.id) filter (where b.raw->>'input' = 'backoff'))::int as input_backoff_beats,
       (count(b.id) filter (where b.raw->>'output' = 'backoff'))::int as output_backoff_beats,
       (count(b.id) filter (where b.raw->>'graphics' = 'restarting'))::int as graphics_restarting_beats,
       (count(b.id) filter (where b.raw->>'graphics' = 'failed'))::int as graphics_failed_beats,
       (count(b.id) filter (where b.raw->'inputKickAlert' = 'true'::jsonb))::int as kick_alert_beats,
       (count(b.id) filter (where jsonb_typeof(b.raw->'rung') = 'string' and b.raw->>'rung' <> 'full'))::int as rung_stepped_beats,
       (count(b.id) filter (where b.raw->'scoreStale' = 'true'::jsonb))::int as score_stale_beats,
       max((b.raw->>'inputKicks')::bigint)::float8 as max_input_kicks,
       max((b.raw->>'pipelineRebuilds')::bigint)::float8 as max_pipeline_rebuilds,
       max((b.raw->>'sinkSwaps')::bigint)::float8 as max_sink_swaps,
       (select max(r.seconds) from backoff_runs r) as longest_input_backoff_s,
       min(b.sampled_at) filter (where b.raw->'inputKickAlert' = 'true'::jsonb) as first_kick_alert_at,
       min(b.sampled_at) as first_beat_at,
       max(b.sampled_at) as last_beat_at,
       (select e.exit_reason from latest_exit e) as exit_reason,
       (select e.exit_detail from latest_exit e) as exit_detail,
       s.last_heartbeat
  from fixture_stream_sessions s
  left join beats b on true
 where s.id = (:'sid')::uuid
 group by s.id, s.mode, s.last_heartbeat
