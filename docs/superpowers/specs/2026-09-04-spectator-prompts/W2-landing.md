# W2 — the competition landing, division and player pages, i18n sweep

Read `_RULES.md` → `_INDEX.md` → spec §W2. Plan:
`../../plans/2026-09-05-spectator-w2-competition-landing.md` (DRAFT, drafted 2026-09-05 by a Fable agent in parallel with W1; re-pin file:line references after W1 merges). Worktree;
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

## Plan (DRAFT, 2026-09-05)

- **Plan:** `../../plans/2026-09-05-spectator-w2-competition-landing.md` — 19 tasks
  (1 schema + ladders · 2 standings view · 3 leaders · 4 hub builder + caches +
  invalidation · 5 hub API + OpenAPI · 6 dictionaries ×4 · 7 hook + `PublicTabRail` +
  `MatchCard` · 8–11 Matches / Table / Stats-Teams-Info / Overview + root · 12
  competition page · 13 division page · 14 player per-match lines · 15 org-home chip +
  island + layout · 16 English sweep · 17 walkthrough v2 + mobile + smoke · 18 gates /
  R11 / index · 19 optional TabRail fold). Status DRAFT until W1 merges and premises
  P1–P20 (listed in the plan) are re-pinned.
- **Owner questions, with the product-owner recommendation:**
  1. Testid prefix — spec R7 and this prompt say `mh-*`; an orchestrator dispatch said
     `cl-*` in error. **Recommend `mh-*`** (the spec); no rename.
  2. Leaders — scope item 5 says "minimum-balls floor read from the module's metric
     spec": a **false premise** — `PlayerStatsModel` (`packages/engine` `stats.ts:106`)
     declares no floor and no leaderboard. **Recommend:** ship count leaders (runs,
     wickets, sixes; goals, assists) pinned to declared keys in W2, AND permit one
     additive engine `leaderboards` declaration for ratio leaders (strike rate,
     economy) — the leaders board is headline cricheroes-grade value; cost is one
     engine task in the ruling-12 pattern.
  3. Org-home liveness (R10) — the plan adds a small public `…/orgs/{slug}/live`
     endpoint polled by an island; Realtime would need a channel per division for
     every competition. **Recommend poll-only** for the org home.
- **False premises found while drafting:** the module-spec floor (above);
  `division:{id}` Realtime channels are token-less/public today (P10); the public
  OpenAPI routes carry no `response` schema (P12); reschedules bypass
  `invalidatePublicCache` (P13); `getPublicCompetition` selects no `config` (P15); the
  mobile.spec seed has no fixtures (P17).
