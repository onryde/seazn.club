# B01 — runner core (CLI, pre-flight, HTTP client, report writer)

Read `_RULES.md` → `_INDEX.md` → bench spec §2, §10. Depends on B00.
Worktree; one PR.

## Scope

1. `scripts/bench/bench.ts` — CLI: `--suite <key>` (repeatable),
   `--engine optimized|greedy|both` (default optimized), `--keep|--wipe`
   (default keep), `--report-dir`, `--base <url>`. npm script
   `bench:scheduler`.
2. `scripts/bench/lib/env.ts` — pre-flight, refuses to run on failure:
   own-DB proof (`show data_directory`), own-port PID (`lsof -t`),
   never :3000 / dev DB, placement gRPC health probe (and records
   whether placement is LIVE or ABSENT — both are valid modes, the
   report says which), sports catalog synced (funnel `badminton`
   witness), server answers `/api/health` on `localhost` (Secure-cookie
   rule — never 127.0.0.1).
3. `scripts/bench/lib/http.ts` — cookie-jar session + magic-link auth
   (smoke.ts pattern, own thin copy — smoke.ts is not refactored),
   typed request helper that FAILS the run on unexpected 4xx/5xx with
   the body captured.
4. `scripts/bench/lib/report.ts` — per-run dir `bench-report/<run-id>/`
   (run-id from CLI arg or git sha, NOT Date.now — determinism),
   `report.json` (typed schema) + `report.md` renderer; every later
   layer appends sections. Exit code = any gate red.
5. `scripts/bench/lib/log.ts` — pino JSON lines, one logger, child per
   suite/phase.
6. Proof loop: `--suite _tiny` seeds one org + one 2-entrant division
   via API, schedules greedy, asserts zero blocking conflicts, writes a
   report. This is the bench's own smoke from here on.

## Do NOT touch

`scripts/smoke.ts`, product code, packs (B02+), placement service.

## Acceptance

- [ ] Unit: report schema round-trip; env verdict matrix (each
      pre-flight failure mode → named refusal, not a stack trace)
- [ ] Regression: pre-flight refuses :3000, refuses foreign
      data_directory, refuses unsynced catalog (three real traps, three
      tests)
- [ ] Smoke: `_tiny` run green end-to-end, report committed as PR
      artifact; run BOTH with and without placement live
- [ ] E2E: `_tiny` IS the e2e at this layer (recorded as such per
      _RULES §1)
- [ ] pino events: `bench_started`, `preflight_passed|refused`,
      `suite_completed`, `bench_finished` with gate summary
- [ ] `rtk proxy` discipline in any subprocess the runner spawns; child
      processes write `EXIT=$?` to the report, never trust wrapper exit

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b1.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b1.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite _tiny --wipe   # paste the report.md summary
```

## Output cap

Final message under 15 lines — commits, counts, `_tiny` gate summary,
files, deviations.
