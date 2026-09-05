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

---

## Design theme (from _DESIGN.md, 2026-09-05)

Build to `_DESIGN.md` §5 W2, on W1's vocabulary (`W1-match-centre.md` §"Design theme").
Theme sheet: <https://claude.ai/code/artifact/45c81708-095d-458c-b49f-b471e2901415> — the
"W2 — competition landing" board at 320 px shows the composition; the component section
above it draws the score strip, match card and composed standings at phone width. W0
board `CurrentCompetitionPhone.dc.html` is the BEFORE (the headline-only rail this wave
replaces).

**The memorable thing:** the **Live-now rail** — every live match in the competition as a
swipeable row of miniature court cards carrying real team names and scores, updating in
place. It sits directly under the hero and is the reason a spectator opens the link.

**Rules:**

1. **Keep the hero exactly.** The existing court slab (`[competitionSlug]/page.tsx:95-179`)
   — org eyebrow, `font-display text-4xl sm:text-5xl` uppercase name, date line, share bar,
   register CTA, `bg-white/12` count chips, accent keel. Its two accent radial washes are
   the page's ONE atmosphere device; do not add a second.
2. **Live-now card = a miniature court card**, not a new component:
   `rounded-xl bg-court p-3.5 ring-1 ring-emerald-400/40`, two side rows with crest tile +
   short name + `tabular-nums` score, emerald keel. The `<ul>` becomes a real rail —
   `role="list" tabIndex={0} aria-label` — which it lacks today
   (`[competitionSlug]/page.tsx:187`). **No `hover:-translate-y-0.5 hover:shadow-md`**
   (inherited at `:194,232`; do not propagate).
3. **Match card = the schedule row grammar**
   (`grid-cols-[3.25rem_minmax(0,1fr)_auto]`, time/LIVE rail left, stacked sides,
   right-aligned Barlow `text-lg` `tabular-nums` scores, winner bold / loser muted, live
   edge `w-0.5 bg-emerald-400`) plus a crest tile before each name. Meta as **separate
   elements** — division chip, stage/round, venue — never one `·`-joined string.
4. **Standings composed for 320, not shrunk:** rank chip · crest · team (`truncate`) · P ·
   W · L · **Pts** in `font-display text-base font-bold text-accent-strong`; the long tail
   (D, T, NR, NRR, tiebreaks) behind a `<details>` "More columns" or unfolding at `md`.
   Podium colours stay fixed and are **not** org-themeable
   (`standings-table.tsx:39-45,81`). Numeric widths and `px-0.5` per W1 rule 5.
5. **Rails and radii by role.** Tab rail = W1's `TabRail` component with `mh-` testids;
   the division page keeps its sticky segmented shell. Row groups `rounded-xl` +
   `border-zinc-200/80` + `divide-y`, **no shadow** (P7). Chips `rounded-full`; the
   division chip may key its wash on `divisionTint`/`divisionInk`.
6. **Every scrolling region** (Live-now rail, tab rail, any wide table) carries
   `tabindex="0"`, a role and an accessible name; no horizontal PAGE scroll at
   320/360/375/390/430/768/834. Controls ≥ 44 px by `elementFromPoint`, not `boundingBox`.
7. **Live in place (R10) with one highlight, not a re-layout.** A changed cell gets the
   single `accent-soft` fade (P6) and nothing else moves; no toast, no scroll jump.
   `prefers-reduced-motion` disables it.
8. **Copy.** Filter labels and empty states in sentence case with the empty case FIRST
   ("No fixtures yet — the schedule appears once the draw is made."); no "coming soon", no
   emoji, no apology; no "→" on links; standings abbreviations stay notation with a
   localised `title` and `sr-only`.

**Proposed items this wave depends on** (owner ruling before W2 executes): **P1** the team
colour ladder — scope item 6's "monogram in team colour" resolves to it · **P7** row groups
drop `shadow-sm` (this wave writes the row groups) · **P2** 44 px tab hit area · **P3**
section titles in Barlow 16 px · **P6** the live-change highlight · **P10** 13 px table
cells · **P11** `min-h-11` on controls · **P5** focus ring on the slab.

### Conflicts for the owner

1. **The team-colour KEY.** This plan's `primaryColour(e.team_display?.colors)`
   (plan Task 4, `…-w2-competition-landing.md:959`) reads `colors.primary`. **`primary` is
   a key nothing in the product writes.** The only writer is the club hub's four kit
   pickers, which write `home_primary` / `home_secondary` / `away_primary` /
   `away_secondary` (`components/v2/club-hub/overview-tab.tsx:38-52`); `_DESIGN.md` §2.2
   has the full chain. `primary` was taken from `usecases/exports.ts:261-262`, which is the
   only reader and is itself wrong. Shipped as planned, every real club colour is missed
   and every tile silently falls to the fallback — a green suite over an inert seam. Not
   resolved here: the owner decides whether W2 reads `home_primary` (and W3/W5 follow), or
   the key question is deferred and all three waves ship fallback-only.
2. **Where the fallback comes from.** `_DESIGN.md` P1 rung 2 specifies the existing
   `lib/division-hue.ts` wheel keyed on the entrant id (twelve stops, skips the brand
   violet's 260–290° band). W3's plan defines its own `BRAND_PALETTE`
   (`…-w3-poster.md:955-962`). Two authorities for one fact; the owner picks one before
   either wave builds it.

**Correction (product-owner ruling, 2026-09-06 — apply at re-pin):** the team colour is
NOT `colors.primary`. The only writer (`club-hub/overview-tab.tsx:38-52`) stores
`home_primary` / `home_secondary` / `away_primary` / `away_secondary` on
`clubs.colors` / `teams.colors`, resolved by `team_display_v.colors` and already present in
the public entrant payload (`public-site/data.ts:316-323`). `exports.ts:261-262` reads
`colors->>'primary'` and is the broken reader this plan copied. Ruling: public tiles use
`colors.home_primary` through `public-theme.ts`'s 3:1 `contrast()` guard, else the
`division-hue.ts` wheel keyed on the entrant, else neutral initials (`_DESIGN.md` P1);
one shared resolver in W2 (`primaryColour`) consumed by W3 and W5 — no second palette.
