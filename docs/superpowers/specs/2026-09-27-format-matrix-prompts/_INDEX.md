# Format × sport matrix — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-27-format-matrix-design.md`
- **Audit inputs (hypotheses, not facts):** `audit-2026-09-27/`
- **Cross-programme sequencing:** `../bench-product-value/_MASTER.md`

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1a | L3 core: lean runner, HttpDriver, 11 stream generators, invariants, MATRIX generator | plan being written |
| W1b | Catalogues (atomic cases, applicability, variants, pairs) + reference skeleton | not started |
| W1c | Browser layers: page objects, 11 pad adapters, L1/L2 | not started |
| W1d | CI (weekly + dispatch, visibility guard) + first full truth run | not started |
| W2 | Sport scoring fidelity | not started |
| W3 | Swiss | not started |
| W4 | Knockout family | not started |
| W5 | Round-robin family | not started |
| W6 | Double elimination | not started |
| W7 | Americano, mexicano, ladder | not started |
| W8 | Scorer sheets (lane) | not started |
| W9 | Operational [O] (lane) | not started |
| W10 | Sweep: #878 #858 #853 #843 (lane) | not started |

## Owner rulings

Rulings BY THE OWNER, 2026-09-27 brainstorm. Recommendations I made are in the
next section and are **not** interchangeable with these. Never carry either to
a peer session as the other.

1. **Scope B** — all nine issues opened 2026-09-23 → 09-27 are folded in:
   #879 #850 #846 #870 (format work), #880 #878 #858 #853 #843 (lanes).
2. **Order by what customers hit next** — no events booked, so production
   usage was pulled (badminton knockout 10 / Swiss 9 / league 1 divisions).
   Refined by ruling 3.
3. **The whole format × sport matrix is the frame; approach 1** — customer-path
   waves grouped by format family. No guard-only "W0" wave.
4. **Every offered cell gets a browser walkthrough (B)**, and edge cases are a
   first-class axis — "what happens in the middle of a withdrawal, a walkover
   in only one match, etc."
5. **All [M] scenarios join the scenario axis; [O] items are a separate wave**
   (W9).
6. **Unfit cells and unsupported scenarios: case by case (C)** in each wave's
   rulebook — no blanket default.
7. **Three layers (A):** L1 every cell's lifecycle in the browser, L2 every
   (format, scenario) and (sport, scenario) pair in the browser, L3 the full
   cartesian through the real server.
8. **Bench: fold B17 into this programme (A); this programme goes first,
   bench suites interleave** as closing gates after the matching wave.
9. **Section 1 (programme shape and waves) approved.**
10. **Expected values: a full reference model (C)** — pairing, brackets,
    progression and standings — plus invariants.
11. **Rulebooks follow federation rules (A)**; product rules where no federation
    governs; deliberate deviations recorded as owner rulings.
12. **Customisation levels:** stage-level for every setting; fixture-level for
    **match format only** (game points, sets, best-of, overs, halves), **only
    before the fixture starts**; **never** per-fixture table points or
    tiebreakers (Q11 A); **no mid-match rule change**. Worst case named by the
    owner: a final with no time left gets shorter games before it starts.
13. **Sections 2 (harness) and 3 (rules and done) approved.**
14. **Written spec approved** (2026-09-27, commit `b56a19ad4`).
15. **Mixed-driver lifecycle accepted** for L1/L2 (design §6.2, O2): every
    distinct action type in the browser at least once; filler fixtures scored
    over HTTP.
16. **CI cadence: weekly scheduled full run + manual dispatch** (design §6.5,
    O1). Refined by ruling 20.
17. **Do not split `run-suite.ts`** — the L3 runner is a lean runner of its own
    reusing only the bench's small helpers; bench runner work is no longer
    blocked by W1 (amends the sequencing half of ruling 8; B17 stays folded in).
18. **W1 is split into W1a–W1d** (L3 core · catalogues + reference skeleton ·
    browser layers · CI + truth run).
19. **Wave done = zero ❌ attributable to the wave's own routed gaps**; other
    reds on its rows are tagged ⏳ with their owning wave; the programme end
    still requires the whole matrix green.
20. **Weekly L1 + L2 + L3 while the repo is public ($0 on standard runners).**
    The owner will make the repo private later; the private-repo plan
    (self-hosted runner) is a recommendation to be ruled at the switch.

## Recommendations (mine — not rulings)

- A guard-only W0 before the real fixes — **declined** by ruling 3.
- #878 (browser Sentry) ships early from the W10 lane; it is a one-file ops fix.
- CI weekly + dispatch (O1) — **accepted**, now rulings 16/20.
- When the repo goes private: move the weekly matrix to a self-hosted runner
  (free today — GitHub postponed its self-hosted charge). The owner proposed a
  public shim repo pulling a private image; I recommended against it (Actions
  terms exclude hosted-runner work unrelated to the repo's own project; public
  logs). Not ruled.
- Mixed-driver lifecycle (O2) — **accepted**, now ruling 15.
- L1 at 1280 + 320 per cell; L2 rotates the seven widths (design §11 O3).
- The bench's repeated-`completeStage` finding is fixed in W5; the harness
  avoids repeat calls until then.

## Decision log

- **2026-09-27** — five read-only audits (~150 gaps), offered-cell map (no door
  restricts sport × format; 37 cells unfit), bench reuse assessment. All saved
  under `audit-2026-09-27/`.
- **2026-09-27** — spot-checks by the orchestrating session (code read, not
  product-driven): SW-H1 (`swiss.ts:280` returns an empty round), SW-H2
  (`lib/swiss-rounds.ts` has no production caller), FX-G1 / #879 (Generate
  inserts by `extKey` position, `stages.ts:2509`; the button's comment calls it
  "routine, safe"), SC-X1 (`append-event.ts:334` refuses only `draw`), ST-G5
  (`stage.ts:178` pool membership = entrants with a result), SH-G1
  (`print-scorer-sheets.tsx:95` sends only `{date}`), americano console writes
  `generic.result` (`americano-panel.tsx:162`) and `americano-night.json` is
  tennis.
- **2026-09-27** — independent spec review (reviewer agent): Approve with
  fixes, 34 findings (5 High), none contradicting a ruling; all applied in the
  amended design (states ⏳/🚫/░, committed applicability, invariant
  preconditions, Swiss reference scope, single owner per gap, entitlement
  dimension, cost recount). Review kept at `audit-2026-09-27/spec-review.md`.
- **2026-09-27** — plan-facts scouts: the bench has **no run-time event
  simulation** (packs replay recorded streams; stream generators for all sports
  are new work); `run-suite.ts` is one ~4,100-line function (split dropped,
  ruling 17); no create-from-template-key endpoint; no quick-result endpoint;
  disqualify does not cascade; triple_rr from the builder may come out as one
  leg (hypothesis). Facts kept under `audit-2026-09-27/plan-facts-*.md`.
- **2026-09-27** — the repo is PUBLIC again (`gh repo view`), so standard
  runners are free; the earlier $85/run estimate assumed private.
- **2026-09-27** — stale memory corrected: per-stage match rules #804 merged
  2026-09-20 (D7 went option A, `7d5433faf`); bench B07a merged (#792).

## False premises found

(none yet — record each audit gap that fails to reproduce here, with the wave
that tried)
