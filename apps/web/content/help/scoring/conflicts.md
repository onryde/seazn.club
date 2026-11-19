---
title: Score conflicts
description: Two people score the same match at once. Both entries are kept, and a console action that is out of date is refused.
order: 2
related: scoring/device-links, scoring/offline-scoring, scoring/corrections
---

Two people can score the same match at the same moment: a courtside scorer and an organiser at the desk, or two phones on the same [device link](/help/scoring/device-links). This page says what each of them sees.

## What happens to a tap on the pad

Usually both entries land and you see no message. If the pad was out of date when you tapped, it catches up with the latest score and sends your entry again on top of it.

- Both entries land in the ledger, one after the other. Nothing is lost and nothing is overwritten.
- Nothing is merged either. If both people tap for the same point, the point is recorded twice.
- **If the other entry already ended the game or the match, your tap is refused.** The pad shows "This match already has a result. Reopen it before scoring again." Nothing is recorded, and there is nothing to reopen in a match that has already been finalized, so check the ledger instead. In practice the pad refreshes within a moment and stops offering the score tiles for a match that has ended, so only a tap made in that window is refused.
- **If the pad cannot get the entry in after two catch-ups, it gives up.** The entry is not recorded and the pad says "Not recorded — this entry could not be saved after several tries. Check the ledger, then retake it." Read the ledger, then tap again if the point is missing.

> **Example**
> Badminton, Mira against Jonas. A phone still shows 0-0 while the desk has already recorded a rally for Mira. The phone's scorer taps Jonas. The ledger now holds both rallies, and the phone shows 1-1.

## What happens to an organiser action

Actions that you start from the console, such as **Abandon…** or **Forfeit…**, are checked against the score you were looking at. If someone scored in the meantime, the action is refused and the console says "Score moved on another device — the view has been refreshed, please re-check." The refresh shows the latest score. Look at it, and make the action again if it still applies.

## What to do

Read the score after a conflict, and after any message from the pad. If the pad shows a point twice, [void](/help/scoring/corrections) the extra one.

## Why it works this way

Every match is a numbered ledger, and each entry names the number it expects to follow. Two entries cannot take the same number, so the ledger cannot split into two versions. Phones, the console and the API all score through the same rule.

**Seeing it often?** Two devices are probably scoring the same match. Keep to one device for each match.
