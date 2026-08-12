# B13 — pack: table tennis (suite 6)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B15. Smallest post-pilot session — explicitly
pairable with B12 or B14 in one wave if research runs thin (record the
pairing in `_INDEX.md`).

## Suite sheet

- **Suite 6 — org "WTTC 2025 Doha"** (tabletennis, setbased kernel).
- Div A: Men's Singles main draw (64 — Wang Chuqin d. Hugo Calderano
  final per the real result; verify at research). Div B: Women's
  Singles (Sun Yingsha; verify).
- Cfg: 11×7 (bo7 from R16 per ITTF — encode the real per-round bo5/bo7
  split via stage cfg if supported, else §7A single-format adaptation
  recorded).
- Sources: ITTF/WTT results portal (game scores complete), draw sheets.
- Squads: individuals ~128; officials where published.
- Constraint scenario (§5): many tables (8) collapsing to 2 then 1
  across the week; day caps; two sessions/day.
- Certificate: session-level order of play where archived.
- Specials: **expedite rule** — no reliably archived real instance
  expected: encode ONE reconstructed long-game stream flagged
  `reconstructed` that triggers the engine's expedite knob, and record
  in `meta.adaptations[]` that the trigger is synthetic-by-necessity
  (the KNOB is real, the instance is manufactured — say so).
- Oracles: both champions; per-round results; deciding-game deuce
  matches fold exactly.
- Size: ~63+63 matches, ~60–100 reconstructed rallies each → ~8k
  events; ~130 persons.

## Session-specific acceptance

- [ ] Expedite stream triggers the engine mechanism and is flagged +
      recorded as manufactured
- [ ] bo5/bo7 split handled (either via cfg or recorded adaptation)
- [ ] Table-count collapse across days survives checker containment
- [ ] `_INDEX.md`: B13 → DONE (+ pairing note if run with a sibling)

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, provenance %, oracle
summary, deviations.
