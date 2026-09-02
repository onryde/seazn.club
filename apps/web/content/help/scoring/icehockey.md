---
title: Scoring ice hockey
description: Goals with assists, the full penalty ladder with a live box countdown and strength chip, line changes, overtime and game-winning shots.
order: 20
---

Ice hockey and field hockey run on one pad chassis and share the same clock and period model — and almost nothing else on the scoresheet. [The field hockey page](/help/scoring/hockey) is that sport's own. This page is ice hockey's: three twenty-minute periods, the seven-class penalty ladder, assists, and the game-winning shots.

Pick a format when you create the division. **IIHF** is the default — 3 × 20, sudden-death overtime, a five-shooter shoot-out, and 3-2-1-0 points. **Recreational** turns overtime and the shoot-out off (draws stand, 2-1-0), and cuts the penalty ladder down to the two-minute pair, minor and bench minor, so nothing else is even offered.

The band above the score says which of those is in force: *3 × 20 min · Overtime · GWS*.

## The clock

Ice hockey is one of the two sports whose pad runs a clock. **Start** and **Pause** it as play runs, and **Correct the clock** nudges it by a minute or ten seconds when it has drifted from the rink clock — that only moves this pad's clock, never the times already recorded.

Every entry you record while it's running is stamped with the game time it happened at, which is what lets the penalty box count down properly instead of sitting still between whistles.

## Goals

**Goal** is a tile per side and a single press: it records the goal for that side immediately, and everything else is offered afterwards while the entry is still held.

That panel carries, in order: how it was scored — **Power play**, **Short-handed**, **Penalty shot** — plus **Own goal** (which moves the goal to the other side, because that's what an own goal is) and **Empty net** as flags. Then **Who scored?** from the side's players on the ice. Once a scorer is named it becomes **Who assisted?**, and you can add up to two — the same cap the record itself enforces, so a third simply isn't offered.

Field hockey has no assists; ice hockey does, and this is the one place the two pads visibly differ on a goal.

## Penalties, the box, and strength

**Penalty** is a tile per side. The sheet asks:

1. **Which penalty?** — the ladder in severity order: minor, bench minor, double minor, major, misconduct, game misconduct, match penalty. The order is fixed by severity rather than by however the division's configuration happens to be stored, so reaching for a minor under time pressure doesn't land on a match penalty.
2. **What for?** — the IIHF offence list, from tripping and hooking through to fighting and too many men.
3. **Minutes** — opening at *that class's own* declared duration: 2 for a minor, 4 for a double minor, 5 for a major, 10 for a misconduct. Change it if the official gave more. A game misconduct has no duration to ask about — it's for the rest of the match — so the step is skipped.
4. **Served by** — optional, for the team-mate who sits a penalty they didn't earn (a bench minor, a goalkeeper's penalty).

After the tap, the held panel asks **Who was penalised?**.

While penalties are running, the strip carries **On ice** — `5v4`, `5v3` — and **Back on**, a live countdown to the next release, ticking against the game clock rather than against the last thing anybody recorded. A penalty with no countdown to show (one carried across a period break, or recorded before the clock was started) shows its class word instead; a game misconduct shows **Rest of match**.

Overtime inverts the strength model, and the pad reads it straight from the record rather than counting penalties itself: in sudden death the *non-offending* side gains a skater, so a penalty reads `4v3` and two coincidental ones stay `3v3`.

**Release** appears only while somebody in the box can actually be released — pick the entry itself from a list that names the side, the class and the player. A game misconduct can't be released, so it's never offered.

## Line changes

**Line change** is a tile per side. Substitution is unlimited and on the fly, so nothing is capped or refused here — pick who comes off and who goes on, and the player coming on takes the position the other one was holding. It's also how a pulled goalie is recorded end to end: the goalie leaves, an extra skater goes on, and the goalie comes back.

## Penalty shots, periods and the shoot-out

**Set piece awarded** records a penalty shot as it's given, whether or not it beats the goalkeeper — the awarding is its own entry, separate from any goal that follows. Ice hockey has only one kind of set piece, so the pad doesn't ask which: it asks who it was awarded to and how it ended, then offers who took it and which goalkeeper faced it.

**Advance period** moves play along and names the marker it's about to record on the tile itself, so there's nothing to pick.

Level at the end, with the format's decider on, and play goes to sudden-death overtime and then to **GWS attempt** tiles, one per side. Attempts have to alternate, so only the side whose turn it is has a live tile and the strip names who's **Next**. Each attempt asks whether it scored; the held panel then offers who took it, the defending goalkeeper, and a **Retake** flag for a defender's foul during the one-on-one.

The game-winning shot counts in the official score: a match tied 2-2 and won on the shoot-out is recorded 3-2, with the shoot-out tally shown beside it as `(2–1)`. The shoot-out itself credits no player goal, so per-player scoring stays what happened in play.

## Standings and stats

Regulation win 3, overtime or shoot-out win 2, overtime or shoot-out loss 1, loss 0. Ties break head-to-head first, then on goal difference and goals for.

The division's **Stats** tab carries goals, assists and points, penalty minutes (2 for a minor or bench minor, 4 for a double, 5 for a major, 10 for a misconduct, 20 for a game misconduct, 25 for a match penalty), power-play and short-handed goals, shoot-out attempts and goals, and — for goalkeepers — shots faced, saves and save percentage.

Individual shots stay under **More** rather than taking two of the board's four columns: a full stream of them is a lot of taps, and the board keeps its space for the actions most matches use.

## Recording level

Each level adds to the one below it — see [choosing a detail level](/help/scoring/fidelity).

- **Result only** — goals, period advances and shoot-out attempts. The score is right; nobody is named.
- **Card** — penalties and releases, which is what brings the box countdown and the **On ice** strength chip to life.
- **Timeline** — who scored, the assists, the offence a penalty was for, who served it, line changes, and penalty shots. This is the level per-player stats are built from.
- **Detail** — individual shots, and with them the goalkeeper save numbers.

## Common questions

**Why does the box countdown disagree with the record by a second or two?** The countdown ticks against the pad's own clock so you can watch it; the record sweeps a penalty out at the next stamped entry or whistle. They agree at every point that matters and are allowed to differ in between.

**A penalty was recorded before I started the clock.** It stands, and the strip shows its class word rather than a countdown — there's no game time to count from yet.

**Where's the field hockey card ladder?** On [the field hockey page](/help/scoring/hockey). Ice hockey's classes are words on a scoresheet rather than cards an official holds up, which is why they read as words here.

**Signal dropped mid-period?** Entries queue on the device and send when it returns — see [scoring without signal](/help/scoring/offline-scoring).
