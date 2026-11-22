---
title: Refunds and disputes
description: When a card entry fee is refunded by itself, how to refund one yourself after the refund lock, and what happens when a player disputes a payment with their bank.
order: 3.5
related: registration/card-payments, registration/registrants, entrants/withdrawals
---

This page is about entry fees paid by card at sign-up. For how the money reaches you, see [how card entry fees flow](/help/registration/card-payments).

## Refunds

When a player withdraws a paid card entry before the **Refund lock** date, the refund is automatic and in full. The money goes back to their card, the platform fee is returned with it, and they receive a receipt email. The player withdraws with **Cancel this entry** on their registration page.

Set the **Refund lock** in the division's settings, under **Money**. It appears when the division charges by card. After that moment a withdrawal keeps the fee, and refunds become your call.

![The Money section of a card division with a refund lock set](/help/registration/refund-lock.webp "A division that takes card payment at sign-up, with its refund lock set to 25 May at 12:00")

With no **Refund lock** set, withdrawals refund in full until the competition's start date. If the competition has no start date either, nothing refunds by itself.

After the lock, open the entry on the **Registrants** tab and press **Refund**. The entry keeps its place. **Withdraw** frees the place and applies the same lock rule.

A solo sign-up with no team by its **Place-by date** is also withdrawn and refunded. See [allow solo sign-ups](/help/registration/open-registration#allow-solo-sign-ups).

> **Example**
> A division charges a card fee and its **Refund lock** is 1 June. A player withdraws on 28 May and is refunded in full to their card. Another withdraws on 3 June. Their fee is kept. You decide to refund them anyway, so you open their entry and press **Refund**.

## Disputes

A cardholder can dispute a payment with their bank. When Stripe tells Seazn Club, the entry's payment shows **Disputed**, and an alert email goes to your organisation's owner. The email asks you to check the entry and gather anything that shows the registration was genuine, such as the confirmation email or check-in records. Nothing happens to the entrant automatically. Whether they stay in the competition is your call.

The **Registrants** tab has no place to upload evidence or reply to a dispute, and the alert email does not say who replies to Stripe.

- **You win the dispute.** The flag clears and the money stays with you.
- **You lose the dispute.** Stripe repays the cardholder, and the entry records the amount as refunded. The net amount you received for that payment is taken back from your Stripe balance. If your balance cannot cover it, the email says Stripe takes it from your upcoming payouts. Seazn Club covers Stripe's dispute fee. You get an email that says what moved. If the amount could not be taken back automatically, the email says the Seazn Club team will follow up.

When you connect Stripe, you agree that your organisation bears the cost of chargebacks on its entry fees: lost disputes are recovered from your Stripe balance.
