# B10 — pack: tennis (suite 3)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B15. Second-largest pack (PBP volume).

## Suite sheet

- **Suite 3 — org "AELTC Championships"** (tennis module, nested
  kernel).
- Div A: **Wimbledon 2025 Gentlemen's Singles**, 128 draw (Sinner d.
  Alcaraz final), best-of-5 grand-slam preset. Div B: **Ladies' Singles
  2025** (Świątek d. Anisimova 6-0 6-0), best-of-3 preset — the variant
  contrast is the cfg preset pair.
- Sources: public Grand-Slam point-by-point archives (Sackmann-style)
  for main-draw PBP; official draw sheets; where an outer-court match
  lacks PBP → set-score stream, `provenance:"reconstructed"` for the
  point sequence folding to the EXACT real game/set scores.
- Squads: individual entrants ×128 + ×128; officials: chair umpires for
  show-court rounds where published (P1 oracle: the finals' umpires).
- Constraint scenario (§5): **18 courts**, 14 days, **23:00 curfew as a
  daily blackout**, show-court sessions starting 13:30/13:00 encoded as
  court-scoped `sessionWindows` (or D5 court calendars if live — B00
  inventory), 1 match/player/day via `perEntrantMinRest` (~20h),
  middle-Sunday played.
- Certificate: partial-to-full (order of play archives exist per day) —
  encode what research yields; absent days go uncovered honestly.
- Specials: final-set 10-point tiebreak instances; **retirements**
  (2025 R1 heat wave — record the real ones; engine path per B00's
  risk-6 answer, else §7A admin-finalize adaptation); walkover if any.
- Oracles: both champions; per-round results; the 6-0 6-0 final folds
  exactly; leaders: most aces IF tier-representable (else §7A drop
  recorded); claims for 3 stars each draw; news drafts on finals.
- Adaptations expected: qualifying rounds excluded (main draw only —
  scope adaptation recorded); seeds' court preferences NOT modeled
  (report-only note, spec §5 already says fieldFairness is besteffort).
- Size: 127+127 matches; PBP ~200–300 events each where archived →
  **~30–50k events depending on PBP coverage**; ~260 persons. Same
  throughput escape hatch as B08 (import path for one div if live,
  single-POST kept on the other).

## Session-specific acceptance

- [ ] Curfew blackout honored in schedule AND checker (no fixture spans
      23:00)
- [ ] 1-match/player/day proven by checker rest rule across 128-draw
      density
- [ ] Retirement matches fold to the historical winner via the engine's
      actual mechanism (B00 answer), adaptation recorded if
      admin-finalize
- [ ] PBP-vs-reconstructed split visible per round in provenance report
- [ ] `_INDEX.md`: B10 → DONE + PBP coverage % + findings

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, PBP coverage, oracle
summary, throughput, deviations.
