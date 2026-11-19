---
title: Pinned slots and freezing
description: Pin a match so the automatic passes leave it where it is, or freeze the whole schedule to stop every edit.
order: 2
related: scheduling/board, scheduling/undo, scheduling/constraints
---

A pin keeps one match at its time and court while you rebuild the rest of the day. A freeze goes further and stops every edit to the schedule, yours included.

![The schedule board in agenda view with one card locked. Amber vs Fenwick, round 1, at 09:00 on Court 2 shows a lock in its corner, and the other cards show an unlocked pin.](/help/scheduling/pinned-slot.webp "Pinned slot: the lock on a card means Auto-schedule, Re-flow unlocked and Improve times leave it where it is.")

## Pin a match

1. Open **Schedule**, then the **Board** tab.
2. Select the pin on the match card. Its label reads **Pin/lock this slot**.
3. The card now reads **Locked — survives re-flow**. To release it, select the lock again. That control reads **Unlock (allow re-flow)**.

A pinned match stays put through **Auto-schedule**, **Re-flow unlocked**, **Improve times** and **Clear schedule…**. Each confirm window tells you how many matches it leaves alone, and the summary above the board tells you again afterwards:

- Before: **1 locked match stays exactly where it is.**
- After: **1 locked fixture was kept where it is.**

> **Example**
> A six-player league on two courts has 15 matches. You pin Amber vs Fenwick at 09:00 on Court 2 and select **Auto-schedule**. The window says **14 matches will be placed or moved.** and **1 locked match stays exactly where it is.** After the run, Amber vs Fenwick is still at 09:00 on Court 2. Run **Re-flow unlocked** and then **Improve times** on top of that, and the match is still there.

AI Schedule leaves pinned matches alone too. Its planning checklist counts them under **Pinned**.

### When a pin stops everything fitting

If your locked matches are why a run could not place every match, the summary says **Fixtures you locked may be why this could not all fit.** and offers **Re-run and allow locked fixtures to move**. Nothing moves until you confirm **Allow locked fixtures to move?**.

A match that already has a result or scoring cannot be pinned. The board says **This match has a result or scoring recorded, so it can't be moved or locked.**

## Freeze the schedule

Freeze from either place:

- The **Freeze schedule** button on the board.
- The **Freeze whole schedule** box on the **History** tab.

The board button then reads **🔒 Frozen — unfreeze**. Select it to open the schedule again. The board confirms each change with **Schedule frozen — all edits are blocked until you unfreeze.** or **Schedule unfrozen — edits are open again.**

While the schedule is frozen:

- The slot buttons on the board are switched off, so you cannot place a match.
- **Undo**, **Redo** and **Clear schedule…** are switched off. The panel says **The schedule is frozen. Unfreeze it above to undo or redo an edit.**
- Restoring or deleting a save point is switched off. The panel says **The schedule is frozen. Unfreeze it above to restore or delete a save point.**
- **Auto-schedule** still opens its confirm window, but it changes nothing. A message tells you the schedule is locked.
- AI Schedule says **This schedule is frozen. Unfreeze it to plan with AI.**

Anyone who can edit the division can freeze and unfreeze it. A freeze does not add a row to **Recent edits** on the History tab.

Use a freeze once the timetable is printed and taped to the wall. Use a pin when only one match must not move.
