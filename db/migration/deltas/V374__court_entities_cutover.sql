-- =============================================================================
-- V374 — Court entities cutover (P9 pass 1/5): stored-config migration.
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
  -- 1) Collect distinct (org_id, string, venue_hint) TRIPLES from both
  -- sources, blank-filtered, excluding any string that already equals a
  -- real court id for that org (idempotency — see header).
  --
  -- REVIEW (P9 dispatch #6): `venue_hint` is the free-text venue a
  -- FIXTURE's own court_label was seen with (`fixtures.venue`, blank/absent
  -- -> '') — the one signal this migration has, at this grain, for telling
  -- two identically-named courts in two different venues apart. Court names
  -- are unique only PER VENUE (`courts_venue_name_active_idx`, V367), so an
  -- org with "Court 1" in two halls needs this to avoid collapsing both
  -- onto one arbitrary court (see step 2's lateral, which used to match on
  -- name alone with no venue scoping and no order by). `config.courts[]`
  -- carries NO per-element venue at all — every row from that source is
  -- venue_hint = '' ("unknown"), which stays genuinely, unavoidably
  -- ambiguous when the same name exists in two venues (see step 2's
  -- deterministic-tie-break note); there is no data anywhere in the stored
  -- config to disambiguate it with.
  drop table if exists pg_temp.court_strings;
  create temp table court_strings as
    select distinct ss.org_id, elem as court_string, ''::text as venue_hint
      from schedule_settings ss,
           lateral jsonb_array_elements_text(ss.config -> 'courts') as elem
     where jsonb_typeof(ss.config -> 'courts') = 'array'
       and elem is not null and elem <> ''
       and not exists (
         select 1 from courts c2 where c2.org_id = ss.org_id and c2.id::text = elem
       )
    union
    select distinct f.org_id, f.court_label as court_string,
           coalesce(nullif(btrim(f.venue), ''), '') as venue_hint
      from fixtures f
     where f.court_label is not null and f.court_label <> ''
       and not exists (
         select 1 from courts c2 where c2.org_id = f.org_id and c2.id::text = f.court_label
       );

  -- 2) Precompute, ONCE, both the reuse-vs-create status AND (when it
  -- already exists) the actual court id per (string, venue_hint) — read-
  -- only, pre-write. Both the dry-run report (step 3) and the write loop
  -- (step 4) read this single computation — see header "Dry-run/write
  -- agreement" — instead of each re-deriving their own copy of "does an
  -- active court with this name already exist", so the two can never
  -- disagree.
  --
  -- REVIEW (P9 dispatch #6): two-tier match, VENUE-SCOPED first. `by_venue`
  -- fires only when `venue_hint` names a real, active venue for this org
  -- (by name — the only venue key a free-text `fixtures.venue` carries)
  -- that ALSO owns an active court with this exact name.
  -- `courts_venue_name_active_idx` is a UNIQUE index on (venue_id, name)
  -- among active courts, so once the venue is pinned this match is
  -- unambiguous BY CONSTRUCTION — no tie-break needed for it. `by_name` is
  -- the ORG-WIDE fallback, engaged whenever the venue-scoped match finds
  -- nothing (no venue_hint, a venue_hint naming no real venue, or a real
  -- venue with no court by this name) — this is the genuinely ambiguous
  -- case the dispatch asks to make deterministic rather than
  -- implementation-defined: with no venue to disambiguate by, two
  -- identically-named active courts in two different venues are
  -- indistinguishable from the string alone, so this picks the OLDEST
  -- active court by that name in the org (`created_at, id` ascending) —
  -- a reproducible, documented rule, not a guarantee of "the right one".
  -- `config.courts[]` strings (always venue_hint = '') always resolve
  -- through this fallback alone.
  drop table if exists pg_temp.court_strings_status;
  create temp table court_strings_status as
    select cs.org_id, cs.court_string, cs.venue_hint,
           coalesce(by_venue.id, by_name.id) as existing_court_id,
           coalesce(by_venue.id, by_name.id) is not null as already_exists
      from court_strings cs
      left join lateral (
        select c.id
          from venues v
          join courts c
            on c.venue_id = v.id and c.org_id = cs.org_id and c.archived_at is null
         where cs.venue_hint <> ''
           and v.org_id = cs.org_id and v.name = cs.venue_hint and v.archived_at is null
           and c.name = cs.court_string
         order by v.created_at asc, v.id asc
         limit 1
      ) as by_venue on true
      left join lateral (
        select c.id
          from courts c
         where c.org_id = cs.org_id
           and c.name = cs.court_string
           and c.archived_at is null
         order by c.created_at asc, c.id asc
         limit 1
      ) as by_name on true;

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
    raise notice 'V374 court migration (dry run): org=% distinct_court_strings=% courts_to_create=% courts_field_to_normalize=%',
      v_org.org_id, v_org.n_strings, v_org.n_to_create, v_org.n_to_normalize;
    v_total_orgs := v_total_orgs + 1;
    v_total_strings := v_total_strings + v_org.n_strings;
    v_total_to_create := v_total_to_create + v_org.n_to_create;
    v_total_to_normalize := v_total_to_normalize + v_org.n_to_normalize;
  end loop;
  raise notice 'V374 court migration (dry run) TOTAL: orgs=% distinct_court_strings=% courts_to_create=% courts_field_to_normalize=%',
    v_total_orgs, v_total_strings, v_total_to_create, v_total_to_normalize;

  -- 4) Build the mapping, reusing any existing ACTIVE court that already
  -- matches (venue-scoped first, then by name anywhere in the org — step
  -- 2's computation; P8 may have shipped real venues, never duplicate
  -- them), else create one.
  --
  -- REVIEW (P9 dispatch #6): a new court is minted under the venue_hint's
  -- OWN venue when it names a real, active venue for this org — the
  -- "venue-aware" half of the fix: a fixture's own recorded venue is
  -- followed when resurrecting a court for it, not dumped into a generic
  -- bucket regardless of what the data actually said. Falls back to "Main
  -- venue" (reused by name if it already exists) exactly as before when
  -- venue_hint is unknown ('') or names no real venue — `config.courts[]`
  -- strings always take this path.
  drop table if exists pg_temp.court_mapping;
  create temp table court_mapping (
    org_id uuid not null,
    court_string text not null,
    venue_hint text not null default '',
    court_id uuid not null,
    primary key (org_id, court_string, venue_hint)
  );

  for v_row in
    select org_id, court_string, venue_hint, existing_court_id
      from court_strings_status
     order by org_id, court_string, venue_hint
  loop
    v_court_id := v_row.existing_court_id;

    if v_court_id is null then
      v_venue_id := null;

      if v_row.venue_hint <> '' then
        select id into v_venue_id
          from venues
         where org_id = v_row.org_id
           and name = v_row.venue_hint
           and archived_at is null
         order by created_at asc, id asc
         limit 1;
      end if;

      if v_venue_id is null then
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
      end if;

      insert into courts (venue_id, org_id, name, tags)
        values (v_venue_id, v_row.org_id, v_row.court_string, '{}')
        returning id into v_court_id;
    end if;

    insert into court_mapping (org_id, court_string, venue_hint, court_id)
      values (v_row.org_id, v_row.court_string, v_row.venue_hint, v_court_id);
  end loop;

  -- 5) Rewrite schedule_settings.config.courts: string[] -> uuid[]. Element
  -- order and duplicate cardinality are preserved (a duplicate string maps
  -- to a duplicate court id — this migration reshapes values, it does not
  -- change array semantics). Each element resolves via court_mapping (a raw
  -- name — always the venue_hint = '' bucket: this source carries no
  -- per-element venue, see step 1) OR, if it already equals a real court id
  -- for this org (idempotent re-run), passes through unchanged; an element
  -- that resolves neither way (blank/garbage) is dropped. A `courts` key
  -- that was absent to begin with is never added (WHERE guards on
  -- `? 'courts'`) — it keeps parsing through ScheduleConfig's default().
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
                 on cm.org_id = ss.org_id and cm.court_string = elem.val and cm.venue_hint = ''
               left join courts existing
                 on existing.org_id = ss.org_id and existing.id::text = elem.val
           ) resolved
          where resolved.court_id is not null
       ), '[]'::jsonb)
     )
   where ss.config ? 'courts';

  -- 6) fixtures.court_id from court_label — venue-SCOPED to EACH fixture's
  -- OWN recorded venue (REVIEW, P9 dispatch #6): the join key now includes
  -- venue_hint, computed identically to step 1's collection
  -- (`coalesce(nullif(btrim(f.venue), ''), '')`), so a fixture whose
  -- court_label collides with another venue's court of the same name
  -- resolves to ITS OWN venue's court, never whichever one the org-wide
  -- lookup happened to prefer. Only rows with court_id still null are
  -- touched — already idempotent without any extra guard.
  update fixtures f
     set court_id = cm.court_id
    from court_mapping cm
   where cm.org_id = f.org_id
     and cm.court_string = f.court_label
     and cm.venue_hint = coalesce(nullif(btrim(f.venue), ''), '')
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
    raise notice 'V374 fixture-venue migration (dry run): org=% distinct_venue_strings=% venues_to_create=%',
      v_org.org_id, v_org.n_strings, v_org.n_to_create;
    v_total_orgs := v_total_orgs + 1;
    v_total_strings := v_total_strings + v_org.n_strings;
    v_total_to_create := v_total_to_create + v_org.n_to_create;
  end loop;
  raise notice 'V374 fixture-venue migration (dry run) TOTAL: orgs=% distinct_venue_strings=% venues_to_create=%',
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

-- =============================================================================
-- Division scope-locks migration (P9 pass-3a-FIX, owner-authorized this
-- session): `divisions.locked_scopes[].courts`/`.venues` were left as
-- organiser-typed free-text names by the two blocks above (out of scope for
-- pass 1 — see the FixtureLite doc comment on `court_label` in
-- usecases/schedule.ts, now deleted, that used to flag this). `scopeLocked`
-- matched them against `fixtures.court_label`/`.venue`, which stayed correct
-- right up until pass 3a stopped WRITING those columns — from that point a
-- name-keyed scope lock matches nothing, and an organiser's explicit
-- court/venue freeze silently stops doing anything, with no error anywhere to
-- surface it. `scopeLocked` itself now reads `court_id`/`venue_id` (same PR);
-- this block is what makes `locked_scopes` hold ids for it to read.
--
-- REUSES court_mapping/venue_mapping — the two blocks above build them as
-- session-scoped temp tables (default `CREATE TEMP TABLE` semantics: they
-- live for the whole session/script, not just their own DO block), so this
-- is not a third independent "does this name already exist" lookup. Same
-- "Dry-run/write agreement" discipline as the header above: the write below
-- re-derives the per-element resolution inline rather than reading a
-- materialized report table back — the `court_normalize_status` precedent
-- (step 2b) for why that duplication is safe (a trivial, deterministic
-- per-element check, not a "pick one among ties" lookup).
--
-- REVIEW WAVE 1, FINDING 12 (superseded — see the P9 dispatch #7-ADJACENT
-- note below; kept for the idempotency/shape reasoning, which still holds):
-- this block used to LEAVE an unmappable name in place, on the theory that a
-- scope lock only ever COMPARES its `courts`/`venues` (never renders them)
-- so a dangling name is "inert" against real ids from here on. It is not
-- inert: `LockInput` (usecases/history.ts) and `DivisionLocks`
-- (api-v1/schemas.ts) tighten `courts`/`venues` to CourtId/VenueId (real
-- uuids, same PR), and the console ECHOES a division's existing
-- `locked_scopes` back into the body of every lock PUT — so a stale name now
-- 400s that PUT, permanently, with no UI path to ever clear it. Wave 1's
-- fix was to DROP the unresolvable element rather than leave it in place.
--
-- P9 DISPATCH #7-ADJACENT ("treat the locked-scopes item like #7"): dropping
-- is itself worse than it looks. A scope object that named ONLY `courts`,
-- all of which turn out unmappable, collapses to `courts: []` —
-- indistinguishable from a scope that never restricted courts at all, so an
-- organiser's explicit freeze goes silently quieter with nothing durable
-- left behind to say a name went missing (the dry-run report is aggregate
-- counts in a migration log, not something an organiser using the product
-- will ever see). Same choice the blackout-court block below faces, same
-- answer this time: an unresolvable element is REDIRECTED to a lazily
-- created, per-org PLACEHOLDER court/venue instead of dropped — see that
-- block's own header for the full reasoning (it applies identically here);
-- the short version is that the placeholder is a real row (so
-- LockInput/DivisionLocks — real uuids — still parse it) that no division's
-- `config.courts`/real venue set ever contains and no fixture's
-- court_id/venue_id can ever equal, so redirecting to it can NEVER
-- retroactively change what `scopeLocked` reports for any real fixture
-- (ruling 3, candidate-courts.ts) — the freeze's ACTUAL reach is unchanged
-- either way (nothing real ever matched the stale name after the cutover,
-- drop or redirect), but the array element — and therefore the fact that
-- something here needs attention — now survives where an organiser (or a
-- later migration) can find it, instead of vanishing.
--
-- Idempotent, same shape as the two blocks above: an element already equal
-- to a real court/venue id for the org (a second run, post-migration, INCLUDING
-- the placeholder's own id) passes through via the same `id::text = <string>`
-- referential check court_mapping/venue_mapping themselves use (never a
-- uuid-shape regex); the placeholder itself is reused by name, never
-- recreated, on a second run. A scope object's `courts`/`venues` key that is
-- ABSENT to begin with is never added (mirrors the courts block's
-- `? 'courts'` guard); `pool_ids` is untouched throughout (already ids,
-- never free text).
-- =============================================================================

-- division-locked-scopes-migration:begin
do $$
declare
  v_org record;
  v_ph record;
  v_ph_venue_id uuid;
  v_ph_court_id uuid;
  v_total_orgs int := 0;
  v_total_divisions int := 0;
  v_total_court_entries int := 0;
  v_total_court_unmapped int := 0;
  v_total_venue_entries int := 0;
  v_total_venue_unmapped int := 0;
begin
  -- Read-only: every court/venue name-string entry inside every division's
  -- locked_scopes array, resolved against court_mapping/venue_mapping (or a
  -- direct real-id passthrough check) — reporting only, see header. An org
  -- whose only pending change lives here (zero court/venue strings anywhere
  -- else) would never appear in the two reports above, which is why this is
  -- its own report rather than folded into either. `cm.venue_hint = ''`:
  -- `locked_scopes[].courts` carries no per-element venue any more than
  -- `config.courts[]` does (step 1's own reasoning), so this always resolves
  -- through the venue_hint = '' bucket — without this filter a name that
  -- ALSO exists with a real venue_hint (from some fixture's own court_label)
  -- would join against BOTH court_mapping rows and silently fan out.
  drop table if exists pg_temp.division_scope_entries;
  create temp table division_scope_entries as
    select d.org_id, d.id as division_id, 'court' as kind, celem.val as raw_string,
           (cm.court_id is not null or c_existing.id is not null) as resolved
      from divisions d
           cross join lateral jsonb_array_elements(d.locked_scopes) as scope(obj)
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(scope.obj -> 'courts') = 'array'
                  then scope.obj -> 'courts' else '[]'::jsonb end
           ) as celem(val)
      left join court_mapping cm
        on cm.org_id = d.org_id and cm.court_string = celem.val and cm.venue_hint = ''
      left join courts c_existing
        on c_existing.org_id = d.org_id and c_existing.id::text = celem.val
     where jsonb_array_length(d.locked_scopes) > 0
    union all
    select d.org_id, d.id as division_id, 'venue' as kind, velem.val as raw_string,
           (vm.venue_id is not null or v_existing.id is not null) as resolved
      from divisions d
           cross join lateral jsonb_array_elements(d.locked_scopes) as scope(obj)
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(scope.obj -> 'venues') = 'array'
                  then scope.obj -> 'venues' else '[]'::jsonb end
           ) as velem(val)
      left join venue_mapping vm
        on vm.org_id = d.org_id and vm.venue_string = velem.val
      left join venues v_existing
        on v_existing.org_id = d.org_id and v_existing.id::text = velem.val
     where jsonb_array_length(d.locked_scopes) > 0;

  -- Lazily create ONE placeholder venue + court PER ORG that actually needs
  -- one (an org with nothing unresolved gets no placeholder rows at all —
  -- this must never fire unconditionally, or "N courts created" in any
  -- report/test would drift for every org regardless of whether this block
  -- had anything to redirect). Reused by name if either already exists
  -- (idempotent — a second run finds the same rows and creates nothing new;
  -- also converges with the blackout block below, which creates the exact
  -- same names independently if it runs first in the same session).
  drop table if exists pg_temp.scope_placeholder;
  create temp table scope_placeholder (
    org_id uuid primary key,
    venue_id uuid not null,
    court_id uuid not null
  );

  for v_ph in
    select distinct org_id from division_scope_entries where not resolved
  loop
    select id into v_ph_venue_id
      from venues
     where org_id = v_ph.org_id and name = 'Unmapped legacy references' and archived_at is null
     order by created_at asc, id asc
     limit 1;
    if v_ph_venue_id is null then
      insert into venues (org_id, name) values (v_ph.org_id, 'Unmapped legacy references')
        returning id into v_ph_venue_id;
    end if;

    select id into v_ph_court_id
      from courts
     where org_id = v_ph.org_id and venue_id = v_ph_venue_id
       and name = 'Unresolved legacy reference' and archived_at is null
     order by created_at asc, id asc
     limit 1;
    if v_ph_court_id is null then
      insert into courts (venue_id, org_id, name, tags)
        values (v_ph_venue_id, v_ph.org_id, 'Unresolved legacy reference', '{}')
        returning id into v_ph_court_id;
    end if;

    insert into scope_placeholder (org_id, venue_id, court_id)
      values (v_ph.org_id, v_ph_venue_id, v_ph_court_id);
  end loop;

  -- DRY-RUN REPORT — before any write, same discipline as the two blocks
  -- above. "unmapped" here now means "redirected to the org's placeholder",
  -- not "dropped" — see header.
  for v_org in
    select org_id,
           count(distinct division_id) as n_divisions,
           count(*) filter (where kind = 'court') as n_court_entries,
           count(*) filter (where kind = 'court' and not resolved) as n_court_unmapped,
           count(*) filter (where kind = 'venue') as n_venue_entries,
           count(*) filter (where kind = 'venue' and not resolved) as n_venue_unmapped
      from division_scope_entries
     group by org_id
     order by org_id
  loop
    raise notice 'V374 division-locked-scopes migration (dry run): org=% divisions_with_scope_entries=% court_scope_entries=% court_entries_redirected_unmapped=% venue_scope_entries=% venue_entries_redirected_unmapped=%',
      v_org.org_id, v_org.n_divisions, v_org.n_court_entries, v_org.n_court_unmapped, v_org.n_venue_entries, v_org.n_venue_unmapped;
    v_total_orgs := v_total_orgs + 1;
    v_total_divisions := v_total_divisions + v_org.n_divisions;
    v_total_court_entries := v_total_court_entries + v_org.n_court_entries;
    v_total_court_unmapped := v_total_court_unmapped + v_org.n_court_unmapped;
    v_total_venue_entries := v_total_venue_entries + v_org.n_venue_entries;
    v_total_venue_unmapped := v_total_venue_unmapped + v_org.n_venue_unmapped;
  end loop;
  raise notice 'V374 division-locked-scopes migration (dry run) TOTAL: orgs=% divisions_with_scope_entries=% court_scope_entries=% court_entries_redirected_unmapped=% venue_scope_entries=% venue_entries_redirected_unmapped=%',
    v_total_orgs, v_total_divisions, v_total_court_entries, v_total_court_unmapped, v_total_venue_entries, v_total_venue_unmapped;

  -- WRITE: rewrite each division's locked_scopes array in place, element by
  -- element, order AND cardinality now ALWAYS preserved (no element is ever
  -- dropped any more — see header). `stage`/`rewritten` below are computed
  -- once per scope object via LATERAL, then reused rather than re-evaluated,
  -- so the courts- and venues- rewrites cannot land on inconsistent
  -- snapshots of the same object.
  update divisions d
     set locked_scopes = coalesce((
       select jsonb_agg(rewritten.obj order by scope.ord)
         from jsonb_array_elements(d.locked_scopes) with ordinality as scope(obj, ord)
         cross join lateral (
           select
             -- P9 dispatch #7-adjacent: an element that resolves neither via
             -- court_mapping nor as an already-real id now falls through to
             -- this org's placeholder court (`ph.court_id`) — ALWAYS
             -- non-null once `scope_placeholder` holds a row for this org,
             -- which it does exactly when this division has at least one
             -- unresolved entry (the loop above). A `[null]` element (finding
             -- 14) resolves the identical way: `celem.val` is SQL NULL, never
             -- equal to anything, so it falls through to the placeholder too
             -- — same treatment as a stale name, not a special case.
             (case when scope.obj ? 'courts' then coalesce((
                      select jsonb_agg(to_jsonb(coalesce(cm.court_id, c_existing.id, ph.court_id)::text) order by celem.ord)
                        from jsonb_array_elements_text(
                               case when jsonb_typeof(scope.obj -> 'courts') = 'array'
                                    then scope.obj -> 'courts' else '[]'::jsonb end
                             ) with ordinality as celem(val, ord)
                        left join court_mapping cm
                          on cm.org_id = d.org_id and cm.court_string = celem.val and cm.venue_hint = ''
                        left join courts c_existing
                          on c_existing.org_id = d.org_id and c_existing.id::text = celem.val
                        left join scope_placeholder ph
                          on ph.org_id = d.org_id
                    ), '[]'::jsonb) end) as new_courts,
             (case when scope.obj ? 'venues' then coalesce((
                      select jsonb_agg(to_jsonb(coalesce(vm.venue_id, v_existing.id, ph.venue_id)::text) order by velem.ord)
                        from jsonb_array_elements_text(
                               case when jsonb_typeof(scope.obj -> 'venues') = 'array'
                                    then scope.obj -> 'venues' else '[]'::jsonb end
                             ) with ordinality as velem(val, ord)
                        left join venue_mapping vm
                          on vm.org_id = d.org_id and vm.venue_string = velem.val
                        left join venues v_existing
                          on v_existing.org_id = d.org_id and v_existing.id::text = velem.val
                        left join scope_placeholder ph
                          on ph.org_id = d.org_id
                    ), '[]'::jsonb) end) as new_venues
         ) stage
         cross join lateral (
           select
             (case when stage.new_courts is not null
                   then jsonb_set(scope.obj, '{courts}', stage.new_courts)
                   else scope.obj end)
             || (case when stage.new_venues is not null
                      then jsonb_build_object('venues', stage.new_venues)
                      else '{}'::jsonb end)
             as obj
         ) rewritten
     ), '[]'::jsonb)
   where jsonb_array_length(d.locked_scopes) > 0;
end $$;
-- division-locked-scopes-migration:end

-- =============================================================================
-- Blackout court-name migration (P9 pass 4c, owner-authorized this session):
-- `schedule_settings.config.blackouts[].court` was left a free-text court
-- NAME by the courts-migration block above (out of scope for pass 1). The
-- SAME config row's `courts` array already holds real ids from that block,
-- so a court-scoped blackout could no longer match the court it named from
-- that point on — silently global or inert depending on the reader.
-- schemas.ts (same PR) tightens `blackouts[].court` to CourtId, which makes
-- this migration required reading for any org with a court-scoped blackout,
-- not optional cleanup.
--
-- REUSES court_mapping — built by the courts-migration block above as a
-- session-scoped temp table (default `CREATE TEMP TABLE` semantics: it lives
-- for the whole session/script, not just its own DO block), so this is not a
-- third independent "does this name already exist" lookup. This block does
-- NOT feed blackout court strings back into court_strings/court_mapping's
-- own collection-and-create phase (steps 1-4 above): a blackout referencing
-- a name no fixture or `courts[]` entry ever used has no business silently
-- minting a brand-new REAL court that a future solve could then place a
-- fixture on. It only ever probes the mapping that already exists, exactly
-- like the division-locked-scopes block above does for a scope's own
-- `courts`/`venues` entries.
--
-- REVIEW WAVE 1, FINDINGS 2 & 14 (superseded — see P9 DISPATCH #7 below for
-- the current answer; kept for the 500/widen reasoning, which still holds):
-- this block used to LEAVE an unmappable court name in place, on the theory
-- that a blackout's `court` field is only ever COMPARED against a fixture's
-- `court_id`, never rendered, so a dangling name is "inert". It is not
-- inert: `blackouts[].court` is `CourtId` (api-v1/schemas.ts) — a stale name
-- fails `ScheduleConfig.parse` at `loadSettings`, 500ing the board,
-- auto-schedule, apply, validate and publish for the whole division, not
-- just the one blackout. Turning the entry into a venue-wide (global)
-- blackout by dropping only the `court` key was, and still is, rejected: a
-- global blackout blocks EVERY court during that window, strictly MORE than
-- the one the organiser could no longer identify — a correctness regression,
-- not a safe fallback. Wave 1's fix was to DROP the whole entry instead.
--
-- P9 DISPATCH #7: dropping is itself worse than it looks — the maintenance
-- closure the organiser recorded simply disappears, with nothing durable
-- left to say so (the dry-run report is an aggregate count in a migration
-- log, not something an organiser using the product will ever see), and the
-- very next solve can go ahead and book the court it was meant to keep
-- clear. A THIRD option closes this without reopening either rejected one:
-- redirect the unresolvable `court` to a lazily created, per-org PLACEHOLDER
-- court (`blackout_placeholder` below — a real `venues`/`courts` row named
-- distinctly enough that it reads as "needs manual reattachment" wherever it
-- is rendered) instead of dropping the entry or widening it.
--
-- This is SAFE in exactly the sense ruling 3 (candidate-courts.ts) cares
-- about: the placeholder is never a member of any division's
-- `config.courts` and no fixture's `court_id` can ever equal it (nothing
-- creates fixtures on it), so a blackout pointed at it can NEVER produce a
-- NEW conflict against an already-scheduled, already-valid board —
-- unlike feeding the raw name back into court_mapping's own
-- collection-and-create phase would (see the paragraph above this one): that
-- could resolve to a court OTHER fixtures are genuinely booked on, and a
-- blackout newly enforced against a real, in-use court is exactly the
-- retroactive-invalidation shape ruling 3 forbids. The blackout's own
-- enforceable reach is therefore UNCHANGED by this choice (it protected
-- nothing real either way, the instant the name stopped resolving) — what
-- changes is that the entry, and the fact that it needs attention, survives
-- where an organiser can find and manually re-target it, rather than
-- vanishing.
--
-- Idempotent, same shape as division-locked-scopes: an element already equal
-- to a real court id for the org (a second run, post-migration, INCLUDING
-- the placeholder's own id) passes through via the same `id::text = <string>`
-- referential check court_mapping itself uses (never a uuid-shape regex);
-- the placeholder is reused by name, never recreated, on a second run. A
-- blackout entry with no `court` key (venue-wide) is untouched throughout.
-- As a side effect this also folds in the SAME present-but-non-array
-- normalization the courts block's step 5 documents (json null/string/
-- object -> treated as zero elements, so `blackouts` itself lands on `[]`)
-- via the identical CASE guard — not a new write path, the existing
-- courts-block idiom reused verbatim.
-- =============================================================================

-- blackouts-court-migration:begin
do $$
declare
  v_org record;
  v_ph record;
  v_ph_venue_id uuid;
  v_ph_court_id uuid;
  v_total_orgs int := 0;
  v_total_divisions int := 0;
  v_total_entries int := 0;
  v_total_rewritten int := 0;
  v_total_unmapped int := 0;
begin
  -- Read-only: every blackout entry that carries a `court` KEY (any value,
  -- including null/blank — finding 14: this must agree with the write's own
  -- guard below, `barr.obj ? 'court'`, or the two can disagree on an entry
  -- neither of them then treats consistently), resolved against
  -- court_mapping (venue_hint = '' — a blackout carries no per-element venue
  -- any more than `config.courts[]` does) or a direct real-id passthrough
  -- check. A blackout with no `court` key at all (venue-wide) never appears
  -- here — nothing to migrate for it.
  drop table if exists pg_temp.blackout_court_entries;
  create temp table blackout_court_entries as
    select ss.org_id, ss.division_id, elem.val as raw_string,
           (cm.court_id is not null or c_existing.id is not null) as resolved
      from schedule_settings ss
           cross join lateral jsonb_array_elements(
             case when jsonb_typeof(ss.config -> 'blackouts') = 'array'
                  then ss.config -> 'blackouts' else '[]'::jsonb end
           ) as barr(obj)
           cross join lateral (select barr.obj ->> 'court' as val) as elem(val)
      left join court_mapping cm
        on cm.org_id = ss.org_id and cm.court_string = elem.val and cm.venue_hint = ''
      left join courts c_existing
        on c_existing.org_id = ss.org_id and c_existing.id::text = elem.val
     where barr.obj ? 'court';

  -- Lazily create ONE placeholder venue + court PER ORG that actually needs
  -- one — same discipline as division-locked-scopes-migration's own
  -- `scope_placeholder` above (an org with nothing unresolved gets no
  -- placeholder rows), and the SAME names, so the two blocks converge on one
  -- shared placeholder per org regardless of which runs first in a given
  -- session (reused by name, never recreated).
  drop table if exists pg_temp.blackout_placeholder;
  create temp table blackout_placeholder (
    org_id uuid primary key,
    court_id uuid not null
  );

  for v_ph in
    select distinct org_id from blackout_court_entries where not resolved
  loop
    select id into v_ph_venue_id
      from venues
     where org_id = v_ph.org_id and name = 'Unmapped legacy references' and archived_at is null
     order by created_at asc, id asc
     limit 1;
    if v_ph_venue_id is null then
      insert into venues (org_id, name) values (v_ph.org_id, 'Unmapped legacy references')
        returning id into v_ph_venue_id;
    end if;

    select id into v_ph_court_id
      from courts
     where org_id = v_ph.org_id and venue_id = v_ph_venue_id
       and name = 'Unresolved legacy reference' and archived_at is null
     order by created_at asc, id asc
     limit 1;
    if v_ph_court_id is null then
      insert into courts (venue_id, org_id, name, tags)
        values (v_ph_venue_id, v_ph.org_id, 'Unresolved legacy reference', '{}')
        returning id into v_ph_court_id;
    end if;

    insert into blackout_placeholder (org_id, court_id) values (v_ph.org_id, v_ph_court_id);
  end loop;

  -- DRY-RUN REPORT — emitted BEFORE the write below (the safety property of
  -- this whole session, per the P9 dispatch; a previous fix broke exactly
  -- this ordering and a re-review caught it). Counts every entry this block
  -- will rewrite AND every one it will redirect to the org's placeholder
  -- (P9 dispatch #7: no longer "drop" — see this block's header), so
  -- neither number is invisible to an operator deciding whether to run this
  -- migration.
  for v_org in
    select org_id,
           count(distinct division_id) as n_divisions,
           count(*) as n_entries,
           count(*) filter (where resolved) as n_rewritten,
           count(*) filter (where not resolved) as n_unmapped
      from blackout_court_entries
     group by org_id
     order by org_id
  loop
    raise notice 'V374 blackout-court migration (dry run): org=% divisions_with_court_blackouts=% court_blackout_entries=% entries_rewritten=% entries_redirected_unmapped=%',
      v_org.org_id, v_org.n_divisions, v_org.n_entries, v_org.n_rewritten, v_org.n_unmapped;
    v_total_orgs := v_total_orgs + 1;
    v_total_divisions := v_total_divisions + v_org.n_divisions;
    v_total_entries := v_total_entries + v_org.n_entries;
    v_total_rewritten := v_total_rewritten + v_org.n_rewritten;
    v_total_unmapped := v_total_unmapped + v_org.n_unmapped;
  end loop;
  raise notice 'V374 blackout-court migration (dry run) TOTAL: orgs=% divisions_with_court_blackouts=% court_blackout_entries=% entries_rewritten=% entries_redirected_unmapped=%',
    v_total_orgs, v_total_divisions, v_total_entries, v_total_rewritten, v_total_unmapped;

  -- WRITE: rewrite each blackout entry's `court` in place — element order
  -- AND cardinality now ALWAYS preserved (no entry is ever dropped any
  -- more — P9 dispatch #7, see header). A resolvable court (mapped or
  -- already-real) rewrites to that id; an unresolvable one — including JSON
  -- null, which used to hit `jsonb_set`'s STRICT null handling and leak a
  -- bare `null` into the array (finding 14) — redirects to this org's
  -- placeholder court instead, ALWAYS non-null once `blackout_placeholder`
  -- holds a row for this org (which it does exactly when this org has at
  -- least one unresolved entry — the loop above). An element with no
  -- `court` key at all (venue-wide) still passes through byte-identical —
  -- the outer `not (barr.obj ? 'court')` branch never touches it.
  update schedule_settings ss
     set config = jsonb_set(
       ss.config, '{blackouts}',
       coalesce((
         select jsonb_agg(
                  case
                    when not (barr.obj ? 'court') then barr.obj
                    else jsonb_set(barr.obj, '{court}',
                           to_jsonb(coalesce(cm.court_id, c_existing.id, ph.court_id)::text))
                  end
                  order by barr.ord
                )
           from jsonb_array_elements(
                  case when jsonb_typeof(ss.config -> 'blackouts') = 'array'
                       then ss.config -> 'blackouts' else '[]'::jsonb end
                ) with ordinality as barr(obj, ord)
           left join court_mapping cm
             on cm.org_id = ss.org_id and cm.court_string = (barr.obj ->> 'court') and cm.venue_hint = ''
           left join courts c_existing
             on c_existing.org_id = ss.org_id and c_existing.id::text = (barr.obj ->> 'court')
           left join blackout_placeholder ph
             on ph.org_id = ss.org_id
       ), '[]'::jsonb)
     )
   where ss.config ? 'blackouts';
end $$;
-- blackouts-court-migration:end
