# B07 — pack: carrom (suite 10, thin-data resilience)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B06.
Parallel-safe with B08–B15 (own worktree, own pack files only).

## Suite sheet

- **Suite 10 — org "ICF World Cup"** (carrom module; fidelity ceiling
  tier 1 — strike-by-strike is NOT wired (#430), streams are board-level
  by design).
- Div A: ICF Carrom World Cup men's team/singles event (most recent
  edition with published results — B00/B06-era research picks the
  edition and records it). Div B: women's event, same edition.
- Cfg: board/points per carrom module presets; verify `positionsFor`
  fix (#521) irrelevance here at re-pin.
- Sources: ICF published results, national-federation reports, news
  coverage of medalists. EXPECT gaps — this suite exists to prove the
  provenance discipline under thin data.
- Squads: real named players for medal rounds guaranteed; earlier
  rounds may be names-only or partial → §7A adaptations, honestly
  recorded; NO invented attributed facts.
- Constraint scenario: few boards (4), short slots, dense single-venue
  days; afternoon-only window variant.
- Certificate: none/partial expected → certificate section reports
  ABSENT honestly (the "none" branch is exercised for the first time).
- Specials: draw handling n/a; board sweeps if representable.
- Oracles: medalists (champion + finalists) exact; results where
  published; leaders only if sourceable — else dropped via §7A with the
  reason in `meta.adaptations[]`.
- Size: small (~40–60 matches, tiny streams, ~60 persons).

## Session-specific acceptance

- [ ] Report's provenance % + adaptation count make the thinness
      VISIBLE (this suite's success = honest accounting, not fullness)
- [ ] Certificate-absent branch renders correctly in report
- [ ] Zero unflagged reconstructions (spot-check per playbook)
- [ ] `_INDEX.md`: B07 → DONE + the edition chosen + provenance %

## Verify

Playbook §4 + standard gates; counts pasted.

## Output cap

Final message under 15 lines — pack stats, provenance %, adaptations
count, gate summary.
