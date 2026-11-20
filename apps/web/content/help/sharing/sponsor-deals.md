---
title: Sponsor deals
description: Add a deal to a sponsor, choose how it is paid and when it goes live, and follow it through payment, approval, end and refund.
order: 6.2
related: sharing/sponsors, sharing/sponsors-packages, sharing/sponsor-invoices, billing/plans
---

A deal puts a sponsor on your pages. It ties a sponsor to a [package](/help/sharing/sponsors-packages) and says how it is paid, when it goes live and when it ends. Only a live deal sets the sponsor's tier on your public pages.

![A deal's own page with a timeline reading Created, Invoice sent, Paid and Live, and buttons for Refund and End now.](/help/sharing/sponsor-deal.webp "A live deal that was paid offline, with its timeline.")

## Add a deal

Open the sponsor on the **Sponsors** tab and select **Add deal**. **Add deal for Quay Tyres** opens and asks for:

- **Package.** Pick one from your price list. With none yet, the sheet reads **No packages on sale yet** and links to **Go to Packages**.
- **Competition or season.** **Whole organisation** is the default. A package made for one competition fixes this to that competition. A deal for one competition ends when the competition finishes.
- **Ends on (optional).** Leave it empty to run until you end it.
- **Payment.** **Online invoice**, **Offline** or **Complimentary**. See below.
- **Send invoice to.** The sponsor's email, for an online invoice. An offline deal asks for **Sponsor's email (optional)**.
- **Goes live.** **When paid**, **Straight away** or **After I approve**.

A sentence under **What will happen** repeats your choices in plain words before you save. Select **Save deal**, or **Save and go live** when it goes live straight away. For an **Online invoice** the button reads **Send invoice** and emails it. If Stripe does not answer, the deal is still saved and **Send invoice** tries again.

### Payment

- **Online invoice.** Seazn Club emails an invoice with a pay link. The money goes to your Stripe account. Connect Stripe first. It needs a paid plan, or an Event Pass for the competition.
- **Offline.** You take the money by bank transfer or cash and select **Mark as paid** yourself.
- **Complimentary.** No payment. Anyone can use it, on every plan.

### Goes live

- **When paid.** The deal goes live as soon as the invoice is paid, or when you mark it paid.
- **Straight away.** The deal goes live when you save, before any payment arrives.
- **After I approve.** The deal waits until you select **Approve**. On an unpaid deal it waits for payment first.

A sponsor already live under another deal gets the new one as **Scheduled**. It starts when the current deal ends. **End the current deal now instead** swaps them straight away.

If the sponsor already has a deal for this package that has not gone live yet, saving asks **Send a second invoice?** for an online deal and **Add a second deal?** for an offline one. While money is still due, the first link stays payable, so the sponsor could pay twice.

## Follow a deal

Each deal has its own page. Open it with **Open deal**. Its **Timeline** lists **Created**, **Invoice sent**, **Paid**, **Live** and **Ended**, with the date of each and a note on what is next. The chips on a sponsor's row read **Draft**, **Awaiting payment**, **Paid**, **Scheduled**, **Awaiting approval**, **Live** and **Ended**. A live deal that is unpaid reads **Live · awaiting payment**, **Live · on hold** when paused, and **Ended · unpaid** when money is still due. **Write off** clears what is still due.

An offline deal that goes live **When paid** makes its invoice the moment you save it, but nothing is emailed. Select **Send invoice** to email it. **Resend invoice** sends it again.

1. Select **Mark as paid** when the money arrives. The page asks **Record £250 from Ridge Physio as received?** Confirm it.
2. The timeline reads **£250 recorded as received**, and the deal follows its go-live rule: **Live**, **Scheduled** or **Awaiting approval**.
3. A deal set to **After I approve** shows **Awaiting approval** and an **Approve** button. Select **Approve** and the deal goes live.

### End a deal

Select **End now** on a deal, then **End deal**. A live deal's tier, public page and stream switch off at once, and any payment link it sent stops working. A deal queued behind it takes over if its end date has not passed. An unpaid offline deal that you end has its invoice read **Cancelled**, and nothing is due. The sponsor then comes off your public pages. **Show on site again** on its page puts it back.

Ending a paid deal does not refund the payment. It stays with your club.

### Refund a deal

Select **Refund** on a paid deal. The page reads **Refund this deal?** and states the amount. A deal you marked paid by hand moves no money through Stripe, so you pay the sponsor back yourself. A deal paid by card goes back to the card and your payout is reversed. The deal ends now, and the sponsor leaves your public pages unless another deal is queued. A refund cannot be undone. The timeline then reads **Ended** with **Refunded**, and the invoice reads **Refunded**.

## Who can do this

Owners and admins add and change deals. A Viewer sees the sponsors and their chips and has no edit controls.

> **Example**
> **Ridge Physio** takes a Partner package at 250 in GBP, paid by bank transfer. You choose **Offline**, **Send invoice to** an email address and **Goes live** **When paid**. You select **Save deal**. The row reads **Awaiting payment** and the invoice has the number SP-0001. You select **Send invoice**. The transfer arrives and you select **Mark as paid**, then confirm. The timeline reads **Created**, **Invoice sent**, **Paid** and **Live**, and Ridge Physio appears in the Partners line. The club later agrees a refund. You select **Refund**, confirm, and pay the 250 back yourself. The timeline ends with **Refunded**, and the name leaves your pages.
