# P10 — Venues & courts: calendars → lattice (D5c)

Read first: `_RULES.md` → `_INDEX.md` → spec
`../designs/2026-08-13-venues-courts-design.md`. Depends on P9. Same external
gate. Worktree + fresh branch.

## Scope

1. `packages/engine/src/scheduling/court-windows.ts` — pure
   `usableWindows(court, dateRange, config)`: `court_hours[weekday]`
   overridden by `court_exceptions[date]`, ∩ `sessionWindows`, −
   `blackouts`. Org tz governs day boundaries (`settings.orgTz`, #448 —
   never `settings.tz`).
2. Lattice build consumes `usableWindows` per court-day (replacing the
   uniform-windows assumption); `/validate` and conflict codes
   (`warn.window`/`warn.blackout`) become calendar-aware via the SAME
   function (one function, both sides — placer/verifier rule).
3. D2/D3 additive inputs IF merged by now: capacity card consumes
   per-court windows; health offenders show court names. Skip silently
   if not merged (no dependency created).

## Files (scout re-pins first)

- new: `packages/engine/src/scheduling/court-windows.ts` + tests
- `build.ts` lattice assembly, validate usecase, conflict copy keys if
  any new, 4 dictionaries (only if new user-facing strings)

## Do NOT touch

Placement service/proto (windows stay pre-baked into `grid_slots` —
still zero proto change), P8's CRUD, fixtures readers.

## Acceptance criteria

- Unit: `usableWindows` — multi-range days, exception full-close and
  partial override, hours∩session−blackout composition, DST boundary in
  org tz (both spring-forward and fall-back dates), empty result days.
- Regression: org WITHOUT calendars → lattice byte-identical to P9
  output (calendars are opt-in, absence changes nothing); a fixture
  scheduled inside court hours on main but outside a new exception
  reds `/validate` with the typed code.
- E2E: set weekly hours + one exception → auto-schedule avoids the
  exception day visibly.
- Smoke: schedule round on a calendared org.
- Gate run with AND without live placement (same P9 rule).

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p10.json packages/engine/src/scheduling apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10.json
rtk proxy npm run lint
cd packages/engine && npx tsc --noEmit; echo EXIT=$?
npm run openapi:gen && git status --porcelain
```

## Execution & close

**Scout (Sonnet High):** re-pin lattice assembly + validate path;
confirm D2/D3 merge state for the additive inputs. **Implementer
(Sonnet MAX):** spec's `usableWindows` algorithm verbatim — civil
local times, org tz, no UTC arithmetic. **Reviewer (Sonnet MAX):** ONE
consumer set for `usableWindows` (grep for an inlined second copy —
the placer/verifier fork), DST both directions tested, no-calendar
byte-identity regression present; gap list only. Close per
`_RULES.md` §5.

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
