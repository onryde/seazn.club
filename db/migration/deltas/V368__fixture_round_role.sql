-- =============================================================================
-- V368 — persist each bracket fixture's ROLE (F1, format-progression design
-- 2026-08-17 §2.3).
--
-- The engine already computes each generated fixture's position in the
-- bracket (BracketFixtureGen.bracket/isFinal/thirdPlace/conditional,
-- packages/engine/src/scheduling/bracket.ts) and bracketToGen
-- (apps/web/src/server/usecases/stages.ts) discarded all four fields at
-- persistence. Without them, four separate consumers re-derived a round
-- name from round_no/match-count and drifted — a double-elim losers
-- bracket has repeated 2-match and 1-match rounds by construction, so a
-- count-based namer produced several "Semi-finals" and several "Final"s in
-- one bracket. This migration is schema-only: it adds the columns that let
-- Task 1's roundRole() (packages/engine/src/competition/round-role.ts) be
-- fed real data instead of re-derived guesses.
--
-- Additive, greenfield, no backfill: every existing fixture row predates
-- this column and stays lane = null / is_final = false / third_place =
-- false / conditional = false, which the namer treats as an ordinary
-- single-lane bracket round — the same answer every current consumer
-- already renders for it (round_no-based single-lane naming), so no row's
-- displayed name changes as a side effect of running this migration alone.
--
-- Was V367 before this session started — two other concurrent worktree
-- sessions (p8-venues, rs002) had already taken V367 on their own branches
-- by the time this one ran; re-verified against `db/migration/deltas/`
-- (this worktree) plus sibling worktrees at write time rather than trusting
-- the plan's pinned number, same renumbering practice V361's own header
-- documents.
--
-- Idempotent constraint add follows this repo's established shape
-- (V330/V331/V336/V356): drop-if-exists then plain add, not
-- `add constraint if not exists` (not valid Postgres syntax).
-- =============================================================================

alter table fixtures
  add column if not exists lane text,
  add column if not exists is_final boolean not null default false,
  add column if not exists third_place boolean not null default false,
  add column if not exists conditional boolean not null default false;

alter table fixtures
  drop constraint if exists fixtures_lane_chk;

alter table fixtures
  add constraint fixtures_lane_chk check (lane is null or lane in ('WB', 'LB', 'GF'));

comment on column fixtures.lane is
  'Double-elim lane: WB winners, LB losers, GF grand final. Null for single-lane brackets (knockout, page_playoff, stepladder) and non-bracket stages.';
comment on column fixtures.is_final is
  'True on the single-elim final and on every double-elim grand-final game (both gf and the conditional bracket-reset gf).';
comment on column fixtures.third_place is
  'True on a third-place playoff fixture, independent of lane/round position.';
comment on column fixtures.conditional is
  'True on the double-elim bracket-reset game, which is only played if the losers-bracket champion wins the first grand final.';
