# B12 — pack: badminton (suite 5)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B15.

## Suite sheet

- **Suite 5 — org "All England 2025"** (badminton, setbased kernel).
- Div A: **All England Open 2025 Men's Singles** main draw (32). Div B:
  **Mixed Doubles** — `pair` entrants; where a player appears in BOTH
  draws, the SAME person row backs both entrants (the cross-draw person
  is the point of this suite).
- Cfg: 21×3 rally scoring; setbased kernel presets.
- Sources: BWF tournament software results (set scores complete),
  official entry lists.
- Squads: singles individuals + doubles pairs with pair order; ~100
  persons total after cross-draw dedupe.
- Constraint scenario (§5): 4 courts → 1 TV court for finals day
  (court-count change across days: encode via court-scoped windows or
  blackout of courts 2–4 on finals day), morning/evening sessions,
  **`crossPersonClash` is the suite's own gate**: the shared-person
  matches must never overlap; the checker asserts it independently.
- Certificate: session-level (BWF publishes order of play) — encode per
  day where archived.
- Specials: rally streams are `reconstructed` to exact real set scores
  (side-attributed — lossless per spec §4); any walkover/retirement per
  reality.
- Oracles: both champions; per-round results; the shared-person
  schedule-clash NEGATIVE oracle (no overlap ever); claims: one star
  claimed in BOTH capacities shows a career page spanning both
  divisions (**cross-division `personCareerStats` oracle** — this suite
  owns it programme-wide).
- Adaptations expected: qualifying excluded; seeding committee quirks
  n/a.
- Size: 31 + 31 matches, ~80–120 reconstructed rallies each → ~6k
  events; ~100 persons.

## Session-specific acceptance

- [ ] `crossPersonClash`: solver honored it AND checker independently
      proves zero overlap for every shared person
- [ ] Cross-division career rollup oracle green for the double-entered
      star
- [ ] Reconstruction exactness: every stream folds to the exact real
      set scores (validator already enforces; spot-check 5)
- [ ] Pair entrant kind + pair order round-trips through seed → roster
      read-back
- [ ] `_INDEX.md`: B12 → DONE + shared-person count + findings

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, provenance % (expect low —
reconstructed rallies), oracle summary, deviations.
