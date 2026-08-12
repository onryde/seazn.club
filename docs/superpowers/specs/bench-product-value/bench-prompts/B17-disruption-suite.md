# B17 — disruption & repair suite (suite 12, reuses suite 8's org)

Read `_RULES.md` → `_INDEX.md` → bench spec §3 row 12, §9 P4. Depends
on B15 (suite 8 seeded + scheduled + partially simulated fixtures
available). Worktree; one PR.

## Scope

Not a pack — a scripted disruption sequence over a fresh suite-8 run,
`scripts/bench/lib/disrupt.ts` + suite wiring:

1. **Venue blackout → reflow**: after apply + first pool round
   simulated, inject a blackout over one pitch/day (via schedule config
   update per the post-C4 reflow path), re-run scheduling in repair
   mode (`none|optimized|llm` enum — use `optimized`), then assert:
   - every fixture in the blacked-out window moved to a lawful slot
     (checker re-run clean, certificate n/a),
   - **minimal-move**: fixtures OUTSIDE the blackout window that were
     not forced (no cascade constraint) kept their original
     `scheduled_at`/court — the moved-set is enumerated in the report
     and asserted ⊆ the affected-set closure,
   - pins survived untouched (a pinned fixture inside the window is
     the INFEASIBLE-honesty case: expect the typed refusal, then
     unpin and repair — both branches exercised).
2. **Walkover/withdrawal**: withdraw one pool team pre-KO per the
   sport's real mechanism (B00 risk-6 answer family); assert standings
   recompute + the affected fixture's outcome state; discipline/stats
   unaffected for uninvolved players.
3. **Result correction**: void/correct one simulated result (the
   engine's correction path), assert standings + `divisionPlayerStats`
   + any auto-drafted news reflect the corrected state, and the hash
   chain stays valid.
4. **Determinism probe** (spec P5): schedule suite 8 twice from
   identical inputs, diff assignments, report nondeterminism % —
   report-only, never red.
5. Report section: disruption timeline, moved-set table, repair wall
   times (informational).

## Do NOT touch

Product repair/reflow code (findings → §7B fork), packs, other suites.

## Acceptance

- [ ] Minimal-move assertion is REAL: a control fixture provably
      unaffected is byte-stable across the repair
- [ ] Pinned-in-blackout: typed refusal branch AND unpin-then-repair
      branch both exercised
- [ ] Correction path: standings + stats + news all converge; chain
      valid
- [ ] Unit: moved-set closure computation; regression: repair that
      moves an unaffected fixture REDs (mutation-proved by loosening
      the assertion once)
- [ ] Both-ways rule (with/without live placement) on the repair run
- [ ] `_INDEX.md`: B17 → DONE + nondeterminism % + findings

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b17.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b17.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite hockey --wipe   # full suite incl. disruption phase
```

## Output cap

Final message under 15 lines — disruption results table, moved-set
size, repair walls, deviations.
