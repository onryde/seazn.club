---
title: Why does a table tennis loss still earn a point?
description: A table tennis match played to the end pays the loser something at every score. A forfeit before a point is played pays the loser less.
date: 2026-11-23
author: Seazn
topic: points
sports: tabletennis
help: sports/tabletennis
related: how-standings-points-work, why-matches-won-come-first, forfeits-and-walkovers-by-sport
examples: table-tennis-loss
---

Because table tennis ranks its table on match points first, and a match played to the end pays both players. The winner gets **{{fact:table-tennis-loss.won30Winner}}** and the loser gets **{{fact:table-tennis-loss.won30Loser}}**, at every score. A forfeit before a point is played pays the loser less: **{{fact:table-tennis-loss.forfeitLoser}}**.

{{example:table-tennis-loss}}

## Reading the table

Each of the first rows is a real match that Ana won, played to the end, at one of the scores the format can finish on. The loser gets the same whether the match ended 3-0, 3-1 or 3-2: {{fact:table-tennis-loss.won30Loser}} at 3-0, {{fact:table-tennis-loss.won31Loser}} at 3-1 and {{fact:table-tennis-loss.won32Loser}} at 3-2. The winner gets {{fact:table-tennis-loss.won30Winner}}, {{fact:table-tennis-loss.won31Winner}} and {{fact:table-tennis-loss.won32Winner}}.

The last row is a different kind of match. Ben forfeits before a single point is played, so there was no match to play. Ana is paid the win, **{{fact:table-tennis-loss.forfeitWinner}}**, and Ben is paid **{{fact:table-tennis-loss.forfeitLoser}}**.

## Why a played loss earns something

Seazn's table tennis rules follow the ITTF's tie-break regulation (3.7.5), which starts from match points, not from matches won. That is the difference from volleyball in [why matches won come first](/blog/why-matches-won-come-first). In those rules a loss that was played to the end is worth {{fact:table-tennis-loss.won30Loser}} match point whatever the score, and a loss that was never played, a forfeit before a point, is worth {{fact:table-tennis-loss.forfeitLoser}} points.

## What changes from sport to sport

- **Table tennis.** The same points apply in all {{fact:table-tennis-loss.variantCount}} formats: {{fact:table-tennis-loss.variantsList}}. The table above is the format a new table tennis division starts on.
- **Every other sport.** Only {{fact:table-tennis-loss.sportsEveryLossPays}} of the {{fact:table-tennis-loss.sportCount}} sports pays every played loss: {{fact:table-tennis-loss.everyLossPaysList}}. {{fact:table-tennis-loss.someLossPaysNothingList}} each have at least one way of losing that earns nothing. And only {{fact:table-tennis-loss.sportsDecidingUnplayed}} of the {{fact:table-tennis-loss.sportCount}} sports starts with a separate amount for a loss that was not played, which is table tennis again.

## Where you set it

On a table tennis stage's card in the division's Fixtures tab, **Points** has a line for a win, a line for a loss and a line for a loss that was not played, so a played loss and a forfeit can be paid differently. The picture shows the three lines.

![The Points editor for a table tennis stage with a line for a win, a loss and a loss not played](/help/blog/table-tennis-loss-still-scores-1.webp "Table tennis pays a played loss and a loss that was not played on separate lines.")
