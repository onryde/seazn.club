---
title: Can a player join or leave a Swiss tournament after round one?
description: Yes. A late player scores nothing for the rounds they missed, and a player who leaves keeps their results while later rounds are paired without them.
date: 2026-11-23
author: Seazn
topic: swiss
sports: all
help: divisions/lifecycle
related: how-swiss-pairing-works, swiss-chess-bye, knockout-seeds-and-byes
examples: swiss-late-and-withdraw
---

Yes, both. A Swiss is paired one round at a time, so a player can join late or leave early without breaking it. A late player scores nothing for the rounds they missed and is paired from their first round on. A player who leaves keeps every result already played, their opponent in the round they were already paired for wins without playing, and the rounds after that are paired without them.

## Why a Swiss takes it in its stride

A round robin fixes its matches in advance. A newcomer needs extra matches to catch up, and a team that leaves halfway has played some opponents and not others. A Swiss has no fixed schedule. Each round is paired from the field and the scores at that moment, so a player who arrives is simply one more name in the next pairing, and a player who leaves is one fewer.

Here is a {{fact:swiss-late-and-withdraw.roundCount}}-round chess Swiss that starts with {{fact:swiss-late-and-withdraw.playerCount}} players, listed best seed first. {{fact:swiss-late-and-withdraw.leaverName}} leaves once round {{fact:swiss-late-and-withdraw.leaverRound}} has been paired, and {{fact:swiss-late-and-withdraw.lateName}} joins from round {{fact:swiss-late-and-withdraw.lateFirstRound}}.

{{example:swiss-late-and-withdraw}}

## Joining late

{{fact:swiss-late-and-withdraw.lateName}} missed {{fact:swiss-late-and-withdraw.lateMissedRounds}} rounds, and starts on {{fact:swiss-late-and-withdraw.lateScoreBeforeFirst}} points. That is the chess federation's rule for a late entrant: a round you were not there for earns nothing. Giving a newcomer points for games they never played would put them ahead of players who played and lost.

From their first round, a late player is paired like everyone else, from the place their score puts them. In the tie-breaks, a missed round counts as a round not played, the way the chess federation's tie-break rules treat it.

## Which round a late player joins

When the organiser adds a player, it depends on how far the round that is already paired has gone.

- **Nothing in the round has started.** The round is paired again with the newcomer in it. A round nobody has begun costs nobody a game to re-pair.
- **A board has started, and the round has a bye.** The newcomer plays the player who has the bye. Nothing else moves.
- **Anything else.** The round is left as it is, and the newcomer joins from the next round.

Players who arrive without the organiser pressing anything, such as a paid registration, a player promoted from a waiting list or an import, always take the last case. Nothing the organiser did not do moves a pairing that is already published.

The first two cases are deliberate differences from the chess federation, whose handling rules say published pairings are not changed and a late entrant joins the next round. Seazn lets the organiser re-pair a round that has not started, or seat the newcomer against the player who has the bye, because neither costs anybody a game. In every other case it follows the federation's rule.

Once the last round has started and no bye is left to play, there is no round left to join, and the app says so ("The last round has started, so there is no round left to join."). Under that message the organiser is offered "Add a round", and once the round is added ("Add the player again to seat them in it") the player is added again and joins from the new round. When the Swiss has been finished, the Entrants tab is locked: "no one new can be added".

## Leaving

{{fact:swiss-late-and-withdraw.leaverName}} played round 1, and that result stays: {{fact:swiss-late-and-withdraw.leaverName}} ends on {{fact:swiss-late-and-withdraw.leaverTotal}}. Striking it would change the score of {{fact:swiss-late-and-withdraw.leaverName}}'s opponent after the fact, and the tie-breaks of everyone who played either of them would move too. On the Standings tab the player stays in the table, tagged as withdrawn, with the results that still count.

A round that is already paired is not paired again when someone leaves, so {{fact:swiss-late-and-withdraw.walkoverWinner}}, who was paired with {{fact:swiss-late-and-withdraw.leaverName}}, wins that board without playing. From the next round, the {{fact:swiss-late-and-withdraw.regularsAfterLeaving}} players still in and {{fact:swiss-late-and-withdraw.lateName}} make a field of {{fact:swiss-late-and-withdraw.fieldAfterLeaving}}, and the pairing leaves {{fact:swiss-late-and-withdraw.leaverName}} out.

## In every sport

These two rules do not depend on the sport. The Swiss format is offered in all {{fact:swiss-late-and-withdraw.sportCount}} sports. Which round a late player joins reads nothing about the sport, and a player who leaves hands their opponent a win in every sport, worth what a win is worth there.
