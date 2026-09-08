# Stream overlay — resume state

**Read this first.** It says what exists, what is decided, and the next
action in order.

**Implementation HAS started.** The T1 wave is complete and sits in **PR #752**
on branch `feat/stream-overlay`: ten commits, four tasks, the first code this
programme has shipped under `apps/web`. Nothing under `packages` or `db` is
touched, and no migration exists yet. Anything below that says "no code exists"
or "docs only" describes the tree before 2026-09-08 and is marked where it
survives as a prior record.

Last updated: 2026-09-08, **T1 closed and in PR #752**; W1 is next.

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
  the symbol is the authority). ~~Deltas still end at `V399`.~~ **They end at
  `V400__repair_orphaned_age_cutoff_half.sql` as of later that day** — which is
  exactly why this programme now reads the tail instead of writing a number
  down. Do not trust this line either; run the `ls`.
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
- **T1 IS DONE (2026-09-08).** All four tasks executed from
  `../../plans/2026-09-07-streaming-t1.md`; ten commits on
  `feat/stream-overlay`, in **PR #752**. Owner picks **1A · 2A · 3A · 4A · 5C**
  plus the ink-hairline addendum are in `_THEMES.md`; the full close — gate
  numbers, mutant killer lists, findings, deferred minors — is the
  "## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)" section of `_INDEX.md`, which is
  the authority for all of it. (This bullet replaces the "NEXT ACTION: execute
  the T1 plan" instruction that stood here; Task 4 owned rewriting it and has.)
- **NEXT ACTION:** see "## THE FIRST THING TO DO NEXT SESSION" below. In short:
  PR #752's pre-merge e2e (`workflow_dispatch pr=752`) and the owner's
  per-screen sign-off, then **W1** from
  `../../plans/2026-09-05-stream-overlay-w1.md` (amended). R1's plan is written
  after PR1 merges, R2's after the R0 memo — one wave ahead, never earlier.

## T1 — what shipped, and what it handed forward (2026-09-08)

`_INDEX.md`'s "## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)" is the single
authority for the detail: the ten commits, the gate numbers, the mutant killer
lists, the findings and the deferred minors. Repeated here only so a resume
read knows what exists and what is owed.

**Shipped** — `apps/web/src/lib/contrast.ts`,
`apps/web/src/components/overlay/overlay-tokens.ts` and its eleven-sport
contrast sweep, `apps/web/e2e/visual/{manifest.ts,manifest.json,seeds.ts,asserts.ts,capture.spec.ts}`,
`overflowingIn` moved into `apps/web/e2e/helpers.ts`, `visualSeedRoutesSuite` in
`scripts/smoke.ts`, `docs/runbooks/visual-gate.md`, the T1a sections of
`_THEMES.md`, and one production fix (`court-card.tsx`, a `min-w-0` on the
truncate chain). **No migration, no dictionary key, no user-facing string.**

**Gate, on `be36620db`:** full `apps/web` vitest **15543 / 15620 / 4 failed**
against the baseline's **15121 / 15198 / 4** — **+422 tests, delta failed 0**,
and the four reds are the baseline's own environmental placement file. Six PNGs,
all hashes distinct; `mobile.spec.ts` @ mobile-320 **44 / 1 / 0**, the exact
pre-change witness; spectator walkthroughs **19 / 0**; smoke visual-gate 4/4;
`tsc` 0; lint 137 warnings / 0 errors, unchanged from baseline.

**One caveat on the seven-width sweep (271 / 1 / 4):** the single red is
`page smokes: settings save + invoice/plan card render`, a read-modify-write on
the org name against the SHARED Pro org, raced by running seven width projects
against ONE local server and database. It is a **run-method artefact** — CI
matrixes those widths into separate jobs with their own DB — and it is recorded
as one rather than as a pass. Run the widths one project at a time locally.

**Handed forward, and each will be silently dropped if not carried:**

1. **The `--sport-ink` hairline is an e2e obligation on W1.** Two contrast
   findings (football's chip at 2.56, hockey's live dot at 2.75) are closed as
   *covered* rather than waived, and the covering element is a 1-px border that
   **no node-environment test can see**. If W1's e2e does not assert it, both
   closures are unbacked. Named in `W1-step-one.md` acceptance.
2. **`overlay-tokens.ts` owes an e2e and a smoke**, and W1 Task 8's are named as
   its. The module has no HTTP surface until the overlay route exists.
3. **`auth: true` and `seed: "none"` must be named as first-use in W1-E's
   brief** — live harness code no manifest row drives.
4. **Two `main` findings need an owner and a wave:** `standings-table.tsx:58`
   (axe SERIOUS, `scrollable-region-focusable`; the fix owes a new string in
   four locales across three surfaces) and `live-score.tsx:245`, the
   `truncate`-without-`min-w-0` twin of the `court-card.tsx` fix. **The second
   was being carried as "on a retired component" — that is wrong.** The
   `LiveScore` WRAPPER is retired; `LiveScoreBody`, which contains line 245, is
   mounted at `summary-tab.tsx:58` and `match-centre.tsx:90` and its branch
   renders whenever `suppressScorebug` is false — cricket on the Summary tab,
   and the no-document fallback, which passes the prop not at all. What is true
   is only that no manifest row photographs it. See `_INDEX.md` FS-T1h.
5. **An owner question for W2's planning:** `_THEMES.md` §5 scopes
   `dismissal-on-board-2` to the WICKET slab. If W2 widens it to red-card slabs,
   football measures 2.56 on its own band and the carrier accounting must be
   re-derived.

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
- Deltas tail when the env was stood up: `V399__stats_player_career_split.sql`.
  **That number is already stale** — `main` took `V400__repair_orphaned_age_cutoff_half.sql`
  later the same day. T1 adds no migration. **No number is reserved for this
  programme; read the tail yourself** — see the rule under "Where the work
  lives" below.
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
  re-added from the branch. ~~The branch has no PR (docs only).~~ **It has one:
  PR #752**, opened 2026-09-08 once T1 landed code.
- ~~Every commit is documentation, all under `docs/superpowers/`.~~ **False
  since T1.** The branch now carries production and test code under `apps/web`
  (`lib/contrast.ts`, `components/overlay/overlay-tokens.ts`, `e2e/visual/**`,
  `e2e/helpers.ts`, `court-card.tsx`) plus `scripts/smoke.ts` and
  `docs/runbooks/visual-gate.md`. Still nothing under `packages/` or `db/`.
- ~~**No pull request, deliberately.**~~ **PR #752 is open.** The reasoning
  behind the old bullet still holds and is why the PR waited for code: CI and
  smoke run on `pull_request`, so a docs-only PR buys nothing. **e2e does NOT
  run on pull requests** — `.github/workflows/e2e.yml` triggers on push to
  `main` only, so the ONLY pre-merge e2e signal for #752 is
  `workflow_dispatch` with `pr=752`. Re-read `e2e.yml` rather than trusting this
  sentence; that trigger has changed three times in one day before.
- **Migrations: a RULE, never a reserved number.** This bullet used to read
  "this programme takes V400 / V401 / V402". `main` took
  `V400__repair_orphaned_age_cutoff_half.sql` during the T1 wave, so the
  reservation was already wrong — and renumbering to V401/V402/V403 would just
  reset the same trap. **Take the next free numbers after
  `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase and
  again immediately before writing the migration file. Never carry a number
  forward from a document.** A duplicate Flyway version survives a clean rebase
  with no conflict, which is why the check is at every rebase and not once.
  T1 adds no migration; **W1 is the first wave here that needs one.**

## The documents, and what each is for

| File | Role |
|---|---|
| `../2026-09-07-streaming-programme-design.md` | **design of record** (owner-approved 2026-09-07): Tier A rewritten in, T1, credits, Tier B, compositor, R0, testing, plan structure, findings |
| `../2026-09-05-stream-overlay-design.md` | superseded; kept for the canvas links and the approval record |
| `_INDEX.md` | decision log, owner rulings verbatim (1–23), false premises, both pinned-symbol tables, the 2026-09-07 section, and **"## 2026-09-08 — T1 wave CLOSED"** — the authority for T1's gate numbers, mutant killer lists, findings and deferred minors |
| `_RULES.md` | R1–R17 standing rules and the eight merge gates |
| `_THEMES.md` | binding values at 1920×1080; §3 `bar`, §4 `bug`. **T1a LANDED 2026-09-08**: §4a slate, §8a Phone tab, §8b credits card, the decided/void rows, §5's derived slab ink and §2's contrast + ink-hairline rows. It supersedes design §7.6 on the Phone-tab QR floor, and it is the authority `overlay-tokens.ts` parses — a value typed in both places is a finding, not a convenience |
| `_OPEN-QUESTIONS.md` | the 2026-09-05/06 questions and answers; the design's §12 holds today's open set |
| `W1-step-one.md`, `W2-moments.md` | the wave prompts (corrected in place by the plan's Task 0) |
| `../../plans/2026-09-05-stream-overlay-w1.md` | W1 plan, executes as corrected (Task 0 Steps 2–13 → the overlay endpoint) |
| `../../plans/2026-09-05-stream-overlay-w2-moments.md` | W2 plan, blocked on spectator W1 |
| `T1-theme-and-visual-gate.md`, `R0-bench.md`, `R1-relay-core.md`, `R2-compositor.md` | per-wave PROMPT files (owner ruling 2026-09-07: prompts for every wave now) — written, `8d31cb34f` |
| `../../plans/2026-09-07-streaming-t1.md` (now), `…-r1.md` (after PR1 merges), `…-r2.md` (after the R0 memo) | per-wave PLAN files, written one wave ahead of execution by `writing-plans`; Task 0's steps sit at the head of the T1 plan |
| `docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)" | the owner's checklist; every task's acceptance names its rows |
| Canvas | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 |

## THE FIRST THING TO DO NEXT SESSION

**Rewritten 2026-09-08 by T1 Task 4.** The two instructions that stood here as
items 2 and 3 are both dead and are named here so a fresh session does not act
on a stale copy of this file:

- ~~"execute Task 0 from the head of the T1 plan"~~ — **T1 is DONE**, Task 0
  included. Re-running it would re-baseline against a tree that has moved and
  re-do corpus corrections already landed.
- ~~"Force-push the rebased branch (`git push --force-with-lease`)"~~ — **no
  force-push is owed, and one would rewrite pushed history.** That instruction
  survived from a state where the branch carried 24 unpushed docs-only commits;
  the branch has since been a fast-forward and is pushed. `git push` plainly, or
  nothing at all.

The live order:

1. **PR #752 (T1).** Two things gate it, and neither is CI-automatic:
   (a) **pre-merge e2e is `workflow_dispatch` with `pr=752`** — `e2e.yml`
   triggers on push to `main` only, so opening the PR ran nothing; re-read
   `e2e.yml` rather than trusting this line. (b) **the owner's per-screen
   sign-off** — six PNGs and the five T1a picks plus the hairline addendum, one
   verdict each. "CI green" is not sign-off.
2. **Then W1**, from `../../plans/2026-09-05-stream-overlay-w1.md` (amended),
   per `superpowers:subagent-driven-development` with `model: opus` per dispatch
   (owner instruction; the agent frontmatter reads `sonnet`). W1's task zero
   owes: a rebase on `main`, the RE-PIN list, and the **migration-number READ**
   — `ls db/migration/deltas | sort -V | tail -1`; no number is reserved, and
   **the W1 plan still names `V400`/`V401` on 24 lines including two literal
   "create this file" steps, while `V400` is already taken on `main`.** Its own
   renumber guard sits at Step 13, after Steps 6 and 3 have written the files.
   Correct the plan's numbers at Task 0, in one edit, before any step creates a
   migration. Full list of the stale locations: `_INDEX.md` FS2. W1's
   acceptance carries **two obligations T1 handed it**, both recorded in
   `_INDEX.md`'s T1 close section and in `W1-step-one.md`: the **1-px
   `--sport-ink` hairline** asserted in e2e (two contrast closures rest on it),
   and this module's **e2e + smoke**, which W1 Task 8 owns.
3. **W1-E's brief must name `auth: true` and `seed: "none"` as first-use** —
   both are live harness code that no manifest row drives today, ruled
   deliberate on the condition that W1-E names them.
4. R1's plan is written after PR1 merges; R2's after the R0 memo. W2 stays
   blocked on its own task-zero RE-PIN.
5. Two `main` findings need an OWNER and a wave, not a fix here:
   `standings-table.tsx:58` (axe SERIOUS) and `live-score.tsx:245` (the
   `truncate` without `min-w-0`). Both are in `_INDEX.md` as FS-T1g / FS-T1h.

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
