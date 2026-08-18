-- V372 — tighten stages_progression_shape_chk (V371) to enforce the
-- invariant this plan's own Gotchas/Self-review section says to carry
-- forward: a `seeded_map` placement needs a non-empty `map`. V371's CHECK
-- validated `sources`/`placement`/`timing`'s structural shape but never
-- looked at `map` at all, so `placement: "seeded_map"` with NO `map` key
-- (or an empty one) PASSED the constraint — proven empirically (F2 Task 6
-- review). `placeDescriptors` (@seazn/engine/competition/progression.ts)
-- then silently treats a missing/empty `map` as `rank_order` (its own
-- documented behaviour: "if (placement !== 'seeded_map' || !map ||
-- map.length === 0) return flat"), producing a wrong-but-plausible draw
-- with no error — exactly the "looks fine, isn't" failure class this
-- programme exists to close.
--
-- Two layers, doing two different jobs (F2 Task 6 review, "decide which
-- layer, say why, and make sure the other layer cannot be bypassed"):
--   1. apps/web's ProgressionSchema (api-v1/schemas.ts) already enforces
--      this at the REQUEST edge via a `.refine()` — every write that goes
--      through the API (CreateStage, PATCH, instantiateTemplate) already
--      400s/422s on this shape before it reaches SQL. That refine is
--      authoritative for anything this codebase's own usecases write.
--   2. This CHECK is defence in depth for anything that writes `stages`
--      directly — a future migration, a script, a manual `UPDATE` — which
--      ProgressionSchema cannot see or stop. Before this migration, layer 2
--      had a real gap: a shape Zod would reject was still accepted by the
--      database. After this migration, the same bad row (`placement:
--      "seeded_map"`, no/empty `map`) is rejected at BOTH layers — a direct
--      SQL write can no longer bypass the invariant Zod already enforces.
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
      -- `progression ? 'map'` guards the chain with a DEFINITE boolean
      -- (never NULL, unlike `jsonb_typeof(progression -> 'map')` when the
      -- key is simply ABSENT — `progression -> 'map'` on a missing key
      -- returns SQL NULL, and `jsonb_typeof(NULL) = 'array'` is NULL, not
      -- FALSE). Postgres CHECK constraints treat a NULL result as
      -- SATISFIED, not violated — verified empirically (isolated probe
      -- table, F2 Task 6 review): the `map` array present-but-empty case
      -- (`"map": []`) was already correctly rejected by
      -- `jsonb_array_length(...) >= 1` alone, but the `map` key ABSENT
      -- entirely (no key at all — the exact reproduction this migration
      -- exists to close) evaluated the whole AND-chain to NULL and the
      -- INSERT silently SUCCEEDED. `FALSE and <anything, even NULL>` is
      -- always FALSE in three-valued logic, so leading with `? 'map'`
      -- forces a real rejection instead of an accidental pass-through.
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
