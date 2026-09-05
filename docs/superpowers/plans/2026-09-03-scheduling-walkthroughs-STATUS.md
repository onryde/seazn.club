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


## Whole-branch review — findings and rulings (2026-09-04)

Three read-only reviewers over `origin/main...HEAD` (41 commits, 40 files).
Reports: `wb-review-logic.md`, `wb-review-i18n.md`, `wb-review-tests.md` in the
plan's SDD workspace. Rulings below are mine as product owner, made rather than
deferred, and each says what it costs if wrong.

**Tests: approved.** No Critical or Major. Every "derived from X" and
guard-placement claim in this wave's tests was cross-checked against production
source and held.

### Critical — `clearPoolEntrants` has no freeze guard

`history.ts:768`, live at `POST /api/v1/pools/[id]/clear-entrants`. It takes the
advisory lock, reads fixtures, calls `engineRemovePool`, then `execute(...)`,
with no `divisionLockState`. A frozen division's fixtures can be removed through
it today. Verified by reading the function, not relayed. **Pre-existing** —
`git log -L :clearPoolEntrants:` from the worktree shows this branch never
touched it.

**Ruling: fix it in this wave.** The wave's headline claim is that a frozen
division refuses edits; that claim is false while this route works, and the
repair is the same four lines as its three siblings in the same file. Landed as
Task 10 Step 4, with a red-first test and an unfrozen control in the same test —
a guard that refuses everything looks identical to a working one otherwise.
*If wrong:* four lines and a test to revert, and a route that was already
unguarded stays unguarded.

### Major — a freeze landing mid-`restoreCheckpoint` leaves a partial rewind

`history.ts:667-679` runs its undo loop as N independent transactions with no
lock spanning them, and the new per-step freeze check re-reads on every
iteration. A concurrent `setDivisionLocks` stops the rewind partway and returns
a 422 that reads as "nothing happened" while earlier events are committed.
Untested — every existing test freezes *before* the restore, never during.

**Ruling: the 422 must carry how many steps were already undone.** A refusal
that cannot be distinguished from a no-op is the worse half of this defect; the
partial rewind itself is acceptable, since the alternative is holding a lock
across N transactions. Owed: a test that freezes mid-loop, and the count in the
error payload. *If wrong:* the payload gains a field nobody reads.

### Major ×2 — this branch's own English leaks into translated cards

`ai-competition-console.tsx:628-631` fills `board.ai.joint.undoneReason`'s
`{reason}` with a raw server `err.message` (from
`competition-schedule-restore.ts:184`), so "the division schedule is locked —
unlock it to edit" ships in English mid-sentence inside a fully translated card,
on the first request. `history-panel.tsx:143,253` renders `err.message` raw in a
generic `catch`, reachable via a stale `scheduleLocked` prop.

**Ruling: fix in this wave, sequenced after Task 10.** The `SCHEDULE_LOCKED`
code that task adds is exactly the handle a client needs to render a local
string instead of echoing the server's English — so this is one piece of work
done in order, not two. *If wrong:* a translated surface keeps an English clause
slightly longer than it should.

### Not in scope, deliberately

`stages-panel.tsx:744-745`'s unwired second undo control is real and stays for
another wave — a concurrent wave is rewriting that file, and a unilateral edit
there makes the merge worse, not better. `schedule-ai.ts`'s 409 refusal shares
the concept but not the string; changing a status code is a contract change
nobody asked for.


## SHIPPED TO REVIEW — 2026-09-05

**PR #723** — https://github.com/onryde/seazn.club/pull/723
Branch `feat/scheduling-walkthrough`, 59 commits, rebased onto `origin/main`,
pushed, tree clean. Nothing outstanding in the worktree.

CI in flight: the PR's own checks (smoke, lint, typecheck, engine matrix,
security, proto drift, Docker) plus an e2e run dispatched manually —
**e2e does NOT run on PRs in this repo**, only on push to `main` or via
`workflow_dispatch` with a `pr` input. That dispatch is run
[33969980134](https://github.com/onryde/seazn.club/actions/runs/33969980134).
A fresh session must re-dispatch it after any new push; nothing does it
automatically.

### If you are picking this up cold

The full record is the SDD ledger at
`.superpowers/sdd/2026-09-03-scheduling-walkthroughs/progress.md` — git-ignored
and machine-local, so on another checkout this file plus the PR body is all
there is.

What the PR body already says, and is not repeated here: the nine unguarded
write paths found across five rounds, the verification numbers with their
caveats, and the three things left deliberately unfixed.

What it does NOT say, and matters if a check goes red:
- `rs012-solo-signup-pool` fails locally for want of `CRON_SECRET`, which
  `seazn-env` does not export. Pre-existing, identical on `main`. If CI reds
  there, it is not this branch.
- Three `credits-*` suites fail under parallel load and pass in isolation. Two
  independent sessions reproduced that.
- Three money specs skip without `CONNECT_WALKTHROUGH=1`; a "green" walkthrough
  project that includes those skips proves nothing about the money path.

### Owed, none blocking

`putScheduleSettings` can remove a court from a frozen division (comment
corrected in `e2b6452c2`, guard deliberately not added); `stages-panel.tsx`
renders four controls enabled on a frozen division so they hit an unanticipated
422 — untouched because a concurrent wave is rewriting that file; the three AI
gates hand-type `"SCHEDULE_LOCKED"` rather than importing it; the translated
error frame `history.error.unexpected`; S13; and the suite's skip-vs-throw
inconsistency on missing env.
