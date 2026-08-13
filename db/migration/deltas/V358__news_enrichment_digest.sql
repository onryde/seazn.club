-- =============================================================================
-- V358 — News enrichment + weekly digest (D7 / P3, portfolio bench spec §14).
--
-- Two independent, additive changes needed for the weekly digest's
-- "standings movement" section and the digest draft kind itself.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) standings_snapshots one-step history.
--
-- `recomputeStandings` (engine-db/competition.ts) is idempotent and reruns on
-- every decided/void write; `writeSnapshot` does `insert ... on conflict ...
-- do update set rows = excluded.rows`, which clobbers the prior ranked table
-- with no trace. The digest's "biggest climber" line needs ONE step of
-- history to diff against — not an audit log, just what the row looked like
-- immediately before the write that produced the current one.
--
-- Nullable, no default: a stage snapshotted for the first time (or never
-- re-computed since this migration) simply has no history yet, which is a
-- valid "nothing to diff" state, not an error.
alter table standings_snapshots add column if not exists previous_rows jsonb;

-- -----------------------------------------------------------------------------
-- 2) org_posts_auto_once (V295) must not apply to weekly_digest.
--
-- The index keys on (org_id, trigger, fixture_id, division_id, stage_id,
-- round_no) — right for result/round_recap, which fire from the decided-write
-- SEAM and must collapse repeat firings for the SAME fixture/round to one
-- draft. A weekly digest fires from a console BUTTON: every press is a
-- deliberate request for a fresh draft (new results may have landed since the
-- last one), and none of the five key fields apply to a digest (no single
-- fixture/division/stage/round), so unchanged the index would let the FIRST
-- digest ever generated for an org insert and silently swallow every digest
-- after it. Exempt weekly_digest from the once-per-key constraint;
-- result/round_recap keep the original guarantee unchanged.
drop index if exists org_posts_auto_once;
create unique index org_posts_auto_once on org_posts (
  org_id,
  (auto_source->>'trigger'),
  coalesce(auto_source->>'fixture_id', ''),
  coalesce(auto_source->>'division_id', ''),
  coalesce(auto_source->>'stage_id', ''),
  coalesce(auto_source->>'round_no', '')
) where auto_source is not null and auto_source->>'trigger' <> 'weekly_digest';

-- -----------------------------------------------------------------------------
-- 3) New draft kind.
alter table org_posts drop constraint if exists org_posts_kind_check;
alter table org_posts add constraint org_posts_kind_check
  check (kind in ('news','result','round_recap','announcement','weekly_digest'));

-- -----------------------------------------------------------------------------
-- 4) Indexes backing the weekly-digest cron's candidate pre-filter.
--
-- `sweepWeeklyDigests` originally walked every row of `organizations` and did
-- an entitlement round-trip plus a tenant transaction per org. That is O(all
-- orgs) for a job whose candidate set is tiny, and it does not merely get slow
-- — against ~7.3k organizations it exceeded a 30s limit and failed outright.
--
-- The sweep now narrows to orgs with either recent decided activity or a
-- fixture scheduled in the coming week, via one UNION query. These two indexes
-- are what make that query cheap; without them the pre-filter is still a
-- sequential scan and nothing is actually fixed.
--
-- `match_states` had no index on `updated_at` at all (only its pkey on
-- fixture_id), and `fixtures` had no index leading with `scheduled_at` — the
-- existing `fixtures_division_idx` leads with `division_id`, so it cannot serve
-- a bare time-range predicate.
create index if not exists match_states_updated_at_idx
  on match_states (updated_at);

create index if not exists fixtures_scheduled_at_idx
  on fixtures (scheduled_at)
  where scheduled_at is not null;
