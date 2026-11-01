# W5 — round-robin family

**Goal.** When this wave is done an organiser running a league or groups can
add a late player and Generate without duplicating pairings, see who sits out
each round, Rebuild without silently losing the schedule, trust that a pool
table lists every seated member, get cross-pool runner-up comparisons that use
the sport's own tiebreaks, and read the same table on the hub, the export, the
digest and the API — across every sport.

## Read first

- `_RULES.md` (R5, R9, R13, R25–R27) and `_INDEX.md` (rulings 6, 11, 19; the
  recommendation that the repeated-`completeStage` finding is fixed here).
- Design §2, §4 (R1–R5, F1/F4–F7, P1–P4, P7, Q1/Q2, X2, C1–C7), §6.4 (the
  harness avoids repeat `/complete` until you fix it), §7.1, §7.3 (every pair
  meets once per leg — with its preconditions; metamorphic checks), §8 (W5 row),
  §9 (the W5 bench list), §10, §11 (O6).
- Audits: `audit-2026-09-27/FX-fixtures.md` (G1, G5, G13, G15, G21, G22),
  `ST-standings.md` (G3–G6, G13–G15, G20, G23, G24), `bench-reuse.md` §4,
  `plan-facts-api.md` (C4 Rebuild, C5 ad-hoc match, C6 complete).
- W4's decision-log note on the shared reconcile.
- Memory: "League +entrant then Generate ⇒ duplicate pairs; safe = Add match per
  missing pair" and "Rebuild NULLs schedule".

## Prerequisites

W4 merged (design §8 order, R1) — FX-G1 extends W4's reconcile.

## Scope

Rows: league, triple_rr, group, league_ko, groups_ko, group_stepladder,
group_playoffs. Routed gaps, copied from design §8:

#879 (all parts; part 3's hidden wipe is fixed by W3's #840),
#850, FX-G1 (round-robin side of the reconcile), FX-G5,
ST-G3/G5/G6/G14/G15/G20/G23/G24, the repeated `completeStage`
seed-proposal finding (bench), triple_rr possibly created as a single round robin
from the builder (hypothesis, `format-templates.ts:341`).

**Amended by W2d (ruling 183, D7; W2d spec §12.3):** ST-G4 (cross-group
best-Nth comparison), ST-G12 (IIHF partial-schedule order) and ST-G13 (residual
seed then UUID) moved to W2d and were built there. Design §8's W5 row and the
backlog section of `_INDEX.md` still list them under W5, because both are the
W1d baseline's routing (false premise 21 of W2d); a red on one of them is W2d's.

#840 and FX-G13 (Rebuild) are fixed in W3 — verify them on the round-robin rows; do not re-fix.

## Carry from W3 (late entry, owner 2026-11-01)

The owner wants late entry after Start in **every format and for every entrant kind** (individual, pair, team), not
only Swiss. W3 shipped the Swiss half (ruling 250); this wave owns the league and groups half. Reuse W3's shape so organisers learn
one action, and brainstorm only the format-specific rule:
- One organiser action, **"Add late player"**, in the stage rail's "More" menu, opening the Entrants tab's existing add
  form (W3 app-A Task 10). Never a second add form.
- The server decides the case and returns `late_entry` (W3 `LateEntryResult`); the desk shows one notice per case.
- The client start-lock mirror (`lib/open-entry-stages.ts`) and the Start dialog copy must agree with the server's
  per-format rule (W3 found them drifted).
- Automatic arrivals (registration confirm, waitlist, import, Reinstate) never reshape a published round.
- An undo barrier (`swiss_late_entry`-style ledger row) stops Undo from crossing the arrival.
- Prove it per format × entrant kind × case, counted, through the real usecases (W3 Task 10c is the template).
Rule to settle with the owner here: how a late player catches up in a league (all missed matches added as catch-up fixtures, or missed matches scored as losses) and which group a late player joins.

## Lifecycle (design §10)

1. Rulebook `rulebook-W5-round-robin.md` (drafted when the wave starts; FIFA/UEFA
   head-to-head first in groups, BWF/ITTF/FIVB/ICC/FIH/IIHF per sport) → **sign-off**.
2. Reference families: standings, tiebreaks, progression, exact oracle; a
   different agent than the engine fixer (R8). 3. Truth run on the seven rows —
   reproduce the triple_rr hypothesis by driving the builder before fixing.
4. Plan → implementer → reviewer; TDD; four test types; mutate every guard.
5. Gates. 6. **Bench gates: Candidates, Euro 2024 / Women's Euro 2025, T20 World
   Cup, Paris volleyball and hockey, IIHF 2025, carrom** (⏳ where no pack yet).
7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — per-case rulings: the withdrawal expunge threshold (hardcoded 50%,
  ST-G15), boardgame bracket cells on league_ko / groups_ko / group_stepladder /
  group_playoffs and generic group_playoffs (`offered-matrix.md` b, c), and any 🚫
  on your rows (e.g. C5 points deduction, a known 🚫 in §4, if it lands here).

## Done when

Ruling 19 on the round-robin rows: zero ❌ from the gaps above; others ⏳ with
their owner; nothing previously ✅/⛔ red anywhere (Swiss and knockout rows
included — the reconcile is shared); §10.5 gates; the W5 bench list run or
recorded deferred. The harness's repeat-`/complete` avoidance is removed and a
second call is a tested case (R27).

## Traps

1. **FX-G1 extends W4's reconcile — do not re-fix it.** A round-robin-only
   patch beside W4's bracket fix is the "patch per format" the test strategy
   warns against. If W4's seam does not fit, record why before changing it.
2. **Rebuild was fixed in W3 (#840 + FX-G13).** Re-run P4 (Rebuild after
   results) on every round-robin row; a red there is a W3 regression, not new
   W5 work — record it against W3.
3. **ST-G5 pool membership = entrants with a result**: an unplayed pool member
   is missing from the table. The empty-pool case is the first case (R13).
4. **Residual ties: fixed in W2d (stored lots)** (ST-G13, ruling 183). They
   used to fall to seed then UUID, so the shuffled-entry metamorphic check held
   only with explicit seeds and no `lots` (§7.3). Every non-Swiss order now ends
   in a lots draw stored on the stage (X-TB-3, X-TB-4); a red here is W2d's.
5. **`org-posts.ts` is shared with the W10 lane**: ST-G6 (`:1070`, `:1256`)
   sits beside ST-G22 (`:1077`, `:1263`). Check W10's file list before editing;
   overlap → sequence (R2).

## Output and handoff

Update the W5 row, decision log and "False premises found" (including the
triple_rr verdict) in `_INDEX.md` as they happen (R22).
