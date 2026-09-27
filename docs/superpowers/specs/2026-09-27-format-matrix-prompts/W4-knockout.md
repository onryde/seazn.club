# W4 — knockout family

**Goal.** When this wave is done an organiser running a bracket (ten live
badminton knockout divisions today) can add a late entrant and see them placed
instead of "up to date", can switch on a third-place match from a screen, gets
a page playoff that survives a top seed withdrawing, a plate that starts when
round-one losers exist, a knockout that notices a corrected qualifier, and
public tables that stop showing a finished bracket as all zeros.

## Read first

- `_RULES.md` (R5, R12, R13, R15, R24, R27) and `_INDEX.md` (rulings 6, 11, 19).
- Design §2, §3 (API-only rows: knockout + `thirdPlace`, standalone
  page_playoff and stepladder), §4 (F1/F3/F8, P2, Q1–Q5, R6, surfaces list),
  §7.1–7.3 (one champion, permutation ranks, preconditions for shared places),
  §8 (W4 row), §9 (All England, Wimbledon, WTTC gates), §10, §11 (O6).
- Audits: `audit-2026-09-27/FX-fixtures.md` (G2, G7, G14, G16, plus G17/G18
  context), `ST-standings.md` (G7, G26, G18), `SC-scoring.md` (X1–X4, O1 — W2's,
  for context), `offered-matrix.md` (boardgame "?b" bracket cells).

## Prerequisites

W3 merged (design §8 order, R1).

## Scope

Rows: knockout, ko_plate, qualifying_main, third place, stepladder,
page_playoff. Routed gaps, copied from design §8:

FX-G2 (bracket growth on Generate — **owns the shared position-keyed reconcile
fix**, which W5 extends to round-robin), FX-G7, FX-G14, FX-G16 (a confirmed
proposal keeps a stale qualifier), third-place UI, ST-G7 + ST-G26 (finished
knockout as all-zero tables on embed/slideshow/OG).

Unlisted gaps on these formats go to you under the §8 preamble — enumerate them
from the audits at start and record each assignment in the decision log.

## Lifecycle (design §10)

1. Rulebook `rulebook-W4-knockout.md` (drafted when the wave starts; BWF, ITF,
   ITTF and the product rules for page playoff / stepladder) → **sign-off**.
2. Reference families: bracket progression and final ranks, exact oracle; a
   different agent than the engine fixer (R8). 3. Truth run on the six rows.
4. Plan → implementer → reviewer; TDD; four test types; mutate every guard.
5. Gates. 6. **Bench gates: All England, Wimbledon, WTTC** (⏳ if no pack yet).
7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — per-case rulings: the boardgame cells on your six rows (6 of the 37
  unfit cells, `offered-matrix.md` reason b; the root cause is W2's SC-O1) and
  generic standalone page_playoff (reason c, W2's SC-O2),
  shared 3rd vs a played third place, joint winners when a final is not played
  (Q4, a known 🚫 in §4), plate eligibility with byes, and any other 🚫.
- The third-place control is new UI — ≥2 options shown first (R24).

## Done when

Ruling 19 on the knockout rows: zero ❌ from the gaps above; others ⏳ with their
owner; nothing previously ✅/⛔ red anywhere; §10.5 gates; the three bench gates
run or recorded deferred. The reconcile fix passes the R27 four questions —
second call, empty input, after a withdrawal or void, another sport — in writing.

## Traps

1. **The reconcile is shared.** W5 extends it to round-robin (FX-G1); build one
   pairing-identity reconcile, not a bracket-only patch that W5 must redo. Within
   one bracket size nothing is inserted; crossing a power of two leaves the old
   final beside a new one — test both sides of 8→9.
2. **Ten live divisions.** Reconcile changes touch brackets already in play;
   the Girls' Singles runbook (record the W/O first, then withdraw) exists
   because withdrawal order matters here.
3. **page_playoff voids instead of walking over** (FX-G7): the dead feeder hands
   walkovers onward, so seed 2 can be eliminated without playing. Assert who
   plays whom, not that the stage completed.
4. **"Unordered query" defects hide behind one sample** (ST-G26, class 7): OG
   takes `standings[0]` from an unordered read — assert order across pools and
   a KO placement, and anchor HTML assertions on `="`.
5. **Third place is API-only today** (`config.thirdPlace`): L1/L2 create it over
   `HttpDriver`; the missing control is itself your ❌ until the UI ships.

## Output and handoff

Update the W4 row, decision log and "False premises found" in `_INDEX.md` as
they happen (R22). Leave W5 a short note in the decision log describing the
reconcile's shape and its seam for round-robin.
