---
title: Two teams finish level on points: who finishes higher?
description: Level teams are split by an ordered list of checks, and the first check that tells them apart decides who finishes higher in the table.
date: 2026-11-23
author: Seazn
topic: tie-breaks
sports: all
help: divisions/settings
related: three-way-tie-head-to-head, when-lots-decide-a-tie, how-standings-points-work
examples: level-on-points
---

Two teams finish on the same points, and the table still has to put one of them above the other. Seazn does it with an ordered list of checks. It runs down the list for the two teams, stops at the first check where they differ, and that check decides who finishes higher. Every sport starts from its own list, and the list matters more than any one check on it. The table below was made by reading the list a new division of each of the {{fact:level-on-points.sportCount}} sports uses.

{{example:level-on-points}}

## Reading the table

Each row is one sport. The first column after the name is what the table is sorted by first, and the last column is the list of checks for teams that are level on it. Points come first in most sports. Volleyball, badminton and tennis sort by matches won instead, so for them "level" means level on wins, not on points.

Read a row from left to right and stop at the first check where the two teams are different. Whatever sits to the right of it is never looked at for those two teams. That is why the order is the real decision: two lists with the same checks in a different order can put different teams on top.

## The same results, two different orders

Football shows it. Hawks and Rockets both finish on {{fact:level-on-points.hawksPoints}} points. Hawks won the match between them, {{fact:level-on-points.hawksBeatRockets}}, but Rockets have the better goal difference over the whole league, {{fact:level-on-points.rocketsGoalDifference}} against {{fact:level-on-points.hawksGoalDifference}}.

Football's own order looks at head-to-head before goal difference, so it separates the two on {{fact:level-on-points.ownOrderSplitBy}}: Hawks finish {{fact:level-on-points.hawksPlaceOwnOrder}} and Rockets finish {{fact:level-on-points.rocketsPlaceOwnOrder}}. The classic order, which football also offers and which checks goal difference first, separates them on {{fact:level-on-points.classicSplitBy}}: Rockets finish {{fact:level-on-points.rocketsPlaceClassic}} and Hawks finish {{fact:level-on-points.hawksPlaceClassic}}.

Neither table is wrong. Head-to-head asks who was better on the day the two actually met. Goal difference asks who was better across the whole league. A competition has to pick which question comes first, and it has to say so before the first match, because the answer can change who finishes higher.

## What each sport checks

- **Football.** The first check is {{fact:level-on-points.footballFirstTieBreak}}. In full: {{fact:level-on-points.footballOrder}}. This is the head-to-head-first order that FIFA uses from 2026; the classic order, the one the World Cup used before that, checks goal difference first.
- **Cricket.** The first check is {{fact:level-on-points.cricketFirstTieBreak}}. In full: {{fact:level-on-points.cricketOrder}}.
- **Chess.** The first check is {{fact:level-on-points.boardgameFirstTieBreak}}. In full: {{fact:level-on-points.boardgameOrder}}.
- **Carrom.** The first check is {{fact:level-on-points.carromFirstTieBreak}}. In full: {{fact:level-on-points.carromOrder}}.
- **A generic division.** The first check is {{fact:level-on-points.genericFirstTieBreak}}. In full: {{fact:level-on-points.genericOrder}}.
- **Volleyball.** The first check, after matches won, is {{fact:level-on-points.volleyballFirstTieBreak}}. In full: {{fact:level-on-points.volleyballOrder}}.
- **Badminton.** The first check, after matches won, is {{fact:level-on-points.badmintonFirstTieBreak}}. In full: {{fact:level-on-points.badmintonOrder}}.
- **Table tennis.** The first check is {{fact:level-on-points.tabletennisFirstTieBreak}}. In full: {{fact:level-on-points.tabletennisOrder}}.
- **Tennis.** The first check, after matches won, is {{fact:level-on-points.tennisFirstTieBreak}}. In full: {{fact:level-on-points.tennisOrder}}.
- **Ice hockey.** The first check is {{fact:level-on-points.icehockeyFirstTieBreak}}. In full: {{fact:level-on-points.icehockeyOrder}}.
- **Hockey.** The first check is {{fact:level-on-points.hockeyFirstTieBreak}}. In full: {{fact:level-on-points.hockeyOrder}}.

Drawing of lots is the last step on every list, so two teams that no check can tell apart are still placed.

## Which list a table uses

A table can use three lists, and it takes the first one that has been set: the stage's own list, then the list set for the whole division, then the sport's.

The list is fixed when a stage starts. A change made to the division afterwards does not move a table that is already being played, so the table the players have been reading does not change under them. The organiser's Standings tab says so under the table: it names which list the table uses and notes that the list was pinned when the stage started.

## Where you set it

Open the division's **Fixtures** tab. The **Division rules** card has a **Tie-breaks** button for the division's list, and every stage card has its own **Tie-breaks** button for that stage alone. In a league the sport's first measure is marked **always first** and drawing of lots is marked **always last**; the steps between them can be moved, removed or added, and a **Reset to** menu offers the football presets. A new stage uses the division's list if one is set, and the sport's list otherwise. Once a stage has started its card reads "Locked: the stage has started" and its rules cannot be changed.

On the public table, a team that was split from another carries the line "Tied with", the names of the other teams, and "split on" followed by the check that separated them.
