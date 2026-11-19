---
title: Reviewing and applying an AI plan
description: What the console shows after a run, what the checker flags, and how to apply the plan or undo it in one tap.
order: 5.3
related: scheduling/ai-scheduling, scheduling/ai-instructions, scheduling/ai-dates, scheduling/undo
---

A run ends with a proposal on the console, not on the board. You read it, then apply it or discard it. Nothing is written until you choose.

![The AI Schedule console after a run on a four-player league. The four stages along the top are ticked. Below are the Summary the AI wrote, the counts, the six placed matches under Why it did that, and a To review list of four flagged matches with the Assign officials and Skip to apply buttons.](/help/scheduling/ai-review.webp "A finished run: the summary, the placed matches under Why it did that, and four matches under To review.")

## While it runs

After you choose **Run with these rules**, the console says **Working on your schedule…** with a timer and **usually 1–5 minutes**. A 15-match league took about 75 seconds. A strip of four stages tracks the run: **Draft**, **Plan**, **Referee** and **Ready**.

## Read the proposal

The proposal opens with a **Summary** the AI wrote, then a **blocking** count. Under **Why it did that** each placed match shows its court and time, with a note when the AI moved it for a reason.

Under **To review** you find the things worth a look before you apply. The heading counts the rows below it: **12 things to review**, for instance. The console says **None of these block the schedule. Check them before you apply.** One tap on **Show the 12 flagged fixtures on the board** highlights them all. Three kinds of row appear:

- **Warnings**: a placement the checker flagged but let through. Each names the match and the reason, such as **breaks your instruction** and **12 matches on 2026-12-05 — your instruction allows 4 a day**.
- **Left out — stays in the tray**: a match the run could not place. You place it by hand, or widen the window and run again.
- **Assumed**: what the AI assumed while it placed matches.

A few problems are **blocking** instead of warnings: a match outside the dates, two matches on one court, a person in two matches at once, and a match that starts before the one that directly feeds it. Untick a blocker to set it aside for the tray. The rest can still apply.

Rest gaps, blackouts, session windows and rules from your sentence are warnings.

> **Example**
> You write: "Play at most 2 matches a day. Give every player 30 minutes rest." The league has 6 matches on two courts. The AI's summary says it honoured the limit and moved round 3 to 6 December. The checker disagrees: **4 matches on 2026-12-05 — your instruction allows 2 a day**. The console shows **blocking 0** and **4 things to review**, each reading **breaks your instruction**. The summary is the AI's own account, so read the list under it.
>
> A 15-match league given "Finish by 6pm and play at most 4 matches a day. Give every player 30 minutes rest." showed **12 things to review** the same way: **12 matches on 2026-12-05 — your instruction allows 4 a day**.

## Clashes fixed before you see them

If a proposal clashes, the console repairs it before it reaches you, by moving as few matches as it can. The panel then reads **Clash fixed automatically** and tells you how many matches moved. It adds **No smaller change would have worked.** when that is true, and **No credits used.** for the repair. When the repair cannot fix everything, it reads **1 fixture left for the AI**, or more, and the run carries on.

## Later rounds and shared players

In a knockout, a later match has no names until the rounds before it are played. The checker holds each undecided match apart from everyone who could still reach it, and it leaves out byes and finished rounds. It can keep apart two matches that turn out to share nobody. That can cost you one more gap in the day, which is the safe side of the trade.

If two player records share a name, the run treats them as one person. Nothing is merged on your rosters.

## Apply

Choose **Skip to apply**, or **Assign officials** first. The apply step says **Apply the proposal to the board.** and, for the league above, **15 fixtures placed on the board**. It adds **A restore point is saved first, so you can undo in one tap.**

Choose **Apply schedule only**, **Apply schedule + officials** or **Discard**. After applying, the console says **Applied. The board is updated.** and **Restore point saved — undo the AI changes in one tap.** Choose **Undo** and it says **Reverted to before the AI changes.** In the league above, all 15 matches went back to the tray.

The restore point is listed under **AI restore points** on the History tab, and the newest three are kept. See [undo and save points](/help/scheduling/undo).
