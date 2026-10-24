---
title: Scoring basics
description: Start the division, open a fixture, use its pad — every point flows to standings live.
order: 1
---

Scoring opens when you **start** the division ([why starting locks setup](/help/divisions/lifecycle)). From then on, every fixture has a score pad tuned to its sport:

- [Tennis](/help/scoring/tennis) — points, games and sets, with deuce and tie-breaks handled for you.
- [Badminton](/help/scoring/badminton), [table tennis](/help/scoring/tabletennis) and [volleyball](/help/scoring/volleyball) — rally by rally, with the serve worked out from what you've already recorded.
- [Cricket](/help/scoring/cricket) — ball by ball, overs and wickets.
- [Football](/help/scoring/football) — goals, cards, substitutions and shoot-outs.
- [Field hockey](/help/scoring/hockey) — quarters, cards that make the team play short, penalty corners and shoot-outs. [Ice hockey has its own page](/help/scoring/icehockey) for assists, the penalty ladder and game-winning shots.
- [Carrom](/help/scoring/carrom) — a board at a time, coins and the queen.
- [Chess](/help/scoring/boardgame) — who won, and how it ended.
- [Everything else](/help/scoring/generic) — a running tally you tap during play, or a plain result at the end.

## The flow

1. Set each side's [lineup](/help/scoring/lineups) — starters, bench, roles — and pick a [detail level](/help/scoring/fidelity) if the default isn't what you want.
2. Open the fixture (from the fixtures tab, the board, or *My matches* for scorers).
3. **Start** the match, enter points as they happen — or just the final score at the end. Credit an event to a player as you go, or skip it — see [crediting the player](/help/scoring/attribution).
4. **Finalize** when it's done. Standings, progression and public dashboards update on every entry.

## Corrections

Results are an append-only ledger: fixing a mistake undoes the entry rather than erasing history, so a disputed scoreline can always be reconstructed. See [fixing a mistake](/help/scoring/corrections) for how undo works and its one ordering caveat.

## If a match is abandoned

**Abandon** ends a match that can't be finished (rain, floodlights, an incident). What it counts as depends on the stage and on the sport's **If a match is abandoned** setting in Match rules:

- **Replay the match** — nobody is decided. The match stays out of the table (nothing is credited) and is marked **Needs a decision** until you act.
- **Share the points** (generic and carrom) — the abandoned match counts as a draw, so both sides take the draw points. It needs draws to be possible: switch on **Allow draws** (generic), or set **Game tied at max boards** to **Drawn game** (carrom), or the setting won't save.
- **Result stands** (football and others) — the score at the moment of the abandon is the result, where the sport allows it.

Two things follow from the stage the match is in:

- **Knockout, double elimination, page playoff, stepladder, ladder:** a bracket can't end level, so the sharing setting is ignored there and an abandoned match is always held. Open it and press **Settle the match** to pick who advances (by lot, higher seed, or your own decision), or use **Void last entry** on the abandon to play the match on.
- **League, group, Swiss, americano:** a shared or standing result is simply a result. A match that decided nobody is held too, and **Settle the match** records who won. In a **Swiss** stage that matters: the next round isn't drawn while an abandoned board is unsettled, and the message names the round and board to settle.

If a player withdraws while one of their boards is waiting, the withdrawal report lists that board as left to you — settle it for the opponent (the withdrawn player can't be chosen as the winner), or void the abandon.

## Common questions

**Two people scored the same match at once?** The second entry is rejected and refreshed rather than silently overwriting — see [score conflicts](/help/scoring/conflicts).

**Offline venue?** Entries queue on the device and send once signal returns — see [scoring without signal](/help/scoring/offline-scoring).
