# B05 — simulation layer (event loop, advancement, oracles, people layer)

Read `_RULES.md` → `_INDEX.md` → bench spec §8, §9. Depends on B04.
Worktree; one PR. **The oracle direction is sacred: events in, outcomes
derived, history only ever compared against.**

## Scope

1. `scripts/bench/lib/simulate.ts` — per fixture: POST the stream in
   order through the post-S13 scoring path (single-event,
   `expected_seq` strictly sequential per fixture; suite-level
   parallelism across fixtures only), throughput measured + reported
   (informational). If D6/P11 shipped: import path allowed per suite
   EXCEPT one suite pinned to single-POST (the live path must stay
   covered) — B00's inventory decides; default pin = darts.
2. Stage advancement: D4 propose+confirm flow if shipped (per B00),
   else bench-as-organizer per the pack's real bracket via admin APIs.
   Either way: advancement asserts the pack's expected qualifier list
   BEFORE advancing — a wrong table must red here, not corrupt the
   next stage.
3. `scripts/bench/lib/oracle.ts` — after each stage and at end:
   standings (points, GD/NRR/buchholz, EXACT tie order), champion,
   `finalRanks`, leaders (`divisionPlayerStats` name AND count),
   `personStats` + `personCareerStats` for the pack's stars,
   suspension carry (the named real player ineligible for the named
   fixture, absent from its lineup), specials outcomes (super-over
   winner, shootout score, DLS target, OT/GWS, tiebreaks, expedite,
   retirement/walkover). Every mismatch: report shows engine-derived
   vs historical side by side.
4. People-layer steps (spec §9): P1 officials (double-booking blocked,
   blackout → `warn.official_unavailable`, final's official matches
   history), P2 claims (accept via magic link as fresh users, claimed
   profile shows real stats, one expired-token path), P3 coach lanes
   (card to coach never in playing stats), P6 news (auto-drafts exist
   for decided fixtures, publish a few → public page, others stay
   draft; enriched fields asserted if D7 shipped).
5. Report sections per suite: sim timings, oracle table, people-layer
   results, provenance %.

## Do NOT touch

Product code; `scoreEvent` semantics; packs beyond `_tiny` (extend
`_tiny` to carry one micro-oracle of each kind — it becomes the
permanent fixture for this layer's tests).

## Acceptance

- [ ] `_tiny` full pipeline green: seed → schedule → simulate →
      oracles → people-layer, single command
- [ ] Unit: oracle differs (tie-order comparison, leader count
      mismatch rendering, suspension lookup)
- [ ] Regression: (a) a stream mutated post-validation (one ball
      flipped) reds the RUNTIME oracle — proving the app path is
      asserted, not just stage-0 (§7C detection); (b) advancement
      pre-check reds on a wrong expected table before any next-stage
      write
- [ ] Sequentiality: enforced per fixture (a deliberate out-of-order
      POST test expects the 409 and the runner surfaces it as a
      finding, not a retry-silently)
- [ ] pino: `suite_simulated` (events, ms, event/s), `oracle_checked`
      (per oracle kind, pass/fail)
- [ ] Counts pasted; lint clean

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b5.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b5.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite _tiny --wipe --engine optimized
```

## Output cap

Final message under 15 lines — commits, counts, `_tiny` pipeline
summary, event/s figure, deviations.
