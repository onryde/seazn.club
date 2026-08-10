# CP-SAT service — BUILD/POLISH cutover — prompt index

**Read this first.** Compaction-proof authority on what this programme is,
where its decisions live, and what order its prompts run in.

- **Design doc** (why, investigation record, contract, architecture,
  open items): `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`
- **Full narrative plan** (this index's source — task boundaries, file
  structure, self-review): `docs/superpowers/plans/2026-08-07-cpsat-service-build-cutover.md`
- **REFLOW cutover is a separate, future programme** — not in scope here.
  Gated on the open items tracked in memory
  `project_cpsat_reflow_repair_investigation.md`. Do not fold REFLOW work
  into any prompt below.
- **Binding rules for THIS programme**: `_RULES.md` beside this file —
  the Domain-Driven Design standard (layers, allowed imports per module,
  ubiquitous language, what the anti-corruption layer owes). Owner-
  mandated 2026-08-09 and **binding on Tasks 01-11 and every reviewer**.
  Every dispatch that touches this programme's code restates the
  relevant rule inline or points there. Each rule carries the command
  that proves it — a reviewer who cannot run the check has not verified
  the rule.
- **Project-wide standing rules**: `docs/superpowers/RULES.md` — read it.
  Agent topology for dispatching any prompt below: Scout=Sonnet High,
  Implementer=Sonnet xHigh, Reviewer=Sonnet xHigh (NOT Opus — supersedes
  older guidance). **Session override 2026-08-09: the owner directed
  that all subagents in the current session run on Opus xHigh instead.
  That override is per-session and does NOT amend the standing topology
  above** — a later session with no such instruction goes back to Sonnet.
  Tasks 01-04 were implemented and reviewed on Sonnet xHigh; Task 05
  onward, and the Tasks 01-04 re-audit, ran on Opus. Every task
  ultimately owes all 4 test types (unit,
  E2E, smoke, regression) — Prompts 01-05 are unit-only because nothing
  user-facing exists yet to E2E/smoke; **Prompt 11 (new, below) is where
  E2E + smoke coverage lands**, once Prompt 06b makes the feature visible
  end-to-end. Don't skip 11 as redundant with Prompt 07's integration
  suite — 07 proves TS↔Python correctness, 11 proves an organiser
  clicking Auto-schedule in a real browser gets a correct board.

## Standing rules for this programme

- Every prompt below is self-contained — exact paths, real code, the
  verify command, what not to touch. A subagent should not need to
  re-read this index or the design doc to execute one prompt, though
  the design doc is the right place to check *why* a decision was made
  if something looks surprising.
- **Do NOT file new issues.** If something is wrong or unclear, fix it
  inline or ask; escalate only if a fix would widen the blast radius
  past the prompt's stated files.
- Run each prompt's own verify command before considering it done —
  never accept "tests pass" without the raw counts.
- Output cap per prompt: final message under 15 lines — counts, paths,
  deviations, blockers. No file contents, no diffs.

## Execution order

```
01 (proto) → 02, 03 (Python model + objective, can run together — same
package, sequential is safer given 03 imports 02) → 04 (server, needs
01-03) → 05 (TS client, needs 01) → 05b (corpus + coverage hardening) →
05c (contract + boundary hardening; 05b FIRST — while the corpus is
EPOCH_MS=0, "unset" and "legitimate value" are the same number, so a
guard added by 05c cannot be proven to fail for the case it exists for)
→ 06 (wire build.ts, needs 04 deployed
somewhere reachable + 05) → 06b (status mapping, needs 06) → 07
(integration tests, needs 06b) → 11 (E2E + smoke, needs 06b — the point
at which the feature is visible end-to-end) → 08 ∥ 09 (deployment, CI —
independent of each other and of 06/06b/07/11) → 10 (remove z3, gated on
01-09 AND 11 ALL green in production for one deploy cycle, not same-day)
```

## Status

Live status is tracked in the SDD ledger, which is git-ignored and so
invisible to a fresh clone: `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/progress.md`.
That ledger is authoritative on *what happened*; this table is the
compaction-proof summary. Keep them in step.

> **Every commit sha in the table below predates a rebase and NO LONGER
> EXISTS.** The branch `worktree-cpsat-service-build` was rebased onto
> `origin/main` `3bab9f43` on 2026-08-10 (60 commits replayed, 0 behind
> after). Post-rebase tips, newest first: `e07ee222` (06 docs) ·
> `29562567` · `8159998b` (06 fix round) · `a584843e` · `32cdf9f3` (06 WIP)
> · `7e11a303` · `64b64f5e` · `1861f363` (08 fix round) · `ece815cf` ·
> `88f484cd` · `fb8a5bab` (08) · `fac91b97` (09) · `d6ffaf9f` · `bf5ac722`.
> The ranges below still read correctly as *what changed in which task* —
> resolve one with `git log --oneline --grep=<subject>` rather than by sha.
> Only ONE conflict arose: `build-rest-lattice.test.ts`, imports only —
> main's `409ae00d` moved `gridStepMinutes` into a new `grid-step.ts` and
> that crossed Task 06's added `cpsat-client` import. Verified after:
> `src/scheduling` **567 passed / 0 failed / 19 skipped**, `tsc` 0 errors.

| # | Prompt | State |
|---|---|---|
| 01 | Proto contract | **complete** — `0c8eb752..e854b978`, review clean |
| 02 | BUILD model (promote from bench) | **complete** — `e854b978..eee3a590`, clean after 2 fix rounds |
| 03 | T0-T3 objective chain | **complete** — `eee3a590..f64235e6`, clean after 1 fix round |
| 04 | gRPC server (auth, health, mapping) | **complete** — `f64235e6..f19605a6`, clean after 1 fix round |
| 05 | TS codegen + client wrapper | **complete** — `f19605a6..b33ac2fb`, approved after 1 fix round |
| 05b | Corpus + coverage hardening (Python tests) | **complete** — `b33ac2fb..a554961e`, clean after fix rounds |
| 05c | Contract + boundary hardening | **complete** — `a554961e..5774439e`, after 6 fix rounds. Rounds 4 and 5 each tried a *character* rule for id canonicality (`.strip()`, then `isprintable()`) and each was defeated — by Cf characters, then by ten code points in Lo/Mn/So. Homoglyphs (`'Сourt 1'`, Cyrillic Es U+0421) defeat any such rule, so round 6 re-cut the contract to **positional identity**: index is identity, the service compares no strings, `court_names` is display-only |
| 06 | Wire `solveBuild` in `build.ts` | **complete** — `b673faa6..bc6bb663`, approved after 1 fix round. Read the box below before touching this code |
| 06b | Status vocabulary translation | not started — **carries an obligation Task 08 discovered**: `CPSAT_MAX_WORKERS=1` on the deploy shape means a second concurrent organiser gets `SOLVER_BUSY`, and **nothing maps that to a greedy board today**. `build.ts`'s existing `"solver_busy"` path is `MAX_SOLVER_QUEUE`, the LOCAL z3 queue cap — unrelated. The service's `SOLVER_BUSY` (`schema.py:473`) reaches `toOutcome` as `status:"ERROR"` + `error.code` and is read by nobody. 06b must map it, or one of two simultaneous organisers gets an error rather than a board |
| 07 | Integration tests (parity, regression, fallback) | not started |
| 11 | E2E + smoke coverage | not started — **brief written** |
| 08 | Deployment (Dockerfile, fly.toml) | **complete** — `befd49eb..d292e33f`, approved after 1 fix round. App is `cp-sat` (NOT the plan's `seazn-cpsat-prod` sample — `.internal` DNS derives from the app name and must match `cpsat-client.ts:127`'s `cp-sat.internal:50051`). Warm-start is carried by `auto_stop_machines = "off"`; `min_machines_running = 1` is set but inert beside it |
| 09 | CI workflow | **complete** — `8d78c595..befd49eb` plus `c57eefe6`, spec PASS + quality approved, 0 Critical/Important. Builds AND runs the image; drift gate covers Python and TS stubs |
| 10 | Remove BUILD/POLISH's z3 code | **blocked** — 01-09 and 11 live in production for one full deploy cycle, **AND the per-court-grid gap closed** (see below) |

### Prompt 10 has a second gate now: the per-court-grid capability gap

Prompt 05c found that CP-SAT was placing fixtures at start times the
court did not offer — measured 6/6 with `C0` at `{T, T+40}` and `C1` at
`{T+40}`, a fixture landed on `C1` at `T`. The board was wrong, and the
TS verifier rejected it afterwards.

The ACL now requires every court to offer identical start times, so those
boards are **refused rather than mis-scheduled**. That is strictly better
— but it means **CP-SAT refuses a shape z3 accepts**, and
`Blackout.court?` (`calendar.ts:21`) makes that shape reachable from
ordinary org data.

**So z3 cannot be removed while this holds.** Removing it would leave any
org with a per-court blackout permanently on the greedy fallback.

The fix is specified but deliberately not built: an enforced per-court
start domain in the model, free on homogeneous boards. It was left out of
05c because it is in the solver hot path, was not asked for, and needs
its own timing case. Closing it is a prerequisite for Prompt 10, not
optional cleanup.

**This gate now has an owner outside this programme.** A separate piece
of work — adding `court_allow` to the scheduling constraint vocabulary,
so an organiser can say "Priya plays on Court 2" — needs exactly the same
primitive: a **per-fixture domain restriction over (court, start)**.
CP-SAT already carries the per-fixture, per-court presence booleans it
would use (`model.py:337`), so enforcement is forcing the disallowed ones
to zero.

Build it once and both close. Do not build a narrower per-court-grid fix
here that the constraint work then has to widen — coordinate instead. The
constraint work also carries a product decision this programme does not
own: whether instruction rules stay **warn-only** (today's behaviour) or
become hard, because a hard placer turns boards that currently return
with a warning into `INFEASIBLE`.

That decision is tracked as **C0** and is filed as issue #497. **The
recommendation on record is soft, inserted as the NEW T1** — not, as an
earlier draft of #497's body said, a T4 below the existing chain. Below
the chain a rule loses to court balance, which is backwards:

```
T0  maximise placed          <- unchanged
T1  minimise rule violations <- new
T2  makespan          |
T3  worst idle gap    | existing chain, demoted
T4  court imbalance   |
```

Two reasons it must not be hard. `INFEASIBLE` is not where a too-tight
rule lands — `build.ts` falls back to **greedy** on any CP-SAT failure,
and greedy honours no rules at all, so one marginal rule costs the whole
optimised board and every other rule with it. And `INFEASIBLE` does not
say which rule broke, whereas a minimum-violation board names it for
free. Escape hatch if per-rule strictness is wanted later: a per-rule
`enforcement: "hard" | "soft"`, matching the existing
`crossPersonClash: "warn" | "hard"` (`schemas.ts:767`). Not designed now.

Tasks 01-04 were re-audited on 2026-08-09 at the owner's request (four
parallel Opus reviewers, mutation-first, one per task). Suite at that
point: 86 passed, 0 failed, exit 0.

### The cutover nearly shipped INERT, and no happy-path test could see it

Task 06's first pass wired `solveBuild` correctly and passed 8/8 new tests —
and on real boards it would have run **greedy, not CP-SAT**, on most of them.

`seedPinsOf`/`pinned` was ported unchanged from z3 and injected the greedy
seed's slots into the grid. Those slots are not grid-aligned, and they were
injected **asymmetrically across courts**. Obligation 5's uniform-grid check
then did its job perfectly: it saw a per-court grid, refused to send it, and
routed the board to greedy.

`seedPins` was built from the **entire greedy board, unconditionally** — not
just from pins. So the trigger is not "a board with pins": it is any
2+-court board whose greedy seed is not grid-aligned, pinned or not.
`build.test.ts:265` is a zero-pin case that failed before the fix.

Three things worth carrying:

- **Every one of the 8 new happy-path tests passed** while this was live.
  They were single-court or grid-aligned. A green cutover test says nothing
  about whether the new placer is being reached.
- The defect was found by **rewriting a pre-existing test that had been
  marked `.skip`**, not by reviewing the diff. Two independent reviews read
  this code and neither saw it.
- The first written account of it — including mine in the SDD ledger — said
  the blast radius was "every POLISH run and every BUILD with locked cards".
  That undersold it. The correction came from the re-review measuring it
  rather than repeating the report.

If a future change makes CP-SAT "stop being used", look here first: assert
`engine === "cp-sat"` on a multi-court board with a non-aligned seed.

### Owed after first deploy: re-measure `NUM_SEARCH_WORKERS`

It is **hardcoded at 8** in the Python source. The deploy shape is
`shared-cpu-2x` — 2 vCPU — so it is 4x oversubscribed, and Task 08's sizing
claim (`tiers_completed=2` guaranteed, T2/T3 best-effort) was reasoned
against a value of 4 that no longer exists in the code.

Recorded here rather than only in the SDD ledger because **two prior task
reports already recommended re-measuring it and nothing changed** — the
ledger is git-ignored, so a recommendation left there is invisible to a
fresh clone and to every subagent. It cannot be measured from a developer
box: the real machine shape is the only place the number means anything.

### Timing numbers on this box need a load reading beside them

The production-board tests are **proof-time** tests, not placement tests,
and they are the first thing to red under CPU contention. Measured on
2026-08-09 at load average 139 (sibling sessions running full vitest from
the main checkout): 7 failed. As load fell to ~12, with **no code
change**, the same suite went to 1 failed and `test_objective.py` to
19/19. Every failure carried `placed=37` of 37 — full placement, with
only `tiers_completed` truncating from 4 to 2.

So a red here is a moving target that tracks `uptime`, and it reads
exactly like a real regression. Record a load reading beside any timing
number, and never "fix" one of these by changing a timing constant.

## Parallel execution

Safe to run alongside the sibling `2026-08-07-datetime-ux-prompts/`
programme in a SEPARATE worktree/branch — file sets are disjoint except
a soft overlap in `apps/web/src/dictionaries/*/ui.json` (this programme
adds one `cp-sat` engine-label key via Prompt 06b; the other adds
blackout/court-removal keys) — a merge-time conflict at worst, not a
live-clobber risk, as long as each runs in its own worktree rather than
the same working directory. Do not run both in the same checkout
simultaneously.

## Owner decisions — settled, do not re-ask

| Decision | Answer |
|---|---|
| Framework | `grpcio` sync + bounded `ThreadPoolExecutor`, not `grpc.aio`, not Connect-RPC |
| Contract shape | Written as field tables in the design doc, `.proto` text is Task 01's own output — not pre-written before approval |
| REFLOW | Separate investigation, separate future cutover — not this program |
| z3 removal | Straight cutover, greenfield — no feature flag, no dual-run, z3 code deleted in Task 10 once verified live. BUILD/POLISH only; `repair.ts`/REFLOW's z3 untouched |
| Engine label rename | Add a new `"cp-sat"` value alongside existing `"z3"`/`"z3+lns"` (Task 06b) — do not remove the old ones yet, that's part of Task 10 |
| Status mapping | `UNKNOWN`→`not_searched`, `ERROR`→new `"solver_unavailable"` (not reusing `z3_unavailable`), `INFEASIBLE`→`infeasible` (Task 06b) |
| Deployment | Own Fly app, `min_machines_running=1` (always warm — cold start eats the wall budget), `lhr` region |
