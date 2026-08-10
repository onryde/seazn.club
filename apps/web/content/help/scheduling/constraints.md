---
title: Scheduling constraints
description: Play hours, rest gaps, court preferences — the rules Auto-schedule must respect.
order: 4
---

Constraints are the rules the auto-scheduler plays by. They live in the division's **schedule settings**. Courts, match length and the start/end dates are also asked once on the **Scheduling** step when you create the division — the settings panel is where you change them afterwards.

## The basics (all plans)

- **Play hours** — when the venue is yours, per day.
- **Courts** — what your court is called. More than one court in parallel is Pro.
- **Match length** — how long a fixture blocks a court, derived from the sport but overridable.

Every time on these screens is picked from a list rather than typed to the minute. On the settings and constraints screens that list is the **quarter hours** — 9:00, 9:15, 9:30 — the times a timetable is normally built from. Dates keep their usual calendar picker.

When you set the time on an individual match — the **Schedule** button on a fixture, **Add match**, or the board's **Move** panel — the list is your division's own slots instead: with 40-minute matches and no gap it offers 9:00, 9:40, 10:20, and so on. Those are the times the rest of the board already sits on, so nudging one match by hand cannot leave it stranded between everyone else's.

Registration opening and closing times are quarter hours too, plus **23:59**, so "entry closes at the end of Friday" stays sayable.

## Finer control (Pro)

- **Multiple courts** — run matches in parallel across a venue.
- **Rest gaps** — minimum minutes between an entrant's matches.
- **Unavailability** — "Rockets can't play before 10am Saturday".
- **Court preferences** — finals on Court 1, wheelchairs on the accessible court.
- **Describe it in words** — type "45 players, 2 courts, done by 6pm, nobody plays twice in a row" and the assistant proposes constraints; you review and apply, nothing is set silently.

To go further and have the same plain-language instruction lay out the whole timetable, see [AI Schedule](/help/scheduling/ai-scheduling).

## Minimum rest is set in four places, and the strictest wins

Rest is the one setting with more than one home, so it is worth knowing which of them is in charge:

- **Minimum rest per entrant** on the **Settings** tab.
- **Minimum rest** on the **Constraints** tab.
- **At least one break between a team's matches**, the checkbox below it.
- A per-pool or per-division override, if your competition has one.

They do not override one another and they are not ranked by how specific they are. The scheduler takes the **largest** of them. Put 30 in one and 10 in the other and entrants rest 30 — raising either raises the floor, and leaving one at 0 simply lets the others decide.

The checkbox is the one that surprises people, because it is not a number. "At least one break" means a whole fixture has to fit in the gap, so it works out as **match length plus the gap between matches**. With 30-minute matches and a 5-minute changeover that is 35 minutes — more than a *Minimum rest* of 30, so the 30 stops mattering the moment you tick the box.

You do not have to work this out yourself. Whenever one of the other settings outranks the rest field you are looking at, a line appears under it naming the setting that won and the rest entrants will actually get.

## Field fairness

Over a long day some entrants end up on the same court every round while others move about. **Field fairness** evens that out — but only as a tie-break.

When the scheduler has two courts free at the same moment, it picks between them:

- **Balance courts** — give the entrant the court they have used least so far.
- **Rotate every game** — avoid the court they played on last.
- **Off** — take whichever court comes first.

Kick-off times always win. If the fairer court is only free later, the match goes on the earlier one anyway; no fixture is ever delayed to even out courts. So on a tight timetable with few spare courts, turning this on may change nothing at all.

## Diagnosing a day

The **schedule report** shows each entrant's shortest and longest waits — the fastest way to spot the poor team sitting idle for three hours before you print anything.
