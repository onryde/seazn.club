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
   **And a read is not a run.** The step after that one: "this function has no
   production callers" is grep-checkable and was true; "so users see the editor
   demanding a goalkeeper" was inferred from it, recorded as a customer fact by
   two sessions, and false — the editor had never expressed minima at all. A
   claim about what a PERSON SEES is settled only by driving the product. Write
   down what you saw, never what must be true.
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
17. **Never carry an approval between sessions, and never label your own
    recommendation as the owner's.** A peer session cannot receive the owner's
    authority second-hand: it has no way to tell a real ruling from a confident
    mistake. Send the RECOMMENDATION with its reasoning and let the peer put it
    to their own owner. This was violated in the same session that wrote the
    rule — a product-owner recommendation went out headed "Owner ruling", on a
    question the owner had never been asked. The peer correctly refused to act
    on it, and the substance turned out right, which is luck rather than
    process. Applies in both directions: a peer's "the owner approved X" is
    their owner's word to them, not yours to act on.
18. **A unilateral reorder of a shared literal makes a concurrent conflict
    WORSE, not better.** If one wave sorts a list the other is inserting into,
    the merge is "one side reordered, the other inserted" — the ugliest shape
    there is. Either both branches adopt the same order before either ships, or
    neither reorders. And assume WAVE ORDER, not alphabetical, until read:
    three shared literals in this repo were assumed alphabetical and were not
    (`SPORT_PALETTES`, and both of `registry.ts`'s).

19. **A reachability test is satisfied by ANY value. Pin what a control
    OPENS AT, not just that it is there.** R6 made a suspension's `minutes`
    field reachable, shipped it behind twelve mutants and a full branch
    review, and still wrote an FIH yellow as a 2-minute suspension against a
    declared 5 — because every test asserted the field was reachable and that
    the payload carried it, and none asserted its seeded VALUE against the
    class the scorer picked. It was found by driving the pad by hand and
    reading the row out of `score_events`.

    Two rules follow. First: **making a field collectable can be WORSE than
    leaving it absent**, because an absent field falls through to a correct
    engine default while a present, wrongly-seeded one overrides it — check
    which way the reducer's `payload.x ?? cfg.x` precedence runs before
    calling such a gap closed. Second: **derive the expected value from the
    engine's own declarations, never a table typed into the test**, so a
    change to the source of truth moves the test with it instead of leaving
    it asserting yesterday's numbers. And prefer at least one case where the
    right answer differs from the wrong one's constant, or the test cannot
    witness the regression it exists for.

20. **A blown test budget reports itself as a DATA defect.** When a Playwright
    test hits `test.setTimeout`, the runner prints the `expect.poll` that
    happened to be in flight — so a walkthrough that ran out of clock on its
    fifteenth tap reported `Expected: 15 / Received: 14`, "the ledger is short
    a rally", above the timeout line. Two error lines, one event, and the
    misleading one comes first. Before chasing a count mismatch, check whether
    the poll's OWN timeout was actually exceeded; if it was not, the failure is
    the wall clock, not the data.

    The cause here was a per-tap wait nobody had costed: the v3 pad
    soft-commits, so every tap waits out `HOLD_MS` before the ledger can be
    polled, and doubling that constant multiplied by sixteen taps. **A flat
    timeout beside a derived cost is a latent red** — express the budget in the
    constant (`Math.max(FLOOR, base + taps * (HOLD_MS + slack))`), so moving
    the constant moves the budget with it.

    And when a constant is made environment-tunable so tests can run it short,
    the guard that pins its VALUE has to move to the default, not follow the
    live value — otherwise it fails in exactly the process where the short
    value is correct, and the obvious repair is to delete the guard.

21. **`-g` on a Playwright sweep is a filename sweep wearing a costume, and
    serial mode hides everything after the first red.** The phone-composition
    wave ran ~six green local gates, every one of them
    `-g "badminton v3 pad|cricket v3 pad|setup:"` — a filter that selected
    neither of the two tests the change actually broke. CI found both. Then
    `mobile.spec.ts` runs `describe.configure({ mode: "serial" })`, so the
    first red aborts the remaining ~110 tests in that project: CI's own
    "2 failed / 29 passed" was concealing a THIRD failure that only appeared
    once the first was fixed. Two rules follow. Run the whole spec file, never
    a `-g` slice, before believing a UI change is clean. And when a serial file
    goes red, treat the count as a floor, not a total — re-run after each fix
    until a full pass completes.

22. **Folding a control behind a phone disclosure breaks every test that
    asserts it VISIBLE, and no unit test can see it.** `apps/web` vitest is
    `environment: "node"` — a `max-md:hidden` body renders into the markup, so
    a class-scan test stays green while five width projects go red on
    `toBeVisible()`. When you fold something, grep the e2e suite for its
    testid and make those tests OPEN the fold; do not weaken their assertions
    to match the new markup. Wait on `toBeAttached`, not `toBeVisible` —
    visibility is exactly what the fold denies — and open EVERY instance
    (`fixture-console.tsx` mounts one disclosure per side; opening the first
    leaves the second's controls boxless and `boundingBox()` returns null).
    Gate the open on the toggle being visible rather than on a width literal:
    at 768/834 the toggle is `md:hidden` and clicking a hidden control throws.

23. **A scrolling rail is not clipped content, and a `scrollWidth >
    clientWidth` scan cannot tell them apart.** Making the scorebug meta strip
    a swipeable rail on phones (`max-md:overflow-x-auto`) reddened
    `mobile.spec.ts`'s clipping scan at all five phone widths
    (`div 394px content in 317px`) and tripped axe's
    `scrollable-region-focusable` at SERIOUS impact in
    `scorepad-skins.spec.ts`. Both are real, and both have one cause: an
    overflow whose extra content is REACHABLE is a feature; one inside an
    `overflow-hidden` box is a defect. Split on computed `overflow-x`
    (`auto`/`scroll` vs `hidden`/`visible`) — `overflowingIn` /
    `expectScorebugNotClipped` in `mobile.spec.ts` do this. And any new
    scrolling region owes a `tabindex="0"` plus a role and an accessible name,
    or axe reds; `tabindex` cannot be varied by media query, so it is
    unconditional. Never let the exemption go unchecked: assert that every box
    you excused is the reachable kind, or the next overflow hides behind it.

## The phone composition (ScoringPad v3 and the fixture console)

Design of record:
`docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md`
(owner-approved 2026-09-02, "Option 2 — score strip up, chrome down"). Read
it before changing anything under `apps/web/src/components/v2/scorepad/v3/`
or `fixture-console.tsx` at a phone width. Not derivable from the code:

- **One DOM, branched — never a second phone tree.** Everything below
  Tailwind `md` (768) is `max-md:*`; everything phone-only is `md:hidden`.
  Exactly ONE control is duplicated (the device hand-over), and its desktop
  twin carries `max-md:hidden`. ≥768 is unchanged and must stay that way.
- **`/\bmd:hidden\b/` also matches inside `max-md:hidden`**, so an assertion
  written that way passes on its own inversion. Anchor on `\s...hidden"`.
- **A wrapper between a grid and its card kills equal-height stretch**, and
  `h-full` on a plain block does NOT cascade into a content-sized child — use
  `grid h-full` on both wrapper and body (`phone-disclosure.tsx`).
- **`truncate` needs `min-w-0` on the whole ancestor chain**, not just the
  span. A missing one on the disclosure wrapper put 106px of horizontal
  overflow on the page at 320–390 — visible only with a realistic 43-character
  entrant name, and only in a browser.
- **Order is explicit, not source order.** `pad-host.tsx`'s root is
  `flex flex-col gap-3` with `order-1..4` on its children; the ribbon moving
  above the board is what buys the headroom that puts cricket's first tile at
  503px on a 568px screen. *Take back* consequently sits BELOW the board on
  phones — an owner-accepted trade, not a bug to "fix".
- **Person/entrant chips get their own row.** In `detail-dock.tsx` the phone
  grid is two columns, but any non-`flag` chip is `max-md:col-span-2` — a name
  in a one-column cell inflates into a circular blob, which is exactly the
  defect the owner rejected the first build for.
- **Verify with a control-set diff from the live DOM**, membership and order
  and repeats, at 320 against 1280 — not by comparing box sizes. A phone view
  that shows the same control set at smaller sizes is a groomed shrink, which
  is the thing this programme exists to undo.

## Standing project rules

- **Read `docs/superpowers/RULES.md` first.** Owner's full standing
  policy — skills to actually use (not just cite), TS7/Node26, agent
  topology (Scout/Implementer/Reviewer — models and effort live in
  `RULES.md` and the `.claude/agents/*.md` frontmatter; never restate them
  here, and never override `model:` on a dispatch), all 4 required test types per task
  (unit/E2E/smoke/regression), greenfield schema stance, mobile+desktop
  UI bar, CI OpenAPI drift check (a `ci.yml` step, not a pre-commit hook —
  this repo has no `.husky/`), and the no-new-issues /
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
