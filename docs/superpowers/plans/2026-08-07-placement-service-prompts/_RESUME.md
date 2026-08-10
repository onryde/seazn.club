# RESUME — placement service build + cutover

Written 2026-08-10 ~10:00Z, at the end of a long session. This file is
**committed**; the SDD ledger at
`.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/progress.md` is
**git-ignored** and will not survive a fresh clone or a `git clean -fdx`.
Anything that matters is duplicated here.

Read this file, then `_INDEX.md` beside it, then the ledger if it still
exists.

---

## STATE: #501 MERGED, #503 open and green

**The cutover is live.** PR #501 merged 2026-08-10 16:07Z (`origin/main` at
`6ef9fc31`). The `placement` service is deployed on Fly, reachable at
`placement.flycast:50051`, and REAL staging boards have been solved through it.

**PR #503** (follow-up) — 9 checks passing. Real solver knobs, per-solve
telemetry, five tests, the wall/machine revert, and the findings below.
Merge it, then resume testing.

### The cutover WORKS. Six production runs proved it, the hard way

Every "solver problem" chased on 2026-08-10 turned out to be something else.
Read this before touching the solver:

| Symptom | Actual cause |
|---|---|
| 4 byte-identical boards, immune to wall AND hardware | the board was ALREADY APPLIED — every run re-solved around its own output as `existing` rows |
| `placed: 30/37`, "7 impossible" | never proved. `FEASIBLE` means the maximum was never established; 30 was greedy's number |
| solver never invoked, `not_searched`, 103 ms | **C2** — one court-scoped blackout, added from the UI |
| worker tuning had no effect | the env var was not wired to anything |

Three walls (10/20/30s) and three machines (shared-cpu-2x, performance-1x,
performance-8x/16gb) changed NOTHING on any board. All reverted in #503.

### Before ANY solver measurement, run this

    select count(*) filter (where scheduled_at is not null) as scheduled,
           count(*) as total
      from fixtures f join stages s on s.id = f.stage_id
     where s.division_id = '<id>';

`scheduled` must be 0. A non-zero value does not fail loudly — it produces a
plausible, stable, WRONG answer. This invalidated four deploys.

Staging DB access: `REMOTE_DATABASE_URL` is COMMENTED OUT in the repo-root
`.env.local` (line 9). Uncomment or export it; `psql` works directly.
`set search_path = seazn_club;` first.

### The T1 question — ANSWERED 2026-08-10, and the lead was wrong

**T1 does not complete on a real board and it is not going to.** That is now
a property to design around, not a bug to fix. Closed by `52ca2747`.

The lead recorded here — the range-reified day-cap encoding hiding a counting
bound, fixable with a redundant `sum(placed) <= sum_of_day_caps` — is
**refuted, both halves**. Do not re-derive it:

  * **Not the day cap.** With a NON-binding cap (999) on the same board, T1
    stalls identically and the dual bound is unchanged at 9 600 000. The cap
    was never the obstruction.
  * **Not fixable by a redundant bound.** A valid window-capacity floor (per
    court, `match+gap` spacing over the admissible ticks, capped by the
    per-day division caps) is exactly tight on 2 of 5 shapes and unlocks T1
    there — FEASIBLE to OPTIMAL in 1.65 s. On the other 3 it moves nothing.
    Separately: a hand-fed floor within **4%** of the incumbent still does not
    close in 15 s. Only an exactly-tight bound works, which is circular.
  * **Not a size problem.** A 2-day board of **304 variables / 575
    constraints** does not close in 15 s. The production board's size was
    never the issue.

What is actually missing: CP-SAT gets no counting relation between the
makespan window and how many fixtures must fit inside it, so the dual bound
starts at 0 (`#Bound 0.02s best:inf next:[0,131400000]`) and has to be walked
up by branching. The incumbent is found immediately in every run; only the
proof is missing — the same signature as T0's production story.

**So the fix was to stop throwing T1's board away.** A cut-short tier's board
is now ADOPTED rather than discarded. `tiers_completed` still counts only
PROVED tiers and `schema.py` already sliced `objective_values[:tiers_completed]`,
so no wire field moved. Measured gain, true span read off the ASSIGNMENTS (the
`makespan`/`worst_gap` variables are only bounded, not pinned, on any tier not
currently optimising them — reading them across arms compares noise):

| board | discarded (was) | adopted (now) | |
|---|---|---|---|
| 2-day | 130 800 000 | 79 200 000 | -39% |
| 3-day | 199 200 000 | 150 600 000 | -24% |
| 8-day | 618 600 000 | 481 200 000 | -22% |
| bench prod | 1 557 600 000 | 1 519 800 000 | |

**A solution hint was measured and REJECTED.** It would have made "the adopted
board is never worse" a guarantee instead of an observation, but over 6 runs
per arm on two boards the regression count was 0 either way (compared WITHIN a
run — two arms are two different solves and cannot be compared), while hinting
cost search quality: one hinted run returned 80 400 000 where six unhinted runs
returned 79 200 000, and under load the hinted arm proved fewer tiers. Note too
that a hint over `placed` and `start` alone is INCOMPLETE — CP-SAT says so:
"37 out of 187 non fixed variables hinted" — so the obvious cheap version of
this idea carries no guarantee at all.

Rejected by measurement earlier, still do not re-run: symmetry level (six runs,
no effect), and fewer search workers (8 -> OPTIMAL/4 tiers in 3.8 s; 4 ->
timeout at 3).

**Reproducing any of this:** `services/placement/bench/placement_bench_boards.py`
`build_board(n=37, courts_n=3, target_slots=108, not_after_entrants=0)` is the
2-day board, and it stalls T1 in under a second of setup. The starved local
repro that was said not to reproduce production does not need to — every shape
tried reproduces it.

### `test_production_board_meets_the_stated_acceptance_criterion` is load-bound

Red at load average 17-22, green at 8.8, same commit. Confirmed as pre-existing
rather than assumed: baseline and change interleaved 3 runs each fail 3/3 at
loads 11.7-19.5. A single baseline pass at load 14.9 was the outlier — n=1
against this solver decides nothing. Its docstring says it is load-sensitive on
purpose; believe it, and re-run alone at low load before triaging.

### Open work, in dependency order

1. ~~**Merge #503.**~~ DONE — merged as `c9b21798`.
2. ~~**`not_searched` names a cause it cannot know.**~~ DONE — reported live by
   the owner 2026-08-10, fixed same day. `build.ts` had SIX exits returning
   `not_searched` and `result-strip.tsx` mapped all six onto one sentence
   blaming the step alignment ("The match, gap and rest times you have set do
   not line up on a shared step"). For `:1286` (`!everyCourtSharesGrid`, i.e.
   **C2**) that is advice that cannot possibly work. Same defect shape as the
   `rule: "CAP"` trap below, on the outbound side: the status honest, the prose
   asserting a cause nothing established. Now a `NotSearchedReason`
   discriminant, one value per exit, with per-cause copy in all four locales.

   **Two findings worth keeping:**

   * **One of the six exits is DEAD from the public entry.** `canSolveWithin`
     — the R22 gate `buildSchedule` calls first — opens with the IDENTICAL
     `grid.overCap || grid.slots.length === 0` test that `solveBuild`'s own
     `lattice_unusable` exit makes, over the same config and the same pure
     `buildGrid`. So an over-cap board reaching `buildSchedule` always reports
     `too_big` and never `lattice_unusable`. Confirmed by probe, and
     `solveBuild` has exactly ONE production caller (`build.ts:1083`, inside
     `buildSchedule` — the other `solveBuild` in the greps is
     `placementClient`'s, a different symbol). The exit is kept as defence and
     reached in tests through a documented `solveBuildForTests` alias.
   * **The reasonless FALLBACK still has to be cause-free.** The first cut
     kept the old sentence for a server one deploy behind, on the reasoning
     that it "is still true of every cause, just less specific" — it is not:
     it names the step alignment. That fallback is exactly what an organiser
     hitting `per_court_grid` sees during a rollout, so it would have gone on
     serving the wrong advice to the one case that prompted the fix. Two
     committed tests asserted the false sentence and were rewritten to assert
     its ABSENCE.
3. **C2 — move it UP #21's order.** It is not a quality gap: one court-scoped
   blackout silently switches the optimiser off for an org, permanently, with
   a board that looks fine. Live repro in `_INDEX.md`. Row 2 above is the same
   defect wearing a misleading label, which raises its priority again.
4. ~~**The T1 encoding fix.**~~ ANSWERED — see the section above. The lead was
   wrong; the fix was to adopt the cut-short board (`52ca2747`).
5. **#21 unified contract revision** — one proto bump covering C1, C2, C4, C6.
   Revisit the shared staging service BEFORE it lands: with one service
   serving both, deploying a contract change to staging IS deploying to prod.
6. **A5** — disable other boards' buttons mid-solve. **A6** — wake-on-load
   `Health/Check` route (server-side, authed, rate-limited).
7. **Task 10** — remove z3 as a capability. Gated on C1/C2/C4/C6. The dead
   tier encoder is already deleted; this is the WASM loader and fallback path.
8. **Owner:** re-measure `NUM_SEARCH_WORKERS` on the real box — now that the
   knob actually works. Decide it WITH `PLACEMENT_WALL_SECONDS_MAX`, one
   variable at a time. **Re-measure the WALL too, now that a cut-short tier's
   board is kept**: before `52ca2747` extra wall bought nothing unless a whole
   tier proved, so it was close to worthless; now every extra second improves
   the board that actually ships.
9. **Check why a "max 5 per day" setting saved as 10, then 8.** Independent of
   the solver; looks like a UI/save path issue. **Leading candidate, not yet
   reproduced:** `constraints-panel.tsx:427-431` calls `save()` on every
   keystroke (`onChange`, not blur or debounce) and builds the payload from
   `withMaxFixturesPerDay(constraints.hard, ...)` — i.e. from the `constraints`
   prop captured in that closure. Typing into an existing value fires several
   overlapping saves, each computed from state that predates the ones already
   in flight, and the last response to land wins. That fits "5 became 10 then
   8" but is unverified — do not write it up as the cause without a repro.

### Reading a solver response

`solver.status` distinguishes reached from not-reached — `ok`/`already_optimal`
mean the service answered; `solver_unavailable`/`solver_busy`/`not_searched`
mean it did not. `engine` answers "did it WIN", which is a race and must never
be asserted. `elapsed_ms` is TS-side (whole round trip); the service's own time
is in its log line now.

Conflicts: read the `rule` field, NOT the `detail` prose. `rule: "CAP"` is the
day cap; the detail says "no court/time within horizon", which reads like a
capacity limit and is not one.

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
