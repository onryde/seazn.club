---
title: A division's life
description: The three stages a division goes through, what Start locks, and who can still join afterwards.
order: 1
related: divisions/settings, entrants/withdrawals, divisions/archive
---

A division is **Draft**, then **Live**, then **Completed**. The badge next to the division name shows which one it is in. This page shows you what each stage lets you do.

## Draft

You are setting up. Add entrants and seeds, pick a format, generate fixtures, clear them and try another format. Nothing is scored yet. When the fixtures look right, choose **Start tournament**.

While the division is a draft, changing the format with fixtures already generated asks first. The **Format** button lists what it will clear: the stages, the unplayed fixtures. It says entrants, seeds and division rules stay, and that you generate the new fixtures afterwards. Choose **Clear and change format** to go ahead, or the keep button to stay on the current format.

## Live

**Start tournament** locks the entrant list for most formats. The Start dialog says which case you are in. A format that closes the list says "Entrant list closes. Withdrawals still work; no one new can be added.", and the Entrants tab then says the list is locked and that withdrawals still work. A format that takes late players says so instead, and the table below lists them.

Once a stage is running, the **Format** button on **Division rules** shows a lock, and the stage card says "Locked: the stage has started".

Who can still join a live division depends on the format and on how far play has gone:

| Format | Late entrant after Start |
|---|---|
| League or group stage that is the division's first stage | Accepted while the stage is running: the new player gets catch-up matches. Refused with "This table has finished. Late players can't join it." once the stage is complete |
| Double elimination | Refused: "This tournament has started — the entrant list is locked." |
| A stage that takes its places from an earlier stage, such as a knockout after a league | Takes no one itself. The add goes to the division's first stage, so the row for that format applies |
| Ladder | Accepted. The new entrant joins the bottom of the ladder, below everyone, and nobody else moves. They can challenge upward straight away |
| Americano | Accepted |
| Swiss that draws from the whole entrant list (no earlier stage feeds it) | Accepted while a round is left to join. Refused with "This Swiss is over." once it has finished, and with "The last round has started, so there is no round left to join." in its last round |
| Knockout that draws from the whole entrant list, with a free place | Accepted and seated straight away |
| The same knockout, with no free place and no match played yet | Added, but waits outside the bracket |
| The same knockout, with no free place and a match already played | Refused with "Round 1 complete; no slot left." The player is not added |

A league or group stage that is the division's first stage takes late players for as long as it is running, whether or not a match has been played. The Entrants tab says so: "This league has started. An entrant you add here plays catch-up matches against everyone in it." For a group stage it says "This group stage has started. An entrant you add here joins a group and plays catch-up matches." and the form has a **Group** picker that starts on the smallest group. When you add a player, the notice says how many catch-up matches they have and in which rounds, for example "Ana has 4 catch-up matches, in rounds 4, 5, 6, and 7." It also says the new matches have no time or court yet, that their opponents are not notified, and that adding a late player can't be undone: withdraw the player instead. On the Fixtures tab the new matches carry **Catch-up**. A league that is followed by a knockout works the same way until the league is complete. After that the add is refused with "This table has finished. Late players can't join it."

A player who arrives without you adding them, such as a reinstated player who never had a match, waits instead. The Fixtures tab shows **Waiting to join the table** with an **Add to the table** button, which writes their catch-up matches. While no match in the stage has started, the strip also says "Rebuild fixtures would draw it again with the player in it, instead of the catch-up matches" and offers **Rebuild fixtures**. That button asks first ("Rebuild this stage's fixtures?" and how many fixtures it deletes) and then draws the whole stage again with the player in it. Once a match has started, only **Add to the table** is offered.

![The Fixtures tab after a late entrant was added to a full bracket: the Waiting to join the bracket card with an Add to bracket button, and the Fixtures don't match the roster notice](/help/divisions/late-entrant-card.webp "A late entrant to a full bracket waits on the stage card until you choose Add to bracket")

A knockout has a free place when its bracket has an open bye whose holder has not started round two. A seat left by a withdrawn player also counts, if nothing was played on it and the player who got the walkover has not started round two: the walkover the withdrawal gave is reversed. A knockout that takes its places from an earlier stage never takes late entrants. A stepladder or page playoff that is the division's first stage is treated like a knockout here, except that its byes are rungs, so a late player never takes a bye in one: only the seat of a withdrawn player can be taken. A new one cannot be created without a table to draw from. A player who arrives through registration, or who is reinstated, waits outside the bracket until you choose **Add to bracket**.

When there is no free place and nothing in the stage has started, the late entrant shows on the stage card as **Waiting to join the bracket** with the note "Joined after the draw. Not in the bracket yet." The card also says "Fixtures don't match the roster" and offers **Rebuild fixtures**. **Rebuild fixtures** is offered only while nothing in the stage has started and the schedule is not frozen. If the schedule is frozen, unfreeze it first.

> **Example**
> A knockout of five players has three byes in round one. Zara arrives after Start. You add her on the Entrants tab and she takes a bye seat in round one. In a knockout of eight, with no open place and nothing played, the same action leaves Zara waiting on the stage card. Once a first-round match has been played, adding her is refused.

Someone who drops out goes through [withdrawal](/help/entrants/withdrawals), which repairs the fixtures instead of pretending they never entered.

## Completed

When the last stage completes, the division shows **Completed**. The public page shows a champion banner.

## Common questions

**Can I take back Start?** No. Nothing on the division gives you an undo for Start. In the **Danger zone** on the Settings tab, **Delete division** is refused once a division has started, even if nothing has been scored. Your options are to archive the division and start a fresh one, or to carry on. See [archive and delete](/help/divisions/archive).
