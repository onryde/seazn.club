# Stream overlay — resume state

**Read this first.** It says what exists, what is decided, and the next
action in order. Planning is COMPLETE; implementation has not started and no
file under `apps/web`, `packages` or `db` has been touched by this programme.

Last updated: 2026-09-06, at the close of the session named "overlay".

## Where the work lives

- Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`,
  based on `997ad225b`. **Pushed to `origin`**, tracking set, working tree
  clean, nothing unpushed.
- 23 commits, every one documentation, all under `docs/superpowers/`.
- **No pull request, deliberately.** CI and smoke run on `pull_request`; e2e
  runs on `push` to `main`. A PR or a main push today would spend both on a
  change with no code in it. Open the PR when W1's code exists.
- The competition desk branch merged as **PR #708**, so W1's stated rebase
  blocker is already cleared.

## The documents, and what each is for

| File | Role |
|---|---|
| `../2026-09-05-stream-overlay-design.md` | design of record, owner-approved |
| `_INDEX.md` | decision log, owner rulings verbatim, false premises, both pinned-symbol tables (47 symbols) |
| `_RULES.md` | R1–R17 standing rules and the eight merge gates |
| `_THEMES.md` | every binding design value at native 1920×1080; §3 is theme `bar`, §4 is theme `bug` |
| `_OPEN-QUESTIONS.md` | sixteen questions, thirteen answered with the owner's own words |
| `W1-step-one.md`, `W2-moments.md` | the wave prompts (rulings; the plans hold the order) |
| `../../plans/2026-09-05-stream-overlay-w1.md` | W1 plan, 8 tasks plus Task 0 |
| `../../plans/2026-09-05-stream-overlay-w2-moments.md` | W2 plan, 6 tasks, blocked on spectator W1 |
| Canvas | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 |

## THE FIRST THING TO DO NEXT SESSION

**Task 0's Steps 2–13 in the W1 plan are marked SUPERSEDED and must be
rewritten before anyone executes them.** They describe adding fields to the
engine's `ScoreSummary`, changing football's `coarsen`, and regenerating four
golden corpora. All of that is unnecessary — see Q15, closed on evidence.
Replace those steps with an **overlay endpoint over `foldFixture`**
(`apps/web/src/server/engine-db/fold.ts:58`, returns the module's whole state
at `:130`): it reads football's `phase`/`periods`/`asOf` and cricket's
`legalBalls`/`ballsLimit` directly, uses the engine rather than changing it,
and touches nothing in `packages/engine`.

Two things that rewrite must carry:
1. `useLiveFixture` fetches `/api/v1/public/fixtures/${id}`
   (`live-score-data.ts:30`) and is shared with `LiveScore`, so the overlay
   needs that hook made generic over its fetcher, or a sibling hook.
2. Step 1, the venue time zone, is **not** superseded and stands as written
   (it rides on `getPublicFixture` via `resolveVenueTz`, no migration).

## Decisions, all made (owner's words in `_INDEX.md` and `_OPEN-QUESTIONS.md`)

- Both themes ship, and **themes are a REGISTRY**, not a two-value union: a
  new theme is one entry in `OVERLAY_THEMES` plus one component, with
  `resolveTheme` falling back to `defaultThemeFor(sportKey)` on an unknown or
  sport-unsuitable id. Cricket defaults to `bar`, every other sport to `bug`.
- The three payload fields go in. The cookie banner does not render on the
  overlay segment, and W1 proves the segment sets no cookies.
- Supabase realtime is the transport; the test org's override grants both
  `streaming.overlay` and `realtime`.
- Pricing is deferred; the hiding gate is the **per-organisation entitlement
  override**, chosen over a preview cookie and an environment flag.
- **One service**, with the overlay getting its own data path inside the app.
- `m.youtube.com` is allowed (eleven hosts). The panel toggle shows at every
  fixture status. The three-letter short code ships. Volleyball gains set and
  match point in W2. **Sponsor logos are their own wave, scheduled last.**
- The football clock ships in W1 and **ticks**: one 1 Hz phase-aware interval,
  re-anchored to the engine on every push. It is the only timer in the
  overlay and it survives `prefers-reduced-motion`, because it is information.

## Still open, none of them blocking

- **Q11** — W2's dependency on spectator W1 may land differently. Its plan
  carries a re-pin table with a named fallback per row. No decision needed.
- **Q12** — two unclassified reds in `pass-scoping-guard.test.ts`. Reproduce
  on a clean detached checkout of `997ad225b` BEFORE W1 starts, and never fix
  them inside this programme's PR.
- **Q13** — video embedded on our own match page. Its own spec later; it
  carries a stream-delay spoiler problem this design does not.

## Environment

- **The `ovl` database is torn down** (port 54405 confirmed free). Recreate in
  about thirteen seconds from this worktree:
  `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl`, then
  `eval "$(… env --label ovl)"`. It returns as
  `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
  DATABASE_SSL=disable` (the port derives from the label), schema V391 plus the
  sport catalog. Add `--server` for e2e and smoke, `--placement` before
  trusting `schedule-build-honours-locks.test.ts`.
- Worktree deps are installed and the engine resolves inside the worktree;
  `.env.local` is symlinked in the root and in `apps/web` with relative
  targets. A package the worktree does not hoist resolves from the MAIN
  checkout, so prove resolution with `require.resolve` if a dependency
  differs between branches.
- Shell guard in a worktree session: `/usr/bin/git` in separate plain calls,
  no heredocs, no `eval` or sourcing, Write tool for files, relative symlink
  targets, and `grep -a` because files report as binary.

## Baseline (apps/web vitest, fresh `ovl` DB, 2026-09-05)

13,962 passed of 14,041, 74 pending, every result path inside the worktree.
Five reds: three in `schedule-build-honours-locks.test.ts` (the placement
service was not running — the documented environmental signature) and two in
`pass-scoping-guard.test.ts` (unclassified, Q12). None touch W1's files.
A W1 gate compares against this baseline, not against zero.

## Then, in order

1. Rewrite Task 0's superseded steps as the overlay endpoint (above).
2. Reproduce Q12's two reds on a clean checkout so they are attributed right.
3. Recreate the `ovl` environment.
4. Run `superpowers:subagent-driven-development` on the W1 plan with Opus
   implementers and reviewers (`model:` passed per dispatch, owner
   instruction — this branch's agent frontmatter still reads `sonnet`).
5. Open the PR once code exists; rebase on `main` first; regenerate
   `i18n-keys.ts` after the rebase and require a zero diff; register the
   walkthrough capture spec in `WALKTHROUGH_SPECS` (it exists on `main` since
   PR #723, not on this branch); get an e2e run via `workflow_dispatch` with
   the `pr` input before merging.
6. W2 only after `feat/spectator-surface` W1 merges and every RE-PIN row in
   its plan is closed and recorded in `_INDEX.md`.
