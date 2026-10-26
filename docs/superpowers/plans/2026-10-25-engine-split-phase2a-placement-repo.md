# Engine split — Phase 2a (placement repo split) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan batch by batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Python placement service and its proto from seazn.club into `onryde/seazn.club.placement`. That repo becomes public and publishes one public GHCR image. seazn.club then vendors a sha-pinned copy of the proto and pulls that image everywhere it builds one locally today.

**Architecture:** Two batches with outward steps between them.
- **Batch P** builds the new repo's tree, CI and deploy workflows in a local clone of the empty remote. Nothing in seazn.club changes.
- **The outward steps** (§ "Outward sequence") push that clone, publish the image and prove the stg deploy. Every one of them that changes something outside this machine waits for an explicit owner go.
- **Batch W** is ONE seazn.club PR in three tasks: vendor the proto, pull the pinned image, then delete the old tree (no re-add guard; owner ruling 2026-10-25).

The pinned image is `ghcr.io/onryde/seazn-placement:<placement sha>`. Its tag is read from `packages/scheduler/VENDORED.json` and never typed into a workflow.

**Tech Stack:**
- Placement: Python 3.14 (CPython 3.14.6 image), pytest, grpcio-tools.
- Contract: buf CLI v2 config (new), protoc 35.1.0 and ts-proto 2.12.0 (unchanged).
- Web: Node 26 `--experimental-strip-types`, pnpm 10.34.5, vitest 4.
- CI and deploy: GitHub Actions (`background:`/`wait:` steps, `services:` containers), GHCR, Fly.io (`flyctl`).

**Spec:** `docs/superpowers/specs/2026-10-13-engine-split-design.md`, §6 (:304-344), §10.2-10.4, §13, and ledger D12, D13, D18, D22, D27. Its §6 line numbers are stale.

**Re-pinned facts:** `.superpowers/handoff/2026-10-13-engine-split/phase2a-facts.md`. It is gitignored and lives in the main checkout only. Pinned against `origin/main` `46b8c5739b`.

**Re-pin every line number before editing** (AGENTS.md class 5).

## Owner decisions baked in (do not re-ask)

- `onryde/seazn.club.placement` already exists: private, empty, with no default branch. It is flipped PUBLIC at import.
- `buf breaking` runs in the placement repo's CI only, against `main`. buf is new: nothing in either repo uses it today.
- The import commit has no base, so the buf step skips and says so.
- Placement publishes ONLY the public image `ghcr.io/onryde/seazn-placement:<placement sha>`. Web CI, e2e and bench pull it without auth (D18). The owner sets the GHCR package's visibility in the GitHub UI, because there is no REST endpoint for it.
- The owner sets `FLY_TOKEN` in the new repo. The Fly apps stay `placement` and `placement-stg`.
- The tag `placement-split-base` points at `093ad1d19ef068950e72571309320e5861dd3255`. Re-verify that at execution (pre-flight step 1).
- Fresh history (D22): one import commit, citing `onryde/seazn.club@<tag sha>`. The new repo's AGENTS.md says where the pre-cutover history lives.

## Execution topology

**Worktrees and clones**
- **Batch P** works in a clone of the empty remote: `gh repo clone onryde/seazn.club.placement ~/github/seazn.club.placement`. That path is also the checkout `seazn-env` later points at (step O10). Never build it inside a seazn.club tree.
- **Batch W** works in the worktree `~/github/seazn.club-worktrees/engine-split-2a`, on branch `feat/engine-split-2a`. Create it from a fresh `origin/main` (`git fetch origin && git worktree add -b feat/engine-split-2a ~/github/seazn.club-worktrees/engine-split-2a origin/main`), then run `pnpm install` in it.
- **Every Bash call starts `cd <abs path> &&`.** No `git stash`, anywhere.

**Agents and reviews**
- **Per task:** `implementer-sonnet` implements, then `reviewer-sonnet` reviews. Loop until the review is clean and the task's scoped tests are green.
- **Per batch:** one Opus `reviewer` reviews the batch whole and answers TEST-STRATEGY's four questions in writing. Its findings go in the web worktree:
  - `docs/superpowers/specs/engine-split/reviews/2a-placement.md` (Batch P; the reviewer reads `~/github/seazn.club.placement`)
  - `docs/superpowers/specs/engine-split/reviews/2a-web.md` (Batch W)
- **Dispatching:** the `*-sonnet` agent files are untracked in the main checkout, so dispatch from the main-checkout session and pass the absolute path. Never override `model:`.

**Gates and approvals**
- **The orchestrator reruns each task's scoped gate itself.** For vitest, green is judged only from `--reporter=json --outputFile "$(mktemp)"` counts with `.testResults[].name` confirmed. For pytest, from the `N passed` summary line plus the `--collect-only` id list.
- **Outward steps** (`O1`–`O15` below) are run by the orchestrator. Steps marked **OWNER GO** wait for an explicit owner "go" in chat for that step. A go for one step is not a go for the next.

## Global Constraints

- **Proto bytes are frozen.** `proto/scheduler.proto` in the placement repo, `packages/scheduler/proto/scheduler.proto` in web, and the blob at `placement-split-base:proto/scheduler.proto` all have the same sha256.
  - ts-proto copies proto comments into `packages/scheduler/src/generated/scheduler.ts` (for example `scheduler.ts:417` is `scheduler.proto:326`), so ANY byte change, a comment included, drifts the TS stubs.
  - The two generated Python stubs stay byte-identical to the tag too.
- **Image reference:** `ghcr.io/onryde/seazn-placement:<40-hex lowercase placement commit sha>`.
  - Immutable sha tags only: no `latest`, no `main`.
  - The image carries the label `org.opencontainers.image.source=https://github.com/onryde/seazn.club.placement`.
  - Locally, every web job retags it `placement-service:ci`, so the existing `docker run … placement-service:ci` lines stay unchanged.
- **`VENDORED.json` has exactly three keys, in this order:** `placementCommit` (40-hex), `sha256` (64-hex, over the vendored file's bytes), `imageTag` (40-hex). `vendor:proto` writes `placementCommit` and `imageTag` from one `git rev-parse HEAD`, so the image can never be older than the proto.
- **Fly:**
  - `fly.toml` keeps `app = "placement"`, and stg deploys the same file with `--app placement-stg`.
  - `packages/scheduler/src/placement-client.ts` keeps `DEFAULT_HOST` as `placement.flycast:50051`.
  - **Internal only:** no public IP on `placement` or `placement-stg`, ever (owner ruling, see "Owner rulings" at the end).
  - The only secret is `FLY_TOKEN`. `GITHUB_TOKEN` gets `packages: write` on the placement `publish` job and nowhere else.
- **The CI service secrets stay literals,** exactly as today: `ci-smoke-secret`, `ci-e2e-secret`, `ci-bench-secret`, `ci-integration-secret`. Each must be identical on both sides of its job.
- **Toolchain:**
  - Python: `actions/setup-python@v5` with `"3.14"`.
  - Node: `node-version: 26`, `pnpm/action-setup@v4` at `10.34.5`.
  - buf: `BUF_VERSION` is one workflow-level env constant. Pin it to the newest buf release that is at least two weeks old at execution, checked with `gh release list -R bufbuild/buf --limit 5`.
- **Freeze:** from O1 until O14, no PR touching `services/placement/**` or `proto/**` merges in seazn.club. O13 checks this mechanically.
- **Scoped tests only.** Never run the full vitest, e2e, or `seazn-env gate`.
  - Run vitest from the package directory.
  - apps/web vitest that needs no DB runs with `DATABASE_URL=` empty.
  - e2e runs by CI dispatch only.
- **Test rules:**
  - Every change ships a test that fails without it.
  - Every sweep reports its count, and a count of zero checked fails.
  - Every new guard is mutated once and seen red.
  - Expected values come from the facts or the tree, never from the code under test.
- **Four test types:** every task has a `Four types:` line (RULES.md, "Testing — required for every task, all four").
- **No user-facing strings are expected.** If one appears, it goes in all four locale dictionaries.
- **Never:** print a token, delete a remote repo, package, image, tag or Fly app, or rewrite seazn.club history.
- **PR body** carries `Matrix rows: none — CI/infra relocation of the placement service; no engine, rule or sport behaviour changes`.

## Review Focus

1. **A buf "skip" that hides a broken checkout.** A shallow clone, or a base ref that is not fetched, must FAIL `buf-breaking`, not skip it as if it were a first import (AGENTS.md class 6). Pinned in Task P2, `test_fails_on_unresolvable_base`.
2. **Vendoring the wrong bytes.** These are refused:
   - a dirty placement checkout;
   - a path that is not a git checkout;
   - a relative path that pnpm resolves against `packages/scheduler` instead of the caller's directory.

   Pinned in Task W1 (`vendorProto` refusal cases, `resolveCheckout` with `INIT_CWD`).
3. **An image reference that silently comes out empty.** `echo "image=$(script)"` swallows the script's failure under `bash -e`. A malformed `imageTag` must fail with `::error::`, and the pin step must assign the reference before writing it. Pinned in Task W2.
4. **[Superseded 2026-10-25: owner ruled no re-add guard; see Owner rulings 4.]** **The re-add guard false-redding on a developer's machine.** The 225 MB gitignored `services/placement/venv/` survives the deletion in every checkout that ever ran `seazn-env` natively, so an `existsSync` guard (the `registrations-sweep-workflow.test.ts:58` precedent) is red locally forever. The guard reads `git ls-files`. Pinned in Task W3, temp-repo cases.
5. **A job that still runs `placement-service:ci` without its pull step, or pulls a typed tag.** That job either dies with "image not found" or tests an image that does not match the vendored proto. Pinned in Task W2's workflow sweep: an exact set of seven jobs, and no hex literal next to `seazn-placement:`.

## False premises found while planning

These are recorded per AGENTS.md class 5. None blocks the plan. Each is handled where noted.

1. **Spec §6.2 says the owner approves *creating* the repo.** It already exists, private and empty (facts). The step becomes "flip public" (O4).
2. **Spec §6.4 and §10.3 assume `buf breaking` exists.** There is no buf config, CLI or action anywhere (facts). Task P2 builds it from scratch.
3. **Spec §6.5's line numbers are all stale.** Live: `ci.yml:975/1276/1571`, `e2e.yml:853/1410/1773`, `bench.yml:147`, and the TS drift gate at `placement-ci.yml:303-314` (not 297-305). Re-pin at execution.
4. **The brief names a "Build schedule" e2e.** No spec, test title or copy uses that name. The e2e that proves a real browser reaches the optimiser on the pinned image is `apps/web/e2e/placement-cutover.spec.ts` ("Auto-schedule reaches the OPTIMISER, not the greedy fallback…", :199). O12 reads that spec's results.
5. **"No edits to services/placement or proto" does not stop the stg race.** `placement-stg.yml:42-47` also fires on `packages/scheduler/**` and `packages/engine/src/scheduling/**`, so any web merge touching the scheduler during the freeze redeploys `placement-stg` from the old tree. O3 disables the old deploy workflows before the new repo first deploys.
6. **The re-add guard precedent (`existsSync`, `registrations-sweep-workflow.test.ts:58`) does not transfer.** See Review Focus 4. (Moot: no guard, owner ruling 4.)
7. **A GitHub Actions `services:` container cannot read a file.** So "the live integration test runs against the image at `imageTag` as a service container" needs a pin job whose output feeds `services.placement.image` (Task W2).
8. **`services/placement/DEPLOY.md:5,226` cites `.github/workflows/placement-service.yml`,** which does not exist on main today. It is fixed in Task P1.
9. **`relay-drivers-ci-wiring.test.ts:222-223` does not break on deletion.** Its `services/placement/*` literals are synthetic `/r/…` paths that test the detector. Only its comment at :204-205 goes stale (Task W3).
10. **The developer machine has no container runtime** (`placement-ci.yml:147-151`). The image is never built or run locally, and every image proof is a CI run.

## Deviations from the spec (for owner review)

- **a. No Python git-status drift job in the placement repo.** `placement-ci.yml:290-301` is dropped. The blocking pytest step already runs `tests/test_proto_compiles.py::test_generated_stubs_match_proto`, which byte-compares a fresh compile. The TS half moves to web `ci.yml` (spec §6.5).
- **b. buf also runs on push to `main`, against `github.event.before`.** That is how the first import's skip becomes visible in a log: no PR exists for the import push.
- **c. Placement prod deploys from a `v*.*.*` tag in the placement repo.** It no longer rides seazn.club's release tag (`placement-prod.yml:3-8` shipped both under one tag). See open question 1.
- **d. O3 disables `placement-stg.yml` and `placement-prod.yml` in seazn.club** before the new repo's first deploy. The spec does not mention it; see false premise 5.
- **e. The 5 comment-only references in `packages/engine/**` are excluded from the stale-reference sweep.** See open question 2.

---

# Pre-flight (orchestrator, local, read-only)

- [ ] **1. Re-verify the tag commit.**

  ```bash
  cd ~/github/seazn.club && git fetch origin && git log -1 --format=%H origin/main -- services/placement proto
  ```
  Expected: `093ad1d19ef068950e72571309320e5861dd3255`. On a different sha, STOP and ask the owner: something touched the tree after 2026-10-25.

- [ ] **2. Confirm the remote is still empty.**

  ```bash
  gh repo view onryde/seazn.club.placement --json visibility,isEmpty,defaultBranchRef
  ```
  Expected: `"isEmpty":true`, `"visibility":"PRIVATE"`.

- [ ] **3. List open PRs that touch the frozen paths.**

  ```bash
  for n in $(gh pr list --state open --json number --jq '.[].number'); do gh pr diff $n --name-only | grep -qE '^(services/placement/|proto/|\.github/workflows/placement-)' && echo "PR $n touches the frozen paths"; done
  ```
  Each hit is either merged before O1 or held until after O14. Tell its owning session either way.

- [ ] **4. Tag locally only:** `cd ~/github/seazn.club && git tag placement-split-base 093ad1d19ef068950e72571309320e5861dd3255`. Pushing the tag is O1.

# O1 — OWNER GO: push the tag; the freeze starts

- [ ] `cd ~/github/seazn.club && git push origin placement-split-base`. Confirm with `git ls-remote --tags origin placement-split-base`.
- [ ] Message every live session that touches scheduling: bench, scheduler, W2d (format matrix), and engine-split peers. Say: "Freeze from now until the 2a web PR merges: no PR touching `services/placement/**` or `proto/**` merges in seazn.club." Send it as a recommendation with its reason (AGENTS.md class 17).

---

# Batch P — the placement repo (local clone, nothing pushed)

Run `gh repo clone onryde/seazn.club.placement ~/github/seazn.club.placement`. Git warns that the repository is empty; that is expected.

Python env for every P task:

```bash
cd ~/github/seazn.club.placement && uv venv --python 3.14 venv && uv pip install --python venv/bin/python -e ".[dev]"
```

The pytest gate is `PYTEST_GATE`:

```bash
cd ~/github/seazn.club.placement && PATH="$BUF_DIR:$PATH" venv/bin/python -m pytest tests/ -q --deselect tests/test_model.py::test_production_board_meets_the_stated_acceptance_criterion
```

### Task P1: Import tree, path fixes, AGENTS.md

**Files:**
- Create (by extraction, at the clone root): the whole tree from `git archive placement-split-base services/placement | tar -x --strip-components=2` and `git archive placement-split-base proto | tar -x`.
- Modify: `tests/test_proto_compiles.py:11,14`.
- Modify (paths only): `README.md`, `DEPLOY.md`, `bench/README.md`, `bench/placement_bench.py:11`, `src/placement/model.py:3`, `tests/_board_positional.py:5`.
- Create: `AGENTS.md`, `CLAUDE.md` (one line, `@AGENTS.md`, the seazn.club convention).

**Interfaces:**
- Produces:
  - The layout every later task relies on: `Dockerfile`, `fly.toml`, `pyproject.toml`, `src/placement/**`, `tests/**`, `bench/**`, `proto/scheduler.proto`, all at the repo root.
  - `.gitignore` and `.dockerignore` at the root (the service's own files).
  - `tests/test_proto_compiles.py` with `REPO_ROOT = Path(__file__).resolve().parents[1]` and `TRACKED_DIR = REPO_ROOT / "src" / "placement" / "generated"`.

- [ ] **Step 1: Extract the tree** into the clone with the two `git archive` pipelines above, run from `~/github/seazn.club`. Check that `ls -A ~/github/seazn.club.placement` shows `.dockerignore .git .gitignore DEPLOY.md Dockerfile README.md bench fly.toml proto pyproject.toml src tests uv.lock` and no `venv`.
- [ ] **Step 2: Run the gate to see it fail.** Create the venv, then run `PYTEST_GATE`. Expected: FAIL in `tests/test_proto_compiles.py`, because `parents[3]` resolves above the repo and `proto/` is not found. This is the test that fails without the fix.
- [ ] **Step 3: Fix the two paths** in `tests/test_proto_compiles.py` (`parents[1]`; `TRACKED_DIR` without `services/placement`).
- [ ] **Step 4: Fix the human-run paths.**
  - Every `services/placement/<x>` that names a file in this repo becomes the root-relative `<x>`.
  - `cd services/placement` becomes "from the repo root".
  - `fly deploy services/placement --config services/placement/fly.toml …` becomes `fly deploy . --config fly.toml …`.
  - `DEPLOY.md:5,226`'s `.github/workflows/placement-service.yml` becomes `.github/workflows/stg.yml` / `prod.yml`.
  - Relative links `../../docs/…` and `../../../docs/…` become `https://github.com/onryde/seazn.club/blob/placement-split-base/docs/…`.
  - Leave references to `packages/…` and `apps/…` as they are. They name seazn.club files, and AGENTS.md says so.
- [ ] **Step 5: Write `AGENTS.md`.** It says:
  - (a) What this is: the CP-SAT placement gRPC service, consumed only by seazn.club's `packages/scheduler`.
  - (b) **History:** "Pre-cutover history lives in onryde/seazn.club: `git log placement-split-base -- services/placement proto` (tag at `093ad1d19ef068950e72571309320e5861dd3255`). This repo starts with one import commit and is never rewritten."
  - (c) Paths in comments that start with `packages/` or `apps/` are seazn.club paths.
  - (d) **Proto rule:** additive only, enforced by `buf breaking`. The order is: placement PR → deploy → re-vendor in web with `pnpm --filter @seazn/scheduler vendor:proto <this checkout>` then `gen:proto`.
  - (e) Deploys: stg on every push to `main`, prod on a `v*.*.*` tag. The only artifact is `ghcr.io/onryde/seazn-placement:<sha>`, published from `main`.
  - (f) Local tests need the pinned buf on PATH (Task P2).
- [ ] **Step 6: Run the gate to see it pass.** Run `PYTEST_GATE` (no buf test exists yet). Expected: `N passed`, 0 failed.
- [ ] **Step 7: Prove parity of the test ids.**

  ```bash
  T=$(mktemp -d); cd ~/github/seazn.club && git archive placement-split-base services/placement | tar -x --strip-components=2 -C "$T"
  cd "$T" && ~/github/seazn.club.placement/venv/bin/python -m pytest --collect-only -q tests/ | grep '::' | sort > "$T.before"
  cd ~/github/seazn.club.placement && venv/bin/python -m pytest --collect-only -q tests/ | grep '::' | sort > "$T.after"
  diff "$T.before" "$T.after" && wc -l < "$T.after"
  ```
  Expected: no diff, and a nonzero count. Paste the count.
- [ ] **Step 8: Prove the bytes.** For every path in `git -C ~/github/seazn.club ls-tree -r --name-only placement-split-base services/placement proto`, map it to its root path and compare `git hash-object` against the tag blob.
  - Expected identical: everything except the 7 files modified above.
  - Expected byte-identical, explicitly: `proto/scheduler.proto` and both `src/placement/generated/*` stubs.
  - Paste the count of identical files, and the 7 differing ones.
- [ ] **Step 9: Mutate once.** Put `parents[3]` back, run `PYTEST_GATE`, and see it red. Restore it.
- [ ] **Step 10: Commit.** This is the import commit; author it with `git checkout --orphan main` if the clone has no branch yet.

  ```
  Import the placement service from onryde/seazn.club@093ad1d19ef068950e72571309320e5861dd3255

  services/placement/** -> /, proto/** -> proto/, at tag placement-split-base.
  Path fixes only (test_proto_compiles.py, docs, three comments); the proto and
  generated stubs are byte-identical. Pre-cutover history: onryde/seazn.club,
  git log placement-split-base -- services/placement proto
  ```
  The message contains no `#NNN` (D22).
- [ ] **Four types:**
  - Unit: the full pytest suite at the new layout, with id parity.
  - Regression: `test_proto_compiles` red-without-fix.
  - E2E and smoke: owed by O7 (stg deploy) and O12 (placement-cutover e2e on the image).

### Task P2: Placement CI — pytest, docker, `buf breaking`, GHCR publish

**Files:**
- Create: `buf.yaml`, `scripts/buf-breaking.sh`, `.github/workflows/ci.yml`, `tests/test_buf_breaking.py`, `tests/test_ci_wiring.py`.
- Modify: `README.md` ("Local dev": install buf `$BUF_VERSION`).

**Interfaces:**
- Consumes: P1's layout.
- Produces:
  - `scripts/buf-breaking.sh <base-ref>`, which runs from the repo root. Its outcomes:

    | Condition | Exit | Prints |
    |---|---|---|
    | `<base-ref>` empty or `0{40}` | 0 | `::notice::buf breaking skipped: no base commit (first push to main)` |
    | `<base-ref>` resolves but has no `proto/scheduler.proto` | 0 | `::notice::buf breaking skipped: <ref> has no proto/scheduler.proto (first import)` |
    | `<base-ref>` non-empty and unresolvable | 1 | `::error::base ref <ref> is not in this clone (checkout needs fetch-depth: 0)` |
    | otherwise | buf's own exit code | `buf breaking proto --against <base proto extracted to a temp dir via git archive>` |
  - `buf.yaml`: `version: v2`, `modules: [{path: proto}]`, `breaking.use: [FILE]`.
  - `ci.yml`, with jobs `test`, `docker`, `buf-breaking`, `publish`, and workflow-level `permissions: contents: read` plus `env.BUF_VERSION`.

- [ ] **Step 1: Write the failing tests** in `tests/test_buf_breaking.py`. Each case builds a temp git repo holding `buf.yaml`, `scripts/buf-breaking.sh` (copied from the repo) and a minimal proto, then runs the script with `cwd` set to that repo. Cases:
  - `test_buf_is_installed`: `assert shutil.which("buf")`. It FAILS rather than skips: a skipped contract gate is a vacuous one.
  - `test_skips_on_all_zero_base`: the ref `"0"*40` gives exit 0 and `"skipped"` in stdout.
  - `test_skips_when_base_has_no_proto`: a base commit with only `README.md` gives exit 0 and `"first import"`.
  - `test_fails_on_unresolvable_base`: `"deadbeef"*5` gives exit 1 and `"::error::"`.
  - `test_passes_an_additive_field`: base has `message M { string a = 1; }`, head adds `string b = 2;`. Exit 0, and `"skipped"` NOT in stdout.
  - `test_fails_on_a_removed_field`: head drops `a`. Exit is not 0.
  - `test_fails_on_a_renumbered_field`: head has `string a = 3;`, the proto3 hazard `placement-stg.yml:24-27` names. Exit is not 0.
  - `test_real_proto_against_itself_passes`: the repo's own `proto/scheduler.proto` as both base and head. Exit 0, and `"skipped"` NOT in stdout. This is the anti-vacuity case on the real contract.
- [ ] **Step 2: Write the failing tests** in `tests/test_ci_wiring.py`. These are pure text reads of `.github/workflows/*.yml`, with job blocks split on `^  ([a-z0-9-]+):$` under `jobs:`.
  - `test_scans_the_workflows`: the number of `.yml` files read is ≥ 1 here (P3 raises it to 3).
  - `test_only_publish_can_write_packages`: `packages: write` appears exactly once, inside the `publish` block. The top-level permissions are `contents: read`.
  - `test_publish_runs_only_on_main_after_every_gate`: `publish`'s `if:` requires `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`, and its `needs:` holds `test`, `docker` and `buf-breaking`.
  - `test_image_is_the_sha_tag_only`: `ghcr.io/onryde/seazn-placement:${{ github.sha }}` occurs exactly once, and no `seazn-placement:latest` or `:main` occurs.
  - `test_image_links_to_this_repo`: the label `org.opencontainers.image.source=https://github.com/onryde/seazn.club.placement` is present.
  - `test_buf_job_has_full_history`: the `buf-breaking` block has `fetch-depth: 0`. Its base is `origin/${{ github.base_ref }}` on `pull_request` and `${{ github.event.before }}` on `push`.
  - `test_no_old_layout_paths`: no non-comment line contains `services/placement`.
- [ ] **Step 3: Run both to see them fail.** Run `PYTEST_GATE`. Expected: FAIL. The buf script is missing (and so is buf itself until Step 4), and so is `ci.yml`.
- [ ] **Step 4: Install buf locally** into a scratch dir:

  ```bash
  BUF_DIR=$(mktemp -d); curl -fsSL -o "$BUF_DIR/buf" https://github.com/bufbuild/buf/releases/download/v$BUF_VERSION/buf-Darwin-arm64; chmod +x "$BUF_DIR/buf"
  ```
  It goes on PATH only through `PYTEST_GATE`. Nothing on the machine's PATH changes.
- [ ] **Step 5: Implement `buf.yaml` and `scripts/buf-breaking.sh`** per Interfaces. Use `set -euo pipefail` and `mktemp -d` with a `trap` to remove it. Pass the base ref as an argument, never as interpolated YAML.
- [ ] **Step 6: Implement `.github/workflows/ci.yml`.**
  - **Triggers:** `on: pull_request` and `push: branches: [main]`. `concurrency: placement-ci-${{ github.ref }}`, with cancel-in-progress only for PRs.
  - **`test`:** port `placement-ci.yml:68-144` with `working-directory` removed: install, `pip check`, the blocking pytest with the deselect, and the advisory re-run. Keep the comment block that explains the deselect. Add `bufbuild/buf-action@v1` in setup-only mode at `${{ env.BUF_VERSION }}` before pytest; confirm the input names against that action's `action.yml` at the pinned tag.
  - **`docker`:** port `placement-ci.yml:153-243` with `context: .` and `file: Dockerfile`. `push: false`, `load: true`.
  - **`buf-breaking`:** checkout with `fetch-depth: 0`, set up buf, then run `bash scripts/buf-breaking.sh "$BASE"`. Feed `BASE` through `env:`.
  - **`publish`:** `if:` as tested, `needs: [test, docker, buf-breaking]`, and job-level `permissions: {contents: read, packages: write}`. Steps:
    - `docker/login-action@v3`, with `registry: ghcr.io`, `username: ${{ github.actor }}` and `password: ${{ secrets.GITHUB_TOKEN }}`;
    - `docker/build-push-action@v6`, with `push: true`, the sha tag, and the source label under `labels:`;
    - an echo of the pushed digest.
- [ ] **Step 7: Run the gate to see it pass.** Run `PYTEST_GATE`. Expected: 0 failed, and the new tests are listed in `-v` output. Paste the counts.
- [ ] **Step 8: Mutate once each.**
  - (a) Make the script exit 0 when the ref is unresolvable: `test_fails_on_unresolvable_base` goes red.
  - (b) Move `packages: write` up to the top-level permissions: `test_only_publish_can_write_packages` goes red.

  Restore both.
- [ ] **Step 9: Commit** as `ci: pytest, docker, buf breaking and the GHCR image publish`.
- [ ] **Four types:**
  - Unit: the buf script cases and the wiring pins.
  - Regression: renumber and remove are refused.
  - Smoke: the `docker` job's container-starts check, running at O5.
  - E2E: O12.

### Task P3: stg and prod deploy workflows, ported

**Files:**
- Create: `.github/workflows/stg.yml` (from `seazn.club:.github/workflows/placement-stg.yml`) and `.github/workflows/prod.yml` (from `placement-prod.yml`).
- Modify: `tests/test_ci_wiring.py`.

**Interfaces:**
- Consumes: P1's `fly.toml` at the root.
- Produces: `stg.yml` (push to `main`, no paths filter) and `prod.yml` (`push: tags: ["v*.*.*"]`), both reading `secrets.FLY_TOKEN`.

- [ ] **Step 1: Add the failing tests** to `tests/test_ci_wiring.py`:
  - `test_scans_the_workflows`: the count is now exactly 3 (`ci.yml`, `stg.yml`, `prod.yml`).
  - `test_stg_deploys_the_shared_config_to_placement_stg`: `stg.yml` asserts that the `fly.toml` app is `"placement"` (the sed line reads `fly.toml`), pushes `registry.fly.io/placement-stg:${{ github.sha }}`, and deploys with `--app placement-stg --config fly.toml`.
  - `test_prod_deploys_only_from_a_release_tag`: `prod.yml` has `tags: ["v*.*.*"]` and no `branches:`. Its app-name assertion reads `fly.toml` and requires `placement`.
  - `test_deploys_use_FLY_TOKEN_and_never_needs`: both files reference `secrets.FLY_TOKEN`, and neither has a `needs:` line. This ports `toolchain.test.ts:213-227`'s rule.
  - `test_deploy_concurrency_is_never_cancelled`: each file has a `concurrency:` group with `cancel-in-progress: false`.
- [ ] **Step 2: Run the gate to see it fail.** Run `PYTEST_GATE`. Expected: FAIL (the files are missing).
- [ ] **Step 3: Port the two workflows.**
  - Replace `services/placement/fly.toml` with `fly.toml`, and `context: services/placement` with `context: .`.
  - Drop the `paths:` filter: the whole repo is the service.
  - Rewrite the header comments that are now false:
    - "Same path filter as placement-ci.yml" goes.
    - "both services ship together under one tag" becomes "placement prod moves on a tag in THIS repo; seazn.club's release tag no longer deploys it".
    - The reference to `placement-ci.yml` becomes `ci.yml`.
  - Keep, verbatim: the "What to verify by hand" log-attribution step and the "Report machine count" step.
- [ ] **Step 4: Run the gate to see it pass.** Run `PYTEST_GATE`. Expected: 0 failed. Paste the counts.
- [ ] **Step 5: Mutate once.** Change `--app placement-stg` to `--app placement`: red. Restore it.
- [ ] **Step 6: Commit** as `ci: port the stg and prod Fly deploys from onryde/seazn.club`.
- [ ] **Four types:**
  - Unit: the wiring pins.
  - Smoke and E2E: O7, the live stg deploy plus the log attribution.
  - Regression: the app-name assertions.

### Batch P close

- [ ] The Opus `reviewer` reviews the clone's three commits whole and writes `reviews/2a-placement.md`. Loop until it is clean.
- [ ] **Freeze the shas.** Record `git -C ~/github/seazn.club.placement rev-parse HEAD` as `PLACEMENT_HEAD`. From here on, no amend and no rebase in the clone. If a fix is needed, add a commit, and re-run W1 Step 4 if W1 has already vendored.

---

# Outward sequence O2–O8 (placement goes live)

Run these in order. O3 MUST precede O5, because O5's push deploys `placement-stg`.

> **Amended 2026-10-25 after the P3 review:** P3 deploys the tested GHCR image with `flyctl deploy --image … --no-public-ips` (stg on `workflow_run` after `ci` succeeds on main; prod on a `v*.*.*` tag that already has an image). So the first stg run is expected RED until O6 makes the package public. Owner ruling 2026-10-25: ONE repo-level `FLY_TOKEN`, no GitHub environment (the repo has a single write-access maintainer; fork PRs never receive secrets; environments are not offered on the private repo). Revisit only if write collaborators are added (P3 review M-7, Batch P review I-1). Also owed at O2: branch protection blocks force-pushes on `main` (P2 review M-5); required checks are listed by job `name:` (P2 review M-11).

- [ ] **O2 — OWNER (GitHub UI / `gh secret set`):**
  - Set `FLY_TOKEN` in `onryde/seazn.club.placement`. It must be able to deploy both `placement` and `placement-stg`.
  - Confirm the `onryde` org's package settings allow public container packages. The token here lacks `read:packages`, so the orchestrator cannot see that setting.
  - Then confirm with `gh secret list -R onryde/seazn.club.placement`: the name only, never a value.
- [ ] **O3 — OWNER GO: stop seazn.club deploying placement.**

  ```bash
  gh workflow disable placement-stg.yml -R onryde/seazn.club && gh workflow disable placement-prod.yml -R onryde/seazn.club
  ```
  Verify that `gh workflow list -R onryde/seazn.club --all | grep placement-` shows both `disabled_manually`. `placement-ci.yml` stays enabled: it only validates PRs against the frozen tree.

  Rollback: `gh workflow enable` the same two.
- [ ] **O4 — OWNER GO: make the repo public.**

  ```bash
  gh repo edit onryde/seazn.club.placement --visibility public --accept-visibility-change-consequences
  ```
  Expected afterwards: `gh repo view … --json visibility` reads `PUBLIC`.
- [ ] **O5 — OWNER GO: push the import.** This also triggers the first `placement-stg` Fly deploy and the first GHCR publish.

  ```bash
  cd ~/github/seazn.club.placement && git push -u origin main
  ```
  Then check:
  - `gh repo view onryde/seazn.club.placement --json defaultBranchRef` is `main`.
  - Watch both runs: `gh run list -R onryde/seazn.club.placement --limit 5`.
  - Expected: `ci` is green on all four jobs, and the `buf-breaking` log shows `::notice::buf breaking skipped: no base commit (first push to main)`.
  - Expected: `stg` is RED at `require-image` ("not published or not public"). That is correct: stg deploys the published GHCR image, checked anonymously, and the package stays private until O6. Paste both run URLs.
- [ ] **O6 — OWNER (GitHub UI): make the image public.** In Package `seazn-placement` → Package settings → Change visibility → Public. Then the orchestrator proves an anonymous pull without docker:

  ```bash
  TOKEN=$(curl -fsS "https://ghcr.io/token?scope=repository:onryde/seazn-placement:pull" | jq -r .token); curl -fsS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' "https://ghcr.io/v2/onryde/seazn-placement/manifests/$PLACEMENT_HEAD"
  ```
  Expected: `200`. The anonymous token is not a secret, but do not echo it anyway.
  - Then re-run the failed stg run: `gh run rerun <stg run id> -R onryde/seazn.club.placement --failed`. Expected: green, with `require-private-ips` passing (private v6 only).
- [ ] **O7 — Proof 1 (spec §6.6): the stg deploy from the new repo.**
  - Run `fly status --app placement-stg`. Its image must be `ghcr.io/onryde/seazn-placement:$PLACEMENT_HEAD` (P3 deploys the tested image; no registry.fly.io rebuild).
  - Run `fly ips list --app placement-stg`: only a private v6 (owner ruling: internal only).
  - The owner runs one Auto-schedule on stg.seazn.club.
  - `fly logs --app placement-stg` must then show a `solve request=` line, and `fly logs --app placement` must show nothing for it (`stg.yml`'s verify-by-hand step).
  - Write down what was SEEN.
- [ ] **O8 — OWNER GO: prove `buf breaking` in a real PR.**
  - Open a draft PR in the placement repo that deletes one field from `proto/scheduler.proto`. Expected: `buf-breaking` is red.
  - Push a second commit that restores the field and adds a new optional field instead. Expected: green.
  - Close the PR unmerged and delete its branch. The proto on `main` stays byte-frozen.
  - Paste both run URLs.

---

# Batch W — the web PR (worktree `engine-split-2a`, one PR)

W1 needs `PLACEMENT_HEAD` and the clone; it can start as soon as Batch P closes, while O2–O8 run. The branch is pushed only after O6, because CI pulls the image.

Scoped vitest for the scheduler package (run from the package dir):

```bash
cd ~/github/seazn.club-worktrees/engine-split-2a/packages/scheduler && R=$(mktemp) && npx vitest run --reporter=json --outputFile "$R" <files> ; jq '{numTotalTests,numPassedTests,numFailedTests,numPendingTests,numFailedTestSuites}, [.testResults[].name]' "$R"
```

### Task W1: Vendor the proto, `vendor:proto`, `gen:proto` from the copy, pin test, stub drift in `ci.yml`

**Files:**
- Create:
  - `packages/scheduler/scripts/proto-paths.ts`
  - `packages/scheduler/scripts/vendor-proto-lib.ts`
  - `packages/scheduler/scripts/vendor-proto.ts`
  - `packages/scheduler/proto/scheduler.proto` (written by the script)
  - `packages/scheduler/VENDORED.json` (written by the script)
  - `packages/scheduler/test/vendor-proto.test.ts`
  - `packages/scheduler/test/vendored-proto.test.ts`
- Modify:
  - `packages/scheduler/scripts/gen-proto.ts:1,31-35` (read `VENDORED_PROTO_DIR` from `proto-paths.ts`; fix the header comment)
  - `packages/scheduler/package.json` (`"vendor:proto": "node --experimental-strip-types scripts/vendor-proto.ts"`)
  - `.gitattributes` (`packages/scheduler/proto/** -text`, the `docs/contracts/** -text` precedent for checksummed files)
  - `.github/workflows/ci.yml` (two steps in the `gates` job, after "Scheduler package tests (DB-free)" at :316)
  - `packages/scheduler/test/integration-runs-elsewhere.test.ts` (add the ci.yml drift assertions)

**Interfaces:**
- Produces:
  - `proto-paths.ts` exports `PKG_ROOT: string`, `VENDORED_PROTO_DIR = <PKG_ROOT>/proto`, `VENDORED_PROTO = <dir>/scheduler.proto` and `VENDORED_JSON = <PKG_ROOT>/VENDORED.json`. No side effects.
  - `vendor-proto-lib.ts` exports:
    - `interface VendoredPin { placementCommit: string; sha256: string; imageTag: string }`;
    - `sha256Of(file: string): string` (lowercase hex);
    - `resolveCheckout(arg: string, initCwd: string | undefined, cwd: string): string`. It resolves a relative `arg` against `initCwd ?? cwd`, because pnpm sets `INIT_CWD` to the caller's directory;
    - `vendorProto(opts: { checkout: string; pkgRoot?: string }): VendoredPin`. It throws `Error`s whose messages start `not a git checkout:`, `has uncommitted changes:` and `no proto/scheduler.proto in`. It copies the file byte for byte, then writes `VENDORED.json` with the three keys in order, 2-space JSON and a trailing newline. `placementCommit` and `imageTag` both come from `git -C <checkout> rev-parse HEAD`.
  - `vendor-proto.ts` is the CLI. It takes `process.argv[2]`, prints the pin and "now run `pnpm --filter @seazn/scheduler gen:proto`", and exits 1 with the error message on a throw. It does not regenerate the stubs; the drift gate catches a forgotten regeneration.
  - `ci.yml` `gates` gains the steps `- name: Regenerate TypeScript proto stubs` (`run: pnpm --filter @seazn/scheduler gen:proto`) and `- name: TypeScript stub drift gate`. The second is a port of `placement-ci.yml:306-314`, with its error message naming `packages/scheduler/proto/scheduler.proto` and `vendor:proto`.

- [ ] **Step 1: Write the failing tests** in `test/vendor-proto.test.ts`. Each case uses a temp git repo with `proto/scheduler.proto` committed and a temp `pkgRoot`.
  - `writes the copy and the pin`: the copy's bytes equal the source's. The pin is `{placementCommit: HEAD, sha256: sha256Of(copy), imageTag: HEAD}`, and `Object.keys` of the JSON on disk is exactly `["placementCommit","sha256","imageTag"]`.
  - `is idempotent`: a second call leaves both files byte-identical (sequence rule).
  - `follows a new commit`: commit an additive change, re-vendor, and both shas move.
  - `refuses a dirty checkout`: an unstaged edit to any file throws `/has uncommitted changes/`, and nothing is written (the old pin survives).
  - `refuses a non-checkout`: throws `/not a git checkout/`.
  - `refuses a checkout without the proto`: throws `/no proto\/scheduler\.proto/`.
  - `resolves a relative path against INIT_CWD`: `resolveCheckout("../p", "/a/b", "/x/y")` is `/a/p`. With `initCwd` undefined it is `/x/p`.
- [ ] **Step 2: Write the failing tests** in `test/vendored-proto.test.ts`. They read the REAL files.
  - `VENDORED.json has exactly the three keys, in order, well-formed`: `placementCommit` and `imageTag` match `/^[0-9a-f]{40}$/`, and `sha256` matches `/^[0-9a-f]{64}$/`.
  - `the vendored copy matches its pin`: `sha256Of(VENDORED_PROTO) === pin.sha256`.
  - `it is the only proto vendored`: `readdirSync(VENDORED_PROTO_DIR)` equals `["scheduler.proto"]`.
  - `gen-proto reads the vendored copy`: the source of `scripts/gen-proto.ts` imports `VENDORED_PROTO_DIR` from `./proto-paths.ts` and has no `path.join(repoRoot, "proto")`. The behavioural half is the CI drift gate, plus W3, where `/proto` disappears.
- [ ] **Step 3: Write the failing test** in `test/integration-runs-elsewhere.test.ts`: `it("ci.yml's gates job regenerates the stubs from the vendored proto and diffs them")`.
  - Take `step(workflow("ci.yml"), "Regenerate TypeScript proto stubs")` and match `/run:\s*pnpm --filter @seazn\/scheduler gen:proto\s*$/`.
  - The drift step contains `git status --porcelain -- packages/scheduler/src/generated/`.
  - Each step name occurs exactly once in ci.yml.
  - ci.yml's `on:` block has no `paths:`, so the gate cannot be filtered away.
- [ ] **Step 4: Run the tests to see them fail.** Use the scoped vitest over the three test files. Expected: FAIL, because the modules and files are missing.
- [ ] **Step 5: Implement `proto-paths.ts`, `vendor-proto-lib.ts` and `vendor-proto.ts`,** repoint `gen-proto.ts`, and add the package script and the `.gitattributes` line.
- [ ] **Step 6: Vendor for real.**

  ```bash
  cd ~/github/seazn.club-worktrees/engine-split-2a && pnpm --filter @seazn/scheduler vendor:proto ~/github/seazn.club.placement
  ```
  Expected: `VENDORED.json` has both shas equal to `PLACEMENT_HEAD`. Then cross-check against the tag:

  ```bash
  cd ~/github/seazn.club-worktrees/engine-split-2a && git show placement-split-base:proto/scheduler.proto | shasum -a 256
  ```
  This must equal `VENDORED.json`'s `sha256`. Paste both values; they go in the PR body.
- [ ] **Step 7: Regenerate, and prove no drift.**

  ```bash
  cd ~/github/seazn.club-worktrees/engine-split-2a && pnpm --filter @seazn/scheduler gen:proto && git status --porcelain -- packages/scheduler/src/generated/
  ```
  Expected: empty output, because the proto bytes are frozen.
- [ ] **Step 8: Add the two `gates` steps** to `ci.yml`, after line 316's step. Re-pin that line number first.
- [ ] **Step 9: Run the tests to see them pass.** Use the scoped vitest over the three files. Expected: 0 failed, 0 pending, `numFailedTestSuites` 0, and all three files listed. Paste the counts. Then run `cd packages/scheduler && pnpm typecheck && rtk proxy pnpm lint` and read `✖ N problems`: it must be 0.
- [ ] **Step 10: Mutate once each.**
  - (a) Flip one byte in `packages/scheduler/proto/scheduler.proto`: `the vendored copy matches its pin` goes red.
  - (b) Delete the dirty-tree check in `vendorProto`: `refuses a dirty checkout` goes red.

  Restore both.
- [ ] **Step 11: Commit** as `feat(scheduler): vendor the placement proto with a sha-pinned VENDORED.json; gen:proto reads the copy`.
- [ ] **Four types:**
  - Unit: both new files.
  - Regression: the pin and the dirty-refusal mutants.
  - Smoke: the ci.yml drift gate on the PR.
  - E2E: O12.

### Task W2: Every placement image comes from the pin; the live tests run in `ci.yml` against it

**Files:**
- Create:
  - `packages/scheduler/scripts/placement-image.sh`
  - `packages/scheduler/test/placement-image-wiring.test.ts`
- Modify:
  - `.github/workflows/ci.yml`: smoke-db :973-982, smoke-db-usecases :1276-1283 (with its buildx step), smoke-e2e :1566-1580; plus the new jobs `placement-pin` and `scheduler-live`.
  - `.github/workflows/e2e.yml`: :845-861, :1403-1418, :1766-1781.
  - `.github/workflows/bench.yml`: :146-154.
  - The comment blocks directly above each of those steps.
  - `scripts/ci-local.sh:15-17,61`.
  - `packages/scheduler/test/integration-runs-elsewhere.test.ts`: retarget the judge and run tests to ci.yml.

**Interfaces:**
- Consumes: W1's `VENDORED.json`.
- Produces:
  - `bash packages/scheduler/scripts/placement-image.sh ref|pull`, which reads `${PLACEMENT_VENDORED_JSON:-<script dir>/../VENDORED.json}` with `jq`.
    - On a missing file, a missing key, or an `imageTag` not matching `^[0-9a-f]{40}$`, it prints `::error::…` and exits 1.
    - `ref` prints `ghcr.io/onryde/seazn-placement:<imageTag>`.
    - `pull` runs `docker pull <ref>`, then `docker tag <ref> placement-service:ci`, then prints the pulled `RepoDigests`, all under `set -euo pipefail`.
    - Its header comment records spec §13: if the image goes private, every caller needs `packages: read` and a `docker login ghcr.io` before `pull`.
  - ci.yml job `placement-pin` (`runs-on: ubuntu-latest`) has the output `image`. Its one step is: `ref="$(bash packages/scheduler/scripts/placement-image.sh ref)"`, then `echo "image=$ref" >> "$GITHUB_OUTPUT"`. Assigning first propagates a failure under `bash -e`; Review Focus 3.
  - ci.yml job `scheduler-live`:
    - `needs: placement-pin`;
    - `services.placement`: `image: ${{ needs.placement-pin.outputs.image }}`, `ports: ["50051:50051"]`, `env: {PLACEMENT_SERVICE_SECRET: ci-integration-secret, PLACEMENT_LOG_LEVEL: WARNING}`;
    - steps: checkout, a TCP-ready loop (`placement-ci.yml:381-393`), pnpm/node/install, then `- name: Run the integration suite against the live service` and `- name: Assert the suite RAN, and passed`, both ported verbatim from `placement-ci.yml:414-488`.
    - The only edit is that every `docker logs placement-integration` becomes `docker logs "$PLACEMENT_CONTAINER"`, with step-level `env: PLACEMENT_CONTAINER: ${{ job.services.placement.id }}`. A `${{ }}` inside the script body would break the executed judge's `bash -c`.
    - A comment at the job records §13: going private needs `packages: read` plus a login here.

- [ ] **Step 1: Write the failing tests** in `test/placement-image-wiring.test.ts`. They read every `.github/workflows/*.yml`, with comments stripped, and split jobs on `^  ([a-z0-9-]+):$`.
  - `scans every workflow (anti-vacuity)`: the file count is > 10. Also assert the count of jobs found that run `placement-service:ci`.
  - `exactly these seven jobs run the placement image, and each pulls it first`: the set of `<file>:<job>` whose block contains `docker run` … `placement-service:ci` equals `{ci.yml:smoke-db, ci.yml:smoke-db-usecases, ci.yml:smoke-e2e, e2e.yml:e2e-parallel, e2e.yml:e2e-serial, e2e.yml:e2e-mobile, bench.yml:bench}`. That set comes from the facts table, not from the code. In each block, `placement-image.sh pull` occurs before the first `docker run`. Report `7 jobs checked`.
  - `no workflow builds placement or types a tag`: no non-comment line matches `context:\s*services/placement` or `/seazn-placement:[0-9a-f]{7,}/`. `build-push-action` occurs in none of the seven blocks.
  - `the live job runs against the pinned image as a service`:
    - `placement-pin`'s step assigns `ref="$(bash packages/scheduler/scripts/placement-image.sh ref)"` and does NOT match `/echo [^\n]*\$\(bash packages\/scheduler\/scripts\/placement-image\.sh/`;
    - `scheduler-live` has `needs: placement-pin` and `image: ${{ needs.placement-pin.outputs.image }}`.
  - `ref mode prints the pinned reference` (executed): a temp JSON with tag `a`×40 gives stdout exactly `ghcr.io/onryde/seazn-placement:aaaa…` and exit 0.
  - `ref mode on the REAL pin`: stdout ends with `:` plus `VENDORED.json`'s `imageTag`.
  - `it.each` refusals (executed): a missing file, no `imageTag`, a 7-char tag, an uppercase tag, and an empty string. Each gives exit 1 and stdout or stderr matching `/::error::/`.
  - `pull mode pulls, then retags` (executed, with a `docker` shim on PATH that appends argv to a log): the log lines are exactly `pull ghcr.io/onryde/seazn-placement:<tag>`, then `tag ghcr.io/onryde/seazn-placement:<tag> placement-service:ci`, then the `image inspect` call.
  - `pull mode stops when the pull fails`: the shim exits 1 on `pull`. The script exits non-zero, and the log has no `tag` line.
- [ ] **Step 2: Retarget `integration-runs-elsewhere.test.ts`.**
  - `judge()` and the `"runs every live file"` and `"judge fails on…"` tests read `workflow("ci.yml")`.
  - Add `it("each live-job step name occurs once in ci.yml")`.
  - Update the header comment and `describe` title to "run in ci.yml's scheduler-live job, against the pinned image".
  - Keep the `"filter and drift gate"` test reading `placement-ci.yml`; W3 removes it.
- [ ] **Step 3: Run the tests to see them fail.** Use the scoped vitest over both files. Expected: FAIL. The script is missing, the seven blocks still build, and ci.yml has no live job.
- [ ] **Step 4: Implement `placement-image.sh`** per Interfaces.
- [ ] **Step 5: Replace the seven blocks.** In each block, the buildx step and the `Build the placement service image` step become one step, `- name: Pull the pinned placement image` with `run: bash packages/scheduler/scripts/placement-image.sh pull`.
  - Keep `id: image` wherever a `wait:` names it (ci.yml smoke-e2e :1629, e2e.yml :902/:1459/:1822).
  - Keep `background: true` exactly where it was (ci.yml smoke-e2e only).
  - Remove a job's `docker/setup-buildx-action` only after confirming that no other step in that job uses buildx: grep each job block for `build-push-action`.
  - Rewrite each block's comment to say the image is pulled from the pin, dropping the `placement-ci.yml` and `type=gha` cache claims.
  - Leave the `docker run … placement-service:ci` lines byte-identical.
- [ ] **Step 6: Add `placement-pin` and `scheduler-live`** to ci.yml per Interfaces. Update the `gates` comment at ci.yml:309-315 so the exclusion points at `scheduler-live`.
- [ ] **Step 7: Update `scripts/ci-local.sh`.** Lines 15-17 and 61 become: "--placement-image pulls and runs the pinned GHCR image (`packages/scheduler/VENDORED.json`); the default runs a native placement checkout (seazn-env)". Text only: the behaviour lives in machine-local `seazn-env.sh` (O10).
- [ ] **Step 8: Run the tests to see them pass.** Use the scoped vitest over both files. Paste the counts and `7 jobs checked`.
- [ ] **Step 9: Run the workflow-reading sweeps your edits touch** (sweep by behaviour, rule 16).
  - Scoped apps/web:

    ```bash
    cd apps/web && DATABASE_URL= npx vitest run --reporter=json --outputFile "$(mktemp)" src/__tests__/toolchain.test.ts src/lib/__tests__/relay-drivers-ci-wiring.test.ts src/lib/__tests__/e2e-ci-wiring.test.ts src/lib/__tests__/stg-base-url.test.ts src/components/public-site/match-centre/__tests__/settled-poll-override.test.ts src/server/overlay/__tests__/overlay-compositor-e2e-wiring.test.ts
    ```
  - Plus `tools/matrix/__tests__/{ci-wiring,matrix-workflow}.test.ts` and `tools/bench/lib/__tests__/workspace.test.ts`, each from its own package dir.
  - Expected: 0 failed. Confirm each file in `.testResults[].name`.
- [ ] **Step 10: Mutate once each.**
  - (a) Delete the pull step from `bench.yml`: the seven-jobs test goes red.
  - (b) Drop the `^[0-9a-f]{40}$` check from the script: the 7-char and uppercase refusals go red.

  Restore both.
- [ ] **Step 11: Commit** as `ci: pull the pinned placement image everywhere; the live scheduler tests run in ci.yml against it`.
- [ ] **Four types:**
  - Unit: the wiring and script cases.
  - Smoke: ci.yml smoke-db, smoke-db-usecases and smoke-e2e on the PR, against the pulled image.
  - E2E: e2e.yml by dispatch (O12).
  - Regression: `scheduler-live`'s judge, and the bench `--engine optimized` assertion.

### Task W3: Delete the tree and the workflows; stale-reference sweep

> **Owner ruling 2026-10-25 ("3 dont add guard"): NO re-add guard.** Do not create `placement-moved-out.test.ts`; skip Steps 1, 2 and 7 below and every guard line in Steps 5, 6 and the four types. The test that fails without this task is the existing-test edits plus Step 6's `gen:proto` drift proof with `/proto` gone.

**Files:**
- Delete:
  - `services/placement/**` (33 files)
  - `proto/scheduler.proto`
  - `.github/workflows/placement-ci.yml`
  - `.github/workflows/placement-stg.yml`
  - `.github/workflows/placement-prod.yml`
- ~~Create: `packages/scheduler/test/placement-moved-out.test.ts`.~~ (dropped, owner ruling 4)
- Modify:
  - `apps/web/src/__tests__/toolchain.test.ts:213-218` (drop the two placement entries)
  - `packages/scheduler/test/integration-runs-elsewhere.test.ts:191-205` (delete the `placement-ci.yml` paths test)
  - `.gitignore` (`/services/placement/` with a one-line reason: the pre-split venvs linger in old checkouts)
  - `eslint.config.mjs:28` (remove `"services/**"`; nothing is left under it)
  - `packages/scheduler/test/placement-image-wiring.test.ts` (W2 review M5: drop `FROZEN_TREE_WORKFLOWS` and its "every exemption is real" test — the three workflows it exempts are deleted here)
- Modify (stale references; comments only, unless a step says otherwise):
  - workflows: `.github/workflows/{ci,e2e,bench,stg,prod}.yml` (`placement-ci.yml` / `placement-prod.yml` mentions)
  - apps/web: `apps/web/e2e/placement-cutover.spec.ts:27`, `apps/web/src/lib/__tests__/_fly-health-check.ts:16`, `apps/web/src/lib/__tests__/relay-drivers-ci-wiring.test.ts:204-205`, `apps/web/src/server/usecases/schedule.ts:2125`
  - packages/scheduler: `src/__tests__/placement-integration.test.ts:4,102,169,373`, `src/__tests__/repair-decompose-cpsat-integration.test.ts:10`, `src/placement-client.ts:152`, `src/placement-client.test.ts:938`
  - scripts: `scripts/smoke.ts:14840`

**Interfaces:**
- Consumes: W1's vendored files and W2's `scheduler-live` (so nothing reads `placement-ci.yml` any more).
- Produces: nothing other tasks consume. The test file defines a local `trackedUnder(repo: string, paths: string[]): string[]`, which returns the `git ls-files -z -- <paths>` entries run with `cwd: repo`. It asserts that git exited 0, so a missing git is a red, not an empty list.

- [ ] **Step 1: Write the failing test** in `test/placement-moved-out.test.ts`, with `GONE = ["services/placement", "proto", ".github/workflows/placement-ci.yml", ".github/workflows/placement-stg.yml", ".github/workflows/placement-prod.yml"]`.
  - `nothing under the moved paths is tracked: they live in onryde/seazn.club.placement`: `trackedUnder(REPO, GONE)` is `[]`. The comment cites the tag and the new repo, and says that re-adding is a decision someone makes out loud: delete it again, or delete this test.
  - `the positive pair: git sees the replacement`: `trackedUnder(REPO, ["packages/scheduler/proto/scheduler.proto", "packages/scheduler/VENDORED.json"])` has length 2. This proves `git ls-files` runs from this cwd; an empty answer from a wrong cwd is not absence.
  - `the detector bites, and ignores untracked leftovers` (temp `git init` repo):
    - after committing `services/placement/x.py`, `trackedUnder(tmp, GONE)` is `["services/placement/x.py"]`;
    - after `git rm` it is `[]`;
    - an untracked `services/placement/venv/bin/python3` keeps it `[]` (Review Focus 4);
    - a committed `.github/workflows/placement-stg.yml` is caught.

    Report `5 paths checked`.
- [ ] **Step 2: Run it to see it fail.** Run the scoped vitest over `test/placement-moved-out.test.ts`. Expected: the first test FAILS, because the tree is still tracked.
- [ ] **Step 3: Delete the tracked files.**

  ```bash
  git rm -r --quiet services/placement proto .github/workflows/placement-ci.yml .github/workflows/placement-stg.yml .github/workflows/placement-prod.yml
  ```
  Then edit `toolchain.test.ts` and `integration-runs-elsewhere.test.ts`, and add the `.gitignore` and `eslint.config.mjs` changes.
- [ ] **Step 4: Sweep the stale references.**
  - `services/placement/<x>` becomes "`<x>` in onryde/seazn.club.placement".
  - `services/placement/README.md`'s "Local dev" becomes "onryde/seazn.club.placement's README, Local dev".
  - A bare `proto/scheduler.proto` becomes `packages/scheduler/proto/scheduler.proto` (the vendored copy).
  - Workflow comments citing `placement-ci.yml`'s integration job now cite `scheduler-live`; those citing `placement-prod.yml` cite the placement repo's `prod.yml`.
  - `docs/**` is not swept: it is the pre-cutover record (D22). `packages/engine/**` is not swept (deviation e).
- [ ] **Step 5: Verify the sweep.**

  ```bash
  git grep -n -I -E "services/placement|placement-(ci|stg|prod)\.yml|(^|[^/])proto/scheduler\.proto" -- . ':!docs' ':!packages/engine'
  ```
  Expected residual hits, and ONLY these:
  - `placement-moved-out.test.ts` (`GONE` and the temp-repo cases)
  - `placement-image-wiring.test.ts` (its negative pattern)
  - `relay-drivers-ci-wiring.test.ts:222-223` (synthetic detector literals)
  - `.gitignore`

  Paste the list, and paste the excluded `packages/engine` hits (5 files) for the PR body.
- [ ] **Step 6: Run everything scoped.**
  - The scheduler package exactly as ci.yml's `gates` step runs it (re-pin ci.yml:320-323 and copy the command). Expected: 0 failed, 0 pending, and `.testResults[].name` includes all six scheduler `test/*.test.ts` files: `integration-runs-elsewhere`, `runtime-deps`, `vendor-proto`, `vendored-proto`, `placement-image-wiring` and `placement-moved-out`.
  - apps/web: `cd apps/web && DATABASE_URL= npx vitest run --reporter=json --outputFile "$(mktemp)" src/__tests__/toolchain.test.ts src/lib/__tests__/relay-drivers-ci-wiring.test.ts`.
  - `pnpm --filter @seazn/scheduler gen:proto && git status --porcelain -- packages/scheduler/src/generated/` is empty. This is the behavioural proof that gen:proto no longer needs `/proto`.
  - Lint: `rtk proxy pnpm lint` (the `eslint.config.mjs` edit). Read `✖ N problems`.
  - Paste all the counts.
- [ ] **Step 7: Mutate once.**
  - Before committing (HEAD is still W2's commit), re-add one deleted file: `git checkout HEAD -- .github/workflows/placement-stg.yml`, which also stages it. The guard goes red.
  - Remove the file again: `git rm -qf .github/workflows/placement-stg.yml`.
- [ ] **Step 8: Commit** as `chore: the placement service and its proto now live in onryde/seazn.club.placement`.
- [ ] **Four types:**
  - Unit: the guard with its detector cases.
  - Regression: the re-add mutant.
  - Smoke: ci.yml smoke jobs on the PR, after the deletion.
  - E2E: O12.

### Batch W close

- [ ] The Opus `reviewer` reviews the branch whole (`git diff origin/main...HEAD`, run from the worktree) and writes `reviews/2a-web.md`. Loop until it is clean.

---

# Outward sequence O9–O15 (the web cutover)

- [ ] **O9 — Warn the peers.** Before opening the PR, message the bench and scheduler peer sessions, and W2d:
  - The 2a PR deletes `services/placement/**`, `proto/**` and the three placement workflows.
  - Images now come from `packages/scheduler/VENDORED.json`.
  - A branch that edits those paths must move its change to onryde/seazn.club.placement.
  - Local `seazn-env` is repointed at O10.
- [ ] **O10 — OWNER GO: repoint machine-local `seazn-env`.** These files are untracked and shared by every session, so the change must be back-compatible.
  - **`~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, native mode (:249-289).**
    - The placement dir is `$root/services/placement` if it exists (a pre-split branch). Otherwise it is `${SEAZN_PLACEMENT_DIR:-$HOME/github/seazn.club.placement}`.
    - The venv lives in that dir.
    - Warn when that checkout's HEAD differs from `$root/packages/scheduler/VENDORED.json`'s `placementCommit`.
  - **`seazn-env.sh`, image mode (:336-342).** If `VENDORED.json` exists, `$cli pull` the pinned reference and tag it `placement-service:$label`. Otherwise build as today.
  - **`SKILL.md`.** Update §3b (:404-463: "`services/placement` is…", `cd services/placement`, `docker build … services/placement`) and the §3b "Stopping and cleaning up" and §6 :586 lines to match.
  - **Verify:** `seazn-env up --label 2a-check` on the `engine-split-2a` worktree. It must bring placement up natively from `~/github/seazn.club.placement`, and `lsof -nP -iTCP:<port> -sTCP:LISTEN` must show a PID from that run. Then `seazn-env down --label 2a-check`. Image mode cannot be verified on this machine, which has no container runtime; say so.
- [ ] **O11 — Rebase, push and open the PR.**
  - Wait until `fix/ci-run-instrumentation-register` has merged. It edits the `Start server` steps in ci.yml, e2e.yml and bench.yml, and is not on the remote as of 2026-10-25. Wait for #1013 too if it has merged (it edits ci.yml smoke-e2e).
  - Then `git fetch origin && git rebase origin/main` in the worktree. Re-run W2 Step 8 and W3 Step 6 after the rebase.
  - Push `feat/engine-split-2a` and open the PR. Its body has:
    - the three task summaries;
    - the two sha256 values from W1 Step 6;
    - the excluded `packages/engine` hits;
    - deviations a–e;
    - `Matrix rows: none — CI/infra relocation of the placement service; no engine, rule or sport behaviour changes`.
- [ ] **O12 — The remaining proofs (spec §6.6).** Paste every count and URL.
  - **Proof 2:** ci.yml's `scheduler-live` job is green. Paste its judge line `integration suite ran against the live service: N passed, 0 skipped`, plus the `.testResults[].name` list, which names both live files. Smoke-db, smoke-db-usecases and smoke-e2e are green, and their pull step logs a digest.
  - **Proof 3:**

    ```bash
    gh workflow run e2e.yml --ref feat/engine-split-2a -f pr=<PR number>
    ```
    Confirm that the run's `headSha` equals the branch head; a push to main cancels a dispatched run, so re-dispatch if it does. Expected: all three jobs green. Read `placement-cutover.spec.ts`'s three tests as passed from the report, not from the job colour.
  - **Proof 4:** `bench.yml` runs on the PR (its `pull_request` path is `bench.yml` itself). Expected: green with `--engine optimized` held.
- [ ] **O13 — The freeze check, right before merge.**

  ```bash
  cd ~/github/seazn.club && git fetch origin && git diff --stat placement-split-base origin/main -- services/placement proto
  ```
  Expected: empty. If it is not empty, STOP. The delta goes to the placement repo as a PR first, then W1 is re-vendored.
- [ ] **O14 — OWNER GO: merge the web PR.**
  - The push to `main` triggers e2e.yml. Watch it: the agents hand back, and the main session watches CI.
  - `placement-stg.yml` and `placement-prod.yml` no longer exist on main, so their disabled state is moot.
- [ ] **O15 — Close.**
  - Announce the end of the freeze to the peers.
  - Persist the state: the engine-split sequencing memory, and `reviews/2a-*.md` status.
  - Tell the owner that old checkouts still hold an ignored `services/placement/venv/`, which can be deleted at leisure.

## Rollback (spec §6.7)

Revert the web PR with `git revert -m 1 <merge sha>`, as a PR, OWNER GO. That restores the tree, the proto and the three workflows. Then `gh workflow enable placement-stg.yml` and `gh workflow enable placement-prod.yml`; they were disabled at O3, and a revert does not re-enable them.

`seazn-env` falls back to `$root/services/placement` on its own. The placement repo, the GHCR package and its images are kept, never deleted.

**Before O14, a bad stg deploy from the new repo is rolled back by:**
1. re-enabling the two old workflows;
2. the owner redeploying `placement-stg` from seazn.club per `services/placement/DEPLOY.md` (`fly deploy services/placement --config services/placement/fly.toml --app placement-stg`).

## Owner rulings on the open questions (2026-10-25, "Apply rec from 1-3")

1. **Placement prod release trigger:** a `v*.*.*` tag in the placement repo (deviation c accepted). seazn.club's release tag no longer ships placement.
2. **The 5 comment-only `services/placement` / `proto/` references in `packages/engine/src/scheduling/**`:** left out of this PR. Fixed in a one-line follow-up after W2d merges; the PR body lists them.
3. **Branch protection on `onryde/seazn.club.placement` `main`:** after O5's first green run, the owner requires `ci`'s `test`, `docker` and `buf-breaking` checks (owner UI step).

**Placement is an internal service only** (owner, 2026-10-25). It is reached only over Fly private networking (`placement.flycast:50051`, private IPv6, DEPLOY.md §2), never from the public internet. Task P3's deploy workflows MUST keep it so: after each deploy, `flyctl ips list --app <app> --json` is checked and the job fails if any address is public (anything other than a private v6). No workflow ever runs `fly ips allocate-v4`, `allocate-v6` without `--private`, or adds an HTTP handler to `fly.toml`'s `[[services.ports]]`. P3 ships a test that pins both rules.

4. **No re-add guard in W3** (owner, 2026-10-25, "3 dont add guard"). The deletion ships without `placement-moved-out.test.ts`; Review Focus 4 and Steps 1, 2, 7 of W3 are superseded.

**Visibility** (owner "Ok", 2026-10-25): the repo and the GHCR image stay PUBLIC as planned. "Internal only" governs the network, not visibility; nothing in the repo or image is secret (the shared secret lives in Fly secrets).
