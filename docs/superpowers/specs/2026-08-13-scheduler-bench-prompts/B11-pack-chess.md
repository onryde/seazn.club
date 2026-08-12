# B11 — pack: chess (suite 4)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B15. Cheapest streams, richest STRUCTURE suite.

## Suite sheet

- **Suite 4 — org "FIDE Cycle"** (boardgame module — result-level
  fidelity by design; PGN is out of scope per #430, permanently for
  this pack).
- Div A: **Candidates 2024 open** — 8 players, DOUBLE round-robin, 14
  rounds (Gukesh 9/14). Div B: **FIDE Grand Swiss 2023** (Vidit; 114
  players, 11 rounds) as a **swiss stage with historical pairings
  seeded as manual rounds** (B00 risk-2 answer decides manual-fixture
  mechanics; engine swiss pairing is NOT asserted against history —
  different pairing engines, recorded adaptation).
- Cfg: boardgame half-point scoring ({win:2, draw:1} = 1/½ scaled);
  draws = nullable winner. Div A tiebreakers per FIDE Candidates regs
  (h2h, wins) — assert the REAL final order incl. tied groups; Div B
  tiebreakers **buchholz** — the comparator's first real-data proof.
- Sources: FIDE/chess.com/lichess published crosstables + round
  pairings + results (complete and unambiguous — expect provenance
  ~100% real).
- Squads: individuals; officials: chief arbiters (P1: named arbiter on
  the final round).
- Constraint scenario (§5): 1 round/day, rest days after R7 (Div A per
  real calendar → blackout days), **afternoon-only `sessionWindows`
  (14:30 starts)**, boards-as-courts (4 for Candidates; Div B many
  boards — cap courts at a sane number and record the adaptation:
  boards are not scarce, the scheduler's job here is day/round
  structure, the purest round-order-gate exercise in the programme).
- Certificate: full for Div A (published round calendar); rounds-only
  for Div B.
- Specials: mass draws (14-round double RR — draw density is the
  half-point fold's stress test); Div A had decisive last-round drama —
  the final table's tied 2nd/3rd group order per FIDE tiebreaks is the
  suite's sharpest oracle.
- Oracles: both winners; full final crosstable points; Div A tie-order
  exact; Div B top-10 by buchholz exact; claims for 3 stars.
- Adaptations expected: manual-pairing seeding for swiss (the big one);
  Armageddon/playoff n/a in these editions.
- Size: 56 + 627 games, 1–3 events each → ~1.5k events; ~130 persons.

## Session-specific acceptance

- [ ] Double round-robin generates correctly (2 legs) or the adaptation
      is recorded and bench-as-organizer builds leg 2
- [ ] Buchholz oracle: top-10 order matches FIDE's published standings
- [ ] Draw-heavy fold: points table exact to the half point everywhere
- [ ] Round-order gate across 14 single-round days — zero violations
- [ ] `_INDEX.md`: B11 → DONE + swiss-mechanics note + findings

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, oracle summary (tie orders,
buchholz), deviations.
