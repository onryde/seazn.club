# RESUME — cp-sat service build + cutover

Written 2026-08-10 ~10:00Z, at the end of a long session. This file is
**committed**; the SDD ledger at
`.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/progress.md` is
**git-ignored** and will not survive a fresh clone or a `git clean -fdx`.
Anything that matters is duplicated here.

Read this file, then `_INDEX.md` beside it, then the ledger if it still
exists.

---

## How to restart

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cpsat-service-build
claude
```

Do **not** `cd` to the main checkout, and do not `git checkout` this branch
anywhere else — it is `worktree-cpsat-service-build`, checked out only here.
Shell cwd resets to the main checkout between tool calls in this repo, so
every verify command must carry its own `cd <abs worktree> &&` in the SAME
call, and resolved paths in `.testResults[].name` must be confirmed to sit
inside the worktree before any count is believed.

`claude --resume` reopens a previous session's transcript if you want the
history; a fresh `claude` with the prompt at the bottom of this file is
cleaner and cheaper.

---

## State as of this file

- Branch `worktree-cpsat-service-build`, HEAD `0835792a`, **0 behind
  `origin/main`**, tree clean, 78 commits ahead. Never pushed — no PR, no
  force-push concern.
- Rebased onto `origin/main` this session: 73 commits, zero conflicts.
  `git merge-tree --write-tree origin/main HEAD` predicted it correctly
  beforehand; use that to preview next time.
- **Every sha recorded in the ledger before the rebase is historical.**
  Take BASE from live `git log`.
- Tasks 01-09 and 5b/5c/06b complete. Task 07 complete pending review.

## IN FLIGHT AND LOST — re-dispatch this first

A task reviewer for **Task 07** was dispatched and did not finish before the
session ended. Its result is gone. **Task 07 is NOT closed**: it has an
implementer report and a resolved fix round, but no spec verdict and no
quality verdict, and the SDD loop requires both.

Re-dispatch it. Everything it needs already exists on disk:

- Brief: `.superpowers/sdd/.../task-07-brief.md`
- Report: `.superpowers/sdd/.../task-07-report.md`
- Review package: `.superpowers/sdd/.../review-task07-bf2f9682..b069d282.diff`
  (372 lines, BASE `bf2f9682`, built with **path filters** because three of
  the coordinator's own commits interleave with the task's — `c74ac3ca`,
  `dba3cd8f`, `b069d282`. Verified disjoint. The task's own commits are
  three: `1b739d02`, `23fb5756`, `2b44d480`.)

The one question that review must answer: **does every constraint the
current Board 1's win depends on actually reach the solver on the wire?**
Checked against `cpsat-client.ts`'s `SolveBuildInput`/`toRequest` and
`services/cp-sat/src/cp_sat/model.py` — NOT against the test's own comments.
Board 1 failed exactly that check twice already. Do not ask it to re-run the
suite: the implementer ran it and the coordinator verified independently
(3 consecutive live runs at 3/3, default-skip at 3 pending / 0 passed).

---

## Owner decisions settled this session — do not re-ask

| Decision | Answer |
|---|---|
| Scale to zero | `auto_stop_machines = "suspend"`, `min_machines_running = 0` on the solver. Suspend not stop: resumes from a memory snapshot instead of a 1-3s cold start against an 8-10s wall. Fly does not document suspend billing (pricing covers `stopped` only, rootfs $0.15/GB/30d); cents either way, so it is a latency choice |
| Host | `cp-sat.flycast:50051`, NOT `.internal`. Autostart is a Fly Proxy feature and `.internal` bypasses the proxy, so suspended + `.internal` = unreachable = **silent greedy boards**. Needs a one-time `fly ips allocate-v6 --private` — DEPLOY.md step 2 |
| Staging web app | `fly.stg.toml` also moved `"stop"` -> `"suspend"`. No flycast work owed there: it is reached over the public internet through Fly Proxy already |
| Production web app | **NOT changed.** Deliberately left alone — suspending it puts a resume in front of a real user's page load. Needs an explicit decision |
| Multi-board | Boards share a page but solve **one at a time, per button click** |
| `CPSAT_MAX_WORKERS` | Stays **1**. CP-SAT's parallelism is INTRA-solve (`NUM_SEARCH_WORKERS = 8`, `model.py:214`), so one solve already uses the whole box. Raising it trades proof depth for throughput nobody needs |
| Wake-on-load | An authenticated, rate-limited API route that pings gRPC `Health/Check`. The browser cannot reach 6PN, so it must be a server route. It starts a machine, so an open endpoint is an abuse lever |
| Who deploys | Owner, by hand, from DEPLOY.md. No agent runs `fly deploy` |

---

## Q1 / Q2 / Q3 — the concurrency discussion, in full

The owner asked three questions late in the session. The answers drive the
next task, so they are recorded here rather than left in a transcript.

### Q1 — "we should say solver busy when it can't solve or not reachable"

**Today those are the same thing, and that is the bug.** All five
`CpSatError` failure kinds, plus a plain `Error`, plus the service's own
`SOLVER_BUSY`, collapse into `greedy("solver_unavailable")` at `build.ts`'s
catch. Task 06b did that deliberately and it was right at the time; it is
no longer.

Split into three:

| status | meaning | user sees |
|---|---|---|
| `solver_busy` | service reachable, refused admission | "Solver busy — retrying", retry once, then offer to wait or accept the quick board |
| `solver_unavailable` | unreachable / transport / deadline | "Couldn't reach the solver; showing a basic schedule" |
| `ok` / `already_optimal` | normal | unchanged |

**Two code sites, not one.** `SOLVER_BUSY` does not arrive as a thrown
failure kind — it comes back as `status: "ERROR"` with an `error.code`
(`schema.py:473` -> `cpsat-client.ts`'s `toOutcome`). So the catch block and
the outcome mapping both need it.

**Two costs to know before starting.** Adding `solver_busy` widens a union
that `apps/web/src/server/api-v1/schemas.ts` hand-mirrors as a zod enum —
that reds `apps/web` tsc while the engine's own tsc stays green, and it
drives `openapi:gen`. Both are CI-only gates this repo has been bitten by
repeatedly. And the new user-facing strings need all four locale
dictionaries.

### Q2 — "what happens if 10 orgs schedule a board with MAX_WORKERS=1"

**One org gets a real solve. The other nine get greedy boards, silently, in
milliseconds.** Verified chain:

1. `main.py`'s admission control is `BoundedSemaphore.acquire(blocking=False)`
   — it refuses immediately, there is no queue.
2. Nine requests get `SOLVER_BUSY`.
3. `cpsat-client.ts` maps that to `status: "ERROR"` and throws.
4. `build.ts` folds it into `greedy("solver_unavailable")`.

Nine organisers get a plausible-looking schedule that is measurably worse,
with nothing saying so. Not a slow path — a *fast wrong* path. This is a
cliff, not a slope, and it is invisible.

**10 solvers means 10 MACHINES, not 10 workers:**

```toml
[services.concurrency]
  type       = "connections"
  hard_limit = 1
  soft_limit = 1
```

`hard_limit = 1` tells the proxy a machine is full at one connection, so the
second concurrent solve goes to another machine and autostarts it. Then
`fly scale count 10`. Nine sit suspended costing only rootfs storage. Each
solve gets a whole box, so `NUM_SEARCH_WORKERS = 8` stays honest and
`MAX_WORKERS = 1` stays correct — concurrency comes from machine count, the
one axis that does not trade away proof depth.

### Q3 — "how do we know which one to wake up"

**You never pick. That is the entire reason for `.flycast`.**

You dial one name; Fly Proxy picks a machine and starts it if suspended. The
machines are interchangeable — the solver is stateless, holds no session,
and every request carries its whole board. Addressing an individual machine
is precisely what `.internal` does, and precisely why it cannot autostart.

**But the proxy can only distribute what it can see, and right now it sees
ONE connection.** `clientFor` caches one channel per host in a module-level
`Map` (`cpsat-client.ts:179-188`). Ten concurrent solves ride ten HTTP/2
streams over one TCP connection, and Fly's TCP proxy balances by
*connection*. All ten pin to one machine no matter how many are running.

**So channel-per-solve is the unlock, and it must come first.** Handshake
cost on 6PN is milliseconds against a 2.5s solve, and it deletes the pooling
trap rather than working around it.

**Ordering:** channel-per-solve -> status split (+ i18n + `openapi:gen`) ->
`hard_limit` + `fly scale count`. Doing `hard_limit` first achieves nothing;
doing autostop before the status split turns every contention event into an
invisible downgrade.

---

## Open work, in dependency order

1. **Task 07 review** — re-dispatch, above. Blocks closing Task 07.
2. **Task 11 (E2E + smoke)** — no brief written. E2E and smoke are deferred
   in full to it for every task 01-07; **no task has paid either**. Until it
   lands the cutover has zero end-to-end coverage.
3. **Solver concurrency + status honesty** — Q1/Q2/Q3 above. One cohesive
   task: `build.ts` + `cpsat-client.ts`, one test story.
4. **#21 unified contract revision** covering C1, C2, C4, C5.
5. **C2, C1, C4, C5** — blocked on #21.
6. **#20 rename `cp-sat` -> `placement`** across seven namespaces (1013 refs
   / 66 files, measured). Cheap now, expensive after deploy — the engine
   label is not persisted anywhere.
7. **Task 10** — delete BUILD/POLISH z3. Blocked on all the gaps + a deploy.
8. **Owner:** run `services/cp-sat/DEPLOY.md`. Then re-measure
   `NUM_SEARCH_WORKERS` on the real machine shape (hardcoded 8, measured on
   a 6-core dev box; a dev-box A/B already found 4 beating 8 and 12).

## Traps this session paid for

- **A union widened in `packages/engine` reds `apps/web` tsc while the
  engine's own tsc stays green.** `schemas.ts` hand-mirrors it as a zod
  enum. It was red at base for two whole tasks past two reviews and the
  coordinator's own gate.
- **A test whose win condition is a constraint the solver never receives is
  green by luck.** Board 1 flipped pass/fail on consecutive runs against one
  unchanged service. n=1 against a nondeterministic solver decides nothing —
  N>=6, paste the spread.
- **`isBlockingConflict` (`calendar.ts:202-209`) is `court` /
  `person_overlap` / `window` / `order`-with-`direct`.** `start_window` is
  NOT in it — warn-only for the D6 gate. The coordinator wrote the wrong
  mechanism into a committed doc and the implementer caught it.
- **Separately real:** `rejectedBlockingConflicts` is a DELTA keyed
  `fixtureId|reason|detail`, so a blocking conflict matching one the greedy
  seed already carried ships un-rejected. No repro built.
- **A stale local service on `:50051` serves old source and produces a false
  green.** Both ports confirmed free at session end.
- **Four things were reported done this session and were not** — including
  two of the coordinator's own claims. Grep before repeating any completion
  claim.

---

## Resume prompt

Paste this into a fresh `claude` started in the worktree:

> Continue the cp-sat scheduler cutover programme in this worktree
> (`worktree-cpsat-service-build`). Read
> `docs/superpowers/plans/2026-08-07-cpsat-service-prompts/_RESUME.md`
> first, then `_INDEX.md` beside it, then the SDD ledger at
> `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/progress.md` if it
> still exists.
>
> First action: re-dispatch the Task 07 task reviewer — it was in flight when
> the last session ended and its result was lost. The brief, report and
> review package are all on disk; `_RESUME.md` names them and states the one
> question the review must answer. Task 07 is not closed until it returns
> both a spec verdict and a quality verdict.
>
> After that, work the open list in `_RESUME.md` in dependency order. The
> next substantive task is the solver concurrency + status honesty work
> (channel-per-solve, then the `solver_busy` split with its i18n and
> `openapi:gen` regen, then `hard_limit` + `fly scale count`) — the full
> reasoning is in `_RESUME.md`'s Q1/Q2/Q3 section and the decisions are
> already settled, so do not re-litigate them.
>
> Standing rules: follow the SDD loop (fresh implementer per task, then a
> task reviewer returning BOTH verdicts, then the ledger entry). Never
> enable or modify `.github/workflows/e2e.yml`. Never `git stash` in this
> worktree — the stash stack is shared with the main checkout. Do not file
> GitHub issues; fix inline or ask. No agent runs `fly deploy`. Verify every
> green from `--reporter=json`, never from a wrapper summary or an exit code.
