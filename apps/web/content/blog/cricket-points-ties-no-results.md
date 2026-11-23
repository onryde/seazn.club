---
title: How many points does a cricket team get for a tie or a washed-out match?
description: With the starting rules, a tied or washed-out cricket match gives each team the same: more than a loss and less than a win.
date: 2026-11-23
author: Seazn
topic: points
sports: cricket
help: sports/cricket
related: how-standings-points-work, shootout-win-league-points, net-run-rate-explained
examples: cricket-points
---

Each team gets **{{fact:cricket-points.tieEach}}** for a tie and **{{fact:cricket-points.noResultEach}}** for a match with no result. A win earns **{{fact:cricket-points.winWinner}}** and a loss earns **{{fact:cricket-points.winLoser}}**, so a tied or washed-out match is worth more than a loss and less than a win. These are the numbers a new cricket division starts with, and an organiser can change them.

{{example:cricket-points}}

## Reading the table

Each row is one way a match can end, played out as a real match. A **tie** means both sides finished on the same score. A **no result** means the match was abandoned before it could be decided, for example by rain. In both, nobody wins, so both teams are paid the same.

A tie can be turned into a win. When the stage plays a super over on a tie, the winner of the super over wins the match: they get {{fact:cricket-points.superOverWinner}} and the other side gets {{fact:cricket-points.superOverLoser}}, and the table no longer holds a tie at all. The rules editor also lets you choose what happens if the super over is tied as well: another super over, most boundaries wins, or leave it as a tie.

## A washed-out match

Rain does not always make a no result. The rules editor has a setting for the fewest overs the chasing side must face before DLS, the Duckworth-Lewis-Stern method, can decide an abandoned match. In the editor's own words, fewer is a no result. A match that ends as a no result pays each side {{fact:cricket-points.noResultEach}}.

## What changes from format to format

- **The limited-overs formats.** {{fact:cricket-points.limitedOversList}} all pay the same: a win {{fact:cricket-points.winWinner}}, a tie {{fact:cricket-points.tieEach}} each, no result {{fact:cricket-points.noResultEach}} each.
- **Test match.** A win pays {{fact:cricket-points.testWinWinner}} to {{fact:cricket-points.testWinLoser}}. A Test is the one format that can end in a draw, and a draw pays each side {{fact:cricket-points.testDrawEach}}. A tie pays {{fact:cricket-points.testTieEach}} each. A Test that is abandoned is booked as a draw, so it pays {{fact:cricket-points.testAbandonedEach}} each, not as a no result.
- **Every other sport.** Cricket is the only one of the {{fact:cricket-points.sportCount}} sports whose league rules have a result called a tie or a no result. Football, ice hockey, hockey, chess, carrom, a generic division, volleyball, badminton, table tennis and tennis have neither. Where one of them allows a level match it is booked as a draw, and [how standings points work in each sport](/blog/how-standings-points-work) lists what each pays for it.

## Where you set it

On a cricket stage's card in the division's Fixtures tab, **Points** lists a separate line for a win, a loss, a tie and a no result, so each can be changed on its own. The super over is a match rule: it sits under **Match rules**, in the deciders section.

![The Points editor for a cricket stage with a line for a win, a loss, a tie and a no result](/help/blog/cricket-points-ties-no-results-1.webp "A cricket stage's Points editor pays a tie and a no result on lines of their own.")
