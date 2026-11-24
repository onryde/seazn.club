---
title: Set ratio or set difference: which does my sport use?
description: Set difference is sets won minus sets lost; set ratio is sets won divided by sets lost. The same results can rank players differently under each.
date: 2026-11-23
author: Seazn
topic: tie-breaks
sports: all
help: sports/volleyball
related: level-on-points-who-finishes-higher, three-way-tie-head-to-head, why-matches-won-come-first
examples: set-ratio-or-difference
---

When players finish level on matches won, the sets or games they won and lost are one of the checks the list reaches soon after, though not always the very next one: badminton looks at the match between two level players first, and tennis counts matches played before it counts sets. There are two ways to count them. Set difference is sets won minus sets lost. Set ratio is sets won divided by sets lost. Each sport follows the rulebook of its own governing body, and the rulebooks do not agree, so the same results can rank two players differently depending on the sport.

The table below is badminton, which ranks by set difference. Cy, Ana and Ben each win the same number of matches, and the last two columns show the order badminton uses and the order the same results would give with set ratio instead. Badminton counts games, so its table says "Games won" and "Games lost" where the measures are named for sets; the section on words below says why.

{{example:set-ratio-or-difference}}

## Reading the table

Cy, Ana and Ben each win {{fact:set-ratio-or-difference.levelWins}} matches, so matches won cannot separate them. Badminton's order then looks at the set difference, and the first thing to notice is that Cy and Ana are level on it, Cy with {{fact:set-ratio-or-difference.cySetDifference}} and Ana with {{fact:set-ratio-or-difference.anaSetDifference}}. Ben has {{fact:set-ratio-or-difference.benSetDifference}}, so Ben finishes {{fact:set-ratio-or-difference.benPlaceOwn}}. Cy and Ana are separated by the match between the two, which Cy won, {{fact:set-ratio-or-difference.cyBeatAna}}: Cy finishes {{fact:set-ratio-or-difference.cyPlaceOwn}} and Ana {{fact:set-ratio-or-difference.anaPlaceOwn}}. The split is on {{fact:set-ratio-or-difference.ownSplitBy}}.

Count the same sets as a ratio and the picture changes. Ana's record gives a ratio of {{fact:set-ratio-or-difference.anaSetRatio}} and Cy's gives {{fact:set-ratio-or-difference.cySetRatio}}, so Ana finishes {{fact:set-ratio-or-difference.anaPlaceRatio}} and Cy {{fact:set-ratio-or-difference.cyPlaceRatio}}, and the split is on {{fact:set-ratio-or-difference.ratioSplitBy}}. Ben, at {{fact:set-ratio-or-difference.benSetRatio}}, finishes {{fact:set-ratio-or-difference.benPlaceRatio}} either way. Dev has the worst record under both and finishes {{fact:set-ratio-or-difference.devPlaceOwn}} in the first order and {{fact:set-ratio-or-difference.devPlaceRatio}} in the second.

## Why the two disagree

A difference counts the margin. A ratio counts the proportion. Cy and Ana have the same margin, but Ana reached it having lost fewer sets, so she won a larger share of the sets she played. The difference does not see that. It treats a player who won many sets and lost many as equal to one who won few and lost few, as long as the gap is the same. The ratio sees it, and rewards the player who got there with fewer sets lost.

Neither is the better measure in general. Which one a sport uses was settled by its governing body, and Seazn follows the body.

## What each sport uses

Badminton follows the BWF's competition regulations: matches won, then the match between two level players, and for three or more the set difference and then the point difference. Volleyball follows FIVB, which uses ratios. Table tennis follows the ITTF, which also uses ratios, but works them only among the players who are level. Tennis follows the ATP's rule for round robins, which checks matches won and matches played before the ratios.

- **Football:** {{fact:set-ratio-or-difference.footballMeasures}}.
- **Cricket:** {{fact:set-ratio-or-difference.cricketMeasures}}.
- **Chess:** {{fact:set-ratio-or-difference.boardgameMeasures}}.
- **Carrom:** {{fact:set-ratio-or-difference.carromMeasures}}.
- **A generic division:** {{fact:set-ratio-or-difference.genericMeasures}}.
- **Volleyball:** {{fact:set-ratio-or-difference.volleyballMeasures}}.
- **Badminton:** {{fact:set-ratio-or-difference.badmintonMeasures}}.
- **Table tennis:** {{fact:set-ratio-or-difference.tabletennisMeasures}}.
- **Tennis:** {{fact:set-ratio-or-difference.tennisMeasures}}.
- **Ice hockey:** {{fact:set-ratio-or-difference.icehockeyMeasures}}.
- **Hockey:** {{fact:set-ratio-or-difference.hockeyMeasures}}.

## Sets, games and the words on each screen

{{fact:set-ratio-or-difference.gameSports}} count games where {{fact:set-ratio-or-difference.setSports}} count sets, and the product uses two sets of words for the same step. The organiser's editor, the stage card and the division builder name the step in the sport's own unit, so for badminton they read "{{fact:set-ratio-or-difference.editorDifference}}" and "{{fact:set-ratio-or-difference.editorRatio}}". The Standings tab and the public table's "split on" line say "{{fact:set-ratio-or-difference.standingsDifference}}" and "{{fact:set-ratio-or-difference.standingsRatio}}" for every one of these sports. Badminton's public table prints the counts as "Games won" and "Games lost". Carrom adds boards between sets and points. Tennis has sets and games.

## Where you set it

The measure is one step in the sport's list of checks. The division's **Standings** tab prints the list under the table as "Tie-break cascade", and the stage's **Tie-breaks** button on the **Fixtures** tab edits it until the stage starts. The public table shows, beside a player who was separated from another, "Tied with" and the other players, and "split on" followed by the check that separated them: "split on set difference" under badminton's own order, and "split on set ratio" where a stage uses the ratio.

![The Tie-breaks list of a started badminton stage: wins, game difference, point difference and drawing of lots, with a note that two players still level are split by their head-to-head result](/help/blog/set-ratio-or-set-difference-1.webp "In the organiser's editor a badminton stage names the step game difference, and notes that two players still level at any step are split by their match.")
