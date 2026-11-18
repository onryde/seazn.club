---
title: How card entry fees flow
description: From connecting Stripe to money in your bank, with holds, reminders, refunds and disputes.
order: 3
related: registration/open-registration, registration/registrants, registration/waitlist
---

With card payments, players pay their entry fee by card when they register. The money goes to your own Stripe account. This page follows one payment from connecting Stripe to the money reaching your bank. To take cash or bank transfers instead, choose **Pay the organiser** in [open registration](/help/registration/open-registration).

## Connect your Stripe account

You do this once, and only an organisation owner can. Choose **Settings**, then **Connect**. Under **Card payments (Stripe)**, tick the agreement to the Terms of Service, then press **Connect Stripe**. The agreement says your organisation bears the cost of chargebacks on its entry fees. Lost disputes are recovered from your Stripe balance.

Stripe takes over from there. The page shows three steps:

1. **Connect**: you are sent to Stripe's secure onboarding. Seazn Club never sees your details.
2. **Verify (KYC)**: Stripe checks who receives the money. It asks for a legal name, date of birth and bank account. Clubs and companies may be asked for registration documents. This usually takes minutes, and sometimes a day or two. You can leave and resume at any time with **Resume Stripe onboarding**.
3. **Go live**: when the page shows **Live — charges enabled**, your divisions can take card entry fees.

![The Connect page with card payments live](/help/registration/connect-live.webp "Card payments are live, with a button to open your Stripe dashboard")

Until your account is live, **Card payment at sign-up** is greyed out in a division's settings.

If a division already charges by card and your account stops being able to take charges, the **Registration** page says "Card payments aren't set up, so divisions that charge by card are closed to new registrations." Players see "Card payments are temporarily unavailable" on that division. Nothing is charged.

## If Stripe needs more information

Stripe can ask for more details later, even when you are live. The **Connect** page then shows "Stripe needs more information", with a **Finish Stripe verification** button that takes you to what Stripe still needs. Use **Open Stripe dashboard** to see payouts, charge history and bank details. You do not need a separate Stripe login.

## When a player pays

A player who registers for a card division is sent to a Stripe checkout page. When the payment goes through, the entry is confirmed and the confirmation email is sent.

If the player closes checkout without paying, the entry is held for 48 hours. About 24 hours before the hold ends, they get a reminder with a link to pay. If the 48 hours pass, the entry expires and the first person on the [waitlist](/help/registration/waitlist) is offered the place. You can also press **Send payment reminder** on the entry yourself.

## The platform fee

Taking card payments needs no upgrade. Every plan can do it, Community included. Your plan sets the share Seazn Club keeps from each card payment:

| Plan | Platform fee |
| --- | --- |
| Community | {{plan:registration.fee_percent:community}}% |
| Event Pass | {{plan:registration.fee_percent:event_pass}}% |
| Pro | {{plan:registration.fee_percent:pro}}% |
| Enterprise | {{plan:registration.fee_percent:enterprise}}% |

Each payment reaches your Stripe account minus Stripe's own processing fee and this platform fee. Stripe sets its fee, and it is taken on every plan. Stripe pays out to your bank on its own schedule. Payout timing and bank details are in your Stripe dashboard.

The rate for a competition is the better of what your plan and an [Event Pass](/help/billing/event-pass) give it. It is fixed when the competition takes its first paid entry, and later entries pay that same rate even if your plan changes.

> **Example**
> A Community organisation puts its annual open on an Event Pass. Until the first paid entry arrives, the open can still change rate. Once the first player pays, the open keeps the Event Pass rate for every later entry, while the organisation's other competitions stay at the Community rate.

## Refunds

When a player withdraws a paid card entry before the **Refund lock** date, the refund is automatic and in full. The money goes back to their card, the platform fee is returned with it, and they receive a receipt email. The player withdraws with **Cancel this entry** on their registration page.

Set the **Refund lock** in the division's settings, under **Money**. It appears when the division charges by card. After that moment a withdrawal keeps the fee, and refunds become your call.

With no **Refund lock** set, withdrawals refund in full until the competition's start date. If the competition has no start date either, nothing refunds by itself.

After the lock, open the entry on the **Registrants** tab and press **Refund**. The entry keeps its place. **Withdraw** frees the place and applies the same lock rule.

A solo sign-up with no team by its **Place-by date** is also withdrawn and refunded. See [allow solo sign-ups](/help/registration/open-registration#allow-solo-sign-ups).

> **Example**
> A division charges a card fee and its **Refund lock** is 1 June. A player withdraws on 28 May and is refunded in full to their card. Another withdraws on 3 June. Their fee is kept. You decide to refund them anyway, so you open their entry and press **Refund**.

## Disputes

A cardholder can dispute a payment with their bank. When Stripe tells Seazn Club, the entry's payment shows **Disputed**, and an alert email goes to your organisation's owner. Nothing happens to the entrant. Whether they stay in the competition is your call.

- **You win the dispute.** The flag clears and the money stays with you.
- **You lose the dispute.** Stripe repays the cardholder, and the entry records the amount as refunded. The net amount you received for that payment is taken back from your Stripe balance. Seazn Club pays Stripe's dispute fee. You get an email that says exactly what moved.

## Common questions

**Where do I change my bank account or see payouts?** In your Stripe dashboard. Use **Open Stripe dashboard** on the **Connect** page. Seazn Club shows the entry-fee side and Stripe shows the banking side.

**Why can I not choose Card payment at sign-up?** Your Stripe account is not live yet. See the first section of this page.

**Does a waitlisted player pay?** No. A fee is only taken once a place is theirs. See [the waitlist](/help/registration/waitlist).
