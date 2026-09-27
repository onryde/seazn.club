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

#879 (all parts), #840 (Rebuild wipes the schedule — owned here; W3 consumes),
#850, FX-G1 (round-robin side of the reconcile), FX-G5, FX-G13,
ST-G3/G4/G5/G6/G13/G14/G15/G20/G23/G24, the repeated `completeStage`
seed-proposal finding (bench), triple_rr possibly created as a single round robin
from the builder (hypothesis, `format-templates.ts:341`).

W3 tagged its SW-M12 (#840) reds ⏳ W5 — close them here and re-run the Swiss rows.

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
2. **#840 is two defects in one button**: Rebuild deletes and regenerates in
   two transactions (a throw leaves the stage empty, FX-G13) and NULLs every
   time and court while the confirm hides it (#879 part 3). Fix and test both.
3. **ST-G5 pool membership = entrants with a result**: an unplayed pool member
   is missing from the table. The empty-pool case is the first case (R13).
4. **Residual ties fall to seed then UUID** (ST-G13): the shuffled-entry
   metamorphic check holds only with explicit seeds and no `lots` (§7.3).
5. **`org-posts.ts` is shared with the W10 lane**: ST-G6 (`:1070`, `:1256`)
   sits beside ST-G22 (`:1077`, `:1263`). Check W10's file list before editing;
   overlap → sequence (R2).

## Output and handoff

Update the W5 row, decision log and "False premises found" (including the
triple_rr verdict) in `_INDEX.md` as they happen (R22).
