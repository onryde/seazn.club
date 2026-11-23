---
title: Downgrading to Community
description: When your organisation moves to Community, nothing is deleted. Competitions and team members over the Community limits become read-only until you make room.
order: 3
related: billing/change-plan, billing/plans, billing/event-pass-ends, billing/groups
---

Your organisation moves to Community when you cancel Pro and the period ends, when you choose **Downgrade to Community**, when a trial ends without a card, or when a failed payment stays unpaid for 14 days. See [start, switch or cancel Pro](/help/billing/change-plan).

Nothing is deleted. Two limits can make things **read-only** until you make room: active competitions and team members. Over any other limit, what you have keeps working, and you cannot add more until you are back under it.

## Competitions over the limit

Community allows {{plan:competitions.max_active:community}} active competitions. If you have more, the ones used least recently become read-only, and their card in your competition list shows **Read-only**. The ones used most recently stay fully editable. How recently a competition was used is the later of its most recent score and the day it was created.

![A competition card in the list with the Read-only chip beside the sport, its progress bar at 0 of 6 played, the next match and the line 1 division, 4 entrants.](/help/billing/downgrade-readonly.webp "A frozen competition still shows its progress and next match.")

The choice is made once. Scoring a read-only competition does not swap it for another one.

In a read-only competition:

- **Matches still score.** A match can be scored and finished on the pad, so nothing in progress is stranded. The same goes for an online chess board that is on hold: you can resync it from Lichess, let the game go on, or settle it.
- **You cannot change it.** Everything else waits for room: the schedule, entrants, registrations, match formats, calling matches on Match Day, opening a round of online chess, re-sending a player's invite, adding time to a check-in with **+5 min**, and starting any new stream, whether from the stream panel, a camera phone or an automatic start. A stream already running keeps going, and you can still stop it.
- **Everything stays visible.** Its pages, standings and history are still there, for you and for the public.

A competition with an Event Pass is not counted, so it is never frozen while its pass applies.

## Divisions, entrants and public pages

These do not freeze. A competition with more divisions or entrants than Community allows keeps them all, and you can still edit them. You cannot add a division or an entrant past Community's limit.

Public competitions stay public. While you are at the public-dashboard limit, a new competition you create as public is created private.

## Team members over the limit

Community allows {{plan:members.max:community}} team members. If you have more, the members who joined earliest are frozen first, until the rest fit inside the limit. Owners are never frozen.

The freeze applies to admins. A frozen admin can still see everything, but their changes are refused. Nothing on screen marks them in advance. They find out when they try to save, and they are blocked across most of the app: the schedule board, entrants, officials and settings among them. The freeze is separate from API keys, which stop working on Community anyway.

An invitation that would take you past the limit is refused.

## Features that switch off

Features your plan no longer includes stop working. They do not freeze anything. For example, public pages lose your brand colour and keep your logo, exports come out plain, and API keys stop working.

Card entry fees keep working on Community. Your Stripe connection stays linked and paid entries are untouched. What can change is the platform fee. A competition that has taken its first paid card entry keeps its platform fee locked at the rate that entry was charged, even after you downgrade or its Event Pass ends. A competition with no paid card entry yet follows Community's rate. See [the platform fee on entry fees](/help/billing/plans#the-platform-fee-on-entry-fees).

## Make room

- **Archive** a competition, or mark one **completed**. The read-only competition you used most recently becomes editable again, one for each place you free.
- **Buy an Event Pass** for a competition. It leaves the count, and if it was read-only it is editable again. See [buy an Event Pass](/help/billing/buy-an-event-pass).
- **Remove a team member** to make room for a frozen one.
- **Go back to Pro**, and everything is editable again.

> **Example**
> Harbour Hockey Club has Autumn Open, Winter Cup, Spring Ladder and Summer Slam all running when it moves from Pro to Community. Autumn Open had a match scored yesterday. The other three have never been scored, so each one counts from the day it was created. Winter Cup was created first, so it is the least recently used and becomes **Read-only**. Adding an entrant to Winter Cup is refused. Scoring its match still works, and Winter Cup stays read-only after that. Then the club archives Spring Ladder, and Winter Cup is editable again.
