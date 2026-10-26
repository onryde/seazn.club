# Phase 2a Batch W: Opus batch review

**Scope:** branch `feat/engine-split-2a`, HEAD ed720b84a2, base 0f2fc5478c.
**Verdict (first pass):** NEEDS FIXES. 0 Critical, 1 Important, 4 Minor.

## Verified
- **The pin reaches a real consumer.** The published GHCR config at `9684aa96…` is linux/amd64, Cmd `python3 -m placement.main`, port 50051.
  - Every one of the seven jobs pulls once, before its `docker run … placement-service:ci`.
  - `scheduler-live` maps 50051 and dials `localhost:50051`.
  - The secret `ci-integration-secret` matches on both sides and is pinned as equal.
- **The vendored bytes are the tag's bytes.** sha256 `92d1827b…4b45` equals the `placement-split-base` blob and an anonymous raw fetch at 9684aa9. `gen-proto` with no root `/proto` regenerates byte-identical stubs.
- **No live consumer of the removed paths** in workflows, `tools/**`, `apps/**`, the Dockerfile, README, AGENTS.md or the `seazn.club.workflow` sibling.
- **Merge hazards are clear:**
  - the old placement-stg and placement-prod workflows are deleted and `disabled_manually`;
  - seazn.club `main` has no protection and no rulesets;
  - `merge-tree` against origin/main is clean;
  - the freeze holds.
- **Rollback is executable:** one `git revert -m 1` (see m-3).
- **Gates:**
  - scheduler, run as ci.yml's gates step runs it: 228/228 (10 files)
  - apps/web readers: 150 passed, 10 pending (pre-existing skipIf)
  - root/tools: 336/336
  - actionlint and shellcheck: no new issues

## Important
- **I-1. `placement-pin` can be silenced.** `if: false` or `continue-on-error: true` on the `placement-pin` job header (ci.yml:2059-2063) skips `scheduler-live`, the only real-solver job, while the run stays green.
  - Mutants M5 and M6 both stay 155/155.
  - The title at `placement-image-wiring.test.ts:608-614` overclaims.
  - Fix: apply the job-header refusal (`if`, `continue-on-error`, `defaults`) to `placement-pin` as well, and add a negative self-test.

## Minor
- **m-1. A lying pin is undetectable.** A mixed triple (copy and sha256 updated, `placementCommit` stale) passes.
  - Fix: a `placement-pin` step anonymously fetches `raw.githubusercontent.com/onryde/seazn.club.placement/<placementCommit>/proto/scheduler.proto` and compares the sha256 with `::error::` on mismatch. Executed-test it with a curl shim.
- **m-2.** The title "the seven blocks carry no build tooling" checks only build-push-action and setup-buildx. Retitle it; wider detection is the owner's call (ruling 4).
- **m-3. The plan's Rollback leaves two deployers per Fly app.** Amend it to also `gh workflow disable stg.yml prod.yml -R onryde/seazn.club.placement`.
- **m-4.** `stg.yml:10`: the job is `deploy-prod`, not `deploy`.

## Design gap for the owner (not a blocker)
`VENDORED.json` pins CI only.
- **Forward:** a placement-repo behaviour change reaches stg and prod without the TypeScript live suite.
- **Reverse:** a web release with a newer proto can run against an older prod placement.
- **Options:**
  - the placement `prod.yml` refuses a tag that web has not vendored; or
  - a scheduled web job runs `scheduler-live` against the deployed image.

## Signal
- **On this PR:**
  - ci.yml: gates, smoke ×3, `placement-pin`, `scheduler-live`;
  - bench.yml.
- **Unproven until O12:** e2e.yml's three jobs, including `placement-cutover.spec.ts`. The dispatch must use `--ref feat/engine-split-2a`.
- **A future re-vendor PR gets no bench and no e2e signal.** Document "dispatch e2e on a re-vendor PR".

## Mutants
- M3 (`.gitattributes`): killed.
- M1: survived (m-1).
- M2: survived (m-2).
- M4: caught at runtime by the wait gate.
- M5, M6: survived (I-1).

## Re-review (821cf6906e)
- **Verdict: READY.** I-1, m-1, m-2 and m-4 are closed.
- **New, fixed in the follow-up commit:**
  - m-A: the job-key check was a denylist, so `needs: matrix-sample` on `placement-pin` (a job with its own `if:`) skipped both live jobs with the run green. The job-level keys of `placement-pin` and `scheduler-live` are now pinned exactly, and `scheduler-live` needs exactly `placement-pin`.
  - m-B: the `verify-pin` curl shim never asserted `--max-time`; it now does, on every fetch.
- **Checked and fine:** fail-open on a malformed or missing field, exact bytes of the fetched file, fork PRs (the anonymous fetch needs no secret).
