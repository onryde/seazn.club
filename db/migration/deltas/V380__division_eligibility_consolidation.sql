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

-- eligibility-backfill:begin
-- Age. `maxAgeAt`/`minAgeAt` map straight onto the band. Only fills a side the
-- hub panel left null, so a column value an organiser set explicitly always
-- wins over the wizard's older jsonb copy of the same intent.
--
-- A division can carry MORE THAN ONE `{kind:"age"}` rule object -- this
-- file's own header documents the old evaluator's rules as "independent and
-- additive", and in practice the wizard round-trips a min-only object and a
-- max-only object as two separate array entries for what is really one
-- band. `cross join lateral jsonb_array_elements` produces one row PER
-- RULE, so a division with two age rules produced two rows sharing the same
-- `d.id` -- and an `UPDATE ... FROM` matched against them picks ONE,
-- unpredictably (Postgres's own documented behaviour for a target row
-- matched by more than one FROM row), discarding whichever bound the other
-- row held. Confirmed in psql:
-- `[{"kind":"age","minAgeAt":8},{"kind":"age","maxAgeAt":15}]` landed
-- `age_min=8, age_max=NULL` under the original single-CTE version of this
-- block. That is not cosmetic -- `youth`, recomputed further down from
-- `age_max` alone, then reads false for a genuine U16 division, and
-- `resolveNameDisplay` (apps/web/src/server/og/model.ts) stops suppressing
-- minors' full names on that division's public share images.
--
-- Fixed by aggregating per division (`group by d.id`) instead of leaving
-- one row per rule. `min(min_age)`/`max(max_age)` both skip nulls, so a
-- min-only object and a max-only object combine into the single band they
-- were always meant to express -- {8,15} for the example above, regardless
-- of array order, with no ambiguity as long as at most one object states
-- each bound (the only shape the wizard itself writes).
--
-- A GENUINE conflict -- two rule objects that both state the SAME bound
-- with DIFFERENT values -- has no "reconstruct the split band" reading to
-- fall back on, and the wizard never produces one (it writes at most one
-- age rule per division). `min(min_age)`/`max(max_age)` resolve it the same
-- direction anyway: the union of every band an organiser configured, wider
-- rather than narrower. Deliberate, not incidental -- a silently NARROWER
-- pick is exactly the failure mode this comment exists to fix (it happened
-- to drop `age_max` to NULL, "no limit", last time), so the direction that
-- cannot silently exclude someone entitled to register under at least one
-- of their own configured rules is the safer default for registration
-- ACCESS. It is a real tradeoff, not a free win: if two conflicting
-- `maxAgeAt` values straddled 18 (one youth, one not), this pick favours
-- the LARGER one and the `youth` recompute below follows it. Unrealistic
-- given the wizard's own shape today (see above), and worth a reader's
-- attention if that ever changes.
with age_bounds as (
  select d.id,
         min((r.value ->> 'minAgeAt')::int) as min_age,
         max((r.value ->> 'maxAgeAt')::int) as max_age
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) r(value)
  where r.value ->> 'kind' = 'age'
  group by d.id
),
age_cutoff as (
  -- The cutoff is a {month,day} PAIR, not a bound -- resolving month and day
  -- from two DIFFERENT rule rows independently could stitch together a date
  -- nobody configured. Takes the first rule (by array order) that actually
  -- carries a cutoff, falling back to the first rule overall if none does --
  -- same "first by array order, never guessed" precedent as `custom_rule`
  -- and `gender_rule_first` below.
  select distinct on (d.id)
         d.id,
         (r.value -> 'cutoff' ->> 'month')::int as cutoff_month,
         (r.value -> 'cutoff' ->> 'day')::int   as cutoff_day
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) with ordinality r(value, ord)
  where r.value ->> 'kind' = 'age'
  order by d.id, (r.value -> 'cutoff') is null, r.ord
)
update divisions d
set age_max          = coalesce(d.age_max, ab.max_age),
    age_min          = coalesce(d.age_min, ab.min_age),
    age_cutoff_month = coalesce(d.age_cutoff_month, ac.cutoff_month),
    age_cutoff_day   = coalesce(d.age_cutoff_day, ac.cutoff_day)
from age_bounds ab
left join age_cutoff ac on ac.id = ab.id
where ab.id = d.id;

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

-- Sex. Two things can happen to a `kind:"gender"` rule: it converts onto
-- `category` when the conversion is EXACT (the category's admit-set matches
-- the jsonb allow-list precisely -- no guessing), or it is preserved as a
-- plain-English sentence in `eligibility_note` below instead, so the drop at
-- the end of this file never silently destroys it. A division with no
-- gender rule at all is untouched by either step.
--
-- What converts, and why it loses nothing:
--   ['m']      -> mens     ['f']      -> womens
--   ['m','x']  -> mens     ['f','x']  -> womens
-- `categoryEligibilityIssues` (registration-rules.ts) never blocks gender
-- 'x' against ANY category -- an owner ruling this migration wave already
-- made, not introduced here -- so `mens` admits EXACTLY {m, x} and `womens`
-- admits EXACTLY {f, x}. The retired jsonb evaluator's own check was strict
-- membership with no such case (`r.allowed.includes(person.gender)`,
-- confirmed by reading it before this branch's app-code half deleted it), so
-- ['m'] admitted exactly {m} and ['m','x'] admitted exactly {m, x} -- the
-- same two admit-sets `mens` produces depending only on whether 'x' was
-- listed. Converting either one to `mens` reproduces its old behaviour
-- exactly. Only fires where `category` is still null -- an organiser-set
-- category (hub panel) always wins, same guard as before.
--
-- What does not convert, and why guessing would be wrong:
--   ['m','f'] admits male or female individually and rejects non-binary.
--   That is NOT `mixed` -- `mixed` is a ROSTER rule (rosterCompositionIssues:
--   "the TEAM must field at least one male AND one female player"), a
--   completely different thing from "this ENTRANT may be male or female".
--   Writing `mixed` here would silently turn a per-entrant admission gate
--   into a team-composition requirement nobody configured.
--   ['x'] alone admits only non-binary entrants -- none of `open`/`mens`/
--   `womens`/`mixed` can express that; there is no column value to put it in.
-- Both, plus anything this migration does not recognise above (more than one
-- gender-kind rule on a division, an empty/malformed `allowed`, or a
-- recognised shape whose division already had a DIFFERENT category set), are
-- handled the same conservative way: noted below, never guessed.
with gender_rule_all as (
  select d.id, r.value, r.ord
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) with ordinality r(value, ord)
  where r.value ->> 'kind' = 'gender'
),
gender_rule_count as (
  select id, count(*) as n from gender_rule_all group by id
),
gender_rule_first as (
  -- First gender-kind rule only, by array order -- same precedent as the
  -- custom-rule block below. A division with more than one never gets a
  -- shape match: `n` (from gender_rule_count) stays > 1 for it either way.
  select distinct on (id) id, value
  from gender_rule_all
  order by id, ord
),
gender_rule as (
  select f.id,
         c.n,
         case
           when jsonb_typeof(f.value -> 'allowed') = 'array' then
             array(select elem
                   from jsonb_array_elements_text(f.value -> 'allowed') as elem
                   order by elem)
           else null
         end as allowed_sorted
  from gender_rule_first f
       join gender_rule_count c using (id)
)
update divisions d
set category = case
                 when g.allowed_sorted in (array['m'], array['m','x']) then 'mens'
                 when g.allowed_sorted in (array['f'], array['f','x']) then 'womens'
               end
from gender_rule g
where g.id = d.id
  and g.n = 1
  and g.allowed_sorted in (array['m'], array['f'], array['m','x'], array['f','x'])
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

-- Every gender rule the block above could not put into `category` -- an
-- unrecognised shape, more than one gender-kind rule on a division, or a
-- recognised shape whose division already carried a DIFFERENT category --
-- is preserved here as a plain sentence in `eligibility_note` instead of
-- being silently destroyed by the drop at the end of this file. This column
-- is organiser-authored free text rendered on the public register/join
-- pages (`register.organiserNote`) and as a badge in the entrants hub, so an
-- organiser who has never heard of jsonb still learns their division used
-- to be restricted. Never overwrites a note already there (most likely one
-- the custom-rule block above just wrote from this SAME division's
-- `eligibility`, seconds earlier in this same migration) -- a division can
-- have lost BOTH a custom note and a gender rule, and clobbering one to
-- record the other would just move the data loss this migration exists to
-- close, so the two are appended, clearly separated by a blank line.
--
-- Re-derives the same `gender_rule` shape as the block above -- a plain SQL
-- script cannot share one CTE across two separate statements -- and checks
-- the now-CURRENT `category` against what THIS rule alone would have
-- produced: equal means nothing was lost (either the update above just set
-- it, or the row already agreed before this migration ran), anything else
-- -- including still null, which cannot happen for a recognised shape since
-- the update above is unconditional on a match -- means a note is owed.
with gender_rule_all as (
  select d.id, r.value, r.ord
  from divisions d
       cross join lateral jsonb_array_elements(d.eligibility) with ordinality r(value, ord)
  where r.value ->> 'kind' = 'gender'
),
gender_rule_count as (
  select id, count(*) as n from gender_rule_all group by id
),
gender_rule_first as (
  select distinct on (id) id, value
  from gender_rule_all
  order by id, ord
),
gender_rule as (
  select f.id,
         c.n,
         case
           when jsonb_typeof(f.value -> 'allowed') = 'array' then
             array(select elem
                   from jsonb_array_elements_text(f.value -> 'allowed') as elem
                   order by elem)
           else null
         end as allowed_sorted
  from gender_rule_first f
       join gender_rule_count c using (id)
),
gender_loss as (
  select g.id,
         case
           when g.n = 1 and g.allowed_sorted = array['f','m'] then
             'Previously restricted to men or women only (non-binary entrants were not eligible).'
           when g.n = 1 and g.allowed_sorted = array['x'] then
             'Previously restricted to non-binary entrants only.'
           when g.n = 1 and g.allowed_sorted = array['m'] then
             'Previously restricted to men only.'
           when g.n = 1 and g.allowed_sorted = array['f'] then
             'Previously restricted to women only.'
           when g.n = 1 and g.allowed_sorted = array['m','x'] then
             'Previously restricted to men (non-binary entrants were also allowed).'
           when g.n = 1 and g.allowed_sorted = array['f','x'] then
             'Previously restricted to women (non-binary entrants were also allowed).'
           else
             'Previously had a gender-based entry restriction that could not be carried forward automatically -- please review this division''s eligibility.'
         end as note_text
  from gender_rule g
       join divisions div on div.id = g.id
  where g.n <> 1
     or g.allowed_sorted is null
     or g.allowed_sorted not in (array['m'], array['f'], array['m','x'], array['f','x'])
     or div.category is null
     or div.category <> (
          case
            when g.allowed_sorted in (array['m'], array['m','x']) then 'mens'
            when g.allowed_sorted in (array['f'], array['f','x']) then 'womens'
          end
        )
)
update divisions d
set eligibility_note = case
  when d.eligibility_note is not null and trim(d.eligibility_note) <> '' then
    trim(d.eligibility_note) || E'\n\n' || gl.note_text
  else gl.note_text
end
from gender_loss gl
where gl.id = d.id;

-- Re-derive `youth` from the band that now holds the truth. This is defect 2:
-- rows whose age limit only ever lived in `age_min`/`age_max` never got a
-- youth flag, and rows that had one keep it only if the band agrees.
-- `age_max < 18` matches the jsonb rule's own test (`maxAgeAt < 18`) exactly.
update divisions
set youth = (age_max is not null and age_max < 18)
where youth is distinct from (age_max is not null and age_max < 18);
-- eligibility-backfill:end

-- ---------------------------------------------------------------------------
-- The jsonb column goes. Nothing reads it after this migration: the app's
-- evaluator loses its jsonb branch in the same change, and the public API
-- schema drops the field (OpenAPI regen).
-- ---------------------------------------------------------------------------
alter table divisions drop column eligibility;
