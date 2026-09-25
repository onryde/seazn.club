---
title: Printing scorer sheets
description: Print a day's matches as cut-out cards, sorted by court, each with its own scoring QR. The umpire scans a card and scores that match on their phone.
order: 3.5
---

A **scorer sheet** puts one day's matches on paper as cut-out cards, sorted by court. Give each court its pile. When a match is about to start, the umpire scans that card's QR and scores the match on their own phone. They don't need an account or an app, and you don't need to do anything for each match. Each card's QR is that match's [device link](/help/scoring/device-links).

## Print a day

On the competition's **Schedule** page, pick the **Day** beside the page title and press **Print scorer sheets**. You get one PDF with the day's matches from every division together, sorted by court.

The control shows up once at least one match still to play has a time. The **Day** list offers only the days that have matches to print.

- **Who can print:** owners and admins.
- **Plans:** scorer sheets are made of device links, so they come with **Pro**, or with an [Event Pass](/help/billing/event-pass) for that competition. On Community you see an upgrade prompt in its place, once a match has a time.
- **Which matches:** every match that day that has a time and is still to play or already in play. Matches with no time yet, byes, and matches that are already over are left off.
- **Which day:** days and times on the sheet follow [your organisation's time zone](/help/scheduling/timezones), whatever the clock on the computer you print from.
- **Start the division first.** A division that hasn't been [started](/help/divisions/lifecycle) can't be scored yet. An umpire who scans a card before then sees **Not started yet**, and the screen moves on by itself once you start the division.

The sheet never prints a card without a working QR. If a scoring link can't be made for a match, the download stops with an error instead.

## What's on the sheet

Each A4 page is a three-by-three grid of nine cards, with dashed lines to cut along. Every court starts a new page, with its name at the top ("COURT 2 · PAGE 1 OF 2"). A court with more than nine matches carries on to the next page. Matches without a court come last, under **No court assigned**. Cards run in time order, left to right and then down the page.

Each card shows:

- the time, the match's code as the schedule shows it (for example **QF·2** or **R1·3**) and the division;
- both sides' names — a doubles pair prints one player per line;
- the QR code, with the Seazn logo in the middle.

There's no box for the score. The score goes in on the phone. The scoring link is never printed as text, so the QR is the only way in. Anyone holding a card can score that match: keep sheets with your umpires.

## When a side isn't decided yet

You can print before the draw fills in. A side that isn't known yet prints as its place in the draw, like "Winner of QF·2", with a line under it to write the name in. An unpaired Swiss board prints **TBD** for both sides, with the same lines. The card belongs to the match, not to the players, so it works as soon as the side is filled. An umpire who scans early sees **Waiting for** both sides as they stand, and "This page updates by itself." When the other result comes in, the screen moves on to the match. There's no need to scan again.

In Swiss, a card belongs to its board. Unpairing a round does not delete its boards, so after you pair again the same card scores whoever is now on that board. That is why the top of every sheet says **Scan to score. Check names on screen before you start.** The phone always shows the match as it stands now.

## What the umpire does

1. Scan the card's QR with the phone's camera. The match opens in the browser.
2. The phone shows **Check the match before you start**, with the court, time, match and both names. If these are the players in front of them, the umpire taps **Start match**.
3. Score the match on the same pad a signed-in scorer uses. A match that has already started opens straight on the pad.

Sometimes the phone shows something else:

- **Not started yet** — the organiser hasn't started this division yet. The screen moves on by itself once the division starts.
- **Waiting for** — a side isn't decided yet (see above).
- **The final score with no controls** — the match is over. The phone says why, for example "Match over — result finalised. Ask the organiser to correct it."
- **This scoring link was revoked.** or **This scoring link is not valid.** — the card no longer works (see below).

## When a printed card stops working

A card works until its match is over. There's no daily cut-off, so cards printed the night before are fine. A card stops scoring when:

- **The match is over.** Once the match is finalized or cancelled, or its result moves the competition on, scanning the card shows the result read-only. A result moves the competition on in a knockout when the winner goes into the next match, in Swiss when the next round is paired, and in any format when the stage is completed. After that, corrections are yours, from the console.
- **You choose Revoke & reissue on the match.** Use it when a card goes missing: the old QR stops working at once. Print the day again, or use **Show QR** on the match, to get the new one. **Revoke** on its own switches the link off and makes no new one.
- **The match is deleted.** **Rebuild fixtures** deletes every match in the stage and makes new ones, so every card for that stage stops working. The rebuild dialog warns you about this. The same happens to a match's card when you delete its stage, when you undo the step that generated the stage's matches, or when a Swiss round loses a board: if the number of players changes before a round is paired, pairing can remove matches from it, and the notice says how many. Print again after any of these.

## Printing again

Printing again is safe. A match keeps the same QR every time you print, and **Show QR** on the match shows that same code. Handing a match to a device from the console never replaces a printed card. Only Revoke & reissue, Revoke, or deleting the match changes it.

## Common questions

**Can one phone score a whole court?** Yes. Scan each card as its match comes up. Each scan opens only that match.

**Two phones scanned the same card.** Both can score that match, and they share one link, so either can undo the other's entries. If they tap at the same moment, one refreshes to the latest score ([score conflicts](/help/scoring/conflicts)). Keep to one phone per match.

**The names on the card are out of date.** Trust the phone. It always shows who is in the match now.
