# B15 — packs: field hockey + ice hockey (suites 8 + 9, one session)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B14. Two suites, one session (shared period-
family mechanics); split into two PRs only if research overruns —
record the split in `_INDEX.md`. **B17 reuses suite 8's org — this
session's output is its precondition.**

## Suite sheet — Suite 8, org "Olympic Hockey" (hockey module)

- Div A: Paris 2024 Men (12 teams, 2 pools → QF..F; **Netherlands d.
  Germany on shoot-out in the final** — fih-shootout preset). Div B:
  Women (Netherlands d. China, also SO).
- Cfg: FIH quarters, fih-shootout preset (5 attempts, sudden death,
  8s clock knob per preset); FIH pool ranking cascade (points → GD →
  GF → h2h).
- Sources: FIH/Olympics match reports (goals with scorers+minutes,
  green/yellow/red cards, shoot-out sequences), rosters, umpires.
- Constraint scenario: **joint two-division plan on 2 shared pitches**
  (Yves-du-Manoir), morning/afternoon/evening windows, pool
  interleaving — the programme's primary joint-scheduling exercise
  (with B14).
- Certificate: full. Specials: BOTH finals' shoot-outs; cards incl. at
  least one red/suspension if the record shows one; GD-decided pool
  placements.
- Oracles: champions; pool tables (FIH cascade exact); SO scores;
  leaders (top scorer w/ count); claims ×3; officials incl. finals'
  umpires.
- Size: ~38+38 matches, goals+cards level → ~2k events; ~400 persons.

## Suite sheet — Suite 9, org "IIHF Worlds 2025" (icehockey module)

- Div A: 2025 IIHF World Championship top division (16 teams, 2 groups
  of 8 → QF..F; **USA d. Switzerland OT final**). Div B: Division I-A
  2025 (6-team RR).
- Cfg: IIHF 3/2/1/0 points (OT/SO losses = 1) — the OT-loss column is
  the suite's sharpest table oracle; OT sudden-death 3-on-3 + GWS
  presets; GWS +1 goal convention (S1 ruling — engine already does
  this; the oracle CONFIRMS final scores like 4–3 for a 3–3 SO win).
- Sources: IIHF official game sheets (goals, penalties w/ minutes,
  GWS sequences), rosters, referees.
- Constraint scenario: 2 arenas, 4–6 games/day, group parallelism,
  `perEntrantMinRest`.
- Certificate: full. Specials: OT final; GWS games (enumerate);
  penalty-minute leaders; any match-penalty → 1-game suspension the
  record shows (discipline-carry oracle).
- Oracles: champion; BOTH group tables with the 3/2/1/0 + OT-loss
  points EXACT (this catches a wrong points rule instantly); relegation
  cut; leaders (points/goals); suspension carry; claims ×3.
- Size: ~64+15 matches → ~3k events; ~550 persons.

## Session-specific acceptance

- [ ] FIH cascade and IIHF 3/2/1/0 tables both EXACT against history
      (two different points/tiebreak systems, one session — config, not
      code, must explain both)
- [ ] All four shoot-out/OT finals fold to the historical winners; GWS
      +1 convention asserted on final scores
- [ ] Joint plan across suite 8's two divisions verified by checker
      (shared-pitch double-booking impossible)
- [ ] Discipline carry: at least one real suspension asserted end to
      end (or `meta.adaptations[]` records that the editions had none —
      then `_tiny` keeps the mechanism covered)
- [ ] `_INDEX.md`: B15 → DONE (+ split note if two PRs) + findings

## Verify

Playbook §4 + standard gates, per suite; counts pasted.

## Output cap

Final message under 15 lines — both packs' stats, oracle summaries,
deviations.
