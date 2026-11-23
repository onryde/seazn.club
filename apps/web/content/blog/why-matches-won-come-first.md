---
title: Why do volleyball, badminton and tennis tables rank by matches won?
description: These sports count matches won before points, so a team with more points can sit below a team that won more matches.
date: 2026-11-23
author: Seazn
topic: points
sports: volleyball, badminton, tennis
help: sports/volleyball
related: how-standings-points-work, set-ratio-or-set-difference, level-on-points-who-finishes-higher
examples: matches-won-first
---

Because the match is the result that counts in these sports. Points can be paid by the score of the match, so a team can collect more points from narrow results than another team collects from wins. Ranking on matches won first means a team that wins more matches always sits above one that wins fewer, whatever the points say. The rulebooks of the three sports rank their round-robin tables this way, and Seazn follows them.

{{example:matches-won-first}}

## Reading the table

Four indoor volleyball teams play each other once. The six matches were: {{fact:matches-won-first.matchList}}. The same results are ranked twice, once with matches won first, as the rules of the sport say, and once with points first, to show what would change.

Look at Blues and Reds. Reds have {{fact:matches-won-first.redsPoints}} points and Blues have {{fact:matches-won-first.bluesPoints}}, so on points Reds are ahead. But Blues won {{fact:matches-won-first.bluesWon}} matches and Reds won {{fact:matches-won-first.redsWon}}. With matches won first, Blues are in place {{fact:matches-won-first.bluesPlaceWins}} and Reds in place {{fact:matches-won-first.redsPlaceWins}}. With points first, Reds would be in place {{fact:matches-won-first.redsPlacePoints}} and Blues in place {{fact:matches-won-first.bluesPlacePoints}}. The order is {{fact:matches-won-first.winsFirstOrder}} with matches won first, and {{fact:matches-won-first.pointsFirstOrder}} with points first.

How did it happen? In indoor volleyball the score decides the points. A clean win, in straight sets, pays the winner **{{fact:matches-won-first.indoorWinThree}}** points. A win that goes the distance pays the winner less, and the side that loses it still earns something. Blues won twice but both wins went the distance. Reds won once, cleanly, and earned points in their two narrow defeats.

## What changes from sport to sport

- **Volleyball.** Matches won come first. Indoor volleyball pays by the score of the match, which is how a team can have more points and a lower place. Beach volleyball pays a flat amount for a win, so for beach the two orders agree.
- **Badminton and tennis.** Matches won also come first, and a win pays the same whatever the score, so more matches won always means more points and the two orders agree.
- **Everything else.** Football, cricket, ice hockey, hockey, chess, carrom, a generic division and table tennis do not rank on matches won first. Table tennis is a set-based sport too, but it pays a played loss, which is why it ranks on points: [why a table tennis loss still earns a point](/blog/table-tennis-loss-still-scores).

Of the {{fact:matches-won-first.sportCount}} sports, {{fact:matches-won-first.sportsWinsFirst}} put matches won first: {{fact:matches-won-first.winsFirstList}}. Of those, only {{fact:matches-won-first.whereOrdersCanDiffer}} can pay a team more points for fewer wins. {{fact:matches-won-first.alwaysAgreeList}} cannot: a team's points always follow its wins there.

## Where you set it

The order is a tie-break rule, and it sits on a stage's card in the division's Fixtures tab under **Tie-breaks**. In these sports the editor marks matches won as always first, and lists points and the set and point ratios after it. The picture shows volleyball's order, with a summary line that says how a straight-sets win is paid and that ties go to wins and then to points.

![The Tie-breaks editor for a volleyball stage, with matches won marked as always first and points second](/help/blog/why-matches-won-come-first-1.webp "In volleyball the Tie-breaks editor locks matches won in first place and lists points second.")
