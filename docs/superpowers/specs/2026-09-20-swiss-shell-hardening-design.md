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

A tenth gap was found later the same day, outside the predecessor's list and
one layer up: **three of those wrong-number findings land in the standings
table, and no e2e or walkthrough in the repo asserts a standings POINT** — the
two specs whose titles promise it assert only that rows are visible. Tasks 0.6
and 0.7 close that before Wave 1 touches the numbers.

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

Ordered by **blast radius, not by effort** — where blast radius means "what
does this stop an organiser doing", not "how many rows does it touch". The
ranking moved once already: a defect filed as setup-time roster drift turned
out to be reachable through the ordinary mid-tournament withdrawal path, which
promoted it from Wave 2 to the head of Wave 1. Expect the ranking to move again
as premises are re-pinned.

Two hard dependencies:

- **Wave 0 precedes everything.** Nine tests in this area do not constrain the
  code, and above them no e2e asserts a standings point at all. Fixing
  behaviour behind that means the suite cannot witness a regression in the very
  thing being fixed. Tasks 0.6/0.7 are the ones Wave 1 actually depends on:
  1.1, 1.2 and 1.3 all change what the standings table says.
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

**DONE 2026-09-20 (`b7cd4ae49`), and the premise was FALSE.** There is no pair
of guards left to cover for each other: C1 (`95c6cfa88`, which landed on #804)
deleted `isSwissByeRow` — `ext_key?.endsWith("-bye") === true || isAwardOutcome`
— outright. Verified independently: the symbol appears nowhere in production
code, only in two comments in `swiss-shell.test.ts` (`:108`, `:377`) recording
what it used to be. The task's "second guard is dead code" reading described a
predicate that had already been removed.

What `swissRoundHasPlayedResult` actually has is THREE arms, and each already
kills a distinct named test when mutated singly — the bye-exemption arm, the
award arm (killed by a row whose status is `scheduled`, which the status arm
therefore cannot cover) and the status arm (killed by a forfeited row whose
outcome is a WIN, which the award arm cannot cover). Nothing was deleted: the
`ext_key` values still present in the row fixtures are load-bearing test INPUT
proving the name is ignored, so removing them would weaken 26 literals rather
than tidy them.

Two witnesses were added regardless — a `-bye`-keyed row carrying a real played
match must still block, and a genuine bye named like a board must still be
exempt. Reinstating the old ext_key arm reds the first; exempting by name reds
both. 29 tests, was 27.

**Carried forward as a finding, NOT closed here.** `reconcileSwissRoundShells`
(Task 1.0) reintroduces name-based bye classification —
`isByeShell = ext_key?.endsWith("-bye")` — the very predicate C1 deleted. It is
defensible in that one place and nowhere else: it classifies an UNSEATED SHELL,
which has no entrants and therefore no award outcome, so `isOneSidedAwardBye`
cannot classify it and the ext_key is the row's only identity. The destructive
guards (unseated, `swissRoundHasPlayedResult`, canonical `fixtureEvidenceSql`)
all run before any delete, so a misnamed real row refuses rather than being
eaten. The residual exposure is the inverse: a genuine bye shell that is NOT
`-bye`-suffixed would be invisible to the reconcile and a second bye minted
beside it. Nothing mints such a row today — both mint sites use
`sw-r${n}-bye` — so this is a constraint to keep, not a live defect. Any third
mint site owes the same suffix or this breaks silently.

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

### Task 0.6 — no e2e anywhere asserts a standings POINT

Found 2026-09-20 by sweeping assertions, not titles. Wave 1's Tasks 1.1, 1.2
and 1.3 are all standings-points defects, and the layer that would catch them
in a browser does not exist.

What the sweep actually found:

| Layer | Plays through | Asserts points? |
| --- | --- | --- |
| DB-integration vitest | `scoreEvent` / `appendEvent` → real engine fold | **Yes, well** — `custom-points.test.ts:176` (forfeit 3 / −1), `engine-db/integration.test.ts:215` (3/0 **and rank 1/2**), `config-snapshot.test.ts:312` (3/1), `swiss-shell-fixtures.test.ts:248` (bye `{played:1,won:1,points:2}`, then 0/0/0 after Unpair), `add-fixture.test.ts:153` |
| e2e | API-driven scoring | **Once, in the whole suite** — `v6-sports.spec.ts:698` hockey FIH draw → `points === 1`, `drawn === 1` |
| e2e "standings" journeys | fully-scored stage | **No** — see below |
| walkthrough | tap-by-tap pad | **No** — none navigates to standings at all |

`journey-pro.spec.ts:266` is titled *"complete the stage and verify the
standings table"*. Its whole body is a `getByRole("row", …)).toBeVisible()`
loop over `PLAYERS`. Rows present; no point, no rank, no order.
`journey-community.spec.ts:101` is the same shape plus `expect(pub.status)
.toBe(200)`. **Garble every points value in the table and both stay green** —
failure class 4, and the reason this task is in Wave 0 rather than Wave 1.
`spectator-hub.spec.ts` opens `?tab=standings` three times (`:803`, `:1020`)
and every assertion there is layout or a11y — sideways scroll, `.sr-only`
anchoring, tap-target height — never a value.

**Build:** an assertion on the real table in `journey-pro.spec.ts:266`, on the
stage that test has already scored. The rig costs nothing extra: the division
is created at `:47-56` with `config: { points: { w: 3, d: 1, l: 0 } }`, and
every fixture is a HOME win — `scoreRemainingFixtures` (`e2e/helpers.ts:2056`)
posts `generic.result { p1Score: 2, p2Score: 1 }` unconditionally, and the one
fixture scored through the pad at `:211` is filled `3` then `1`, also a home
win. So each entrant's points are `w × (times they were home)` and nothing
else.

- Hoist the points block to a `const POINTS` used BOTH in the division-create
  body and in the expectation, so the two cannot drift apart. Do **not** type
  `3` into the assertion.
- Derive the expected map by reading `home_entrant_id` off the 15 fixtures —
  never a table of numbers typed into the test (failure class 19).
- Assert the full map, then that `rank` is monotone non-increasing in points.
  Six entrants on a circle-method round robin WILL produce home-count ties, so
  a strict order assertion here is a latent red; Task 0.7 owns strictness.

**Acceptance (the distinguishing one):** mutate `w: 3 → w: 2` in the division
config alone and this test must red with a points mismatch. A test that only
checks "every entrant has SOME points" survives that and is not the deliverable.
Also confirm the assertion sits after `/complete` and after
`scoreRemainingFixtures`, or it asserts a half-folded table.

### Task 0.7 — the one e2e that builds a strictly-ordered table asserts nothing about it

`competition-desk-actions.spec.ts:76` `scoreInSeedOrder` exists specifically to
make the standings **strictly ordered** — its own docblock says a uniform 2-1
would leave teams level on points and disable the confirm control. It scores
`leagueOfFour` (4 entrants, 6 fixtures, explicit `points: { w: 3, d: 1, l: 0 }`
at `:108`) so the earlier seed always wins, guards that every fixture was
scored — and then never reads the table it went to that trouble to produce. The
rows downstream assert the seed PROPOSAL, not the standings.

The expected table is total and tie-free: `entrantIds[0] = 9, [1] = 6, [2] = 3,
[3] = 0`, ranks 1-4. This would be the repo's **first e2e standings ORDERING
check**.

**Build:** give `scoreInSeedOrder` the `stageId` (all call sites are in this
one file; `leagueOfFour` already returns `leagueId`) and have it read
`GET /api/v1/stages/{id}/standings` after its existing scored-count guard,
asserting points and rank per seed. Every row that scores in seed order then
gets the check for free, beside the count guard that already exists for the
same reason.

Derive `9/6/3/0` from the same `points` object the division was created with
and each seed's win count — `(3 - i) × w` — not as four literals.

No `/complete` call is owed: `recomputeStandings` runs on every decided write
(`engine-db/integration.test.ts:204-224` pins exactly this), which is also why
`v6-sports.spec.ts` can read points mid-match.

**Acceptance:** reverse the comparison in `scoreInSeedOrder` (`h! < a!` →
`h! > a!`) so the LATER seed always wins. The table inverts, every downstream
row still passes, and only this assertion reds. A points-only assertion that
ignores rank does not witness that — it must fail on order.

**Wave 0 gate:** every mutant listed above kills a NAMED test, test totals
unmoved, and the killer names are recorded. Tasks 0.6 and 0.7 are e2e, so their
mutants are verified by running the spec FILE (never a `-g` slice, failure
class 21) against a prod build with `E2E_PROD_TARGET`.

---

## Wave 1 — stop the tournament being un-runnable, then stop the wrong numbers

**Goal:** one defect that halts a live Swiss event, then three that corrupt
standings silently. None changes a user-facing string.

**Re-ranked 2026-09-20 (owner challenge).** Task 1.0 was Task 2.1 and was
described as a setup-time mistake. It is not — see below. It now leads the
programme, ahead of the standings fixes: wrong Buchholz misorders a table,
whereas this stops the event being run at all, on the most ordinary
interruption a Swiss tournament has.

**Where 1.1–1.3's tests go.** The unit harness already exists and is good —
extend `usecases/__tests__/custom-points.test.ts` (it drives `scoreEvent` then
`getStandings` and asserts real point values) for 1.2, and
`usecases/__tests__/swiss-shell-fixtures.test.ts:248` (already asserts a bye
winner at `{played:1, won:1, points:2}`) for 1.1 and 1.3. No new rig is owed at
that layer. The e2e layer has no points harness at all until Tasks 0.6/0.7
build one — which is why those two are a hard dependency of this wave and not
a nice-to-have.

### Task 1.0 — a mid-tournament withdrawal bricks Pair next

**This is the common path, not an edge case.** Establish the chain before
touching anything, because the severity rests on it:

1. After Start, the ONLY roster change possible is a withdrawal.
   `enrollEntrants` refuses additions once the division is `active` or
   `completed` (`entrants.ts:300-306`), exempting only `ladder` / `americano`,
   neither of which is Swiss. Its own message says so: "This tournament has
   started — the entrant list is locked. Withdrawing entrants still works."
2. A withdrawal is a STATUS FLIP, not a delete (`withdrawal.ts:122`). The
   entrant row stays; `status` becomes `withdrawn`.
3. The generate/pair path counts only ACTIVE entrants (`stages.ts:1606-1609`):
   `select id, seed from entrants where division_id = $1 and status in
   ('registered', 'confirmed')`. `withdrawn` is not in that set.

So the field the pairer sees shrinks by one the moment anyone withdraws, while
the shells were minted for the old field size and are never revisited. Then the
seating loop walks the pre-minted shells against the newly-sized
`round.pairings` and throws: `"swiss bye shell missing for pairing"` when the
parity now needs a bye that was not minted, or `"swiss shell count mismatch for
pairing"` when it goes the other way.

**A field's parity changing is the NORMAL consequence of a withdrawal**, not an
exotic one. A player gets injured or does not show for round 3, and Pair next
throws `CONFIG_INVALID` for the remainder of the tournament.

Note the asymmetry this exposes: `withdrawEntrantCascade` already does careful
post-start work — walkovers for pending fixtures, voids for resulted ones — so
that path is plainly DESIGNED for mid-tournament use. It settles the existing
fixtures correctly and then leaves the shell set inconsistent with the field it
just changed.

The 5→6 growth direction is reachable only BEFORE Start, and is the less
important half.

**Build (owner ruled 2026-09-20 — option (a), reconcile).** Before seating the
target round, reconcile its shells against the CURRENT active field:
`boards = floor(n / 2)`, `bye = n % 2`. Delete surplus boards from the highest
`seq_in_round` down, mint only the shortfall, and add or remove the `-bye`
shell as parity requires.

**It must be a reconcile, never a delete-and-recreate.** Scheduling a shell
ahead of Pair is a shipped, tested feature — `swiss-shell.spec.ts` pins a TBD
shell's `scheduled_at` and asserts it survives Pair AND re-Pair. Recreating the
round changes fixture ids and discards `scheduled_at` / `court_id`, losing an
organiser's advance layout. Surviving rows keep their ids and their slots.
Full reasoning in Open question 1.

**Acceptance:**
- Withdraw one entrant from a 6-player Swiss after Start, mid-tournament, and
  Pair next must seat the next round — including the bye the new odd parity
  requires.
- Drive it through the REAL withdrawal path (`withdrawEntrantCascade`), not by
  editing entrant rows in a fixture. A fixture on both ends proves the fixture.
- Cover a withdrawal that flips parity odd→even as well as even→odd. One sample
  is not a parity sweep; enumerate the table.
- Already-seated and already-played rounds must be untouched.
- Recovery must not require deleting the stage.
- **A shell scheduled ahead keeps its slot across the reconcile.** Pin
  `scheduled_at` and `court_id` on a surviving shell, withdraw an entrant,
  Pair, and assert the slot is unchanged — the same assertion
  `swiss-shell.spec.ts` already makes across Pair/re-Pair, now across a field
  change. This is the assertion that distinguishes a reconcile from a
  recreate; without it both implementations pass.
- Re-run `swiss-shell.spec.ts` itself. It covers schedule-ahead directly and is
  the existing guard against this regression.

**DONE 2026-09-20** — `7cbbb8b44` (fix, `stages.ts` +168 and a new
`swiss-withdrawal-reconcile.test.ts`), `00ee59a70` (e2e). Unpushed, no PR.

`reconcileSwissRoundShells` (`stages.ts:1056`) sits between `pairRound` and the
seating loop, reuses `swissBoardsForField`, deletes surplus from the highest
`seq_in_round` down, mints only the shortfall, and moves — never recreates — a
surviving bye. It returns early and writes NOTHING when the field has not
moved, so the common Pair is untouched. All three destructive guards run under
the advisory lock `generateStageFixturesWrite` already holds, and every refusal
reuses `STAGE_NOT_READY`, so no new user-facing string and no dictionary work.

**Verified in this session, not taken on report:**

- Unit, re-run with the JSON reporter against `sw1`: 71 passed / 0 failed
  across the three suites, 11 of them the new file. Paths confirmed in
  `.testResults[].name`.
- **The distinguishing criterion was mutated by hand.** Turning the reconcile
  into a faithful delete-all/mint-all recreate (`survivors = []`, every board
  and the bye doomed, the bye re-minted) reds exactly two named tests — "a
  shell scheduled ahead keeps its id, slot and court across the reconcile" and
  "a field that grows before Start mints only the shortfall and keeps the
  boards it has" — with the total unmoved at 71. A recreate does not pass this
  suite, which is what the acceptance criterion above demanded and the one
  thing a report cannot establish.
- `swiss-shell.spec.ts` run as a WHOLE FILE against the rebuilt `sw1` prod
  bundle: 4 passed, including the new `:134` withdrawal test. (`seazn-env env`
  exports `SMOKE_BASE`, not `PLAYWRIGHT_BASE`; without the latter the preflight
  silently probes `:3000` and aborts. Environment, not defect.)

**Scope is LAZY — only the round being paired.** A later round has no results
to lose by being reshaped late, and reconciling every unseated round widens a
destructive write for a cosmetic fixture count. Two tests assert that rounds 2
and 3 keep their old size, so switching to all-rounds must move a test rather
than slip through.

**Deliberate survivor.** The early return gates only the RESHAPE: a
correct-shaped round still Pairs even when it carries evidence, because
refusing it would regress a Pair that works today. Pinned by a named test, and
it is the one mutant that survives by design in the force-false direction.

**Still owed on this task:** no walkthrough spec (the programme's bar is one
per task group) and the branch is unpushed with no PR.

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

**Goal:** one failure mode whose only recovery is deleting and re-creating the
stage (Task 2.2), and two correctness gaps on the destructive path. The other
failure mode originally filed here is now Task 1.0.

### Task 2.1 — MOVED to Task 1.0

Roster drift after minting was originally filed here as a setup-time mistake.
The owner established that it is reachable mid-tournament through the ordinary
withdrawal path, which makes it the programme's most severe finding rather than
a Wave 2 item. It now leads Wave 1. This heading is kept so the predecessor
doc's ordering still resolves.

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

**Note added 2026-09-20 — this task is NOT closed by Task 1.0, and a report
from that task nearly read as if it were.** Task 1.0's reconcile cannot eat an
ad-hoc fixture: `AddFixture` (`api-v1/schemas.ts:1133`) requires both entrant
ids as UUIDs under `.strict()`, so every ad-hoc row is SEATED, and the
reconcile's unseated guard refuses rather than deleting. Verified at the schema,
not inferred from the TypeScript input type. That settles the hazard for
`reconcileSwissRoundShells` and for nothing else — `unpairSwissRound` is a
different function with a different guard, and this task still owns it. Its
acceptance criterion is unchanged.

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

1. **Task 1.0 — how should the next round seat after a mid-tournament
   withdrawal?**

   **This question was previously answered wrongly and the answer is
   withdrawn.** The earlier recommendation was "refuse, and tell the organiser
   to unpair the seated rounds first". That was written on the belief that this
   was a pre-start setup mistake. As the response to a withdrawal in round 3 it
   is unacceptable: it asks the organiser to unpair rounds that have already
   been PLAYED, and refusing outright leaves the event un-runnable, which is
   the defect itself rather than a fix for it.

   The real options:
   - **(a) Re-mint the affected round's shells** to match the current active
     field, leaving seated and played rounds untouched.
   - **(b) Seat the round without depending on pre-minted shells** — create or
     delete rows as the pairing requires, so the shell set stops being a
     fixed-size assumption.

   **Recommendation was (a).** It is the smaller change, it keeps the shell
   model the rest of this feature is built on, and it confines the write to
   exactly one round that by definition has no results yet. (b) is the cleaner
   end state — the fixed-size assumption is the root cause — but it rewrites
   the seating path wholesale, on the same destructive surface that produced
   C1.

   **OWNER RULING 2026-09-20: (a).** Re-mint the affected round.

   **One refinement, flagged to the owner — taken literally, (a) breaks a
   shipped feature.** Scheduling a shell AHEAD of Pair is supported and tested:
   `apps/web/e2e/swiss-shell.spec.ts` schedules a TBD shell before Pair and
   then asserts the slot survives both Pair and re-Pair
   (`expect(rescheduled.scheduled_at).toBe(pinnedAt)`). A delete-and-recreate
   re-mint changes fixture ids and discards `scheduled_at` / `court_id`, so an
   organiser who had laid out round 4 in advance would silently lose it — and
   the existing e2e would red, correctly.

   **So the ruling is implemented as a RECONCILE, not a recreate.** Compute the
   shape the current active field needs — `boards = floor(n / 2)`,
   `bye = n % 2` — and move only the delta:
   - surplus boards: delete from the HIGHEST `seq_in_round` down, so the
     lower-indexed shells (and their scheduling) survive
   - missing boards: mint only the shortfall
   - bye shell: mint or delete exactly as parity requires, preserving the
     `-bye` `ext_key` convention that Unpair and the bye classifier depend on

   Surviving rows keep their ids, their `scheduled_at` and their `court_id`.
   Nothing is rewritten that does not have to be.

   Guards, either way: the canonical destructive guard rather than a subset,
   evidence-of-play monotonic (`config_snapshot is not null OR
   exists(score_events)`), the advisory lock taken BEFORE the guard is read
   (Task 2.4), and the round being reconciled proven unseated and unplayed
   first.

   **Deliberately left open:** rounds BEYOND the one being paired are also
   wrong-sized after a withdrawal. Reconciling lazily — each round when it is
   paired — is simpler and touches less, but leaves later shells stale, which
   any UI counting fixtures will report. Reconciling all unseated rounds at
   once is consistent but widens the write. Decide when building Task 1.0; the
   lazy option is the safer default and is what the acceptance criteria above
   assume.
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
