# Why ~thousands of green tests still missed the holes — and what to do about it

**Status:** owner-approved as ruling 21 of the format × sport matrix programme
(2026-09-27). Shared by the owner for other sessions and programmes to adopt.
Outside that programme it is a **recommendation**: confirm with the owner which
parts apply to your scope before acting.

**Sources:** `docs/superpowers/specs/2026-09-27-format-matrix-design.md` §7.3a,
§7.5; `2026-09-27-format-matrix-prompts/_RULES.md` R25–R29; audits under
`2026-09-27-format-matrix-prompts/audit-2026-09-27/`.

## The finding

Five read-only audits on 2026-09-27 found ~150 gaps in Swiss, fixture
generation, standings, scoring and QR sheets — behind suites that were green.
The engine's generator suites passed 144/144 with four gaps in the very logic
they cover. The tests were not too few; they pointed the wrong way.

## Six reasons the tests missed them

| # | Cause | Evidence |
|---|---|---|
| 1 | **Tests cover features one at a time; bugs live in combinations and sequences.** Each author tested their own happy path at a fixed roster. Nobody tested "add entrant *then* Generate" or "withdraw *then* Pair next". | #879 Generate duplicates pairings after roster growth; #846 Swiss phantom bye; pre-Start delete stranding a round |
| 2 | **Expected values came from the code.** The author of the code wrote what it "should" return, so a wrong rule was frozen in as correct. | Buchholz bye maths; chess points doubled on the table; hockey shoot-out 3/0 vs FIH 2/1 |
| 3 | **Vacuous tests.** A property passes on an empty result; a test's name claims more than it asserts. | Swiss "no rematch ever" passes on an empty round; "rotation covers pairings evenly" cannot see 21/28; the Undo test checks the shell count, not the seats |
| 4 | **One sample stood in for all.** | Every scorer-sheet test uses sport `generic`; format tests use 4 or 8 entrants |
| 5 | **Assumptions written as comments, not guards.** | `competition.ts:148` "draw/tie/no_result never reach a bracket" — they do, and the bracket stalls silently |
| 6 | **No written rules**, so no definition of "correct" to test against. | Swiss rules exist only as code |

## What to do

### Already in the format-matrix programme
- **Rulebook first** (fixes 6): the rules per format and sport are written and
  owner-signed **before** code — federation rules by default.
- **An independent oracle** (fixes 2): a reference model written from the
  rulebook by a different agent, import-isolated from the engine.
- **The matrix** (fixes 4): every format × sport cell × 69 scenarios × config
  variants, in three layers (browser lifecycle, browser scenarios, full cartesian
  over HTTP).

### Added by ruling 21 — adopt these anywhere
1. **Model-based sequence testing (fast-check command model).** Generate random
   sequences of user actions (add entrant, withdraw, walkover, void, correct,
   Generate, Pair next, Rebuild, complete stage) and check invariants after
   **every** step. A failure shrinks to the shortest reproducing sequence, which is
   committed as a named regression case with its seed **before** the fix (fixes 1).
2. **Anti-vacuity.** Every invariant, property and sweep returns how many items
   it checked; **zero checked = failure**. Every rule set states its empty case
   first (fixes 3).
3. **Automated mutation testing (Stryker), weekly**, on the engine's scheduling,
   competition and tiebreaker modules, with a score floor that may only rise.
   Surviving mutants are killed by a test or recorded as equivalent (fixes 3).
4. **Sweep sports by default.** Engine, standings and progression tests iterate
   the sport registry through a shared `forEachSport` helper; a single-sport test
   carries a one-line reason, and CI lists unreasoned ones (fixes 4).
5. **Production shadow invariants.** The server evaluates the same invariants on
   real tables, brackets and pairings after each write and **logs** a Sentry event
   on violation — never refuses. Real events become the final test (catches what
   all of the above miss). Needs browser/server Sentry working (#878).

### Process rules — cheapest to adopt today
- **Assumptions are guards, not comments.** "Cannot happen" becomes an assertion
  or a named refusal plus a test that reaches it (fixes 5).
- **Every PR touching `packages/engine` or `stages.ts` declares the format ×
  sport rows it affects**; CI runs those rows.
- **The reviewer asks four questions of every change and writes the answers in
  the review:** what happens on a **second call**, on an **empty** input,
  **after a withdrawal or void**, and **for another sport**?
- **Nothing is built before its rules are decided.** Most of the week's rework
  was build-then-decide.
- **Fix the root cause once, at one owner** — one pairing-identity reconcile for
  Generate, not a patch per format.

## How to apply in another session

- Read `AGENTS.md` recurring failure classes 1, 3, 4, 6, 7, 19 — the six causes
  above are the same classes, recurring.
- Before writing tests for a change: list its **state transitions** (what can
  happen before and after it) and its **empty case**; test both.
- Before calling a suite green: confirm each property reported a non-zero
  checked count, and mutate the guard you added once to see it go red.
- Do not relabel any of this as an owner ruling for your programme — it is the
  owner's ruling for format-matrix, offered to you as a recommendation.
