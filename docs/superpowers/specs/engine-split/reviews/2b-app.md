# Engine split 2b — Batch A close review (app cutover)

Branch `feat/engine-split-2b` at `babc888c3b` (on `eacdb01244`; merge-base with main `87a287c1c6`). Engine `@onryde/seazn-engine@1.0.0` (v1.0.0 = `fb7d7e4`). Opus reviewer, 2026-10-30. Saved by the orchestrator: the reviewer's contract is read-only.

**Verdict: NOT READY.** 0 Critical, 1 Important, 10 Minor. It becomes READY once I1 is fixed. The fixes are recorded below the findings.

## Owner hard gates

- **Gate 1, smoke/e2e/walkthrough specs unchanged:** passes. `apps/web/e2e/**` and `*.spec.ts(x)`, diffed against the merge-base, give 0 files. Smoke, walkthrough and playwright configs give 0. `e2e.yml` changes only auth lines; spec selection, filters, shards and projects are untouched.
- **Gate 2, no assertion weakened:** fails as written, on I1 only. Everything else falls into the allowed categories:
  - path and import re-pins;
  - installed-package reads;
  - ledgered deletions;
  - the ruling-A splits;
  - floors lowered by exactly the deleted count;
  - npm-alias re-pins.

  The added `packages: read` permission pins are stronger, not weaker.
- **Parity:** before-only 124 · after-only 116 · both 21712 · unaccounted 0, exit 0.

## Important

**I1. Assertions removed inside test ids that survive are not in the ledger.** Id parity can't see these, so `unaccounted 0` holds anyway.
- `apps/web/src/__tests__/toolchain.test.ts:67-78`: the `web.target === engine.target` check is gone, but the title still says "matching the engine". The engine repo has no ES2022 pin test.
- `tools/matrix/__tests__/single-sport.test.ts:129` (scope test): the 6 engine fixtures and 5 pins are dropped, and `scanned` went from 6 to 2.
- `tools/matrix/__tests__/single-sport.test.ts:939-950` (real-tree test): the cricket witness and the engine-module-import witness are dropped. Measured: deleting the import-pick push at `tools/matrix/single-sport.ts:302` reds only the unit test at `:162`. The app tree still has an import pin to use: `apps/web/src/components/v2/scorepad/v3/__tests__/boardgame-tiebreak.test.ts:7` (sport boardgame).
- The A3 commit lists single-sport as a ruling-A split, but the engine repo has no half for it. Its v1.0.0 `test/single-sport.test.ts` holds only the 3 HEAD^1 CLI tests.
- `tools/matrix/__tests__/workspace-wiring.test.ts`: `toContain("packages/engine")` was removed with no ledger row. Its subject left the repo; only the record is missing.

Fix:
1. Retitle the toolchain test to "apps/web targets ES2022".
2. Add a real-tree import witness that checks the pick kind (`via === "import"`) on the boardgame-tiebreak pin.
3. Add one ledger note per narrowed id.
4. Correct the single-sport ruling-A claim in the ledger and the PR body.

## Minor

| # | Where | Finding |
|---|---|---|
| m1 | `packages/reference/test/boundary-gate.test.ts:303-304` | Imports `./core/index.ts`, which no longer exists behind the `dist/core` link, so the witness is lost. Use `./core/index.js`. |
| m2 | `scripts/__tests__/engine-package-identity.test.ts:15,56` | Dead `ENGINE_MANIFEST` filter. Delete it. |
| m3 | `scripts/__tests__/dockerignore.test.ts:114` | Witness path no longer exists, so the check is vacuous. Point it at a `packages/scheduler/src` path. |
| m4 | `AGENTS.md:408`, `README.md:19,27,60,89,94`, `.gitignore:63-69`, `.dockerignore:12,30` | Stale `packages/engine` references. |
| m5 | `.github/workflows/ci.yml:137,141` | The link/file guard misses `@onryde/seazn-engine` keys and override blocks. |
| m6 | `scripts/__tests__/registry-auth-workflows.test.ts:178` | Floor is `> 0`. The plan's "26" was a false premise; the real count is 21. Record it. |
| m7 | branch | origin/main has moved 11 commits ahead. Merge it in before pushing; `git merge-tree` is clean. |
| m8 | PR body | Needs the `Matrix rows: none — …` line; pr-rows exits 1 without it. |
| m9 | `tools/matrix/lib/audit-ledger.ts:34`, `tools/matrix/ci/pr-rows.ts` `DECLARING` | Dead engine-path constants. |
| m10 | A3 note | Parity numbers are stale (123/115/21713). Update them to 124/116/21712. |

## Engine-repo items owed (not blockers)

1. An ES2022 target pin.
2. A `ban-ts-comment` pin on the engine's eslint config.
3. A single-sport scanner suite covering the multi-root ZERO refusal and the scope-directory behaviour. None of the three has a test at v1.0.0.

## Strengths

- The registry-auth sweep killed 9 of 9 hand-mutants: stg install with no token, `packages: read` dropped from a deploy job and from a calling job, `registry-url` dropped, a token hoisted to the job, the Docker secret mount dropped, a Docker `ARG` token, an `.npmrc` credential, and a folded-scalar install.
- The pr-rows lock rule works on a real lock diff. Second-call and empty cases are covered.
- A lock bump moves the turbo cache hash.
- Scoped runs: 9 runs, 0 failed tests, 0 failed suites, all EXIT=0. tsc is clean for web and tools-tests.
- Ledger: all 58 `moved` targets exist in the engine repo, and 13 sampled `retired` reasons are honest.

## Not provable locally (CI items, O10)

- The Docker install using only the npmrc secret.
- setup-node's user-level npmrc on a hosted runner. The first container job proves both.
