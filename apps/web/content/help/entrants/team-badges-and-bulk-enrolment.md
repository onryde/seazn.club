---
title: Team badges and bulk enrolment
description: Upload a badge for an entrant, and enrol a whole squad, including new players, in one step.
order: 4
related: entrants/kinds, entrants/duplicate-players, directory/clubs-and-teams
---

This page shows you where to upload a badge, and how to enrol a team with its whole squad without creating each player first.

## Badges

On the **Entrants** tab, open an entrant's row by choosing its name. The row has a **Badge** line with an **Upload** button. Until you upload one, the entrant shows a monogram tile with its first letter.

![An expanded entrant row with the Name field, the Badge line and Upload button, and the roster with a player search](/help/entrants/badge-and-roster.webp "An open entrant row: rename the entrant, upload a badge, and edit the roster")

The same open row lets you rename the entrant and edit its roster: find a player, add the chip, then choose **Save roster**.

## Enrol a squad in one step

You do not have to create every player first. Through the API, a team can be created together with its roster in one request. Each roster member is either an existing person or a **new person** that you give just a name.

- One request can hold up to 500 entrants.
- One entrant can carry up to 40 roster members.

New people created this way are never matched against your directory. If a player already exists, send them as an existing person, or you will have two records and need to [merge them](/help/entrants/duplicate-players).

The same request can carry a badge address for each entrant.

> **Example**
> A club sends a 26-player squad. One request creates the team "Stonebridge Stags" with 26 new people. All 26 appear on its roster. Two weeks later the club's secretary finds that one player was already in your directory as "Rohan Mehta". Merge the two records from **Directory → Players**.

The **Add entrant** form on the Entrants tab also has **Import CSV** and **Sample CSV** buttons for loading entrants from a spreadsheet.
