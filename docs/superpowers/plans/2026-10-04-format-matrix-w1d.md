# Format × Sport Matrix — W1d (CI truth runs + the first full truth run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution model policy (owner, 2026-10-04: "Let's us Sonnet for all remainings tasks in this session" and "Whole branch review must be Opus").** Every implementer, every task reviewer and every fix agent runs on Sonnet: dispatch each with `model: "sonnet"`. The whole-branch reviews, one at the end of PR-A (Task 16) and one at the end of PR-B (Task 22), run on Opus: dispatch each with `model: "opus"`. Nothing else overrides a model. Each commit carries the attribution of the model that wrote it. The policy was given for the owner's current session: if execution runs in another session, re-confirm it with the owner first (AGENTS class 17), because AGENTS.md otherwise says never to override `model:`.

**Goal:** The matrix runs itself. A GitHub workflow runs it weekly and on dispatch, sharded across about 12 jobs, each on a fresh Postgres with `sync:sports`. A visibility guard stops it before it can bill a private repo. Stryker runs weekly on the engine, placement scheduling excepted (rulings 66, 67), against per-group floors that may only rise. The first full truth run is then triaged: every ❌ carries an audit gap ID (or `NEW-W1d-<n>`) and its owning wave, so W2–W7 each start from a measured backlog.

What an organiser gets: the ~150 audit hypotheses become a list of reproduced problems, each owned by one wave, plus a weekly signal when a change breaks a case that used to work.

**Architecture** (owner rulings 60–68, 2026-10-04):
- **One plan, two PRs** (ruling 62). `workflow_dispatch` fires only a workflow file already on `main`.
  - **PR-A (infra), Tasks 1–16:** the 28 "W1d first tasks" items, sharding, the workflow and its visibility guard, the per-PR sample, the Stryker workflow, and the weekly schedule shipped DISABLED.
  - **PR-B (evidence), Tasks 17–22:** three harness-green dispatches, the triage tooling and the triaged baseline, the Stryker floor, the schedule enabled, the per-wave ❌ tables, and W2 → "backlog ready".
  - **Merge gate between them: the owner merges PR-A.** PR-B's branch is cut from `main` after that merge.
- **A shard is a stripe of the plan.** `--shard k/N` keeps the plan items whose index `i` satisfies `i mod N = k−1`. It is a pure function of plan order, so the same case lands in the same shard on every run. The union of the shards is the plan, and no two shards overlap.
- **One merged result per layer.** `merge-shards.ts` puts each layer's N shard files back into plan order (one `results.json`, one `MATRIX.md`). It refuses a missing, partial, aborted or mismatched shard. `judge.ts` then decides harness-green (ruling 61) from the merged files.
- **The workflow is reusable.** `.github/workflows/matrix-truth.yml` has four triggers:
  - `schedule` (gated by `vars.MATRIX_WEEKLY_ENABLED`);
  - `workflow_dispatch`;
  - `workflow_call`, which is how `ci.yml`'s per-PR sample calls it;
  - `pull_request` on its own paths, which runs a smoke scope (the `bench.yml` self-proof precedent).

  There is one recipe and one guard.
- **No product changes.** Product reds are data (ruling 19). W1d touches `apps/web` and `packages/engine` only for Stryker's config, devDependencies and floor checker, which change no runtime path.
- **The matrix proves formats and rules, not scheduling** (rulings 66, 67). The shard job has no placement container and no solver-fallback guard, because no matrix path reaches the solver at HEAD (D23). A test pins that premise, so a path that starts reaching it reds. Stryker covers every engine module except the placement files under `src/scheduling/`, which are a named, liftable exclusion.

**Tech Stack:**
- Node 26 `--experimental-strip-types`: no enums, namespaces or parameter properties; `.ts` import suffixes.
- TypeScript 7 (`typescript-native` 7.0.2).
- vitest 4 via `packages/engine`'s binary.
- zod 4.
- Playwright 1.61.1 (chromium).
- pnpm 10.34.5.
- GitHub Actions: `background:`/`wait:` steps as in `e2e.yml`; `runner.environment`.
- `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` 10.0.0. Both need Node ≥ 22; the runner's peer is `vitest >=2.0.0` (read from the npm registry 2026-10-04).

**Spec:** `docs/superpowers/specs/2026-09-27-format-matrix-design.md` §2, §6.4, §6.5, §7.3, §7.5 item 2, §8, §9, §10 and §12. The binding scope is owner rulings 16, 19, 20, 21, 39, 46, 47, 48, 55, 56, 58 and **60–67** in `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` ("Owner rulings"), plus "W1d first tasks" items 1–28.
- Prompt: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/W1d-ci-truth-run.md`. Where the prompt and rulings 60–64 disagree, the rulings win (False premises 6–8).
- `_RULES.md`: R5, R10–R14a, R18, R19, R22, R25, R27, R29.
- `docs/superpowers/TEST-STRATEGY.md`: rules 1–5 and 10, plus the reviewer's four questions.
- `docs/superpowers/RULES.md`: TS7, Node 26, the four test types, never a full local suite.
- `AGENTS.md`: failure classes 1, 3, 4, 5, 8, 9, 10, 14, 15, 16 and 20.
- House style follows `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md`.

Where the spec and the tree disagree, see **False premises found in planning**. The tree wins.

---

## Step 0 — anchors (pinned 2026-10-04 against `57f78d888` = `origin/main` `dfe8132da` + rulings 60–64)

`HM` = `tools/matrix`. `TR` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs`.

| Fact | Where |
|---|---|
| Exit table `EXIT = {OK 0, NO_SIGNAL 1, REFUSED 2, ABORTED 3}`; the per-code meanings | `HM/run.ts:135`, header `:40-95` |
| `SETS` (w1b-probe, pad-proof, width-sweep, api-only-browser, w1-driving, w1-driving-l1) | `HM/run.ts:275-285` |
| `BROWSER_WORKERS = routeTo("W1d", "browser workers inside a shard (D10)")`; the D10 usage refusal | `HM/run.ts:454`, `:545-548` |
| `planOf` writes `--layer L1` with no scope | `HM/run.ts:484-490` |
| `parseCli`: the flags; no `--shard`, `--scope` or `--rows` | `HM/run.ts:530-569` |
| `recordPlanned`: `durationMs: 0`, zero counts, no marker | `HM/run.ts:727-735` |
| `runItems` / `itemId`; `execute` plans after sign-in (`variantFor` needs the DB's variant order) | `HM/run.ts:768-787`, `:839-845` |
| `runSlice`'s `refused` list lacks `NoLayerForWidth` | `HM/run.ts:1059-1062` |
| `RunIdReused` checks only `<report-dir>/<run-id>/results.json` | `HM/run.ts:300-309`, `:1044-1045` |
| `LayerCase` = `DrivenLayerCase {spec, noPath:null, notRun:null}` \| `PlannedLayerCase {spec:null, identity, noPath\|notRun}`; `planL1` = the slice × LIFECYCLE at 1280; `planL2(pairs, cells)` sets `run` on every L2 case; `l1Planner`/`l2Planner` = the slice's cells; `LAYER_PLANNERS` exists, chosen at `run.ts:1020` | `HM/lib/layers.ts:80-91`, `:103-106`, `:142-161`, `:174-197`; `HM/run.ts:1020` |
| `CaseSchemaV3` and `RunResultsSchemaV3` are `z.strictObject` | `HM/lib/results.ts:177-221` |
| `decideState`: error reds read `error: <name>: <msg>`; vacuous reds read `no checks ran (vacuous)` / `every check abstained (vacuous)` / `checked zero items (vacuous)` | `HM/lib/results.ts:248-263` |
| `RefusedCall` message: `<METHOD> <path> → HTTP <status> <code>: <message>` | `HM/lib/driver/types.ts:236-252` |
| Lock schema `{note, runs:{<dir>:{plan, layered, driven[], planned{}}}}`; `judgeRun`; the I-2 heuristic | `HM/__tests__/committed-plans.ts:183-200`, `:125-176`, `:143` |
| `expectedPlanFor` parses `--layer L1` as `l1Planner` (today: the slice) | `HM/__tests__/committed-plans.ts:~100-112` |
| `RESULTS_FLOOR = 33`; `EVIDENCE_DIRS`; `W1C_RUNS` | `HM/__tests__/committed-matrix.test.ts:234`, `:71-74`, `:190-197` |
| `rebase-map.test.ts` reads every `TR/w1drv-*` dir's harness commits | `HM/__tests__/rebase-map.test.ts:81` |
| `ci-wiring.test.ts` "no scheduled matrix workflow exists in W1a" reds on ANY workflow matching `/matrix:l3\|tools\/matrix\/run\b/` | `HM/__tests__/ci-wiring.test.ts:244-252` |
| `counts.json` `l1 {formula "cells × 2 widths (1280, 320)", value 462}`; the writer; the test that freezes it | `HM/catalogue/counts.json`; `HM/lib/counts.ts:99`; `HM/__tests__/committed-catalogue.test.ts:271` |
| `l2-pairs.json`: 1,731 runs. Full-grid plan: **62 driven** (M1 21, R4a 21, F1 20), **164 🚫** (W9 63, W4 67, W2 21, W5 13), **1,505 ░** | `HM/catalogue/l2-pairs.json`; measured by `planL2(loadL2Pairs(), all 231 cells)` in the scratchpad |
| Full-grid L1: 16 template rows × 11 = 176 driven; 5 API-only rows × 11 = 55, of which 2 template-reachable (driven through their cards) and 53 🚫 | `HM/lib/catalogue.ts:21-35`; `HM/lib/api-only-ui.ts`; `HM/lib/templates.ts:112,125-131` |
| `HARNESS_SCENARIO = {LIFECYCLE, M1, R4a→R4, F1}` | `HM/lib/scenario-catalogue.ts:199` |
| `MAX_WORKERS = 8`; the results schema reads it | `HM/lib/workers.ts:28`; `HM/lib/results.ts:211,216` |
| `requireOwnDataDir` (BENCH_EXPECTED_DATA_DIR mandatory) | `HM/lib/seed-org.ts:67-70` |
| The bench preflight refuses base ports 3000 and 3100, and DB port 5432 | `tools/bench/lib/env.ts:32,36` |
| `get fillers()` and the `FILLER` names | `HM/lib/driver/browser-driver.ts:585`; `HM/lib/driver/mixed.ts:29` |
| Parity `quiet`; `notDriven` uses the recordPlanned shape | `HM/lib/parity.ts:145`, `:167-189` |
| `openFoldIfFolded` returns `"opened" \| "unfolded"`; `railFor` drops it | `HM/lib/browser/pages/stage-rail.ts:39-52`, `:64` |
| `showAllFixtures` always presses "all"; the product opens on "today" when `phase === "match_day"` | `HM/lib/browser/pages/run-sheet.ts:51-68`; `apps/web/src/components/v2/stages-panel.tsx:556` |
| The console's void: per-row Void and "Void last" both send `core.void {event_id}` | `apps/web/src/components/v2/fixture-console.tsx:1253`, `:1278-1286` |
| `cricketPad` refuses `inningsPerSide !== 1` | `HM/lib/pads/cricket.ts:66` |
| `padProofPlanner` refuses any filter | `HM/lib/pad-proof-set.ts:14-15` |
| `regressionFor` returns the FIRST open matching case | `HM/lib/model/run-cell.ts:157-165` |
| Entrants are `Matrix Player ${i+1}`; the americano note joins the whole roster | `HM/lib/scenarios/common.ts:226`; `HM/lib/scenarios/r4-withdrawal.ts:366` |
| Import guard `scan()`; ROOTS; literals; positive control `perRoot {apps:5, packages:2, scripts:4}` | `scripts/__tests__/tools-import-guard.test.ts:94-177`, `:27`, `:64-73`, `:268-288` |
| `tsconfig.scripts.json` excludes `*.test.ts`; nodenext | `tsconfig.scripts.json` |
| ci.yml `gates`: `fetch-depth: 0`; single-sport at `:113`; matrix unit step `:239-257` | `.github/workflows/ci.yml` |
| e2e.yml recipe: Postgres, db:apply, sync:sports, background build, chromium, standalone server (the placement image and container are NOT copied: ruling 66, D23) | `.github/workflows/e2e.yml:353-800` |
| bench.yml: port 5433, server on 3200, `AUTH_DEV_LINKS: "1"`, no Redis, `NEXT_PUBLIC_SCOREPAD_HOLD_MS: "3000"` at job level | `.github/workflows/bench.yml:59-213` |
| Engine vitest: threads, `isolate: false`, memory-bound workers | `packages/engine/vitest.config.ts:40-66` |
| Engine `tsconfig.json` includes `scripts/**/*.ts` and `test/**/*.ts` | `packages/engine/tsconfig.json` |
| `runtime-deps.test.ts` constrains `dependencies` only | `packages/engine/test/runtime-deps.test.ts:1-20` |

Before building on any line above, the executor pins it again (AGENTS class 5). A line that has moved is a note in the task report, not a blocker. A line whose MEANING is false is a false premise: record it, then continue.

---

## Global Constraints

- **Worktrees and branches.**
  - **PR-A** executes in `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-exec` on branch `feat/format-matrix-w1d-infra`, created from the tip of the planning branch `docs/format-matrix-w1d-plan` (Task 1 Step 0).
  - **PR-B** executes in `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-evidence` on branch `feat/format-matrix-w1d-evidence`, created from `origin/main` AFTER PR-A merges (Task 17 Step 0).
  - Every shell command starts `cd <worktree> && …`, because cwd resets between calls.
  - Never edit the main checkout. **Never `git stash`**: the stash stack is shared.
  - No heredocs. Write commit messages with the Write tool into `$TMPDIR/w1d-msg.txt`, then `git commit -F "$TMPDIR/w1d-msg.txt" -- <paths>`.
  - Every message ends with a blank line, then the `Co-Authored-By:` line the running agent's own system prompt gives (the model that wrote the commit: Sonnet for implementers and fix agents, Opus for the whole-branch review's fixes; never a hard-coded name).
- **pnpm, never npm install.** A fresh worktree has no `node_modules`, so run `pnpm install --frozen-lockfile` first. Two tasks change the lockfile:
  - Task 10 adds `vitest` as a root devDependency, the same range as the engine's, so it is the same package;
  - Task 15 adds the two Stryker packages to `packages/engine`.

  Each lockfile diff is reviewed. No other task touches it.
- **Local verification = ONLY the tests that cover the files you changed** (owner, 2026-09-28). Never the full gate, the full vitest suite, the full e2e suite or `seazn-env gate`.
  - The vitest template, with `<N>` = the task number and `<files>` = the exact test paths:
    ```bash
    cd <worktree> && rm -f "$TMPDIR/w1d-t<N>.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1d-t<N>.json" --testTimeout=30000 <files>; echo EXIT=$?
    cd <worktree> && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const files=r.testResults.map(t=>t.name);const bad=files.filter(f=>!f.startsWith(process.argv[2]));console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,failedSuites:r.numFailedTestSuites,files:files.length,stray:bad}))' "$TMPDIR/w1d-t<N>.json" "$PWD/"
    ```
  - Green means all of: `failed == 0`; `failedSuites == 0`; `passed == total > 0`; `files` equals the number of paths passed; `stray` is empty. Paste the JSON line into the task report, and pin `total`.
  - Never trust `rtk` summaries. `PASS(0) FAIL(0)` is a suite that failed to collect, and vitest positionals are literal filename filters.
  - Engine tests (Task 15) run with `cd packages/engine && ./node_modules/.bin/vitest run --reporter=json --outputFile=… <files>` from the worktree, judged the same way.
- **tsc and eslint on changed files only.**
  - Scoped tsc uses `$TMPDIR/w1d-tsc-<N>.json`: `{"extends":"<worktree>/tsconfig.scripts.json","include":[],"files":[<absolute changed non-test .ts paths>],"compilerOptions":{"incremental":false}}`. Run it with `rtk proxy node node_modules/typescript-native/bin/tsc -p "$TMPDIR/w1d-tsc-<N>.json"; echo EXIT=$?`.
  - After Task 10 lands, test files are also checked with `rtk proxy node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?`.
  - eslint: `rtk proxy ./node_modules/.bin/eslint <changed files>; echo EXIT=$?`. Empty output is clean only with `EXIT=0`. `rtk` hides lint output, so always use `rtk proxy`.
- **`grep -a` always**, through `rtk proxy grep -a …` when the output matters.
- **Strip-types rules.** No `enum`, `namespace` or constructor parameter properties. Error subclasses assign their fields in the constructor body. Every relative import carries `.ts`. Extend `HM/__tests__/strip-types-loadable.test.ts` with each new module, as a `W1D_T<N>` array beside the existing ones.
- **Boundary.** No new import from `tools/bench/**` beyond the existing `http`, `plan` and `env` helpers (R3; `HM/__tests__/boundary.test.ts`). No new relative import of `apps/web` runtime code; product facts are read as text. Nothing under `apps/`, `packages/` or `scripts/` imports or spawns `tools/` (ruling 56; Task 11 closes the spawn gap).
- **Do not touch:**
  - `tools/bench/lib/suites/run-suite.ts` and `PackSchema` (R3);
  - `.github/workflows/e2e.yml` and `bench.yml`;
  - any `apps/web/**` source;
  - any `packages/engine/src/**` file. Task 15 adds config, devDependencies, a script and a test beside `src/`, never inside it.
  - **Committed truth-runs evidence is never edited.** A new run only ADDS a directory and a lock entry (item 1). Task 1 makes that a CI gate.
- **Test authority** (TEST-STRATEGY rules 1–5 and 10; R9, R13, R25):
  - List each task's state transitions and its **empty case first**, then test both. The four questions are a second call, an empty input, after a withdrawal or void, and another sport. For the CI tools, the shapes are: a second run, an empty shard, a shard that died, and another layer.
  - Every judge, sweep, merge and planner reports how many items it checked. **Zero checked is a failure.**
  - Expected values come from the committed catalogue files (`l2-pairs.json`, `drop-list.json`, `variants.json`), the product's own text, the rulings, or the design. **Never from the code under test.** Where one can, pick a case where the right answer differs from the wrong one's constant.
  - "Cannot happen" becomes a named refusal, plus a test that reaches it.
  - **Rule 10.** This wave's ordered-action surface is the shard partition and its merge, so Task 4 gets a fast-check property: for any plan length and any N, the merged shards equal the plan, in order. A shrunk failure is committed as a named case with its seed BEFORE the fix.
- **Mutation** (R17). Each task's last test step lists `mutant → killing test`.
  - Back up with `cp <file> "$TMPDIR/w1d-bak-<name>"`, mutate, run the named test file, and see it red (pin `total` and `failed`). Then restore with `cp "$TMPDIR/w1d-bak-<name>" <file>`.
  - **Never** `git checkout <file>`.
  - Mutate each new guard once. Mutate two guards that cover for each other one at a time.
- **Budgets are derived, never flat** (class 20). A shard job's `timeout-minutes` comes from `shard-matrix.ts`: `setup + ceil(driven × perCaseCeilingS ÷ workers ÷ 60) + slack`. Each layer's per-case ceiling is read from committed evidence (Task 8), never typed into the workflow.
- **The repo is public** (R14a; design §6.4). Every CI log and artifact is public. It goes private after W1d (ruling 68, D24), so the runner is switchable now.
  - Synthetic identities only: `delivered+matrix-<runId>@resend.dev`, "Matrix Player N" / "Matrix Team N".
  - Never echo `DATABASE_URL`, a cookie, a magic link or a token.
  - Every text writer goes through `redact()`, and results still refuse on `findSecrets()`.
  - No Playwright trace is ever uploaded (D16).
  - The CI DB URL is a CI-only dummy (`postgres:postgres@localhost`), as in `bench.yml`.
- **Live runs** (Tasks 12, 14, 16 locally; Tasks 17, 20 in CI) follow `~/.claude/skills/seazn-local-env/SKILL.md`:
  - a fresh DB via `db:apply` + `sync:sports`, with `BENCH_EXPECTED_DATA_DIR` = `show data_directory` (confirm it is yours);
  - no `REDIS_URL`; PostHog and Sentry blanked; `AUTH_DEV_LINKS=1`;
  - a prod build with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`;
  - `SMOKE_BASE=http://localhost:<port>`, never 127.0.0.1, never port 3000 or 3100;
  - a fresh run id and a clean tree before evidence runs;
  - every command writes `EXIT=$?` itself.
- **Owner rulings are binding:**
  - 19 (wave done; product reds are recorded, never fixed);
  - 20 (weekly L1+L2+L3 while public);
  - 39 (L1 at 1280);
  - 46 (workers in-process; W1d owns shards);
  - 47 (the full L1 grid is W1d's);
  - 56 (`tools/` boundary; evidence stays in `docs/`);
  - 58 as clarified;
  - **60–67**.

### The four test types, as they apply here

| Type | Meaning in W1d |
|---|---|
| Unit | DB-free tests under `HM/__tests__/` for the planners, shard, merge, judge, exit table, pr-sample and pr-rows, shard-matrix, summary, staleness and the visibility guard. The workflow steps run against stand-in `gh`/`vitest` binaries, as `ci-wiring.test.ts` does today. Also `scripts/__tests__/tools-import-guard.test.ts` and `packages/engine/test/stryker-*.test.ts`. |
| E2E / live | `matrix-truth.yml` proves itself on PR-A through its own `pull_request` trigger (smoke scope: all three layers, two shards each, merge, judge). Task 14's browser carries run live at 1280 and 320. PR-B's three full dispatches are the wave's E2E. |
| Smoke | The HTTP slice re-run on PR-A's head equals `w1drv-http-slice` in every state (Task 16 Step 2). The per-PR sample itself is a smoke on every engine-touching PR. |
| Regression | Committed runs stay judged against `plans.lock.json`, which Task 1 makes append-only in CI. The model's `--regressions` replays MB-001..MB-010 as known (Task 13). The per-PR sample judges every ✅/⛔ case of the committed baseline (Task 7). |

---

## Review Focus

These are the five failure modes most likely to bite a person using this system (the owner reading the weekly summary, a W2 implementer reading their backlog) that no functional test exercises. Each one's pinning test sits in its owning task.

1. **A shard that ran nothing reads as green.** Three ways it happens: a killed step exits 0; a shard dies before writing `results.json`; or a shard that planned 23 cases writes 14 (an abort). Expected: the merge refuses a missing `exit.txt`, an `exit.txt` other than `0`, a missing or empty `results.json`, an `aborted` header, and a shard whose case count is not its stripe's derived size. A run with any refused shard is harness-red. Pinned by `merge.test.ts`, "a shard that died, a partial shard, a stray shard: each refused by name" (Task 4).
2. **The visibility guard fails open.** (Ruling 68: it fails only when the repo is private AND the runner is `github-hosted`; a `self-hosted` runner passes, and the repo goes private after W1d.) Ways it could: a `schedule` payload with no `repository` object; a `gh api` that 403s or prints nothing; `runner.environment` unset; a dispatch input that tries to inject `public`. Expected: the guard reads visibility through `gh api`, treats unreadable as not public, exempts only an exact `self-hosted` runner (no hosted minutes billed), and refuses an injected `public`. The per-PR sample is NOT exempt: on a private repo it fails loudly too. Pinned by `matrix-workflow.test.ts`, "the guard fails closed: unreadable, 403, private, internal, injected public, unset runner" (Task 9), and live by Task 17's injected-`private` dispatch.
3. **A state that differs across the three runs for a PRODUCT reason.** The W7 note says mexicano pairing ties break on random person UUIDs. Expected: `judge.ts across` names each differing case with its state per run, and harness-green stays RED per ruling 61. The executor never averages, never re-runs until it agrees, and never classifies a difference away. The difference goes to the owner (Task 17 Step 6). Pinned by `judge.test.ts`, "a case whose state differs in one run of three is named with all three states, and the verdict is not green" (Task 6).
4. **The per-PR sample blocks an unrelated PR, or passes a real regression.** Ways it could: a stale baseline; a flaky ✅ case; a known red that stays red; a case missing from the sample. Expected: only a ✅/⛔ → anything-else move is a regression. It is re-run once, and only a reproduced regression fails. A baseline case absent from the current run is a refusal, not a pass. Pinned by `judge.test.ts` "regression: known red stays red passes; ✅→❌ fails; ✅→❌→✅ on re-run passes; missing case refused" (Task 6), and `matrix-workflow.test.ts` "the sample re-runs a regressed case once before failing" (Task 9).
5. **A public log or artifact leaks something.** The candidates: `DATABASE_URL`, a magic link, a cookie, a Playwright trace (it holds cookies and request bodies), or a server log. Expected: no step echoes a secret-shaped env value; uploaded paths are an explicit allow-list (`results.json`, `MATRIX.md`, `exit.txt`, `shots/**/*.png`, `SUMMARY.md`) and never `trace.zip`; `MATRIX_TRACE_ON_TIMEOUT` is never set in a workflow; every new writer goes through `redact()` + `findSecrets()`. Pinned by `matrix-workflow.test.ts` "upload paths are an allow-list; no trace; no step echoes a DB URL or token" (Task 9) and `merge.test.ts` "a secret-shaped string in a shard is refused" (Task 4).

---

## False premises found in planning

Each has file:line evidence. They go to `_INDEX.md` "False premises found" under a new "### Found during W1d planning" (Task 16 Step 3).

1. **Item 4: "every case the layers build carries `run: null`."** Partly false. The four cited lines (`layers.ts:105`, `:220`, `:255`, `:278`) are the non-L2 planners. `planL2` has set `run` on every L2 case since W1c `64ae38f4d` (`layers.ts:149`). The inert half holds: `run.ts` never reads `c.run`, and `CaseSchemaV3` (strict) would refuse `n`/`covers`. Task 2 records them.
2. **Item 7: "5 pre-existing errors in `scenarios.test.ts`" is the whole of it.** The scope moved and widened. The tests now live in `tools/`, and `tsconfig.scripts.json` includes `tools/**` (excluding only `*.test.ts`). A test-inclusive TS7 program reports 124 errors:
   - 5 in `HM/__tests__/scenarios.test.ts`;
   - about 90 in `tools/bench/**/__tests__`;
   - 3 in `scripts/__tests__`;
   - 18 in `apps/web` (`queue.ts` 7, `use-pad-pipeline.ts` 11), pulled in by three matrix tests that import the pad queue, under nodenext rules the app does not use;
   - 4 environment artifacts in `tools/bench/lib`.

   `vitest` is not a root devDependency either; a stale root `node_modules/vitest` in the main checkout made the local probe resolve it. → D9, Task 10.
3. **`counts.json` L1 = 462, "cells × 2 widths (1280, 320)".** This contradicts ruling 39 and `widths.ts` (L1 at 1280 only). `committed-catalogue.test.ts:271` pins `CELLS * 2`: a test that froze the stale value (class 4). → Task 3.
4. **"The wave that adds the weekly schedule must invert `ci-wiring.test.ts`"** (decision log). The test reds on ANY workflow mentioning `matrix:l3` or `tools/matrix/run`, so a dispatch-only workflow reds it too (`ci-wiring.test.ts:244-252`). → Task 9.
5. **"Following `bench.yml`'s precedent (R84): three consecutive green manual dispatches."** `bench.yml` has never been dispatched: 0 `workflow_dispatch` runs; all 15 runs are `pull_request` self-path runs, 9 green and 6 red (`gh run list`, 2026-10-04). The R84 bar was never met, and no cron was ever added, so there is no worked example of the three-dispatch gate. W1d's Task 17 is the first.
6. **W1d prompt: "The design does not say what 'green' means."** False. Design §6.5 (D:326-331) defines harness-green, including "case states are identical across the three runs". Ruling 61 adopts it. The prompt's shorter suggestion dropped the identical-states clause.
7. **W1d prompt and item 27: "The trigger must NOT be GitHub `schedule:`."** Superseded by ruling 60 (GitHub `schedule:` + `workflow_dispatch`, and a staleness signal, D1).
8. **W1d prompt: every ❌ "carries its gap ID", as if the reds already did.** W1-driving's 164 product reds are keyed by triage rule P1–P7 and coverage-table signatures, not audit IDs (`TR/w1drv-l3/TRIAGE.md`; `_INDEX.md` "Every product red"). Audit IDs appear only inside rule prose (P1 "SC-O1/SC-O2", P6 "SW-H1"). → ruling 63, Task 19.
9. **`plan-facts-repo.md` §5's paths** (`scripts/bench/…`, `scripts/matrix`) predate the `tools/` move (#913, #914). The facts still hold at the new paths.
10. **"Evidence moves out of `docs/` with the harness."** It stays: ruling 56 was amended on 2026-10-04 (12 MB, read by 12 CI test files). New W1d evidence goes under `TR/`, and new directories must not use the `w1drv-` prefix, because `rebase-map.test.ts:81` requires every `w1drv-*` harness commit in the W1-driving rebase map.
11. **"Exit 1 means the same thing in every CLI."** It does not:
    - `findings-table.ts` and `draw-counts.ts` use 1 for "refused";
    - `run.ts` uses 1 for "zero cases";
    - `model.ts` uses 1 for "a NEW failure";
    - `gen-catalogue.ts` uses 1 for "drift".

    Unreadable input is 3 in `parity.ts` (`:58`, `:70`) and 2 in `render.ts` (`:55`). → D8, Task 6.
12. **RULING CONFLICT, ruling 64 × ruling 61: "L2 = all 1,731 pair-runs" and "no ░".** Only 62 of the 1,731 runs have a harness script (M1 21, R4a 21, F1 20). `l2-pairs.json` holds no LIFECYCLE atom. 164 runs plan 🚫 (a named wave owes the path) and **1,505 plan ░ "no scenario script yet"** by construction (`layers.ts:139-160`). Read literally, ruling 61's "no ░" can never hold on the full L2 scope. **Resolved by owner ruling 65 (2026-10-04, `_INDEX.md:919`):** "no ░" applies to driven cases only; the 1,505 planned ░ runs do not make a run harness-red. → D7.
13. **"The full L1 grid is 231 driven runs."** 53 of the 231 cells are API-only with no builder control, so they plan 🚫 naming W4 or W5 (`api-only-ui.ts`). The 2 template-reachable cells drive through their gallery cards. So L1 = **178 driven + 53 🚫**, and that is still 231 cases (ruling 64's count holds).
14. **"Item 15: forfeit and withdraw on league and knockout in the browser are unbuilt."** Half false. The full-grid L2 already drives M1 and R4a on `league|football` (M1@430, R4a@390) and `knockout|icehockey` (M1@834, R4a@768): runs 408, 64, 417 and 73 of `l2-pairs.json`. The 1280 half is still owed. → Task 3 pins the four runs; Task 14 Step 7 adds the 1280 proof.
15. **"Void is a product path the harness never reached."** No `OrganiserDriver` method voids anything. The product's void is `core.void {event_id}` from the fixture console (per-row Void, and "Void last", `fixture-console.tsx:1253,1278-1286`). It is reachable in the browser; the harness simply never had the method. → D15, Task 14.
16. **The cited lines for item 15 drifted.** `run.ts:468-469` is now `run.ts:561`, and `lib/pad-proof-set.ts:16` is now `:15`. The meaning holds.
17. **"A scheduled run's payload carries the repository."** Unverified, and design §6.5 assumed it. The guard does not depend on it: it reads `gh api repos/$GITHUB_REPOSITORY --jq .visibility`. Task 17 Step 5 records what the first scheduled run's `github.event` actually held.
18. **"The Cloudflare cron worker can fire the weekly run."** It can only `POST ${BASE_URL}${path}` with `x-cron-secret` (`apps/cron-worker/src/call.ts:92-94`). It has no GitHub API target. This was moot after ruling 60; it is recorded so the option is not re-offered.
19. **Design §7.5's "scheduling, competition and tiebreaker modules" are three directories.** They are two: `tiebreakers.ts` lives in `packages/engine/src/competition/`. (Review 3, rulings 66 and 67: "engine scheduling" reads as draw generation, not placement. The Stryker scope is the whole engine except the placement files under `src/scheduling/`.)
20. **W2 prompt trap 2** ("declared 3/0 loses to the FIH 2/1 the rulebook adopts", SC-P4) contradicts the SC-P4 false premise (`_INDEX.md:1362-1366`) and design §8 ("FIH 2/1 is Pro League only"). It is not W1d's to fix. Task 22 records it beside the W2 backlog for W2's planner.
21. **(Found in review fix round 1.) "The 11 `RefusedCall` reds in `w1drv-l3` are a harness-seeding shape"** (plan review 1, m7). They are not. All 11 are `POST /api/v1/entrants/<id>/withdraw → 422`, the R4 scenario's withdraw action (P5 → W4), counted at HEAD with Task 6 Step 0's one-liner. They are the product answering a scenario action, so they stay data. The setup-call guard the review proposed is adopted anyway (`SetupRefused`, tagged by phase at the setup seam; D6, review 2 R2-I2), because a refused SETUP call would be a harness fault, and none exists today to witness it.
22. **(Found in review fix round 1.) "bench.yml builds the placement image with a `type=gha` cache"** (bench.yml:141's comment; ci.yml:594, 1080 and e2e.yml:612 say the same; plan review 1, I13). No workflow at HEAD sets `cache-from:` or `cache-to:`. `rtk proxy grep -an "cache-from:\|cache-to:" .github/workflows/*.yml` matches comments only. What IS load-bearing is `docker/setup-buildx-action@v3` before `build-push-action` (bench.yml:143, e2e.yml:614). Task 9 copies bench's step unchanged and adds buildx, and does not invent a cache the source never had. **Moot under ruling 66:** the placement image is no longer built in W1d (D23), so neither buildx nor a cache is needed.
23. **(Found in review 3.) "The greedy-fallback guard proves the solver is reachable and used"** (fix round 2, R2-I1). It proved nothing. The step counted server-log lines and fallback lines, never solver attempts, so with zero solver calls it printed `placement fallbacks: 0` and passed on every run. The matrix drives no solver route (D23), and the guard was vacuous before ruling 66 removed it. Round 2's own Step 0 note ("the task report says plainly whether today's run exercised it") was a disclosure standing in for a check, which TEST-STRATEGY rule 1 does not accept.

---

## Decisions

**Ruled: 60 (2026-10-04).** The weekly trigger is the truth workflow's own GitHub `schedule:` plus `workflow_dispatch`. There is no Cloudflare worker and no app route. A missed week must still be visible (D1). → Task 9.

**Ruled: 61.** Harness-green is design §6.5's definition:
- every shard completes;
- every case reports a state, with no ░ and no harness error;
- case states are identical across the three runs.

Product reds are data. → Tasks 6, 17. Narrowed by ruling 65 (D7).

**Ruled: 62.** One plan, two PRs. PR-A is Tasks 1–16 and PR-B is Tasks 17–22. PR-A merges by the owner's hand, and PR-B is cut after.

**Ruled: 63.** Every ❌ carries an audit gap ID (`SW-`/`FX-`/`ST-`/`SC-`/`SH-`) or `NEW-W1d-<n>`, with its owning wave from §8. Triage never re-routes a gap §8 already assigns. W1-driving's 164 reds are re-keyed in the same pass. → Tasks 18, 19.

**Ruled: 64.** Full scope:
- L1 is 231 cells at 1280, and `counts.json` moves from 462 to 231;
- L2 is the 1,731 runs of `l2-pairs.json`;
- L3 is the 937 W1-driving cases.

Each job is one shard on a fresh Postgres with `sync:sports`, about 12 shards, with explicit `timeout-minutes` well under 360. → Tasks 3, 4, 8, 9.

**D1 — The staleness signal (ruling 60's "a missed week must still be visible").** Two halves:
- **(a)** Every run's `SUMMARY.md` (also the job summary) opens with "Previous complete weekly/dispatch run: `<date>` (`<n>` days ago) — run `<id>`". `summary.ts` reads it from `gh api …/actions/workflows/matrix-truth.yml/runs?status=success`.
- **(b)** `ci.yml`'s `matrix-rows` job carries a NON-BLOCKING step. When `vars.MATRIX_WEEKLY_ENABLED == 'true'` and the newest successful `schedule`/`workflow_dispatch` run of `matrix-truth.yml` is older than 8 days (or none exists), it emits `::warning title=Matrix truth run is stale::…` on every PR. It never fails the PR, and an API failure warns rather than fails.
- Owner value: a skipped or broken week shows on the next PR, at the cost of one API call, with no new service.
- Rejected:
  - a scheduled "watchdog" workflow (it can be missed the same way);
  - failing the PR (it would block unrelated work on CI's weather).

**D2 — Shipped disabled: the gate is `vars.MATRIX_WEEKLY_ENABLED`.**
- `matrix-truth.yml` declares `schedule: - cron: "17 2 * * 6"` (Saturday 02:17 UTC: "overnight at the weekend", design §6.5).
- Its first job, `plan`, carries `if: github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true'`. Every other job `needs: plan`, so a schedule that fires while disabled is a visible run of skipped jobs.
- `mutation.yml` uses the same variable (`cron: "23 3 * * 0"`, Sunday).
- PR-B's "schedule enabled" is the owner running `gh variable set MATRIX_WEEKLY_ENABLED --body true`. The controller records the time and the first scheduled run id in `_INDEX.md` (R22).
- Owner value: the schedule can be switched off in seconds without a PR if it ever turns noisy, and switching it on is one reviewed, recorded act.
- Rejected:
  - a commented-out `schedule:` (invisible: nothing fires, nothing shows);
  - a committed flag file (a PR to switch off).

**D3 — The workflow proves itself on its own PR.**
- `matrix-truth.yml` and `mutation.yml` also trigger on `pull_request` with `paths:` limited to their own files and `tools/matrix/ci/**` (`bench.yml`'s precedent, `bench.yml:17-22`).
- On that event `matrix-truth.yml` runs the **smoke** scope:
  - L1 `--layer L1 --scope slice` (6);
  - L2 `--layer L2 --scope slice` (68, 3 driven);
  - L3 `--set pr-sample` (the fixed sample, 33).

  Each layer is split into **2 shards**, so the partition, merge and judge are exercised with N > 1. `mutation.yml` runs its `probe` group.
- Owner value: PR-A cannot merge an untested workflow, because `workflow_dispatch` fires only from `main` (ruling 62). The self-proof costs one ~20-minute run per edit of those files.
- Rejected: proving it only after merge (the bench's "proved after merging untested" trap).

**D4 — Shards: a stripe of the plan, sized per layer, committed.**
- `tools/matrix/ci/shards.json` holds `{L1: 8, L2: 2, L3: 2}` = **12 shard jobs** for the full scope, plus per-layer timing ceilings read from committed evidence.
- Sizing, derived in Task 8 and re-derived in PR-B from measured times:
  - **L3:** 937 cases. On 4 workers, Σ 3,943 s ran in 988 s locally (`w1drv-l3`), so 2 shards are ~8–10 min of cases each.
  - **L1:** 178 driven at 1 browser worker. The committed max per case is 132.7 s, across the six `TR/w1drv-l1/w1drv-l1-*` sub-runs (the directory has no top-level `results.json`), and the median is 15–21 s. So 8 shards hold ~23 driven each.
  - **L2:** 62 driven of 1,731 planned, so 2 shards drive ~31 each. Planned cases cost 0 s (`recordPlanned`).
- **A budget counts DRIVEN items, per stripe** (review C2). Each job's timeout comes from the driven count of ITS stripe, so the stripe with the most driven items sets the largest timeout. Counting planned items would budget L2 at 18 + ⌈866 × 30 / 60⌉ + 10 = 461 min, which is over the cap and refused.
- Each shard keeps `--workers 4` on L3 and 1 on L1/L2 (D11).
- Owner value: wall clock stays under ~1 h at $0. A stripe balances slow rows across shards, and the same case always lands in the same shard, which ruling 61's per-case comparison needs.
- Rejected:
  - contiguous blocks (all cricket `test` cases land in one shard);
  - hash partition (stable, but harder to verify and unbalanced on small plans).

**D5 — One merged result per layer, one summary per run.** `results.json` has a run-level `layer`, so L1, L2 and L3 merge separately into `merged/<layer>/{results.json, MATRIX.md}`.
- The merged header records `shards: N` and the plan WITHOUT `--shard`. Each shard's header records `shard {index, of, planSize}`.
- `SUMMARY.md` spans all three layers: histograms, harness verdict, timings, staleness and the diff against the previous green run.
- Owner value: each layer's `MATRIX.md` is exactly what a one-machine run would have written (R10: generated, never hand-edited), and the committed baseline's lock entries are per layer.
- Rejected: a cross-layer results.json (a schema change for no reader).

**D6 — What counts as a harness error** (ruling 61's "no harness error"; `judge.ts` `harnessFaults`). A harness fault is any of:
- **crash:** a red whose reason starts `error: crashed —` (`run.ts` `crashResult`);
- **harness error:** a red whose reason starts `error: ` but not `error: RefusedCall:`. A `RefusedCall` is the product answering, so it is data (for example P5's `422 WRONG_PHASE`). Anything else (`DriverMisuse`, a timeout, a TypeError) is the harness or the environment;
- **vacuous:** a red whose reason is one of `decideState`'s three vacuity reasons (`results.ts:256,260,262`). They are matched as `decideState` writes them: two exact strings, and `checked zero items (vacuous): <ids>` by PREFIX, because it carries a suffix (review I3). The strings are exported from `results.ts` as `VACUOUS_REASONS` and imported by the judge, never retyped;
- **setup refused:** a red reading `error: SetupRefused: …`. The tag is set by PHASE, never by route (review 2, R2-I2). Route shape cannot tell setup from action: DENIED's action is `POST /api/v1/divisions/<id>/stages` (`scenarios/denied.ts:64-77`), which is exactly a setup route elsewhere.
  - `setUpDivision` (`scenarios/common.ts:196`) runs every driver call it makes BEFORE `driver.start` inside one `inSetup(…)` wrapper. Those are `createFromTemplate`, `createCompetition`, `createDivision`, `postStages`, `addEntrants` and `entrantMembers`.
  - The wrapper rethrows a `RefusedCall` as `SetupRefused`, a SUBCLASS of `RefusedCall`. Every existing `instanceof RefusedCall` catch therefore behaves as before, while `run.ts:458`'s `errText` writes the subclass's name into the reason.
  - **Construction (review 3, R3-m2).** `RefusedCall`'s constructor (`types.ts:236-252`) composes `${method} ${path} → HTTP ${status} ${code}: ${message}` and keeps no raw message. Rebuilding with `new SetupRefused(e.method, e.path, e.status, e.code, e.message, …)` would double that prefix and redact twice. So `SetupRefused.from(e: RefusedCall)` passes the same fields with a `null` message, plus `featureKey` and `extra`, then sets `this.message = e.message` (already redacted) and `this.name = "SetupRefused"`. The e2e test asserts the WHOLE reason equals `error: SetupRefused: ${original.message}`, not just its prefix.
  - **DENIED's own setup (review 3, R3-m3).** `scenarios/denied.ts` does not use `setUpDivision`, but its `createCompetition` (`:63`), `createDivision` (`:64`), the second `createDivision` (`:76`) and the working-stage `postStages` (`:77`) are setup. `:77` is the shape the route cannot tell apart: it is the same route as the action under test at `:67`. `inSetup` is exported and wraps those four calls. The action at `:67` stays outside it, so its gated refusal is still data.
  - `driver.start` stays OUTSIDE the wrapper. Start is the product's own generate act (STAGE_NOT_READY and the like), so its refusal is data. DENIED does not call `setUpDivision`, so its gated `postStages` stays data.
  - A refused setup call means the harness asked wrongly (review m7), with two known limits (review 3, R3-m4). A RefusedCall anywhere else stays data. All 11 RefusedCall reds in `TR/w1drv-l3` are `POST /api/v1/entrants/<id>/withdraw` (the R4 action; P5 → W4), so they stay data;
  - **Limit 1: a harness mistake read as data.** `start` stays outside the tag, so a harness that asked wrongly AT `start` is labelled data. `TR/w1b-probe/results.json` holds `page_playoff_only|generic|score|LIFECYCLE`, red `POST /divisions/<id>/start → 422 CONFIG_INVALID: page playoffs need exactly 4 entrants, got 8`. That is the harness seeding the wrong roster size, and D6 classes it as data.
  - **Limit 2: a product defect read as a harness fault.** A catalogue-valid `postStages` body that the product refuses through a defect reads as `setup-refused` and blocks PR-B's harness-green count, and no wave inside W1d can fix a product defect.
  - **The route for both (Task 18 Step 3).** The triage reads the message of every `start` `CONFIG_INVALID` red before assigning a wave. A `SetupRefused` diagnosed as the product refusing a catalogue-valid body gets a named route: an owner ruling and a `NEW-W1d-<n>`, never "fix the harness";
- **unplanned ░:** `not_run` without the `planned: true` marker (Task 2);
- **run-level:** a missing, partial or aborted shard (`merge-shards.ts` refuses).

⏳ `later` and 🚫 `no_path` are data (they name a wave). ⬜ `needs_ruling` is data too: it names a missing decision (R12), and triage routes it to the owner, not to a wave (review m4). Each class is a named test.
- Owner value: "harness-green" is mechanical, so nobody judges it by eye.
- Rejected: reading exit codes alone (a shard that exits 0 with 40 crash reds is not green).

**D7 — RULED 65 (2026-10-04, `_INDEX.md:919`; owner "ok" to recommendation (a)). Ruling 61's "no ░" applies to driven cases only.**
- The 1,505 L2 runs whose atom has no harness script are planned ░ (marker `planned: true`). They are recorded as the plan says, counted in `SUMMARY.md` per atom, and do not make a run harness-red.
- A ░ on a case the plan DRIVES, meaning a ░ without the marker, is still harness-red (D6, "unplanned ░"). Task 6 pins it with a test.
- The judge applies it as `--planned-not-run allow`, which is the default and is written explicitly in `matrix-truth.yml` with a comment citing ruling 65. `refuse` stays only as the mutation lever that Task 6's tests use. No workflow passes it.
- Rejected by the ruling:
  - (b) shrinking L2 to the drivable runs (it hides the backlog);
  - (c) the literal reading (the schedule could never be enabled).

**D8 — One exit convention (item 6): run.ts's.** Every matrix CLI uses:
- **0:** done, a verdict or data;
- **1:** a negative signal (difference, drift, zero cases, a regression, a harness fault);
- **2:** refused, nothing written (usage, **unreadable input**, a refused precondition);
- **3:** aborted after start, or a load crash.

Three CLIs change:
- `parity.ts`: unreadable input 3 → 2;
- `findings-table.ts`: refused 1 → 2, unreadable 3 → 2;
- `draw-counts.ts`: refused 1 → 2, unreadable 3 → 2.

`gen-catalogue.ts`, `single-sport.ts`, `render.ts`, `run.ts` and `model.ts` already fit. One declared table, `HM/lib/exit-codes.ts`, is pinned against each CLI's header, so the CI wrapper reads one meaning per code (W1b's "key on which CLI" becomes a table lookup, not a switch).
- Owner value: a red CI step means the same thing whichever tool printed it.
- Rejected: a per-CLI switch in the wrapper (the drift the table removes).

**D9 — Item 7's scope.**
- A new `tsconfig.tools-tests.json` type-checks `tools/matrix/**` and `scripts/**` INCLUDING tests, under `moduleResolution: "bundler"` + `module: "preserve"`. That resolves the 18 apps/web errors, which are nodenext-only artifacts of reading app code; the app itself is bundler.
- `vitest` becomes a root devDependency, the same range as the engine's, so `scripts/__tests__` resolve it in CI.
- The 5 `scenarios.test.ts` errors and the 3 `scripts/__tests__` errors are fixed.
- `tools/bench/**` tests are excluded and recorded in `_INDEX.md` as a carry for the bench programme (~90 errors; no issue filed).
- Owner value: the matrix's own test code is checked at last, without W1d absorbing the bench's debt.
- Rejected:
  - including bench (it doubles the task, and it is another programme's code);
  - nodenext for tests (18 false errors in app code).

**D10 — The lock is append-only, in CI (item 1).** `HM/lock-append-only.ts --against HEAD^1` runs in `ci.yml`'s `gates` job, directly after `npm run reference:boundary`. That is not directly after the single-sport ratchet, because `ci-wiring.test.ts:351` pins `reference:boundary` as the line immediately after the ratchet (review I5). Every entry present in the base's `plans.lock.json` must be byte-identical in the head, and any number of entries may be added. A removed or edited entry exits 1 and names the run.
- Owner value: the re-review's tamper (an existing entry and its results edited together) turns from "review must notice" into a red CI step.
- Rejected: review-only (it already missed one).

**D11 — Browser workers and `MAX_WORKERS` (items 17, 18): recommend declining in favour of shards. This is a recommendation, put to the owner in PR-A's body (Task 16 Step 3), because the owner listed items 17 and 18 (review m8). If the owner wants browser workers, they become a W1d follow-up task; nothing else in the plan depends on the answer.**
- L1/L2 shards run one browser case at a time, and parallelism comes from the job matrix.
- `BROWSER_WORKERS = routeTo("W1d", …)` is removed (W1d closes; the Q-A guard would red a route to a closed wave). The D10 refusal's text becomes "one browser case at a time per shard; parallelism is the shard matrix (W1d D11)".
- `MAX_WORKERS` stays 8.
- Owner value: no unmeasured contention on pad holds, and wall clock is bought with free jobs instead.
- Rejected: building browser workers now (an inert seam until measured, class 1).

**D12 — Redis (item 19): no Redis in any matrix job, pinned.**
- `matrix-truth.yml` declares no `redis` service and sets no `REDIS_URL`; a test pins both.
- Each shard is its own runner, with its own source IP, so the 5-per-300 s magic-link budget applies per shard (5 sign-ins on L3's 4 workers + 1).
- The `--workers` refusal stays unbuilt, as the W1-driving recommendation said.
- Owner value: the threshold can never be met by accident in CI.

**D13 — The per-PR sample (R27).**
- `ci.yml` gains two jobs:
  - `matrix-rows`: reads the PR body's `Matrix rows:` line LIVE (`gh api repos/$REPO/pulls/$N`, never the event payload: `ci.yml` listens to the default `pull_request` types, so a body edit fires no run, and a re-run replays the ORIGINAL payload with the old body; review 3, R3-m1) and the changed files;
  - `matrix-sample`: calls `matrix-truth.yml` with `scope: pr-sample`.
- **Rows:** R27 says a PR touching `packages/engine/**` or `apps/web/src/server/usecases/stages.ts` declares its rows. `pr-rows.ts` enforces it:
  - no declaration on such a PR → exit 1, which fails the job;
  - `Matrix rows: none — <reason>` is allowed;
  - `all` means every row.
- **The sample** is `--set pr-sample --rows <rows>`: the w1-driving cases on the declared rows, plus a fixed sample of 33. The fixed sample is the 24 slice cases plus `league|<sport>|<variantFor(sport)>|LIFECYCLE` on the 9 sports the slice lacks. `variantFor` is the run's own builder-default reader, the one authority for the variant (review m10).
- The job runs only when a paths filter matches: `packages/engine/**`, `apps/web/src/server/**`, `apps/web/src/lib/format-templates.ts`, `tools/matrix/**` or `pnpm-lock.yaml`.
- **Judged** against the committed baseline's L3 (`HM/catalogue/baseline.json` names it: `TR/w1drv-l3/results.json` until PR-B replaces it with `TR/w1d-baseline/L3/results.json`). The baseline is restricted to the EXACT case ids the sample plans. `run-sample.ts` writes them from `planPrSample(rows, offlineBuilderDefault)` before it runs, and `judge.ts regression --expect <ids.json>` uses them. A cell filter would also pull in the baseline's three `league|cricket|test|LIFECYCLE|cricket#…` cases, which the fixed sample does not plan, so every PR would report them absent (review C3c).
- **Re-run:** when the judge finds a ✅/⛔ case in any other state, the WHOLE sample is re-run once under a fresh run id, and only a move that reproduces fails. `run.ts --only` takes one cell, so re-running only the regressed cases would mean one process per cell. The pr-sample job's derived timeout therefore budgets two passes (`shards.json` `"passes": 2`; Task 8; review I10).
- Owner value: an engine PR learns on its own PR whether it broke a case that worked. Task 7 Step 4 measures how long one pass takes on the local env, and that measured time, not a guess, is what PR-A's body quotes.
- Rejected:
  - every PR (most touch only UI copy);
  - failing on the first red (flaky-shaped gates are run again, class 8).

**D14 — Stryker lives with the engine, ten groups plus a probe, incremental (rulings 66, 67).**
- `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` (exact `10.0.0`) become devDependencies of `packages/engine`.
- `packages/engine/stryker.config.mjs` reads `STRYKER_GROUP`. `packages/engine/stryker.groups.mjs` declares ten groups plus a `probe` group: `competition`, `core`, `modules` (sport, stats, history, officials, import, exports), `draws` (the seven draw generators) and six `sports-*` groups that split `src/sports/` by sport family. A sweep test gives every non-test `.ts` under `packages/engine/src` exactly one home: a group, a named exclusion with its own reason, or the ruling-67 placement exclusion (19 files: build, calendar, repair; "low priority", liftable). `testkit/` is excluded as test helpers. Unclassified files fail the test, and the failure reports their count. The probe is `src/scheduling/roundrobin.ts`.
- `mutation.yml` runs one job per group, each with `--incremental` and its incremental file cached across weeks, with a per-group `timeout-minutes` derived from the dry run (PR-A) and then from measurement (PR-B), capped at 300. One matrix per event: a PR runs `probe`, the schedule and dispatch `all` run the groups, and a dispatch `group` input selects one.
- Floors are per group in `packages/engine/stryker-floor.json`, checked by `packages/engine/scripts/stryker-floor.ts`. A floor is never lowered: the `--check-file-against HEAD^1` mode runs in `ci.yml` `gates`.
- Survivors are listed in `SURVIVORS.md` per group. Equivalent mutants are recorded in `packages/engine/stryker-equivalent.json` by `file:line:col mutator → replacement`, never by Stryker's unstable ids.
- Estimate before measuring, and only an estimate. As a rough proxy, about 33k non-test source lines are in scope; at roughly 0.67 mutants per line that is on the order of 22k mutants. Every job pays one dry run, which is the engine suite with coverage: 5 m 44 s (344 s) on CI. With per-test coverage a mutant runs only its covering tests, taken at 1–10 s in one sandbox (10 s is the pessimistic bound, since the sports kernels sit under replay suites). Concurrency is 3 on `ubuntu-latest` (4 cores, 16 GiB, one vitest worker per sandbox). So a group's job takes about `344 s + mutants × t ÷ 3`. For a group of 4,000 mutants that is 344 + 4,000 × 10 ÷ 3 = 13,677 s = 228 min at the bound and 344 + 4,000 × 2.5 ÷ 3 = 3,677 s = 61 min at 2.5 s, so the first-run timeout (from Step 4's estimate, capped at 300) is a ceiling and not a prediction. The estimate is then dropped: Task 15 Step 4's dry run gives the true mutant count per group (PR-A), and Task 20's first full run gives the true wall time per group (PR-B). The shard sizes, the timeouts and any further split follow those measurements, never line counts. A group over 200 min measured is split (Task 20 Step 2).
- Owner value: mutation sits beside the code it measures, and weekly reruns stay cheap.
- Rejected:
  - a `tools/mutation` workspace (Stryker's sandbox cannot mutate files outside its cwd);
  - root-level Stryker (the sandbox would copy the whole monorepo).

**D15 — Void in the browser (item 15e): the console's "Void last", as a capability proof.**
- A new driver method `voidLast(fixtureId)`:
  - HTTP: `core.void {event_id}` on the newest voidable event;
  - browser: the console's "Void last" control.
- A new proof scenario `VOIDPROOF` and a set `void-proof` (league|badminton at 1280 and 320, 2 cases) score one event, void it, check the ledger and the fold, then finish as LIFECYCLE.
- The M7 atoms ("void a decided result") keep their ░ until the wave that owns their rulebook writes their scripts.
- Owner value: the organiser's undo is proven end to end in the browser, without W1d inventing M7's rulebook.
- Rejected: scripting M7 here (rule semantics owned by later waves).

**D16 — F-PP-1 diagnostics (item 15a): timestamps always, trace local-only.**
- Every pad tap records `{tap, clickedAtMs, ledgerSeenAtMs | null, waitedMs, budgetMs}`, relative to the case start.
- A tap-wait timeout throws with the last 5 taps' timings in its message (redacted).
- A Playwright trace is saved ONLY when `MATRIX_TRACE_ON_TIMEOUT=1` and only to the local report dir. Workflows never set it, and uploads never include `trace.zip` (Review Focus 5).
- Owner value: the next F-PP-1 red explains itself in a public log, without publishing cookies.

**D17 — Item 15c, the match-day run sheet: a `match-day` set.**
- One layered set, `match-day` (league|badminton LIFECYCLE at 1280 and 320). It creates the competition dated today, schedules its first fixture for today through HTTP filler (the product's own schedule endpoint, pinned at Task 14 Step 0), and reads the run sheet BEFORE widening the filter.
- The check `runsheet-today-default`:
  - the product opened on "today" exactly when its derived phase reads `match_day`;
  - the "today" rows are exactly the fixtures the HTTP fixture list dates today.

  It abstains, counted, when no fixture is dated today.
- Owner value: the organiser's match-day default is finally driven, on the two widths that matter.

**D18 — The triage tooling ships in PR-B (Task 18).** `triage.ts` and `audit-ledger.ts` are shaped by the run's data, so they land with the data they judge. They are DB-free like every tool, with their own tests.
- Owner value: PR-A stays the infra the owner reviews before any evidence exists.

**D19 — The baseline layout (item 27; PR-B).**
- `TR/w1d-baseline/{L1,L2,L3}/{results.json, MATRIX.md}` come from the LAST of the three harness-green dispatches.
- Beside them sit `HARNESS-GREEN.md` (the three run ids and `judge.ts across` output), `TRIAGE.md`, `AUDIT-LEDGER.md`, `TIMINGS.md` and `README.md`.
- Screenshots are not committed. They live in the runs' artifacts (90-day retention), and their run ids are in `README.md`.
- Lock entries: `w1d-baseline/L1`, `w1d-baseline/L2`, `w1d-baseline/L3`.
- Weekly runs keep artifacts only (item 27).
- Owner value: one reviewable baseline instead of three 10 MB copies, with every claim traceable to a run id.

**D20 — The weekly diff (informational).** `summary.ts` downloads the previous complete run's merged artifact and lists every case whose state changed, as "✅→❌", "❌→✅" and so on. It never fails the run.
- Owner value: the weekly summary says what changed this week, not only what is red.

**D21 — The three dispatches run one product: a pinned, non-release tag (PR-B).**
- Before the first of the three, the executor tags `origin/main`'s tip as `matrix-truth/w1d-baseline` (a lightweight tag, pushed) and dispatches all three with `--ref matrix-truth/w1d-baseline`. Read 2026-10-04: no workflow triggers on a tag outside `v*.*.*` (`prod.yml`, `placement-prod.yml`), so the tag deploys nothing.
- `judge.ts across` refuses runs whose `harnessCommit` differs (Task 6).
- Owner value: a state that differs across the three runs is flakiness or nondeterminism, never "main moved between dispatches".
- Rejected: dispatching on moving `main`. Three runs of two products would make ruling 61's comparison meaningless, and a fix landing mid-sequence would restart it.

**D22 — An audit gap the run never exercised is not a false premise.** Ruling 63 and R5 send a non-reproduced gap to "False premises found". W1d's run exercises only LIFECYCLE, M1, R4 and F1 (plus the 62 L2 atoms), so most of the ~150 gaps have no driven case at all. The audit ledger (Task 18) gives every gap exactly one of five outcomes:
- **reproduced** (case ids);
- **exercised, not reproduced:** a driven case covers the gap's cell and action and passed. This is a false premise (R5), with the case ids as evidence;
- **not exercised:** no driven case reaches it. It stays a hypothesis with its §8 wave and the atom or script that would reach it;
- **verified-by-read** / **verified-by-failing-test** for a non-behavioural gap (design §10 step 3).

- Owner value: "false premise" keeps meaning "we looked and it is not there", and no wave loses a real gap because W1d's scenarios never reached it.
- Rejected: marking every non-reproduced gap a false premise (it would delete most of W2–W7's backlog on no evidence).

**D23 — The matrix drives no placement solver, so the shard jobs carry no placement container and no greedy-fallback guard (ruling 66).**
- **Evidence at HEAD (read 2026-10-04, review 3).** `buildSchedule(` has two production call sites, both inside `autoSchedule` (`apps/web/src/server/usecases/schedule.ts:1924` directly, and `:2486` through `reflowExisting`, whose only caller is `:1916`). `autoSchedule`'s only caller is `app/api/v1/stages/[id]/schedule/auto/route.ts:19`. The AI solver paths are reached only through the `…/schedule/ai-plan` routes. The matrix's routes are divisions, stages, fixtures and entrants (`stages`, `entrants`, `fixtures`, `start`, `generate`, `rebuild`, `complete`, `americano`, `challenges`, `seed-proposal`, `standings`, `events`, `state`, `finalize`, `lineups`, `withdraw`). None is `schedule/auto` or `ai-plan`, and the browser driver's selectors hold no auto-schedule control. `startDivision` (`:3839`) generates fixtures through `generateStageFixturesUnpublished` and never calls the solver.
- **The server boots without the placement env.** `PLACEMENT_SERVICE_HOST` and `PLACEMENT_SERVICE_SECRET` are read lazily, at `placement-client.ts:748` and `build.ts:2125`.
- **So:** no placement image build, no container, no `PLACEMENT_*` on the server step, no greedy guard. A guard that counts log lines and "fallbacks: 0" passes on every run when nothing calls the solver. That is a vacuous check (TEST-STRATEGY rule 1), and false premise 23 records it.
- **The premise becomes a guard (assumptions are guards).** `tools/matrix/__tests__/no-solver-route.test.ts` scans the matrix harness for a solver route and fails, citing ruling 66, if one appears. It reports the number of files scanned, and zero scanned is a failure. If a matrix path ever needs the solver, the container comes back as plumbing, and no check may then claim to prove scheduling.
- Owner value: the weekly run is faster and cheaper, and nothing in W1d's evidence claims to prove placement.
- Rejected: keeping the container "because it is cheap" (it adds an image build to the build job and a start-up wait to every shard, for a path the run never takes).

**D24 — The repo goes private after W1d, so the runner is switchable now (ruling 68).**
- **In PR-A:** every matrix and Stryker job (all four `matrix-truth.yml` jobs and every `mutation.yml` job) takes `runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}`. The visibility guard fails loudly only when the repository is private AND `runner.environment` is `github-hosted`; on a `self-hosted` runner it passes. `runner.environment` reaches the guard script as an input (`RUNNER_ENV`), so a unit test drives it. The test covers all four combinations: public/hosted (pass), public/self-hosted (pass), private/hosted (fail), private/self-hosted (pass). The dispatch input `inject_visibility=private` still fails a HOSTED job, which is PR-B's live proof (Task 17 Step 1). It proves the hosted path only: on a `self-hosted` runner the guard returns before it reads the input, so Step 1 checks its precondition (`vars.MATRIX_RUNNER` unset).
- **Outside W1d, not planned here:** the ephemeral self-hosted runner on Fly Machines is a follow-up between PR-B and the private switch. Then `vars.MATRIX_RUNNER` changes, to a runner that meets the contract in the execution handoff (it is NOT only the variable: see there). This supersedes design §6.5's "a VPS or the owner's machine". W1d builds no runner.
- **`MATRIX_RUNNER` stays UNSET while the repo is public (review 5, R5-m8).** A self-hosted runner on a public repository runs fork `pull_request` jobs. The variable is set in the same step as the private flip, never before, unless the owner accepts in writing the mitigation of an ephemeral, secretless runner.
- **The order:** PR-B's dispatches run on GitHub-hosted runners while the repo is public; then the Fly runner follow-up; then the switch to private. `ci.yml` PR jobs go back on the meter at the switch, which is outside the matrix. The per-PR sample calls `matrix-truth.yml`, so it inherits the switchable runner.
- Owner value: going private cannot silently bill hosted minutes, and the move to a free runner is one variable on W1d's side (the runner itself has a contract, see the handoff).
- Rejected: building the Fly runner in W1d (ruling 68 puts it outside).

---

## File Structure

```
tools/matrix/
  lock-append-only.ts            (T1)  CLI: plans.lock.json entries never change (D10, item 1)
  lib/lock-diff.ts               (T1)  lockChanges(base, head)
  lib/results.ts                 (T2,T4) v3 optional: case planned/l2/filler; run shard/shards
  run.ts                         (T2,T3,T4,T5,T7,T13) planOf scope; --scope; --shard; refused list; RunIdUsedInDb; pr-sample; D11 text
  lib/layers.ts                  (T3)  planL1Grid; l1/l2 planners take scope grid
  lib/counts.ts, catalogue/counts.json (T3) l1 = cells × 1 width (231)
  lib/shard.ts                   (T4)  parseShard, stripe, stripeSize
  lib/merge.ts, merge-shards.ts  (T4)  mergeShards + CLI
  lib/seed-org.ts, model.ts      (T5)  RunIdUsedInDb (items 12, 25)
  lib/judge.ts, judge.ts         (T6)  harnessFaults, statesAcross, regressions + CLI
  lib/exit-codes.ts              (T6)  the one table (D8)
  parity.ts, findings-table.ts, draw-counts.ts (T6) exit codes normalised
  lib/pr-sample.ts               (T7)  PR_SAMPLE_SET, planPrSample, parseRows
  ci/pr-rows.ts                  (T7)  R27 rows from the PR body + changed files
  catalogue/baseline.json        (T7,T21) the baseline the sample is judged against
  ci/shards.json                 (T8)  per-layer shard counts + per-case ceilings
  ci/shard-matrix.ts             (T8)  the GitHub job matrix, derived timeouts
  ci/summary.ts                  (T8)  SUMMARY.md: histograms, timings, staleness, diff
  ci/staleness.ts                (T8)  the PR annotation (D1b)
  lib/pads/*.ts, lib/pad-proof-set.ts, lib/browser/budget/execute (T12) items 8, 9, 15a, 15b, 16
  lib/parity.ts, lib/scenarios/{common,r4-withdrawal}.ts, lib/browser/pages/stage-rail.ts, lib/model/run-cell.ts (T13) items 10, 11, 22, 23, 24, 26
  lib/browser/pages/{run-sheet,stage-rail,fixture-console}.ts, lib/driver/*, lib/scenarios/void-proof.ts, lib/match-day-set.ts (T14) items 15c–f
  triage.ts, lib/triage.ts, audit-ledger.ts, lib/audit-ledger.ts (T18) PR-B
  __tests__/…                    one test file per module (named in each task)
.github/workflows/matrix-truth.yml (T9)
.github/workflows/mutation.yml     (T15)
.github/workflows/ci.yml           (T1,T9,T10,T15) lock gate; matrix-rows + matrix-sample; tests typecheck; floor gate
tsconfig.tools-tests.json          (T10)
package.json                       (T10) vitest devDependency
scripts/__tests__/tools-import-guard.test.ts (T11)
packages/engine/{stryker.config.mjs, stryker.groups.mjs, stryker-floor.json, stryker-equivalent.json, scripts/stryker-floor.ts, test/stryker-*.test.ts, package.json} (T15)
docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md (T1,T16,T17,T19,T21,T22)
docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-carry/ (T14) 1280 browser proofs
docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/ (T21) PR-B
```

Every new `HM/**` test file is picked up by the existing strict CI matrix step (`ci.yml:239-257`), which fails on zero tests, failed suites, passed ≠ total and stray files.

---
## PR-A — infra (Tasks 1–16)

Batching (ruling 41): every one of the 28 "W1d first tasks" items is owned by exactly one task here.

| Task | Items |
|---|---|
| T1 | 1 |
| T2 | 3, 4, 14, 21 (and the `scope` schema field item 2 needs; review m1) |
| T3 | 2 (the full-grid planners, and the run's recorded scope; ruling 64's grid) |
| T4 | — (sharding) |
| T5 | 5, 12, 25 |
| T6 | 6 |
| T7 | — (R27) |
| T8 | — |
| T9 | 19, 27 |
| T10 | 7 |
| T11 | 28 |
| T12 | 8, 9, 15a, 15b, 16 |
| T13 | 10, 11, 13, 17, 18, 20, 22, 23, 24, 26 |
| T14 | 15c, 15d, 15e, 15f |

Reviewers check the table against `_INDEX.md` "W1d first tasks" at the end of PR-A (Task 16 Step 1).

### Task 1: The lock is append-only (item 1, D10)

**Why:** Item 1's guard (`committed-matrix.test.ts:264-275`) proves a committed run has a lock entry. Nothing proves an existing entry was not edited alongside its results. The re-review found exactly that tamper path, and review was the only guard.

**Files:**
- Create: `tools/matrix/lib/lock-diff.ts`, `tools/matrix/lock-append-only.ts`, `tools/matrix/__tests__/lock-append-only.test.ts`
- Modify:
  - `package.json`: add the root script `"matrix:lock-check": "node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/lock-append-only.ts"`;
  - `.github/workflows/ci.yml`: a `gates` step after `pnpm matrix:single-sport --check --against HEAD^1`;
  - `tools/matrix/__tests__/ci-wiring.test.ts`: pin the step;
  - `tools/matrix/__tests__/strip-types-loadable.test.ts`: add `W1D_T1`.

**Interfaces:**
- Produces:
  - `lockChanges(base: LockFile, head: LockFile): { compared: number; added: string[]; changed: { run: string; kind: "removed" | "edited" }[] }`
  - `type LockFile = { runs: Record<string, unknown> }`
  - CLI `lock-append-only.ts --against <git-ref> [--lock <path>]`. Exit 0 append-only; 1 an entry removed or edited (each named); 2 refused (usage, unreadable, zero entries compared).

- [ ] **Step 0: Create the execution worktree and pin anchors**

```bash
cd /Users/ashokhein/github/seazn.club && git worktree add -b feat/format-matrix-w1d-infra .claude/worktrees/format-matrix-w1d-exec docs/format-matrix-w1d-plan; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-exec && pnpm install --frozen-lockfile; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-exec && node -e 'const l=require("./docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json");console.log(Object.keys(l.runs).length)'
```

Expected: `135` (record the number you see; a later merge to main may have added entries). Re-pin the Step 0 anchors table and note any moved line in the task report.

- [ ] **Step 1: Write the failing test**

Write `tools/matrix/__tests__/lock-append-only.test.ts`:

```ts
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockChanges } from "../lib/lock-diff.ts";

const REAL = JSON.parse(readFileSync(new URL("../../../docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json", import.meta.url), "utf8"));
const entry = (plan: string) => ({ plan, layered: false, driven: ["a|b|c|LIFECYCLE"], planned: {} });

describe("lockChanges (item 1, D10)", () => {
  it("the empty case: two empty locks compare zero entries, and the CLI refuses that as vacuous", () => {
    expect(lockChanges({ runs: {} }, { runs: {} })).toEqual({ compared: 0, added: [], changed: [] });
  });
  it("adding entries is allowed, and every base entry is compared", () => {
    const base = { runs: { a: entry("slice") } };
    const head = { runs: { a: entry("slice"), b: entry("--set w1-driving") } };
    expect(lockChanges(base, head)).toEqual({ compared: 1, added: ["b"], changed: [] });
  });
  it("an edited entry is named — one changed character in a driven id", () => {
    const head = { runs: { a: { ...entry("slice"), driven: ["a|b|c|M1"] } } };
    expect(lockChanges({ runs: { a: entry("slice") } }, head).changed).toEqual([{ run: "a", kind: "edited" }]);
  });
  it("a removed entry is named", () => {
    expect(lockChanges({ runs: { a: entry("slice") } }, { runs: {} }).changed).toEqual([{ run: "a", kind: "removed" }]);
  });
  it("a reordered key inside an entry is NOT an edit — the comparison is by value, keys sorted", () => {
    const e = entry("slice");
    const reordered = { planned: e.planned, driven: e.driven, layered: e.layered, plan: e.plan };
    expect(lockChanges({ runs: { a: e } }, { runs: { a: reordered } }).changed).toEqual([]);
  });
  it("the real committed lock against itself: every entry compared, none changed", () => {
    const r = lockChanges(REAL, REAL);
    expect(r.compared).toBe(Object.keys(REAL.runs).length);
    expect(r.compared).toBeGreaterThanOrEqual(135);
    expect(r.changed).toEqual([]);
  });
});

describe("lock-append-only CLI", () => {
  const cli = (args: string[], cwd: string) => spawnSync(process.execPath, ["--experimental-strip-types", join(process.cwd(), "tools/matrix/lock-append-only.ts"), ...args], { cwd, encoding: "utf8" });
  const repo = (base: object, head: object) => {
    const d = mkdtempSync(join(tmpdir(), "lock-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: d });
    git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
    writeFileSync(join(d, "lock.json"), JSON.stringify(base)); git("add", "."); git("commit", "-qm", "base");
    writeFileSync(join(d, "lock.json"), JSON.stringify(head)); git("commit", "-qam", "head");
    return d;
  };
  it("exit 1 and names the run when the head edits a base entry", () => {
    const d = repo({ runs: { w1c: entry("slice") } }, { runs: { w1c: entry("--layer L1") } });
    const r = cli(["--against", "HEAD^1", "--lock", "lock.json"], d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("w1c: edited");
  });
  it("exit 0 with the count when the head only adds", () => {
    const d = repo({ runs: { w1c: entry("slice") } }, { runs: { w1c: entry("slice"), w1d: entry("slice") } });
    const r = cli(["--against", "HEAD^1", "--lock", "lock.json"], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 entries compared, 1 added");
  });
  it("exit 2 when the base holds zero entries (vacuous), and on an unknown ref", () => {
    expect(cli(["--against", "HEAD^1", "--lock", "lock.json"], repo({ runs: {} }, { runs: {} })).status).toBe(2);
    expect(cli(["--against", "no-such-ref", "--lock", "lock.json"], repo({ runs: { a: entry("s") } }, { runs: { a: entry("s") } })).status).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Use the vitest template with `<N>`=1 and `<files>` = `tools/matrix/__tests__/lock-append-only.test.ts`. Expected: the suite fails to collect (`failedSuites: 1`), with `Cannot find module '../lib/lock-diff.ts'`.

- [ ] **Step 3: Implement**

`tools/matrix/lib/lock-diff.ts`:

```ts
// Item 1 (W1d D10): plans.lock.json is append-only. An entry present in the
// base must be value-identical in the head; entries may be added. Keys are
// sorted before comparing, so a formatter reordering an object is not an edit.
export type LockFile = { runs: Record<string, unknown> };
export type LockChange = { run: string; kind: "removed" | "edited" };

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function lockChanges(base: LockFile, head: LockFile): { compared: number; added: string[]; changed: LockChange[] } {
  const changed: LockChange[] = [];
  let compared = 0;
  for (const [run, entry] of Object.entries(base.runs)) {
    compared++;
    if (!Object.hasOwn(head.runs, run)) changed.push({ run, kind: "removed" });
    else if (canonical(entry) !== canonical(head.runs[run])) changed.push({ run, kind: "edited" });
  }
  const added = Object.keys(head.runs).filter((r) => !Object.hasOwn(base.runs, r));
  return { compared, added, changed };
}
```

`tools/matrix/lock-append-only.ts`:

```ts
// CLI: pnpm matrix:lock-check --against <git-ref> [--lock <path>]
// Exit codes (the one convention, D8):
//   0  append-only: every base entry unchanged (count printed);
//   1  an entry was removed or edited — each named on stderr;
//   2  refused, nothing judged: usage, a ref or file git cannot read, JSON
//      that is not a lock, or ZERO base entries compared (vacuous, R25).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { lockChanges, type LockFile } from "./lib/lock-diff.ts";

export const DEFAULT_LOCK = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json";

function asLock(text: string, what: string): LockFile {
  const v: unknown = JSON.parse(text);
  if (v === null || typeof v !== "object" || typeof (v as { runs?: unknown }).runs !== "object" || (v as { runs: unknown }).runs === null) {
    throw new Error(`${what} is not a plans lock (no "runs" object)`);
  }
  return v as LockFile;
}

export function main(argv: readonly string[]): number {
  let against: string; let lock: string;
  try {
    const { values } = parseArgs({ args: [...argv], options: { against: { type: "string" }, lock: { type: "string" } }, strict: true, allowPositionals: false });
    if (values.against === undefined) throw new Error("--against <git-ref> is required");
    against = values.against; lock = values.lock ?? DEFAULT_LOCK;
  } catch (e) { console.error(`lock-append-only: ${(e as Error).message}`); return 2; }
  let base: LockFile; let head: LockFile;
  try {
    base = asLock(execFileSync("git", ["show", `${against}:${lock}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), `${against}:${lock}`);
    head = asLock(readFileSync(lock, "utf8"), lock);
  } catch (e) { console.error(`lock-append-only: cannot read the locks — ${(e as Error).message.split("\n")[0]}`); return 2; }
  const r = lockChanges(base, head);
  if (r.compared === 0) { console.error(`lock-append-only: ${against}:${lock} holds zero entries — nothing was compared (vacuous)`); return 2; }
  for (const c of r.changed) console.error(`${c.run}: ${c.kind} — plans.lock.json is append-only (item 1); a committed run's plan never changes`);
  if (r.changed.length > 0) return 1;
  console.log(`lock-append-only: ${r.compared} entries compared, ${r.added.length} added`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
```

Add the `gates` step to `ci.yml`, directly after the `- run: npm run reference:boundary` line, NOT directly after the single-sport line: `ci-wiring.test.ts:351` asserts that `reference:boundary` is the line immediately after the ratchet, and that assertion stays as it is. The comment says why `HEAD^1` (the same reasoning as R26's step):

```yaml
      # Item 1 (W1d D10): plans.lock.json is append-only — an edited or removed
      # entry is a rewritten plan for evidence already committed. HEAD^1 as
      # for the single-sport ratchet two steps above.
      - run: pnpm matrix:lock-check --against HEAD^1
```

In `ci-wiring.test.ts`, add one test, "the lock gate runs in gates, unconditionally, right after reference:boundary". Write it in the line-based style of the existing R26 test (`:333-358`, which finds the ratchet line `ss` in the file's lines and asserts `lines[ss + 1]`): find the `reference:boundary` run line, then assert that the next non-comment line is `- run: pnpm matrix:lock-check --against HEAD^1`, that exactly one non-comment line names `matrix:lock-check`, and that no `if:` or `continue-on-error` sits between it and the next `- ` step. The R26 test at `:351` still passes unchanged; re-run it to prove that.

- [ ] **Step 4: Run it and see it pass**

Run the vitest template with `<files>` = `tools/matrix/__tests__/lock-append-only.test.ts tools/matrix/__tests__/ci-wiring.test.ts tools/matrix/__tests__/strip-types-loadable.test.ts`. Expected: `failed 0`, `failedSuites 0`, `files 3`. Then run the CLI against the real tree:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-exec && pnpm matrix:lock-check --against origin/main; echo EXIT=$?
```

Expected: `lock-append-only: 135 entries compared, 0 added` and `EXIT=0`.

- [ ] **Step 5: Mutate**

| Mutant | Killing test |
|---|---|
| In `lockChanges`, `canonical(entry) !== canonical(head.runs[run])` → `false` | "an edited entry is named" + the CLI exit 1 test |
| In `main`, delete the `r.compared === 0` line | "exit 2 when the base holds zero entries" |
| `canonical` → `JSON.stringify` | "a reordered key … is NOT an edit" |

Use cp backups (Global Constraints), and record `total`/`failed` for each mutant.

- [ ] **Step 6: Scoped tsc, eslint, commit**

Run scoped tsc on `tools/matrix/lib/lock-diff.ts tools/matrix/lock-append-only.ts`, then eslint on all five changed files. Commit the 5 files plus `package.json` with the message `feat(matrix): plans.lock.json is append-only in CI (W1d item 1, D10)`.

---

### Task 2: What a result records — scope, planned marker, L2 run, fillers, shard (items 3, 4, 14, 21; item 2's schema field)

**Why:**
- A committed run cannot say whether ░ was planned or a harness failure: the I-2 heuristic is `durationMs === 0` (item 3).
- L2's `n`/`covers`/`l3Gap` are computed and thrown away (item 4).
- A browser run cannot say which setup ran through HTTP (item 21).
- The shard fields arrive here so Task 4 only writes them.

All additions are OPTIONAL fields on the strict v3 schemas, so every committed run still parses. The committed-matrix suite is the regression test.

**Files:**
- Modify:
  - `tools/matrix/lib/results.ts:177-221` (CaseSchemaV3, RunResultsSchemaV3);
  - `tools/matrix/run.ts`: `recordPlanned` `:727-735`, `runCase` `:~700-720`;
  - `tools/matrix/lib/parity.ts:183-189` (notDriven);
  - `tools/matrix/__tests__/committed-plans.ts:143` (judgeRun prefers the marker).
- Test:
  - `tools/matrix/__tests__/results.test.ts` (extend);
  - `tools/matrix/__tests__/run-planned-marker.test.ts` (create);
  - `tools/matrix/__tests__/parity.test.ts` (extend).

**Interfaces:**
- Produces, all optional, on `CaseSchemaV3`:
  - `planned: z.literal(true)`
  - `l2: z.strictObject({ n: z.number().int().min(1), covers: z.array(z.string().min(1)).min(1), l3Gap: z.string().min(1).nullable() })`
  - `fillers: z.partialRecord(z.enum(FILLER), z.number().int().min(1))`. It must be `partialRecord`: in zod 4, `z.record(z.enum(…), …)` is EXHAUSTIVE and would refuse a run that ran one filler (review I2).
- Produces on `RunResultsSchemaV3`:
  - `shard: z.strictObject({ index: z.number().int().min(1), of: z.number().int().min(2).max(MAX_SHARDS), planSize: z.number().int().min(1) }).refine(s => s.index <= s.of)`
  - `shards: z.number().int().min(2).max(MAX_SHARDS)`
  - `export const MAX_SHARDS = 64` in `results.ts`.
  - A refine: `shard` and `shards` are never both present.
- Item 14, per-case `layer` read by no production code: no code change. Task 4's merge READS it (each case's `layer` must equal the run's), which makes the field load-bearing. Add a JSDoc line on `CaseSchemaV3.layer` naming that reader.

- [ ] **Step 0: Read the shapes**

Read `results.ts:150-221` in full, and check whether `lib/driver/mixed.ts` (which owns `FILLER`) imports `results.ts` directly or through another module (`rtk proxy grep -an "import" tools/matrix/lib/driver/mixed.ts`). If it does, that is a cycle: move `FILLER` and `FillerName` into a new `tools/matrix/lib/fillers.ts`, re-exported from `mixed.ts` so no other importer changes.

- [ ] **Step 1: Write the failing tests**

Append to `results.test.ts`:

```ts
describe("W1d optional fields (items 3, 4, 21; shard)", () => {
  const base = () => structuredClone(validV3Run());   // the file's existing v3 fixture builder
  it("a v3 run with none of the new fields still parses (every committed run)", () => {
    expect(() => parseResults(base())).not.toThrow();
  });
  it("planned is only ever the literal true", () => {
    const r = base(); (r.cases[0] as Record<string, unknown>).planned = false;
    expect(() => parseResults(r)).toThrow();
  });
  it("l2 carries n ≥ 1 and at least one covered atom", () => {
    const r = base(); (r.cases[0] as Record<string, unknown>).l2 = { n: 0, covers: [], l3Gap: null };
    expect(() => parseResults(r)).toThrow();
  });
  it("fillers names only FILLER methods, each counted at least once", () => {
    const r = base(); (r.cases[0] as Record<string, unknown>).fillers = { start: 1 };
    expect(() => parseResults(r)).toThrow();
    (r.cases[0] as Record<string, unknown>).fillers = { setMembers: 2 };
    expect(() => parseResults(r)).not.toThrow();
  });
  it("a shard header and a merged header are exclusive, and index ≤ of", () => {
    const r = base() as Record<string, unknown>;
    r.shard = { index: 3, of: 2, planSize: 10 };
    expect(() => parseResults(r)).toThrow();
    r.shard = { index: 2, of: 2, planSize: 10 }; r.shards = 2;
    expect(() => parseResults(r)).toThrow();
  });
});
```

If `results.test.ts` has no `validV3Run()` builder, Step 0 names the existing fixture and the test uses it. Do not create a second fixture.

Create `run-planned-marker.test.ts`. It drives `execute` with the existing fake-driver deps, the way `run-cli.test.ts` already does (the only test file that passes `planCases:` at HEAD), through `RunDeps.planCases`, with a planner that returns one driven case, one 🚫 case and one ░ case:

```ts
it("recordPlanned marks every case it writes; a driven case never carries the marker", async () => {
  const results = await runWithFakePlan([
    { caseId: "league|generic|default|LIFECYCLE", layer: "L3", driven: true },
    { caseId: "page_playoff_only|generic|default|LIFECYCLE", layer: "L3", state: "no_path", reason: "API-only (W4)" },
    { caseId: "league|generic|default|M7", layer: "L3", state: "not_run", reason: "no scenario script yet (atom M7)" },
  ]);
  const by = new Map(results.cases.map((c) => [c.caseId, c]));
  expect(by.get("league|generic|default|LIFECYCLE")!.planned).toBeUndefined();
  expect(by.get("page_playoff_only|generic|default|LIFECYCLE")!.planned).toBe(true);
  expect(by.get("league|generic|default|M7")!.planned).toBe(true);
  expect(results.cases.filter((c) => c.planned === true)).toHaveLength(2);
});
it("an L2 case records its run (n, covers, l3Gap) from l2-pairs.json, driven or planned", async () => {
  const pairs = loadL2Pairs();            // the committed file is the authority, not planL2
  const want = pairs.runs.find((r) => r.row === "league" && r.sport === "football" && r.scenario === "M1")!;
  const results = await runLayered("L2", { only: "league|football", scenario: "M1" });
  const c = results.cases.find((x) => x.width === want.width)!;
  expect(c.l2).toEqual({ n: want.n, covers: want.covers, l3Gap: want.l3Gap });
});
it("a browser case records the setup fillers it ran; an HTTP case records none", async () => {
  const b = await runWithFakeBrowser({ fillers: { setMembers: 3, putLineup: 1 } });
  expect(b.cases[0].fillers).toEqual({ setMembers: 3, putLineup: 1 });
  const h = await runWithFakePlan([{ caseId: "league|generic|default|LIFECYCLE", layer: "L3", driven: true }]);
  expect(h.cases[0].fillers).toBeUndefined();
});
```

`runWithFakePlan`, `runLayered` and `runWithFakeBrowser` are thin wrappers over `execute` + `fake-driver.ts`, defined at the top of this file. Model them on `run-cli.test.ts`'s existing `planCases` helper (Step 0 names it). A fake browser driver exposes `fillers` exactly like `BrowserDriver.fillers` (`browser-driver.ts:585`).

Extend `parity.test.ts` with:
- "a browser case carrying `planned: true` is notDriven even when its key maps";
- "a case with no checks, ░, and NO marker on an unmapped key is still notDriven (old evidence)" — the existing behaviour, kept for committed runs.

- [ ] **Step 2: Run and see them fail**

Run the vitest template on the three test files. Expected: the new `results.test.ts` cases fail (the strict schema refuses `planned`), and `run-planned-marker.test.ts` fails on `planned` undefined.

- [ ] **Step 3: Implement**

1. In `results.ts`, add the three case fields and two run fields above (`import { FILLER } from "./driver/mixed.ts"`, or `./fillers.ts` per Step 0). Add `.refine((r) => !(r.shard !== undefined && r.shards !== undefined), "a run is a shard or a merge, never both")` on `RunResultsSchemaV3`.
2. In `run.ts` `recordPlanned`, add `planned: true` to the written case.
3. In `run.ts` `runCase`, when the LayerCase carries `run !== null` and `layer === "L2"`, write `l2: { n: run.n, covers: run.covers, l3Gap: run.l3Gap }`. Do the same in `recordPlanned` for an L2 planned case: a ░ L2 run still names its pair-run.
4. In `run.ts` `runCase`, when `cli.driver === "browser"` and the driver exposes `fillers` with at least one non-zero entry, write `fillers` (only the non-zero names).
5. In `parity.ts` notDriven, accept `b.planned === true && b.checks.length === 0` as well as the existing unmapped-key shape.
6. In `committed-plans.ts` `judgeRun` (`:125-160`), **keep the I-2 heuristic exactly as it is**. ADD a marker cross-check that applies only to runs that carry the marker. Two conditions, two refusals (review I4):

   ```ts
   // W1d item 3: the marker is a SECOND witness beside I-2's shape, never a replacement.
   const marked = cases.some((c) => c.planned !== undefined);
   // …inside the per-case loop, after `p`/driven are known:
   if (marked && p !== undefined && !(c.planned === true && c.durationMs === 0 && c.checks.length === 0)) {
     wrong.push(`${c.caseId}: the plan records it planned, stored without the planned shape (planned=${c.planned}, ${c.durationMs} ms, ${c.checks.length} check(s))`);
   }
   if (c.planned === true && plan.driven.has(key)) {
     wrong.push(`${c.caseId}: the plan DRIVES this case, stored with planned: true — a driven result recorded as planned (class 6)`);
   }
   ```

   The second check does not depend on `marked`, because a single stray marker is exactly the case it catches.

- [ ] **Step 4: Run and see them pass**

Run the vitest template on:

```
tools/matrix/__tests__/results.test.ts
tools/matrix/__tests__/run-planned-marker.test.ts
tools/matrix/__tests__/parity.test.ts
tools/matrix/__tests__/committed-matrix.test.ts
tools/matrix/__tests__/committed-plans-frozen.test.ts
tools/matrix/__tests__/run-cli.test.ts
```

All green; `files 6` (`run-planned-marker.test.ts` is new; the other five exist at HEAD). The committed-matrix pass proves every committed run still parses (its `RESULTS_FLOOR` count is in its own output).

- [ ] **Step 5: Mutate**

| Mutant | Killing test |
|---|---|
| Drop `planned: true` from `recordPlanned` | "recordPlanned marks every case it writes" |
| In `runCase`, write `l2` only when `state === "works"` | "an L2 case records its run … driven or planned" |
| In `judgeRun`, delete the first new check (planned-shape) | Add to `committed-plans-frozen.test.ts`: "a marked run where one lock-planned case LACKS `planned: true` (the shape `recordPlanned` would write if it forgot one case) is wrong, naming the case". |
| In `judgeRun`, delete the second new check (marker on a driven key) | Add: "a run where one lock-DRIVEN case carries `planned: true` with `durationMs` > 0 and checks (a driven result relabelled) is wrong". Under the old I-2 heuristic alone this case passes, so the test witnesses the new guard and not the old one. |
| Both mutated at once | Not done: class 3 (they are mutated one at a time). |

- [ ] **Step 6: Scoped tsc, eslint, commit**

Run scoped tsc on `results.ts run.ts parity.ts`, and eslint on all changed files. Commit `feat(matrix): results record the planned marker, the L2 run, fillers and shard fields (W1d items 3, 4, 14, 21)`.

---

### Task 3: The full grid — `--scope grid` for L1 and L2, and counts.json's L1 (ruling 64, item 2)

**Why:**
- Ruling 64 sets the full scope: L1 is 231 cells at 1280, and L2 is the 1,731 runs.
- `LAYER_PLANNERS` (`layers.ts:197`, chosen at `run.ts:1020`) maps `L1`/`L2` to `l1Planner`/`l2Planner`. Both are `PlanLayers` functions over the 6-cell slice (`layers.ts:174-195`).
- `planOf` cannot say which of the two a run planned (item 2).
- `counts.json` says L1 is 462 (false premise 3).

Re-pinned against `layers.ts` at HEAD (review I1). A `LayerCase` is either a `DrivenLayerCase` `{ layer, width, run, spec: CaseSpec, noPath: null, notRun: null }` or a `PlannedLayerCase` `{ layer, width, run, spec: null, identity: CaseIdentity, noPath | notRun }` (`layers.ts:80-91`). A case's id is `layerCaseId(c)` (`:98`). Tests tell the two shapes apart by `c.spec !== null`.

**Files:**
- Modify:
  - `tools/matrix/lib/layers.ts`: `planL1Grid`, `l1GridPlanner`, `l2GridPlanner`, `ALL_CELLS`, and a NEW `LAYER_GRID_PLANNERS` beside the existing `LAYER_PLANNERS`, which stays unchanged. Its catalogue import (`:35`, today `API_ONLY_ROWS, cellId, type RowKey`) gains `ROW_KEYS`, `SPORT_KEYS` and `type ApiOnlyRowKey` (`catalogue.ts:32,35,37`; review 2, R2-m5). `apiOnlyUiPath` and `templateField` are already imported (`:36-37`);
  - `tools/matrix/run.ts`: `parseCli` `--scope`, planner selection `:1020`, `planOf`, USAGE;
  - `tools/matrix/lib/counts.ts:99`;
  - `tools/matrix/catalogue/counts.json` (regenerated through `pnpm matrix:catalogue`, never hand-edited);
  - `tools/matrix/__tests__/committed-plans.ts` (`expectedPlanFor` reads `--scope grid`);
  - `tools/matrix/__tests__/committed-catalogue.test.ts:271`.
- Test:
  - `tools/matrix/__tests__/layers-grid.test.ts` (create);
  - `tools/matrix/__tests__/layers.test.ts` and `tools/matrix/__tests__/run-cli.test.ts` (both exist; extend).

**Interfaces:**
- Produces:
  - `type LayerScope = "slice" | "grid"`;
  - `LAYER_GRID_PLANNERS: Readonly<Record<"L1" | "L2", PlanLayers>>`;
  - `planL1Grid(variantFor: (sport: string) => string): LayerCase[]` (231 cases, `ROW_KEYS` × `SPORT_KEYS` order);
  - `ALL_CELLS: ReadonlySet<string>` (every `cellId(row, sport)`);
  - `Cli.scope?: LayerScope`;
  - `planOf` returns `--layer L1 --scope grid` for a grid run. A slice run keeps today's `--layer L1` string, so every committed lock entry still matches.
- Grid planners take no `--only`/`--scenario`. The grid is the whole grid, and a filter is a usage refusal (`refuseFilters`, `layers.ts`, as the named sets do).

- [ ] **Step 0: Pin the grid's facts from the committed files**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-exec && node -e 'const p=require("./tools/matrix/catalogue/l2-pairs.json");const r=p.runs??p;console.log(r.length);for(const [row,sport,sc] of [["league","football","M1"],["league","football","R4a"],["knockout","icehockey","M1"],["knockout","icehockey","R4a"]])console.log(row,sport,sc,JSON.stringify(r.filter(x=>x.row===row&&x.sport===sport&&x.scenario===sc).map(x=>[x.n,x.width])))'
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-exec && sed -n '78,100p;170,200p' tools/matrix/lib/layers.ts
```

Expected: `1731`, then one line per pair naming its `n` and width. False premise 14 says M1@430, R4a@390, M1@834 and R4a@768. Record the four `n` values; the test reads them from the file, not from this plan. Re-read the `LayerCase` types; if they moved, adapt the code below to them and record it.

- [ ] **Step 1: Write the failing tests**

`layers-grid.test.ts`. Every expected count is derived from the catalogue constants, the committed `counts.json` and the rulings, never from `planL1Grid`/`planL2`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, SPORT_KEYS, TEMPLATE_ROW_KEYS, type ApiOnlyRowKey } from "../lib/catalogue.ts";
import { API_ONLY_UI_WAVE } from "../lib/api-only-ui.ts";
import { TEMPLATE_ROW } from "../lib/templates.ts";
import { HARNESS_SCENARIO } from "../lib/scenario-catalogue.ts";
import { L1_WIDTH, LAYER_GRID_PLANNERS, identityOf, layerCaseId, planL1Grid, type LayerCase } from "../lib/layers.ts";
import { loadL2Pairs } from "../lib/pairs.ts";          // pairs.ts:216
// variantFor is (sport) => string (run.ts:225); offlineBuilderDefault (variants.ts:34) is that signature, read from the
// committed builder defaults with no DB — the committed-plans judge's stand-in.
import { offlineBuilderDefault } from "../lib/variants.ts";

const COUNTS = JSON.parse(readFileSync(new URL("../catalogue/counts.json", import.meta.url), "utf8"));
const CELLS = (TEMPLATE_ROW_KEYS.length + API_ONLY_ROWS.length) * SPORT_KEYS.length;
const TEMPLATE_REACHED = Object.keys(TEMPLATE_ROW).length;   // box-league → group_only, t20-super8 → group_group_ko
const driven = (cs: readonly LayerCase[]) => cs.filter((c) => c.spec !== null);
const planned = (cs: readonly LayerCase[]) => cs.filter((c) => c.spec === null);

describe("the full L1 grid (ruling 64: 231 cells @1280, ruling 39)", () => {
  const cases = planL1Grid(offlineBuilderDefault);
  it("plans one case per cell — the count the corrected counts.json states — all at 1280", () => {
    expect(CELLS).toBe(231);
    expect(COUNTS.l1.value).toBe(CELLS);           // red until Step 3 regenerates counts.json (462 today)
    expect(cases).toHaveLength(CELLS);
    expect(new Set(cases.map(layerCaseId)).size).toBe(CELLS);
    expect(cases.every((c) => c.width === L1_WIDTH && c.layer === "L1" && c.run === null)).toBe(true);
  });
  it("drives every builder row and every template-reached API-only cell; plans 🚫 for the rest", () => {
    expect(driven(cases)).toHaveLength(TEMPLATE_ROW_KEYS.length * SPORT_KEYS.length + TEMPLATE_REACHED);   // 178
    const p = planned(cases);
    expect(p).toHaveLength(API_ONLY_ROWS.length * SPORT_KEYS.length - TEMPLATE_REACHED);                   // 53
    // review 2, R2-m4: the wave each 🚫 names is the declaration's, API_ONLY_UI_WAVE[row].wave (api-only-ui.ts:16)
    for (const c of p) expect(c.noPath?.wave, layerCaseId(c)).toBe(API_ONLY_UI_WAVE[identityOf(c).row as ApiOnlyRowKey].wave);
  });
  it("a template-reached cell carries its template and the template's own variant (ruling 47, D11 of W1-driving)", () => {
    const t = driven(cases).filter((c) => c.spec!.template !== undefined);
    expect(t.map((c) => c.spec!.template).sort()).toEqual(Object.keys(TEMPLATE_ROW).sort());
  });
  it("another sport: cricket's league cell is planned once, under variantFor's variant", () => {
    const cricket = cases.filter((c) => layerCaseId(c).startsWith("league|cricket|"));
    expect(cricket).toHaveLength(1);
    expect(cricket[0].spec!.variant).toBe(offlineBuilderDefault("cricket"));
  });
  it("the grid takes no filter", () => {
    expect(() => LAYER_GRID_PLANNERS.L1({ only: "league|generic" })).toThrow();
  });
});

describe("the full L2 grid (ruling 64: every run of l2-pairs.json)", () => {
  const pairs = loadL2Pairs();
  const cases = LAYER_GRID_PLANNERS.L2({}).layered(offlineBuilderDefault);
  it("plans exactly one case per committed pair-run, none twice", () => {
    expect(cases).toHaveLength(pairs.runs.length);
    expect(new Set(cases.map(layerCaseId)).size).toBe(pairs.runs.length);
  });
  it("drives exactly the runs whose atom has a harness script; every other run is planned 🚫 or ░ with its reason", () => {
    const scripted = new Set(Object.keys(HARNESS_SCENARIO));
    const d = driven(cases);
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((c) => scripted.has(c.run!.scenario))).toBe(true);
    const notRun = cases.filter((c) => c.spec === null && c.notRun !== null);
    expect(notRun.every((c) => !scripted.has(c.run!.scenario))).toBe(true);
    console.log(`L2 grid: ${d.length} driven, ${cases.length - d.length - notRun.length} no_path, ${notRun.length} not_run of ${cases.length}`);
  });
  it("the four league/knockout M1/R4a phone runs (false premise 14) are driven", () => {
    for (const [row, sport] of [["league", "football"], ["knockout", "icehockey"]]) for (const sc of ["M1", "R4a"]) {
      const want = pairs.runs.filter((r) => r.row === row && r.sport === sport && r.scenario === sc);
      expect(want.length).toBeGreaterThan(0);
      for (const w of want) expect(cases.find((c) => c.run?.n === w.n && c.spec !== null)).toBeDefined();
    }
  });
});
```

`layers.test.ts`: add "LAYER_PLANNERS is unchanged: L1 still plans the slice's 6 cells at 1280" as the second-call guard that the slice default did not move.

`run-cli.test.ts` additions:
- `--scope grid` without `--layer` is a usage refusal (exit 2);
- `--scope` with `--set` is a usage refusal;
- `--scope banana` is a usage refusal;
- `--layer L1 --scope grid --only league|generic` is a usage refusal;
- `planOf` of `--layer L1 --scope grid` is `"--layer L1 --scope grid"`, and of `--layer L1` (no scope) is `"--layer L1"`, which is the second call: the default is unchanged.

`committed-catalogue.test.ts:271` becomes `expect(c.l1).toEqual({ formula: "cells × 1 width (1280; ruling 39)", value: CELLS })`, with `CELLS` derived from the catalogue constants as above, never `c.cells` read back.

- [ ] **Step 2: Run and see them fail**

Run the vitest template on `layers-grid.test.ts layers.test.ts run-cli.test.ts committed-catalogue.test.ts`. Expected: `layers-grid.test.ts` fails to collect (`planL1Grid` is not exported), and the catalogue test fails on 462 ≠ 231. The JSON line must show `files: 4`; any other count means a path did not match (vitest drops a positional that matches nothing).

- [ ] **Step 3: Implement**

In `layers.ts`:

```ts
/** Every catalogue cell (ruling 64's full grid), in ROW_KEYS × SPORT_KEYS order. */
export const ALL_CELLS: ReadonlySet<string> = new Set(ROW_KEYS.flatMap((r) => SPORT_KEYS.map((s) => cellId(r, s))));
const isApiOnly = (row: RowKey): row is ApiOnlyRowKey => (API_ONLY_ROWS as readonly string[]).includes(row);

/** Ruling 64: the full L1 grid — one LIFECYCLE case per cell at 1280. A
 *  builder row drives with variantFor's variant; an API-only cell a catalog
 *  template reaches drives through that template (its own sport and variant,
 *  as planW1DrivingL1 does); every other API-only cell is 🚫 naming its wave. */
export function planL1Grid(variantFor: (sport: string) => string): LayerCase[] {
  const at = (spec: CaseSpec): DrivenLayerCase => ({ spec, layer: "L1", width: L1_WIDTH, noPath: null, notRun: null, run: null });
  return ROW_KEYS.flatMap((row) => SPORT_KEYS.map((sport): LayerCase => {
    if (!isApiOnly(row)) {
      const variant = variantFor(sport);
      return at({ caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false });
    }
    const p = apiOnlyUiPath(row, sport);
    if (p.reachable) {
      const { variant } = templateField(p.template);
      return at({ caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE, canary: false, template: p.template });
    }
    const variant = variantFor(sport);
    return { spec: null, identity: { caseId: `${row}|${sport}|${variant}|${LIFECYCLE}`, row, sport, variant, scenario: LIFECYCLE },
      layer: "L1", width: L1_WIDTH, noPath: { wave: p.wave, reason: p.reason }, notRun: null, run: null };
  }));
}

export const l1GridPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseFilters("--layer L1 --scope grid", cli);
  return { sports: SPORT_KEYS, deniesFeatures: false, layer: "L1", label: "--layer L1 --scope grid", acceptsWidth: L1_WIDTH, layered: planL1Grid };
};

export const l2GridPlanner: PlanLayers = (cli: PlannerCli) => {
  refuseFilters("--layer L2 --scope grid", cli);
  const cases = planL2(loadL2Pairs(), ALL_CELLS);
  const sports = [...new Set(cases.flatMap((c) => (c.spec === null ? [] : [c.spec.sport])))];
  return { sports, deniesFeatures: false, layer: "L2", label: "--layer L2 --scope grid", acceptsWidth: null, layered: () => cases };
};

export const LAYER_GRID_PLANNERS: Readonly<Record<"L1" | "L2", PlanLayers>> = Object.freeze({ L1: l1GridPlanner, L2: l2GridPlanner });
```

Notes for the implementer:
- `refuseFilters` already exists for the named sets. Step 0 confirms its signature (`(label, cli)`) and adapts the call if it differs.
- `CaseSpec.template` is the field `planW1DrivingL1` sets (`layers.ts:~268`).
- `planL2(pairs, cells)` is `layers.ts:142`. Do not confuse it with `pairs.ts:115`'s `planL2`, which BUILDS `l2-pairs.json` and is not a planner.
- `sports: SPORT_KEYS` covers all 11 sports, so the runner reads every sport's variant order once, exactly as the planner contract (`run.ts:~250`, `UndeclaredSport`) requires.

In `run.ts`:
- `parseCli` gains `scope: { type: "string" }`. It is accepted only with `--layer`, its value is `slice | grid`, and anything else is a usage refusal (the existing usage path);
- planner selection at `:1020` becomes `cli.layer !== undefined ? (cli.scope === "grid" ? LAYER_GRID_PLANNERS : LAYER_PLANNERS)[cli.layer] : …`;
- `planOf` appends ` --scope grid` only when `cli.scope === "grid"`;
- USAGE gains the flag line.

`counts.ts:99` → `l1: { formula: "cells × 1 width (1280; ruling 39)", value: cells }`. Then regenerate: `cd <exec> && pnpm matrix:catalogue; echo EXIT=$?`. The `counts.json` diff must be exactly the `l1` object; anything else is a STOP.

In `committed-plans.ts` `expectedPlanFor`, `--layer L1 --scope grid` → `LAYER_GRID_PLANNERS.L1` (the same for L2). A bare `--layer L1` stays `LAYER_PLANNERS.L1`, so every committed entry is judged exactly as before.

- [ ] **Step 4: Run and see them pass**

Run the vitest template on:

```
tools/matrix/__tests__/layers-grid.test.ts tools/matrix/__tests__/layers.test.ts tools/matrix/__tests__/run-cli.test.ts
tools/matrix/__tests__/committed-catalogue.test.ts tools/matrix/__tests__/committed-matrix.test.ts tools/matrix/__tests__/committed-plans-frozen.test.ts
```

All green, with `files: 6`. Paste the `L2 grid: …` console line. Expected `62 driven, 164 no_path, 1505 not_run of 1731`; if the tree moved, record what you see and why.

- [ ] **Step 5: Mutate**

| Mutant | Killing test |
|---|---|
| In `planL1Grid`, skip the `p.reachable` branch (plan 🚫 for every API-only cell; `apiOnlyNoPath` would also throw `TemplateReachable`) | "drives every builder row and every template-reached API-only cell" |
| `planOf` drops ` --scope grid` | `run-cli.test.ts` planOf case |
| `counts.ts` back to `cells * 2` | `committed-catalogue.test.ts` and "the count the corrected counts.json states" |

- [ ] **Step 6: Scoped tsc, eslint, commit**

Run scoped tsc on `layers.ts run.ts counts.ts`. Commit `feat(matrix): --scope grid plans the full L1 (231) and L2 (1,731) grids; counts.json L1 is 231 (W1d, ruling 64, item 2)`.

---

### Task 4: Shards and their merge (D4, D5; Review Focus 1)

**Why:** Ruling 64 splits each layer into about 12 jobs. The partition must be stable (ruling 61 compares per case across runs), and the merge must refuse every way a shard can silently be short (R25, class 1).

**Files:**
- Create: `tools/matrix/lib/shard.ts`, `tools/matrix/lib/merge.ts`, `tools/matrix/merge-shards.ts`, `tools/matrix/lib/run-id.ts`
- Modify:
  - `tools/matrix/run.ts`: `--shard`; the stripe applied after `runItems`; `ShardEmpty` in `refused`; the `shard` header; the run-id slug (`:567-569`) moves into `lib/run-id.ts` and is imported back, with its behaviour unchanged;
  - `package.json`: `"matrix:merge": "node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/merge-shards.ts"`.
- Test: `tools/matrix/__tests__/shard.test.ts`, `tools/matrix/__tests__/merge.test.ts`, `tools/matrix/__tests__/run-shard.test.ts` (all create).

**Interfaces:**
- Produces:
  - `type Shard = { index: number; of: number }`;
  - `parseShard(text: string): Shard`, which throws `BadShard` for anything other than `k/N` with integers 1 ≤ k ≤ N, 2 ≤ N ≤ MAX_SHARDS;
  - `stripe<T>(items: readonly T[], s: Shard): T[]`;
  - `stripeSize(planSize: number, s: Shard): number`;
  - `mergeShards(inputs: readonly ShardInput[], runId: string): { merged: RunResults; checked: number }`, with `type ShardInput = { name: string; exit: string | null; results: unknown }`;
  - the refusals `ShardMissing`, `ShardDuplicate`, `ShardFailed`, `ShardEmpty`, `ShardAborted`, `ShardMismatch`, `ShardSize`, `CaseCollision`, `ShardSecret`, each `name`d;
  - CLI `merge-shards.ts --run-id <id> --out <dir> <shardDir>...`. Each shard dir holds `results.json` and `exit.txt`. Exit 0 merged (`results.json` + `MATRIX.md` written); 2 refused, nothing written. It refuses a `--run-id` that is not already its own slug (`slugRunId(id) !== id`), so the CLI never writes to a directory other than the one it was named.
  - `slugRunId(raw: string): string | null` (`lib/run-id.ts`): run.ts's slug, moved verbatim. It returns the lowercase `[a-z0-9-]` id, or null when the result is empty or longer than `RUN_ID_MAX`. **run.ts writes `<report-dir>/<slugRunId(--run-id)>/`, so every caller that later reads that directory must pass an id that is already its own slug** (review C1: `…-L3-s1` would land in `…-l3-s1/`). Task 8 emits lowercase ids, and Task 9's tests hold the workflow's templates to `slugRunId(x) === x`.
- Consumes: `RunResultsSchemaV3.shard`/`shards`, `MAX_SHARDS` (Task 2); `parseResults`, `writeResults`, `renderMatrix`, `findSecrets`.

- [ ] **Step 1: Write the failing tests**

`shard.test.ts`, including the rule-10 property:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BadShard, parseShard, stripe, stripeSize } from "../lib/shard.ts";

describe("parseShard", () => {
  it.each(["0/2", "3/2", "1/1", "1/65", "a/2", "1/2/3", "", "1/ 2", "01/2"])("refuses %j", (s) => expect(() => parseShard(s)).toThrow(BadShard));
  it("reads k/N", () => expect(parseShard("3/12")).toEqual({ index: 3, of: 12 }));
});

describe("stripe (rule 10: the union is the plan, in order, with no overlap, on every run)", () => {
  it("the empty plan: every shard is empty and stripeSize says 0", () => {
    expect(stripe([], { index: 1, of: 2 })).toEqual([]);
    expect(stripeSize(0, { index: 1, of: 2 })).toBe(0);
  });
  it("a plan shorter than N leaves the high shards empty", () => {
    expect(stripe(["a"], { index: 2, of: 3 })).toEqual([]);
    expect(stripeSize(1, { index: 2, of: 3 })).toBe(0);
  });
  it("property: interleaving the N stripes round-robin rebuilds the plan exactly", () => {
    let checked = 0;
    fc.assert(fc.property(fc.array(fc.integer(), { maxLength: 300 }), fc.integer({ min: 2, max: 64 }), (plan, of) => {
      const parts = Array.from({ length: of }, (_, k) => stripe(plan, { index: k + 1, of }));
      parts.forEach((p, k) => expect(p).toHaveLength(stripeSize(plan.length, { index: k + 1, of })));
      const rebuilt: number[] = [];
      for (let i = 0; i < plan.length; i++) rebuilt.push(parts[i % of][Math.floor(i / of)]);
      expect(rebuilt).toEqual(plan);
      expect(parts.reduce((n, p) => n + p.length, 0)).toBe(plan.length);
      checked++;
    }), { numRuns: 300 });
    expect(checked).toBe(300);
  });
  it("a second call is identical (the partition is a pure function of plan order)", () => {
    const plan = Array.from({ length: 937 }, (_, i) => `c${i}`);
    expect(stripe(plan, { index: 2, of: 2 })).toEqual(stripe(plan, { index: 2, of: 2 }));
  });
});
```

`merge.test.ts`. Its fixture builder `shardOf(plan, k, of, overrides)` writes a valid v3 shard of the stripe, with `harnessCommit "abc"`, a fixed grid, `layer "L3"`, `driver "http"`, `plan "--set w1-driving"`, `shard {index: k, of, planSize: plan.length}`, and every case `works` with one check:

```ts
describe("mergeShards (Review Focus 1)", () => {
  const plan = Array.from({ length: 7 }, (_, i) => `league|generic|default|S${i}`);
  const all = (of: number) => Array.from({ length: of }, (_, k) => ({ name: `s${k + 1}`, exit: "0", results: shardOf(plan, k + 1, of) }));
  it("merges N shards back into plan order, records shards: N, and counts every case", () => {
    const { merged, checked } = mergeShards(all(3), "ci-1-1-L3");
    expect(merged.cases.map((c) => c.caseId)).toEqual(plan);
    expect(merged.shards).toBe(3);
    expect(merged.shard).toBeUndefined();
    expect(merged.runId).toBe("ci-1-1-L3");
    expect(checked).toBe(7);
  });
  it("zero shards is refused (vacuous)", () => expect(() => mergeShards([], "x")).toThrow(/ShardMissing|zero shards/));
  it("a shard that died, a partial shard, a stray shard: each refused by name", () => {
    const s = all(3);
    expect(() => mergeShards([s[0], s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardMissing" }));
    expect(() => mergeShards([s[0], { ...s[1], exit: null }, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardFailed" }));
    expect(() => mergeShards([s[0], { ...s[1], exit: "3" }, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardFailed" }));
    const short = structuredClone(s[1]); (short.results as { cases: unknown[] }).cases.pop();
    expect(() => mergeShards([s[0], short, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardSize" }));
    const aborted = structuredClone(s[1]); (aborted.results as Record<string, unknown>).aborted = { turn: "t", deadlineMs: 1, caseId: plan[1], worker: null, inFlight: [] };
    expect(() => mergeShards([s[0], aborted, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardAborted" }));
    expect(() => mergeShards([...s, s[0]], "x")).toThrow(expect.objectContaining({ name: "ShardDuplicate" }));
  });
  it("shards of different commits, plans, layers or plan sizes are refused", () => {
    for (const o of [{ harnessCommit: "def" }, { plan: "--set pad-proof" }, { layer: "L1" }, { shard: { index: 2, of: 3, planSize: 8 } }]) {
      const s = all(3); s[1] = { ...s[1], results: { ...(s[1].results as object), ...o } };
      expect(() => mergeShards(s, "x")).toThrow(expect.objectContaining({ name: "ShardMismatch" }));
    }
  });
  it("a case whose own layer differs from its run's is refused (item 14's reader)", () => {
    const s = all(3); (s[0].results as { cases: { layer: string }[] }).cases[0].layer = "L1";
    expect(() => mergeShards(s, "x")).toThrow(expect.objectContaining({ name: "ShardMismatch" }));
  });
  it("a secret-shaped string in a shard is refused (Review Focus 5)", () => {
    const s = all(3); (s[0].results as { cases: { reason: string }[] }).cases[0].reason = "postgres://u:p@h/db";
    expect(() => mergeShards(s, "x")).toThrow(expect.objectContaining({ name: "ShardSecret" }));
  });
  it("another layer: an L2 grid shard set merges with planned ░ cases kept planned", () => {
    const l2 = Array.from({ length: 5 }, (_, i) => ({ id: `league|generic|default|M7|n${i}`, planned: i % 2 === 0 }));
    const { merged } = mergeShards(l2ShardsOf(l2, 2), "ci-1-1-L2");
    expect(merged.cases.filter((c) => c.planned === true)).toHaveLength(3);
  });
});
```

`run-shard.test.ts` drives `execute` through `RunDeps.planCases` with a fake 5-item plan:
- `--shard 2/2` runs cases 1 and 3 (0-based) and writes `shard {index: 2, of: 2, planSize: 5}`;
- `--shard 3/4` on a 2-item plan is refused `ShardEmpty`, with exit 2 and nothing written;
- `--shard` with `--canary` is a usage refusal;
- the second call: running `--shard 1/2` twice under two run ids plans the same case ids.

- [ ] **Step 2: Run and see them fail**

Run the vitest template on the three files. Expected: collection fails on the missing modules.

- [ ] **Step 3: Implement `shard.ts`**

```ts
// W1d D4: a shard is a stripe of the plan — item i (0-based) belongs to shard
// (i mod N) + 1. A pure function of plan order: the same case lands in the
// same shard on every run (ruling 61 compares per case across runs).
import { MAX_SHARDS } from "./results.ts";

export type Shard = { index: number; of: number };

export class BadShard extends Error {
  constructor(text: string) {
    super(`--shard ${JSON.stringify(text)} is not k/N with 1 ≤ k ≤ N and 2 ≤ N ≤ ${MAX_SHARDS}`);
    this.name = "BadShard";
  }
}

export function parseShard(text: string): Shard {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (m === null) throw new BadShard(text);
  const index = Number(m[1]); const of = Number(m[2]);
  if (of < 2 || of > MAX_SHARDS || index > of) throw new BadShard(text);
  return { index, of };
}

export function stripe<T>(items: readonly T[], s: Shard): T[] {
  return items.filter((_, i) => i % s.of === s.index - 1);
}

export function stripeSize(planSize: number, s: Shard): number {
  return planSize < s.index ? 0 : Math.floor((planSize - s.index) / s.of) + 1;
}
```

- [ ] **Step 4: Implement `merge.ts` and the CLI**

```ts
// W1d D5: N shard results of ONE layer back into one run, in plan order. Every
// way a shard can be short is refused by name (Review Focus 1, R25): a shard
// that is absent, failed (exit.txt missing or ≠ 0), aborted, short of its
// stripe, duplicated, from another commit/plan/layer/plan size, or carrying a
// secret. Nothing is merged around a hole.
import { findSecrets } from "./redact.ts";
import { parseResults, type RunResults } from "./results.ts";
import { stripeSize } from "./shard.ts";

export type ShardInput = { name: string; exit: string | null; results: unknown };

function refusal(name: string, message: string): Error { const e = new Error(message); e.name = name; return e; }

const SAME = ["harnessCommit", "layer", "driver", "plan"] as const;

export function mergeShards(inputs: readonly ShardInput[], runId: string): { merged: RunResults; checked: number } {
  if (inputs.length === 0) throw refusal("ShardMissing", "zero shards given — nothing to merge (vacuous)");
  for (const i of inputs) {
    if (i.exit === null) throw refusal("ShardFailed", `${i.name}: no exit.txt — the shard died before writing its exit code`);
    if (i.exit.trim() !== "0") throw refusal("ShardFailed", `${i.name}: exit ${i.exit.trim()} (run.ts: 1 zero cases, 2 refused, 3 aborted)`);
    if (i.results === null || i.results === undefined) throw refusal("ShardEmpty", `${i.name}: no results.json`);
    const leaks = findSecrets(JSON.stringify(i.results));
    if (leaks.length > 0) throw refusal("ShardSecret", `${i.name}: ${leaks.length} secret-shaped string(s) — refused before anything is written`);
  }
  const shards = inputs.map((i) => ({ name: i.name, r: parseResults(i.results) as RunResults }));
  const first = shards[0].r;
  if (first.shard === undefined) throw refusal("ShardMismatch", `${shards[0].name}: not a shard (no shard header)`);
  const { of, planSize } = first.shard;
  const byIndex = new Map<number, RunResults>();
  for (const { name, r } of shards) {
    if (r.shard === undefined) throw refusal("ShardMismatch", `${name}: not a shard (no shard header)`);
    if (r.aborted !== undefined) throw refusal("ShardAborted", `${name}: aborted at ${r.aborted.turn}`);
    for (const k of SAME) if (JSON.stringify(r[k]) !== JSON.stringify(first[k])) throw refusal("ShardMismatch", `${name}: ${k} ${JSON.stringify(r[k])} ≠ ${JSON.stringify(first[k])}`);
    if (JSON.stringify(r.grid) !== JSON.stringify(first.grid) || r.shard.of !== of || r.shard.planSize !== planSize) {
      throw refusal("ShardMismatch", `${name}: grid, shard count or plan size differs from ${shards[0].name}`);
    }
    if (byIndex.has(r.shard.index)) throw refusal("ShardDuplicate", `${name}: shard ${r.shard.index}/${of} given twice`);
    if (r.cases.length === 0) throw refusal("ShardEmpty", `${name}: zero cases`);
    const want = stripeSize(planSize, r.shard);
    if (r.cases.length !== want) throw refusal("ShardSize", `${name}: ${r.cases.length} cases, its stripe of ${planSize} holds ${want}`);
    for (const c of r.cases) if (c.layer !== r.layer) throw refusal("ShardMismatch", `${name}: case ${c.caseId} is ${c.layer} in an ${r.layer} run`);
    byIndex.set(r.shard.index, r);
  }
  for (let k = 1; k <= of; k++) if (!byIndex.has(k) && stripeSize(planSize, { index: k, of }) > 0) throw refusal("ShardMissing", `shard ${k}/${of} is absent`);
  const cases: RunResults["cases"] = [];
  const seen = new Set<string>();
  for (let i = 0; i < planSize; i++) {
    const c = byIndex.get((i % of) + 1)!.cases[Math.floor(i / of)];
    if (seen.has(c.caseId)) throw refusal("CaseCollision", `case ${c.caseId} appears in two shards`);
    seen.add(c.caseId); cases.push(c);
  }
  const all = [...byIndex.values()];
  const { shard: _drop, workers: _w, ...header } = first;
  const maxWorkers = Math.max(...all.map((r) => r.workers ?? 1));
  const merged: RunResults = {
    ...header, runId, shards: of,
    startedAt: all.map((r) => r.startedAt).sort()[0],
    finishedAt: all.map((r) => r.finishedAt).sort().at(-1)!,
    ...(maxWorkers > 1 ? { workers: maxWorkers } : {}),
    cases,
  };
  return { merged: parseResults(merged) as RunResults, checked: cases.length };
}
```

`lib/run-id.ts` is a straight move of run.ts's slug, plus a `run-cli.test.ts` case: "an upper-case run id is written to its lower-case directory, and the results.json names the slug". That pins the behaviour C1 tripped on, so no caller can assume otherwise again.

`merge-shards.ts` follows `render.ts`'s CLI shape, with a header of exit codes (0 merged; 2 refused, nothing written; 3 load crash through the package script).
- Positionals are shard directories. For each it reads `exit.txt`, or null when absent, and `results.json`, or null when absent; `JSON.parse` errors become exit 2 naming the dir.
- It calls `mergeShards`, then `writeResults(out, merged, …)` and `renderMatrix` → `MATRIX.md` (through `redact`), and prints `merged <checked> cases from <N> shards → <out>`.
- Any refusal prints `merge-shards: <name>: <message>` and returns 2.

Add a CLI test to `merge.test.ts`: spawn it on three temp shard dirs with exit 0 and assert the files are written; spawn it on dirs missing `exit.txt` and assert exit 2 and no `results.json` in `--out`.

- [ ] **Step 5: Wire `--shard` into run.ts**

1. `parseCli` gains `shard: { type: "string" }`, read through `parseShard`; `BadShard` maps to the usage refusal. `--shard` with `--canary` is a usage refusal.
2. In `execute`, immediately after `runItems` returns the full plan's items (`run.ts:~839-845`):

```ts
const planSize = items.length;
const mine = cli.shard === undefined ? items : stripe(items, cli.shard);
if (cli.shard !== undefined && mine.length === 0) throw new ShardEmptyPlan(cli.shard, planSize);
```

   `ShardEmptyPlan` is named `"ShardEmpty"`, with the message `shard k/N of a plan of P items holds none — fewer items than shards`. Add it to `runSlice`'s `refused` list → exit 2.
3. The header gains `...(cli.shard !== undefined ? { shard: { ...cli.shard, planSize } } : {})`. `plan` stays `planOf(cli)`, without the shard, so every shard of a run carries the same plan string.
4. USAGE gains `--shard k/N  run only plan items i with i mod N = k−1 (W1d D4)`.

- [ ] **Step 6: Run and see them pass**

Run the vitest template on `shard.test.ts merge.test.ts run-shard.test.ts run-cli.test.ts strip-types-loadable.test.ts`. All green; paste the counts. The property test's `checked` must be 300.

- [ ] **Step 7: Mutate**

| Mutant | Killing test |
|---|---|
| In `stripe`, `i % s.of === s.index - 1` → `i % s.of === s.index` | the property test |
| In `mergeShards`, delete the `ShardSize` check | "a partial shard" |
| Delete the `exit.trim() !== "0"` line | "a shard that died" (exit "3") |
| Delete the `ShardMissing` loop | "a shard that died" (missing middle shard) |
| Delete the `CaseCollision` check | Add a test with two shards whose fixtures carry the same case id at the same stripe position. Reaching it needs a hand-built collision fixture; the test is "two shards naming one case is refused". |

The `ShardMissing` and `ShardSize` checks cover for each other (a missing shard also shortens the total), so mutate them one at a time.

- [ ] **Step 8: Scoped tsc, eslint, commit**

Run scoped tsc on `shard.ts merge.ts merge-shards.ts run.ts`. Commit `feat(matrix): --shard k/N stripes a plan; merge-shards rebuilds it and refuses any short shard (W1d D4, D5)`.

---

### Task 5: Refusals before a run — NoLayerForWidth, a run id the DB already holds (items 5, 12, 25)

**Why:**
- Item 5: `NoLayerForWidth` exits 3 (aborted) when it is a precondition refusal (2).
- Items 12 and 25: a run id reused with another `--report-dir` (or by `model.ts`) against the same DB collides on the case org slug `m-<runId>-<n>` with a raw 23505 mid-run.

Under sharding this matters: a re-dispatched CI attempt reuses nothing (each attempt's run id carries `github.run_attempt`), but a local re-run of a shard does.

**Files:**
- Modify:
  - `tools/matrix/run.ts` (`refused` list `:1059-1062`; a DB probe before the first case);
  - `tools/matrix/lib/seed-org.ts` (`runIdTaken(sql, runId)`);
  - `tools/matrix/model.ts:~200-416` (the same probe).
- Test: `tools/matrix/__tests__/run-refusals.test.ts` (create), `tools/matrix/__tests__/model-cli.test.ts` (extend).

**Interfaces:**
- Produces:
  - `runIdTaken(sql: Sql, runId: string): Promise<number>`: the count of `organizations` rows whose slug starts with `m-<runId>-`. Use parameterised `LIKE $1 || '%'` with the id escaped for `%`/`_`;
  - `class RunIdUsedInDb extends Error`, `name "RunIdUsedInDb"`, with the message `run id <id> already seeded <n> org(s) in this database — pick a fresh --run-id (item 12)`. It is refused (exit 2) in both CLIs.

- [ ] **Step 1: Write the failing tests**

```ts
it("NoLayerForWidth is a refusal (exit 2), not an abort (item 5)", async () => {
  const code = await runSliceWith({ planCases: () => { throw new NoLayerForWidth(999); } });
  expect(code).toBe(2);
});
it("a run id this DB already seeded is refused before any case runs (items 12, 25)", async () => {
  const deps = fakeDeps({ runIdTaken: async () => 3 });
  const code = await runSliceWith(deps, ["--run-id", "w1d-dup"]);
  expect(code).toBe(2);
  expect(deps.casesStarted).toBe(0);
  expect(deps.stderr).toContain("already seeded 3 org(s)");
});
it("the empty case: a fresh run id (zero orgs) proceeds", async () => {
  const deps = fakeDeps({ runIdTaken: async () => 0 });
  expect(await runSliceWith(deps, ["--run-id", "w1d-fresh"])).toBe(0);
});
it("a run id containing % or _ cannot match other ids (the LIKE escape)", () => {
  expect(likePrefixOf("w1d_a")).toBe("m-w1d\\_a-");
});
```

`runSliceWith` and `fakeDeps` extend the existing `RunDeps` fakes; `RunDeps` gains `runIdTaken?`. The `model-cli.test.ts` case is the same refusal through `model.ts`'s deps.

- [ ] **Step 2: Run and see it fail**

Run the vitest template on the two files. Expected: NoLayerForWidth returns 3, and `runIdTaken` is unknown.

- [ ] **Step 3: Implement**

1. Add `NoLayerForWidth` to `refused`.
2. In `execute`, after the DB connection opens and BEFORE sign-in, run `const taken = await (deps.runIdTaken ?? runIdTaken)(sql, cli.runId); if (taken > 0) throw new RunIdUsedInDb(cli.runId, taken);`, and add `RunIdUsedInDb` to `refused`.
3. Do the same in `model.ts` before its first `caseOrgSlug`.
4. Export `likePrefixOf(runId)` from `seed-org.ts`, and use it in the SQL.

- [ ] **Step 4: Run, mutate, commit**

Run the vitest template on both files, green. Mutate:

| Mutant | Killing test |
|---|---|
| `taken > 0` → `taken > 5` | "already seeded 3" |
| Remove `NoLayerForWidth` from `refused` | the item 5 test |

Then run scoped tsc and eslint, and commit `feat(matrix): NoLayerForWidth and a run id the DB already holds are refusals (W1d items 5, 12, 25)`.

---

### Task 6: The judge, and one exit convention (ruling 61, D6, D8, item 6; Review Focus 3, 4)

**Why:**
- Ruling 61's verdict must be mechanical: three merged runs per layer, identical case-id sets, identical states, no harness fault.
- The per-PR sample needs a regression judge against the baseline.
- Item 6: the CLIs disagree on what each exit code means.

**Files:**
- Create: `tools/matrix/lib/judge.ts`, `tools/matrix/judge.ts`, `tools/matrix/lib/exit-codes.ts`
- Modify:
  - `tools/matrix/lib/results.ts`: export `VACUOUS_REASONS` (the two exact strings and the one prefix `decideState` writes at `:256,260,262`), and use them in `decideState`, so the judge and the writer share one authority;
  - `tools/matrix/parity.ts:58,70` (3 → 2);
  - `tools/matrix/findings-table.ts` (refused 1 → 2, unreadable 3 → 2, and its header);
  - `tools/matrix/draw-counts.ts` (the same);
  - `tools/matrix/lib/driver/types.ts`: `class SetupRefused extends RefusedCall`, beside `RefusedCall` (`:236`), with `name = "SetupRefused"` set in the constructor body (strip-types rule) and a `static from(e: RefusedCall)` that keeps the original message (D6, review 3 R3-m2);
  - `tools/matrix/lib/scenarios/common.ts`: exported `inSetup<T>(f: () => Promise<T>): Promise<T>`, wrapping `setUpDivision`'s pre-start calls (D6);
  - `tools/matrix/lib/scenarios/denied.ts`: `inSetup` around `:63`, `:64`, `:76` and `:77` (review 3, R3-m3);
  - `package.json` (`"matrix:judge": …`).
- Test:
  - `tools/matrix/__tests__/judge.test.ts`, `tools/matrix/__tests__/exit-codes.test.ts` (create);
  - `tools/matrix/__tests__/scenarios.test.ts` (extend: the phase tag, through the real `setUpDivision`);
  - extend the three CLIs' existing tests where they pin an exit code.

**Interfaces:**
- Produces:
  - `harnessFaults(run: RunResults, opts: { plannedNotRun: "allow" | "refuse" }): { caseId: string; kind: "crash" | "harness-error" | "setup-refused" | "vacuous" | "unplanned-not-run" | "planned-not-run" | "marker-on-driven"; reason: string }[]`. Ruling 65 fixes `plannedNotRun` at `allow` (the default) for every caller. `refuse` exists only so a test can show what the option changes.
  - `SetupRefused extends RefusedCall` (driver/types.ts) and `inSetup` (scenarios/common.ts). There is no route list: the phase is the authority (review 2, R2-I2, which also retires the round-1 `SETUP_CALLS` examples, R2-m7). The org itself is seeded in SQL (`seed-org.ts:225-235`), so no HTTP refusal can come from it. Sign-in (`tools/bench/lib/http.ts:80`) refuses before any case exists, which is a run-level abort, not a case red.
  - `statesAcross(runs: readonly RunResults[]): { compared: number; differing: { caseId: string; states: string[] }[]; missing: { caseId: string; inRuns: number[] }[] }`
  - `regressions(baseline: RunResults, now: RunResults): { compared: number; regressed: { caseId: string; was: CaseState; now: CaseState; reason: string }[]; absent: string[] }`
  - `EXIT_CODES: Record<0 | 1 | 2 | 3, string>`
  - CLI `judge.ts`, two modes:
    - `across <runA.json> <runB.json> <runC.json> [--planned-not-run allow|refuse]`: exit 0 harness-green; 1 not green (faults or differences listed); 2 refused (fewer than 2 runs, unreadable, different layer, plan or `harnessCommit` — three runs of two products are not a flakiness measure (D21) — or zero cases compared);
    - `regression --baseline <file> --now <file> --expect <ids.json> [--rerun <file>]`: exit 0 none; 1 reproduced regressions; 2 refused (an expected case absent from `now`, a `now` case not in `--expect`, unreadable, zero compared). `--expect` is the exact case-id list the sample PLANNED (written by `run-sample.ts` from `planPrSample`), and the baseline is restricted to exactly those ids (review C3c). Never use a cell filter.
    - `faults <run.json> [--planned-not-run allow|refuse]`: one merged run's harness faults (D6), used by the workflow's merge job on every run. Exit 0 none; 1 faults listed; 2 refused (unreadable, zero cases).
    - The `planned` marker is trusted only in the shape it can be checked without a plan (review 2, R2-m6). A `planned: true` case with `durationMs > 0` or any check is a driven result relabelled, so it is a `marker-on-driven` fault, the same shape as `judgeRun`'s I-2 check. Whether a marked case is in the plan's planned SET is not checked in CI. The backstop is `committed-plans-frozen.test.ts`'s `judgeRun` (Task 2's second check), which runs on PR-B's committed baseline, and the task report says so.

- [ ] **Step 0: Read the setup seam**

Open `scenarios/common.ts:196-285` and list every `ctx.driver.*` call before `ctx.driver.start(division.id)`, each with its line. Then confirm that no caller depends on catching a refusal from inside setup: `rtk proxy grep -an "setUpDivision(" tools/matrix/lib -r`, opening each hit for an enclosing `try`. Because `SetupRefused` extends `RefusedCall`, such a catch still works, but record any you find. Then check the committed L3 evidence:

```bash
cd <exec> && node -e 'const r=require("./docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-l3/results.json");const m={};for(const c of r.cases){const x=/^error: RefusedCall: ([A-Z]+ \S+) →/.exec(c.reason||"");if(x){const k=x[1].replace(/[0-9a-f-]{36}/g,"<id>");m[k]=(m[k]||0)+1}}console.log(m)'
```

Expected at HEAD: `{ "POST /api/v1/entrants/<id>/withdraw": 11 }`. That is the R4 action (P5 → W4), raised after setup, so it stays `RefusedCall`. A test pins it: "the 11 committed RefusedCall reds are data", run over the real `TR/w1drv-l3/results.json`, which expects 11 checked and zero setup-refused faults.

- [ ] **Step 1: Write the failing tests**

`judge.test.ts` (fixtures via a `run(cases)` builder producing valid merged v3 runs):

```ts
const ok = (id: string, state = "works", reason = "") => ({ caseId: id, state, reason, checks: state === "works" ? [chk()] : [] });

describe("harnessFaults (D6)", () => {
  it("the empty case: a run with zero cases is refused by the CLI, and has no faults by itself", () => {
    expect(harnessFaults(run([]), { plannedNotRun: "allow" })).toEqual([]);
  });
  it("names each class once, and a product refusal is data, not a fault", () => {
    const f = harnessFaults(run([
      ok("a", "red", "error: crashed — TypeError: x is undefined"),
      ok("b", "red", "error: DriverMisuse: no such control"),
      ok("c", "red", "error: RefusedCall: POST /api/v1/stages/1/start → HTTP 422 WRONG_PHASE: not now"),
      ok("d", "red", VACUOUS_REASONS.none),
      { ...ok("e", "not_run", "no scenario script yet (atom M7)") },
      { ...ok("f", "not_run", "no scenario script yet (atom M7)"), planned: true },
      ok("g", "later", "W4 owes the path"),
      ok("h", "red", "standings: expected 3, saw 2"),
      ok("i", "needs_ruling", "the rulebook is silent on …"),
      ok("j", "red", "error: SetupRefused: POST /api/v1/divisions/0b2c/entrants → HTTP 422 VALIDATION: members"),
      ok("k", "red", "error: RefusedCall: POST /api/v1/entrants/0b2c/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant"),
    ]), { plannedNotRun: "allow" });
    expect(f.map((x) => [x.caseId, x.kind])).toEqual([["a", "crash"], ["b", "harness-error"], ["d", "vacuous"], ["e", "unplanned-not-run"], ["j", "setup-refused"]]);
  });
  it.each([["none"], ["abstained"], ["zeroItems"]] as const)("every vacuity reason decideState writes is a fault: %s (strings from results.ts, review I3)", (k) => {
    const reason = k === "zeroItems" ? `${VACUOUS_REASONS.zeroItemsPrefix} i1-standings, i4-complete` : VACUOUS_REASONS[k];
    expect(harnessFaults(run([ok("v", "red", reason)]), { plannedNotRun: "allow" }).map((x) => x.kind)).toEqual(["vacuous"]);
  });
  it("ruling 65: a planned ░ (L2's 1,505) is not a fault, and a ░ on a driven case still is", () => {
    const f = harnessFaults(run([{ ...ok("p", "not_run", "no scenario script yet (atom M7)"), planned: true }, ok("q", "not_run", "lost result")]), { plannedNotRun: "allow" });
    expect(f).toEqual([{ caseId: "q", kind: "unplanned-not-run", reason: "lost result" }]);
  });
  it("the 11 committed RefusedCall reds are data: no fault of ANY kind names one of them (11 checked)", () => {
    const real = parseResults(JSON.parse(readFileSync(TR_W1DRV_L3, "utf8")));
    const refused = real.cases.filter((c) => (c.reason ?? "").startsWith("error: RefusedCall:"));
    expect(refused).toHaveLength(11);
    const ids = new Set(refused.map((c) => c.caseId));
    // ANY kind: a broken RefusedCall exemption would make all 11 'harness-error', and a setup-refused-only filter would stay green (class 4; review 3, R3-m5)
    expect(harnessFaults(real, { plannedNotRun: "allow" }).filter((x) => ids.has(x.caseId))).toEqual([]);
  });
  it("a planned marker on a case that ran (durationMs > 0 or checks) is a fault under allow too (review 2, R2-m6)", () => {
    const f = harnessFaults(run([{ ...ok("m", "works"), planned: true, durationMs: 1200 }, { ...ok("n", "not_run", "x"), planned: true, durationMs: 0 }]), { plannedNotRun: "allow" });
    expect(f.map((x) => [x.caseId, x.kind])).toEqual([["m", "marker-on-driven"]]);
  });
  it("the refuse lever (rejected alternative (c)) is what makes a planned ░ a fault — so allow is doing the work", () => {
    const f = harnessFaults(run([{ ...ok("f", "not_run", "x"), planned: true }]), { plannedNotRun: "refuse" });
    expect(f.map((x) => x.kind)).toEqual(["planned-not-run"]);
  });
});

describe("statesAcross (ruling 61; Review Focus 3)", () => {
  it("a case whose state differs in one run of three is named with all three states, and the verdict is not green", () => {
    const r = statesAcross([run([ok("a"), ok("b")]), run([ok("a"), ok("b", "red", "x")]), run([ok("a"), ok("b")])]);
    expect(r.compared).toBe(2);
    expect(r.differing).toEqual([{ caseId: "b", states: ["works", "red", "works"] }]);
  });
  it("a red that is the same red in all three runs is NOT a difference (product reds are data)", () => {
    const r = statesAcross([run([ok("a", "red", "x")]), run([ok("a", "red", "y")]), run([ok("a", "red", "x")])]);
    expect(r.differing).toEqual([]);
  });
  it("a case missing from one run is named with the runs that hold it", () => {
    expect(statesAcross([run([ok("a"), ok("b")]), run([ok("a")]), run([ok("a"), ok("b")])]).missing).toEqual([{ caseId: "b", inRuns: [0, 2] }]);
  });
});

describe("regressions (D13; Review Focus 4)", () => {
  it("known red stays red passes; ✅→❌ fails; ⛔→✅ is not a regression; an EXPECTED case missing from now is absent", () => {
    const base = run([ok("a", "red", "x"), ok("b"), ok("c", "refused", "422"), ok("d"), ok("e")]);
    const now = run([ok("a", "red", "x"), ok("b", "red", "y"), ok("c")]);
    const r = regressions(base, now, ["a", "b", "c", "d"]);   // e: in the baseline, not planned by the sample → ignored
    expect(r.regressed.map((x) => x.caseId)).toEqual(["b"]);
    expect(r.absent).toEqual(["d"]);
    expect(r.compared).toBe(3);
  });
  it("a ✅ case that comes back ✅ on the single re-run is not reported (CLI --rerun)", () => {
    const code = judgeCli(["regression", "--baseline", f(run([ok("b")])), "--now", f(run([ok("b", "red", "y")])), "--expect", ids(["b"]), "--rerun", f(run([ok("b")]))]);
    expect(code).toBe(0);
  });
  it("faults mode: exit 1 on one crash red, 0 on a run of product reds only, 2 on zero cases", () => {
    expect(judgeCli(["faults", f(run([ok("a", "red", "error: crashed — x")]))])).toBe(1);
    expect(judgeCli(["faults", f(run([ok("a", "red", "standings: expected 3, saw 2")]))])).toBe(0);
    expect(judgeCli(["faults", f(run([]))])).toBe(2);
  });
  it("…and one that is red again on the re-run is exit 1, named", () => {
    const code = judgeCli(["regression", "--baseline", f(run([ok("b")])), "--now", f(run([ok("b", "red", "y")])), "--expect", ids(["b"]), "--rerun", f(run([ok("b", "red", "y")]))]);
    expect(code).toBe(1);
  });
});
```

`scenarios.test.ts` gains the phase tag's tests, through the REAL `setUpDivision` with a fake driver in the file's existing `override` pattern (`:982`):
- positive control: "a driver refusing `addEntrants` surfaces as `SetupRefused`, and is still `instanceof RefusedCall`";
- the same for `createDivision` and `postStages`;
- the negative pair: "a driver refusing `start` surfaces as a plain `RefusedCall`, not `SetupRefused`" (start is the product's act);
- the end-to-end case: one fake-driver case run through `execute` (the `run-cli.test.ts` deps pattern) whose `addEntrants` refuses. Its `results.json` reason EQUALS `error: SetupRefused: ${original.message}` (the whole string, so a doubled prefix reds), and `harnessFaults` names it `setup-refused`;
- DENIED (review 3, R3-m3): through the real scenario with a fake driver, a refused `:77` `postStages` surfaces as `SetupRefused`, while `:67`'s gated refusal is still caught as data. Each test counts the calls the fake answered, so a setup that never reached the refusing call fails rather than passing empty.

`f(run)` writes the run to a temp file, `ids(list)` writes a JSON id list, and `judgeCli` calls `main(argv)` with stdout/stderr captured.

`exit-codes.test.ts` reads each CLI's header comment as text: `run.ts`, `render.ts`, `parity.ts`, `findings-table.ts`, `draw-counts.ts`, `gen-catalogue.ts`, `single-sport.ts`, `model.ts`, `merge-shards.ts`, `judge.ts` and `lock-append-only.ts`. For each, it asserts:
- every code the header declares is in `EXIT_CODES`;
- an input-unreadable line is declared under 2;
- no header declares "refused" under 1.

It counts the CLIs read and expects 11, so the zero-checked case fails.

- [ ] **Step 2: Run and see them fail**

Expected: the modules are missing, and exit-codes fails on `parity.ts` (3 for unreadable) and `findings-table.ts` (1 for refused).

- [ ] **Step 3: Implement `lib/judge.ts`**

```ts
// Ruling 61 (design §6.5) and D6: harness-green is mechanical. A harness
// fault is a crash, a non-product error, a vacuous red, or a ░ the plan did
// not mark planned; product reds (incl. RefusedCall — the product answering)
// are data. States must be identical across runs, per case.
import { VACUOUS_REASONS, type CaseState, type RunResults } from "./results.ts";

export type FaultKind = "crash" | "harness-error" | "setup-refused" | "vacuous" | "unplanned-not-run" | "planned-not-run" | "marker-on-driven";
// results.ts: { none: "no checks ran (vacuous)", abstained: "every check abstained (vacuous)",
//               zeroItemsPrefix: "checked zero items (vacuous):" } — the third carries a suffix of check ids.
const isVacuous = (r: string): boolean => r === VACUOUS_REASONS.none || r === VACUOUS_REASONS.abstained || r.startsWith(VACUOUS_REASONS.zeroItemsPrefix);
// D6: a refusal raised inside setUpDivision's setup phase is tagged SetupRefused at the seam
// (scenarios/common.ts inSetup) — the harness asked wrongly. A RefusedCall anywhere else is the product answering.

export function harnessFaults(run: RunResults, opts: { plannedNotRun: "allow" | "refuse" }) {
  const out: { caseId: string; kind: FaultKind; reason: string }[] = [];
  for (const c of run.cases) {
    const reason = c.reason ?? "";
    let kind: FaultKind | null = null;
    if (c.planned === true && (c.durationMs > 0 || c.checks.length > 0)) kind = "marker-on-driven";   // R2-m6
    else if (c.state === "red" && reason.startsWith("error: crashed —")) kind = "crash";
    else if (c.state === "red" && reason.startsWith("error: SetupRefused:")) kind = "setup-refused";
    else if (c.state === "red" && reason.startsWith("error: ") && !reason.startsWith("error: RefusedCall:")) kind = "harness-error";
    else if (c.state === "red" && isVacuous(reason)) kind = "vacuous";
    else if (c.state === "not_run" && c.planned !== true) kind = "unplanned-not-run";
    else if (c.state === "not_run" && opts.plannedNotRun === "refuse") kind = "planned-not-run";
    if (kind !== null) out.push({ caseId: c.caseId, kind, reason });
  }
  return out;
}

export function statesAcross(runs: readonly RunResults[]) {
  const ids = new Set(runs.flatMap((r) => r.cases.map((c) => c.caseId)));
  const maps = runs.map((r) => new Map(r.cases.map((c) => [c.caseId, c.state as string])));
  const differing: { caseId: string; states: string[] }[] = [];
  const missing: { caseId: string; inRuns: number[] }[] = [];
  let compared = 0;
  for (const id of ids) {
    const inRuns = maps.flatMap((m, i) => (m.has(id) ? [i] : []));
    if (inRuns.length !== runs.length) { missing.push({ caseId: id, inRuns }); continue; }
    compared++;
    const states = maps.map((m) => m.get(id)!);
    if (new Set(states).size > 1) differing.push({ caseId: id, states });
  }
  return { compared, differing, missing };
}

const HELD: ReadonlySet<string> = new Set(["works", "refused"]);

export function regressions(baseline: RunResults, now: RunResults, expected: readonly string[]) {
  const want = new Set(expected);
  const nowBy = new Map(now.cases.map((c) => [c.caseId, c]));
  const regressed: { caseId: string; was: CaseState; now: CaseState; reason: string }[] = [];
  const absent: string[] = [];
  let compared = 0;
  for (const b of baseline.cases) {
    if (!want.has(b.caseId)) continue;   // not planned by this sample (review C3c)
    const n = nowBy.get(b.caseId);
    if (n === undefined) { if (HELD.has(b.state)) absent.push(b.caseId); continue; }
    compared++;
    if (HELD.has(b.state) && !HELD.has(n.state)) regressed.push({ caseId: b.caseId, was: b.state, now: n.state, reason: n.reason ?? "" });
  }
  return { compared, regressed, absent };
}
```

Two notes for the implementer:
- `regressions`' `compared` counts expected cases present in both runs. Only baseline ✅/⛔ cases count as `absent`. The restriction is by EXACT case id from `--expect`, never by cell or scenario: the baseline's `league|cricket|test|LIFECYCLE|cricket#…` cases share a cell and a scenario with the fixed sample's `league|cricket|<variant>|LIFECYCLE`, and a cell filter would report them absent on every PR (review C3c). The CLI also refuses (exit 2) a `now` case that is not in `--expect`, so a sample that planned something else cannot pass by omission.
- The check `regressed` × `rerun`: the CLI keeps only cases red in BOTH `--now` and `--rerun` (a `--rerun` without the case = exit 2).

`judge.ts` (CLI):
- the `across` output prints, per layer, `compared N cases across K runs; D differing; F faults`, listing each differing case with its states and each fault with its kind;
- `regression` prints each reproduced regression with was → now and its reason (redacted);
- both print the D8 exit header.

`lib/exit-codes.ts`:

```ts
// D8 (item 6): one meaning per code across every tools/matrix CLI. Each CLI's
// header comment states its own codes in these words; exit-codes.test.ts holds
// every header to this table.
export const EXIT_CODES = Object.freeze({
  0: "done — a verdict or data was written",
  1: "a negative signal: a difference, drift, zero cases, a regression, a harness fault",
  2: "refused, nothing written: usage, unreadable input, a refused precondition",
  3: "aborted after start, or a crash while loading (through the package script's preload)",
} as const);
```

- [ ] **Step 4: Normalise the three CLIs**

- `parity.ts:58,70` → `return 2`, and update its header line.
- `findings-table.ts`: "refused" → 2, "unreadable" → 2. Its 1 is now unused: the header says so ("1 is not used").
- `draw-counts.ts`: the same.

Find each one's tests that pin the old code (`rtk proxy grep -an "status).toBe(3)\|toBe(1)" tools/matrix/__tests__/{parity,findings-table,draw-counts}*.test.ts`) and change them to 2, under a comment `// D8: unreadable input is a refusal`. A grep is not a read, so open each test and confirm it pins the INPUT failure before changing it.

- [ ] **Step 5: Run and see them pass**

Run the vitest template on:

```
judge.test.ts exit-codes.test.ts parity.test.ts findings-table.test.ts draw-counts.test.ts scenarios.test.ts run-cli.test.ts strip-types-loadable.test.ts
```

All eight exist at HEAD except the two created here (re-pinned 2026-10-04: `parity`, `findings-table`, `draw-counts`, `scenarios`, `run-cli`, `strip-types-loadable`). `.testResults[].name` must list exactly 8 files.

- [ ] **Step 6: Mutate**

| Mutant | Killing test |
|---|---|
| In `harnessFaults`, drop `&& !reason.startsWith("error: RefusedCall:")` | "names each class once" (c would be a fault) |
| Drop the `inSetup` wrapper around `addEntrants` | "a driver refusing `addEntrants` surfaces as `SetupRefused`" |
| Move `driver.start` inside `inSetup` | "a driver refusing `start` surfaces as a plain `RefusedCall`" |
| Drop the `RefusedCall` exemption in the harness-error branch | "the 11 committed RefusedCall reds are data" (any kind; review 3, R3-m5) |
| `SetupRefused.from` rebuilds from `e.message` | the e2e case's whole-reason equality (R3-m2) |
| Remove `inSetup` from `denied.ts:77` | DENIED's `:77` case (R3-m3) |
| `SetupRefused` no longer extends `RefusedCall` | "…and is still `instanceof RefusedCall`" |
| Drop the `marker-on-driven` branch | "a planned marker on a case that ran … is a fault under allow too" |
| Delete the `setup-refused` branch in `harnessFaults` | "names each class once" (j would read `harness-error`) |
| `isVacuous` back to exact match only | the `zeroItems` row of "every vacuity reason decideState writes" |
| `regressions` ignoring `expected` | "an EXPECTED case missing from now is absent" (e would be absent) |
| `c.planned !== true` → `true` | the same test (f would be a fault) |
| In `statesAcross`, `new Set(states).size > 1` → `> 2` | "differs in one run of three" |
| In `regressions`, `HELD` without `"refused"` | "⛔→✅ is not a regression" plus a new line asserting ⛔→❌ IS one |
| `parity.ts` back to 3 | `exit-codes.test.ts` |

- [ ] **Step 7: Scoped tsc, eslint, commit**

Commit `feat(matrix): judge — harness-green across runs and regression vs baseline; one exit convention (W1d ruling 61, D6, D8, item 6)`.

---

### Task 7: The per-PR sample — `--set pr-sample` and the rows a PR declares (R27, D13)

**Why:** R27 says a PR touching the engine or `stages.ts` declares its rows, and the matrix samples them. Today nothing reads the declaration and there is no set to run.

**Files:**
- Create:
  - `tools/matrix/lib/pr-sample.ts`;
  - `tools/matrix/ci/pr-rows.ts`;
  - `tools/matrix/catalogue/baseline.json` (`{ "L3": "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-l3/results.json" }`).
- Modify: `tools/matrix/run.ts` (`SETS` adds `pr-sample`; `--rows` accepted only with `--set pr-sample`; `planOf` records `--set pr-sample --rows <sorted>`).
- Test: `tools/matrix/__tests__/pr-sample.test.ts`, `tools/matrix/__tests__/pr-rows.test.ts` (create).

**Interfaces:**
- Produces:
  - `PR_SAMPLE_SET = "pr-sample"`;
  - `fixedSample(variantFor: (sport: string) => string): CaseSpec[]`. It returns `planSliceCases(variantFor)` (24) plus `league|<sport>|<variantFor(sport)>|LIFECYCLE` for each `SPORT_KEYS` sport not in `SLICE_SPORTS` (9). `variantFor` is the only variant authority (review m10);
  - `parseRows(text: string): readonly string[] | "all"`, which throws `UnknownRow` naming the row and the 21 catalogue rows;
  - `planPrSample(rows: readonly string[] | "all", variantFor): CaseSpec[]`. It calls `planW1Driving(variantFor, {})`: the full w1-driving set, with the filter argument explicit (`w1-driving-set.ts:183`; review m2), filtered to `rows`;
  - `baselineL3Path(): string` reads `catalogue/baseline.json`'s `L3` and resolves it against the repo root. It throws when the file is missing.
  - CLI `ci/pr-rows.ts --body-file <path> --changed-file <path>`. It prints `rows=<csv|all|none>` to stdout (for `$GITHUB_OUTPUT`). Exit 0 decided; 1 the PR touches a declaring path and declares no rows (R27), naming the paths and telling the author to edit the PR body and re-run the job (the job reads the body live); 2 usage or unreadable.

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseRows (R27)", () => {
  it.each([["Matrix rows: league, swiss", ["league", "swiss"]], ["matrix rows:all", "all"], ["Matrix rows: none — copy only", []]])("%j", (t, want) => expect(rowsFromBody(t)).toEqual(want));
  it("an unknown row is refused by name, listing the catalogue", () => expect(() => rowsFromBody("Matrix rows: leage")).toThrow(/leage.*league/s));
  it("the empty body declares nothing (null), which is not 'none'", () => expect(rowsFromBody("")).toBeNull());
  it("only the first Matrix rows: line counts; a quoted one inside a code fence is ignored", () => {
    expect(rowsFromBody("```\nMatrix rows: all\n```\nMatrix rows: swiss")).toEqual(["swiss"]);
  });
});

describe("pr-rows decision", () => {
  it("an engine change with no declaration is exit 1, naming the path", () => {
    expect(decide({ body: "fixes a bug", changed: ["packages/engine/src/competition/standings.ts"] })).toEqual({ exit: 1, why: expect.stringContaining("packages/engine/src/competition/standings.ts") });
  });
  it("stages.ts is a declaring path too", () => expect(decide({ body: "", changed: ["apps/web/src/server/usecases/stages.ts"] }).exit).toBe(1));
  it("a UI-only change needs no declaration and samples only the fixed sample", () => expect(decide({ body: "", changed: ["apps/web/src/components/x.tsx"] })).toEqual({ exit: 0, rows: [] }));
  it("the empty change list is refused (vacuous)", () => expect(decide({ body: "Matrix rows: all", changed: [] }).exit).toBe(2));
});

describe("the sample against the real baseline (review C3c)", () => {
  it("the real committed baseline against the real fixed sample: zero absent when now holds every planned case", () => {
    const baseline = parseResults(JSON.parse(readFileSync(baselineL3Path(), "utf8")));   // catalogue/baseline.json's L3
    const expected = planPrSample([], offlineBuilderDefault).map((c) => c.caseId);
    const now = { ...baseline, cases: baseline.cases.filter((c) => expected.includes(c.caseId)) };
    const r = regressions(baseline, now, expected);
    expect(r.absent).toEqual([]);
    expect(r.compared).toBeGreaterThan(0);
    expect(r.compared).toBe(now.cases.length);
    // review 2, R2-m3: every planned sample case has a baseline twin — a sample case the baseline lacks protects nothing.
    // 33 at HEAD (24 slice + 9 league LIFECYCLE), derived here, not typed in.
    expect(r.compared).toBe(expected.length);
  });
  it("…and the cell filter it replaced WOULD have reported the cricket test cases absent (the regression this guards)", () => {
    const baseline = parseResults(JSON.parse(readFileSync(baselineL3Path(), "utf8")));
    expect(baseline.cases.filter((c) => c.caseId.startsWith("league|cricket|test|LIFECYCLE|")).length).toBeGreaterThan(0);
  });
});

describe("planPrSample", () => {
  const W1 = planW1Driving(offlineBuilderDefault, {});    // the committed w1-driving set, unfiltered, is the authority for row cases
  it("the fixed sample is the 24 slice cases plus league LIFECYCLE on the 9 sports the slice lacks", () => {
    const cases = planPrSample([], offlineBuilderDefault);
    expect(cases).toHaveLength(SLICE_ROWS.length * SLICE_SPORTS.length * SCENARIO_KEYS.length + (SPORT_KEYS.length - SLICE_SPORTS.length));
  });
  it("a declared row adds exactly the w1-driving cases on that row, never twice", () => {
    const cases = planPrSample(["swiss"], offlineBuilderDefault);
    const want = new Set([...planPrSample([], offlineBuilderDefault).map((c) => c.caseId), ...W1.filter((c) => c.caseId.startsWith("swiss|")).map((c) => c.caseId)]);
    expect(new Set(cases.map((c) => c.caseId))).toEqual(want);
    expect(cases).toHaveLength(want.size);
  });
  it("'all' is the whole w1-driving set plus the fixed sample", () => {
    expect(planPrSample("all", offlineBuilderDefault).length).toBeGreaterThanOrEqual(W1.length);
  });
});
```

`rowsFromBody` and `decide` are exported from `ci/pr-rows.ts`. The expected-count line derives from the slice constants and `SPORT_KEYS` (rule 2), not from `fixedSample(offlineBuilderDefault).length`.

- [ ] **Step 2: Run and see them fail**

- [ ] **Step 3: Implement**

1. `pr-sample.ts`:
   - `fixedSample(v)` = `planSliceCases(v)` (all 24) ∪ `league|<sport>|<v(sport)>|LIFECYCLE` for each `SPORT_KEYS` sport not in `SLICE_SPORTS`;
   - `planPrSample(rows, v)` = that ∪ `planW1Driving(v, {})` filtered to `rows`, deduplicated by `caseId`, in w1-driving order and then the fixed sample;
   - an empty plan is impossible (the fixed sample is non-empty), and that is asserted.
2. `pr-rows.ts`:
   - `DECLARING = [/^packages\/engine\//, /^apps\/web\/src\/server\/usecases\/stages\.ts$/]` (R27's two paths, verbatim from `_RULES.md` R27);
   - the body regex is `/^Matrix rows:\s*(.+)$/im`, taken from the body with fenced blocks stripped first;
   - `none — <reason>` → `[]`.
3. `run.ts`:
   - `SETS[PR_SAMPLE_SET] = makePrSamplePlanner(cli.rows)`;
   - `--rows` is parsed by `parseRows` (usage refusal on `UnknownRow`) and refused without `--set pr-sample`;
   - `planOf` → `--set pr-sample --rows <sorted csv|all|none>`.

   The `committed-matrix.test.ts` test "livePlan reads every --set the runner registers" will now red on the new set until `expectedPlanFor` knows it. Teach it `--set pr-sample --rows …`, with no committed run of it expected yet.

- [ ] **Step 4: Run, mutate, commit**

Run the vitest template on `pr-sample.test.ts pr-rows.test.ts run-cli.test.ts committed-matrix.test.ts` (`files: 4`; the first two are new). Mutate:

| Mutant | Killing test |
|---|---|
| `DECLARING` without the stages.ts entry | "stages.ts is a declaring path too" |
| Drop the dedupe in `planPrSample` | "never twice" |

**Measure one pass (review I10).** On the local env, with a fresh DB and run id, `pnpm matrix:l3 --set pr-sample --rows none --workers 4 --run-id w1d-t7-sample --report-dir "$TMPDIR/w1d-runs"; echo EXIT=$?`. Record the wall clock and the max per-case `durationMs` from its `results.json`. Those two numbers are what D13's owner-value line quotes in PR-A's body, and what `shards.json`'s L3 `pr-sample` budget is checked against in Task 8.

Commit `feat(matrix): pr-sample set and the R27 row declaration reader (W1d D13)`.

---

### Task 8: The CI helpers — shard matrix, summary, staleness (D1, D4, D20)

**Why:** The workflow must not carry logic it cannot test. Three things live in node scripts with unit tests:
- the job matrix and its derived timeouts;
- the run summary (histograms, harness verdict, timings, staleness, the weekly diff);
- the PR staleness annotation.

The YAML only calls them.

**Files:**
- Create:
  - `tools/matrix/ci/shards.json`;
  - `tools/matrix/ci/shard-matrix.ts`;
  - `tools/matrix/ci/summary.ts`;
  - `tools/matrix/ci/staleness.ts`;
  - `tools/matrix/ci/gh.ts` (a thin `gh api` wrapper with an injectable runner).
- Modify: `package.json`: `matrix:shards`, `matrix:summary` and `matrix:staleness`, each `node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/ci/<file>`, for `shard-matrix.ts`, `summary.ts` and `staleness.ts` respectively (review m9). The workflows call them through `pnpm --silent`, so pnpm's banner never reaches `$GITHUB_OUTPUT`.
- Test: `tools/matrix/__tests__/shard-matrix.test.ts`, `summary.test.ts`, `staleness.test.ts` (create).

**Interfaces:**
- `shards.json`:

```json
{
  "note": "W1d D4. Shard counts per layer per scope, and the committed runs each layer's per-case ceiling derives from. A ceiling is the max measured durationMs across the named runs, rounded up to 10 s, then ×1.5 for a CI runner. Budgets count DRIVEN cases per stripe (planned cases cost 0 s). Re-derive from PR-B's baseline (Task 21).",
  "setupMinutes": 18,
  "slackMinutes": 10,
  "maxTimeoutMinutes": 300,
  "layers": {
    "L1": { "full": { "args": "--driver browser --layer L1 --scope grid", "shards": 8, "workers": 1 }, "smoke": { "args": "--driver browser --layer L1 --scope slice", "shards": 2, "workers": 1 },
            "ceilingFrom": ["w1drv-l1/w1drv-l1-r1", "w1drv-l1/w1drv-l1-r2", "w1drv-l1/w1drv-l1-r3", "w1drv-l1/w1drv-l1-t15-r1", "w1drv-l1/w1drv-l1-t15-r2", "w1drv-l1/w1drv-l1-t15-r3"] },
    "L2": { "full": { "args": "--driver browser --layer L2 --scope grid", "shards": 2, "workers": 1 }, "smoke": { "args": "--driver browser --layer L2 --scope slice", "shards": 2, "workers": 1 }, "ceilingFrom": ["w1c-l2"] },
    "L3": { "full": { "args": "--set w1-driving", "shards": 2, "workers": 4 }, "smoke": { "args": "--set pr-sample --rows none", "shards": 2, "workers": 4 }, "ceilingFrom": ["w1drv-l3"] }
  },
  "prSample": { "args": "--set pr-sample", "workers": 4, "passes": 2 }
}
```

`ceilingFrom` is a LIST of committed run directories, each holding a `results.json`. `TR/w1drv-l1/` has no top-level `results.json`; its six runs are sub-directories (review I6). The CLI refuses (exit 2) a listed directory with no `results.json`, so a moved directory reds the plan step, never the shard. Measured at HEAD (2026-10-04), the maxima are:
- L1 132,684 ms (`w1drv-l1-r2`) → 140 s × 1.5 = **210 s**;
- L2 17,002 ms → **30 s**;
- L3 13,530 ms → **30 s**.

- `shardMatrix(cfg, scope: "full" | "smoke" | "pr-sample", plans: Partial<Record<Layer, readonly boolean[]>>, ceilingS: Record<Layer, number>, rows?: string): { include: { layer: Layer; id: string; k: number; of: number; args: string; timeout: number }[] }`.
  - `plans[layer][i]` is `true` when plan item `i` (in plan order, the order `stripe` partitions) is DRIVEN, and `false` when it is planned 🚫/░ (review C2).
  - Each job's timeout is `setupMinutes + ceil(drivenInStripe × ceilingS × passes / workers / 60) + slackMinutes`, where `drivenInStripe` counts the driven items `i` with `i mod of = k − 1`. The job holding the most driven items therefore gets the largest budget. `passes` is 1, except 2 for `pr-sample` (its single re-run, D13).
  - `id` is the job's lowercase run-id suffix: `<layer lowercased>-s<k>` (for example `l3-s1`), or `l3-sample` for `pr-sample`. The workflow builds `RUN_ID = ci-<run_id>-<attempt>-<id>` from it, and Task 9's test holds every id to `slugRunId(x) === x` (review C1).
  - `args` is the full run.ts argument string: the layer's `args`, then `--workers <w>` when w > 1, then `--shard <k>/<of>` when `of > 1`. The workflow passes it through an env var and adds only `--run-id` and `--report-dir`.
  - `k`/`of` name the artifact (`shard-<layer>-<k>`), since an artifact name cannot hold `/`.
  - `pr-sample` = L3 only, 1 job, no `--shard`, `cfg.prSample.args` + ` --rows <rows>`. `rows` comes from the caller, already validated by `pr-rows.ts`; `run.ts` validates it again through `parseRows`.
  - Refusals:
    - `ShardTimeoutTooLong` when a job's timeout exceeds `maxTimeoutMinutes`, which reds at plan time, never at minute 360;
    - a layer of the scope with zero planned items, or zero driven items in the whole layer (vacuous);
    - a stripe with zero ITEMS (it would be `ShardEmpty` at run time).

    A stripe with items but no driven case is allowed, because the smoke L2 slice drives 3 of 68. It costs its setup, and it still exercises the merge of planned cases.
- CLI `shard-matrix.ts --scope <s> [--rows <csv>]`:
  - plans each layer OFFLINE (`offlineBuilderDefault`, the same as the committed-plans judge), producing the driven flags in plan order;
  - reads the ceilings from `ceilingFrom`;
  - prints `matrix=<json>` for `$GITHUB_OUTPUT`;
  - exit 0, or 2 when refused.

  Package script: `"matrix:shards": "node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/ci/shard-matrix.ts"` (review m9), and the workflow calls `pnpm --silent matrix:shards`.
- `summary(merged: Record<Layer, RunResults | null>, judge: JudgeOut | null, previous: { runId: number; date: string; layers: Record<Layer, RunResults> } | null, now: Date): string` → `SUMMARY.md`.
- `staleness(runs: { conclusion: string; event: string; created_at: string }[], now: Date, maxDays: number): { stale: boolean; message: string; newest: string | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
const flags = (n: number, driven = n) => Array.from({ length: n }, (_, i) => i < driven);
describe("shardMatrix (D4; class 20 — derived budgets; review C2)", () => {
  const cfg = loadShardsConfig();
  const C = { L1: 210, L2: 30, L3: 30 };
  it("the full scope is 12 jobs (L1 8 + L2 2 + L3 2), each timed by the driven items of its own stripe", () => {
    const m = shardMatrix(cfg, "full", { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) }, C);
    expect(m.include).toHaveLength(12);
    expect(m.include.every((j) => j.timeout <= cfg.maxTimeoutMinutes && j.timeout < 360)).toBe(true);
  });
  it("the stripe with the most driven items sets the larger budget", () => {
    // items 0..5, driven at 0,2,4,5 → stripe 1 (0,2,4) drives 3, stripe 2 (1,3,5) drives 1
    const plan = [true, false, true, false, true, true];
    const m = shardMatrix({ ...cfg, layers: { ...cfg.layers, L2: { ...cfg.layers.L2, smoke: { ...cfg.layers.L2.smoke, shards: 2 } } } }, "smoke", { L1: flags(6), L2: plan, L3: flags(33) }, { L1: 210, L2: 600, L3: 30 });
    const [s1, s2] = m.include.filter((j) => j.layer === "L2");
    expect(s1.timeout).toBe(cfg.setupMinutes + Math.ceil((3 * 600) / 60) + cfg.slackMinutes);
    expect(s2.timeout).toBe(cfg.setupMinutes + Math.ceil((1 * 600) / 60) + cfg.slackMinutes);
  });
  it("planned cases cost nothing: L2's 1,731-item grid with 62 driven fits, where counting planned items would not", () => {
    const m = shardMatrix(cfg, "full", { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) }, C);
    for (const j of m.include.filter((x) => x.layer === "L2")) expect(j.timeout).toBeLessThan(60);
    expect(cfg.setupMinutes + Math.ceil((Math.ceil(1731 / 2) * 30) / 60) + cfg.slackMinutes).toBeGreaterThan(cfg.maxTimeoutMinutes);   // the wrong count would refuse
  });
  it("job ids are lowercase, unique, and already their own run-id slug (review C1)", () => {
    const m = shardMatrix(cfg, "full", { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) }, C);
    const ids = m.include.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(slugRunId(`ci-12345678901-2-${id}`)).toBe(`ci-12345678901-2-${id}`);
  });
  it("shard labels are k/N with every k once per layer, and args end with that shard", () => {
    const m = shardMatrix(cfg, "full", { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) }, C);
    const l1 = m.include.filter((j) => j.layer === "L1");
    expect(l1.map((j) => `${j.k}/${j.of}`)).toEqual(["1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8", "8/8"]);
    expect(l1.every((j) => j.args.endsWith(`--shard ${j.k}/8`))).toBe(true);
  });
  it("pr-sample is ONE L3 job with no --shard, budgeted for two passes, and its rows travel in args", () => {
    const m = shardMatrix(cfg, "pr-sample", { L3: flags(40) }, C, "league,swiss");
    expect(m.include).toEqual([expect.objectContaining({ layer: "L3", id: "l3-sample", k: 1, of: 1, args: "--set pr-sample --rows league,swiss --workers 4",
      timeout: cfg.setupMinutes + Math.ceil((40 * 30 * 2) / 4 / 60) + cfg.slackMinutes })]);
  });
  it("a timeout over the cap is refused at plan time (moving the ceiling moves the budget)", () => {
    expect(() => shardMatrix(cfg, "full", { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) }, { ...C, L1: 5000 })).toThrow(/ShardTimeoutTooLong|exceeds/);
  });
  it("the empty case: zero planned, or zero driven, in a layer is refused (vacuous)", () => {
    expect(() => shardMatrix(cfg, "full", { L1: [], L2: flags(1731, 62), L3: flags(937) }, C)).toThrow(/zero/);
    expect(() => shardMatrix(cfg, "full", { L1: flags(231, 0), L2: flags(1731, 62), L3: flags(937) }, C)).toThrow(/zero driven/);
  });
  it("a stripe with zero items is refused; a stripe with items but nothing driven is allowed", () => {
    expect(() => shardMatrix(cfg, "smoke", { L1: flags(1), L2: flags(68, 3), L3: flags(33) }, C)).toThrow(/fewer items than shards/);
    expect(() => shardMatrix(cfg, "smoke", { L1: flags(6), L2: [false, false, false, true], L3: flags(33) }, C)).not.toThrow();
  });
  it("the CLI reads the real committed ceilings and the real offline plans, and the full scope plans", () => {
    const out = runCli(["--scope", "full"]);
    expect(out.status).toBe(0);
    const m = JSON.parse(out.stdout.replace(/^matrix=/, ""));
    expect(m.include.map((j: { layer: string }) => j.layer).sort()).toEqual([...Array(8).fill("L1"), ...Array(2).fill("L2"), ...Array(2).fill("L3")].sort());
  });
  it("a ceilingFrom directory without results.json is refused by name (review I6)", () => {
    expect(runCli(["--scope", "full", "--shards-file", withCeiling("L1", ["w1drv-l1"])]).status).toBe(2);
  });
});
```

`runCli` spawns the real script, and `withCeiling` writes a temp copy of `shards.json` with one layer's `ceilingFrom` replaced. The CLI therefore takes an optional `--shards-file` (default `tools/matrix/ci/shards.json`), for tests only.

`summary.test.ts`:
- "harness verdict and per-layer histogram rows, with planned ░ counted per atom";
- "no previous run → 'Previous complete run: none yet' (the empty case)";
- "the weekly diff lists ✅→❌ and ❌→✅ moves, and says 'no state changed' when none did";
- "per-layer timings p50/p90/max computed from durationMs of driven cases only (planned cases have durationMs 0 and are excluded)";
- "a missing layer (merge refused) is a line saying so, never a silent omission";
- "the text passes findSecrets() with zero hits on a fixture containing a reason with an email" (redact applied).

`staleness.test.ts`:
- "no successful schedule/dispatch run ever → stale with 'never'";
- "the newest success 9 days ago → stale";
- "7 days → not stale";
- "a successful pull_request run does not count (smoke scope is not the weekly run)";
- "a failed run newer than the last success does not reset the clock".

- [ ] **Step 2: Run, see them fail. Step 3: Implement.**

Write each module to the interfaces above. `summary.ts` CLI: `summary.ts --merged <dir> [--judge <json>] [--previous-run auto|none] --out <file>`.
- `auto` calls `gh.ts` → once per event in `WEEKLY_EVENTS` (`schedule`, `workflow_dispatch`): `gh api repos/$GITHUB_REPOSITORY/actions/workflows/matrix-truth.yml/runs?event=<event>&status=success&per_page=10` (a server-side `event` filter, so a PR's own runs never crowd the page; projected small by `--jq`), merges the two lists newest first, drops this run (`id` = `GITHUB_RUN_ID`), and downloads the newest one's `merged` artifact via `gh run download <id> -n merged -D <tmp>`.
- Any `gh` failure becomes the line "previous run unavailable: <redacted reason>". It never fails the summary, since D20 is informational.

`staleness.ts` CLI: `staleness.ts --max-days 8`.
- It reads the runs list through `gh.ts` and prints `::warning title=Matrix truth run is stale::<message>` when stale, otherwise `matrix truth run: last success <date>`.
- **It always exits 0** (D1: non-blocking). An API failure prints `::warning::` naming it and exits 0.

`gh.ts`:

```ts
export type GhRunner = (args: readonly string[]) => { status: number; stdout: string; stderr: string };
export const realGh: GhRunner = (args) => { const r = spawnSync("gh", [...args], { encoding: "utf8" }); return { status: r.status ?? 1, stdout: r.stdout, stderr: redact(r.stderr) }; };
```

- [ ] **Step 4: Run, mutate, commit**

Run the vitest template on the three files. Mutate:

| Mutant | Killing test |
|---|---|
| The timeout formula without `setupMinutes` | "the stripe with the most driven items" |
| Count all planned items instead of driven ones | "planned cases cost nothing" (L2 refused) |
| `passes` ignored for pr-sample | "pr-sample is ONE L3 job … two passes" |
| `id` keeps the upper-case layer | "job ids are … already their own run-id slug" |
| `staleness` counting `pull_request` runs | its test |
| `summary` including planned cases in timings | its test |

Commit `feat(matrix): CI helpers — derived shard matrix, run summary, staleness signal (W1d D1, D4, D20)`.

---
### Task 9: `matrix-truth.yml`, its visibility guard, and the per-PR sample's wiring (rulings 60, 64; D1–D4, D12, D13; items 19, 27; Review Focus 2, 4, 5)

**Why:** This is the wave's deliverable. Every rule the earlier tasks built is used here.

The workflow is written failing-first against `ci-wiring.test.ts`'s deliberate change:
- the old "no workflow may run the matrix" test becomes "exactly `matrix-truth.yml` may, and `ci.yml` only by calling it";
- the new test is red before the file exists.

**Files:**
- Create:
  - `.github/workflows/matrix-truth.yml`;
  - `tools/matrix/ci/run-sample.ts` (the sample's run → judge → one re-run → judge, as a tested script rather than YAML logic);
  - `tools/matrix/__tests__/matrix-workflow.test.ts`;
  - `tools/matrix/__tests__/workflow-text.ts` (the text-parser helpers, review 7 m5);
  - `tools/matrix/__tests__/no-solver-route.test.ts` (ruling 66's premise as a guard);
  - `tools/matrix/__tests__/run-sample.test.ts`.
- Modify:
  - `.github/workflows/ci.yml`: the jobs `matrix-rows` and `matrix-sample`;
  - `tools/matrix/__tests__/ci-wiring.test.ts:244-252`: the deliberate change, and the MOVE of `indentOf`, `stepOf` and `jobBlock` out to `workflow-text.ts` (imported back);
  - `package.json`: `"matrix:sample": "node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/ci/run-sample.ts"`.

**Interfaces:**
- Consumes:
  - `shard-matrix.ts`, `summary.ts`, `staleness.ts` (Task 8);
  - `merge-shards.ts` (Task 4);
  - `judge.ts` `faults`/`regression` (Task 6);
  - `pr-rows.ts` and `--set pr-sample` (Task 7);
  - `--layer … --scope grid` (Task 3);
  - `--shard` (Task 4).
- Produces:
  - the workflow's dispatch inputs `scope: full|smoke` (default `full`) and `inject_visibility: none|private|internal` (default `none`);
  - `workflow_call` inputs `scope` (string, required) and `rows` (string, default `none`);
  - the artifacts `shard-<layer>-<k>` (per shard) and `merged` (`merged/<layer>/{results.json, MATRIX.md, faults.txt}`, `SUMMARY.md`);
  - `runSample(deps): Promise<number>`, with `deps = { run(args): Promise<number>; judge(args): number; now(): Date }`. It returns the judge's exit (0 / 1 / 2).

- [ ] **Step 0: Read the recipes this copies**

Read these, and copy literally where this task says "as e2e/bench":
- `e2e.yml:353-700`: env, checkout, pnpm, node, Flyway cache, db:apply, sync:sports, build, chromium, the server start. NOT the placement image or the placement container (`:670-690`): ruling 66, D23;
- `bench.yml:59-213`.

Check whether a reusable workflow may declare top-level `concurrency:`. Read GitHub's "Reusing workflows" limitations page via WebFetch, or the `docs.github.com` copy in `node_modules` if one exists. If it may not, move the `concurrency` block onto the `plan` job and record the change.

Confirm that `runner.environment` is a documented runner-context property (values `github-hosted` | `self-hosted`), and record the doc line in the task report. Ruling 68 (D24) rests on it: a `self-hosted` runner always passes, and a `github-hosted` one passes only while the repo is public.

Record ruling 66 and its evidence rather than a placement recipe. Re-run the solver-route read at HEAD and write the result in the task report:
- `rtk proxy grep -an "buildSchedule(" apps/web/src/server/usecases/*.ts` lists the call sites, all reached only from the `schedule/auto` and `ai-plan` routes;
- `rtk proxy grep -an "schedule/auto\|schedule/ai-\|ai-plan\|schedule-auto\|schedule-reflow\|schedule-polish\|board-ai-schedule" tools/matrix` returns nothing (re-pin the four testids against `schedule-board.tsx` first).

The workflow has no placement image, container or `PLACEMENT_*` env, and no greedy-fallback guard (D23). If a matrix path DOES reach the solver, STOP: that is a premise change for the owner, because the container would then be plumbing (ruling 66).

- [ ] **Step 1: Write the failing tests**

The deliberate change to `ci-wiring.test.ts:244-252`. It replaces the test "no scheduled matrix workflow exists in W1a" with:

```ts
it("the matrix runs only in matrix-truth.yml, and ci.yml reaches it only by calling that workflow (W1d; was W1a's 'no workflow')", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
  const runners = files.filter((f) => /matrix:l3|matrix:browser|tools\/matrix\/run\b/.test(readFileSync(join(WORKFLOWS, f), "utf8")));
  expect(runners).toEqual(["matrix-truth.yml"]);
  const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
  expect(ci).toMatch(/uses:\s*\.\/\.github\/workflows\/matrix-truth\.yml/);
  expect(files.length).toBeGreaterThan(5);   // anti-vacuity: the directory was read
});
```

`matrix-workflow.test.ts` stays a TEXT parser: there is no YAML dependency at HEAD, and none is added (review I8). The helpers live in a new `tools/matrix/__tests__/workflow-text.ts`.
- MOVE (do not copy) `indentOf`, `stepOf` and `jobBlock` from `ci-wiring.test.ts:~15-55`, and import them back there.
- `stepOf(text, name): { keys: string[]; body: string; script: string | null }` keeps its HEAD contract: it throws unless exactly ONE `      - name: <name>` line exists in `text`. Because every truth job has a guard step of the same name, it is always called on ONE job's text, never on the whole file.
- `jobsOf(text: string): Record<string, string>` is new. It takes the lines under `jobs:`, splits them at each `^  ([a-z][\w-]*):$` key, and maps each job name to its text (the key line through the line before the next job). It throws on zero jobs or a repeated name.
- `stepHeads(jobText: string): string[]` is new. It lists every `      - ` step line of the job, in order, named or not (`- uses: actions/checkout@v5` included), and throws on zero.
- Every step the tests read by name has a `name:` in the workflow, the upload steps included (`Upload shard results`, `Upload merged results`).

```ts
const WF = readFileSync(".github/workflows/matrix-truth.yml", "utf8");
const JOBS = jobsOf(WF);                               // job name → that job's text
const GUARD = "Visibility guard (design §6.4; R14a)";

describe("matrix-truth.yml — triggers and the disabled schedule (rulings 60, 62; D2, D3)", () => {
  it("schedule + workflow_dispatch + workflow_call + its own pull_request paths, and no push", () => {
    expect(WF).toMatch(/schedule:\s*\n\s*- cron: "17 2 \* \* 6"/);
    for (const t of ["workflow_dispatch:", "workflow_call:", "pull_request:"]) expect(WF).toContain(t);
    expect(WF).not.toMatch(/^\s{2}push:/m);
    expect(WF).toMatch(/paths:\s*\n\s*- "\.github\/workflows\/matrix-truth\.yml"\s*\n\s*- "tools\/matrix\/ci\/\*\*"/);
  });
  it("the plan job is skipped on a schedule unless vars.MATRIX_WEEKLY_ENABLED is 'true', and every other job needs it", () => {
    expect(Object.keys(JOBS)).toEqual(["plan", "build", "shard", "merge"]);
    expect(JOBS.plan).toContain("if: github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true'");
    for (const [name, text] of Object.entries(JOBS)) if (name !== "plan") expect(text).toMatch(/needs:\s*\[?[^\n]*\bplan\b/);
  });
});

describe("the visibility guard (Review Focus 2)", () => {
  it("is the first step of every job, with one identical script", () => {
    const scripts = Object.values(JOBS).map((t) => {
      expect(stepHeads(t)[0]).toBe(`      - name: ${GUARD}`);
      return stepOf(t, GUARD).script;
    });
    expect(scripts).toHaveLength(4);   // matrix-truth.yml's four jobs; Task 15 adds mutation.yml's, held equal to them
    expect(scripts.every((x) => x !== null)).toBe(true);
    expect(new Set(scripts).size).toBe(1);
  });
  const run = (env: Record<string, string>, gh: "public" | "private" | "fail") => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    writeFileSync(join(dir, "gh"), gh === "fail" ? "#!/bin/sh\necho 'HTTP 403' >&2\nexit 1\n" : `#!/bin/sh\necho ${gh}\n`, { mode: 0o755 });
    return spawnSync("bash", ["-c", stepOf(JOBS.plan, GUARD).script!], { env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "onryde/seazn.club", ...env }, encoding: "utf8" });
  };
  const cases: { name: string; env: Record<string, string>; gh: "public" | "private" | "fail"; want: number }[] = [
    { name: "public, hosted", env: { RUNNER_ENV: "github-hosted", INJECT: "none" }, gh: "public", want: 0 },
    { name: "public, self-hosted (ruling 68)", env: { RUNNER_ENV: "self-hosted", INJECT: "none" }, gh: "public", want: 0 },
    { name: "private, hosted", env: { RUNNER_ENV: "github-hosted", INJECT: "none" }, gh: "private", want: 1 },
    { name: "unreadable (403), hosted", env: { RUNNER_ENV: "github-hosted", INJECT: "none" }, gh: "fail", want: 1 },
    { name: "public but injected private (the live mutation)", env: { RUNNER_ENV: "github-hosted", INJECT: "private" }, gh: "public", want: 1 },
    { name: "public but injected internal", env: { RUNNER_ENV: "github-hosted", INJECT: "internal" }, gh: "public", want: 1 },
    { name: "private but injected public (cannot loosen)", env: { RUNNER_ENV: "github-hosted", INJECT: "public" }, gh: "private", want: 1 },
    { name: "runner.environment unset", env: { RUNNER_ENV: "", INJECT: "none" }, gh: "public", want: 1 },
    { name: "private, self-hosted (no hosted minutes; ruling 68)", env: { RUNNER_ENV: "self-hosted", INJECT: "none" }, gh: "private", want: 0 },
  ];
  // review m3: the title names the expected exit from the row itself ($want), never the row index.
  it.each(cases)("$name → exit $want", ({ env, gh, want }) => expect(run(env, gh).status).toBe(want));
  it("the four visibility × runner combinations of ruling 68 are all present and give the ruled exits", () => {
    const at = (r: string, g: string) => cases.find((c) => c.env.RUNNER_ENV === r && c.gh === g && c.env.INJECT === "none")!;
    expect([at("github-hosted", "public").want, at("self-hosted", "public").want, at("github-hosted", "private").want, at("self-hosted", "private").want]).toEqual([0, 0, 1, 0]);
  });
  it("every job of matrix-truth.yml runs on the switchable runner (ruling 68, D24), and has a timeout-minutes (mutation.yml's jobs join this check in Task 15)", () => {
    const jobs = Object.entries(JOBS);
    expect(jobs.length).toBeGreaterThan(1);   // anti-vacuity
    for (const [name, t] of jobs) {
      expect(t, `${name} runs-on`).toContain("runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}");
      expect(t, `${name} timeout-minutes`).toMatch(/timeout-minutes:/);
    }
  });
  it("the guard fails closed: unreadable, 403, private, internal, injected public, unset runner — counted", () => {
    expect(cases.filter((c) => c.want === 1)).toHaveLength(6);
  });
  it("never prints the token", () => {
    const r = run({ RUNNER_ENV: "github-hosted", INJECT: "none", GH_TOKEN: "ghs_SECRETSECRETSECRET" }, "private");
    expect(r.stdout + r.stderr).not.toContain("ghs_");
  });
});

describe("the build and shard jobs carry what bench.yml needed to build and serve (review I13)", () => {
  const bench = readFileSync(".github/workflows/bench.yml", "utf8");
  const envKeys = (block: string) => [...block.matchAll(/^ {6,10}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  const benchJob = Object.values(jobsOf(bench))[0];
  const benchJobEnv = envKeys(jobBlock(benchJob.split("\n"), "env"));
  const benchServerEnv = envKeys(stepOf(benchJob, "Start server").body);
  it("every env key bench.yml sets at job level is set on the shard job AND the build job (NEXT_PUBLIC_* is baked at build)", () => {
    expect(benchJobEnv.length).toBeGreaterThan(8);
    expect(benchJobEnv).toEqual(expect.arrayContaining(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_SSL"]));
    const shardEnv = envKeys(jobBlock(JOBS.shard.split("\n"), "env"));
    const buildEnv = envKeys(jobBlock(JOBS.build.split("\n"), "env"));
    for (const k of benchJobEnv) expect(shardEnv, k).toContain(k);
    for (const k of benchJobEnv) expect(buildEnv, k).toContain(k);
  });
  // Ruling 66: the matrix drives no solver route, so the server step omits these two keys, by name.
  const OMITTED_BY_RULING_66 = ["PLACEMENT_SERVICE_HOST", "PLACEMENT_SERVICE_SECRET"];
  it("every env key bench.yml's server step sets is set on the shard job's server step, except the two ruling-66 omissions, and none twice (review m11)", () => {
    expect(benchServerEnv.length).toBeGreaterThan(3);
    expect(benchServerEnv).toEqual(expect.arrayContaining(OMITTED_BY_RULING_66));   // the exclusion names keys bench really sets; a rename reds here
    const server = envKeys(stepOf(JOBS.shard, "Start the server").body);
    const shardEnv = envKeys(jobBlock(JOBS.shard.split("\n"), "env"));
    for (const k of benchServerEnv.filter((x) => !OMITTED_BY_RULING_66.includes(x))) expect(server, k).toContain(k);
    for (const k of server) expect(shardEnv, `${k} set at job AND step level`).not.toContain(k);
  });
  it("the shard and build jobs carry no placement service at all: the keys are ABSENT, so putting one back is a deliberate act (ruling 66)", () => {
    for (const k of OMITTED_BY_RULING_66) expect(WF, k).not.toContain(k);
    expect(WF).not.toMatch(/placement|buildx|docker (load|run|save)|build-push-action|greedy/i);
  });
});

describe("the shard job (ruling 64; D4, D12; item 19, 27)", () => {
  const shard = JOBS.shard;
  it("runs the derived matrix, fail-fast off, with the derived timeout", () => {
    expect(shard).toContain("matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(shard).toContain("fail-fast: false");
    expect(shard).toContain("timeout-minutes: ${{ matrix.timeout }}");
  });
  it("a fresh Postgres per job, db:apply then sync:sports before the run, its own data dir proven", () => {
    expect(shard).toMatch(/services:\s*\n\s*postgres:\s*\n\s*image: postgres:16/);
    const heads = stepHeads(shard);
    const at = (n: string) => heads.indexOf(`      - name: ${n}`);
    expect(at("Apply migrations")).toBeGreaterThan(0);
    expect(at("Apply migrations")).toBeLessThan(at("Sync sports (sync:sports)"));
    expect(at("Sync sports (sync:sports)")).toBeLessThan(at("Run the shard"));
    expect(shard).toContain("BENCH_EXPECTED_DATA_DIR");
  });
  it("the run id is built from the matrix's lowercase id, and is already its own slug (review C1)", () => {
    const tpl = /RUN_ID: (ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.id \}\})/.exec(stepOf(shard, "Run the shard").body)?.[1];
    expect(tpl).toBeDefined();
    const m = JSON.parse(spawnSync(process.execPath, ["--experimental-strip-types", "tools/matrix/ci/shard-matrix.ts", "--scope", "full"], { encoding: "utf8" }).stdout.replace(/^matrix=/, ""));
    for (const j of [...m.include]) {
      const id = tpl!.replace("${{ github.run_id }}", "12345678901").replace("${{ github.run_attempt }}", "2").replace("${{ matrix.id }}", j.id);
      expect(slugRunId(id)).toBe(id);
    }
    expect(m.include.length).toBe(12);
  });
  it("no Redis anywhere (D12, item 19)", () => {
    expect(WF).not.toMatch(/redis/i);
  });
  it("the run writes EXIT=$? itself, and a killed step cannot read as 0", () => {
    expect(stepOf(shard, "Run the shard").script).toMatch(/set \+e[\s\S]*pnpm matrix:l3 \$MATRIX_ARGS[\s\S]*echo "\$code" > "\$dir\/exit\.txt"/);
  });
  it("upload paths are an allow-list; no trace; no step echoes a DB URL or token (Review Focus 5)", () => {
    const up = stepOf(shard, "Upload shard results").body;
    const paths = /path: \|\n((?: {12}.+\n)+)/.exec(up + "\n")![1].split("\n").map((l) => l.trim()).filter(Boolean);
    expect(paths).toEqual(["out/*/results.json", "out/*/MATRIX.md", "out/*/exit.txt", "out/*/**/*.png"]);
    expect(WF).not.toMatch(/trace\.zip|MATRIX_TRACE_ON_TIMEOUT/);
    expect(WF).not.toMatch(/echo[^\n]*\$\{?(DATABASE_URL|AUTH_SECRET|GH_TOKEN|SUPABASE_JWT)/);
  });
  it("rows from a PR body never reach a run: line as an expression (script injection)", () => {
    expect(WF).not.toMatch(/run:[^\n]*\$\{\{\s*inputs\.rows/);
    expect(WF).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.body/);
  });
});

describe("the merge job", () => {
  it("runs even when a shard failed, refuses on any short shard, and judges faults per layer under ruling 65", () => {
    expect(JOBS.merge).toContain("if: ${{ always() && needs.plan.result == 'success' && inputs.scope != 'pr-sample' }}");
    const script = stepOf(JOBS.merge, "Merge each layer and judge its faults").script!;
    expect(script).toMatch(/pnpm matrix:merge --run-id "ci-[^"]*\$\{layer,,\}"[\s\S]*pnpm matrix:judge faults [^\n]*--planned-not-run allow/);
    expect(stepOf(JOBS.merge, "Merge each layer and judge its faults").body).toMatch(/# ruling 65/);
    expect(script).toContain("$GITHUB_STEP_SUMMARY");
  });
});

describe("ci.yml's per-PR sample (R27, D13)", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const ciJobs = jobsOf(ci);
  it("matrix-rows declares the rows, matrix-sample calls the truth workflow with scope pr-sample when the filter matches", () => {
    expect(ciJobs["matrix-sample"]).toMatch(/needs: matrix-rows[\s\S]*if: needs\.matrix-rows\.outputs\.run == 'true'[\s\S]*uses: \.\/\.github\/workflows\/matrix-truth\.yml[\s\S]*scope: pr-sample/);
  });
  it("the PR body is read live through gh api (so a re-run after a body edit sees the edit), never from the event payload, never inline (review 3, R3-m1)", () => {
    const step = stepOf(ciJobs["matrix-rows"], "Rows the PR declares (R27)");
    expect(step.script).toMatch(/gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER" --jq '\.body \/\/ ""'/);
    expect(step.body).toMatch(/REPO: \$\{\{ github\.repository \}\}/);
    expect(ciJobs["matrix-rows"]).toMatch(/pull-requests: read/);
    expect(ci).not.toMatch(/github\.event\.pull_request\.body/);   // neither in a run: line nor in env
  });
  it("the staleness step never fails a PR, and runs even when the rows step failed (D1b; review m6)", () => {
    const s = stepOf(ciJobs["matrix-rows"], "Truth-run staleness (D1b, non-blocking)");
    expect(s.keys).toContain("continue-on-error");
    expect(s.body).toContain("continue-on-error: true");
    expect(s.body).toContain("if: ${{ always() && vars.MATRIX_WEEKLY_ENABLED == 'true' }}");
  });
});
```

`slugRunId` is imported from `../lib/run-id.ts` (Task 4).

`run-sample.test.ts`. The sample re-runs a regressed case once before failing:

```ts
it("no regression: one run, judge 0, no re-run", async () => {
  const deps = fakeSampleDeps({ judgeExits: [0] });
  expect(await runSample(deps)).toBe(0);
  expect(deps.runs).toBe(1);
});
it("a regression that does not reproduce: two runs, the second judged with --rerun, exit 0", async () => {
  const deps = fakeSampleDeps({ judgeExits: [1, 0] });
  expect(await runSample(deps)).toBe(0);
  expect(deps.runs).toBe(2);
  expect(deps.judgeArgs[1]).toContain("--rerun");
  // the re-run id itself is pinned by the real-CLI tests below, against the workflow's template (review I9)
});
it("a reproduced regression is exit 1; the sample never re-runs twice", async () => {
  const deps = fakeSampleDeps({ judgeExits: [1, 1] });
  expect(await runSample(deps)).toBe(1);
  expect(deps.runs).toBe(2);
});
it("a run that exits non-zero (refused/aborted) is exit 2 with no judge call — a broken sample is not a pass", async () => {
  const deps = fakeSampleDeps({ runExits: [3], judgeExits: [] });
  expect(await runSample(deps)).toBe(2);
});
```

`no-solver-route.test.ts` pins ruling 66's premise (D23). It is a pure scan, with no network and no DB:

```ts
const HM = "tools/matrix";
const SOLVER_ROUTE = /schedule\/auto|schedule\/ai-|ai-plan/;
// The board's real solver controls, from apps/web/src/components/v2/schedule-board.tsx (:1416, :1433, :1456, :1485). The words
// run schedule-auto, not auto-schedule (review 4, R4-I3), so the pattern is built from the testids themselves.
const BOARD_SOLVER_CONTROLS = ["schedule-auto", "schedule-reflow", "schedule-polish", "board-ai-schedule"];
const BOARD_SOLVER_CONTROL = /schedule-(auto|reflow|polish)|board-ai-schedule|autoRun/;
it("the route pattern matches the real solver routes and not the matrix's own (a positive pair)", () => {
  for (const p of ["/api/v1/stages/x/schedule/auto", "/api/v1/stages/x/schedule/ai-plan", "/schedule/ai-plan/apply"]) expect(SOLVER_ROUTE.test(p), p).toBe(true);
  for (const p of ["/api/v1/stages/x/generate", "/api/v1/divisions/x/start", "/api/v1/stages/x/rebuild"]) expect(SOLVER_ROUTE.test(p), p).toBe(false);
});
it("the control pattern matches the board's four REAL solver testids, read from the product source (a positive pair)", () => {
  const board = readFileSync("apps/web/src/components/v2/schedule-board.tsx", "utf8");
  for (const id of BOARD_SOLVER_CONTROLS) {
    expect(board, `${id} is no longer in the board: re-read the controls`).toContain(`data-testid="${id}"`);
    expect(BOARD_SOLVER_CONTROL.test(`[data-testid="${id}"]`), id).toBe(true);
  }
  expect(BOARD_SOLVER_CONTROL.test('[data-testid="stage-generate"]')).toBe(false);
});
it("no non-test file under tools/matrix names a solver route, and none under lib/browser names a board solver control (ruling 66)", () => {
  const files = globSync("**/*.ts", { cwd: HM }).filter((f) => !/__tests__|\.test\.ts$|^catalogue\//.test(f));
  // anti-vacuity: the scan must have read files, and the ones that matter must be among them
  expect(files.length, "zero files scanned is a failure").toBeGreaterThan(0);
  expect(files).toEqual(expect.arrayContaining(["lib/driver/http-driver.ts", "lib/browser/selectors.ts", "lib/browser/pages/stage-rail.ts", "run.ts"]));
  const browser = files.filter((f) => f.startsWith("lib/browser/"));
  expect(browser.length, "zero browser files scanned").toBeGreaterThan(1);
  const text = (f: string) => readFileSync(join(HM, f), "utf8");
  const hits = [...files.filter((f) => SOLVER_ROUTE.test(text(f))), ...browser.filter((f) => BOARD_SOLVER_CONTROL.test(text(f)))];
  expect(hits, `scanned ${files.length} file(s), ${browser.length} of them browser. A matrix path now reaches the solver: re-decide the placement container as plumbing, and no check may claim to prove scheduling (owner ruling 66)`).toEqual([]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run the vitest template on `ci-wiring.test.ts matrix-workflow.test.ts run-sample.test.ts`. Expected:
- `ci-wiring`'s new test fails (`runners` is `[]`);
- `matrix-workflow.test.ts` fails on ENOENT for the workflow file;
- `run-sample` fails to collect.

- [ ] **Step 3: Write `matrix-truth.yml`**

```yaml
name: Matrix truth run

# W1d (owner rulings 60–68, 2026-10-04). The format × sport matrix, sharded:
# L1 (231 cells @1280), L2 (1,731 pair-runs), L3 (937 cases), each shard on its
# own fresh Postgres with sync:sports. Triggers:
#  - schedule: weekly, Sat 02:17 UTC — GATED by vars.MATRIX_WEEKLY_ENABLED (D2):
#    while the variable is not 'true' a firing is a visible run of skipped jobs.
#  - workflow_dispatch: scope full|smoke; inject_visibility proves the guard live.
#  - workflow_call: ci.yml's per-PR sample (R27, D13), scope pr-sample.
#  - pull_request on this file and tools/matrix/ci/**: the smoke scope proves
#    the workflow on its own PR (D3) — dispatch only fires main's copy.
# PUBLIC REPO (R14a): synthetic orgs only; nothing here echoes a secret; no
# Playwright trace is ever uploaded (D16).
on:
  schedule:
    - cron: "17 2 * * 6"
  workflow_dispatch:
    inputs:
      scope:
        description: "full (ruling 64) or smoke (slice, 2 shards per layer)"
        type: choice
        options: [full, smoke]
        default: full
      inject_visibility:
        description: "mutation proof of the visibility guard: none, or a visibility to pretend (the run must then fail)"
        type: choice
        options: [none, private, internal]
        default: none
  workflow_call:
    inputs:
      scope:
        type: string
        required: true
      rows:
        type: string
        default: none
  pull_request:
    paths:
      - ".github/workflows/matrix-truth.yml"
      - "tools/matrix/ci/**"

permissions:
  contents: read
  actions: read

concurrency:
  group: matrix-truth-${{ github.event_name }}-${{ inputs.scope || 'self' }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  SCOPE: ${{ inputs.scope || (github.event_name == 'pull_request' && 'smoke') || 'full' }}

jobs:
  plan:
    name: Plan the shards
    if: github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true'
    runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}   # ruling 68, D24
    timeout-minutes: 15
    outputs:
      matrix: ${{ steps.matrix.outputs.matrix }}
    steps:
      - name: Visibility guard (design §6.4; R14a)
        env:
          GH_TOKEN: ${{ github.token }}
          INJECT: ${{ inputs.inject_visibility || 'none' }}
          RUNNER_ENV: ${{ runner.environment }}
        run: |
          set -euo pipefail
          if [ "$RUNNER_ENV" = "self-hosted" ]; then echo "self-hosted runner: no hosted minutes billed; guard passes"; exit 0; fi
          if [ "$RUNNER_ENV" != "github-hosted" ]; then echo "::error::runner.environment is '${RUNNER_ENV:-unset}', neither github-hosted nor self-hosted; refusing"; exit 1; fi
          vis="$(gh api "repos/$GITHUB_REPOSITORY" --jq .visibility 2>/dev/null || true)"
          case "$INJECT" in
            none) ;;
            private|internal) echo "inject_visibility=$INJECT: pretending the repository is $INJECT (mutation proof; this run must fail here)"; vis="$INJECT" ;;
            *) echo "::error::inject_visibility '$INJECT' is not none|private|internal"; exit 1 ;;
          esac
          if [ "$vis" != "public" ]; then
            echo "::error title=Matrix truth run refused::repository visibility is '${vis:-unreadable}'. Sharded matrix runs are free only while the repo is public (design §6.4); refusing before any minute is spent. Set vars.MATRIX_RUNNER to a self-hosted runner label to run them privately (ruling 68)."
            exit 1
          fi
          echo "repository is public; guard passes"
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
        with:
          version: 10.34.5
      - uses: actions/setup-node@v5
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Derive the shard matrix (D4)
        id: matrix
        env:
          ROWS: ${{ inputs.rows || 'none' }}
        run: |
          set -euo pipefail
          pnpm --silent matrix:shards --scope "$SCOPE" --rows "$ROWS" >> "$GITHUB_OUTPUT"

  build:
    name: Build once
    needs: [plan]
    runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}   # ruling 68, D24
    timeout-minutes: 30
    env:
      # bench.yml's job-level env (bench.yml:80-106), every key, copied with its
      # comments. CI-only dummies, never real secrets. NEXT_PUBLIC_* is baked into
      # the client bundle HERE, so the stubs must be present at build (review I13).
      # … DATABASE_URL, DATABASE_SSL, AUTH_SECRET, DEVICE_LINK_KEK, SUPABASE_JWT_SIGNING_KEY_B64,
      #   SUPABASE_JWT_SECRET, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
      #   NEXT_TELEMETRY_DISABLED, STRIPE_SECRET_KEY, NEXT_PUBLIC_SCOREPAD_HOLD_MS …
      SKIP_TYPECHECK: "1"
    steps:
      - name: Visibility guard (design §6.4; R14a)
        # (identical script — matrix-workflow.test.ts holds every job's copy equal)
      - uses: actions/checkout@v5
      # … pnpm/action-setup, setup-node 26, pnpm install --frozen-lockfile, as in plan …
      - name: Build the web app (standalone)
        run: npm run build --workspace apps/web
      - name: Pack the build
        run: |
          set -euo pipefail
          cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
          cp -r apps/web/public apps/web/.next/standalone/apps/web/public
          tar -czf web.tgz -C apps/web/.next standalone
      - uses: actions/upload-artifact@v4
        with:
          name: build
          path: web.tgz
          retention-days: 1

  shard:
    name: ${{ matrix.layer }} shard ${{ matrix.k }}/${{ matrix.of }}
    needs: [plan, build]
    runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}   # ruling 68, D24
    timeout-minutes: ${{ matrix.timeout }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      # bench.yml's job-level env (bench.yml:80-106), every key once, at JOB level only.
      # DATABASE_URL points at this job's service DB; the server step below does NOT
      # repeat it (review m11: one level per key, so there is no precedence to reason about).
      DATABASE_URL: postgresql://postgres:postgres@localhost:5433/postgres
      DATABASE_SSL: disable
      # … AUTH_SECRET … NEXT_PUBLIC_SCOREPAD_HOLD_MS, copied verbatim with their comments …
      SMOKE_BASE: http://localhost:3200
    steps:
      - name: Visibility guard (design §6.4; R14a)
        # (identical script)
      - uses: actions/checkout@v5
      # … pnpm/action-setup, setup-node 26, pnpm install --frozen-lockfile …
      - uses: actions/download-artifact@v4
        with:
          name: build
      - name: Apply migrations
        run: npm run db:apply
      - name: Sync sports (sync:sports)
        run: npm run sync:sports
      - name: Prove the DB is this job's own (BENCH_EXPECTED_DATA_DIR)
        run: |
          set -euo pipefail
          dir="$(psql "$DATABASE_URL" -tAc 'show data_directory')"
          test -n "$dir"
          echo "BENCH_EXPECTED_DATA_DIR=$dir" >> "$GITHUB_ENV"
      - name: Install chromium
        if: matrix.layer != 'L3'
        working-directory: apps/web
        run: npx playwright install --with-deps chromium
      - name: Start the server
        env:
          # bench.yml's "Start server" env (bench.yml:176-195), every key but the two the solver reads
          # (omitted by name, ruling 66 and D23), and no job-level key repeated.
          PORT: "3200"
          AUTH_DEV_LINKS: "1"
          LOG_LEVEL: warn
        run: |
          set -euo pipefail
          tar -xzf web.tgz
          # … bench.yml's health loop on :3200 — reading from ./standalone/apps/web/server.js,
          #   with its output to "$RUNNER_TEMP/server.log" (kept for diagnosis; never uploaded, Review Focus 5) …
      - name: Run the shard
        env:
          MATRIX_ARGS: ${{ matrix.args }}
          # matrix.id is lowercase (shard-matrix.ts); run.ts slugs --run-id, so the
          # id must already be its own slug or "out/$RUN_ID" below names nothing (review C1).
          RUN_ID: ci-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.id }}
        run: |
          set +e
          mkdir -p out
          if [ "$SCOPE" = "pr-sample" ]; then
            # run-sample reads MATRIX_ARGS from the env: a dash-leading --args value is
            # refused by util.parseArgs (review C3a).
            pnpm matrix:sample --run-id "$RUN_ID" --report-dir out
          else
            pnpm matrix:l3 $MATRIX_ARGS --run-id "$RUN_ID" --report-dir out
          fi
          code=$?
          dir="out/$RUN_ID"; mkdir -p "$dir"
          echo "$code" > "$dir/exit.txt"
          echo "EXIT=$code"
          exit "$code"
      - name: Upload shard results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: shard-${{ matrix.layer }}-${{ matrix.k }}
          path: |
            out/*/results.json
            out/*/MATRIX.md
            out/*/exit.txt
            out/*/**/*.png
          retention-days: 90
          if-no-files-found: warn

  merge:
    name: Merge, judge, summarise
    needs: [plan, shard]
    if: ${{ always() && needs.plan.result == 'success' && inputs.scope != 'pr-sample' }}
    runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}   # ruling 68, D24
    timeout-minutes: 20
    steps:
      - name: Visibility guard (design §6.4; R14a)
        # (identical script)
      - uses: actions/checkout@v5
      # … pnpm/action-setup, setup-node 26, pnpm install --frozen-lockfile …
      - uses: actions/download-artifact@v4
        with:
          pattern: shard-*
          path: shards
      - name: Merge each layer and judge its faults
        env:
          GH_TOKEN: ${{ github.token }}
        # ruling 65 (2026-10-04): "no ░" applies to driven cases only. A planned ░
        # (L2's 1,505 unscripted pair-runs) is not a fault, so `allow` is the ruled
        # behaviour; a ░ on a DRIVEN case is still a fault under it (judge.test.ts).
        run: |
          set +e
          status=0
          for layer in L1 L2 L3; do
            dirs=$(ls -d shards/shard-$layer-*/* 2>/dev/null)
            [ -z "$dirs" ] && { echo "$layer: no shards ran (scope $SCOPE)" | tee -a merged-notes.txt; continue; }
            pnpm matrix:merge --run-id "ci-${{ github.run_id }}-${{ github.run_attempt }}-${layer,,}" --out "merged/$layer" $dirs
            code=$?; echo "$layer merge EXIT=$code"; [ "$code" -ne 0 ] && status=1 && continue
            pnpm matrix:judge faults "merged/$layer/results.json" --planned-not-run allow > "merged/$layer/faults.txt"
            code=$?; echo "$layer faults EXIT=$code"; [ "$code" -ne 0 ] && status=1
          done
          pnpm matrix:summary --merged merged --previous-run auto --out merged/SUMMARY.md
          cat merged/SUMMARY.md >> "$GITHUB_STEP_SUMMARY"
          exit "$status"
      - name: Upload merged results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: merged
          path: merged/
          retention-days: 90
```

In the committed file, the `# … as in plan …` / `# (identical script)` / `# … copied verbatim …` lines are REPLACED by the literal steps and keys. The test above holds them identical. They are elided here only to keep the plan readable; the guard's text is given once in full in the `plan` job.

`merge-shards.ts` reads each shard dir's `<run-id>/` subdirectory: the artifact holds `out/<run-id>/…`. The `ls -d shards/shard-$layer-*/*` glob gives the per-run-id dirs.

- [ ] **Step 4: Write `run-sample.ts`**

The CLI is `run-sample.ts --run-id <id> --report-dir <dir>`, and it reads the run.ts arguments from the `MATRIX_ARGS` env var, split on whitespace (review C3a: `util.parseArgs` refuses a separate value that starts with `--`, such as `--args "--set pr-sample …"`). It refuses (exit 2):
- an empty or missing `MATRIX_ARGS`;
- a `--run-id` that is not its own slug (`slugRunId(id) !== id`, Task 4);
- a `-r` re-run id that would exceed `RUN_ID_MAX`.

Its exit header (D8): 0 no reproduced regression; 1 a reproduced regression; 2 the sample run itself refused or aborted, the baseline is unreadable, or a refusal above.

Before the run it writes `<report-dir>/<run-id>.expect.json`: the exact case ids `planPrSample(rows, offlineBuilderDefault)` plans, with `rows` read from `MATRIX_ARGS`'s `--rows`. The judge restricts the baseline to those ids (Task 6, review C3c).

```ts
export async function runSample(d: SampleDeps): Promise<number> {
  const first = await d.run([...d.args, "--run-id", d.runId, "--report-dir", d.reportDir]);
  if (first !== 0) { d.say(`sample run exited ${first} — a broken sample is not a pass`); return 2; }
  const nowFile = join(d.reportDir, d.runId, "results.json");
  const j1 = d.judge(["regression", "--baseline", d.baseline, "--now", nowFile, "--expect", d.expectFile]);
  if (j1 !== 1) return j1;
  // D13: the WHOLE sample runs once more (shards.json prSample.passes = 2 budgets it); only cases red in both count.
  const rerunId = `${d.runId}-r`;
  const second = await d.run([...d.args, "--run-id", rerunId, "--report-dir", d.reportDir]);
  if (second !== 0) { d.say(`re-run exited ${second}`); return 2; }
  return d.judge(["regression", "--baseline", d.baseline, "--now", nowFile, "--expect", d.expectFile, "--rerun", join(d.reportDir, rerunId, "results.json")]);
}
```

`d.baseline` is `baselineL3Path()` (Task 7). The real `run`/`judge` deps spawn `node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/run.ts …` and `tools/matrix/judge.ts …` (the crash-exit preload on each, as their package scripts spell it), the way `ci-wiring.test.ts` spawns its stand-ins.

Add these CLI tests to `run-sample.test.ts`. They spawn the REAL `run-sample.ts` with the real deps replaced only at the process boundary: `MATRIX_RUN_BIN` / `MATRIX_JUDGE_BIN` point at stand-in scripts that record their argv to a file. That replaces the fake-deps test whose `--run-id` lookup compared a value with itself (review I9).
- "a dash-leading MATRIX_ARGS reaches run.ts intact": `MATRIX_ARGS="--set pr-sample --rows none --workers 4"`. The recorded run argv starts with exactly those five tokens.
- "the run id the workflow builds is the id run.ts is given and the dir the judge reads". Take the YAML's `RUN_ID` template (read from `matrix-truth.yml` as in Task 9's C1 test), with `matrix.id = l3-sample` substituted. The recorded run argv's `--run-id` equals it, and the recorded judge argv's `--now` equals `<report-dir>/<it>/results.json`. Both expected values come from the workflow text, never from `run-sample.ts`.
- "the re-run id is the first id plus `-r`, it is its own slug, and it fits RUN_ID_MAX".
- "an upper-case --run-id is refused with exit 2 before anything runs".
- "the expect file holds planPrSample's ids for the rows in MATRIX_ARGS".

- [ ] **Step 5: Write `ci.yml`'s two jobs**

```yaml
  # -------------------------------------------------------------------------
  # R27 (W1d D13): a PR touching the engine or stages.ts declares its matrix
  # rows; the sample runs them + a fixed 33 against the committed baseline.
  # -------------------------------------------------------------------------
  matrix-rows:
    name: Matrix rows (R27) + truth-run staleness
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    permissions:
      contents: read
      pull-requests: read
      actions: read
    outputs:
      run: ${{ steps.filter.outputs.matrix }}
      rows: ${{ steps.rows.outputs.rows }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            matrix:
              - 'packages/engine/**'
              - 'apps/web/src/server/**'
              - 'apps/web/src/lib/format-templates.ts'
              - 'tools/matrix/**'
              - 'pnpm-lock.yaml'
      - uses: pnpm/action-setup@v4
        with:
          version: 10.34.5
      - uses: actions/setup-node@v5
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Rows the PR declares (R27)
        id: rows
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          # LIVE read (review 3, R3-m1): editing the body fires no run, and a re-run replays the original event
          # payload. `// ""` turns a null body into an empty string, which pr-rows refuses as undeclared.
          gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.body // ""' > "$RUNNER_TEMP/body.txt"
          git diff --name-only "$BASE_SHA" "$HEAD_SHA" > "$RUNNER_TEMP/changed.txt"
          node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/ci/pr-rows.ts --body-file "$RUNNER_TEMP/body.txt" --changed-file "$RUNNER_TEMP/changed.txt" >> "$GITHUB_OUTPUT"
      - name: Truth-run staleness (D1b, non-blocking)
        # always(): a failed rows step (R27 undeclared) must not hide the staleness signal (review m6).
        if: ${{ always() && vars.MATRIX_WEEKLY_ENABLED == 'true' }}
        continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
        run: pnpm --silent matrix:staleness --max-days 8

  matrix-sample:
    name: Matrix per-PR sample (R27)
    needs: matrix-rows
    if: needs.matrix-rows.outputs.run == 'true'
    permissions:
      contents: read
      actions: read
    uses: ./.github/workflows/matrix-truth.yml
    with:
      scope: pr-sample
      rows: ${{ needs.matrix-rows.outputs.rows }}
```

`rows` passes as a `with:` input (data), and the truth workflow reads it only through `env: ROWS`. Its values are validated twice: `pr-rows.ts` emits only catalogue row keys, `all` or `none`, and `run.ts` `parseRows` refuses anything else.

- [ ] **Step 6: Run and see them pass**

Run the vitest template on:

```
ci-wiring.test.ts matrix-workflow.test.ts no-solver-route.test.ts run-sample.test.ts shard-matrix.test.ts strip-types-loadable.test.ts
```

All green, with `.testResults[].name` listing exactly these 6 files (review I15: a misspelt positional is silently dropped). The guard's `it.each` must report 9 cases.

- [ ] **Step 7: Mutate**

| Mutant | Killing test |
|---|---|
| In the guard, `[ "$vis" != "public" ]` → `[ "$vis" = "private" ]` | "unreadable (403)" (and "internal") |
| Make the guard fail on a `self-hosted` runner (delete the early `exit 0`) | "public, self-hosted" and "private, self-hosted" (ruling 68) |
| Make the guard pass on a `github-hosted` private repo (accept hosted like self-hosted) | "private, hosted" and the four-combination test |
| One matrix-truth job back to `runs-on: ubuntu-latest` | "every job of matrix-truth.yml runs on the switchable runner" |
| Delete the `case "$INJECT"` block | "public but injected private" |
| Change `private\|internal)` to accept `public` | "private but injected public" |
| Remove `if:` from `plan` | the D2 test |
| Add `out/*/trace.zip` to the upload | Review Focus 5 test |
| In `runSample`, `if (j1 !== 1) return j1` → `return j1` | "a regression that does not reproduce" |
| `RUN_ID` template back to `${{ matrix.layer }}-s${{ matrix.k }}` | "the run id is built from the matrix's lowercase id" (C1) |
| `run-sample.ts` reads `--args` again instead of `MATRIX_ARGS` | "a dash-leading MATRIX_ARGS reaches run.ts intact" (C3a) |
| Drop `--expect` from the judge call | "the run id the workflow builds…" (judge argv) and Task 6's expect refusal |
| Put `PLACEMENT_SERVICE_HOST` back on the server step | "the shard and build jobs carry no placement service at all" |
| Drop `PLACEMENT_SERVICE_SECRET` from `OMITTED_BY_RULING_66` | "every env key bench.yml's server step sets…" (the shard lacks a key the test now demands) |
| Rename a key in `OMITTED_BY_RULING_66` | the same test's `arrayContaining` |
| Add `/schedule/auto` to a string in `tools/matrix/lib/driver/http-driver.ts` | `no-solver-route.test.ts`, naming the file and ruling 66 |
| Narrow the scan's glob to a directory with no files | `no-solver-route.test.ts`'s zero-files-scanned failure |
| Add `scheduleAuto: '[data-testid="schedule-auto"]'` to `lib/browser/selectors.ts` | `no-solver-route.test.ts`, naming the file |
| Add `getByTestId("schedule-auto")` to `lib/browser/pages/stage-rail.ts` | the same test (the scan covers every browser file, not just selectors) |
| Remove `NEXT_PUBLIC_SUPABASE_URL` from the build job | "every env key bench.yml sets at job level…" (I13) |

Mutate the guard's three branches one at a time; they partly cover for each other. Each mutant is applied to EVERY job's copy, or the identity test reds first and proves nothing about the guard.

- [ ] **Step 8: Prove it on the PR (E2E, D3)**

This happens at PR-A's opening, in Task 16. Pushing the branch fires the workflow's own `pull_request` trigger in smoke scope. Nothing is dispatched from a feature branch.

- [ ] **Step 9: Commit**

Commit `feat(ci): matrix-truth.yml — sharded weekly/dispatch truth run with visibility guard; ci.yml per-PR sample (W1d rulings 60, 64; D1–D4, D12, D13)`.

---

### Task 10: Type-check the matrix's tests in CI (item 7, D9)

**Why:** `tsconfig.scripts.json` excludes every `*.test.ts`, so type errors in test code reach `main` (five already have). `vitest` is not resolvable from the repo root in a fresh clone.

**Files:**
- Create: `tsconfig.tools-tests.json`, `tools/matrix/__tests__/tools-tests-typecheck.test.ts`
- Modify:
  - `package.json` (devDependency `vitest`, the engine's range `^4.1.11`; `pnpm-lock.yaml` via `pnpm install`);
  - `tools/matrix/__tests__/scenarios.test.ts:734,745,1567,1776,1785`;
  - `scripts/__tests__/seed-demo-templates.test.ts:38`;
  - `scripts/__tests__/stripe-connect-fixture.test.ts:137`;
  - `scripts/__tests__/tools-import-guard.test.ts:23` (TS7016: add `scripts/lib/tools-import-guard.d.mts`);
  - `.github/workflows/ci.yml` (`gates` step);
  - `tools/matrix/__tests__/ci-wiring.test.ts` (a case pinning that step; review 2, R2-I3);
  - `_INDEX.md` (the bench carry, Task 16).

**Interfaces:**
- Produces:
  - `tsconfig.tools-tests.json`:

    ```json
    {
      "extends": "./tsconfig.scripts.json",
      "compilerOptions": { "module": "preserve", "moduleResolution": "bundler", "noEmit": true },
      "include": ["scripts/**/*.ts", "tools/matrix/**/*.ts"],
      "exclude": []
    }
    ```

    Step 0 confirms `extends` keeps `paths: {"@/*"}` and `allowImportingTsExtensions`.
  - The gates step `- run: node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json`.

- [ ] **Step 1: Measure first, then write the failing test**

```bash
cd <exec> && rtk proxy node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json > "$TMPDIR/w1d-t10-before.txt"; echo EXIT=$?; grep -ac "error TS" "$TMPDIR/w1d-t10-before.txt"; grep -ao "^[^(]*" "$TMPDIR/w1d-t10-before.txt" | sort | uniq -c
```

Expected: about 8 errors at HEAD (5 in `scenarios.test.ts`, 3 in `scripts/__tests__`), plus any in the test files and `workflow-text.ts` that Tasks 1–9 added (scoped tsc there covered non-test files only, so they have never been type-checked; fix those in this task, review 7, m2), and **zero under `apps/web`**. Bundler resolution is the claim D9 rests on. If ANY `apps/web` file errors, STOP and report the list: D9's premise is false, and the owner chooses between excluding those three tests and fixing app types.

`tools-tests-typecheck.test.ts`:

```ts
const tracked = (glob: string) => spawnSync("git", ["ls-files", glob], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
it("tsconfig.tools-tests.json covers every tracked matrix test and every tracked scripts test, counted separately (review m13)", () => {
  const r = spawnSync(process.execPath, ["node_modules/typescript-native/bin/tsc", "-p", "tsconfig.tools-tests.json", "--listFilesOnly"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  const listed = new Set(r.stdout.split("\n").map((f) => relative(process.cwd(), f.trim())).filter(Boolean));
  const matrix = tracked("tools/matrix/__tests__/*.test.ts");
  const scripts = tracked("scripts/*.test.ts");     // a git pathspec's * crosses "/", so this is recursive
  expect(matrix.length).toBeGreaterThan(0);        // 67 at HEAD 2026-10-04; derived, never typed in
  expect(scripts.length).toBeGreaterThan(0);       // 15 at HEAD
  for (const f of [...matrix, ...scripts]) expect(listed.has(f), f).toBe(true);
});
it("…and none of bench's TESTS (bench's lib is allowed: HM/run.ts imports it, R3; review I7)", () => {
  const r = spawnSync(process.execPath, ["node_modules/typescript-native/bin/tsc", "-p", "tsconfig.tools-tests.json", "--listFilesOnly"], { encoding: "utf8" });
  const bench = r.stdout.split("\n").filter((f) => /tools\/bench\//.test(f));
  expect(bench.filter((f) => /\.test\.ts$|\/__tests__\//.test(f))).toEqual([]);
});
```

The type-check ITSELF is not a vitest test (review m12): a full `tsc -p` inside the unit step would duplicate the gates step's minutes against `ci.yml`'s unit-step timeout. The gates step below is the check, and Step 4 runs it locally.

Because the gate now lives only in YAML, a test must pin the step, or deleting it would leave everything green (review 2, R2-I3; classes 1 and 3). In `ci-wiring.test.ts`, in the line style of the reference-boundary case (`:355-362`):

```ts
it("the tools-tests type-check runs in the gates job, exactly once, and nothing can make it conditional or advisory (W1d item 7)", () => {
  const STEP = "      - run: node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json";
  const at = lines.indexOf(STEP);
  expect(at).toBeGreaterThan(0);
  expect(lines.filter((l) => l.includes("tsconfig.tools-tests.json") && !isComment(l))).toEqual([STEP]);
  // a key under the step (`if:`, `continue-on-error:`, `env:`, …) would sit at indent 8
  expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);
  expect(jobAt(at)).toBe("  gates:");
});
```

It reuses that `describe`'s `lines`/`isComment`/`jobAt` helpers. Move them to the file's top level if the new case sits outside that block.

- [ ] **Step 2: See it fail on the 8 errors. Step 3: Fix them.**

Open each error line and fix the test's types. Do not change what a test asserts (class 4): a `TS2554` (wrong arg count) means the test calls a helper whose signature moved; follow the helper. Add the `.d.mts` for `scripts/lib/tools-import-guard.mjs`, declaring exactly what the `.mjs` exports (read it: 47 lines).

Then run `pnpm add -D -w vitest@^4.1.11`. The lockfile diff must ADD only a root importer entry pointing at the same resolved `vitest` version the engine uses; a second vitest version is a STOP. Then add the gates step, appended AFTER Task 1's lock-check step (never directly after `reference:boundary`, which Task 1's test pins; review 7, m1).

- [ ] **Step 4: Pass, mutate, commit**

Run the vitest template on `tools-tests-typecheck.test.ts scenarios.test.ts ci-wiring.test.ts` (3 files in `.testResults[].name`). Plus run `cd <exec> && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1d-t10s.json" scripts/__tests__/seed-demo-templates.test.ts scripts/__tests__/stripe-connect-fixture.test.ts; echo EXIT=$?`, judged the same way.

The guard test is Task 11's. It does not collect from a nested worktree (vite import analysis on `typescript.js`), which is environmental and noted in facts. Run it from the exec worktree; if it fails to collect there too, that is the same environment fault, and CI is the arbiter.

Run the gates step's command locally: `cd <exec> && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?`, expecting `EXIT=0`.

Mutate:
- re-introduce one `scenarios.test.ts` error (an extra argument): that command exits non-zero, naming the file;
- drop `scripts/**` from the tsconfig's `include`: "covers every tracked … scripts test" reds;
- delete the gates step: the new `ci-wiring` case reds (R2-I3);
- add `continue-on-error: true` under it: the same case reds on its indent check.

Commit `chore(matrix): type-check tools/matrix and scripts tests in CI; vitest is a root devDependency (W1d item 7, D9)`.

---

### Task 11: The `tools/` import guard sees spawn-by-path (item 28)

**Why:** `scan()` judges imports, manifests, tsconfigs and script NAMES. A string literal holding a `tools/…` path passed to `exec`/`execFile`/`spawn`/`fork` (or their `Sync` forms) is never judged, so `apps/`, `packages/` or `scripts/` could run tools code at runtime while the guard stays green.

**Files:**
- Modify: `scripts/__tests__/tools-import-guard.test.ts` (`scan()` `:94-177`, its fixture, the positive control `:268-288`, the real-tree floors `:290-316`)

**Interfaces:**
- Produces: `scan()` returns, in addition to today's fields, `spawnCalls: number` (calls inspected) and `spawnHits: { file: string; line: number; arg: string }[]`. `SPAWN_EXEMPT = ["packages/reference/test/boundary-gate.test.ts", "scripts/__tests__/tools-import-guard.test.ts"]` holds exact paths, each with its reason in a comment.

- [ ] **Step 1: Write the failing tests**

Extend the `fixture()` helper with three files:
- `scripts/spawns.ts`: `execFileSync("node", ["--experimental-strip-types", "tools/matrix/run.ts"])` (a hit);
- `apps/web/x/spawn-decoy.ts`: `const p = "tools/matrix/run.ts"; spawnSync("git", ["ls-files"])`. This is the dockerignore/z3 decoy shape: a tools literal in a file that spawns something else. It is not a hit;
- `packages/reference/test/boundary-gate.test.ts`: `spawnSync("node", ["tools/bench/x.ts"])` (exempt).

```ts
it("a tools/ path passed to a spawn call is a hit; a tools/ literal elsewhere in a spawning file is not; the exempt file is exempt", () => {
  const r = scan(fixture());
  expect(r.spawnHits).toEqual([{ file: "scripts/spawns.ts", line: 1, arg: "tools/matrix/run.ts" }]);
  expect(r.spawnCalls).toBe(2);   // spawns.ts and spawn-decoy.ts; the exempt file is not inspected
});
it("every spelling: exec, execSync, execFile, execFileSync, spawn, spawnSync, fork, and child_process.<x>, and ./tools and an absolute-ish join", () => {
  for (const call of ["exec(\"node tools/matrix/a.ts\")", "cp.execSync(\"pnpm --dir tools/matrix x\")", "fork(\"./tools/bench/b.ts\")", "spawn(\"node\", [join(root, \"tools\", \"matrix\", \"run.ts\")])"]) {
    expect(scan(fixtureWith(`scripts/one.ts`, call)).spawnHits).toHaveLength(1);
  }
});
it("the real tree: spawn calls were inspected (non-zero) and none reaches tools/", () => {
  const r = scan(process.cwd());
  expect(r.spawnCalls).toBeGreaterThan(10);
  expect(r.spawnHits).toEqual([]);
});
```

The `join(root, "tools", "matrix", …)` case: a call argument whose string-literal pieces include `"tools"` immediately followed by `"matrix"` or `"bench"` counts.

- [ ] **Step 2: See them fail. Step 3: Implement**

In `scan()`, for each source file already read (the existing loop at `:150-160`):
- `ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)`;
- walk it with `ts.forEachChild`;
- for each `CallExpression` whose callee's final identifier is in `SPAWNERS = /^(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/`, collect every `StringLiteral`/`NoSubstitutionTemplateLiteral`/template head and span inside the call's ARGUMENTS (descending into arrays and nested calls like `join(...)`), and count one `spawnCalls`;
- a hit is any collected literal matching `/(^|[\s"'./])tools\/(matrix|bench)\b/`, or an adjacent pair of literals `"tools"`, `"matrix"|"bench"`.

Skip files in `SPAWN_EXEMPT` before parsing. The guard test file names `tools/` paths in its own fixtures, which is why it is exempt by exact path.

- [ ] **Step 4: Pass, mutate, commit**

Run `cd <exec> && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1d-t11.json" scripts/__tests__/tools-import-guard.test.ts; echo EXIT=$?` and judge it with the template's node line. If it fails to COLLECT with "Failed to parse source for import analysis" (the nested-worktree vite fault recorded in facts), run it from a fresh non-nested detached worktree:

```bash
cd /Users/ashokhein/github/seazn.club && git worktree add --detach /private/tmp/w1d-guard-check feat/format-matrix-w1d-infra && cd /private/tmp/w1d-guard-check && pnpm install --frozen-lockfile && ./packages/engine/node_modules/.bin/vitest run … ; echo EXIT=$?
```

Remove that worktree after.

Mutate:

| Mutant | Killing test |
|---|---|
| Drop `fork` from `SPAWNERS` | "every spelling" |
| Collect ALL literals in the file, not only call arguments | the decoy test (spawn-decoy becomes a hit) |
| Remove the exemption | the first test |

Commit `test(guard): the tools/ import guard judges spawn-call arguments (W1d item 28)`.

---

### Task 12: Pad adapter and pad-proof carries (items 8, 9, 15a, 15b, 16; D16)

**Why:** The replay's guards are unwitnessed (item 8), and the adapter minors are open (item 9). F-PP-1's timeout cannot explain itself (15a). Pad proof cannot be scoped to one sport (15b). Cricket two-innings events have no pad route, so 24 `test` cases are HTTP-only (16).

**Files:**
- Modify:
  - `tools/matrix/lib/pads/{cricket,carrom,period,replay,types}.ts`;
  - `tools/matrix/lib/driver/browser-driver.ts` (`padCheck` `:243-246`; the tap timings);
  - `tools/matrix/lib/pad-proof-set.ts:14-15`;
  - `tools/matrix/run.ts:561`.
- Test:
  - `pad-replay.test.ts`, `pad-adapters.test.ts`, `browser-driver.test.ts`, `pad-proof.test.ts` (extend; there is no `pad-proof-set.test.ts` at HEAD, review I15);
  - `pad-cricket-innings.test.ts` (create).

**Interfaces:**
- `--set pad-proof --only league|<sport>` is accepted. One sport, where `<sport>` ∈ `PAD_SPORTS`; any other filter stays refused. `planOf` → `--set pad-proof --only league|<sport>`, which `committed-plans.ts` parses.
- `TapTiming = { tap: number; clickedAtMs: number; ledgerSeenAtMs: number | null; waitedMs: number; budgetMs: number }`. A `TapWaitTimeout` message ends with `last taps: <JSON of the last 5 TapTimings>`, redacted.
- `cricketPad` accepts `inningsPerSide: 2` and routes:
  - `cricket.followon` (the pad's follow-on control);
  - `cricket.match.close`;
  - a declared innings (`cricket.declare`, or the event name the engine declares; Step 0 reads it from `packages/engine/src/sport/cricket*`).

- [ ] **Step 0: Read the referents**

- Item 8 cites `pad-replay.test.ts:49-61,154-173` and `browser-driver.ts:243-246,645`.
- Item 9's M-4 is `cricket.ts:86,146-148`; M-8 is `carrom.ts:27` vs `apps/web/src/components/v2/scorepad/v3/skins/carrom.tsx:452,479`; Mn-1 is `period.ts:37,49`; Mn-2 is `replay.ts:103`.
- For item 16: grep the cricket v3 skin for the follow-on, declare and close controls (`rtk proxy grep -an "followon\|declare\|match.close" apps/web/src/components/v2/scorepad/v3/skins/cricket*.tsx`) and the engine's event names. **If the skin has no control for one of them, that event is a 🚫 naming the owning wave, not a route.** Record which; ruling 52 says routes for what the pad offers. Re-pin the sizing below against what you find.

- [ ] **Step 1: Write the failing tests**

Item 8:
- "a ledger row at seq ≤ the server tip is never replayed": the fake ledger gains rows at `tip-1` and `tip`, and the replay sends only the later ones;
- "the unseated-fixture guard refuses by name": drive `browser-driver` with a fixture whose entrants are unseated, and expect the message `does not seat two entrants` (the text at `:645`);
- "padCheck lists 12 notes and then '+N more' when there are more": 14 notes → 12 lines + `+2 more`.

Item 9:
- M-4: two consecutive `stepsFor` calls on two different events give independent `tapped` state. Today the module-level variable leaks between them; the test calls `stepsFor(eventA)`, then `stepsFor(eventB)` without consuming A, and asserts B's steps equal a fresh adapter's. Fix: move `tapped` into the closure `stepsFor` returns, and document "stepsFor is one-shot per event" on `MatrixPadAdapter.stepsFor` (`types.ts:33-45`).
- M-8: "carrom's coin bound is the skin's": read `carrom.tsx` as TEXT, extract the `max:` beside the coins field (`/coins[\s\S]{0,200}?max:\s*(\d+)/`), and assert the adapter refuses `max+1` and accepts `max`. Change `carrom.ts:27` to a named constant `CARROM_COIN_MAX = 9`, with a comment pointing at the skin line. The test is the binding.
- Mn-1: "period.ts refuses 1.5 periods". Mutate `Number.isInteger` → `Number.isFinite` and see it red.
- Mn-2: "replay.ts:103 FallbackMismatch is returned, not thrown, and names both sides". Read the line first; the test pins its exact message shape.

15a: `browser-driver.test.ts`, "a tap-wait timeout's message carries the last 5 tap timings, each with clickedAtMs and waitedMs, redacted". It uses the fake page whose ledger never advances.

15b: `pad-proof.test.ts`, covering `--only league|badminton` → only badminton's cases; `--only league|chess` (not in `PAD_SPORTS`) → refused; `--scenario M1` → still refused; and the empty case, `--only` with an empty value → usage.

16, `pad-cricket-innings.test.ts`:
- "inningsPerSide 2 is accepted";
- "a follow-on request yields the follow-on control's steps";
- "a declared innings yields the declare control";
- "match.close yields the close control";
- "the 24 committed cricket test cases (w1drv-l3) each map to a route or a named 🚫". It reads `TR/w1drv-l3/results.json`, filters `|cricket|test|`, expects 24, and asserts every event type their ledgers hold is routable.

- [ ] **Step 2: See them fail. Step 3: Implement each to its test.** Keep each item's change inside its file. The tap timing is a small ring buffer in the driver's tap loop.

- [ ] **Step 4: A live proof of 15b and 16**

Use the local env recipe and a fresh run id:

```bash
cd <exec> && pnpm matrix:browser --set pad-proof --only "league|cricket" --run-id w1d-t12-pp-cricket --report-dir "$TMPDIR/w1d-runs"; echo EXIT=$?
```

Expected: EXIT 0, and only cricket cases in `results.json`. The two-innings routes are exercised only if the pad-proof set plans a `test` variant. If it does not, ALSO run `--driver browser --set w1-driving --only "league|cricket" --scenario LIFECYCLE` at 1280 on the `test` variant (D13 of W1-driving: the variant's own case) and record what the pad did. Report the browser-driven count of cricket `test` cases. **Not committed** (this is a task proof, not evidence); paste the `jq` histogram into the task report.

- [ ] **Step 5: Mutate**

| Mutant | Killing test |
|---|---|
| `padCheck` without `+N more` | its test |
| `tapped` back to module scope | M-4 |
| `CARROM_COIN_MAX = 10` | M-8 |
| `pad-proof-set` accepting any `--only` | the chess refusal |

- [ ] **Step 6: Scoped tsc, eslint, commit**

Commit `feat(matrix): pad carries — replay guards witnessed, adapter minors, tap timings, single-sport pad proof, cricket two-innings routes (W1d items 8, 9, 15a, 15b, 16)`.

---

### Task 13: Harness minors (items 10, 11, 13, 17, 18, 20, 22, 23, 24, 26; D11)

**Why:** Each is small and owned here by name. Batched (ruling 41) because none changes a case's state.

**Files:**
- `lib/parity.ts:145` (10);
- `__tests__/boundary.test.ts:215-226` and `__tests__/browser-budget.test.ts:42` (11);
- `run.ts:454,545-548` (17);
- `lib/workers.ts:25-28` comment (18);
- the plain-browser planner in `run.ts` and `browser-driver.ts:367-383` (20);
- `lib/browser/pages/stage-rail.ts:115-123` (22);
- `lib/scenarios/common.ts:226` (23);
- `lib/scenarios/r4-withdrawal.ts:366` (24);
- `lib/model/run-cell.ts:155-165` and `model.ts` (26).

Each item extends its tests in the existing test file for that module.

- [ ] **Step 1: Write the failing tests, one per item**

- **10:** "a browser error red that kept its checks, against an HTTP works case, lists each check row" (today `quiet` hides them). And kill the unkilled conjunct: "equal states with one side check-less is NOT quiet".
- **11:** `boundary.test.ts` matches `spec === "playwright" || spec.startsWith("playwright/") || spec === "@playwright/test"`. `FLAT` adds `setDefaultTimeout\(\s*\d`, `setDefaultNavigationTimeout\(\s*\d` and `new Promise\(\s*\(?r\w*\)?\s*=>\s*setTimeout\(\s*\w+,\s*\d`. Each new spelling gets a positive fixture string that must be caught and a negative that must not. The real-tree scan still reports zero hits with a non-zero count of files scanned.
- **13:** No code; accepted (T8 m-2). Task 19's triage rule T-H names any L1 red whose reason mentions hydration or first control and sends it to the owner as item 13's revisit trigger.
- **17 (D11):** "`--driver browser --workers 2` is refused with a message naming the shard matrix, and no route names W1d". Assert the message contains `parallelism is the shard matrix (W1d D11)`, and that `rtk proxy grep -a 'routeTo("W1d"' tools/matrix -r` finds nothing (a test reading `run.ts` text). The scenario-catalogue Q-A guard stays green after `_INDEX.md` marks W1d done.
- **18:** "MAX_WORKERS stays 8; the comment names D11". A text test on `workers.ts`, so a silent raise is a diff the test sees.
- **20:** "`--driver browser --only group_only|badminton` plans the template case, like the grid does". Today it throws DriverMisuse naming the template. The plain browser planner routes template-reachable API-only cells through `templateFor`, as `planL1Grid` does in Task 3, and reuses that item builder. Second assertion: "a template competition is created public; the run's org is the case's own, so its public quota is that org's", which reads the gallery's request shape from `template-gallery.tsx:316-324` as text and asserts no `visibility` key. Record that each case gets its own org, so quota never accumulates across cases.
- **22:** "a multi-stage knockout L1 case shoots `08-completed` after the LAST stage completes; the group stage's completion shot is `07-stage-1-completed`". The fake page holds two stages; assert the shot order.
- **23:** "team-entrant rows are named Matrix Team N; individual rows stay Matrix Player N". It reads the row's entrant kind from the catalogue's `entrantKind`, or wherever `model/state.ts:345` derives it (Step 0).
- **24:** "the americano policy note names the withdrawn entrant's persons count, not every id". For example, `2 pending game(s) of the withdrawn entrant (2 persons)`. The note keeps the policy and pending count, and drops the `join("+")`.
- **26:** "MB-007 and MB-010 (same cell, check, match) are told apart by their shown trigger". `regressionFor` gains a `trigger` argument: the scenario step that tripped it, which `run-cell.ts` already logs per step (Step 0 names the field). Among open cases matching cell, check and match, it prefers the one whose `regressions.json` row's `trigger` equals it. If two or more match and none names the trigger, it returns `ambiguous: [ids]`, which the model reports as NEW-or-ambiguous and NEVER as known. A `trigger` field is added to MB-007 and MB-010 in `catalogue/regressions.json`, read from their commands. That is catalogue data, not evidence, so it may change. The test replays the `w1drv-t16fr1-model-de` withdrawn-trigger failure shape and expects `ambiguous` or MB-010, never MB-007.

- [ ] **Step 2: See each fail. Step 3: Implement each. Step 4: Run.**

Run the vitest template on the files touched:

```
parity.test.ts boundary.test.ts browser-budget.test.ts run-cli.test.ts workers.test.ts browser-driver.test.ts page-objects.test.ts scenarios.test.ts model-run-cell.test.ts
```

All nine exist at HEAD (re-pinned 2026-10-04 with `ls tools/matrix/__tests__`; the rail's tests live in `page-objects.test.ts:108-170`, there is no `stage-rail.test.ts`, review I15). The JSON reporter's `.testResults[].name` must list exactly 9 files: a misspelt positional is dropped silently and the run reports green on fewer.

- [ ] **Step 5: Mutate (one per item that has a guard)**

| Mutant | Killing test |
|---|---|
| 10: restore `&& h.state !== b.state` deletion | the conjunct test |
| 11: drop the `setDefaultTimeout` alternation | its positive fixture |
| 17: re-add `routeTo("W1d"` | the text test |
| 26: make the matcher return the first match | the ambiguity test |

- [ ] **Step 6: Commit**

Commit `fix(matrix): harness minors — parity quiet, scan spellings, browser workers declined, template cells, completion shot, team names, fence ambiguity (W1d items 10, 11, 13, 17, 18, 20, 22–24, 26; D11)`.

---

### Task 14: Browser carries — match-day run sheet, fold branch, void, forfeit and withdraw at 1280 (items 15c–15f; D15, D17)

**Why:** Four organiser paths the browser has never proven, or never proven at 1280. Each becomes a small committed carry run under `TR/w1d-carry/` with a lock entry: the first committed runs of W1d, and the first exercise of Task 1's append-only gate on a real addition.

**Files:**
- Modify:
  - `tools/matrix/lib/browser/pages/run-sheet.ts` (`readDefaultFilter`, before `showAllFixtures`);
  - `tools/matrix/lib/browser/pages/stage-rail.ts:64` (record the fold result);
  - `tools/matrix/lib/browser/pages/fixture-console.ts` (`voidLastUi`);
  - `tools/matrix/lib/driver/{types,http-driver,browser-driver,mixed}.ts` (`voidLast`);
  - `tools/matrix/lib/browser/selectors.ts` (the void-last selector, read from the console's markup);
  - `tools/matrix/run.ts` (`SETS`).
- Create:
  - `tools/matrix/lib/scenarios/void-proof.ts`;
  - `tools/matrix/lib/match-day-set.ts`;
  - `tools/matrix/lib/carry-1280-set.ts`.
- Test:
  - `__tests__/run-sheet-today.test.ts`, `__tests__/void-proof.test.ts`, `__tests__/carry-sets.test.ts` (create);
  - `__tests__/page-objects.test.ts` (extend: its `describe("the stage rail's fold")` block, `:112`).
- Evidence: `TR/w1d-carry/{match-day-1280,match-day-320,void-1280,void-320,carry8-1280}/`, `TR/plans.lock.json` (5 added entries), `committed-matrix.test.ts` `EVIDENCE_DIRS` + `RESULTS_FLOOR`.

**Interfaces:**
- `OrganiserDriver.voidLast(fixtureId: string): Promise<{ voidedEventId: string; voidedType: string }>`. HTTP finds the newest event of the fixture that is not `core.void` and not already voided (the console's own rule, `fixture-console.tsx:882`), then appends `core.void {event_id}`. Browser clicks the console's "Void last" control.
- `ACTION_TYPES` gains `"voidLast"`. The mixed driver records it like every action.
- Check id `runsheet-today-default` (D17). Check id `fold-branch` (15d): `{ width, branch: "opened" | "unfolded" }`, where `opened` is expected below 768 and `unfolded` at or above it (the design: `max-md` is <768).
- Sets:
  - `match-day` (league|badminton LIFECYCLE @1280 and @320: 2 cases);
  - `void-proof` (league|badminton VOIDPROOF @1280 and @320: 2 cases);
  - `carry8-1280` (league|generic and knockout|badminton × M1, R4: 4 cases @1280).

  Every one is layered, so `planOf` → `--set <name>`.

- [ ] **Step 0: Read the product**

- The console's "Void last" markup: `fixture-console.tsx:1270-1290` (its `data-testid`, or its accessible name via the `score.voidLast` dictionary key). Read the English value from `apps/web/src/i18n/dictionaries/en*.json`, and prefer a testid if one exists.
- The run sheet's "today" filter value and how `phase === "match_day"` is derived (`stages-panel.tsx:550-556`, plus the phase derivation it reads).
- The HTTP endpoint the harness can use to schedule a fixture for today: `rtk proxy grep -an "scheduled_at\|schedule" tools/matrix/lib/driver/http-driver.ts`. If the driver has no schedule method, use the product route the scheduler UI calls, and record it.
- **If making a competition "match day" needs a product path the harness cannot reach, the match-day set records 🚫 naming the path, and that is a finding for the owner**, not a reason to fake the date.

- [ ] **Step 1: Write the failing tests**

```ts
// run-sheet-today.test.ts — fake page with a run sheet whose default filter is "today"
it("reads the default filter BEFORE widening it, and the today rows are exactly the fixtures dated today", async () => {
  const page = fakeRunSheet({ pressed: "today", rows: [1, 3], allRows: [1, 2, 3] });
  const seen = await readDefaultFilter(ctxOf(page));
  expect(seen).toEqual({ filter: "today", rows: [1, 3] });
  expect(page.clicks).toEqual([]);           // nothing pressed yet
});
it("judges runsheet-today-default: today on match day, all otherwise; abstains, counted, with no fixture dated today", () => {
  expect(judgeTodayDefault({ phase: "match_day", seen: { filter: "today", rows: [1, 3] }, datedToday: [1, 3] }).verdict).toBe("pass");
  expect(judgeTodayDefault({ phase: "match_day", seen: { filter: "all", rows: [1, 2, 3] }, datedToday: [1, 3] }).verdict).toBe("fail");
  expect(judgeTodayDefault({ phase: "match_day", seen: { filter: "today", rows: [1] }, datedToday: [1, 3] }).verdict).toBe("fail");
  expect(judgeTodayDefault({ phase: "scheduled", seen: { filter: "all", rows: [1, 2, 3] }, datedToday: [] })).toEqual({ verdict: "abstain", checked: 0, note: expect.stringContaining("no fixture dated today") });
});

// page-objects.test.ts, inside describe("the stage rail's fold")
it("records the fold branch: opened below 768, unfolded at 768 and above", async () => {
  for (const [w, want] of [[320, "opened"], [767, "opened"], [768, "unfolded"], [1280, "unfolded"]] as const) {
    expect((await railBranchAt(w)).branch).toBe(want);
  }
});

// void-proof.test.ts — through the fake driver and the REAL engine fold (class 1)
it("VOIDPROOF scores one event, voids it, and the ledger and the fold both show it voided", async () => {
  const r = await runScenario("VOIDPROOF", "league|badminton", fakeDriverWithEngine());
  expect(r.checks.find((c) => c.id === "void-ledger")!.verdict).toBe("pass");
  expect(r.checks.find((c) => c.id === "void-fold")!.verdict).toBe("pass");
  expect(r.checks.find((c) => c.id === "void-fold")!.checked).toBeGreaterThan(0);
});
it("a second void voids the NEXT newest event, never the void itself (sequence)", async () => {
  const r = await runScenario("VOIDPROOF", "league|badminton", fakeDriverWithEngine(), { voids: 2 });
  expect(r.voided.map((v) => v.type)).not.toContain("core.void");
  expect(new Set(r.voided.map((v) => v.id)).size).toBe(2);
});
it("void with nothing to void is refused by the product shape, never sent", async () => {
  await expect(fakeDriverWithEngine().voidLast("fixture-with-no-events")).rejects.toThrow(/nothing to void/);
});

// carry-sets.test.ts
it("each carry set plans exactly its cases, at its widths, and planOf names it", () => {
  expect(planOf(cliFor("--set match-day"))).toBe("--set match-day");
  expect(caseIdsOf("carry8-1280")).toEqual([
    "league|generic|default|M1", "league|generic|default|R4", "knockout|badminton|default|M1", "knockout|badminton|default|R4",
  ].map((id) => expect.stringContaining(id.split("|default|")[0])));
});
```

`fakeDriverWithEngine` folds through `@seazn/engine`'s real reducer, as the W1-driving scenario tests already do. Step 0 names their helper; reuse it.

- [ ] **Step 2: See them fail. Step 3: Implement.**

1. `readDefaultFilter(c)` reads `aria-pressed="true"` among `RUN_SHEET_FILTER_OPTIONS` and the visible `li[data-fixture-no]` numbers, BEFORE `showAllFixtures`. `railFor` calls it when the case's spec asks (the match-day set), and passes `seen` to the scenario's check.
2. `railFor` returns `{ sheet, branch }`, and the driver records `fold-branch` once per case.
3. `voidLast` goes into all four drivers. In the browser it opens the console (`fixture-console.ts`), clicks the void-last control (`actBudget`), and waits for the ledger tip to advance by one `core.void`, the same wait the pad uses.
4. `VOIDPROOF` = LIFECYCLE up to the first scored fixture, plus one score event, `voidLast`, the checks `void-ledger` (the ledger's newest row is `core.void` naming that event) and `void-fold` (the fold's score equals the score before the event), then the remaining LIFECYCLE.
5. Register the three sets in `SETS`, and teach `expectedPlanFor` the three plan strings.

- [ ] **Step 4: Run them, then the live carries**

Run the vitest template on the four test files plus `committed-plans-frozen.test.ts run-cli.test.ts`. Then, on the local env (fresh DB; each set under a fresh run id):

```bash
cd <exec> && for s in match-day void-proof carry8-1280; do pnpm matrix:browser --set $s --run-id w1d-carry-$s --report-dir "$TMPDIR/w1d-runs"; echo "$s EXIT=$?"; done
```

Expected: EXIT 0 or 1 per set. 1 is a red case, which is data (ruling 19): read its reason. A crash or harness-error red (D6) is a harness bug, fixed in this task. Then copy each run's `results.json` + `MATRIX.md` + shots into `TR/w1d-carry/<name>/`, using the width-split directory names in the Files list where a set ran both widths. Add their lock entries exactly as `committed-matrix.test.ts`'s missing-entry failure prints them, extend `EVIDENCE_DIRS`, and raise `RESULTS_FLOOR` by the number of `results.json` added.

**The visual check is owed** (AGENTS class 15; feedback "verify visually"). Open the match-day shots at 320 and 1280 and the void shots before and after. Write one line per screen in `TR/w1d-carry/README.md`: what the screen shows, not what must be true.

- [ ] **Step 5: Mutate**

| Mutant | Killing test |
|---|---|
| `readDefaultFilter` called AFTER `showAllFixtures` | the first run-sheet test (clicks non-empty) |
| `voidLast` picking the newest event including `core.void` | "a second void" |
| `fold-branch` threshold 767 | its test |

- [ ] **Step 6: Commit (two commits)**

- Code: `feat(matrix): match-day run sheet, fold branch, void in the browser, forfeit/withdraw at 1280 (W1d items 15c–f; D15, D17)`.
- Evidence: `docs(matrix): W1d carry runs — match-day, void-proof, carry8-1280 (+5 lock entries)`. Run `pnpm matrix:lock-check --against HEAD^1` before this commit; it must print `… 5 added`.

---

### Task 15: Stryker on the engine, placement scheduling excepted (design §7.5 item 2; rulings 66, 67; D14)

**Why:** Mutation testing is the design's answer to "a green suite whose guards are never killed" (class 3), applied weekly to the engine's format and rules code. Ruling 67 sets the scope: every module under `packages/engine/src` plus the draw generators under `src/scheduling/`. The placement files (build, calendar, repair) are a named exclusion a later wave may lift, and `testkit/` is out entirely.

**Files:**
- Create:
  - `packages/engine/stryker.config.mjs`;
  - `packages/engine/stryker.groups.mjs`, and `packages/engine/stryker.groups.d.mts` declaring exactly its five exports, `STRYKER_GROUPS`, `STRYKER_EXCLUDED`, `STRYKER_PLACEMENT_OUT_OF_SCOPE`, `STRYKER_VITEST_WORKERS` and `strykerConcurrency` (review I11d: the engine tsconfig includes `test/**`, and a `.ts` test importing an untyped `.mjs` is TS7016);
  - `packages/engine/stryker-floor.json` (`{"note": "...", "groups": {}}`: empty until PR-B, Task 20);
  - `packages/engine/stryker-timeouts.json` (`{group: minutes}`, written by Step 4), `packages/engine/scripts/stryker-matrix.mjs` and `packages/engine/test/stryker-matrix.test.ts` (the per-event matrix; review 4, R4-I2);
  - `packages/engine/stryker-equivalent.json` (`{"note": "...", "equivalent": []}`);
  - `packages/engine/scripts/stryker-floor.ts`;
  - `packages/engine/test/stryker-groups.test.ts`;
  - `packages/engine/test/stryker-floor.test.ts`;
  - `.github/workflows/mutation.yml`.
- Modify:
  - `packages/engine/package.json` (devDependencies `@stryker-mutator/core` `10.0.0` and `@stryker-mutator/vitest-runner` `10.0.0`; scripts `"mutation": "stryker run stryker.config.mjs"` and `"mutation:floor": "node --experimental-strip-types scripts/stryker-floor.ts"`);
  - `pnpm-lock.yaml`;
  - `.github/workflows/ci.yml` (the gates floor step below, appended after Tasks 1 and 10's steps), and `tools/matrix/__tests__/ci-wiring.test.ts` (its pin);
  - `.gitignore` (`packages/engine/reports/mutation/`, `packages/engine/.stryker-tmp/`).

**Interfaces:**
- `STRYKER_GROUPS: Record<"competition" | "core" | "modules" | "draws" | "sports-cricket" | "sports-football" | "sports-period" | "sports-setbased" | "sports-nested" | "sports-other" | "probe", string[]>`, as globs relative to `packages/engine` (rulings 66, 67). Every directory-glob group ends with `NO_TESTS = ["!src/**/*.test.ts", "!src/**/__tests__/**"]` (review I11a: `src/` co-locates its tests, and a glob without the negations would have Stryker mutate test files):
  - **competition:** `src/competition/**/*.ts`;
  - **core:** `src/core/**/*.ts`;
  - **modules:** `src/sport/**/*.ts`, `src/stats/**/*.ts`, `src/history/**/*.ts`, `src/officials/**/*.ts`, `src/import/**/*.ts`, `src/exports/**/*.ts`;
  - **draws:** exact files `src/scheduling/<name>.ts` for `bracket`, `bracket-layout`, `roundrobin`, `swiss`, `americano`, `participants`, `feedgraph` (ruling 67 lists them; they are format code);
  - **the six sports groups** split `src/sports/` by sport family, one directory set each:
    - `sports-cricket`: `src/sports/cricket/**/*.ts`;
    - `sports-football`: `src/sports/football/**/*.ts`;
    - `sports-period`: `src/sports/period/**/*.ts`, `src/sports/hockey/**/*.ts`, `src/sports/icehockey/**/*.ts`;
    - `sports-setbased`: `src/sports/setbased/**/*.ts`, `src/sports/tennis/**/*.ts`;
    - `sports-nested`: `src/sports/nested/**/*.ts`;
    - `sports-other`: `src/sports/generic/**/*.ts`, `src/sports/boardgame/**/*.ts`, `src/sports/carrom/**/*.ts`, and the top-level `src/sports/*.ts` (`index.ts`, `squad-state.ts`);
  - **probe:** `src/scheduling/roundrobin.ts` only (the PR self-proof, D3). `rest-floor.ts` is placement code and out of scope, so the probe moved to a format file with a co-located test (`roundrobin.test.ts`, checked at HEAD).

  The split is by sport family, because each family is one kernel with its own tests. It is an initial split, and Step 4 re-justifies it from the dry run's mutant count per group, never from line counts. A group the dry run shows to be disproportionate is split by file in that step, and the report says which and why.
- `STRYKER_PLACEMENT_OUT_OF_SCOPE: Record<string, string>` (ruling 67): the 19 placement files, each an exact `src/scheduling/<name>.ts`, each with the reason `ruling 67: placement scheduling, low priority (a later wave may lift this)`:
  - **build:** `build`, `build-grid`, `build-objectives`, `constraints`, `candidate-courts`;
  - **calendar:** `calendar`, `capacity`, `health`, `court-windows`, `tz`, `grid-step`, `rest-floor`;
  - **repair:** `repair-domain`, `repair-decompose-cpsat`, `repair-decompose`, `repair-synthetic-board`, `repair-minimality`, `conflict-detail`, `report`.
- `STRYKER_EXCLUDED: Record<string, string>` maps a glob (relative to `packages/engine`) to its OWN reason. Every `src/scheduling/` entry below is named by ruling 67's last bullet:
  - `src/scheduling/index.ts`: a barrel, re-exports only;
  - `src/scheduling/logger.ts`: holds no logic;
  - `src/scheduling/solver-test-bounds.ts`: a test helper;
  - `src/scheduling/placement-client.ts`: the gRPC client, covered only by integration tests that need the service;
  - `src/scheduling/payload-fixtures.ts`: test fixtures for the placement payloads, decided from the file itself (opened 2026-10-04; ruling 67 conditions the exclusion on it "only building the placement request": it builds no request, it is test fixtures for the calendar and repair tests, which is the stated reason). It builds frozen calendar `Assignment`s, golden slots and order dependencies, and only `calendar-*.test.ts`, `repair-domain.test.ts`, `participants-rules.test.ts` (as test input) and the out-of-scope `repair-synthetic-board.ts` import it. It feeds no draw or format code, so it is excluded. A test pins that no in-scope production file imports it (Step 1); if one ever does, move it into `draws` and say so in the task report;
  - `src/scheduling/generated/**`: generated;
  - `src/testkit/**`: `ruling 67: test helpers, not product`.
  Exclusion keys may be globs. Each carries a reason of at least 10 characters.

- `stryker-floor.ts` modes:
  - `--check <group> <mutation.json>`: exit 0 when the score ≥ floor; 1 when below (survivors listed); 2 refused (zero mutants, no floor for the group, unreadable);
  - `--set-floor <group> <mutation.json>`: PR-B only; writes `floor = floor(score, 1 dp)`, and refuses lowering;
  - `--check-file-against <ref>`: exit 1 when any group's floor in the working file is LOWER than at `<ref>`, or a group was removed. The empty cases are stated (review 7, R7-I1):
    - `stryker-floor.json` ABSENT at `<ref>` (`git show` says the path does not exist there) means "no floors yet": exit 0, printing `no floors at <ref>: nothing to compare`. This is PR-A's own first run, where `HEAD^1` is `main`, which lacks the file;
    - the file absent in the WORKING TREE is exit 2, always. PR-A commits it (as `{"groups": {}}`), so a missing file is a deletion, and after PR-B a deleted floor file must never read as "no floors" (the fail-closed rule of round 4);
    - an unreadable `<ref>`, a `git show` failure other than "path does not exist", or malformed JSON on either side is exit 2.
- `--survivors <group> <mutation.json> --out SURVIVORS.md` lists file:line:col mutator → replacement for each Survived/NoCoverage mutant not in `stryker-equivalent.json`.

- [ ] **Step 0: Versions and runtime**

```bash
cd <exec> && npm view @stryker-mutator/core@10.0.0 engines peerDependencies --json; npm view @stryker-mutator/vitest-runner@10.0.0 peerDependencies engines --json; ./packages/engine/node_modules/.bin/vitest --version
```

Record each. The vitest-runner peer must admit the engine's vitest 4. Stryker must load on Node 26 (it runs plain JS, so TS7 does not matter, and vitest transpiles TS itself). If `npm view` shows a newer 10.x patch, use the newest 10.x and record it.

Read Stryker's vitest-runner docs for its constraints on `pool`, `isolate` and `coverageAnalysis: "perTest"` (WebFetch `https://stryker-mutator.io/docs/stryker-js/vitest-runner/`). The engine runs `pool: threads`, `isolate: false` (`vitest.config.ts:40-66`). If the runner requires different settings, put them in `stryker.config.mjs`'s `vitest.configFile` override, a `vitest.stryker.config.ts` beside the main one. Never change the main config.

- [ ] **Step 1: Write the failing tests**

```ts
// stryker-groups.test.ts — every engine source file has exactly one home (rulings 66, 67)
const universe = () => globSync("src/**/*.ts", { cwd: ENGINE }).filter((f) => !/__tests__|\.test\.ts$|\.d\.ts$/.test(f));
// path.matchesGlob (node:path, Node 22+): minimatch is not a dependency of the engine or the root (review I11c)
const inMap = (map: Record<string, string>, f: string) => Object.keys(map).some((e) => matchesGlob(f, e));
// globSync's `exclude` option receives BASENAMES for files ('cascade.test.ts'), so a path negation never matches there
// (probed on Node 26.8.2: 24 files, 14 of them tests). Expand the positives, then filter the RESULT (review 4, R4-I1).
const expand = (globs: string[], only: string[] = globs.filter((g) => !g.startsWith("!"))) => globSync(only, { cwd: ENGINE }).filter((f) => !globs.filter((g) => g.startsWith("!")).some((n) => matchesGlob(f, n.slice(1))));
it("every non-test .ts under src/ is in exactly one group, a named exclusion, or the ruling-67 placement exclusion; unclassified = 0", () => {
  const files = universe();
  const owners = new Map<string, string[]>();
  for (const [g, globs] of Object.entries(STRYKER_GROUPS)) if (g !== "probe") for (const f of expand(globs)) owners.set(f, [...(owners.get(f) ?? []), g]);
  const unclassified: string[] = [], doubled: string[] = [];
  let grouped = 0, excluded = 0, placement = 0;
  for (const f of files) {
    const homes = (owners.get(f)?.length ?? 0) + (inMap(STRYKER_EXCLUDED, f) ? 1 : 0) + (inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f) ? 1 : 0);
    if (homes === 0) unclassified.push(f);
    if (homes > 1) doubled.push(f);
    grouped += owners.get(f)?.length ?? 0; excluded += inMap(STRYKER_EXCLUDED, f) ? 1 : 0; placement += inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f) ? 1 : 0;
  }
  // the failure message reports the count, so a red names how many files escaped (ruling 67)
  expect(unclassified, `${unclassified.length} of ${files.length} file(s) unclassified`).toEqual([]);
  expect(doubled, "files with more than one home").toEqual([]);
  // anti-vacuity, derived from the maps and never typed: the universe is exactly what was homed, and every class was non-empty
  expect(files.length).toBe(grouped + excluded + placement);
  expect(grouped).toBeGreaterThan(0);
  expect(excluded).toBeGreaterThan(0);
  expect(placement).toBe(Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE).length);   // every placement key is one existing exact file
});
it("every exclusion names its own reason and globs at least one file, in BOTH maps", () => {
  const files = universe();
  for (const [name, map] of [["STRYKER_EXCLUDED", STRYKER_EXCLUDED], ["STRYKER_PLACEMENT_OUT_OF_SCOPE", STRYKER_PLACEMENT_OUT_OF_SCOPE]] as const) {
    expect(Object.keys(map).length, name).toBeGreaterThan(0);
    for (const [k, reason] of Object.entries(map)) {
      expect(reason.length, `${name}[${k}]`).toBeGreaterThanOrEqual(10);
      // testkit and generated/ hold files the universe filter would keep; a stale key (renamed or deleted file) matches none
      expect(files.filter((f) => matchesGlob(f, k)).length, `${name}[${k}] matches no file`).toBeGreaterThan(0);
    }
  }
  expect(new Set(Object.values(STRYKER_EXCLUDED)).size, "each exclusion has its OWN reason").toBe(Object.keys(STRYKER_EXCLUDED).length);
  for (const r of Object.values(STRYKER_PLACEMENT_OUT_OF_SCOPE)) expect(r).toMatch(/^ruling 67: placement scheduling, low priority/);
  expect(STRYKER_EXCLUDED["src/testkit/**"]).toMatch(/^ruling 67:/);
});
it("no in-scope production file imports payload-fixtures.ts, the file excluded because it feeds only the placement tests (review 4, R4-m4)", () => {
  const inScope = universe().filter((f) => !inMap(STRYKER_EXCLUDED, f) && !inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f));
  expect(inScope.length).toBeGreaterThan(0);
  expect(inScope.filter((f) => /payload-fixtures/.test(readFileSync(join(ENGINE, f), "utf8")))).toEqual([]);
});
it("once any floor exists, every non-probe group has one: a missing entry is a failure, never a skip (review 4, R4-m3)", () => {
  const floors = JSON.parse(readFileSync(join(ENGINE, "stryker-floor.json"), "utf8")).groups as Record<string, number>;
  if (Object.keys(floors).length > 0) for (const g of Object.keys(STRYKER_GROUPS).filter((x) => x !== "probe")) expect(floors, g).toHaveProperty(g);
});
it("the probe is one exact file with a co-located test, and a draw generator (ruling 66)", () => {
  expect(STRYKER_GROUPS.probe).toEqual(["src/scheduling/roundrobin.ts"]);
  expect(existsSync(join(ENGINE, "src/scheduling/roundrobin.test.ts"))).toBe(true);
  expect(STRYKER_GROUPS.draws).toContain("src/scheduling/roundrobin.ts");
  expect(inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, "src/scheduling/roundrobin.ts")).toBe(false);
});
it("no group's mutate list reaches a test file (review I11a)", () => {
  let checked = 0, positives = 0;
  for (const [g, globs] of Object.entries(STRYKER_GROUPS)) {
    const pos = globs.filter((x) => !x.startsWith("!"));
    const files = expand(globs);
    for (const p of pos) expect(globSync([p], { cwd: ENGINE }).length, `${g}: ${p} matches no file`).toBeGreaterThan(0);   // EACH positive entry, not the group's total (review 4, R4-m5)
    checked += files.length; positives += pos.length;
    expect(files.filter((f) => /\.test\.ts$|__tests__/.test(f)), g).toEqual([]);
  }
  // the bound comes from the groups themselves, not a typed number
  expect(positives).toBeGreaterThan(Object.keys(STRYKER_GROUPS).length);
  expect(checked).toBeGreaterThanOrEqual(positives);
  expect(Object.keys(STRYKER_GROUPS).length).toBeGreaterThan(1);
});
// GB = 1024 ** 3, as vitest.config.ts:42. Each expected value is hand-derived from vitest.config.ts:43-46,
// bound = max(2, min(cores − 1, floor(mem / 3 GiB))), then divided by the vitest workers ONE sandbox runs
// (Step 0 pins W = STRYKER_VITEST_WORKERS from the runner's own override; review 2, R2-I4).
it("concurrency = vitest's own bound ÷ the workers one sandbox runs, from the formula's inputs (review I11b, R2-I4)", () => {
  // 4 cores, 16 GiB: bound = max(2, min(3, 5)) = 3
  expect(strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: 1 })).toBe(3);
  expect(strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: 3 })).toBe(1);   // 3 ÷ 3
  // 16 cores, 8 GiB: bound = max(2, min(15, 2)) = 2 (memory-bound)
  expect(strykerConcurrency({ cores: 16, memBytes: 8 * GB, workersPerSandbox: 1 })).toBe(2);
  // 16 cores, 64 GiB: bound = max(2, min(15, 21)) = 15; ÷ 2 = 7
  expect(strykerConcurrency({ cores: 16, memBytes: 64 * GB, workersPerSandbox: 2 })).toBe(7);
  // never below one sandbox, however many workers each runs
  expect(strykerConcurrency({ cores: 2, memBytes: 4 * GB, workersPerSandbox: 4 })).toBe(1);
});
it("vitest.config.ts's bound is still the formula this copy was taken from (a moved formula reds here, not in an OOM)", () => {
  const cfg = readFileSync(join(ENGINE, "vitest.config.ts"), "utf8");
  expect(cfg).toContain("Math.min(availableParallelism() - 1, Math.floor(totalmem() / (3 * GB)))");
  expect(cfg).toMatch(/Math\.max\(\s*2,/);
});

// stryker-floor.test.ts
it("zero mutants is a refusal (vacuous), never a pass", () => expect(check("draws", report({ killed: 0, survived: 0 }), floors({ draws: 50 }))).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") }));
it("a score below the floor fails and lists survivors; at the floor passes", () => {
  expect(check("draws", report({ killed: 49, survived: 51 }), floors({ draws: 50 })).exit).toBe(1);
  expect(check("draws", report({ killed: 50, survived: 50 }), floors({ draws: 50 })).exit).toBe(0);
});
it("an equivalent mutant listed by file:line:col and mutator is excluded from the denominator", () => { /* 49 killed, 50 survived, 1 equivalent → 49/99 → still < 50 → exit 1; with 2 equivalents listed → 49/98 = 50.0 → 0 */ });
it("the floor never falls: --check-file-against flags a lowered or removed group", () => {
  expect(floorDiff({ draws: 50, competition: 40 }, { draws: 49.9, competition: 40 })).toEqual([{ group: "draws", was: 50, now: 49.9 }]);
  expect(floorDiff({ draws: 50 }, {})).toEqual([{ group: "draws", was: 50, now: null }]);
  expect(floorDiff({}, { draws: 50 })).toEqual([]);   // a new group may be added
});
it("no floor for a group is a refusal until PR-B sets one", () => expect(check("draws", report({ killed: 1, survived: 0 }), floors({})).exit).toBe(2));
```

The `mutation.json` fixture uses Stryker's mutation-testing-elements schema (`files[path].mutants[].status`). Step 0 records the schema version Stryker 10 writes; the fixture matches it. Score = killed + timeout ÷ (all − ignored − equivalents − NoCoverage?) — **Step 0 decides**, from Stryker's own "mutation score" definition (covered vs total). Use Stryker's TOTAL score (NoCoverage counts as surviving) and say so in the floor file's note: an uncovered line is a survivor.

- [ ] **Step 2: See them fail. Step 3: Implement.**

`stryker.config.mjs`:

```js
// Design §7.5 item 2 (W1d D14; rulings 66, 67): weekly mutation testing of the
// engine, placement scheduling excepted. One group per CI job (STRYKER_GROUP);
// incremental across weeks via the cached incremental file.
import { availableParallelism, totalmem } from "node:os";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "./stryker.groups.mjs";
const group = process.env.STRYKER_GROUP;
if (!group || !(group in STRYKER_GROUPS)) throw new Error(`STRYKER_GROUP must be one of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: STRYKER_GROUPS[group],
  coverageAnalysis: "perTest",
  incremental: true,
  incrementalFile: `reports/mutation/${group}.incremental.json`,
  reporters: ["json", "clear-text", "progress"],
  jsonReporter: { fileName: `reports/mutation/${group}.json` },
  thresholds: { high: 80, low: 60, break: null },   // the floor file, not Stryker's break, gates (D14)
  timeoutMS: 60000,
  // Each Stryker sandbox runs the engine's vitest, z3-WASM files included. Total vitest workers across
  // sandboxes stay within vitest.config.ts:43-46's own bound; a fixed 4 would OOM a 16 GB runner (I11b, R2-I4).
  concurrency: strykerConcurrency({ cores: availableParallelism(), memBytes: totalmem(), workersPerSandbox: STRYKER_VITEST_WORKERS }),
  tempDirName: ".stryker-tmp",
};
```

`stryker.groups.mjs` also exports two things:
- `strykerConcurrency({ cores, memBytes, workersPerSandbox }) = Math.max(1, Math.floor(bound / workersPerSandbox))`, where `bound = Math.max(2, Math.min(cores - 1, Math.floor(memBytes / (3 * GB))))` is a copy of `vitest.config.ts:43-46`'s formula. The quantity is TOTAL vitest workers, not sandboxes, so it stays within the bound the engine's own suite was sized for.
- `STRYKER_VITEST_WORKERS`: the vitest workers one Stryker sandbox runs. Step 0 reads it from the vitest runner's config override (its docs, and `node_modules/@stryker-mutator/vitest-runner/dist/**`), and the comment cites the line. If the runner forces one worker per sandbox it is 1, and concurrency equals vitest's bound (3 on a 4-core, 16 GiB `ubuntu-latest`). If it does not, set it to vitest's own `maxWorkers` for that machine, and say so.

The tests pin the function against machines whose expected values are worked from the formula's INPUTS in comments, never typed from the function's output. A second test pins `vitest.config.ts`'s formula text, so a change there reds this copy rather than an OOM on a Sunday. A comment in each file names the other.

`stryker-floor.ts` follows the interfaces above, with a D8 exit header.

**The `ci.yml` floor gate (review 7, R7-I1).** Add the step to `gates`, appended AFTER the last step Tasks 1 and 10 added (the lock-check step, then the tools-tests type-check step if Task 10 has landed), never directly after `reference:boundary` (Task 1's test pins that the lock step is the line after it). `gates` already has `fetch-depth: 0`, so `HEAD^1` resolves:

```yaml
      # D14 (W1d): a Stryker floor never falls. HEAD^1 as for the lock gate. Absent at HEAD^1
      # (PR-A's own first run) means "no floors yet": the CLI exits 0 for it.
      - run: pnpm --filter @seazn/engine mutation:floor --check-file-against HEAD^1
```

In `ci-wiring.test.ts`, in the line style of Task 10's type-check case (same `lines`/`isComment`/`jobAt` helpers):

```ts
it("the Stryker floor gate runs in the gates job, exactly once, and nothing can make it conditional or advisory (W1d D14)", () => {
  const STEP = "      - run: pnpm --filter @seazn/engine mutation:floor --check-file-against HEAD^1";
  const at = lines.indexOf(STEP);
  expect(at).toBeGreaterThan(0);
  expect(lines.filter((l) => l.includes("mutation:floor") && !isComment(l))).toEqual([STEP]);
  expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);   // no key beneath it (`if:`, `continue-on-error:`, `env:`)
  expect(jobAt(at)).toBe("  gates:");
});
```

`packages/engine/test/stryker-floor.test.ts` also tests the CLI's empty cases by spawning it in a temp git repo (a repo with one commit, a `packages/engine/stryker-floor.json` copy, `cwd` set so the CLI finds it):
- the file absent at the ref, a working file of `{"groups": {}}` or with floors: exit 0, output names "no floors";
- the file present at the ref and LOWER in the working file: exit 1; equal or higher: exit 0;
- the working file deleted while the ref has it: exit 2; the working file deleted while the ref lacks it: exit 2 too;
- a nonexistent ref: exit 2; malformed JSON at the ref: exit 2.
Each case counts that the CLI actually compared (the diff list's length is printed), so a CLI that exits 0 without reading fails the "lower" case.

`mutation.yml` (ruling 68: every job `runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}`; top-level `permissions: contents: read`; `plan` `timeout-minutes: 15`):
- triggers: `schedule: - cron: "23 3 * * 0"`, `workflow_dispatch` (input `group`: `all` or one `STRYKER_GROUPS` key, `probe` included, the choices derived from the file and held equal by a test; `inject_visibility` as in matrix-truth), and `pull_request` paths `.github/workflows/mutation.yml`, `packages/engine/stryker*`, `packages/engine/scripts/stryker-*`.
- jobs `plan` and `mutate`. `plan` has the guard, the gate `if: github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true'` (the matrix-truth form, so a PR run and a dispatch run while the schedule is disabled, which is PR-A's whole state), and one matrix derivation, `node packages/engine/scripts/stryker-matrix.mjs --event "$EVENT" --group "$GROUP"`, which prints `matrix={"include":[{"group":…,"timeout":…}]}`:
  - `pull_request` gives `probe` only;
  - `workflow_dispatch` with `all` gives every key except `probe`; with any other key gives that key alone, `probe` included;
  - `schedule` gives every key except `probe`;
  - `timeout` comes from `packages/engine/stryker-timeouts.json` (minutes per group, ≤ 300, written by Step 4 from the dry run and replaced by Task 20 from measurement). A key with no timeout is a refusal, and so is an empty matrix.
- `mutate` runs per matrix entry, with `timeout-minutes: ${{ matrix.timeout }}`:
  - the guard, checkout, pnpm, node and install;
  - `actions/cache` for `packages/engine/reports/mutation/<group>.incremental.json`, keyed `stryker-<group>-${{ github.sha }}` with restore-keys `stryker-<group>-`;
  - `cd packages/engine && STRYKER_GROUP=<g> pnpm mutation`, writing `EXIT=$?` itself;
  - `pnpm mutation:floor --check <g> reports/mutation/<g>.json`. It is skipped for `probe`, and for the other groups only while `stryker-floor.json`'s `groups` is empty (PR-A's state: it prints "no floor yet: PR-B sets it"). Once PR-B commits a floor, a group with no entry is exit 2, a failure (review 4, R4-m3);
  - `--survivors` → `SURVIVORS.md`;
  - upload the `mutation-<group>` artifact (json, SURVIVORS.md).
- `mutate` has `strategy: fail-fast: false` with `matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`, so one group's timeout or red dry run never cancels the others (Task 20 expects a timeout and still needs the other groups' wall times). The `Survivors` and `Upload mutation results` steps carry `if: always()`, so a non-zero Stryker exit still saves what the group produced (review 5, R5-I1).
- Timeout cap: ONE value, 300 minutes, everywhere (D14, Step 4, Task 20). A group whose estimate or measurement exceeds 200 is split before its timeout (× 1.5) would pass 300.

The skeleton (the guard's body is `matrix-truth.yml`'s, copied; `…` marks what the prose above already fixes):

```yaml
name: Stryker mutation
# W1d (rulings 66, 67, 68). One job per STRYKER_GROUPS key; a PR runs the probe only (D3).
on:
  schedule:
    - cron: "23 3 * * 0"        # GATED by vars.MATRIX_WEEKLY_ENABLED (plan's if:)
  workflow_dispatch:
    inputs:
      group:
        type: choice
        default: all
        options:
          - all
          - competition
          # … one line per STRYKER_GROUPS key, in the order stryker.groups.mjs declares them, probe included (the choices test is order-sensitive)
      inject_visibility:
        type: choice
        default: none
        options: [none, private, internal]
  pull_request:
    paths:
      - ".github/workflows/mutation.yml"
      - "packages/engine/stryker*"
      - "packages/engine/scripts/stryker-*"
permissions:
  contents: read
jobs:
  plan:
    name: Plan the groups
    if: github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true'
    runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 15
    outputs:
      matrix: ${{ steps.matrix.outputs.matrix }}
    steps:
      - name: Visibility guard (design §6.4; R14a)
        env:
          GH_TOKEN: ${{ github.token }}
          INJECT: ${{ inputs.inject_visibility || 'none' }}
          RUNNER_ENV: ${{ runner.environment }}
        run: |
          # … identical to matrix-truth.yml's …
      - uses: actions/checkout@v5
      - name: Derive the matrix
        id: matrix
        env:
          EVENT: ${{ github.event_name }}
          GROUP: ${{ inputs.group }}
        run: node packages/engine/scripts/stryker-matrix.mjs --event "$EVENT" --group "$GROUP" >> "$GITHUB_OUTPUT"

  mutate:
    name: mutate ${{ matrix.group }}
    needs: [plan]
    runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: ${{ matrix.timeout }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}
    env:
      GROUP: ${{ matrix.group }}   # job level: every step below reads $GROUP (step env does not carry over)
    steps:
      - name: Visibility guard (design §6.4; R14a)
        # … the same env block and script …
      - uses: actions/checkout@v5
      # … pnpm/action-setup, setup-node 26, pnpm install --frozen-lockfile, actions/cache (see above) …
      - name: Run Stryker
        run: |
          set +e
          cd packages/engine && STRYKER_GROUP="$GROUP" pnpm mutation
          code=$?; echo "EXIT=$code"; echo "$code" > reports/mutation/exit.txt; exit "$code"
      - name: Floor check
        # … skipped for probe, and while stryker-floor.json's groups is empty …
      - name: Survivors
        if: always()   # deliberate: save evidence after a non-zero Stryker exit (a manual cancel also runs it; accepted)
        # … node --experimental-strip-types scripts/stryker-floor.ts --survivors "$GROUP" reports/mutation/$GROUP.json --out SURVIVORS.md (run in packages/engine) …
      - name: Upload mutation results
        if: always()   # deliberate, as above
        uses: actions/upload-artifact@v4
        with:
          name: mutation-${{ matrix.group }}
          path: |
            packages/engine/reports/mutation/${{ matrix.group }}.json
            packages/engine/SURVIVORS.md
```

The guard step is the SAME script as `matrix-truth.yml`.

Append these to `tools/matrix/__tests__/matrix-workflow.test.ts` (they read `mutation.yml` and `stryker.groups.mjs`, which this task creates, so they cannot live in Task 9: a read in a `describe` body fails the whole file at collection). The file imports `STRYKER_GROUPS` from `../../../packages/engine/stryker.groups.mjs` (typed by its `.d.mts`):

```ts
describe("both workflows run on the switchable runner (ruling 68, D24)", () => {
  const WF = readFileSync(".github/workflows/matrix-truth.yml", "utf8");
  it("every job of matrix-truth.yml AND mutation.yml runs on the switchable runner (ruling 68, D24), and has a timeout-minutes", () => {
    for (const [file, text] of [["matrix-truth.yml", WF], ["mutation.yml", readFileSync(".github/workflows/mutation.yml", "utf8")]] as const) {
      const jobs = Object.entries(jobsOf(text));
      expect(jobs.length, file).toBeGreaterThan(1);   // anti-vacuity
      for (const [name, t] of jobs) {
        expect(t, `${file}:${name} runs-on`).toContain("runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}");
        expect(t, `${file}:${name} timeout-minutes`).toMatch(/timeout-minutes:/);
      }
    }
  });
});

describe("mutation.yml and the runner wiring (review 5: R5-I1, m2, m3; moved here by review 6, R6-I1)", () => {
  const JOBS = jobsOf(readFileSync(".github/workflows/matrix-truth.yml", "utf8"));
  const GUARD = "Visibility guard (design §6.4; R14a)";
  const MUT = readFileSync(".github/workflows/mutation.yml", "utf8");
  const MJOBS = jobsOf(MUT);
  it("every guard step of BOTH workflows takes RUNNER_ENV from runner.environment, never a literal (the one line that decides whether private hosted minutes can be billed)", () => {
    const all = [...Object.values(JOBS), ...Object.values(MJOBS)];
    expect(all.length).toBeGreaterThan(4);   // anti-vacuity: matrix-truth's four plus mutation's
    for (const t of all) expect(stepOf(t, GUARD).body).toContain("RUNNER_ENV: ${{ runner.environment }}");
  });
  it("the mutate job does not cancel its siblings, takes its timeout from the matrix, and saves its evidence even when Stryker exits non-zero (R5-I1)", () => {
    expect(MJOBS.mutate).toContain("matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(MJOBS.mutate).toContain("fail-fast: false");
    expect(MJOBS.mutate).toContain("timeout-minutes: ${{ matrix.timeout }}");
    for (const n of ["Survivors", "Upload mutation results"]) expect(stepOf(MJOBS.mutate, n).body).toContain("if: always()");
  });
  it("the dispatch `group` choices are `all` plus exactly STRYKER_GROUPS's keys, in declaration order (m2)", () => {
    // a trailing `# comment` on an option line is stripped (review 6, m4)
    const opts = /group:[\s\S]*?options:\n((?:\s+- .+\n)+)/.exec(MUT)![1].split("\n").map((l) => l.replace(/\s+#.*$/, "").replace(/^\s+- /, "").trim()).filter(Boolean);
    expect(opts).toEqual(["all", ...Object.keys(STRYKER_GROUPS)]);
    expect(opts.length).toBeGreaterThan(2);
  });
  it("mutation.yml's guard is the first step of every job, with matrix-truth's script (the identical-script claim for the second workflow)", () => {
    const want = stepOf(JOBS.plan, GUARD).script;
    expect(want).not.toBeNull();
    expect(Object.keys(MJOBS).length).toBeGreaterThan(1);
    for (const [name, t] of Object.entries(MJOBS)) {
      expect(stepHeads(t)[0], name).toBe(`      - name: ${GUARD}`);
      expect(stepOf(t, GUARD).script, name).toBe(want);
    }
  });
});
```

Their mutation rows are in Step 5's table.

`matrix-workflow.test.ts` gains the identical-guard test above. A new `packages/engine/test/stryker-matrix.test.ts` SPAWNS `stryker-matrix.mjs` per event and compares with `STRYKER_GROUPS` and `stryker-timeouts.json`: `pull_request` gives exactly `["probe"]`; `schedule` and dispatch `all` give every non-probe key (more than one); dispatch `probe` gives `["probe"]`; an unknown key such as `nosuch` is exit 2; every entry has a timeout in (0, 300]. Mutation rows: change the `pull_request` branch to `all`; ignore `--group`; drop the timeout lookup. Add `stryker-matrix.mjs` and `stryker-timeouts.json` to Task 15's Create list. The new `describe("mutation.yml and the runner wiring")` in `matrix-workflow.test.ts` imports `STRYKER_GROUPS` from `packages/engine/stryker.groups.mjs` (through its `.d.mts`) and pins the `RUNNER_ENV` line, `fail-fast: false`, `if: always()` and the dispatch choices.

- [ ] **Step 4: Dry-run every group, run the probe, and the tests**

Group sizes come from MEASURED data, not from line counts (owner, 2026-10-04). First the dry run, which instruments each group and runs the suite once, giving the mutant count and the dry-run time:

```bash
cd <exec>/packages/engine && for g in $(node -e 'import("./stryker.groups.mjs").then((m) => console.log(Object.keys(m.STRYKER_GROUPS).join(" ")))'); do ( time STRYKER_GROUP=$g pnpm mutation --dryRunOnly > "$TMPDIR/w1d-t15-dry-$g.log" 2>&1; echo "$g EXIT=$?" ) 2>&1 | tail -4; done
```

Record, per group, the mutant count Stryker reports and the dry-run wall time. Check the groups:
- a group whose count is zero is a configuration fault (fix the globs);
- compute `est = ceil((max(dryRunSeconds, 344) + mutants × 10 ÷ 3) / 60)` minutes per group (D14's formula: the pessimistic 10 s per mutant, concurrency 3 and the 344 s CI dry run as a floor, so a faster local machine cannot under-estimate; the dry-run time may instead be read from a CI run). The timeouts are calibrated on the 4-vCPU hosted runner and must be re-derived when `MATRIX_RUNNER` changes (handoff). ANY group with `est > 200` is split by file in this step, before PR-A merges, and the report says which and why (the count, never a line count). Then write `stryker-timeouts.json` with `min(300, ceil(est × 1.5))` per group, the probe's from its real run;
- the table (group, mutants, dry-run time) goes in the task report and the PR body. It is the evidence Task 20's first full run is compared against.

Then the probe, which is small, runs for real:

```bash
cd <exec>/packages/engine && STRYKER_GROUP=probe pnpm mutation > "$TMPDIR/w1d-t15-probe.log" 2>&1; echo EXIT=$?; tail -30 "$TMPDIR/w1d-t15-probe.log"
cd <exec>/packages/engine && node --experimental-strip-types scripts/stryker-floor.ts --survivors probe reports/mutation/probe.json --out "$TMPDIR/w1d-probe-SURVIVORS.md"; echo EXIT=$?
```

Expected: Stryker completes, with a non-zero mutant count and a score. Record the mutants, the score and the wall time: the probe's mutants-per-second is the first measured rate, and Task 20's per-group estimate is checked against it.

Run the engine tests: `cd <exec>/packages/engine && ./node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1d-t15.json" test/stryker-groups.test.ts test/stryker-floor.test.ts test/stryker-matrix.test.ts test/runtime-deps.test.ts; echo EXIT=$?` (judged by the template; `.testResults[].name` lists exactly these 4 files). Then, from the root, the vitest template on `tools/matrix/__tests__/matrix-workflow.test.ts` (Task 9's file, now holding the mutation.yml block), judged the same way. `runtime-deps` must stay green: devDependencies only.

- [ ] **Step 5: Mutate**

| Mutant | Killing test |
|---|---|
| `check` treating zero mutants as 100% | its test |
| Delete the `mutation:floor` step from `gates`, or add `continue-on-error: true` under it | the `ci-wiring` case "the Stryker floor gate runs in the gates job, exactly once…" |
| Treat a file absent at the ref as exit 2 | the CLI case "absent at the ref" (PR-A's own run would go red) |
| Treat a working file that is absent as exit 0 | the CLI case "working file deleted" (fail-open after PR-B) |
| `RUNNER_ENV: self-hosted` literal in one job's guard env | "every guard step of BOTH workflows takes RUNNER_ENV from runner.environment" |
| Delete `fail-fast: false` from `mutate` | "the mutate job does not cancel its siblings" (R5-I1) |
| Delete `if: always()` from `Survivors` or the upload step | the same test |
| One `mutation.yml` job back to `runs-on: ubuntu-latest` | "every job of matrix-truth.yml AND mutation.yml runs on the switchable runner" |
| Add a group to `stryker.groups.mjs` only | "the dispatch `group` choices are `all` plus exactly STRYKER_GROUPS's keys" |
| Change one `mutation.yml` guard line | "mutation.yml's guard is the first step of every job, with matrix-truth's script" |
| `floorDiff` ignoring removed groups | its test |
| Put `roundrobin.ts` in two real groups (not the probe) | the sweep's `doubled` list |
| Delete the `src/testkit/**` exclusion | the sweep: `unclassified` lists the testkit files, with the count |
| Delete one `STRYKER_PLACEMENT_OUT_OF_SCOPE` key | the sweep: that file is unclassified; `placement` no longer equals the key count |
| `stryker-matrix.mjs`: the `pull_request` branch returns `all` | `stryker-matrix.test.ts` (a PR must give exactly `["probe"]`) |
| `stryker-matrix.mjs` ignores `--group` | the same test (dispatch of one key) |
| `stryker-matrix.mjs` drops the timeout lookup | the same test (every entry has a timeout in (0, 300]) |
| Add a stale exclusion key (a renamed file) | "every exclusion … globs at least one file" |
| Point the probe at `rest-floor.ts` | "the probe is one exact file with a co-located test" |
| Drop `!src/competition/**/*.test.ts` | "no group's mutate list reaches a test file" (it goes red only because `expand` filters the result; the `exclude` form could never have gone green) |
| `strykerConcurrency` returning `cores - 1` | "concurrency = vitest's own bound ÷ …" (16 cores, 8 GiB → 2, not 15) |
| `strykerConcurrency` ignoring `workersPerSandbox` | the same test's `÷ 3` and `÷ 2` rows |

- [ ] **Step 6: Commit**

Commit `feat(engine): Stryker weekly on the engine minus placement scheduling, floor that only rises (W1d D14; rulings 66, 67; design §7.5)`. The lockfile diff is reviewed in the task report: only the two packages and their transitive dependencies.

---

### Task 16: PR-A close — smoke, review, `_INDEX`, open the PR (merge gate)

- [ ] **Step 1: Coverage check of the 28 items**

Read `_INDEX.md` "W1d first tasks" 1–28 against the batching table at the top of PR-A. Every item maps to a commit, or to a recorded "no code; accepted" (13). Write the map into the PR body.

- [ ] **Step 2: Smoke: the HTTP slice is unchanged**

On the local env, with a fresh DB and run id:

```bash
cd <exec> && pnpm matrix:l3 --run-id w1d-smoke-slice --report-dir "$TMPDIR/w1d-runs"; echo EXIT=$?
node -e 'const a=require(process.argv[1]),b=require(process.argv[2]);const m=new Map(b.cases.map(c=>[c.caseId,c.state]));const d=a.cases.filter(c=>m.get(c.caseId)!==c.state).map(c=>[c.caseId,m.get(c.caseId),c.state]);console.log(JSON.stringify({compared:a.cases.length,differ:d}))' "$TMPDIR/w1d-runs/w1d-smoke-slice/results.json" docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-http-slice/results.json
```

Expected: `compared` equals the slice size (24), and `differ: []`. A difference is either a real behaviour change from this branch (a STOP) or a product change on `main` since that run (record it and its cause). Then run the sharded form of the same: `--shard 1/2` and `--shard 2/2` under two run ids, `pnpm matrix:merge` them, and diff the merged file against the unsharded run. The states must be identical. That is Task 4's property, on a live run.

- [ ] **Step 3: `_INDEX.md`**

- **W1d status row:** "PR-A open: infra (Tasks 1–16); PR-B after the owner merges".
- **False premises:** add "### Found during W1d planning" with every false premise listed above (23 at last count), plus any found while executing.
- **Recommendations:** the bench carry (D9); D11's recommendation (decline browser workers in favour of shards, items 17 and 18), for the owner; D2's enable step, as the owner's action. D7 needs nothing here: ruling 65 is already recorded (`_INDEX.md:919`).
- **Close "W1d first tasks":** each item gets `— done in W1d T<N> (<sha>)`, or `— accepted (item 13)`.

- [ ] **Step 4: Scoped gate, reviewer, push, PR**

1. Run the vitest template over EVERY test file this PR touched (the union from Tasks 1–15), plus the engine's four Task 15 files (`stryker-groups`, `stryker-floor`, `stryker-matrix`, `runtime-deps`). Paste the counts.
2. Run eslint on every changed `.ts`/`.mjs` through `rtk proxy`, and tsc on `tsconfig.tools-tests.json`.
3. Dispatch the `reviewer` agent on `git diff origin/main...HEAD` with `model: "opus"` (the whole-branch review; Execution model policy), at most 25 findings. Fix every Critical and Important finding inline (the no-new-issues rule), then re-review the fixes.
4. Push `feat/format-matrix-w1d-infra` and open the PR. The body carries the 28-item map, the D-list, D11's recommendation, the line "the merge job judges with `--planned-not-run allow` per owner ruling 65", and "Merge gate: the owner merges PR-A (ruling 62); PR-B is cut from main after." It does NOT yet carry `Matrix rows: none — harness infrastructure; engine change is Stryker config only`. Step 5 opens without it on purpose, to see the R27 gate red once, and then adds it. The PR is not ready for review until that line is in the body and `matrix-rows` is green (review 2, R2-m2).

- [ ] **Step 5: Watch the self-proof (D3)**

The PR fires `matrix-truth.yml` (smoke) and `mutation.yml` (probe) through their own `pull_request` paths. Before believing either:
- read each job's steps: steps > 0, not cancelled, not billing-shaped;
- read the merged `SUMMARY.md` artifact: three layers, 2 shards each, a harness verdict;
- confirm `merged/L3/results.json` holds 33 cases.

Then the per-PR sample: this PR touches `tools/matrix/**`, so `ci.yml`'s `matrix-sample` runs. It also touches `packages/engine/**` (Task 15's config, devDependencies and script), a declaring path, so PR-A's body must carry `Matrix rows: none — harness infrastructure; engine change is Stryker config only`, or the R27 gate reds by design. That red is the gate's first live witness: open the PR WITHOUT the line, see `matrix-rows` red naming `packages/engine/package.json`, then add the line to the body and RE-RUN the failed job. The job reads the body live (D13, review 3 R3-m1), so the re-run sees the edit, where an event-payload read would replay the old body and stay red. See it green, and record both run ids. A new commit would also work but is not needed.

**Merge gate: STOP here. The owner reviews and merges PR-A.**

---
## PR-B — evidence (Tasks 17–22). Starts only after the owner merges PR-A.

Every PR-B step that touches GitHub reads its result before believing it. The traps, from memory and the W1d prompt:
- **A dispatched run executes the workflow file at the dispatched REF.** `--ref main` runs main's copy, so PR-B can only dispatch what PR-A merged.
- **A run whose jobs are all red with 0 steps in ~3 s is billing**, not the harness.
- **A job with zero steps never got a runner.**
- **`cancelled` is not a pass.**
- **A run's `headSha` is the dispatch ref's SHA**, so check it equals the tag's SHA.

### Task 17: Three harness-green dispatches, and the guard proven live (ruling 61, 62; D7, D21; Review Focus 2, 3)

**Files:**
- `_INDEX.md` (the W1d status row; a "W1d dispatches" block under the programme log)
- `$TMPDIR/w1d-dispatch/<n>/` (downloaded artifacts; not committed until Task 21)

- [ ] **Step 0: Worktree and the tag**

```bash
cd /Users/ashokhein/github/seazn.club && git fetch origin && git worktree add -b feat/format-matrix-w1d-evidence .claude/worktrees/format-matrix-w1d-evidence origin/main; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-evidence && pnpm install --frozen-lockfile; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1d-evidence && git log -1 --format='%H %s' && test -f .github/workflows/matrix-truth.yml && echo PR-A-merged
```

Every judge call below uses `--planned-not-run allow`: owner ruling 65 (2026-10-04, `_INDEX.md:919`) says "no ░" applies to driven cases only. Nothing is asked of the owner here.

D21: tag the tip and push the tag:

```bash
cd <evidence> && git tag matrix-truth/w1d-baseline origin/main && git push origin matrix-truth/w1d-baseline; echo EXIT=$?
cd <evidence> && git rev-parse matrix-truth/w1d-baseline
```

Record the SHA. A tag push runs no workflow (D21), and the executor confirms that in the Actions tab via `gh run list -L 5 --json event,headBranch,createdAt`: there must be no run whose `headBranch` is the tag.

- [ ] **Step 1: The guard, live (the mutation PR-A could only unit-test)**

**Precondition (review 5, R5-m4; D24).** The injected-`private` proof only means something on a GitHub-hosted runner, because a self-hosted runner returns from the guard before it reads the input. Check first:

```bash
cd <evidence> && gh variable list --json name,value --jq '.[] | select(.name == "MATRIX_RUNNER")'
```

This lists REPO-level variables only; `vars.MATRIX_RUNNER` also resolves organisation and environment variables, so this check is the quick one and the LOG check after the dispatch is the authority. List the other two scopes as well (`gh variable list --org <org>`, `gh variable list --env <env>`), or rely on the log check. The repo-level list must print nothing. If it prints a value, STOP with the reason "`MATRIX_RUNNER` is set, so this dispatch would run self-hosted and the injection proof is void" (not a red): unset it, or record that the proof was run with it unset. After the dispatch, the plan job's log must also not contain `self-hosted runner:`.

```bash
cd <evidence> && gh workflow run matrix-truth.yml --ref matrix-truth/w1d-baseline -f scope=full -f inject_visibility=private; echo EXIT=$?   # scope is a one-option choice (full): a smoke dispatch would count as the weekly run (T9); the run dies at the guard before any shard starts
cd <evidence> && gh run list --workflow matrix-truth.yml --event workflow_dispatch -L 1 --json databaseId,headSha,status,conclusion
cd <evidence> && gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion, steps: [.steps[] | {name, conclusion}]}'
```

Expected:
- `plan` is `failure` at the step "Visibility guard (design §6.4; R14a)";
- `build`, `shard` and `merge` are `skipped`;
- the log shows `pretending the repository is private` and the `::error title=Matrix truth run refused::` line;
- `headSha` equals the tag's SHA.

Record the run id. If `plan` SUCCEEDED and the log does NOT show `self-hosted runner:`, the guard is open: STOP, with a PR-A defect. If it SUCCEEDED and the log DOES show `self-hosted runner:`, the precondition failed (an org- or environment-level `MATRIX_RUNNER`), which is not a defect: unset it and re-dispatch.

- [ ] **Step 2: Dispatch 1 of 3 (full)**

```bash
cd <evidence> && gh workflow run matrix-truth.yml --ref matrix-truth/w1d-baseline -f scope=full; echo EXIT=$?
cd <evidence> && gh run list --workflow matrix-truth.yml --event workflow_dispatch -L 1 --json databaseId,headSha,status
```

Wait for it with the Monitor tool, using an until-loop on `gh run view <id> --json status --jq .status` = `completed`. Never use a foreground sleep.

Then check the run:
- `gh run view <id> --json conclusion,jobs`: 15 jobs (plan, build, 12 shards, merge), each with > 0 steps;
- none `cancelled`;
- no shard at its `timeout-minutes` (a timeout shows as `cancelled` with "exceeded the maximum execution time"; class 20: a timeout is the clock, not data).

```bash
cd <evidence> && rm -rf "$TMPDIR/w1d-dispatch/1" && gh run download <id> -n merged -D "$TMPDIR/w1d-dispatch/1"; echo EXIT=$?
cd <evidence> && for l in L1 L2 L3; do pnpm matrix:judge faults "$TMPDIR/w1d-dispatch/1/$l/results.json" --planned-not-run allow; echo "$l EXIT=$?"; done
```

Expected per layer: `EXIT=0`. Then confirm the case counts against ruling 64:

```bash
cd <evidence> && node -e 'for (const l of ["L1","L2","L3"]) { const r=require(process.argv[1]+"/"+l+"/results.json"); const h={}; for (const c of r.cases) h[c.state]=(h[c.state]??0)+1; console.log(l, r.cases.length, r.shards, JSON.stringify(h)); }' "$TMPDIR/w1d-dispatch/1"
```

Expected: L1 231, L2 1731, L3 937 (the current plans' sizes; Task 3 Step 4 and the `w1-driving` set pin them).

- [ ] **Step 3: Dispatches 2 and 3, sequentially**

The workflow's concurrency group for a dispatch is `matrix-truth-workflow_dispatch-full-refs/tags/…` and does not cancel, but GitHub keeps only ONE pending run per group. A third dispatch queued behind a running and a pending one replaces the pending one. So dispatch 2 only after 1 completes, and 3 after 2. Each gets the Step 2 checks, downloaded to `$TMPDIR/w1d-dispatch/<n>`.

- [ ] **Step 4: The verdict (ruling 61)**

```bash
cd <evidence> && for l in L1 L2 L3; do pnpm matrix:judge across "$TMPDIR/w1d-dispatch/1/$l/results.json" "$TMPDIR/w1d-dispatch/2/$l/results.json" "$TMPDIR/w1d-dispatch/3/$l/results.json" --planned-not-run allow | tee "$TMPDIR/w1d-dispatch/across-$l.txt"; echo "$l EXIT=$?"; done
```

**Harness-green = all three `EXIT=0`.** The output's `compared` must equal each layer's case count.

- [ ] **Step 5: If not green**

- **A harness fault** (D6) means a harness defect. Fix it on a branch, through the reviewer, and get it merged by the owner (ruling 62's merge gate applies to every `main` change). Then move the tag, record the old and new SHA, and **restart from dispatch 1**. "Three consecutive" means three on one SHA (D21).
- **A missing shard or a merge refusal:** read the shard job's log. An environment fault (a runner died, a docker pull rate-limit) is re-dispatched, and the count restarts.
- **A state differing for a PRODUCT reason** (Review Focus 3, e.g. the W7 mexicano UUID tie-break) **stays red per ruling 61.** Write the differing cases, their three states and their reasons into `_INDEX.md`, and ask the owner in chat. Never classify it away, average it, or re-run until it agrees. Rule each owner reply into `_INDEX.md`.

Record every dispatch in `_INDEX.md` as it happens (R22): run id, SHA, conclusion, per-layer histogram, wall clock, and verdict.

- [ ] **Step 6: Record the scheduled-run payload question (false premise 17)**

Nothing fires on a schedule yet (the variable is unset). Record in `_INDEX.md` that Task 22 Step 3 reads the first scheduled run's event payload.

---

### Task 18: The triage tooling (ruling 63; D18, D22)

**Why:** Ruling 63 asks for every ❌ to carry an audit gap ID (or `NEW-W1d-<n>`) and its §8 wave, and for W1-driving's 164 to be re-keyed. By hand that is ~200 rows that drift. Two DB-free tools make it a committed, re-checkable mapping.

**Files:**
- Create:
  - `tools/matrix/lib/audit-ledger.ts`, `tools/matrix/audit-ledger.ts`;
  - `tools/matrix/lib/triage.ts`, `tools/matrix/triage.ts`;
  - `tools/matrix/catalogue/gap-routing.json`;
  - `tools/matrix/catalogue/triage-rules.json`;
  - `tools/matrix/catalogue/audit-verdicts.json`;
  - `tools/matrix/catalogue/new-gaps.json`.
- Test: `tools/matrix/__tests__/audit-ledger.test.ts`, `tools/matrix/__tests__/triage.test.ts`
- Modify: `package.json` (`matrix:triage`, `matrix:ledger`)

**Interfaces:**
- `readAuditGaps(dir: string): { id: string; file: string; title: string; severity: string }[]`. It parses each `<PREFIX>-*.md` file's `## Gaps` table(s); the ID column holds the bare id (`H1`), and the prefix comes from the file name (`SW-swiss.md` → `SW-H1`). It throws `AuditParse` on a row without an id, or on a duplicate id.
- `gap-routing.json`: `{ "note": "design §8 (D:446-460), transcribed; a reviewed change", "routes": { "SC-O1": "W2", … , "SW-*": "W3", "SH-*": "W8" } }`. Exact ids win over a `<PREFIX>-*` wildcard.
- `triage-rules.json`: `{ "rules": [{ "id": "T-1", "match": { "cell"?: "<glob over row|sport>", "scenario"?: "M1", "layer"?: "L3", "check"?: "<check id>", "reason"?: "<substring>" }, "gap": "SC-O1" | "NEW-W1d-<n>", "wave": "W2", "was"?: "P1", "note": "…" }] }`.
- `new-gaps.json`: `{ "gaps": [{ "id": "NEW-W1d-1", "wave": "W4", "title": "…", "evidence": "<case ids>" }] }`.
- `audit-verdicts.json`: `{ "verdicts": [{ "id": "SW-H2", "outcome": "not-exercised" | "exercised-not-reproduced" | "verified-by-read" | "verified-by-failing-test", "evidence": "…", "wave": "W3" }] }`.
- `triage(runs: RunResults[], rules, routing, ledger, newGaps): { rows: { caseId; layer; gap; wave; rule; was? }[]; untriaged: string[]; ambiguous: { caseId; rules: string[] }[]; misrouted: { rule; gap; wave; routed }[]; unknownGap: { rule; gap }[]; checked: number }`.
- CLI `triage.ts --runs <L1> <L2> <L3> [--rekey <w1drv-l3 results> --rekey-map <w1drv-l3 TRIAGE p-map json>] --out <dir>`. It writes `triage.json`, `TRIAGE.md` (per wave, per gap, the case list) and `REKEY.md`. Exit 0 every red triaged; 1 untriaged, ambiguous, misrouted or unknown (each listed); 2 refused.
- CLI `audit-ledger.ts --audit <dir> --triage <triage.json> --verdicts <json> --out <AUDIT-LEDGER.md>`. Every ledger id gets exactly one outcome from the five (D22): `reproduced` comes from triage, the others from verdicts. Exit 1 when an id has none or two.

- [ ] **Step 1: Write the failing tests**

```ts
describe("readAuditGaps", () => {
  const gaps = readAuditGaps(AUDIT_DIR);
  it("reads every Gaps row of the five audit files, prefixed by file, none twice", () => {
    const by = Object.groupBy(gaps, (g) => g.id.split("-")[0]);
    expect(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v!.length]))).toEqual(STEP0_COUNTS);   // pinned at Step 0
    expect(new Set(gaps.map((g) => g.id)).size).toBe(gaps.length);
    expect(gaps.length).toBeGreaterThanOrEqual(150);
  });
  it("the empty dir is refused (vacuous)", () => expect(() => readAuditGaps(emptyDir())).toThrow(/zero gaps/));
});

describe("triage (ruling 63)", () => {
  it("every red maps to exactly one rule; a red with none is untriaged, with two is ambiguous", () => {
    const r = triage([run([red("league|generic|default|M1", "standings: x"), red("swiss|chess|default|R4", "round 5 paired nobody (SW-H1)"), red("knockout|generic|default|F1", "nothing matches")])], rules([
      { id: "T-1", match: { cell: "league|*", check: "standings" }, gap: "ST-G3", wave: "W5" },
      { id: "T-2", match: { reason: "SW-H1" }, gap: "SW-H1", wave: "W3" },
      { id: "T-3", match: { cell: "swiss|*" }, gap: "SW-H1", wave: "W3" },
    ]), ROUTING, LEDGER, NONE);
    expect(r.rows.map((x) => [x.caseId, x.gap])).toEqual([["league|generic|default|M1", "ST-G3"]]);
    expect(r.ambiguous).toEqual([{ caseId: "swiss|chess|default|R4", rules: ["T-2", "T-3"] }]);
    expect(r.untriaged).toEqual(["knockout|generic|default|F1"]);
    expect(r.checked).toBe(3);
  });
  it("a rule that routes a gap away from §8 is misrouted (never re-route a gap §8 assigns)", () => {
    const r = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "SC-O1", wave: "W4" }]), ROUTING, LEDGER, NONE);
    expect(r.misrouted).toEqual([{ rule: "T-1", gap: "SC-O1", wave: "W4", routed: "W2" }]);
  });
  it("a gap id that is neither in the audit ledger nor in new-gaps.json is unknown", () => {
    const r = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "SC-Z9", wave: "W2" }]), ROUTING, LEDGER, NONE);
    expect(r.unknownGap).toEqual([{ rule: "T-1", gap: "SC-Z9" }]);
  });
  it("works, refused, later, no_path and planned not_run cases are never triaged; a zero-red run checks zero and is fine", () => {
    expect(triage([run([ok("a|b|c|M1")])], rules([]), ROUTING, LEDGER, NONE)).toMatchObject({ rows: [], untriaged: [], checked: 0 });
  });
  it("rekey: each of W1-driving's red cases is listed with its P-rule and its new gap, or 'not red in the baseline'", () => {
    const r = rekey(W1DRV_FIXTURE, { "league|boardgame|default|F1": "P1" }, triaged([["league|boardgame|default|F1", "SC-O1"]]));
    expect(r).toEqual([{ caseId: "league|boardgame|default|F1", was: "P1", now: "SC-O1" }]);
  });
});

describe("audit ledger outcomes (D22)", () => {
  it("each id gets exactly one of the five outcomes; none or two is exit 1, naming the id", () => { /* … */ });
  it("'exercised-not-reproduced' must cite at least one case id present in the runs as works", () => { /* … */ });
});
```

`STEP0_COUNTS` is pinned at Step 0 by running `readAuditGaps` once and reading the rows by hand against each file. The facts recorded SW 29, FX 24, ST 33, SC 44 ids in 46 rows, SH 20. The two extra SC rows are a finding for the test to explain, not to ignore: read them.

- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass.**

Run the vitest template on both test files plus `strip-types-loadable.test.ts`.

- [ ] **Step 5: Mutate, then commit**

| Mutant | Killing test |
|---|---|
| `triage` taking the first matching rule (no ambiguity) | "two is ambiguous" |
| Skipping the routing check | "misrouted" |

Commit `feat(matrix): triage and audit-ledger tools — every red keyed to a gap and its §8 wave (W1d ruling 63, D18, D22)`.

---

### Task 19: Triage the baseline, and re-key W1-driving's 164 (ruling 63; R5, R12)

**Files:**
- `tools/matrix/catalogue/{gap-routing,triage-rules,audit-verdicts,new-gaps}.json` (filled)
- `$TMPDIR/w1d-triage/` (outputs; committed in Task 21)
- `packages/engine/test/audit-witnesses.test.ts` and `tools/matrix/__tests__/audit-witnesses.test.ts` (create, only if a verdict is `verified-by-failing-test`; Step 4)

- [ ] **Step 1: Transcribe §8**

Transcribe design §8 (D:446-460) into `gap-routing.json`, id by id, each with its line. A reviewer checks every line against the design. "Gaps not listed go to the wave owning their format/sport" becomes rows that cite their format or sport.

- [ ] **Step 2: Seed the rules from W1-driving's triage**

Translate P1–P7 and the coverage-table signatures in `TR/w1drv-l3/TRIAGE.md` into rules with `was: "P<n>"`. The gap ids come from the rule prose and the audit files:
- P1 → SC-O1/SC-O2 (W2);
- P6 → SW-H1 (W3);
- P2, P4, P5: read their cited mechanisms against `FX-fixtures.md`/`ST-standings.md` and pick the audit id whose mechanism matches, or `NEW-W1d-<n>`.

**A grep is not a read** (class 5). Open the audit row and confirm that the mechanism matches the red's reason before assigning.

- [ ] **Step 3: Run triage on the third dispatch's merged layers, iterating rules until exit 0**

```bash
cd <evidence> && pnpm matrix:triage --runs "$TMPDIR/w1d-dispatch/3/L1/results.json" "$TMPDIR/w1d-dispatch/3/L2/results.json" "$TMPDIR/w1d-dispatch/3/L3/results.json" --rekey docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-l3/results.json --rekey-map "$TMPDIR/w1d-triage/p-map.json" --out "$TMPDIR/w1d-triage"; echo EXIT=$?
```

`p-map.json` (case id → P-rule) is derived by script from `TRIAGE.md`'s per-case table. Its count must be 164, and the script asserts that.

For each red the rules do not cover:
1. Read the case's evidence: the reason, the failing checks and the screenshots for L1/L2.
2. Find the audit row whose mechanism it is.
3. If none fits, add `NEW-W1d-<n>` to `new-gaps.json`, with the wave that owns its format or sport (§8's fallback rule) and the case ids.
3a. Read the message of every `POST /divisions/<id>/start` `CONFIG_INVALID` red before assigning a wave (D6 limit 1: the harness may have asked wrongly there, as `w1b-probe`'s `page_playoff_only` 8-entrant case did). A `SetupRefused` red that is the product refusing a catalogue-valid body (D6 limit 2) gets an owner ruling and a `NEW-W1d-<n>`, never "fix the harness".
4. A red whose cause is a HARNESS defect (D6 should have caught it; if it did not, D6 has a gap) is a STOP: fix it, and Task 17's three dispatches restart.

An L1 red whose reason names hydration or the first control is item 13's revisit trigger (rule T-H): it goes to the owner, not to a wave.

- [ ] **Step 4: Audit verdicts (D22)**

For each audit id the triage does not reproduce, write one verdict with evidence:
- **exercised-not-reproduced:** the driven case ids that cover it and passed. These become "False premises found — W1d triage" entries in `_INDEX.md`, one line each with evidence (R5);
- **not-exercised:** the atom or script that would reach it, and its wave;
- **verified-by-read:** `file:line` and what it shows;
- **verified-by-failing-test:** the test path, which is committed in this PR and fails on `main`. Each such test is marked `it.fails` and names the gap, so it is a real, running witness that flips when the gap is fixed. It goes OUTSIDE `packages/engine/src/**`, which this wave does not touch (review I12):
  - an engine gap → `packages/engine/test/audit-witnesses.test.ts` (new; `packages/engine/test/**` is in the engine's vitest `include` and its tsconfig, and already holds `boundary-gate.test.ts`, `runtime-deps.test.ts`, `source-bytes.test.ts`). It imports the engine's public entry the way those files do;
  - a gap reached only through the product's HTTP surface → `tools/matrix/__tests__/audit-witnesses.test.ts` (new), as a text or plan-level assertion.

  Each `.fails` test carries the audit id in its title. `audit-verdicts.json` names the file and the title, and the ledger CLI refuses a `verified-by-failing-test` verdict whose title does not appear in the named file. Run both files with the vitest template and confirm `.testResults[].name` lists them, because a missing path is dropped silently.

Then run:

```bash
cd <evidence> && pnpm matrix:ledger --audit docs/superpowers/specs/2026-09-27-format-matrix-prompts/audit-2026-09-27 --triage "$TMPDIR/w1d-triage/triage.json" --verdicts tools/matrix/catalogue/audit-verdicts.json --out "$TMPDIR/w1d-triage/AUDIT-LEDGER.md"; echo EXIT=$?
```

Expected: `EXIT=0`, with every id given one outcome and the counts per outcome printed.

- [ ] **Step 5: Review the triage**

Dispatch the `reviewer` on the four catalogue files plus `TRIAGE.md`/`AUDIT-LEDGER.md`/`REKEY.md`. Brief: sample 20 reds across the waves, and for each re-derive its gap from the case evidence and the audit row without reading the rule. Every disagreement is a finding. Fix and re-run until it agrees.

- [ ] **Step 6: Commit the catalogue files**

Commit `docs(matrix): W1d triage rules, §8 routing, audit verdicts, new gaps (ruling 63)`.

---

### Task 20: Stryker's first measured run sets the floor (design §7.5 item 2; D14)

- [ ] **Step 1: Dispatch every group**

```bash
cd <evidence> && gh workflow run mutation.yml --ref matrix-truth/w1d-baseline -f group=all; echo EXIT=$?
```

Monitor it until completed, with the same Step 2 checks as Task 17. Download each `mutation-<group>` artifact into `$TMPDIR/w1d-mutation/<group>/`.

- [ ] **Step 2: Read each group**

For each group, record:
- mutants;
- killed, survived, NoCoverage, timeout;
- the total score;
- the wall time;
- the 10 files with the most survivors.

A group with zero mutants is a configuration fault (the floor checker refuses it): fix the globs. A group that hit its timeout is split in two by file (its measured wall time is lost, so Step 4's estimate decides the split), and that group is re-dispatched. A measured wall time over 200 minutes is split too, because × 1.5 would pass the 300 cap. The split is justified by the group's MEASURED mutant count and per-file survivor counts from this run, never by line counts. Compare each group's wall time with Task 15 Step 4's dry-run table, and replace each group's `stryker-timeouts.json` entry with measured wall time × 1.5 (at most 300).

- [ ] **Step 3: Set the floors**

```bash
cd <evidence>/packages/engine && for g in $(node -e 'import("./stryker.groups.mjs").then((m) => console.log(Object.keys(m.STRYKER_GROUPS).filter((x) => x !== "probe").join(" ")))'); do node --experimental-strip-types scripts/stryker-floor.ts --set-floor $g "$TMPDIR/w1d-mutation/$g/$g.json"; echo "$g EXIT=$?"; done
```

Then `--check-file-against origin/main`, which must pass: floors rise from "none".

- [ ] **Step 4: Derive the timeouts, and commit the survivors**

Set each group's `stryker-timeouts.json` entry = ceil(measured × 1.5), at most 300. `stryker-matrix.mjs` emits it as the `timeout` field of the job matrix. Write `TR/w1d-baseline/MUTATION.md` with:
- the per-group table;
- the run id;
- the artifact names;
- the instruction "survivors are killed by a test or recorded as equivalent in `stryker-equivalent.json` (by file:line:col mutator), by the wave that owns the file".

Commit `feat(engine): Stryker floors from the first measured run (W1d D14)`.

---

### Task 21: Commit the baseline (D19; item 27)

**Files:**
- `TR/w1d-baseline/{L1,L2,L3}/{results.json, MATRIX.md}`;
- `TR/w1d-baseline/{README.md, HARNESS-GREEN.md, TRIAGE.md, REKEY.md, AUDIT-LEDGER.md, TIMINGS.md, MUTATION.md}`;
- `TR/plans.lock.json` (+3);
- `HM/__tests__/committed-matrix.test.ts` (`EVIDENCE_DIRS`, `RESULTS_FLOOR`);
- `HM/catalogue/baseline.json`;
- `HM/ci/shards.json` (`ceilingFrom` → the baseline).

- [ ] **Step 1: Copy the third dispatch's merged layers**

Copy `results.json` and `MATRIX.md` per layer. `MATRIX.md` is already generated by `merge-shards.ts` (R10), so never hand-edit it. Then size-check the result: `du -sh TR/w1d-baseline`. Ruling 56 keeps evidence in `docs/` at ~12 MB today. If L2's `results.json` exceeds 5 MB, report it to the controller before committing; do not trim cases.

- [ ] **Step 2: Lock entries, exactly as the missing-entry failure prints them**

Run the committed-matrix test once, copy the three printed entries (`w1d-baseline/L1` plan `--layer L1 --scope grid`, `w1d-baseline/L2` plan `--layer L2 --scope grid`, `w1d-baseline/L3` plan `--set w1-driving`) into the lock, and re-run it. Raise `RESULTS_FLOOR` by 3, and add `w1d-baseline/L1`, `w1d-baseline/L2` and `w1d-baseline/L3` to `EVIDENCE_DIRS`.

The `merged` runs carry `shards: N` and no `shard`, so `judgeRun` must accept them. If it does not, that is a Task 4/Task 2 gap: fix it in this PR, with a test.

- [ ] **Step 3: The prose files**

- `README.md`: the env (CI, `postgres:16`, no Redis, HOLD 3000, the tag and its SHA, the three run ids, artifact retention 90 days, where the screenshots are);
- `HARNESS-GREEN.md`: the three `judge across` outputs verbatim;
- `TIMINGS.md`: per layer and per shard, wall and per-case p50/p90/max, from `summary.ts`. Design §12: "W1d publishes the real times". `counts.json` gains nothing; times are not counts;
- the triage outputs from Task 19 and `MUTATION.md` from Task 20.

- [ ] **Step 4: Point the sample and the shard budget at the baseline**

Set `baseline.json` `L3` to `…/w1d-baseline/L3/results.json`, and each layer's `shards.json` `ceilingFrom` to `w1d-baseline/<layer>`. Re-run `shard-matrix.test.ts`: the CLI test reads the new ceilings. If a derived timeout moved past the cap, re-shard (raise that layer's count) and record why.

- [ ] **Step 5: Verify, then commit**

Run the vitest template on:

```
committed-matrix.test.ts committed-plans-frozen.test.ts shard-matrix.test.ts pr-sample.test.ts rebase-map.test.ts
```

`rebase-map` must stay green, which is why the directory is not `w1drv-*` (false premise 10). Then run `pnpm matrix:lock-check --against origin/main`; it must print `… 3 added`.

Commit `docs(matrix): W1d baseline — full L1/L2/L3 truth run, triaged (ruling 63, D19)`.

---

### Task 22: Enable the schedule, write the backlogs, close W1d (ruling 62; D2)

- [ ] **Step 1: Per-wave ❌ tables in `_INDEX.md`**

Under a new "## W1d truth-run backlog (baseline `<sha>`)", write one table per wave (W2…W10), generated from `triage.json`. For each gap, give:
- the gap id;
- its title;
- the case count;
- up to 5 example case ids;
- the layer(s).

Then the not-exercised gaps per wave, from the ledger. Generate the section with a one-off `node -e` over `triage.json` and paste it in. **The tables are data, so they are never typed.**

- [ ] **Step 2: The W2 backlog**

When W2's table is written, flip W2's status row to "backlog ready (W1d baseline `<sha>`)". No other wave's row changes (the prompt's rule).

Next to the W2 backlog, record W2 prompt trap 2's contradiction (false premise 20) for W2's planner.

- [ ] **Step 3: Enable the schedule (the owner's act; D2)**

Ask the owner in chat to run `gh variable set MATRIX_WEEKLY_ENABLED --body true`, or run it on their explicit instruction in this session, never on an inherited one (AGENTS 17). Record the time in `_INDEX.md`. Then read `gh variable list` to confirm.

The first scheduled firing is the following Saturday 02:17 UTC, and GitHub's cron can be hours late (help-shots fires 5–6.5 h late). Record its run id when it appears, and from it:
- its `event` (`schedule`);
- that the `plan` job ran (not skipped);
- what the run's payload held (false premise 17). Read it from `gh api repos/{owner}/{repo}/actions/runs/<id>` (`event`, `triggering_actor`, `head_sha`), never from a debug step that prints `github.event` (it is public, and nothing in the guard depends on it).

If it has not fired within 8 days, D1's PR annotation shows it; that is the signal working. This observation is a carry recorded in `_INDEX.md`, not a PR-B blocker.

- [ ] **Step 4: PR-B**

1. Update the W1d status row: "Done: PR-A `<sha>`, PR-B `<sha>`; baseline `TR/w1d-baseline` (tag `matrix-truth/w1d-baseline`); weekly schedule enabled `<date>`".
2. Dispatch the reviewer on the whole PR-B diff with `model: "opus"` (the whole-branch review; Execution model policy), then fix (Sonnet) and re-review.
3. Push and open the PR. Its body carries `Matrix rows: none — evidence, triage catalogue and Stryker floors; no runtime change` (it touches `packages/engine/stryker-floor.json`, a declaring path). It also carries the per-wave counts, ruling 65's reading of ░ (driven cases only), the three run ids and the mutation run id.
4. Watch CI: `gates` (the lock check prints `3 added`, the floor check passes) and the per-PR sample (now judged against the new baseline).

**The owner merges PR-B.**

---

## Review response (fix round 1)

Plan review 1 (3 Critical, 15 Important, 13 Minor; findings in the session's scratchpad `plan-review-1.md`) was taken against `ed9801b60`. Owner ruling 65 (`6399878c9`) landed after the plan.

**Every C and I is fixed.** Where:
- **C1** `lib/run-id.ts` `slugRunId` (Task 4); `shardMatrix` emits a lowercase `id` (Task 8); the YAML builds `RUN_ID` from `matrix.id`, and the merge uses `${layer,,}` (Task 9). Tests hold the templates to `slugRunId(x) === x` against the real CLI output.
- **C2** budgets count DRIVEN items per stripe, with a test showing the planned count would refuse L2 (D4, Task 8).
- **C3** (a) `run-sample.ts` reads `MATRIX_ARGS` from the env; (b) is C1; (c) `regressions` takes the exact expected ids (`--expect`), with a test on the real committed baseline (Tasks 6, 7, 9).
- **I1** Task 3 is rewritten on `DrivenLayerCase`/`PlannedLayerCase`.
- **I2** `z.partialRecord`.
- **I3** `VACUOUS_REASONS` comes from results.ts, with the prefix match and a test per reason.
- **I4** the marker is a second witness beside I-2, and the mutant has a new killing test.
- **I5** the gate sits after `reference:boundary`.
- **I6** `ceilingFrom` is a list holding the six L1 sub-runs.
- **I7** asserts no bench TEST file.
- **I8** `workflow-text.ts` with stated contracts; it stays a text parser.
- **I9** real-CLI spawn tests against the workflow's template.
- **I10** whole-sample re-run, `passes: 2`, measured in Task 7.
- **I11** negated test globs, memory-derived concurrency, `path.matchesGlob`, `.d.mts`.
- **I12** witnesses in `packages/engine/test/` or `HM/__tests__/`.
- **I13** bench's env on the build and shard jobs, and a key-parity test. (Its buildx half is superseded by ruling 66: no placement image is built, D23.)
- **I14** per ruling 65, `allow` is the ruled behaviour. It is cited in the YAML, and the D7 question is removed from Tasks 16/17 and the handoff. A ░ on a driven case is still a fault (Task 6 test).
- **I15** re-pinned to `pad-proof.test.ts`, `page-objects.test.ts` and `layers.test.ts`/`run-cli.test.ts`, with file counts stated.

**Minors fixed:** m1, m2, m3, m4 (⬜ `needs_ruling` is data, D6), m6, m8, m9, m10, m11, m12, m13.

**Disagreed, with reasons:**
- **m5 (evidence directories in PR-A): kept in PR-A.** Ruling 62 gives PR-B "three harness-green dispatches, the triaged baseline committed, the Stryker floor". Those are the dispatched evidence, and they all land in PR-B (Tasks 17–21). The only evidence PR-A commits is Task 14's `TR/w1d-carry/`. Those are LOCAL runs that close "W1d first tasks" items 15c–15f, and ruling 62 puts those items in PR-A. Moving them would split one item's proof from its code across two PRs, and would leave Task 1's append-only gate without a real addition to witness before merge.
- **m7 (RefusedCall as a seeding shape): premise false, guard adopted.** See false premise 21. The 11 reds are scenario withdraw actions, so they stay data. A setup-phase tag is added so that a refused setup call would be a fault (`SetupRefused` since fix round 2).

**New false premises:** 21 and 22 above.

---

## Review response (fix round 2)

Re-review 2 (0 Critical, 4 Important, 7 Minor) was taken against `653e62ee2`. The reviewer withdrew m5 and m7 and verified false premises 21 and 22.

**All 4 Important are fixed:**
- **R2-I1 (placement secret).** One literal, `ci-matrix-secret`, sits on both sides. The container step is written out instead of "e2e verbatim", whose `ci-e2e-secret` was the mismatch. Two tests are added: one compares the two literals, and one, "The solver never fell back to greedy", fails the shard when the server log carries build.ts's `falling back to greedy` warning. It also refuses an empty log, and checks its pattern against `build.ts`'s real text. Task 9 Step 0 records whether a matrix path reaches the solver at all. At HEAD `http-driver.ts` calls no `/schedule/` route, so the report must not imply the guard fired. **Superseded by ruling 66 (fix round 3, R3-I1): the container, the secret literal, both of those tests and the greedy guard are removed (D23).**
- **R2-I2 (setup refusals).** The route list is gone. `setUpDivision` wraps its pre-`start` calls in `inSetup`, which rethrows a `RefusedCall` as `SetupRefused extends RefusedCall`. The judge reads the `error: SetupRefused:` prefix. Tests:
  - the positive control (`addEntrants`, `createDivision`, `postStages` refused) and the negative pair (`start` refused stays data), through the real `setUpDivision`;
  - an end-to-end case through `execute`;
  - the real `w1drv-l3` run, with 11 RefusedCall reds checked and 0 setup-refused.

  Mutation rows are added.
- **R2-I3 (unpinned type-check gate).** A `ci-wiring.test.ts` case pins the `tsc -p tsconfig.tools-tests.json` step, in the reference-boundary line style: exactly once, in `gates`, with no key beneath it. Mutants: delete the step; add `continue-on-error`.
- **R2-I4 (Stryker concurrency).** The quantity is now stated: TOTAL vitest workers stay within `vitest.config.ts:43-46`'s bound, divided by the workers one sandbox runs (`STRYKER_VITEST_WORKERS`, pinned at Step 0 from the runner). Expected values are worked from the formula's inputs in comments (4 cores, 16 GiB → 3). A second test pins the vitest formula's text.

**Minors fixed:** R2-m1 (`trimEnd`), R2-m2 (`fixedSample`, `LAYER_GRID_PLANNERS`; see below for the PR body), R2-m3 (`compared === expected.length`), R2-m4 (`API_ONLY_UI_WAVE[row].wave`), R2-m5 (the `layers.ts` import list), R2-m6 (a `marker-on-driven` fault in `faults`; set membership is backstopped by `judgeRun` on PR-B's evidence, as stated), and R2-m7 (folded into R2-I2).

**Disagreed in part:**
- **R2-m2, third bullet (move the `Matrix rows:` line into Step 4).** PR-A deliberately opens WITHOUT it. Step 5 uses that red as the R27 gate's first live witness, then adds the line. Moving the line into Step 4 would lose the only live proof that the gate reds. Step 4 now says this explicitly: the line is added in Step 5, and the PR is not ready for review until it is in and `matrix-rows` is green.

**New false premises:** none.

---

## Review response (fix round 3)

Re-review 3 (0 Critical, 2 Important, 5 Minor) was taken against `04b0c2957`. Both Important findings are what owner ruling 66 requires, and ruling 67 then widened the Stryker scope.

**Both Important are fixed:**
- **R3-I1 (placement container, image build, greedy guard; ruling 66).** Removed: the build job's buildx, image build, `docker save` and `placement.tgz`; the shard's container start, `docker load` and wait; the server's `PLACEMENT_*` env; the greedy guard step; its three tests (the secret literal, the greedy log, buildx); and their three mutation rows. Added:
  - `OMITTED_BY_RULING_66` in the server-env parity test, which asserts the two keys are named in bench's server env and ABSENT from the workflow. The parity test therefore no longer goes red.
  - `no-solver-route.test.ts`, which scans `tools/matrix/lib` for a solver route and the board's auto-run control, reports the number of files scanned, fails on zero, requires the two files that matter to be among them, and has a positive pair for the pattern. Mutants are in the Task 9 table.
  - D23 (the evidence from the review, re-read at HEAD) and false premise 23: the greedy guard was vacuous, because it counted log lines and "fallbacks: 0" passed on every run when nothing called the solver. Step 0 and false premises 19 and 22 are updated.
- **R3-I2 (Stryker scope; rulings 66, then 67).** The review's 17-file scope is superseded by ruling 67, which puts the whole engine in. Task 15 and D14 now have ten groups plus the `probe`: `competition`, `core`, `modules` (sport, stats, history, officials, import, exports), `draws`, and six `sports-*` groups split by sport family.
  - **Exclusions.** The 19 placement files are `STRYKER_PLACEMENT_OUT_OF_SCOPE`, each with the reason `ruling 67: placement scheduling, low priority`. `STRYKER_EXCLUDED` holds `index.ts`, `logger.ts`, `solver-test-bounds.ts`, `placement-client.ts`, `payload-fixtures.ts`, `generated/**` and `src/testkit/**`, each with its own reason.
  - **`payload-fixtures.ts`, decided from the file.** It builds frozen calendar `Assignment`s, golden slots and order dependencies. Its importers are the `calendar-*` and `repair-domain` tests, `participants-rules.test.ts` (as test input) and the out-of-scope `repair-synthetic-board.ts`. It feeds no draw or format code, so it is excluded and NOT put in `draws`.
  - **The sweep** covers all of `src/**`, reports the unclassified count, and fails on any. Its bounds are derived from the groups and maps: the universe equals grouped + excluded + placement, and each class is non-empty. No line count appears in any test, floor or acceptance criterion (owner, 2026-10-04).
  - **Sizing.** D14's estimate mentions the line proxy once, as an estimate, then defers to measurement. Task 15 Step 4 dry-runs every group for its mutant count (PR-A), and Task 20 uses the first full run's wall time per group (PR-B), so splits and `timeout-minutes` follow measurements.
  - The probe moved to `src/scheduling/roundrobin.ts` (co-located test, checked). Task 20's loop reads the group names from `STRYKER_GROUPS`. `mutation.yml`'s matrix and dispatch choices are derived from the same keys, with a test.

**Minors:**
- **R3-m1 fixed, by the review's second option.** `matrix-rows` reads the PR body live with `gh api repos/$REPO/pulls/$N --jq '.body // ""'` (the job already has `pull-requests: read`), and not through an empty commit. The test, D13, `pr-rows.ts`'s exit-1 message and Task 16 Step 5 are updated: add the line, re-run the failed job, see it green. The sole reason to prefer this over an empty commit is that a re-run then works too.
- **R3-m2 fixed.** `SetupRefused.from(e)` keeps the original message, and the e2e test asserts the whole reason. **Disagreement on the re-pin:** `errText` is at `run.ts:458` at HEAD (opened and counted with `grep -n`), not `:457`, so the plan's `:458` stays.
- **R3-m3 fixed.** `inSetup` is exported and wraps `denied.ts:63`, `:64`, `:76` and `:77`, with a fake-driver test that keeps `:67` as data.
- **R3-m4 fixed.** D6 states both limits, Task 18 Step 3 reads every `start` `CONFIG_INVALID` red, and a catalogue-valid-body refusal gets an owner ruling and a `NEW-W1d-<n>`.
- **R3-m5 fixed.** The real-run test now asserts that no fault of any kind names one of the 11, and has a mutation row.

**New false premises:** 23 (the greedy guard).

**Execution model policy** (owner, 2026-10-04) is added beside the plan header: Sonnet for every implementer, task reviewer and fix agent; Opus for the two whole-branch reviews (Tasks 16 and 22).

---

## Review response (fix round 4)

Re-review 4 (0 Critical, 3 Important, 9 Minor) was taken against `cff1e7176` and closed round 3. Owner ruling 68 landed after it.

**All 3 Important are fixed:**
- **R4-I1 (`globSync` `exclude`).** Re-probed on Node 26.8.2: the callback receives basenames for files, so the `!` negations never fired (24 files, 14 of them tests). The sweep and the "no test file" test now use `expand()`, which globs the positives and filters the RESULT with `matchesGlob`. The mutation row says why the old form could never have gone green.
- **R4-I2 (mutation matrix).** One derivation per event, in `stryker-matrix.mjs`: a PR runs `probe`, the schedule and dispatch `all` run every other group, and a dispatch `group` input selects one (`probe` included). The gate is the matrix-truth form. A spawn test pins each event, plus three mutation rows.
- **R4-I3 (browser half of the guard).** The pattern is built from the four real testids (`schedule-auto`, `schedule-reflow`, `schedule-polish`, `board-ai-schedule`, re-opened at `schedule-board.tsx:1416,1433,1456,1485`). The scan covers every file under `tools/matrix` for routes and every `lib/browser/**` file for controls. A positive pair reads the testids from the board source. Two mutation rows (selectors, a page object).

**Ruling 68 (new):** D24. Every matrix and Stryker job takes `vars.MATRIX_RUNNER || 'ubuntu-latest'`. The guard already passed on `self-hosted` and failed on hosted-private, and `RUNNER_ENV` is its input. The test now holds all four combinations and the runner literal in every job of both workflows. Three mutation rows. The Fly runner is recorded in the handoff and not planned.

**Minors fixed:**
- m1: the doubled `describe(` is gone.
- m2: one cap, 300, everywhere; the split rule is absolute (`est > 200`, from the dry-run formula, before PR-A merges); `stryker-timeouts.json` carries per-group timeouts into the matrix, and Task 20 replaces them from measurement.
- m3: `--check` is skipped only for `probe` and while the floor file is empty; a test requires every non-probe group to have a floor once any exists.
- m4: a test pins that no in-scope file imports `payload-fixtures.ts`. m5: the assertion is per positive glob, and the sports globs end `/**/*.ts`.
- m6: counts are 23 premises and D1–D24. m7: the trailer is "the line the running agent's prompt gives", plus a re-confirm-with-the-owner line.
- m8: `permissions: contents: read` and `plan` `timeout-minutes: 15` for `mutation.yml`, and a test that every job of both workflows has `timeout-minutes`. m9: the scan covers all of `tools/matrix`, and the stray capital is fixed.

**Disagreements:** none. **New false premises:** none.

---

## Review response (fix round 5)

Re-review 5 (0 Critical, 1 Important, 10 Minor) was taken against `d8b2b7b35`.

- **R5-I1 fixed.** `mutate` has `strategy: fail-fast: false` and `if: always()` on its survivors and upload steps. A test in `matrix-workflow.test.ts`, beside matrix-truth's, pins both and the matrix-derived timeout, with mutation rows.
- **m1** 9 cases. **m2** the dispatch choices test now exists. **m3** every guard step of both workflows must carry `RUNNER_ENV: ${{ runner.environment }}`, with a mutation row. **m4** Task 17 Step 1 checks `vars.MATRIX_RUNNER` is unset and STOPs with that reason; D24 says the injection proves the hosted path only. **m5** wording and the guard's hint. **m6** the estimate floors the dry run at 344 s and uses concurrency 3; timeouts are re-derived when the runner changes. **m7** the handoff states the runner contract (Docker for `services: postgres`, tools, one label). No Fly runner is planned. **m8** `MATRIX_RUNNER` stays unset while the repo is public, in D24 and the handoff. **m9** the garbled example and the D23/D24 order. **m10** a `mutation.yml` skeleton in Task 15 Step 3.
- **Disagreements:** none. **New false premises:** none.

---

## Review response (fix round 6)

Re-review 6 (0 Critical, 1 Important, 7 Minor) was taken against `b53c5cd53`.

- **R6-I1 fixed.** The `mutation.yml` / `stryker.groups.mjs` blocks (the two-file `runs-on` test, the `RUNNER_ENV`, `fail-fast`, `if: always()` and choices tests) and their mutation rows moved from Task 9 to Task 15 Step 3 and Step 5. Task 9 keeps a `runs-on` / `timeout-minutes` check on `matrix-truth.yml` alone. Task 15 Step 4 runs `matrix-workflow.test.ts` too, and `stryker-matrix.test.ts` (m1) with its three mutation rows.
- **Scan of every task for the same shape** (a test or command in Task N that reads a file first created in a later task). Method: every file named in a `Create` list of every task (by basename) was searched for in all EARLIER tasks, once on read/import/spawn/`pnpm`/`node` lines and once on every line inside a code fence. Result: only the three Task 9 mentions above (`mutation.yml`, at the `runs-on` test, the describe body and the choices test). One prose hit in Task 7 names `shards.json` (Task 8) as a figure to check later, and reads nothing. Not covered by the scan: files named only in prose, and files a task reads that are Modify targets of a later task, which already exist.
- **m1** done. **m2** the precondition states that `gh variable list` shows repo-level variables only, adds the org and environment lists, and makes the post-dispatch log check the authority; the "guard is open" STOP now excludes the self-hosted log line. **m3** D24 wording. **m4** the skeleton comment moved off the option line, and the test strips trailing comments and says it is order-sensitive. **m5** the status row now says rulings 60–68. **m6** the `if: always()` choice is marked deliberate. **m7** the `--out` path is written once.
- **Disagreements:** none. **New false premises:** none.

---

## Review response (fix round 7)

Re-review 7 (0 Critical, 1 Important, 7 Minor) was taken against `26c0b5226`. Its independent forward-reference scan (53 created files, 22 tasks) found no other test or command that reads a later task's file.

- **R7-I1 fixed.** Task 15 now writes the `ci.yml` floor step (exact YAML, appended after the Task 1 lock step and Task 10's type-check step, never after `reference:boundary`), pins it in `ci-wiring.test.ts` (once, in `gates`, no key beneath it), and has mutation rows for deleting it and for `continue-on-error`. `--check-file-against` states its empty cases: absent at the ref is "no floors yet" (exit 0, PR-A's own first run); absent in the working tree is exit 2 always (fail-closed after PR-B); an unreadable ref or malformed JSON is exit 2. CLI tests spawn it in a temp git repo for each case, and two more mutation rows cover the two directions.
- **m1** both Task 10 and Task 15 say where the gates step goes. **m2** Task 10's error count allows for the test files Tasks 1–9 added. **m3** the Task 14 selectors path. **m4** Task 16's four engine files. **m5** `workflow-text.ts` and the helper move are in Task 9's file lists. **m6** the identical-guard test is written, and the moved mutation rows are in Step 5's table. **m7** `GROUP` is job-level env in the skeleton.
- **Disagreements:** none. **New false premises:** none.

---


## Plan review 8: Approved (0C/0I/3m), executor carries

Re-review 8 (plan `2d3a7801f`) approved the plan. Its three minors are not fixed in the plan. The executor of the
named task carries them:

1. **Task 15 Step 4** also runs `tools/matrix/__tests__/ci-wiring.test.ts`, where the new floor-step pin lives.
   Check it in `.testResults[].name`.
2. **Task 15, `--check-file-against` contract:**
   - The file path is relative to cwd.
   - Resolve the ref with `git rev-parse --verify <ref>^{commit}`, and test presence with `git ls-tree <ref> -- <path>`.
     Never parse the localised stderr of `git show`.
   - The interface states the compared-entry count the CLI prints, and zero compared with a floor present is a failure.
3. **Task 15's temp-git-repo CLI tests** copy Task 1's git-identity helper (`user.name` / `user.email`) and set
   `commit.gpgsign=false`, so a developer machine with signing on does not red them.

## Self-Review

**1. Spec coverage** (the brief, rulings 60–68, item list):

| Requirement | Where |
|---|---|
| The matrix proves formats and rules, not scheduling: no placement container or greedy guard, a test pins the premise (66) | D23; Task 9 `no-solver-route.test.ts`; false premise 23 |
| Stryker covers the whole engine except placement scheduling, sharded by group, sized from measured mutant counts and wall time (66, 67) | Task 15; D14; Task 20 |
| Weekly via the workflow's own `schedule:` + dispatch; no worker or route (60) | Task 9; D2; false premise 18 |
| A missed week is visible (60) | D1; Task 8 `staleness.ts` + `summary.ts`; Task 9 ci.yml step |
| Harness-green per §6.5, a 3-run comparison tool, non-zero exit, anti-vacuity (61) | Task 6 `judge.ts across`; Task 17 Step 4; D6 |
| One plan, two PRs; tasks marked; merge gate (62) | the PR-A/PR-B headings; Task 16 STOP; Task 17 Step 0 |
| Schedule shipped disabled; a firing while disabled is a visible skipped run (62) | D2; Task 9 `plan` `if:`; test "skipped on a schedule unless…" |
| Every ❌ keyed to an audit id or NEW-W1d with its §8 wave; 164 re-keyed; non-reproduced → false premises; non-behavioural verified (63) | Tasks 18, 19; D22 |
| L1 231 @1280 + counts.json fix; L2 1,731; L3 937; one shard per job, fresh Postgres + sync:sports, ~12 shards, explicit timeouts < 360 (64) | Tasks 3, 4, 8, 9; D4 |
| Full-grid planners + scope recorded (item 2); frozen plans (item 1) + lock review | Tasks 3, 1; D10 |
| `--shard i/N` deterministic; union = plan; no overlap; stable | Task 4 (property test) |
| A merge CLI refusing missing/empty shards (R25); `EXIT=$?` written by each shard; MATRIX.md from merged | Task 4; Task 9 "Run the shard" |
| One exit-code convention + normalising the CLIs (item 6) | Task 6; D8 |
| Workflow: build once, a shard matrix with own Postgres + db:apply + sync:sports + BENCH_EXPECTED_DATA_DIR + Playwright; artifacts per shard; merge, judge and summary | Task 9 |
| Visibility guard first in every job, `gh api`, fails loudly; unit test with injected visibility; dispatch input injects `private`; PR-B proves it live | Task 9; Task 17 Step 1 |
| R14a: synthetic only, never echo secrets | Global Constraints; Review Focus 5; Task 4 `ShardSecret`; Task 9 tests |
| `ci-wiring.test.ts:244` changed deliberately, failing-first | Task 9 Step 1 |
| Per-PR sample (R27) in ci.yml | Tasks 7, 9; D13 |
| Stryker weekly: versions, config, own workflow + timeout, floor + checker (only rises), floor from the first run, survivors, runtime estimate, grouping and incremental | Tasks 15, 20; D14 |
| All 28 items batched (ruling 41); items 4 and 7 CHANGED | the PR-A table; Tasks 2, 10; false premises 1, 2 |
| Item 28 inspects spawn ARGUMENTS, decoys, exempt by name, positive control, non-zero count | Task 11 |
| Item 15 browser items and item 16 cricket routes, sized honestly | Tasks 12, 14 (Step 0 of each re-sizes against the skin) |
| PR-B: 3 dispatches with the traps; the triage tool and process; a baseline layout without the `w1drv-` prefix; the Stryker floor; enabling the schedule; _INDEX tables; W2 "backlog ready" | Tasks 17–22; D19, D21 |
| The four test types per task | the table in Global Constraints; each task's steps |
| A "False premises found" section | 23 entries (20 at planning, 2 in review fix round 1, 1 in review 3) |
| D-numbered recommendations with owner value | D1–D24 |

**2. Placeholder scan.** Three places say "Step 0 pins" for a number the tree must give:
- `STEP0_COUNTS` (Task 18);
- the four L2 run `n` values (Task 3);
- Stryker's score definition (Task 15).

Each names the command or source that yields it. They are deliberate re-pins (class 5), not TBDs.

Three YAML steps are elided with `# … verbatim from e2e.yml/bench.yml …`. They name the exact source lines, and Task 9's identity test forbids divergence. They are kept out of the plan only because the source is the authority.

**3. Type consistency:**
- `Shard {index, of}`, `stripe`, `stripeSize` and `MAX_SHARDS` (Tasks 2, 4, 8);
- `mergeShards → {merged, checked}`;
- `harnessFaults`, `statesAcross` and `regressions` (Task 6), as used in Tasks 9 and 17;
- `shardMatrix(cfg, scope, plans: driven flags per layer, ceilingS, rows?)` → `include {layer, id, k, of, args, timeout}` (Task 8), as used in Task 9's YAML (`matrix.id`, `matrix.k`, `matrix.of`, `matrix.args`, `matrix.timeout`);
- `slugRunId` (Task 4), used by run.ts, `merge-shards.ts`, `run-sample.ts` and Tasks 8–9's tests;
- `regressions(baseline, now, expected)` and `judge.ts regression --expect` (Task 6), fed by `run-sample.ts`'s expect file from `planPrSample` (Tasks 7, 9);
- `VACUOUS_REASONS` (results.ts) and `SetupRefused`/`inSetup` (driver/types.ts, scenarios/common.ts), Task 6;
- `planned` / `l2` / `fillers` / `shard` / `shards` (Task 2), as read in Tasks 4, 6 and 21;
- `LAYER_GRID_PLANNERS[layer]` beside the unchanged `LAYER_PLANNERS` (Task 3);
- `voidLast` (Task 14).

All consistent.

**4. Review Focus.** Five entries, each pinned by a named test in Tasks 4, 6, 9 (×2), plus Task 17's live proof.

---

## Execution handoff

Plan complete, saved to `docs/superpowers/plans/2026-10-04-format-matrix-w1d.md`. Please review it.

**Recommended: Subagent-driven.** 22 tasks share interfaces tightly: the Task 2 schema fields feed Tasks 4, 6 and 21, and the Task 4/6/8 CLIs are called by Task 9's YAML. A shipped mistake here is a weekly job that reads green on a run that did not happen. Use a fresh implementer per task, and a reviewer per task before the next.

Batch Tasks 12 and 13 into one dispatch with one review: they are same-shaped carries in disjoint files. Tasks 1–11 are sequential. Tasks 12–15 may run in parallel worktrees only if their file sets stay disjoint (Task 14 and Task 12 both touch `browser-driver.ts`, so they run sequentially).

D7 (the L2 ░ reading) is RULED: owner ruling 65 (2026-10-04). The merge job and every Task 17 judge call use `--planned-not-run allow`, and Task 6 keeps a test that a ░ on a DRIVEN case is still harness-red. No owner question blocks any task.

**Between PR-B and the private switch (ruling 68, not planned here):** a short follow-up builds the ephemeral self-hosted GitHub Actions runner on Fly Machines (its own Fly app and image with Node, Playwright browsers and Postgres, no production secrets). Then `vars.MATRIX_RUNNER` changes. This supersedes design §6.5's "a VPS or the owner's machine". W1d builds no runner. PR-B's dispatches run on GitHub-hosted runners while the repo is still public.

**The runner contract the follow-up must meet (review 5, R5-m6, m7, m8):**
- **Docker.** The shard job declares `services: postgres:16` on port 5433, which needs Docker on the runner. A Fly image with Postgres baked in and no Docker does not satisfy it, so the follow-up either supplies Docker or changes the shard job. It is not "only the variable".
- **Tools.** `gh`, `psql`, Node 26 and pnpm are assumed, plus sudo for `playwright install --with-deps`. `MATRIX_RUNNER` is a single label, never an array.
- **Timeouts are calibrated on the 4-vCPU hosted runner** (Task 15 Step 4, Task 20). Re-derive them when `MATRIX_RUNNER` changes.
- **`MATRIX_RUNNER` stays unset while the repo is public** (D24): a self-hosted runner on a public repo runs fork PRs. Set it in the same step as the private flip, or accept in writing the mitigation of an ephemeral, secretless runner.
