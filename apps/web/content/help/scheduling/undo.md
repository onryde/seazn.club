---
title: Undo and save points
description: Step a schedule back and forward, bookmark a known-good timetable with a save point, and restore it later.
order: 3
related: scheduling/board, scheduling/locks, scheduling/constraints, scheduling/ai-review
---

Every change to the schedule is a step in a history, like edits in a document. **Undo** steps back one change and **Redo** steps forward. A **save point** bookmarks the timetable as it is now, so you can come back to it after experimenting.

![The History tab of a division's schedule. It lists Recent edits, a Save points section with one save point named before rain, and a Danger zone with Clear schedule.](/help/scheduling/history-panel.webp "The History tab: Undo and Redo at the top, Recent edits below them, then Save points and the Danger zone.")

## Undo and redo

Open **Schedule**, then the **History** tab.

1. Select **Undo** to step back one change. Placing matches, moving one, clearing the schedule and shifting every kick-off time are all steps.
2. Select **Redo** to step forward again.

Each step, including an undo or a redo, adds a row to **Recent edits**, such as **Schedule applied**, **Fixture moved** or **Schedule cleared**.

Undo does not stop at a save point. With three save points on the list, one **Undo** still took back the last change.

## Save points

1. In **Save points**, type a name. The box suggests **e.g. before rain reshuffle**.
2. Select **Save point**. The new bookmark appears in the list with its name and time, and the counter reads, for example, **1 used**.
3. To go back, select **Restore** beside the save point and confirm **Restore this save point?**.

Restore undoes each change made since the bookmark, one by one. The screen then says how many it undid, for example **Restored — undid 1 change.** If the board already matches, it says **Nothing to undo — the board is already at this save point.**

> **Example**
> You run **Auto-schedule** on a six-player league and save a point named before rain. You shift every match by 45 minutes. You select **Restore** and confirm. The screen says **Restored — undid 1 change.** and all 15 matches are back at their earlier times. Select **Restore** again and it says **Nothing to undo — the board is already at this save point.**

### How many you can keep

Community keeps {{plan:schedule.checkpoints.max:community}} save points per division. Pro keeps {{plan:schedule.checkpoints.max:pro}}.

When you are at your plan's number, a new save point replaces the oldest, and the panel names the one that went: **“one” was replaced — your plan keeps 2 save points.** It adds **Undo still rewinds past it.** To remove one yourself, select the **✕** beside it and confirm **Delete this save point?**. The schedule does not change.

AI restore points are separate. They are listed under **AI restore points**, they do not use up your save points, and the newest three per division are kept. See [reviewing and applying an AI plan](/help/scheduling/ai-review).

## Clear the schedule

**Clear schedule…** sits in the **Danger zone**. The panel says **Clears timetable slots only — locked fixtures and matches in play or finished always stay, and the action is undoable above.** You confirm **Clear unlocked slots?**, and the clear shows up in Recent edits as **Schedule cleared**. Undo brings the slots back.

## Results are never touched

Undo, redo and restore change the timetable only. If a step would touch a match that already has a result or scoring recorded, it stops and says so: **A match this change touches has a result or scoring recorded, so it can't be undone or redone.** The restore window adds that a change that can't be undone, such as a confirmed draw, stops the restore there.

A frozen schedule switches all of this off until you unfreeze it. See [pinned slots and freezing](/help/scheduling/locks).
