# Smoke split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `scripts/smoke.ts` (~25k lines) into `scripts/smoke/` (harness, suites, main, index) with provably identical suite names, order and check counts.

**Architecture:** Two PRs. PR1 adds a per-suite manifest emitter (`suite(name, fn)` wrapper + `SMOKE_MANIFEST`) and the diff script, changing no behaviour. PR2 moves code mechanically; `main()` moves whole into `main.ts` (spec correction), suites go one per file. CI smoke on both PRs yields the before/after manifests.

**Tech Stack:** Node `--experimental-strip-types` (relative imports end `.ts`; no enums/namespaces), vitest for `scripts/__tests__`, GitHub Actions smoke job.

**Spec:** `docs/superpowers/specs/2026-10-27-smoke-split-design.md` (read the "Correction" and "Owner ruling … option B" sections first).

## Global Constraints
- Starts only after W2d PR B merges; branch from fresh `origin/main` in a worktree, never the main checkout.
- NO full local smoke / full vitest. Local gate = scoped vitest (`scripts/__tests__/smoke-*.test.ts`) + `tsc` for scripts. Arbiter = the PR's CI smoke job.
- Every PR runs ALL suites. No change-based skipping.
- No new checks, no rewording, no reordering, no defect fixes in the move (record defects, don't fix).
- Module-level mutable state (`pass`, `fail`, `smokeWebhookSeq`) lives in exactly one module, mutated only there.
- `smoke-select.ts` and `SELECTABLE_SUITES` semantics unchanged; `npm run test:smoke` unchanged.
- Judge vitest only from `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`) and confirm `.testResults[].name` paths.
- Internal tooling: no mutant sweeps or extra test scaffolding.

## Review Focus
- A suite that stops running (call deleted/lost in the move) while the run stays green → diff reports `missing after`.
- A suite running with fewer checks (loop/helper moved wrongly) → diff reports `checks changed`.
- Reordered suites (shared DB state is order-load-bearing) → diff reports `order changed`.
- `pass`/`fail` copied instead of shared → totals drop to 0 or double; the final `N passed, M failed` line must equal the baseline.
- A failing run must still write the manifest (written in `finally`) and exit 1; an empty manifest must not compare as a match.

---

### Task 1 (PR1): Manifest recorder and `suite()` wrapper
**Files:** Create `scripts/smoke-manifest.ts`, `scripts/__tests__/smoke-manifest.test.ts`. Modify `scripts/smoke.ts`.
**Interfaces:**
- Produces: `createManifestRecorder(total: () => number): { run<T>(name: string, fn: () => Promise<T>): Promise<T>; entries(): SmokeManifestEntry[] }` where `SmokeManifestEntry` is imported from `scripts/smoke-manifest-diff.ts` (`{suite: string; checks: number}`). `checks` = `total()` delta across the call. Inline checks outside any `run` are recorded once as a final entry `{suite: "(inline)", checks: total() - sum of suite deltas}` by `entries()`.
- [ ] **Step 1:** Cherry-pick `af0f7f4a8a` (diff script + test) from `chore/smoke-manifest-diff` onto the PR1 branch.
- [ ] **Step 2:** Write failing tests in `smoke-manifest.test.ts`: `records one entry per run in call order`; `checks is the total() delta, so a suite that runs 3 checks reports 3`; `(inline) holds checks made outside any run`; `a run that throws still records its partial delta, then rethrows`; `a name used twice throws` (duplicate names would break the diff's parse).
- [ ] **Step 3:** Run them with the repo's explicit-binary command (`./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=<scratchpad>/vt.json scripts/__tests__/smoke-manifest.test.ts`); expect FAIL (module missing).
- [ ] **Step 4:** Implement `createManifestRecorder` in `scripts/smoke-manifest.ts` (pure; no I/O). Rerun; expect `numPassedTests == numTotalTests`.
- [ ] **Step 5:** Commit.

### Task 2 (PR1): Wire the recorder into `smoke.ts`
**Files:** Modify `scripts/smoke.ts` (module top near `let pass`/`fail` ~line 145; every suite call inside `main()` and the entry block ~23899+).
**Interfaces:** Consumes `createManifestRecorder`. Produces module-level `const suite = recorder.run` and, when `process.env.SMOKE_MANIFEST` is set, a `writeFileSync(path, JSON.stringify(entries(), null, 2))` in the entry block's `finally`-equivalent (before `process.exit`, on success AND on the catch path).
- [ ] **Step 1:** Replace each `await xSuite(args)` / `await xSmoke(args)` in `main()` with `await suite("x", () => xSuite(args))`, keeping position and arguments byte-identical otherwise. Suite name = the function name without a trailing `Suite`; non-`Suite` names (e.g. `matchCentreSmoke`) keep the full function name. Do it with a one-off script from the scratchpad, not committed; review the diff by eye: only wrapper text changes, call count unchanged (record the before/after count of awaited calls).
- [ ] **Step 2:** Wire `SMOKE_MANIFEST` write in both the `.then` and `.catch` paths of the entry block; unset ⇒ no behaviour change.
- [ ] **Step 3:** Run `tsc` over `scripts/` (the repo's scripts tsconfig) and the two scoped vitest files; expect green.
- [ ] **Step 4:** Commit, push, open PR1. CI smoke must pass. Add a step (or one-time manual `gh run download`) so the smoke job exposes the manifest: set `SMOKE_MANIFEST=smoke-manifest.json` for the smoke step and upload it as an artifact `smoke-manifest`. Keep this to the smallest `ci.yml` edit; read the file first, it is live CI.
- [ ] **Step 5:** After PR1's smoke job is green, download its artifact as `baseline.json` and note the run id and the final `N passed, M failed` line in the PR2 description. Baseline must be from PR1's head (same code shape as `main` + wrapper).

### Task 3 (PR2): Inventory and harness extraction
**Files:** Create `scripts/smoke/harness.ts`. Modify `scripts/smoke.ts`.
**Interfaces:**
- Produces from `harness.ts`: `check(label: string, cond: boolean): void`, `expectFail(label, fn)`, `counts(): {pass: number; fail: number}`, `nextWebhookSeq(): number` (replaces the `smokeWebhookSeq++` sites), `tag`, `Session`/`newSession`, `call`, `raw`, `signIn`, `v1`, `v1data`, `setPlan`, `cleanup`, plus any helper used by 2+ suites. A helper used by exactly one suite stays with that suite (Task 4).
- [ ] **Step 1:** Enumerate every top-level declaration of `smoke.ts` with start/end lines (a scratchpad script; output a table: name, kind, lines, which top-level functions reference it). Keep the table in the PR description, not the repo.
- [ ] **Step 2:** Move shared state and shared helpers into `harness.ts`. `pass`/`fail` become private to the harness with `counts()`; `check` mutates them there. Replace direct `pass`/`fail` reads with `counts()`.
- [ ] **Step 3:** `tsc` + scoped vitest; expect green. Commit.

### Task 4 (PR2): Move suites, `main.ts`, `index.ts`
**Files:** Create `scripts/smoke/suites/<name>.ts` (one per suite function; its single-use helpers/consts go with it), `scripts/smoke/main.ts`, `scripts/smoke/index.ts`. Modify `package.json` `test:smoke` script paths; leave `scripts/smoke.ts` as a re-export stub only if another file imports it (grep first with `-a`), otherwise delete it.
**Interfaces:** Each suite file exports its function with an unchanged signature. `main.ts` exports `main()` unchanged except imports. `index.ts` owns `selectSmokeSuites`/`SELECTABLE_SUITES`/`subsetSetup`/`runSubset`, the entry `.then/.catch`, the manifest write and `process.exit`.
- [ ] **Step 1:** Move suites in batches by file-range using the Task 3 table; imports use `./…ts` extensions. Do not edit function bodies. `main.ts` keeps `main()` whole and calls the imported suites at the same positions.
- [ ] **Step 2:** Update `package.json` `test:smoke` to `node --experimental-strip-types scripts/smoke/index.ts`. Grep `.github/workflows`, `docs`, `scripts` (with `-a`) for `scripts/smoke.ts` and fix references.
- [ ] **Step 3:** `tsc` over `scripts/` + scoped vitest; expect green. Quick local sanity that the entry loads: `SMOKE_ONLY=<bad name> node --experimental-strip-types scripts/smoke/index.ts` must exit 1 with the selector's own message (no server needed).
- [ ] **Step 4:** Commit in reviewable batches; push; open PR2 with the baseline run id.

### Task 5 (PR2): Prove nothing changed
- [ ] **Step 1:** After PR2's CI smoke is green, download its `smoke-manifest` artifact as `after.json`.
- [ ] **Step 2:** Run `node --experimental-strip-types scripts/smoke-manifest-diff.ts baseline.json after.json`; expect `smoke manifests identical`, exit 0. Also confirm both runs print the same `N passed, M failed` line and `after.json` has the same entry count as the number of wrapped calls + 1 (`(inline)`).
- [ ] **Step 3:** If any difference: fix the move, never the baseline. A serial/flaky-shaped red: rerun CI three times before believing it.
- [ ] **Step 4:** Reviewer pass (`reviewer` agent) on PR2 before merge; post the diff output in the PR.

## Self-Review notes
- Spec coverage: harness/suites/index (T3–T4), `main` correction (T4), manifest + diff (T1–T2, T5), every-PR full run (no skipping task exists by design), CI-only validation (T2 step 4, T5).
- `(inline)` exists because `main()` still owns inline checks under option B; its count is part of the proof.
