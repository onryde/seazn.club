---
title: How card entry fees flow
description: From connecting Stripe to money in your bank, with the hold on an unpaid entry, the platform fee and payout alerts.
order: 3
related: registration/refunds-and-disputes, registration/open-registration, registration/registrants, registration/waitlist
---

With card payments, players pay their entry fee by card when they register. The money goes to your own Stripe account. This page follows one payment from connecting Stripe to the money reaching your bank. To take cash or bank transfers instead, choose **Pay the organiser** in [open registration](/help/registration/open-registration). For refunds and disputes, see [refunds and disputes](/help/registration/refunds-and-disputes).

## Connect your Stripe account

You do this once, and only an organisation owner can. Choose **Settings**, then **Connect**. Under **Card payments (Stripe)**, tick the agreement to the Terms of Service, then press **Connect Stripe**. The agreement says your organisation bears the cost of chargebacks on its entry fees. Lost disputes are recovered from your Stripe balance.

An admin who opens **Connect** sees the cash and bank transfer instructions, but not the **Card payments (Stripe)** section.

Stripe takes over from there. The page shows three steps, and says this about each:

1. **Connect**: you are sent to Stripe's secure onboarding, and Seazn Club never sees your details.
2. **Verify (KYC)**: Stripe verifies who receives the money, with a legal name, date of birth and bank account. Clubs and companies may be asked for registration documents. The page says this is usually minutes, and can take a day or two if Stripe asks for more. You can leave and resume at any time with **Resume Stripe onboarding**.
3. **Go live**: when the page shows **Live — charges enabled**, your divisions can take card entry fees.

![The Connect page with card payments live](/help/registration/connect-live.webp "Card payments are live, with a button to open your Stripe dashboard")

Until your account is live, **Card payment at sign-up** is greyed out in a division's settings.

If a division already charges by card and your account stops being able to take charges, the **Registration** page says "Card payments aren't set up, so divisions that charge by card are closed to new registrations." Players see "Card payments are temporarily unavailable" on that division. Nothing is charged.

## If Stripe needs more information

Stripe can ask for more details later, even when you are live. The **Connect** page then shows "Stripe needs more information" and says payouts are paused until onboarding is completed. Use **Finish Stripe verification** to go back to Stripe. **Open Stripe dashboard** opens your Stripe dashboard.

## When a player pays

A player who registers for a card division is sent to a Stripe checkout page. When the payment goes through, the entry is confirmed and the confirmation email is sent. On a division with **Manual approval** the entry shows **Paid** instead and waits for you to approve it. See [managing registrants](/help/registration/registrants).

If the player closes checkout without paying, the entry is held for 48 hours. About 24 hours before the hold ends, they get a reminder with a link to pay. If the 48 hours pass, the entry expires and the first person on the [waitlist](/help/registration/waitlist) is offered the place. You can also press **Send payment reminder** on the entry yourself.

## The platform fee

Taking card payments needs no upgrade. Every plan can do it, Community included. Your plan sets the share Seazn Club keeps from each card payment:

| Plan | Platform fee |
| --- | --- |
| Community | {{plan:registration.fee_percent:community}}% |
| Event Pass | {{plan:registration.fee_percent:event_pass}}% |
| Pro | {{plan:registration.fee_percent:pro}}% |
| Enterprise | {{plan:registration.fee_percent:enterprise}}% |

The rate for a competition is the better of what your plan and an [Event Pass](/help/billing/event-pass) give it. It is fixed when the competition takes its first paid entry, and later entries pay that same rate even if your plan changes.

> **Example**
> A Community organisation puts its annual open on an Event Pass. Until the first paid entry arrives, the open can still change rate. Once the first player pays, the open keeps the Event Pass rate for every later entry, while the organisation's other competitions stay at the Community rate.

## Payouts

The **Connect** page says payouts land in your bank on Stripe's schedule, minus Stripe's processing fee and the platform fee for your plan. To see your payouts or change your bank account, use **Open Stripe dashboard** on the **Connect** page.

When a payout needs you, the **Connect** page shows **Your payouts need attention** with one of these lines:

- "Stripe could not pay out to your bank account. Check your bank details in Stripe — the next payout retries once they are right."
- "The bank account Stripe pays out to was removed. Add a new one in Stripe, or your entry fees stay on your Stripe balance."
- "Your payout bank details changed. If that was not you, check them in Stripe before the next payout."

The notice is on the **Connect** page only, where the owner sees it. It goes away once a payout made after it reaches your bank.

## Common questions

**Why can I not choose Card payment at sign-up?** Your Stripe account is not live yet. See the first section of this page.

**Does a waitlisted player pay?** No. A fee is only taken once a place is theirs. See [the waitlist](/help/registration/waitlist).

**Does a shared bill change where entry fees go?** No. Each organisation keeps its own Stripe account and payouts, even when someone else pays for its plan. See [one bill for several organisations](/help/billing/groups).
