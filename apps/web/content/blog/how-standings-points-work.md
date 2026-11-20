---
title: How do standings points work in each sport?
description: A win, a draw and a loss earn different points in different sports, and some sports rank their table by wins before points.
date: 2026-11-20
author: Seazn
topic: points
sports: all
help: divisions/settings
related: shootout-win-league-points, level-on-points-who-finishes-higher, why-matches-won-come-first
examples: standings-points
---

A finished match pays the winner a fixed number of points and the loser a fixed number, and pays each side a number when the sport allows a level result. Each sport brings its own numbers, and a few rank their table by wins before they look at points. The table below was made by playing real matches in all {{fact:standings-points.sportCount}} sports.

{{example:standings-points}}

## Reading the table

Each row is one sport. Start with football: a win earns **{{fact:standings-points.footballWin}}** points, a draw earns each side **{{fact:standings-points.footballLevel}}**, and a loss earns **{{fact:standings-points.footballLoss}}**. The last column says what the standings look at first when two teams are level, which is points in most sports and wins in a few.

A sport that cannot end a match level says so in the third column. Nobody is owed a draw payout there, and the points rule simply has no level result to pay.

## What changes from sport to sport

- **Football and hockey.** A win earns {{fact:standings-points.footballWin}} in football and {{fact:standings-points.hockeyWin}} in hockey. A draw earns {{fact:standings-points.footballLevel}} in football and {{fact:standings-points.hockeyLevel}} in hockey.
- **Cricket.** A win earns {{fact:standings-points.cricketWin}}. A tie earns each side {{fact:standings-points.cricketLevel}}.
- **Chess.** A win earns {{fact:standings-points.boardgameWin}}, a draw earns {{fact:standings-points.boardgameLevel}}, a loss earns {{fact:standings-points.boardgameLoss}}.
- **Volleyball.** The score of the match decides the points. A 3-0 win earns the winner {{fact:standings-points.volleyballWin30}} and the loser {{fact:standings-points.volleyballLoss30}}. A 3-2 win earns the winner {{fact:standings-points.volleyballWin32}} and the loser {{fact:standings-points.volleyballLoss32}}.
- **Table tennis.** At 3-0 the winner earns {{fact:standings-points.tabletennisWin30}} and the loser {{fact:standings-points.tabletennisLoss30}}. At 3-2 the winner earns {{fact:standings-points.tabletennisWin32}} and the loser {{fact:standings-points.tabletennisLoss32}}.
- **Badminton, tennis, carrom, ice hockey and any other sport.** A win earns {{fact:standings-points.badmintonWin20}} in badminton, {{fact:standings-points.tennisWin}} in tennis, {{fact:standings-points.carromWin}} in carrom, {{fact:standings-points.icehockeyWin}} in ice hockey and {{fact:standings-points.genericWin}} in a generic division.

The last column of the table shows what each sport ranks by first: volleyball by {{fact:standings-points.volleyballRankedBy}}, badminton by {{fact:standings-points.badmintonRankedBy}}, tennis by {{fact:standings-points.tennisRankedBy}}, and football by {{fact:standings-points.footballRankedBy}}.

## How Seazn handles it

A division starts from its sport's own points, so you change them only when your competition plays by different rules. Open the division, go to the **Fixtures** tab and use the **Division rules** card. A single stage can have its own points on its own card. The help page on [division settings](/help/divisions/settings) shows where that card sits.

> **Note**
> Points are only half of what puts a team above another. The tie-break order decides who finishes higher when points are level.
