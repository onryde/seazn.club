---
title: How does a Swiss tournament decide who plays whom?
description: Each round pairs players on the same score, never twice against the same opponent, and moves as few players as it can to a neighbouring score.
date: 2026-11-23
author: Seazn
topic: swiss
sports: all
help: formats/swiss
related: swiss-chess-bye, joining-or-leaving-a-swiss, knockout-seeds-and-byes
examples: swiss-pairing
---

A Swiss pairs each round from the scores so far. Players on the same score meet each other, and nobody meets the same opponent twice. When a score group cannot be paired inside itself, as few players as possible move to the score next to theirs. Nobody is knocked out, and after a few rounds the players at the top have played each other.

## Why pair by score

A round robin gives the fairest ranking, because everyone plays everyone. It also needs a round for almost every player in the field. A Swiss gets close to that fairness in far fewer rounds. Winners meet winners, so every round splits the leaders further. Players who lose early meet each other too, so they still get even games.

Here is a small chess Swiss: {{fact:swiss-pairing.playerCount}} players, seeded in order, over {{fact:swiss-pairing.roundCount}} rounds.

{{example:swiss-pairing}}

## Reading the example

Round 1 has no scores yet, so the seeds decide it. The top half of the field plays the bottom half: the best seed meets the best of the lower half on board 1, and so on down the boards. That keeps the strongest players apart for the first round, the way a knockout keeps its top seeds apart.

After round 1, {{fact:swiss-pairing.r2TopPair}} are level at the top, on {{fact:swiss-pairing.r2TopScore}} each, so they meet on the top board in round 2. {{fact:swiss-pairing.r1DrawPair}} are the only players on {{fact:swiss-pairing.r1DrawScore}}, but they drew with each other in round 1. They cannot meet again, so each one is paired with a player from the score below. Moving a player to another score like this is called a float.

## Top against bottom, or neighbours

Inside a score group there is a choice of how to pair. Line the group up, best first. The default is top half against bottom half: the best plays the first player of the lower half, the next plays the second player of the lower half, and so on down. It is the pairing used in round 1, and it keeps the strongest players apart for as long as the scores allow. The other choice is neighbours, where the best plays the next best, the third plays the fourth, and so on. Seazn offers both when round 1 is paired, as "Top vs bottom" and "Neighbours", and the choice cannot be made in a later round.

## The rules behind each pairing

- **No rematches.** A second game between the same two players tells you less than a game against someone new. In a short event, every game against a new opponent counts.
- **As few floats as possible.** A float pairs players on different scores, which is less fair to both. The pairing looks for the arrangement that keeps the most players inside their own score group.
- **The next round must still work.** When a Swiss is set to more rounds than half the number of players, a careless pairing can leave a later round with no legal way to pair. Before it seats such a round, Seazn checks that the round after it can still be paired, and prefers a pairing that keeps it possible.
- **All or nothing.** A round that cannot be paired at all is refused as a whole, never half seated.
- **Players without a seed are drawn.** Round 1 places seeded players by seed and the rest by a draw, so the order people signed up in never decides a pairing.

## Chess and the other sports

The pairing works the same in every sport: the Swiss format is offered in all {{fact:swiss-pairing.sportCount}} sports, from football to table tennis.

Chess adds one thing, colours. Playing White is an advantage, so the pairing keeps each player's colours balanced. Nobody plays more than two more games with one colour than with the other, and nobody plays the same colour three times in a row. There is one exception, and it only applies in the last round: a player who has scored more than half of the most they could have, one of the leaders, may be given the colour that breaks those limits, so that two leaders are not kept apart over colours. In round 1 a lot decides which colour the player on board 1 takes, and the colours alternate down the boards. In the example the higher seed has White on every other board for that reason.
