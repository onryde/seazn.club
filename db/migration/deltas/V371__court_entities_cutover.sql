-- =============================================================================
-- V371 — Court entities cutover (P9 pass 1/5): stored-config migration.
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
--
-- Non-array `courts` (present-but-wrong-shaped: json null, a string, an
-- object): normalized to `[]` INSIDE step 5's rewrite (folded into the
-- same UPDATE that resolves string court names to real ids — see step 5's
-- comment), not by a separate up-front write. This is the READ-PATH TRAP
-- the whole migration exists to close, not tidiness — `ScheduleConfig.
-- courts`'s `.default([])` only substitutes for an ABSENT key
-- (`undefined`); it never fires for a present value of the wrong shape, so
-- an un-normalized `courts: null` (or a string/object) is a live 500 at
-- ScheduleConfig.parse. How many rows this will touch is precomputed
-- read-only in step 2b and surfaced in step 3's dry-run report (as
-- `courts_field_to_normalize`) BEFORE step 5 — or any other write — runs;
-- see "Dry-run/write agreement" below. Idempotent: once normalized, the
-- value is jsonb type "array", so a second run's rewrite reproduces `[]`.
--
-- Dry-run/write agreement (both blocks): the "does an active court/venue
-- already exist with this name" lookup is computed exactly ONCE per block
-- (court_strings_status.existing_court_id / venue_strings_status.
-- existing_venue_id) and both the dry-run report and the write loop read
-- that single precomputed column, so the two cannot independently drift —
-- by construction, not by keeping two hand-written predicates in sync.
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
  v_total_to_normalize int := 0;
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

  -- 2) Precompute, ONCE, both the reuse-vs-create status AND (when it
  -- already exists) the actual court id per string (read-only, pre-write).
  -- Both the dry-run report (step 3) and the write loop (step 4) read this
  -- single computation — see header "Dry-run/write agreement" — instead of
  -- each re-deriving their own copy of "does an active court with this
  -- name already exist", so the two can never disagree.
  drop table if exists pg_temp.court_strings_status;
  create temp table court_strings_status as
    select cs.org_id, cs.court_string,
           m.id as existing_court_id,
           m.id is not null as already_exists
      from court_strings cs
      left join lateral (
        select c.id
          from courts c
         where c.org_id = cs.org_id
           and c.name = cs.court_string
           and c.archived_at is null
         limit 1
      ) as m on true;

  -- 2b) Precompute, read-only, the count of schedule_settings rows whose
  -- `courts` value is PRESENT but the wrong shape (json null, a bare
  -- string, a number, a bool, or an object) — these get reset to `[]` by
  -- step 5 below, folded into that same rewrite rather than a separate
  -- pre-write pass (see step 5 and the header's "Non-array courts" note).
  -- That reset is itself a write the operator should see coming — a report
  -- that only covers string-to-id counts and stays silent about a row
  -- whose non-array value is about to be discarded undercounts what the
  -- migration actually does, so it is precomputed here (before step 3, the
  -- report) and folded into that report below. NOTE this table is a
  -- reporting-only count, unlike court_strings_status above: step 5 does
  -- NOT read it back, it re-evaluates the identical `? 'courts' and
  -- jsonb_typeof(...) <> 'array'` predicate inline via its own CASE. The
  -- two are duplicated text, not a shared computation — safe only because
  -- the predicate is a trivial, deterministic shape check with no "pick
  -- one among ties" ambiguity (unlike the by-name reuse lookup, which IS
  -- shared for exactly that reason — see "Dry-run/write agreement" below).
  drop table if exists pg_temp.court_normalize_status;
  create temp table court_normalize_status as
    select ss.org_id, count(*) as n
      from schedule_settings ss
     where ss.config ? 'courts'
       and jsonb_typeof(ss.config -> 'courts') <> 'array'
     group by ss.org_id;

  -- 3) DRY-RUN REPORT — emitted BEFORE the first write (the safety property
  -- of this whole session, per the P9 dispatch). Driven off a FULL OUTER
  -- JOIN of court_strings_status and court_normalize_status, not off
  -- court_strings_status alone — an org whose ONLY pending write is the
  -- non-array normalization (zero court strings anywhere) would otherwise
  -- never appear in this loop at all, which is the same "report undercounts
  -- a write" defect as omitting the column.
  for v_org in
    select coalesce(css.org_id, cns.org_id) as org_id,
           coalesce(css.n_strings, 0) as n_strings,
           coalesce(css.n_to_create, 0) as n_to_create,
           coalesce(cns.n, 0) as n_to_normalize
      from (
        select org_id,
               count(*) as n_strings,
               count(*) filter (where not already_exists) as n_to_create
          from court_strings_status
         group by org_id
      ) css
      full outer join court_normalize_status cns on cns.org_id = css.org_id
     order by 1
  loop
    raise notice 'V371 court migration (dry run): org=% distinct_court_strings=% courts_to_create=% courts_field_to_normalize=%',
      v_org.org_id, v_org.n_strings, v_org.n_to_create, v_org.n_to_normalize;
    v_total_orgs := v_total_orgs + 1;
    v_total_strings := v_total_strings + v_org.n_strings;
    v_total_to_create := v_total_to_create + v_org.n_to_create;
    v_total_to_normalize := v_total_to_normalize + v_org.n_to_normalize;
  end loop;
  raise notice 'V371 court migration (dry run) TOTAL: orgs=% distinct_court_strings=% courts_to_create=% courts_field_to_normalize=%',
    v_total_orgs, v_total_strings, v_total_to_create, v_total_to_normalize;

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

  for v_row in
    select org_id, court_string, existing_court_id
      from court_strings_status
     order by org_id, court_string
  loop
    v_court_id := v_row.existing_court_id;

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
  -- is never added (WHERE guards on `? 'courts'`) — it keeps parsing
  -- through ScheduleConfig's default().
  --
  -- Also folds in the present-but-non-array normalization (json null, a
  -- bare string, a number, a bool, or an object -> `[]`) — the READ-PATH
  -- TRAP this migration exists to close, not tidiness: `ScheduleConfig.
  -- courts`'s `.default([])` only substitutes for an ABSENT key
  -- (`undefined`); it never fires for a present value of the wrong shape,
  -- so an un-normalized `courts: null` (or a string/object) is a live 500
  -- at ScheduleConfig.parse. This used to be a separate up-front UPDATE
  -- (former "step 0"), which is exactly what put a write BEFORE the step-3
  -- dry-run report — folding it into THIS statement (the CASE below
  -- substitutes `[]` for `jsonb_array_elements_text` when the stored value
  -- isn't already an array, so it iterates zero elements and the same
  -- `coalesce(..., '[]'::jsonb)` below lands the value on `[]`) makes the
  -- two behaviors one write instead of two, so they cannot independently
  -- drift out of order again. Idempotent: once a row is `[]` (or already a
  -- real-id array), a second run's CASE/rewrite reproduces the same value.
  update schedule_settings ss
     set config = jsonb_set(
       ss.config, '{courts}',
       coalesce((
         select jsonb_agg(resolved.court_id order by resolved.ord)
           from (
             select elem.ord, coalesce(cm.court_id, existing.id) as court_id
               from jsonb_array_elements_text(
                      case when jsonb_typeof(ss.config -> 'courts') = 'array'
                           then ss.config -> 'courts'
                           else '[]'::jsonb
                      end
                    ) with ordinality as elem(val, ord)
               left join court_mapping cm
                 on cm.org_id = ss.org_id and cm.court_string = elem.val
               left join courts existing
                 on existing.org_id = ss.org_id and existing.id::text = elem.val
           ) resolved
          where resolved.court_id is not null
       ), '[]'::jsonb)
     )
   where ss.config ? 'courts';

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

  -- Precompute, ONCE, both the reuse-vs-create status AND (when it already
  -- exists) the actual venue id per string — same "compute once, both
  -- consumers read it" discipline as the courts block's
  -- court_strings_status (see header "Dry-run/write agreement").
  drop table if exists pg_temp.venue_strings_status;
  create temp table venue_strings_status as
    select vs.org_id, vs.venue_string,
           m.id as existing_venue_id,
           m.id is not null as already_exists
      from venue_strings vs
      left join lateral (
        select v.id
          from venues v
         where v.org_id = vs.org_id
           and v.name = vs.venue_string
           and v.archived_at is null
         limit 1
      ) as m on true;

  -- DRY-RUN REPORT — before any write, same discipline as the courts block.
  for v_org in
    select org_id, count(*) as n_strings, count(*) filter (where not already_exists) as n_to_create
      from venue_strings_status
     group by org_id
     order by org_id
  loop
    raise notice 'V371 fixture-venue migration (dry run): org=% distinct_venue_strings=% venues_to_create=%',
      v_org.org_id, v_org.n_strings, v_org.n_to_create;
    v_total_orgs := v_total_orgs + 1;
    v_total_strings := v_total_strings + v_org.n_strings;
    v_total_to_create := v_total_to_create + v_org.n_to_create;
  end loop;
  raise notice 'V371 fixture-venue migration (dry run) TOTAL: orgs=% distinct_venue_strings=% venues_to_create=%',
    v_total_orgs, v_total_strings, v_total_to_create;

  drop table if exists pg_temp.venue_mapping;
  create temp table venue_mapping (
    org_id uuid not null,
    venue_string text not null,
    venue_id uuid not null,
    primary key (org_id, venue_string)
  );

  for v_row in
    select org_id, venue_string, existing_venue_id
      from venue_strings_status
     order by org_id, venue_string
  loop
    v_venue_id := v_row.existing_venue_id;

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
