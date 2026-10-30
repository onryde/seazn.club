# Engine split — Phase 2b (engine repo cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan batch by batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `packages/engine` into `onryde/seazn.club.engine`, publish `@onryde/seazn-engine@1.0.0` to GitHub Packages, and switch every seazn.club consumer to `"@seazn/engine": "npm:@onryde/seazn-engine@^1.0.0"` with the test set provably unchanged.

**Architecture:** Three batches with outward steps between them.
- **Batch R** (seazn.club, before the tag) moves the app tests that still read engine *source paths* onto the engine's *installed surface*, so the move itself changes no test.
- **Batch E** builds the engine repo's tree, CI, Stryker and release workflows in a local clone. Nothing is pushed until an owner go.
- **Batch A** is ONE seazn.club PR, the cutover: delete `packages/engine/**`, install from the registry, rewire CI and deploy auth, retire the monorepo Stryker copy. It merges only after the engine repo's cold Stryker run passes parity.

**Tech Stack:** TS 7 (`typescript-native`), Node 26 `--experimental-strip-types`, pnpm 10.34.5, vitest 4, Stryker, Changesets, GitHub Packages (npm), GitHub Actions, Docker BuildKit secrets, Fly.io.

**Spec:** `docs/superpowers/specs/2026-10-13-engine-split-design.md` §7–§12 and ledger D14–D34, as amended by `docs/superpowers/specs/engine-split/2026-10-29-pad-wave-and-2b-design.md` §6 (D35–D37). Inputs: `docs/superpowers/specs/engine-split/reverse-inventory.md` (the 2b fate of every out-reaching file), and the Phase 2a plan `docs/superpowers/plans/2026-10-25-engine-split-phase2a-placement-repo.md` (the rehearsal; this plan reuses its shape).

**Line numbers below are re-pinned against `origin/main` `17948f93a8`.** The pad wave lands before this plan starts, so every task re-pins again before editing (AGENTS.md class 5).

## Preconditions (all must hold before Pre-flight)

1. The pad wave (P0–P4) is merged to main.
2. `stryker-sizing` is green on main (the mutation session's post-W2e re-measure has landed). The import carries `stryker-measured.json` as it stands at the tag, so a red there is a red engine CI on day one.
3. No open engine-touching PR that the owner wants in 1.0.0 (Pre-flight step 3 lists them).

## Owner decisions baked in (do not re-ask)

- D18/D19: registry is GitHub Packages; published name `@onryde/seazn-engine`; consumed as the alias `@seazn/engine`, zero import changes.
- D16: Changesets; **the owner merges the Version PR**; `1.0.0` at 2b; PR snapshots `0.0.0-pr<N>.<sha>` after.
- D22: fresh history; one import commit citing `onryde/seazn.club@<engine-split-base sha>`; seazn.club is never rewritten.
- D24 + D29: one app cutover PR; rollback = revert it; that PR merges only after the engine repo's cold Stryker run passes parity.
- D36: prod is held. Nothing in this plan deploys prod.
- D37 (recommendation applied): no `scripts/port-engine-branch.sh`; D21's per-PR changed-lines Stryker moves after 2b; CI guards are one grep step each, no selftests, no mutation sweeps on CI/deploy tooling (owner ruling 2026-10-26).
- Owner ruling 2026-10-25 (2a, ruling 4) carried over: **no re-add guard** for `packages/engine/**`.

## Execution topology

- **Clones and worktrees.**
  - Batch R: worktree `~/github/seazn.club-worktrees/engine-split-2b-r`, branch `feat/engine-split-2b-readers`, from a fresh `origin/main`.
  - Batch E: clone `gh repo clone onryde/seazn.club.engine ~/github/seazn.club.engine`. Never build it inside a seazn.club tree.
  - Batch A: worktree `~/github/seazn.club-worktrees/engine-split-2b`, branch `feat/engine-split-2b`, from `origin/main` at or after the tag.
  - Every Bash call starts `cd <abs path> &&`. No `git stash`.
- **Agents (D30).** Per task: `implementer-sonnet`, then `reviewer-sonnet`, looped until clean and the scoped gate is green. Per batch: one Opus `reviewer`; findings to `docs/superpowers/specs/engine-split/reviews/2b-{readers,engine,app}.md`. Dispatch from the main-checkout session with absolute paths; never override `model:`.
- **Gates.** The orchestrator reruns each task's scoped gate itself. Vitest green only from `--reporter=json --outputFile "$(mktemp)"` with `.testResults[].name` confirmed AND `EXIT=0` (unhandled rejections are invisible to the JSON).
- **Outward steps** (`O1`…`O14`) are run by the orchestrator. **OWNER GO** steps wait for an explicit go in chat for that step; a go for one is not a go for the next.

## Global Constraints

- **No engine behaviour change.** Golden ledgers byte-identical at the tag, at the import commit and in `1.0.0`'s tarball; `FOLD_EPOCH` / `FOLD_MINOR` untouched.
- **Test parity (D23), from the JSON reporter, collect-only, `--isolate` on both sides:**
  - engine: tag vs import commit → `unaccounted 0`, identical `numTotalTests` except ledgered moves;
  - app suites importing the engine: `workspace:` vs `1.0.0` → `unaccounted 0`;
  - ledger file `docs/superpowers/specs/engine-split/ledgers/2b.json` (fates `moved`, `rehomed`, `split`, `rewritten`, `retired`; each with a reason).
- **Consumer spec, exactly:** `"@seazn/engine": "npm:@onryde/seazn-engine@^1.0.0"` in `package.json` (root :76), `apps/web/package.json:25`, `packages/reference/package.json:14`, `packages/scheduler/package.json:20`, `tools/matrix/package.json:7`, `tools/bench/package.json:8`.
- **Registry config:** root `.npmrc` (new) holds exactly `@onryde:registry=https://npm.pkg.github.com` and `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`. That is an env reference, never a token.
- **Secrets.** Never print a token. CI uses `GITHUB_TOKEN` with `permissions: packages: read` (write only on the engine repo's publish job). Docker gets the npmrc only through `RUN --mount=type=secret,id=npmrc`; never `--build-arg`, never a layer, never a committed file. Local dev uses the owner's personal `read:packages` token in `~/.npmrc`, set by the owner.
- **Engine repo merges are merge commits only** (the `HEAD^1` gates rely on it).
- **Package versions:** the manifest is `0.1.0` at the tag; the first changeset is `major`, so Changesets cuts `1.0.0`. It must publish through `pnpm publish` (reverse-inventory C-j: npm publish drops `publishConfig.exports`).
- **Scoped tests only.** Never the full vitest, e2e or `seazn-env gate` locally. E2E by `gh workflow run e2e.yml --ref <branch>` only.
- **Never:** delete or rewrite a remote repo, package, version, tag or branch; force-push the engine repo's existing `main`.
- **PR bodies** carry `Matrix rows: none — engine relocation; no rule, fold or sport behaviour changes (golden ledgers byte-identical)`.

## Review Focus

1. **An install path with no registry auth.** Every `pnpm install` in every workflow (26 after mutation.yml and engine-canary.yml leave) needs `packages: read` and `NODE_AUTH_TOKEN`. `stg.yml:76` and `prod.yml:111` (`--prod`) and `e2e.yml` run only after merge or on dispatch, so a missing one is first seen red on main. Pinned in Task A2, `every install step authenticates` (counts the steps; zero fails).
2. **The token reaching an image layer.** `ci.yml:721,745` and `stg.yml:164`/`prod.yml:193` must pass the npmrc as a BuildKit secret. Pinned in Task A1, `Dockerfile installs with the npmrc secret only` (no `ARG`/`ENV` carrying a token; the install `RUN` has the mount).
3. **A published tarball without `publishConfig.exports`.** It installs, then resolves `./src/*.ts` paths the tarball does not carry. Pinned in O8: `pack-proof` runs against the PUBLISHED `1.0.0`, not a local pack.
4. **A checkout that still resolves the old workspace engine.** A leftover `node_modules/@seazn/engine → ../../packages/engine` symlink in a dev checkout or worktree gives a green against stale source (class 14). Pinned in Task A1, `@seazn/engine resolves to the registry package` (resolved path is under `.pnpm/@onryde+seazn-engine@`, version equals the lock's).
5. **An engine bump that skips the matrix.** After 2b no PR touches `packages/engine/**`, so `matrix-rows` (`ci.yml:2309`) and R27's `pr-rows.ts` would never fire on a rule change. Pinned in Task A2, `pr-rows treats an @onryde/seazn-engine version change in pnpm-lock.yaml as engine-touching`.

## False premises found while planning (AGENTS.md class 5)

1. **Spec §7 step 2: "owner approves creating `onryde/seazn.club.engine`".** It already exists: PUBLIC, created 2026-10-13, one commit `357585d872 first commit` (README only), squash/rebase/merge all allowed, `main` unprotected. The step becomes "owner sets merge-commit-only and branch protection" (O4).
2. **Spec §11.4: "the import commit has no parent".** It has one, the README commit. The `HEAD^1` gates must treat "file absent at `HEAD^1`" as no baseline (check the floor file against itself), never as a pass by crash. Pinned in Task E2. The README commit is kept (no force-push).
3. **`@onryde/seazn-engine` already exists on GitHub Packages:** PRIVATE, linked to `onryde/seazn.club`, 28 canary versions (latest `0.0.0-canary.29.g17948f93a`). A package linked to one repo does not accept publishes from another until the owner grants it: O5 adds `onryde/seazn.club.engine` with **Write** under "Manage Actions access" (the 2a GHCR "source repo" trap, npm flavour). seazn.club and seazn.club.capture need **Read**.
4. **Spec §7 step 6 cites `ci.yml:237,257,283,308,811`** for the root steps running the engine's vitest. Live: `ci.yml:247,267,293,320,368,391,950`, plus `scripts/ci-local.sh:358` and `scripts/mutate.ts:54`.
5. **Spec §7 cites `ci.yml:1751` for `matrix-rows`.** Live: `:2309` (job), filter `:2328`; `matrix-sample` `:2370`. `ci.yml:113` (single-sport ratchet), `:126` (Stryker floor), `:105` (`engine:boundary`) are unchanged; the schema-snapshot gate is `:175-184` (not 171-176); engine tests `:598`, `sim:matrix` `:606`, engine-pack `:662`; path filters `:564`, `:648`.
6. **`prod.yml:105` runs `packages/engine/scripts/release-epoch-report.ts`** (the #964 epoch report). The spec does not mention it; it breaks when the tree leaves. Task E4 moves the report into the engine repo's release (the Version PR body and GitHub Release), and Task A2 deletes the prod.yml step.
7. **`tools/matrix/single-sport.ts:104` scopes ONLY engine dirs** (`packages/engine/src/{scheduling,competition}`). Spec §10.1 says "duplicated"; there is nothing left to ratchet app-side. The ratchet moves wholly to the engine repo (Task E2) and `ci.yml:113` is deleted.
8. **Reverse-inventory rows 5, 7, 8, 9, 22, 23 are not done:** the testkit exports no golden corpora or `__fixtures__`, and `applicability.test.ts:43-49` still reads `packages/engine/src/sports`. Batch R does them before the tag; they need an engine change (a testkit export), which reverses D32f ("golden corpora do not ship") for the testkit only. See Deviation b.
9. **Amendment §6.1 lists the freeze notice AFTER the baseline Stryker run.** The freeze must start at the tag, or engine PRs merged during the ~11 h baseline are missing from the import. O1 sends the notice at the tag. See Deviation a.
10. **`engine-canary.yml` (reverse-inventory row 13, fate M) has nothing to do in the engine repo:** canaries were the Phase 1 channel; PR snapshots and releases replace them, and its `proof` job is `ci.yml`'s engine-pack. It is retired, not moved (ledger fate `retired`).
11. **The plan never mentions the fold-epoch guard (found by the Batch R close review, I2).** `ci.yml:132` runs `pnpm --filter @onryde/seazn-engine --fail-if-no-match fold-epoch:check --against HEAD^1` in `gates`, and the "fold-epoch guard CI wiring" describe (`tools/matrix/__tests__/ci-wiring.test.ts:572-639`, 4 tests, added in 1e-2 after the 1d inventory) reads `packages/engine/package.json` (:573), `scripts/fold-epoch-guard.ts` (:612), the corpora directory (:624) and `src/stats/stats.ts` (:632). Unplanned, the cutover's `gates` job reds (`--fail-if-no-match` finds no workspace project), the ci-wiring file reds, and the engine repo ships with no D15/D26 check that a golden-stream change carries an epoch bump. It is a `HEAD^1` gate too, so false premise 2's absent-baseline case applies. Task E1 moves the describe, E2 adds the guard to `gates`, A2 deletes `ci.yml:132` (reverse-inventory row 29).
12. **The 1d reverse inventory was not complete (found by the Batch R close review, I1 and I3).** Four readers were added after it or missed by its patterns: `w2e-retirement.test.ts` (row 28, W2e, 2026-10-29; fixed in Batch R), the fold-epoch describe above (row 29), `scripts/__tests__/prod-release-epoch-workflow.test.ts` (row 30: module-scope `readdirSync(packages/engine/src/sports)` at :215, so all 30 collected tests fail to collect at the move) and `tools/matrix/__tests__/lint-warnings-gate.test.ts` (row 31: `EXPECTED` :53 and `PROBE_FILE` :172 pin `packages/engine` as a lint workspace). Rows 30 and 31 import no `@seazn/engine`, so A3 step 2's `git grep -l '@seazn/engine'` list would have missed them and their retirement or rewrite would have been unledgered, a hole in D23 parity. Both are now in A3's file list and parity list.

## Deviations from the spec (for owner review)

- **a. Freeze ~1 day, with both Stryker runs in parallel.** The baseline full run (monorepo, on the tag) and the cold run (engine repo, on the import commit) are the same tree, so they start together at O3/O6 instead of back to back. Sequential would make the freeze ~2 days. If the free runner pool queues them, the result is no slower than sequential.
- **b. The testkit ships the golden corpora and the bye-deltas fixture** (`@seazn/engine/testkit`, test-only, not a phone subpath; under `dist/sports/**` and `dist/sport/__fixtures__/`, layout preserved; the tarball grows 2,395,786 → 2,626,388 B, +9.6%), so the four app suites that read them (reverse-inventory rows 5, 7, 8, 9) keep their tests. Reverses D32f for the testkit. The alternative, retiring those 18 tests, loses public-site coverage.
- **c. No temporary "freeze" CI check.** The freeze is the AGENTS.md dated line plus messages to the live sessions (O1); every merge already needs an owner go. A CI check would also fail the cutover PR itself.
- **d. The epoch report moves to the engine release** (false premise 6), not to the app's prod deploy.

---

# Batch R — readers onto the installed surface (seazn.club, one PR, before the tag)

Scoped vitest from the package dir, `DATABASE_URL=` empty for DB-free files.

### Task R1: testkit exports the corpora and the bye-deltas fixture; the four app readers use it

**Files:**
- Create: `packages/engine/src/testkit/corpora.ts`
- Modify: `packages/engine/src/testkit/index.ts`; `packages/engine/package.json` (`build:dist` gains a third step, `scripts/copy-dist-data.mjs`, that copies the corpora to `dist/sports/**/<key>.golden.json` and the fixture to `dist/sport/__fixtures__/bye-deltas.json`, the SAME relative paths as under `src/`, so one `../sports` URL is right from both; `files` already carries `dist`, so it does not change. **As built in Batch R, not the `dist/testkit/corpora/` first written here**); `packages/engine/test/publish-manifest.test.ts` (the pin)
- Modify (readers): `apps/web/src/server/engine-db/__tests__/double-walkover-seating.test.ts:420`, `apps/web/src/server/public-site/__tests__/public-player-matches.test.ts:2059-2062`, `apps/web/src/server/public-site/__tests__/timeline.test.ts:119,143-147`, `apps/web/src/components/public-site/__tests__/player-matches.test.tsx:330-336`

**Interfaces:**
- Produces: `goldenCorpora(): ReadonlyArray<{ sport: string; key: string; corpus: unknown }>` (every `src/sports/**/*.golden.json`, sorted by path) and `byeDeltas(): unknown` (`src/sport/__fixtures__/bye-deltas.json`), both from `@seazn/engine/testkit`. Resolved relative to the module (`import.meta.url`), so they work from `src/` in the workspace and from `dist/` when installed.

- [ ] **Step 1:** In `packages/engine/src/testkit/corpora.test.ts`, test `goldenCorpora returns every corpus on disk`: its length equals a fresh `readdirSync(..., { recursive: true })` count of `*.golden.json` under `src/sports` (non-zero), and each `corpus` deep-equals the file's JSON. Test `byeDeltas equals the fixture file`. Run; expect FAIL (module missing).
- [ ] **Step 2:** Implement `corpora.ts`; export from the testkit barrel. Run; expect PASS.
- [ ] **Step 3:** `test/rules-reference.test.ts` pins the testkit barrel's disk-reading closure to exactly `rules-reference.ts` (reverse-inventory D.2). Re-pin it to `{rules-reference.ts, corpora.ts}`; that is the deliberate change, not a weakening.
- [ ] **Step 4:** Switch the four readers to the testkit. Each file's test count is unchanged (collect-only before/after, parity script, `unaccounted 0`).
- [ ] **Step 5:** `pack:proof --only node` shows the corpora in the tarball and `goldenCorpora().length` from the INSTALLED tarball equals the source count.
- [ ] **Step 6:** Commit `test(engine-split): read golden corpora and bye deltas through @seazn/engine/testkit`.

Four types: unit (corpora tests); regression (the four reader files, counts unchanged); smoke and e2e n/a (test-only surface, no product path), stated in the PR.

### Task R2: the matrix's tie and schema readers use the public API

**Files:** `tools/matrix/__tests__/applicability.test.ts:40-59`, `tools/matrix/__tests__/streams.test.ts:32-36`, `tools/matrix/__tests__/scenarios.test.ts:1377-1378`.

- [ ] **Step 1:** Replace the `<sport>.schema.json` read with each module's exported `configSchema`, the `kind: "tie"` source scan with the module's tie declaration (reverse-inventory rows 22, 23), and `scenarios.test.ts:1377`'s `catalog.ts` text read with the `LineupIssue` kinds from the engine's exported type/const (row 25a). If a module does not export what is needed, STOP and report: adding an engine export is a scope change for the owner.
- [ ] **Step 2:** Mutate once per file: drop one sport's tie declaration in a scratch copy; the test reds.
- [ ] **Step 3:** Parity: collect-only before/after on the three files, `unaccounted 0`. Commit.

### Batch R close

Opus review → `reviews/2b-readers.md` (verdict NEEDS FIXES at `a73b34e260`; the fixes, with what each did, are appended to that file). PR with the Matrix-rows line and "smoke and e2e n/a (test-only surface)"; CI green; **OWNER GO** to merge. Batch R lands before the tag, so its parity ledger is its own, `ledgers/2b-readers.json` (the Global Constraints' `ledgers/2b.json` starts at the tag, A3); say so in the PR body. The review's I1 (`w2e-retirement.test.ts`, reverse-inventory row 28) is a Batch R reader and was fixed here.

---

# Pre-flight (orchestrator, read-only)

- [ ] **1.** `git fetch origin && git log -1 --format=%H origin/main` → `BASE_SHA`. Confirm the preconditions and that Batch R is in it.
- [ ] **2.** `gh repo view onryde/seazn.club.engine --json isEmpty,defaultBranchRef` and `gh api repos/onryde/seazn.club.engine/commits --jq length` → expect one commit, README only. Anything else: STOP and ask.
- [ ] **3.** Open PRs touching the engine: `for n in $(gh pr list --state open --json number --jq '.[].number'); do gh pr diff $n --name-only | grep -q '^packages/engine/' && echo "PR $n"; done`. Each is merged before O1 or ported after (AGENTS.md note, Task E1).
- [ ] **4.** `git tag engine-split-base $BASE_SHA` locally.

# O1 — OWNER GO: push the tag; the freeze starts

- [ ] `git push origin engine-split-base`; confirm with `git ls-remote --tags origin engine-split-base`.
- [ ] Add a dated line to seazn.club `AGENTS.md` under Standing project rules ("2b freeze from <date>: no PR touching `packages/engine/**` merges until the cutover PR merges"), on the Batch A branch (it lands with the cutover; the messages are the live notice).
- [ ] Message every live session touching the engine (mutation, format-matrix, capture, R4/sponsors if active): the freeze, its reason, and its expected end. As a recommendation with reasons (class 17).

# O2 — the baseline Stryker run (O-6)

- [ ] `gh workflow run mutation.yml -R onryde/seazn.club --ref engine-split-base -f group=all`. Record the run id. It runs in parallel with Batch E (Deviation a). Its per-family scores are the parity baseline for O6.

---

# Batch E — the engine repo (local clone, nothing pushed)

### Task E1: Import tree, engine-local config, AGENTS.md, parity ledger

**Files (engine clone):** the tree from `git -C ~/github/seazn.club archive engine-split-base packages/engine | tar -x --strip-components=2`; root `package.json` (from `packages/engine/package.json`), `pnpm-workspace.yaml`, `.gitignore`, `LICENSE.md`, `.npmrc`, `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), moved tests; seazn.club `docs/superpowers/specs/engine-split/ledgers/2b.json` (in the Batch A worktree).

**Interfaces:** Produces the engine repo tree whose `vitest run --isolate -t __parity_collect_only__` report is the "after" side of the engine parity.

- [ ] **Step 1:** Extract the tree. Apply reverse-inventory Section C, one row each:
  - C-a/C-b: `packageManager` and exact `devDependencies` for `next`, `react`, `typescript`, `typescript-native` (the versions at the tag) in the engine `package.json`; `pack-proof/run.mjs:53,61` read the repo's own manifest.
  - C-c: `typecheck`/`build:dist` call `./node_modules/typescript-native/bin/tsc`; re-pin `test/publish-manifest.test.ts:66`.
  - C-d: the `@babel/helper-module-transforms@<8>@babel/core` and `posthog-node>rxjs` overrides move to the engine's `pnpm-workspace.yaml` only if the engine lock needs them (check `pnpm install` output for the unmet peer); `test/pack-proof.test.ts:388` reads the engine's file.
  - C-e / A2-f: `.gitignore` carries `dist/`, `sim-report.json`, `reports/mutation/`, `SURVIVORS.md`, `.stryker-tmp/`.
  - C-f: drop `eslint.config.mjs:19`'s import of `../../scripts/lib/tools-import-guard.mjs` (the engine repo has no `tools/` to guard against).
  - C-g: `repository` = `{ "type": "git", "url": "https://github.com/onryde/seazn.club.engine" }`, no `directory`; re-pin `publish-manifest.test.ts:56`.
  - `MUTATION.md:549` "11.5 h" → "~10.8 h" (spec §11.8).
- [ ] **Step 2:** Move in the M rows: reverse-inventory rows 4 (K7 only), 6 (engine half), 13 (the test is retired with the workflow, false premise 10), 15 (:59-65), 17 (the `mutation.yml` describe), 18 (engine-pack and floor halves), **29 (the fold-epoch guard describe, `ci-wiring.test.ts:572-639`, 4 tests, re-rooted; false premise 11)**, 25 (the `assertLineup(` caller scan, now `scenarios.test.ts:1566-1571`), 26 (`core.void` pin), plus `tools/matrix/single-sport.ts`, `tools/matrix/lib/harness-path.ts` and `tools/matrix/catalogue/single-sport-baseline.json` as `scripts/single-sport.ts` etc. (false premise 7), re-rooted. Each test keeps its title so its id matches the ledger's `moved` entry (row 29's four tests are `moved` entries in `ledgers/2b.json`).
  Also keep, in the engine repo where reading `src/` is legitimate, a source-scan ⇔ `reachableResultKinds` parity test: Batch R's matrix readers now take the tie-capable sports from the module's own `reachableResultKinds`, so a future sport whose fold writes `kind: "tie"` but forgets the declaration would hide from both the LEVEL_PROBES guard and the streams tie sweep (review m1).
- [ ] **Step 3:** `.npmrc`: `@onryde:registry=https://npm.pkg.github.com`. `pnpm install`; `pnpm build:dist`; `pnpm typecheck`. Expected: all exit 0.
- [ ] **Step 4:** `AGENTS.md`: what lives here and where the history is (`onryde/seazn.club@<tag sha>`, D22); registry auth for local dev (D18); the dev loop (§9: `link:` override, paired PRs, never commit `link:`); the in-flight porting note (D37):
  ```
  git -C ~/github/seazn.club diff origin/main...<branch> -- packages/engine | git apply -p3
  ```
  then open the engine PR and the paired app PR. Plus `Matrix rows:` in every engine PR body (TEST-STRATEGY rule 9).
- [ ] **Step 5: Parity.** Collect-only at the tag (`cd <seazn.club at tag>/packages/engine`, plus the M-row source files) vs the clone root. Write `ledgers/2b.json` entries for every moved/retired id. `node scripts/lib/test-parity.mjs --before <tag-engine.json>=<root> --before <tag-movers.json>=<root> --after <clone.json>=<clone> --ledger ledgers/2b.json` → `unaccounted 0`, exit 0. Paste the summary line.
- [ ] **Step 6:** Commit `chore: import @onryde/seazn-engine from onryde/seazn.club@<tag sha>` (one commit, D22). Not pushed.

Four types: regression (parity, golden ledgers byte-identical: `git diff --no-index` of every `*.golden.json` vs the tag is empty); unit (moved tests collect); smoke/e2e via Batch A proofs.

### Task E2: Engine CI

**Files (engine clone):** `.github/workflows/ci.yml` (new).

Jobs, ported from seazn.club `ci.yml` with `--workspace packages/engine` / `--filter ./packages/engine` removed:
- `gates`: `engine:boundary` + RN-safe rule (`:105`); single-sport ratchet `--against HEAD^1` (`:113`, now `scripts/single-sport.ts`); Stryker floor `--check-file-against HEAD^1` (`:126`); **fold-epoch guard `fold-epoch:check --against HEAD^1` with `--fail-if-no-match` dropped (`:132`; the D15/D26 guard must survive the move, false premise 11; its wiring test moved in E1 step 2)**; schema-snapshot drift (`:175-184`); lint; tsc.
- `test`: `test:coverage` (`:598`), `SIM_SEEDS=5 sim:matrix` (`:606`), golden ledgers.
- `engine-pack`: `node pack-proof/run.mjs` (`:662`).
- `changeset`: PR fails with no `.changeset/*.md`; fails a `FOLD_EPOCH` change under a non-major changeset, or a `FOLD_MINOR`-only change under a patch (§8).
- `downstream` (§9.3): check out `onryde/seazn.club@main`, install the PR snapshot, run app `tsc`, `apps/web/src/lib/match-rules/__tests__/*.contract.test.ts`, `tools/matrix` unit tests. No DB.

- [ ] **Step 1:** Write the workflow. `permissions: contents: read` at the top; nothing else needs more.
- [ ] **Step 2: the missing-`HEAD^1`-file case (false premise 2).** The floor and ratchet gates on the import commit read `HEAD^1` = the README commit, where neither file exists. Add the case to the existing gate tests (`stryker-floor`, `single-sport` and `fold-epoch-guard` tests; the fold-epoch guard also reads `HEAD^1`): "baseline file absent at `HEAD^1` → check the file against itself, exit 0 with a notice"; and "`HEAD^1` unresolvable (shallow clone) → exit non-zero". Run red, fix, run green. Mutate once: make the absent case return early before checking → the self-check test reds.
- [ ] **Step 3:** `actionlint` the file (if installed; else `gh workflow view` after push). Commit.

### Task E3: Stryker in the engine repo

**Files (engine clone):** `.github/workflows/mutation.yml` (from seazn.club, re-rooted), `stryker.config.mjs`, `stryker.groups.mjs` (paths only).

- [ ] **Step 1:** Move `mutation.yml`. Rename `vars.MATRIX_RUNNER` → `vars.STRYKER_RUNNER` (`:175,182,213`; D32g); weekly gate on `vars.STRYKER_WEEKLY_ENABLED` (D29); the public-visibility refusal message names `STRYKER_RUNNER`. Paths drop `packages/engine/`.
- [ ] **Step 2:** Incremental files: each leg uploads its incremental json as an artifact (90 days); restore tries the cache, then the latest artifact (§11.5). Reuse the existing steps if present; otherwise add the two steps, no new tooling.
- [ ] **Step 3:** The moved `matrix-workflow` describe (E1 step 2) passes against the moved workflow. Commit.

### Task E4: Release (Changesets) and the epoch report

**Files (engine clone):** `.changeset/config.json`, `.changeset/initial-1-0-0.md` (`"@onryde/seazn-engine": major`, body "First stable release from onryde/seazn.club.engine; no behaviour change from 0.0.0-canary.<tag>"), `.github/workflows/release.yml`.

- [ ] **Step 1:** `release.yml` on push to `main`: `changesets/action` with `publish: pnpm publish -r --no-git-checks` (C-j), `version: pnpm changeset version`; `permissions: contents: write, pull-requests: write, packages: write` on that job only; `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- [ ] **Step 2:** PR snapshot job (`pull_request`, same-repo heads only): `pnpm changeset version --snapshot pr${{ github.event.number }}` then publish with dist-tag `pr`. `packages: write` on that job only.
- [ ] **Step 3:** The epoch report (false premise 6): the Version PR step runs `node --experimental-strip-types scripts/release-epoch-report.ts --from <last v tag or the import commit> --to HEAD --summary <file>` and appends the result to the Version PR body via the action's `commitMessage`/PR body hook; the same text goes in the GitHub Release. One happy-path check: on the import, it reports "no previous tag; nothing to compare".
- [ ] **Step 4:** Commit.

### Batch E close

Opus review of the clone → `reviews/2b-engine.md` (in the Batch A worktree): TEST-STRATEGY's four questions; confirm golden ledgers byte-identical; confirm no workflow grants more than listed.

---

# Outward sequence O3–O9 (the engine repo goes live)

- [ ] **O3 — OWNER GO: push the clone.** `cd ~/github/seazn.club.engine && git push origin main` (fast-forward on top of the README commit; never force). Watch `gh run list -R onryde/seazn.club.engine --limit 5`. Expected: `ci` green (the `HEAD^1` notices in the gate logs), `release` opens a "Version Packages" PR proposing `1.0.0`.
- [ ] **O4 — OWNER (settings):** merge commits only (`gh api -X PATCH repos/onryde/seazn.club.engine -F allow_squash_merge=false -F allow_rebase_merge=false`, run by the orchestrator on the go); branch protection on `main` with required checks `gates`, `test`, `engine-pack`, `changeset`; no force-push, no deletion; `enforce_admins=false` (the placement settings).
- [ ] **O5 — OWNER (GitHub UI): package access.** Package `seazn-engine` → Package settings → Manage Actions access: add `onryde/seazn.club.engine` (**Write**), confirm `onryde/seazn.club` (**Read**), add `onryde/seazn.club.capture` (**Read**). Visibility stays private (owner's call; private needs nothing else since every install authenticates).
- [ ] **O6 — The cold Stryker run.** `gh workflow run mutation.yml -R onryde/seazn.club.engine --ref main -f group=all`. When both O2 and O6 finish: every family ≥ its floor in `stryker-floor.json` AND within ±0.5 of O2's score. Write both tables into `reviews/2b-engine.md`. Outside ±0.5: investigate before O9; do not merge the cutover.
- [ ] **O7 — OWNER GO: merge the Version PR.** `1.0.0` publishes; tag `v1.0.0` and a GitHub Release appear. Confirm: `gh api /orgs/onryde/packages/npm/seazn-engine/versions --jq '.[0].name'` → `1.0.0`.
- [ ] **O8 — The published tarball is right (Review Focus 3).** In a scratch dir outside both repos, install `@onryde/seazn-engine@1.0.0` with the owner's `~/.npmrc`, and run the engine's `pack-proof` against the installed package (`--tarball` from `npm pack @onryde/seazn-engine@1.0.0`). Expected: node, next, rn and types fixtures green; `./pad` and `./testkit` resolve to `dist/`; the node leg's `corpora.mjs` reads `dist/sports/**/*.golden.json` and `dist/sport/__fixtures__/bye-deltas.json` from the published package, each equal to the source's digest (11 corpora).
- [ ] **O9 — Request to capture's owner (class 17):** a capture build that installs `@seazn/engine@^1.0.0` through the alias and bundles `@seazn/engine/pad` under Metro/Hermes (spec §7 proof; R2). Sent as a recommendation with the reason; the result is recorded, not assumed.

---

# Batch A — the app cutover (worktree `engine-split-2b`, one PR)

Starts after O7 (it installs `1.0.0`). Pushed after Batch A close.

### Task A1: Install from the registry; Docker and deploy auth

**Files:** delete `packages/engine/**`; the six manifests (Global Constraints); `.npmrc` (new); `pnpm-workspace.yaml:57-76` (delete the S4 overrides and their comment); `pnpm-lock.yaml` (regenerated); `Dockerfile:15` (delete), `Dockerfile:23-24` (the secret mount); root `package.json:39,40,43,52-54` (drop the engine clauses and `sim`, `sim:replay`, `engine:boundary`; reverse-inventory A2-h); root `devDependencies` gains `vitest` at the engine's tag version (S3); `turbo.json`, `packages/reference/turbo.json`, `packages/scheduler/turbo.json` (A2-k); `scripts/reference-boundary.ts:87` (`engineDir()` → `node_modules/@onryde/seazn-engine`, A2-j); test `scripts/__tests__/registry-install.test.ts` (new).

**Interfaces:** Consumes `@onryde/seazn-engine@1.0.0` (O7).

- [ ] **Step 1: tests first** in `scripts/__tests__/registry-install.test.ts`:
  - `@seazn/engine resolves to the registry package`: `realpathSync(require.resolve("@seazn/engine/core"))` contains `/.pnpm/@onryde+seazn-engine@`, and the installed `package.json` `version` equals the `@onryde/seazn-engine` version in `pnpm-lock.yaml`. Checked from each of the six consumers' dirs (count 6; zero fails).
  - `every consumer pins the alias`: each of the six manifests has exactly `npm:@onryde/seazn-engine@^1.0.0`.
  - `Dockerfile installs with the npmrc secret only`: the `pnpm install` `RUN` carries `--mount=type=secret,id=npmrc,target=/root/.npmrc`; no `ARG`/`ENV` line names `NODE_AUTH_TOKEN`, `NPM_TOKEN` or `_authToken`; no `COPY .npmrc`.
  Run; expect FAIL.
- [ ] **Step 2:** Make the edits above; `pnpm install`. Run; expect PASS. Mutate once: point one manifest back to `workspace:` in a scratch copy → the first two tests red.
- [ ] **Step 3:** CI and deploy auth (Docker): `ci.yml:721,745` `docker build --secret id=npmrc,src=$RUNNER_TEMP/npmrc`, the file written from `NODE_AUTH_TOKEN` with `umask 077` and never echoed; `stg.yml:164` and `prod.yml:193` `docker/build-push-action` pass the npmrc through the action's `secrets` input (`npmrc=//npm.pkg.github.com/:_authToken=${{ secrets.GITHUB_TOKEN }}`), never `build-args`, with `permissions: packages: read` on those jobs.
- [ ] **Step 4:** Local proof: `pnpm --filter @seazn/web exec tsc --noEmit` exit 0; `npm run sync:sports` against a local fresh DB imports `@seazn/engine/sports` from the registry package (seazn-local-env skill recipe; `show data_directory` is yours). Commit.

Four types: unit (the three tests); regression (parity, A3); smoke (stg `sync-sports`, O12); e2e (O11).

### Task A2: CI rewiring and the registry guards

**Files:** `.github/workflows/ci.yml`, `e2e.yml`, `matrix-truth.yml`, `bench.yml`, `help-shots.yml`, `build-guard.yml`, `stg.yml`, `prod.yml`; delete `mutation.yml`, `engine-canary.yml`; `tools/matrix/ci/pr-rows.ts` and its test; `scripts/ci-local.sh:358`; delete `scripts/mutate.ts` (moved, A2-i); test `scripts/__tests__/registry-auth-workflows.test.ts` (new).

- [ ] **Step 1: tests first.**
  - `every install step authenticates` (Review Focus 1): for every workflow, every step whose `run` has `pnpm install` / `npm ci` sits in a job (or workflow) with `permissions.packages: read` and has `NODE_AUTH_TOKEN` in its env. Reports the count (expect 26; zero fails).
  - `pr-rows treats an @onryde/seazn-engine version change in pnpm-lock.yaml as engine-touching` (Review Focus 5): a lock diff moving `1.0.0 → 1.1.0` requires declared rows; a lock diff not touching the engine does not. In `tools/matrix/ci/__tests__/pr-rows.test.ts`.
  Run; expect FAIL.
- [ ] **Step 2: ci.yml.**
  - delete `:105` (`engine:boundary`), `:113` (single-sport, moved), `:126` (floor), **`:132` (fold-epoch guard, moved to the engine repo's `gates` in E2; its `ci-wiring.test.ts:572-639` describe left in E1, so no block is left pointing at the deleted step, false premise 11)**, `:175-184` (schema snapshot), the engine test job (`:564` filter, `:598`, `:606`), engine-pack (`:648`, `:662`);
  - the seven root vitest steps (`:247,267,293,320,368,391,950`) and `scripts/ci-local.sh:358` use the root `./node_modules/.bin/vitest`;
  - `matrix-rows` filter `:2328`: drop `packages/engine/**` (`pnpm-lock.yaml` already triggers it);
  - one step in `gates`: the two registry guards as one grep each: `! git grep -nE '"@seazn/engine": *"(link|file):' -- '*package.json'` and `git grep -c 'npm:@onryde/seazn-engine@' -- '*package.json'` equals 6.
- [ ] **Step 3:** Every install step in the eight workflows gets `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and its job `packages: read`. `stg.yml:76`, `prod.yml:111` included. Delete `prod.yml`'s epoch-report step (`:89-110`, "Report FOLD_EPOCH bumps since the previous release"; false premise 6). `pr-rows.ts` learns the lock rule.
- [ ] **Step 4:** Run the two tests; expect PASS. Mutate once: drop `NODE_AUTH_TOKEN` from `stg.yml`'s install → the sweep reds. Commit.

### Task A3: Rehome the remaining readers (reverse inventory)

**Files:** per reverse-inventory Section A rows 1, 2, 3, 6, 10, 11, 12, 14, 15, 16, 19, 20, 21, 24, **30 and 31**, and A2 rows a, b, l (row 28 was done in Batch R; row 29 moved in E1): each takes its stated fate (**I** reads the installed package; **U** edits; **D** deletes with the reason in the ledger; the M halves were moved in E1 and are deleted here).

- [ ] **Step 1:** Apply each row. `status-set-sweep.test.ts` (row 3) drops `packages/engine/src` from `ROOTS`; the engine-side sweep is not added (no engine row exists, reverse inventory row 3). `lock-isolation.test.ts` (row 20) loses its two override cases with the overrides. `rules-reference.test.ts` (row 16) runs only in the engine repo. **Row 30** `scripts/__tests__/prod-release-epoch-workflow.test.ts` is `retired` with the `prod.yml` step A2 deletes (30 tests, one ledger entry each; or `moved` with E4's report if E4 ports the wiring pins). **Row 31** `tools/matrix/__tests__/lint-warnings-gate.test.ts` drops its two `packages/engine` entries (`EXPECTED` :53, `PROBE_FILE` :172), `rewritten`.
- [ ] **Step 2: App parity.** Collect-only of every app/tools/scripts/reference test file that imports `@seazn/engine` or appears in the reverse inventory (list the files with `git grep -l -a '@seazn/engine' -- '*.test.ts' '*.test.tsx'` plus the inventory rows; **rows 30 and 31 import no `@seazn/engine`, so the grep alone misses them: name `scripts/__tests__/prod-release-epoch-workflow.test.ts` and `tools/matrix/__tests__/lint-warnings-gate.test.ts` explicitly**; record the count), at the tag vs this branch. `test-parity.mjs` with `ledgers/2b.json` → `unaccounted 0`, exit 0. Paste the line.
- [ ] **Step 3:** Scoped run (not collect) of the files this task edited, JSON reporter, EXIT=0. Commit.

### Batch A close

Opus review → `reviews/2b-app.md`. Then push the branch and open the PR (Matrix-rows line; links the engine repo `v1.0.0`).

# Outward sequence O10–O14 (the web cutover)

- [ ] **O10 — PR CI green**, including both docker builds with the secret (`ci.yml:721,745`) and the matrix sample on the pinned version.
- [ ] **O11 — E2E by dispatch:** `gh workflow run e2e.yml --ref feat/engine-split-2b`. All three jobs green, including the pad specs (`scorepad-skins.spec.ts`, `mobile.spec.ts`) as whole files. Read the run's own headSha (it is the branch head, since `--ref` is the branch).
- [ ] **O12 — Proof checklist complete** (spec §7 "Proof", amended): engine parity (E1 step 5) and app parity (A3 step 2) lines; O6 Stryker table; O8 published-tarball proof; O9 capture result or "pending with capture's owner"; O10 docker builds; O11 e2e. Nothing is ticked from a message alone.
- [ ] **O13 — OWNER GO: merge the cutover PR.** Only after O6 passed parity. Then watch main: `stg.yml` green, including `pnpm install --prod` from the registry and `Sync sport catalog` (`stg.yml:96`) importing `@seazn/engine/sports` from it. Paste the run URL.
- [ ] **O14 — Owner stg pass of the pad** (amendment §6.6): one scored match on stg with the v3 pad, any sport. Until then, no merge in the engine repo (the rollback window). Then message the live sessions: the freeze is over; engine changes now go to `onryde/seazn.club.engine` with a paired app PR.

## Rollback (spec §7, amended §6.6)

- Before O14: revert the cutover PR in seazn.club (it restores `packages/engine` and `workspace:` in one revert). The engine repo, its `1.0.0` and the package stay (never deleted).
- After the first post-cutover engine-repo merge, rollback is a forward fix only.
- Prod is not involved (D36). The first prod deploy after 2b ships W2 and the split together, after a longer stg soak (amendment §6.6).

## After 2b (not in this plan)

- D21: the per-PR changed-lines Stryker run in the engine repo, advisory, then blocking at a dated checkpoint.
- O-2 theme contract, with capture S2.
- O-7 going private (§13): `STRYKER_RUNNER` is already the variable to set.
