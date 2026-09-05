# Stream overlay — resume state

Read this first in a fresh session. It says what exists, what was in flight
when the last session stopped, and the next action in order. Update it at
every stop; it is the handoff, the index is the record.

Last updated: 2026-09-05 18:35 BST (session "overlay", branch
`feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`).

## What exists and is committed

| Artefact | Path | Commit |
|---|---|---|
| Design spec (owner-approved: "I am ok with design", "approve") | `docs/superpowers/specs/2026-09-05-stream-overlay-design.md` | `0781ba76d`, motion `9ad0b9902`, premise fixes `852c817f3` |
| Programme index (rulings, base-commit health, two pinned-symbol tables) | `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` | `852c817f3`, `2a1da7581`, `2ed315259` |
| Design themes sheet (binding values, 1920×1080) | `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` | `0106f4d50` |
| Canvas (two directions, sport sheets, moments, phone test, panel) | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 | published |

## What was in flight at the last stop

Three Fable subagents, dispatched 2026-09-05 ~18:10–18:20 BST, owner
deadline 18:58 BST ("try to complete all subagent in 25 mins, otherwise
commit and record everything"):

| Deliverable | Path | State at last update |
|---|---|---|
| Wave 1 plan | `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` | not yet on disk |
| Wave 2 plan (moments) | `docs/superpowers/plans/2026-09-05-stream-overlay-w2-moments.md` | landed 18:44 BST, 1083 lines, 6 tasks, committed; carries a "NOT executable yet" status note: Task 1 test bodies are comment-sketched pending the RE-PIN table (task zero rewrites them); blocked on spectator W1 merge |
| Prompt dir: `_RULES.md`, `W1-step-one.md`, `W2-moments.md` | same dir as this file | on disk, uncommitted at 18:33; committed if a later row below says so |
| Prompt dir: reshaped `_INDEX.md` | same dir | not yet rewritten (18:16 version is the committed one) |

If a plan file is missing when you resume: re-dispatch ONE Fable planner per
missing plan from the spec, `_INDEX.md` (pinned symbols), `_THEMES.md` and
the matching `W*-*.md` prompt file. Do not re-brainstorm, do not re-scout
what the index already pins. Owner instruction: "Start the subagent where
it left instead of starting from the beginning."

If a plan file exists but was never self-reviewed: run the writing-plans
self-review (spec coverage, placeholder scan, type consistency) and add
these two items if absent — Task 8 registers the walkthrough capture spec in
`WALKTHROUGH_SPECS` after the rebase (the inventory landed on main in PR #723,
`01ea4a455`, after this branch's base `997ad225b`, so it is absent here);
overlay tasks cite `_THEMES.md` sections instead of restating values.

## Environment

- Worktree deps installed (`pnpm install --frozen-lockfile`, engine resolves
  inside the worktree); `.env.local` symlinked in root and `apps/web`
  (relative targets).
- Postgres under seazn-env label `ovl`: `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
  DATABASE_SSL=disable`, schema V391 + sport catalog. `seazn-env status`
  shows it; `seazn-env down --label ovl` removes it. No prod server yet
  (`up --label ovl --server` when e2e starts).
- Baseline `apps/web` vitest against that DB: see "Baseline" below.
- Shell guard in a worktree session: `/usr/bin/git` in separate plain calls,
  no heredocs, no `eval`/sourcing, Write tool for files, no absolute paths
  into the main checkout (relative symlink targets).

## Baseline (apps/web vitest on the fresh `ovl` DB, 2026-09-05)

Filled in by the session that ran it; if empty, run
`cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl DATABASE_SSL=disable npx vitest run --reporter=json --outputFile=<file>`
and record `numPassedTests/numTotalTests`, failing suites, and whether each
red is environmental (AGENTS.md "Verification traps", seazn-local-env §5).

Run 2026-09-05 18:20–18:33 BST, JSON reporter, every `testResults[].name`
under the worktree (0 outside):

| Metric | Value |
|---|---|
| total tests | 14041 |
| passed | 13962 |
| failed | 5 |
| pending | 74 |
| failed suites | 2 files (`numFailedTestSuites` reported 7, counting nested blocks) |

- `apps/web/src/server/usecases/__tests__/schedule-build-honours-locks.test.ts`
  (3 reds): the CP-SAT placement service was not running for this label —
  the documented environmental signature (seazn-local-env §3b, §5). Start it
  with `seazn-env up --label ovl --placement` before trusting it, and run
  that gate both with and without the service.
- `apps/web/src/lib/__tests__/pass-scoping-guard.test.ts` (1–2 reds): "Event
  Pass grants are resolved with a competition in scope … has no enforcement
  site". A repo-scanning guard. Not classified at the time of writing:
  reproduce on a detached checkout of `997ad225b` before calling it
  pre-existing, and never fix it inside this programme's PR.
- The 74 pending are the usual `HAS_DB` / service skips; unchanged `total`
  with a moving `pending` is the trap to watch (seazn-local-env §2).

Nothing in this baseline touches files W1 changes.

Caveat on the runner: the failure stack shows `@vitest/runner` loaded from
`/Users/ashokhein/github/seazn.club/node_modules/…` (the MAIN checkout) even
though `apps/web/node_modules/.bin/vitest` and `@seazn/engine` resolve inside
the worktree. Cause: this worktree sits INSIDE the main checkout's directory,
so Node's parent-directory walk reaches main's `node_modules` for any package
the worktree's pnpm layout does not hoist to its root. Same lockfile, same
version, code under test is the worktree's — but any package missing from
the worktree resolves silently from main. Before trusting a run that depends
on a changed dependency, check `readlink -f` for that package.

Prompt-dir files `_RULES.md`, `W1-step-one.md`, `W2-moments.md` and this
file were committed as `a7bcd50a3` at 18:35 BST; the reshaped `_INDEX.md`
follows in its own commit once the writer finishes.

## Next actions, in order

1. Commit whatever prompt-dir files are on disk (`_RULES.md`, `W1-step-one.md`,
   `W2-moments.md`, reshaped `_INDEX.md`).
2. Land or re-dispatch the two plans; self-review; commit.
3. Add `_THEMES.md` pointers to `W1-step-one.md`, `W2-moments.md`, `_RULES.md`
   and both plans if the writers did not.
4. Owner pre-approved execution ("approve the plan now"): run
   `superpowers:subagent-driven-development` on the W1 plan with Fable or Opus
   implementers and reviewers (`model:` passed per dispatch, owner
   instruction). W2 waits for `feat/spectator-surface` W1 to merge.
5. PR1 rebases after `feat/fixture-console-redesign` merges; register the
   walkthrough spec in `WALKTHROUGH_SPECS`; regenerate `i18n-keys.ts` post
   rebase and require zero diff; e2e via `workflow_dispatch pr=<n>` before
   merge; main's walkthrough leg must be green (base-commit note in the index).
