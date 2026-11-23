---
title: Add entrants
description: Type names, pick players or teams you already have, or load a spreadsheet. Entrants are who competes in a division.
order: 4
related: getting-started/generate-fixtures, entrants/kinds, entrants/withdrawals, registration/open-registration, entrants/team-badges-and-bulk-enrolment
---

Entrants are who competes: the players, pairs or teams in a division. Open the division and choose its **Entrants** tab. A new division says **No entrants registered yet.**

![The Add entrant card on the Entrants tab: Name and Seed boxes, a Player search, New player with Create player, the Add entrant button, Import CSV and Sample CSV.](/help/getting-started/entrants-tab.webp "The Add entrant card of a division for individuals")

## Type them in

The **Add entrant** form shows the entrant kind at the top, for example **Individual**. Type the **Name**, give a **Seed** if you want one, and press **Add entrant**. The entrant joins the table below with the status **Registered**. Add the next one the same way.

The **Seed** is a number, and it is optional. Each row also has a seed box you can fill in later.

There is no field for several names at once: add one name per press. The form does not stop you adding the same name twice. Two rows called **Dev Patel** both register, so check the list before you move on.

## Pick a player or a team you already have

- **Players.** Under **Player**, type in **Search players…** to find someone already in your organisation's players, pick them and press **Add entrant**. A player who is already in the division shows **Already entered**. To add someone new, type a **Full name** under **New player** and press **Create player**. The page says "added to Players and selected", and they are now in your organisation's players for later competitions. Press **Add entrant** to put them in the division.
- **Teams.** In a team division, the **Existing team** tab searches your clubs and teams. Pick one and press **Enroll team**. A note first says how many players the team's squad copies to the entry. The team then shows **Already entered**. See [clubs and teams](/help/directory/clubs-and-teams).

## Load a spreadsheet

Press **Import CSV** and choose a `.csv` file. The entrants appear in the table straight away. There is no preview step first, so check the table afterwards.

One name per line is enough: a file with no header row imports each line as a name. To fill more columns, start the file with a row that names them, such as `name,seed`. Only a first line that contains "name" counts as a header. A comma splits a line into columns, so a name written "Rao, Dev" is imported as "Rao". **Sample CSV** downloads a file that shows the columns the import reads: `name`, `dob`, `gender`, `seed`, `team` and `squad_number`. You can leave a cell empty.

## Let players register themselves

[Open registration](/help/registration/open-registration) lets players sign up from your public page, with optional fees, questions and a waiting list.

## Change your mind

- **Withdraw** takes an entrant out of the competition and repairs the fixtures. See [withdrawals](/help/entrants/withdrawals).
- **Delete** removes an entrant. It is offered while the division is a draft. Once you press **Start tournament**, the row offers **Withdraw** and **Disqualify** instead.

> **Example**
> You import a file with Asha Rao, Ben Okafor and Chloe Martin. Then you type Dev Patel with seed 4 and press **Add entrant**. The table shows four rows, each **Registered**. A knockout needs at least four entrants, so you can now generate fixtures.

Next: [generate fixtures](/help/getting-started/generate-fixtures).
