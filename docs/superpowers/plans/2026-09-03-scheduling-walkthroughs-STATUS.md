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
| 9 | Undo/redo refuse it too; joint path says why | `9f6d4117f` … `cb6a3ceda`, `bfae88327` |
| 4 | Organiser's scheduling day walkthrough | `6b9978ac3` + fix round `5b3c6949c` — green ×3, 2 mutants killed |

## Open

- **Task 4 re-review** — of fix round `5b3c6949c`. Dispatched; if no
  `task-4-rereview.md` exists, it did not survive.
- **Task 5** — officials handoff walkthrough (see below). Its brief carries two
  controller amendments: finding S4's apply button must be encoded as
  `test.fail()` (never `test.skip()`), and the durable rows it writes
  (`officials`, `official_availability`, `fixture_officials`) need an
  idempotent `afterAll` cleanup.
- **Product change owed, recorded nowhere else.** `autoSolverWallMs`
  (`apps/web/src/server/usecases/schedule.ts:1992`) is MIRRORED into the
  walkthrough rather than imported, because a Playwright spec cannot import a
  server module. It wants exporting from a leaf, the way `HOLD_MS` and
  `NOT_RECORDING_GRACE_MINUTES` already are. Fold into Task 10, the
  constant-extraction task. This survives only here: the report that would have
  carried it was never written.

## Rate limit, 2026-09-04

The Task 4 fix-round implementer was killed mid-round by a WEEKLY opus limit
(HTTP 429, `claude-opus-5`, resets **Sep 5 19:00 Europe/London**). It had
committed `5b3c6949c` first, so nothing was lost, but its report never got
written. Until that resets, dispatch reviewers and implementers on a mid-tier
model; an opus dispatch 429s on arrival.

The verification the agent never reached was run by hand instead: three clean
runs (suites 2, expected 3, unexpected 0, flaky 0), walkthrough test 31.08s
against a derived 81s budget and a 90s ceiling, tsc and eslint both exit 0 from
the worktree's own `apps/web`.
- **Task 5** — officials handoff walkthrough. Its apply step must stay a
  FAILING test (`test.fail()`, never skip) per spec §S4.
- **Task 6** — perf gate, cost table, findings doc.
- **Task 10** — `SCHEDULE_LOCKED` error code plus a shared constant across the
  six throw sites. Owner sequenced this AFTER the walkthroughs.

## Findings that must not be misread

**The board-tab control-set row is RETRACTED — and now SETTLED.** Task 4
measured it: on a first phone visit at 320 with no saved preference, the board
opens at **Agenda**, its intended mobile default. No phone composition work is
owed for the board tab. S14 covers the other tabs only.

Why the original measurement was wrong: `schedule-board.tsx:853-861`
reads a saved density from `localStorage` before applying its mobile default, so
a 1280 → 768 → 320 sweep in one browser context carries desktop density into the
phone pass. The board is NOT demonstrated to be a groomed shrink. That is what a fresh context per width
showed. Reasoning and the quoted code are in
`../specs/2026-09-03-scheduling-walkthrough-evidence/README.md`.

The other five tabs' identical-control-set finding STANDS. S13 — the officials
assign control sitting ~60% off-screen and keyboard-unreachable — STANDS, and
does not depend on density. S14 phone work proceeds for the five tabs that have no persisted view state.

**Five briefed premises in this wave proved false**, every one caught by a
review rather than by a passing suite. Do not build on a premise here that is
not accompanied by a `file:line` someone actually opened.

## Trap this wave found the hard way

**A shared prod server serves whatever build it was started with.** The server
on :3313 was found serving a build stamped an hour earlier — from before
`a74095b13`, so without the Task 3 testids or any of the freeze guards under
test — while agents tested against it. Rebuilt at Task 4; it is shared, so a
rebuild is a side effect on other sessions and should be announced.

Grepping a guard's copy out of the served chunks does NOT detect this. That
check was run and passed, because an earlier guard used the same string. Check
the stamp instead:

```sh
ls -l --time-style=full-iso apps/web/.next/standalone/apps/web/.next/BUILD_ID
git log -1 --format=%cI <the commit whose behaviour you are testing>
```

A build older than the commit makes every assertion about it meaningless,
passing or failing. Ask "is this server serving my tree?" before the first
e2e run, not after a confusing red.

(An earlier revision of this file warned that Task 4 mutation-tests by patching
the served bundle, and that an interrupted run would leave a lying server with
a clean `git status` — `.next/` being ignored. The patching was refused by the
permission classifier and never happened. The reasoning still applies to anyone
who does patch a build; it is not something that occurred here.)

## Cross-session

`fw2` (`feat/competition-desk-w2-run-sheet`) is rewriting `stages-panel.tsx` —
do not touch it from this branch. A merge conflict is CERTAIN in all four
`ui.json`: both waves append behind `reg.hub.registrants.table.soloAssigned`,
the last key in each file. Four hunks of that shape are expected; anything
further is real. `i18n-keys.ts` is generated — take one side wholesale and re-run
`pnpm run i18n:gen-keys`.
