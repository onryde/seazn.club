# P1 — Capacity pre-check: engine lib + route guard + setup card (D2)

Read first: `_RULES.md` → `_INDEX.md` → spec
`../designs/2026-08-13-capacity-precheck-design.md`. Worktree + fresh branch.

## Scope

1. `packages/engine/src/scheduling/capacity.ts` — pure `assessCapacity`
   per spec (supply/demand, per-day, rest lower bound, verdict,
   quantified `suggestions[]` with honest `flipsVerdict`). No DB, no
   solver imports, no clock.
2. Server guard: schedule-auto route (stage + joint competition variants)
   re-runs `assessCapacity`; `verdict:"impossible"` → typed 422
   `capacity.impossible` with the report attached. OpenAPI regen.
3. UI card in schedule setup: live recompute on knob change, verdict
   chip, supply/demand + per-day bars, suggestion rows; Solve disabled
   only on impossible. i18n ×4.

## Files (scout re-pins ALL of these first — spec citations are stale by design)

- new: `packages/engine/src/scheduling/capacity.ts` + unit tests beside it
- `apps/web/src/server/api-v1/schemas.ts` (report + 422 shape),
  schedule-auto route + its usecase, OpenAPI spec regen output
- schedule setup component (scout locates), 4 dictionaries

## Do NOT touch

`services/placement/**`, `proto`/generated stubs, golden corpora, any
`ScheduleConfig` field semantics (read-path trap — additive report types
only), smoke.ts internals (add a scenario via its existing pattern only).

## Acceptance criteria

- Unit: arithmetic incl. rest bound + per-day caps; every suggestion
  proven by re-assessment (apply → verdict flips); asymmetric fixtures
  (unequal entrant counts) per the tests-that-cannot-fail rules.
- Regression: a known-INFEASIBLE board asserts `impossible` with zero
  solver involvement; loosening the binding constraint exits `impossible`.
- E2E: impossible config → card + disabled Solve + reason; apply
  suggestion → enabled.
- Smoke: one impossible + one ok assessment through the real route.
- Server is authority (422 path tested API-level, not only UI).
- pino `capacity_assessed` in the route; nothing logged in the lib.
- All new UI strings in 4 dictionaries; card verified 1280/320/768.

## Verify (verbatim, from the worktree root — cd in the SAME call)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p1.json packages/engine/src/scheduling apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p1.json
rtk proxy npm run lint            # read "✖ N problems" yourself
cd packages/engine && npx tsc --noEmit; echo EXIT=$?
npm run openapi:gen && git status --porcelain   # must be empty
```

Confirm `.testResults[].name` paths are the WORKTREE's, not main's.

## Execution & close

**Scout (Sonnet High):** re-pin every file/route/schema this prompt and
spec cite; file:line table ≤25 lines. **Implementer (Sonnet MAX):**
brief = this prompt + scout table + spec's Arithmetic section verbatim;
TDD. **Reviewer (Sonnet MAX):** suggestions honesty (`flipsVerdict`
proven by re-assessment, not asserted), 422 path tested API-level, lib
purity (no DB/clock/solver imports); gap list only. Close per
`_RULES.md` §5.

## Output cap

Final message under 15 lines — commits, verified counts from the JSON,
files touched, deviations, blockers. No file contents, no diffs.
