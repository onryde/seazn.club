# Placement service — BUILD/POLISH cutover — prompt index

**Read this first.** Compaction-proof authority on what this programme is,
where its decisions live, and what order its prompts run in.

- **Design doc** (why, investigation record, contract, architecture,
  open items): `docs/superpowers/specs/2026-08-07-placement-scheduler-design.md`
- **Full narrative plan** (this index's source — task boundaries, file
  structure, self-review): `docs/superpowers/plans/2026-08-07-cpsat-service-build-cutover.md`
- **REFLOW cutover is a separate, future programme** — not in scope here.
  Gated on the open items tracked in memory
  `project_placement_reflow_repair_investigation.md`. Do not fold REFLOW work
  into any prompt below.
- **Binding rules for THIS programme**: `_RULES.md` beside this file —
  the Domain-Driven Design standard (layers, allowed imports per module,
  ubiquitous language, what the anti-corruption layer owes). Owner-
  mandated 2026-08-09 and **binding on Tasks 01-11 and every reviewer**.
  Every dispatch that touches this programme's code restates the
  relevant rule inline or points there. Each rule carries the command
  that proves it — a reviewer who cannot run the check has not verified
  the rule.
- **Project-wide standing rules**: `docs/superpowers/RULES.md` — read it.
  Agent topology for dispatching any prompt below: Scout=Sonnet High,
  Implementer=Sonnet xHigh, Reviewer=Sonnet xHigh (NOT Opus — supersedes
  older guidance). **Session override 2026-08-09: the owner directed
  that all subagents in the current session run on Opus xHigh instead.
  That override is per-session and does NOT amend the standing topology
  above** — a later session with no such instruction goes back to Sonnet.
  Tasks 01-04 were implemented and reviewed on Sonnet xHigh; Task 05
  onward, and the Tasks 01-04 re-audit, ran on Opus. Every task
  ultimately owes all 4 test types (unit,
  E2E, smoke, regression) — Prompts 01-05 are unit-only because nothing
  user-facing exists yet to E2E/smoke; **Prompt 11 (new, below) is where
  E2E + smoke coverage lands**, once Prompt 06b makes the feature visible
  end-to-end. Don't skip 11 as redundant with Prompt 07's integration
  suite — 07 proves TS↔Python correctness, 11 proves an organiser
  clicking Auto-schedule in a real browser gets a correct board.

## Standing rules for this programme

- Every prompt below is self-contained — exact paths, real code, the
  verify command, what not to touch. A subagent should not need to
  re-read this index or the design doc to execute one prompt, though
  the design doc is the right place to check *why* a decision was made
  if something looks surprising.
- **Do NOT file new issues.** If something is wrong or unclear, fix it
  inline or ask; escalate only if a fix would widen the blast radius
  past the prompt's stated files.
- Run each prompt's own verify command before considering it done —
  never accept "tests pass" without the raw counts.
- Output cap per prompt: final message under 15 lines — counts, paths,
  deviations, blockers. No file contents, no diffs.

## Execution order

```
01 (proto) → 02, 03 (Python model + objective, can run together — same
package, sequential is safer given 03 imports 02) → 04 (server, needs
01-03) → 05 (TS client, needs 01) → 05b (corpus + coverage hardening) →
05c (contract + boundary hardening; 05b FIRST — while the corpus is
EPOCH_MS=0, "unset" and "legitimate value" are the same number, so a
guard added by 05c cannot be proven to fail for the case it exists for)
→ 06 (wire build.ts, needs 04 deployed
somewhere reachable + 05) → 06b (status mapping, needs 06) → 07
(integration tests, needs 06b) → 11 (E2E + smoke, needs 06b — the point
at which the feature is visible end-to-end) → 08 ∥ 09 (deployment, CI —
independent of each other and of 06/06b/07/11) → 10 (remove z3, gated on
01-09 AND 11 ALL green in production for one deploy cycle, not same-day)
```

## Status

Live status is tracked in the SDD ledger, which is git-ignored and so
invisible to a fresh clone: `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/progress.md`.
That ledger is authoritative on *what happened*; this table is the
compaction-proof summary. Keep them in step.

> **Every commit sha in the table below predates a rebase and NO LONGER
> EXISTS.** The branch `worktree-cpsat-service-build` was rebased onto
> `origin/main` `3bab9f43` on 2026-08-10 (60 commits replayed, 0 behind
> after). Post-rebase tips, newest first: `e07ee222` (06 docs) ·
> `29562567` · `8159998b` (06 fix round) · `a584843e` · `32cdf9f3` (06 WIP)
> · `7e11a303` · `64b64f5e` · `1861f363` (08 fix round) · `ece815cf` ·
> `88f484cd` · `fb8a5bab` (08) · `fac91b97` (09) · `d6ffaf9f` · `bf5ac722`.
> The ranges below still read correctly as *what changed in which task* —
> resolve one with `git log --oneline --grep=<subject>` rather than by sha.
> Only ONE conflict arose: `build-rest-lattice.test.ts`, imports only —
> main's `409ae00d` moved `gridStepMinutes` into a new `grid-step.ts` and
> that crossed Task 06's added `placement-client` import. Verified after:
> `src/scheduling` **567 passed / 0 failed / 19 skipped**, `tsc` 0 errors.

| # | Prompt | State |
|---|---|---|
| 01 | Proto contract | **complete** — `0c8eb752..e854b978`, review clean |
| 02 | BUILD model (promote from bench) | **complete** — `e854b978..eee3a590`, clean after 2 fix rounds |
| 03 | T0-T3 objective chain | **complete** — `eee3a590..f64235e6`, clean after 1 fix round |
| 04 | gRPC server (auth, health, mapping) | **complete** — `f64235e6..f19605a6`, clean after 1 fix round |
| 05 | TS codegen + client wrapper | **complete** — `f19605a6..b33ac2fb`, approved after 1 fix round |
| 05b | Corpus + coverage hardening (Python tests) | **complete** — `b33ac2fb..a554961e`, clean after fix rounds |
| 05c | Contract + boundary hardening | **complete** — `a554961e..5774439e`, after 6 fix rounds. Rounds 4 and 5 each tried a *character* rule for id canonicality (`.strip()`, then `isprintable()`) and each was defeated — by Cf characters, then by ten code points in Lo/Mn/So. Homoglyphs (`'Сourt 1'`, Cyrillic Es U+0421) defeat any such rule, so round 6 re-cut the contract to **positional identity**: index is identity, the service compares no strings, `court_names` is display-only |
| 06 | Wire `solveBuild` in `build.ts` | **complete** — `b673faa6..bc6bb663`, approved after 1 fix round. Read the box below before touching this code |
| 06b | Status vocabulary translation | **complete** — `b97afcfc..9dca481c`, approved on both verdicts with **0 fix rounds**, the only task in this programme to manage that. `SOLVER_BUSY` → the existing `solver_busy`; the whole promise-rejection path (FIVE `PlacementError` failure kinds, not four) → `solver_unavailable`. The review proved structurally that `SOLVER_BUSY` **cannot** reach the rejection path — `main.py:118-124` returns a resolved `error_response` and never aborts the RPC — so the split is correct by construction. Its original obligation, below, is discharged |
| 06b (original obligation, now discharged) | — | **carried an obligation Task 08 discovered**: `PLACEMENT_MAX_WORKERS=1` on the deploy shape means a second concurrent organiser gets `SOLVER_BUSY`, and **nothing maps that to a greedy board today**. `build.ts`'s existing `"solver_busy"` path is `MAX_SOLVER_QUEUE`, the LOCAL z3 queue cap — unrelated. The service's `SOLVER_BUSY` (`schema.py:473`) reaches `toOutcome` as `status:"ERROR"` + `error.code` and is read by nobody. 06b must map it, or one of two simultaneous organisers gets an error rather than a board |
| 07 | Integration tests (parity, regression, fallback) | **complete** — spec PASS, quality approved after 2 fix rounds, 0 Critical / 0 Important, 0 deferred Minors. Closed on a **negative control**, not a passing run: with a wrong secret against a live service Board 2 now FAILS, where before the fix that same broken run passed green. Its base prompt had three errors, verified against the code — see below. (An earlier revision of this row said "not started"; it was stale, and `_RESUME.md` had already recorded the closure.) |

### Prompt 07's base prompt does not compile as written

Checked before dispatching rather than after, because two of this
programme's briefs have already shipped a confident claim about code that
had only been grepped:

1. **`buildSchedule` takes ONE argument** (`build.ts:951`). The prompt's
   fallback test calls `buildSchedule(input, { placementHost: "localhost:1" })`.
   No such parameter exists — the host is read from
   `process.env.PLACEMENT_SERVICE_HOST` (`placement-client.ts:564`), so the test has
   to stub the environment instead.
2. **`npm run test:integration --workspace packages/engine` does not
   exist.** `packages/engine/package.json` has no `test:integration` script.
   Use the direct `npx vitest run <path>` form the prompt's own Step 3 uses,
   or add the script deliberately.
3. **The fallback test's `status` assertion is a guess.** The prompt pins
   `"solver_unavailable"`, but an unreachable service does not return a
   status at all — the client THROWS `PlacementError` with a `failure`
   discriminant (`placement-client.ts:295`, `failureFor` at :479), and
   `build.ts`'s catch swallows every rejection into one greedy fallback. What
   that becomes is whatever Task 06b lands. Assert 06b's actual mapping;
   do not assume this string.

`validateAssignments(assignments, config, existing, dependencies)` — the one
signature the prompt gets right (`calendar.ts:1257`).
| 11 | E2E + smoke coverage | **complete** — spec PASS, quality approved, 0 Critical, 2 Important (both closed inline: the wall-clamp doc, and the build guard). Closed on a NEGATIVE CONTROL, reproduced independently by the reviewer against a live service: service down -> FAIL (`data-engine="greedy"`, `data-status="solver_unavailable"`, `placement-cutover.spec.ts:211`); service up -> PASS 3/3. Smoke 759 passed / 0 failed with `PLACEMENT_SERVICE_HOST` live, exercising `placementOptimizedSuite`. Added `data-engine` to the result strip — without it the cutover is UNASSERTABLE from a browser, since the optimised engine deliberately renders the same "Solver" copy as z3. Its board is hand-built (6 entrants / 9 fixtures / 2 courts), not the generated round-robin: a 21-fixture board stalls at `tiers_completed: 1/4` against the server's 10s wall clamp. **It also found the broken production build** — see the section above |
| 12 | Solver concurrency — channel-per-solve + Fly fan-out | **complete** — spec PASS, quality approved, 0 Critical / 0 Important, 3 Minors (one fixed inline, two judged inert). Gate rerun by the coordinator AND independently by the reviewer: 591 passed / 0 failed / 613 total, 22 pending (live-container suite). Negative control reproduced from both sides: 30/2/32 against the unmodified `clientFor`, 32/32 after |
| 13 | Rename `cp-sat` -> `placement` (#20) | **complete** — spec PASS, quality approved, 0 Critical / 0 Important, 1 Minor (a docstring quoting the retired engine value, fixed inline). All seven namespaces renamed; the engine label forked to **`"optimized"`**, not `placement`, because `placement` would not distinguish it from greedy, which also places. Engine suite 591/0/613 — identical to the pre-rename baseline; both-workspace tsc 0 errors; all three drift gates byte-identical; Python 169 passed with both stub sets regenerated by the real toolchain. All 14 residual old-name hits were traced individually and are deliberate — do not re-derive them |
| 08 | Deployment (Dockerfile, fly.toml) | **complete** — `befd49eb..d292e33f`, approved after 1 fix round. App is `placement` (NOT the plan's `seazn-placement-prod` sample — `.internal` DNS derives from the app name and must match `placement-client.ts:127`'s `placement.internal:50051`). Warm-start is carried by `auto_stop_machines = "off"`; `min_machines_running = 1` is set but inert beside it |
| 09 | CI workflow | **complete** — `8d78c595..befd49eb` plus `c57eefe6`, spec PASS + quality approved, 0 Critical/Important. Builds AND runs the image; drift gate covers Python and TS stubs |
| 10 | Remove BUILD/POLISH's z3 code | **blocked, but no longer indefinitely** — owner ruled 2026-08-10 to CLOSE the capability gaps and remove z3 fully, rather than close the programme at 11 and leave z3 dormant. Gates: 01-09 and 11 live for one full deploy cycle, **plus all three gaps below closed** |

### The scheduling barrel is SERVER-ONLY, and it broke the production build

Found by Task 11, 2026-08-10 — outside its own scope, and the most expensive
defect this programme shipped. **The production build was broken from the
cutover until Task 11 found it.**

`packages/engine/src/scheduling/index.ts` re-exports `build.ts`, which reaches
`placement-client.ts` -> `@grpc/grpc-js` -> `net`/`tls`/`http2`/`dns`/`fs`.
None of those exist in a browser. Two `"use client"` components
(`bracket-panel.tsx`, `slideshow.tsx`) imported the barrel purely for bracket
GEOMETRY helpers and dragged the whole chain into the browser bundle.
`next build` died with `Module not found: Can't resolve 'dns'` — an error
naming nothing near the cause.

**A dynamic import does NOT protect a bundle.** `build.ts` imports the client
via `await import(...)`, which looks like it keeps it out. It does not: a
bundler still resolves and compiles a dynamic import, it merely puts the
result in a separate chunk, and that chunk still has to build. That dynamic
import exists for **test mocking** — its own call-site comment says so — and
never provided bundle safety.

**Why every gate missed it.** `tsc` sees valid types. `vitest` runs in Node,
where those modules exist. `eslint` has no such rule. The drift gates are
unrelated. Only a real `next build` catches it — and that ran on PULL
REQUESTS only, while a local merge pushed straight to `main` skips it. Fly's
builder cannot build Next at all, so the deploy never independently checks
either. It surfaced only because E2E needs a prod build and **nothing in this
programme had ever built the app**.

**The rule, now written at the top of the barrel itself:** a client component
imports a LEAF, never the barrel. Four leaves already existed for exactly
this purpose (`grid-step`, `rest-floor`, `tz`, and Task 11's `bracket-layout`),
declared in `packages/engine/package.json` — the convention predates this and
was simply never documented, which is why two components reached past it.
Need something client-side with no leaf? Add one; do not widen a client
component's reach to the barrel.

**Guard, and it is PROVEN rather than assumed.** `.github/workflows/build-guard.yml`
runs `next build` on `push: main` — the one path ci.yml deliberately leaves
ungated, since PRs already build in its smoke job. Negative control run
2026-08-10: adding a single barrel import to a `"use client"` file reproduced
`BUILD_EXIT=1` with `Module not found: Can't resolve 'dns' / 'fs' / 'http2'`;
reverting restored a clean build. Re-run that control before ever deleting
the workflow.

### Task 11's two blockers — both closed by Task 11 itself

Found 2026-08-10 while writing `task-11-brief.md`. Recorded here because both
are defects in committed code, not brief-local notes.

**1. `solver.engine` is not observable from the DOM.**
`apps/web/src/components/v2/board/result-strip.tsx` exposes
`data-testid="schedule-result-strip"`, `data-tone`, `data-status` and an
`aria-label` — and nothing carrying the engine. The engine reaches the page
only as rendered i18n copy through `schedule-result-provenance`, and
`ENGINE_KEY` (`:34-39`) deliberately maps the placement value to **z3's own
key**, so both render the identical string "Solver".
`apps/web/e2e/z3-auto-schedule.spec.ts:221-234` states this and defers the
problem: its regex "cannot tell z3 from placement. It is not meant to...
Asserting the cutover specifically is Prompt 11's job, against `engine`
itself rather than this rendered string." So Task 11 owes a small additive
production change — `data-engine={solver.engine}` on the strip — before its
central assertion is even expressible. Assert it as `data-engine="..."`,
never as bare attribute presence: React serialises an omitted prop as
`"$undefined"`, so a bare probe passes in both states.

**2. `scripts/smoke.ts:7759-7761` allow-lists an engine set that excludes the
new one.** `z3AutoScheduleSuite` (defined `:7631`, called `:672`) asserts
`engine === "greedy" || "z3" || "z3+lns"`. The placement value is absent. It
passes today **only because the service is unreachable from a local smoke
run**, so every board falls back to greedy — which means the first smoke run
against a live service fails, and fails reading as "smoke is broken" rather
than "the cutover works". A four-value allow-list is also not an assertion:
Task 11 owes a scenario that REQUIRES the optimised engine and skips loudly
when the service is down.

### The three capability gaps that gate Prompt 10

Owner decision 2026-08-10: **close all three, then delete z3.** The
alternative on the table — end the programme at Task 11 and leave z3 in
place as dead-but-present code — was rejected.

Do not remove z3 while any of these is open; each one is a board z3
schedules correctly and placement does not.

| Gap | What z3 does that placement does not | Cost to close |
|---|---|---|
| **C2 — per-court start grids** | z3 accepts courts offering different start times. The ACL now REFUSES that shape, so `Blackout.court?` (`calendar.ts:21`) routes those orgs permanently to greedy | Per-fixture domain restriction over (court, start). Same primitive `court_allow` needs — build once, both close |
| **C1 — rule scopes above the division** | `encodeBuild` §9 honours EVERY scope via `scopeCoversFixture` (`build-encode.ts:506`). The placement wire carries `day_cap_by_division` / `rest_by_division` only, so a rule scoped to a competition, pool, entrant or **person** is silently not sent (`build.ts:1063-1068`) | A wire representation for scoped rules. This is what task C1 already tracks |
| **C4 — `existing` rows don't consume day-cap allowance** | z3 subtracts immovable rows from each day's room: `room = h.count - immovable` (`build-encode.ts:507`). placement builds `on_day` for movable fixtures only (`model.py:506-511`), so a pinned row on a capped day consumes nothing and the solver may add another | `division_index` on `PinnedRow` — a proto change, both codegen sides, ACL. Round 6 stripped even fixture identity from `PinnedRow` to reach positional identity, so nothing can attribute a pin to a cap today |

C4 is the one that produces a **wrong board that Placement reports OPTIMAL**:
a division capped at 2/day with one fixture already on Saturday gets two
more added, three on the day. The TS verifier catches it afterwards, so it
surfaces as a rejected board rather than a bad schedule — but that is the
greedy fallback firing on a board placement should have solved.

C0's ruling (**soft, new T1**) was ratified by the owner on 2026-08-10 and
gates the placer halves of C1 and C2. It is settled — do not re-ask it.

### Close all three through ONE contract revision, not three

Owner ruling 2026-08-10. Every one of C1, C2 and C4 needs a wire addition:

- C1 — a representation for rules scoped above the division
- C2 — `court_allow`, i.e. a per-fixture domain over (court, start)
- C4 — `division_index` on `PinnedRow`

Three separate proto bumps would each cost a regen of BOTH stub sets, an
ACL pass, and a drift-gate cycle. **Revise the contract once, covering all
three, then build the three model halves independently against it.** Do not
let a task ship a narrow proto change that a later one has to widen — that
is the same mistake the per-court-grid note above already warns against.

### The rename — DONE, Task 13, 2026-08-10

> **This section is history now.** It was written while the rename was still
> pending and the rename then edited it, which is why an earlier revision read
> "`placement` names the algorithm family" — the exact inverse of the truth.
> Rewritten in past tense so it cannot mislead again. **A blanket rename
> damages the prose that describes the rename**, and a residual-old-name grep
> cannot detect it: nothing old survives, the sentence merely becomes false or
> tautological. Three such sentences were found and fixed by reading, not
> grepping. If a future rename lands, re-read every paragraph that discussed
> it rather than trusting a clean grep.

**The problem it solved.** `cp-sat` named the algorithm family, not the
domain, and it spelled SEVEN namespaces identically: the directory, the
Python package `cp_sat`, the `CPSAT_*` env prefix, the proto package
`seazn.cpsat.v1`, the Fly app (hence its `.internal`/`.flycast` host), the
`BuildResult.engine` label, and this plan directory. Leaking a
theorem-prover family name into the product is backwards, and the whole
point of the ACL is that `build.ts` cannot know what solves.

**SETTLED by the owner 2026-08-10, and shipped: `placement`.** Directory
`services/placement`, package `placement`, env `PLACEMENT_*`, proto
`seazn.placement.v1`, Fly app `placement` → **`placement.flycast:50051`**
(`.flycast`, NOT `.internal` — autostart is a Fly Proxy feature and
`.internal` bypasses the proxy, so a suspended machine on `.internal` is
unreachable and every solve silently returns a greedy board). It
is this repo's own ubiquitous language (placer vs verifier) and it names the
domain act. Three alternatives were put up and rejected: `scheduler-decision`
(scheduling is what the entire application does, so it does not distinguish
this service, and "decision" is rules-engine vocabulary absent from this
domain), `board-solver` (keeps a technology word, which is the thing being
removed), and `placement-solver`.

`placement-solver` was the closest call and was raised twice, so record why
it lost rather than re-deriving it: it does NOT reoffend against the
original objection — that was to an *algorithm* name (`placement`) reaching the
product, and "solver" is a role noun, not an algorithm. It lost on three
smaller points. `services/` already says it is a service, so the suffix
earns little. The env names get long (`PLACEMENT_SOLVER_SERVICE_SECRET`).
And if the solver is ever replaced by something not solver-shaped — a
heuristic, a learned ranker — `placement` still describes it while
`placement-solver` becomes the next `placement`.

The `engine` label takes a DIFFERENT word — `placement` would not
distinguish it from greedy, which also places. Settled:
**`engine: "greedy" | "optimized"`**, which survives the next solver swap
too. During the transition the union also still carries `"z3"`/`"z3+lns"`
until Prompt 10 deletes them.

Measured cost, 2026-08-10: **1013 references across 66 files** — 482 of them
prose in `docs/`, 531 code and config. It is nearly free today and gets
expensive at exactly two moments:

1. **Tasks 07 and 11 add assertions** on the label and the paths.
2. **First deploy** — after that, renaming the Fly app means recreating it
   and re-issuing `PLACEMENT_SERVICE_SECRET`.

Checked rather than assumed: the engine label is **not persisted** — not in
`core`, not event-sourced, absent from every golden and corpus. So there is
no migration and no re-baseline. Only `DEFAULT_HOST` (`placement-client.ts:127`)
must move in lockstep with the app name.

**Order of work:** 06b → 07 → 11 → rename + unified contract revision →
C2 → C1 → C4 → deploy cycle → Prompt 10.

### Prompt 10 has a second gate now: the per-court-grid capability gap

Prompt 05c found that Placement was placing fixtures at start times the
court did not offer — measured 6/6 with `C0` at `{T, T+40}` and `C1` at
`{T+40}`, a fixture landed on `C1` at `T`. The board was wrong, and the
TS verifier rejected it afterwards.

The ACL now requires every court to offer identical start times, so those
boards are **refused rather than mis-scheduled**. That is strictly better
— but it means **Placement refuses a shape z3 accepts**, and
`Blackout.court?` (`calendar.ts:21`) makes that shape reachable from
ordinary org data.

**So z3 cannot be removed while this holds.** Removing it would leave any
org with a per-court blackout permanently on the greedy fallback.

The fix is specified but deliberately not built: an enforced per-court
start domain in the model, free on homogeneous boards. It was left out of
05c because it is in the solver hot path, was not asked for, and needs
its own timing case. Closing it is a prerequisite for Prompt 10, not
optional cleanup.

**This gate now has an owner outside this programme.** A separate piece
of work — adding `court_allow` to the scheduling constraint vocabulary,
so an organiser can say "Priya plays on Court 2" — needs exactly the same
primitive: a **per-fixture domain restriction over (court, start)**.
Placement already carries the per-fixture, per-court presence booleans it
would use (`model.py:337`), so enforcement is forcing the disallowed ones
to zero.

Build it once and both close. Do not build a narrower per-court-grid fix
here that the constraint work then has to widen — coordinate instead. The
constraint work also carries a product decision this programme does not
own: whether instruction rules stay **warn-only** (today's behaviour) or
become hard, because a hard placer turns boards that currently return
with a warning into `INFEASIBLE`.

That decision is tracked as **C0** and is filed as issue #497. **The
recommendation on record is soft, inserted as the NEW T1** — not, as an
earlier draft of #497's body said, a T4 below the existing chain. Below
the chain a rule loses to court balance, which is backwards:

```
T0  maximise placed          <- unchanged
T1  minimise rule violations <- new
T2  makespan          |
T3  worst idle gap    | existing chain, demoted
T4  court imbalance   |
```

Two reasons it must not be hard. `INFEASIBLE` is not where a too-tight
rule lands — `build.ts` falls back to **greedy** on any Placement failure,
and greedy honours no rules at all, so one marginal rule costs the whole
optimised board and every other rule with it. And `INFEASIBLE` does not
say which rule broke, whereas a minimum-violation board names it for
free. Escape hatch if per-rule strictness is wanted later: a per-rule
`enforcement: "hard" | "soft"`, matching the existing
`crossPersonClash: "warn" | "hard"` (`schemas.ts:767`). Not designed now.

Tasks 01-04 were re-audited on 2026-08-09 at the owner's request (four
parallel Opus reviewers, mutation-first, one per task). Suite at that
point: 86 passed, 0 failed, exit 0.

### The cutover nearly shipped INERT, and no happy-path test could see it

Task 06's first pass wired `solveBuild` correctly and passed 8/8 new tests —
and on real boards it would have run **greedy, not Placement**, on most of them.

`seedPinsOf`/`pinned` was ported unchanged from z3 and injected the greedy
seed's slots into the grid. Those slots are not grid-aligned, and they were
injected **asymmetrically across courts**. Obligation 5's uniform-grid check
then did its job perfectly: it saw a per-court grid, refused to send it, and
routed the board to greedy.

`seedPins` was built from the **entire greedy board, unconditionally** — not
just from pins. So the trigger is not "a board with pins": it is any
2+-court board whose greedy seed is not grid-aligned, pinned or not.
`build.test.ts:265` is a zero-pin case that failed before the fix.

Three things worth carrying:

- **Every one of the 8 new happy-path tests passed** while this was live.
  They were single-court or grid-aligned. A green cutover test says nothing
  about whether the new placer is being reached.
- The defect was found by **rewriting a pre-existing test that had been
  marked `.skip`**, not by reviewing the diff. Two independent reviews read
  this code and neither saw it.
- The first written account of it — including mine in the SDD ledger — said
  the blast radius was "every POLISH run and every BUILD with locked cards".
  That undersold it. The correction came from the re-review measuring it
  rather than repeating the report.

If a future change makes Placement "stop being used", look here first: assert
`engine === "optimized"` on a multi-court board with a non-aligned seed.

### An engine union widening reds `apps/web` tsc, and the engine's own tsc stays green

Task 06 added `"optimized"` to `BuildResult["engine"]` (`build.ts:446`). It
touched only engine files, so its verify ran `packages/engine` tsc — clean.
Its implementer, its reviewer and my own wave-boundary gate all called it
green.

**`apps/web` tsc was red at that commit and stayed red across two tasks.**
`apps/web/src/server/api-v1/schemas.ts:935` hand-mirrors that union as a zod
enum, and `schedule.ts` assigns `BuildResult` into it one-for-one: TS2322 at
`schedule.ts:1102`. It surfaced only because Task 06b's implementer tripped
over it doing unrelated work and reported it as pre-existing instead of
quietly fixing it. Confirmed independently against the base commit before
being believed.

The mirror is manual — no codegen, and no test asserts the two agree. So:
**any change to a public engine type needs `apps/web` tsc too.** At least two
zod mirrors live in that file (`engine`, and `ScheduleSolverInfo`'s status
union).

This can reach `main` with every gate green, because `apps/web` typecheck is
PR-only (it OOMs CI's heap) and this branch has been merging locally.

### Owed after first deploy: re-measure `NUM_SEARCH_WORKERS`

It is **hardcoded at 8** in the Python source. The deploy shape is
`shared-cpu-2x` — 2 vCPU — so it is 4x oversubscribed, and Task 08's sizing
claim (`tiers_completed=2` guaranteed, T2/T3 best-effort) was reasoned
against a value of 4 that no longer exists in the code.

Recorded here rather than only in the SDD ledger because **two prior task
reports already recommended re-measuring it and nothing changed** — the
ledger is git-ignored, so a recommendation left there is invisible to a
fresh clone and to every subagent. It cannot be measured from a developer
box: the real machine shape is the only place the number means anything.

### Timing numbers on this box need a load reading beside them

The production-board tests are **proof-time** tests, not placement tests,
and they are the first thing to red under CPU contention. Measured on
2026-08-09 at load average 139 (sibling sessions running full vitest from
the main checkout): 7 failed. As load fell to ~12, with **no code
change**, the same suite went to 1 failed and `test_objective.py` to
19/19. Every failure carried `placed=37` of 37 — full placement, with
only `tiers_completed` truncating from 4 to 2.

So a red here is a moving target that tracks `uptime`, and it reads
exactly like a real regression. Record a load reading beside any timing
number, and never "fix" one of these by changing a timing constant.

## Rebased onto `origin/main` 2026-08-10 09:1xZ — clean, 0 behind

73 commits replayed, ZERO conflicts, despite six overlapping files (the four
`ui.json` dicts, `i18n-keys.ts`, `schemas.ts`, `packages/engine/package.json`).
`git merge-tree --write-tree` predicted it correctly beforehand — use that to
preview, it cost nothing and was right.

**Every sha recorded in the git-ignored ledger before this point is
historical.** Take BASE from live `git log` when generating a review package.

Upstream brought `packages/engine/src/scheduling/rest-floor.ts` (NEW) plus
`calendar.ts`/`index.ts` changes — `d251d4df`, `10062c6c`, `37eb77f6`.
Verdict after reading them: `restFloor()` does not change this programme's
answers, and `hardRestMinutesFor` is NOT a new unifying leaf — it predates
the rebase and covers a different source (typed `min_rest_minutes` rules).
The refactor makes gap **C5** more visible, not less: there is now a clean
shared leaf, and `build.ts`'s placement translation still does not call it.

## placement can ship a board violating a rule it never received

Found 2026-08-10 while verifying Task 07. It converts C1/C2 from "missing
capability" into "wrong output reaches the organiser".

`SolveBuildInput.constraints` (`placement-client.ts:71-76`) carries exactly four
fields — matchMinutes, gapMinutes, restByDivision, dayCapByDivision. **No
rule under `config.constraints` reaches the solver at all.** Greedy and the
verifier both read the full config; placement reads four scalars.

Demonstrated: Task 07's first regression board put a `startWindows` rule on
an entrant. placement, blind to it, placed the fixture greedy had correctly
stranded, "beat" greedy on placed count, and `validateAssignments` then
flagged the violation.

**Why D6 did not catch it.** `isBlockingConflict` (`calendar.ts:202-209`) is
`court` / `person_overlap` / `window` / `order` with `direct === true`.
`start_window` is not in that list, so it is warn-only for the gate — it
never reaches `rejectedBlockingConflicts` at all, in any form.

**A SECOND, independent defect, same investigation.** For the reasons that
ARE blocking, the gate is `deltaConflicts(before.filter(isBlockingConflict),
after.filter(isBlockingConflict))`, keyed `fixtureId|reason|detail`. So a
blocking conflict whose key matches one the greedy seed already carried does
not register as new, and ships un-rejected. Confirmed from both functions'
implementations; no repro board built. This is NOT what caused the board
above — an earlier revision of this section wrongly said it was.

Two consequences, both load-bearing:

1. **Any test whose win condition is a constraint placement never receives is
   green by luck.** That board flipped pass/fail on consecutive runs against
   one unchanged service — placement sometimes satisfied the window by
   coincidence. A single green run proves nothing against this solver.
2. Closing C1/C2 is no longer only about board quality. Until they land,
   nothing reliably stops a rule-violating board: the unsent rules are
   invisible to the solver, and half of them are warn-only at the gate.

## Parallel execution

Safe to run alongside the sibling `2026-08-07-datetime-ux-prompts/`
programme in a SEPARATE worktree/branch — file sets are disjoint except
a soft overlap in `apps/web/src/dictionaries/*/ui.json` (this programme
adds one `placement` engine-label key via Prompt 06b; the other adds
blackout/court-removal keys) — a merge-time conflict at worst, not a
live-clobber risk, as long as each runs in its own worktree rather than
the same working directory. Do not run both in the same checkout
simultaneously.

## Owner decisions — settled, do not re-ask

| Decision | Answer |
|---|---|
| Framework | `grpcio` sync + bounded `ThreadPoolExecutor`, not `grpc.aio`, not Connect-RPC |
| Contract shape | Written as field tables in the design doc, `.proto` text is Task 01's own output — not pre-written before approval |
| REFLOW | Separate investigation, separate future cutover — not this program |
| z3 removal | Straight cutover, greenfield — no feature flag, no dual-run, z3 code deleted in Task 10 once verified live. BUILD/POLISH only; `repair.ts`/REFLOW's z3 untouched |
| Engine label rename | Add a new `"optimized"` value alongside existing `"z3"`/`"z3+lns"` (Task 06b) — do not remove the old ones yet, that's part of Task 10 |
| Status mapping | `UNKNOWN`→`not_searched`, `ERROR`→new `"solver_unavailable"` (not reusing `z3_unavailable`), `INFEASIBLE`→`infeasible` (Task 06b) |
| Deployment | Own Fly app, `lhr` region. **Always-warm is SUPERSEDED — see the scale-to-zero row below** |
| Scale to zero (2026-08-10) | **`auto_stop_machines = "suspend"`, `min_machines_running = 0`.** Suspend not stop: it resumes from a memory snapshot instead of paying a 1-3s cold start against an 8-10s wall. Fly does not document suspend billing (pricing covers `stopped` only, rootfs at $0.15/GB/30d) — cents either way, so this is a latency choice, not a cost one. **Requires `.flycast`:** autostart is a Fly Proxy feature and `.internal` bypasses the proxy, so suspended + `.internal` = unreachable = silent greedy boards. `DEFAULT_HOST` is now `placement.flycast:50051` and DEPLOY.md step 2 allocates the private v6 |
| Multi-board concurrency (2026-08-10) | Boards live on one page but solve **one at a time, per button click**. So `PLACEMENT_MAX_WORKERS = 1` stays — CP-SAT's parallelism is INTRA-solve (`NUM_SEARCH_WORKERS = 8`, `model.py:214`), so one solve already uses the box; raising it would trade proof depth for throughput nobody needs. The knob that scales with a bigger machine is `NUM_SEARCH_WORKERS`, still owed a re-measurement. **UI must disable other boards' buttons while a solve is in flight** — otherwise "one at a time" is an intention, not a guarantee, and the second click gets `SOLVER_BUSY` |
| Wake-on-page-load (2026-08-10) | An API endpoint that pings the service's gRPC `Health/Check` to resume the suspended machine, called from the schedule page. Must be authenticated and rate-limited — it starts a machine, so an open endpoint is an abuse lever. The browser cannot reach 6PN, so this is necessarily a server route |
| Programme end state (2026-08-10) | **Close C2, C1 and C4, then remove z3 entirely.** Not "stop at Task 11 and leave z3 dormant" |
| C0 rule enforcement (2026-08-10) | **Ratified: soft, inserted as the NEW T1.** Settled — gates C1/C2's placer halves |
| Who deploys (2026-08-10) | Owner runs `fly` by hand from a written runbook. CI builds and RUNS the image but never pushes or deploys, by design (`placement-service.yml:131`). No agent runs `fly deploy` |
