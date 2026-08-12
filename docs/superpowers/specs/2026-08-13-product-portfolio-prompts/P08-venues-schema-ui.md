# P8 — Venues & courts: schema + API + org UI (D5a)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → spec
`../2026-08-13-venues-courts-design.md`. **Gate: release-2 C-chain done**
(check its index) + owner green-light. Worktree + fresh branch.

## Scope

1. Migrations (re-verify next free V numbers): `venues`, `courts`
   (+`tags text[]`), `court_hours`, `court_exceptions`,
   `fixtures.court_id uuid null fk`, division/stage
   `required_court_tags text[]`. DDL per spec. NO consumer switches yet
   — `court_label` keeps working this session (P9 migrates + switches).
2. CRUD API: venues + nested courts (+hours/exceptions payloads), key
   scopes, OpenAPI regen. RLS/ACL per org membership (follow existing
   org-resource pattern; check `check-rls.ts` passes).
3. Org settings → Venues UI: venue list, courts with tag chip editor,
   calendar editor (weekly ranges + exception days — per-day LIST layout,
   mobile-first, no desktop-only grid). Division settings gain
   required-tags picker (stores, not yet consumed). i18n ×4.

## Files (scout re-pins first)

- new migrations under `db/migration/`, new usecase
  `apps/web/src/server/usecases/venues.ts`, routes under
  `apps/web/src/app/api/v1/orgs/[id]/venues/`, org settings pages,
  `schemas.ts`, `openapi.ts`, key-scopes, 4 dictionaries

## Do NOT touch

`schedule.ts`/`build.ts`/lattice (P9), `ScheduleConfig` shape (P9),
placement service, fixtures readers (P9), stages.

## Acceptance criteria

- Unit: CRUD usecases incl. hours multi-range validation (open<close,
  no overlapping ranges per day), exception override precedence,
  tag array hygiene (trim/dedupe/lowercase).
- Regression: RLS — cross-org venue read/write rejected (assert the
  error CODE, not bare 4xx); `check-rls.ts` clean.
- E2E: create venue → courts → tags → weekly hours + one exception →
  survives reload; division required-tags picker persists.
- Smoke: venue+court CRUD via API on smoke org.
- Screenshots 1280/320/768 — calendar editor especially at 320.
- pino on CRUD mutations.

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p8.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p8.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
node scripts/check-rls.ts   # or its npm alias — scout confirms invocation
```

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
