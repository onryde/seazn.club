# W2 — the competition landing, division and player pages, i18n sweep

Read `_RULES.md` → `_INDEX.md` → spec §W2. Plan:
`../../plans/2026-09-04-spectator-w2.md` (written after W1 merges). Worktree;
one PR. Depends on W1 (match cards link into the match centre; the player
page's per-match lines come from W1's fold).

## Why the wave exists

The competition page is where the shared link lands, and today it cannot
answer "what is on, who is winning, when do we play" without a drill-down per
division. It is also English on every locale. This wave makes it the
competition's front window on a phone, and finishes the i18n debt on every
public page.

## Scope

1. **Competition page tab rail** — Overview · Matches · Table · Stats · Teams ·
   Gallery (slot only; W4 fills it) · Info. A tab with nothing to show is not
   rendered (R4/R9). Scroll rail at phone widths, one DOM.
2. **Overview** — brand hero, status line, Live-now rail with team names and
   scores, next three matches, first three rows per table, register CTA when
   open, sponsors. **R10**: one client subscription per page (Realtime on Pro,
   poll otherwise) re-renders the Live-now rail, the Matches hub cards, the
   division schedule rows and the tables in place — never a reload.
3. **Matches hub** — all divisions; filters Live · Upcoming · Completed with the
   default ladder (Live if any, else Upcoming if any, else Completed — empty
   case first); division chips; grouped by day in the venue zone; the match
   card per spec (division chip · stage/round · time or LIVE · venue/court ·
   crest + team + score (overs) × 2 · result line or "Starts in 2 h" · poster
   icon slot). Links to the match centre.
4. **Table** — per division, `StandingsTable` under a division header + "Full
   division"; composed for 320 (rank · crest · team · P · W · L · Pts, long tail
   behind a disclosure) — a diffed control set, not a shrunk table.
5. **Stats** — leaders per division from the existing public player-stat folds;
   minimum-balls floor read from the module's metric spec; rows link to the
   player page.
6. **Teams** — entrants with badges (`badge_url` / `team_display_v.logo_path` /
   monogram in team colour) linking to the division's Entrants tab.
7. **Info** — description, dates, venues, sponsors, registration state, .ics,
   share bar.
8. **Division page** — same rail treatment; Schedule reuses the match card;
   Standings and Entrants composed for the phone.
9. **Player page** — per-match performances list from W1's fold, consent-gated.
10. **i18n sweep** — competition, division, `LiveScore`, schedule, layout
    tagline into the `public` namespace, four locales; the W1 coverage
    assertion widened to every `/shared` page.
11. **Testids** `mh-*`; **walkthrough v2** — org home → competition → Matches
    filters → Table → Stats → player → division, at 320 and 1280, control-set
    diff asserted.

## Do NOT touch

The organiser console; the scorepad; registration pages; the `present` slides;
entitlement matrix/copy; the engine.

## Acceptance — all four test types

- **Unit**: filter default ladder with the empty case first; day grouping
  across a DST boundary in the venue zone; leaders' floor read from the module
  spec; badge fallback ladder.
- **E2E**: walkthrough v2 in `--project=walkthrough` — including: with the
  competition page open in the anonymous context, an event posted through the
  API moves the Live-now card and the Matches hub card without a reload (R10);
  full `mobile.spec.ts`.
- **Smoke**: competition page GET carries `mh-` markers.
- **Regression**: zero hardcoded English on every public page, four locales;
  the old divisions-grid-only competition page does not render.
- **Screens**: every tab at 320/768/1280; control-set diffs pasted.

## Gates

As W1. `_INDEX.md` status updated in the same PR.
