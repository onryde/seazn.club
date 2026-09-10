# B06a — session state (live, rewritten at each task boundary)

Worktree `.claude/worktrees/bench-b06a`, branch `feat/bench-b06a-framework`,
cut from `8f3e3d655`. Plan:
`docs/superpowers/plans/2026-09-09-bench-b06a-suite-framework.md`. Design of
record: `designs/2026-09-09-b06-pack-pilot-design.md` (owner decisions D1–D8).

## Where the wave is

| task | state |
|---|---|
| 1 — suite registry | **COMMITTED** `2e0c4ba` region (see `git log`) |
| 2 — extract the runner | **COMMITTED** `3acc0ace9` |
| 3 — `compareMatches` | IN FLIGHT |
| 4 — `compareSpecials` | not started |
| 5 — provenance writer | not started |
| 6 — claim accept | not started |
| 7 — news | not started |
| 8 — doc corrections | not started |
| 9 — live run (orchestrator only) | not started |

## Gate numbers, in order, so a regression is visible

| point | files | tests | failed suites |
|---|---|---|---|
| baseline (before task 1) | 36 | 1397/1397 | 0 |
| after task 1 | 37 | 1404/1404 | 0 |
| after task 2 | 38 | 1408/1408 | 0 |

Gate command (the apps/web suite and turbo never see `scripts/bench`):

```
./packages/engine/node_modules/.bin/vitest run --reporter=json \
  --outputFile=/tmp/b06a.json --testTimeout=30000 scripts/bench
```

Counts rise by more than the tests written because
`strip-types-loadable.test.ts` generates one case per bench MODULE — a new
`lib/**.ts` file adds a case. Task 1 added 5 written + 2 generated; task 2
added 3 written + 1 generated (`run-suite.ts`).

## Findings this wave (for the PR body)

1. **The plan's task-2 premise was false.** It said the DLS probe, registration
   drivers, discipline subject and cross-division court probe were
   `_tiny`-specific and needed hook extraction. Grepping the 2,480-line `try`
   block for a hardcoded pack ref returns **comments only** — all four are
   already pack-driven. The only suite-specific content was 3 report fields
   holding `"_tiny"` and 50 `"tiny: "` log prefixes. Extraction became a move
   plus one parameter; no probe machinery was built.
2. **The registry broke two existing mocks.** `vi.mock("../suites/tiny.ts")`
   returning only `runTinySuite` fails COLLECTION once `registry.ts` also
   imports `TINY_PACK_PATH` — which reads as a lost suite, not a failed test.
   Both mocks now return the extra export.
3. **The runner used to default a missing `packPath` to `TINY_PACK_PATH`.** A
   suite that forgot to pass one would have folded the proof pack while
   reporting its own name. `runPackSuite` now takes it from the definition and
   has no `_tiny` fallback; `run-suite.test.ts` mutation-proves both.

## What a fresh session should do first

Read the plan, then `git log --oneline origin/main..HEAD` in the worktree — the
commit messages carry each task's reasoning. Re-run the gate command above and
confirm 38 files before trusting any count.
