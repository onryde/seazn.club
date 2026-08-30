<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:session-handoff -->
## Compact instructions
When compacting, preserve: current task state, files touched this
session, decisions made, and the latest test results.
Drop: full file contents already committed, exploration dead ends,
and resolved error output.
<!-- END:session-handoff -->

<!-- BEGIN:orchestration -->
## Orchestration (long sessions)

Main thread is the orchestrator, not the reader. Every file dump pulled
into main context is a permanent tax on the rest of the session.
Delegate reads; keep decisions. Full rationale and the wave recipe:
`docs/agent-playbook.md` — read it before running a multi-task wave.

**Delegate vs inline.** Broad fan-out ("where is X", "what calls Y",
"map this dir") → `scout` or `Explore`. Scoped task with acceptance
criteria → `implementer`. Diff review before commit → `reviewer`.
Known file + known symbol + one fact → do it inline; a subagent spawn
costs more than the answer. Never delegate a search *and* run it too.

**Every dispatch carries five things** or the agent guesses: exact file
paths, acceptance criteria, what NOT to touch, the verify command to
run, and an output cap. Default cap: "final message under 15 lines —
counts, paths, deviations, blockers; no file contents or diffs."

**Parallel only when file sets are provably disjoint.** Ownership lists
do not hold: a production change routinely forces a test-file edit into
someone else's lane. Overlap → sequential, or `isolation: "worktree"`.

**Never accept "done, tests pass"** without the raw counts pasted back.
Rerun the gate yourself at the wave boundary.

## Environment setup

Standing up a local environment — a fresh DB, a worktree, a prod server
for smoke or e2e — has an ordered recipe, and several of the obvious
shortcuts return HTTP 200 or exit 0 while serving, testing or compiling
the wrong thing. **Follow the `seazn-local-env` skill**
(`~/.claude/skills/seazn-local-env/SKILL.md` — invoke it with the Skill
tool, or just read the file; it is machine-local, so a fresh clone on
another machine will not have it). Its §5 also lists the environmental
red signatures here, so an environment fault is not reported as a defect.

The two that cost the most, if you read nothing else: `db:apply` alone is
NOT a fresh schema (it needs `sync:sports`, or `funnel.test.ts` fails
`expected 'generic' to be 'badminton'`), and a `pg_ctl` that fails with
"Address already in use" is followed by a `createdb` that SUCCEEDS —
against another session's server. Confirm `show data_directory` is yours.

## Verification traps in this repo

Tool wrappers here lie in specific, repeatable ways. Assume these
before diagnosing a real bug:

- `rtk` vitest summaries print `PASS(0) FAIL(0)` for a suite that
  **failed to collect**, and swallow exit codes. Judge green only from
  `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`).
- `rtk` hides `npm run lint` output entirely; "ESLint output (JSON
  parse failed)" is the wrapper losing the result, not a clean run.
  Use `rtk proxy` and read `✖ N problems`.
- `npm test --workspace apps/web -- run <path>` treats positionals as
  **filename filters** — a typo silently runs a subset and reports
  green. Also: unset `DB_SCHEMA` and `--root` each under-report.
- `grep` reports files here as `Binary file … matches` and hides the
  lines. Always `-a` before concluding a call site does not exist.
- A killed background command reports **exit code 0** — that 0 is the
  SIGTERM. Have the command write `EXIT=$?` itself.
- **Shell cwd can reset to the main checkout between calls.** A verify
  run launched from a worktree then silently executes on `main` and
  returns a false green (12 tests, none of yours). Prefix
  `cd <abs worktree> &&` in the *same* call, and confirm the resolved
  paths in `.testResults[].name` before believing a count.
- **`git stash` in a worktree is not safe here** — the stash stack is
  shared with the main checkout. A no-op `stash push` followed by `pop`
  pops a *pre-existing foreign* stash and leaves `package.json` /
  `package-lock.json` unmerged, which blocks every commit in the tree.
- Assertions on a Next HTML body must anchor on `="` — React serialises
  an omitted prop as `"$undefined"`, so a bare `data-*` probe passes in
  both states.

## Recurring failure classes — read before claiming anything works

Generalized from ScoringPad v3 (R1–R5) and Registration (RS001–RS011); full
per-wave detail lives in each programme's `_INDEX.md`. Every class below
shipped at least twice, and the first four shipped **past a green suite**.

1. **The inert seam.** Code declared, typed and unit-green, but nothing in
   production ever sends or reads it. Recurred 6× (football `subWindows`, the
   two-step goal dock, tennis `pairOrder`, volleyball's anchor, the RS wizard
   payload) despite being named explicitly each time. A seam is proven only by
   driving it through its REAL producer and consumer — fold the builder's own
   output through the real engine/handler, or through the browser. A fixture on
   both ends proves the fixture.
2. **Pure-builder tests cannot see wiring.** `apps/web` vitest is
   `environment: "node"` — no DOM. A green builder suite is blind to stale
   closures and re-invocation, to CSS cascade, and to real tap area
   (`boundingBox()` measures paint; hit-test with `elementFromPoint`). Changed
   something a user touches ⇒ re-run the e2e that covers it, not just the unit.
3. **A guard nothing kills is not tested.** Mutate it — delete the predicate,
   `return true`, comment out the taps. Still green ⇒ the test is decoration (a
   97-test suite stayed green with a predicate body replaced; a probe passed
   with both its taps commented out). Two guards covering for each other are
   each untested: mutate them one at a time.
4. **Tests lie in their names.** One asserted the opposite of its title; one
   froze a live bug as its expected value and carried it through two sign-offs.
   Read what a test ASSERTS, never what it is called.
5. **The brief is a hypothesis.** 15 briefed premises proved false in one
   programme — engine capabilities that did not exist, "layout complaints" that
   were dead taps, defect rows owed by a different wave. Re-pin every line
   number and re-verify every capability claim against the tree before building
   on it. A false premise is a finding to record, not a blocker.
   **A grep is not a read.** Three assertions were made and withdrawn in one
   day — a table "is alphabetical" (it was wave order), a colour "reads as
   green" (it was a teal, blue channel leading), a seam "never reaches the UI"
   (static values arrived; only the conditional shape was dead). Each came from
   a grep that showed what exists and was then asserted to show how it is
   ordered, shaped, or routed. Open the file before asserting a property of it.
6. **An absent symptom can mean suppressed, not safe.** An over-refusing guard
   silently dropped a wave's headline stat and looked clean.
7. **One sample is not a parity sweep.** Serve/rotation/alternation bugs hid
   behind a single lucky score. Enumerate the table.
8. **Green and pushed is not done.** Reviews run after a green push still found
   live defects, twice. Run the final review anyway; re-run a flaky-shaped gate
   three times before believing it.
9. **The runner lies about scope.** `--root apps/web` loses 208 tests and
   invents 21 ENOENT failures; vitest from a worktree root reported
   `numFailedTests: 0` while 25 suites failed to COLLECT. Use
   `cd apps/web && vitest`, the JSON reporter, and confirm `.testResults[].name`.
10. **The visual gate has its own vacuous mode.** The capture harness once
    errored before a single screenshot and would have collected a sign-off on
    zero pictures; shared states were pixel-identical because nothing opened; a
    width raced the fold. Confirm the images exist, DIFFER, and that the last
    check runs after the state being proven.
11. **Sign-off means per-screen verdicts.** "CI green" / "no gaps" was taken as
    merge sign-off twice. It is not.
12. **Never skip the review loop.** Five implementers once ran back-to-back with
    zero reviewer passes; the wave was green and still Needs Fixes.
13. **An idempotency guard can skip a legitimate new arrival.** `if (already)
    return` also swallowed a late join, seating nobody. Check both directions.
14. **Environment before defect.** An unstarted local service, a turbo cache hit
    from another worktree, an accumulated test DB — reproduce on a clean
    detached worktree before calling any red pre-existing.
15. **A green suite is not a working product.** Findings reachable from ~4,000
    passing tests: untranslated copy nothing renders, a defect in the gap
    between two individually-correct screens, a build serving a page whose
    chunks were never emitted (HTTP 200, tsc clean, page inert). Use the
    product and ask plain questions of the screen.
16. **Sweep by behaviour, never by filename.** An e2e sweep filtered on
    `registration*.spec.ts` missed the spec that actually exercised the path.
    Grep the selector, route or SQL pattern.

## Standing project rules

- **Read `docs/superpowers/RULES.md` first.** Owner's full standing
  policy — skills to actually use (not just cite), TS7/Node26, agent
  topology (Scout/Implementer/Reviewer, all Sonnet, xHigh for
  Implementer/Reviewer), all 4 required test types per task
  (unit/E2E/smoke/regression), greenfield schema stance, mobile+desktop
  UI bar, pre-commit OpenAPI drift check, and the no-new-issues /
  fix-inline-unless-blast-radius rule. Every dispatch brief should
  restate the relevant parts inline or point here explicitly.
- **`.github/workflows/e2e.yml` is LIVE, and it triggers on `push` to `main`
  only — NOT on pull requests, and NOT on a push to any other branch**
  (scoped to `branches: [main]` 2026-08-26, PR #656; before that it was
  `push:` with no branch filter from `b87def3ab` the same day, `pull_request:`
  from 2026-08-14 until then, and "disabled, never enable it" before that —
  this trigger has now changed three times in one day, so re-read the file
  rather than trust this paragraph). `workflow_dispatch` additionally takes a
  `pr` input, and is now the ONLY way to get an e2e run against a feature
  branch before it merges — a feature-branch push no longer triggers anything.
  **Opening a PR does not run e2e — pushing to `main` does.** A PR that sits on
  a feature branch gets zero automatic e2e signal, ever, until it merges (the
  exact opposite of smoke, which is PR-only — see the next bullet; the two
  trigger on disjoint events and neither substitutes for the other).
  Three jobs — `e2e-parallel` (sharded), `e2e-serial`, `e2e-mobile`
  (matrixed) — and **all seven width projects are covered** between them.
  Do NOT trust a job/leg count written here: this paragraph claimed "five
  legs" and was right for about four hours until #597 split the floor jobs
  (2026-08-17), then claimed "runs on PRs" until the trigger changed under it.
  **Read `e2e.yml` itself** — the only durable fact is that the seven widths
  are covered; the trigger and the arithmetic have both already gone stale
  here once. There is **no flag-forced scorepad-v2 job**; the file contains no
  `scorepad` or `flag` reference at all, so a scorepad change behind a flag
  gets NO dedicated CI coverage — cover it from a project that actually runs.
  An edit to that file's CONTENTS affects live CI rather than being dead
  weight. Verifying locally as well is still useful (prod build +
  `E2E_PROD_TARGET`) — CI is the arbiter, not the only signal.
- Smoke CI runs on **PRs only** — merging locally and pushing to `main`
  skips it. Behavior changes need a PR or a local full-smoke first.
- Every change ships a test that fails without it.
- Any new or changed user-facing string → all 4 locale dictionaries,
  never hardcoded English. Two exceptions, both English-only with no
  i18n work owed: `content/help/**` (one English tree) and
  `apps/web/src/games/**` (Seazn Games — declared 2026-08-26, spec
  `docs/superpowers/specs/2026-08-26-games-board-redesign-and-new-games-design.md`).
- UI work is verified by screenshot at desktop (1280), **320px**, and
  **768px**, with no horizontal page scroll at any of them; the
  seven-width e2e matrix (320/360/375/390/430/768/834, `mobile.spec.ts`
  projects) is the enforcement backstop. `/admin` is staff-only —
  functional bar, skip design polish; every other surface keeps full
  polish.
- New branches go in a worktree; never check out in the main repo dir.

## Live programmes — read the index before touching their code

Some areas carry rulings that are NOT derivable from the code and that
a fresh session will otherwise re-derive wrongly. If your task touches
one, read its index first. Cross-programme sequencing and gates:
`docs/superpowers/specs/bench-product-value/_MASTER.md`.

- **Scoring / sport modules / the scoring pad / fidelity tiers** →
  `docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md`
  (decision log, false premises found, session status), then
  `_RULES.md` beside it. Design of record:
  `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md`.
  Two rulings that bite immediately: the fidelity band scale is
  **closed at 0–3** (no tier 4, ever), and engine comments citing
  **"doc 14" point at a document that does not exist** — the scale's
  semantics live in `packages/engine/src/sport/module.ts`, nowhere else.
<!-- END:orchestration -->
