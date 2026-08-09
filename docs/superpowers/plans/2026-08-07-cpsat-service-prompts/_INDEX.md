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
01-03) → 05 (TS client, needs 01) → 06 (wire build.ts, needs 04 deployed
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

| # | Prompt | State |
|---|---|---|
| 01 | Proto contract | **complete** — `0c8eb752..e854b978`, review clean |
| 02 | BUILD model (promote from bench) | **complete** — `e854b978..eee3a590`, clean after 2 fix rounds |
| 03 | T0-T3 objective chain | **complete** — `eee3a590..f64235e6`, clean after 1 fix round |
| 04 | gRPC server (auth, health, mapping) | **complete** — `f64235e6..f19605a6`, clean after 1 fix round |
| 05 | TS codegen + client wrapper | in progress — codegen + tests done, client wrapper landing |
| 06 | Wire `solveBuild` in `build.ts` | not started — **blocked on the 4 wire-contract gaps** parked in the ledger; the day-cap timezone one must not ship past this task |
| 06b | Status vocabulary translation | not started |
| 07 | Integration tests (parity, regression, fallback) | not started |
| 11 | E2E + smoke coverage | not started — prompt not yet drafted |
| 08 | Deployment (Dockerfile, fly.toml) | not started |
| 09 | CI workflow | not started |
| 10 | Remove BUILD/POLISH's z3 code | **blocked** — do not start until 01-09 and 11 are live in production for one full deploy cycle |

Tasks 01-04 were re-audited on 2026-08-09 at the owner's request (four
parallel Opus reviewers, mutation-first, one per task). Suite at that
point: 86 passed, 0 failed, exit 0.

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
