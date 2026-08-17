-- =============================================================================
-- V368 — Court entities cutover (P9 pass 1/5): stored-config migration.
--
-- V367 (P8) added the venues/courts/court_hours/court_exceptions tables and
-- `fixtures.court_id`, but touched zero consumers — `schedule_settings.config
-- courts[]` and `fixtures.court_label` were, and still are at that point,
-- free-text strings. This migration is the compatibility strategy itself
-- (design doc "Stored-config migration"): after it runs, every stored
-- schedule config's `courts[]` holds real `courts.id` values, every fixture
-- with a `court_label` also carries the matching `court_id`, and every
-- fixture with a free-text `venue` also carries a matching `venue_id`. The
-- code switch (schemas.ts, same PR) then requires courts[] to be real ids —
-- no permanent tolerant string union.
--
-- `court_label` and `venue` are LEFT POPULATED (read-only legacy columns) —
-- dropping them is V-c, a later PR after a green soak (design doc "Migration
-- order").
--
-- FALSE PREMISE FOUND & CORRECTED IN-SESSION (_RULES.md §1: "fix in-session
-- if inside the stated file set"): the design's "competition free-text
-- venue... tournaments.venue_id" step names a `tournaments` table that does
-- not exist in the live v2 schema — `\d tournaments` on this database
-- returns nothing, though `flyway_schema_history` still remembers V011
-- ("tournaments") and V109 ("venue" on tournaments) as successfully applied:
-- the v1->v2 cutover dropped the v1 `tournaments` table (replaced by
-- `competitions`/`divisions`/`stages`/`fixtures`) without erasing that
-- history. `competitions` carries no free-text venue column at all. The one
-- surviving free-text venue field in the live schema is `fixtures.venue`
-- (V214__fixtures.sql: "scheduled_at timestamptz, venue text, court_label
-- text") — a per-fixture sibling of `court_label`, already scoped at the
-- same grain `court_label`/`court_id` are. This migration backfills
-- `fixtures.venue_id` from `fixtures.venue`, mirroring `court_label`/
-- `court_id` exactly (same table, same pattern, same reasoning), instead of
-- the nonexistent `tournaments.venue_id`.
--
-- Both DO blocks below are bounded by `-- <name>:begin` / `-- <name>:end`
-- comment markers so
-- apps/web/src/server/__tests__/court-entities-migration.test.ts can extract
-- and re-run each one directly via `sql.unsafe()` against hand-seeded rows
-- (the sponsor-crm-migration.test.ts technique) — this is what actually
-- proves the migration's DATA logic (reuse-vs-create, order/duplicate
-- preservation, idempotency), independently of `db:apply` ever having run.
--
-- Idempotency (both blocks): a second run must not re-treat its own uuid
-- output as a raw name to re-migrate. The courts block guards this by
-- excluding, from BOTH collection sources, any string that already equals a
-- real `courts.id` for that org (checked referentially via
-- `courts.id::text = <string>`, not by uuid-shape regex) — and the rewrite
-- step passes such an element through unchanged rather than dropping it, so
-- a config already on real ids is left byte-identical. The fixture-venue
-- block is naturally idempotent: it only ever collects rows where
-- `venue_id is null`, so a second run finds nothing to do.
-- =============================================================================

-- Competition free-text venue analogue: fixtures.venue -> fixtures.venue_id.
-- Composite FK to (id, org_id) mirrors V367's fixtures.court_id pattern
-- exactly (same table, same "history must not silently vanish" reasoning,
-- same deferral for multi-statement delete ordering within one explicit
-- transaction — see V367's header for why deferral does NOT help a single
-- statement's own cascade fan-out).
alter table fixtures add column venue_id uuid;
alter table fixtures
  add foreign key (venue_id, org_id) references venues (id, org_id)
  on delete restrict deferrable initially deferred;
create index fixtures_venue_idx on fixtures(venue_id);

-- courts-migration:begin
do $$
declare
  v_org record;
  v_row record;
  v_venue_id uuid;
  v_court_id uuid;
  v_total_orgs int := 0;
  v_total_strings int := 0;
  v_total_to_create int := 0;
begin
  -- 1) Collect distinct (org_id, string) pairs from both sources, blank-
  -- filtered, excluding any string that already equals a real court id for
  -- that org (idempotency — see header).
  drop table if exists pg_temp.court_strings;
  create temp table court_strings as
    select distinct ss.org_id, elem as court_string
      from schedule_settings ss,
           lateral jsonb_array_elements_text(ss.config -> 'courts') as elem
     where jsonb_typeof(ss.config -> 'courts') = 'array'
       and elem is not null and elem <> ''
       and not exists (
         select 1 from courts c2 where c2.org_id = ss.org_id and c2.id::text = elem
       )
    union
    select distinct f.org_id, f.court_label as court_string
      from fixtures f
     where f.court_label is not null and f.court_label <> ''
       and not exists (
         select 1 from courts c2 where c2.org_id = f.org_id and c2.id::text = f.court_label
       );

  -- 2) Precompute reuse-vs-create status per string (read-only, pre-write) —
  -- feeds the dry-run report below and is reused by the write loop.
  drop table if exists pg_temp.court_strings_status;
  create temp table court_strings_status as
    select cs.org_id, cs.court_string,
           exists (
             select 1 from courts c
              where c.org_id = cs.org_id
                and c.name = cs.court_string
                and c.archived_at is null
           ) as already_exists
      from court_strings cs;

  -- 3) DRY-RUN REPORT — emitted BEFORE the first write (the safety property
  -- of this whole session, per the P9 dispatch).
  for v_org in
    select org_id,
           count(*) as n_strings,
           count(*) filter (where not already_exists) as n_to_create
      from court_strings_status
     group by org_id
     order by org_id
  loop
    raise notice 'V368 court migration (dry run): org=% distinct_court_strings=% courts_to_create=%',
      v_org.org_id, v_org.n_strings, v_org.n_to_create;
    v_total_orgs := v_total_orgs + 1;
    v_total_strings := v_total_strings + v_org.n_strings;
    v_total_to_create := v_total_to_create + v_org.n_to_create;
  end loop;
  raise notice 'V368 court migration (dry run) TOTAL: orgs=% distinct_court_strings=% courts_to_create=%',
    v_total_orgs, v_total_strings, v_total_to_create;

  -- 4) Build the mapping, reusing any existing ACTIVE court that already
  -- matches by name anywhere in the org (P8 may have shipped real venues —
  -- never duplicate them), else "Main venue" (reused by name if it already
  -- exists) + a new court.
  drop table if exists pg_temp.court_mapping;
  create temp table court_mapping (
    org_id uuid not null,
    court_string text not null,
    court_id uuid not null,
    primary key (org_id, court_string)
  );

  for v_row in select org_id, court_string from court_strings order by org_id, court_string loop
    select c.id into v_court_id
      from courts c
     where c.org_id = v_row.org_id
       and c.name = v_row.court_string
       and c.archived_at is null
     limit 1;

    if v_court_id is null then
      select id into v_venue_id
        from venues
       where org_id = v_row.org_id
         and name = 'Main venue'
         and archived_at is null
       limit 1;

      if v_venue_id is null then
        insert into venues (org_id, name) values (v_row.org_id, 'Main venue')
          returning id into v_venue_id;
      end if;

      insert into courts (venue_id, org_id, name, tags)
        values (v_venue_id, v_row.org_id, v_row.court_string, '{}')
        returning id into v_court_id;
    end if;

    insert into court_mapping (org_id, court_string, court_id)
      values (v_row.org_id, v_row.court_string, v_court_id);
  end loop;

  -- 5) Rewrite schedule_settings.config.courts: string[] -> uuid[]. Element
  -- order and duplicate cardinality are preserved (a duplicate string maps
  -- to a duplicate court id — this migration reshapes values, it does not
  -- change array semantics). Each element resolves via court_mapping (a raw
  -- name) OR, if it already equals a real court id for this org (idempotent
  -- re-run), passes through unchanged; an element that resolves neither way
  -- (blank/garbage) is dropped. A `courts` key that was absent to begin with
  -- is never added (WHERE guards on jsonb_typeof = 'array') — it keeps
  -- parsing through ScheduleConfig's default().
  update schedule_settings ss
     set config = jsonb_set(
       ss.config, '{courts}',
       coalesce((
         select jsonb_agg(resolved.court_id order by resolved.ord)
           from (
             select elem.ord, coalesce(cm.court_id, existing.id) as court_id
               from jsonb_array_elements_text(ss.config -> 'courts') with ordinality as elem(val, ord)
               left join court_mapping cm
                 on cm.org_id = ss.org_id and cm.court_string = elem.val
               left join courts existing
                 on existing.org_id = ss.org_id and existing.id::text = elem.val
           ) resolved
          where resolved.court_id is not null
       ), '[]'::jsonb)
     )
   where jsonb_typeof(ss.config -> 'courts') = 'array';

  -- 6) fixtures.court_id from court_label. Only rows with court_id still
  -- null are touched — already idempotent without any extra guard.
  update fixtures f
     set court_id = cm.court_id
    from court_mapping cm
   where cm.org_id = f.org_id
     and cm.court_string = f.court_label
     and f.court_id is null;
end $$;
-- courts-migration:end

-- fixture-venue-migration:begin
do $$
declare
  v_org record;
  v_row record;
  v_venue_id uuid;
  v_total_orgs int := 0;
  v_total_strings int := 0;
  v_total_to_create int := 0;
begin
  -- Collect distinct (org_id, free-text venue) pairs, blank-filtered,
  -- restricted to rows not yet backfilled (venue_id is null) — this alone
  -- makes the block idempotent: a second run finds nothing to collect.
  drop table if exists pg_temp.venue_strings;
  create temp table venue_strings as
    select distinct f.org_id, f.venue as venue_string
      from fixtures f
     where f.venue is not null and f.venue <> ''
       and f.venue_id is null
       and not exists (
         select 1 from venues v2 where v2.org_id = f.org_id and v2.id::text = f.venue
       );

  drop table if exists pg_temp.venue_strings_status;
  create temp table venue_strings_status as
    select vs.org_id, vs.venue_string,
           exists (
             select 1 from venues v
              where v.org_id = vs.org_id and v.name = vs.venue_string and v.archived_at is null
           ) as already_exists
      from venue_strings vs;

  -- DRY-RUN REPORT — before any write, same discipline as the courts block.
  for v_org in
    select org_id, count(*) as n_strings, count(*) filter (where not already_exists) as n_to_create
      from venue_strings_status
     group by org_id
     order by org_id
  loop
    raise notice 'V368 fixture-venue migration (dry run): org=% distinct_venue_strings=% venues_to_create=%',
      v_org.org_id, v_org.n_strings, v_org.n_to_create;
    v_total_orgs := v_total_orgs + 1;
    v_total_strings := v_total_strings + v_org.n_strings;
    v_total_to_create := v_total_to_create + v_org.n_to_create;
  end loop;
  raise notice 'V368 fixture-venue migration (dry run) TOTAL: orgs=% distinct_venue_strings=% venues_to_create=%',
    v_total_orgs, v_total_strings, v_total_to_create;

  drop table if exists pg_temp.venue_mapping;
  create temp table venue_mapping (
    org_id uuid not null,
    venue_string text not null,
    venue_id uuid not null,
    primary key (org_id, venue_string)
  );

  for v_row in select org_id, venue_string from venue_strings order by org_id, venue_string loop
    select id into v_venue_id
      from venues
     where org_id = v_row.org_id and name = v_row.venue_string and archived_at is null
     limit 1;

    if v_venue_id is null then
      insert into venues (org_id, name) values (v_row.org_id, v_row.venue_string)
        returning id into v_venue_id;
    end if;

    insert into venue_mapping (org_id, venue_string, venue_id)
      values (v_row.org_id, v_row.venue_string, v_venue_id);
  end loop;

  update fixtures f
     set venue_id = vm.venue_id
    from venue_mapping vm
   where vm.org_id = f.org_id
     and vm.venue_string = f.venue
     and f.venue_id is null;
end $$;
-- fixture-venue-migration:end
