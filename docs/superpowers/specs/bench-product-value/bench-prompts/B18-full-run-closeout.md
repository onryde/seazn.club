# B18 — full run + perf baseline + close-out

Read `_RULES.md` → `_INDEX.md`. Depends on ALL sessions. Worktree for
any code fixes; docs may land on main per repo convention.

## Scope

1. **Full run**: every suite, `--engine both`, `--keep`, fresh env per
   `seazn-local-env`; placement live AND a second greedy-only pass
   without placement (both-ways at programme scale). All gates green or
   each red triaged §7 (fix-inline vs escalate) before close.
   Suite 13 (`club-open`, B16) runs in this pass exactly as it does
   daily — UI-first, Stripe test mode, pad-tapped — so pre-flight must
   include `stripe listen` + Chromium (customer-journey spec §6).
1b. **Registration-at-volume pass** (customer-journey spec §2 D2, §7):
   one extra run `--entry registration --keep` over suites 1–12 (API
   path, free/open/auto-approve, no Stripe). Report-only: entries /
   entrants / funnel wall per suite in a "Registration at volume"
   section. Never gates. Committed beside the perf baseline as the
   reference numbers for future registration-code changes.
2. **Perf baseline**: consolidated report — per suite: seed/schedule/
   sim walls, events/s, solver status + wall, greedy-vs-optimized
   deltas, believability metrics, provenance %, nondeterminism %.
   Committed under `docs/superpowers/specs/bench-product-value/baselines/<date>/`
   as the reference numbers future runs are eyeballed against
   (informational — no timing gates, ever).
3. **Browsability pass**: with `--keep`, walk the seeded orgs in the
   app (players, stats, career pages, standings, news) — screenshot
   set at 1280/320/768 for THREE representative surfaces attached to
   the PR (the demo-data-factory promise, verified once).
4. **Docs**: bench README (`tools/bench/README.md`) — how to run,
   flags, report anatomy, how to add a suite (pointer to playbook);
   `seazn-local-env` final touch-ups.
5. **Close-out**: `_INDEX.md` all rows DONE + programme summary
   (findings count by §7 class, fixed-inline list, escalated list);
   memory file updated (`project_scheduler_bench_programme`:
   RUNNING/COMPLETE state, baseline path); snapshot script run.

## Acceptance

- [ ] Full-run report committed; zero unexplained gate reds (suite 13
      funnel + result oracles included)
- [ ] `--entry registration` pass committed under the baseline dir,
      "Registration at volume" table present, no gate added for it
- [ ] Baseline dir committed with the run's raw JSON + md
- [ ] Every §7B finding across the programme has an outcome recorded
      (fixed inline w/ regression test, or escalated w/ owner ruling)
- [ ] README present; a fresh session could run the bench from it alone
- [ ] Browsability screenshots attached
- [ ] `_INDEX.md` + memory + snapshot done

## Verify (verbatim)

```bash
npm run bench:scheduler -- --engine both            # full roster (suite 13 UI-first)
npm run bench:scheduler -- --entry registration --keep   # volume pass, report-only
npx vitest run --reporter=json --outputFile=/tmp/b18.json tools/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b18.json
rtk proxy npm run lint
```

## Output cap

Final message under 20 lines — per-suite gate table (one line each),
baseline path, findings summary, deviations.
