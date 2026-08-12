# B08 — pack: cricket (suite 1, the volume monster)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B07/B09–B15. Budget the research: this is the
largest pack in the programme.

## Suite sheet

- **Suite 1 — org "World Cricket Series"** (cricket module — the only
  true 4-band fidelity ladder; tier 3 = `cricket.ball` behind
  `scoring.ball_by_ball`; org plan must clear it, probe per B03).
- Div A: **T20 World Cup 2024**, all 55 matches, ball-by-ball
  (groups 4×5 → Super 8 2×4 → SF/F). Div B: **Champions Trophy 2025**
  (ODI 50-over, 15 matches, ball-by-ball). True T20-vs-ODI variant pair
  via cfg (`overs`, `ballsPerInnings`, `superOver`, `dls.enabled`).
- Sources: cricsheet-style public per-ball archives (primary), ESPNcricinfo
  scorecards (verification + officials), ICC published squads.
- Squads: full 15-man squads both events; playing XI per match from
  scorecards; officials: named umpires per match.
- Constraint scenario (§5): 9 venues-as-courts, afternoon+night
  `sessionWindows`, 1–2 matches/day/venue, `perEntrantMinRest` for
  travel, group-phase pins for marquee fixtures (IND–PAK).
- Certificate: full — the real match schedule is published.
- Specials (real instances, all asserted): **USA–PAK super over**
  (group stage), **DLS matches** (2024 WC + CT25 rain games — enumerate
  during research; encode interruption + revise events), rain
  no-results if any (abandonment path), concussion substitute if one
  occurred in either event (else the cfg knob is exercised in `_tiny`,
  recorded as such).
- Oracles: both champions (IND won T20WC 2024; IND won CT 2025);
  group/Super-8 tables with **NRR to 3dp**; leaders: most runs + most
  wickets both events (name AND count); super-over + DLS outcomes;
  suspension carry if any real code-of-conduct ban landed in-event.
- Adaptations expected: Super 8 pre-seeded groupings (ICC pre-assigned
  seeds — encode as the REAL mapping via bench-as-organizer/D4 map);
  reserve days (encode as blackout-exception days, not fixtures).
- Size: ~70 matches, ~250–600 events each → **~25–30k events**; ~350
  persons. Runtime: measure; if single-POST seed exceeds ~20min for
  this suite alone, invoke the B00-decided import path (if live) for
  Div A and keep Div B single-POST — record the split in the report.

## Session-specific acceptance

- [ ] NRR oracle to 3dp on every table row (the sharpest stats oracle
      in the programme — a fold bug shows here first)
- [ ] Super-over stream folds to the historical winner via the
      `superOverStillTied` cfg actually used by the event
- [ ] Every DLS match: revised target asserted == official
- [ ] Throughput section: events/s + total wall for this suite;
      import-vs-single-POST split recorded if used
- [ ] `_INDEX.md`: B08 → DONE + counts + any §7B findings

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, provenance %, oracle
summary (champions/NRR/leaders), throughput, deviations.
