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

Two shortcuts take back the latest entry without finding it in the feed. They are two controls in two places:

- The ribbon on the pad has **Take back**. Pressed while the tap is still held back, it cancels the tap before it is sent. Pressed later, it voids the entry.
- The ledger footer of the fixture console has **⟲ Void last entry**.

A [device link](/help/scoring/device-links) shows **Void my last entry** on its pad.

> **Example**
> A badminton rally is recorded four times: Mira, Jonas, Mira, Mira, so 3-1. The second tap was a mistake. Void that entry and the score becomes 3-0 for Mira. The other three entries stand, and the pad works out the server and the court again from what is left.

## Who can void what

- **You, as the organiser:** any entry on a match that is not finalized, including after the result has moved the competition on.
- **An official** with an accepted assignment to the match: any entry on that match until it is finalized. See [officials](/help/scoring/scorer-role).
- **A device link** can void only entries made through that same link, never an official's entry or one made through a different link, and only until the result moves the competition on. In a knockout that is the moment the result is entered, because the winner goes straight into the next match. After that the pad says "Not recorded — this result has already moved the competition on. Ask the organiser to correct it.", and corrections are the organiser's, from the console. Two phones that scanned the same QR share one link, so either can void the other's entries.

## After the match is finalized

Nothing can change a finalized match, whoever you are. **Void** is no longer offered to the organiser, an official or a device link, the console shows no scoring controls for the match, and the app refuses every write to it, including from an owner or an API key. There is no way to reopen a finalized match.

Check the result with both sides before you, or an official, press **Finalize**. Until then the result can be voided and entered again. A pad that was already open when the match was finalized and tries to score is refused on the match console with "This match already has a result. To score it again, void the entry that decided it (“⟲ Void last entry” in the match console). A finalised result can't be changed." and on a device link with "This match already has a result. If your last entry decided it, void it with “⟲ Void my last entry” to score again; if someone else's did, ask the organiser. A finalised result can't be changed." On a finalized match there is nothing to void or reopen, so the last sentence is the one that applies. The signed [audit trail](/help/scoring/match-audit-trail) keeps the whole record either way.

## Replays

Voiding an entry does not subtract it. The app plays every entry after it again, in order, as if the voided one had never happened. Voiding the last point changes only the last point. Voiding an earlier one moves everything after it as well, and it can change more than the number you meant to fix. If you are not sure, void back to the mistake and re-enter from there.

## Common questions

**Can I undo a void?** No. The pad says "Not recorded — an undo cannot be undone. Re-record the entry instead." Enter the entry again.

**I pressed Confirm void twice.** The second one is refused: "Not recorded — that entry was already taken back." Nothing changes.

**Someone else already voided it.** You get the same answer.
