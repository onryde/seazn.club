# Player profile — upcoming matches across the org

Status: design approved in chat 2026-09-23; spec awaiting owner review.

## Goal

A visitor on a player's public card
(`/shared/{orgSlug}/{competitionSlug}/players/{personId}`) sees that player's
next matches across **every division and competition of the same org** — not
only the competition they arrived from.

## Owner rulings (not derivable from code)

| # | Question | Ruling |
|---|----------|--------|
| R1 | How wide is "across"? | **Same org only.** Cross-org (via `persons.user_id` from claims) is out of scope — it is a new public disclosure needing its own consent design. |
| R2 | Which other competitions may appear? | **`public` competitions, plus the current competition whatever its visibility.** An `unlisted` competition never appears on another competition's page (that would publish its link). `private` never appears. |
| R3 | Which fixtures, how many? | `status = 'scheduled'` only. Dated fixtures first (ascending), then undated rows labelled **"Time TBC"**. Show **5**, then a "Show N more" reveal. `in_play` is excluded — the existing Matches section already shows it. |
| R4 | Layout | **Option A**: its own "Upcoming" section **above** Matches, one chronological list, each row names its competition › division, rows from another competition carry an "Other event" chip. |

## Current state (verified 2026-09-23 on `main` @ 1c42a297a)

- Page: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx` — ISR `revalidate = 300`; sections Matches → Career → Stats → squad links.
- A player is a `persons` row owned by one org (`V204__persons.sql`).
- `readPlayerMatchSeeds` (`server/public-site/public-player-matches.ts`) filters to one competition and to `APPEARANCE_STATUSES` (completed + in_play) — scheduled fixtures are excluded today. No public upcoming-by-player query exists.
- `public_fixtures_v` (`V401__fixture_stream_url.sql`) already filters to `public`/`unlisted` competitions and nulls `scheduled_at`/`venue`/`court_label` while `divisions.status = 'setup'`. It exposes `home_slot_label` / `away_slot_label`.
- Public fixture page exists: `[divisionSlug]/fixtures/[fixtureId]/page.tsx`.

## Design

### 1. Loader — `readPlayerUpcomingSeeds`

New function in `apps/web/src/server/public-site/public-player-matches.ts`
(beside `readPlayerMatchSeeds`, same idioms).

Input: `orgId`, `personId`, `currentCompetitionId`, `now`.

Rules:
- Membership: person is an `entrant_members` member of the fixture's home **or** away entrant; entrant status `registered` or `confirmed`.
- Source: `public_fixtures_v` joined to its division and competition; `org_id = orgId`.
- Visibility (R2): `competition.visibility = 'public' OR competition.id = currentCompetitionId`. Since the view already excludes `private`, this predicate is what excludes a foreign `unlisted`.
- Status: `f.status = 'scheduled'`.
- Staleness: exclude `scheduled_at < now - 3 hours` (a scheduled fixture whose slot long passed without scoring is not "upcoming"). `scheduled_at IS NULL` rows are kept.
- Order: `scheduled_at ASC NULLS LAST`, then `round_no`, `seq_in_round`, `id` (stable).
- Returns all rows (no SQL limit beyond a safety cap of 50); the 5-row cut is presentational.

Output row: `fixtureId`, `scheduledAt | null`, `courtLabel | null`, `venue | null`, `opponentLabel`, `competitionName/Slug`, `divisionName/Slug`, `isOtherCompetition`.

### 2. Opponent label

The opponent is the side the player is NOT on. Label = the opponent entrant's public name, resolved with the same naming the existing Matches rows use; when that side has no entrant yet, the side's slot label (e.g. "Winner of QF2"); if neither exists, a localised "TBD".

### 3. UI — `PlayerUpcoming`

New `apps/web/src/components/public-site/player-upcoming.tsx`, mounted above the Matches section in the player page.

- Server-rendered by the page (inherits the 5-minute ISR); no live polling.
- Row: date · time · court (or "Time TBC"), "vs {opponent}", "{competition} › {division}", "Other event" chip when `isOtherCompetition`. Whole row links to `/shared/{orgSlug}/{competitionSlug}/{divisionSlug}/fixtures/{fixtureId}`.
- First 5 rows visible; a client "Show N more" reveals the rest.
- No rows ⇒ section not rendered (no empty state).
- Dates/times formatted with the same helper and timezone handling as the Matches section.
- One DOM, phone-first; no horizontal page scroll at 320 / 768 / 1280. `min-w-0` on the truncation chain for long entrant/competition names.
- New strings ("Upcoming", "Time TBC", "Other event", "Show {n} more", "TBD") in all 4 locale dictionaries; regenerate `i18n-keys.ts` via `gen-keys`.

### 4. Gates

Unchanged: page gated by the current competition's `dashboard.player_profiles` entitlement and the person's `public_name` consent (`publicPlayerGate`). Other competitions' entitlements are not checked — only fixture data (already public on their own fixture pages) is shown, never another competition's player card.

## Out of scope

- Cross-org upcoming (R1).
- Live/realtime updates of the Upcoming list.
- ICS/calendar export for a player.
- Changing the Matches section.

## Testing

- **Integration (DB) for the loader:**
  - membership via entrant (singles + doubles/team);
  - fixture in another `public` competition included, flagged `isOtherCompetition`;
  - fixture in another `unlisted` competition **excluded**; in the current `unlisted` competition **included**;
  - `private` competition excluded;
  - `in_play`, `decided`, `cancelled` excluded;
  - division in `setup` ⇒ `scheduledAt` null, sorted after dated rows;
  - fixture > 3h in the past excluded; within grace included;
  - withdrawn entrant excluded; another org's fixture excluded;
  - opponent label: named entrant / slot label / TBD.
- **Mutation:** drop the visibility predicate ⇒ the unlisted-other test goes red; drop the status filter ⇒ in_play test goes red; drop NULLS LAST ⇒ ordering test goes red.
- **E2E:** player page shows rows from two competitions in time order with the chip on the foreign one; "Show more" reveals rows 6+; row link opens the fixture page; screenshots at 320, 768, 1280 with no horizontal scroll; run the whole spec file.
- **Smoke:** player card renders the Upcoming section for a seeded player with a scheduled fixture.
- **Regression:** existing Matches section content unchanged for the same player.
