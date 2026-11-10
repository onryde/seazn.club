-- V496 — W4 knockout app PR B, Task 6 (Q8, ruling 270; rules X-FR-5, X-FR-4 history half): a FINISHED knockout that played no
-- third-place match re-ranks its two semi-final losers to a SHARED 3rd. Spec docs/superpowers/specs/2026-11-04-format-matrix-w4-
-- knockout-design.md §11; plan docs/superpowers/plans/2026-11-05-w4-knockout-app-b.md Task 6. Numbered main's max + 1 when
-- written (V495 is sponsor_deals; V497 is swiss auto-advance): RENUMBER BY SUFFIX AT MERGE if main has moved, never reorder.
-- Its test reads this file by glob, never by number (apps/web/src/server/__tests__/w4b-migration.test.ts).
--
-- DATA CHANGE (LOUD). Engine 5.0.0 (W4) ranks a knockout's two semi-final losers LEVEL, 3rd (1, 2, 3, 3, 5 ...) where no play-off
-- decided it. Before W4 (engine 4.x and earlier) the engine ranked them 3rd and 4th by seed, and `writeSnapshot` (engine-db/competition.ts) stored
-- that once, at completion, in `standings_snapshots.rows` (pool null). Every snapshot reader (the standings API, the public
-- standings, the exports, officials sourcing, a progression's rank_range) reads the STORED rank, so a bracket that finished
-- before the deploy would keep its 4th until this delta runs. The champion needs no move: it is derived from the fixtures on
-- read (`champion.ts`), and no final was joint or vacant before W4.
--
-- What it changes: for each stage with kind = 'knockout' and status = 'complete' (V210), with a pool-null snapshot, with no PLAYED
-- third-place fixture (`third_place` V368, or an ext_key ending `-3p`; a voided or cancelled one does not count: it shares
-- 3rd, as the engine ranks it), whose semi-finals are the two non-play-off
-- fixtures of the round before the final, BOTH with a seated winner and loser on their outcome (an abandon award counts;
-- never a double walkover, never a bye), and whose snapshot holds exactly ONE row at rank 3 and exactly ONE at rank 4 and those two are the two semi-final
-- losers: the rank-4 row's "rank" becomes 3. `previous_rows`, `computed_through_seq`, `updated_at` and every other row are
-- untouched. Anything else is left as it is: a played play-off (3rd and 4th are real), a 2-entrant final-only bracket (ranks
-- 1, 2: there is no 3rd), n = 3 (one real semi-final: 1, 2, 3), a semi-final both sides walked over, a snapshot already
-- shared (a completion after the bump), and a snapshot whose rank-4 row is not a semi-final loser.
--
-- ── Pre-flight count (W4 app-B Task 0, prod read-only, owner-run 2026-11-07; stg 2026-11-07) ──
-- prod: 4 of 9 finished knockouts re-rank (2 x 4-draw, 2 x 8-draw; the 5 final-only brackets are untouched; 3 of the 4 sit in
-- completed competitions). stg: 0 of 1 (that one complete knockout has no pool-null snapshot: skipped, its ranks are derived on
-- read). The block COUNTS FIRST and reports what it found in NOTICEs, then writes, and reports the rows it changed.
--
-- ── Runbook ──
-- 1. Run BEFORE the W4 (engine 5+) app serves (prod.yml migrates before it deploys). One block: it commits whole or not at all.
--    DEPLOY WINDOW: a knockout completed by a still-serving pre-W4 instance AFTER this ran keeps a strict 3rd/4th (nothing
--    refreshes a completed snapshot but a correction). Re-run V496's predicate after the deploy: it is idempotent and safe.
-- 2. READ THE NOTICES (`W4 shared-3rd history: ...`). The role matters: standings_snapshots is FORCE ROW LEVEL SECURITY with a
--    policy `to app_user` only, so a role without BYPASSRLS counts 0, writes 0 and still exits clean. Flyway's migrating role
--    bypasses it; a hand re-run must use that role.
-- 3. Cached public documents turn over with the deploy; this delta does not touch `updated_at` on purpose (it is the
--    watermark of the completion, not of this correction).
--
-- Idempotent: a second run finds no rank-4 row left at a semi-final loser and changes none.
do $$
declare
  n_complete integer;
  n_no_snapshot integer;
  n_final_only integer;
  n_targets integer;
  n_changed integer;
begin
  create temp table if not exists w4_v496_targets (stage_id uuid primary key, rank4_entrant text not null) on commit drop;
  truncate w4_v496_targets;

  -- ═══ 1. Count first ═══
  select count(*) into n_complete from stages s where s.kind = 'knockout' and s.status = 'complete';
  select count(*) into n_no_snapshot
    from stages s
   where s.kind = 'knockout' and s.status = 'complete'
     and not exists (select 1 from standings_snapshots ss where ss.stage_id = s.id and ss.pool_id is null);
  -- a final-only bracket: its final is in the first round, so there is no semi-final round at all
  select count(*) into n_final_only
    from stages s
   where s.kind = 'knockout' and s.status = 'complete'
     and exists (select 1 from standings_snapshots ss where ss.stage_id = s.id and ss.pool_id is null)
     and not exists (
       select 1 from fixtures f
        where f.stage_id = s.id and f.third_place = false and (f.ext_key is null or f.ext_key not like '%-3p')
          and f.round_no < (select max(g.round_no) from fixtures g
                             where g.stage_id = s.id and g.third_place = false and (g.ext_key is null or g.ext_key not like '%-3p')));

  insert into w4_v496_targets (stage_id, rank4_entrant)
  with bracket as (
    select s.id as stage_id,
           (select max(g.round_no) from fixtures g
             where g.stage_id = s.id and g.third_place = false and (g.ext_key is null or g.ext_key not like '%-3p')) as final_round
      from stages s
     where s.kind = 'knockout' and s.status = 'complete'
       -- a PLAYED play-off decides 3rd and 4th (X-TP-3); a voided one (a third-place line that holds nobody and has no outcome, or a
       -- cancelled one) shares 3rd, as the engine ranks it (stage.js `playOff.status === "void"`) and `competition.ts` reads it
       and not exists (select 1 from fixtures p
                        where p.stage_id = s.id and (p.third_place or p.ext_key like '%-3p') and p.status <> 'cancelled'
                          and (p.outcome is not null or p.home_entrant_id is not null or p.away_entrant_id is not null))
  ),
  semis as (
    select b.stage_id, array_agg(f.outcome ->> 'loser' order by f.outcome ->> 'loser') as losers
      from bracket b
      join fixtures f on f.stage_id = b.stage_id and f.round_no = b.final_round - 1
                     and f.third_place = false and (f.ext_key is null or f.ext_key not like '%-3p')
     group by b.stage_id
    having count(*) = 2
       and count(*) filter (where f.outcome ->> 'winner' is not null and f.outcome ->> 'loser' is not null) = 2
       and count(distinct f.outcome ->> 'loser') = 2
  ),
  places as (
    select ss.stage_id,
           array_agg(e.r ->> 'entrantId') filter (where (e.r ->> 'rank')::integer = 3) as r3,
           array_agg(e.r ->> 'entrantId') filter (where (e.r ->> 'rank')::integer = 4) as r4
      from standings_snapshots ss
      cross join lateral jsonb_array_elements(ss.rows) as e(r)
     where ss.pool_id is null
     group by ss.stage_id
  )
  select p.stage_id, p.r4[1]
    from places p join semis m on m.stage_id = p.stage_id
   where cardinality(p.r3) = 1 and cardinality(p.r4) = 1
     and (select array_agg(x order by x) from unnest(p.r3 || p.r4) as x) = m.losers;
  select count(*) into n_targets from w4_v496_targets;

  raise notice 'W4 shared-3rd history: % finished knockout stage(s) counted', n_complete;
  raise notice 'W4 shared-3rd history: % complete with no standings snapshot: skipped (their ranks are derived on read)', n_no_snapshot;
  raise notice 'W4 shared-3rd history: % final-only (no semi-final, no 3rd place): untouched', n_final_only;
  raise notice 'W4 shared-3rd history: % to re-rank to a shared 3rd (ruling 270)', n_targets;

  -- ═══ 2. Write ═══
  update standings_snapshots ss
     set rows = (
       select jsonb_agg(case when e.r ->> 'entrantId' = t.rank4_entrant then jsonb_set(e.r, '{rank}', '3'::jsonb) else e.r end
                        order by e.ord)
         from jsonb_array_elements(ss.rows) with ordinality as e(r, ord))
    from w4_v496_targets t
   where ss.stage_id = t.stage_id and ss.pool_id is null;
  get diagnostics n_changed = row_count;
  raise notice 'W4 shared-3rd history: % snapshot(s) re-ranked', n_changed;
  raise notice 'W4 shared-3rd history: % finished knockout(s) left as they are (a played play-off, n = 3, a walked-over semi-final, already shared, or not matching)',
    n_complete - n_no_snapshot - n_final_only - n_targets;
end
$$;
