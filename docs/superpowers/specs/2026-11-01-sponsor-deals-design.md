# Sponsor deals: sponsor first, then a package, then payment

- **Status:** design, 2026-11-01. The owner approved the direction ("yes"), the mockups ("perfect mockup") and option B ("B").
- **Mockups (layout only; the build uses the house theme):** `~/seazn-artifacts/2026-11-01_sponsor-deals-mockups_6472cb56/index.html` (served locally at http://127.0.0.1:8765/2026-11-01_sponsor-deals-mockups_6472cb56/index.html; the claude.ai artifact link is dead)
- **Depends on:** R4 PR A (`feat/r4-sponsors`). It provides the Sponsors hub at `/o/:slug/sponsors` (tabs Overview, Sponsors, On stream, Packages), `sponsors.on_stream`, `lib/sponsor-tiers.ts` and the sponsor report links. Build this programme only after PR A has merged.

## 1. Why

The owner: "most of the time, I confused that Sponsor adding and package".

Today the two are separate halves with no link between them:
- **Sponsors** (`components/org-sponsors.tsx`): add a name, logo, link, tier and competition.
- **Packages and orders** (`components/sponsor-packages.tsx`): create a priced package, then send a Stripe Checkout link to a sponsor whose name and email are typed in again.

On payment, `handleSponsorPaymentSucceeded` (`server/usecases/sponsors.ts:~616`) **inserts a new sponsor row** that has a name but no logo or link. A sponsor the club had already added therefore turns into a duplicate. The only connection between the two screens is `paid_order_id`.

There is also:
- no offline payment;
- no "mark as paid";
- no approval step;
- no real invoice. The "invoice" is an outbox email that carries a Checkout URL: no number and no PDF.

The owner's model, in their words: add the sponsor first "with link or image etc.", then "choose the package for that sponsor", pay by "invoice ... or offline payment", and go live "automatically ... if payment is successful or offline payment or manual approval". This should work for community orgs too.

## 2. Goals

1. **The sponsor exists first,** with name, logo and link, on every plan. Adding a sponsor sells nothing.
2. **A package is a price list entry:** name, price, currency, tier, scope (one competition, or the whole org), and what it includes.
3. **A deal links one sponsor to one package for one scope.** It is created from the sponsor.
4. **Payment method per deal:**
   - **Online invoice:** paid through the club's Stripe Connect account.
   - **Offline:** bank transfer or cash; the club marks it paid.
   - **Complimentary:** no payment.
5. **Go-live rule per deal:**
   - **When paid** (the default for online);
   - **Straight away;**
   - **After I approve.**
6. **Going live applies the package to that same sponsor:** tier, scope, public visibility, and on-stream if included. A refund, a lost dispute, the end date or "End now" switches it back off. There are never duplicate sponsor rows.
7. **Every deal has one visible status and a timeline.**

## 3. Non-goals

- A sponsor-facing self-serve shop, where a sponsor picks and buys a package without the club. Deals are created by the club.
- Recurring or instalment billing. One deal is one payment.
- VAT and tax handling beyond what Stripe already does on the connected account.
- Changes to how sponsors appear on stream or in reports. That stays R4.

## 4. Anti-goals: a failure even if it "works"

- A paid deal that creates a second sponsor row.
- A sponsor that goes public or on air without the club's chosen rule being met. For example, "After I approve" must not go live on payment alone.
- Money state and display state drifting apart: a refunded deal whose sponsor is still live, or a live sponsor whose deal is unpaid under a "When paid" rule.
- A community club blocked from recording a sponsorship it has already been paid for in cash.

## 5. The model

### 5.1 Entities

- **Sponsor** (existing table `sponsors`): name, url, logo_path, display_order, status, tier, competition_id, on_stream.
  - Before this programme, a sponsor's own tier, competition and status were edited directly.
  - After this programme, a sponsor **with a live deal** takes its tier, scope and visibility from that deal.
  - A sponsor **with no deal** shows as entered: its name, link and logo, as a plain Partner for the whole organisation. Its tier and scope are not edited by hand in any screen; a deal sets them, and a **complimentary** deal covers a favour such as a free Gold. The API still accepts both fields on a sponsor, unchanged. (owner, 2026-11-11: "A".) Sponsors that already hold another tier keep it, and the sponsor's page shows it read-only; this is a screen change, with no data move and no migration.
- **Package** (existing table `sponsor_packages`): add an `includes` set covering website board, slideshow and on stream. The existing price, currency, tier, competition and active fields stay.
- **Deal**: evolve `sponsor_orders`. The data-change rule applies: a loud migration, no silent re-meaning.
  - **Columns:** sponsor_id (required from creation), package_id, a snapshot of the scope and of the package's price/tier/includes at creation (a later package edit does not move an existing deal), payment_method (`online` | `offline` | `complimentary`), go_live (`on_payment` | `immediate` | `on_approval`), starts_at / ends_at (optional), status, an invoice number, and timestamps for each step.
  - The builder decides whether to rename the table or keep `sponsor_orders` with new columns. Existing paid orders must keep their dispute and refund history.

### 5.2 Deal status

Draft → Awaiting payment → Paid → (Awaiting approval) → Live → Ended.

| Case | Path |
|---|---|
| Online, when paid | Awaiting payment → (webhook) Paid → Live |
| Online, after approval | Awaiting payment → Paid → Awaiting approval → (Approve) Live |
| Online, straight away | Live at once, while payment is still awaited. The chip shows both: "Live · awaiting payment". |
| Offline | Same three rules, with "Mark as paid" replacing the webhook. |
| Complimentary | No payment states. "When paid" is not offered. |

Exits:
- **Refund** (online: a Stripe refund; offline: recorded only, no money moves) → Ended (refunded).
- **Dispute opened** → the sponsor is hidden until the dispute is resolved. This is today's "parks at pending" behaviour.
- **ends_at reached** or **End now** → Ended.

### 5.3 Applying a deal to its sponsor

When a deal becomes Live, these fields are set in the same transaction:
- the sponsor's `status=active`;
- `tier` and `competition_id` from the deal's snapshot;
- `on_stream` if the package includes it. The R4 tick rules apply, including creating the stream-settings row.

When it leaves Live, the sponsor goes `inactive`, unless another live deal for the same sponsor still covers it.

**The webhook stops inserting sponsors.** It moves the deal to Paid, and the go-live rule decides what happens next.

## 6. Screens (option B: the owner's choice)

Follow the mockups. In summary:

1. **Sponsors tab:**
   - "Add a sponsor" asks only for name, logo and link.
   - Rows sit in the existing tier groups. Each row shows a deal chip, the package and price, and one next action: Resend invoice, Approve, Mark as paid or Add deal.
   - On phones, the clicks count and the edit, move and delete actions move into a "⋯" menu.
2. **Sponsor page (option B):**
   - Tapping a sponsor opens its own page on phones, or a side sheet on desktop.
   - It has three sections: Details (name, logo, link, on stream), Deals (current and past, plus "Add deal"), and Report link (R4 S13 share links).
3. **Add deal sheet:**
   - package cards;
   - a scope select;
   - payment method as three radio cards;
   - go-live rule as three radio cards;
   - a summary line;
   - a primary button whose label follows the choice: "Send invoice", "Save deal" or "Save and go live".
4. **Packages tab:**
   - Packages become a price list. Each card shows its includes and "used by N sponsors".
   - The tab name changes from "Packages and orders" to "Packages".
5. **Deal page:** a timeline (created, invoice sent, paid, approved, live, ends), plus Mark as paid, Approve, Refund and End now, each only when it applies.

Copy goes in all 4 locales. Screens follow mobile-first at 320, 768 and 1280.

## 7. Invoices

- **Online:** a real invoice the sponsor can keep. It needs a number, the club's name and address, the line item and a paid/unpaid state. It reaches the sponsor by email with a pay link, through the club's Stripe Connect account as today (destination charge plus application fee).
  - The builder chooses between Stripe Invoicing on the connected account and Seazn's own numbered PDF plus Checkout. Record the choice and the reason. Stripe Invoicing carries its own fee.
- **Offline:** the same numbered invoice document, without a pay link. It shows the bank details the club enters once in settings.
- Invoice numbers run per org, in sequence, and are never reused.

## 8. Plans

**My call, for the owner to confirm (see §10):**

| Feature | Community | Paid plans |
|---|---|---|
| Sponsors, packages, offline deals, complimentary deals, approval rule | Yes. No money passes through Seazn. | Yes |
| Online invoices and payment | No. Shown but locked, with an upgrade hint. | Yes (`sponsors.monetize` plus Stripe Connect) |

Tiers on community stay governed by `sponsors.tiers` as today. Whether a community package can carry a tier is an owner question (§10).

## 8a. Rulings from the builder check (controller's calls, marked as such)

- **One live deal per sponsor (controller's call).** A `sponsors` row carries one tier and one scope, and R4's rendering, stream rotation and reports all read that row.
  - "Add deal" on a sponsor that already has a live deal creates a deal that **starts when the current one ends**. The sheet says so, and it also offers "End the current deal now" instead.
  - A guard enforces at most one Live deal per sponsor.
  - Two simultaneous placements for one sponsor (for example Gold org-wide plus Title on one cup) are out of scope. That case is rare.
- **What a live deal locks (controller's call).** While a deal is live, the sponsor's tier, scope and on-stream setting come from the deal and are read-only on the sponsor page; change them by ending the deal or adding a new one. Name, logo and link stay editable. Since the owner's 2026-11-11 ruling ("A", §5.1) the sponsor editor never offers the tier or the scope, live deal or not, so the live-deal lock now guards the on-stream box and the API (`sponsor_locked_by_deal`).
- **`includes` is "On stream" only (controller's call).** Every sponsor already appears on the website board and the slideshow; nothing gates those per sponsor. A package therefore has one include toggle, On stream, which maps to `sponsors.on_stream`. Remove "website board" and "slideshow" from the mockup's includes list, so no label promises something the system cannot withhold.
- **Package scope vs deal scope (controller's call).** A package is either "any competition" or one named competition. When a deal is made, the club picks the deal's scope within what the package allows: the whole org, or one competition.
  - `ends_at` is optional.
  - A deal scoped to one competition with no `ends_at` ends when that competition is finished (its derived phase), not on a stored copy of its date. Moving the competition's dates therefore moves the end with it.

- **Visibility before go-live (owner, 2026-11-01: "1 Ok").** A sponsor with no deal shows on the site as soon as it is added, exactly as today, as a plain Partner for the whole organisation (owner, 2026-11-11: "A"; §5.1). A sponsor whose only deal is waiting for payment or approval stays hidden until that deal goes live.
- **No backfill (owner, 2026-11-01: "No customer in prod for sponsor").** No real sponsor orders exist in prod, so the switch is clean: no backfill of old orders into deals. The migration is still loud (§5.1), and the dispute and refund columns stay.

## 9. Left to the builder

- Table naming and the migration shape (§5.1). Keep the history of existing orders.
- The invoice mechanism (§7).
- Where "bank details for offline invoices" lives in settings.
- Emails: invoice sent, payment received (to the club), deal live (to the sponsor, optional). Reuse the email outbox.
- How "Live · awaiting payment" reminders work, if any. Keep them minimal.

## 10. Owner answers (2026-11-07, "Ok" to the controller's recommendations)

1. **Community tier:** no. On the community plan every deal is Partner, until the club upgrades. Tiers stay gated by `sponsors.tiers` as today. (The plan isolates this in one task, so a later change is cheap.)
2. **Bank details for offline invoices:** a separate setting from the registrant payment instructions.
3. **After all of a sponsor's deals have ended:** the club may switch the sponsor back on by hand, as for a sponsor with no deal. Its tier and scope are not edited by hand either (a deal sets them; §5.1, owner 2026-11-11: "A").
