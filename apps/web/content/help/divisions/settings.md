---
title: Division settings
description: Name, card logo, format, sharing and the danger zone — one tab, four sections.
order: 3
---

Every division has a **Settings tab** (visible to editors) beside Entrants, Fixtures, Standings and Stats. It groups four sections:

- **General** — rename the division and upload a **card logo**. The logo shows on the division's card in your console; without one the card wears a monogram in the division's colour. Remove the logo any time to go back to the monogram.
- **Format** — choose the competition structure (League, Knockout, Groups + Knockout, Swiss…) with its knobs (top-N advance, group count, rounds), plus the match rules (variant, standings points, per-sport rules). Two different locks apply, and the tab tells you which before you type. The **structure** locks the moment any fixtures exist ("Stage structure is locked — fixtures exist"); changing it rebuilds the division's stages, so delete the stages first if you truly must change it. The **match rules** lock one field at a time, and only once a stage that plays by them has **started**: that field turns read-only with a line naming the stage ("Locked: Group A has started and plays this format"), and everything else stays editable. A division with fixtures but no started stage keeps all its rules editable. The **Entrants** section is the one exception — entrant settings stay editable after fixtures exist, up until you press **Start** ([a division's life](/help/divisions/lifecycle)). Edits are validated by the sport's own rules before saving.
- **Sharing & embed** — the copy-paste iframe snippet for your website ([details](/help/sharing/embeds)).
- **Danger zone** — [archive or delete](/help/divisions/archive) the division.

## Common questions

**Do my results change if the rules change?** No. A fixture records the match rules in force the moment its first event is entered, and it keeps them for good — the score, the result and the standings contribution stay exactly as they were played. This is why a match rule locks once a stage that plays by it has started, and why a match already scored is never quietly re-graded under a newer setting.

**Why can't I change the format?** It depends which part you are after.

- *The structure* (League, Groups + Knockout…): fixtures exist — a schedule (and any results) were built on the old structure. On the **Fixtures tab**, delete the stages first (last stage down; a plain League has just the one), then the structure unlocks. If a stage already has **played** results — anything in play, decided or finalized — it can't be deleted; archive the division and start a fresh one instead. Budget for that: a division with played results keeps its place in your division limit when archived, so the fresh one needs a spare slot. The Danger zone says so above the **Archive** button when that's the case, before you press it ([archive and delete](/help/divisions/archive)).
- *A match rule* (best of, points to win, standings points, the variant): a stage that plays by it has started, so the field is read-only and the line under it names the stage. To play one match differently, change that match's own rules before it starts. If you press **Save** on a page that was opened before a stage started, whatever could be saved is saved, and the settings a started stage kept are listed by name under "Saved. 1 setting(s) were kept because a stage has started" — nothing snaps back unannounced.

**Who sees the Settings tab?** Owners, admins and editors of the competition. Viewers never see it.
