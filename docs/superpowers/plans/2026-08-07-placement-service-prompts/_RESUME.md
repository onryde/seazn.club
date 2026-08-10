# RESUME — placement service build + cutover

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
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/placement-service-build
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

- Branch `worktree-cpsat-service-build`, **0 behind `origin/main`**, tree
  clean. Never pushed — no PR, no force-push concern. Take the current HEAD
  from live `git log`; do not trust a sha written here.
- Rebased onto `origin/main` this session: 73 commits, zero conflicts.
  `git merge-tree --write-tree origin/main HEAD` predicted it correctly
  beforehand; use that to preview next time.
- **Every sha recorded in the ledger before the rebase is historical.**
- Tasks 01-09, 5b, 5c, 06b and **07** all complete and reviewed. Nothing in
  flight; no agent running.

## Task 07 is CLOSED — nothing in flight

The reviewer landed before the session ended. **Spec PASS, quality approved
after 2 fix rounds**, 0 Critical / 0 Important open, 0 deferred Minors (the
one Minor was fixed inline). Commits `1b739d02`, `23fb5756`, `2b44d480`,
`80c181fd`. Review in `.superpowers/sdd/.../task-07-review.md`.

The review answered the question that mattered: Board 1's win depends only
on fields that actually reach the solver. `SolveBuildInput.constraints` is
exactly 4 fields (`placement-client.ts:71-76`); `dependencies` reaches placement
regardless of `direct` (`build.ts:1402-1404` drops it in the `.map()`);
`model.py:365`, `:429-445` enforce every pair unconditionally.

It also found a second no-teeth board. `scaleBoard`'s original assertions
(`length === 32`, `conflicts === 0`) could not fail: entrants never repeat,
so greedy alone places all 32 unaided, and any RPC failure fell back to
greedy with both assertions still green — while the docstring claimed it
proved the round-trip "without erroring or timing out". Seventh instance of
this programme's signature defect, second in that one file. Fixed with
`expect(result.status).not.toBe("solver_unavailable")`.

**Proven by negative control**, which is the evidence to trust: with
`PLACEMENT_SERVICE_SECRET=WRONG-SECRET` against a live service, Board 2 now
FAILS. Before `80c181fd` that same broken run passed green.

---

## Owner decisions settled this session — do not re-ask

| Decision | Answer |
|---|---|
| Scale to zero | `auto_stop_machines = "suspend"`, `min_machines_running = 0` on the solver. Suspend not stop: resumes from a memory snapshot instead of a 1-3s cold start against an 8-10s wall. Fly does not document suspend billing (pricing covers `stopped` only, rootfs $0.15/GB/30d); cents either way, so it is a latency choice |
| Host | `placement.flycast:50051`, NOT `.internal`. Autostart is a Fly Proxy feature and `.internal` bypasses the proxy, so suspended + `.internal` = unreachable = **silent greedy boards**. Needs a one-time `fly ips allocate-v6 --private` — DEPLOY.md step 2 |
| Staging web app | `fly.stg.toml` also moved `"stop"` -> `"suspend"`. No flycast work owed there: it is reached over the public internet through Fly Proxy already |
| Production web app | **Also `"suspend"`** (owner decision, `68280e42`). Only machines above `min_machines_running = 2` are affected; the floor never suspends. One real difference from `stop`: a suspended peer cannot answer `broadcastRevalidate`'s 6PN POST and resumes with its in-memory ISR cache intact, including entries invalidated while it slept. Acceptable because that is the failure mode `peer-revalidate.ts` already declares and bounds (fail-open, converges within the 30s `REVALIDATE_FAST` window). Revisit if that window tightens |
| 10 concurrent orgs | **A real target, not a worst case** (owner). Sequences the concurrency work ahead of the contract revision |
| Multi-board | Boards share a page but solve **one at a time, per button click** |
| `PLACEMENT_MAX_WORKERS` | Stays **1**. CP-SAT's parallelism is INTRA-solve (`NUM_SEARCH_WORKERS = 8`, `model.py:214`), so one solve already uses the whole box. Raising it trades proof depth for throughput nobody needs |
| Wake-on-load | An authenticated, rate-limited API route that pings gRPC `Health/Check`. The browser cannot reach 6PN, so it must be a server route. It starts a machine, so an open endpoint is an abuse lever |
| Who deploys | Owner, by hand, from DEPLOY.md. No agent runs `fly deploy` |

---

## Q1 / Q2 / Q3 — the concurrency discussion, in full

The owner asked three questions late in the session. The answers drive the
next task, so they are recorded here rather than left in a transcript.

### Q1 — "we should say solver busy when it can't solve or not reachable"

> **SUPERSEDED 2026-08-10, and this section was WRONG when written.** The
> split described below was already landed by Task 06b. Verified against
> the code, not grepped: `build.ts:1483-1484` maps
> `outcome.error?.code === "SOLVER_BUSY"` to `greedy("solver_busy")` and
> every other `ERROR` to `solver_unavailable`; `build.ts:1445-1462`'s catch
> (all five `PlacementError` failure kinds plus a plain `Error`) returns
> `solver_unavailable`. Both members are in the union (`build.ts:338`,
> `:384`) AND in the hand-written zod mirror
> (`apps/web/src/server/api-v1/schemas.ts:1029`, `:1059`). Copy exists in
> all four locales as `board.result.busy` / `board.result.unavailable`
> (`ui.json:3225-3226`). **So there is no union to widen, no `openapi:gen`
> to run, and no i18n owed.** `_INDEX.md`'s 06b row said so ("obligation
> discharged") and this file contradicted it; `_INDEX.md` was right.
>
> Kept rather than deleted because the vocabulary below is still the
> reference for what each status means, and because "the handoff asserted
> a bug that was already fixed" is the eighth instance of this programme's
> habit of trusting a written claim over the code.

The three statuses, as shipped:

| status | meaning | user sees |
|---|---|---|
| `solver_busy` | service reachable, refused admission | "Solver busy — retrying", retry once, then offer to wait or accept the quick board |
| `solver_unavailable` | unreachable / transport / deadline | "Couldn't reach the solver; showing a basic schedule" |
| `ok` / `already_optimal` | normal | unchanged |

**Two code sites, not one — and 06b wired both.** `SOLVER_BUSY` does not
arrive as a thrown failure kind; it comes back as `status: "ERROR"` with an
`error.code` (`schema.py:473` -> `placement-client.ts`'s `toOutcome`). So the
catch block and the outcome mapping each needed their own arm, and each has
one. Read `build.ts:1439-1484` before believing any claim about this path.

**The costs this section warned about are already paid**, and are recorded
here only so a future union change remembers them: a status added to
`BuildResult` widens a union that
`apps/web/src/server/api-v1/schemas.ts` hand-mirrors as a zod enum — which
reds `apps/web` tsc while the engine's own tsc stays green — and it drives
`openapi:gen`. Both are CI-only gates this repo has been bitten by
repeatedly. New user-facing strings need all four locale dictionaries.

### Q2 — "what happens if 10 orgs schedule a board with MAX_WORKERS=1"

**One org gets a real solve. The other nine get greedy boards in
milliseconds.** Verified chain, corrected 2026-08-10 against the code — the
original had two errors, marked below:

1. `main.py:94`, `:120` — admission control is
   `BoundedSemaphore(max_workers)` with `acquire(blocking=False)`. It
   refuses immediately; there is no queue.
2. Nine requests get `SOLVER_BUSY`.
3. `placement-client.ts`'s `toOutcome` resolves with `status: "ERROR"` plus
   `error.code`. **It does not throw** — the original said it did. The
   rejection path and the `ERROR`-status path are different arms.
4. `build.ts:1483-1484` returns `greedy("solver_busy")`. **Not
   `solver_unavailable`** — the original said that too, and 06b had already
   made it false.

So it is no longer *silent*: those nine organisers see
`board.result.busy` — "Scheduled quickly — the optimiser was busy. Try
again for a better board." A correct label on a worse board. What remains
wrong is the board itself, and no label fixes that: nine of ten organisers
still get greedy output on a solve the fleet could have served. That is
what machine count, not copy, has to fix.

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
`Map` (`placement-client.ts:179-188`). Ten concurrent solves ride ten HTTP/2
streams over one TCP connection, and Fly's TCP proxy balances by
*connection*. All ten pin to one machine no matter how many are running.

**So channel-per-solve is the unlock, and it must come first.** Handshake
cost on 6PN is milliseconds against a 2.5s solve, and it deletes the pooling
trap rather than working around it.

**Ordering, as revised 2026-08-10 once the status split turned out to be
already done:** channel-per-solve -> `hard_limit = 1` + `fly scale count 10`.
Doing `hard_limit` first achieves nothing, because one pooled connection is
one connection however the proxy is configured. The status-split step that
used to sit between them is discharged (see Q1).

---

## Open work, in dependency order

**Owner ordering, set 2026-08-10: concurrency, then the rename, then the
owner runs DEPLOY.md.** The rename must precede the first deploy — after it,
renaming the Fly app means recreating it and re-issuing
`PLACEMENT_SERVICE_SECRET`. Accepted cost of not waiting for #21: the proto
rename pays its own stub regen now, and #21 pays a second one later.

1. **Solver concurrency — Task 12, in flight.** Q2/Q3 above. Four files:
   `placement-client.ts` (channel-per-solve), `placement-client.test.ts`,
   `fly.toml` (`[services.concurrency]`, absent today), `DEPLOY.md`
   (`fly scale count 10`). **`build.ts` is NOT in scope** — its status
   mapping is already correct. Brief:
   `.superpowers/sdd/.../task-12-brief.md`.
   1b. **Not yet briefed, and owed before the concurrency story is whole:**
   the UI must disable other boards' buttons while a solve is in flight
   (`_INDEX.md` decision, 2026-08-10) — otherwise "one at a time" is an
   intention, not a guarantee — and the wake-on-page-load route that pings
   gRPC `Health/Check` to resume a suspended machine, authenticated and
   rate-limited because it starts a machine.
1c. **Rename `cp-sat` -> `placement` — DONE (Task 13, 2026-08-10).** Spec
   PASS, quality approved. The engine label became **`"optimized"`**, a
   different word on purpose. Next is Task 11, then the owner deploys.
2. **Task 11 (E2E + smoke)** — no brief written. E2E and smoke are deferred
   in full to it for every task 01-07; **no task has paid either**. Until it
   lands the cutover has zero end-to-end coverage.
3. **#21 unified contract revision** covering C1, C2, C4, C5.
5. **C2, C1, C4, C5** — blocked on #21.
6. **#20 rename `cp-sat` -> `placement` — CLOSED** (Task 13, 2026-08-10),
   ahead of the first deploy as the owner directed. It was cheap then and
   would have cost a recreated Fly app and a re-issued secret afterwards.
7. **Task 10** — delete BUILD/POLISH z3. Blocked on all the gaps + a deploy.
8. **Owner:** run `services/placement/DEPLOY.md`. Then re-measure
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

> Continue the placement scheduler cutover programme in this worktree
> (`worktree-cpsat-service-build`). Read
> `docs/superpowers/plans/2026-08-07-placement-service-prompts/_RESUME.md`
> first, then `_INDEX.md` beside it, then the SDD ledger at
> `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/progress.md` if it
> still exists.
>
> Nothing is in flight and Task 07 is closed (spec PASS, quality approved
> after 2 fix rounds, 0 deferred Minors).
>
> Work the open list in `_RESUME.md` in dependency order. The first item is
> the solver concurrency + status honesty work
> (channel-per-solve, then the `solver_busy` split with its i18n and
> `openapi:gen` regen, then `hard_limit` + `fly scale count`) — the full
> reasoning is in `_RESUME.md`'s Q1/Q2/Q3 section and the decisions are
> already settled, so do not re-litigate them. Ten concurrent orgs is a real
> target, not a worst case.
>
> Standing rules: follow the SDD loop (fresh implementer per task, then a
> task reviewer returning BOTH verdicts, then the ledger entry). Never
> enable or modify `.github/workflows/e2e.yml`. Never `git stash` in this
> worktree — the stash stack is shared with the main checkout. Do not file
> GitHub issues; fix inline or ask. No agent runs `fly deploy`. Verify every
> green from `--reporter=json`, never from a wrapper summary or an exit code.
