-- W2b (spec §5.4; plan D12, D13). V438: main reached V437 (capture_records) while W2b was open, so this delta,
-- first V435 (C-9), was renumbered at Task 18 Step 1. RENUMBER AGAIN AT MERGE if main has moved; the tests read
-- this file by glob.
--
-- 1) FAIL CLOSED (Loop R M-6, W2b-R12): refuse to apply while any UNSETTLED held bracket fixture's ACTIVE result is
--    the legacy chess double forfeit (`boardgame.result{method:"double_forfeit"}`, retired by D15). BG-DW-1 now folds
--    it to a double walkover, but a stored row cannot be re-classified safely here: the write would seat nobody (the
--    cascade is TypeScript), never ask whether the line is a final (X-DW-3), and leave match_states holding its
--    no_result. "Active" is the latest boardgame.result no core.void targets — a voided double forfeit followed by an
--    agreed draw is a real held level result, and is not counted. Settled rows keep their settle (plan D6) and are not
--    counted. Production's count is expected to be 0 (ruling 104; Task 17 runs the pre-ship counts): then this block
--    only says so. Otherwise it names every fixture and stage, and each is put right through the console before the
--    migration is run again: void its double forfeit, then record the double walkover (a forfeit by both sides), which
--    runs the cascade a stored re-classification cannot. A settle is no way out: over a double forfeit it is refused
--    (SETTLE_NOT_APPLICABLE, plan D6).
-- 2) division_has_results counts only results with a verdict (W2b-R13): no_result and double_walkover never charge
--    the divisions.per_competition.max quota slot, whatever the status (a decided no_result included — V432's
--    unconditional decided/finalized/forfeited arm charged it). Redefined with create or replace, as V432 redefined
--    V355's; V355's header (STABLE, SECURITY INVOKER) still applies. Its status arms are unchanged, so V432's partial
--    index fixtures_division_results_idx still covers them (D13; the test reads the live definitions).
do $$
declare
  examined integer;
  fixture_list text;
  stage_list text;
begin
  select count(*),
         coalesce(string_agg(f.id::text, ',' order by f.id::text), ''),
         coalesce(string_agg(distinct f.stage_id::text, ',' order by f.stage_id::text), '')
    into examined, fixture_list, stage_list
    from fixtures f join stages s on s.id = f.stage_id
   where s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder')
     and f.status = 'needs_decision'
     and exists (select 1 from score_events r
                  where r.fixture_id = f.id and r.type = 'boardgame.result' and r.payload->>'method' = 'double_forfeit'
                    and not exists (select 1 from score_events v where v.voids_event_id = r.id)
                    and r.seq = (select max(r2.seq) from score_events r2
                                  where r2.fixture_id = f.id and r2.type = 'boardgame.result'
                                    and not exists (select 1 from score_events v2 where v2.voids_event_id = r2.id)))
     and not exists (select 1 from score_events st
                      where st.fixture_id = f.id and st.type = 'core.settle'
                        and not exists (select 1 from score_events v3 where v3.voids_event_id = st.id));
  if examined > 0 then
    raise exception 'W2b legacy double forfeit held: examined=% fixtures=% stages=%', examined, fixture_list, stage_list
      using hint = 'In the console, void each fixture double forfeit and record the double walkover (a forfeit by both sides), then run the migration again (W2b-R12).';
  end if;
  raise notice 'W2b legacy double forfeit held: examined=0';
end $$;

create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and coalesce(f.outcome->>'kind', '') not in ('no_result', 'double_walkover')
         and (f.status in ('decided', 'finalized', 'forfeited')
              or (f.status in ('abandoned', 'needs_decision') and f.outcome is not null)))
  $$;
