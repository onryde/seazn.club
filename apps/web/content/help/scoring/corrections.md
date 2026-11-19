---
title: Fixing a mistake
description: Void a wrong entry from the activity feed. Voiding an early one recalculates everything after it.
order: 14
related: scoring/match-audit-trail, scoring/device-links, scoring/conflicts
---

A wrong entry is not erased. You **void** it, and the match recalculates as if the entry had never been made. The original stays in the feed so the record can always be reconstructed.

## Void an entry

Every entry in the pad's **Activity** feed has a **Void** button.

1. Press **Void** on the entry.
2. Press **Confirm void**, or **Cancel**.
3. The entry shows **Voided** and a new row, **Entry undone**, appears. The score and the state of the match are recalculated at once.

Before the match starts, the pad's **Take back** button removes the last entry. Once it is live, the same button reads **Void last entry**. A [device link](/help/scoring/device-links) shows **Void my last entry**.

> **Example**
> A badminton rally is recorded four times: Mira, Jonas, Mira, Mira, so 3-1. The second tap was a mistake. Void that entry and the score becomes 3-0 for Mira. The other three entries stand, and the pad works out the server and the court again from what is left.

## Who can void what

- **You, as the organiser:** any entry, on any match, including after the result has moved the competition on.
- **An official** with an accepted assignment to the match: any entry on that match until it is finalized. See [officials](/help/scoring/scorer-role).
- **A device link** can void only entries made through that same link, never an official's entry or one made through a different link, and only until the result moves the competition on. In a knockout that is the moment the result is entered, because the winner goes straight into the next match. After that the link is refused with "This result has already moved the competition on", and corrections are the organiser's, from the console. Two phones that scanned the same QR share one link, so either can void the other's entries.

## After the match is finalized

**Void** is no longer offered, and the app refuses a void with "This fixture is finalized". There is no button that reopens a finalized match. The signed [audit trail](/help/scoring/match-audit-trail) keeps the whole record either way.

## Replays

Voiding an entry does not subtract it. The app plays every entry after it again, in order, as if the voided one had never happened. Voiding the last point changes only the last point. Voiding an earlier one moves everything after it as well, and it can change more than the number you meant to fix. If you are not sure, void back to the mistake and re-enter from there.

## Common questions

**Can I undo a void?** No. The app answers "An undo cannot be undone — re-record the entry instead". Enter the entry again.

**I pressed Confirm void twice.** The second one is refused with "Nothing to undo — that entry is already undone". Nothing changes.

**Someone else already voided it.** You get the same answer.
