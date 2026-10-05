# W3 — Swiss

**Goal.** When this wave is done an organiser running a Swiss (nine live
divisions today, all badminton) gets pairings that never silently dead-end,
round-count guidance that matches the field, byes worth what the rulebook says
and counted in Buchholz the FIDE way, Swiss tiebreaks for every sport, chess
colours that alternate, an Undo that actually unseats a round, and an ad-hoc
match that no longer hands everyone else a phantom bye.

## Read first

- `_RULES.md` (R5, R6, R8, R12, R13, R25, R28) and `_INDEX.md` (rulings 6, 11,
  12, 19; the O7 recommendation).
- Design §2, §4 (R1/R2/R15 late entry and leavers, F1 byes, P5 undo, M2 double
  walkover), §7.1 (FIDE), §7.2 (Swiss reference = hard legality + existence),
  §7.3 (no rematch, Buchholz under the bye rule), §8 (W3 row), §9 (Grand Swiss
  gate), §10, §11 (O6, O7).
- Audits: `audit-2026-09-27/SW-swiss.md` (whole), `SC-scoring.md` (O7, S6),
  `ST-standings.md` (G2, G21), `SH-sheets.md` (G16, G18 — context only, W8 owns).
- Memory runbooks: Swiss pre-Start roster change (Withdraw → Unpair → Pair),
  "BYE eats a row", "DELETE entrant strands round".

## Prerequisites

W2 merged (design §8 order, R1) — SW-M9 needs W2's double-walkover engine
outcome (SC-S6) and SW-H4 builds on W2's tiebreak validation and UI (ST-G10).

## Scope

Rows: swiss, swiss_playoff, swiss_knockout. Routed gaps, copied from design §8:

SW-* (H1 failed pairing reported as success; H2 round guidance; H3 chess
colours; H4 Swiss tiebreak families; M1 Buchholz bye; M2 undo Pair next; bye
points, snapshot and court booking; byeScore SC-O7/SW-M8 owned here; Swiss
handling of double walkover SW-M9, engine outcome from W2) — **enumerate
SW-H1…H4, M1…M13, L1…L12 from `SW-swiss.md` at start**; #846; ST-G21
(slideshow Buchholz column); #838 recorded as answered by ruling 12 (round count
per stage) — confirm in the rulebook.

**SW-M12 is #840, and W3 owns it** (design §8, amended 2026-09-27): W3 is the
first wave that needs Rebuild, so it fixes **#840 + FX-G13** here — Rebuild
keeps times and courts, and delete + regenerate run in ONE transaction (a throw
must not leave the stage empty). Build it format-agnostic; W5 consumes it for
league rows and #879 part 3.

## Lifecycle (design §10)

1. Rulebook `rulebook-W3-swiss.md` (draft being written in parallel) — FIDE by
   default, deliberate simplifications recorded as owner rulings → **sign-off**.
2. Reference family: legality + existence, with the n bound for exhaustive or
   blossom matching set here (§7.2); a different agent than the engine fixer.
3. Truth run on the three rows. 4. Plan → implementer → reviewer; TDD; four test
   types; mutate every guard. 5. Gates. 6. **Bench gate: Grand Swiss** (deferred
   ⏳, not blocking, if its pack has not landed, §9). 7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O7** — #838 round count per stage or division-wide. Recommended as answered
  by ruling 12 (per stage). **It stays a recommendation until the signed
  rulebook says so**; #838's own title asks for an owner ruling.
- **O6** — per-case rulings: bye value (full / half / zero), requested byes,
  late entry after Start (SW-L7), manual board swap (SW-L12), the boardgame
  swiss_playoff / swiss_knockout cells (`offered-matrix.md` reason b) and
  generic swiss_playoff (reason c), and any 🚫 on your rows.

## Done when

Ruling 19 on the Swiss rows: zero ❌ from the gaps above (including #840/FX-G13),
nothing previously ✅/⛔ red anywhere; §10.5 gates; Grand Swiss run or recorded
deferred. The "no rematch" and "fully paired" invariants report non-zero counts
on every round (R25).

## Traps

1. **"No rematch ever" passes on an empty round** (SW-L9) — which is why SW-H1
   shipped. Every pairing property counts its pairs; zero is a failure.
2. **The Undo test asserts the shell count, not the seats** (SW-M2, class 4).
   Assert the seats cleared, and mutate the undo to prove the test can see it.
3. **The reference is not a second pairing engine** (§7.2): it asserts
   legality and that a legal pairing exists; a preference order only where the
   rulebook fixes one.
4. **`swissGen` hard-codes win 1 / draw 0.5 / bye 1** (SW-M11) while the table
   uses the sport's points; chess stores half-points (ST-G2, W2's). Derive the
   expected groups from the rulebook, never from either constant (R9).
5. **Nine live divisions.** A pairing or bye change reaches events mid-round;
   say in the plan what happens to a round already paired under the old rule.

## Output and handoff

The fix for SW-H1 removes owner ruling 70's override in the same change: delete the `ruling70` block of
`tools/matrix/catalogue/baseline.json` and `RULING_70_IDS` in `tools/matrix/lib/pr-sample.ts`, and re-baseline L3
(`truth-runs/w1d-baseline/README.md`, "Owner ruling 70"). A test fails once the committed baseline shows none of the three
cells red, and a re-baselined L3 refuses the block. Both fire at the re-baseline, not when the fix lands: a W3 fix merged without re-baselining L3 leaves the override live, where it can hide a regression on those three cells only, so re-baseline in the same change.

Update the W3 row, decision log and "False premises found" in `_INDEX.md` as
they happen (R22). The O7 answer moves to "Owner rulings" only when the owner
signs the rulebook.
