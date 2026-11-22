---
title: Plans at a glance
description: Community is free. An Event Pass lifts one competition while it runs. Pro lifts every competition in your organisation, and Enterprise is for federations and platforms.
order: 1
related: billing/change-plan, billing/event-pass, billing/downgrade, billing/groups
---

Every plan runs the same product. Scoring, scheduling, remote scoring from any phone, Match Day and live streaming from a phone work on all of them, Community included. A plan sets your limits and adds features on top. Prices are on the [pricing page](/pricing), in your currency.

## See your plan

Open **Settings** and choose **Plan & Billing**.

- **Current plan** names your plan and its status.
- **Usage** counts your active competitions, public dashboards and team members against your plan's limits. ∞ means there is no limit.
- On Community, the person who pays for the organisation also sees **Upgrade to Pro**, with the two plans side by side.

![The Upgrade to Pro section on Plan & Billing: a Community card with ticks for what it includes and crosses for branded exports, theme colour and the realtime scoreboard, a Pro card listing what it adds, and the Start free trial button.](/help/billing/plans-upgrade.webp "What a Community organisation's payer sees on Plan & Billing.")

## The limits

| | Community | Pro | Enterprise |
| --- | --- | --- | --- |
| Active competitions | {{plan:competitions.max_active:community}} | No limit | No limit |
| Divisions in a competition | {{plan:divisions.per_competition.max:community}} | {{plan:divisions.per_competition.max:pro}} | No limit |
| Entrants per division | {{plan:entrants.per_division.max:community}} | {{plan:entrants.per_division.max:pro}} | No limit |
| Team members | {{plan:members.max:community}} | {{plan:members.max:pro}} | No limit |
| Public dashboards | {{plan:dashboard.public.max:community}} | {{plan:dashboard.public.max:pro}} | No limit |
| Organisations on one bill | {{plan:orgs.max_owned:community}} | {{plan:orgs.max_owned:pro}} | No limit |
| AI credits a month | {{plan:ai.credits.monthly:community}} | {{plan:ai.credits.monthly:pro}} | {{plan:ai.credits.monthly:enterprise}} |
| Free match credits a month | {{plan:streaming.credits.monthly:community}} | {{plan:streaming.credits.monthly:pro}} | {{plan:streaming.credits.monthly:enterprise}} |

A competition stops counting as active once you mark it completed or archive it. A competition covered by an [Event Pass](/help/billing/event-pass) does not count either, while the pass applies.

When you reach a limit, the thing that would go over it is refused. Nothing you already have is removed.

## Community

Community is free, with no card. You can run real competitions on it, take entry fees by card or offline, put your logo on your public pages and export plain PDF and spreadsheet files.

## Event Pass

An Event Pass is a one-time payment that lifts **one competition** while it runs. It raises that competition to {{plan:divisions.per_competition.max:event_pass}} divisions of {{plan:entrants.per_division.max:event_pass}} entrants and adds most of Pro's features to it. There is no subscription. See [the Event Pass](/help/billing/event-pass).

## Pro

Pro lifts every competition in your organisation and adds:

- your brand colour on public pages and the slideshow
- branded PDF and spreadsheet exports, and public player profiles
- the realtime scoreboard and slideshow
- advanced formats, such as ladders and americano
- sponsor tiers and online sponsor invoices
- automatic officials assignment, automatic suspension tracking and auto-drafted result posts
- career stats across competitions, embeds and read-only API keys

Pro starts with a 14-day free trial. See [start, switch or cancel Pro](/help/billing/change-plan).

## Enterprise

Enterprise is everything in Pro with no limits on size, plus an API key that can write, and no "Powered by Seazn Club" badge on your public pages. It is not sold on the pricing page. The page has a **Talk to us** link below the plans instead.

## The platform fee on entry fees

Taking entry fees is free on every plan. What your plan changes is the fee we keep from each entry paid by card:

| Plan | Platform fee |
| --- | --- |
| Community | {{plan:registration.fee_percent:community}}% |
| Event Pass, on its competition | {{plan:registration.fee_percent:event_pass}}% |
| Pro | {{plan:registration.fee_percent:pro}}% |
| Enterprise | {{plan:registration.fee_percent:enterprise}}% |

Stripe's own card processing fee is separate. Once a competition takes its first paid entry, its rate is locked for that competition. See [the entry-fee rate locks when sales start](/help/billing/groups#the-entry-fee-rate-locks-when-sales-start) and [how card entry fees flow](/help/registration/card-payments).

> **Example**
> Riverside Racquets is on Community and runs Autumn Open and Club Championship. **Usage** shows **Active competitions 2 / {{plan:competitions.max_active:community}}**. They buy an Event Pass for Autumn Open, and the count drops to 1, because a competition with a pass does not count. They can now create two more competitions. Creating one more after that is refused until they finish or archive one.
