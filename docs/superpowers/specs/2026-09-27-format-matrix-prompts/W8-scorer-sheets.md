# W8 — scorer sheets (lane)

**Goal.** When this wave is done an organiser can print the sheets they
actually need — one division, a date range, untimed matches — from a screen,
revoke a whole day's printed credentials at once, and trust that a printed card
still checks the plan when it is scanned. Every format and every sport has been
scanned, started and scored from a real card, not just `generic`.

## Read first

- `_RULES.md` (R2, R5, R14a, R16, R23, R24, R26) and `_INDEX.md` (rulings 1, 4,
  19; #870 is folded in by ruling 1).
- Design §2, §4 (E4 device link / printed-sheet scan; "cases that need times"
  are L1/L2 only; the printed sheet is an asserted surface), §8 (W8 row and the
  lanes paragraph), §10, §11 (O6).
- Audits: `audit-2026-09-27/SH-sheets.md` (whole), `SW-swiss.md` (M13 — bye
  shell on a court, W3's), `FX-fixtures.md` (G19).
- Memory: printable scorer sheets (#869 merged), the scorer-sheet spec and its
  plan (the source of D5 and Q10 cited in the audit).

## Prerequisites

A parallel lane (R2). **Before starting, list this lane's file set and prove it
disjoint from the wave in flight** (grep the wave's plan and open branch for
every file you will touch), and record the proof in `_INDEX.md`. Likely
collisions: `stages.ts` bye-shell code (W3, SW-M13 / SH-G16) and `schedule.ts`
(W9). A production change that forces an edit in the other lane's or wave's
files → stop and sequence.

Recommended (not a ruling): start the per-format/per-sport card work after W1c
merges, because E4 and every sheet case run only in L1/L2 (§4).

## Scope

Routed gaps, copied from design §8:

SH-* (SH-G1 unreachable print options = #870; plan re-check when scoring; revoke
a day; untimed matches; non-Latin fonts; per-format and per-sport card tests,
SH-G7) — **enumerate SH-G1…G22 from `SH-sheets.md` at start**.

## Lifecycle (design §10)

1. Rulebook `rulebook-W8-sheets.md` (drafted when the lane starts: what a card
   carries per format and sport, which prints refuse, credential lifetime)
   → **sign-off**. 2. Reference: no format family here — record in the rulebook
   which harness invariants the sheet cases assert instead. 3. Truth run on the
   E4 / printed-sheet cases. 4. Plan → implementer → reviewer; TDD; four test
   types; mutate every guard. 5. Gates. 6. No bench gate. 7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — per-case rulings: non-Latin glyphs (the audit cites an earlier owner
  acceptance, plan Q10, from the scorer-sheets programme — **re-put it; it is
  not a ruling of this programme**, class 17), no format on the card (spec D5,
  same caveat), untimed printing, bulk revoke scope, the Swiss bye shell card.
- Any new print control — ≥2 options shown first (R24).

## Done when

Ruling 19 on the sheet cases: zero ❌ from SH-*; others ⏳ with their owner;
nothing previously ✅/⛔ red anywhere; §10.5 gates with per-screen verdicts at
1280/768/320 for the print and scan screens; four locales + `gen-keys` (R23).

## Traps

1. **Every sheet test uses `generic`** (SH-G7, class 7): sweep the sports with
   `forEachSport` (R26) and scan → Start → score a real sport from a real card.
2. **Credentials in the PDF**: the repo is public (R14a). A test artifact or CI
   log holding a printed QR or link is a live credential leak — synthetic orgs,
   and never upload a real PDF.
3. **An ordering test that cannot see the sort key** (SH-G15): "Open" < "Second"
   in both name and seq order. Pick names whose name order differs from seq order.
4. **SH-G1's route is session-only** and API keys are refused — the harness
   drives it with a session, and a UI that only calls the route with `{date}`
   is exactly the inert seam (class 1).
5. **Stale cards** (SH-G12, SH-G18) cross into W9's "stale sheet scanned after
   a move or rebuild" [O] item — agree which lane owns the shared code first.

## Output and handoff

Update the W8 row, the disjointness proof, decision log and "False premises
found" in `_INDEX.md` as they happen (R22).
