# Walkthroughs

A walkthrough drives **one whole journey by hand**, through the real UI, from
its first screen to its finished state — and asserts that the system's own
record agrees with what was done.

Every other spec in `e2e/` asserts on a slice of behaviour. These assert on the
product: that a person holding a phone can actually get to the end of the thing
they came to do.

**Not only scoring.** A journey qualifies whenever a real person completes a
multi-step task that the business depends on: scoring a match to a decided
result, entering a competition and paying for it, an organiser configuring
something that then has to work for someone else. The scorepad specs came
first because that is where the defects were found first, not because the
folder is about sport.

## Owed journeys (2026-09-03, owner-requested)

Two journeys no walkthrough drives. **Both are owed, and both are ALSO covered
over the API by the scheduler bench** — that is not duplication, it is the two
halves of the same claim. The bench asserts the record is correct
(`POST /officials/{id}/invite`, `GET /persons/{id}/stats`,
`GET /divisions/{id}/stats/players`); a walkthrough asserts a person can get
through the screens, which is the half no API-driven suite can see.

**W-PLAYER's timing is part of the requirement:** the stats must be verified
AFTER the competition has finished. A stats page read mid-competition proves
almost nothing. That sequences it behind the bench's own B05, which is what
folds the events and produces a finished suite to read.

If the bench's browser driver (B03r's `lib/drivers/browser.ts`) lands first,
prefer driving these there rather than building a second harness — the bench
index records that decision.

**W-OFF — the organiser seats an official.** Create an official, invite them,
and assign them to a fixture, by hand, start to finish. Nothing covers this
today: `competition-desk-organiser.spec.ts` never mentions officials, and the
`invite` hits in the `rs007`/`rs010` specs are REGISTRATION invites, not
official ones. `officials-directory.spec.ts` and `official-marks-reports.spec.ts`
exist but are slices — both make more `request`/`api/v1` calls than `page.goto`
navigations, so they assert the routes, not the journey.

This is squarely what the README below calls "an organiser configuring
something that then has to work for someone else": the assignment has to show
up for the official, and a claim invite has to be openable by the person who
receives it.

**W-PLAYER — the player reads their own record.** Claim a player profile and
verify the stats shown are the real ones. Same situation:
`player-accounts.spec.ts` and `me-career.spec.ts` are route-level slices
(`request` calls run 2-3x their `goto` count).

Two specs, not one: they are two different actors, and this folder's point is
that one person gets to the end of one task.

**Where the data comes from.** The stats W-PLAYER reads are produced by the
scheduler bench — `pc_` claim invites are minted by B03 §5 and accepted by B05,
and bench design §9 P2 is exactly "claimed profile shows the real stats". So
the bench makes the record and the walkthrough checks a human can see it. Do
not rebuild seeding here; do not verify UI there.

**Bar:** desktop 1280, 320 and 768, no horizontal page scroll at any of them,
per the standing UI rule.

## Why this folder exists

Cricket and football each shipped a **broken decider** through two signed-off
waves. A cricket super over could not be scored on the pad at all — the board
printed "This innings is closed." over a live decider and disabled every
delivery tile — and nothing caught it: not unit tests, not e2e, not the
gallery, not smoke.

The registration side then produced the same shape from a different direction:
**3098 unit tests were green while every claim link 404'd**, because a
screenshot proves a link RENDERS and never that it RESOLVES. Only tapping it
does.

All of those surfaces assert on code. None of them had ever used the thing.

## The rule

> Setup may use the API to REACH a state. Every step that IS the thing under
> test must be DONE THROUGH THE UI — tapped, typed, submitted — and the
> system's own record must agree with it.

An API-driven test cannot see a payload the client never builds, a control the
client disabled, a link that points nowhere, or a cue naming the wrong side.
That blindness is the whole reason the defects survived.

## What is here

| Spec | Drives |
|---|---|
| `scorepad-v3-deciders-byhand` | cricket super over, football shoot-out — every decider event tapped |
| `scorepad-v3-deciders-fullmatch` | football to penalties; cricket to a tie, then the super over; undo in and after a decider |
| `scorepad-v3-tennis-mtb` | tennis, through the deciding-set match tie-break, then the match point undone |
| `scorepad-v3-badminton-match` | badminton, through a game boundary — Law 8.1 names the winner as next server — to a decided result, then undone |
| `scorepad-v3-tabletennis-match` | table tennis, across the turnLength:2 rotation, into deuce, through a game boundary, to a decided result, then undone |
| `scorepad-v3-volleyball-match` | volleyball, a set opened by answering the pad's own serve question, a set that inherits its opener by alternation, then the deciding set's own fresh toss, to a decided result, then undone |
| `scorepad-v3-cricket-icc-picks` | cricket opening pair and bowler off the strip, other-end block, required “Who walks in?” after a wicket, rename the incoming batter until they face, then the same incoming question on retire |
| `registration-connect` | the money path: organiser settings → public team entry on a paid division → card on `checkout.stripe.com` → webhook → confirmed |
| `rs007-invite-pay-cancel` | invite + pay + cancel: two team entries in one cart (capacity ONE waitlists the second), one Stripe checkout for the cart's real subtotal, a claim link followed, the waitlisted sibling promoted but never paid, then cancelled through the status page — witnesses two confirmed defects (the subtotal keeping a withdrawn entry's fee; the cancel dialog promising a refund sourced from a sibling's charge). Meant to FAIL. |
| `settings-admin` | the platform fee — the one global number every entry fee is cut by: a support-role staff member offered a dead Save the route also refuses, a cleared field that must not save a silent 0%, the fee changed through the form and read back from the store, and both bounds driven on the form AND on the route. Then the four legacy `/settings/*` shims, landing org-scoped with the `?tab=` and Stripe return params they carry — `/settings/payments` via two hops — and an email-change confirmation keeping its OUTCOME through `/settings`, driven on two outcomes so a shim forwarding a constant, or a banner ignoring the value, fails |
| `scheduling-organiser-day` | the organiser's scheduling day: division settings and the court multi-picker → the constraints panel's real commit semantics (blur-commit numbers, instant-commit checkboxes, a blackout saved through its own editor) → required court tags on the stage → a capacity pre-check derived from the settings, including a case where the per-day cap BINDS → auto-schedule → the timetable read back off the record (time AND court, not a count) → freeze → clear and restore both refused, on screen and at 422 → publish and start, with the freeze asserted still in force on both sides |
| `swiss-pre-start-field-change` | the club night that changes shape before it starts: a three-round Swiss generated PRE-Start, a court and a time pinned on a LATER round's TBD shell, then entrants added through the add form and deleted through the row's own confirm dialog — and Pair next, after which rounds 2 AND 3 must carry the board count the new field needs (with the new board offering a `set_time` action, i.e. schedulable) while the pinned shell keeps its id, its `scheduled_at` and its `court_id`. Both parity directions: 6→9 mints a board and an appearing `-bye`, 9→6 deletes the surplus board and the bye while the pinned `b1` survives |
| `swiss-round-one-pairing` | a Swiss Knockout's round-1 pairing, picked from the desk: the ▾ split button and its menu at 320/768/1280 (options, seed hints, keyboard, Escape, axe, hit-tested), then Pair next with no pick (`{}` on the wire, top-vs-bottom 1v5… in the DB although the stage is stored as Neighbours), Unpair, ▾ → Neighbours (`{"pairing":"rank_adjacent"}`, 1v2…), Unpair and a plain press (`{}` again — the pick was for one press), round 1 played, the round-2 menu read-only, and round 2 paired off the served standings by the engine's own `pairRound`. The menu is also driven in French. Every expected pair is derived (`roundOnePairs`, `pairRound`), every sentence read from the dictionaries |
| `scheduling-officials-handoff` | the two-person handoff: the organiser invites an official from the directory, the claim link is read off the page that emits it (it is a `<code>`, not an anchor — §S16) and followed in a SECOND context with `storageState: undefined`, the official sets a blackout day on `/me`, the organiser assigns them by name through the per-fixture select and sees the unavailable cue, and the official accepts from their own screen — every step read back out of `fixture_officials`. Also drives propose → apply → read-back to completion, seating an uncapped official on BOTH same-day fixtures — which is how §S4 was resolved: the apply control is not dead, it is the block-conflict branch refusing a proposal the `max_per_day` cap cannot cover. The residual finding is that a blocked draft gives the organiser no reason. |

`registration-connect` and `rs007-invite-pay-cancel` are both **opt-in** and
skip loudly without `CONNECT_WALKTHROUGH=1` and `STRIPE_CONNECT_TEST_ACCOUNT`
— between them they are the only places in the suite that genuinely produce
`checkout.session.completed`, so a run that skips both proves nothing about
fulfilment. Read the skip warning in the job log rather than the "N skipped"
in the summary.

## Running them

```bash
npx playwright test --project=walkthrough
```

They are their own Playwright project and their own CI leg — see
`playwright.config.ts`'s `WALKTHROUGH` comment for the cost and the reasoning.
`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` proves the project is
dispatched and selects these files, because a project nothing dispatches is
indistinguishable from a passing one.

## What they cost

Every spec here carries a **derived** budget rather than a flat literal, and
asserts its own ceiling as the test's FIRST act — never at module scope, where
a load-time failure reports as zero collected tests instead of a red one.
Ceiling: **90s per spec.**

| Spec | Measured | Budget derives to | How |
|---|---|---|---|
| `scheduling-organiser-day` | **31.08s**, three consecutive clean runs, warm `:3313` | 81s | `14 × 4_000 + 2 × solverWall() + 5_000`, where `solverWall()` mirrors `autoSolverWallMs()` (env-tunable, 10s default) |
| `scheduling-officials-handoff` | **~25s** solo for the file (2 tests; the second drives propose → apply → read-back, and PASSES — the §S4 `test.fail()` pin it replaced is gone) | 82.5s | `25 × 2_500 + 20_000`, the 20s citing `loginUi`'s own wait |
| `swiss-pre-start-field-change` | **9.8s + 8.7s** solo, `--workers=1`, warm `:3366`; 30.3s for the whole file including both `auth.setup` projects | 185s each | `navs × 20_000 + (acts + 3 widths) × 5_000 + generates × 20_000`, floored at 120s — the counts are the test's own, settled against a measured `visits` at the end. Deliberately NOT tightened to the solo figure: this file has never been measured under contention |
| `swiss-round-one-pairing` | **25.6s / 28.3s / 34.4s** for the whole file (11 serial tests + both `auth.setup` projects), three consecutive runs, warm `:3365`; in the third, no test over 2.5s | 60s floor; 215s for the Pair next test (6 presses) | `navs × 20_000 + acts × 5_000 + generates × 20_000`, floored at 60s — each test states the counts it performs. Not measured under contention |

**Leg-level number, measured 2026-09-05** on a quiet machine against a server
rebuilt from this tree:

| | |
|---|---|
| whole `walkthrough` project | **593s** (9.9 min) at `workers=4` |
| its floor | `scorepad-v3-tennis-mtb`, **307s** in ONE unsplittable test |
| `scheduling-organiser-day` | **43.7s** under contention (27.2s solo), budget 81s |
| `scheduling-officials-handoff` | **34.9s** for its two tests under contention (38s solo for the file), budget 82.5s |

So the two scheduling specs do hide under the tennis tail, as the pass condition
required — together they are about an eighth of a leg whose floor is one test
they cannot influence.

The numbers that matter are the CONTENTION ones, not the solo ones. Both
budgets are derived, and both hold at `workers=4` where the specs compete with
the scorepad files and with each other. A budget that only holds in a quiet run
is a budget that reds in CI.

Two caveats on this measurement, so nobody over-reads it:

- It was taken at `workers=4`, not the `workers=3` this note originally
  specified. Compare like with like before drawing a trend.
- There is still no **pre-wave** figure for the same invocation, so "not
  materially above its pre-task value" is argued from the marginal cost of the
  two specs rather than from a before-and-after. That is weaker evidence, and
  it is the honest description of what was measured.

- The measurement must confirm `suites > 0` and `expected > 0`. A walkthrough
  run that aborts at preflight reports `suites: 0, expected: 0, unexpected: 0`
  — a pass to any gate reading `unexpected === 0` alone.

One flake seen once and not reproduced in three clean runs:
`scheduling-officials-handoff` hit its own 82.5s budget on
`official-blackout-add` staying disabled. That is ~3× the clean wall clock, so
it is a stall rather than accumulated slowness — a controlled date input whose
`fill()` lost the hydration race, leaving `disabled={busy || !date}` true while
`click()` waits out the whole test budget. **Do not raise the budget for it.**

### Watch one in a real browser

```bash
DEMO_PACE=800 DEMO_HOLD=30000 npx playwright test --project=walkthrough --headed --workers=1
```

`DEMO_PACE` slows each tap so a human can follow it; `DEMO_HOLD` keeps the
window open on the final screen.

## Adding one

Ask what a real person came to do, and whether failing halfway through it would
be invisible to every test that asserts on code. If it would, it belongs here.

Two shapes have failed repeatedly and are worth covering on sight:

- **A transition the UI must repoint itself onto.** A sport belongs here once
  it has a decider or a phase change the pad repoints scoring onto. Tap to the
  transition, assert the board is still live at it, finish the match, then undo
  the deciding event and assert the pad comes back scoreable.
- **A handoff between two people, or between a person and an external system.**
  A link one person sends another, a payment that has to come back and confirm
  something. Those break at the seam, and the seam is exactly what unit tests
  stub out. Follow the link or the redirect the way its recipient would — from
  the page that emits it, not by constructing the URL yourself, which is how a
  dead link stays green.

Three things worth copying rather than reinventing:

- **Skip loudly, or not at all.** A spec that needs a secret must say on stdout
  what was not exercised when it lacks one. Playwright's summary prints "1
  skipped" with no reason, and a leg that silently skips its only real proof
  looks exactly like one that ran it.

- **Shorten the match through config, never through the API.** One-game sets
  or a one-over innings keeps the tap count sane and leaves the decider itself
  untouched. Configs are refined against each other — cricket's
  `ballsPerInnings` against both `maxOversPerBowler` and `minOversForResult` —
  and an unparseable config renders **no pad at all**, not an error.
- **Prove the test can fail.** Every spec here was mutated until it went red
  before it was trusted; one of them passed on the first run, which is exactly
  when a test deserves the least trust.
