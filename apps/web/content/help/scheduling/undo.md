---
title: Undo and save points
description: Every schedule change is undoable; a save point bookmarks a known-good timetable.
order: 3
---

Schedule edits are a **history**, like a document: undo steps back one change, redo steps forward. Generating, moving, clearing, shifting — all of it is reversible.

## Save points

A **save point** bookmarks the timetable exactly as it is now — every kick-off time and court. Made a mess experimenting? **Restore** rewinds the schedule to the bookmark by undoing each change since, one by one.

Match results are never touched by either. A match counts as played once a result or any scoring has been recorded on it: it is under way or finished, a walkover was recorded during play, it was abandoned after scoring began, or it was started and the start was taken back. A walkover or a void that Generate wrote itself is not played — nothing was. If undoing, redoing or restoring would move or erase a played match, it stops right there and tells you. **Community keeps 2 save points per division and Pro keeps 10.**

Clearing the schedule, shifting kick-offs and applying a schedule work around played matches instead: they keep their slots, and the clear and the shift tell you how many they left in place. A played match can't be dragged or pinned on the board.

When you're already at your plan's number, saving a new one **replaces the oldest** rather than refusing. The panel names the one that went, so you're never left hunting for a bookmark that quietly disappeared — and because a save point is only a bookmark, undo still rewinds past it.

AI restore points are separate: they don't use up your save points, and the newest three per division are kept.

Restoring always says what it did — either how many changes it undid, or that there was nothing to undo. The second one is normal after an AI plan that was refused outright, because nothing was written: the restore point and the live schedule are already the same. An AI plan that stopped **part-way** is the other case — some of it did land, the dock says so and offers an undo of its own, and restoring here really does rewind.

## Common questions

**Does undo affect scores?** Never — schedule history and the score ledger are separate. Fixing a wrong score happens on the fixture itself.

**How far back can I undo?** To the start of the division's schedule history. Save points are bookmarks, not boundaries — undo walks straight past them, including past one that has been replaced.

**Can two admins undo each other?** History is shared, so undo reverses the last change whoever made it — coordinate before big rewinds, or freeze the board first.
