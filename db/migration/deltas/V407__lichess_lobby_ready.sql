-- Ready clicks for the Lichess lobby. Both must be set before a challenge
-- is minted. Cleared when the 20s window is missed and the game never started.
alter table fixture_external_play
  add column if not exists white_ready_at timestamptz,
  add column if not exists black_ready_at timestamptz;

-- Private lobby channel `external-play:{fixtureId}`. Same skip rules as V403:
-- local Postgres has no realtime schema; Flyway may not own the table.
do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V407: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1 from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V407: realtime.messages missing — skip';
    return;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'external play lobby read by claim'
  ) then
    raise notice 'V407: policy already present — skip';
    return;
  end if;

  begin
    execute $sql$
      create policy "external play lobby read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.topic() = ('external-play:' || (select auth.jwt() ->> 'fixture_id'))
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V407: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
