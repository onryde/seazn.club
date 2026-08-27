# Walkthroughs

A walkthrough plays a **whole match by hand** — from the pre-match screen,
through every goal, delivery or point, to a decided result — and asserts that
the ledger agrees with what was tapped.

Every other spec in `e2e/` asserts on a slice of behaviour. These assert on the
product: that a scorer holding a phone can actually finish a match.

## Why this folder exists

Cricket and football each shipped a **broken decider** through two signed-off
waves. A cricket super over could not be scored on the pad at all — the board
printed "This innings is closed." over a live decider and disabled every
delivery tile — and nothing caught it: not unit tests, not e2e, not the
gallery, not smoke.

All of those surfaces assert on code. None of them had ever tapped the thing.

## The rule

> Setup may use the API to REACH a state. Every event that IS the thing under
> test must be TAPPED, and the ledger must agree with the tap.

An API-driven test cannot see a payload the pad never builds, a tile the pad
disabled, or a cue pointing at the wrong side. That blindness is the whole
reason the defects survived.

## What is here

| Spec | Plays |
|---|---|
| `scorepad-v3-deciders-byhand` | cricket super over, football shoot-out — every decider event tapped |
| `scorepad-v3-deciders-fullmatch` | football to penalties; cricket to a tie, then the super over; undo in and after a decider |
| `scorepad-v3-tennis-mtb` | tennis, through the deciding-set match tie-break, then the match point undone |

## Running them

```bash
npx playwright test --project=walkthrough
```

They are their own Playwright project and their own CI leg — see
`playwright.config.ts`'s `WALKTHROUGH` comment for the cost and the reasoning.
`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` proves the project is
dispatched and selects these files, because a project nothing dispatches is
indistinguishable from a passing one.

### Watch one in a real browser

```bash
DEMO_PACE=800 DEMO_HOLD=30000 npx playwright test --project=walkthrough --headed --workers=1
```

`DEMO_PACE` slows each tap so a human can follow it; `DEMO_HOLD` keeps the
window open on the final screen.

## Adding one

A sport belongs here once it has a decider or a phase transition the pad must
repoint scoring onto — that is the shape that has failed every time. Tap the
match to the transition, assert the board is still live at it, finish the
match, then undo the deciding event and assert the pad comes back scoreable.

Two things worth copying rather than reinventing:

- **Shorten the match through config, never through the API.** One-game sets
  or a one-over innings keeps the tap count sane and leaves the decider itself
  untouched. Configs are refined against each other — cricket's
  `ballsPerInnings` against both `maxOversPerBowler` and `minOversForResult` —
  and an unparseable config renders **no pad at all**, not an error.
- **Prove the test can fail.** Every spec here was mutated until it went red
  before it was trusted; one of them passed on the first run, which is exactly
  when a test deserves the least trust.
