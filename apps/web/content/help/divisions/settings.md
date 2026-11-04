---
title: Division settings
description: Name, card logo, sharing and the danger zone — one tab, three sections. The format lives on the Fixtures tab.
order: 3
---

Every division has a **Settings tab** (visible to editors) beside Entrants, Fixtures, Standings and Stats. It groups three sections:

- **General** — rename the division and upload a **card logo**. The logo shows on the division's card in your console; without one the card wears a monogram in the division's colour. Remove the logo any time to go back to the monogram.
- **Sharing & embed** — the copy-paste iframe snippet for your website ([details](/help/sharing/embeds)).
- **Danger zone** — [archive or delete](/help/divisions/archive) the division.

The **format** is not set here any more. It lives on the **Fixtures tab**, on the **Division rules** card: press **Format** to pick the competition structure (League, Knockout, Groups + Knockout, Swiss…) and its knobs (top-N advance, group count, rounds) from the same cards the new-division builder shows, with estimates for your real entrants and courts. The card names the current format beside the button. It can change until scoring starts (see *Why can't I change the format?* below). The **match rules** live on that card too: the **Division rules** card holds what every stage plays unless its card says otherwise, and each **stage card** has **Match rules**, **Points** and **Tie-breaks** for that stage alone. Those lock one field at a time, and only once a stage that plays by them has **started**; a division with fixtures but no started stage keeps all its rules editable. Entrant settings are not here either: the kinds a division accepts are on the **Entrants tab**, and stay editable after fixtures exist, up until you press **Start** ([a division's life](/help/divisions/lifecycle)). Edits are validated by the sport's own rules before saving.

## Common questions

**Do my results change if the rules change?** No. A fixture records the match rules in force the moment its first event is entered, and it keeps them for good — the score, the result and the standings contribution stay exactly as they were played. This is why a match rule locks once a stage that plays by it has started, and why a match already scored is never quietly re-graded under a newer setting.

**Why can't I change the format?** It depends which part you are after.

- *The structure* (League, Groups + Knockout…): it changes freely until scoring starts. With no fixtures yet, **Format** saves the new structure straight away. With fixtures generated but nothing played, **Format** asks first: it lists what the change clears — the stages by name, the unplayed fixtures, and the schedule's time slots and courts — and only when you confirm does it clear them and build the new stages, in one step, so nothing is left half-changed. Entrants, seeds and the division rules stay; you generate the new fixtures afterwards. Any **Remote scoring** link still live on those fixtures stops working, and the list says how many. A match that is streaming live holds it until its stream ends. From the first result — a match in play, decided or finalized — the button is locked and says "Format is locked once scoring starts". A score that was undone doesn't count: if every score in the division was taken back, **Format** opens again. Otherwise archive the division and start a fresh one instead. Budget for that: a division with played results keeps its place in your division limit when archived, so the fresh one needs a spare slot. The Danger zone says so above the **Archive** button when that's the case, before you press it ([archive and delete](/help/divisions/archive)).
- *A match rule* (best of, points to win, standings points, the variant): a stage that plays by it has started, so the field is read-only on the **Fixtures tab** and the line under it names the stage ("Locked: Group A has started and plays this format"). To play one match differently, change that match's own rules before it starts. If you press **Save** on a page that was opened before a stage started, whatever could be saved is saved, and the settings a started stage kept are listed by name under "Saved. 1 setting(s) were kept because a stage has started" — nothing snaps back unannounced.

**Who sees the Settings tab?** Owners, admins and editors of the competition. Viewers never see it.
