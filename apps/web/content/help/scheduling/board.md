---
title: The schedule board
description: Place matches on courts and times by hand, run Auto-schedule and its two follow-up passes, and see what the board refuses.
order: 1
related: scheduling/locks, scheduling/undo, scheduling/constraints, scheduling/ai-scheduling
---

The schedule board is where matches meet the clock. Open it from **Schedule**, on the **Board** tab. Pick how to see it: **Board** puts courts across the top and time down the side, and **Agenda** lists the matches by time. On a phone the board opens as **Agenda**. Each match is a card.

![The schedule board for a six-player league on a phone-width screen. A summary with four figures sits above the Auto-schedule, Re-flow unlocked and Improve times buttons. Below them the Agenda view lists the matches by time, each card showing the two players, the court and the round, from 09:00.](/help/scheduling/board-agenda.webp "The board on a phone after Auto-schedule with play hours of 09:00 to 12:00: the summary, the three passes and the Agenda view.")

## Place a match by hand

1. Find the match in the tray. It is headed **Unscheduled (15)** when 15 matches are waiting.
2. Pick the match, then pick a slot. Every free slot is a button, for example **Place picked match at 08:00 on Court 1**. You can also drag a card from the tray onto a slot.
3. The card moves from the tray onto the grid.

A slot that already holds a match is switched off, so you cannot stack two matches on one court.

## Let the scheduler place the day

Three buttons sit side by side. Their hint reads **Rebuild → fix clashes → tighten times. Locked cards stay put.**

| Button | What it does | What the confirm window says |
|---|---|---|
| **Auto-schedule** | Rebuild the whole stage from scratch; locked cards stay put | **15 matches will be placed or moved.** |
| **Re-flow unlocked** | Re-run the auto pass over unlocked fixtures only; pinned cards stay | **14 unlocked matches may move to a new time or court.** |
| **Improve times** | Tighten the existing board — pinned and locked matches keep the times they already have | **14 unlocked matches may get a new start time.** |

The counts above come from a league with one pinned match. Pinned matches are covered in [pinned slots and freezing](/help/scheduling/locks).

When a run finishes, a summary appears above the board. It says which pass produced the board. **Optimised. These are the numbers the solver settled on.** means the optimiser finished. **Scheduled quickly, without the optimiser. The board is valid.** means the quick pass produced it. **Re-flow unlocked** always uses the quick pass, and **Auto-schedule** sometimes does too. The last line of the summary names the pass, for example **Solver · 5.8s · nothing moved** or **Quick pass · 10.2s · nothing moved**. A run that finds nothing to improve says **Already the best arrangement — there was nothing left to improve.**

The summary shows four figures: **Total length**, **Longest gap**, **Court spread** and **Scheduled**. A longest gap is a team's longest wait between matches. Court spread is the busiest court against the quietest.

> **Example**
> A six-player league has 15 matches, two courts and 30-minute matches, with no play hours set. **Auto-schedule** placed all 15. The summary read **Total length** 4h 0m, **Longest gap** 1h 0m, **Court spread** 30m and **Scheduled** 15 / 15. With play hours of 09:00 to 12:00 the same league runs over two days. The summary then read **Total length** 25h 40m and **Longest gap** 21h 45m.

The scheduler only places matches inside your play hours, so set them first. See [scheduling constraints](/help/scheduling/constraints).

## Several divisions at once

On the competition's own board (**Competition**, then **Schedule**), the board can show more than one division.

- **Filter by division** shows chips for each division. Pick one to see just that division.
- When more than one division has more than one stage still to play, a **Stage** chooser appears. It reads **Choose which stage to schedule**, and the three passes run on the stage you pick.

## What the board refuses

A few moves are refused outright. The board will not save a move that:

- puts a match on a court slot that is already taken;
- puts one person in two matches at once;
- starts a match before the match that feeds it has finished, plus the rest its players are owed;
- places a match after the **End date** on the Settings tab.

> **Example**
> A four-player knockout has two semi-finals and a final, and the semi-finals sit at 08:00. You pick the final and place it at 08:00 too. The board answers **Can't schedule here. This match feeds a later one, so it can't start until the earlier match has finished and its players have had their rest.** and names both semi-finals. Nothing is saved.

When two matches in a league share a player, the board answers **Can't schedule here. Someone would be playing in two matches at once. A clash you introduce is refused; one already on the board stays a badge you can edit around.**

Everything else is a badge you can act on or ignore. That covers short rest, a blackout and a rule from your scheduling instruction. The card gets a tag, such as **rest**, and the header shows a **⚠ conflicts** button that opens the full list.

> **Example**
> A league has a **Minimum rest per entrant** of 60 minutes. You place Amber vs Fenwick at 08:00 and Amber vs Dunmore at 08:30. Both are saved, both cards carry a **rest** tag, and the header shows **⚠ 2 conflicts**. With a rest of 0, the same two placements show no badge.

The refusal is about the change you just made, not the state of the board. If a clash is already there, it stays a badge and you can keep editing around it. Fix the clash and the badge clears.

## Editing together

If another organiser changes the schedule after you opened the board, your change is not saved. The board refreshes and says **Schedule changed by someone else — board refreshed.**
