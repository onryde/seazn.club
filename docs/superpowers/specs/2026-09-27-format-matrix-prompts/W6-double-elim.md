# W6 — double elimination

**Goal.** When this wave is done an organiser running double elimination gets
a grand-final reset that only exists when it is needed, an unbeaten champion who
can never be ranked last, and a losers' bracket that crosses its drops the way
standard brackets do, so players stop replaying the opponent they just lost to.
The plan-gated state is covered too: an organiser without `formats.double_elim`
is refused with plain guidance.

## Read first

- `_RULES.md` (R5, R9, R12, R13, R25) and `_INDEX.md` (rulings 6, 11, 19).
- Design §2, §3 (entitlements: `double_elim` needs `formats.double_elim`; one
  denied-state case), §4 (F1/F3/F8, M1/M3/M9, R4–R6, Q3), §7.1–7.3 (one champion,
  ranks a permutation, preconditions), §8 (W6 row), §10, §11 (O6).
- Audits: `audit-2026-09-27/FX-fixtures.md` (G3, G4, G24), `ST-standings.md`
  (G33), `SH-sheets.md` (G17 — context only, W8 owns), `offered-matrix.md`.

## Prerequisites

W5 merged (design §8 order, R1). No bench gate lines up after W6 (§9).

## Scope

Row: double_elim (all 11 sports). Routed gaps, copied from design §8:

FX-G3, FX-G4.

Unlisted gaps on double_elim go to you under the §8 preamble — enumerate them
from the audits at start and record each assignment in the decision log.

## Lifecycle (design §10)

1. Rulebook `rulebook-W6-double-elim.md` (drafted when the wave starts; product
   rules plus the sport federations' tie rules for the match layer) → **sign-off**.
2. Reference family: DE bracket progression and final ranks, exact oracle; a
   different agent than the engine fixer (R8). 3. Truth run on the row.
4. Plan → implementer → reviewer; TDD; four test types; mutate every guard.
5. Gates. 6. No bench gate (§9). 7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — per-case rulings: whether a forfeit/no-show drops the absent player
  to the losers' bracket or eliminates them, the boardgame double_elim cell
  (`offered-matrix.md` reason b; root cause W2's SC-O1), whether the bracket
  reset is on by default, and any 🚫 on the row.

## Done when

Ruling 19 on the double_elim row: zero ❌ from FX-G3 and FX-G4; others ⏳ with
their owner; nothing previously ✅/⛔ red anywhere; §10.5 gates. The denied-state
case (no `formats.double_elim`) is observed as ⛔ with guidance.

## Traps

1. **The champion ranked last** (FX-G3): if an unneeded reset is abandoned,
   `bracketRanks` finds no decided final. The invariant "one champion, ranks a
   permutation" must run on the abandoned-reset path, not only the happy one.
2. **One sample is not a sweep** (ST-G33, class 7): DE ranks are tested with 2
   entrants. Enumerate field sizes across powers of two and odd fields, and
   count the LB rematches the reference sees — zero checked is a failure (R25).
3. **FX-G4 needs a case where the right answer differs** (class 19): with the
   favourite winning every match every LB major-round game is a rematch; a
   random-winner fixture may hide it.
4. **`page_playoff` shares the `formats.double_elim` key** (§3) but belongs to
   W4. Do not change the gate without re-running W4's denied-state case.
5. **The reset prints like any match** (SH-G17) — that is W8's. If your fix
   changes `conditional`, tell the W8 lane rather than editing sheet code.

## Output and handoff

Update the W6 row, decision log and "False premises found" in `_INDEX.md` as
they happen (R22).
