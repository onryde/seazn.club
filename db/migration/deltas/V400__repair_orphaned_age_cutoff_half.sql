-- F19 (settings walkthrough W8 fix backlog) — repair any division left with
-- exactly one half of its age-cutoff override set.
--
-- `age_cutoff_month`/`age_cutoff_day` are a pair (RS007/V380): both null
-- means "use the default 1 January cutoff", and both set means "use this
-- cutoff instead". The registration hub UI has never sent a one-sided body —
-- `toDivisionPatchBody` (registration-hub-config-state.ts) always PATCHes
-- both keys together — so a division holding only one of the pair can only
-- have gotten there via a direct script or DB write outside the app.
--
-- That state is not just internally inconsistent: `checkAgeCutoff`
-- (api-v1/schemas.ts) refuses ANY future PATCH to such a division — even one
-- editing an unrelated field like name or capacity — with a 400 at
-- `age_cutoff_day`, because `toDivisionPatchBody` re-sends the orphaned
-- value on every save and the schema's own-half-null-half-set check fires.
-- With `hasAgeBand` also disabling the cutoff selects when the division has
-- no age band, an orphan with no age band is a division nobody can save from
-- the hub at all.
--
-- Checked directly (2026-09-08, this migration's own author): 0 rows on the
-- local schema this repo migrates from a fresh apply. This statement is a
-- verified no-op there and is what would clean up any live orphan the same
-- check finds elsewhere — it does not depend on that count being zero to be
-- correct. Re-runnable: a division already `(null, null)` or fully set never
-- matches the where clause.
update divisions
set age_cutoff_month = null,
    age_cutoff_day = null
where (age_cutoff_month is null) <> (age_cutoff_day is null);
