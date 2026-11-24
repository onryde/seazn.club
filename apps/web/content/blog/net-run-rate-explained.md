---
title: What is net run rate, and what happens to it after a forfeit?
description: Net run rate is runs per over scored minus runs per over conceded. A side bowled out counts its full overs, and a forfeit charges the defaulter alone.
date: 2026-11-23
author: Seazn
topic: tie-breaks
sports: cricket
help: sports/cricket
related: level-on-points-who-finishes-higher, cricket-points-ties-no-results, forfeits-and-walkovers-by-sport
examples: net-run-rate
---

Net run rate is a way to compare cricket sides that have won the same number of matches. It is the runs a side scored for every over it batted, minus the runs it conceded for every over it bowled. A side that wins big and wins fast has a high rate, and a side that is beaten badly has a low one. It exists in cricket alone: no other sport in Seazn has it in its list of checks.

The table below follows three sides through a T20 league. Tigers chased down the total that Lions were bowled out for, Bears beat Tigers, and then Bears did not turn up against Lions. Every side ends with one win, and net run rate alone puts them in order.

{{example:net-run-rate}}

## How the rate is worked out

Seazn adds up every run and every over first, and divides once at the end. For each side the table shows the runs it scored, the overs it faced, the runs it conceded and the overs it bowled, so the rate can be checked from the row. Tigers faced {{fact:net-run-rate.tigersOversFaced}} overs across their two matches, and their rate is {{fact:net-run-rate.tigersNetRunRate}}: they scored a little more per over than they conceded.

Scores read runs, then the wickets lost when the innings did not end all out, then the overs in brackets. The first match finished {{fact:net-run-rate.tigersBeatLions}}, home side first: Lions were bowled out for {{fact:net-run-rate.lionsRunsInTheirMatch}} in {{fact:net-run-rate.lionsOversLasted}} overs, and Tigers chased it down in {{fact:net-run-rate.tigersChaseOvers}}. The second finished {{fact:net-run-rate.bearsBeatTigers}}: Bears made their runs in a full innings and Tigers were bowled out early.

## An innings that ends early counts in two ways

A side that is bowled out counts as having faced its full {{fact:net-run-rate.inningsOvers}} overs, however few it lasted. Lions were bowled out in {{fact:net-run-rate.lionsOversLasted}} overs and are counted as having batted {{fact:net-run-rate.lionsOversInTheirMatch}}, and so is the side that bowled them out. A side that wins a chase with overs to spare is different: nobody was bowled out, so Tigers are counted for the {{fact:net-run-rate.tigersChaseOvers}} overs they used to reach the target. This is how the ICC counts it in the playing conditions of its T20 World Cup, and Seazn counts every limited-overs match that way.

The reason for counting the full overs when a side is bowled out is that a rate is runs divided by overs, and a collapse makes the overs small. A side bowled out quickly would otherwise show a fast rate for its short innings, and bowling a side out would not help the bowlers. Counting the full overs removes that: the side is charged for the overs it had and failed to use.

## After a forfeit, only the defaulter is charged

When a side does not turn up, nothing was played, so there are no real runs and no real overs. Seazn charges the side that defaulted a full innings of {{fact:net-run-rate.walkoverOversCharged}} overs at {{fact:net-run-rate.walkoverRunsCharged}} runs. That is why Bears' overs faced are {{fact:net-run-rate.bearsOversFaced}} although they batted in only one match: {{fact:net-run-rate.bearsOversInTheirMatch}} for the match they played, and {{fact:net-run-rate.walkoverOversCharged}} for the walkover. Their rate is {{fact:net-run-rate.bearsNetRunRate}}.

The charge falls on the batting side of Bears' record and nowhere else. Their runs conceded and overs bowled are what their one played match put there, and the walkover adds nothing to either.

The side given the match gains nothing in its rate. Lions were handed the match and are credited with {{fact:net-run-rate.walkoverOversToLions}} overs and no runs for it, so their overs faced stay {{fact:net-run-rate.lionsOversFaced}} and their rate stays {{fact:net-run-rate.lionsNetRunRate}}. They still earn the points for the win: {{fact:net-run-rate.lionsPoints}} points for {{fact:net-run-rate.levelWins}} win.

A Test match has no overs limit, so there is no full innings to charge and no overs to divide by. A forfeit in a Test is left out of net run rate, and the match counts for the result and the points only.

## Where net run rate sits in the order

Cricket sorts by points first, and then checks {{fact:net-run-rate.cricketOrder}}. Net run rate is step {{fact:net-run-rate.netRunRateStep}} of that list, counting points as the first, so it only comes into play for teams that are level on points and on wins. Here all three sides finish on {{fact:net-run-rate.levelPoints}} points with {{fact:net-run-rate.levelWins}} win each, so net run rate alone decides: {{fact:net-run-rate.tigersPlace}} Tigers at {{fact:net-run-rate.tigersNetRunRate}}, {{fact:net-run-rate.bearsPlace}} Bears at {{fact:net-run-rate.bearsNetRunRate}} and {{fact:net-run-rate.lionsPlace}} Lions at {{fact:net-run-rate.lionsNetRunRate}}.

## Where you set it

There is nothing to switch on: every cricket division counts the rate this way. The public table has an **NRR** column that shows each side's rate with its sign, such as {{fact:net-run-rate.lionsNetRunRate}}, and the results grid marks the forfeited match "w/o" instead of a score. The order itself is printed under the table on the division's **Standings** tab, as "Tie-break cascade", and it reads points, then {{fact:net-run-rate.cricketOrder}}. The stage's **Tie-breaks** button on the **Fixtures** tab edits it until the stage starts.

![A started cricket stage's Tie-breaks list: points, wins, net run rate, head-to-head, seeding and drawing of lots, under the note that the stage has started](/help/blog/net-run-rate-explained-1.webp "A cricket stage lists net run rate after points and wins; once the stage has started its card reads Locked: the stage has started.")
