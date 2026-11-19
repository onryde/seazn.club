---
title: The schedule board
description: Place matches on courts and times by hand, run Auto-schedule and its two follow-up passes, and see what the board refuses.
order: 1
related: scheduling/locks, scheduling/undo, scheduling/constraints, scheduling/ai-scheduling
---

The schedule board is where matches meet the clock. Open it from **Schedule**, on the **Board** tab. Each match is a card. **Board** puts courts across the top and time down the side, **Agenda** lists the matches by time, and **By division** is a third view. On a screen 640 px wide or narrower the board opens as **Agenda**, unless you have picked a view before.

![The schedule board for a six-player league on a phone-width screen: a summary with four figures, the three pass buttons, and the Agenda view listing matches by time from 09:00.](/help/scheduling/board-agenda.webp "The board on a phone after Auto-schedule with play hours of 09:00 to 12:00: the summary, the three passes and the Agenda view.")

## Place a match by hand

1. Find the match in the tray. It is headed **Unscheduled (15)** when 15 matches are waiting.
2. Pick the match, then pick a slot. Every free slot is a button, for example **Place picked match at 08:00 on Court 1**. You can also drag a card onto a slot.

A slot that already holds a match is switched off.

## Let the scheduler place the day

Three buttons sit side by side. Their hint reads **Rebuild → fix clashes → tighten times. Locked cards stay put.** Each asks you to confirm and says how many matches it will touch.

- **Auto-schedule** rebuilds the whole stage from scratch. With 15 matches waiting, the window reads **15 matches will be placed or moved.** Locked cards stay where they are, and the window says how many.
- **Re-flow unlocked** places the matches still in the tray around everything already on the board. Nothing already placed moves, so it cannot fix a clash between two placed matches.
- **Improve times** tightens the existing board. Pinned and locked matches keep their times. See [pinned slots and freezing](/help/scheduling/locks).

When a run finishes, a summary appears above the board and says which pass produced it. **Optimised. These are the numbers the solver settled on.** means the optimiser finished. **Scheduled quickly, without the optimiser. The board is valid.** means the quick pass produced it, and the line under the figures says what happened, for example **Time ran out — 2 of 7 targets improved before the solver stopped.** When the optimiser could not run, the summary says why: **Scheduled quickly — the optimiser was busy. Try again for a better board.**

The summary shows **Total length**, **Longest gap** (a team's longest wait between matches), **Court spread** (busiest court against the quietest) and **Scheduled**.

> **Example**
> A six-player league has 15 matches on two courts, with 30-minute matches and no play hours. **Auto-schedule** placed all 15, and the summary read **Total length** 4h 0m, **Longest gap** 1h 0m and **Court spread** 30m. With play hours of 09:00 to 12:00 the league runs over two days. The summary in the picture above read **Total length** 25h 40m and **Longest gap** 22h 20m.

Set your play hours first: [scheduling constraints](/help/scheduling/constraints).

## Several divisions at once

On the competition's own board (**Competition**, then **Schedule**), **Filter by division** shows a chip for each division. Pick one to see just that division.

Whenever more than one unfinished stage is on the board, a **Stage** chooser appears: two divisions with one stage each, or one division with a league and its finals. The three passes run on the stage you pick. On the competition board its menu is named **Choose which stage to schedule**.

## What the board refuses

A few moves are refused outright. The board will not save a move that

- puts a match on a court slot that is already taken;
- puts one person in two matches at once;
- starts a match before the match that feeds it has finished, plus the rest its players are owed;
- places a match outside the days from the **Start date & time** to the **End date** on the Settings tab.

> **Example**
> In a four-player knockout with both semi-finals at 08:00, you place the final at 08:00. The board answers **Can't schedule here. This match feeds a later one, so it can't start until the earlier match has finished and its players have had their rest.** and names both semi-finals. Nothing is saved.

When two matches in a league share a player, the board answers **Can't schedule here. Someone would be playing in two matches at once.**

Everything else is a badge you can act on or ignore, such as short rest or a blackout. The card gets a tag like **rest**, and the header shows a **⚠ conflicts** button that opens the full list.

> **Example**
> With a **Minimum rest per entrant** of 60 minutes, you place Amber vs Fenwick at 08:00 and Amber vs Dunmore at 08:30. Both are saved, both cards carry a **rest** tag, and the header shows **⚠ 2 conflicts**. With a rest of 0, no badge appears.

The refusal is about the change you just made. A clash already on the board stays a badge, and fixing it clears the badge.

## Editing together

If another organiser changes the schedule first, your change is not saved and the board says **Schedule changed by someone else — board refreshed.**
