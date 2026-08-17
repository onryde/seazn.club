-- V371 — unify stages.qualification and stages.seeding into one
-- stages.progression field (F2, design doc §2.1/§5). Greenfield per owner
-- ruling 2026-08-17: no production data — no backfill, no dual-read, no
-- compat shim, both old columns are dropped in the same migration that
-- adds the new one.
--
-- Verified immediately before writing this file, per Task 4 Step 1, against
-- the target database (schema seazn_club, flyway at V370):
--   select count(*) from stages where qualification is not null;  -- 0
--   select count(*) from stages where seeding is not null;        -- 0
--   select count(*) from stages;                                  -- 0
-- (An empty `stages` table trivially satisfies the premise; recorded here
-- as evidence per ruling 5, not as a claim that the check was vacuous.)
--
-- This file's own number moved three times before landing here (V367 ->
-- V369 -> V370 -> V371) as sibling branches (P8, RS002, F1's two
-- migrations) each merged first and claimed the number this plan was
-- drafted against. Re-verified against a freshly fetched origin/main
-- immediately before writing this file: main's newest delta is V370
-- (registration_entry_refunds), so V371 is free. A number is claimed by
-- merging, not by choosing — whichever branch merges last still has to
-- renumber regardless of what was free when it was written.
--
-- `progression` is nullable, same as both columns it replaces: a division's
-- first stage never had qualification/seeding either (no upstream source to
-- describe), and that is still expressed as `progression is null`, not a
-- sentinel value. See @seazn/engine/competition/progression.ts for the
-- take-rule vocabulary this column's jsonb holds, and
-- apps/web/src/server/api-v1/schemas.ts (ProgressionSchema, a later task in
-- this plan) for the full validated wire shape.
alter table stages drop column qualification;
alter table stages drop column seeding;
alter table stages add column progression jsonb;

-- Structural shape checks the zod layer already enforces at the edge — this
-- is defence in depth for anything that writes stages directly (a future
-- migration, a script), not a substitute for ProgressionSchema. Idempotent
-- constraint add follows this repo's established shape (V330/V331/V336/
-- V356/V368): drop-if-exists then plain add, not `add constraint if not
-- exists` (not valid Postgres syntax).
alter table stages
  drop constraint if exists stages_progression_shape_chk;

alter table stages
  add constraint stages_progression_shape_chk check (
    progression is null
    or (
      jsonb_typeof(progression -> 'sources') = 'array'
      and jsonb_array_length(progression -> 'sources') >= 1
      and progression ? 'placement'
      and progression -> 'placement' <@ '["seeded_map", "snake", "rank_order"]'::jsonb
      and progression ? 'timing'
      and progression -> 'timing' <@ '["setup", "on_complete"]'::jsonb
    )
  );

comment on column stages.progression is
  'F2: the union of the old qualification and seeding vocabularies — one or '
  'more sources (each an earlier stage + take rules), one placement '
  '(rank_order/snake/seeded_map), and timing (setup = TBD placeholders '
  'generated independently of source completion, propose+confirm fill; '
  'on_complete = auto-seed only once every source stage completes). See '
  '@seazn/engine/competition (progression.ts) for the take-rule vocabulary '
  'and apps/web/src/server/api-v1/schemas.ts (ProgressionSchema) for the '
  'full validated shape.';
