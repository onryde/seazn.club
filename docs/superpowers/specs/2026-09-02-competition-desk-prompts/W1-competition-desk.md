# W1 — the competition page becomes an organiser desk

Read `_RULES.md` and `_INDEX.md` beside this file first. Spec §W1:
`../2026-09-02-competition-desk-design.md`. Plan:
`../../plans/2026-09-02-competition-desk-w1.md`.

## Why the wave exists

The competition page showed three chips per division that could contradict each
other. The 2026-09-02 seed showed Premier Division reading
`Scheduled · 15 of 15 played · nothing scheduled` — every match played, and the
page still calling it scheduled with nothing coming. An organiser cannot tell
from that screen which division needs them.

W1 replaces the chips with a derived phase, an orthogonal attention list, a
"Needs you" section, and a division ledger.

## What shipped

| Piece | File |
| --- | --- |
| Phase + attention resolver | `apps/web/src/lib/division-phase.ts` |
| One-line status string | `apps/web/src/lib/division-status-line.ts` |
| Desk use case (one query set) | `apps/web/src/server/usecases/competition-desk.ts` |
| Pill, Needs you, ledger | `apps/web/src/components/v2/desk/` |
| Page wiring | `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` |
| Tip gating + stage order | `apps/web/src/components/v2/stages-panel.tsx` |
| E2E, walkthrough, smoke, help | `apps/web/e2e/competition-desk.spec.ts`, `apps/web/e2e/walkthrough/competition-desk-organiser.spec.ts`, `scripts/smoke.ts`, `content/help/**` |

Two changes ride along because they are one-liners the owner had already seen:
the `division.start-locks` tip is gated to `phase === "setting_up"`, and stages
render by `seq` ascending always (the complete-sinks-last term is gone).

## Defects this wave FOUND in itself

Every one was found by loading the page and reading it. None was found by a
suite, and several survived suites that were green, mutation-tested and
reviewed. They are listed so a later wave does not reintroduce them.

1. A division whose stages were all played but never marked complete read
   `Scheduled · nothing scheduled`. Fixed by the finished rule, guarded so a
   stage still owing a draw does not flip to finished.
2. An empty division read "Finished" before it began (spec amendment 2).
3. An empty competition read "Finished · 0 divisions" above "No divisions yet"
   (spec amendment 3).
4. A started division with fixtures but no times read
   `Scheduled · 0 of 6 played · nothing scheduled · 6 unscheduled · Next: …` —
   three contradicting facts in one row, i.e. the wave's own headline defect
   rebuilt on the page built to remove it. Found by the final whole-branch
   review, driving a live server.
5. The phase pill vanished at 320; the status line truncated where the meaning
   was; "Nothing scheduled next" printed on rows with nothing left to schedule;
   the page and the ledger both rendered a "Divisions" heading.
6. Removing that next-line text left its grid TRACK reserved, leaving a dead
   gap between the pill and the Open button.
7. Six copy defects: a verb agreeing with a plural stage name, four counted
   strings rendering "1 fixtures"/"1 registrations"/"1 divisions"/"1 entrants",
   and one orphaned key.
8. `competitionPhase` returned the phase WORD where the spec's ladder asks for
   the earliest next fixture DATE, making "Setting up" reachable for a
   competition 43 matches deep.

## Open at the time of writing

Fix round B still owes: an unfiltered score-event subquery (a seq scan on every
public competition-page render, for every viewer); `result_missing`/`no_scorer`
emitting one row per fixture with no aggregation (a 15-fixture league gives 15
rows and pushes the ledger below the fold at 320); and "has no scorer" testing
only `eventCount === 0` while never reading `scorer_assignments`, so the
"Assign scorer" action the row offers cannot clear the row.

One question is open rather than merely unfixed: zero stages + a non-`setup`
division status + no live fixture still resolves to `finished`, and both
`replaceStages` and `deleteStage` can leave a started division stage-less. It
could not be constructed through the UI. Decide it before W2 builds on the
phase.
