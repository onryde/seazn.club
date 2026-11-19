---
title: Scheduling constraints
description: The rules Auto-schedule and AI Schedule play by — hours, courts, rest, a daily cap, blackouts — and the tools that check a day.
order: 4
related: scheduling/board, scheduling/locks, scheduling/ai-scheduling, scheduling/undo
---

Constraints are the rules the scheduler plays by. You set them once per division. Auto-schedule obeys them. An AI plan is checked against them, and any break is flagged for you to review before you apply. Matches you place by hand are checked against them too. Every plan has them.

![The Constraints tab of a division's schedule. It shows the two rule boxes, Minimum rest, Max matches per day, Field fairness and Blackout windows.](/help/scheduling/constraints-panel.webp "The Constraints tab: the rule boxes and fields sit at the top, with Blackout windows, Bulk time shift and the Wait-time report below.")

The rules live on three tabs of **Schedule**: **Settings**, **Courts** and **Constraints**.

## Hours, courts and match length

On the **Settings** tab you set:

- **Start date & time** and **End date**. The scheduler begins on the start date, and the end date bounds the days it may use.
- **Play from** and **Play until**. Matches only land between these times each day. Leave them blank and any time of day is allowed.
- **Match length (minutes)** and **Gap between matches (minutes)**. The gap is turnaround time on the same court, such as warm-up and teardown.
- **Minimum rest per entrant (minutes)**.

Set **Play from** and **Play until** before you run **Auto-schedule**. With no play hours, Auto-schedule starts at midnight, not at the time of day you picked for the start. In a six-player league with play hours of 09:00 to 12:00, the first match landed at 09:00.

On the **Courts** tab you pick the courts this schedule can use.

## Rest between matches

Rest is the one rule with more than one home. The scheduler takes the **largest** of these:

- **Minimum rest per entrant** on the Settings tab.
- **Minimum rest** on the Constraints tab.
- **At least one break between a team's matches**, the box on the Constraints tab. It is not a number. A whole match has to fit in the gap, so it works out as the match length plus the gap between matches.

Raising any of them raises the floor, and leaving one at 0 lets the others decide.

When another setting outranks the field you are looking at, a line under it names the winner and the rest entrants get.

> **Example**
> Match length is 30 minutes and the gap between matches is 5. You tick **At least one break between a team's matches** and set **Minimum rest** to 20. The line under the field reads **Entrants will rest at least 35 min — set by “at least one break between a team’s matches”.** Set **Minimum rest** to 50 and the line disappears, because the field itself now wins.

## Max matches per day

**Max matches per day** caps how many of this division's matches land on one calendar day. The rest spill to the next available day. Leave it blank for no limit.

> **Example**
> A six-player league has 15 matches, two courts and a Max matches per day of 4. Auto-schedule puts 4, 4, 4 and 3 matches on four days in a row.

## The two rule boxes

- **A player is never in two matches at once**. The hint reads **A double-booking is always refused. This only decides whether the AI planner tries to avoid one.**
- **At least one break between a team's matches**. The hint reads **No entrant plays two rounds running.**

Both boxes start unticked.

## Field fairness

**Field fairness** is a tie-break between courts that are free at the same moment. It never delays a match.

- **Off** takes whichever court comes first.
- **Balance courts** gives the entrant the court they have used least.
- **Rotate every game** avoids the court they played on last.

On a tight timetable it can change nothing. In a six-player league on two courts, all three choices gave the same board.

## Blackout windows

A blackout is a time when nothing can be scheduled, such as a lunch break or one court out of action. Select **Add blackout**, choose **Applies to** (**Whole division** or one court), set **From** and **To**, then select **Save blackout windows**. The times are shown in the zone named above the list. See [timezones](/help/scheduling/timezones).

> **Example**
> A six-player league has 15 matches on two courts, with play hours of 08:00 to 18:00. With no blackout, every match is on 5 December between 08:00 and 11:30. You add a blackout for the whole division from 09:00 to 10:00 on 5 December. With later days still open, Auto-schedule moves all 15 matches to 6 December, 08:00 to 11:30. With only 5 December open, they run from 10:00 to 13:30. A blackout for Court 1 only, on that one open day, leaves Court 1 empty from 09:00 to 10:00 while Court 2 still plays at 09:30.

## Bulk time shift

Type a number of minutes and select **Shift everything**. A window asks **Shift every fixture by 45 minutes?** and tells you that locked and decided matches stay put. Afterwards the screen says **Moved 15 matches.** Take it back with **Undo** on the History tab. See [undo and save points](/help/scheduling/undo).

## Wait-time report

Select **Check waits** for a table of the five entrants with the longest waits, worst first. The columns are **Entrant**, **Games**, **Longest wait** and **First to last**.

> **Example**
> In the six-player league, Dunmore played 5 games with a longest wait of 1h, from a first start to a last start 3h 30m apart. The report listed five of the six players.
