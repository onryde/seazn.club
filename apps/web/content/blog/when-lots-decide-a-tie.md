---
title: When is a tie settled by drawing lots?
description: Lots decide a tie only when every other check has failed. The draw is made once and kept, and some sports check the seeding before they reach it.
date: 2026-11-23
author: Seazn
topic: tie-breaks
sports: all
help: sports/generic
related: level-on-points-who-finishes-higher, three-way-tie-head-to-head, buchholz-and-sonneborn-berger, how-standings-points-work
examples: drawing-lots
---

A drawing of lots is the last step of every sport's list of checks. It decides a tie only when nothing before it could. When a table reaches it, two teams are level on everything the sport thinks is worth counting, and the table still has to put one of them higher.

The table below is a generic division, where the list is points, then {{fact:drawing-lots.genericOrder}}. Larks and Owls draw their own match, {{fact:drawing-lots.larksOwlsDraw}}, and both beat Wrens by the same score.

{{example:drawing-lots}}

## Reading the table

Larks and Owls finish on {{fact:drawing-lots.levelPoints}} points each, with the same difference and the same goals scored, and the match between them was a draw. Every check on the list leaves them level, so the table is split on {{fact:drawing-lots.lotsSplitBy}}: the draw puts {{fact:drawing-lots.lotsFirst}} first and {{fact:drawing-lots.lotsSecond}} second. Wrens are not part of it and finish third whichever way the two are placed.

Look at the last column. Put a seeding step before the lots, as some sports do, and the table is split on {{fact:drawing-lots.seedingSplitBy}} instead. {{fact:drawing-lots.seedingFirst}} had the better seed, so {{fact:drawing-lots.seedingFirst}} goes first. The two methods give opposite answers for the same results, so which one a competition uses changes who finishes higher.

## The draw is made once and kept

A lot that is drawn again every time the table loads would be no use: refresh the page and the winner would change. Seazn draws once, the first time the table has teams that nothing else can separate, and stores the draw. Ranking the table again later gives the same order: {{fact:drawing-lots.storedFirst}} stays first and nothing new is drawn.

The draw is not an unrecorded coin toss, either. It is worked out from a number stored with the stage and the teams that are level, and the result is stored too, so it can be reproduced from the record. The public table says so: beside the teams that were split it notes "Drawn by lots on" and the date.

## When seeding comes first

Lots are the last step, but they are not always the next one after the checks on the scoreboard. Cricket, tennis and ice hockey have a seeding step in front of them, so for those sports two teams level on everything else are placed by their seeds. That is {{fact:drawing-lots.seedSportCount}} of the {{fact:drawing-lots.sportCount}} sports: {{fact:drawing-lots.seedSports}}.

A seed is a decision made before play and a draw is chance. A sport that checks seeding first lets that earlier decision break the tie, and one that goes straight to lots does not.

## What each sport does at the end of its list

- **Football.** Last steps: {{fact:drawing-lots.footballLastSteps}}.
- **Cricket.** Last steps: {{fact:drawing-lots.cricketLastSteps}}.
- **Chess.** Last steps: {{fact:drawing-lots.boardgameLastSteps}}.
- **Carrom.** Last steps: {{fact:drawing-lots.carromLastSteps}}.
- **A generic division.** Last steps: {{fact:drawing-lots.genericLastSteps}}.
- **Volleyball.** Last steps: {{fact:drawing-lots.volleyballLastSteps}}.
- **Badminton.** Last steps: {{fact:drawing-lots.badmintonLastSteps}}.
- **Table tennis.** Last steps: {{fact:drawing-lots.tabletennisLastSteps}}.
- **Tennis.** Last steps: {{fact:drawing-lots.tennisLastSteps}}.
- **Ice hockey.** Last steps: {{fact:drawing-lots.icehockeyLastSteps}}.
- **Hockey.** Last steps: {{fact:drawing-lots.hockeyLastSteps}}.

## Where you set it

The stage's **Tie-breaks** button on the division's **Fixtures** tab lists the steps. In a league the drawing of lots is marked **always last**, so it cannot be moved ahead of another step, and in football's editor **+ Add step** offers seeding among the other steps. The division's **Standings** tab prints the list under the table as "Tie-break cascade". On the public table, a team split by the draw carries "Tied with" and the other team, then "split on drawing of lots", with a note giving the date of the draw. A team split by seeding carries "split on seeding".
