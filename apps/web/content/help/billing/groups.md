---
title: One bill for several organisations
description: A billing group is one plan, one card and one invoice for several organisations. What each extra organisation costs, who pays, and what every organisation keeps for itself.
order: 4
related: billing/add-an-organisation, billing/remove-an-organisation, billing/hand-over-a-bill, billing/operator
---

A subscription is not tied to one organisation. It is a **billing group**: one plan, one card and one invoice for every organisation on it. A county association, for example, can pay for its member clubs. The person who pays does not have to be a member of the organisations they pay for.

The person who pays sees the bill under **Settings → Plan & Billing**, in **Organisations on this bill**. It counts the organisations on the bill and the seats paid for, and says how many the plan has room for. From there you [add an organisation](/help/billing/add-an-organisation), [take one off](/help/billing/remove-an-organisation) or [hand the bill to someone else](/help/billing/hand-over-a-bill).

![The Organisations on this bill panel, with three organisations on a Pro bill](/help/billing/groups-panel.webp "The payer's view of a bill with three organisations on it, each with Remove from this bill")

## What it costs

The first organisation pays the plan's normal rate. Each organisation after it costs no more than half the base rate, on the same card and invoice. The plan prices in your currency are on the [pricing page](/pricing), and when you add an organisation to a paid bill, the dialog says what your bill goes up by before you confirm.

Pro has room for {{plan:orgs.max_owned:pro}} organisations on one bill, and Enterprise has no limit. Community covers {{plan:orgs.max_owned:community}}. When a Pro bill is full, you can buy an extra organisation under **Settings → Add-ons**. See [add-ons](/help/billing/add-ons).

## Every organisation runs on the bill's plan

An organisation on the bill gets the bill's plan: its limits, features and platform fee on card entry fees.

| The group's plan | Platform fee on entries |
| --- | --- |
| Community | {{plan:registration.fee_percent:community}}% |
| Pro | {{plan:registration.fee_percent:pro}}% |
| Enterprise | {{plan:registration.fee_percent:enterprise}}% |

The limits are per organisation, not shared. Three organisations on a Pro bill each get Pro's limits. Team members are per organisation too, so someone who helps run two of them is invited to each. See [inviting your team](/help/getting-started/invite-your-team).

## The entry-fee rate locks when sales start

A competition's platform fee is fixed when it takes its first paid card entry. Every later entry in that competition pays the same rate, whatever happens to the plan afterwards. Moving onto a bill, coming off one, or a change of plan never re-rates a competition whose entrants have started paying.

Until the first card payment, the rate follows the plan. Free entries and entries paid to the organiser do not lock anything.

> **Example**
> Harbour County Association pays for a Pro bill and moves Westbrook Badminton onto it. Westbrook's spring open took its first card payment while Westbrook was on Community, so the open keeps the Community rate. Westbrook's summer league has not taken a payment yet, so it moves to the Pro rate.

## Who pays

A bill has one payer, with one card and one invoice. The payer manages the plan, the card and cancellation for every organisation on it.

The payer can open **Plan & Billing**, **Credits** and **Add-ons** on every organisation on the bill, even one they are not a member of. The rest of that organisation stays closed to them.

The owner of an organisation on someone else's bill sees who pays on its **Plan & Billing** page: "This organisation is covered by {payer}'s subscription — they pay for it, and the plan above applies here in full." The page has no card or plan controls for them.

An organisation on a bill cannot pay for itself or pay a share. For a bill of its own, it has to come off this one first. Two clubs that need separate invoices need separate bills.

## Payouts never move

Card entry fees are per organisation, and a bill never touches them. Each organisation keeps its own Stripe account, bank details and payouts, and its entry fees go to its own account, not the payer's. See [how card entry fees flow](/help/registration/card-payments).

## Common questions

**Do the organisations share AI credits?** Yes. Everyone on the bill spends from one AI wallet. See [AI credits](/help/billing/credits). The payer can give each organisation a monthly cap in the [operator console](/help/billing/operator).

**What currency is the bill in?** One currency, set at the bill's first checkout. Organisations added later are billed in it. The currency an organisation charges entry fees in is its own setting, under **Settings**.

**Does an Event Pass count toward the subscription?** Once per billing group, ever. It counts when the organisation that starts the Pro checkout bought its most recent pass in the 30 days before. A pass that another organisation on the bill holds earns nothing. See [start, switch or cancel Pro](/help/billing/change-plan).

**Every organisation on our bill is suspended by your team. What happens?** Suspension is a moderation step, not a billing one, and you keep paying for the bill. While every organisation on the bill is suspended, the number of organisations the bill can hold falls to what its plan covers plus the extra organisations you have bought, which still count. A limit our team raised for one organisation does not apply until that organisation is back. If the bill is already at that limit, it cannot take another organisation until one is back.

**What if the payer deletes their account?** The bill passes to the longest-standing owner of an organisation on it. If nobody can take it over, the subscription is cancelled.
