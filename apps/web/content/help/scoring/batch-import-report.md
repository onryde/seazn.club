---
title: Reading the import report
description: What the report says after a bulk import, why a fixture can be rejected, and how to send the file again safely.
order: 16
related: scoring/batch-import, scoring/corrections
---

After a [bulk import](/help/scoring/batch-import) runs, you get a totals line and one row per fixture you named.

## The report

The totals read **imported**, **skipped** and **rejected**. Each row shows:

- the fixture, linked to its match page when it is a fixture in this division
- its status: imported, skipped as a duplicate, or rejected
- how many events were written
- for an imported fixture, its result, such as the winner and how it was won, or a draw
- for a rejected fixture, why

Skipped is not a failure. It means that fixture was already imported by an earlier call with the same `import_id`.

> **Example**
> You send four streams. The report reads 3 imported · 0 skipped · 1 rejected. Three fixtures show their results. The fourth row says "This fixture reference matched 0 fixtures in this division (expected exactly 1)." Its `ext_key` has a typo. Nothing was written for that fixture, so you fix the key and send the file again.

## When a row is rejected

Nothing is written for a rejected fixture, not even part of its stream. It is always safe to fix the file and send it again. The other fixtures in the same call are not affected.

| What the row says | Why | What to do |
|---|---|---|
| "This fixture reference matched 0 fixtures in this division (expected exactly 1)." (or more than 1) | The `id` or `ext_key` did not match exactly one fixture. An `ext_key` only has to be unique in a stage, so the same key in two stages of one division matches two fixtures. | Fix the key, or use the fixture's `id`. |
| "This fixture already has recorded events, or is no longer scheduled, so it can't be imported into." | It has a live entry or an earlier import, or the match is no longer waiting to be played. This is also what you see if you resend a fixture under a new `import_id`. | Use [a void](/help/scoring/corrections) if what is recorded is wrong. |
| "This fixture doesn't have both entrants assigned yet." | One or both sides is still a bye or not decided yet. | Fill in the fixture's sides first. |
| "Importing these events needs the ... feature, which isn't enabled for your organization." | An event needs a feature that is off for your organisation. | Remove those events and send again. |
| A message naming one event and a code | One event does not fit the sport at that moment. The row names which event in the list. | Compare it with what happened and fix it. |
| "This stream doesn't end in a decided result, so nothing was imported." | Every event was valid, but together they do not decide the match. | Add the missing events. |

An error you do not recognise means nothing was written for that fixture and the rest of the call carried on. Send just that fixture again.

A file with an invalid structure, for example a bad `at`, is refused as a whole before you get a report, and so is a call over a limit, a division that has not started, a second import already running for the same division, or a competition that is read-only because your organisation is over its plan's limit on active competitions.

## Sending the file again

You can send the same file again under the same `import_id`. A fixture that already succeeded is reported as **skipped** and nothing is duplicated. A fixture that was rejected had nothing written, so the fixed version goes through.

Under a new `import_id`, a fixture that already succeeded is rejected with "This fixture already has recorded events, or is no longer scheduled, so it can't be imported into." Either way nothing about it changes. Give a different batch of results its own `import_id`, and reuse an id only to retry the same file.
