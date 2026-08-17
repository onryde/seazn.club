---
title: Qualifying out of any stage
description: Feed the next stage from a bracket, a ladder or an americano — not just a league table. Includes plate competitions for first-round losers.
order: 5
---

A qualification spec used to need a table underneath it. A knockout, a ladder or an americano could finish, but nothing could be seeded *from* it — so a plate for the beaten sides, or a qualifying round feeding a main draw, had to be built by hand.

Any stage can now feed the next one.

**From a bracket.** When a knockout completes, its full finishing order is recorded — winner, runner-up, and every eliminated entrant ranked by how far they got. The next stage's `topN` reads that order exactly as it would read a league table.

**Losers of a round — the plate.** A plate takes the entrants knocked out early and gives them their own bracket. Set the plate stage's qualification to `losersOfRound: { round: 1, count: 4 }` — the losers of round one, in bracket order, with the number of places you want. The **KO + Plate** template does this for you.

Bracket rounds are labelled, not numbered in sequence: a losers' side and a grand final carry their own round numbers, so name the round you mean rather than counting forwards from one.

**From a ladder.** A ladder completes when no challenge is outstanding, and its standing order becomes the finishing order. A ladder whose challenges are still live will not complete — the order isn't settled yet.

**From an americano.** Individuals are ranked on personal points across the rotation, and the top N carry into the next stage as individual entrants.

## The two new templates

**KO + Plate** — a main knockout, plus a plate for the first-round losers. Everyone gets a second competition; nobody travels for one match.

**Qualifying + Main** — a qualifying knockout whose survivors seed the main draw. Useful when entries outgrow the bracket you want to run.

## Carrying points forward

Carry-over moves accumulated points from one stage into the next, and only makes sense from a stage that kept a table. A bracket, ladder or americano source records a finishing order rather than points, so carry-over is refused there rather than silently carrying zeroes.
