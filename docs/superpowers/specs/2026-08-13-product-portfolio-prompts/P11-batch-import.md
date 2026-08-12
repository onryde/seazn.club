# P11 — Batch score-event import (D6)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → spec
`../2026-08-13-batch-event-import-design.md`. **Gate: ScoringPad S13
done** (check its index) + owner green-light. Worktree + fresh branch.

## Scope

1. `POST /api/v1/divisions/{id}/events/import` per spec: `{import_id,
   streams[]}`; unstarted-fixture guard; **dry-run engine fold before any
   write**; all-or-nothing per fixture, streams independent; append via
   the ONE production writer (`scoreEvent` path — post-S13 shape; the
   import must NOT reimplement append: hash chain, `match_states`,
   decided side effects all inherited); entitlement gates unchanged;
   idempotency `(division, import_id, fixture)`; size cap constant +
   typed 413. OpenAPI regen + key scopes.
2. `/admin`-grade upload page under the division: JSON paste/upload →
   per-stream result table. Functional bar only.
3. `content/help` page documenting the format (English-only tree — no
   i18n owed there; the admin UI strings DO get 4 locales).

## Files (scout re-pins ALL first — S12/S13 moved this surface)

- new route + usecase `apps/web/src/server/usecases/event-import.ts`,
  `scoring.ts` (read-only reuse — extract a shared internal if needed,
  behavior identical), migration for the idempotency table (UNIQUE index
  `(division_id, import_id, fixture_id)` in DDL — the idempotency
  guarantee lives in the constraint, not app code; load
  `supabase-postgres-best-practices` first), admin page,
  `schemas.ts`, `openapi.ts`, help page, 4 dictionaries

## Do NOT touch

Engine fold code, pad components, realtime/device-link flows, existing
`scoreEvent` route behavior (a shared-internal extraction must leave its
tests byte-green).

## Acceptance criteria

- Unit: dry-run gate (mid-stream invalid → whole stream rejected, ZERO
  writes), unstarted guard, entitlement rejection (free org + tier-3
  events → typed code), size cap.
- Regression (the session's core): (a) hash chain over an imported
  fixture equals a sequentially-scored twin byte-for-byte; (b) import →
  `recomputePlayerStats` + `personCareerStats` show the history (the
  career-day-one claim, proven); (c) replay same import_id → DB state
  byte-identical + `skipped_duplicate`.
- E2E: upload page happy path + one rejected stream row.
- Smoke: import one finished match → outcome + stats + auto-draft news
  appear.
- pino `events_imported` per spec.

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p11.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
```

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
