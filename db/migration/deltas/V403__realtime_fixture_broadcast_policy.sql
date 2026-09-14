-- =============================================================================
-- V403 — Realtime Authorization: private `fixture:{id}` broadcast SELECT
--
-- Spectator/scorepad tokens are minted outside Supabase Auth
-- (`mintPublicFixtureToken` in apps/web/src/lib/realtime.ts) with claims
-- `{ role: "authenticated", fixture_id }`. Private channels require a SELECT
-- policy on `realtime.messages` (Supabase Realtime Authorization). Without it,
-- subscribe fails with "no permissions to read from this Channel topic" even
-- when the JWT verifies against JWKS (proved 2026-09-13).
--
-- Bind the topic to the minted claim so a token for fixture A cannot join
-- fixture B. Entitlement remains enforced by the token route; this is the
-- Realtime-side bind.
--
-- Guard: local / non-Supabase Postgres has no `realtime` schema (Flyway
-- search_path is seazn_club; shared Supabase DBs do have `realtime`). Skip
-- cleanly there. Idempotent if the policy was applied by hand in the SQL
-- editor first.
-- =============================================================================

do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V403: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1
    from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V403: realtime.messages missing — skip';
    return;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'fixture broadcast read by claim'
  ) then
    raise notice 'V403: policy already present — skip';
    return;
  end if;

  -- `realtime.messages` is owned by `supabase_admin` on Supabase; if the
  -- Flyway role is not that owner, `create policy` raises `insufficient_
  -- privilege` — uncaught, that ABORTS the whole Flyway run and blocks every
  -- later delta. Skip cleanly instead, matching the existence-check style
  -- above: this delta is best-effort on a schema Flyway does not own.
  begin
    execute $sql$
      create policy "fixture broadcast read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and realtime.topic() = ('fixture:' || (select auth.jwt() ->> 'fixture_id'))
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V403: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
