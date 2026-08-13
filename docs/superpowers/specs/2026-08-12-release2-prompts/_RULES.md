# Standing rules — every release-2 session

Read this **first**, then `_INDEX.md`, then your session's prompt. Prompts
assume this file and do not repeat it.

## 1. Owner rules (non-negotiable)

- **Don't raise new issues.** Found a defect or a false premise in the brief?
  Fix it in-session; if the blast radius exceeds the stated file set, ask
  first. Record under `Unplanned fixes` in the PR body.
- **Think past the literal brief.** A wrong premise is a finding, not a
  blocker — re-verify every `file:line` in the prompt before trusting it;
  they drift.
- **One PR per session.** Smoke CI runs on **PRs only** — merge-local + push
  skips it. Never enable `.github/workflows/e2e.yml`.
- **New branch in a worktree**, never a checkout in the main repo dir.
  `pnpm install --frozen-lockfile` there (not `npm ci`). Check
  `readlink -f node_modules/@seazn/engine` — a symlink to MAIN's engine
  makes every engine edit invisible to your tests.
- **Every change ships a test that fails without it.** All 4 test types per
  task (unit/e2e/smoke/regression) or the PR body says which are deferred and
  why.
- **i18n:** any new/changed user-facing string → all 4 locale dictionaries
  (flat dotted keys), never hardcoded English. Grep e2e for changed UI text
  before merging.
- UI verified by screenshot at 1280 / **320** / **768**, no horizontal
  scroll. `/admin` is functional-bar only.

## 2. Environment

Bring-up (fresh DB, worktree, prod server for smoke/e2e): follow the
`seazn-local-env` skill — `db:apply` alone is NOT a fresh schema (needs
`sync:sports`); never bind :3000; never touch the local dev DB; confirm
`show data_directory` is yours.

**A BRAND-NEW DATABASE FOR EVERY FULL DB-BACKED RUN.** Not per session, per
RUN. This is written here rather than left to the skill because on 2026-08-13
two sessions independently lost hours to it in one afternoon, both of them
with the trap already recorded and both of them reusing a database anyway:

- a C2 run's failure SET moved between otherwise identical runs (5 failures,
  then a different 5, then 7), which made a design problem look like a tuning
  problem and cost three wrong fixes before a fresh DB steadied the signal;
- a P5 lane accumulated **25 427 organisations** across a day, and
  `sweepWeeklyDigests` — which walks every org — went red on the volume alone.

Rebuild it: `initdb` a new datadir, confirm `show data_directory` is yours (a
`pg_ctl` that fails "Address already in use" is followed by a `createdb` that
SUCCEEDS against someone else's server), then `db:apply` + `sync:sports`.

**And baseline before attributing.** Run the same command on `origin/main`
with the same DB and the same services before calling any red yours. For the
DB-backed suites that is
`npm test --workspace apps/web -- src/server src/lib` with
`PLACEMENT_SERVICE_HOST` set; main was 4518/0 on 2026-08-13. Several reds that
looked like C2's were main's, and one of them is INTERMITTENT at 1-in-3 — so
run it more than once in each arm before believing either colour.

## 3. Verification traps that bite these tasks specifically

- **rtk wrappers lie:** vitest green only from
  `--reporter=json --outputFile` (`numPassedTests`); lint via `rtk proxy`;
  bare `tsc`/`--version` output can be fabricated — `rtk proxy` for both.
- `npm test --workspace apps/web -- run <path>` treats positionals as
  filename **filters** — a typo runs a subset and reports green.
- **Placer/verifier parity:** any rule added to the Python model MUST land in
  the TS verifier with the same numbers/comparisons, and a test must hold one
  board against both sides. This fork is the recurring bug (3× in one
  session).
- **Solver benches:** N ≥ 6 runs per side — n=1 vs a nondeterministic solver
  is a coin flip. The solve wall has TWO env-var ceilings on separately
  deployed apps; raising one alone is inert.
- **Drift gates are CI-only:** `openapi:gen`, `i18n:gen-keys`,
  `schema:snapshot` — run locally, `git status --porcelain` clean before PR.
- **`ScheduleConfig` is the READ path** — narrowing a stored enum without
  migrating rows first 500s them. Migration before narrowing, always.
- `grep` here reports source files as "Binary file … matches" — use
  `git grep` / `-a`. Counts under `apps/` must exclude `.next/types`.
- Engine has its **own** lint task (`@seazn/engine#lint`); root lint skips it.
  apps/web typecheck peaks ~2.8 GB (`NODE_OPTIONS=--max-old-space-size=6144`);
  `tsc | tail; echo $?` reports tail's status — have the command write
  `EXIT=$?` itself.
- Proto changes: additive fields are safe across the stg/prod deploy split;
  renumbering or repurposing is never safe. Reserve, don't reuse.
- `settings.orgTz` is the governing clock; `settings.tz` is display only.

## 4. Skills — load, don't cite

| When | Skill |
|---|---|
| before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review` + `/code-review` |
| worktree setup / red-suite triage | `seazn-local-env` |
