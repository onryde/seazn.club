---
title: Setting your lineup
description: Pick starters, bench, positions and roles before the match starts. The team sheet locks when the match starts.
order: 10
related: scoring/attribution, scoring/basics, divisions/discipline
---

A team or a pair has a **Lineup** panel on the fixture. A match between two single players has none, and neither do sports with nothing to nominate: a doubles pair in tennis has a panel, a carrom pair does not. Where there is one, open it from the **Lineup** button in the fixture header, set the team sheet, and press **Save lineup** under each side before you press **Start match**.

![The Lineup panel for the home side of a football match, with the banner Starting line-up still needs Goalkeeper times 1 and the first five starters, each with a position list](/help/scoring/lineup-panel.webp "The Lineup panel: Home and Away tabs, and a position list on each starter")

## Starters and bench

If nobody has saved a lineup, the panel fills one in from the roster: the first names as starters (a football match: 11) and the rest on the bench. The panel header reads, for example, "Home Spring Cup lineup", with a count such as 11/11 starting under it. You then only have to press **Save lineup**.

Each row has a **⋯** menu with **Move to starting** or bench, **Make captain**, **Move up**, **Move down** and **Remove from lineup**.

## Positions

A sport with positions gives each starter a **position…** list. Football offers Goalkeeper, Defender, Midfielder, Forward and the finer positions such as Centre back and Striker. If the sport needs a goalkeeper and there is none, the panel says "Starting line-up still needs: Goalkeeper × 1" until you pick one. You can still save without one.

## Roles: a coach is not a player

Everyone starts as **Player**. In the **⋯** menu, set **Role** to **Coach** or **Staff**. They move under **Coaches & staff**, stay on the team sheet, and are not offered when you [credit a player](/help/scoring/attribution).

## Serve order for pairs

A pair entrant, such as a doubles pair, can choose who **serves 1st** and who **serves 2nd**, so the pad knows whose turn it is. Singles and teams do not see this choice.

## When the lineup locks

The team sheet locks when the match starts. After that the panel opens read-only: there is no **Save lineup** button and the **⋯** menus are gone. A save sent through the API after the start is refused, and the API says the lineup is locked. A substitution during the match is recorded on the pad as its own entry.

> **Example**
> A football match between Hawks and Rockets. You open **Lineup**, see 11 starters and two on the bench for Hawks, pick Goalkeeper for the first starter, move one bench player to **Coach**, and press **Save lineup**. Once the match is started, the panel is read-only and nothing can be saved.

## Common questions

**Can I score without a lineup?** Football: yes, the pad still takes goals and the goal dock opens with no lineup saved. Whether a scorer can be credited depends on the players the match has, see [crediting players](/help/scoring/attribution). Other sports were not checked for this.

**Can an official enter the lineup?** Yes, on a match they have accepted. See [officials](/help/scoring/scorer-role).
