-- RS007 review fix: V380 (`division eligibility consolidation`) silently
-- discarded any jsonb gender rule it could not convert to a first-class
-- `category`, then dropped the jsonb column in the SAME migration. This
-- file documents that loss where it can still be seen, and states plainly
-- what this migration — and every migration after it, forever — CANNOT do
-- about it.
--
-- ---------------------------------------------------------------------------
-- What was lost, and why it cannot come back.
-- ---------------------------------------------------------------------------
--
-- V380's "Sex" backfill (its own file, ~:99-125) converted ONLY an exact
-- singleton allow-list onto a division whose `category` was still null:
--   ['m'] -> mens, ['f'] -> womens.
-- Two other shapes existed and were deliberately left unconverted, per that
-- migration's own comment ("Guessing here would invent a restriction the
-- organiser never set"):
--   * any OTHER allow-list — ['m','f'] (admits male/female, excludes
--     non-binary) or ['x'] alone (admits only non-binary) — has no
--     first-class `category` equivalent at all (`open`/`mens`/`womens`/
--     `mixed` cannot express either), so there was nothing correct to
--     backfill it TO;
--   * a division that already had a non-null `category` (e.g. set via the
--     registration hub panel, independent of the wizard's jsonb rule) kept
--     that value untouched even if its jsonb ALSO carried a clean ['m']/
--     ['f'] rule — the backfill's own guard is `and d.category is null`.
-- Both cases left NO trace anywhere in the surviving columns: `category` is
-- exactly what it would be for a division that never had a gender rule at
-- all, and (unlike V380's "custom" rule, which became `eligibility_note`)
-- no gender-rule shape was ever written to `eligibility_note` either.
--
-- V380's very last statement (`alter table divisions drop column
-- eligibility`) ran in the SAME migration, unconditionally, right after the
-- above. By the time ANY later migration — including this one — is allowed
-- to run on a given database, V380 has already both attempted the
-- conversion AND dropped the only column that held the original rule, as
-- one indivisible unit. There is no point in this database's history, on
-- ANY environment, where a migration running AFTER V380 could still read
-- the jsonb it needs to finish the job. Editing V380 itself would have been
-- the only real fix, and this project's standing rule treats an
-- already-applied migration as immutable (correct forward only) — V380 has
-- already run wherever this branch's migrations have been applied
-- (confirmed on this database: `flyway_schema_history` shows version 380
-- applied). So, stated plainly, for the record:
--
--   PRE-V380 GENDER RULES THAT WERE NOT AN EXACT ['m']/['f'] SINGLETON ONTO
--   A NULL-CATEGORY ROW WERE PERMANENTLY DISCARDED BY V380. THEY CANNOT BE
--   RECONSTRUCTED FROM THIS DATABASE BY V382 OR BY ANY MIGRATION AFTER IT —
--   THE SOURCE DATA NO LONGER EXISTS ANYWHERE FOR ANY QUERY TO READ.
--
-- This migration does NOT attempt a data backfill for the same reason V380
-- didn't guess: on this very database, 14535 of 14604 divisions have a null
-- `category` (checked directly, 2026-08-27) — the ordinary shape of a
-- division that never had ANY gender rule. Nothing left in the schema
-- distinguishes "always open" from "had an unconvertible gender rule,
-- silently dropped" among them. Writing a "this division's eligibility may
-- be incomplete" note to every null-category row would not disclose a real
-- loss — it would manufacture a false one across the entire table. Per the
-- brief this migration was written against: do not invent data, do not
-- claim to restore what is gone.
--
-- ---------------------------------------------------------------------------
-- What this migration DOES do.
-- ---------------------------------------------------------------------------
--
-- 1. Records the loss in the live schema itself (COMMENT ON COLUMN below) —
--    not just in this file's git history — so anyone inspecting the table
--    (`\d+ divisions`, information_schema) finds the warning at the column,
--    not only a reader who happens to open this migration.
-- 2. Closes the half of this defect that WAS still fixable: a division
--    whose `category` alone can no longer prove it unrestricted (because
--    V380 could not express its original rule) now also needs the public
--    form to keep collecting gender defensively, so an organiser reviewing
--    entries against a hand-typed `eligibility_note` at least has the data
--    to check it manually. That is an application-code fix, not a SQL one —
--    see `requiresGender`'s doc comment,
--    apps/web/src/server/usecases/registration-eligibility.ts — but it only
--    protects a division GOING FORWARD if the organiser records the
--    restriction as a note; it cannot rediscover a note nobody wrote for a
--    row already migrated silently. This is the "ensure no FUTURE
--    conversion is silent" half of the fix: the one organiser-facing
--    channel left for an unconvertible rule (`eligibility_note`) now
--    actually causes the data it might need to be collected, instead of
--    being collected nowhere the way the original jsonb rule was.

comment on column divisions.category is
  'V380 (2026-08-27) backfilled this column from the retired jsonb '
  '`eligibility` rules ONLY for an exact singleton gender allow-list on a '
  'row whose category was still null (["m"]->mens, ["f"]->womens). Every '
  'other jsonb gender shape -- a list like ["m","f"], ["x"] alone, or any '
  'shape on a row that already had a category -- was discarded when that '
  'same migration dropped the jsonb column. A null category here can mean '
  '"never had a gender rule" OR "had one V380 could not convert" -- the '
  'two are no longer distinguishable. See V382__division_eligibility_'
  'gender_rule_loss_disclosure.sql for the full account.';

comment on column divisions.eligibility_note is
  'First-class since V380 (2026-08-27), converted from the jsonb '
  '`eligibility` rules'' "custom" kind only. NOT populated for a gender '
  'rule V380 could not convert onto `category` (e.g. ["m","f"] or ["x"]) --'
  ' those were dropped with no note written. requiresGender() (registration'
  '-eligibility.ts) treats a non-empty note here as a reason to collect '
  'gender defensively going forward, since `category` alone can no longer '
  'prove a division unrestricted; this only protects a division whose '
  'organiser records the restriction as a note AFTER V382, not one already '
  'silently migrated by V380 with no note written for it.';
