-- W2b (spec §5.4; plan D12, D13). V438: main reached V437 (capture_records) while W2b was open, so this delta,
-- first V435 (C-9), was renumbered at Task 18 Step 1. RENUMBER AGAIN AT MERGE if main has moved; the tests read
-- this file by glob.
--
-- 1) Re-classify every UNSETTLED held bracket fixture whose ACTIVE result is the legacy chess double forfeit
--    (`boardgame.result{method:"double_forfeit"}`, retired by D15): it is now a double walkover (BG-DW-1), never
--    held. "Active" is the latest boardgame.result no core.void targets — a voided double forfeit followed by an
--    agreed draw is a real held level result and stays held. Settled rows keep their settle (plan D6). This block
--    seats nobody: the cascade is TypeScript, so the notice names every stage it touched (`stages=<id,…>`) and the
--    one-off apps/web/src/server/migration/w2b-double-walkover-resolve.ts resolves exactly those (plan D12, loop-F
--    ruling I-4; production's count is expected to be 0, ruling 104). The update names `status`, so
--    fixtures_track_finished fires; needs_decision and forfeited are both in its finished set (V432), so the moved
--    rows KEEP their finished_at.
-- 2) division_has_results counts only results with a verdict (W2b-R13): no_result and double_walkover never charge
--    the divisions.per_competition.max quota slot, whatever the status (a decided no_result included — V432's
--    unconditional decided/finalized/forfeited arm charged it). Redefined with create or replace, as V432 redefined
--    V355's; V355's header (STABLE, SECURITY INVOKER) still applies. Its status arms are unchanged, so V432's partial
--    index fixtures_division_results_idx still covers them (D13; the test reads the live definitions).
do $$
declare
  examined integer;
  changed integer;
  stage_list text;
begin
  create temporary table w2b_dw on commit drop as
    select f.id, f.stage_id from fixtures f join stages s on s.id = f.stage_id
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
  select count(*), coalesce(string_agg(distinct stage_id::text, ',' order by stage_id::text), '')
    into examined, stage_list from w2b_dw;
  update fixtures set status = 'forfeited', outcome = '{"kind":"double_walkover"}'::jsonb where id in (select id from w2b_dw);
  get diagnostics changed = row_count;
  raise notice 'W2b double walkover reclassify: examined=% changed=% stages=%', examined, changed, stage_list;
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
