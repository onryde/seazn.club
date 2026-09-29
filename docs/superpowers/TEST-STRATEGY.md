# Test strategy — house rules for every agent

**Status: owner ruling, 2026-09-28.** In force across every programme, wave and
lane, for orchestrators and subagents alike. Owner's words: *"make it generic
rules to follow by all agents"*.

**Provenance.** This adopts, house-wide, ruling 21 of the format × sport matrix
programme (owner-approved there 2026-09-27), whose text lives at
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/test-strategy-recommendation.md`
on branch `docs/format-matrix-programme`. That document offered its rules to
other programmes as a **recommendation** and explicitly said not to relabel them
as an owner ruling for your own scope. This file is not that relabelling: the
owner was asked directly and ruled them house-wide on 2026-09-28. The
format-matrix document remains the authority for its own programme's extra
machinery (the rulebook, the independent oracle, the 69-scenario matrix); this
file is the authority for what every agent in this repo owes.

**Read with** `AGENTS.md`'s recurring failure classes — the six causes below are
those classes recurring, especially 1, 3, 4, 6, 7 and 19.

---

## Why this exists

Five read-only audits on 2026-09-27 found **~150 gaps** in Swiss, fixture
generation, standings, scoring and QR sheets — every one of them behind a green
suite. The engine's generator suites passed 144/144 while carrying four gaps in
the very logic they covered. **The tests were not too few. They pointed the
wrong way.**

## The six reasons green suites miss real defects

| # | Cause | What it looked like |
|---|---|---|
| 1 | **Tests cover features one at a time; bugs live in combinations and sequences.** Each author tested their own happy path at a fixed roster. | #879 Generate duplicates pairings after roster growth; #846 Swiss phantom bye; a pre-Start delete stranding a round |
| 2 | **Expected values came from the code.** The author wrote what it "should" return, freezing a wrong rule in as correct. | Buchholz bye maths; chess points doubled on the table; hockey shoot-out 3/0 against FIH's 2/1 |
| 3 | **Vacuous tests.** A property passes on an empty result; a name claims more than the body asserts. | Swiss "no rematch ever" passes on an empty round; "rotation covers pairings evenly" cannot see 21/28; an Undo test counting shells, not seats |
| 4 | **One sample stood in for all.** | Every scorer-sheet test uses sport `generic`; format tests use 4 or 8 entrants |
| 5 | **Assumptions written as comments, not guards.** | `competition.ts:148` "draw/tie/no_result never reach a bracket" — they do, and the bracket stalls silently |
| 6 | **No written rules**, so no definition of "correct" to test against. | Swiss rules existed only as code |

---

## In force today — every agent, every task

These cost nothing to adopt and are owed from now on.

1. **Test the sequence, not just the feature.** Before writing tests for a
   change, list its **state transitions** (what can legitimately happen before
   and after it) and its **empty case**, and test both. The four transitions
   that have bitten this repo repeatedly: a **second call**, an **empty input**,
   a **withdrawal or void**, and **another sport**.

2. **Anti-vacuity is mandatory.** Every invariant, property and sweep returns
   how many items it checked, and **zero checked is a failure**, never a pass.
   Every rule set states its **empty case first** — the empty set answers "no"
   to every `contains` question and lands on the default, which shipped three
   vacuous "Finished" defects in one wave.

3. **Never derive an expected value from the code under test.** Derive it from
   the rulebook, the federation's own declaration, or the engine's own
   declarations — so a change to the source of truth moves the test with it
   instead of leaving it asserting yesterday's numbers. Prefer at least one case
   where the right answer differs from the wrong one's constant, or the test
   cannot witness the regression it exists for.

4. **Assumptions are guards, not comments.** "Cannot happen" becomes an
   assertion or a named refusal, plus a test that reaches it. A comment is a
   hypothesis; a guard is a fact.

5. **Mutate the guard you added, once, before calling a suite green.** A guard
   nothing kills is not tested. Two guards covering for each other are each
   untested — mutate them one at a time.

6. **Sweep the sport registry by default** for engine, standings, scoring and
   progression tests. A single-sport test carries a one-line reason in the test
   body. *(Use the shared `forEachSport` / `forEachSportAsync` helper from
   `@seazn/engine/testkit` — `packages/engine/src/testkit/for-each-sport.ts`,
   format-matrix W1b Task 11 — rather than hard-coding `generic`.)*

7. **Decide the rules before building.** Most rework in the week this ruling
   came from was build-then-decide. If the rule is not written and signed, that
   is the finding — raise it rather than inventing the rule in code.

8. **Fix a root cause once, at one owner** — one reconcile for a shared
   identity problem, not a patch per format.

9. **Every PR touching `packages/engine` or `stages.ts` declares the format ×
   sport rows it affects**, and runs those rows.

10. **Model-based sequence testing** where the surface has ordered user actions
    (add entrant, withdraw, walkover, void, correct, Generate, Pair next,
    Rebuild, complete stage): generate random sequences with `fast-check` and
    check invariants after **every** step. A failure shrinks to the shortest
    reproducing sequence, which is committed as a **named regression case with
    its seed, BEFORE the fix**. `fast-check` is already a dependency of both
    `apps/web` and `packages/engine` — no setup is owed.

## The reviewer's four questions

**Every review answers these in writing, for every change**, or the review is
incomplete:

1. What happens on a **second call**?
2. What happens on an **empty input**?
3. What happens **after a withdrawal or a void**?
4. What happens **for another sport**?

"Not applicable" is an acceptable answer only with the reason stated.

---

## Adopted, but NOT yet built — owed work, do not claim these are running

Recorded so no agent reports them as in force. Each needs its own scoped piece
of work and its own owner go-ahead on timing.

- ~~**A shared `forEachSport` helper**, plus a CI listing of tests that sweep a
  single sport without a stated reason.~~ *Built by format-matrix W1b Task 11*:
  `forEachSport` in `packages/engine/src/testkit/for-each-sport.ts`, and the
  `pnpm matrix:single-sport --check --against HEAD^1` ratchet in
  `.github/workflows/ci.yml` (no unreasoned single-sport pin count may rise).
- **Weekly automated mutation testing (Stryker)** on the engine's scheduling,
  competition and tiebreaker modules, with a score floor that may only rise;
  surviving mutants either killed by a test or recorded as equivalent. *Stryker
  is not installed and no workflow runs it.* Hand mutation with named killers
  (rule 5 above) remains the bar in the meantime.
- **Production shadow invariants**: the server evaluates the same invariants on
  real tables, brackets and pairings after each write and **logs** a Sentry
  event on violation — never refuses, never blocks the organiser. Real events
  become the final test. Depends on browser/server Sentry working (#878).
