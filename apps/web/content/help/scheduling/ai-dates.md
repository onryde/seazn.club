---
title: The dates an AI plan covers
description: Where the planning window comes from, when your own sentence replaces it, and what happens to a match outside it.
order: 5.2
related: scheduling/ai-scheduling, scheduling/ai-instructions, scheduling/ai-review, scheduling/timezones
---

Every AI run plans inside a window of days. You can set the window in the division's settings, or write it into your sentence.

## Where the window comes from

The window starts from the division's **Start date & time** and **End date** on the **Settings** tab.

- With a start date and an end date, the window runs between them.
- With a start date and no end date, it runs seven days from the start date.
- With neither, it runs the next seven days, starting today in your organisation's timezone.

The window can widen but never narrows. It stretches to cover play hours you set by hand, and matches already on the board that the run may move. When you plan several divisions together, they share one window, wide enough for all of them.

A division with no start date starts its first draft at 08:00 on the window's first day, in your organisation's timezone. Your play hours still decide where matches may go.

All of this is worked out in one zone, your organisation's scheduling timezone. See [timezones](/help/scheduling/timezones).

## When your sentence sets the dates

Dates you write into the instruction replace the worked-out window. Use words the product can place on the calendar, such as "tomorrow" or "Friday". The card from **Check what this means** shows the result under **Window**, as the first day, the last day and the timezone.

One case widens the range. If you cap the whole run at some matches a day and the days you wrote cannot hold every match at that cap, the card moves the end date out by 7 days, once, and says so under **Assumed**. It does not check that the wider range is enough. A cap for each player or each team never widens the range.

> **Example**
> It is Thursday 19 November. You type: "From tomorrow till Friday. At most 3 matches a day." The sentence reads as 20 November to 20 November. A six-player league has 15 matches, and one day at 3 a day holds only 3 of them. The card widens the end to the following week. **Window** shows **2026-11-20 → 2026-11-27 · UTC**, and the reason is listed under **Assumed**.
>
> You type: "Run for 3 days starting tomorrow." **Window** shows **2026-11-20 → 2026-11-22 · UTC**.

A range written as day and month, such as "from 7 December until 9 December", did not read as a window and landed under **Couldn't use**. A range for one division only is not supported either: state the dates for the whole run.

## A match outside the window

A match the proposal places outside the window counts as blocking. It shows in the **blocking** count, and the console says **Untick a blocker to set it aside for the tray — the rest can still apply.** See [reviewing a proposal](/help/scheduling/ai-review).

Usually it means the end date is earlier than your competition really runs. Fix the dates in **Settings** rather than arguing with the proposal.
