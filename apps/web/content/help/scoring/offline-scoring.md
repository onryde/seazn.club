---
title: Scoring without signal
description: Lost signal in the middle of a match does not lose the match. Entries queue on the device and send when you are back online.
order: 13
related: scoring/conflicts, scoring/device-links
---

Courtside signal drops. The pad keeps working: every entry shows on the pad straight away and waits in a queue until it can be sent.

## What you see

The pad's status line shows where the queue stands.

- **Offline — actions are saved and will send once you're back online.** Your connection is down. Keep scoring.
- **3 queued**, then **2 queued**, then **1 queued**. Entries are waiting to send, or going out one at a time. The number counts down.
- **All synced.** Everything is in the ledger.

> **Example**
> Badminton, Mira against Jonas. The venue loses signal. You tap Mira, Jonas, Mira, and the pad shows 2-1 while the status line reads Offline. The match has recorded only its start. When the phone is back online the status changes to **All synced** within a moment, and the ledger holds the three rallies in the order you tapped them.

## What is kept

- **Entries are saved on the device.** Reloading the page does not lose them: after a reload the score and the queue come back.
- **The queue lives only on the device that made the entries.** A second phone looking at the same match still shows the score the ledger has. It cannot see your queue.
- **Order.** Entries from one device go out in the order they were made.

## When the queue sends

A device that knows it is back online sends its queue by itself, oldest entry first, with no tap.

Sometimes the connection is poor but the phone does not report it as offline, for example a hall with a Wi-Fi network that has no internet. Then the status line stays on **Offline** after the connection is good again. Tap the pad once: any new entry sends the whole queue, oldest first.

## Switching devices

If you hand the match to another phone while entries are still queued on the first, they stay on the first phone. Bring that phone back online first, or the match will be missing those entries until it is.

## Two devices offline at once

Nothing is lost. Each device sends its own entries when it comes back, so the ledger holds them in the order the devices reconnected, not the order the taps were made. Both devices then show the same score.

> **Example**
> Phone A taps Mira twice and phone B taps Jonas three times, both offline. A reconnects first, then B. The ledger holds Mira, Mira, Jonas, Jonas, Jonas and both phones show 2-3. If the order matters to the rally count (the server, the court side), [void](/help/scoring/corrections) and re-enter. For two entries that land close together, see [score conflicts](/help/scoring/conflicts).
