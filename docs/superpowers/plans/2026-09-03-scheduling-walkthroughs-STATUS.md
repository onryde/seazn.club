# Scheduling walkthroughs — wave status

Companion to `2026-09-03-scheduling-walkthroughs.md`. Written at a session
boundary so the next session does not re-derive where the wave stands.

Full detail — per-task rulings, review findings, mutation results — lives in the
SDD ledger at
`.superpowers/sdd/2026-09-03-scheduling-walkthroughs/progress.md`. That path is
git-ignored and MACHINE-LOCAL: on any other checkout this file is all there is.

## Done and committed

| # | Task | Landed |
|---|------|--------|
| 0 | Hand-drive of the organiser's scheduling day | evidence committed `3e4d80d81` |
| 1 | Clear-schedule refuses a frozen division | `463bdfc27` and predecessors |
| 2 | History panel copy in 4 locales | reviewed, amended `efe8c572e` |
| 3 | Testids across five panels | reviewed |
| 7 | CP-SAT rest floor reached the wire as `NaN` | `234d4005a`, `65e0b5b4c` |
| 8 | Restore-checkpoint refuses a frozen division | `a3ab7db16`, `e6193c1c2` |
| 9 | Undo/redo refuse it too; joint path says why | `9f6d4117f`, `1f9a01227`, `111fe8070`, `cb6a3ceda` |

## Open

- **Task 4** — `scheduling-organiser-day.spec.ts`. In flight at the boundary;
  the file may be present and UNTRACKED. Run it before trusting it.
- **Task 9 fix round** — scoped re-review of `cb6a3ceda` not yet dispatched.
- **Task 5** — officials handoff walkthrough. Its apply step must stay a
  FAILING test (`test.fail()`, never skip) per spec §S4.
- **Task 6** — perf gate, cost table, findings doc.
- **Task 10** — `SCHEDULE_LOCKED` error code plus a shared constant across the
  six throw sites. Owner sequenced this AFTER the walkthroughs.

## Findings that must not be misread

**The board-tab control-set row is RETRACTED.** `schedule-board.tsx:853-861`
reads a saved density from `localStorage` before applying its mobile default, so
a 1280 → 768 → 320 sweep in one browser context carries desktop density into the
phone pass. The board is NOT demonstrated to be a groomed shrink. Re-measure
with a fresh context per width. Reasoning and the quoted code are in
`../specs/2026-09-03-scheduling-walkthrough-evidence/README.md`.

The other five tabs' identical-control-set finding STANDS. S13 — the officials
assign control sitting ~60% off-screen and keyboard-unreachable — STANDS, and
does not depend on density. S14 phone work is PARKED pending the re-measurement.

**Five briefed premises in this wave proved false**, every one caught by a
review rather than by a passing suite. Do not build on a premise here that is
not accompanied by a `file:line` someone actually opened.

## Trap this wave found the hard way

Task 4 proves its freeze guard by mutating the SERVED production bundle under
`.next/standalone`, because the prod server runs a build and editing source
proves nothing about what is running. An interrupted mutation leaves the running
server wrong, and `git status` shows nothing — `.next/` is ignored. Before
trusting any freeze assertion:

```sh
cd apps/web
grep -rac "the division schedule is locked" \
  .next/standalone/apps/web/.next/server/chunks/*.js | grep -v ':0$'
```

Nine chunks match on a clean build. Fewer means the bundle is still mutated and
the suite is lying. Rebuild rather than hand-patch a minified chunk.

## Cross-session

`fw2` (`feat/competition-desk-w2-run-sheet`) is rewriting `stages-panel.tsx` —
do not touch it from this branch. A merge conflict is CERTAIN in all four
`ui.json`: both waves append behind `reg.hub.registrants.table.soloAssigned`,
the last key in each file. Four hunks of that shape are expected; anything
further is real. `i18n-keys.ts` is generated — take one side wholesale and re-run
`pnpm run i18n:gen-keys`.
