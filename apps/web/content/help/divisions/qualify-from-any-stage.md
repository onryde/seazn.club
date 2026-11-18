---
title: Qualifying out of any stage
description: Feed the next stage from a bracket, as well as from a table. Plates and qualifying rounds work this way.
order: 5
related: divisions/groups-to-knockout, divisions/bracket-view, entrants/withdrawals
---

The next stage does not have to take its players from a league table. A finished knockout can feed a **plate** for the beaten sides, or a qualifying bracket can feed a main draw.

## Two ready-made formats

Open **Format** on **Division rules** and choose **Show more formats** if they are not listed.

- **Knockout + Plate** is a main knockout plus a plate. The plate takes every entrant who lost their first match.
- **Qualifying + Main draw** is a qualifying knockout whose top finishers go into the main draw.

A stage only feeds the next one once it is complete. The plate fills when the main draw has finished, not after its first round.

> **Example**
> Eight players enter a **Knockout + Plate** division. Four lose in round one. When the main draw completes, the plate's seed proposal lists those four as its qualifiers, and you confirm it to build the plate bracket.

## From a bracket

When a knockout completes, its finishing order is recorded: the winner, the runner-up, and every other entrant ranked by how far they got. A following stage can take a range of that order. A qualifying knockout whose top two go on to a main draw was confirmed this way.

## From a ladder

A ladder only completes when no challenge is still open. While a challenge is live, asking to complete it returns "not completed".

## Through the API

The ready-made formats use these `take` rules in the next stage's `progression`:

- `{ "kind": "firstLosses" }` takes everyone who lost their first match.
- `{ "kind": "rankRange", "from": 1, "to": 2 }` takes a range of the finishing order.
- `{ "kind": "roundLosers", "round": 1, "count": 4 }` takes the losers of one named round. A bracket's rounds are labelled, not simply counted, so name the round you mean.

A stage that takes losers of a round still waits until the source stage is complete before it offers a seed proposal. The API answers 409 until then.
