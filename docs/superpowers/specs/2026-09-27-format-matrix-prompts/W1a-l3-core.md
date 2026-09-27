# W1a — L3 core: the lean HTTP runner

**Goal.** When this wave is done an organiser gets nothing on screen yet — but
the programme gets its first instrument: a lean runner that creates a real
competition on a real prod server, drives it through its whole lifecycle over
HTTP, checks the §7.3 invariants after every step and writes JSON that
generates `MATRIX.md`. Proven on a vertical slice (league, knockout, swiss ×
generic, badminton), with stream generators for all 11 sports so every later
wave can add rows without new plumbing.

## Read first

- `_RULES.md` (all of it; R3, R10, R13, R14, R14a, R25 bite here) and `_INDEX.md`
  (owner rulings 15, 17, 18, 21).
- Design `../2026-09-27-format-matrix-design.md` §3 (rows, sports, cells,
  entitlements), §6.1 (drivers, generators, seeding, API traps), §6.4, §7.3,
  §7.3a, §8 (W1a row), §9.
- Plan: `../../plans/2026-09-27-format-matrix-w1a.md` — **if present** (it is
  being written; if absent, write it with `writing-plans` first).
- Audits: `audit-2026-09-27/plan-facts-bench.md` (§0 headline facts, §3
  exported helpers), `plan-facts-api.md` (§0 wire rules, §C, §D),
  `plan-facts-sports.md` (per-sport finalize sequences, "Harness cautions"),
  `plan-facts-repo.md` (§2, §6), `bench-reuse.md` §5, `offered-matrix.md`.

## Prerequisites

None — W1a is first (design §8 order, R1). Own worktree off `main`.

## Scope

- Lean runner of its own reusing only the bench's small helpers (HTTP client,
  magic-link auth, plan provisioning); **`run-suite.ts` and PackSchema are not
  touched or imported** (ruling 17, R3).
- `HttpDriver` implementing the `OrganiserDriver` interface (§6.1); org/plan
  seeding in the harness DB (bench `setPlan` precedent); sign-in once per worker.
- Stream generators for all 11 sports: minimal legal sequence per outcome (win,
  draw where allowed, walkover/retirement via `core.forfeit`, abandon).
- Per-round generation for swiss / mexicano / ladder.
- §7.3 invariants with their preconditions; JSON results; `MATRIX.md` generator.
- **Routed gaps: none.** This is a harness wave. Reds it finds are recorded, not
  fixed — they go to W1d's triage.

## Lifecycle

No rulebook step (harness wave) and no reference-model step. Use §10 steps 4,
5 and 7 only: plan → implementer → reviewer, TDD, gates, drive before claiming.

## Decisions owed

None from §11. O1 and O2 are already owner rulings (20, 15) — obey, do not
reopen. If the vertical slice forces a harness-shape question, put it to the
owner as a recommendation with its owner value (R6); never decide it silently.

## Done when

- The vertical slice (4 cells × default config) runs end to end on a fresh DB
  with `sync:sports` and produces JSON + a generated `MATRIX.md` (never
  hand-edited, R10).
- Every invariant reports a non-zero checked count on the slice; a mutated
  invariant (`return true`) and a mutated generator each produce a red (R17, R25).
- Stream generators produce a legal minimal stream for each of the 11 sports,
  proven by posting it to the real server, not by a unit fixture (R15).
- No existing suite is red that was green before (ruling 19 (b)); CI green;
  reviewer loop closed.

## Traps

1. **The bench does not simulate events** — it replays recorded pack streams
   (`plan-facts-bench.md` §0.1). Generators are new work; do not "borrow" a
   pack stream and call it a generator.
2. **Plan provisioning is buried in the DLS-gate probe** (`dls-gate.ts:964`);
   call `provisionPlan` directly. It is raw SQL plus an admin cache bust — and a
   prod build needs `AUTH_DEV_LINKS=1` or magic-link sign-in has no `login_url`.
3. **The API lies in quiet ways:** scoring before Start is 422 `WRONG_PHASE`;
   `/complete` on an unfinished stage is `200 {completed:false}`; a repeated
   `/complete` mints a new draft seed proposal (fixed only in W5) — the driver
   must be idempotent by construction. Sides are entrant IDs, never home/away;
   always send `core.start` first; `period.advance.to` must be the exact next label.
4. **An empty generate is a failure, not "up to date"** (SW-H1, R13). The Swiss
   desk literally says "Nothing new to generate — fixtures are up to date" over
   an empty round.
5. **Strip-types cannot synthesize enums**: a script import graph that reaches
   `packages/engine/src/scheduling/generated/scheduler.ts` crashes at load and
   vitest does not catch it (`plan-facts-repo.md` §6). Script tests are also
   excluded from typecheck (`tsconfig.scripts.json`).

## Output and handoff

Update the W1a row in `_INDEX.md` Status and add decision-log lines **as they
happen** (R22) — slice counts, generator coverage, anything that surprised you.
An audit gap the slice fails to reproduce goes to "False premises found". Keep
your own recommendations out of "Owner rulings".
