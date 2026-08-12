# P2 — Schedule health: engine lib + route + panel (D3)

Read first: `_RULES.md` → `_INDEX.md` → spec
`../2026-08-13-schedule-health-design.md`. Worktree + fresh branch.

## Scope

1. `packages/engine/src/scheduling/health.ts` — pure `assessHealth`:
   5 metrics (restSpread normalized to achievable, courtBalance,
   gapDispersion, homeAwayAlternation [RR only], primeSlotFairness),
   each `{key, score 0-100, explanation, offenders[]}`. Contract:
   deterministic, no DB/solver/clock — the future bench consumes this
   exact function.
2. `GET /api/v1/stages/{id}/schedule/health` (ACL = schedule read) +
   joint competition aggregation. OpenAPI regen.
3. Panel on stage schedule page post-auto/apply: 5 bars, expandable
   offenders, explanations. Blocks nothing. i18n ×4.

## Files (scout re-pins first)

- new: `packages/engine/src/scheduling/health.ts` + tests
- new route file under `apps/web/src/app/api/v1/stages/[id]/schedule/`
- stage schedule page component (scout locates), `schemas.ts`,
  4 dictionaries

## Do NOT touch

Solver/`build.ts`, placement service, capacity.ts (P1's — consume
nothing from it), fixtures write paths, golden corpora.

## Acceptance criteria

- Unit: per-metric on hand-built boards with KNOWN scores; perfect board
  = 100s; one adversarial board per metric; boards use UNEQUAL division/
  entrant sizes (symmetric-fixture trap).
- Regression: full report pinned for one fixed board — any drift reds
  with a metric-level diff. Prime-slot definition (default: last 2 slots
  per day) asserted as declared config, not re-derived.
- E2E: auto-schedule → panel renders 5 bars → offender expansion.
- Smoke: health route returns well-formed report for the smoke org.
- `homeAwayAlternation` provably skipped (absent, not 0) for bracket
  stages.
- pino `schedule_health_assessed` (scores only) in the route.
- Panel verified 1280/320/768; bars degrade to stacked list at 320.

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p2.json packages/engine/src/scheduling apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p2.json
rtk proxy npm run lint
cd packages/engine && npx tsc --noEmit; echo EXIT=$?
npm run openapi:gen && git status --porcelain
```

## Execution & close

**Scout (Sonnet High):** re-pin cites; locate the stage schedule page
component. **Implementer (Sonnet MAX):** brief carries the spec's
Metric formulas section VERBATIM — implement exactly those, no
"improvements". **Reviewer (Sonnet MAX):** formula fidelity vs spec,
absent-not-zero for bracket alternation, offender-order determinism;
gap list only. Close per `_RULES.md` §5.

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
