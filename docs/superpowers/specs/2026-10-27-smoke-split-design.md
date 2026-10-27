# Smoke split — design

Status: draft for owner review. Date: 2026-10-27.

## Intent
`scripts/smoke.ts` is ~25k lines. It is slow to edit and is a standing merge-conflict hotspot against every open
branch. Split it into a harness plus one file per suite so edits are local and conflicts shrink.

## Goals
- `scripts/smoke/harness.ts`: shared state and helpers (pass/fail counters, `check`, `step`, `tag`, sessions, `call`,
  `v1`, `setPlan`, `cleanup`, the existing `SubsetCtx`/`subsetSetup`/`SELECTABLE_SUITES` machinery).
- `scripts/smoke/suites/<name>.ts`: one suite per file. The 28 existing `*Suite` functions each move as-is.
- The inline checks in `main()` (~1,100 lines, ~60 `// --- section ---` blocks) are grouped by topic into new suites,
  so `main()` becomes an ordered list of suite calls.
- An index lists suites in their CURRENT run order. No reordering.
- `npm run test:smoke` and `SMOKE_ONLY` keep working unchanged; `smoke-select.ts` is untouched.
- Proof of no behavioural change: suite names, order and per-suite check counts identical before and after, via
  `scripts/smoke-manifest-diff.ts` (already built, branch `chore/smoke-manifest-diff`), plus the PR's own CI smoke.

## Non-goals
- No change-based skipping: every PR runs ALL suites (owner, 2026-10-27).
- No new checks, no rewording, no behaviour fixes. A defect found mid-move is recorded, not fixed here.
- Not a published package; stays under `scripts/`.
- `smoke-sports.ts` is out of scope.

## Anti-goals
- A split that is green because a suite silently stopped running or lost checks.
- Reordering suites: shared state and DB side effects make order load-bearing.

## Constraints
- Own PR, mechanical. Starts only after W2d PR B merges (a mid-wave split conflicts with every open branch).
- Worktree, never the main checkout. No full local smoke or full vitest (standing rule): local = `tsc` + the
  manifest-diff test + scoped `SMOKE_ONLY` at most; the arbiter is the PR's CI smoke job.
- Module-level mutable state (`pass`, `fail`, `steps`, `tag`) must live in exactly one module and be shared by
  import, never copied.
- `node --experimental-strip-types`: relative imports carry the `.ts` extension; no enums/namespaces.

## Manifest emitter (lands in the split PR, edits smoke.ts)
When `SMOKE_MANIFEST=<path>` is set, snapshot `pass+fail` around each suite call and write `{suite, checks}[]` in run
order. Unset = byte-identical behaviour. Baseline manifest comes from CI on the base commit; compare with the after
manifest using the diff script. Static counts are NOT proof (loops/helpers run checks many times).

## Decided by owner
Split harness/suites/index; group `main()` inline checks; keep every-PR full run; CI is the validator.

## Left to the builder
- Topic grouping names/boundaries for the inline checks (follow the existing section comments).
- Whether state is exported as live bindings or a small object.
- How the CI job exposes the manifest (artifact vs log).
