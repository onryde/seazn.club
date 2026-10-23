-- VERSION, re-pinned 2026-10-16 at the W2c rebase onto origin/main cf3e64977: written as V443 (main's
-- tail was V438; V439-V442 are chess's, on staging). Main has since merged V450__stream_runner_crash_count.sql,
-- and Flyway runs no out-of-order migrations here, so a V443 reaching a database that has applied V450 is
-- refused. Renumbered (not corrected forward: this delta has never run in production) to V462, past main's
-- V450 and the V451-V461 the chess session has reserved for its own deltas; then to V463 on 2026-10-18, because
-- r2 PR #981 holds V462 (V462__relay_composed_stream_input_b.sql) and merges first. Chess and r2 must still
-- merge first, or this moves again.
-- Then to V469 on 2026-10-23, at the pre-PR rebase onto origin/main 5c78df031a: chess and r2 have merged and main's
-- tail is V468__stream_runner_restart_tally.sql. Open PR #1005 also holds V469 (V469__all_stages_free.sql): whichever
-- merges second takes the next free number.
--
-- W2c (spec §4.3): a fixture's own match-format override — engine ruleKeys of
-- scope "match" only, written by writeFixtureRulesOverride alone. Null = the
-- fixture plays its stage's rules. Greenfield (spec §11): nullable, no default,
-- no backfill.
alter table fixtures add column if not exists rules_override jsonb;
-- W2c P-1 (spec §4.5 item 2): bumped ONLY by a Q11 correction or a staff re-freeze
-- (refreezeFixture). A scoring pad sends it with each event; append-event refuses a
-- stale one FIXTURE_RULES_CHANGED. Senders that omit it are never checked.
alter table fixtures add column if not exists rules_version int not null default 0;
comment on column fixtures.rules_override is
  'W2c: match-scoped rule override (engine ruleKeys scope "match"). Resolved as '
  'snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override); frozen '
  'into config_snapshot with everything else at the first event.';
comment on column fixtures.rules_version is
  'W2c: incremented by a rules correction or staff re-freeze only; checked at append time when the sender includes it.';

-- Rebase ruling D2 (2026-10-23): an OPENED online-chess round locks its stage's rules, exactly as a played match does.
-- Online (Lichess) chess appends no event and freezes no config_snapshot until a result lands, so the PLAYED half of
-- the stage-lock predicate (apps/web/src/server/usecases/rule-locks.ts `lockedStageIdsAmong`) cannot see a round whose
-- players are already invited on the division's clock. The predicate runs inside withTenant (role app_user), and
-- stage_round_opens is sealed (V451: FORCE RLS, no app_user policy, no grant), so it reads the open through this
-- function: security definer + pinned search_path (the V306/V451 shape), returning only stage ids.
--   * Scoped to the transaction's tenant (`app.current_org`, which withTenant sets before it drops to app_user):
--     another organisation's open is never reported. A transaction with no tenant set is a privileged one (the pool's
--     own role, which reads stage_round_opens directly anyway): it is answered unscoped, so the lock is the lock there
--     too - never an empty "nothing opened" (rule-locks-opened-round.test.ts pins both).
--   * Monotonic like the rest of the predicate: a re-open re-stamps the row (opened_at moves) and nothing in the app
--     deletes one; it goes only with its stage (on delete cascade).
create function stage_ids_with_opened_round(p_stage_ids uuid[]) returns setof uuid
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
    select distinct o.stage_id
      from stage_round_opens o
     where o.stage_id = any(p_stage_ids)
       and (nullif(current_setting('app.current_org', true), '') is null
            or o.org_id = nullif(current_setting('app.current_org', true), '')::uuid)
$$;

revoke all on function stage_ids_with_opened_round(uuid[]) from public;
grant execute on function stage_ids_with_opened_round(uuid[]) to app_user;
