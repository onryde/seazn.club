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

## Round 2 — reviewer (verdict: NEEDS FIXES; 1 HIGH / 5 LOW)

Round-1 findings: 10/11 fixed and probed through real paths; finding 8 is only
half-fixed (see R2-2). Gate re-run: 754/754 across 39 files; 27/27 mutants
killed; no assertions weakened.

1. **HIGH — `stages.ts:6102,6119` addFixture keys `adhoc-${count(*)+1}`.**
   Reconciling deletes bye rows on withdrawal, so the count drops and the next
   key collides: duplicate key on `fixtures_stage_ext_key_idx`, then a 500 on
   every retry. Reachable from the UI (`stages-panel.tsx:1955`). Fix: max(N)+1
   or a uuid, with a test that fails today.
2. LOW — `registrations.ts:4705` `withdrawCore` withdraws by raw SQL: no
   reconcile, no division lock, so future byes stay.
3. LOW — addFixture never reconciles. A match added for a bye holder in their
   bye round leaves them both resting and playing. Test
   `round-robin-bye-lifecycle.test.ts:315` locks this in.
4. LOW, OWNER DECISION — in a progression-fed league, a qualifier who leaves
   before the draw has their seat awarded to the opponent as a one-seated
   walkover (`awardSeededByes`, `stages.ts:3934`). `isRestBye` classifies these
   as rest byes, so they stop scoring (main scored them as a win).
   `deleteRestByesHeldBy` (`stages.ts:2194`) deletes them while the reconciler
   treats them as matches.
5. LOW — `run-sheet-groups.ts:324`: in a partly played untimed round, the bye
   sits under "Played, not scheduled" while one of its matches is still
   unscheduled.
6. LOW — bye rows take division-wide match numbers; cosmetic, as it already
   happens with Swiss and knockout byes.

Decisions: (a) hub omits rest byes: sound. (b) API feed drops them: sound.
(c) withdrawal policy: sound, but wire it through withdrawCore. (d) reconciler:
idempotent and inside the division lock at all 4 call sites; wire it into
addFixture and withdrawCore. (e) V417: safe (no V415 on any ref; the gap is
allowed; the predicate matches `restByeSql`). (f) acceptable apart from R2-5.
(g) acceptable scope.

## Round 3 — reviewer (verdict: NEEDS FIXES; 1 MEDIUM / 2 LOW)

All six round-2 findings are fixed and verified through real paths. Gate:
795/795 across 41 files. The first full-suite run to cover the draw-label write
shows only environmental failures (poster-image-budget, schedule-build-honours-locks,
and org-posts-digest timing out on an accumulated DB). ext_key is selected at
every predicate call site; the marker can't be dropped or forged; V417 equals
V355 plus the exemption.

1. MEDIUM — `stages.ts:4226/4234` `resolveBracketSeats` stamps the PLAIN bye
   label on draw-made dead-feeder seats (double-elim losers'-bracket byes
   `lb-r0-i*`, the `se-3p` third-place bye), so the ICS feed still emits "X vs Bye".
   The orchestrator rules this a sit-out under the ICS ruling: stamp
   `DRAW_BYE_SLOT_LABEL` when the dead feeder is draw-made; withdrawal voids
   and walkovers keep the plain label.
2. LOW — lock-order inversion: `patchEntrant` (`entrants.ts:732→753`) and
   `withdrawCore` (`registrations.ts:4711→4719`) update the entrant row before
   taking the division lock, while `deleteEntrant` takes the lock first. A
   concurrent withdraw and delete of the same entrant can deadlock (40P01).
3. LOW — addFixture in a new round writes a rest bye (3-entrant league;
   `add-fixture.test.ts:138-147`). Owner ruled: no bye for hand-added matches.
