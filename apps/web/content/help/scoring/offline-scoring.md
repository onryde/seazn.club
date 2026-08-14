---
title: Scoring without signal
description: Lost signal mid-match doesn't lose the match — entries queue on the device and send once you're back online.
order: 13
---

Courtside signal drops. The pad doesn't stop working when it does — every entry you make still records locally and queues to send the moment you're back online.

## What you'll see

A status line on the pad's header shows the queue: **N queued** while entries wait to send, **Syncing…** while they're going out, **All synced** once everything's landed. Go offline and it says so plainly — *"Offline — actions are saved and will send once you're back online."* Keep scoring through all of it; nothing is blocked by a bad connection.

## It's durable, and it drains itself

Queued entries are saved on the device, not just in the browser tab's memory — closing the tab, reloading, or the browser restarting doesn't lose them. The moment the device gets a connection back, the queue sends itself, oldest entry first, with no extra tap required. Watch the queued count drop as it goes.

## One thing not to do

The queue lives on **the device that recorded it** — nowhere else. If you hand the match to a different phone or tablet partway through (a dead battery, say), whatever was still queued on the first device stays there and only sends once *that* device is back online — a fresh device starting from now has no way to see or send it. If you're switching devices, get the original one back online first, or you'll be missing entries until it reconnects.

## Common questions

**Do I need to press anything to resend?** No — reconnecting is enough. Submitting anything new also nudges the queue along.

**Will I lose points if two devices score offline at once?** No, but they can disagree about order — see [score conflicts](/help/scoring/conflicts) for what happens when two entries land close together.
