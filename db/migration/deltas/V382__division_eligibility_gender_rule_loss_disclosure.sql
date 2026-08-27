-- RS007 review fix, RECONCILED 2026-08-27 (see the section below the dashes
-- for what changed and why): V380 (`division eligibility consolidation`)
-- originally backfilled `category` from the jsonb `eligibility` rules for
-- only an exact singleton gender allow-list, then dropped the jsonb column
-- in the SAME migration — silently discarding every other gender-rule shape
-- with no trace it had ever existed. This file was first written on the
-- premise that V380 had already shipped and was therefore immutable — to
-- document that loss where it could still be seen (COMMENT ON COLUMN below)
-- and to state plainly what a migration running AFTER V380 could and could
-- not do about it.
--
-- ---------------------------------------------------------------------------
-- That premise was wrong, and the real fix changed as a result.
-- ---------------------------------------------------------------------------
--
-- "Already shipped" was checked against the wrong thing: a local database
-- this session happened to be using (`flyway_schema_history` showed version
-- 380 applied there), not `origin/main`. `git log origin/main --oneline --
-- db/migration/deltas/V380__division_eligibility_consolidation.sql` came
-- back EMPTY — V380 had never reached `main`; it lived (and, unmerged,
-- still lives) only on this same draft branch/PR. This project's
-- "migrations are immutable, correct forward" rule protects a migration
-- once it has shipped; applying it to one that has not would have let a
-- genuinely fixable defect ship anyway, permanently, for no reason.
--
-- So V380 was corrected DIRECTLY instead of being patched forward from
-- here. Its "Sex" section now preserves every gender rule it cannot
-- faithfully convert onto `category` — INCLUDING the two shapes this file
-- originally said had "no first-class `category` equivalent at all"
-- (`['m','f']`, `['x']` alone) and the "division already had a category"
-- case — as a plain-English sentence written into `eligibility_note`
-- before the jsonb column is dropped, in the SAME migration, so there is no
-- point in its history where the rule exists nowhere at all. It also now
-- faithfully CONVERTS two shapes the discussion below still lists as
-- discarded (`['m','x']` → `mens`, `['f','x']` → `womens` — exact, not
-- guessed; see V380's own comments for why). Read
-- `V380__division_eligibility_consolidation.sql` itself for the current,
-- authoritative backfill behaviour — what follows describes the migration
-- as it stood BEFORE this correction, not as it stands now.
--
-- The one thing this correction cannot do anything about: a database that
-- already applied the pre-correction V380 really did lose those rows'
-- gender rules, permanently, exactly as documented below — editing the
-- migration file does not retroactively re-run it. This repo's own
-- `seazn_rs007` test database is one such case (checked directly,
-- 2026-08-27). For a database in that position, and only that one, the
-- rest of this file's account still applies verbatim, and the COMMENT ON
-- COLUMN text below — left exactly as originally written, deliberately —
-- still describes exactly what is recorded there. A database that has not
-- yet reached V380 (per the check above, this includes `main`) gets the
-- corrected behaviour from one ordinary migration run and loses nothing.
--
-- Anyone who already applied the pre-correction V380 (or this file) gets a
-- Flyway CHECKSUM MISMATCH the next time they run `db:apply` after pulling
-- this fix. Recover with `bash scripts/flyway.sh repair` (realigns the
-- recorded checksums with the edited files; it does NOT re-run either
-- migration and does NOT recover the rows already lost), then `db:apply`
-- again for anything after.
--
-- ---------------------------------------------------------------------------
-- What was lost by the PRE-correction V380, for the record.
-- ---------------------------------------------------------------------------
--
-- V380's "Sex" backfill (its own file, ~:99-125 at the time) converted ONLY
-- an exact singleton allow-list onto a division whose `category` was still
-- null:
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
-- above. By the time ANY later migration — including this one — was allowed
-- to run on a database still carrying the pre-correction V380, it had
-- already both attempted the conversion AND dropped the only column that
-- held the original rule, as one indivisible unit. There was no point in
-- that database's history where a migration running AFTER V380 could still
-- read the jsonb it needed to finish the job — which is exactly why the fix
-- had to go INTO V380 itself, and why (per the section above) that was only
-- possible because V380 had not actually shipped anywhere yet.
--
-- On the database this was first caught on, 14535 of 14604 divisions had a
-- null `category` (checked directly, 2026-08-27) — the ordinary shape of a
-- division that never had ANY gender rule. Nothing left in the schema
-- distinguished "always open" from "had an unconvertible gender rule,
-- silently dropped" among them, which is why item 2 below (application-code
-- defensive collection) was the best available fix for a database already
-- in that state — writing a note to every null-category row would not
-- disclose a real loss, it would manufacture a false one across the entire
-- table.
--
-- ---------------------------------------------------------------------------
-- What this migration still does, and why it still runs.
-- ---------------------------------------------------------------------------
--
-- 1. Records the loss in the live schema itself (COMMENT ON COLUMN below) —
--    not just in this file's git history — so anyone inspecting the table
--    (`\d+ divisions`, information_schema) on a database that carries the
--    pre-correction V380 finds the warning at the column. Left unedited by
--    this reconciliation pass, deliberately: it still describes exactly
--    what happened on such a database, and rewriting the text would not
--    change what is actually recorded on one that already applied it.
-- 2. Closes the half of the ORIGINAL defect that was still fixable from
--    here, for a database that had already lost the data: a division whose
--    `category` alone can no longer prove it unrestricted now also needs
--    the public form to keep collecting gender defensively, so an organiser
--    reviewing entries against a hand-typed `eligibility_note` at least has
--    the data to check it manually. That is an application-code fix, not a
--    SQL one — see `requiresGender`'s doc comment,
--    apps/web/src/server/usecases/registration-eligibility.ts. Unaffected
--    by the correction above and still exactly as useful — it now also
--    covers every row the corrected V380 notes going forward, since a
--    non-empty `eligibility_note` is precisely the signal it watches for.

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
