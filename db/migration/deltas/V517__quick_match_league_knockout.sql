-- V517 — Quick match League + Knockout: the format value and the guests' answer to a tie at the cut
-- (docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §2, §5, §11, §12; plan
-- docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md Task 1, decisions D1 and D5).
-- Flyway runs with outOfOrder=false, so the version number must rise in MERGE order: V517 is a WORKING number (main tops at
-- V516__match_day_code_can_call.sql), reassigned at merge if main has moved past it. A renumber moves this file's name, the
-- `V517` on line 1 (migration-header-truth.test.ts) and the comments and tests that cite V517 by number
-- (`git grep -n V517 -- apps`).
--
-- Two changes, neither of which changes a row's data:
--
-- 1. `quick_matches.format` gains `league_knockout` (D1): a league whose top 2 or top 4 play a knockout, built as ONE division
--    with two stages. The check is V506's inline, unnamed column check, which Postgres named quick_matches_format_check; it is
--    restated whole here with the same name (no delta after V506 touched it, re-checked 2026-11-13 against da5672071c). `knockout`
--    stays for the rows that hold it; the create refuses a new one (422 FORMAT_NOT_OFFERED). The qualifier count is NOT a column:
--    the knockout stage's own progression (`sources[0].take[0].to`) is its one authority.
--
-- 2. `quick_matches.cut_decision` (D5, spec §5 and §11): the guests' one answer to a tie that straddles the knockout's cut,
--    `{how: "pick" | "toss", through: [entrant ids], tie: [the tied group's ids, sorted], at: iso}`. Null until somebody answers.
--    The first answer wins: the decision usecase writes it only `where cut_decision is null`, and the advance clears a stale one
--    (an edited league result moved the table) with a compare-and-clear, so the question is asked again. The CHECK says only
--    that a stored decision is a JSON object; its fields are the usecase's contract (usecases/quick-match-advance.ts). Nullable
--    with no default, so every existing row reads "no decision".

alter table quick_matches drop constraint quick_matches_format_check,
  add constraint quick_matches_format_check check (format in ('league', 'knockout', 'league_knockout'));

alter table quick_matches add column cut_decision jsonb null
  constraint quick_matches_cut_decision_object check (cut_decision is null or jsonb_typeof(cut_decision) = 'object');
