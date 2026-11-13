# Quick match — design

Status: **APPROVED by the owner on 2026-11-06** ("design is approved"), including the designer's calls C1 to C23. Direction and screens were approved on 2026-11-05 (see §6.1). Builder check run on 2026-11-05; its questions are settled in C19 to C23 and §7.10. Code facts were verified on 2026-11-05 against the local checkout at `/Users/asubramanian-mac2/Downloads/seazn.club-main`; pins are file:line relative to the repo root. The engine is the npm package `@onryde/seazn-engine` (`apps/web/package.json:25`), not source in this repo, so a few engine-internal facts are settled by probe tests at build time (§12). Local file only; the owner asked for no commit. Design of record for the screens: `docs/superpowers/specs/mockups/2026-11-03-quick-match/`. Awaiting the owner's approval of this text.

## 1. Intent

Today every match lives under competition → division → stage. The shortest real path to one scorable match is four screens (blank competition with a mandatory end date, division builder, two entrants, Generate). That is far too much for two friends at a club who just want to play and keep score.

**Quick match** lets a **casual player with no account** start a small, scored set of matches from the **marketing page** in a few seconds, share it by link, and keep it by signing up. It is both a product in its own right and the cheapest way to try Seazn, so it doubles as a sign-up funnel.

Owner's words, 2026-11-03: users are "causual player"; scope is "a one or two or best of N matches"; "just use outside login in market page and quickly create and play there"; "ask friendly name to remember with optional email and expire after 7 days". On 2026-11-05, seeing the setup mockup: show the real format, "stay both format".

## 2. Goals

1. From the marketing page, a visitor with no account sets up and starts scoring within one screen.
2. Every sport whose scoring needs no named players works from day one, using the existing engine, scoring pad and sport rules.
3. The match can be found again: by a friendly name, by this device, by its link, and by email if the guest gave one.
4. Anyone with the link can score (friends on other phones).
5. Unsaved quick matches are deleted after 7 days; saving keeps them.

## 3. Non-goals (v1)

- Other formats: no Swiss, no groups. **League and knockout only** (O5).
- An early stop. A league plays every match it generated.
- A deciding-match rule for a level league. A level table just shows level (see C5).
- Rosters, people, player profiles or stats for guests. Sides are names only.
- **Lineup sports** (cricket and any other sport whose pad needs a named player to record an event). See C11.
- Public pages, the hub, discovery, the sitemap, streaming, sponsors, scorer PDFs for guest matches.
- A watch-only link. The scoring link is the only link (owner: "it doesn't matter right? if we can able to use scoring link").
- Turning a saved quick match into a regular competition, or moving it into the user's own org.
- Changing the signed-in competition flow.

## 4. Anti-goals (failure even if it works)

- A setup screen that feels like the division builder. If a guest sees "stage", "variant", "legs", "entrant kind" or any other internal word, it has failed.
- A guest match leaking into any public listing, search or sitemap.
- A guest match readable by anyone who does not hold its token. All guest matches share one org (§7.1), so an org-scoped read without the per-match check is a leak across strangers.
- An anonymous endpoint that lets one visitor create unbounded data or send mail to arbitrary addresses at volume.
- A second, quick-match-only scoring pad or engine path. The pad and engine must be the existing ones.

## 5. The guest's flow

1. **Marketing page** (`apps/web/src/app/[lang]/(marketing)/page.tsx`). A "Quick match" call to action sits beside the existing start-a-competition funnel (`StartFunnelForm`, hero at `:113`). It links to the quick-match setup screen. There is no sign-in wall.
2. **Setup (one screen, mobile-first; O10, mockup `setup.html`)**. The screen stays on the stadium-night stage the marketing hero uses, with every control open. Top to bottom:
   - **Name**, an editable heading prefilled with a suggestion, e.g. "Badminton · Tue 3 Nov", with the hint "The name you'll look for later".
   - **Sport**: chips for every sport the catalog offers that passes C11. The product ships eleven modules (badminton, table tennis, tennis, carrom, chess, cricket, football, hockey, ice hockey, volleyball, generic: `apps/web/src/components/v2/scorepad/v3/skins/`); the chips show those that pass, never "generic". The catalog is the same the funnel uses (`lib/sport-options.ts:25` `sportOptionsFrom`, `lib/funnel.ts:85-104` `resolveSport`).
   - **Singles / doubles / team** as a switch under the chips, where the sport takes more than one entrant kind. The kind is a per-sport axis, not a variant: each sport module declares the kinds it takes in its `entrantModel` (badminton and tennis take `individual` and `pair`: engine `dist/sports/setbased/badminton.js:88`, `dist/sports/tennis/tennis.js:59`), and no variant carries one (tennis `doubles-noad-mtb10` changes only the scoring, `tennis.js:37-40`). The switch picks the entrant kind: `individual` for singles, `pair` for doubles, `team` for team sports. Chess is individual-only (`entrants.ts:450` `assertChessKindIndividual`). (Corrected 2026-11-07, C24.)
   - **Sides**: a numbered card, 2 rows by default, "+ Add a side" up to **6**, with a "2 of 6" count. Each side is a name only ("Ravi & Sam", "Blue team").
   - **Format**: "League" or "Knockout", each with one plain line under it ("Everyone plays everyone. Most wins tops the table." / "Lose and you're out. Two semi-finals, then a final."). League shows a sub-row **"Each pair plays: once / twice / 3 times / 4 times"** (the league's legs; the word "legs" never appears). Knockout shows the draw as the generator will make it (C22). With **two sides the format row hides** and "Each pair plays" stands alone (C16). Knockout is offered only when the sport and rules cannot end level (C23); otherwise the row shows League alone with one line saying why.
   - **Match rules**: the sport's own games or sets length, shown as one plain choice with the default preselected. The choices are the sport's system variants under plain names in all 4 locales (C14). The switch above picks the entrant kind, and this choice picks exactly one variant; nothing else is shown.
   - **Email**, optional: "Email me the link (optional)".
   - A **Start playing** button that also states the match count, e.g. "Start playing · 6 matches" (C17).
3. **Quick match home (the share link; O11, mockup `home.html`)**. Next match first:
   - the name, a line such as "2 of 6 matches played · kept 7 days after the last score";
   - the **next match as the hero**: "Up next · match 3 of 6", the two sides, one big **Score this match** button. If that match is live on another phone, the hero shows Live and the current score and the button reads "Continue scoring";
   - **Share link** (with a QR code that carries the Seazn logo, a standing rule) and **Save this match**;
   - **Standings** for a league, or **The draw** for a knockout;
   - **All matches** in play order, each unplayed one with a Score button, finished ones at the bottom with their scores, a knockout match whose sides are not yet known shown as waiting;
   - **+ Add a match** for a league only (C5);
   - "Anyone with this link can score."
   - When every match is played, the hero turns into the winner and the final table or bracket (C15).
4. **Scoring**: the existing `/score/[token]` pad, one fixture at a time, with a small "back to quick match" link (C12). When the last point lands the pad shows the result as it does today, with its own undo still open; the back link returns to the home, which by then leads with the next match because the scoring path has already updated the table or seated the winner (§7.10). The pad has no redirect of its own and none is added.
5. **Coming back**:
   - **Same device**: a "Your recent quick matches" strip on the marketing page and the setup screen.
   - **Link**: always works until expiry.
   - **Email**: the link was mailed on creation.
6. **Keeping it**: "Save this match" means sign up or sign in (magic link or Google). On sign-in, that one quick match is recorded against the user and stops expiring (§7.7). Friends with the link can still score it.

## 6. Decisions

### 6.1 Owner's

| # | Date | Decision |
|---|---|---|
| O1 | 2026-11-03 | Users are casual players with no account. Entry is the marketing page, with no sign-in. |
| O2 | 2026-11-03 | A friendly name to remember it, an optional email, and expiry after 7 days. |
| O3 | 2026-11-03 | Sharing is the scoring link. Anyone with it can score. |
| O4 | 2026-11-03 | "Best of N" means separate matches, and what that means depends on the sport. |
| O5 | 2026-11-05 | **League and knockout** are both in v1, chosen on the setup screen by their real names ("stay both format"). Swiss and groups stay out. |
| O6 | 2026-11-03 | 2 to 6 sides (owner "Ok" to the recommendation). |
| O7 | 2026-11-05 | The match rows reuse the existing engine tables; guest-only data goes in a new `quick_matches` table; the existing tables get no schema change; every guest match lives in **one system org** (§7.1). Owner: "yes". |
| O8 | 2026-11-05 | Saving claims **one match at a time**: the Save button saves that match, and signing in with an email saves only matches that email was typed on. Owner: "yes". |
| O9 | 2026-11-05, lifted 2026-11-07 | ~~No remote repo; nothing is committed.~~ **Lifted 2026-11-07** (owner: "yes, lift O9, commit and PR as usual"): work happens on branch `feat/quick-match` in a worktree, with ordinary commits and a PR per plan. |
| O10 | 2026-11-05 | Setup screen: the stadium-night stage with every control open (mockup round: "B but with A in details", then option 1). |
| O11 | 2026-11-05 | Quick match home: next match first, one big Score button, standings or draw and the full list below (mockup option 2; owner asked for the designer's view and it agreed). |

### 6.2 The designer's calls (owner to check while reading)

| # | Call | Why |
|---|---|---|
| C1 | The 7 days run from the **last activity** (creation or the last score), not from creation. | A match left open overnight should not vanish early. |
| C2 | If an email was given, send one reminder **~24h before expiry**, carrying only the link and a "Save it" button. | Gives the guest one chance to keep it, without marketing mail. |
| C3 | The Save button saves that one match for whoever signs in, even if no email was given. Signing in with a verified email saves every quick match that email was typed on and nobody has saved yet. Nothing else from the device comes along. | A shared club tablet must not hand one person's matches to whoever signs in next (O8). |
| C4 | **One link per quick match** (the home page), not one per fixture. The home page mints per-fixture scoring tokens as needed. | A 6-side league has up to 15 fixtures per round of play. Sharing 15 links is not casual. One device link covers exactly one fixture (`device-links.ts:2-7`). |
| C5 | A level league stays level. A guest who wants a decider can add one more match between the two sides from the quick match home, through the existing ad-hoc match (`addFixture`, `stages.ts:7245`): league and group stages only, refused only on a complete stage, inserted at `max(round_no) + 1` with `ext_key 'adhoc-<n>'`, and counted by the standings recompute (`engine-db/competition.ts:745`; `usecases/__tests__/add-fixture.test.ts:84,141-150`). A knockout has a winner by construction and gets no "Add a match". | Owner was unsure; this needs no new rule. |
| C6 | Cap: **6 sides**; a league allows **up to 4 plays each pair** (one league round = once; the generator clamps legs to 1..8, `stages.ts:2619-2620`), so 60 matches at most; a 6-side knockout is 5 matches. | Keeps it casual and bounded for an anonymous creator. |
| C7 | Guest matches are always `visibility = 'private'`, `discoverable = false`. | Discovery reads `public_discovery_v`, which requires public and discoverable (`V419:67-69`); the sitemap reads `public_competitions_v`, public and not draft (`public-site/data.ts:2002-2013`). Private rows never reach either. |
| C8 | Realtime follows the **community** plan (off). Other phones refresh rather than live-update. | The free path should cost no more than community. Revisit if two-phone scoring feels broken in the walkthrough. |
| C9 | A saved quick match stays in the system org. It never touches the user's own org, its plan or its `competitions.max_active`. | Three casual games must not block a new user from creating a real competition. |
| C10 | All guest-facing copy goes in all 4 locale dictionaries. | Standing rule; the marketing page is localized. |
| C11 | **Lineup sports are optional and wait for v2.** v1 offers only sports that score a complete match with name-only sides and no lineup, which the create-and-score sweep (§9) proves for every sport × variant it offers. Cricket is out: a ball needs `striker`, `nonStriker` and `bowler`, the engine refuses `cricket.ball` with no lineup (`usecases/__tests__/scoring-free.test.ts:102-104,141-144`; `event-import-dryrun.test.ts:544-552`), and a scoring link cannot set a lineup. The owner asked on 2026-11-05 whether lineup sports are needed; this is the designer's answer, open for the owner to overturn. | Asking for player names at setup makes the one screen longer and gives guests "people" records (§3). The engine source is not in this repo, so the offered list is proven by running each sport, never typed. |
| C12 | The pad gets a small "back to quick match" link when the fixture belongs to a quick match. Scoring logic is unchanged. | A guest otherwise has no way back to the home except the share link. |
| C13 | Anyone with the home link can score and, for a league, add a decider match. Only the user who saved the match can rename or delete it. After saving, the link still lets friends score. | Casual sharing with one owner once it matters. |
| C14 | The match-rules choice is the sport's existing system variants under plain names in all 4 locales. | No new rule objects; no internal names on the screen. |
| C15 | A quick match is never formally closed. When every match is played, the home's hero shows the winner above the final table or bracket; a league can still take a decider. | No end-of-competition flow for guests. Nothing in the product changes a competition's or division's status by date (§7.3). |
| C16 | With two sides the format row hides and "Each pair plays" stands alone. | League and knockout with two sides are the same single match; a choice with no consequence is noise. |
| C17 | The Start button states the match count, taken from the product's own no-database preview of the generator (`previewDivisionFixtures`, `stages.ts:2778`, already served at `app/api/v1/format-preview/route.ts:33`). | A guest sees what they signed up for before tapping, and the number can never drift from what gets generated. |
| C18 | A knockout fixture whose sides are not yet known cannot be scored and mints no link; the home shows it as waiting. Sides that sit out the first round follow the generator's bye rules. | The final must wait for both semi-finals; no new bracket logic. The pad already shows a waiting screen for a fixture with an unknown side (`score/[token]/page.tsx:104-110`, `scanScreen`), so even a leaked link cannot score it. |
| C19 | The home token is stored twice, exactly as a device link's secret is: its sha256 for lookup and its sealed envelope for re-display (`device-links.ts:22-27`, `secret_enc`, sealed with the relay KEK that an owner ruling of 2026-09-23 says is always set). The pad's back link, the "recent quick matches" strip and the account's list all rebuild `/q/<token>` by unsealing that envelope server-side. No surface gets a second, non-token way in, and the token never rides a query string. **Amended 2026-11-08 (controller (PO rec, autonomous mandate); plan 3 pre-flight D1)**: one exception, the sign-in hand-off. The home token may ride the sign-in `next` parameter (`/login?next=/q/<token>/save`) and, from there, the magic-link mail's link, exactly as the claim and invite secrets already do (`components/auth-form.tsx:85-88`). Nowhere else. Two conditions hold it: the `/q/` path-secret scrub (`lib/scrub-score-url.ts` `SECRET_PATH_ROUTES`, plan 2 Task 5) lands before any surface puts the token in `next`, and a scrub test proves the token is removed from `/login?next=…` with the path encoded once, twice and three times, and from the magic-link URL that carries it. | Three screens need the plaintext link and a hash cannot give it; the product already solved this for printed QR codes. The amendment: a "pending save" cookie was the alternative, and it loses the save silently when the guest opens the sign-in mail in a mail app's in-app browser, which is the common path on a phone. The token already rides the URL path on every home visit and the creation mail, so the hand-off adds no new kind of sink. |
| C20 | A side is one entrant row with a display name and `members: []`, of kind `individual`, `pair` or `team` as the chosen variant implies. Every kind accepts zero members (`api-v1/schemas.ts:696` defaults `members` to `[]`; `entrants.ts:116-127` checks only a maximum). The division's `config.entrants` names the allowed kinds (`entrant-shape.ts:42-46`). | §3 forbids people records for guests, and the pad names a side by its display name when it has no roster (`page.tsx:200-219`). |
| C21 | Nothing date-driven may close a quick match, and nothing in the product does: no cron or lifecycle code changes a competition's or division's status from `ends_on` (`apps/cron-worker/src/schedule.ts:65-169`; `competitions.ts:820-830` only emits an analytics event). The API still requires `ends_on` on create (`schemas.ts:191`; the column is nullable, `V207:10`), so the create sets one a year out and a test pins that no job reads it. The scoring door gates only on the division being started (`lib/division-phase.ts:18-20`). | A saved quick match lives until its saver deletes it (C15), so a calendar must never finish it. |
| C22 | The draw preview on the setup screen comes from `previewDivisionFixtures` (`stages.ts:2778`), which runs the generator's pure `generate()` (`:2607`) over placeholder entrants with no database. The sides are seeded 1..N in the order entered, so the preview and the real draw pair the same way (seed i against N+1−i, byes to the top seeds: `lib/format-templates.ts:104-107`, `format-estimate.ts:43-46`). There is never a second bracket algorithm. | §4 forbids a second engine path, and a preview that disagrees with the real draw is worse than none. |
| C23 | Knockout is offered only when a bracket of the chosen variant **cannot end level**: the engine's own `bracketMayEndLevel(mod, "knockout", cfg)` is false, evaluated on the variant's config merged with the stage defaults that `createStages` seeds for a knockout (for football and hockey: extra time plus a sudden-death shootout). It is decided in one helper that both `offerFor` and the build probe call. A level result in a bracket is held as `needs_decision` (`append-event.ts:191,202`; level kinds `draw`, `tie`, `no_result`, `V432:52`) for an organizer's `core.settle`, whose methods are lot, higher seed or organizer's choice with no replay (`components/v2/needs-decision.tsx:149,288`). No guest can give that. Abandon, forfeit and settle are organizer-only and refused to a device link (`scoring.ts:580-593`). **Amended 2026-11-07 (owner, "apply rec")**: the original test was `supportsDraws(cfg, "knockout")`, which the build found is false for every variant on engine 3.0.2, so it decided nothing. The premise "football can draw, so it is refused" was false for brackets, because the knockout stage presets stop a level finish. | Football, hockey and ice hockey knockouts are offered: "four mates, football, knockout" is a common casual ask. Cricket is excluded from the whole offer anyway (C11). A guest-path settle is a sensitive new write and can wait. |
| C24 | **Corrected 2026-11-07 (plan 1 pre-flight D2).** The entrant kind is its own choice, not part of the variant. The sport module's `entrantModel` declares the kinds it takes (badminton and tennis: `individual` and `pair`, engine 3.0.2 `dist/sports/setbased/badminton.js:88`, `dist/sports/tennis/tennis.js:59`), and no system variant carries a kind (badminton's are `bwf`, `bwf-3x15` and `short`, all scoring, `badminton.js:36-47`; tennis `doubles-noad-mtb10` is scoring only, `tennis.js:37-40`). So the setup's switch picks the kind from the sport's own kinds (chess: individual only), and Match rules picks the variant. The create takes `kind` as its own input and refuses one the sport does not take. This supersedes "as the chosen variant implies" in C20 and the earlier §5 wording. | Read as written, the old wording could never offer Doubles: no variant implies `pair`, so the switch would have nothing to show. |

## 7. How it fits the system

### 7.1 Where guest data lives (owner-approved, O7)

There is no system org, guest user or anonymous-session concept today (a grep for `SYSTEM_ORG|is_system_org|system_user|guest|anon_session` finds nothing).

- **One platform system org, "Seazn quick matches"**, holds every guest competition. It has no human members.
- **One platform system user** is the actor for every guest-created row. `device_links.issued_by` is NOT NULL and references users (`V222__device_links.sql:12`), and `/score/[token]` builds its auth context from `issued_by` (`apps/web/src/app/score/[token]/page.tsx:72-78`). This user can never sign in.
- **One quick match = one private competition** in the system org, with one division and one stage (league with legs = plays per pair, or knockout), name-only entrants, and the generated fixtures.
- **A new `quick_matches` table** carries everything guest-specific: the competition id, the friendly name, the home-page token (its hash and its sealed envelope, C19), the visitor key hash (from an HttpOnly cookie minted on first create), the optional email, the locale, `last_activity_at`, `expires_at`, `reminder_sent_at`, and `saved_by_user_id` (null until saved). The existing tables get no new column; "is this a quick match" is answered by a join to this table.
- **Because every guest shares one org, these hold** (each pinned by a test):
  1. **Quota.** `createCompetition` calls `assertActiveQuota` first (`competitions.ts:134-138`, `:313`); "active" is status `draft`, `published` or `live` (`entitlement-freeze.ts:22`), counted by `quotaCount` (`:177-204`) regardless of visibility. The system org gets an `org_entitlement_overrides` row for `competitions.max_active` with `int_value = null`, which the entitlement reader treats as unlimited (`lib/entitlements.ts:600,616,633`; `V489:33-34`). Staff already manage such rows at `app/api/admin/orgs/[id]/entitlement-override/route.ts:35`.
  2. **Slugs.** Competitions are unique on `(org_id, slug)` (`V207__competitions.sql:16`). The create must not pass a slug: `withUniqueSlug(slugify(name))` then appends `-2`, `-3`… on collision (`slugs.ts:84-106`). Divisions are unique on `(competition_id, slug)` (`V209:16`), one per competition here. Entrant display names are not unique per division (`V256`), so two sides may share a name.
  3. **The per-match check.** Every read or write through a home token checks that the competition (and, for scoring, the fixture) belongs to that token's `quick_matches` row **before** anything is rendered or minted. A system-user context is scoped to the whole system org by RLS, so this check is the only thing between two strangers' matches.
  4. **Org-wide sweeps.** Admin pages count and list every org (`app/admin/page.tsx:11`, `app/admin/orgs/page.tsx:19-28`) and show one org's competitions without a visibility filter (`admin/orgs/[id]/page.tsx:55`); that is acceptable for one named system org. The weekly news digest picks orgs by fixture activity when they are entitled to `news.auto` (`org-posts.ts:1742-1781`), and `billing-grant` grants to every wallet (`api/cron/billing-grant/route.ts:4`): the system org's plan grants neither news nor a wallet (§7.2). Per-division stat refresh is write-triggered (`player-stats-refresh.ts:161,272,385`) and needs nothing. **Corrected 2026-11-08 (controller (PO rec, autonomous mandate); plan 3 pre-flight D12, E1):** "grants no wallet" is a false premise. `grantMonthlyForAllWallets` (`lib/credits.ts:453-510`) runs over every subscription, and community grants `ai.credits.monthly` = 5, so the system org receives 5 AI credits a month. This is accepted: the system user can never hold a session, so the credits cannot be spent. The news digest keeps the system org out only because community has `news.auto` off. That is an entitlement accident, and a catalog change would publish a weekly digest of strangers' matches. So the digest's candidate query excludes the system org explicitly, and a test proves it.
- Every v2 table carries a denormalized `org_id` with RLS triggers (`v2-engine/rls-grants/V225`, `V227`). Nothing ever moves between orgs, so those triggers are never fought.

### 7.2 The system org's plan

The system org is on a dedicated `quick_match` plan key or on community plus overrides (builder's choice). Limits to pin:

| Key | Value | Note |
|---|---|---|
| `competitions.max_active` | `null` = unlimited | via `org_entitlement_overrides` (§7.1 point 1); the per-visitor cap lives in `quick_matches` |
| `divisions.per_competition.max` | 1 | |
| `stages.per_division.max` | 1 | league or knockout, never both |
| `entrants.per_division.max` | 6 | |
| `scoring.device_links` | true | free on every plan since V488; the pad reads entitlements through `hasFeature(link.org_id, …)` (`score/[token]/page.tsx:252`) |
| `realtime` | false | C8 |
| `news.auto`, billing wallet, public dashboards, streaming, sponsors, branding, discovery | off / none | keeps the org out of every org-wide sweep (§7.1 point 4) |

**Per-visitor cap: 5 alive quick matches**, counted as unexpired, unsaved rows in `quick_matches` with the same visitor key hash.

### 7.3 Creating

Creation uses the standard usecases with a built `AuthCtx` for the system user and system org, as `createFromDraft` does (`lib/funnel.ts:114`, context at `:128`). No precedent creates the full tree; `instantiateTemplate` (`templates.ts:104`) stops at stages and `createFromDraft` stops at the division. The quick-match create must, **in one transaction**:

1. create the competition: `visibility: "private"` (the API defaults to public, `schemas.ts:199`; the column defaults to private, `V207:11`), `discoverable` left false, no slug (§7.1 point 2), `starts_on` today and `ends_on` a year out (C21); then the division with the chosen variant (`variant_key`) and `config.entrants` naming the one allowed kind; then one stage: league with `legs` = plays per pair, or knockout;
2. add the N sides as entrants of that kind with `members: []` (C20), seeded 1..N in the order entered;
3. generate the fixtures through `generateStageFixturesTx(tx, …)` (`stages.ts:3481`), the transaction-taking form that skips the pre-flight; it needs at least 2 active entrants (`:3552-3557`) and has no division- or stage-status gate (a `pending` stage goes `active`, `:3939-3943`). A league comes from `generateRoundRobin` (`:2588-2605`, called with `{ entrants, seeds, config: { legs } }`); a knockout from `generateSingleElim` (`:2632-2646`), padded to the next power of two with byes to the top seeds, a bye stored as a round-1 row with the bye holder at home, status `forfeited` and an award outcome (`:1282`, `:3770-3780`), later rounds created up front with empty seats and "Winner of" slot labels (`:3740-3760`) and `winner_to_fixture`/`winner_to_slot` wired (`:3820-3858`). With 3 sides seed 1 sits out; with 5, seeds 1 to 3; with 6, seeds 1 and 2. No seat is ever "owed to a draw": a standalone knockout seats its first round from the entrants directly, and no seeding proposal exists for it;
4. **start the division.** The pad shows a "division not started" waiting screen until the division is `active` (`score/[token]/page.tsx:109-137`), and the scoring door refuses while it is `setup` or `scheduled` (`scoring.ts:560`; `lib/division-phase.ts:18-20`). The product's `startDivision` (`schedule.ts:4064-4228`) opens its own transactions and cannot run inside a caller's, so the create uses a transaction-taking variant of its body (`:4121-4208`): it stamps `schedule_published`, sets `status = 'active'`, records the `division_started` event, and moves the competition `published` → `live` (`:4203-4206`);
5. insert the `quick_matches` row and, if an email was given, its outbox mail (§7.6).

A half-built quick match must never be left behind. The match count the Start button showed (C17) must equal the number of fixtures generated.

### 7.4 Scoring

The quick match home's own token is the credential. It resolves to the `quick_matches` row and through it to the competition. "Score" on a fixture calls a guest-path variant of `ensureDeviceLink` that mints or reopens that fixture's link, issued by the system user, and redirects to `/score/[token]`. Today `createDeviceLink`/`ensureDeviceLink` require a session editor (`device-links.ts:94-99`), so the guest path is new. It must check that the fixture belongs to the competition the home token resolves to (§7.1 point 3), and refuse a fixture whose sides are not yet known (C18). The pad itself is untouched apart from C12.

The pad is fixture-scoped but org-aware: beyond the fixture it reads org branding, competition branding, the org time zone, entitlements, both entrants and both lineups (`score/[token]/page.tsx:87-208`). All of that resolves through the system org, so the system org needs a sensible display name and no branding.

For a knockout, the winner of a scored fixture reaches the next round's fixture the way the engine does it for any knockout stage today (§7.10). The home page reads the sides from the fixture rows; it never computes a bracket itself.

### 7.5 Rendering the home page

The home page renders a private competition's table or bracket and fixture list to anyone holding the token. The precedent is the pad page, which builds `{ orgId: link.org_id, via: "session", userId: link.issued_by, role: "admin" }` and lets RLS limit it to the org (`score/[token]/page.tsx:68-78`). The home page does the same with the system user and system org, then applies the per-match check of §7.1 point 3 on every query.

### 7.6 Email

- An optional email is stored on the `quick_matches` row. It is **never verified at entry**, so it gets exactly one mail at creation and one reminder (C2, tracked by `reminder_sent_at`).
- Use the outbox: `enqueueEmail` (`server/email-outbox/enqueue.ts:152`), locale from the setup screen. Follow the funnel's pattern (`api/funnel/start/route.ts:46-58`), where the row and its outbox mail commit together. Outbox rows reference their subject by free-text `ref_type`/`ref_id` with no foreign key (`V470:38-39`), so the sweep deletes them by that reference (§7.8).
- The mail carries the link and the friendly name only.
- ~~Because the address is unverified, anyone can type a stranger's email on a match. The only effect is one stray match in that person's "Quick matches" list once they sign in, which they can delete (C13). Accepted.~~
- **Corrected 2026-11-08 (controller (PO rec, autonomous mandate); plan 3 branch review B m5):** "the only effect is one stray match" understated it. Because the address is unverified, anyone can type another person's email on a match, and once that person signs in with it, the by-email save (§7.7, C3) makes them **the match's saver**: the match stops expiring, and they get the saver's rename and delete rights (C13). They can rename the match, or delete it out from under the creator's friends, and the creator's own later Save answers "already saved by someone else". This is the intended behaviour of C3 and O8, not a defect, and it stays. Accepted. The address itself is forgotten at that save, because the saver is known from then on (branch review B m9).

### 7.7 Saving

- Signing in runs `postAuthLanding` (`lib/auth.ts:458`) → `ensureActiveOrg` (`:397`), which creates "My organization" for a user with none (`:409`). The save hook runs **before** that, after the email is verified (`verify-email/route.ts:46`, magic-link consume `:34`, Google callback `:123`). It does not interfere with `ensureActiveOrg`; the user's own org is created or kept exactly as today.
- **From the Save button:** the sign-in flow carries that quick match's id; on success, set `saved_by_user_id` on that one row and clear `expires_at`.
- **By email:** on any verified sign-in, set `saved_by_user_id` on every `quick_matches` row whose email equals the verified email (case-folded) and whose `saved_by_user_id` is null, and clear their `expires_at`.
- A second save of a row already saved by someone else is a no-op with a plain message.
- In the account, saved matches are listed under **Quick matches**, read from `quick_matches` by `saved_by_user_id` and rendered through the same token path as the home page (the link rebuilt from the sealed envelope, C19). They do not appear among the user's competitions and never count toward the user's `competitions.max_active` (C9).
- Rename and delete are offered only to the saver (C13).
- **Amended 2026-11-08 (controller (PO rec, autonomous mandate); plan 3 pre-flight D2, D3, D8, D9, D13):**
  - **Save button.** The button POSTs; a GET never writes. A signed-in guest who presses it saves at once. A signed-out guest goes to sign-in with `next=/q/<token>/save` (C19 as amended). After sign-in that address shows a one-button confirm page ("Save this match"). It shows the plain "already saved by someone else" message instead when another account holds the match. The reminder's "Save it" button (C2) opens the same page.
  - **"Any verified sign-in"** means all six places a person's session starts: email verification, magic link, Google, the funnel claim, the invite claim and the claim accept. It never includes staff impersonation. The save runs only when `users.email_verified` is true, and a source-scan test stops a seventh sign-in route from shipping without it.
  - **Saving cancels a queued reminder.** It also never revives a match whose expiry has passed but which the sweep has not yet reached.
  - **Deleting an account** releases the matches it saved: they expire again 7 days after their last activity, so friends with the link keep scoring until then. The deleted address is removed from every quick match that carries it.

### 7.8 Expiry sweep

- A new row in `apps/cron-worker/src/schedule.ts` (the in-repo scheduler; model `funnel-remind` at `:75`) POSTs a new `/api/cron/quick-match-expiry` route gated by `CRON_SECRET` (pattern `api/cron/email-outbox/route.ts:21-24`).
- The route deletes unsaved quick matches whose `last_activity_at` is older than 7 days and sends the C2 reminders. There is no org cleanup; the system org is permanent.
- **`deleteCompetition` cannot be used**: it returns 409 for any competition with score events (`competitions.ts:866-876`), and again for an Event Pass or live paid registrations (`:886-899`). The sweep needs its own hard delete of the competition row, and the database does the rest:
  - competitions → divisions (`V209:3`), competition_events (`V208:5`), api_keys (`V265:8`), competition_passes (`V271:7`), pass_credit_redemptions (`V335:30`), registration_groups (`V363:52`), sponsors and sponsor_packages (`V283:12,40`), all CASCADE; org_posts SET NULL (`V295:20`);
  - divisions → stages (`V210:3`), entrants (`V212:6`), schedule_settings (`V219:5`), division_events (`V220:3`), registrations (`V223:8,25`), schedule undo (`V244:24`), player_stat_snapshots (`V248:7`), player_stat_folds (`V409:29`), discipline (`V293:15,25`), event_imports (`V376:36,108`), all CASCADE;
  - stages → pools (`V211:3`), fixtures (`V214:6`), standings_snapshots (`V218:5`), stage_seed_proposals (`V360:34`), CASCADE;
  - entrants → entrant_members (`V213:2`), lineups (`V215:3`), CASCADE; fixtures' home/away SET NULL (`V214:12-13`);
  - fixtures → score_events (`V216:6`), lineups (`V215:2`), match_states (`V217:2`), device_links (`V222:9`), fixture_officials (`V243:23`), official marks and reports (`V294:31,45`), capture_records (`V437:19`) and the rest of the fixture-keyed tables, CASCADE; `winner_to`/`loser_to` SET NULL (`V214:14,16`); `score_events.voids_event_id` has no clause (`V216:13`) but both rows fall in the same per-fixture cascade.
  - **Deleted by the route itself, because no key reaches them:** `email_outbox` rows by `ref_type`/`ref_id` (`V470:38-39`) and the `quick_matches` row.
  - **Cannot block a guest row:** `sponsor_orders.package_id` is RESTRICT (`V299:15-17`), but guests have no sponsors; `pass_mint_refusals`, stream admission snapshots and video rooms (`V342:39`, `V410:200-201`, `V460:31`) carry ids without keys and never arise for a guest. The orphan test (§9) asserts all of them anyway.

### 7.9 Abuse

- Per-IP rate limit on quick-match create and on the email send (`lib/rate-limit.ts:60` `rateLimit`, `EMAIL_LIMIT` `:96`; precedent `api/funnel/start/route.ts:32-33`).
- Per-visitor cap of 5 alive (§7.2).
- There is no captcha anywhere today. Leave it out of v1 unless the builder finds the limits insufficient; if one is needed it is a separate decision for the owner.

### 7.10 Match end, standings and progression

Nothing here is new work; it is what the scoring path already does, recorded so the plan does not invent a finalize step.

- `POST /api/v1/fixtures/{id}/events` goes through `scoreEvent` (`server/usecases/scoring.ts:150`), whose header lists what it wraps around the engine's append: idempotency, rate limiting, **bracket slot progression, standings recompute**, realtime publish and public-cache invalidation. A fixture that reaches its terminal outcome becomes `decided`.
- `decided` is "settled but not locked" (`lib/fixture-status.ts:29-33`): the result stands, the table and the next seat are updated, and the ledger still takes an undo. `finalized` and `cancelled` are the only locked statuses (`:22`). Finalizing is an organizer's lock, not a step the result needs, so a quick match never finalizes anything.
- Progression is automatic: `scoreEvent` calls `onDecided` whenever the outcome is set and the status is not `needs_decision` (`scoring.ts:361-362`, `:974`); it computes `advancingSides` and `fillSlot`s the winner into `winner_to_fixture`/`winner_to_slot` (`:1046-1057`; `stages.ts:4863-4878`), filling only a null seat.
- Once a result has moved the competition on, the scoring path refuses further writes with `RESULT_CARRIED_FORWARD` and the pad opens read-only (`server/usecases/carried-forward.ts`, `page.tsx:103-110`). For a guest that is the right behavior: a semi-final cannot be undone once the final is seated.
- Standings are recomputed for table stages (`league`, `group`, `swiss`: `scoring.ts:113`; `engine-db/competition.ts:745`). The home page reads the stored table; it never computes one.
- A level result in a bracket is held as `needs_decision` for an organizer's settle; C23 keeps that state unreachable for guests.

## 8. Screens

Three surfaces: the marketing CTA plus the "recent quick matches" strip, the setup screen, and the quick match home. The setup and home layouts were chosen by the owner on 2026-11-05 from mockups; the design of record is:

- `docs/superpowers/specs/mockups/2026-11-03-quick-match/setup.html`: the night-stage setup with every control open, drawn with League chosen and with Knockout chosen;
- `docs/superpowers/specs/mockups/2026-11-03-quick-match/home.html`: the next-match-first home, drawn for a league and for a knockout.

They are layout mockups, not pixel specs: build with the product's own tokens (`--mk-night`, `--mk-lime`, `--mk-cream`, the Barlow Condensed display face, the `.mk-funnel-night` input treatment, `.bottom-bar`). Mobile-first, verified at 320, 768 and 1280 with no horizontal scroll (standing rule). The marketing CTA and the recent strip follow the marketing page's existing components and need no mockup. The pad is the existing one plus the C12 link.

## 9. Tests owed (house rules: unit, e2e, smoke, regression; TEST-STRATEGY.md)

- **Create-and-score sweep:** every sport module × each of its system variants × each format creates 1 division, 1 started stage, N name-only entrants and the fixture count `previewDivisionFixtures` promised (league: N sides × plays; knockout: N sides including byes for 3, 5 and 6), then scores one full match through the real `POST /fixtures/{id}/events` with no lineup. A sport × variant that refuses is excluded from the offered list by that result, and the sweep reports how many cases it checked and which it excluded. Cricket must be among the excluded; badminton, table tennis and tennis among the offered.
- **Knockout offer:** for every offered sport × variant, the format row offers Knockout exactly when the C23 helper says a bracket cannot end level (variant cfg ⊕ knockout stage defaults); football (extra time + shootout) and badminton are offered. Every knockout the probe creates is also checked with `bracketMayEndLevel` on its real fixture cfg (amended 2026-11-07).
- Atomicity: a failure after entrants are inserted leaves no competition and no `quick_matches` row behind.
- Started division: a fresh quick match's first fixture opens the pad with no waiting screen, and the competition reads `live`.
- Format row: hidden with two sides, shown with three; "Each pair plays" shown only for a league.
- Scoring seam, driven through the REAL producer and consumer: from the quick match home, "Score" mints a link and a scored rally lands in `score_events` for that fixture. A home token must not mint a link for a fixture of another quick match in the same system org (negative and positive pair).
- Knockout progression: the final cannot be scored while a semi-final is open; once both are scored the final's sides are the two winners and it mints a link. Byes for 3, 5 and 6 sides match the generator's own output.
- Token re-display: the pad's back link, the recent strip and the account list each produce the working home URL from the stored envelope; the stored hash alone never does.
- Isolation: a home token must not render another quick match's table even though both share the org.
- Visibility: a guest match never appears in the sitemap, org home, discovery or public views.
- Quota and slugs: the system org holds more quick matches than the community `competitions.max_active`; the 6th alive match for one visitor refuses with a localized message; two quick matches with the same name in the same hour both create with distinct slugs.
- Expiry: the sweep deletes a scored, unsaved match older than 7 days of inactivity; keeps one active 6 days ago; keeps a saved one; leaves no row in any table of §7.8, including `email_outbox` and `quick_matches`. Mutate the age predicate once.
- No date closes a match: a saved quick match whose `ends_on` is in the past still scores.
- Save: Save-button save with no email; email save on sign-in; email save when the user already has an org (their org untouched); a second save of someone else's match is a no-op; a saved match is absent from the user's competitions list and quota.
- Limits: the 7th side and the rate limit each refuse with a localized message.
- e2e: the marketing page → setup → home → score one rally → back home, once as a league and once as a knockout, at all seven width projects.
- Smoke: create, score, sweep.

## 10. Left to the builder

- The route names (e.g. `/play` for setup, `/q/[token]` for the home), the token format and the cookie name.
- `quick_match` plan key vs community-plus-overrides for everything other than `competitions.max_active`.
- How the account's "Quick matches" list is wired.
- Exact rate-limit numbers.
- Whether the home token and the visitor key share a table with `funnel_drafts` or get their own (`V272:6` is the precedent; `funnel_drafts` already carries a single-use token and expiry, `lib/funnel.ts:42-78`).
- How the home page's "Live" state and current score are read for a match being scored on another phone (realtime is off, C8; a refresh is enough).
- The plain names for each sport's system variants in the 4 locales.

## 11. Facts that contradict easy assumptions

- "Free orgs can't issue scorer links": false on `origin/main`. V488 made `scoring.device_links` free on every plan (shipped in #1111). A stale local `main` still shows the old state.
- "Scheduled jobs live in a separate repo": false now. The scheduler is `apps/cron-worker` in this repo.
- "`deleteCompetition` can clean up a scored match": false (409, `competitions.ts:866-876`).
- "A scoring link covers a whole quick match": false. One link covers exactly one fixture (`device-links.ts:2-7`), hence C4.
- "A generated fixture is scorable at once": false. The pad waits until the division is started (`score/[token]/page.tsx:109-137`), hence §7.3 step 4.
- "The pad route is under `[lang]`": false. It is `apps/web/src/app/score/[token]/page.tsx` with no locale segment.
- "The pad only touches the fixture": false. It is org-aware (§7.4), which is why the system org needs a plan and a display name.
- "Somebody has to finalize a match before the table moves": false. The scoring path recomputes standings and seats bracket winners on `decided`; `finalized` is only a lock (§7.10).
- "A device link's secret is stored only as a hash": false. It is stored as a hash and as a sealed envelope so a printed QR can be shown again (`device-links.ts:22-27`), hence C19.
- "A level knockout result just needs a replay": false. It is held as `needs_decision` for an organizer's settle, and settle offers no replay, hence C23.
- "The engine is in `packages/engine`": false. It is the npm package `@onryde/seazn-engine`; `packages/` holds only `reference/` and `scheduler/`.
- "A lineup size of 0 means no lineup is needed": false. A missing lineup policy answers `LINEUP_NOT_SUPPORTED` (`api-v1/http.ts:36-38`); whether a sport scores without named players is proven by scoring it (C11).
- "`startDivision` can be called inside the create's transaction": false as written; it opens its own (`schedule.ts:4064-4228`), hence the transaction-taking variant in §7.3 step 4.
- "`addFixture` lives at `stages.ts:6894`": false; it is at `:7245`.
- "The system org's plan grants no wallet": false. `billing-grant` grants 5 AI credits a month to every subscription, the system org's included. Accepted (2026-11-08), because they cannot be spent (§7.1 point 4).
- "The three `postAuthLanding` call sites are every sign-in": false. The funnel claim, the invite claim and the claim accept start a session without reaching it, so the save runs at six sign-in points (§7.7, amended 2026-11-08).

## 12. Related designs of record

- **W4 knockout family** (`2026-11-04-format-matrix-w4-knockout-design.md`, approved by the owner on 2026-11-04, rules recorded in the engine and marked not yet implemented). It makes the knockout family trustworthy for standalone use, which is exactly what a quick knockout is: the prod census found no standalone knockout at all. Three of its rulings touch this design and are followed here: the draw seeds on the fold with byes to the top seeds and **draws the unseeded at random with a stored seed** (its G6), so the quick match create seeds every side explicitly 1..N in entry order and the random path never runs, keeping the preview equal to the real draw (C22); third place is one setting with **Shared** as the default in every sport (its G4), and a quick match keeps that default, so there is never a third-place match; a final not played ends as a walkover or a vacant title (its G5), which a quick match reaches only through the organizer-free paths already in the engine. Quick match asks for **no engine change**; if a probe test shows one is needed, that is a W4-style ruling for the owner, not something this design assumes.
- **W5 round-robin family** (`2026-11-05-format-matrix-w5-round-robin-design.md`, approved by the owner on 2026-11-06, ruling 285). It makes a standalone league trustworthy, which is what a quick league is. Its rules for late entry, withdrawal, pools and the cut never arise here because a quick match's sides are fixed at creation and there is only one stage. It keeps the ad-hoc "Add match" that C5 relies on (its FX-G15 notes each such match lands in its own new round, which is fine for a decider). Engine versions: W4 releases the engine as 4.0.0 and W5's engine change lands after it; the create-and-score sweep (§9) runs against whatever engine the app pins at build time, and a fold-epoch raise means the app's migration steps run first, exactly as W5 says.
- **Device-link scoring gaps** (`2026-09-21-device-link-scoring-gaps-design.md`, approved 2026-09-21): the pad transport's handling of terminal 409s and the per-fixture rate limit on replays. Already of record for the pad the quick match reuses; nothing here changes it.

## 13. Settled at build time by the probe tests

Two facts live inside the engine package and are proven by running it rather than read:

- Which sport × variant pairs score a complete match with no lineup (C11, §9 first test). Known from app tests: cricket refuses; football's `taker` and `goalkeeper` are optional (`scoring-free.test.ts:99-101`) but it is a team sport and the probe decides.
- Which sport × variant pairs can end level in a bracket under their knockout stage defaults (C23, §9 second test). Answered 2026-11-07 on engine 3.0.2: none of the offered variants.
