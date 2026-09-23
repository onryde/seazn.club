---
title: Fixing a mistake
description: Undo a wrong entry from the activity feed — and why voiding an early one replays everything after it.
order: 14
---

Every recorded entry shows up in the pad's **Activity** feed with its own **Undo** control.

## Undoing an entry

Tap **Undo** on any entry that hasn't already been undone. It doesn't erase the original — it records a new event that cancels it, so the full history stays visible (struck through, marked *undone*) rather than disappearing. The match's score and state recompute immediately as if the undone entry had never happened.

**Who can undo what:** a signed-in scorer can undo any entry on a match they're assigned to, until the match is finalized; after that, an organiser has to reopen it first. A [device link](/help/scoring/device-links) can only undo entries it recorded itself — never another device's or another scorer's — and only until the result moves the competition on (in a knockout, that is the moment the result is entered); after that, corrections are the organiser's.

## The ordering caveat

Matches are scored as a straight sequence of events, and undoing one doesn't just subtract it — it replays every entry recorded after it, in order, as if the undone one had never happened. Most of the time that's invisible: undo the last point and only the last point changes. Undo something further back and everything scored after it recomputes on top of the correction, which can move more than just the number you meant to fix. If you're not sure, undo back to the mistake rather than trying to patch around it.

You can't undo an undo — there's no "redo". To bring back something you cancelled by mistake, re-record it as a new entry.

## Common questions

**I tapped Undo twice by accident.** The second tap does nothing — an entry that's already undone just says so, calmly, rather than erroring.

**Someone else already fixed it.** If two people try to undo the same entry, the second one simply finds nothing left to undo.

**The match is already finalized.** Undo is locked once a match is finalized. Ask an organiser to reopen it — see [the match audit trail](/help/scoring/match-audit-trail) for how corrections stay visible either way.
