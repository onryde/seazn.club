# B09 — pack: football (suite 2)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07–B15.

## Suite sheet

- **Suite 2 — org "UEFA Festival"** (football module).
- Div A: **Euro 2024**, all 51 matches: every goal (scorer, minute,
  pen/OG flags), card, sub; shootouts (Portugal–Slovenia R16,
  England–Switzerland QF). Div B: **B00's recorded decision** — Futsal
  Euro 2026 (small-sided cfg: sinbin, rolling subs) or Women's Euro
  2025 fallback (pens final: England d. Spain). Build to the decision,
  don't re-open it.
- Cfg: Div A standard 11-a-side, UEFA points; **division tiebreakers set
  to UEFA h2h-first** (engine has both cascades — this suite proves the
  config matters: Euro 2024 groups contained h2h-decided orders).
  Div B per decision (small-sided knobs or WEuro same-variant).
- Sources: UEFA official match reports (goals/cards/lineups/refs),
  Wikipedia consolidated tables, squad lists.
- Squads: full 26-man Euro squads ×24; officials: named referees per
  match (P1 oracle: the final's referee).
- Constraint scenario (§5): 10 venues, ≥3-day team rest
  (`perEntrantMinRest`), 4–6 matches/day group phase, **simultaneous
  final-round kickoffs as pins** (both matches of each group), KO
  spacing.
- Certificate: full (real schedule published).
- Specials: 2 shootouts; **yellow-accumulation suspensions** — research
  the real banned players (there were several before QF) and assert:
  ineligible for the RIGHT fixture, absent from its lineup; record
  10 own goals of the tournament fold correctly to conceding sides.
- Oracles: champion (Spain), group tables incl. h2h-decided orders
  EXACT, third-place ranking table (feeds R16 mapping — the
  bench-as-organizer/D4 map uses the REAL bracket), top scorer shared
  at 3 goals (6 players — the leaders oracle must handle ties in the
  LEADERBOARD itself), suspension list, shootout scores.
- Adaptations expected: R16 third-place mapping (UEFA permutation
  table); if Div B = futsal and a cfg knob is missing → §7A per spec
  (fallback already named).
- Size: ~51+30 matches, ~40–60 events/match → ~4–5k events; ~700–900
  persons (two full squad sets).

## Session-specific acceptance

- [ ] At least one group's order provably h2h-decided (assert the
      engine ordered it by the UEFA cascade, and that FIFA-style
      fall-through would have differed — comment the counterexample)
- [ ] Suspension oracle: named player, named missed fixture, lineup
      absence — all three asserted
- [ ] Leaders oracle handles the 6-way top-scorer tie
- [ ] `_INDEX.md`: B09 → DONE + Div B decision honored + findings

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, provenance %, oracle
summary, deviations.
