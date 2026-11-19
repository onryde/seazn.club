---
title: Printing scorer sheets
description: Print a day's matches as cut-out cards sorted by court, each with its own scoring QR for the umpire to scan.
order: 3.5
related: scoring/scorer-card-scan, scoring/device-links, scheduling/timezones
---

A **scorer sheet** puts one day's matches on paper as cut-out cards, sorted by court. Give each court its pile. When a match is about to start, the umpire scans the card's QR and scores the match on their own phone, with no account and no app. Each card's QR is that match's [device link](/help/scoring/device-links). What the umpire does is on [scanning a scorer card](/help/scoring/scorer-card-scan).

## Print a day

On the competition's **Schedule** page, choose the **Day** next to the page title and press **Print scorer sheets**. You get one PDF with that day's matches from every division, sorted by court.

- **Who can print:** owners and admins.
- **Plans:** free on every plan.
- **Which matches:** every match on that day that has a time and is still to play or in play. Matches with no time, byes and matches that are already over are left off.
- **The control** appears once at least one match to play has a time, and the **Day** list offers only days that have matches to print.
- **Which day:** days and times follow [your organisation's time zone](/help/scheduling/timezones), whatever the clock on the computer you print from.
- **Start the division first.** A division that has not been [started](/help/divisions/lifecycle) cannot be scored. An umpire who scans a card early sees **Not started yet**.

A card is never printed without a working QR. If a scoring link cannot be made for a match, the download stops with an error.

## What is on the sheet

Each A4 page is a grid of nine cards, three across and three down, with dashed lines to cut along. Every court starts a new page, headed with its name and the page count, such as "COURT 1 · PAGE 2 OF 2". When the court belongs to a venue, the venue name follows the court name in brackets. A court with more than nine matches runs on to the next page. Matches without a court come last, under the heading **No court assigned**. Cards run in time order, left to right, then down.

Each card shows:

- the time and the match's code as the schedule shows it, such as **SF·1** or **R1·3**, and the division
- both sides' names, one per line (a doubles pair prints one player per line)
- the QR, with the Seazn logo in the middle

![The top left of a scorer sheet: the words Scorer sheets, the competition name Spring Open, the date, and the first cut-out card with the time 10:00, the match code SF·1, the division and two names](/help/scoring/scorer-sheet-page.webp "The top left of a scorer sheet. The card's QR code sits below the names and is cropped out of this picture.")

There is no box for the score, because the score goes in on the phone. The scoring link is never printed as text, so the QR is the only way in. Anyone holding a card can score that match, so keep the sheets with your umpires.

> **Example**
> A knockout of four and a league of four share one day, with matches on Court 1 and Court 2 and a few without a court. You print the day and get three pages: Court 1, Court 2, and No court assigned. A semi-final card shows 10:00, **SF·1**, the division name, "Mira Okafor" and "Leo Marsh", and its QR.

## Print before the draw is complete

You can print before the draw fills in. A side that is not known yet prints as its place in the draw, such as "Winner of SF·1", with a line under it to write the name on. A card belongs to the match, not to the players, so it works as soon as the side is known.

An unpaired Swiss board prints **TBD** for both sides, with the same lines. A card belongs to its board. Unpairing a round does not delete its boards, so after you pair again, the same card scores whoever is now on that board. That is why every sheet says **Scan to score. Check names on screen before you start.** The phone always shows the match as it stands now.

## Printing again

Printing again is safe. A match keeps the same QR every time you print, and **Show QR** on the match shows that same code. Only **Revoke & reissue**, **Revoke**, or deleting the match changes it. See [device links](/help/scoring/device-links).

## From the API

The sheet is `POST /api/v1/competitions/{id}/exports/scorer-sheets`. It takes a `date`, or `dateFrom` and `dateTo`, an optional `divisionId`, and `groupBy`: `"court"` (the default) or `"division"`. With `"division"` each page run is one division, and each card shows its court under the time. A day with nothing to print answers "No fixtures to print on that day".
