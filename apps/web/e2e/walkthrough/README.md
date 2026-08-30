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
| `registration-connect` | the money path: organiser settings → public team entry on a paid division → card on `checkout.stripe.com` → webhook → confirmed |
| `rs007-invite-pay-cancel` | invite + pay + cancel: two team entries in one cart (capacity ONE waitlists the second), one Stripe checkout for the cart's real subtotal, a claim link followed, the waitlisted sibling promoted but never paid, then cancelled through the status page — witnesses two confirmed defects (the subtotal keeping a withdrawn entry's fee; the cancel dialog promising a refund sourced from a sibling's charge). Meant to FAIL. |

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
