# C9 — decomposed repair on CP-SAT

Spec of record: `../2026-08-12-z3-retirement-design.md` (closes the gap C5's
bench opened). Gate: **C5 merged**, and **strictly before C8** — see
"Sequencing" below, this is not optional ordering.

## Why this exists

C5's own bench (`packages/engine/scripts/bench-ai-repair-cpsat.ts`, N=6/side,
real placement service) measured a real regression at high violator density:

| density | OLD (`repairDecomposed`/z3) | NEW (`buildSchedule`/CP-SAT) |
|---|---|---|
| 10 free / 30 fixtures (~33%) | 2167–2557 ms, 0 blocking | 433–817 ms, 0 blocking |
| 24 free / 40 fixtures (~60%) | 7821–8891 ms, 0 blocking | 44643–45636 ms (budget exhausted), **24 blocking** |

The high-density arm ran with `PLACEMENT_WALL_SECONDS_MAX=60` server-side, so
the service's own 10 s default is ruled out as the cause. CP-SAT does not
reliably solve a dense violator set as ONE monolithic call; `buildSchedule`
falls back to its internal greedy, which does not avoid the injected clashes.
z3 handles the identical board in <9 s at 0 conflicts **because it decomposes
first** — 40-ish independent components of ~35 fixtures each, not one 40-card
solve.

C5 shipped this as an accepted risk, correctly: `solveBoard` re-verifies with
the real `validateAssignments` regardless of what `buildSchedule.status`
claims, and the caller's adoption gate (`afterBlocking.length <
blocking.length`) never adopts a degraded board — it falls through to LLM
repair exactly as if the solver had declined. So today's cost is **wasted
solver budget and latency, never a corrupted board an organiser can see.**
C9 recovers the capability.

## The premise correction this task rests on

C5's PR body says re-introducing decomposition "would reverse this task's own
premise (retiring z3's decomposition machinery)." **That is not accurate, and
this brief supersedes it.** Verified by reading `repair-decompose.ts` end to
end: the decomposition is not z3 machinery. Exactly ONE line in the whole file
touches z3's solver — the per-component `repairSchedule()` call at `:488`
(plus its mandatory `resetZ3()` at `:516`, a WASM-heap workaround with no
CP-SAT analogue).

Solver-agnostic and reusable AS IS — do not rewrite these:

- `repairComponents()` (`repair-decompose.ts:280-328`) — the graph itself.
  Union-find over "same court, or shares an entrant/person, within
  `maxSeparationMinutes(config)`" plus an edge per order dependency, via a
  time-sorted sweep (not O(n²)). Pure TS over `Assignment[]`/`VerifyConfig`.
  Deterministic by contract: fixtures id-sorted, components ordered by
  smallest id.
- `dayCapGuard()` (`:353-362`) — decides when freezing is UNSAFE
  (`max_fixtures_per_day` present AND some proposal fixture missing from
  `config.ruleFixtures`), returning `whole_board` mode. Read its docstring
  before touching it; it documents a real encoder/verifier unit mismatch.
- `disjointConflictBound()` (`repair-minimality.ts`) — the independent-set
  lower bound behind an honest `"proved"` verdict.

## Goal

A decomposed repair driver whose per-component solve is `buildSchedule`
(placement CP-SAT), not `repairSchedule` (z3), wired into the AI repair round
in place of C5's single monolithic `buildSchedule` call.

Freeze semantics are already proven twice in this programme and must not be
re-derived: `frozen = caller's own immovables ∪ every OTHER component at its
current placement` (`repair-decompose.ts:464-467` already computes exactly
this list) fed through `buildSchedule`'s `frozen`/`current` pins — C4's
`reflowExisting` and C5's `solveBoard` are both working precedents.

Expected free win, and the reason it is worth doing beyond latency: honest
`minimality` becomes reportable again. `disjointConflictBound` never touched
z3, so the `data-minimality="proved"` claim C5 had to drop from
`ai-architect.spec.ts:1173` is recoverable. Treat it as an expected outcome to
VERIFY, not an assumption — and if the certificate does not hold on the CP-SAT
path, say so and leave `"unknown"` rather than reporting a claim nothing
proves.

## Context that saves you a dead end

- **Do NOT reuse C5's tuning constants.** `COMPONENT_MOVABLE_LIMIT = 50`
  (`:100`) and `DEFAULT_COMPONENT_BUDGET_MS = 20_000` (`:111`) were read off
  z3's measured WASM curve ("40 movable 8.2 s, 60 movable 43.8 s, 80 never
  returns"). Those numbers say nothing about CP-SAT. Re-measure both, and
  state the new curve in the PR the way `repair-decompose.ts:26-32` states
  the old one.
- **Sequential first, parallel NOT in this task.** A remote gRPC call per
  component looks trivially parallelisable, but `build.ts:1196` still wraps
  EVERY `buildSchedule` call in the process-wide `withZ3LockAndReset` mutex.
  Its own comment (`:1178-1195`) admits the lock "buys this call NOTHING
  correctness-wise" on the placement path but was deliberately left because
  removing it is cross-cutting (REFLOW takes the same lock) and "the
  throughput cost is unmeasured, not merely asserted." Ship sequential —
  matching today's behaviour exactly. Parallel dispatch is a separate,
  benched task that must first settle the lock question.
- **`resetZ3()` (`:516`) has no CP-SAT analogue — drop it, do not port it.**
  It exists for a WASM heap that only grows. The placement path shares no
  heap. Keep it in whatever z3 driver survives until C8.
- **The repair bench omits hard rules (#455)** and an identical `k` is the
  tell. Gate on verifier conflict counts, never on the bench number alone —
  same instruction C5 was given and honoured.
- `repairDecomposed`'s two contract properties are load-bearing and must
  survive the port: **anytime** (each component commits independently, a
  budget that runs out yields a PARTLY repaired board that is still put
  through the real verifier) and **honest minimality** (restricting what may
  move can only RAISE `k`, so it is an upper bound unless a certificate meets
  it). Read `repair-decompose.ts:46-55`.
- C5's `solveBoard` already found and fixed a subtlety you will meet again:
  `unresolvedFixtureIds` must count both "still blocking" AND "dropped from
  the board entirely" — `validateAssignments` iterates the rows it is handed
  and cannot report an absence.

## Sequencing — this is a C8 blocker, not a nice-to-have

After C5, `repairDecomposed` has **zero production callers** (verified: only
`bench-decompose.ts`, `bench-ai-repair-cpsat.ts`, and its own tests import
it). C8's file set is "z3 reflow/repair code paths, their env flags, their
tests" — which deletes `repair-decompose.ts` wholesale, graph and lower-bound
math included. **If C9 does not land before C8, the reusable half is deleted
and this capability has to be rewritten from scratch later.** Update C8's
brief as part of this task so it deletes only the z3 driver, never the graph.

C9 does NOT depend on C6 or C7 and does not block them.

## File set

- `packages/engine/src/scheduling/` — the decomposed CP-SAT driver. Decide and
  JUSTIFY in the PR whether it belongs in `repair-decompose.ts` alongside the
  z3 driver (shared graph, two drivers, one file until C8 removes the other)
  or in its own module. Either is defensible; an unexplained choice is not.
- `apps/web/src/server/usecases/schedule-ai-solver.ts` — `solveBoard` calls
  the decomposed driver instead of a single `buildSchedule`.
- `packages/engine/scripts/bench-ai-repair-cpsat.ts` — extend with a third
  arm (decomposed CP-SAT) at BOTH existing densities, so the three-way
  comparison is in one table.
- `docs/superpowers/specs/2026-08-12-release2-prompts/C8-z3-delete-solver.md`
  — narrow its file set per "Sequencing" above.
- Tests for all of the above.

## Do NOT touch

REFLOW (C4's; a decomposed REFLOW is a separate question — note it, do not do
it), public wire schemas (C7 owns narrowing; `"optimized"` already exists from
C5 and is the correct value here too), the LLM repair path, credit/billing
accounting, `withZ3LockAndReset` itself (see above), the z3 driver's own
behaviour (it stays compiling until C8).

## Acceptance

- **The C5 regression is closed, measured:** the 24 free / 40 fixtures
  scenario at ~60% violator density returns **0 blocking conflicts**, N ≥ 6,
  against a real local placement service. This is the whole point of the
  task — a PASS here is the gate, and a partial improvement is a finding to
  report, not a pass to claim.
- **No moderate-density regression:** the 10/30 scenario stays at 0 blocking
  and does not get materially slower than C5's 433–817 ms. Decomposition
  overhead on an easy board must not cost more than it saves.
- Component-limit and per-component-budget constants are backed by a MEASURED
  CP-SAT curve pasted in the PR, not inherited from z3's.
- Anytime property proven by test: a deliberately short budget yields a
  partly-repaired board that the real verifier accepts — never a throw, never
  an unverified return.
- Minimality: either `"proved"` is reported AND a test proves the certificate
  is real (mutation-check the bound), or the PR states plainly why it cannot
  be and leaves `"unknown"`.
- A regression test that fails without the decomposition — i.e. reds against
  C5's monolithic path on a dense board.
- AI generate → refine → repair e2e loop green (`ai-architect.spec.ts`, real
  prod build, all three named specs).
- C8's brief updated so the graph and `repair-minimality.ts` survive it.

## Verify

Full suites via JSON reporter (raw counts, `numPassedTests`/`numTotalTests`),
fresh DB, real placement service. Prod build + `E2E_PROD_TARGET` for e2e.
Three-way bench table (z3-decomposed / CP-SAT-monolithic / CP-SAT-decomposed)
at both densities in the PR body, N ≥ 6 per cell.
