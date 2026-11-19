---
title: What an AI Schedule run costs
description: How credits are charged for a run, what a credit buys, how to pick the number for a run, and the hourly limit.
order: 5.4
related: scheduling/ai-scheduling, scheduling/ai-instructions, scheduling/ai-several-divisions, billing/credits
---

AI Schedule needs no upgrade. It is available on every plan, Community included. Every run is paid for from your organisation's shared AI credit wallet. Generate, refine and repair are all metered the same way, and so is the officials pass. See [AI credits](/help/billing/credits) for the monthly grant, credit packs and how a billing group shares one wallet.

![The Run cost card in the AI Schedule console. It reads 15 fixtures, 2 courts and an estimated token count, with a picker for 1, 2 or 3 credits and a Recommended hint.](/help/scheduling/ai-run-cost.webp "The Run cost card: the size of the job, the credits picker with the recommended number, and the thinking budget that number buys.")

Community's monthly grant is {{plan:ai.credits.monthly:community}} credits and Pro's is {{plan:ai.credits.monthly:pro}}.

## See the cost first

The console shows a **Run cost** card before anything is spent. It gives the size of the job, for example **15 fixtures · 2 courts**, with an estimated token count. A picker offers **1**, **2** and **3** credits and marks the **Recommended** number. Checking your sentence is free. The button on the check card names the credits it will charge. Nothing is taken until you press it.

## Credits buy a thinking budget

A credit does not buy "a run". It buys the model a **thinking budget** for that run:

| Credits | Thinking budget for the whole run |
| --- | --- |
| 1 | up to 32K tokens |
| 2 | up to 64K tokens |
| 3 | up to 128K tokens |

The price is fixed when you confirm. A run that reaches the ceiling stops there rather than costing more. A run that fails with no usable timetable is not charged, and the credits return to your wallet.

## Choose the number

The picker starts on the number the size of the job suggests, and you can move it before you confirm.

- Moving it **down** costs less, but the run has a smaller budget. The card warns **Below the recommended credits. This run may stop before a full schedule.** You still see what it produced, checked as usual.
- Moving it **up** gives an awkward brief more room.
- If the card says **This run is very large. Split the division and schedule it in parts for a better result.**, more credits are not the answer.

## The hourly limit

Each division has a limit of 5 AI runs an hour for scheduling, and officials have a separate 5 an hour. A check of your sentence counts as one, and the run that follows that check does not count again. Over the limit, the console says **Too many runs just now — wait a moment and try again.**

> **Example**
> You write the sentence, select **Check what this means**, and read the card. That check counts as one of the 5 an hour. You press **Run with these rules** straight after. The run is not counted a second time, so five check-then-run rounds fit in an hour.

## When the wallet is empty

If the wallet runs out, the console says **You're out of AI credits for this billing period. Top up a credit pack or upgrade your plan to keep using AI Schedule.**
