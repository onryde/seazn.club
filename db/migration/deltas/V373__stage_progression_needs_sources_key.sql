-- V373 — close the same CHECK-constraint gap V372 closed for `map`, this
-- time on `sources` (F2 full-branch review, Blocker 1). V371's
-- stages_progression_shape_chk validated `sources`'s shape with
--   jsonb_typeof(progression -> 'sources') = 'array'
--   and jsonb_array_length(progression -> 'sources') >= 1
-- but — unlike `placement` and `timing`, which are both guarded by
-- `progression ? 'placement'` / `progression ? 'timing'` before their `<@`
-- checks — `sources` had NO `progression ? 'sources'` existence guard.
--
-- Postgres three-valued logic: `progression -> 'sources'` on a row with no
-- `sources` key at all returns SQL NULL; `jsonb_typeof(NULL)` is NULL, not
-- FALSE; the AND-chain then evaluates to NULL; and a CHECK constraint
-- treats a NULL result as SATISFIED, not violated. So a row missing
-- `sources` entirely passed. Reproduced live (rolled-back transaction,
-- this branch's DB, still at V372):
--   insert into stages (division_id, seq, kind, name, progression)
--   values ('<div>', 999, 'league', 'x',
--     '{"placement":"rank_order","timing":"on_complete"}'::jsonb)
--   -- no "sources" key at all — SUCCEEDED (has_sources_key: f).
--
-- Every reader assumes `sources` exists — progression.ts's take-rule
-- expansion calls `.flatMap` on it unconditionally — so a row like that
-- crashes at read time, not write time. Every app write path
-- (ProgressionSchema, api-v1/schemas.ts) already requires `sources` via a
-- plain zod `.min(1)` array field, so this is defence in depth for
-- anything that writes `stages` directly (a future migration, a script),
-- exactly the same job V372 does for `map` — not a substitute for
-- ProgressionSchema.
alter table stages
  drop constraint if exists stages_progression_shape_chk;

alter table stages
  add constraint stages_progression_shape_chk check (
    progression is null
    or (
      progression ? 'sources'
      and jsonb_typeof(progression -> 'sources') = 'array'
      and jsonb_array_length(progression -> 'sources') >= 1
      and progression ? 'placement'
      and progression -> 'placement' <@ '["seeded_map", "snake", "rank_order"]'::jsonb
      and progression ? 'timing'
      and progression -> 'timing' <@ '["setup", "on_complete"]'::jsonb
      and (
        progression ->> 'placement' <> 'seeded_map'
        or (
          progression ? 'map'
          and jsonb_typeof(progression -> 'map') = 'array'
          and jsonb_array_length(progression -> 'map') >= 1
        )
      )
    )
  );
