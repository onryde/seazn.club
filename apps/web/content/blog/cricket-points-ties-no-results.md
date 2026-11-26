---
title: How many points does a cricket team get for a tie or a washed-out match?
seoTitle: Cricket points for a tied or washed-out match
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

A tie can be turned into a win. When the stage plays a super over on a tie, the winner of the super over wins the match: they get {{fact:cricket-points.superOverWinner}} and the other side gets {{fact:cricket-points.superOverLoser}}, and that match is booked as a win and a loss, not a tie. With the super over off, the scorer's pad ends a tied match as tied straight away. The rules editor also lets you choose what happens if the super over is tied as well: another super over (the scorer's pad plays one when the setting is left alone), most boundaries wins, or leave it as a tie, which pays each side {{fact:cricket-points.tieEach}}.

## A washed-out match

Rain makes a no result unless DLS can decide the match. DLS, the Duckworth-Lewis-Stern method, revises the target of an interrupted match. It stays off unless the organiser switches it on in the rules editor, so by default an abandoned limited-overs match is a no result. With DLS on, a second setting applies: the fewest overs the chasing side must face before DLS can decide an abandoned match, and in the editor's own words, fewer is a no result. Either way, a match that ends as a no result pays each side {{fact:cricket-points.noResultEach}}.

## What changes from format to format

- **The limited-overs formats.** {{fact:cricket-points.limitedOversList}} all pay the same: a win {{fact:cricket-points.winWinner}}, a tie {{fact:cricket-points.tieEach}} each, no result {{fact:cricket-points.noResultEach}} each.
- **Test match.** A win pays {{fact:cricket-points.testWinWinner}} to {{fact:cricket-points.testWinLoser}}. A Test is the one format that can end in a draw, and a draw pays each side {{fact:cricket-points.testDrawEach}}. A tie pays {{fact:cricket-points.testTieEach}} each. A Test that is abandoned is booked as a draw, so it pays {{fact:cricket-points.testAbandonedEach}} each, not as a no result.
- **Every other sport.** Cricket is the only one of the {{fact:cricket-points.sportCount}} sports whose league rules have a result called a tie or a no result. {{fact:cricket-points.withoutTieOrNoResultList}} have neither. Where one of them allows a level match it is booked as a draw, and [how standings points work in each sport](/blog/how-standings-points-work) lists what each pays for it. (An online chess board in a league that the organiser marks as No result earns neither player any points.)

## Where you set it

On a cricket stage's card in the division's Fixtures tab, **Points** lists a separate line for a win, a loss, a tie and a no result, so each can be changed on its own. The super over is a match rule: it sits under **Match rules**, in the deciders section.

![The Points editor for a cricket stage with a line for a win, a loss, a tie and a no result](/help/blog/cricket-points-ties-no-results-1.webp "A cricket stage's Points editor pays a tie and a no result on lines of their own.")
