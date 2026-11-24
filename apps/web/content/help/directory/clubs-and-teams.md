---
title: Clubs & Teams
description: Keep your clubs, teams and squads in one place, and enrol a team into a division without typing its players again.
order: 1
related: getting-started/add-entrants, entrants/kinds, entrants/team-badges-and-bulk-enrolment, billing/plans
---

**Directory** holds four tabs: **Players**, **Clubs & Teams**, **Officials** and **Venues**. The **Clubs & Teams** tab is your register of clubs and teams. Everything in it belongs to your organisation, so a squad you build once is there for your later competitions too.

A new organisation shows "No clubs or teams yet — create your first club to group teams across divisions, or add a standalone team." The tab has a search box, **New club**, **New team** and a **Bulk import participants** link. The list has the columns **Club**, **Teams** and **Contact**.

## Pick the lightest step

- **Entrant only.** Add an entrant straight into a division and keep nothing in the directory. See [add entrants](/help/getting-started/add-entrants).
- **A standalone team.** Press **New team**, type a **Team name** and press **Create**. It appears in the list marked **standalone**, with an **Add to club…** choice if you want to place it in a club later.
- **A club.** Press **New club**, type a **Club name** and press **Create**. A club groups teams under one crest, kit colours and contacts. Grouping teams under a club needs no paid plan.

## The club page

Creating a club opens its page, with a **Back to directory** link and three tabs.

**Overview** holds the club's **Club name**, **Short name**, **URL slug**, **Home ground**, **Website** and **Notes**. Under **Kit colours**, **Home** and **Away** each have a **Primary** and a **Secondary** colour. Press **Save changes** to keep them. **Upload crest** adds the club crest. Every team without its own badge wears it. **Contacts** takes a **Role** (**Secretary**, **Chair**, **Treasurer**, **Welfare officer**, **Manager** or **Other**), a **Full name**, an **Email** and a **Phone**. The first contact you add is marked **Primary**. **Make primary** beside another contact moves the **Primary** badge to it. The **Danger zone** deletes the club and keeps its teams. Their badges fall back to no club badge.

![The Teams tab of a club: the Team name and Short boxes with Add team, and the team Lakeside First Four opened to show its squad, with Priya Nair ticked as captain, Tom Reyes, a Find player box and Save squad.](/help/directory/club-teams-tab.webp "A club's Teams tab with one squad open")

**Teams** has a **Team name** and a **Short** name with **Add team**. A new team shows as a row. Press its name to open the squad: **Find player…** searches your players, and a name that is not there offers **+ Add 'Priya Nair' as a new player** without leaving the page. Each player has a **No.** box for the squad number, a **captain** tick box and **remove**. **Save squad** keeps the list. **Override club crest** gives the team its own badge. **Detach** asks you to confirm, and says the team keeps its players and just leaves the club.

**Entries** lists each team of the club with the divisions it is entered in.

## Squads and entry rosters

A team's **squad** lives in the directory. Each competition entry keeps its own roster. When you enrol a team into a division, the entry gets a copy of the squad at that moment. In the **Entrants** tab of a team division, choose **Existing team**, pick the team and read the note: "Team squad: 2 players will be copied to this entry." Then press **Enroll team**.

After that the two are separate. A player you add to the squad later is not on the entry. In the entrant's row, **Sync from team squad** asks "This replaces the whole entry roster with the team's current squad. Position or role settings the sport doesn't define are dropped; roster edits made only on this entry are lost." and **Sync roster** goes ahead.

> **Example**
> The squad of Riverside First XI holds Priya Nair and Tom Reyes, and you enrol the team. You then add Lena Fox to the squad. The entry still lists two players, with a **+ Lena Fox** suggestion. You press **Sync from team squad**, then **Sync roster**, and the entry now lists Lena Fox, Priya Nair and Tom Reyes.

## Limits

Your plan sets how many clubs and teams your directory can hold and how large one squad can be. A team here is a row on the **Clubs & Teams** tab, not a competition entrant:

| Plan | Clubs | Teams | Squad size |
|---|---|---|---|
| Community | {{plan:clubs.max:community}} | {{plan:teams.max:community}} | {{plan:teams.squad_max:community}} |
| Pro | {{plan:clubs.max:pro}} | {{plan:teams.max:pro}} | {{plan:teams.squad_max:pro}} |
| Enterprise | Unlimited | Unlimited | Unlimited |

Clubs, teams and squads belong to the organisation, not to one competition, so an [Event Pass](/help/billing/event-pass) does not change them.

How many sides a division can hold is a separate limit, **entrants per division**: {{plan:entrants.per_division.max:community}} on Community and {{plan:entrants.per_division.max:pro}} on Pro. It counts the entrants in that division, whether or not each came from a directory team, and an Event Pass raises it for one competition. Enrolling a team adds an entrant to the division and no new team to the directory. A team you keep in the directory and never enrol still counts against the team limit.

At a limit the page says "You've reached your plan's club limit." or "You've reached your plan's team limit." with a link to plans. A squad over its size is refused with "This squad has reached your plan's size limit." See [plans at a glance](/help/billing/plans).
