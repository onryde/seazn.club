-- V417 — a round-robin REST BYE is not a recorded result (#850).
--
-- Since #850 (owner ruling 2026-09-23) an odd league/group persists one bye
-- row per round at GENERATION: one seat filled, `status = 'forfeited'`,
-- `outcome = {"kind":"award","winner":<the seated entrant>}` — the same shape
-- as a Swiss sit-out, but it scores nothing and is never a match anyone plays
-- (lib/fixture-bye.ts `isRestBye`, `REST_BYE_STAGE_KINDS`).
--
-- V354/V355's `division_has_results` matched it on `status = 'forfeited'`, so
-- a freshly generated odd league — nothing played — read as "has results":
-- `deleteDivision` refused it (DIVISION_HAS_RESULTS), and archiving it still
-- held a paid division slot (the quota count, `division-slots.ts`,
-- admin-divisions.ts). A 4-entrant league deleted cleanly beside it (review
-- 2026-09-23, finding 2). This excludes exactly the rest-bye rows and nothing
-- else; every other clause of V355 is unchanged and deliberate.
--
-- WHAT IS A REST BYE, IN SQL. The row conditions are `restByeSql`'s
-- (apps/web/src/server/fixture-bye-sql.ts), which is itself the SQL twin of
-- the TypeScript predicate: the rest-bye MARKER on `ext_key` (the generator's
-- bye key, `[p{pool}-]rr-r{n}-bye` — stamped at creation by the generator and
-- the reconciler only), an `award` naming a winner, EXACTLY one seat filled,
-- that seat the winner, in a stage whose kind is a round-robin one. The row
-- shape alone NEVER decides it (owner ruling 2026-09-24, fourth round): a fed
-- league's walkover — a qualifier departed before the draw, `awardSeededByes`
-- settled their line to the opponent — has the same shape, keeps its match
-- key, and IS a result. A migration cannot bind the TypeScript constants, so
-- the kinds — `('league', 'group')` — and the marker pattern —
-- `'(^|-)rr-r[0-9]+-bye$'`, `REST_BYE_EXT_KEY_PATTERN` verbatim — are written
-- here, and `division-has-results-rest-bye.test.ts` pins both: the kinds to
-- `REST_BYE_STAGE_KINDS` over EVERY engine stage kind, the marker to
-- `isRestBye` over marked and unmarked keys, both directions, so neither can
-- drift silently.
--
-- What deliberately still counts:
--   * a Swiss sit-out and a bracket bye — both are wins that move a table or a
--     draw (their pre-#850 behaviour; not this migration's to change);
--   * a fed league's walkover (above) — the bye's shape without the marker;
--   * a TWO-SIDED award in a league — a walkover or retirement is a result;
--   * a one-seated award whose seat is NOT the winner — not a bye by the
--     predicate, so not exempt.
--
-- NULL-SAFE for the same reason `restByeSql` is: the exemption is wrapped in
-- `coalesce(…, false)` so a row whose `outcome` or `ext_key` is NULL can never
-- turn the whole `and not (…)` into NULL and fall out of the EXISTS.
--
-- STABLE / SECURITY INVOKER / the V355 partial index: all unchanged. The
-- index predicate is still implied by the status clause, so the planner keeps
-- using it; the rest-bye test only narrows the rows it already found.
create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and (f.status in ('decided', 'finalized', 'forfeited')
              or (f.status = 'abandoned'
                  and f.outcome is not null
                  and f.outcome->>'kind' <> 'no_result'))
         and not coalesce((
               f.ext_key ~ '(^|-)rr-r[0-9]+-bye$'
               and f.outcome ->> 'kind' = 'award'
               and (f.home_entrant_id is null) <> (f.away_entrant_id is null)
               and f.outcome ->> 'winner' = coalesce(f.home_entrant_id, f.away_entrant_id)::text
               and exists (
                 select 1 from stages rest_bye_stage
                  where rest_bye_stage.id = f.stage_id
                    and rest_bye_stage.kind in ('league', 'group'))
             ), false))
  $$;
