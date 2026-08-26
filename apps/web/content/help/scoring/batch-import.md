---
title: Importing results in bulk
description: Load a finished match's events from a JSON file in one go, for migrating history or catching up matches scored on paper. The target fixture must still be untouched.
order: 15
---

If you're moving a club's history in from another system, or catching up a division after scoring matches on paper, you don't have to re-key every point through the live pad. Batch import loads a whole match's finished events at once from a JSON file — one call can cover many matches in a division in a single go.

## Before you import

**Start the division first.** [Starting a division](/help/divisions/lifecycle) locks its structure and moves it out of setup — a division that's still in setup, or scheduled but not yet started, refuses the whole import call outright.

**But leave the fixtures themselves untouched.** Every fixture you import into must still show no recorded events at all — not from a previous import, and not from a stray tap on its live pad. The moment a fixture has even one event on it, it's permanently out of reach for import; the only way to change something already on the record is the normal [correction flow](/help/scoring/corrections).

This page isn't linked from the console yet, since it's still rolling out. If your organisation has it enabled, reach it by adding `/import` to the end of the division's own web address; if it isn't working for you, ask your seazn.club contact to switch it on for your organisation.

## The JSON file

The file is one JSON object: an `import_id` you choose, and a list of `streams` — one per fixture, each carrying the same events its live pad would record.

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

A few things worth knowing about the shape:

- **`fixture`** is either `{ "id": … }` or `{ "ext_key": … }` — whichever you use has to match exactly one fixture in the division. Most people pasting a file by hand will find `ext_key` easier, since the console shows fixtures by number, not by their internal id; `id` matters more when you're scripting the import against fixtures you've already fetched from the API.
- **`events[].type` and `.payload`** are the same event vocabulary that sport's live pad uses — `core.start` and `core.finalize` on every sport, plus sport-specific ones like the `generic.result` above, or cricket's `cricket.ball`. List them in the order they happened; `payload` can be left out for an event that carries none.
- **`events[].at`** is optional — the original time the event happened, if you know it. Leave it out and the event is stamped with the import time instead.
- Don't send a **`seq`**. The server numbers each fixture's events itself, starting at 1, in the order you listed them.
- **`core.void`** — the live pad's undo — can't be imported at all. If a stream is wrong, fix the file itself rather than trying to cancel one event with another.
- `import_id` only has to be unique within a division — reusing the same name for a different division is fine.

## The three limits

One call can carry at most:

| Cap | Limit |
|---|---|
| Fixtures (streams) per call | 50 |
| Events for any one fixture | 1,000 |
| Events across the whole call | 10,000 |

Go over any one of these and the whole call is refused — nothing from it is imported, not even the fixtures that were within range. Split a large backfill into several files, each under all three limits, and send them one after another.

## Reading the report

Once a call runs, you'll get a totals line in the form *N imported · N skipped · N rejected*, and a row per fixture you named: whether it imported, was skipped as a duplicate, or was rejected; the fixture itself, linked straight to its match page when it's a real fixture in this division; how many events were written; its final result once imported; and, for anything that didn't import, why. *Skipped* isn't a failure — it means that exact fixture was already imported by an earlier call with the same `import_id`; see "Sending it again safely" below.

## When a row comes back rejected

Nothing is written for a rejected fixture, not even part of its stream, so it's always safe to fix the file and send it again. (This is about one fixture's row coming back rejected inside an otherwise normal report — if the whole call is refused before you see a report at all, it's one of the cases above: too large, the division not started yet, or a second import already running for this division that you need to wait out.)

- **No matching fixture, or more than one.** *"This fixture reference matched 0 fixtures in this division (expected exactly 1)."* The `id` or `ext_key` didn't line up with exactly one fixture. `ext_key` only has to be unique within a stage, so reusing the same key across two stages in the same division will match more than one — use the fixture's `id` instead if that happens.
- **Already has events.** Something's already been recorded against this fixture, live or from an earlier import — see "Before you import" above. Use the [correction flow](/help/scoring/corrections) if what's on record is wrong.
- **Line-up not set.** One or both sides is still a bye or unresolved. Fill the fixture's entrants in first.
- **Needs a detail level this plan doesn't include.** One of the events needs a scoring detail level your organisation isn't entitled to. See [Choosing a detail level](/help/scoring/fidelity) — simplify the stream to a level you have, or upgrade.
- **Something in the stream is invalid partway through.** One of the events isn't valid for this sport at that point in the match — the report names which event in the list. Check it against what actually happened and resend.
- **The stream never reaches a result.** Every event was valid, but read start to finish they don't add up to a finished match — you're likely missing the last event or two. Add what's missing and resend.

## Sending it again safely

You can always resend the same file under the same `import_id` — a fixture that already succeeded is reported as skipped, not re-applied, so nothing is duplicated. A fixture that was rejected the first time never had anything written, so a fixed version of just that stream goes through cleanly on the retry.

Reusing the `import_id` and choosing a new one behave the same for anything that hasn't imported yet; the only difference is how an already-succeeded fixture is reported if it's accidentally included again — skipped under the same id, or an "already has events" rejection under a new one. Either way, nothing about an already-imported fixture changes. Give a genuinely different batch of results its own `import_id`, and only reuse one when you're retrying the exact same submission.

## For scripts and self-hosted deployments

You can call this directly instead of using the browser page — the endpoint is `POST /api/v1/divisions/{id}/events/import`, using an [API key](/help/api/keys) with **Score** scope.

If you manage this deployment yourself: a fixture's import holds a database connection open for as long as it's actively writing that fixture's events, and the more events a fixture carries the longer that takes, since every event re-checks everything recorded for that fixture so far. The deployment's `DB_POOL_MAX` setting caps how many such connections can be open at once, across the whole app (5 by default) — and the underlying database driver has no wait-time limit for a free connection, so if concurrent demand ever reaches that ceiling, new requests don't fail, they simply wait with no time limit, which from the outside can look like the whole deployment has stalled rather than just the import. Keep `DB_POOL_MAX` comfortably above the number of imports you expect to run at the same time.
