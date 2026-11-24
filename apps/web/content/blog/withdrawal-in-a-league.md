---
title: What happens to a team's results when it withdraws from a league?
description: A team that leaves before half its matches are played has every result removed. After half, its results stand and the rest become walkovers.
date: 2026-11-23
author: Seazn
topic: withdrawal
sports: all
help: entrants/withdrawals
related: withdrawal-in-a-knockout, joining-a-league-late, clinched-or-eliminated, forfeits-and-walkovers-by-sport
examples: withdrawal-in-a-league
---

When a team leaves a league, some of its matches are played and some are not. Seazn has to decide what to do with both, and the answer has to be fair to everyone else in the table. It depends on how much of the schedule the team has played. If fewer than half of its matches are played, every result of the team is removed, and the table reads as if it had never played a match. If half or more are played, the results stand and each match still to play is a walkover for the other team.

## The example

Here are {{fact:withdrawal-in-a-league.teams}} football teams, listed best seed first: {{fact:withdrawal-in-a-league.signUpOrder}}. Each plays {{fact:withdrawal-in-a-league.matchesEach}} matches. The same league is run twice. In one, {{fact:withdrawal-in-a-league.leaver}} withdraw after round {{fact:withdrawal-in-a-league.earlyRound}}. In the other, they withdraw after round {{fact:withdrawal-in-a-league.lateRound}}. The matches between the other teams, and their scores, are the same in both.

{{example:withdrawal-in-a-league}}

## Fewer than half: the team is taken out

After round {{fact:withdrawal-in-a-league.earlyRound}}, {{fact:withdrawal-in-a-league.leaver}} have played {{fact:withdrawal-in-a-league.earlyPlayed}} of their {{fact:withdrawal-in-a-league.earlyTotal}} matches. Half would be {{fact:withdrawal-in-a-league.half}}, so this is under half, and their matches are {{fact:withdrawal-in-a-league.earlyMode}}: all of them, including the one already played. {{fact:withdrawal-in-a-league.leaver}} stay in the table with {{fact:withdrawal-in-a-league.leaverEarlyPlayed}} played and {{fact:withdrawal-in-a-league.leaverEarlyPoints}} points, and nothing they did counts for anybody. Under the table Seazn prints one line to say so: "{{fact:withdrawal-in-a-league.earlyNote}}"

That includes {{fact:withdrawal-in-a-league.firstOpponent}}'s win over them in round 1. It is removed, and {{fact:withdrawal-in-a-league.firstOpponent}} finish on {{fact:withdrawal-in-a-league.firstOpponentPointsEarly}} points.

## Half or more: the results stand

After round {{fact:withdrawal-in-a-league.lateRound}}, {{fact:withdrawal-in-a-league.leaver}} have played {{fact:withdrawal-in-a-league.latePlayed}} of {{fact:withdrawal-in-a-league.lateTotal}}. That is exactly half, and half counts: the rule's line is "fewer than half", so a team that has played half is not taken out. Their played results stand. Their remaining matches, in rounds {{fact:withdrawal-in-a-league.walkoverRounds}}, are walkovers, and the opponents, {{fact:withdrawal-in-a-league.walkoverWinners}}, are given the win. The line under the table now reads: "{{fact:withdrawal-in-a-league.lateNote}}"

Now {{fact:withdrawal-in-a-league.firstOpponent}}'s win over {{fact:withdrawal-in-a-league.leaver}} counts, and {{fact:withdrawal-in-a-league.firstOpponent}} finish on {{fact:withdrawal-in-a-league.firstOpponentPointsLate}} points: a win more than when it was removed.

## Everyone is compared on the same matches

In the first case the other teams each have {{fact:withdrawal-in-a-league.earlyCounted}} matches in the table, because their match against {{fact:withdrawal-in-a-league.leaver}} is gone. In the second case they each have {{fact:withdrawal-in-a-league.lateCounted}}, because every match against {{fact:withdrawal-in-a-league.leaver}} still counts, played or walked over. Either way the teams that are left are measured on the same number of matches, which is what makes the table fair to read. The two cases give the same team different points, so the moment a team leaves matters.

## In every sport

When a withdrawal is settled by walkovers, the opponent is given the win in all {{fact:withdrawal-in-a-league.sportCount}} sports. Each sport pays a walkover in its own way, which [forfeits and walkovers by sport](/blog/forfeits-and-walkovers-by-sport) shows. What the sport changes is the score of the walkover, and the half-way line is the same in all of them.
