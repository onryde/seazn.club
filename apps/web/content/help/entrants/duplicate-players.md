---
title: Merging duplicate players
description: Merge two directory entries for the same person into one record, and undo it if you got it wrong.
order: 3
related: players/duplicates, entrants/kinds, entrants/team-badges-and-bulk-enrolment
---

The same person often ends up in the directory twice: typed in by hand one season, imported from a spreadsheet the next. A merge folds the two records into one.

You rarely need to hunt for pairs yourself. **Directory → Players** has a **Possible duplicates** panel that finds them. [Reviewing possible duplicates](/help/players/duplicates) explains what it suggests. This page covers the pair you spotted yourself.

## Merge a pair by hand

1. Open **Directory → Players** and find the entry you want to fold away.
2. Choose **merge…** on its row.
3. In the list that opens, choose **Keep this one** on the record you want to keep.
4. In the **Merge two records** dialog, check the two columns, **Keep this record** and **Merge this one in**. Choose **Swap** if they are the wrong way round.
5. Tick **I have checked both records. They are the same person.**
6. Choose **Merge records**. The button stays off until you have ticked.

![The bottom of the Merge two records dialog: the stricter public-visibility setting wins, the same-person tickbox, and the Merge records and Cancel buttons](/help/entrants/merge-confirm.webp "The confirm step. Nothing is deleted, and the stricter public setting wins")

If the two records give different dates of birth, the dialog warns you and asks for a second tick: **I know the dates of birth differ and want to merge anyway.** Two records with different birth dates are often two people who share a name, so check first.

## What you keep

- The kept record keeps its own name and date of birth.
- **Consent is the stricter of the two.** If one record kept its name private, the merged record stays private. The dialog shows this under **Public visibility**.
- Rosters, lineups, sport profiles, bans, availability replies and the player's account link move to the kept record. Season statistics are worked out again, so each result counts once.
- When both records were on the same team, the team keeps one entry and uses the kept record's squad number.
- The merged-in record's photo is not copied across.

> **Example**
> "Leila Haddad" was entered by hand and "Layla Haddad" came from an import. Both are on the Riverside Rockets roster, as #9 and #10. You merge Layla into Leila. The team now lists one player, Leila, with #9. If Layla's record had kept the name private, Leila's would be private now too.

## What is refused

- Two records that two different people have claimed with their own logins cannot be merged.
- A player and an official are never merged.
- You cannot undo a merge once a later merge has built on it.

## Nothing is deleted

The merged-in record is hidden, not deleted. **Recent merges**, under the duplicates panel, lists what you merged and has an **Undo** on each. Undo brings back both records with their own names, birth dates, consent and roster entries.

The app never merges on its own. Every merge starts with someone choosing **Merge records**.
