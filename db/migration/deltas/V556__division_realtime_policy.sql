-- V556 — Realtime Authorization: private `division:{divisionId}` broadcast SELECT
--
-- Realtime push-nudges T3.1. A public competition page joins the private topic
-- `division:{divisionId}` (`divisionTopic` in apps/web/src/lib/realtime.ts) of
-- each of its divisions with ONE subscriber JWT, which `mintDivisionToken`
-- mints: `{ role: "authenticated", division_ids: [...] }` — a jsonb array, even
-- for one division. The server broadcasts a nudge there (a reason and a stamp,
-- never state). Without a SELECT policy the private subscribe is refused.
--
-- Bind the topic to the minted list: the id after `division:` must be an
-- ELEMENT of the array (jsonb `?`, an exact string match), so a token for A
-- reads neither `division:AB` nor `division:A:x`, and a division token reads
-- only the divisions it lists. The claim is the division family's own: never
-- `capture_pairing_id` (V554), `md_code_id` (V555), `fixture_id` (V403) or
-- `lobby_fixture_id` (V452), so no other family's token reads a division topic
-- and a division token reads none of theirs (the V452 rule: one claim name per
-- policy). Whether to mint at all stays the competition door's decision; this
-- is the Realtime-side bind.
--
-- Three guards on top of the design's predicate:
--   - `like 'division:%'` first: `substr(topic, 10)` of `match-day:A` is `A`,
--     so without the prefix a division token for A would read it;
--   - the claim must be an ARRAY (`jsonb_typeof`): jsonb `?` also answers yes
--     for a scalar string equal to the id (`'"A"' ? 'A'`) and for an object
--     KEY (`'{"A":1}' ? 'A'`), so a scalar or object claim would otherwise bind;
--   - a blank id binds nothing: `substr('division:', 10)` is `''`, and
--     `[""] ? ''` is true, so `nullif(…, '')` turns it into null (`? null` is
--     null, never true) and a `[""]` token cannot read the bare `division:`
--     topic. The app's mint and topic builder refuse a blank (or whitespace)
--     id too; this is the database half.
--
-- Shape: V554's and V555's — V403's guards and exception handling, and V537's
-- wrapped `(select realtime.topic())` and claim read, each evaluated once per
-- statement rather than per row (Supabase lint 0003).
--
-- Guard: a non-Supabase Postgres (local labels, CI) has no `realtime` schema;
-- skip cleanly there. Idempotent if the policy is already present (applied by
-- hand first, or a re-run). Flyway may not own realtime.messages on Supabase:
-- skip on insufficient privilege rather than abort the run.
-- =============================================================================

do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V556: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1
    from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V556: realtime.messages missing — skip';
    return;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'division read by claim'
  ) then
    raise notice 'V556: policy already present — skip';
    return;
  end if;

  begin
    execute $sql$
      create policy "division read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and (select realtime.topic()) like 'division:%'
        and jsonb_typeof((select auth.jwt() -> 'division_ids')) = 'array'
        and (select auth.jwt() -> 'division_ids') ? nullif(substr((select realtime.topic()), 10), '')
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V556: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
