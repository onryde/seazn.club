---
title: AI credits
description: AI scheduling and AI officials spend AI credits from your organisation's wallet. Each month brings a grant that does not roll over; packs you buy never expire.
order: 5
related: scheduling/ai-credits, billing/match-credits, billing/plans, billing/groups
---

AI scheduling and AI officials spend **AI credits**. They work on every plan. Your plan decides how many credits arrive each month, and you can buy packs on top.

## Open your AI wallet

1. Open **Settings** and choose **Credits**. The page opens on **Streaming**, which holds match credits (see [match credits](/help/billing/match-credits)).
2. Choose **AI** at the top. The **Manage AI credits** link on **Plan & Billing** opens this side straight away.

You see:

- **Balance**: every AI credit the organisation can spend now.
- **This month's grant**: how much of this month's grant is used, how many days until it resets, and how many are left.
- **Packs**: credits you bought, marked *never expire*.
- **Auto-topup**: marked **Coming soon**. Nothing tops up on its own yet.
- **Run history**: every grant, pack and AI run, newest first, with the change in credits. **Export** downloads it as a spreadsheet file.

![The AI side of the Credits page: the balance, the month's grant meter with the days until it resets, packs marked never expire, the Buy credits button and the run history with one monthly grant.](/help/billing/credits-ai.webp "A Community organisation right after its monthly grant arrived. The meter counts up as AI runs spend the grant.")

## The monthly grant

Each calendar month your organisation gets a grant of AI credits:

| Plan | AI credits a month |
| --- | --- |
| Community | {{plan:ai.credits.monthly:community}} |
| Pro | {{plan:ai.credits.monthly:pro}} for each organisation the subscription pays for |
| Enterprise | {{plan:ai.credits.monthly:enterprise}} |

The grant does not roll over. A new grant arrives at the start of each calendar month, counted in UTC, and any grant credits left from the month before are removed then.

An Event Pass adds a one-time top-up of AI credits when it is bought. Those credits go with your packs and never expire. The size of the top-up is on the [pricing page](/pricing).

If your plan stops being paid for, for example after a failed renewal runs out its grace period, the grant drops to the Community amount until the plan is back in good standing.

## Which credits a run spends

A run costs 1, 2 or 3 credits, and the credits buy the model a thinking budget: 1 credit → up to 32K tokens, 2 → 64K, 3 → 128K. You choose the number before the run starts.

An AI run spends this month's grant first. It touches your packs only when the grant is used up, so a pack is never spent while free credits remain.

If a run fails before it gives you anything to use, you are not charged: the credits come back and the run history shows them returning. [What an AI Schedule run costs](/help/scheduling/ai-credits) explains how a run is priced before you start it.

## Buy a pack

1. On the AI side, choose **Buy credits**.
2. Pick a pack. Bigger packs carry a bonus, shown as a percentage, and the biggest is marked **Best value**.
3. Pay. The credits land in your wallet once the payment clears.

Packs are priced in your billing currency. Your first purchase of any kind fixes that currency for the organisation.

## Shared across a billing group

When one subscription pays for several organisations, they share one AI wallet. Each of them sees the same balance on its own Credits page, with the note **Shared across 2 organisations in this billing group.** (the number is however many share it). Any of them can spend from it, and the run history names the organisation behind each run.

When an organisation joins a group, the AI credits it already held move into the shared wallet, grant credits as grant credits and pack credits as pack credits. When an organisation leaves a group that others stay on, the wallet stays with them and the leaving organisation starts with an empty one. The last organisation to leave takes the balance with it. See [billing groups](/help/billing/groups).

> **Example**
> Riverside Racquets is on Pro, and its subscription pays for two organisations: Riverside itself and Hillside Badminton. The grant is {{plan:ai.credits.monthly:pro}} credits for each, so the meter starts the month at twice that. Hillside's owner opens Hillside's own Credits page and sees the same meter, the same balance and the note **Shared across 2 organisations in this billing group.** A run started from either organisation spends from that one wallet.
