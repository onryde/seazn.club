# B04 — scheduling layer (apply, checker, certificate, metrics)

Read `_RULES.md` → `_INDEX.md` → bench spec §5, §6. Depends on B03.
Worktree; one PR. **This session owns the bench's core claim: schedules
are verified independently, and INFEASIBLE is attributed correctly.**

## Scope

1. `scripts/bench/lib/schedule.ts` — apply the pack's `ScheduleConfig`
   per division (post-C-chain shapes from B00), run
   `/stages/{id}/schedule/auto` → `/apply` (joint competition plan for
   the suites whose sheet says so), `--engine both` runs greedy AND
   optimized and reports the delta. Suite 12 hooks (reflow/repair) are
   B17's; the client just exposes the calls.
2. `scripts/bench/lib/checker.ts` — independent verification from
   FETCHED fixtures: court double-booking, window/blackout containment
   (court calendars if D5 shipped — else config windows), per-entrant
   rest minima, day caps, pin integrity, official double-booking,
   round-order lexicographic (day ≤, same-day start ≤; round-robin
   only — day-one GATE per index rulings). Consumes the pure libs
   (capacity/health/court-windows) where they exist per B00's
   inventory; NO solver imports; NO trust in `/validate` (which is
   asserted separately as layer 1).
3. `scripts/bench/lib/certificate.ts` — §6.3 protocol, in order:
   historicalAssignment vs encoded constraints FIRST; then
   INFEASIBLE/UNKNOWN attribution (pack bug vs product bug) exactly as
   specced; report section says which branch fired.
4. Believability metrics into the report (health lib if shipped, else
   the five formulas inlined here from D3's spec — same definitions, so
   a later swap is a no-op): plus greedy-vs-optimized delta and
   similarity-to-historical %.
5. Conflict assertions target C3 structured details ({kind, ids…});
   zero `blocking` = gate; warn codes tallied in the report.

## Do NOT touch

Product code, placement service. If a checker finding disagrees with
`/validate`, that is a FINDING (§7B) — report, do not "fix" the checker
to match.

## Acceptance

- [ ] `_tiny` schedules green: layer-1 zero blocking, layer-2 checker
      clean, certificate SKIPPED-with-reason (tiny has no historical)
- [ ] Unit: each checker rule on hand-built violating boards (one
      violation each, asymmetric sizes); certificate three-branch logic
      (violating cert / satisfied cert + INFEASIBLE / satisfied cert +
      FEASIBLE)
- [ ] Regression: a board that satisfies `/validate` but violates a
      hand-injected checker rule REDs the run (independence proven —
      mutation-style: bypass checker, run must go green, restore)
- [ ] Round-order gate: a deliberately disordered round-robin board
      reds with the pair named
- [ ] Both-ways rule: `_tiny` gate run with AND without live placement;
      greedy-vs-optimized delta present when both ran
- [ ] pino: `suite_scheduled` (engine, status, wall ms, conflicts,
      checker verdict, certificate branch)
- [ ] Counts pasted; lint clean

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b4.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b4.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite _tiny --wipe --engine both
```

## Output cap

Final message under 15 lines — commits, counts, `_tiny` schedule
summary (status/conflicts/checker/certificate), deviations.
