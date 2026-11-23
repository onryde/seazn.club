---
title: Three teams are level: how does head-to-head work?
description: With three teams level, head-to-head becomes a small table among them, and whether it runs once or again can change who finishes first.
date: 2026-11-23
author: Seazn
topic: tie-breaks
sports: all
help: sports/football
related: level-on-points-who-finishes-higher, when-lots-decide-a-tie, set-ratio-or-set-difference
examples: three-way-tie
---

Head-to-head means setting aside every match except the ones the level teams played against each other. For two teams that is one match, and the winner finishes higher. For three teams it is a small league of its own, and that is where it gets hard: a circle of results, where each team beat one of the others, leaves all three level again. The rules then have to say what to count next, and what to do when the count separates one team and leaves two still level.

The table below is football, ranked twice from the same six results. The two columns are two real rules. Football's own order in Seazn runs the head-to-head steps once. UEFA's rule applies them again to the teams that are still level, and so do FIFA's rules for the 2026 World Cup (Article 13 of the FIFA World Cup 26 Regulations), so the UEFA column is also what that rulebook gives.

{{example:three-way-tie}}

## Reading the table

Hawks, Rockets and Comets all finish on {{fact:three-way-tie.levelPoints}} points. They beat each other in a circle: Rockets beat Hawks {{fact:three-way-tie.rocketsBeatHawks}}, Hawks beat Comets {{fact:three-way-tie.hawksBeatComets}}, and Comets beat Rockets {{fact:three-way-tie.cometsBeatRockets}}. In the games among the three, every team has {{fact:three-way-tie.miniPoints}} points and a goal difference of {{fact:three-way-tie.miniGoalDifference}}. The next count is goals scored in those games. Comets scored {{fact:three-way-tie.cometsMiniGoals}} there against {{fact:three-way-tie.hawksMiniGoals}} for Hawks, so Comets finish {{fact:three-way-tie.cometsPlaceOwn}} in football's own order and {{fact:three-way-tie.cometsPlaceUefa}} in the UEFA order. Dynamos are on {{fact:three-way-tie.dynamosPoints}} points, so they are not level with the three and finish {{fact:three-way-tie.dynamosPlaceOwn}} in the first order and {{fact:three-way-tie.dynamosPlaceUefa}} in the second.

That leaves Hawks and Rockets level on every head-to-head count, and this is where the two orders part. Football's own order runs the head-to-head steps once and then moves on to the whole league, so it separates the two on {{fact:three-way-tie.ownSplitBy}}: Hawks have the better goal difference, {{fact:three-way-tie.hawksGoalDifference}} against {{fact:three-way-tie.rocketsGoalDifference}}, so Hawks finish {{fact:three-way-tie.hawksPlaceOwn}} and Rockets {{fact:three-way-tie.rocketsPlaceOwn}}. The UEFA order runs the head-to-head steps again for the two teams still level, and separates them on {{fact:three-way-tie.uefaSplitBy}}: Rockets won the match between the two, so Rockets finish {{fact:three-way-tie.rocketsPlaceUefa}} and Hawks {{fact:three-way-tie.hawksPlaceUefa}}.

## Why run it again

The case for running it again is that the games against Comets say nothing about Hawks and Rockets. Once Comets have dropped out, those two are a two-team tie, and the plainest question for a two-team tie is the match they played against each other. Football's own order stops after one pass and goes on to the whole league instead. Which of the two a competition follows is a choice in its rulebook, and it has to be made before play starts, because it moves a team from first to second without any result changing.

## Head-to-head waits for every match

A head-to-head step only runs once every match among the level teams has been played. A mini-league with a match missing would rank teams on games they have not all had, so until then the table skips the step and uses the next check. Suppose Hawks, Comets and Rockets have each beaten Dynamos ({{fact:three-way-tie.partWayHawksResult}}, {{fact:three-way-tie.partWayCometsResult}} and {{fact:three-way-tie.partWayRocketsResult}}) and have not yet played each other. All three are level on points, and the table orders them by {{fact:three-way-tie.partWaySplitBy}}: {{fact:three-way-tie.partWayOrder}}. The public table adds a note beside each of them: "{{fact:three-way-tie.partWayNote}}" Once the three matches among them are played the head-to-head steps run, and the places can change.

## What each sport does with three level teams

Head-to-head comes in several shapes. It can run once as a mini-league, run again on whoever is still level, start again each time it separates someone, count only when exactly two teams are level, or, in chess, count the points each player scored against the others once. Each sport's own list uses one of them.

- **Football:** {{fact:three-way-tie.footballThreeWay}}.
- **Cricket:** {{fact:three-way-tie.cricketThreeWay}}.
- **Chess:** {{fact:three-way-tie.boardgameThreeWay}}.
- **Carrom:** {{fact:three-way-tie.carromThreeWay}}.
- **A generic division:** {{fact:three-way-tie.genericThreeWay}}.
- **Volleyball:** {{fact:three-way-tie.volleyballThreeWay}}.
- **Badminton:** {{fact:three-way-tie.badmintonThreeWay}}.
- **Table tennis:** {{fact:three-way-tie.tabletennisThreeWay}}.
- **Tennis:** {{fact:three-way-tie.tennisThreeWay}}.
- **Ice hockey:** {{fact:three-way-tie.icehockeyThreeWay}}.
- **Hockey:** {{fact:three-way-tie.hockeyThreeWay}}.

Where head-to-head counts only between two teams, a three-way tie skips it and falls to the next check. If that check then leaves exactly two teams level, head-to-head comes back for those two. The brackets in each line say where in the sport's list the head-to-head step sits.

## Where you set it

For football the stage's **Tie-breaks** editor has a **Reset to** menu with **FIFA 2026**, **UEFA** and **Classic**, found on the division's **Fixtures** tab on the stage card. The entry named **FIFA 2026** sets football's own order, the one that runs head-to-head once; **UEFA** is the entry that runs it again. Choose one before the stage starts; once it has started the card shows "Locked: the stage has started". The public table then shows, beside each team that was split, the line "Tied with" and the other teams, and "split on" followed by the check that separated them: with football's own order, "Tied with Rockets — split on goal difference" beside Hawks, and "Tied with Hawks, Rockets — split on head-to-head scoring" beside Comets.

![The public standings table with a note under Comets: tied with Hawks and Rockets, split on head-to-head scoring](/help/blog/three-way-tie-head-to-head-1.webp "Tapping the marker beside Comets names the teams they were tied with and the check that split them.")
