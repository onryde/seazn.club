# Stream overlay — resume state

Read this first in a fresh session. It says what exists, what was in flight
when the last session stopped, and the next action in order. Update it at
every stop; it is the handoff, the index is the record.

Last updated: 2026-09-05 18:35 BST (session "overlay", branch
`feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`).

## Where the work lives

Branch `feat/stream-overlay` is **pushed to `origin`** (2026-09-06, head
`96a487d31`), tracking set. **No pull request yet, deliberately**: the branch
is documentation only (13 commits, 10 files, all under `docs/superpowers/`),
and the repo's CI runs on `pull_request` while e2e runs on `push` to `main`,
so a PR now would spend CI minutes on a change with no code to test. Open the
PR when W1's code lands.

The competition desk branch merged as **PR #708**, so W1's stated rebase
blocker is cleared.

## What exists and is committed

| Artefact | Path | Commit |
|---|---|---|
| Design spec (owner-approved: "I am ok with design", "approve") | `docs/superpowers/specs/2026-09-05-stream-overlay-design.md` | `0781ba76d`, motion `9ad0b9902`, premise fixes `852c817f3` |
| Programme index (rulings, base-commit health, two pinned-symbol tables) | `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` | `852c817f3`, `2a1da7581`, `2ed315259` |
| Design themes sheet (binding values, 1920×1080) | `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` | `0106f4d50` |
| Canvas (two directions, sport sheets, moments, phone test, panel) | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 | published |

## Both wave plans are written (2026-09-05 23:4x BST)

| Wave | Plan | Size | State |
|---|---|---|---|
| W1 | `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` | 3475 lines, 8 tasks, 80 steps | committed `c303435a1`; no placeholders, no empty test bodies, 26 `_THEMES.md` citations. Ready to execute once the desk branch merges. |
| W2 | `docs/superpowers/plans/2026-09-05-stream-overlay-w2-moments.md` | 1083 lines, 6 tasks | committed `f491867a7`; NOT executable until its RE-PIN rows close and its comment-sketched Task 1 test bodies are written out. |

**Eight W1 deviations the planner recorded, each a decision to keep or
reverse (they are argued in the plan; four need an owner answer):**

1. `useLiveFixture` returns `{ data, live, subscribed, refresh }` — `LiveScore`
   renders `subscribed` at `live-score.tsx:148`, so a bare payload would
   change its render. Keep.
2. `msg` is typed `OverlayMsg` (plain string key), not `MsgFn` — `MessageKey`
   is `keyof ui.json` (`lib/messages.ts:12`), so every `public.overlay.*` key
   would fail tsc. Keep.
3. `overlayModel` takes a fourth input `decidedTemplates`, because `result`
   must come from `renderDecidedOutcome`, the one decided-sentence authority.
   Keep.
4. **Start time formats in UTC**, server-side, because no public venue zone
   exists on the payload. The competition-desk programme's "one zone per
   fixture" ruling says a time belongs in the venue's zone. OWNER QUESTION:
   accept UTC for W1, or add the zone to the public payload first.
5. `detail` drops the discipline `person` name in W1; consent resolution is
   W2's rule. Keep.
6. Cricket chase reads "Need 45", not "Need 45 off 45" — `ballsLimit` is not
   on the public payload. OWNER QUESTION: accept the shorter line, or extend
   the payload. `_THEMES.md` §3 shows the longer form.
7. The overlay e2e lives under `e2e/walkthrough/` (R9), not the path W2's
   plan names. W1 wins; W2 re-points at execution.
8. `.ovl-*` CSS lives in `globals.css`, because the panel preview mounts
   `OverlayStage` outside the overlay layout. One extra file is touched:
   `cookie-consent.tsx` gains a `data-testid` so the banner can be
   suppressed — OBS would otherwise put the cookie banner on air. Keep.

**Symbols that stayed unpinned:** football's match clock (no field on
`ScoreSummary.detail`; `lib/public-site.ts:319-373` is the complete reader
set), so `header.clock` is undefined for football until the payload carries
it — `_THEMES.md` §3 and §4 show a clock, so either the payload grows or the
football bar ships without it (OWNER QUESTION). Entrant short name does not
exist (`public_entrants_v`, `V350:18-47`, has `display_name` and
`team_display` only), so watch-list item 6 resolves to the three-letter
fallback. Each sport's opener event for the capture spec is marked re-pin.

## What was in flight at the last stop

Three Fable subagents, dispatched 2026-09-05 ~18:10–18:20 BST, owner
deadline 18:58 BST ("try to complete all subagent in 25 mins, otherwise
commit and record everything"). Two finished inside the clock; the third
(W1 plan) hit the account's Fable session limit. Commit trailers from that
point on read `Claude Opus 5 (1M context)`:

| Deliverable | Path | State at last update |
|---|---|---|
| Wave 1 plan | `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` | not yet on disk. The Fable writer died at 18:5x BST on a session rate limit (resets 23:00 Europe/London) having written nothing. The owner then switched the session model to Opus 5 and ruled "Use Opus as a SubAgent to write the implementation plan where it left instead of starting from beginning", so the EARLIER Opus planner (which had finished pinning and was about to write when it was stopped) was RESUMED with its context intact, re-pointed at this path and at `_THEMES.md` / `_RULES.md` / `W1-step-one.md`. If it is gone when you resume, dispatch one Opus planner from those three files plus `_INDEX.md`'s symbol tables — never re-scout what is already pinned. |
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
- **The `ovl` database is TORN DOWN** (2026-09-06, `seazn-env down --label
  ovl`, port 54405 confirmed free). It was removed on purpose once the
  baseline below was recorded and implementation was deferred; this repo does
  not keep standing environments. Recreate it in about thirteen seconds when
  W1 starts: `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label
  ovl` from this worktree, then `eval "$(… env --label ovl)"`. It comes back
  as `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
  DATABASE_SSL=disable` (the port is derived from the label, so it is stable),
  schema V391 plus the sport catalog. Add `--server` for e2e and smoke, and
  `--placement` before trusting `schedule-build-honours-locks.test.ts`.
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

**Implementation is deliberately NOT started.** Owner, 2026-09-05: "Let's do
implementation later on, just note down all open questions and raise." The
planning phase is complete and committed; nothing in `apps/web`, `packages`
or `db` has been touched by this programme.

1. Owner answers `_OPEN-QUESTIONS.md`. Q1–Q4 change what a viewer sees and
   should be answered before W1 starts; Q5–Q9 can be answered during W1;
   Q10–Q13 are W2 or later. Each answer moves to `_INDEX.md`'s decision log
   with the date and the owner's own words, and is struck through in the
   questions file.
2. Fold the answers into the spec and the W1 plan (a payload extension from
   Q1 becomes a new first task; Q2 becomes a step in the overlay-route task).
3. Then, and only then, run `superpowers:subagent-driven-development` on the
   W1 plan with Opus implementers and reviewers (`model:` passed per
   dispatch, owner instruction). W2 waits for `feat/spectator-surface` W1 to
   merge and its RE-PIN rows to close.
4. Before W1 starts, reproduce `pass-scoping-guard.test.ts` on a clean
   detached checkout of `997ad225b` (Q12) so its two reds are attributed
   correctly.
5. PR1 rebases after `feat/fixture-console-redesign` merges; register the
   walkthrough spec in `WALKTHROUGH_SPECS`; regenerate `i18n-keys.ts` post
   rebase and require zero diff; e2e via `workflow_dispatch pr=<n>` before
   merge; main's walkthrough leg must be green (base-commit note in the index).
