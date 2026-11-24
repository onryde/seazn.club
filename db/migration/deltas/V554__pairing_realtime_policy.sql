-- V554 — Realtime Authorization: private `capture:{pairingId}` broadcast SELECT
--
-- Realtime push-nudges T1.1. A paired capture phone joins its pairing's
-- private topic `capture:{pairingId}` (`captureTopic` in
-- apps/web/src/lib/realtime.ts) with the subscriber JWT `mintCaptureToken`
-- mints: `{ role: "authenticated", capture_pairing_id }`. The server
-- broadcasts a nudge there (`nudgeMessage`: a reason and a stamp, never
-- state). Without a SELECT policy the private subscribe is refused.
--
-- Bind the topic to the minted claim so a token for pairing A cannot join
-- pairing B. The claim is the capture family's own: never `fixture_id`
-- (V403's paid score channel) and never `lobby_fixture_id` (V452's lobby), so
-- no other family's token reads a capture topic and a capture token reads
-- neither of theirs (the V452 rule: one claim name per policy). Whether to
-- mint at all stays the beat door's decision; this is the Realtime-side bind.
--
-- Shape: V403's guards and exception handling, and V537's wrapped
-- `(select realtime.topic())`, evaluated once per statement rather than per
-- row (Supabase lint 0003).
--
-- A blank claim binds nothing: `nullif(…, '')` turns `''` into null, so a
-- token with `capture_pairing_id: ""` cannot read the bare `capture:` topic
-- (`'capture:' || null` is null, and null = topic is never true). The app's
-- mint and topic builder refuse a blank id too; this is the database half.
--
-- Guard: a non-Supabase Postgres (local labels, CI) has no `realtime` schema;
-- skip cleanly there. Idempotent if the policy is already present (applied by
-- hand first, or a re-run). Flyway may not own realtime.messages on Supabase:
-- skip on insufficient privilege rather than abort the run.
-- =============================================================================

do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V554: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1
    from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V554: realtime.messages missing — skip';
    return;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'capture pairing read by claim'
  ) then
    raise notice 'V554: policy already present — skip';
    return;
  end if;

  begin
    execute $sql$
      create policy "capture pairing read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and (select realtime.topic()) = ('capture:' || nullif((select auth.jwt() ->> 'capture_pairing_id'), ''))
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V554: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
