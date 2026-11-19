---
title: Scoring basics
description: Start the division, open a fixture, use its pad. Every entry reaches the standings as it is made.
order: 1
related: scoring/corrections, scoring/lineups, scoring/fidelity, scoring/knockout-deciders
---

You score a match on its **pad**, the panel of tiles on the fixture page. The pad is built for the sport, and every entry reaches the standings and the public page as you make it.

## Pick your sport

- [Tennis](/help/sports/tennis): points, games and sets, with advantage and tie-breaks worked out for you.
- [Badminton](/help/sports/badminton), [table tennis](/help/sports/tabletennis) and [volleyball](/help/sports/volleyball): rally by rally, with the serve worked out from what you have already recorded.
- [Cricket](/help/sports/cricket): ball by ball, with overs and wickets.
- [Football](/help/sports/football): goals, cards, substitutions and shoot-outs.
- [Field hockey](/help/sports/hockey): quarters, cards that leave a team short, penalty corners and shoot-outs. [Ice hockey](/help/sports/icehockey) has its own page for assists, overtime and game-winning shots, and [ice hockey penalties](/help/sports/icehockey-penalties) another for the penalty box.
- [Carrom](/help/sports/carrom): a board at a time, coins and the queen.
- [Chess and other board games](/help/sports/chess): who won, and how it ended.
- [Everything else](/help/sports/generic): a running tally you tap during play, or a plain result at the end.

## The flow

Scoring opens when you **start** the division. See [why starting locks setup](/help/divisions/lifecycle).

1. Set each side's [lineup](/help/scoring/lineups) before the match starts. Pick a [detail level](/help/scoring/fidelity) if you do not want the default.
2. Open the fixture from the fixtures tab, the board, or **My matches & teams** if you are an [official](/help/scoring/scorer-role).
3. Press **Start match**.
4. Enter points as they happen, or only the final score at the end. You can [credit a player](/help/scoring/attribution) as you go, or skip it.
5. Finalize the match when it is over.

## If you make a mistake

Results are an append-only ledger. You do not erase an entry, you void it. See [fixing a mistake](/help/scoring/corrections).

## If a match is abandoned

**Abandon** ends a match that cannot be finished (rain, floodlights, an incident). You type a reason and press **Apply**. What the match counts as depends on the stage and on the **If a match is abandoned** setting in Match rules. Which options you see depends on the sport.

| Setting | What it does | Sports that offer it |
|---|---|---|
| **Replay the match** | Nobody is decided. The fixture is held and marked **Needs a decision**. | football, field hockey, ice hockey, carrom, generic |
| **Result stands** | The score at the moment of the abandon is the result. If the score is level and the sport will not take a draw there, the match is held. | football, field hockey, ice hockey |
| **Result stands from the 4th quarter, otherwise replay** | Counts only when the abandon came in the last quarter. | field hockey |
| **Share the points** | The match counts as a draw. | carrom, generic |

Badminton, tennis, table tennis, volleyball and chess do not have the setting: an abandoned match is held. A cricket abandon in limited overs is recorded as **no result** and the fixture is decided with no winner. An abandoned Test (two innings a side) is a draw, and an abandoned super over leaves the tie standing. The exception is a limited-overs chase with **DLS revised targets** on, where the chasing side has faced at least the **Minimum overs for a result**: the DLS par then decides the abandoned match, a win for either side, or a tie if the chasing side is exactly level with par.

Replay is the default where there is a choice, with one exception: field hockey's FIH shoot-out variant defaults to **Result stands from the 4th quarter, otherwise replay**. Football in particular does not keep the score unless you switch the setting to **Result stands**. **Share the points** needs draws to be possible. In generic, switch on **Allow draws**. In carrom, set **Game tied at max boards** to **Drawn game**. Without that the setting will not save.

Two things follow from the stage the match is in:

- **Knockout, double elimination, page playoff, stepladder, ladder:** A bracket cannot end level, so sharing is ignored and an abandoned match is always held. Open it and press **Settle the match** to pick who advances, or use **Void last entry** on the abandon to play the match on.
- **League, group, Swiss, americano:** A shared or standing result is simply a result. A match that decided nobody is held, and **Settle the match** records who won. In a Swiss stage the next round is not drawn while an abandoned board is unsettled, and the message names the round and the board.

If a player withdraws while one of their boards is waiting, the withdrawal report lists that board as left to you. Settle it for the opponent (the withdrawn player cannot be chosen as the winner), or void the abandon.

> **Example**
> A league football match is 1-0 to Hawks when rain stops play. With the default **Replay the match**, the match is held and nobody gets points. Change the setting to **Result stands** before the match and the same abandon gives Hawks the win. A carrom match with **Share the points** gives both players the draw points.

## Common questions

**Two people scored the same match at once?** Both entries land. See [score conflicts](/help/scoring/conflicts).

**No signal at the venue?** Entries queue on the device. See [scoring without signal](/help/scoring/offline-scoring).
