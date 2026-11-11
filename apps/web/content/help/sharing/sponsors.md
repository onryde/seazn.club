---
title: Sponsors
description: Tiered sponsor logos on your public pages — and the packages and deals that put a sponsor on them.
order: 6
---

Sponsor logos appear on your public competition pages, the registration page and the venue slideshow. Every plan can run a sponsor strip, keep a price list of packages and record a sponsorship deal; **tiers above Partner, per-competition placement and online invoices need Pro — or an [Event Pass](/help/billing/event-pass) on the competition you're selling around**.

## Add sponsors

Open **Sponsors** in the top bar or on your Dashboard, then the **Sponsors** tab. The hub's other tabs, including sponsors on your streams and the reports you can send a sponsor, are covered in [The Sponsors hub](/help/sharing/sponsors-hub). Add a name, an optional link and a logo (PNG/JPG/WebP up to 2 MB). Use the arrows to set the display order — that order is what the public sees. The sponsor's name, link and logo are all you edit on the sponsor itself: its tier and where it shows come from its deals (see Deals below), and its page shows them read-only.

## Tiers (Pro or Event Pass)

Pro orgs — and any competition holding an Event Pass — group sponsors into **Title, Gold, Silver and Partner** tiers. A sponsor's tier comes from its deal's package — there is no tier box on the sponsor. On public pages the title sponsor renders largest, then each tier in descending prominence. On the free plan every sponsor sits in one flat strip.

On the **Sponsors** tab each row names its deal's tier beside the package (on the free plan, only a tier above Partner), and a sponsor whose waiting deal will move it to another tier carries a note such as **Gold when live**: it stays in its current group until that deal goes live.

## Per-competition sponsors (Pro or Event Pass)

By default a sponsor is org-wide — it shows on every competition. To scope a sponsor to one event, give it a deal for that competition: the deal's scope is where the sponsor shows. Competition-scoped sponsors lead the strip on their event's pages.

## Click tracking

Public sponsor logos link through a tracked redirect, so the click count in the manager shows each sponsor the traffic you sent them. Use it as proof of delivery when you renew a deal.

## Packages: your price list

A **package** is a price on your list: a name, a price, a tier, where it applies (the whole organisation or one competition) and whether it includes your stream. Open **Sponsors → Packages** to create one or retire one. Packages are on every plan; a tier above Partner, or a package for one competition, needs Pro or an Event Pass.

Each package shows how many sponsors hold a deal on it. **Retire** stops new deals using a package. Deals already on it carry on, and past deals keep its name and price.

Under the price list, **What each tier gets** explains the four tiers in plain words: the Title sponsor is named under the competition name, Gold gets a large logo panel on the sponsor board and Silver a smaller one, and a Partner is listed by name in the Partners line. It also shows how many turns each tier takes in the stream rotation. It is there on every plan. On a plan without tiers it also says what that plan's own pages do (every sponsor in one strip, one turn each in the stream rotation, except on a competition with an Event Pass) and what to upgrade for, with a link to billing for an editor. On a phone the section folds under its heading, and it starts open while the list has no packages yet.

## Deals: putting a sponsor on a package

A **deal** is one sponsor on one package. Open a sponsor on the **Sponsors** tab and choose **Add deal**, then pick the package, how it is paid and when the sponsor goes live. A sponsor's tier and where it shows come only from its deals, never from the sponsor's own editor. A new sponsor with no deal shows as a Partner for the whole organisation (sponsors you added before keep the tier they hold), and one you want to show higher for free gets a **Complimentary** deal on the package you choose. While a deal is live it also sets the sponsor's On stream setting, so that is locked on the sponsor too.

**How it is paid**

- **Online invoice** (Pro, or an Event Pass on that competition). We email the sponsor a numbered invoice with a **Pay by card** button. Money settles to your connected account, and the platform keeps the same fee as entry fees ([the rate for your plan](/help/billing/plans#the-platform-fee-on-entry-fees)). You need **Get paid (Stripe Connect)** set up, the same onboarding used for card entry fees.
- **Offline.** Bank transfer or cash. The deal has a numbered invoice too, with your bank details on it. You mark the deal paid when the money arrives.
- **Complimentary.** No payment.

**When the sponsor goes live**

- **When paid.** As soon as an online invoice is paid, or when you mark an offline deal paid.
- **Straight away.** Before payment arrives, or when you save a complimentary deal.
- **After I approve.** The deal waits until you press **Approve**.

Each deal has its own page: a timeline of what has happened and what comes next, and only the buttons that apply right now. **End now** ends the deal at once; when a sponsor's last deal ends, it comes off your public pages until you choose **Show on site again** on its page. **Refund** on a deal paid by card sends the money back through Stripe; on an offline deal it records the refund and you pay the sponsor back yourself.

A sponsor who is already live under one deal can be given a second. The new deal waits for the first to end, unless you end the first one from the same sheet.

## Invoices

Every online and offline deal has an invoice; a complimentary deal has none. Invoices work on every plan: a club on the free plan can record a sponsor's cash payment and give them an invoice for it.

**Numbering.** Invoice numbers run per organisation, starting at **SP-0001**: the next deal takes the next number, and a number is never reused, even when the deal ends. The number is on the invoice and its PDF, and it is the reference an offline sponsor puts on their transfer.

**Where the details live.** Open **Settings → Payments** and fill in **Sponsor invoices**: the address printed under your club's name, and the bank details printed on offline invoices. They are not the same as the offline payment instructions you write for players on the registration page, which are worded for entrants and never appear on a sponsor invoice. An invoice picks up the details as they are when the sponsor opens it, so a change shows on invoices already sent. Only owners and admins can change them.

**What the sponsor gets.** An email with a link to the invoice page. It needs no login. It shows who it is from and to, what the sponsor gets (tier, competitions, whether they are on your stream), the total, and a stamp that reads **Unpaid**, **Paid**, **Refunded**, **Cancelled**, **Written off** or **Ended**. **Download PDF** gives the same invoice as a file, and **Print** prints the page. The invoice is written in your organisation's language.

- **Pay by card (online invoices).** **Pay by card** opens Stripe's secure payment page. When the payment lands the invoice reads **Paid**, the deal goes live by its go-live rule, and we email the organisation's owner that the sponsor paid, once per payment. If a sponsor taps the button a second time on a paid invoice, nothing is charged: they are sent back to the invoice, which reads Paid. If your club can no longer take cards (Stripe disconnected, or the plan changed), the button is replaced by a note to contact you.
- **Bank transfer (offline invoices).** There is no pay button. The invoice shows your bank details and asks for its number as the payment reference. Save your bank details first: without them an offline invoice shows none. When the money arrives, press **Mark as paid** on the deal and the invoice reads **Paid**. An offline invoice is only emailed when the deal has a billing email; without one you tell the sponsor yourself.

**Send and resend.** An online invoice is emailed when you add the deal. Press **Resend invoice** on a deal to email it again; for an offline deal with a billing email that is also how its first invoice goes out. Each send makes a new link and **stops the earlier one**: a sponsor who opens an old link sees "This invoice link doesn't open anything" and should use the newest email. After sending, the deal shows the invoice link so you can copy it into your own message; it is the same link the email carries, never a Stripe payment link. To protect your sender reputation an organisation can send up to 50 sponsor invoice emails in 24 hours.

**When a deal ends before it is paid.** If you end a deal yourself before it is paid, the invoice reads **Cancelled** and nothing is due. A deal that ends unpaid on its own, because its end date passed or its competition finished, depends on how it is paid. An **online** invoice reads **Ended**: its pay link is gone, and the sponsor is told to contact you about anything still owed. An **offline** deal that had already gone live is still owed: its invoice stays **Unpaid**, with a note that the sponsorship has ended and the invoice is still due, and its row on the **Sponsors** tab reads **Ended · unpaid** and offers **Mark as paid**. Marking it paid leaves the deal ended and the invoice reads Paid. If you will not collect it, open the sponsor and choose **Write off** (it asks first, and it is final): the invoice then reads **Written off**, with "Nothing due".

## Common questions

**Where do the logos appear?** The public competition page footer, the registration masthead and the slideshow strip.

**My old sponsors are still there?** Existing sponsor lists were migrated automatically as Partner-tier entries — nothing was lost.

**A sponsor says their invoice link doesn't open?** You have sent a newer one since: every resend replaces the earlier link. Ask them to use your latest email, or copy the link from the deal after you press **Resend invoice** and send it yourself.

**Where do I change the bank details on an invoice?** **Settings → Payments → Sponsor invoices**. See Invoices above.

**A sponsor paid but isn't showing?** Open the sponsor's deal: its page shows whether the payment has arrived. An online payment is confirmed by Stripe (usually seconds). If the deal goes live only after you approve it, press **Approve**. Contact support if a paid deal stays pending.
