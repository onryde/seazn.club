---
title: Youth divisions and privacy
description: Divisions for players under 18 ask for guardian consent and show shortened names on public pages.
order: 7
related: registration/registering-for-a-competition, registration/open-registration, registration/registrants
---

A division is a youth division when its **Maximum age** is below 18. Set it in the division's registration settings, under **Eligibility**. The division then shows an age chip such as **Under 12** on the sign-up page, and two protections apply: guardian consent when players register, and shortened names on public pages.

## Guardian consent

Guardian consent works in two ways, depending on who is registering.

- **A player registering for themselves.** If the player is under 18, the **Consent** step adds an **Under-18 entry — guardian consent** block. It asks for a parent or guardian's name and a tick that says "I am this player's parent or guardian and I consent to their registration." The entry cannot go on without both. This sits beside the privacy consent box that every registrant ticks.
- **A parent or guardian registering a child.** An adult who enters a player with a date of birth under 18 sees a box that reads "I'm the parent or guardian of the players under 18 I'm entering." Tick it and the consent is recorded for the child, who is then not asked to confirm. Leave it unticked and each player confirms for themselves when they join or claim their place.

![The Consent step with the under-18 guardian block](/help/registration/guardian-consent.webp "A player under 18 registering for themselves must give a guardian's name and consent")

On the **Registrants** tab, the **Consent pending** filter lists entries where someone still has to confirm. A child consented for by a guardian is marked as guardian consent in the **Export CSV** file, in the `player_guardian_name` column and `player_consent_status`.

## Names on public pages

Public division pages, and the roster on a player's registration page, show a youth player as first name and initial, such as "Kabir R.", never the full name. Your organiser pages and the CSV export keep the full name. The shortening applies only to what other people can see.

A player can also hide their own name from public pages in their profile, under **My matches & teams**. A name is shortened if either the division or the player asks for it. A player under 16 cannot change this switch. The profile says "An organiser manages this until you're 16."

> **Example**
> Kabir Rao, aged 8, is entered in **Under 12 Singles** by his mother Anita. The division's public page lists him as "Kabir R.". On your **Registrants** tab his row reads "Kabir Rao", and the CSV export has his full name in `player_name` and Anita's in `player_guardian_name`.

## Making a competition visible

When a competition has a youth division, changing its visibility asks you to confirm first. The message reads: "Making it visible publishes players' names on the public page. Confirm you hold guardian consent for every under-age player before continuing." Choose **I hold guardian consent — continue**, or **Cancel**.

## Common questions

**We are a school. Can we keep the competition out of search results?** Set the competition to **Link only**. Anyone with the link can open it, and search engines are told not to list it. **Private** hides the pages from everyone outside your organisation, and the sign-up page does not open either.
