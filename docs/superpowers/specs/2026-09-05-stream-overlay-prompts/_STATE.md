# Stream overlay — resume state

**Read this first.** It says what exists, what is decided, and the next
action in order. Planning is being redone at programme scope; implementation
has not started and no file under `apps/web`, `packages` or `db` has been
touched by this programme.

Last updated: 2026-09-08, planning complete and merged to `main`.

## 2026-09-08 — where things stand (read this block, then the tables)

- **Planning is COMPLETE and ON MAIN.** Owner approved the design
  ("approve") and ruled "push to main": merge commit `b2244879f` carried the
  spec, the four wave prompts, the re-pinned W1/W2 prompts and the
  `RULES.md` owner checklist. The T1 plan + W1 amendment (`c8dc4d07f`) and
  the plan review follow in a second merge.
- **Shareable spec page:** https://claude.ai/code/artifact/b7e7d0c8-e254-4d6e-80f0-161681ae797a
  (rebuilt from the spec by `scratchpad/build-spec-page.mjs`; republish
  after any spec change).
- **`main` moved under us on 2026-09-08:** desk W3 (#740) and settings W8
  (#744) merged. Consequences recorded in the spec's findings: FS14 —
  `run-sheet-edit-time` is now `desk/run-sheet-row.tsx:407` (was `:377`;
  the symbol is the authority). Deltas still end at `V399`.
- **2026-09-08 (later) — spectator W1 MERGED (PR #743, `main` 60c0615b0;
  worktree rebased, HEAD `09f5fa1de`+).** Consequences applied (design FS18):
  the live transport already exists at
  `components/public-site/match-centre/use-live-fixture.ts:17` — W1 Task 1 is
  rewritten to widen it IN PLACE (no lift; `LiveScore` wrapper is RETIRED,
  `live-score.tsx` exports only `LiveScoreBody`); the public payload carries
  `match_centre` (with `timeline: TimelineLine[] | null` — NO event `type` on a
  line); **the W2 gate is OPEN** — W2 waits on PR1 and its own task-zero RE-PIN
  (rows annotated in `W2-moments.md` and the W2 plan; `match_centre.timeline`
  to be evaluated as the moments source, F4 unchanged); `run-sheet.tsx`
  mounts re-pinned to `:355/:390/:428/:669`; `WALKTHROUGH_SPECS` now lists the
  two spectator walkthroughs, so W1 Task 8's insertion point moved.
- **Findings since the design was written:** FS10 credits donor is
  `ai_credit_ledger` (V320) + `lib/credits.ts` + `credit-pack-checkout` +
  `billing-events.ts:151`, not size packs; FS11 Stripe events may be applied
  by `api/cron/billing-events`; FS12 landing catalogue rows are FALSE for
  all five plans; FS13 `public_fixtures_v` latest definer is `V369:18`.
- **Plan review:** `_REVIEW-2026-09-08-plans.md` (reviewer pass over the T1
  plan and the amended W1 plan; fixes applied before the second merge).
- **NEXT ACTION:** execute `../../plans/2026-09-07-streaming-t1.md` from
  this worktree with `superpowers:subagent-driven-development` (Opus at
  minimum per dispatch). Its Task 0 stands the env up (`seazn-env up --label
  ovl`), installs `node_modules` (fresh worktree has none), records the
  vitest baseline, and re-checks `ls db/migration/deltas | sort -V | tail`.
  R1/R2 plans are written one wave ahead, never earlier.
  **(SUPERSEDED 2026-09-08 — T1 Task 0 has RUN: the env is up, `node_modules`
  installed, the baseline recorded and the deltas tail re-checked. See
  "## Environment (label `ovl`, stood up 2026-09-08 …)" below. T1 Task 4 owns
  rewriting this bullet; it is left in place until then.)**

## Environment (label `ovl`, stood up 2026-09-08 from this worktree @ `4ee38278d`)

This block supersedes the "## Environment" and "## Baseline" sections at the
foot of this file — they describe the 2026-09-05 tree and are kept only as the
prior record.

- `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl`
  `DATABASE_SSL=disable`
- `SMOKE_BASE=http://localhost:3303` = `PLAYWRIGHT_BASE`; `E2E_PROD_TARGET=1`
- `psql "postgresql://postgres@127.0.0.1:54405/seazn_ovl" -tAc "show
  data_directory"` → `/tmp/seazn-env/ovl/pg` (contains `ovl`). Run by hand
  2026-09-08; this is the psql output, not the script's
  `BENCH_EXPECTED_DATA_DIR`. The script separately verified the same value
  against its own datadir ("data_directory verified" in its log) before
  reporting the server ready. This is the check that tells our cluster apart
  from a squatter's — a `pg_ctl` that failed "Address already in use" is
  followed by a `createdb` that SUCCEEDS against another session's server.
- Deltas tail on this branch: `V399__stats_player_career_split.sql` (T1 adds
  none; W1 takes V400/V401)
- Baseline (`apps/web`, full, fresh DB, tree = `origin/main` + this branch @
  `4ee38278d`): **passed 15121 / total 15198 / failed 4 / pending 73** — 1182
  test files, 1 failed; `outside-worktree 0` (every `.testResults[].name`
  resolves under this worktree); runner exit 1. JSON at
  `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/80298fc7-d342-412c-85bd-3bd1f75ab7f6/scratchpad/t1/baseline-web.json`.
  Red files: `apps/web/src/server/usecases/__tests__/schedule-build-honours-locks.test.ts`
  — all four assertions fail `AssertionError: expected undefined to be
  '2026-08-01T19:00:00.000Z'`. Classification **ENVIRONMENTAL**: the suite needs
  the CP-SAT placement service and `up` was not given `--placement`. Not
  attributable to this branch (which carries no code) and not to `main`.
- Lint `✖ 137 problems (0 errors, 137 warnings)`, `LINT_EXIT=0` — read through
  `rtk proxy pnpm run lint`, since plain `rtk` hides this output entirely; tsc
  `EXIT=0`; `openapi:gen` + `i18n:gen-keys` porcelain: **EMPTY both before and
  after**, so no generator drift on an untouched tree and no finding against
  `main` from that step.
- `mobile.spec.ts` @ mobile-320 before Task 3: **44 passed, 1 skipped, 0 failed**
  (2.2 m), `PW_EXIT=0`. Both `auth.setup.ts` projects passed first, so the
  served build is this tree's. This is the pre-change witness Task 3's helper
  move is judged against.
- Q12 (`pass-scoping-guard.test.ts`): **green on this tree.** The 2026-09-05
  note's "two reds, unclassified" do NOT reproduce; closed as green on
  `4ee38278d`. Nothing to attribute, nothing to fix.
- **`seed:demo` was NOT run** — the env skill lists it as owed by the caller.
  Nothing so far needed it; Task 3's smoke suite may.
- **The 2026-09-07 corpus re-pins are ALREADY LANDED — do not re-pin them.**
  Verified 2026-09-08 (T1 Task 0 Step 8a) on an untouched tree; they were
  committed at `8d31cb34f` / `c8dc4d07f` and reached `main`, so a rewrite would
  stage nothing. The five checks and what they printed: `"re-pinned 2026-09-07
  @ fb99bbd4c"` in `W1-step-one.md` → **8** (floor is 8 — no margin, so a later
  edit that drops one line takes this below its floor silently); `"eleven"` in
  `_RULES.md` → **3** (R16 widened); `"run-sheet-row.tsx"` in `W1-step-one.md`
  → hit at `:29` (RP1 re-pinned; the mount is the SYMBOL
  `data-testid="run-sheet-edit-time"`, never a line number); `"set point"` in
  `W2-moments.md` → **5** (F3 landed); `"^| T1 |"` in `_INDEX.md` → **empty**,
  which was the row Task 0 then added.
- Recreate from this worktree with
  `POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_KEY= ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl --server`;
  `rebuild --label ovl` after every code change. **Blank both PostHog keys**:
  `captureServer` reads `POSTHOG_KEY ?? NEXT_PUBLIC_POSTHOG_KEY` and
  `.env.local` carries a real key, so a browser-driven local run otherwise
  posts to the LIVE PostHog project.

## Where the work lives

- Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`,
  **based at `4ee38278d`** (Task 0 Step 1, 2026-09-08). Every docs commit of
  this programme is already ON `main`: the branch was 0 ahead / 3 behind, so
  `/usr/bin/git rebase origin/main` was a FAST-FORWARD, not a replay. The
  earlier "rebased onto `fb99bbd4c`, 24 unpushed docs-only commits,
  force-pushed" no longer describes this branch — nothing is carried and no
  force-push is owed. **`main` moves under this branch several times a day**
  — during Task 0 alone #747 `feat/pad-attribution-side-groups`, #748
  `docs/spectator-w1-merged`, then #750 `fix/money-path-gate-arming` (which
  touched only `.github/workflows/e2e.yml`, no contention with this
  programme). So treat any ahead/behind written here as a SNAPSHOT and re-run
  `/usr/bin/git rev-list --left-right --count origin/main...HEAD` before
  trusting it. At the close of Task 0 the branch was **1 ahead** (the Task 0
  docs commit) **and 2 behind**, and `origin/feat/stream-overlay` still
  pointed at the pre-Task-0 `01669d287` — the push is the main session's call.
  The previous directory at that path was an unregistered residue and was
  moved to `.claude/worktrees/stream-overlay.stale-20260907`; the worktree was
  re-added from the branch. The branch has no PR (docs only).
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
| `T1-theme-and-visual-gate.md`, `R0-bench.md`, `R1-relay-core.md`, `R2-compositor.md` | per-wave PROMPT files (owner ruling 2026-09-07: prompts for every wave now) — written, `8d31cb34f` |
| `../../plans/2026-09-07-streaming-t1.md` (now), `…-r1.md` (after PR1 merges), `…-r2.md` (after the R0 memo) | per-wave PLAN files, written one wave ahead of execution by `writing-plans`; Task 0's steps sit at the head of the T1 plan |
| `docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)" | the owner's checklist; every task's acceptance names its rows |
| Canvas | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 |

## THE FIRST THING TO DO NEXT SESSION

1. If the four wave prompts (`T1-theme-and-visual-gate.md`, `R0-bench.md`,
   `R1-relay-core.md`, `R2-compositor.md`) or the T1 plan
   (`../../plans/2026-09-07-streaming-t1.md`) do not exist: write them from
   the design (§11 is the table; §9a the patterns every brief must name).
   Prompts for every wave now; step-level plans one wave ahead only. Do not
   re-brainstorm; every decision is in the design and in `_INDEX.md` rulings
   18–22.
2. If they exist: execute Task 0 from the head of the T1 plan (corpus
   corrections in place, migration renumbering, Q12 reproduction), then T1 and
   W1-A/W1-B in parallel, per `superpowers:subagent-driven-development` with
   `model: opus` per dispatch (owner instruction; the agent frontmatter reads
   `sonnet`). The R1 plan is written after PR1 merges; the R2 plan after the
   R0 memo.
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

## Environment (SUPERSEDED — prior record, 2026-09-07)

**Stale as of 2026-09-08** in its FIRST SENTENCE only — the `ovl` environment IS
up, and the coordinates are in "## Environment (label `ovl`, stood up
2026-09-08 …)" above, which is the authority for them. **Everything else in
this section still holds and is kept deliberately:** the `up` FLAGS in the
first bullet — `--server` for e2e and smoke, and **`--placement` before
trusting `schedule-build-honours-locks.test.ts`**, which is the one command
that turns the new block's four ENVIRONMENTAL reds green — and the
worktree-setup traps in the last two bullets.

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

## Baseline (SUPERSEDED — apps/web vitest, fresh `ovl` DB, 2026-09-05, at `997ad22`)

**Stale as of 2026-09-08.** The live baseline is the one in "## Environment
(label `ovl`, stood up 2026-09-08 …)" above — 15121 / 15198, one red file,
environmental — and it is cited by JSON path, which is the single authority.
Q12 was reproduced there and closed GREEN. Kept as the prior record only.

13,962 passed of 14,041, 74 pending. Five reds: three placement-service
environmental, two `pass-scoping-guard.test.ts` unclassified (Q12). **Stale
after the rebase** — Task 0 re-baselines on `fb99bbd4c` and attributes Q12's
reds on a clean detached checkout before any wave starts.
