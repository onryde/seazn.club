# B14 — pack: volleyball (suite 7)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B15. Pairable with B13 if thin (record pairing).

## Suite sheet

- **Suite 7 — org "Paris 2024 Volleyball"** (volleyball, setbased
  kernel).
- Div A: Men's Olympic tournament (12 teams: 3 pools of 4 → QF→SF→F;
  France d. Poland final). Div B: Women's (Italy d. USA).
- Cfg: 25×5 with 15-point 5th set; pool → KO structure; Olympic pool
  ranking rules (match points, set ratio, point ratio) — encode via
  division tiebreakers; assert the REAL pool orders (2024 had
  ratio-decided placements).
- Sources: FIVB/Olympics official results (set scores complete),
  rosters incl. **libero** designations, referees.
- Squads: 12-man rosters ×24 incl. libero role (roster metadata proof);
  officials: named referees (P1: finals' referees).
- Constraint scenario (§5): ONE arena (South Paris), **4–6 matches/day
  hard cap**, pools interleaved M/W across shared days — BUT M and W
  are separate divisions in ONE competition: this suite exercises the
  **joint competition-level plan** alongside suite 8 (both sheets say
  so; the joint call covers both).
- Certificate: full (Olympic schedule published).
- Specials: 5-set thrillers (tiebreak set at 15) — enumerate the real
  ones; set-ratio-decided pool placements are the sharp oracle.
- Oracles: both champions; pool tables with set/point ratios EXACT;
  bracket results; leaders only if tier-representable (else §7A);
  claims ×3.
- Adaptations expected: rally sequences reconstructed to exact set
  scores (side-attributed, lossless); Olympic seeding committee
  quirks → real bracket via advancement map.
- Size: ~38+38 matches, ~150–200 reconstructed rallies each → ~14k
  events; ~300 persons.

## Session-specific acceptance

- [ ] Pool ranking: set-ratio/point-ratio tie resolution matches the
      REAL Olympic tables exactly (the setbased tiebreaker cascade's
      first real proof)
- [ ] Joint two-division scheduling on one arena under the 4–6/day cap:
      checker proves the cap across BOTH divisions' fixtures combined
- [ ] Libero roster role survives seed → read-back
- [ ] 15-point 5th sets fold correctly (every real 5-setter asserted)
- [ ] `_INDEX.md`: B14 → DONE + findings

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, provenance %, oracle
summary (ratios/pools), deviations.
