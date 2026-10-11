-- V434 — private match-room channel external-play:{fixtureId} (amends the
-- unmerged V407; renamed because V407 sat below main's V431 and flyway.toml
-- sets no outOfOrder). Under the 2026-10-09 design this topic carries the
-- LIVE game, not just lobby readiness: our server is the only mover, so every
-- accepted move is broadcast here (RoomBroadcast, T10). The token still
-- carries lobby_fixture_id, NEVER fixture_id — V403's paid fixture:{id} score
-- policy reads fixture_id, and one claim name must not authorize both.
-- Writes come from the service role, which bypasses RLS; this policy is the
-- READ side, and it is the only thing stopping a player subscribing to
-- someone else's room.

-- Same skip rules as V403:
-- local Postgres has no realtime schema; Flyway may not own the table.
do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V434: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1 from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V434: realtime.messages missing — skip';
    return;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'external play lobby read by claim'
  ) then
    raise notice 'V434: policy already present — skip';
    return;
  end if;

  begin
    execute $sql$
      create policy "external play lobby read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and realtime.topic() = ('external-play:' || (select auth.jwt() ->> 'lobby_fixture_id'))
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V434: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
