# Engine split 2b, Batch E close review (the engine repository clone, before O3)

Reviewer: Opus batch reviewer, 2026-10-30. Scope: the local clone `~/github/seazn.club.engine`, `git diff 357585d..0260d0b`
(E1 `0e77252` import, E2 `4412622` CI, E3 `9437932` Stryker, E4 `0260d0b` Changesets). The tag source is
`onryde/seazn.club@engine-split-base` = `5a67fbf37d` (pushed: `git ls-remote --tags origin` answers it). Ledger
`ledgers/2b.json` at `6e52bb9f1b`. Nothing was pushed or committed to the clone. Mutants and probes ran in scratch copies.

**Verdict: NOT READY FOR O3.** 0 Critical, 2 Important, 9 Minor. The import itself is clean. `src/` and `rules/` are
byte-identical to the tag. The 11 golden corpora and `FOLD_EPOCH`/`FOLD_MINOR` are untouched. Every pre-existing engine test
file is byte-identical or changed only on a path. Parity reproduces `unaccounted 0`, and the four outward-facing CLIs behave on
a real README-parent history. Two things stand between this clone and O3:
- **I1 (clone change):** the move left mutation.yml's visibility guard with no test that runs it.
- **I2 (settings change):** a repository setting will stop `release` from opening the Version PR.

## What I ran (all scoped; judged from the JSON reporter plus `EXIT=0`)

| run | result |
|---|---|
| Tag tree (`git archive engine-split-base packages/engine`) vs `git archive 0260d0b`, `diff -rq` | 13 differing files (below), 0 tag files missing; `src/` and `rules/` identical |
| Test-file census, every `*.test.ts(x)` in the tag tree | **287 at the tag: 282 byte-identical, 5 changed**. 3 path-only (publish-manifest 2 lines, pack-proof 1, stryker-cuts 1). 2 append-only (stryker-floor +42, fold-epoch-guard-cli +47; 0 tag lines removed). 9 new files in the clone (8 moved, 1 added) |
| Moved tests, AST-extracted per test and compared with the tag source (`moved` entries) | 61 single tests: 32 bodies identical, 29 changed. Each change is a path re-root, the MATRIX_→STRYKER_ rename, `floors-in`, the upload regex, or one of the 6+2 ruling-A engine halves. The 5 parametrised plan-step tests sit in a describe that is byte-identical. Module-scope code: path re-roots, imports, `STRYKER_REFUSAL` wording, and the ALLOWED/apply lists trimmed to engine rows |
| Titles of the 66 `moved` entries | 58 identical; 8 are exactly `<source title> (engine half)` |
| Parity: before = tag `packages/engine` whole (8019) + web/matrix/root filtered to ledgered ids (7 / 59 / 9), after = clone (8094), all `--isolate -t __parity_collect_only__` | `before-only 75 · after-only 75 · both 8019 · unaccounted 0`, exit 0. All 8019 engine ids survive |
| Scoped vitest in the clone: the 14 changed, moved or added files plus `stryker-outputs-ignored` | **417/417 passed, 15 files, 0 failed suites, EXIT=0** |
| Real history (scratch clone: README commit, then the tip tree as one commit), the three gates exactly as ci.yml spells them | single-sport, floor and fold-epoch all exit 0 with their `::notice::` (floor: 10 floors; fold-epoch: 11 sports, 442 streams) |
| The same history, `git clone --depth 1` | all three exit 2 with their "not a commit / no such commit" refusals |
| Mutants (scratch clone) | **M1** floor: return before the self-check line: killed. **M2** floor: `floorDiff(now, now)` → `[]`: survived (m1). **M3** fold-epoch: `return report(...)` → `return 0`: killed by both new tests. **M4** `holdsNoEngine` → `true`: killed by the existing renamed-directory test. **M5** mutation.yml guard `if [ "$vis" != "public" ]` → `if false` in all 3 jobs: **survived 50/50** (I1) |
| `pnpm install --frozen-lockfile --offline` on a copy of the manifest and lock | "Lockfile is up to date", exit 0 |
| pnpm 10.34.5 on a root-only workspace (probe dir) | `--filter .`, `--filter ....` and `--filter <name>` all select the root. `pnpm -r exec` selects nothing. **`pnpm publish -r --dry-run` publishes the root** (so `-r` is fine) |
| `changesets/action@v2` `action.yml`, read via `gh api` | inputs `version-script`, `publish-script`, `create-github-releases`, `push-git-tags` and outputs `pr-number`, `has-changesets` all exist as the workflow uses them |
| `release-epoch-report.ts --from <import> --to HEAD` as release.yml runs it | "11 sport(s) compared … 0 FOLD_EPOCH raised"; `--summary` appends after the workflow's preface |
| `gh api repos/onryde/seazn.club.engine/actions/permissions/workflow` | `{"default_workflow_permissions":"write","can_approve_pull_request_reviews":false}` (I2) |

Not run: actionlint and shellcheck (neither is installed here). All three workflows parse as YAML (`yaml@2.9.0`). Stryker was not
run, by the brief. Known red, not counted: `test/stryker-sizing.test.ts` leg-count drift, so the `engine` job reds at O3
until the mutation session ports its fix.

## 1. Spec compliance

| plan item | state |
|---|---|
| E1 import, C-a…C-g, `MUTATION.md` "~10.8 h" | Done. `docs/MUTATION.md:549` is the only line that differs from its tag source. The C-d override was kept, and pack-proof pins it |
| E1 M rows (4 K7, 6, 15, 17, 18, 25, 26, 29) + single-sport move + tie parity test | Done. Rows 6, 25 and 26, and two row-17 tests, are split under owner ruling A. **Row 17 missed one mixed test (I1)** |
| E1 AGENTS.md / CLAUDE.md | Done: history and tag sha, registry auth, the `link:` dev loop, paired PRs, the `git apply -p3` porting note, `Matrix rows:`. One wording slip (m4) |
| E2 gates / engine / engine-pack / changeset / downstream | Done. Deviations, all harmless: the job is `engine`, not `test` (it keeps the moved ci-wiring pin verbatim, but see m3 for O4). The fold-epoch step keeps `--fail-if-no-match` although the plan said to drop it (the filter matches the root: probed). `tsconfig.tools-tests.json` is new, so the moved `TSC_STEP` pin stays verbatim |
| E2 step 2, the HEAD^1-absent cases | Done for all three gates, and verified on a real history. The single-sport case was already handled at the tag. The floor self-check is a tautology (m1) |
| E3 mutation.yml, STRYKER_RUNNER, STRYKER_WEEKLY_ENABLED | Done. The incremental-artifact step was dropped (a known decision) |
| E4 changesets, release, snapshot, epoch report | Done. Sanctioned deviation: the epoch report's baseline before the first tag is the import commit ("0 raised"), not "nothing to compare". That is better |
| Batch E close: golden ledgers byte-identical; no workflow grants more than listed | Yes. Write scopes exist only on `release.release` (contents, pull-requests, packages) and `release.snapshot` (packages). `engine-pack` adds `pull-requests: read` (m6) and `downstream` adds `packages: read` |

## 2. Strengths (load-bearing only)

- The no-behaviour-change claim holds by bytes, not by sampling: `src/`, `rules/`, the goldens and the fold tables, at the tip and at
  the import commit (`git diff 0e77252 0260d0b -- src rules` is empty).
- The ledger is honest about every id the parity tool can see. Every `moved` target exists, and every split title is the
  source title plus ` (engine half)` exactly.
- `holdsNoEngine` keeps the renamed-directory refusal. M4 proves an existing test still guards it.

## 3. Issues

### Critical

None.

### Important

**I1. mutation.yml's visibility guard has no test that runs it in the engine repository. The one mixed test that would do so was neither split nor ledgered.**
- Where: tag `tools/matrix/__tests__/matrix-workflow.test.ts:151`, "carry (b): a refusal on a private repository NAMES the
  Stryker mutation workflow, in every job …". It runs each MJOBS guard with a stand-in `gh`: private plus hosted gives exit 1
  with the Stryker wording, and public gives exit 0. It then checks matrix-truth's own guard as the positive control.
- Evidence:
  - It is the only test at the tag that EXECUTES mutation.yml's guard script. The nine-case table (`:140`) runs matrix-truth's
    script. Its result reached mutation.yml only through the identity test that E3 retired (ledger `2b.json:98`).
  - In the clone, `test/matrix-workflow.test.ts:252` (the `added` half) checks only that the jobs share one script holding the
    Stryker wording.
  - Mutant M5, `if false` in all three guards, stays **green 50/50** (matrix-workflow plus stryker-outputs-ignored). At the tag
    it dies twice: carry (b) expects exit 1, and the identity test fails.
  - carry (b) is a mixed test, the exact shape owner ruling A splits. It is absent from `2b.json`, so its MJOBS half dies at
    A3 with no ledger trace.
  - The ledger reason at `2b.json:103` ("its mutation.yml-only part … is kept") overstates what was kept.
- Why it matters: this is the guard that refuses billed hosted minutes if the repository ever becomes private (ruling 68, design
  §6.4). AGENTS.md classes 3 and 6 apply.
- Fix (clone plus ledger; no product code):
  - Split carry (b) under ruling A. The engine half goes in `test/matrix-workflow.test.ts` and keeps the MJOBS loop plus the
    public pass-through. The stand-in-`gh` `runWith` helper comes with it, and the matrix-truth positive control stays with the
    app half.
  - Ledger it as `moved` → `"<title> (engine half)"`, and correct the `:103` reason.
  - Optional: point the nine-row table at `stepOf(MJOBS.plan, GUARD).script`, so mutation.yml's script keeps the
    case coverage the retired identity test used to carry. Record that as `added`.
  - Re-run M5. It must die.

**I2. `release` cannot open the Version PR at O3: the repository refuses PR creation by `GITHUB_TOKEN`.**
- Evidence:
  - `gh api repos/onryde/seazn.club.engine/actions/permissions/workflow` answers `can_approve_pull_request_reviews: false`. That
    is the "Allow GitHub Actions to create and approve pull requests" switch.
  - `release.yml:100` runs `changesets/action@v2`, whose `github-token` defaults to `github.token` (checked in its v2
    `action.yml`).
  - With the switch off, the push at O3 makes the action fail with "GitHub Actions is not permitted to create or approve pull
    requests". `release` goes red, no Version PR appears, and O7 cannot happen.
  - Neither O3 nor O4 nor O5 sets the switch.
- Fix (owner setting, no clone change): before O3, turn it on. One command does it and also drops the repository default to read,
  which every workflow here overrides anyway:
  `gh api -X PUT repos/onryde/seazn.club.engine/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.
  If org policy forbids the switch, `release` needs a GitHub App token instead.

### Minor

**m1. The floor self-check is a tautology, and its test pins zero floors as a pass.**
- `scripts/stryker-floor.ts:561-563`: `floorDiff(now, now)` cannot report a problem, so the `: 1` arm is unreachable. Mutant M2
  (`[]`) survives.
- `test/stryker-floor.test.ts:868` asserts that the `{}` file exits 0 with "0 floor(s)", which turns TEST-STRATEGY's
  anti-vacuity rule upside down. In this repository the floor file can never legitimately be empty; PR-A is history.
- Fix: return 0 directly, and refuse (exit 2) on a self-check of 0 floors. Drop the `[{}, 0]` row, or flip it to expect the
  refusal.

**m2. The O3 expectation "the HEAD^1 notices in the gate logs" is false.**
- A push of four commits runs ci.yml once, on `0260d0b`, whose HEAD^1 is `9437932`. That commit holds the engine, so each
  gate compares normally and prints no notice. The self-check branches never run in CI. My real-history probe and the 7
  `added` tests are their only exercise.
- O3 will also start mutation.yml's push probe (the push matches its paths), and `engine` reds on the known sizing drift.
- Fix: amend O3's watch list.

**m3. O4's required checks name nothing that reports.**
- Branch protection matches check-run names. Those are the jobs' `name:` values: "Typecheck + lint + drift gates", "Engine
  coverage + golden ledgers + sim matrix", "Engine packed-tarball proof", "Changeset present, and its bump covers the fold
  tables". There is no `test` job.
- A Version PR pushed by `GITHUB_TOKEN` triggers no workflow, so no required check ever reports on it. O7 then needs the admin
  bypass (`enforce_admins=false` allows it), or an App token.
- Fix: re-pin O4, and write the bypass into O7.

**m4. `AGENTS.md:19` says "the publish job alone has `packages: write`".**
Two jobs do: `release.yml:46` and `release.yml:182`. Fix the wording.

**m5. `README.md:7` says "The source lives in the seazn.club monorepo (`packages/engine`)".**
That is stale, and npm always packs the README, so it ships in 1.0.0. No test pins the line (`publish-manifest.test.ts:160`
checks subpaths and peers). Fix: point it at this repository, plus the history pointer.

**m6. engine-pack's paths-filter is a no-op that costs a grant.**
- `ci.yml:152-158` with the `'**'` glob always matches. It exists so the moved pin stays verbatim, but it is why the job holds
  `pull-requests: read` (`ci.yml:149`).
- Fix after 2b: drop the filter and the grant, and ledger the pin as `rewritten`.

**m7. Two moved titles now describe the old layout.**
- `test/matrix-workflow.test.ts:819` "runs `pnpm mutation` in packages/engine" asserts `working-directory: .`.
- `:524` "rooted at packages/engine/" asserts root-relative paths.
- The titles-unchanged ruling keeps both, which is correct for 2b (AGENTS.md class 4). Fix after 2b: retitle as `rewritten`.

**m8. `NODE_AUTH_TOKEN` is set at job level in both write jobs (`release.yml:47-49`, `:183-185`).**
- Every step can read it: `pnpm install` lifecycle scripts, `build:dist`, and the third-party actions. In the snapshot job that
  means a PR's own code runs next to a `packages: write` token.
- The version check at `:206-224` stops an accidental leak, not a deliberate one. A same-repo PR author could edit the workflow
  anyway, so this is defence in depth, not a hole.
- Fix: move `NODE_AUTH_TOKEN` onto the publish step (snapshot) and the changesets step (release). The install needs no
  `@onryde` package.

**m9. `downstream` fails open on a missing snapshot.**
- `ci.yml:314-315`: when no snapshot appears within ten minutes, the job only warns and stays green.
- Before the cutover that is right. After it, a failed snapshot publish reads as a passed downstream. Not a required check.
- Fix (post-cutover): make it `::error::` when the app already consumes the registry package.

## 4. Gap hunt

- **The move-induced coverage hole (I1)** is the one real gap. I swept every tag test in the moved app files for
  engine paths, `MJOBS`, `MUT` and `mutation.yml`, and checked each against the ledger:
  - matrix-workflow: the 7 unledgered hits are matrix-truth-only, or ci.yml's matrix-rows (which stay in the app), except carry (b).
  - ci-wiring: the R26 ratchet wiring stays in the app by the known decision. The `engine:boundary` entry-point test is app-side.
  - scenarios, http-driver, append-event, outcome-readers, main-module: nothing else.
- The engine-repo gates `pnpm boundary`, `pnpm single-sport`, schema-snapshot drift, golden-ledger drift and `pnpm lint` have no
  wiring pins here. That is not flagged: D37 rules out selftests on CI guards.
- The single-sport copy (`scripts/single-sport.ts`, 692 lines) carries 3 engine-only tests. Its main suite stays with the app
  copy, by the known decision. The two copies will drift, so treat the app's suite as the authority until one is retired.
- The import commit `0e77252` does not collect on its own: three test files read workflows that arrive in E2/E3, as the ledger
  note records. A bisect that lands there reds. That follows from the D22 one-import shape; noted only.
- The upload-path assertion was loosened from `^packages/engine/` to "not absolute, not `../`" (`test/matrix-workflow.test.ts:531`).
  It is in the brief's known list and is correct for the root layout.
- `AGENTS.md:24` promises "App CI fails any committed `link:` or `file:` engine spec". That is spec D17, but Batch A has to
  build it. Check at A2.

## 5. The four questions

1. **Second call.** CI's second and every later run sees a HEAD^1 that holds the engine, so it compares normally, and only the
   import commit could ever take the self-check branch (m2). `release` is idempotent across reruns: an already-tagged version
   exits 0; a published but untagged version is tagged; a version that was never published is a red (`release.yml:141-150`).
   `pnpm publish -r` skips a published version. The Version PR body gets the report again on every push, never twice
   (changesets/action rewrites the body).
2. **Empty input.**
   - Fold-epoch refuses a pass over 0 streams (`report`, after the verdicts).
   - Single-sport with an empty scan prints its counts.
   - The floor self-check over `{}` passes (m1).
   - The changeset job with no `.changeset/*.md` is red, and an empty FOLD table is red (`ci.yml:212`).
   - downstream with 0 consumers skips with a notice (correct before the cutover). Its judge reds on 0 tests.
   - A snapshot with only `--empty` changesets publishes nothing, with a notice.
3. **After a withdrawal or void.**
   - Engine void and withdrawal semantics are unchanged: `src/` is byte-identical.
   - On the release side, a Version PR closed without merging is recreated on the next push.
   - A release run that died after publishing is finished on rerun (the tag step reads the registry, not the exit code).
   - A PR whose changesets were all withdrawn leaves the version as committed, so the snapshot is skipped and nothing leaks
     under `pr`.
4. **Another sport.** No sport code moved. The tie-declaration parity test sweeps every builtin module × declared config ×
   stage kind, with cricket as the rulebook control. The fold-epoch self-check counted all 11 sports and 442 streams. The
   changeset job reads every `sport: n` entry of both fold tables, 11 each.

## Verdict

**NOT READY FOR O3.**
- What blocks it:
  - I1 needs a small clone change: split carry (b), fix the ledger, and see M5 die.
  - I2 needs one owner setting before the push.
- Once I1 is fixed and I2's switch is on the O3 checklist, this is READY FOR O3.
- The Minor items can ride along now or after O3. m2 and m3 should amend the O3 and O4 runbook text before those steps run.
