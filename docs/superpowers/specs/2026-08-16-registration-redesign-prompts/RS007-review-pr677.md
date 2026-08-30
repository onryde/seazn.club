# PR #677 review — findings, and what verification did to them

`/code-review medium 677`, run 2026-08-30 against
`git diff main...HEAD` on `feat/rs007-status-join-payments` (283 files).
Production hunks read depth-first; test files skimmed, not audited.

Recorded here rather than left in a chat transcript, per the standing
rule that review findings go to disk. Each finding keeps the reviewer's
own wording; **VERDICT** lines below them are mine, added after checking
the code — a reviewer agent is a lead, not a ruling.

Status key: OPEN (accepted, unfixed) · CONFIRMED (reproduced) ·
REJECTED (checked, not a defect) · FIXED (with commit).

---

## H1 — refund can hit the wrong charge when a cart holds two payment intents

`apps/web/src/server/usecases/registrations.ts:3978`

`confirmPaidRegistration` writes `payment_intent_id = coalesce(${paymentIntentId},
payment_intent_id)` (`:2526`), so the LATEST intent wins on the group row. A cart
with entry A paid at submit (PI_A), and sibling B promoted off the waitlist later
and paid through its own single-entry session (PI_B), ends up with
`group.payment_intent_id = PI_B`. Cancelling A passes that group PI into
`resolveRefundPolicy` (`:3967`), `refundable` is true, and `stripeRefund(PI_B,
A.amount)` refunds B's charge while B stays confirmed and A is never refunded —
or Stripe rejects it outright if A's fee exceeds B's.

The `status === "paid" || "confirmed"` guard added in this PR closes the
never-charged-sibling case, not this one. The same wrong value is shown on the
read side at `:3661`.

Reviewer's suggested fix: a per-entry intent, or at minimum refuse to auto-refund
when the group PI is not provably this entry's.

**VERDICT: CONFIRMED — real, and reachable by design, not by accident.**

Checked each link in the chain rather than the conclusion:

- The refund really does target the group's intent. `locked` is a
  `registrations join registration_groups` row (`regGroupCols`), so
  `locked.payment_intent_id` at `:3977` is the GROUP column, not the entry's.
- The group column really is last-writer-wins. `confirmPaidRegistration`
  writes `coalesce(${paymentIntentId}, payment_intent_id)` at `:2526` — the
  NEW intent first, so it overwrites. Note the `late` branch twenty lines up
  writes the arguments the other way round, `coalesce(payment_intent_id,
  ${paymentIntentId})` — first-wins. The two orderings sit in one function and
  only one of them can be right for a column that must identify a charge.
- Two intents on one cart is the DESIGN, not an edge case. Sessions are
  group-keyed with an explicit `registration_ids` SUBSET (`:2019-2041`,
  `line_items: entries.map(...)`), precisely so a promoted or resumed entry
  can be paid on its own. `handleCheckoutCompleted` then loops those ids
  against one intent. So a cart paid in two sessions has two intents and one
  column to hold them.

The existing comment at `:3963` shows the shape of this bug was already found
once — "passing the group PI unconditionally here used to let cancelling a
never-charged promoted sibling run a REAL stripeRefund against the sibling's
own money". That fix gated on the entry's own STATUS, which closes the
never-charged case and leaves this one: both entries were genuinely charged,
so the status gate passes and the wrong intent still goes to Stripe.

Correct fix is a per-entry `payment_intent_id` (migration + write path + read
path). The reviewer's interim — refuse to auto-refund when the group PI is
not provably this entry's — is the right stopgap: it converts silent
wrong-charge refunds into a visible "refund by hand", which #16's manual
refund control already supports.

NOT caught by the money matrix, and it never would have been: all 5 scenarios
pay a cart in ONE session.

---

## H2 — a duplicate charge on a withdrawn-after-payment entry is silently kept

`apps/web/src/server/usecases/registrations.ts:2490`

The `if (reg.status === "withdrawn" && reg.charged_at) return null;` guard — added
by this session's #18 fix — has no intent comparison, unlike the paid/confirmed
branch above it (`:2400`), which refunds when `paymentIntentId !== reg.payment_intent_id`.

Two checkout tabs: S1 pays, entry confirmed. Entry withdrawn past the refund lock
(correctly unrefunded). S2 then completes with a DIFFERENT PI. This guard returns
null, so the second charge is neither refunded, nor recorded, nor audited.

Reviewer's suggested fix:
`... && (!paymentIntentId || paymentIntentId === reg.payment_intent_id)`.

**VERDICT: CONFIRMED — and this one is mine, from #18.**

The path is exactly as described: a `withdrawn` row skips the duplicate branch
at `:2400` (that branch only matches `confirmed`/`paid`), reaches my guard, and
returns null regardless of which intent just paid. Reachable: the duplicate
branch exists BECAUSE two open checkout tabs are real, and nothing prevents the
second tab completing after a withdrawal.

**The reviewer's suggested fix is wrong, and would lose the money it is trying
to protect.** Adding `&& (!paymentIntentId || paymentIntentId === reg.payment_intent_id)`
makes a different intent fall through to the `late` branch below — which
returns `intent: (reg.payment_intent_id ?? paymentIntentId)`, i.e. the FIRST
intent. So it would refund the original charge, the one #18 exists to let the
organiser keep past the refund lock, and still leave the duplicate unrefunded.
Strictly worse than the current defect.

The right fix is symmetry with the branch above — return `duplicate` carrying
the NEW intent, so the duplicate is refunded and the original kept:

```ts
if (reg.status === "withdrawn" && reg.charged_at) {
  if (paymentIntentId && reg.payment_intent_id && paymentIntentId !== reg.payment_intent_id) {
    return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
  }
  return null;
}
```

Blocked behind H1 in one respect worth stating: `reg.payment_intent_id` is the
GROUP column, so on a two-session cart "different intent" can also mean "a
sibling's payment". H1's per-entry column fixes both.

---

## M1 — #10 is only half fixed: the write path still reads the cart's stale `payment_method`

`apps/web/src/server/usecases/registrations.ts:3680`

`buildGroupStatusView`/`resolveMoneyState` now resolve the method per division,
but `resumeRegistrationCheckout` still gates on `reg.payment_method` (the group
column). `promoteWaitlistedRow` only overwrites that column when no other entry in
the cart is still `pending` (`:1075`), so a promoted stripe entry in a cart with
another pending sibling renders a live "Pay now" button whose POST 422s with
"This entry fee is paid directly to the organiser" — the dead end #10 was raised
for, moved from the button to the click.

**VERDICT:** _pending verification_

---

## M2 — `requiresGender` fires on any non-empty `eligibility_note`

`apps/web/src/server/usecases/registration-eligibility.ts:174`

Any organiser note ("bring your own kit", "club members only") makes the public
WHO step demand gender as a REQUIRED field (`joinWhoRequirements` /
`whoFieldRequirements` feed `validateContact`), while `divisionEligibilityIssues`
never checks gender for a null category. The browser therefore blocks a registrant
the API would accept.

Documented as a deliberate trade in the doc comment, but it is a real
registration-blocking change on divisions with nothing to do with gender.

**VERDICT:** _pending verification_

---

## L1 — an out-of-range cutoff day silently rolls into the next month

`apps/web/src/lib/registration-rules.ts:193`

`age_cutoff_day` is validated only as 1–31, by zod and by
`divisions_age_cutoff_check`. `new Date(Date.UTC(year, month-1, day))` rolls over:
31 September becomes 1 October, 30 February becomes 1/2 March. Eligibility shifts
by days against what the organiser configured, on both client and server, with no
error anywhere.

**VERDICT:** _pending verification_

---

## L2 — the claim CAS overwrites `dob`/`gender` with whatever the joiner sent, including null

`apps/web/src/server/usecases/registration-submit.ts:1130`

The join form renders those inputs only when `requires_dob`/`requires_gender`. If
an organiser removes the age band between submit and claim, a captain-entered DOB
is ERASED on claim — losing the value `findOrCreatePlayerPerson`'s dob rule and
any later youth handling depend on.

Reviewer's suggested fix: `coalesce(${input.player.dob}, dob)`.

**VERDICT:** _pending verification_

---

## L3 — the lapse pass returns a row to `waitlisted` without clearing `amount_cents`

`apps/web/src/server/usecases/registrations.ts:4385`

`entryCountsTowardTotal`'s own doc comment, and `buildCartMail`'s "non-waitlisted"
rule, both rest on "a waitlisted row's `amount_cents` is always 0 by
construction". After a lapse it carries the promoted fee. Nothing misreads it
today (the status page filters waitlisted out), but the stated invariant is now
false for every re-promotion candidate.

**VERDICT:** _pending verification_

---

## L4 — the join success meter uses a stale roster total after a refresh

`apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/register/join/join-form.tsx:133`

`totalPlayers` is the prop captured at page load; `slots` may have been replaced
by `refreshSlots()`. After a 409 → refresh → successful claim,
`claimed = totalBefore - freshUnclaimed + 1` mixes two snapshots and can report
"3 of 4" for a roster that is 4 of 4.

**VERDICT:** _pending verification_

---

## Explicitly cleared by the reviewer

Nothing blocking in V380 (the per-division age dedup and the `youth` re-assert are
correct as written), V383, the sweep's lease/CAS reordering, the `not-found.tsx`
locale fix, or the `registrations-sweep.yml` / `e2e.yml` additions.

## Scope caveat worth carrying

Test files were skimmed, not audited — so "no finding" here is not evidence that a
test proves what it claims to. The money matrix
(`e2e/walkthrough/rs007-money-matrix.spec.ts`) passes 7/7 against real Stripe on
the shipped state, and did NOT catch H1 or H2: both need a SECOND payment intent
in one cart, which no scenario in the matrix creates.
