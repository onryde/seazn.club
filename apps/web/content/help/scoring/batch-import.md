---
title: Importing results in bulk
description: Load the finished events of many matches from one JSON file, to bring in history or catch up matches scored on paper.
order: 15
related: scoring/batch-import-report, scoring/corrections, api/keys, divisions/lifecycle
---

If you are moving a club's history in from another system, or catching up a division after scoring matches on paper, you do not have to key every point through the pad. Bulk import loads the finished events of many matches from one JSON file in a single call.

## Before you import

- **Start the division.** A division still in setup refuses the whole call: "This division hasn't started yet", and the message asks you to start it before importing. See [starting a division](/help/divisions/lifecycle).
- **Leave the fixtures untouched.** A fixture you import into must have no events at all, from the pad or from an earlier import. As soon as a fixture has one, import refuses it. Fix what is already recorded with [a void](/help/scoring/corrections).

## Open the import page

The page is at the division's own address with `/import` added to the end. No button in the console leads to it. It is available on every plan.

Paste or choose your file, press import, and read the report. See [reading the import report](/help/scoring/batch-import-report).

## The file

One JSON object with an `import_id` you choose and a list of `streams`, one per fixture. Each stream holds the events the pad would have recorded.

```json
{
  "import_id": "2026-week3-backfill",
  "streams": [
    {
      "fixture": { "id": "b1a3c9de-4a21-4e2f-9c31-7e6a2f5d10aa" },
      "events": [
        { "type": "core.start", "payload": {} },
        { "type": "generic.result", "payload": { "p1Score": 2, "p2Score": 0 } },
        { "type": "core.finalize", "payload": {} }
      ]
    },
    {
      "fixture": { "ext_key": "court2-1400" },
      "events": [
        { "type": "core.start", "payload": {}, "at": "2026-08-20T14:05:00Z" },
        { "type": "generic.result", "payload": { "p1Score": 1, "p2Score": 3 } },
        { "type": "core.finalize", "payload": {} }
      ]
    }
  ]
}
```

- **`fixture`** is `{ "id": … }` or `{ "ext_key": … }`. It must match exactly one fixture in the division. `ext_key` is easier by hand. `id` is better in a script that has already fetched the fixtures.
- **`type` and `payload`** are the events the sport's pad records. `core.start` and `core.finalize` exist in every sport, and each sport adds its own, such as `generic.result` here or `cricket.ball`. List them in the order they happened. A stream has to add up to a result: a stream with only `core.start` is rejected.
- **`at`** is optional: when the event really happened. It must be a full ISO-8601 instant with a zone, such as `"2026-08-20T14:05:00Z"` or `"2026-08-20T14:05:00+02:00"`. Fractions of a second are accepted. A bare date such as `"2026-08-20"` makes the app refuse the whole file before anything is written. Leave `at` out and the event takes the time of the import.
- **Do not send `seq`.** The app numbers each fixture's events from 1, in your order.
- **`core.void` cannot be imported.** The app refuses the whole file (the API's answer reads "core.void cannot be imported"). Correct the file itself and import it under a new `import_id`.
- Use one `import_id` for one batch. It only has to be different from other imports in the same division.

## The limits

| Limit | Value |
|---|---|
| Fixtures (streams) in one call | 50 |
| Events for one fixture | 1,000 |
| Events in one call | 10,000 |

A call over any limit is refused whole, and the message names the limit and your count, for example "Too many streams in one call: 51 exceeds the limit of 50." Split a large backfill into several files that are each within all three limits.

> **Example**
> You have 120 finished generic matches from last season. Split them into three files of 40 streams each, each with its own `import_id` such as `2026-spring-1`, `-2` and `-3`. Each call is under every limit, and each fixture ends up decided with its result in the standings.

## Using the API

The call is `POST /api/v1/divisions/{id}/events/import` and the body is the file. It runs under your signed-in session. To call it from a script with an [API key](/help/api/keys), the key needs the **Score** scope, and a key that can write is available on the Enterprise plan only. A file that contains `core.finalize`, `core.settle`, `core.forfeit` or `core.abandon` needs the **Manage** scope instead, because those events end or decide a match. Such a file sent with a Score key is refused whole, before any fixture is written. The sample file above ends each match with `core.finalize`, so an API key needs the Manage scope to send it. A file without those events needs only Score. A read-only key is refused: the API answers "This key is limited to 'read'".
