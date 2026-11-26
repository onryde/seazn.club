---
title: How is a round-robin schedule made, and what happens with an odd number of teams?
seoTitle: Round-robin schedules: what happens with an odd number of teams?
description: Every team meets every other once. With an odd number of teams one team rests each round, so the league needs one more round than each team has opponents.
date: 2026-11-23
author: Seazn
topic: round-robin
sports: all
help: formats/league
related: groups-into-knockout, withdrawal-in-a-league, joining-a-league-late, how-standings-points-work
examples: round-robin-schedule
---

Every team plays every other team once, and nobody plays twice in a round. With an even number of teams everyone plays in every round. With an odd number, one team has nobody to play in each round and sits it out, and every team sits out exactly once. That is why {{fact:round-robin-schedule.fieldSize}} teams need {{fact:round-robin-schedule.rounds}} rounds: one more than the {{fact:round-robin-schedule.opponentsEach}} opponents each of them has.

## The circle

One place in the draw never moves. The other teams sit in a loop around it, and after every round they all move one place along. Because each team lands opposite a different team every time, no two teams meet twice, and by the time the loop has come all the way round everyone has met everyone.

The teams are placed in the order of their seeds, so the seeds decide which round a pair meets in and never whether they meet. Here is a league of {{fact:round-robin-schedule.fieldSize}} teams, listed best seed first, with the picture of its first round.

{{example:round-robin-schedule}}

## An odd number of teams

The loop only works with an even number of places, so an odd field gets one more place: an empty seat. The empty seat is the one that stays where it is, and whoever sits opposite it in a round has no opponent and rests. In the first round the matches are {{fact:round-robin-schedule.firstLegRoundOne}}, and the team left over rests. Over the {{fact:round-robin-schedule.rounds}} rounds the empty seat is opposite every team once, which is why each of them rests exactly once.

Add a team to make the field even and the empty seat goes. A field of {{fact:round-robin-schedule.evenFieldSize}} still plays {{fact:round-robin-schedule.evenRounds}} rounds, with {{fact:round-robin-schedule.evenMatchesPerRound}} matches in every round and nobody resting. The extra team adds a match to each round and no round to the season.

## How many matches

Each of the {{fact:round-robin-schedule.fieldSize}} teams plays {{fact:round-robin-schedule.opponentsEach}} others, and every match has two teams in it, so the matches are counted twice if you add up what the teams play. Halve it and the {{fact:round-robin-schedule.fieldSize}} teams play {{fact:round-robin-schedule.matches}} matches, {{fact:round-robin-schedule.matchesPerRound}} a round. {{fact:round-robin-schedule.evenFieldSize}} teams play {{fact:round-robin-schedule.evenMatches}}. The count grows faster than the field does.

## Home and away

A team that hosts more often than it travels has an edge, so the schedule keeps the two counts close. In the {{fact:round-robin-schedule.fieldSize}}-team league every team plays {{fact:round-robin-schedule.homeEach}} at home and {{fact:round-robin-schedule.awayEach}} away. With {{fact:round-robin-schedule.evenFieldSize}} teams each plays {{fact:round-robin-schedule.evenOpponentsEach}} matches, so an even split is impossible: every team has {{fact:round-robin-schedule.evenHomeFewest}} or {{fact:round-robin-schedule.evenHomeMost}} of them at home and the rest away.

## A second leg

A league can be played twice. The second leg repeats the first with home and away turned round, so the first round of the second leg is {{fact:round-robin-schedule.secondLegRoundOne}}, the first round's matches the other way up. Two legs of the {{fact:round-robin-schedule.fieldSize}}-team league are {{fact:round-robin-schedule.twoLegRounds}} rounds and {{fact:round-robin-schedule.twoLegMatches}} matches.

## In every sport

The schedule is built from the list of teams and nothing else, so it is the same in all {{fact:round-robin-schedule.sportCount}} sports. What a sport changes is what a finished match is worth in the table, which is what [how standings points work](/blog/how-standings-points-work) is about.
