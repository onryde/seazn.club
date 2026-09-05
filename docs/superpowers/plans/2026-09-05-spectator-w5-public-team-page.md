# Spectator W5 — Public Team Page: Design and Implementation Plan

> **Status:** DRAFT — W5 ruled IN SCOPE by the owner 2026-09-06 (ruling 16, "Keep it"); design options and the plan for the recommended option (A); re-pin file:line references after W1–W4 merge before execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT start Part 2 until the owner has ruled on the questions in Part 1 §"Owner questions" and W1–W4 have merged (every W2 name this plan consumes is a DRAFT name today).

**Goal:** Give every entrant in a public competition its own page — `/shared/[org]/[comp]/[div]/teams/[entrantId]` — with crest, division and record, its live/upcoming/recent fixtures, its squad (consent-resolved, masked never blank) with season lines, and its table position, updating in place while a match is live, so a captain can share ONE link to the whole squad.

**Architecture:** The page is a SLICE of two documents that already exist. Fixtures and standings come from W2's competition-hub document (`CompetitionHubDoc`) filtered to the entrant on the client by pure helpers (`lib/team-page.ts`), delivered live by W2's `useLiveCompetition` hook — no new endpoint, no new cache to invalidate, and a push or poll that moves the hub moves this page on the same tick (R10). The squad comes from ONE new server reader (`readPublicSquad`) over `entrant_members`/`persons` through the single consent resolver, with season lines from the same `player_stat_snapshots` rows W2's leaders read, cached under the division's ISR tag. A client root (`TeamPage`) renders the W1/W2 shell — court header → `PublicTabRail` (Fixtures · Squad · Table, by presence) → panel — and reuses W2's `MatchCard` and `StandingsTableView` unchanged except for two additive props.

**Tech Stack:** TypeScript 7, Node 26, pnpm; Next.js App Router (ISR: `revalidate = 30` + `generateStaticParams`, `unstable_cache` tags); `@seazn/engine` (`PlayerStatsModel` via `resolveModule`); zod (W2's schemas, consumed only); vitest (`environment: "node"`, no DOM — `renderToStaticMarkup` + the `_hook-harness` island renderer); Playwright (`walkthrough` project, seven-width `mobile.spec.ts` projects); Supabase Realtime + 15 s poll (W2's transport); Tailwind public-site tokens.

**Spec:** `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` — §W5 (lines 562–567: "the queued candidate is the public team page (`…/teams/[entrantId]`: badge, squad, results, upcoming, table position — captains share it to their squad), recommended to the owner 2026-09-05 and not yet ruled on"), §W2 Teams (line 449–450: "No public team page (out of scope, noted as a later candidate after W5)"), §Out of scope (line 600: "public team pages (later candidate)"), standing rules R1–R11, §"Copy and i18n", §"Error and empty states". Programme rules: `docs/superpowers/specs/2026-09-04-spectator-prompts/_RULES.md`; index: `_INDEX.md` (owner rulings 1–14; product-owner call at lines 94–97). Wave prompt: `../specs/2026-09-04-spectator-prompts/W5-team-page.md`. Conventions this plan matches: `plans/2026-09-04-spectator-w1-match-centre.md` (W1) and `plans/2026-09-05-spectator-w2-competition-landing.md` (W2, DRAFT — its Task numbers are cited below as "W2 Task N").

---

# Part 1 — Design (candidate; owner approval needed before Part 2)

## The page's job

A spectator arrives on the team page from a captain's WhatsApp, a QR poster, the competition's Teams tab, a standings row or a division's Entrants list. In one screen on a phone the page answers, in this order: **is my team playing right now / when do we play next**, **how did we do** (recent results), **who is in** (squad with shirt numbers and a season line each), and **where are we** (table position with the record). Every fixture links to its match centre; the header links back to the division and the competition; "Add to calendar" gives the squad the team's own `.ics` feed, which already exists (`calendar.ics?entrant=<id>`).

Customer value, as the owner asked it to be stated: the **captain** gets one link that replaces "what time is it Saturday?" in the group chat — and every one of those shares carries the organiser's public face and, for free orgs, "Powered by seazn" (R8). The **player** sees their own name and season line one tap from the player page. The **organiser** gets this for zero work: every fact on the page is already in the database.

## What exists (pinned 2026-09-05 on `feat/spectator-surface`)

| Need | Where it already is | Pin |
|---|---|---|
| Entrant identity, seed, status, kind | `public_entrants_v` (`id, division_id, kind, display_name, seed, status, members, team_display, badge_url`) — only `registered`/`confirmed` entrants of `public`/`unlisted` competitions | `db/migration/deltas/V350__person_tombstone_views.sql:18-52` (latest redefinition; columns since V236/V242/V289) |
| Consent-masked entrant names and members | `getPublicDivision(orgSlug, compSlug, divSlug).entrants` → `maskPublicEntrantNames` re-derives every `members[].name` through `resolvePersonDisplayName` and masks a non-team `display_name` | `apps/web/src/server/public-site/data.ts:610-686`, `:510-607`; resolver `apps/web/src/lib/name-display.ts:72-81` |
| Crest | `resolveEntrantBadge({ badge_url, team_logo_path })` — entrant badge wins, then team/club logo, else null → `EntityLogo` initials | `apps/web/src/lib/entrant-badge.ts:8-16`; `apps/web/src/components/ui/entity-logo.tsx:16-62` |
| `entrants.badge_url` IS written (organiser flow exists) | `setEntrantBadge` + `POST/DELETE /api/v1/entrants/[id]/badge`; PATCH accepts an external URL | `apps/web/src/server/usecases/entrants.ts:524-562`; `apps/web/src/app/api/v1/entrants/[id]/badge/route.ts:8-33` |
| Team colour | `team_display_v.colors` (team → club inherit), key `primary` | `db/migration/jul3/V242__clubs_and_imports.sql:60-78` (view), `:13` (clubs.colors); the only reader of the key: `apps/web/src/server/usecases/exports.ts:261-262` (`colors->>'primary'`) |
| Squad number, position, captain, roles | `entrant_members (entrant_id, person_id, org_id, squad_number, default_position_key, is_captain, roles)` — `is_captain`/`roles` are NOT exposed by `public_entrants_v.members` | `db/migration/v2-engine/tables/V213__entrant_members.sql:1-10`; view members shape `V350:18-31` |
| Position noun, localised | `positionLabel(key, m, engineLabel?)` over the `ui` namespace | `apps/web/src/lib/scoring-vocab.ts:1191` |
| Player-page link gate | `members[].person_id` is non-null only with `public_name` consent AND `org_has_feature(org, 'dashboard.player_profiles')`; `getPublicPlayer` 404s without the entitlement | `V350:26-28`; `data.ts:800-810`; `public_players_v` `V350:54-70` |
| Fixtures per entrant, live | W2's hub document `CompetitionHubDoc.matches[]` (`HubMatch.header.sides[i].entrantId`, `bucket`, `href`, `resultLine`) polled by `useLiveCompetition` (`HUB_POLL_MS` = W1's `POLL_MS` 15 000) + `division:{id}` Realtime | W2 Task 1 schema, Task 4 `loadCompetitionHub`, Task 5 endpoint `GET /api/v1/public/orgs/{org}/competitions/{slug}/hub`, Task 7 hook |
| Standings per entrant (record, rank) | W2's `TableView.rows[]` (`rank`, `cells` aligned to `columns[].key`: `played won drawn lost points …`) built from `public_standings_v` snapshots — never recomputed | W2 Task 2 `buildTableView`; snapshots `data.ts:279-298` |
| Phone-composed table, match card, tab rail, transport | W2's `StandingsTableView`, `MatchCard`, `PublicTabRail`, `useLiveCompetition` | W2 Tasks 2, 7 |
| Per-player season stats | `player_stat_snapshots (division_id, person_id, org_id, sport_key, stats, computed_through_seq)` folded by the engine's declared `PlayerStatsModel`; W2's `readLeaderRows(sql, divisions)` refreshes the watermark (`recomputePlayerStats`) and returns rows with `personId`, `stats`; `specsFor(sportKey, model)` names the metrics that matter per sport | `db/migration/jul3/V248__player_stats.sql:6-15`; `apps/web/src/server/usecases/player-stats.ts:55-60`; W2 Task 3 `leaders.ts`/`public-leaders.ts` |
| Per-entrant calendar | `GET …/[divisionSlug]/calendar.ics?entrant=<id>` | `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route.ts:26,59-77` |
| Share bar, footer, theme | `ShareBar` (W2 adds `labels`); layout footer "Powered by seazn" unless `org.branded`; `publicThemeStyle(competition.branding)` | `apps/web/src/components/share-bar.tsx:23`; `apps/web/src/app/(public)/shared/[orgSlug]/layout.tsx:107-116`; `[divisionSlug]/page.tsx:301` |
| Entitlements | `org_has_feature` / `hasFeature(orgId, key, competitionId?)` — REUSED as-is (`realtime`, `dashboard.player_profiles`, `dashboard.branding`); nothing new gated (R6) | `apps/web/src/lib/entitlements.ts:454`; `data.ts:361-365,732-734` |
| Not-found and rename | `sharedRenameTarget(orgSlug, compSlug?, divSlug?)` → redirect target or null | `apps/web/src/server/slug-resolve.ts:146-152` |
| ISR contract | every `/shared` page exports `revalidate` and an empty `generateStaticParams`; the test enumerates pages by file | `apps/web/src/lib/__tests__/public-isr-contract.test.ts:25-67` |

## Composition options at 320–430 (one DOM, `max-md:*` branches; ≥768 adds columns, never controls)

**Option A — shell parity: court header + tab rail (RECOMMENDED).**

```
‹ Org / Competition / Division                        (breadcrumb)
┌──────────────────────────────────────────────┐
│ [crest] TEAM · Men's T8                      │  ← eyebrow: kind + division link
│         SOUTHEND BLUE BLAZERS                │  ← 43-char name truncates with title
│         P 6 · W 4 · L 2 · Pts 12 · Position 2 of 8   (or "No results yet")
└──────────────────────────────────────────────┘
[Share] [WhatsApp] [Copy link]
[Fixtures] [Squad] [Table]        ← PublicTabRail, role=tablist, tabindex=0; tabs by PRESENCE
… Fixtures: LIVE NOW card · UPCOMING cards · RECENT RESULTS cards · Add to calendar
… Squad:    #7 Arun Kumar (C) · Batter · Runs 84 · Wickets 3   (one row per member; masked shows "Arun K.")
… Table:    the division table (P W L Pts at 320, long tail behind W2's disclosure) with THIS row highlighted
Powered by seazn
```

- Pros: the same shell as the match centre (W0 option A) and the landing (W2) — a spectator who learned one page knows this one; `?tab=squad` deep links for the captain's share; every panel is short; live in place through the one hub subscription; three components reused unchanged (`MatchCard`, `StandingsTableView`, `PublicTabRail`); tabs vanish by presence (a knockout-only division has no Table tab, a team with no roster has no Squad tab — R4/R9), so the empty cases are structural rather than copy.
- Cons: the squad (the captain's reason to share) is one tap away from first paint; three panels mean three per-tab screenshots per width in the R11 sign-off.
- ≥768: the fixtures grid goes two-up (`md:grid-cols-2`, as W2's Matches tab), the squad list two-up; the rail stays. Control set at 320 == 1280 except W2's `mh-table-more-*` phone disclosure inside the table.

**Option B — one scrolling page, no rail.**

```
header (as A) → share → NEXT / LIVE match hero card → RECENT RESULTS (3) + "All fixtures" disclosure
→ SQUAD grid → TABLE window (this row ±2, "Full table" link) → Add to calendar → footer
```

- Pros: a captain's share lands on everything in one scroll (~1 400–1 800 px for a 12–15 player squad); no tab state; the squad is on the page without a tap.
- Cons: a second composition idiom on a surface whose two shipped pages are rails (the W0 ruling picked tabs over the scrolling page for the match centre); needs a NEW "table window" view (rows around the entrant) instead of reusing `StandingsTableView`; a live match mid-page competes with the header for the fold; a disclosure for "All fixtures" is a phone-only control unless it is kept at 1280 too.

**Option C — squad first (for captains).** Header → squad grid → fixtures → table. Rejected: a parent or a player arriving mid-match wants the live match first; it contradicts the surface's own rule that the score strip comes first ("Option 2 — score strip up, chrome down") and would make the team page the one public page where a live score is below the fold.

**Recommendation: A**, with B kept as the named alternate. The owner reverses by naming the letter, as with the W0 picks. The one thing A must get right for the captain: the FIRST tab is Fixtures with the live or next match as its first card, so the share still answers "when do we play" without a tap.

## Data the page needs and where it comes from (one authority per fact — R5)

| Fact on the page | Authority | Reader |
|---|---|---|
| Name (masked for a non-team entrant with an opted-out member; youth rule) | `maskPublicEntrantNames` | `getPublicDivision().entrants` — reused |
| Crest / colour / seed / kind | `public_entrants_v` + `resolveEntrantBadge` + `team_display_v.colors.primary` | `getPublicDivision().entrants`, W2's `primaryColour` |
| Record P/W/D/L/Pts and position | the standings SNAPSHOT (`TableView.rows[]`) — never recomputed from fixtures | `entrantStanding(doc, divisionId, entrantId)` — the FIRST table in the hub document's order (unfinished stages first) that contains the entrant |
| Live / upcoming / recent fixtures | the hub document's `matches[]` (status bucket from W2's `bucketFixture`, order from `sortHubMatches`) | `entrantMatches` + `splitEntrantFixtures` |
| Result sentence on a card | `decidedOutcomeText` via W2's `HubMatch.resultLine` | W2's `MatchCard` unchanged |
| Squad names, numbers, captain, position | `entrant_members` + `persons.consent` through `resolvePersonDisplayName`; `positionLabel` | NEW `readPublicSquad` (the `maskPublicEntrantNames` query shape, `data.ts:562-569`) |
| Player link | `public_players_v` (consent) AND `hasFeature(org, "dashboard.player_profiles", competitionId)` — the two gates `public_entrants_v.members[].person_id` already encodes | `readPublicSquad` (`public_profile` exists-check, as W2's `readLeaderRows`) + `loadTeamPage` (entitlement, outside the cache as `getPublicPlayer` does) |
| Season line per player | `player_stat_snapshots` folded by the engine's `PlayerStatsModel`; which metrics = W2's `specsFor(sportKey, model)` (COUNT metrics only — the engine declares no ratio floor, W2 P9) | W2's `readLeaderRows` (also refreshes the watermark) → `buildSquad` |
| Calendar | existing `calendar.ics?entrant=` | a link |
| Live updating | W2's hub poll/Realtime | `useLiveCompetition` — one subscription per page |

Per-MATCH lines ("34 (21) & 2/18") stay on the player page (W2 Task 14, from W1's fold); the team page shows SEASON lines only and links to the player page for the rest.

## Explicitly out of scope for W5

Organiser-set team content (bios, photos, "team news" — no organiser console change, decision 4); a team poster (W3 owns posters; a per-team poster is a later candidate); a team gallery (W4's Gallery tab is competition-scoped); ratio season lines (strike rate, economy — no engine floor declared; wait for the `leaderboards` declaration W2 asked for); a cross-competition team profile (`teams` table) — this page is per ENTRANT in a division; links from the match centre's court-card sides into the team page (W1's control set is signed off; adding two links there is a W1 amendment, recorded as Q7); the sitemap (division pages are listed, team pages are not — `apps/web/src/app/sitemap.ts:33-47`; a candidate follow-up, not W5); the `present` slides; the landscape OG card (the team page inherits the division's `opengraph-image.tsx`, which is the standings card — acceptable for W5, recorded as Q9); entitlement matrix rows (R6).

## Owner questions — must be ruled before Part 2 executes

Recorded, not asked (this session cannot ask the owner). Each carries the product-owner recommendation and its reasoning; the owner rules by number.

- **Q1 — Is the public team page in scope at all?** The record: spec §W2 Teams (line 449–450) says *"No public team page (out of scope, noted as a later candidate after W5)"*; spec §W5 (lines 562–567) records it as *"The queued candidate is the **public team page** (`…/teams/[entrantId]`: badge, squad, results, upcoming, table position — captains share it to their squad), recommended to the owner 2026-09-05 and not yet ruled on. Own design pass after W4."*; `_INDEX.md:22` lists W5 as *"Public team page (candidate; …) — Not designed, not yet ruled"*, and `_INDEX.md:94-97` records the recommendation as MINE, not the owner's. **Recommendation: yes, as W5 after W4.** Value: the captain's one link (the growth loop drawn as a share, R8) for zero organiser work; cost: nine tasks, most of it reuse of W2 — the only new server code is one squad reader.
- **Q2 — Route.** The spec's sketch `…/teams/[entrantId]` names no parent segment. **Recommendation: `/shared/[org]/[comp]/[div]/teams/[entrantId]`** — an entrant belongs to exactly one division; the breadcrumb, the `calendar.ics?entrant=` sibling and the division's ISR tag all live there; a competition-level `…/[comp]/teams/[entrantId]` would need a division lookup on every render.
- **Q3 — Which entrant kinds get a page?** Teams only, or every entrant (individual, pair)? **Recommendation: every kind.** The value ("when do WE play next", results, table position) is identical for a singles player in a ladder; the page adds no personal data the division page does not already show (the same masked `display_name`); the only difference is copy — the eyebrow reads Team / Pair / Player and the second tab reads "Squad" for a team, "Players" otherwise. A withdrawn or disqualified entrant 404s because `public_entrants_v` hides it (its division-page card vanishes the same way) — keep that.
- **Q4 — Testid prefix.** The brief suggested `mt-*`. **Recommendation: `tm-*`** ("team"): `mt-` is also Tailwind's margin-top utility (`mt-3`), so every `grep mt-` over markup or e2e returns hundreds of classes; `tm-` has zero matches in `apps/web/src` and `apps/web/e2e` today. If the owner prefers `mt-`, it is a global rename of the `tm-` literals in Tasks 5–8 and the smoke markers — decide before Task 5.
- **Q5 — Season lines.** **Recommendation: show the engine's declared COUNT metrics only** (cricket runs · wickets · sixes; football goals · assists — W2's `LEADER_SPECS`, max two per player, zeros dropped), never a ratio: `PlayerStatsModel` declares no minimum-balls floor (W2 P9), so a strike rate over three balls would be a wrong number with the authority of a stat.
- **Q6 — The captain marker.** `entrant_members.is_captain` is organiser-entered roster data not exposed publicly today (the view omits it). **Recommendation: show it** as a "C" chip with a localised title — a fact visible to anyone at the ground, on the same masked name; no consent axis is added. If the owner declines, Task 2 drops one field and Task 5 one chip.
- **Q7 — Links INTO the page from the match centre's court card sides.** **Recommendation: not in W5.** W1's control set is signed off; W5 reaches the page from the competition Teams tab (W2's `TeamCard.href` repointed), the division Entrants list and every standings row. Recorded as a W1 amendment candidate.
- **Q8 — Composition: A or B** (§"Composition options"). **Recommendation: A.**
- **Q9 — Share image.** The team page inherits the division's `opengraph-image.tsx` (the standings card). **Recommendation: accept for W5**; a team OG card (crest + record) is a W3-family follow-up.
- **Q10 — Roster edits reach the page within the ISR window (30 s), not instantly.** `entrants.ts` fires no `fireDivisionRevalidate` (callers: `registration-approval.ts`, `schedule.ts`, `registrations.ts` only), so today's division Entrants list has the same lag. **Recommendation: accept** (R10 is about matches in play; a roster is not live) and record it in `_INDEX.md`.

## False premises found and positive findings (re-pin against the tree before building)

1. **`entrants.badge_url` IS written** by an organiser flow (`setEntrantBadge`, the badge route) — the spec's watch-list doubt ("a column read everywhere and written nowhere") does not apply; the crest path is proven with a real badge, `team_display_v.logo_path` AND the monogram fallback.
2. **`public_entrants_v.members[].person_id` is gated by the entitlement as well as consent** (V350:26-28). A "consent-resolved name" alone does not decide whether a name links; the squad reader applies both gates, like the view.
3. **`is_captain` and `roles` never reach the public view** — the squad reader reads the base table (the `maskPublicEntrantNames` precedent) rather than widening a view many correct consumers read.
4. **`PlayerStatsModel` declares no leaderboard floor** (W2 P9 — `packages/engine/src/stats/stats.ts:106-200`) — respected: count metrics only.
5. **`sortHubMatches` already orders completed matches newest-first and upcoming soonest-first** (W2 Task 1) — the recent list needs no second sort; a second sort here would be a second authority.
6. **Roster edits fire no public revalidation** (Q10).
7. **The division-create API response carries `slug`** (`apps/web/src/server/api-v1/schemas.ts:315`) — the mobile seed can build the team route without a second lookup.
8. **W2's Teams tab links to `?tab=entrants` because the spec said "No public team page"** — W5 repoints `TeamCard.href` and amends W2's walkthrough step 7 assertion ("click one → the division page opens at `?tab=entrants`" becomes "→ the team page opens").

---

# Part 2 — Implementation plan (Option A)

## Global Constraints

Copied from the spec's "Standing rules for every public page" (binding) and the programme's repo constraints; every task's requirements implicitly include this section.

- Worktree `.claude/worktrees/spectator`, branch `feat/spectator-surface`; never the main checkout. `pnpm install --frozen-lockfile`; **pnpm, never `npm install`**. One PR for the wave (spec §"Wave order, PRs, gates").
- **R1 — Phone composition, not shrink.** Each page is designed at 320/375 first; ≥768 may add columns or lay cards two-up, never new controls. Verify with a **control-set diff from the live DOM at 320 against 1280** — membership, order, repeats — not box sizes. Any scrolling region carries `tabindex="0"`, a role and an accessible name; no page scrolls horizontally at 320/360/375/390/430/768/834. One DOM, branched with `max-md:*` / `md:hidden`; `/\bmd:hidden\b/` also matches inside `max-md:hidden` — anchor assertions on `\s...hidden"`.
- **R2 — Every string through the `public` dictionary namespace in all four locales**, `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`, keys written BARE (`team.*`, never `public.team.*`), then `npm run i18n:gen-keys` (regenerates `apps/web/src/lib/i18n-keys.ts` — never hand-edit) and `npm run i18n:check`. Standings abbreviations P W D L Pts stay as notation with a localised `title`.
- **R3 — Consent before names.** Every person name on a public page goes through `resolvePersonDisplayName(fullName, consent, divisionSetting, youth)` (`apps/web/src/lib/name-display.ts:72`); entrant display names through `maskPublicEntrantNames` (`data.ts:510`). Never a second resolver. A masked line renders the masked label, never a blank row. Youth rule as in `fixtureCardModel`. A player-page link only with `public_name` consent AND `dashboard.player_profiles`.
- **R4 — Fidelity ladder from the engine / tabs by presence.** A tab that would be empty is not rendered. No "coming soon".
- **R5 — One authority per fact.** Standings numbers come from `public_standings_v` snapshots only (never recomputed); the result sentence from `decidedOutcomeText`; season stats from `player_stat_snapshots` folded by the engine's declared model; which metrics from W2's `specsFor`; position nouns from `positionLabel`; the venue zone as materialised by `getPublicDivision`'s `tz`.
- **R6 — No new entitlement rows.** Match centre, scorecard, commentary and poster are on every plan: they are the growth loop. Existing gates reused as-is — Realtime push on Pro and poll otherwise; `org.branded` decides the page footer; `dashboard.player_profiles` decides the player link exactly as `public_entrants_v` already does. Entitlements v18 is in flight; this programme adds nothing to its matrix.
- **R7 — Testids on every new control** (`tm-…` for the team page — Q4; W2's `mh-…` inside the reused `MatchCard`/`StandingsTableView`); every wave extends `apps/web/e2e/walkthrough/spectator-public.spec.ts`. Setup may use the API to REACH a state, but **at least one over of the cricket match under test is TAPPED through the real pad** (W1's block in the same spec) and read on THIS wave's page too.
- **R8 — The share loop is a feature.** Every public page has the share bar (copy link, WhatsApp, native share). The free-tier footer "Powered by seazn" stays on every public page of a non-branded org (inherited from `layout.tsx`).
- **R9 — Empty case first.** Every aggregate (fixture buckets, squad, standing, tabs) states its empty case in its test BEFORE its ladder, and every ladder test carries an order-differential case.
- **R10 — Live means live, never reload.** Every public surface that shows a match in play updates **in place**; transport is the existing pair — Supabase Realtime push on Pro, polling otherwise (15 s today) — carrying the same public JSON the page rendered from, so a push and a poll produce the same DOM. A spectator is never told to refresh, and a page never reloads itself. The proof is end to end: the walkthrough posts an event through the API while the anonymous page is open and asserts the DOM changes within one poll interval with no navigation; a test that reloads to see the change has not tested this rule.
- **R11 — Visual sign-off, per screen, cosmetics included.** Every page, every tab and every state it touches is screenshotted at 320, 768 and 1280 on a prod build with real data and READ by a person — alignment and baselines, spacing rhythm, button and pill sizes and their consistency across screens, text wrapping and truncation (a 43-character name is the test), colour and contrast, icon alignment, tap targets ≥ 44 px measured with `elementFromPoint`, overlaps and clipped text, empty and error states. Per-screen verdict table appended to the spec ("W5 sign-off — per-screen verdicts"), each row naming what was seen. A cosmetic defect is a defect: fixed before the PR, never parked as polish.
- Design: build to `docs/superpowers/specs/2026-09-04-spectator-prompts/_DESIGN.md` §5 W5 (PROPOSED in full, P12) — the form strip under the crest, five coloured squares that tell the season's story before a word is read; tokens and classes by name, never new colours or radii; R11 reads each screen against the _DESIGN checklist.
- ISR contract: the new page exports `export const revalidate = 30;` and `export async function generateStaticParams() { return []; }` exactly and is added to `apps/web/src/lib/__tests__/public-isr-contract.test.ts` CASES; never read `searchParams`/`cookies()`/`headers()` in the server component (the `?tab=` parameter is read on the client — W2 Task 11's pattern).
- Assertions on Next HTML anchor on `="` — an omitted prop serialises as `"$undefined"`.
- Subagents: Opus at minimum (frontmatter; never pass `model:`); scoped vitest/tsc only — the orchestrator runs the full gate from `apps/web` with `--reporter=json --outputFile` and judges `numTotalTests`/`numFailedTests`/`numFailedTestSuites`, never exit codes; `cd <worktree>/apps/web &&` in the SAME call as any verify command and confirm `.testResults[].name` paths are under the worktree. Every `apps/web` round ends with `pnpm exec tsc --noEmit -p tsconfig.json` (a zod `.default()` makes a field REQUIRED on the output type — W1 lesson).
- Commit after every task with a normal-prose message ending in the two trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01TCLYbFJZ8bseHS4kp4nGDa`. In this worktree git commands are plain `/usr/bin/git <verb> …` with no compound shell around them; `git stash` is never used here (shared stash stack).
- Do NOT touch: the organiser console (`apps/web/src/app/o/**`, `components/v2/**`), the scorepad, the engine (`packages/engine/**`), registration pages, the `present` slides, the landscape OG card and the division's `opengraph-image.tsx`, entitlement matrix/copy, `e2e.yml`, W1's match centre components (the court card gains no links — Q7), W2's public API routes (no new endpoint, no OpenAPI change — `npm run openapi:gen && /usr/bin/git status --porcelain openapi` must print nothing at the end of every task).

---

## File structure

**Pure helpers (`apps/web/src/lib/`)**
- `team-page.ts` — NEW, client-safe: `TeamTabId`, `entrantMatches`, `splitEntrantFixtures`, `entrantStanding`, `deriveTeamTabs`. Slices of W2's hub document; no server imports.

**Server (`apps/web/src/server/public-site/`)**
- `team-page.ts` — NEW: `SquadMember`, `buildSquad` (pure), `readPublicSquad` (one SQL read → `buildSquad`), `TeamPageData`, `loadTeamPage` (composes `getPublicDivision`, `getPublicCompetitionHub`, `readLeaderRows`, `readPublicSquad`; `unstable_cache` on the squad, tags `divisionTag` + `competitionTag`, `REVALIDATE_FAST`).
- `competition-hub.ts` — MODIFY (W2 Task 4's file): `TeamCard.href` → the team page; `export` on `primaryColour` if W2 left it module-private.

**UI (`apps/web/src/components/public-site/`)**
- `team-page/team-header.tsx`, `team-page/team-fixtures-tab.tsx`, `team-page/team-squad-tab.tsx`, `team-page/team-table-tab.tsx` — NEW, hookless.
- `team-page/team-page.tsx` — NEW client root (`useLiveCompetition`, `PublicTabRail testidPrefix="tm"`, `?tab=`).
- `standings-table-view.tsx` — MODIFY (W2 Task 2's file): two ADDITIVE optional props, `highlightEntrantId?: string` and `rowHref?: (row: TableRowT) => string | null`.
- `matches-hub/table-tab.tsx` — MODIFY (W2 Task 9's file): pass `rowHref` so every standings row on the landing links to a team page.

**Pages (`apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/`)**
- `teams/[entrantId]/page.tsx` — NEW (ISR 30, `generateStaticParams`, metadata, breadcrumb, `<TeamPage>`).
- `page.tsx` — MODIFY (after W2 Task 13): the Entrants panel's entrant name becomes a link to the team page (`tm-link-{entrantId}`); the Standings panel passes `rowHref`.

**Dictionaries**: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (`team.*` keys) + `npm run i18n:gen-keys`.

**Tests**: `apps/web/src/lib/__tests__/team-page.test.ts`; `apps/web/src/server/public-site/__tests__/{team-page-squad,team-page-load,team-dictionary}.test.ts`; `apps/web/src/components/public-site/__tests__/{team-header,team-fixtures-tab,team-squad-tab,team-table-tab,team-page}.test.tsx`; `apps/web/src/components/public-site/__tests__/standings-table-view.test.tsx` (extend); `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/teams/[entrantId]/__tests__/page.test.tsx`; `apps/web/src/lib/__tests__/public-isr-contract.test.ts` (one CASE); `apps/web/e2e/walkthrough/spectator-public.spec.ts` (W5 block); `apps/web/e2e/mobile.spec.ts` (one route); `scripts/smoke.ts` (two checks).

---

## Premises to re-pin before execution (DRAFT until each is checked)

Every line number below was opened on 2026-09-05 on `feat/spectator-surface`; W1 is mid-execution and W2–W4 are drafts, so anything they touch can move. A false premise is a finding for `_INDEX.md`, not a blocker.

| # | Premise | Pinned at | Moves when |
|---|---|---|---|
| P1 | W2's names this plan consumes: `CompetitionHubDoc`/`HubMatch`/`TableView`/`TableRow`/`TableColumn`/`TeamCard` + `…T` types (`competition-hub-schema.ts`), `bucketFixture`/`sortHubMatches`/`MatchBucket` (`lib/matches-hub.ts`), `buildTableView` + `StandingsTableView({ view, dict, testid, preview?, showFullLink? })`, `readLeaderRows(sql, divisions)`/`LeaderInputRow`, `specsFor(sportKey, model)`/`LeaderSpec`, `loadCompetitionHub`/`getPublicCompetitionHub(orgSlug, compSlug)`/`hubSide`/`primaryColour`, `useLiveCompetition({ orgSlug, competitionSlug, initial, realtime })` + `HUB_POLL_MS`, `PublicTabRail({ tabs, active, onChange, ariaLabel, testidPrefix })`, `MatchCard({ match, dict, locale, now, showDivision?, compact? })`, `shareLabels(dict)`, `ShareBar labels`. | W2 plan Tasks 1, 2, 3, 4, 7, 12, 16 | W2 merge — re-pin every one |
| P2 | W1's `Person`/`PersonT` (`{ personId, name, masked }`), `Msg`, `Side` and `MatchCentreHeader` are on this branch (`match-centre-schema.ts:9-24,83-85`); `useNow()` at `match-centre/use-now.ts:12`; W1 keys `matchCentre.info.addToCalendar` / `.division` / `.competition` exist in all four `public.json` files (`en/public.json:135-137`). | this branch | W1 merge |
| P3 | `apps/web/e2e/walkthrough/spectator-public.spec.ts` does NOT exist yet (W1 Task 15 creates it and deletes the W0 harness); the seeding helpers `postEvent`, `mustPost`, `createPersons`, `playInnings`, `fixtureSides`, `putLineups`, `setScheduledAt`, `armCookieBypass`, `controlSet` live in `apps/web/e2e/walkthrough/w0-spectator-capture.spec.ts:36-289` today; W2 Task 17 may move `controlSet` into `e2e/spectator-kit.ts`. Task 8 imports from wherever W1/W2 left them. | `w0-spectator-capture.spec.ts` | W1/W2 merge |
| P4 | `public_entrants_v.members[].person_id` is non-null only with consent AND `org_has_feature(c.org_id, 'dashboard.player_profiles')` (`V350:26-28`); `getPublicPlayer` evaluates `hasFeature(org, "dashboard.player_profiles", competition.id)` OUTSIDE its cache (`data.ts:800-810`). The squad's player link uses the same two gates. | `V350`; `data.ts:808` | schema/entitlement change |
| P5 | `entrants.badge_url` is written (`entrants.ts:524-562`; badge route) — positive finding, no gap to record. | `entrants.ts`, `api/v1/entrants/[id]/badge/route.ts` | — |
| P6 | `team_display_v.colors` key is `primary` (`exports.ts:261-262`); W2's `primaryColour(colors: unknown): string | null` (Task 4) is the one helper — if W2 kept it module-private, Task 3 adds ONE `export` keyword rather than a second helper. | `competition-hub.ts` (W2) | W2 merge |
| P7 | `PlayerStatsModel` declares no floor (`stats.ts:106-200`); `labelPlayerStats(sportKey, moduleVersion, stats, msg)` (`server/player-stats.ts:80`) is the display labeller; W2's `specsFor` picks the metrics. | `stats.ts`; `player-stats.ts` | engine `leaderboards` declaration |
| P8 | `entrant_members` columns `squad_number, default_position_key, is_captain, roles` (`V213:5-8`); `maskPublicEntrantNames`'s member query shape and order `em.squad_number nulls last, p.full_name` with `p.merged_into is null` (`data.ts:562-569`). | `V213`; `data.ts` | migration |
| P9 | `positionLabel(key, m: MsgFn, engineLabel?)` resolves through the `ui` namespace (`scoring-vocab.ts:1191`); `MsgFn = (key: MessageKey, vars?) => string` (`:1147`); `msgFor(locale, key, vars)` (`messages-i18n.ts:24`). | `scoring-vocab.ts` | — |
| P10 | `calendar.ics?entrant=<id>` exists and names the feed after the entrant (`calendar.ics/route.ts:26,116-118`). | route file | — |
| P11 | `public_entrants_v` hides `withdrawn`/`disqualified` entrants (`V350:51-52`) → a withdrawn team's page 404s (Q3). | `V350` | owner ruling |
| P12 | Division-create API response carries `slug` (`schemas.ts:311-315`); `addEntrantsViaApi(request, divisionId, names, kind?, seedOffset?)` returns `{ status, ids }` (`e2e/helpers.ts:1366-1372`). | `schemas.ts`; `helpers.ts` | — |
| P13 | `invalidatePublicCache` fires `fireDivisionRevalidate(division_id, competition_id)` on every scoring write (`scoring.ts:507-511`) → the squad cache (tagged `division:{id}`) re-derives after a result; `entrants.ts` fires nothing (Q10). | `scoring.ts`; `entrants.ts` | — |
| P14 | W1's `MatchCentre` root reads the `?tab=` param from a server prop (`match-centre.tsx:47-50`) while W2's `CompetitionLanding` reads it on the client in a mount effect (W2 Task 11 Step 6) to keep the ISR contract. This plan follows W2; if W2 landed a different client-side read (e.g. to satisfy `react-hooks/set-state-in-effect`), copy THAT pattern into Task 6. | `match-centre.tsx`; W2 Task 11 | W2 merge |
| P15 | The island harness `renderIsland` (`apps/web/src/components/__tests__/_hook-harness.tsx`) supports `useState`/`useEffect`/`useMemo`/`useCallback`/`useRef`/`useContext`; `stubFetch`/`stubInterval` are file-local in `public-site/__tests__/live-score.test.tsx:26-55` (W2 P16). `window` is undefined in the harness — every `window.` read in a client root is guarded. | `_hook-harness.tsx:1-60` | — |
| P16 | `sharedRenameTarget(orgSlug, compSlug?, divSlug?)` returns the DIVISION path (`routes.shared(...)`, `slug-resolve.ts:146-152`); Task 7 appends `/teams/${entrantId}` — pin `routes.shared`'s return shape before wiring. | `slug-resolve.ts` | — |
| P17 | `scripts/smoke.ts:13906-13931` has `comp`, `div` and an entrant id in scope (the `calendar.ics?entrant=` check); `html(newSession(), path)` (`:12641`) and `check(name, bool)` are the helpers. | `smoke.ts` | — |

---

### Task 1: Pure slice helpers — `lib/team-page.ts`

**Files:**
- Create: `apps/web/src/lib/team-page.ts`
- Test: `apps/web/src/lib/__tests__/team-page.test.ts`

**Interfaces:**
- Consumes: `CompetitionHubDocT`, `HubMatchT`, `TableViewT`, `TableRowT` (`@/server/public-site/competition-hub-schema`, W2 — P1); `sortHubMatches` (`@/lib/matches-hub`, W2 Task 1).
- Produces:
  ```ts
  export type TeamTabId = "fixtures" | "squad" | "table";
  export function entrantMatches(doc: Pick<CompetitionHubDocT, "matches">, entrantId: string): HubMatchT[];
  export interface EntrantFixtures { live: HubMatchT[]; upcoming: HubMatchT[]; recent: HubMatchT[] }
  export function splitEntrantFixtures(matches: readonly HubMatchT[], recentLimit?: number): EntrantFixtures;   // default 5
  export interface EntrantStanding {
    table: TableViewT; row: TableRowT; position: { rank: number | null; of: number };
    record: { played: string; won: string; drawn: string | null; lost: string; points: string } | null;
  }
  export function entrantStanding(doc: Pick<CompetitionHubDocT, "tables">, divisionId: string, entrantId: string): EntrantStanding | null;
  export function deriveTeamTabs(c: { matches: number; squad: number; table: boolean }): TeamTabId[];
  ```

- [ ] **Step 1: Write the failing tests — EMPTY case first, then the ladders with order-differential cases**

`apps/web/src/lib/__tests__/team-page.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { HubMatchT, TableViewT } from "@/server/public-site/competition-hub-schema";
import { deriveTeamTabs, entrantMatches, entrantStanding, splitEntrantFixtures } from "@/lib/team-page";

const side = (entrantId: string) => ({ entrantId, name: entrantId.toUpperCase(), short: entrantId.slice(0, 3).toUpperCase(), colour: null, badgeUrl: null });
/** A hub match in W2's shape; only the fields the helpers read are varied. */
const m = (fixtureId: string, bucket: HubMatchT["bucket"], scheduledAt: string | null, home: string, away: string): HubMatchT => ({
  fixtureId, divisionId: "d1", divisionSlug: "t8", divisionName: "Men's T8", sportKey: "cricket",
  stageName: "League", roundNo: 1, roundLabel: null, bucket, tz: "Europe/London", scheduledAt,
  venueName: null, courtName: null, href: `/shared/o/c/t8/fixtures/${fixtureId}`,
  header: {
    live: bucket === "live", status: bucket === "live" ? "in_play" : bucket === "completed" ? "decided" : "scheduled",
    sides: [side(home), side(away)], scoreLines: [null, null], subLines: [null, null], battingIndex: null,
    statusLine: null, rateLine: null, updatedAt: "2026-09-05T12:00:00.000Z",
  },
  winnerIndex: null, resultLine: null,
});

describe("entrantMatches", () => {
  it("EMPTY: no matches → []", () => expect(entrantMatches({ matches: [] }, "e1")).toEqual([]));
  it("keeps a match with the entrant on EITHER side and drops the rest (positive and negative pair)", () => {
    const doc = { matches: [m("a", "upcoming", "2026-09-06T13:00:00Z", "e1", "e2"), m("b", "upcoming", "2026-09-07T13:00:00Z", "e3", "e1"), m("c", "upcoming", "2026-09-08T13:00:00Z", "e2", "e3")] };
    expect(entrantMatches(doc, "e1").map((x) => x.fixtureId)).toEqual(["a", "b"]);
    expect(entrantMatches(doc, "e3").map((x) => x.fixtureId)).toEqual(["b", "c"]);
  });
});

describe("splitEntrantFixtures — buckets and order", () => {
  it("EMPTY: [] → three empty lists", () => expect(splitEntrantFixtures([])).toEqual({ live: [], upcoming: [], recent: [] }));
  it("live first; upcoming soonest first (unscheduled last); recent NEWEST first and capped (order-differential: the older result is the one dropped)", () => {
    const out = splitEntrantFixtures([
      m("old", "completed", "2026-09-01T10:00:00Z", "e1", "e2"), m("late", "upcoming", "2026-09-09T10:00:00Z", "e1", "e3"),
      m("live", "live", "2026-09-05T10:00:00Z", "e1", "e4"), m("tbd", "upcoming", null, "e1", "e5"),
      m("soon", "upcoming", "2026-09-06T10:00:00Z", "e2", "e1"), m("new", "completed", "2026-09-04T10:00:00Z", "e6", "e1"),
    ], 1);
    expect(out.live.map((x) => x.fixtureId)).toEqual(["live"]);
    expect(out.upcoming.map((x) => x.fixtureId)).toEqual(["soon", "late", "tbd"]);
    expect(out.recent.map((x) => x.fixtureId)).toEqual(["new"]);            // "old" is the one the cap drops
  });
  it("the default cap keeps five results (positive pair for the cap above)", () => {
    const results = ["r1", "r2", "r3", "r4", "r5", "r6"].map((id, i) => m(id, "completed", `2026-09-0${i + 1}T10:00:00Z`, "e1", "e2"));
    expect(splitEntrantFixtures(results).recent.map((x) => x.fixtureId)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
  });
});

const col = (key: string, abbr: string, compact = true) => ({ key, abbr, title: abbr, compact });
const table = (id: string, divisionId: string, columns: TableViewT["columns"], rows: Array<{ entrantId: string; rank: number | null; cells: string[] }>): TableViewT => ({
  id, divisionId, divisionSlug: "t8", divisionName: "Men's T8", caption: `Table ${id}`, updatedAt: "2026-09-05T10:00:00Z", fullHref: "/shared/o/c/t8?tab=standings",
  columns, rows: rows.map((r) => ({ ...r, name: r.entrantId.toUpperCase(), badgeUrl: null, tieBreakText: null, champion: false })),
});
const PWLP = [col("played", "P"), col("won", "W"), col("lost", "L"), col("points", "Pts")];

describe("entrantStanding — record and position from the standings authority", () => {
  it("EMPTY: no tables → null; a table without the entrant → null", () => {
    expect(entrantStanding({ tables: [] }, "d1", "e1")).toBeNull();
    expect(entrantStanding({ tables: [table("t", "d1", PWLP, [{ entrantId: "e2", rank: 1, cells: ["1", "1", "0", "3"] }])] }, "d1", "e1")).toBeNull();
  });
  it("cells are read by column KEY, not position — a table with a different column order still yields the right record; D is null when there is no D column", () => {
    const shuffled = [col("points", "Pts"), col("lost", "L"), col("won", "W"), col("played", "P")];
    const s = entrantStanding({ tables: [table("t", "d1", shuffled, [{ entrantId: "e1", rank: 2, cells: ["12", "2", "4", "6"] }, { entrantId: "e2", rank: 1, cells: ["15", "1", "5", "6"] }])] }, "d1", "e1")!;
    expect(s.record).toEqual({ played: "6", won: "4", drawn: null, lost: "2", points: "12" });
    expect(s.position).toEqual({ rank: 2, of: 2 });
  });
  it("the FIRST table in the document's order that contains the entrant wins (order-differential: a later table also contains it)", () => {
    const first = table("group", "d1", PWLP, [{ entrantId: "e1", rank: 1, cells: ["3", "3", "0", "9"] }]);
    const later = table("overall", "d1", PWLP, [{ entrantId: "e1", rank: 4, cells: ["6", "3", "3", "9"] }]);
    expect(entrantStanding({ tables: [first, later] }, "d1", "e1")!.table.id).toBe("group");
    expect(entrantStanding({ tables: [later, first] }, "d1", "e1")!.table.id).toBe("overall");
  });
  it("another division's table never answers for this one, even with the same entrant id", () => {
    expect(entrantStanding({ tables: [table("t", "d2", PWLP, [{ entrantId: "e1", rank: 1, cells: ["1", "1", "0", "3"] }])] }, "d1", "e1")).toBeNull();
  });
  it("record is null when a structural column is missing (a bracket-only view), position still answers", () => {
    const s = entrantStanding({ tables: [table("t", "d1", [col("points", "Pts")], [{ entrantId: "e1", rank: null, cells: ["0"] }])] }, "d1", "e1")!;
    expect(s.record).toBeNull();
    expect(s.position).toEqual({ rank: null, of: 1 });
  });
});

describe("deriveTeamTabs — tabs by PRESENCE in a fixed order", () => {
  it("EMPTY: nothing → [] (no rail; the page shows the header and the empty copy)", () => {
    expect(deriveTeamTabs({ matches: 0, squad: 0, table: false })).toEqual([]);
  });
  it("full → fixtures, squad, table in that order; each drops independently", () => {
    expect(deriveTeamTabs({ matches: 2, squad: 8, table: true })).toEqual(["fixtures", "squad", "table"]);
    expect(deriveTeamTabs({ matches: 0, squad: 8, table: true })).toEqual(["squad", "table"]);
    expect(deriveTeamTabs({ matches: 2, squad: 0, table: false })).toEqual(["fixtures"]);
  });
});
```

- [ ] **Step 2: Run to verify the suite fails to collect** (module missing)

Run: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && pnpm exec vitest run src/lib/__tests__/team-page.test.ts --reporter=json --outputFile=/tmp/spx-w5-t1.json; node -e "const r=require('/tmp/spx-w5-t1.json');console.log(r.numTotalTests,r.numFailedTests,r.numFailedTestSuites)"`
Expected: `0 0 1` (collection failure) — NOT a pass.

- [ ] **Step 3: Implement `lib/team-page.ts`**

```ts
// Spectator surface W5 — pure, client-safe helpers for the public team page.
// Everything here is a SLICE of the competition-hub document (W2): the page
// fetches nothing of its own for fixtures or standings, so a poll or push that
// moves the hub moves this page on the same tick (R10). No server imports.
import type { CompetitionHubDocT, HubMatchT, TableRowT, TableViewT } from "@/server/public-site/competition-hub-schema";
import { sortHubMatches } from "@/lib/matches-hub";

export type TeamTabId = "fixtures" | "squad" | "table";

/** Every hub match with the entrant on either side, in the hub's own order
 *  (live → upcoming soonest-first → completed newest-first). */
export function entrantMatches(doc: Pick<CompetitionHubDocT, "matches">, entrantId: string): HubMatchT[] {
  return sortHubMatches(doc.matches.filter((m) => m.header.sides.some((s) => s.entrantId === entrantId)));
}

export interface EntrantFixtures {
  live: HubMatchT[];
  upcoming: HubMatchT[];
  recent: HubMatchT[];
}

/** EMPTY CASE FIRST (R9): no matches → three empty lists. The order inside each
 *  list is `sortHubMatches`'s own — ONE authority for match order on the surface. */
export function splitEntrantFixtures(matches: readonly HubMatchT[], recentLimit = 5): EntrantFixtures {
  if (matches.length === 0) return { live: [], upcoming: [], recent: [] };
  const sorted = sortHubMatches(matches);
  return {
    live: sorted.filter((m) => m.bucket === "live"),
    upcoming: sorted.filter((m) => m.bucket === "upcoming"),
    recent: sorted.filter((m) => m.bucket === "completed").slice(0, recentLimit),
  };
}

export interface EntrantStanding {
  table: TableViewT;
  row: TableRowT;
  position: { rank: number | null; of: number };
  /** Pre-formatted cells from the standings SNAPSHOT (R5) — null when the view
   *  lacks a structural column (a bracket-only division has no P/W/L/Pts). */
  record: { played: string; won: string; drawn: string | null; lost: string; points: string } | null;
}

/** The FIRST table in the document's own order (the division page's relevance
 *  order: unfinished stages first) that belongs to `divisionId` and contains the
 *  entrant. Cells are looked up by column KEY — `TableRow.cells` is aligned to
 *  `TableView.columns`, whose order the builder may change. */
export function entrantStanding(doc: Pick<CompetitionHubDocT, "tables">, divisionId: string, entrantId: string): EntrantStanding | null {
  for (const table of doc.tables) {
    if (table.divisionId !== divisionId) continue;
    const row = table.rows.find((r) => r.entrantId === entrantId);
    if (!row) continue;
    const cell = (key: string): string | null => {
      const i = table.columns.findIndex((c) => c.key === key);
      return i === -1 ? null : (row.cells[i] ?? null);
    };
    const played = cell("played"), won = cell("won"), lost = cell("lost"), points = cell("points");
    const record = played !== null && won !== null && lost !== null && points !== null
      ? { played, won, drawn: cell("drawn"), lost, points }
      : null;
    return { table, row, position: { rank: row.rank, of: table.rows.length }, record };
  }
  return null;
}

/** Tabs by PRESENCE (R4). EMPTY: nothing → [] — the page renders its header and
 *  the empty copy and no rail. The order is fixed: fixtures · squad · table. */
export function deriveTeamTabs(c: { matches: number; squad: number; table: boolean }): TeamTabId[] {
  return [
    ...(c.matches > 0 ? (["fixtures"] as const) : []),
    ...(c.squad > 0 ? (["squad"] as const) : []),
    ...(c.table ? (["table"] as const) : []),
  ];
}
```

- [ ] **Step 4: Run — expect green**: same command; expected `numTotalTests` 12, `numFailedTests` 0. Then apply and RECORD two mutants in a "Mutants killed" comment at the top of the test file: (a) in `entrantStanding` read `row.cells[0]` for `played` instead of the key lookup → the shuffled-columns test reds; (b) in `splitEntrantFixtures` return `sorted.filter(completed).slice(-recentLimit)` → the newest-first cap test reds. Restore.

- [ ] **Step 5: Commit** — `/usr/bin/git add apps/web/src/lib/team-page.ts apps/web/src/lib/__tests__/team-page.test.ts` then `/usr/bin/git commit -F <message file>` — "web(team-page): pure slices of the competition-hub document — entrant matches, fixture buckets, standing by column key, tabs by presence (empty case first)" + the two trailers.

---

### Task 2: The squad builder (pure) — names through the one resolver, captain, position, season line, link gates

**Files:**
- Create: `apps/web/src/server/public-site/team-page.ts` (this task: `SquadRow`, `SquadMember`, `SquadBuildArgs`, `buildSquad`; Task 3 adds the reader and the loader)
- Test: `apps/web/src/server/public-site/__tests__/team-page-squad.test.ts`

**Interfaces:**
- Consumes: `resolvePersonDisplayName(fullName, consent, divisionSetting, youth)` (`apps/web/src/lib/name-display.ts:72`); `positionLabel(key, m, engineLabel?)` and `MsgFn` (`apps/web/src/lib/scoring-vocab.ts:1191,1147`); `specsFor(sportKey, model)` and `LeaderSpec` (`@/server/public-site/leaders`, W2 Task 3 — P1); `PlayerStatsModel` (`@seazn/engine/stats`); `PersonT` (`@/server/public-site/match-centre-schema`, W1 — P2).
- Produces:
  ```ts
  export interface SquadRow {              // one entrant_members ⋈ persons row, as the reader selects it
    person_id: string; full_name: string; consent: { public_name?: boolean } | null;
    squad_number: number | null; default_position_key: string | null; is_captain: boolean;
    public_profile: boolean;               // exists(select 1 from public_players_v v where v.id = p.id)
  }
  export interface SquadMember {
    person: PersonT;                       // { personId, name, masked }
    personHref: string | null;             // only with consent (public_profile) AND the entitlement AND an unmasked name
    squadNumber: number | null;
    position: string | null;               // localised noun via positionLabel, never the raw key
    isCaptain: boolean;
    seasonLine: string | null;             // "Runs 84 · Wickets 3" — W2's specsFor metrics, non-zero only, max two; null when none
  }
  export interface SquadBuildArgs {
    division: { sportKey: string; youth?: boolean; player_name_display?: string | null };
    model: PlayerStatsModel | undefined;   // resolveModule(sportKey, moduleVersion).playerStats, or undefined for a retired build
    playerProfiles: boolean;               // hasFeature(org, "dashboard.player_profiles", competitionId) — evaluated by the caller
    playerHref: (personId: string) => string;
    ui: MsgFn;                             // msgFor bound to the org locale — position nouns live in the `ui` namespace
    statLabel: (spec: LeaderSpec, model: PlayerStatsModel | undefined) => string;   // the SAME labeller the hub's leaders use
    stats: ReadonlyMap<string, Record<string, number>>;   // person_id → player_stat_snapshots.stats for this division
  }
  export function buildSquad(rows: readonly SquadRow[], a: SquadBuildArgs): SquadMember[];
  ```

- [ ] **Step 1: Write the failing tests** (pure — no DB; the cricket model comes from the real registry so the metric keys are the engine's own)

`apps/web/src/server/public-site/__tests__/team-page-squad.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { registry } from "@seazn/engine/sport";              // pin the exact import from server/engine-db/registry.ts:8
import { registerBuiltins } from "@seazn/engine/sports";
import { resolveLatestModule } from "@/server/engine-db";
import { positionLabel } from "@/lib/scoring-vocab";
import { specsFor } from "../leaders";
import { buildSquad, type SquadRow } from "../team-page";

registerBuiltins(registry);
const cricketModel = resolveLatestModule("cricket").playerStats;
const ui = (key: string) => String(key);                      // MsgFn stand-in: returns the key (label tests pin the WIRING, not the copy)

const row = (o: Partial<SquadRow> & { person_id: string; full_name: string }): SquadRow =>
  ({ consent: { public_name: true }, squad_number: null, default_position_key: null, is_captain: false, public_profile: true, ...o });
const args = (over: Partial<Parameters<typeof buildSquad>[1]> = {}) => ({
  division: { sportKey: "cricket", youth: false, player_name_display: null },
  model: cricketModel, playerProfiles: true, playerHref: (id: string) => `/shared/o/c/players/${id}`, ui,
  statLabel: (spec: { key: string; labelKey: string | null }) => spec.labelKey ?? spec.key,
  stats: new Map<string, Record<string, number>>(), ...over,
});

describe("buildSquad", () => {
  it("EMPTY: no rows → []", () => expect(buildSquad([], args())).toEqual([]));

  it("a public_name:false member is masked (never blank, not the full name) and gets NO link; a consenting member keeps the full name and links (positive pair)", () => {
    const out = buildSquad([row({ person_id: "p1", full_name: "Arun Kumar" }), row({ person_id: "p2", full_name: "Bob Private", consent: { public_name: false }, public_profile: false })], args());
    expect(out[0]).toMatchObject({ person: { personId: "p1", name: "Arun Kumar", masked: false }, personHref: "/shared/o/c/players/p1" });
    expect(out[1]!.person.masked).toBe(true);
    expect(out[1]!.person.name).not.toBe("");
    expect(out[1]!.person.name).not.toBe("Bob Private");
    expect(out[1]!.personHref).toBeNull();
  });

  it("the division's youth rule masks a CONSENTING member too (the resolver's second axis), and a masked name never links", () => {
    const [m] = buildSquad([row({ person_id: "p1", full_name: "Arun Kumar" })], args({ division: { sportKey: "cricket", youth: true, player_name_display: null } }));
    expect(m!.person).toEqual({ personId: "p1", name: "Arun K.", masked: true });
    expect(m!.personHref).toBeNull();
  });

  it("without the dashboard.player_profiles entitlement nobody links, even with consent (the view's own second gate)", () => {
    const [m] = buildSquad([row({ person_id: "p1", full_name: "Arun Kumar" })], args({ playerProfiles: false }));
    expect(m!.personHref).toBeNull();
    expect(m!.person.masked).toBe(false);                    // the NAME is unaffected — only the link is gated
  });

  it("captain, shirt number and position ride through; the position is the localised noun, resolved by the ONE helper (never the raw key)", () => {
    const [m] = buildSquad([row({ person_id: "p1", full_name: "Arun Kumar", squad_number: 7, is_captain: true, default_position_key: "wk" })], args());
    expect(m).toMatchObject({ squadNumber: 7, isCaptain: true, position: positionLabel("wk", ui as never) });
    const [plain] = buildSquad([row({ person_id: "p2", full_name: "Dev Patel" })], args());
    expect(plain).toMatchObject({ squadNumber: null, isCaptain: false, position: null });
  });

  it("season line: W2's specsFor metrics in spec order, non-zero only, max two; nothing scored → null (EMPTY first); zeros never make a segment", () => {
    const specs = specsFor("cricket", cricketModel);          // ["runs", "wickets", "sixes"] today — DERIVED, never typed here
    expect(specs.length).toBeGreaterThanOrEqual(2);
    const [k0, k1, k2] = specs.map((s) => s.key);
    const stats = new Map<string, Record<string, number>>([
      ["p1", { [k0!]: 84, [k1!]: 3, ...(k2 ? { [k2]: 5 } : {}) }],
      ["p2", { [k0!]: 0, [k1!]: 2 }],
      ["p3", { [k0!]: 0 }],
    ]);
    const out = buildSquad([row({ person_id: "p1", full_name: "A A" }), row({ person_id: "p2", full_name: "B B" }), row({ person_id: "p3", full_name: "C C" }), row({ person_id: "p4", full_name: "D D" })], args({ stats }));
    const label = (s: { key: string; labelKey: string | null }) => s.labelKey ?? s.key;
    expect(out[0]!.seasonLine).toBe(`${label(specs[0]!)} 84 · ${label(specs[1]!)} 3`);   // the third spec is cut by the cap
    expect(out[1]!.seasonLine).toBe(`${label(specs[1]!)} 2`);                             // the zero runs segment is absent
    expect(out[2]!.seasonLine).toBeNull();
    expect(out[3]!.seasonLine).toBeNull();
  });

  it("a sport with no LEADER_SPECS entry falls back to the module's first two declared metrics (specsFor's own rule) — the squad never invents a metric", () => {
    const tennisModel = resolveLatestModule("tennis").playerStats;
    const specs = specsFor("tennis", tennisModel);
    const stats = new Map(specs[0] ? [["p1", { [specs[0].key]: 4 }] as const] : []);
    const [m] = buildSquad([row({ person_id: "p1", full_name: "A A" })], args({ division: { sportKey: "tennis" }, model: tennisModel, stats: new Map(stats) }));
    expect(m!.seasonLine).toBe(specs[0] ? `${specs[0].key} 4` : null);
  });
});
```

- [ ] **Step 2: Run — collection failure** (`cd <worktree>/apps/web && pnpm exec vitest run src/server/public-site/__tests__/team-page-squad.test.ts --reporter=json --outputFile=/tmp/spx-w5-t2.json` then read `numFailedTestSuites`).

- [ ] **Step 3: Implement `buildSquad`** in `apps/web/src/server/public-site/team-page.ts`

```ts
import "server-only";
// Spectator surface W5 — the public team page's server side. Part 1 (this
// task): the squad builder, pure. Part 2 (Task 3): the SQL reader over
// entrant_members/persons and `loadTeamPage`, which composes the readers that
// already exist (getPublicDivision, W2's hub + leaders) into one page payload.
//
// Names go through the ONE resolver (`resolvePersonDisplayName`, RS008) — this
// file never masks on its own. A player link needs BOTH gates the public view
// already encodes for `members[].person_id` (V350:26-28): `public_players_v`
// membership (consent) and the org's `dashboard.player_profiles` entitlement.
import type { PlayerStatsModel } from "@seazn/engine/stats";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { positionLabel, type MsgFn } from "@/lib/scoring-vocab";
import type { PersonT } from "./match-centre-schema";
import { specsFor, type LeaderSpec } from "./leaders";

export interface SquadRow {
  person_id: string;
  full_name: string;
  consent: { public_name?: boolean } | null;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  public_profile: boolean;
}

export interface SquadMember {
  person: PersonT;
  personHref: string | null;
  squadNumber: number | null;
  position: string | null;
  isCaptain: boolean;
  seasonLine: string | null;
}

export interface SquadBuildArgs {
  division: { sportKey: string; youth?: boolean; player_name_display?: string | null };
  model: PlayerStatsModel | undefined;
  playerProfiles: boolean;
  playerHref: (personId: string) => string;
  ui: MsgFn;
  statLabel: (spec: LeaderSpec, model: PlayerStatsModel | undefined) => string;
  stats: ReadonlyMap<string, Record<string, number>>;
}

/** Season line: the metrics W2's leaders board uses for this sport, in spec
 *  order, non-zero only, at most two — COUNT metrics, never a ratio (the engine
 *  declares no floor; W2 P9). EMPTY → null. */
function seasonLine(stats: Record<string, number> | undefined, a: SquadBuildArgs): string | null {
  if (!stats) return null;
  const parts = specsFor(a.division.sportKey, a.model)
    .filter((spec) => (stats[spec.key] ?? 0) > 0)
    .slice(0, 2)
    .map((spec) => `${a.statLabel(spec, a.model)} ${stats[spec.key]}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function buildSquad(rows: readonly SquadRow[], a: SquadBuildArgs): SquadMember[] {
  return rows.map((r) => {
    const name = resolvePersonDisplayName(r.full_name, r.consent, a.division.player_name_display ?? null, a.division.youth ?? false);
    const masked = name !== r.full_name;
    return {
      person: { personId: r.person_id, name, masked },
      personHref: a.playerProfiles && r.public_profile && !masked ? a.playerHref(r.person_id) : null,
      squadNumber: r.squad_number,
      position: r.default_position_key ? positionLabel(r.default_position_key, a.ui) : null,
      isCaptain: r.is_captain,
      seasonLine: seasonLine(a.stats.get(r.person_id), a),
    };
  });
}
```

- [ ] **Step 4: Run — green** (7 tests). Mutants to apply and RECORD: (a) drop `&& !masked` from `personHref` → the youth test reds (a masked name linking to a player page would defeat the mask); (b) change `> 0` to `>= 0` in `seasonLine` → the zeros test reds; (c) replace `resolvePersonDisplayName(...)` with `r.full_name` → both masking tests red. Restore.

- [ ] **Step 5: Commit** — "web(team-page): squad builder — one resolver for names, both link gates, captain and position, count-metric season lines".

---

### Task 3: `readPublicSquad` and `loadTeamPage` — the reader, the composition, the caches, the 404 rules

**Files:**
- Modify: `apps/web/src/server/public-site/team-page.ts` (add the reader + loader)
- Modify: `apps/web/src/server/public-site/competition-hub.ts` (W2 Task 4): `TeamCard.href` → `${divHref}/teams/${e.id}`; `export` on `primaryColour` if module-private (P6)
- Test: `apps/web/src/server/public-site/__tests__/team-page-load.test.ts` (DB-backed — the `public-lineups.test.ts:1-58` pattern: `vi.mock("next/cache")` passthrough as `consent.test.ts:14-17`, `describe.skipIf(!HAS_DB)`, `afterAll` closes `_sql`); extend W2's `competition-hub.test.ts` with one href assertion.

**Interfaces:**
- Consumes: `getPublicDivision` (`data.ts:610`), `PublicEntrant`, `PublicDivision`, `PublicOrg`, `PublicCompetition`, `divisionTag`, `competitionTag`, `REVALIDATE_FAST` (`data.ts:136-143`); `getPublicCompetitionHub(orgSlug, compSlug)` and `primaryColour` (W2 Task 4 — P1, P6); `readLeaderRows(sql, divisions)` (W2 Task 3); `resolveModule` (`@/server/engine-db`, `registry.ts:27`); `hasFeature(orgId, key, competitionId?)` (`@/lib/entitlements:454`); `resolveEntrantBadge` (`@/lib/entrant-badge:8`); `getDictionary`, `t` (`@/lib/i18n:77`, `i18n-runtime:30`); `msgFor` (`@/lib/messages-i18n:24`); `toLocale`, `Locale` (`@/lib/i18n-constants:42`); `sql` (`@/lib/db`); `unstable_cache` (`next/cache`).
- Produces:
  ```ts
  export async function readPublicSquad(sql: Sql, entrantId: string, a: SquadBuildArgs): Promise<SquadMember[]>;
  export interface TeamPageData {
    org: PublicOrg; competition: PublicCompetition; division: PublicDivision;
    entrant: PublicEntrant;                 // display_name already masked (RS008)
    badgeUrl: string | null; colour: string | null;
    squad: SquadMember[];
    hub: CompetitionHubDocT;                // W2's live document — fixtures and tables are sliced from it on the client
    hrefs: { self: string; division: string; competition: string; calendar: string; teamsBase: string };
    locale: Locale;
  }
  export async function loadTeamPage(orgSlug: string, compSlug: string, divSlug: string, entrantId: string): Promise<TeamPageData | null>;
  ```

- [ ] **Step 1: Write the failing DB-backed tests**

`apps/web/src/server/public-site/__tests__/team-page-load.test.ts` — seed exactly as `public-lineups.test.ts:23-49` (`seedOrg` inserts the org and the `generic`/`score` sport rows; `seedPerson(orgId, fullName, consent)`), then `createCompetition` / `createDivision` / `createEntrants` / `createStages` + `generateStageFixtures` as that file does (`:68-101`):

```ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
const entitlements = vi.hoisted(() => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/lib/entitlements", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/entitlements")>()), hasFeature: entitlements.hasFeature }));
import { sql } from "@/lib/db";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { entrantMatches } from "@/lib/team-page";
import { loadTeamPage, readPublicSquad } from "../team-page";
// seedOrg / seedPerson / DIVISION_CONFIG copied verbatim from public-lineups.test.ts:16-49

const HAS_DB = !!process.env.DATABASE_URL;

async function scene() {
  const { auth, orgId, suffix } = await seedOrg();
  const captain = await seedPerson(orgId, "Arun Kumar", { public_name: true });
  const priv = await seedPerson(orgId, "Bob Private", { public_name: false });
  const noNumber = await seedPerson(orgId, "Zed Last", { public_name: true });
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: `Team Page Cup ${suffix}`, visibility: "public", branding: {} });
  const division = await createDivision(auth, competition.id, { name: "Open", sport_key: "generic", variant_key: "score", config: DIVISION_CONFIG });
  const [team, other, empty] = await createEntrants(auth, division.id, [
    { kind: "team", display_name: "Southend Blue Blazers Cricket Club Seconds XI", seed: 1, members: [
      { person_id: noNumber, squad_number: null, default_position_key: null, is_captain: false, roles: [] },
      { person_id: priv, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
      { person_id: captain, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
    ] },
    { kind: "team", display_name: "Rochford Ramblers", seed: 2, members: [] },
    { kind: "team", display_name: "Empty Squad FC", seed: 3, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, stage!.id);
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`;
  return { auth, orgId, orgSlug, competition, division, team: team!, other: other!, empty: empty!, captain, priv, noNumber };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql; g._sql = undefined; await client?.end();
});

describe.skipIf(!HAS_DB)("readPublicSquad + loadTeamPage (W5 Tasks 2–3)", () => {
  it("readPublicSquad orders by squad_number NULLS LAST then full_name (same order as public_entrants_v.members) and applies the consent resolver", async () => {
    const s = await scene();
    const squad = await readPublicSquad(sql, s.team.id, { division: { sportKey: "generic" }, model: undefined, playerProfiles: true, playerHref: (id) => `/p/${id}`, ui: (k) => String(k), statLabel: (spec) => spec.key, stats: new Map() });
    expect(squad.map((m) => m.person.personId)).toEqual([s.captain, s.priv, s.noNumber]);   // 7, 9, then the null number
    expect(squad[0]).toMatchObject({ isCaptain: true, squadNumber: 7, personHref: `/p/${s.captain}` });
    expect(squad[1]!.person.masked).toBe(true);
    expect(squad[1]!.person.name).not.toBe("Bob Private");
    expect(squad[1]!.personHref).toBeNull();
  });

  it("loadTeamPage composes the page: masked entrant list, crest fallback, the hub slice carries this entrant's fixtures, the calendar href is the entrant feed", async () => {
    const s = await scene();
    const data = (await loadTeamPage(s.orgSlug, s.competition.slug, s.division.slug, s.team.id))!;
    expect(data).not.toBeNull();
    expect(data.entrant.display_name).toBe("Southend Blue Blazers Cricket Club Seconds XI");
    expect(data.badgeUrl).toBeNull();                                          // no badge, no team → monogram (the UI's job)
    expect(data.squad.map((m) => m.person.personId)).toEqual([s.captain, s.priv, s.noNumber]);
    expect(entrantMatches(data.hub, s.team.id).length).toBe(2);               // a 3-team league: two fixtures per entrant
    expect(data.hrefs.calendar).toBe(`/shared/${s.orgSlug}/${s.competition.slug}/${s.division.slug}/calendar.ics?entrant=${s.team.id}`);
    expect(data.hrefs.self).toBe(`/shared/${s.orgSlug}/${s.competition.slug}/${s.division.slug}/teams/${s.team.id}`);
    expect(entitlements.hasFeature).toHaveBeenCalledWith(s.orgId, "dashboard.player_profiles", s.competition.id);
  });

  it("EMPTY: an entrant with no roster → squad [] (the page then has no Squad tab)", async () => {
    const s = await scene();
    expect((await loadTeamPage(s.orgSlug, s.competition.slug, s.division.slug, s.empty.id))!.squad).toEqual([]);
  });

  it("404 rules: a malformed id, an unknown id, an entrant of ANOTHER division, and a private competition → null", async () => {
    const s = await scene();
    expect(await loadTeamPage(s.orgSlug, s.competition.slug, s.division.slug, "not-a-uuid")).toBeNull();
    expect(await loadTeamPage(s.orgSlug, s.competition.slug, s.division.slug, randomUUID())).toBeNull();
    const otherDivision = await createDivision(s.auth, s.competition.id, { name: "Reserves", sport_key: "generic", variant_key: "score", config: DIVISION_CONFIG });
    expect(await loadTeamPage(s.orgSlug, s.competition.slug, otherDivision.slug, s.team.id)).toBeNull();   // right entrant, wrong division
    await patchCompetition(s.auth, s.competition.id, { visibility: "private" });
    expect(await loadTeamPage(s.orgSlug, s.competition.slug, s.division.slug, s.team.id)).toBeNull();
  });

  it("without the entitlement no squad member links, and the squad is otherwise identical (positive pair with the composed test above)", async () => {
    entitlements.hasFeature.mockResolvedValueOnce(false);
    const s = await scene();
    const data = (await loadTeamPage(s.orgSlug, s.competition.slug, s.division.slug, s.team.id))!;
    expect(data.squad.every((m) => m.personHref === null)).toBe(true);
    expect(data.squad.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run** with `DATABASE_URL` — `cd <worktree>/apps/web && DATABASE_URL=… pnpm exec vitest run src/server/public-site/__tests__/team-page-load.test.ts --reporter=json --outputFile=/tmp/spx-w5-t3.json` — `numTotalTests` must be 5 (a `0` means it skipped for want of `DATABASE_URL`, which is NOT a pass); expected failures: `readPublicSquad`/`loadTeamPage` not exported.

- [ ] **Step 3: Implement the reader and the loader** (append to `team-page.ts`)

```ts
import type postgres from "postgres";
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { resolveModule } from "@/server/engine-db";
import {
  competitionTag, divisionTag, getPublicDivision, REVALIDATE_FAST,
  type PublicCompetition, type PublicDivision, type PublicEntrant, type PublicOrg,
} from "./data";
import { getPublicCompetitionHub, primaryColour } from "./competition-hub";
import type { CompetitionHubDocT } from "./competition-hub-schema";
import { readLeaderRows } from "./public-leaders";

export type Sql = ReturnType<typeof postgres>;

/** The `maskPublicEntrantNames` member query (data.ts:562-569) — same join,
 *  same `merged_into is null`, same order — plus the two roster columns the
 *  public view does not carry (`is_captain`; `default_position_key` it does) and
 *  the consent-gate probe W2's leaders reader uses. */
export async function readPublicSquad(client: Sql, entrantId: string, a: SquadBuildArgs): Promise<SquadMember[]> {
  const rows = await client<SquadRow[]>`
    select em.person_id, p.full_name, p.consent, em.squad_number, em.default_position_key, em.is_captain,
           exists (select 1 from public_players_v v where v.id = p.id) as public_profile
    from entrant_members em
    join persons p on p.id = em.person_id
    where em.entrant_id = ${entrantId} and p.merged_into is null
    order by em.squad_number nulls last, p.full_name`;
  return buildSquad(rows, a);
}

export interface TeamPageData {
  org: PublicOrg;
  competition: PublicCompetition;
  division: PublicDivision;
  entrant: PublicEntrant;
  badgeUrl: string | null;
  colour: string | null;
  squad: SquadMember[];
  hub: CompetitionHubDocT;
  hrefs: { self: string; division: string; competition: string; calendar: string; teamsBase: string };
  locale: Locale;
}

const UUID = /^[0-9a-f-]{36}$/i;

export async function loadTeamPage(orgSlug: string, compSlug: string, divSlug: string, entrantId: string): Promise<TeamPageData | null> {
  if (!UUID.test(entrantId)) return null;
  const [data, hub] = await Promise.all([getPublicDivision(orgSlug, compSlug, divSlug), getPublicCompetitionHub(orgSlug, compSlug)]);
  if (!data || !hub) return null;
  // `entrants` is the consent-masked, status-filtered list (public_entrants_v
  // hides withdrawn/disqualified) — an id from another division or a withdrawn
  // team is simply absent, and absent is a 404 (Q3, P11).
  const entrant = data.entrants.find((e) => e.id === entrantId);
  if (!entrant) return null;
  const { org, competition, division } = data;
  const locale = toLocale(org.default_locale);
  // OUTSIDE the cache, like getPublicPlayer (data.ts:800-810): no entitlement
  // write busts a public tag, so a lapsed org must not keep serving links.
  const playerProfiles = await hasFeature(org.id, "dashboard.player_profiles", competition.id);
  const base = `/shared/${org.slug}/${competition.slug}`;
  const divisionHref = `${base}/${division.slug}`;
  const squad = await unstable_cache(
    async () => {
      const dict = await getDictionary(locale, "public");
      const model = (() => { try { return resolveModule(division.sport_key, division.module_version).playerStats; } catch { return undefined; } })();
      // The SAME reader the hub's leaders use: it refreshes the snapshot
      // watermark and returns every person's stats for the division.
      const leaderRows = await readLeaderRows(sql, [{ id: division.id, orgId: org.id, youth: division.youth, player_name_display: division.player_name_display }]);
      return readPublicSquad(sql, entrantId, {
        division: { sportKey: division.sport_key, youth: division.youth, player_name_display: division.player_name_display },
        model,
        playerProfiles,
        playerHref: (personId) => `${base}/players/${personId}`,
        ui: (k, v) => msgFor(locale, k, v),
        statLabel: (spec, m) => (spec.labelKey ? t(dict, spec.labelKey) : (m?.metrics.find((x) => x.key === spec.key)?.label ?? spec.key)),   // byte-for-byte the hub's labeller (W2 Task 4)
        stats: new Map(leaderRows.filter((r) => r.divisionId === division.id).map((r) => [r.personId, r.stats])),
      });
    },
    ["pub-team-v1", entrantId, String(playerProfiles)],
    { tags: [divisionTag(division.id), competitionTag(competition.id)], revalidate: REVALIDATE_FAST },
  )();
  return {
    org, competition, division, entrant,
    badgeUrl: resolveEntrantBadge({ badge_url: entrant.badge_url, team_logo_path: entrant.team_display?.logo_path ?? null }),
    colour: primaryColour(entrant.team_display?.colors),
    squad, hub, locale,
    hrefs: {
      self: `${divisionHref}/teams/${entrantId}`,
      division: divisionHref,
      competition: base,
      calendar: `${divisionHref}/calendar.ics?entrant=${entrantId}`,
      teamsBase: `${divisionHref}/teams`,
    },
  };
}
```

In `competition-hub.ts` (W2 Task 4's `loadCompetitionHub`), change the Teams loop's `href: \`${divHref}?tab=entrants\`` to `href: \`${divHref}/teams/${e.id}\`` and, if `primaryColour` is not exported, add `export`. Extend W2's `competition-hub.test.ts` seeded case with `expect(doc.teams[0]!.href).toMatch(/\/teams\/[0-9a-f-]{36}$/);`.

- [ ] **Step 4: Run — green** (5 + W2's file). Mutant: drop `p.merged_into is null` from the reader → add to the scene a merged duplicate (`insert into persons … merged_into = captain`) rostered on the team and assert it is ABSENT — the mutant reds; record it. Then `cd <worktree>/apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -a "team-page\|competition-hub"` (scoped read; expected no output).

- [ ] **Step 5: Commit** — "web(team-page): readPublicSquad over entrant_members with the one resolver; loadTeamPage composes division, hub and squad under the division tag; Teams tab cards link to the team page".

---

### Task 4: Dictionaries — every `team.*` key in four locales, generated key file, coverage test

**Files:**
- Modify: `apps/web/src/dictionaries/en/public.json`, `es/public.json`, `fr/public.json`, `nl/public.json`
- Regenerate: `cd <worktree> && npm run i18n:gen-keys && npm run i18n:check`
- Test: `apps/web/src/server/public-site/__tests__/team-dictionary.test.ts`

- [ ] **Step 1: Failing coverage test**

```ts
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/public.json"; import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json"; import nl from "@/dictionaries/nl/public.json";

export const W5_KEYS = [
  "team.tabsLabel", "team.tab.fixtures", "team.tab.squad", "team.tab.players", "team.tab.table",
  "team.kind.team", "team.kind.pair", "team.kind.individual", "team.seed",
  "team.position", "team.positionUnranked", "team.noRecord",
  "team.live", "team.upcoming", "team.recent", "team.fixtures.empty",
  "team.squad.empty", "team.squad.captain", "team.squad.number", "team.squad.season",
  "team.empty", "team.meta.description",
  // reused, must still exist (W1 on this branch; W2 draft):
  "matchCentre.info.addToCalendar", "matchCentre.info.division", "matchCentre.info.competition",
] as const;

describe("W5 public dictionary coverage", () => {
  for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
    it(`${locale} has every W5 key`, () => { for (const k of W5_KEYS) expect(dict, k).toHaveProperty(k); });
  }
  it("every {param} in an English template is present in the other three (a dropped {of} renders a raw brace)", () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    for (const k of W5_KEYS) for (const d of [es, fr, nl]) expect(params((d as Record<string, string>)[k] ?? ""), k).toEqual(params((en as Record<string, string>)[k] ?? ""));
  });
  it("no key is namespaced with a leading `public.` (the W1 slip)", () => {
    expect(Object.keys(en).filter((k) => k.startsWith("public.team"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failures listing the missing keys.**

- [ ] **Step 3: Add the keys** (BARE, appended to each file; values below are the four locales' real copy — cricket nouns stay English where a language has none):

`en/public.json`:
```json
"team.tabsLabel": "Team sections",
"team.tab.fixtures": "Fixtures",
"team.tab.squad": "Squad",
"team.tab.players": "Players",
"team.tab.table": "Table",
"team.kind.team": "Team",
"team.kind.pair": "Pair",
"team.kind.individual": "Player",
"team.seed": "Seed {n}",
"team.position": "Position {rank} of {of}",
"team.positionUnranked": "Unranked of {of}",
"team.noRecord": "No results yet",
"team.live": "Live now",
"team.upcoming": "Upcoming",
"team.recent": "Recent results",
"team.fixtures.empty": "No fixtures yet",
"team.squad.empty": "No squad published",
"team.squad.captain": "Captain",
"team.squad.number": "Shirt number {n}",
"team.squad.season": "This season",
"team.empty": "Nothing to show for {team} yet",
"team.meta.description": "Fixtures, results, squad and table position for {team} in {division} at {competition}"
```
`es/public.json`:
```json
"team.tabsLabel": "Secciones del equipo",
"team.tab.fixtures": "Partidos",
"team.tab.squad": "Plantilla",
"team.tab.players": "Jugadores",
"team.tab.table": "Clasificación",
"team.kind.team": "Equipo",
"team.kind.pair": "Pareja",
"team.kind.individual": "Jugador",
"team.seed": "Cabeza de serie {n}",
"team.position": "Puesto {rank} de {of}",
"team.positionUnranked": "Sin clasificar de {of}",
"team.noRecord": "Aún sin resultados",
"team.live": "En directo",
"team.upcoming": "Próximos",
"team.recent": "Resultados recientes",
"team.fixtures.empty": "Aún no hay partidos",
"team.squad.empty": "Plantilla no publicada",
"team.squad.captain": "Capitán",
"team.squad.number": "Dorsal {n}",
"team.squad.season": "Esta temporada",
"team.empty": "Todavía no hay nada que mostrar de {team}",
"team.meta.description": "Partidos, resultados, plantilla y posición en la clasificación de {team} en {division}, {competition}"
```
`fr/public.json`:
```json
"team.tabsLabel": "Sections de l'équipe",
"team.tab.fixtures": "Matchs",
"team.tab.squad": "Effectif",
"team.tab.players": "Joueurs",
"team.tab.table": "Classement",
"team.kind.team": "Équipe",
"team.kind.pair": "Paire",
"team.kind.individual": "Joueur",
"team.seed": "Tête de série {n}",
"team.position": "Position {rank} sur {of}",
"team.positionUnranked": "Non classé sur {of}",
"team.noRecord": "Pas encore de résultats",
"team.live": "En direct",
"team.upcoming": "À venir",
"team.recent": "Résultats récents",
"team.fixtures.empty": "Pas encore de matchs",
"team.squad.empty": "Effectif non publié",
"team.squad.captain": "Capitaine",
"team.squad.number": "Numéro {n}",
"team.squad.season": "Cette saison",
"team.empty": "Rien à afficher pour {team} pour l'instant",
"team.meta.description": "Matchs, résultats, effectif et classement de {team} en {division} à {competition}"
```
`nl/public.json`:
```json
"team.tabsLabel": "Teamonderdelen",
"team.tab.fixtures": "Wedstrijden",
"team.tab.squad": "Selectie",
"team.tab.players": "Spelers",
"team.tab.table": "Stand",
"team.kind.team": "Team",
"team.kind.pair": "Duo",
"team.kind.individual": "Speler",
"team.seed": "Geplaatst {n}",
"team.position": "Positie {rank} van {of}",
"team.positionUnranked": "Ongerangschikt van {of}",
"team.noRecord": "Nog geen resultaten",
"team.live": "Nu live",
"team.upcoming": "Komend",
"team.recent": "Recente uitslagen",
"team.fixtures.empty": "Nog geen wedstrijden",
"team.squad.empty": "Geen selectie gepubliceerd",
"team.squad.captain": "Aanvoerder",
"team.squad.number": "Rugnummer {n}",
"team.squad.season": "Dit seizoen",
"team.empty": "Nog niets te tonen voor {team}",
"team.meta.description": "Wedstrijden, uitslagen, selectie en stand van {team} in {division} bij {competition}"
```
Then `cd <worktree> && npm run i18n:gen-keys && npm run i18n:check` and confirm `apps/web/src/lib/i18n-keys.ts` changed (`/usr/bin/git status --porcelain apps/web/src/lib/i18n-keys.ts` prints an `M`).

- [ ] **Step 4: Run — green** (`team-dictionary.test.ts`, and scoped `pnpm exec vitest run src/lib/__tests__/i18n --reporter=json` for the existing dictionary-shape tests).

- [ ] **Step 5: Commit** — "i18n(public): team page keys in en/es/fr/nl; keys regenerated".

---

### Task 5: UI — `TeamHeader`, `TeamFixturesTab`, `TeamSquadTab`, `TeamTableTab`, and two additive props on W2's `StandingsTableView`

**Files:**
- Create: `apps/web/src/components/public-site/team-page/team-header.tsx`, `team-fixtures-tab.tsx`, `team-squad-tab.tsx`, `team-table-tab.tsx`
- Modify: `apps/web/src/components/public-site/standings-table-view.tsx` (W2 Task 2): `highlightEntrantId?: string`, `rowHref?: (row: TableRowT) => string | null`
- Test: `apps/web/src/components/public-site/__tests__/{team-header,team-fixtures-tab,team-squad-tab,team-table-tab}.test.tsx`; extend `standings-table-view.test.tsx`

**Interfaces:**
- Consumes: `EntrantFixtures`, `EntrantStanding` (Task 1); `SquadMember` (Task 2); `MatchCard` (W2 Task 7); `StandingsTableView` (W2 Task 2); `EntityLogo`, `initials` (`@/components/ui/entity-logo:16,57`); `t` (`@/lib/i18n-runtime:30`); `Dict as PublicDict` (`@/lib/i18n-constants:31`); `Locale`.
- Produces:
  ```ts
  export interface TeamHeaderProps { name: string; kind: string; badgeUrl: string | null; colour: string | null; seed: number | null; divisionName: string; divisionHref: string; standing: EntrantStanding | null; dict: PublicDict }
  export function TeamHeader(p: TeamHeaderProps): JSX.Element;                     // hookless
  export function TeamFixturesTab(p: { fixtures: EntrantFixtures; dict: PublicDict; locale: Locale; now: number; calendarHref: string }): JSX.Element;
  export function TeamSquadTab(p: { squad: SquadMember[]; dict: PublicDict }): JSX.Element;
  export function TeamTableTab(p: { standing: EntrantStanding; dict: PublicDict; teamHref: (entrantId: string) => string }): JSX.Element;
  ```
  Testids: `tm-header`, `tm-crest`, `tm-kind`, `tm-division`, `tm-name`, `tm-seed`, `tm-record`, `tm-position`; `tm-fixtures`, `tm-fixtures-empty`, `tm-live`, `tm-upcoming`, `tm-next` (the first upcoming card's `<li>`), `tm-recent`, `tm-calendar`; `tm-squad`, `tm-squad-empty`, `tm-player-{personId}` (`data-masked="true"` when masked), `tm-captain`, `tm-season`; `tm-table` and W2's `mh-table-*` inside.

- [ ] **Step 1: Failing static-markup tests** (no DOM: `renderToStaticMarkup`; anchor on `="`)

`team-header.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { EntrantStanding } from "@/lib/team-page";
import { TeamHeader } from "../team-page/team-header";

const dict = en as Dict;
const LONG = "Bartholomew Ravindranath-Oyelaran-Whitaker XI";   // 43 characters — the truncation test
const standing: EntrantStanding = {
  table: { id: "t", divisionId: "d1", divisionSlug: "t8", divisionName: "Men's T8", caption: "League", updatedAt: "2026-09-05T10:00:00Z", fullHref: "/x",
    columns: [{ key: "played", abbr: "P", title: "Played", compact: true }, { key: "won", abbr: "W", title: "Won", compact: true }, { key: "drawn", abbr: "D", title: "Drawn", compact: false }, { key: "lost", abbr: "L", title: "Lost", compact: true }, { key: "nrr", abbr: "NRR", title: "NRR", compact: false }, { key: "points", abbr: "Pts", title: "Points", compact: true }],
    rows: [{ rank: 2, entrantId: "e1", name: LONG, badgeUrl: null, cells: ["6", "4", "0", "2", "+0.812", "12"], tieBreakText: null, champion: false }] },
  row: { rank: 2, entrantId: "e1", name: LONG, badgeUrl: null, cells: ["6", "4", "0", "2", "+0.812", "12"], tieBreakText: null, champion: false },
  position: { rank: 2, of: 8 },
  record: { played: "6", won: "4", drawn: "0", lost: "2", points: "12" },
};
const html = (over: Partial<Parameters<typeof TeamHeader>[0]> = {}) =>
  renderToStaticMarkup(<TeamHeader name={LONG} kind="team" badgeUrl={null} colour="#123456" seed={1} divisionName="Men's T8" divisionHref="/shared/o/c/t8" standing={standing} dict={dict} {...over} />);

describe("TeamHeader", () => {
  it("record line is the standings' own notation with localised titles, then the position; NRR (a non-structural column) is NOT in the record", () => {
    const h = html();
    expect(h).toMatch(/data-testid="tm-record"[^>]*>[\s\S]*?<abbr title="Played">P<\/abbr> 6[\s\S]*?<abbr title="Won">W<\/abbr> 4[\s\S]*?<abbr title="Drawn">D<\/abbr> 0[\s\S]*?<abbr title="Lost">L<\/abbr> 2[\s\S]*?<abbr title="Points">Pts<\/abbr> 12/);
    expect(h).not.toContain("NRR");
    expect(h).toMatch(/data-testid="tm-position"[^>]*>Position 2 of 8</);
  });
  it("EMPTY: no standing → the no-results copy and no position (positive pair with the record above)", () => {
    const h = html({ standing: null });
    expect(h).toMatch(/data-testid="tm-record"[^>]*>No results yet</);
    expect(h).not.toContain('data-testid="tm-position"');
  });
  it("an unranked row reads the unranked copy", () => {
    expect(html({ standing: { ...standing, position: { rank: null, of: 8 } } })).toMatch(/data-testid="tm-position"[^>]*>Unranked of 8</);
  });
  it("crest: an <img> when badgeUrl; otherwise a monogram tile in the team colour with the initials (never an empty tile)", () => {
    expect(html({ badgeUrl: "https://x/b.png" })).toMatch(/data-testid="tm-crest"[^>]*src="https:\/\/x\/b\.png"/);
    const h = html();
    expect(h).toMatch(/data-testid="tm-crest"[^>]*style="background:#123456"[^>]*>BX</);   // initials(): first + last word
  });
  it("the 43-character name truncates with a title, the eyebrow names the kind and links to the division", () => {
    const h = html();
    expect(h).toMatch(new RegExp(`data-testid="tm-name"[^>]*class="[^"]*truncate[^"]*"[^>]*title="${LONG}"`));
    expect(h).toMatch(/data-testid="tm-kind"[^>]*>Team</);
    expect(h).toMatch(/data-testid="tm-division"[^>]*href="\/shared\/o\/c\/t8"/);
    expect(html({ kind: "pair" })).toMatch(/data-testid="tm-kind"[^>]*>Pair</);
    expect(html({ kind: "individual" })).toMatch(/data-testid="tm-kind"[^>]*>Player</);
  });
  it("seed chip only when seeded (positive pair)", () => {
    expect(html()).toMatch(/data-testid="tm-seed"[^>]*>Seed 1</);
    expect(html({ seed: null })).not.toContain('data-testid="tm-seed"');
  });
});
```

`team-fixtures-tab.test.tsx` (the `m()` builder from Task 1's test, copied — test scaffolding may be copied):
```tsx
describe("TeamFixturesTab", () => {
  const render = (fixtures: EntrantFixtures) => renderToStaticMarkup(<TeamFixturesTab fixtures={fixtures} dict={dict} locale="en" now={Date.parse("2026-09-05T12:00:00Z")} calendarHref="/shared/o/c/t8/calendar.ics?entrant=e1" />);
  it("EMPTY: no fixtures → the empty copy, no section headings, and the calendar link STILL present (a subscription is useful before the draw)", () => {
    const h = render({ live: [], upcoming: [], recent: [] });
    expect(h).toContain('data-testid="tm-fixtures-empty"');
    expect(h).not.toContain('data-testid="tm-live"'); expect(h).not.toContain('data-testid="tm-upcoming"'); expect(h).not.toContain('data-testid="tm-recent"');
    expect(h).toMatch(/data-testid="tm-calendar"[^>]*href="\/shared\/o\/c\/t8\/calendar\.ics\?entrant=e1"/);
  });
  it("sections render by content, in the order live · upcoming · recent; every card is W2's MatchCard WITHOUT the division chip; the first upcoming card is tm-next", () => {
    const h = render({ live: [m("l", "live", "2026-09-05T11:00:00Z", "e1", "e2")], upcoming: [m("u1", "upcoming", "2026-09-06T13:00:00Z", "e1", "e3"), m("u2", "upcoming", "2026-09-07T13:00:00Z", "e4", "e1")], recent: [m("r", "completed", "2026-09-01T10:00:00Z", "e1", "e5")] });
    expect(h.indexOf('data-testid="tm-live"')).toBeLessThan(h.indexOf('data-testid="tm-upcoming"'));
    expect(h.indexOf('data-testid="tm-upcoming"')).toBeLessThan(h.indexOf('data-testid="tm-recent"'));
    expect(h).toContain('data-testid="mh-match-l"'); expect(h).toContain('data-testid="mh-match-u1"'); expect(h).toContain('data-testid="mh-match-r"');
    expect(h).not.toContain('data-testid="mh-match-division"');
    expect(h).toMatch(/data-testid="tm-next"[\s\S]{0,400}data-testid="mh-match-u1"/);
    expect(h.match(/data-testid="tm-next"/g)?.length).toBe(1);
    expect(h).not.toContain('data-testid="tm-fixtures-empty"');
  });
});
```

`team-squad-tab.test.tsx`:
```tsx
const member = (personId: string, name: string, o: Partial<SquadMember> = {}): SquadMember =>
  ({ person: { personId, name, masked: false }, personHref: `/shared/o/c/players/${personId}`, squadNumber: 7, position: "Wicket-keeper", isCaptain: false, seasonLine: "Runs 84 · Wickets 3", ...o });
describe("TeamSquadTab", () => {
  const render = (squad: SquadMember[]) => renderToStaticMarkup(<TeamSquadTab squad={squad} dict={dict} />);
  it("EMPTY → the empty copy and no list", () => {
    const h = render([]);
    expect(h).toContain('data-testid="tm-squad-empty"'); expect(h).not.toContain("<ul");
  });
  it("a row: number, linked name, captain chip with a localised title, position, season line", () => {
    const h = render([member("p1", "Arun Kumar", { isCaptain: true })]);
    expect(h).toMatch(/data-testid="tm-player-p1"[\s\S]*?aria-label="Shirt number 7"[^>]*>7</);
    expect(h).toMatch(/href="\/shared\/o\/c\/players\/p1"[^>]*title="Arun Kumar"[^>]*>Arun Kumar</);
    expect(h).toMatch(/data-testid="tm-captain"[^>]*title="Captain"[^>]*>C</);
    expect(h).toContain(">Wicket-keeper<");
    expect(h).toMatch(/data-testid="tm-season"[^>]*>Runs 84 · Wickets 3</);
  });
  it("a masked member renders the masked label as plain text with data-masked, no link, no captain chip when not captain; an unmasked one links (positive pair)", () => {
    const h = render([member("p2", "B. P.", { person: { personId: "p2", name: "B. P.", masked: true }, personHref: null, seasonLine: null, position: null }), member("p1", "Arun Kumar")]);
    expect(h).toMatch(/data-testid="tm-player-p2"[^>]*data-masked="true"/);
    expect(h).toMatch(/data-testid="tm-player-p2"[\s\S]{0,600}?>B\. P\.</);
    expect(h).not.toMatch(/data-testid="tm-player-p2"[\s\S]{0,600}?href=/);
    expect(h).not.toMatch(/data-testid="tm-player-p2"[\s\S]{0,600}?tm-season/);
    expect(h).toMatch(/data-testid="tm-player-p1"[\s\S]{0,600}?href="\/shared\/o\/c\/players\/p1"/);
    expect(h.match(/data-testid="tm-captain"/g) ?? []).toHaveLength(0);
  });
  it("a member without a number renders an en dash in the number cell, never an empty cell", () => {
    expect(render([member("p3", "Zed Last", { squadNumber: null })])).toMatch(/data-testid="tm-player-p3"[\s\S]{0,300}?>–</);
  });
});
```

`team-table-tab.test.tsx` + the two new `StandingsTableView` props (extend W2's `standings-table-view.test.tsx` with the same `view` fixture it already has):
```tsx
it("highlightEntrantId marks exactly that row with data-highlight and a highlight class; rowHref turns every name into a link (positive pair: without the props, no highlight and no link)", () => {
  const h = renderToStaticMarkup(<StandingsTableView view={view} dict={en} testid="tm-table-t1" highlightEntrantId="a" rowHref={(r) => `/shared/o/c/div/teams/${r.entrantId}`} />);
  expect(h).toMatch(/data-testid="mh-table-row-a"[^>]*data-highlight="true"[^>]*class="[^"]*bg-accent-soft/);
  expect(h).not.toMatch(/data-testid="mh-table-row-b"[^>]*data-highlight/);
  expect(h).toMatch(/mh-table-row-b[\s\S]*?href="\/shared\/o\/c\/div\/teams\/b"/);
  const plain = renderToStaticMarkup(<StandingsTableView view={view} dict={en} testid="mh-table-t1" />);
  expect(plain).not.toContain("data-highlight"); expect(plain).not.toContain("/teams/");
});
it("TeamTableTab renders the standing's table with THIS entrant highlighted and every row linking to its team page", () => {
  const h = renderToStaticMarkup(<TeamTableTab standing={{ table: view, row: view.rows[0]!, position: { rank: 1, of: 2 }, record: null }} dict={en} teamHref={(id) => `/shared/o/c/div/teams/${id}`} />);
  expect(h).toContain('data-testid="tm-table"');
  expect(h).toMatch(/data-testid="mh-table-row-a"[^>]*data-highlight="true"/);
  expect(h).toContain('href="/shared/o/c/div/teams/b"');
});
```

- [ ] **Step 2: Run — collection failures for the four new files; W2's table test stays green until the props are used.**

- [ ] **Step 3: Implement**

`team-header.tsx`:
```tsx
// Spectator surface W5 — the team page's court-slab header (W0 option A shell).
// Hookless. The record line is the standings snapshot's OWN notation (P W D L
// Pts — R2: notation with a localised title), never a recomputation (R5).
import Link from "next/link";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { EntrantStanding } from "@/lib/team-page";
import { initials } from "@/components/ui/entity-logo";

export interface TeamHeaderProps {
  name: string; kind: string; badgeUrl: string | null; colour: string | null; seed: number | null;
  divisionName: string; divisionHref: string; standing: EntrantStanding | null; dict: PublicDict;
}

const RECORD_KEYS = ["played", "won", "drawn", "lost", "points"] as const;

function kindKey(kind: string): "team.kind.team" | "team.kind.pair" | "team.kind.individual" {
  return kind === "pair" ? "team.kind.pair" : kind === "individual" ? "team.kind.individual" : "team.kind.team";
}

export function TeamHeader(p: TeamHeaderProps) {
  const s = p.standing;
  return (
    <section data-testid="tm-header" className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
      <div className="flex items-start gap-4 p-5 sm:p-6">
        {p.badgeUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img data-testid="tm-crest" src={p.badgeUrl} alt="" aria-hidden className="h-16 w-16 shrink-0 rounded-xl bg-white object-contain p-1 sm:h-20 sm:w-20" />
        ) : (
          <span data-testid="tm-crest" aria-hidden style={{ background: p.colour ?? "var(--ps-accent)" }} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl font-display text-2xl font-bold text-white sm:h-20 sm:w-20">
            {initials(p.name)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
            <span data-testid="tm-kind">{t(p.dict, kindKey(p.kind))}</span>
            <span aria-hidden>·</span>
            <Link data-testid="tm-division" href={p.divisionHref} className="min-w-0 truncate hover:underline">{p.divisionName}</Link>
          </p>
          <h1 data-testid="tm-name" title={p.name} className="mt-1 truncate font-display text-3xl font-bold uppercase leading-none tracking-tight sm:text-4xl">{p.name}</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-court-muted tabular-nums">
            {p.seed ? <span data-testid="tm-seed" className="rounded-full bg-white/12 px-2 py-0.5 text-xs font-medium">{t(p.dict, "team.seed", { n: p.seed })}</span> : null}
            <span data-testid="tm-record">
              {s?.record
                ? s.table.columns.filter((c) => (RECORD_KEYS as readonly string[]).includes(c.key)).map((c, i, all) => (
                    <span key={c.key}><abbr title={c.title} className="no-underline">{c.abbr}</abbr> {s.record![c.key as (typeof RECORD_KEYS)[number]]}{i < all.length - 1 ? " · " : ""}</span>
                  ))
                : t(p.dict, "team.noRecord")}
            </span>
            {s ? (
              <span data-testid="tm-position" className="font-medium text-court-ink">
                {s.position.rank === null ? t(p.dict, "team.positionUnranked", { of: s.position.of }) : t(p.dict, "team.position", { rank: s.position.rank, of: s.position.of })}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <div aria-hidden className="h-1 bg-accent" />
    </section>
  );
}
```
(`record[c.key]` is typed by the key set: `played/won/drawn/lost/points` — `drawn` may be null; render `""` for a null cell so the `D` abbr still lines up only when the column exists; the filter over `columns` already drops a missing D.)

`team-fixtures-tab.tsx`:
```tsx
import type { ReactNode } from "react";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import type { EntrantFixtures } from "@/lib/team-page";
import { MatchCard } from "../matches-hub/match-card";

const LINK_CLASS = "inline-flex min-h-11 items-center rounded-lg border border-zinc-200/80 px-3 py-2 text-[13px] font-medium hover:bg-surface";

function Section({ testid, titleKey, items, firstTestid, dict, locale, now }: { testid: string; titleKey: TKey; items: HubMatchT[]; firstTestid?: string; dict: PublicDict; locale: Locale; now: number }): ReactNode {
  if (items.length === 0) return null;
  return (
    <section data-testid={testid}>
      <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">{t(dict, titleKey)}</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((m, i) => (
          <li key={m.fixtureId} data-testid={i === 0 && firstTestid ? firstTestid : undefined}>
            <MatchCard match={m} dict={dict} locale={locale} now={now} showDivision={false} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TeamFixturesTab({ fixtures, dict, locale, now, calendarHref }: { fixtures: EntrantFixtures; dict: PublicDict; locale: Locale; now: number; calendarHref: string }) {
  const empty = fixtures.live.length + fixtures.upcoming.length + fixtures.recent.length === 0;
  return (
    <div data-testid="tm-fixtures" className="space-y-5">
      {empty ? <p data-testid="tm-fixtures-empty" className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">{t(dict, "team.fixtures.empty")}</p> : null}
      <Section testid="tm-live" titleKey="team.live" items={fixtures.live} dict={dict} locale={locale} now={now} />
      <Section testid="tm-upcoming" titleKey="team.upcoming" items={fixtures.upcoming} firstTestid="tm-next" dict={dict} locale={locale} now={now} />
      <Section testid="tm-recent" titleKey="team.recent" items={fixtures.recent} dict={dict} locale={locale} now={now} />
      {/* A plain <a>, not next/link: an .ics DOWNLOAD, not a route (W1 info-tab.tsx:71-74). Always present — a subscription is useful before the draw. */}
      <a data-testid="tm-calendar" href={calendarHref} className={LINK_CLASS}>{t(dict, "matchCentre.info.addToCalendar")}</a>
    </div>
  );
}
```

`team-squad-tab.tsx`:
```tsx
import Link from "next/link";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { SquadMember } from "@/server/public-site/team-page";

export function TeamSquadTab({ squad, dict }: { squad: SquadMember[]; dict: PublicDict }) {
  if (squad.length === 0) {
    return <p data-testid="tm-squad-empty" className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">{t(dict, "team.squad.empty")}</p>;
  }
  return (
    <ul data-testid="tm-squad" className="grid gap-2 md:grid-cols-2">
      {squad.map((m) => (
        <li key={m.person.personId} data-testid={`tm-player-${m.person.personId}`} data-masked={m.person.masked ? "true" : undefined} className="flex min-h-11 items-center gap-3 rounded-xl border border-zinc-200/80 bg-surface p-3 shadow-sm">
          <span aria-label={m.squadNumber != null ? t(dict, "team.squad.number", { n: m.squadNumber }) : undefined} className="w-8 shrink-0 text-right font-display text-lg font-bold tabular-nums text-ink-muted">
            {m.squadNumber ?? "–"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2 text-[15px] font-medium text-ink">
              {m.personHref ? (
                <Link href={m.personHref} title={m.person.name} className="min-w-0 truncate underline decoration-accent-line underline-offset-2 hover:decoration-accent">{m.person.name}</Link>
              ) : (
                <span title={m.person.name} className="min-w-0 truncate">{m.person.name}</span>
              )}
              {m.isCaptain ? <span data-testid="tm-captain" title={t(dict, "team.squad.captain")} aria-label={t(dict, "team.squad.captain")} className="shrink-0 rounded bg-accent-soft px-1.5 text-[11px] font-bold text-accent-strong">C</span> : null}
            </p>
            {m.position || m.seasonLine ? (
              <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-xs text-ink-muted">
                {m.position ? <span>{m.position}</span> : null}
                {m.seasonLine ? <span data-testid="tm-season" className="tabular-nums" title={t(dict, "team.squad.season")}>{m.seasonLine}</span> : null}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
```

`team-table-tab.tsx`:
```tsx
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { EntrantStanding } from "@/lib/team-page";
import { StandingsTableView } from "../standings-table-view";

export function TeamTableTab({ standing, dict, teamHref }: { standing: EntrantStanding; dict: PublicDict; teamHref: (entrantId: string) => string }) {
  return (
    <div data-testid="tm-table">
      <StandingsTableView view={standing.table} dict={dict} testid={`tm-table-${standing.table.id}`} highlightEntrantId={standing.row.entrantId} rowHref={(r) => teamHref(r.entrantId)} />
    </div>
  );
}
```

`standings-table-view.tsx` (W2's component — two additive props): in `Props` add `highlightEntrantId?: string; rowHref?: (row: TableRowT) => string | null;`; on the `<tr>` add `data-highlight={r.entrantId === highlightEntrantId ? "true" : undefined}` and append ` bg-accent-soft/40` to its class when highlighted; in the name cell render `rowHref ? <Link href={rowHref(r)!} title={r.name} className="block min-w-0 truncate hover:underline">{r.name}</Link> : <span className="block min-w-0 truncate" title={r.name}>{r.name}</span>` (when `rowHref(r)` returns null, fall back to the span). Nothing else in the file changes; W2's existing tests must stay green unchanged.

- [ ] **Step 4: Run — green** (all five files + W2's table test). Mutants to apply and RECORD: (a) in `TeamHeader` filter the record over ALL columns → the "NRR not in the record" assertion reds; (b) in `TeamSquadTab` render the `Link` for a masked member too → the no-link assertion reds; (c) in `TeamFixturesTab` set `firstTestid` on every card → the `tm-next` count-of-one reds. Restore. Then `cd <worktree>/apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -a "team-page\|standings-table-view"` (expected no output).

- [ ] **Step 5: Commit** — "ui(team-page): header with the standings' record and position, fixtures by bucket on W2's MatchCard, squad list with masked names and season lines, table tab; StandingsTableView gains highlight and row links".

---

### Task 6: The `TeamPage` client root — one live subscription, tabs by presence, `?tab=`, empty state

**Files:**
- Create: `apps/web/src/components/public-site/team-page/team-page.tsx`
- Test: `apps/web/src/components/public-site/__tests__/team-page.test.tsx`

**Interfaces:**
- Consumes: `useLiveCompetition`, `HUB_POLL_MS` (W2 Task 7); `PublicTabRail` (W2 Task 7); `useNow` (W1 `match-centre/use-now.ts:12`); Task 1 helpers; Task 5 components; `renderIsland` (`@/components/__tests__/_hook-harness`), `stubFetch`/`stubInterval` copied from `live-score.test.tsx:26-55` (P15).
- Produces:
  ```ts
  export interface TeamPageProps {
    initial: CompetitionHubDocT; entrantId: string; divisionId: string; squad: SquadMember[];
    header: Omit<TeamHeaderProps, "standing" | "dict">; dict: PublicDict; locale: Locale;
    calendarHref: string; teamsBase: string; shareSlot?: ReactNode;
  }
  export function TeamPage(p: TeamPageProps): JSX.Element;   // "use client"
  ```
  DOM contract (the W1/W2 root shape, `match-centre.tsx:107-120`): `tm-root[data-transport]` → `TeamHeader` → `shareSlot` → `PublicTabRail testidPrefix="tm"` → `<div role="tabpanel" id="tm-tab-panel-{active}" aria-labelledby="tm-tab-{active}" data-testid="tm-tab-panel-{active}">` → the active tab; with no tabs at all, `tm-empty` instead of the rail.

- [ ] **Step 1: Failing tests** (static markup for the initial render; the island harness for R10)

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { TeamPage, type TeamPageProps } from "../team-page/team-page";
import { renderIsland } from "@/components/__tests__/_hook-harness";
// hubDoc(), m(), table() builders: copy from W2's competition-landing.test.tsx / Task 1's test; stubFetch/stubInterval from live-score.test.tsx:26-55

const dict = en as Dict;
const props = (doc: CompetitionHubDocT, over: Partial<TeamPageProps> = {}): TeamPageProps => ({
  initial: doc, entrantId: "e1", divisionId: "d1", squad: [], dict, locale: "en",
  header: { name: "Southend Queens", kind: "team", badgeUrl: null, colour: null, seed: null, divisionName: "Men's T8", divisionHref: "/shared/o/c/t8" },
  calendarHref: "/shared/o/c/t8/calendar.ics?entrant=e1", teamsBase: "/shared/o/c/t8/teams", ...over,
});

describe("TeamPage — initial render", () => {
  it("EMPTY: no matches, no squad, no table → header, tm-empty, and NO tablist (the rail is not rendered for nothing)", () => {
    const h = renderToStaticMarkup(<TeamPage {...props(hubDoc({ matches: [], tables: [] }))} />);
    expect(h).toContain('data-testid="tm-header"');
    expect(h).toMatch(/data-testid="tm-empty"[^>]*>Nothing to show for Southend Queens yet</);
    expect(h).not.toContain('role="tablist"');
  });
  it("renders only the tabs the slice earns — fixtures + table without a squad (positive: squad tab present when given one); the first tab's panel is active", () => {
    const doc = hubDoc({ matches: [m("a", "upcoming", "2026-09-06T13:00:00Z", "e1", "e2")], tables: [table("t", "d1", PWLP, [{ entrantId: "e1", rank: 1, cells: ["1", "1", "0", "3"] }])] });
    const h = renderToStaticMarkup(<TeamPage {...props(doc)} />);
    expect(h).toContain('data-testid="tm-tab-fixtures"'); expect(h).toContain('data-testid="tm-tab-table"'); expect(h).not.toContain('data-testid="tm-tab-squad"');
    expect(h).toMatch(/data-testid="tm-tab-fixtures"[^>]*aria-selected="true"/);
    expect(h).toMatch(/role="tabpanel"[^>]*id="tm-tab-panel-fixtures"[^>]*aria-labelledby="tm-tab-fixtures"[^>]*data-testid="tm-tab-panel-fixtures"/);
    expect(h).toContain('data-testid="tm-next"');
    const withSquad = renderToStaticMarkup(<TeamPage {...props(doc, { squad: [member("p1", "Arun Kumar")] })} />);
    expect(withSquad).toContain('data-testid="tm-tab-squad"');
  });
  it("a pair or individual entrant's second tab reads Players, a team's reads Squad (the VALUE the control opens at)", () => {
    const doc = hubDoc({ matches: [], tables: [] });
    expect(renderToStaticMarkup(<TeamPage {...props(doc, { squad: [member("p1", "A A")], header: { ...props(doc).header, kind: "pair" } })} />)).toMatch(/data-testid="tm-tab-squad"[^>]*>Players</);
    expect(renderToStaticMarkup(<TeamPage {...props(doc, { squad: [member("p1", "A A")] })} />)).toMatch(/data-testid="tm-tab-squad"[^>]*>Squad</);
  });
  it("the header's record comes from the document's table for THIS entrant, and the root carries data-transport", () => {
    const doc = hubDoc({ matches: [], tables: [table("t", "d1", PWLP, [{ entrantId: "e1", rank: 2, cells: ["6", "4", "2", "12"] }, { entrantId: "e2", rank: 1, cells: ["6", "5", "1", "15"] }])] });
    const h = renderToStaticMarkup(<TeamPage {...props(doc)} />);
    expect(h).toMatch(/data-testid="tm-root"[^>]*data-transport="poll"/);
    expect(h).toMatch(/data-testid="tm-position"[^>]*>Position 2 of 2</);
  });
});

describe("TeamPage — R10 in place (island harness)", () => {
  it("a poll that changes the entrant's live match re-renders the card text with no navigation; the standing moves too", async () => {
    const before = hubDoc({ matches: [m("l", "live", "2026-09-05T11:00:00Z", "e1", "e2", { scoreLines: ["56/6", "12/0"] })], tables: [table("t", "d1", PWLP, [{ entrantId: "e1", rank: 2, cells: ["6", "4", "2", "12"] }])] });
    const after = hubDoc({ matches: [m("l", "live", "2026-09-05T11:00:00Z", "e1", "e2", { scoreLines: ["71/6", "12/0"] })], tables: [table("t", "d1", PWLP, [{ entrantId: "e1", rank: 1, cells: ["7", "5", "2", "15"] }])] });
    const interval = stubInterval();
    const island = renderIsland(TeamPage, props(before));
    expect(island.text()).toContain("56/6");
    stubFetch({ ok: true, data: after });
    await interval.fire();
    expect(island.text()).toContain("71/6");
    expect(island.text()).not.toContain("56/6");
    expect(island.text()).toContain("Position 1 of 1");
    expect(fetch).toHaveBeenCalledWith("/api/v1/public/orgs/o/competitions/c/hub", expect.anything());   // W2's endpoint — pin api()'s call shape (lib/client.ts:6-11)
  });
});
```
(`m()` gains an optional sixth argument merged into `header` for the score lines.)

- [ ] **Step 2: Run — failures.**

- [ ] **Step 3: Implement `team-page.tsx`**

```tsx
"use client";
// Spectator surface W5 — the team page's client root (W0 option A shell:
// header → rail → panel). EVERYTHING below the header is derived from the
// competition-hub document on every render, so W2's one subscription per page
// re-renders the fixture cards, the record line and the table in place (R10).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import type { SquadMember } from "@/server/public-site/team-page";
import { deriveTeamTabs, entrantMatches, entrantStanding, splitEntrantFixtures, type TeamTabId } from "@/lib/team-page";
import { useLiveCompetition } from "../use-live-competition";
import { PublicTabRail } from "../tab-rail";
import { useNow } from "../match-centre/use-now";
import { TeamHeader, type TeamHeaderProps } from "./team-header";
import { TeamFixturesTab } from "./team-fixtures-tab";
import { TeamSquadTab } from "./team-squad-tab";
import { TeamTableTab } from "./team-table-tab";

export interface TeamPageProps {
  initial: CompetitionHubDocT;
  entrantId: string;
  divisionId: string;
  squad: SquadMember[];
  header: Omit<TeamHeaderProps, "standing" | "dict">;
  dict: PublicDict;
  locale: Locale;
  calendarHref: string;
  teamsBase: string;
  shareSlot?: ReactNode;
}

const TAB_IDS: readonly TeamTabId[] = ["fixtures", "squad", "table"];
const isTab = (x: string | null): x is TeamTabId => x !== null && (TAB_IDS as readonly string[]).includes(x);

export function TeamPage(p: TeamPageProps) {
  const { doc, transport } = useLiveCompetition({ orgSlug: p.initial.orgSlug, competitionSlug: p.initial.competitionSlug, initial: p.initial, realtime: p.initial.realtime });
  const now = useNow();
  const matches = entrantMatches(doc, p.entrantId);
  const fixtures = splitEntrantFixtures(matches);
  const standing = entrantStanding(doc, p.divisionId, p.entrantId);
  const tabs = deriveTeamTabs({ matches: matches.length, squad: p.squad.length, table: standing !== null });

  // Only an explicit CLICK is stored; the active tab is a derivation every
  // render (W1 root, match-centre.tsx:65-70). The `?tab=` param is read on the
  // CLIENT after mount — never on the server, which would flip the ISR route to
  // dynamic (W2 Task 11; P14) — and guarded for the node test harness.
  const [manualTab, setManualTab] = useState<TeamTabId | null>(null);
  const [paramTab, setParamTab] = useState<TeamTabId | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("tab");
    if (isTab(q)) setParamTab(q);
  }, []);
  const onChange = useCallback((tab: TeamTabId) => {
    setManualTab(tab);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());   // never push — a tab is not a navigation (R10)
  }, []);
  const active = [manualTab, paramTab].find((x): x is TeamTabId => x !== null && tabs.includes(x)) ?? tabs[0] ?? null;
  const squadLabelKey = p.header.kind === "team" ? "team.tab.squad" : "team.tab.players";

  return (
    <div data-testid="tm-root" data-transport={transport} className="space-y-4">
      <TeamHeader {...p.header} standing={standing} dict={p.dict} />
      {p.shareSlot}
      {active === null ? (
        <p data-testid="tm-empty" className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">{t(p.dict, "team.empty", { team: p.header.name })}</p>
      ) : (
        <>
          <PublicTabRail
            tabs={tabs.map((id) => ({ id, label: t(p.dict, id === "squad" ? squadLabelKey : `team.tab.${id}`) }))}
            active={active}
            onChange={onChange}
            ariaLabel={t(p.dict, "team.tabsLabel")}
            testidPrefix="tm"
          />
          <div role="tabpanel" id={`tm-tab-panel-${active}`} aria-labelledby={`tm-tab-${active}`} data-testid={`tm-tab-panel-${active}`}>
            {active === "fixtures" ? (
              <TeamFixturesTab fixtures={fixtures} dict={p.dict} locale={p.locale} now={now} calendarHref={p.calendarHref} />
            ) : active === "squad" ? (
              <TeamSquadTab squad={p.squad} dict={p.dict} />
            ) : (
              <TeamTableTab standing={standing!} dict={p.dict} teamHref={(id) => `${p.teamsBase}/${id}`} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — green.** Mutants to RECORD: (a) render all three tabs regardless of `tabs` → the presence test reds; (b) compute `matches` from `p.initial` instead of `doc` → the island test reds (the card would keep "56/6"). Restore. Lint the file scoped (`pnpm exec eslint src/components/public-site/team-page/team-page.tsx`, read the `✖ N problems` line via `rtk proxy`); if `react-hooks/set-state-in-effect` reds on the `?tab=` effect, adopt whatever pattern W2's `CompetitionLanding` landed with (P14) and record it.

- [ ] **Step 5: Commit** — "ui(team-page): client root — one live subscription, tabs by presence, ?tab= on the client, empty state".

---

### Task 7: The page, its metadata, the ISR contract, and the three ways in

**Files:**
- Create: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/teams/[entrantId]/page.tsx`
- Modify: `apps/web/src/lib/__tests__/public-isr-contract.test.ts:25-67` (one CASE)
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx` (after W2 Task 13: the Entrants panel's name → `Link` `tm-link-{id}`; the Standings panel's `StandingsTableView`s get `rowHref`)
- Modify: `apps/web/src/components/public-site/matches-hub/table-tab.tsx` (W2 Task 9): `rowHref={(r) => \`/shared/${doc.orgSlug}/${doc.competitionSlug}/${view.divisionSlug}/teams/${r.entrantId}\`}`
- Test: `teams/[entrantId]/__tests__/page.test.tsx`; extend W2's `table-tab.test.tsx` and the division `page.test.tsx`

**Interfaces:**
- Consumes: `loadTeamPage` (Task 3); `TeamPage` (Task 6); `getDictionary`, `t` (`@/lib/i18n`); `ShareBar` + `shareLabels(dict)` (W2 Tasks 12/16); `publicThemeStyle` (`@/lib/public-theme`); `sharedRenameTarget` (`slug-resolve.ts:146`); `notFound`, `permanentRedirect` (`next/navigation`).

- [ ] **Step 1: Failing page tests** (stub the loader the way the fixture page test stubs its data layer, `fixtures/[fixtureId]/__tests__/page.test.ts:15-18`):

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const loader = vi.hoisted(() => ({ loadTeamPage: vi.fn() }));
vi.mock("@/server/public-site/team-page", () => ({ loadTeamPage: loader.loadTeamPage }));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: vi.fn(async () => null) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, permanentRedirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
// teamData(locale) builds a TeamPageData literal: org {slug:"o", default_locale: locale, branded:false, …}, competition {slug:"c", visibility:"public", branding:{}}, division {id:"d1", slug:"t8", name:"Men's T8", …}, entrant {id:"e1", kind:"team", display_name:"Southend Queens", seed:1, …}, squad [], hub: hubDoc({ locale, matches: [m("a","upcoming",…,"e1","e2")], tables: [] }), hrefs {...}, locale
const OLD_ENGLISH = ["Fixtures", "Squad", "Table", "Add to calendar", "No results yet", "Upcoming", "Team"];

const render = async (locale: string) => {
  loader.loadTeamPage.mockResolvedValue(teamData(locale));
  const { default: Page } = await import("../page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c", divisionSlug: "t8", entrantId: "e1" }) }));
};

describe("team page", () => {
  it("renders the breadcrumb (org → competition → division), the root, the share bar, and hands the loader's hrefs through", async () => {
    const h = await render("en");
    expect(h).toContain('href="/shared/o"'); expect(h).toContain('href="/shared/o/c"'); expect(h).toContain('href="/shared/o/c/t8"');
    expect(h).toContain('data-testid="tm-root"'); expect(h).toContain('data-testid="tm-header"');
    expect(h).toContain("Copy link");                                            // ShareBar — R8
    expect(h).toMatch(/data-testid="tm-calendar"[^>]*href="\/shared\/o\/c\/t8\/calendar\.ics\?entrant=e1"/);
    expect(OLD_ENGLISH.some((s) => h.includes(`>${s}<`))).toBe(true);           // positive pair for the sweep below
  });
  for (const locale of ["es", "fr", "nl"]) it(`${locale}: no English literal survives`, async () => {
    const h = await render(locale);
    for (const s of OLD_ENGLISH) expect(h, s).not.toMatch(new RegExp(`>\\s*${s}\\s*<`));
  });
  it("generateMetadata: title names team, division and competition; description from the dictionary in the org locale; unlisted → noindex", async () => {
    loader.loadTeamPage.mockResolvedValue({ ...teamData("es"), competition: { ...teamData("es").competition, visibility: "unlisted" } });
    const { generateMetadata } = await import("../page");
    const meta = await generateMetadata({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c", divisionSlug: "t8", entrantId: "e1" }) });
    expect(meta.title).toBe("Southend Queens — Men's T8 · Cup");
    expect(meta.description).toBe("Partidos, resultados, plantilla y posición en la clasificación de Southend Queens en Men's T8, Cup");
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
  it("a null loader result 404s (no rename target); a rename target redirects to the SAME entrant under the new slugs", async () => {
    loader.loadTeamPage.mockResolvedValue(null);
    const { default: Page } = await import("../page");
    await expect(Page({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c", divisionSlug: "t8", entrantId: "e1" }) })).rejects.toThrow("NOT_FOUND");
    const { sharedRenameTarget } = await import("@/server/slug-resolve");
    (sharedRenameTarget as ReturnType<typeof vi.fn>).mockResolvedValueOnce("/shared/new-o/c/t8");
    await expect(Page({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c", divisionSlug: "t8", entrantId: "e1" }) })).rejects.toThrow("REDIRECT:/shared/new-o/c/t8/teams/e1");
  });
});
```
ISR contract: add to `CASES` — `{ name: "team page", file: join(SRC_ROOT, "app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/teams/[entrantId]/page.tsx"), revalidate: 30 }`. W2's `table-tab.test.tsx`: `expect(h).toContain('href="/shared/o/c/t8/teams/a"')`. Division `page.test.tsx`: `expect(h).toMatch(/data-testid="tm-link-e1"[^>]*href="\/shared\/o\/c\/t8\/teams\/e1"/)`.

- [ ] **Step 2: Run — failures.**

- [ ] **Step 3: Implement the page**

```tsx
// Spectator surface W5 — the public team page. ISR like every /shared page
// (revalidate 30 + empty generateStaticParams, public-isr-contract.test.ts);
// no searchParams/cookies/headers here — `?tab=` is read on the client.
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { loadTeamPage } from "@/server/public-site/team-page";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { publicThemeStyle } from "@/lib/public-theme";
import { getDictionary, t } from "@/lib/i18n";
import { ShareBar } from "@/components/share-bar";
import { shareLabels } from "@/components/public-site/share-labels";
import { TeamPage } from "@/components/public-site/team-page/team-page";

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string; entrantId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug, entrantId } = await params;
  const data = await loadTeamPage(orgSlug, competitionSlug, divisionSlug, entrantId);
  if (!data) return {};
  const dict = await getDictionary(data.locale, "public");
  return {
    title: `${data.entrant.display_name} — ${data.division.name} · ${data.competition.name}`,
    description: t(dict, "team.meta.description", { team: data.entrant.display_name, division: data.division.name, competition: data.competition.name }),
    ...(data.competition.visibility === "unlisted" ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function TeamPageRoute({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug, entrantId } = await params;
  const data = await loadTeamPage(orgSlug, competitionSlug, divisionSlug, entrantId);
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug, divisionSlug);
    if (renamed) permanentRedirect(`${renamed}/teams/${entrantId}`);
    notFound();
  }
  const dict = await getDictionary(data.locale, "public");
  const { org, competition, division, entrant, hrefs } = data;
  return (
    <div style={publicThemeStyle(competition.branding)}>
      <nav className="mb-4 text-xs text-ink-muted">
        <Link href={`/shared/${org.slug}`} className="hover:text-accent-strong hover:underline">{org.name}</Link>{" / "}
        <Link href={hrefs.competition} className="hover:text-accent-strong hover:underline">{competition.name}</Link>{" / "}
        <Link href={hrefs.division} className="hover:text-accent-strong hover:underline">{division.name}</Link>
      </nav>
      <TeamPage
        initial={data.hub}
        entrantId={entrant.id}
        divisionId={division.id}
        squad={data.squad}
        header={{ name: entrant.display_name, kind: entrant.kind, badgeUrl: data.badgeUrl, colour: data.colour, seed: entrant.seed, divisionName: division.name, divisionHref: hrefs.division }}
        dict={dict}
        locale={data.locale}
        calendarHref={hrefs.calendar}
        teamsBase={hrefs.teamsBase}
        shareSlot={<ShareBar path={hrefs.self} title={`${entrant.display_name} — ${division.name}`} labels={shareLabels(dict)} />}
      />
    </div>
  );
}
```
Division page (W2 Task 13's `entrantsPanel`): the entrant name `<span className="truncate">{e.display_name}</span>` becomes `<Link data-testid={\`tm-link-${e.id}\`} href={\`${basePath}/teams/${e.id}\`} className="min-w-0 truncate hover:underline" title={e.display_name}>{e.display_name}</Link>`; its `StandingsTableView`s pass `rowHref={(r) => \`${basePath}/teams/${r.entrantId}\`}`. W2's `TableTab` passes `rowHref` per view as in the Files list.

- [ ] **Step 4: Run — green; then `cd <worktree>/apps/web && pnpm exec vitest run src/lib/__tests__/public-isr-contract.test.ts "src/app/(public)/shared" src/components/public-site --reporter=json --outputFile=/tmp/spx-w5-t7.json`** — the ISR contract and every W1/W2 public-site test must stay green (compare `numTotalTests` with the run before this task: it must be higher by exactly the tests added here). Mutant: remove `generateStaticParams` from the page → the contract test reds (record). Then `pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -a "teams/\[entrantId\]\|team-page"` (expected no output), and `cd <worktree> && npm run openapi:gen && /usr/bin/git status --porcelain openapi` (prints nothing — no endpoint was added).

- [ ] **Step 5: Commit** — "public(team): the team page route with metadata and the ISR contract; Teams tab cards, Entrants list names and every standings row link to it".

---

### Task 8: Walkthrough v5, the seven-width scan per tab, mobile.spec route, smoke checks, screens

**Files:**
- Modify: `apps/web/e2e/walkthrough/spectator-public.spec.ts` — a new `test.describe("W5 — team page", …)` block (P3: import the seed and `controlSet`/`armCookieBypass` from wherever W1 Task 15 / W2 Task 17 left them)
- Modify: `apps/web/e2e/mobile.spec.ts:343-400,1211-1227` — the setup captures the division slug and the first entrant id (`apiJson<{ id: string; slug: string }>` for the division — P12; `addEntrantsViaApi(...).ids[0]`), and the public-surfaces route list gains `` `/shared/${orgSlug}/${compSlug}/${divisionSlug}/teams/${entrantId}` ``; after the loop, `await anon.goto(teamPath); await expect(anon.getByTestId("tm-header")).toBeVisible(); await expect(anon.getByTestId("tm-empty")).toBeVisible();` (that seed has entrants with no fixtures, no roster and no table — the EMPTY state, witnessed at every width; the populated tabs get their seven-width scan in the walkthrough below)
- Modify: `scripts/smoke.ts` — two `check`s beside the `calendar.ics?entrant=` check at `:13906-13931` (P17), where `comp`, `div` and the entrant id used there are in scope:
  ```ts
  const teamPage = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}/${div.slug}/teams/${entrantId}`);
  check("W5 team page renders root and header", teamPage.status === 200 && teamPage.body.includes('data-testid="tm-root"') && teamPage.body.includes('data-testid="tm-header"'));
  const missingTeam = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}/${div.slug}/teams/${randomUUID()}`);
  check("W5 unknown entrant 404s", missingTeam.status === 404);
  ```

**The W5 walkthrough, in order (R7 + R10 + R1 + R11):**
1. `beforeAll`: reuse W1's seeded competition (four 8-a-side cricket teams, one finished + one live match; football; tennis). Add to the seed a division `Empty` with one team entrant, no roster, no stages (the EMPTY state). Via the DB helper (`setScheduledAt`'s postgres pattern, P3): `update entrant_members set is_captain = true where entrant_id = ${home.entrantId} and person_id = ${home.order[0]}` and `update persons set consent = '{"public_name": false}'::jsonb where id = ${home.order[7]}` — BEFORE any anonymous visit (the squad document is cached 30 s under the division tag and these SQL writes fire no revalidation, Q10). `teamPath = /shared/${org}/${comp}/${cricketDivSlug}/teams/${home.entrantId}` where `home` is the side batting first in the LIVE match (from `fixtureSides`).
2. **Open the anonymous 320×568 context FIRST** (`browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true })`, `armCookieBypass`); `goto(teamPath)`; assert `tm-root`, `tm-header`; `tm-name` text equals the team's name; print `data-transport`. Record: fetch `GET /api/v1/public/orgs/${org}/competitions/${comp}/divisions/${div}/standings` in the signed-in `request`, find the row for `home.entrantId`, and assert `tm-record` contains `P ${row.played}` and `Pts ${row.points}` — one authority (the snapshot), two readers; print what was seen.
3. Rail: `getByRole("tab")` names are exactly `["Fixtures", "Squad", "Table"]`; print them.
4. Fixtures (active by default, VALUE not presence: `tm-tab-fixtures` `aria-selected="true"`): `tm-live` contains `mh-match-${liveFixtureId}`; `tm-recent` contains the finished match whose `mh-match-result` text equals the match centre's `mc-status-line` for that fixture (open `…/fixtures/${finishedId}` in a second anonymous tab and read it — one sentence, three surfaces); `tm-calendar` `href` equals `${divisionPath}/calendar.ics?entrant=${home.entrantId}`; `request.get(that href)` → 200, `content-type` starts `text/calendar`, body contains the team's name (P10).
5. **R10 — with the anonymous page OPEN on Fixtures**: `before = await anon.getByTestId(`mh-match-${liveFixtureId}`).innerText()`; `urlBefore = anon.url()`; in the signed-in `request` post one over of `cricket.ball` events through `mustPost` (six legal balls, at least one `runs.bat: 4` so the total moves — derive the expected total from `GET /api/v1/fixtures/${id}/state` after posting); `await expect(anon.getByTestId(`mh-match-${liveFixtureId}`)).not.toContainText(before, { timeout: HUB_POLL_MS + 5_000 })`; positive pair: `toContainText(String(newRuns))`; `expect(anon.url()).toBe(urlBefore)`. Print both texts.
6. Squad: click `tm-tab-squad`; `tm-player-*` count equals `home.order.length` (8 — derived from the seed, never a literal); `tm-captain` count is exactly 1 and sits inside `tm-player-${home.order[0]}`; the opted-out member's row `tm-player-${home.order[7]}` has `data-masked="true"`, its text is neither empty nor the full name and contains no `<a>`; the number of `<a href*="/players/">` inside `tm-squad` equals the number of `members[].person_id` that are non-null in `GET …/divisions/${div}/entrants` for this entrant (the view's own two gates — one authority, two readers); print the two counts.
7. Table: click `tm-tab-table`; `mh-table-row-${home.entrantId}` has `data-highlight="true"`; its name link `href` equals `teamPath`; another row's link points at another `/teams/` path (positive pair) — click it → `tm-name` shows THAT team's name (a second team renders; inbound link proven), `anon.goBack()`.
8. Inbound links: competition page `?tab=teams` → `mh-team-${home.entrantId}` `href` ends `/teams/${home.entrantId}` (amends W2 Task 17 step 7: clicking it now opens the TEAM page — assert `tm-root`); division page `?tab=entrants` → `tm-link-${home.entrantId}` present.
9. Kind vocabulary: open the tennis division's first entrant page; read its `kind` from `GET …/divisions/${tennisDiv}/entrants`; assert the second tab reads `Squad` when `kind === "team"` and `Players` otherwise (branch on the seed's fact, print it); `tm-kind` reads `Team` / `Pair` / `Player` accordingly.
10. EMPTY: open the `Empty` division's entrant page → `tm-header` visible, `tm-record` reads "No results yet", `tm-empty` visible, `getByRole("tablist")` count 0 (R9 witnessed on a real page).
11. Repeat steps 2–4 at 1280×800 in a fresh anonymous context; **control-set diff** (`controlSet()` at 320 vs 1280 on Fixtures, Squad, Table): the ONLY allowed difference is W2's `mh-table-more-*` phone disclosure; print both lists.
12. **Seven widths per tab**: for each of 320/360/375/390/430/768/834 set the viewport, click each of the three tabs, `expectNoHorizontalScroll(anon)`; print `tab@width` beside each pass.
13. Axe at 320 on Fixtures and Squad (`new AxeBuilder({ page: anon }).withTags(["wcag2a", "wcag2aa"]).analyze()` as `mobile.spec.ts:1391`): zero `serious`/`critical`; the rail's `scrollable-region-focusable` clean.
14. Tap targets: `elementFromPoint` at the centre of each rail pill and of `tm-calendar` resolves to that control, and its box is ≥ 44 px tall (a box measured is not a tap proven — hit-test).
15. Screens: `screenshotAtWidths(anon, testInfo, "w5-<tab>-<state>")` at 320/768/1280 for Fixtures (live), Fixtures (after the over), Squad, Table, the EMPTY page, and the individual/pair entrant's page — for Task 9's R11 read.
16. `afterAll` (never `finally`): close both contexts; nothing shared to thaw.

- [ ] **Step 1: Write the block** (~250 lines, real code following the numbered steps; the seed additions in the shared `beforeAll`).
- [ ] **Step 2: Run against a fresh env**: `seazn-env up --label spx --server` from the worktree, `eval` its env, `cd apps/web && PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test e2e/walkthrough/spectator-public.spec.ts --project=walkthrough --workers=1 --reporter=json > /tmp/spx-w5-wt.json`; judge on the JSON; take the env down after. A blown budget reports itself as a data defect — check the poll's own timeout before chasing a count (AGENTS.md #20).
- [ ] **Step 3: Run the WHOLE `mobile.spec.ts`** across the seven projects (never `-g`; a serial file's red count is a floor — rerun after each fix until a full pass completes).
- [ ] **Step 4: Smoke**: `SMOKE_BASE=… npm run test:smoke` → the two new checks print PASS with what they saw.
- [ ] **Step 5: Commit** — "e2e(spectator): walkthrough v5 — team page at 320/1280 with the control-set diff, R10 in place on the fixture card, squad gates read against the public view, seven-width scan per tab; mobile route; smoke checks".

---

### Task 9: Gates, review loop, R11 visual sign-off, programme index

- [ ] **Step 1: Orchestrator runs the full gate** from the worktree, quiescent tree: `seazn-env gate --label spx` (lint + typecheck; judge on the `Cached:` line — `rtk` prints tsc clean while tsc exits 1); `cd <worktree>/apps/web && pnpm exec vitest run --reporter=json --outputFile=/tmp/spx-w5-web.json`; paste `numTotalTests`/`numFailedTests`/`numFailedTestSuites` and confirm `.testResults[].name` paths are under the worktree and the total is ≥ the pre-wave total plus the tests this plan added. `npm run openapi:gen && /usr/bin/git status --porcelain openapi` prints nothing; `npm run i18n:check` clean.
- [ ] **Step 2: Reviewer dispatch** on the whole branch (Opus; brief = this plan + `_RULES.md` + spec §W5 + the owner's rulings on Q1–Q10; output = a gap list). Fix inline; re-review until clean. **Run the final whole-branch review even if every task review was clean.**
- [ ] **Step 3: R11 sign-off** — the controller READS every screenshot from Task 8 (Fixtures live / after the over, Squad, Table, EMPTY, the non-team entrant — each at 320/768/1280) and writes the per-screen verdict table into the spec ("W5 sign-off — per-screen verdicts"): alignment and baselines (the record line's abbrs against the numbers; the squad number column against the names), spacing rhythm, pill sizes consistent with W1's match centre and W2's landing (same `px-4 py-1.5` pills, same court slab), the 43-character team name truncating with a `title` in the header AND in the highlighted table row, contrast of the monogram tile's initials on the team colour (a light `colors.primary` is the test — if the contrast fails, the tile falls back to `var(--ps-accent)` and the rule is recorded), icon and chip alignment (the "C" chip beside a truncated name), tap targets ≥ 44 px by `elementFromPoint`, overlaps, clipped text, empty states (no fixtures; no squad; no table; the whole-page empty). Each row names what was SEEN. A cosmetic defect goes into ONE fix dispatch with the review findings — never parked.
- [ ] **Step 4: `_INDEX.md`** — W5 row → "PR #… open"; the owner's rulings on Q1–Q10 recorded as RULINGS (never as recommendations); false premises / positive findings from Part 1 §"False premises found" plus anything Task 8 surfaced; mutants (Tasks 1–3, 5–7) with the test that killed each; the walkthrough's measured cost; follow-ups: a team OG card (Q9), court-card side links into the team page (Q7), the sitemap, ratio season lines pending the engine `leaderboards` declaration, roster-edit revalidation (Q10). Point `W5-team-page.md` at this plan's final path.
- [ ] **Step 5: Open the PR** only when the owner says so (never unprompted); e2e runs via `workflow_dispatch` with the PR number once a PR exists (e2e does not run on PRs; smoke does).

---

## Execution order

**Owner rulings on Q1–Q10 first; W1–W4 merged second; then** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Parallel lanes with PROVABLY disjoint file sets, each in `isolation: "worktree"` and merged back before the next sequential task: {Task 1, Task 2} (both pure, different files) after the rulings; {Task 4, Task 5} after Task 3 (Task 5's tests import `en/public.json`, so Task 4 must land before Task 5's dictionary-text assertions run — sequence them if the reviewer prefers). Task 3 touches W2's `competition-hub.ts` and Task 5 W2's `standings-table-view.tsx` — one file each, additive; if W2's own follow-ups are still open on either file, run those tasks sequentially. Tasks 8–9 are the orchestrator's.

## Self-review (done while writing)

- **Spec coverage (§W5 sketch "badge, squad, results, upcoming, table position — captains share it to their squad")**: badge → Tasks 3, 5 (crest: `badge_url` / `logo_path` / monogram in the team colour); squad → 2, 3, 5 (consent-resolved, masked never blank, youth, captain, number, position, season line, link only with both gates); results + upcoming → 1, 5, 6 (from the hub document, W1's court-card idiom via W2's `MatchCard`, live in place); table position → 1, 5, 6 (from the standings snapshot only, highlighted row); share → 7 (`ShareBar`, R8; footer inherited); links to the match centre (every card) and the competition hub (breadcrumb, header division link, `matchCentre.info.*` reuse) → 5, 7; live updating for the fixture rows and the standing (R10) → 6, 8 step 5; four locales → 4, 7; testids (`tm-`, Q4) → 5–8; walkthrough extension → 8; R11 table → 9; four test types — unit (1–7), e2e (8), smoke (8), regression (7's ISR contract + zero-English, 8's 404 smoke and the W2 Teams-tab href change). The brief's minimum scope is met; the plan recommends LESS in two places (no per-match lines here — they live on the player page; no court-card links — Q7) and MORE in two (every standings row links to a team page; the entrant's own `.ics` feed is surfaced), each with its reason in Part 1.
- **Placeholders**: every test step carries code; every implementation step carries code or an exact signature; the walkthrough is a numbered procedure whose every assertion names its testid and its expected VALUE's source. The one algorithm described in prose (the division page's `entrantsPanel` link change, Task 7) names the exact element and attributes.
- **Type consistency**: `TeamTabId`/`EntrantFixtures`/`EntrantStanding` (Task 1) are what Tasks 5–6 consume; `SquadRow`/`SquadMember`/`SquadBuildArgs`/`buildSquad`/`readPublicSquad`/`TeamPageData`/`loadTeamPage` (Tasks 2–3) are what Tasks 5–7 consume; `TeamHeaderProps` (Task 5) is what Task 6's `header: Omit<TeamHeaderProps, "standing" | "dict">` and Task 7's literal satisfy; `TeamPage({ initial, entrantId, divisionId, squad, header, dict, locale, calendarHref, teamsBase, shareSlot })` (Task 6) is what Task 7 renders; `hrefs.teamsBase` (Task 3) feeds `teamsBase` (Task 6); `StandingsTableView`'s `highlightEntrantId`/`rowHref` (Task 5) are what Tasks 5 and 7 pass; every W2 name is listed once in P1 and used with the same spelling throughout.
- **Rules re-read**: R3 — one resolver (`buildSquad` calls `resolvePersonDisplayName`; entrant names come masked from `getPublicDivision`); R5 — no recomputation anywhere (record from cells, order from `sortHubMatches`, stats from snapshots, labels from W2's labeller); R6 — no new gate (`dashboard.player_profiles` reused as the view does); R9 — every test file's first case is EMPTY; R10 — the island test and walkthrough step 5 both change the DOM without navigation; R1 — one DOM, `md:grid-cols-2` only, the rail at every width, control-set diff in step 11.
