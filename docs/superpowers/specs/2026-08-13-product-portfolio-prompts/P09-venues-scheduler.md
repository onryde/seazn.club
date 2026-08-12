# P9 — Venues & courts: scheduler integration + stored-config migration (D5b)

Read first: `docs/superpowers/RULES.md` → `_INDEX.md` → spec
`../2026-08-13-venues-courts-design.md`. Depends on P8. Same external
gate as P8. Worktree + fresh branch. **Riskiest session of the
portfolio — the stored-config migration.**

## Scope

1. Data migration (dry-run count report FIRST, printed before rewrite):
   per org, distinct court strings across stored schedule configs →
   "Main venue" + one court per string; rewrite stored configs'
   `courts[]` → court ids; map `fixtures.court_label` → `court_id`.
2. `ScheduleConfig.courts: z.array(CourtId)` — single post-migration
   shape (the migration IS the compatibility strategy; no permanent
   tolerant union). THE READ-PATH TRAP: prove no stored row 500s.
3. `build.ts`: court ids → solver indices; tag filter (candidate courts
   = `tags ⊇ required_court_tags`); empty candidate set → typed 422
   `capacity.no_matching_court` BEFORE solve. Zero proto change.
4. `/validate` + conflict codes keyed on court_id; every `court_label`
   reader switched (scout's enumerated list from P5-style sweep:
   fixtures API, exports, public pages, e2e fixtures).
5. Court multi-picker replaces free-text courts in schedule setup.

## Files (scout re-pins first)

- new data migration, `apps/web/src/server/api-v1/schemas.ts`,
  `apps/web/src/server/usecases/schedule.ts`,
  `packages/engine/src/scheduling/build.ts`, every reader on the scout
  list, schedule setup components, 4 dictionaries

## Do NOT touch

`services/placement/**` and proto/generated stubs (lattice contract
unchanged — that's the design's point), `court_hours` consumption (P10),
capacity.ts/health.ts beyond additive input fields if already merged.

## Acceptance criteria

- Unit: tag subset filter; id→index mapping stable ordering.
- Regression (the session's core): (a) migration fixture of REAL stored
  config shapes → post-migration reads 200, zero 500s; (b) lattice
  BYTE-EQUIVALENCE for a no-calendar org before/after the switch (pure
  refactor proof); (c) `capacity.no_matching_court` asserted by CODE.
- E2E: tag a court → division requires tag → auto-schedule uses only
  tagged courts → validate green; picker flow.
- Smoke: full schedule round on an org with 2 venues.
- **Run the gate with AND without a live placement service** (memory:
  live placement masks greedy/apply-path defects; CI smoke has no
  placement container by design).
- pino: migration counts, `schedule_court_filtered` (candidates,
  required tags).

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p9.json apps/web/src/server packages/engine/src/scheduling
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p9.json
rtk proxy npm run lint
cd packages/engine && npx tsc --noEmit; echo EXIT=$?
npm run openapi:gen && git status --porcelain
```

## Output cap

Final message under 15 lines — commits, verified counts, dry-run
migration counts, files touched, deviations, blockers. No file contents.
