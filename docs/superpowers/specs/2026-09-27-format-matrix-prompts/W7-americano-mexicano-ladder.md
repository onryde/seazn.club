# W7 — americano, mexicano, ladder

**Goal.** When this wave is done an organiser choosing americano, mexicano or a
ladder either gets a session that works for their sport — fair partner
rotation, byes that rotate, personal points that count, a mexicano that keeps
producing rounds after a walkover, a ladder a newcomer can join — or is told
plainly, before building it, that this sport does not run that format. The
shipped `americano-night` template stops offering a tennis night that cannot
record a result.

## Read first

- `_RULES.md` (R5, R6, R12, R13, R25) and `_INDEX.md` (rulings 6, 11, 19).
- Design §1 (37 unfit cells), §2, §3 (`formats.advanced` entitlement, one
  denied-state case), §4 (R1/R3/R4, F1, M1/M2), §7.1 (product rules — no
  federation governs these), §8 (W7 row), §10, §11 (O6).
- Audits: `audit-2026-09-27/offered-matrix.md` (reason a), `FX-fixtures.md`
  (G6, G8–G12), `ST-standings.md` (G19, G30), `plan-facts-api.md` (C9 ladder
  challenge), `_INDEX.md` decision log (`americano-panel.tsx:162`,
  `americano-night.json`).

## Prerequisites

W6 merged (design §8 order, R1).

## Scope

Rows: americano, mexicano, ladder (all 11 sports). Routed gaps, copied from
design §8:

the 20 unfit americano/mexicano cells (case-by-case rulings); ladder; FX-G6,
FX-G8–G11; the broken `americano-night` tennis template.

Unlisted gaps on these formats go to you under the §8 preamble — enumerate them
from the audits at start and record each assignment in the decision log.

## Lifecycle (design §10)

1. Rulebook `rulebook-W7-americano-mexicano-ladder.md` (drafted when the wave
   starts; product rules, since no federation governs) with **one recommendation
   per unfit cell** → **sign-off**.
2. Reference families: rotation coverage, bye fairness, personal points, ladder
   order; a different agent than the engine fixer (R8). 3. Truth run.
4. Plan → implementer → reviewer; TDD; four test types; mutate every guard.
5. Gates. 6. No bench gate (§9). 7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — for each of the 20 unfit cells: build (a per-sport result path for
  the console) or refuse at the builder with guidance; the `americano-night`
  template (re-sport it or fix tennis); ladder entry for a late joiner; bye
  rotation and per-game vs summed leaderboard. Ruling 6 forbids a blanket
  default — each cell gets its own line, even if many say the same thing.

## Done when

Ruling 19 on the three rows: zero ❌ from the gaps above; every unfit cell is ✅
or ⛔-with-guidance by a signed ruling; others ⏳ with their owner; nothing
previously ✅/⛔ red anywhere; §10.5 gates; the denied-state case (no
`formats.advanced`) observed as ⛔.

## Traps

1. **"Rotation covers pairings evenly" cannot see missing pairs** (FX-G8, class
   4): it compares only pairs that occurred. 8 players reach 21 of 28. Count the
   pairs expected by the rulebook, not the ones produced (R9, R25).
2. **The console writes `generic.result`** and personal points read
   `state.score`, which only generic exposes; even generic's `win_loss` variant
   refuses the panel's payload. A cell "working" on generic `score` says nothing
   about generic `win_loss`.
3. **Team sports declare a team-only entrant model** while americano pairs are
   built from persons (`offered-matrix.md` reason a) — a result path alone does
   not make football americano coherent. Put that to the owner, not a patch.
4. **Mexicano stops on any non-`decided` fixture** (FX-G11): a `finalized`,
   `forfeited` or `abandoned` match blocks every later round. Drive M1 and M4
   through the next-round generate, not just the result.
5. **A ladder newcomer is `LADDER_ENTRANT_FOREIGN`** (FX-G6): `ladder_order`
   is written once. Test the late joiner as both challenger and challenged.

## Output and handoff

Update the W7 row, decision log and "False premises found" in `_INDEX.md` as
they happen (R22). Per-cell rulings go into "Owner rulings" only once signed.
