# Issue 850 — round-robin byes: review findings

Branch `claude/adoring-edison-2u60xj`. Owner rulings: competition-desk `_INDEX.md` § "Issue 850".

## Round 1 — orchestrator, from the implementer's screenshots (run sheet at 320 and 1280)

- **O1 (ruling violated).** League ghost rows all collect at the bottom under
  "PLAYED, NOT SCHEDULED", Round 1..5 in a pile. The owner ruled the ghost row
  sits INSIDE its round (and pool). The heading is also false for a bye:
  nothing was played.
- **O2 (wrong count).** The stage card reads "View 15 fixtures" for a
  5-entrant league with 10 matches. Bye rows are counted as fixtures. The
  implementer reports that the generate/rebuild toasts count matches only, so
  the surfaces now disagree with each other.

## Open owner questions raised by the implementer
- Public division page and slideshow show league byes as "X vs Bye"; the
  slideshow's "Latest results" lists every bye at generation.
- Progression-fed ("setup" timing) league stages get no bye rows.

## Round 1 — reviewer (verdict: NEEDS FIXES; 0 CRITICAL / 4 HIGH / 3 MEDIUM / 4 LOW)

1. **HIGH — O1 confirmed.** `run-sheet-groups.ts:173-183` routes league byes
   to the settled block. `run-sheet-groups.test.ts:502` and
   `e2e/round-robin-bye.spec.ts:126-129` ASSERT the wrong placement (class 4).
2. **HIGH — `division_has_results()` counts any forfeited row.** A freshly
   generated odd league reads as "has results": it can't be deleted, and
   archiving it still holds a paid division slot. A 4-entrant league deletes
   cleanly (probe).
3. **HIGH — Undo of "Clear pool entrants" corrupts byes.** `history.ts:225-241`
   restores rows as scheduled with no outcome, turning byes into
   unscoreable one-seat matches, so the stage can never complete. A later
   Generate duplicates the pool.
4. **HIGH — public surfaces count byes as results.** The hub reads
   "Completed 5" and Present shows "LATEST RESULTS … vs Bye · FORFEIT" before
   anything is played.
5. **MEDIUM — O2 confirmed.** `stages-panel.tsx:1298` counts bye rows, while a
   non-bye count already exists at `:882`.
6. **MEDIUM — Start times bye rows** when rolling round times are configured
   (`schedule.ts:3839`). No test sets rolling times.
7. **MEDIUM — Generate after adding an entrant (4→5) writes byes** for
   entrants who also play in that round (probe).
8. LOW — a withdrawn entrant keeps their future bye row.
9. LOW — progression-fed ("setup" timing) league gets no bye rows. Now
   owner-ruled: see `_INDEX.md`.
10. LOW — no test that knockout byes are excluded from entrant-delete
    cleanup or the generate count.
11. LOW — one DB test hand-builds bye rows; smoke restates the predicate
    instead of importing it.

Held: SQL and TS predicates agree (including NULL); regenerate doesn't
duplicate; generation undo/redo works; double round-robin and odd/even pools
work; auto-schedule, AI and conflicts never place a bye; the implementer's
25/25 mutants were killed.
