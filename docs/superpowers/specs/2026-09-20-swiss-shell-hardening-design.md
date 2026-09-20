# Swiss shells — hardening programme

**Status:** design of record, owner-approved 2026-09-20. Not started.
**Predecessor:** `2026-09-20-pr803-swiss-shell-review-findings.md` (the raw
findings). **Merged under:** PR #804 (`393a2d89a`), which shipped the Swiss
shell model with C1–C3 fixed and these findings deliberately deferred.

## Why this programme exists

PR #803 shipped the Swiss shell model: the first Generate mints empty fixture
rows for every declared round, Pair next seats one round at a time, Unpair
clears the latest seated round. Three criticals found in post-merge review
(C1 Unpair destroying real results, C2 the boardgame bye path throwing, C3 the
tree not typechecking) were fixed on #804 before it landed.

Eight further findings were recorded and NOT fixed. They are not cosmetic:
three of them put **wrong numbers in front of organisers and players**, and two
**brick Pair next**, recoverable only by deleting and re-creating the stage.
Alongside them sit nine tests that do not constrain the code — which is why
none of these were caught by a suite that was green throughout.

**Correction, 2026-09-20 (owner challenge).** An earlier draft of this document
said these had "no recovery short of `rebuild`". That is FALSE, and the owner
caught it. `deleteStage` refuses on only three things — a schedule lock, not
being the last stage, and a fixture in `in_play` / `decided` / `finalized`.
Empty shells are in none of those statuses, so a minted-but-unplayed stage CAN
be deleted, and the delete takes its fixtures with it. Delete-and-recreate is
therefore a real escape hatch. It is destructive, unobvious, requires the stage
to be last, and dies the moment one match is played — but it exists, and the
urgency of Wave 3 was overstated on the assumption that it did not.

This document sequences the work. It does not re-derive the findings; the
predecessor doc is the authority on what they are.

### A warning about line numbers

The predecessor doc's line references have already drifted twice through
rebases (`stages.ts:738` in that doc is `:847` today). **Every line number
below was re-pinned against `origin/main` at `393a2d89a` on 2026-09-20.** They
will drift again. Re-pin before building on any of them; a false premise is a
finding to record, not a blocker.

## Global constraints

These apply to every wave and every task in it. They are not optional and a
dispatch brief should restate the relevant ones inline.

- **Every change ships a test that fails without it.** Write it RED first,
  paste the red counts, then make it green.
- **Mutation-test every guard you touch.** Delete the predicate, force it
  `true`, force it `false`. Each mutant must kill at least one NAMED test with
  the test TOTAL unmoved. Report killer names, never just counts. Two guards
  covering for each other are each untested — mutate them ONE AT A TIME.
- **Judge green only from `--reporter=json --outputFile`** and read
  `numPassedTests` / `numTotalTests` / `testResults.length`. The `rtk` wrapper
  prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT and swallows exit
  codes. Confirm `testResults.length` equals the number of path filters passed —
  vitest positional filters are literal substrings and a mistyped path is
  silently ignored while still reporting green.
- **`apps/web` vitest is `environment: "node"`.** No DOM. A unit test cannot see
  CSS, focus, tap area or wiring. Anything a user touches owes an e2e.
- **Any new or changed user-facing string** → all four locale dictionaries
  (`en`/`es`/`fr`/`nl`), never hardcoded English, then regenerate
  `i18n-keys.ts` (it is GENERATED).
- **UI verified by screenshot** at 1280, 768 and 320, no horizontal page scroll
  at any width.
- **New branches go in a worktree**, never the main checkout.
- **`e2e.yml` triggers on push to `main` only** — a PR gets no automatic e2e.
  Use `workflow_dispatch` with its `pr` input for pre-merge signal. Read the
  file rather than trusting this line; that trigger has changed three times.

## The sequencing principle

Ordered by **blast radius, not by effort**. Two hard dependencies:

- **Wave 0 precedes everything.** Nine tests in this area do not constrain the
  code. Fixing behaviour behind them means the suite cannot witness a
  regression in the very thing being fixed.
- **Wave 3's freeze change is unsafe without Wave 3's no-op fix.** Moving the
  round-count freeze to Start while `existing.length === 0` still gates minting
  would let a 3→5 change report success and mint nothing.

---

## Wave 0 — make the existing tests able to fail

**Goal:** before changing any behaviour, make the suite capable of witnessing a
regression in the code the later waves touch.

Nothing here changes production behaviour. Every task is "this test currently
passes against broken code; make it stop".

### Task 0.1 — the played-result refusal has no witness

`stages.ts`'s played-result refusal can be mutated to `false` and **nothing
reds**. Every test that "decides" a round does so through `appendEvent`, so the
`score_events` guard refuses first and the played-result branch is never the
reason for the refusal.

**Build:** a fixture row set `decided` by direct SQL with **no** `score_events`
rows, so the refusal under test is the only thing that can refuse.
**Acceptance:** mutate the refusal to `false`; the new test reds. Mutate the
`score_events` guard instead; a DIFFERENT named test reds. Neither covers for
the other.

### Task 0.2 — the two bye guards cover for each other

In `swiss-shell.ts` the two bye guards are each untested, because every test bye
row is BOTH `-bye`-keyed AND award-outcomed. The second guard has no test at all
and is, on current reading, **dead code**.

**Build:** one row that is `-bye`-keyed but NOT award-outcomed, and one that is
award-outcomed but NOT `-bye`-keyed. Mutate each guard singly.
**Acceptance:** each mutant kills a different named test. If the second guard
proves genuinely unreachable, DELETE it and say so — a guard that cannot fire is
not a safety net, it is a reader trap.

### Task 0.3 — tests whose titles contradict their bodies

- `swiss-shell-fixtures.test.ts` "Pair R1 requires an explicit second Generate"
  **never calls `generateStageFixtures`**. It passes if Pair is entirely broken.
- `swiss-shell-fixtures.test.ts` asserts `toBeGreaterThan(0)` where the real
  value is 2 — it passes if only the bye were cleared.
- `swiss-knockout-shape.test.ts` — the cross-template parity assertion
  (`confirmSeedProposal` → exact semis → `swiss_playoff`/`swiss_knockout`
  parity) was DELETED and replaced with a mint-only assertion.

**Build:** make each test assert what its title claims. Restore the deleted
parity assertion.
**Acceptance:** read what each test ASSERTS, never what it is called. For the
`toBeGreaterThan(0)` case, assert the exact value, and include a case where the
right answer differs from the wrong one's constant.

### Task 0.4 — the uncovered panel predicates and the missing smoke leg

`stages-panel.tsx`'s `swissHasUnseated` / `canUnpairSwiss` have no unit test;
only e2e covers them, and e2e does not run pre-merge. Separately,
`scripts/smoke.ts` — the only pre-merge signal — **contains no Unpair at all**.

**Build:** unit tests for both predicates, and an Unpair leg in `smoke.ts`.
**Acceptance:** mutate each predicate; a named unit test reds without needing
e2e. The smoke leg must drive Unpair through its real handler.

### Task 0.5 — restore the 4-locale render loop

`division-settings-derived-rounds.test.tsx`'s 4-locale render loop was deleted,
and three `ui.json` keys now ship with English-only render coverage.

**Build:** restore the loop over all four locales.
**Acceptance:** replace one locale's value with English; the test reds. Delete a
key from one locale; the test reds.

**Wave 0 gate:** every mutant listed above kills a NAMED test, test totals
unmoved, and the killer names are recorded.

---

## Wave 1 — stop showing wrong numbers

**Goal:** three defects that corrupt standings silently. All are contained.
None changes a user-facing string.

### Task 1.1 — a bye never freezes `config_snapshot`

`config_snapshot` is written only by `append-event.ts`, and a bye appends no
event. So `resolveFixtureCfg` falls through to LIVE config **forever**: a bye
awarded under `points.w = 3` silently becomes 2 when the organiser later edits
the division. This is exactly the drift `fixture-cfg.ts`'s own header says the
snapshot exists to close.

**Build:** freeze `config_snapshot` on the bye at the moment the bye is
awarded.
**Acceptance:** award a bye under `points.w = 3`, then edit the division to
`w = 2`, then re-read standings — the bye must still be worth 3. Derive the
expected value from the engine's own declarations, never a table typed into the
test.

### Task 1.2 — `forfeit.awardScore` leaks into a bye's metrics

`applyPointsRule` adds `awardScore` to `metrics.for/against/diff`, and only the
winner's half survives the fold. A bye recipient gains **GF+3 / GD+3 that
nobody conceded** and outranks a level rival on `diff`.

**Build:** strip metrics from the synthesised bye delta.
**Acceptance:** a bye recipient and a level rival must tie on `diff`. The test
needs a case where the wrong answer and the right answer differ — a zero
`awardScore` cannot witness this.

### Task 1.3 — Buchholz is wrong for any bye not in the last round

Awards are pushed in a second loop after all results (`tiebreakers.ts`), so a
bye always lands at the END of the card, and `StandingsDelta` carries no round.
`virtualOpponentScore` is `scoreBefore + (rounds − gameIndex)`. A 5-round Swiss
with a bye in R1 then four losses gives card `[L,L,L,L,bye]`, index 4 → virtual
opponent 1 half-point; FIDE C.07 says index 0 → 5. **Understated by 2 points**;
the reverse case overstates.

**Build:** carry the round (or the true game index) on the delta so the virtual
opponent score is computed against the round the bye actually occurred in.

**Acceptance — read this twice:** the existing `stage.test.ts` case is
single-round, so index 0 is right **by accident** and cannot witness this. The
new test MUST be multi-round with the bye NOT last. Enumerate the table rather
than sampling one score — serve/rotation/alternation bugs have hidden behind a
single lucky sample in this repo before.

**Wave 1 gate:** each fix has a test that fails without it AND a mutant that
kills a named test. Standings for a bye division are re-read end to end, not
just unit-asserted.

---

## Wave 2 — stop bricking operations

**Goal:** two failure modes whose only recovery is deleting and re-creating the
stage, and two correctness gaps on the destructive path.

### Task 2.1 — roster drift after minting bricks Pair next

Field 6→5 throws `CONFIG_INVALID "swiss bye shell missing for pairing"`; 5→6
throws `"swiss shell count mismatch for pairing"`. Every subsequent Generate
throws. Untested.

Recoverable by deleting and re-creating the stage (see the correction at the
top of this document) — but that silently discards any scheduling work already
done on those shells, and the organiser is given no hint that it is the way
out.

**Build:** reconcile the shell set against the current roster, or refuse the
roster change with a message that says what to do. **Owner decision needed —
see Open questions.**
**Acceptance:** drive 6→5 and 5→6 and show Pair next still works (or refuses
legibly). Both directions; a one-directional test cannot distinguish a fix from
a guard that refuses everything.

### Task 2.2 — a round-count change after minting is a silent no-op

`stages.ts:847` gates minting on `existing.length === 0`. So 3→5 never mints
rounds 4–5 while Generate reports "up to date", and 5→3 leaves shells that Pair
next will happily seat **past the budget**.

**Build:** mint the missing rounds on an increase; on a decrease, remove unseated
shells beyond the new budget and refuse if any are seated.
**Acceptance:** BOTH directions. This is the `if (already) return` swallow
again — an idempotency guard that also swallows a legitimate new arrival. Check
both directions of every such guard.

### Task 2.3 — Unpair can eat an ad-hoc fixture

`ADHOC_STAGE_KINDS` includes `swiss` and `addFixture` defaults
`round_no = maxRound + 1`, which Unpair then treats as the latest seated round
and clears.

**Build:** exclude ad-hoc rows from Unpair's notion of "the latest seated
round", or refuse when the latest round contains one.
**Acceptance:** add an ad-hoc fixture to a swiss stage, Unpair, and show the
ad-hoc row survives.

### Task 2.4 — guard read before the advisory lock

The guard is read before the advisory lock is taken, inverting this file's own
stated convention. A TOCTOU window on a destructive path.

**Build:** take the lock first, then read the guard.
**Acceptance:** this one is hard to witness with a test; state plainly if there
is no surface, and cover it by placement review against the file's stated
convention rather than pretending a test proves it.

**Wave 2 gate:** align every destructive guard with the canonical one at
`stages.ts:2092-2104`, which also consults `match_states`, `match_reports`,
`official_marks` and `suspensions`. **A subset guard on a destructive path is
how C1 happened.** Evidence must be monotonic — `config_snapshot is not null OR
exists(score_events)` — because `fixtures.status` moves BACKWARDS when a
`core.start` is voided. Status may be used only to ADD refusals, never as the
sole test.

---

## Wave 3 — move the round-count freeze from Generate to Start

**Goal:** implement the owner's 2026-09-20 ruling that the round count stays
changeable until the tournament starts.

**Depends on Task 2.2.** Without it, a round-count change after minting is a
silent no-op, so moving the freeze would hand organisers a control that appears
to work and does nothing.

### The gap — two guards, not one

The round count and the per-stage match rules are governed by DIFFERENT guards.
Conflating them is the mistake this section exists to prevent.

| | Match rules (`bestOf`, set points, cap, margin) | Round count |
| --- | --- | --- |
| Route | `PUT /stages/:id/rules` | `PUT /divisions/:id/stages` (`replaceStages`) |
| Scope | ONE stage | the WHOLE division |
| Locks on | evidence of play on that stage | ANY fixture row existing, played or not |
| Predicate | `config_snapshot is not null OR exists(score_events)` | `select 1 from fixtures f join stages s on s.id = f.stage_id where s.division_id = $1` |
| Locks at | that stage's first score / snapshot | the first Generate |
| Survives division start? | YES, for stages that have not begun | NO |

So the round count is **stricter than match rules, not more flexible**. It
locks earlier (row existence, not play), and it locks across stages that have
nothing to do with the Swiss one. The Settings Rounds input still renders and
still accepts a new number after Generate — it is the SAVE that returns
`409 FORMAT_LOCKED`.

The owner's ruling is that the round count should stay changeable until the
tournament starts — which would put it roughly where match rules already are:
tied to play rather than to row existence.

### The work, re-scoped

Split into a cheap copy fix and a separate, later structural decision. The
destructive re-mint was justified only by the belief that organisers had no way
out; they do (delete and re-create the stage), so it no longer has to come
first.

#### Task 3.0 — tell the organiser the way out (DO THIS FIRST)

`FORMAT_LOCKED` currently reads "Format is locked — fixtures exist", which
names a state and offers no action. The organiser cannot tell that deleting the
stage is the supported recovery.

**Build:** a refusal that names the recovery — delete the stage and re-create it
— and says what that costs (the stage's fixtures and any scheduling on them).
Only offer it when it is actually available: the stage must be the LAST stage
and have no fixture in `in_play` / `decided` / `finalized`; otherwise the
message must say so instead of suggesting something that will be refused.

**Acceptance:** all four locale dictionaries + `i18n-keys.ts` regen. Screenshot
at 1280/768/320. Assert the TEXT of each refusal variant, not that a message
appeared. Drive both branches in the product — a stage that CAN be deleted and
one that cannot.

**This is a message and a test, not a destructive path.** It is most of the
value of this wave at a fraction of the risk.

#### Task 3.1 — round count editable in place (SEPARATE DECISION)

Not started, and not to be started until the owner rules on Open question 3.

`replaceStages` would have to distinguish "fixtures exist because shells were
minted" from "fixtures exist because play happened", and re-mint the shell set
on a round-count change.

**Acceptance:**
- Round count changeable after Generate, before play; refused after.
- A stage with ANY evidence of play refuses regardless of division status.
- The re-mint preserves seated rounds and replaces only unseated shells.
- Drive it in the product, not just in unit tests. A claim about what a person
  SEES is settled only by driving the product.

**Risk:** a destructive path on live rows — the same class that produced C1. It
gets the canonical guard, not a subset, and a full review pass.

**Depends on Task 2.2.** Without it, a round-count change after minting is a
silent no-op.

#### Task 3.2 — split the collapsed refusal string

Every server refusal in this area currently collapses to one string
(`stages-panel.tsx:499-501`), so "round has results" and "division frozen" are
indistinguishable to the organiser. Task 3.0 fixes the `FORMAT_LOCKED` message
specifically; this task fixes the panel that flattens ALL of them.

**Build:** distinct messages per refusal reason, carried from the server's
error code rather than recomputed in the client.
**Acceptance:** all four locale dictionaries + `i18n-keys.ts` regen. Screenshot
at 1280/768/320. Each refusal reason renders its own message — assert the TEXT,
not merely that a message appeared. Enumerate the reasons; one sample is not a
sweep.

**Pairs naturally with Task 3.0** — same surface, same dictionaries, and doing
them together means one screenshot pass instead of two.

---

## Out of scope

- Re-opening the fidelity band scale (closed at 0–3, no tier 4).
- Any change to `isBlockingConflict` or `assertPublishable`.
- The Start-tournament confirmation dialog (shipped, design of record
  `2026-09-20-start-tournament-confirmation-design.md`).
- The competition `published → live` promotion (shipped and covered).

## Open questions for the owner

1. **Task 2.1 — roster drift.** Should a roster change after minting
   (a) reconcile the shell set automatically, or (b) refuse with "unpair the
   seated rounds first"? (a) is friendlier and more destructive; (b) is safer
   and makes the organiser do the work. **Recommendation: (b)** — this sits on
   the path that already produced C1, and an automatic reconcile silently
   rewrites rows the organiser has not looked at. Revisit if (b) proves
   annoying in practice.
2. **Task 2.2 — a round-count decrease with seated rounds beyond the new
   budget.** Refuse outright, or clear the seated rounds above the budget?
   **Recommendation: refuse** — clearing seated rounds is exactly the
   destructive-by-default shape C1 was.
3. **Wave 3 — should the round count follow the per-stage rules model, or keep
   the division-wide one?** Three options:
   - **(a) Leave it as is** and ship only Task 3.0, so the refusal names
     delete-and-recreate as the recovery.
   - **(b) Per-stage, evidence of play** — the same predicate match rules use
     (`config_snapshot is not null OR exists(score_events)`), scoped to the
     Swiss stage. Round count then behaves exactly like `bestOf`, which is one
     rule for an organiser to learn instead of two.
   - **(c) Division-wide, but tied to division `active`** rather than to row
     existence — the literal reading of the 2026-09-20 ruling.

   **Recommendation: (a) now, (b) later.** (a) is a message and a test and
   removes the dead end today. (b) is the right end state because it collapses
   two mental models into one, but it is a destructive re-mint on live rows and
   should not be rushed on the strength of a workaround being ugly. (c) is the
   weakest: division `active` is not monotonic in the way the other freezes
   are, and it would leave rounds and rules answering to different signals
   anyway.

   Note the asymmetry either way: a division can be `active` with no match
   played, so (b) and (c) disagree for exactly the organiser who starts the
   tournament and immediately spots a wrong round count.

## Verification bar for the whole programme

- All four test types per task: unit, e2e, smoke, regression.
- Every guard mutation-tested, killers named.
- Wave gates re-run at the wave boundary by the orchestrator, not accepted from
  a task report.
- Findings recorded per wave in an `_INDEX.md` beside this file, including
  premises that proved false.
- A walkthrough after every task group — an executable spec under
  `apps/web/e2e/walkthrough/`, named in `WALKTHROUGH_SPECS`
  (`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`). A markdown file titled
  "walkthrough" is not one; that confusion has already occurred on this
  programme.
