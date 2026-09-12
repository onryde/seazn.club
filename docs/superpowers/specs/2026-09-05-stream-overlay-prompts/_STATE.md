# Stream overlay — resume state

**Read this first.** It says what exists, what is decided, and the next
action in order.

**Implementation HAS started, and TWO waves have MERGED.** T1 shipped as
**PR #752** (merge `1d1f34d69`) and W1 as **PR #761** (merge `0dc6fe1b9`,
2026-09-10), both from branch `feat/stream-overlay`. The programme carries
production and test code under `apps/web`, and `db/` is no longer untouched —
`V401__fixture_stream_url.sql` and `V402__streaming_entitlements.sql` are on
`main`. Anything below that says "no code exists", "docs only", "no migration
exists yet", or names #752 as an OPEN pull request describes the tree before
2026-09-10 and is marked where it survives as a prior record.

Last updated: **2026-09-12**, by the R0 bench wave (branch `docs/streaming-r0-memo`):
**R0 is CLOSED — its memo is `R0-memo.md` beside this file, and the Cloudflare
gate that blocked three items is cleared.** W1 CLOSED; W2 is next and owes a
task-zero RE-PIN; R1 and R2 are prompts with no plans; R3 is deferred to the
capture repo. **R2's plan gate ("after the R0 memo") is now OPEN.**

**Read `R0-memo.md` before planning R2.** It reverses the design of record's
compositor choice (B2, not B3), names the guest size and its price, and records
six false premises in the design itself — including that §7.2's graceful stop
cannot work as written and that the pull path is not LL-HLS.

## 2026-09-10 — where things stand (R2-prep; SUPERSEDES the 2026-09-08 block below)

- **W1 is CLOSED.** Merged 2026-09-10 as **PR #761** — `0dc6fe1b9`, "Merge pull
  request #761 from onryde/feat/stream-overlay" (verified against `origin/main`
  on 2026-09-10). Its close is the pair of `## 2026-09-10 —` sections in
  `_INDEX.md` — the measured gate numbers, FS-W1-8a's clipped footer, the three
  false premises, the two seed traps, and **"W1 closing: what is OWED to the next
  wave"**. That file is the authority for all of it; do not re-derive it here.
- **T1 is DONE and MERGED** as **PR #752** (`1d1f34d69`). The 2026-09-08 block
  below still describes #752 as an open pull request waiting on a
  `workflow_dispatch pr=752` run and a per-screen sign-off. Both are discharged;
  read that block as history.
- **W2 is NEXT, and it owes a task-zero RE-PIN before any step runs** — the rows
  annotated in `W2-moments.md` and in
  `../../plans/2026-09-05-stream-overlay-w2-moments.md`, with
  `match_centre.timeline` to be evaluated as the moments source. The spectator-W1
  gate that blocked it is open (PR #743 merged 2026-09-08); the RE-PIN is not.
- **R0 is CLOSED (2026-09-12, `R0-memo.md`). R1 and R2 are PROMPTS with NO
  PLANS and have not started.** No
  compositor code exists in the tree — no `x11grab`, no `module-null-sink`, no
  `runner-fly.ts`. Plans are still written one wave ahead: R1's gate ("after PR1
  merges") is now OPEN, since PR1 is #761; R2's plan waits on the R0 memo.
- **R3 is DEFERRED to the capture repo** (owner ruling 18: "R3 native apps in
  their own spec in the capture repo"). Its inherited risks **P1–P5** are
  recorded in `_INDEX.md` rather than here, because two of the five constrain
  work in THIS repo: **P5** (a device spike on real handsets) is startable NOW
  and blocks the R3 estimate; **P1** (iOS drops the camera when backgrounded)
  changes what R2's soak should prove.
- **[CLEARED 2026-09-12 — the account and token already existed in `.env.local`;
  R0 ran against them and U1's hold-window question is answered in `R0-memo.md`
  §4a. Kept as the prior record.]** **ONE owner action gates THREE items.** R0,
  R1 and the U1 spike
  (`_OPEN-QUESTIONS.md` Q17) all wait on the same thing: **provisioning a
  Cloudflare account and a Stream-scoped API token.** The code tree references no
  Cloudflare env var at all — `CF_ACCOUNT_ID` and `CF_API_TOKEN` appear only in
  `README.md:164-165` and nowhere under `apps/`, `packages/` or `scripts/`
  (verified 2026-09-10). Nobody can size the guest, provision a live input, or
  answer U1 until that account exists. It is the single highest-leverage
  unblock in the programme.
- **Migration numbers: the RULE still holds and the collision is already real.**
  `main` now ends at `V402__streaming_entitlements.sql`, so design §5.1's `V401`
  and §6.1's `V402` are BOTH taken. Take the next free number after
  `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase. A
  duplicate Flyway version survives a clean rebase with no conflict.
- **This wave:** **R2-prep**, branch `feat/stream-r2-prep`, opened 2026-09-10 —
  documentation only, folding the 22-row register
  `_FINDINGS-2026-09-10-relay-signal-path.html` into its owning documents before
  R2 starts and the window closes. Brief and fold map:
  `_WAVE-2026-09-10-r2-prep.md`; per-row audit trail in `_INDEX.md`.

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
  `../../plans/2026-09-07-streaming-t1.md`, on `feat/stream-overlay`, in
  **PR #752**. The commits are the range **`origin/main..feat/stream-overlay`** —
  count them with `git log --oneline origin/main..feat/stream-overlay` rather
  than trusting a number written in a document, because each fix round appends
  one. **Anchor on `origin/main`, never on a merge-base sha**: this line first
  read `0cc4614b8..`, and the 2026-09-08 rebase made `0cc4614b8` an ancestor of
  `origin/main`, so that range then swept the 79 replayed `main` commits too.
  Measured on `9164a926a`: `git rev-list --count 0cc4614b8..feat/stream-overlay`
  → **93**; `git rev-list --count origin/main..feat/stream-overlay` → **12**.
  Owner picks **1A · 2A · 3A · 4A · 5C**
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
authority for the detail: the commit table, the gate numbers, the mutant killer
lists, the findings and the deferred minors. Repeated here only so a resume
read knows what exists and what is owed.

**Shipped** — `apps/web/src/lib/contrast.ts`,
`apps/web/src/components/overlay/overlay-tokens.ts` and its eleven-sport
contrast sweep, `apps/web/e2e/visual/{manifest.ts,manifest.json,seeds.ts,asserts.ts,capture.spec.ts}`,
`overflowingIn` moved into `apps/web/e2e/helpers.ts`, `visualSeedRoutesSuite` in
`scripts/smoke.ts`, `docs/runbooks/visual-gate.md`, the T1a sections of
`_THEMES.md`, and one production fix (`court-card.tsx`, a `min-w-0` on the
truncate chain). **No migration, no dictionary key, no user-facing string.**

**Gate, on the tree at commit 10 of the range** (`knownDefects honoured one
check and lied about the other four`, the last Task 3 commit — its pre-rebase
sha no longer resolves)**:** full `apps/web` vitest **15543 / 15620 / 4 failed**
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
  committed at `8d31cb34f` / `c8dc4d07f` and their CONTENT is on `main`, so a
  rewrite would stage nothing. **The obvious ancestry check disagrees with the
  word "reached", and that is expected, not a missing merge**: `8d31cb34f` IS an
  ancestor of `origin/main`, `c8dc4d07f` is NOT — it was squash-merged, so
  `main` carries its changes under a different sha and
  `git merge-base --is-ancestor c8dc4d07f origin/main` returns false. Verify
  these by content, never by ancestry alone. (Re-run after the 2026-09-08
  rebase and unchanged. Both still `cat-file -e` in THIS clone, but
  `c8dc4d07f` is reachable from nothing now — a fresh clone will not have the
  object at all, which is the same reason the commit table above is keyed by
  position rather than by sha.)

  The five checks and what they printed: `"re-pinned 2026-09-07
  @ fb99bbd4c"` in `W1-step-one.md` → **7 as of the final-review fix round,
  2026-09-08; it was 8** — scope 4's entitlement migration lost its marker when
  that line was rewritten from the reserved `V401` to the `V<next+1>` RULE, and
  the re-pin it recorded is exactly what the rule supersedes. **The floor moves
  DOWN to 7 rather than the check reading as a regression**, and the general
  form is: when a marked line is deliberately rewritten, re-derive the floor and
  say why here — never restore a marker to satisfy a count, which turns the
  sentinel into decoration. (The remaining margin is still zero, so the original
  warning stands: an accidental drop takes this below its floor silently.)

  **A bare count still cannot tell a deliberate retirement from an accidental
  drop** — a round that retires one marker and loses another nets to 7 and
  reads clean. So the floor is a ROSTER, not an integer. The seven surviving
  markers and the scope each belongs to, re-derived 2026-09-08 from
  `grep -an "re-pinned 2026-09-07 @ fb99bbd4c" W1-step-one.md`:

  | Line | Owning scope |
  |---|---|
  | `:27` | header — desk sequencing (W1/W2 merged, W3 is the contention) |
  | `:209` | scope 5 — the cookie banner (Q2 + FS1) |
  | `:226` | scope 5 — `hasFeature` at `lib/entitlements.ts:456`, moved from `:454` |
  | `:270` | RP1 — `FixtureLine` / `fixture-schedule-toggle` retired by desk W2 |
  | `:342` | do-not-touch list — `stages-panel.tsx` is no longer the mount |
  | `:486` | acceptance — `fixture-schedule-toggle` absent, `run-sheet-edit-time` present |
  | `:536` | merge gate — rebase after any desk-W3 merge touching `desk/run-sheet-row.tsx` |

  Retired so far: **scope 3/4's migration numbers**, when the reserved
  `V400`/`V401` became the `V<next>` RULE (final-review fix round, 2026-09-08).
  Check the roster by SCOPE, not by count: a line number here moves whenever
  the file is edited, so match on the owning scope and re-derive the numbers.
  `"eleven"` in
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
  PR #752**, opened 2026-09-08 once T1 landed code — **and #752 has since
  MERGED (`1d1f34d69`), as has W1's PR #761 (`0dc6fe1b9`, 2026-09-10).**
  R2-prep works from a different branch and worktree: `feat/stream-r2-prep`,
  `.claude/worktrees/stream-r2-prep`.
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

**SUPERSEDED 2026-09-10 by the R2-prep wave. Items 1–3 below are DISCHARGED**
and are kept only so a fresh session does not act on a stale copy: #752 (T1)
merged as `1d1f34d69`, and W1 merged 2026-09-10 as **PR #761** (`0dc6fe1b9`),
carrying W1-E. Item 4's R1 gate has opened with it. Item 5 is NOT discharged —
FS-T1g (`standings-table.tsx:58`, axe SERIOUS) and FS-T1h
(`live-score.tsx:245`, `truncate` without `min-w-0`) still name an owner and a
wave, and neither belongs to this programme.

**The live order, 2026-09-10:**

1. ~~**The owner action that gates three items** — provision a Cloudflare account
   and a Stream-scoped API token.~~ **DONE 2026-09-12.** The credentials were
   already in `.env.local`; this file did not know. R0 has run, and U1's
   hold-window question (`_OPEN-QUESTIONS.md` Q17) is answered in `R0-memo.md`
   §4a — `timeoutSeconds` governs the hold, the hold is timeout + ~3 s, and at
   180 **no `EXT-X-ENDLIST` is ever emitted**.
2. **W2**, from `../../plans/2026-09-05-stream-overlay-w2-moments.md`, whose
   task zero owes the RE-PIN table in the PR. This is the only wave that can
   move without the Cloudflare account.
3. **The organiser-panel e2e** (`components/v2/fixture-stream-panel.tsx`) — the
   owner-ruled first item of the next wave, still unbuilt. Read the E3
   correction in `_INDEX.md`'s R2-prep section BEFORE writing the rig: the gate
   is four conditions across two files, not the one this file's ancestors
   recorded.
4. **P5, the device spike**, is startable now and blocks the R3 estimate. It
   needs handsets, not this repo, and touches nothing R2 depends on.
5. ~~Then R0's bench~~ **R0 is CLOSED.** Next is **R2's plan**, whose gate is now
   open — write it from `R0-memo.md`, not from design §7.2/§9.3, both of which
   R0 corrects. Then R1, then R2. Plans stay one wave ahead.

**Two owner decisions are open and both cost money** (`R0-memo.md` §2, §3):
whether the `< 80 %` CPU bar is honoured as written — `performance-4x` at
£0.539/3 h misses it by 1–5 points, `performance-8x` at £1.078 clears it and
also buys multi-cam n=4 — and whether to enable Cloudflare's **Low-Latency HLS
beta**, which is off today and is the difference between a ~12.6 s and a claimed
~5 s scorebug for anyone watching a phone-published match.

**The 2026-09-08 order, kept for the record:**

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

**Added 2026-09-10 — and Q17 IS blocking, despite this heading.** `Q17`
(register U1, what the playback side sees while a live input is disconnected) is
the one open question in the programme that gates a wave: it decides whether R2's
slate is driven by frame starvation or by reconnect logic. It cannot be answered
until the Cloudflare account exists. `Q18`/`Q19` are RULED, not open — owner
rulings R-A and R-B, 2026-09-10, recorded as rulings 24 and 25 in `_INDEX.md`.

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
