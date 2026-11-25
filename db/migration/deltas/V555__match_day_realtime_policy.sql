-- V555 — Realtime Authorization: private `match-day:{codeId}` broadcast SELECT
--
-- Realtime push-nudges T2.1. A Match Day phone joins its code's private topic
-- `match-day:{codeId}` (`matchDayTopic` in apps/web/src/lib/realtime.ts) with
-- the subscriber JWT `mintMatchDayToken` mints:
-- `{ role: "authenticated", md_code_id }`. The server broadcasts a nudge there
-- (a reason and a stamp, never state). Without a SELECT policy the private
-- subscribe is refused.
--
-- Bind the topic to the minted claim so a token for code A cannot join code
-- B. The claim is the Match Day family's own: never `capture_pairing_id`
-- (V554), `fixture_id` (V403) or `lobby_fixture_id` (V452), so no other
-- family's token reads a match-day topic and a Match Day token reads none of
-- theirs (the V452 rule: one claim name per policy). Whether to mint at all
-- stays the Match Day door's decision; this is the Realtime-side bind.
--
-- Shape: V554's, verbatim — V403's guards and exception handling, and V537's
-- wrapped `(select realtime.topic())`, evaluated once per statement rather
-- than per row (Supabase lint 0003).
--
-- A blank claim binds nothing: `nullif(…, '')` turns `''` into null, so a
-- token with `md_code_id: ""` cannot read the bare `match-day:` topic
-- (`'match-day:' || null` is null, and null = topic is never true). The app's
-- mint and topic builder refuse a blank (or whitespace) id too; this is the
-- database half.
--
-- Guard: a non-Supabase Postgres (local labels, CI) has no `realtime` schema;
-- skip cleanly there. Idempotent if the policy is already present (applied by
-- hand first, or a re-run). Flyway may not own realtime.messages on Supabase:
-- skip on insufficient privilege rather than abort the run.
-- =============================================================================

do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V555: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1
    from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V555: realtime.messages missing — skip';
    return;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'match day code read by claim'
  ) then
    raise notice 'V555: policy already present — skip';
    return;
  end if;

  begin
    execute $sql$
      create policy "match day code read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and (select realtime.topic()) = ('match-day:' || nullif((select auth.jwt() ->> 'md_code_id'), ''))
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V555: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
