# Stream overlay — resume state

**Read this first.** It says what exists, what is decided, and the next
action in order. Planning is being redone at programme scope; implementation
has not started and no file under `apps/web`, `packages` or `db` has been
touched by this programme.

Last updated: 2026-09-07, mid-session, after the programme design was written.

## Where the work lives

- Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`,
  **rebased 2026-09-07 onto `main` at `fb99bbd4c`** (24 docs-only commits
  carried clean). The previous directory at that path was an unregistered
  residue and was moved to `.claude/worktrees/stream-overlay.stale-20260907`;
  the worktree was re-added from the branch. **Not yet pushed since the
  rebase** (a force-push is required; the branch has no PR).
- Every commit is documentation, all under `docs/superpowers/`.
- **No pull request, deliberately.** CI and smoke run on `pull_request`; e2e
  runs on `push` to `main`. Open the PR when code exists.
- Deltas on `main` run to `V399__stats_player_career_split.sql`; this
  programme takes V400 / V401 / V402 and re-checks `ls db/migration/deltas |
  sort -V | tail` after every rebase.

## The documents, and what each is for

| File | Role |
|---|---|
| `../2026-09-07-streaming-programme-design.md` | **design of record** (owner-approved 2026-09-07): Tier A rewritten in, T1, credits, Tier B, compositor, R0, testing, plan structure, findings |
| `../2026-09-05-stream-overlay-design.md` | superseded; kept for the canvas links and the approval record |
| `_INDEX.md` | decision log, owner rulings verbatim (1–22), false premises, both pinned-symbol tables, the 2026-09-07 section |
| `_RULES.md` | R1–R17 standing rules and the eight merge gates |
| `_THEMES.md` | binding values at 1920×1080; §3 `bar`, §4 `bug`; T1a adds §4a slate, §8a Phone tab, §8b credits card, decided/void rows |
| `_OPEN-QUESTIONS.md` | the 2026-09-05/06 questions and answers; the design's §12 holds today's open set |
| `W1-step-one.md`, `W2-moments.md` | the wave prompts (corrected in place by the plan's Task 0) |
| `../../plans/2026-09-05-stream-overlay-w1.md` | W1 plan, executes as corrected (Task 0 Steps 2–13 → the overlay endpoint) |
| `../../plans/2026-09-05-stream-overlay-w2-moments.md` | W2 plan, blocked on spectator W1 |
| `../../plans/2026-09-07-streaming-programme.md` | the programme plan — **being written next** by `writing-plans` |
| `docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)" | the owner's checklist; every task's acceptance names its rows |
| Canvas | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 |

## THE FIRST THING TO DO NEXT SESSION

1. If `../../plans/2026-09-07-streaming-programme.md` does not exist: run
   `superpowers:writing-plans` from the design (§11 is the task list). Do not
   re-brainstorm; every decision is in the design and in `_INDEX.md` rulings
   18–22.
2. If it exists: execute its Task 0 (corpus corrections in place, migration
   renumbering, Q12 reproduction), then T1 and W1-A/W1-B in parallel, per
   `superpowers:subagent-driven-development` with `model: opus` per dispatch
   (owner instruction; the agent frontmatter reads `sonnet`).
3. Force-push the rebased branch (`/usr/bin/git push --force-with-lease`).

## Decisions, all made (owner's words in `_INDEX.md`)

- Shape: one design of record, one programme plan (ruling 18).
- Two keys, corpus names kept: `streaming.overlay` (Pro, Enterprise, Event
  Pass L) and `streaming.relay` (same split, "may buy credits").
- Per-match credits in packs of 1 / 5 / 20, a ledger, consumed at `live`,
  bought from the stream panel's Phone tab through Stripe Checkout (sandbox
  placeholders £6 / £25 / £80; real prices before GA).
- Runner: Fly Machines only, one per session, `lhr`, `auto_destroy`.
- Front door: Cloudflare Stream. Compositor self-mints realtime as a producer.
- T1 wave (theme design + visual gate) runs ahead of W1-C.
- Everything from 2026-09-05/06 still stands: themes are a registry; eleven
  hosts; overlay endpoint over `foldFixture`; football clock ticks and
  survives reduced-motion; panel toggle at every status; cookie banner off the
  overlay segment (now known to need building — FS1); sponsors last; W2 after
  spectator W1.

## Still open, none of them blocking

Design §12: real prices, passthrough half-credit, Enterprise monthly bundle,
Vault vs envelope, YouTube fresh-channel copy, per-destination VOD, mic
default (R3). Q11–Q13 from the earlier set stand as recorded.

## Environment

- No `ovl` database or server is up. Recreate from this worktree:
  `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl`, then
  `eval "$(… env --label ovl)"` → `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
  DATABASE_SSL=disable`. Add `--server` for e2e and smoke, `--placement`
  before trusting `schedule-build-honours-locks.test.ts`.
- The re-added worktree has **no `node_modules` and no `.env.local`
  symlinks** yet: `pnpm install --frozen-lockfile` and relative symlinks in
  the root and in `apps/web` before any verify command. A package the
  worktree does not hoist resolves from the MAIN checkout — prove resolution
  with `require.resolve` if a dependency differs between branches.
- Shell guard: `/usr/bin/git` in plain calls, no heredocs, no `eval` or
  sourcing, Write tool for files, `grep -a`.

## Baseline (apps/web vitest, fresh `ovl` DB, 2026-09-05, at `997ad22`)

13,962 passed of 14,041, 74 pending. Five reds: three placement-service
environmental, two `pass-scoping-guard.test.ts` unclassified (Q12). **Stale
after the rebase** — Task 0 re-baselines on `fb99bbd4c` and attributes Q12's
reds on a clean detached checkout before any wave starts.
