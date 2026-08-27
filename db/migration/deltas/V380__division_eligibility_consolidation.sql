-- RS007: collapse the TWO live eligibility representations on `divisions`
-- into one. Owner ruling 2026-08-27, recorded in the registration-redesign
-- `_INDEX.md` ("Eligibility consolidation").
--
-- Until now a division carried its age/sex rules TWICE, and both were
-- enforced, additively -- `registration-eligibility.ts` said so itself:
-- "independent and additive - a division configured with both yields issues
-- from both".
--
--   * `eligibility` jsonb  <- the division-creation wizard's Eligibility tab
--   * `category`/`age_min`/`age_max` (V364)  <- the registration hub panel
--
-- Three defects came out of that, and this migration closes the schema half
-- of all three:
--
--  1. TWO AGE RULES, TWO CUTOFF DATES. The jsonb rule carries an
--     organiser-chosen cutoff (`{month, day}`, school-year age groups run
--     1 September); the column band is evaluated at 1 January, hardcoded.
--     Configure both and a player born Sept-Dec is eligible under one rule
--     and rejected by the other, with no screen showing both. The columns
--     could not simply replace the jsonb because they had nowhere to put the
--     cutoff -- hence `age_cutoff_month`/`age_cutoff_day` below. Dropping the
--     jsonb without them would silently re-anchor every U-N division to
--     1 January and change who is eligible.
--
--  2. `youth` WAS DERIVED FROM THE JSONB ONLY. An organiser who set the age
--     band in the registration hub rather than the wizard got a youth
--     division the system did not know was youth -- so public share images
--     published full player names, the slideshow stopped shortening them and
--     the visibility dialog skipped its youth warning. The `youth` column
--     stays; its derivation moves onto `age_max` in app code. The backfill
--     below recomputes it so no existing row keeps the old, jsonb-only
--     answer.
--
--  3. THE CUSTOM RULE WAS SHOWN NOWHERE. `{kind:"custom", note}` was written
--     by the wizard and read by nothing -- the validator handles only 'age'
--     and 'gender'. Its label promised "manual, shown as a warning" and
--     delivered neither. It becomes `eligibility_note`, a first-class column
--     the public entry and join pages actually render.
--
-- On the backfill: this is a greenfield project (`docs/superpowers/RULES.md`
-- §Schema -- "no production data, no backfills to preserve"), so nothing here
-- is load-bearing for production. It runs anyway because staging and every
-- local/dev database DO hold divisions, and a silent reset of their age
-- limits would read as a regression in exactly the surfaces RS007 is being
-- reviewed on. Best-effort by design: the rule shapes it cannot express are
-- listed at each step rather than approximated.

alter table divisions
  add column age_cutoff_month integer,
  add column age_cutoff_day   integer,
  add column eligibility_note text;

-- A cutoff is meaningless half-specified: both halves or neither. The day is
-- capped at 31 only -- a per-month day count is not worth a trigger here, and
-- the app resolves the date against the season year anyway.
alter table divisions add constraint divisions_age_cutoff_check
  check (
    (age_cutoff_month is null and age_cutoff_day is null)
    or (age_cutoff_month between 1 and 12 and age_cutoff_day between 1 and 31)
  );

-- ---------------------------------------------------------------------------
-- Backfill: jsonb rules -> first-class columns.
-- ---------------------------------------------------------------------------

-- Age. `maxAgeAt`/`minAgeAt` map straight onto the band. Only fills a side the
-- hub panel left null, so a column value an organiser set explicitly always
-- wins over the wizard's older jsonb copy of the same intent.
with age_rule as (
  select d.id,
         (r.value ->> 'maxAgeAt')::int              as max_age,
         (r.value ->> 'minAgeAt')::int              as min_age,
         (r.value -> 'cutoff' ->> 'month')::int     as cutoff_month,
         (r.value -> 'cutoff' ->> 'day')::int       as cutoff_day
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) r(value)
  where r.value ->> 'kind' = 'age'
)
update divisions d
set age_max          = coalesce(d.age_max, a.max_age),
    age_min          = coalesce(d.age_min, a.min_age),
    age_cutoff_month = coalesce(d.age_cutoff_month, a.cutoff_month),
    age_cutoff_day   = coalesce(d.age_cutoff_day, a.cutoff_day)
from age_rule a
where a.id = d.id;

-- A cutoff month without its day (or the reverse) would now violate the check
-- constraint above. The wizard always wrote both, but a hand-authored rule
-- need not have -- default the missing half to the 1st rather than fail the
-- migration on a row nobody can see.
update divisions
set age_cutoff_day = 1
where age_cutoff_month is not null and age_cutoff_day is null;
update divisions
set age_cutoff_month = 1
where age_cutoff_day is not null and age_cutoff_month is null;

-- Sex. Only the unambiguous single-gender rules convert:
--   ['m'] -> mens, ['f'] -> womens.
-- Everything else is deliberately LEFT ALONE rather than guessed. ['m','f']
-- is not `mixed` -- `mixed` is a ROSTER rule ("must contain both"), while the
-- jsonb list is a per-person allow-list, and ['x'] alone has no category at
-- all. Guessing here would invent a restriction the organiser never set.
-- NOTE this is also where the accepted behaviour change lands: a jsonb
-- ['m'] rule REJECTED a player whose gender is 'x', whereas category 'mens'
-- admits them (registration-rules.ts, `person.gender !== 'x'`). Converted
-- rows therefore become more permissive for non-binary entrants, which is the
-- owner's explicit call, not an accident of this migration.
with gender_rule as (
  select d.id,
         case
           when r.value -> 'allowed' = '["m"]'::jsonb then 'mens'
           when r.value -> 'allowed' = '["f"]'::jsonb then 'womens'
         end as category
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) r(value)
  where r.value ->> 'kind' = 'gender'
)
update divisions d
set category = g.category
from gender_rule g
where g.id = d.id
  and g.category is not null
  and d.category is null;

-- The custom note becomes a column. Multiple custom rules collapse to the
-- first by array order; the wizard only ever wrote one.
with custom_rule as (
  select distinct on (d.id)
         d.id,
         nullif(trim(r.value ->> 'note'), '') as note
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) with ordinality r(value, ord)
  where r.value ->> 'kind' = 'custom'
  order by d.id, r.ord
)
update divisions d
set eligibility_note = c.note
from custom_rule c
where c.id = d.id
  and c.note is not null
  and d.eligibility_note is null;

-- Re-derive `youth` from the band that now holds the truth. This is defect 2:
-- rows whose age limit only ever lived in `age_min`/`age_max` never got a
-- youth flag, and rows that had one keep it only if the band agrees.
-- `age_max < 18` matches the jsonb rule's own test (`maxAgeAt < 18`) exactly.
update divisions
set youth = (age_max is not null and age_max < 18)
where youth is distinct from (age_max is not null and age_max < 18);

-- ---------------------------------------------------------------------------
-- The jsonb column goes. Nothing reads it after this migration: the app's
-- evaluator loses its jsonb branch in the same change, and the public API
-- schema drops the field (OpenAPI regen).
-- ---------------------------------------------------------------------------
alter table divisions drop column eligibility;
