---
title: AI Officials
description: Draft a duty spread for the whole timetable from the AI Schedule console, steer it with a sentence, and apply it with the schedule.
order: 9
related: scheduling/ai-scheduling, scheduling/ai-review, scheduling/ai-credits, scheduling/officials-assign
---

**AI Officials** is the third step of the AI Schedule console. Once the times are proposed, it puts an official on each match. It only proposes. Nothing is written until you apply. You can draft and review on every plan. Saving the officials when you apply needs Pro, an Enterprise plan or an [Event Pass](/help/billing/event-pass), the same as **Propose** on the [Officials tab](/help/scheduling/officials-assign).

![The Officials step of the AI Schedule console after a default draft. The summary says Draft duty spread from the solver, no AI tokens used. Role coverage reads 6 of 6, and each of the six matches lists its court, time and referee. Two of them carry a flag.](/help/scheduling/ai-officials.webp "The Officials step after a draft: role coverage, a referee on each of six matches, and two flagged assignments.")

## Open the step

Run the [schedule pass](/help/scheduling/ai-scheduling) first. When the proposal is ready, select **Assign officials**, or **Skip to apply** to leave it. The step works over the times you just proposed, even though they are not applied yet. It uses the officials in your [organisation's pool](/help/scheduling/officials).

## Draft the duty spread

Select **Draft the duty spread**. **The first pass runs on the solver, without the AI model — a flat 1 credit.** There is nothing to pick. The summary reads **Draft duty spread from the solver — no AI tokens used.**

The result shows **Role coverage**, such as **6/6** and **Fully covered**, then each match with its court, time, official and role.

The draft does not avoid an official's blackout dates. It can place an official on a day they marked off. When it does, the console flags each one with a line that names the official and the blackout date, counts them as blocking, and says **2 blocking — left for manual assignment**.

## Steer it with a sentence

Type in **Adjust the officials plan**, or add a wish: **Senior refs on finals**, **Spread duties evenly** or **Official only when**. The button then reads **Re-plan officials**. This run uses the AI model. It took about 40 seconds on a six-match league.

The result lists any match it could not staff as **Unfilled**, and **Role coverage** shows the gap, for example **5/6** and **1 unfilled**. In the example below, the match left without an official stayed unfilled.

> **Example**
> A four-team league has six matches on two courts, three rounds at 08:00, 09:00 and 10:00. Ola Brandt has marked that day off. **Draft the duty spread** gives all six matches a referee. It puts Ola on two of them, and flags both: **2 blocking — left for manual assignment**. You then write "Put Marta Quinn on every match she can, and keep Sven Ito off the last round." and select **Re-plan officials**. The summary says it assigned Marta to three matches, one in each round, and kept Sven off the 10:00 round. It says Ola is unavailable. **Role coverage** reads **5/6** with **1 unfilled**, the 10:00 match on Court 1.

## What a run costs

An instructed run takes credits from your organisation's shared wallet, the same as the schedule pass, and the first pass is the 1 credit above. The Run cost card shows the size of the job, such as **6 fixtures · 2 courts**, with an estimate of tokens. It has a picker for **1**, **2** or **3** credits with **Recommended 1**, and reads **Credits buy a thinking budget — up to 32K tokens for this run.** Pick the number before you run. See [what a run costs](/help/scheduling/ai-credits) for how the thinking budget works, and [AI credits](/help/billing/credits) for the monthly grant and credit packs.

Officials runs have their own limit of 5 an hour for each division, apart from the limit on the schedule pass.

## Review and apply

Select **Review & apply**. The step reads **Apply the proposal to the board.**, for example **6 fixtures placed on the board** and **Officials assigned to 6 matches**, and says **A restore point is saved first, so you can undo in one tap.** Choose **Apply schedule + officials**, **Apply schedule only** or **Discard**.

On Pro, the console then says **Applied. The board is updated.** and **Officials were assigned too.** The officials are saved as pending, so each one still accepts or declines. Only the matches that got an official are saved: in the example, that is five.

On Community, the schedule applies, then the console says **Schedule applied, but the officials couldn't be saved — assign them again.** No officials are saved. Assign them yourself on the Officials tab, which is free on every plan.

## What is sent

The draft sends nothing to an AI provider. A run with your own sentence sends the brief to one of our AI providers, Anthropic (Claude), Google (Gemini) or xAI (Grok), only to produce the proposal. They do not use your data to train their models, and requests routed through a gateway also carry zero-data-retention terms. The providers are listed on the [sub-processors page](/legal/sub-processors).
