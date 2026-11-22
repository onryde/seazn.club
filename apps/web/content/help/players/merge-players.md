---
title: Merge two players
description: Merge two records for the same person into one, see what moves, and check the published schedules afterwards.
order: 7
related: players/find-duplicates, players/undo-a-merge, entrants/duplicate-players, scheduling/board
---

A merge folds two records for one person into one. You keep one record and merge the other in. Nothing is deleted, and you can [undo it](/help/players/undo-a-merge). Owners and admins can merge.

![The Merge two records dialog at phone width: each field shows the record you keep above the one you merge in, the Public visibility block shows Shown, Hidden and the result for name and photo, and a tickbox sits above the Merge records button.](/help/players/merge-dialog.webp "The merge dialog on a phone. A struck-through value is the one that is dropped.")

## Merge a suggested pair

1. In **Possible duplicates**, choose **Review** on a pair. See [find possible duplicate players](/help/players/find-duplicates).
2. The **Merge two records** dialog sets the two records against each other. On a wide screen they sit in two columns, **Keep this record** and **Merge this one in**. On a phone each field shows the record you keep above the one you merge in. The older record is the one you keep. Choose **Swap** to turn them round.
3. Compare the fields. A value that differs is struck through on the record you merge in. On a wide screen a not-equal sign also marks it.
4. Tick **I have checked both records. They are the same person.** **Merge records** stays off until you do.
5. Choose **Merge records**. A card reads **Merged into** and the name, then **Both records are kept. [Name] now holds the whole history.** Choose **Close**, or **Undo**.

The merged-in record leaves your roster.

## What moves to the record you keep

- **Squad entries.** Every team and entrant the other record was in. If both records were on the same team, the team keeps one entry. It keeps the squad number the kept record had, or the other's if it had none, and the captain mark if either had one.
- **Lineups.** Past team sheets move over. If both were in one lineup, the kept record's place stays.
- **Availability answers.** The more recent answer wins when both records answered the same match.
- **Bans.** A ban on either record applies to the kept record.
- **The account link.** If only the merged-in record was claimed, the kept record takes the link. The dialog says so: **Only the record being merged in is linked to a player’s account. The record you keep inherits that link.** If two different logins claimed them, the merge is refused.
- **Statistics** are counted again from the matches, so goals and cards are counted once, on the kept player. Match results are not changed.
- **The photo** of the merged-in record is not copied across. The kept record keeps its own photo, or none.

## Public settings: the stricter one wins

Under **Public visibility**, the dialog shows **Name** and **Photo** for both records, and the result. **The stricter setting wins.** If either record hides a setting, the merged record hides it, even if the record you kept showed it.

## Merge by hand

You can merge two records the panel did not list, for example two with different dates of birth.

1. In **Directory**, **Players**, choose **Merge…** on the record you want to merge in. The page reads **Merging** and the name, then **into… pick the player to keep below.**
2. On the record to keep, choose **Keep this one**. The same dialog opens.

If the two records give different dates of birth, the dialog says **These records give different dates of birth, so this pair is never suggested. Merge it only if you know they are the same person.** It adds a second tickbox, **I know the dates of birth differ and want to merge anyway.** Both tickboxes must be ticked. Use it for a mistyped year.

A player record and an official record cannot be merged, and neither can a pair claimed by two different logins.

## A merge can show a clash on a published schedule

As two records, one person could be in two matches at the same time. As one person, they are on two courts at once. After a merge, the published schedules the kept player is in are checked again. A clash is listed under **Published schedules to check**, with the board, a count and a label such as **person overlap**. The merge is not blocked.

- A board whose competition has finished shows **Completed** and **This competition has finished — nothing to reschedule, but the clash is worth knowing about.**
- A schedule that is not published yet is not checked.
- To fix a clash, open the board and move one of the two matches. The cards carry **person overlap**. The board does not offer **Fix with AI** for this clash.

> **Example**
> **Priya Anand** is on file twice. **Spring Singles** has one record in a match on Court 1 and the other in a match on Court 2, at the same time. **Autumn Singles** has the same pair of matches, and its competition has finished. **Summer Singles** has the same pair and is not published. You merge the two records. The card lists **Autumn Singles** with **Completed**, **2** and **person overlap**, and **Spring Singles** with **2** and **person overlap**. **Summer Singles** is not listed. In **Spring Singles** the board shows **⚠ 2 conflicts**. You move one of the two matches.
