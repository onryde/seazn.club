---
title: Scoring a generic sport
description: The pad for every sport that isn't modelled — a running tally you tap during play, or a single result at the end.
order: 23
---

**Generic** is a sport you can pick like any other, and it's the scoring surface for everything this app doesn't model on its own — netball, squash, padel, kabaddi and the rest. It states exactly what it knows and nothing more: two sides and a number, or two sides and a winner. There's no "goal", no "rally", no periods, because none of those would mean the same thing across every sport that lands here.

Two formats, chosen when you create the division:

- **Score** — a running tally you tap during play, with draws allowed.
- **Win Loss** — a result and nothing else, with no draws.

## What the pad tells you

The line above the two halves states both facts at once — *Running score · Draws allowed*, or *Result only · No draws* — because the second is the one a generic scorer can't work out from anywhere else on the screen, and the one whose wrong guess ends in a refusal that's hard to interpret.

The halves show whatever the score currently is, and beneath them a single line says the margin in words: *Home leads by 3*, or **Level**. Level is highlighted when the division doesn't allow draws, because that's exactly the state a match can't be finished from.

## Score: tapping during play

Tap a half — *Tap to add a point* — and one point goes to that side straight away. A side with one named player has that player credited automatically.

The panel that follows asks whether the point was worth more than one, offering **2 points**, **3 points** and **5 points**. Choosing one *amends the point you just recorded* rather than adding a second — so the ordinary case still costs one tap, and the unusual one costs a tap more inside the same window. Tap 3 and then 2 and you're left with 2. Where the side has more than one player, the same panel also offers the players to credit.

The short list is deliberate: anything else is a **Correction** plus another tap, which is the honest cost of an unusual answer.

## Finishing a score match

- **Finish from tally** takes the running score as it stands and records it as the result — the tile shows that score on its face, so you're not asked to trust it. It's offered only when the tally can actually settle the match, which means it's withheld while the score is level in a division that doesn't allow draws.
- **Enter final score** types the two numbers directly, prefilled from the tally so confirming without editing records what the board already shows. This is also the whole pad at the lowest recording level, and the ordinary path for anyone entering a result after the fact.
- **Correction** takes points back off the tally: which side, then how many, with the current score shown as a hint. It can't take a side below zero, and the tile isn't offered at all when there's nothing to subtract.

## Win Loss: one tap

There's no tally and no correction — tapping a half records that side as the winner outright, and nothing follows, because there's nothing left to add to a bare result. Where the division allows draws, **Draw** is a full-width tile beside the halves; where it doesn't, that tile is simply absent rather than present and refused.

## Recording level

A result records at every level, so a **Win Loss** fixture is fully scoreable even at **Result only**. The running tally needs **Card** or above: below that, a score fixture records one final card and nothing else, so its halves aren't tappable and **Enter final score** is the whole pad. See [choosing a detail level](/help/scoring/fidelity).

## Common questions

**Can I score before pressing Start?** Yes. Both a fresh fixture and a live one accept every action on this pad, which is what a result typed in after the fact needs.

**Why can't I find substitutions or periods?** Generic models neither. It's built to be honest about what it can record rather than to imitate a sport it doesn't know — if your sport needs more structure, ask whether one of the modelled sports fits it better.

**The activity feed rows all look alike.** They shouldn't — each point names the player where one is known and the side otherwise, with the amount beside it, so a correction reads as `-2 pts` and needs no further explanation. See [fixing a mistake](/help/scoring/corrections).
