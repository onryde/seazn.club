---
title: Open registration
description: Let players sign themselves up from your public page, with a fee, extra questions, a capacity and optional approval.
order: 1
related: registration/registrants, registration/registering-for-a-competition, registration/waitlist, registration/card-payments, registration/youth
---

Open a division for registration and players can enter it themselves. You get a link to share, and control over fees, capacity and who is let in. This page covers the organiser side. To see what a player sees, read [registering for a competition](/help/registration/registering-for-a-competition). To work with the people who sign up, read [managing registrants](/help/registration/registrants).

## Get the link

Open your competition and choose **Registration**. The **Settings** tab lists every division with a status: **Open now**, **Scheduled** or **Closed**. A division that is open or scheduled shows its sign-up link with three buttons:

- **Copy** copies the link.
- **Open** opens the register page.
- **QR** shows a QR code with the line "Scan with a phone camera to open this link — print it for the club noticeboard." **Download PNG** saves it.

![A division row on the Registration page with its sign-up link and QR code](/help/registration/reg-link.webp "A division that is open now, with its sign-up link and QR code")

A competition set to **Private** has no sign-up link, and its register page does not open. Change the visibility in the competition's settings.

## Set up a division

Choose **Open settings** on a division. The settings come in five sections. Press **Save changes** when you finish.

- **Eligibility**: **Category** (Open, Men's, Women's or Mixed), **Minimum age**, **Maximum age**, **Cutoff month** and **Cutoff day**, and a **Note for entrants** that appears on the sign-up form. The cutoff is the date a player's age is counted on; with none set it is 1 January. **Who approves entries?** is **Auto-confirms** or **Manual approval**.
- **Open & close**: tick **Open for public registration**, choose the **Entrant type** (Individual, Team or Pair), and set **Opens** and **Closes** times if you want a window.
- **Capacity**: leave it blank for no limit. When the division is full, new entries join the [waitlist](/help/registration/waitlist). The division row shows how many places are taken, for example "2 of 2 registered".
- **Money**: the **Entry fee** and how it is collected. See below.
- **Sign-up form**: **+ Add question** adds your own questions, such as shirt size or dietary needs. A question can be text, a choice from a list or a tick box, and you can make it required. Players answer on the **Details** step.

Entries that are pending, paid or confirmed all hold a place. A change to the entry fee applies to new sign-ups. An entry already submitted keeps the price it was submitted at.

With **Manual approval**, a new entry waits for you. See [managing registrants](/help/registration/registrants) for **Approve** and **Reject**.

## Take the entry fee

Under **How is the fee collected?** choose one of two ways:

- **Pay the organiser**: the player pays you in cash or by bank transfer. The entry stays pending until you mark it paid.
- **Card payment at sign-up**: the player pays by card through Stripe when they register. This option is greyed out until you connect Stripe. See [how card entry fees flow](/help/registration/card-payments).

Write your bank details once for the whole organisation. Choose **Settings**, then **Connect**, and fill in **Cash / bank transfer instructions**. A division can use its own text in **Payment instructions for this division**. Basic formatting such as bold and links works in both.

Write `{{reference}}` wherever the player's reference number should appear, for example `Quote {{reference}} on your transfer.` Each player sees their own reference in its place, on their registration page and in their confirmation email.

A cart shows one set of instructions, taken from the first entry that has a fee: that division's text, or else your organisation's. If one entry in the cart owes money, the reference is that entry's own. If several owe money, it is the cart's.

> **Example**
> A player enters a team in **Doubles Teams** and a singles division in one cart, both paid to the organiser. The cart reference is `SZ-X9NX-PKXX`. The two entries are `SZ-X9NX-PKXX-1` and `SZ-X9NX-PKXX-2`. Both owe money, so the instructions tell the player to quote `SZ-X9NX-PKXX`. If the singles entry were free, only the team entry would owe money, and the player would quote `SZ-X9NX-PKXX-1`.

## Allow solo sign-ups

On a team division, tick **Allow solo sign-ups** under **Eligibility**. Players with no team can then choose **Sign up solo**, and you place them on a team later. Two more settings appear:

- **Solo sign-up fee** under **Money**. Leave it empty to charge the team fee, or set 0 to let solo players in free. On a card division the fee must be 0 or at least 1.00.
- **Place-by date** under **Eligibility**. A solo sign-up still without a team after this date is withdrawn and refunded. Leave it empty and the division's **Closes** time is used.

To place the waiting players, see [managing registrants](/help/registration/registrants).

## Privacy consent

Every registrant ticks a required box agreeing that your organisation and Seazn Club store and process the form details to run the competition. The form does not submit without it, and the box links to the Privacy Policy. A second box, for photos and video, is optional.

## Linking an entry to an account

Registration never needs an account. On the first step every player sees a tick box, **I'm one of the players**, signed in or not. Ticking it asks for their date of birth and puts them in as player 1 on the entry. With several entries in the cart, they choose which entries are theirs. On a team entry they are asked **Which player are you?**

If they are also signed in and an adult, the entry is linked to their account's player record. A player under 18 is never linked this way. A parent entering two children should leave the box unticked, so each child keeps a separate record.

## Under-18 divisions

A division with a **Maximum age** below 18 is a youth division. It asks for guardian consent and shortens players' names on public pages. Read [youth divisions and privacy](/help/registration/youth).
