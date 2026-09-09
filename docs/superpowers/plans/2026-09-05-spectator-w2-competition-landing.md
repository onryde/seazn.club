# Spectator W2 — Competition Landing Implementation Plan

> **Status:** DRAFT — re-pin file:line references after W1 merges; not yet approved for execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the public competition page (`/shared/[org]/[comp]`) into the competition's front window on a phone — a tab rail of Overview · Matches · Table · Stats · Teams · (Gallery slot) · Info fed by ONE live document — and give the division and player pages the same phone composition, with every string on every `/shared` page in the `public` dictionary in four locales.

**Architecture:** A server builder (`loadCompetitionHub`) composes the readers that already exist — `getPublicCompetition`/`getPublicDivision` for fixtures, standings snapshots and entrants, `player_stat_snapshots` for leaders, `resolveModule` for the sport's declared metric specs — into one zod-typed `CompetitionHubDoc` in which every number is already formatted and every name already consent-resolved. The page renders that document server-side (ISR, tag-invalidated) and a client root (`CompetitionLanding`) re-renders EVERY tab from the same document delivered by a new public poll endpoint (`GET /api/v1/public/orgs/{org}/competitions/{slug}/hub`, Redis-cached, deleted on every scoring write) plus the existing `division:{id}` Realtime broadcasts on Pro — one hook instance per page, never one per card. The division page renders its own slice of the same document through the same hook; the player page adds per-match lines from W1's engine fold; the org home derives its chip from live fixtures and polls a tiny public endpoint.

**Tech Stack:** TypeScript 7, Node 26, pnpm; Next.js App Router (ISR via `revalidate = 30` + `generateStaticParams`, `unstable_cache` tags); `@seazn/engine` (`deriveCricketScorecard`, `StandingsRow`, `DERIVED_METRICS`, `PlayerStatsModel`); zod; vitest (`environment: "node"`, no DOM — `renderToStaticMarkup` + `_hook-harness` islands); Playwright (`walkthrough` project, seven-width `mobile.spec.ts`); Supabase Realtime + 15 s poll; Redis cache-aside (`@/lib/cache`); Tailwind public-site tokens.

**Spec:** `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` (§W2 "competition landing, division and player pages, i18n sweep", standing rules R1–R11, §"Copy and i18n", §"Error and empty states"). Programme rules: `docs/superpowers/specs/2026-09-04-spectator-prompts/_RULES.md`; index: `_INDEX.md` (owner rulings 1–13, false premises); prompt: `W2-landing.md`. Competition-desk rulings this surface inherits: `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_RULES.md` (venue zone, empty case FIRST, ladders are ORDER, "Fixture Console" = the DIVISION page's `?tab=fixtures` on `/o/…`, never anything here). W1 plan (conventions this plan matches): `docs/superpowers/plans/2026-09-04-spectator-w1-match-centre.md`.

## Global Constraints

- Worktree `.claude/worktrees/spectator`, branch `feat/spectator-surface`; never the main checkout. `pnpm install --frozen-lockfile`; **pnpm, never `npm install`**. One PR for the wave (spec §"Wave order"); it may split at the division/player-page boundary if the review load demands, and the landing PR then still ships its walkthrough leg so the hub seam is not left inert.
- **R1 — Phone composition, not shrink.** Design at 320/375 first; ≥768 may add columns or lay cards two-up, never new controls. Verify with a **control-set diff from the live DOM at 320 against 1280** (membership, order, repeats), never box sizes. Every scrolling region carries `tabindex="0"`, a role and an accessible name; no page scrolls horizontally at 320/360/375/390/430/768/834. One DOM branched with `max-md:*` / `md:hidden`; `/\bmd:hidden\b/` also matches inside `max-md:hidden` — anchor assertions on `\s...hidden"`.
- **R2 — Every string through the `public` dictionary namespace in all four locales** `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`, keys written BARE (`matchesHub.*`, never `public.matchesHub.*`), then `npm run i18n:gen-keys` (regenerates `apps/web/src/lib/i18n-keys.ts` — never hand-edit) and `npm run i18n:check`. Standings abbreviations P W D L Pts and the engine's metric notation (GD, NRR, Ratio) stay as notation with a localised `title`. Competition, division, `LiveScore`, schedule and the layout tagline are hardcoded English today — a defect this wave removes.
- **R3 — Consent before names.** Every person name goes through `resolvePersonDisplayName(fullName, consent, divisionSetting, youth)` (`apps/web/src/lib/name-display.ts:72`), entrant display names through `maskPublicEntrantNames` (`server/public-site/data.ts:510`). Never a second resolver. A masked person renders the masked label, never a blank row; a player-page link is offered only when the person is in `public_players_v`.
- **R4/R9 — Presence and the empty case first.** A tab with nothing to show is not rendered (Gallery is a reserved slot only — W4 fills it); every aggregate (matches filter default, landing status line, tables, leaders, teams) states its empty case in its test BEFORE its ladder, and every ladder test carries an order-differential case.
- **R5 — One authority per fact.** Standings numbers come from `public_standings_v` snapshots only (never recomputed); leaders from `player_stat_snapshots` via `recomputePlayerStats` (`usecases/player-stats.ts:55`); the result sentence from `decidedOutcomeText` (`@/lib/scoring-vocab`); round names from `roundRoleLabel(roundRoleFor(...))` (`@/lib/round-role-label.ts:21,90`); the venue zone from `resolveVenueTz` semantics as already materialised by `getPublicDivision`'s `tz`; format chips from the division CONFIG, never `variant_key`.
- **R6 — No new entitlement rows.** Realtime stays behind `org_has_feature(org, 'realtime', competition)` (`data.ts:732-734`), poll otherwise; `org.branded` decides the footer. Entitlements v18 matrix and copy untouched.
- **R7 — Testids `mh-*` on every new control** (spec R7 + `W2-landing.md` item 11; see "Premises to re-pin" for the `cl-*` discrepancy in the brief). Every wave extends `apps/web/e2e/walkthrough/spectator-public.spec.ts`; setup may API to REACH a state, but the cricket over W1 TAPS through the real pad is read on THIS wave's pages too.
- **R8 — Share loop.** Every public page keeps the share bar; "Powered by seazn" stays on every page of a non-branded org.
- **R10 — Live means live, never reload.** The Live-now rail, the Matches cards, the division schedule rows, the tables and the org-home chips re-render IN PLACE from the polled document; the walkthrough posts an event through the API while the anonymous page is OPEN and asserts the DOM changes within one poll interval with `anon.url()` unchanged. A test that reloads has not tested this.
- **R11 — Visual sign-off, per screen.** Every tab and state screenshotted at 320/768/1280 on a prod build with real data and READ; per-screen verdict table appended to the spec ("W2 sign-off — per-screen verdicts"); tap targets ≥ 44 px measured with `elementFromPoint`; a 43-character entrant name is the truncation test; a cosmetic defect is a defect.
- Design: build to `docs/superpowers/specs/2026-09-04-spectator-prompts/_DESIGN.md` §5 W2 — the Live-now rail, every live match as a swipeable row of miniature court cards with real team names and scores, updating in place; tokens and classes by name, never new colours or radii; R11 reads each screen against the _DESIGN checklist.
- ISR contract: the competition, division, player and org pages keep `export const revalidate = 30|300;` and `generateStaticParams() { return []; }` exactly (`apps/web/src/lib/__tests__/public-isr-contract.test.ts:25-67`). Never read `searchParams`/`cookies()`/`headers()` in these server components (it flips the route to dynamic); the `?tab=` parameter is read on the client.
- Assertions on Next HTML anchor on `="` — an omitted prop serialises as `"$undefined"`.
- Subagents: Opus at minimum (frontmatter; never pass `model:`); scoped vitest/tsc only — the orchestrator runs the full gate from `apps/web` with `--reporter=json --outputFile` and judges `numTotalTests`/`numFailedTests`/`numFailedTestSuites`, never exit codes; `cd <worktree>/apps/web &&` in the SAME call as any verify command and confirm `.testResults[].name` paths are under the worktree.
- Commit after every task with a normal-prose message ending in the two trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01TCLYbFJZ8bseHS4kp4nGDa`. In this worktree git commands are plain `/usr/bin/git <verb> …` with no compound shell around them; `git stash` is never used here (shared stash stack).
- Do NOT touch: the organiser console (`apps/web/src/app/o/**`, `components/v2/**` — `components/public-site/standings-table.tsx` and `schedule.tsx` are consumed by the console/embed and are left as they are), the scorepad, the engine (`packages/engine/**` — W1 already exports `deriveCricketScorecard`), registration pages, the `present` slides, the landscape OG card, entitlement matrix/copy, `e2e.yml`.

---

## File structure

**Server (`apps/web/src/server/public-site/`)**
- `competition-hub-schema.ts` — NEW. zod schemas + inferred types for the hub document (`CompetitionHubDoc`, `HubMatch`, `TableView`, `LeaderBoard`, `TeamCard`, `HubDivision`, `HubInfo`, `CompetitionHubTabId`). Imports `Msg`, `Side`, `Person`, `MatchCentreHeader` from `./match-centre-schema.ts` (W1).
- `standings-view.ts` — NEW. `buildTableView(input): TableViewT` — formats a standings snapshot into pre-resolved cells using the same `standingsColumns`/`formatMetric`/`derivedMetricText` the old table uses.
- `champion.ts` — NEW. `divisionChampion(stages, fixtures, standings): string | null` — the champion rule lifted verbatim from the division page (`[divisionSlug]/page.tsx:125-149`), pure, empty case first.
- `describe-format.ts` — NEW. `describeFormat(sportKey, cfg): MsgT | null` — format chip from the division CONFIG (cricket overs, football minutes, set sports best-of); null falls back to `variant_key`.
- `leaders.ts` — NEW. `LEADER_SPECS`, `specsFor`, `buildLeaderBoards` (pure).
- `public-leaders.ts` — NEW. `readLeaderRows(sql, divisions)` — snapshot rows joined to persons/entrants, consent-resolved.
- `competition-hub.ts` — NEW. `hubHeader`, `hubSide`, `loadCompetitionHub`, `getPublicCompetitionHub` (unstable_cache + tags).
- `public-player-matches.ts` — NEW. `readPlayerMatchLines(sql, ...)` — per-match lines from W1's `deriveCricketScorecard` (cricket) or the fixture summary (other sports).
- `data.ts` — MODIFY: `PublicDivision.config`, `getPublicOrg` gains `in_play` per competition, `getPublicPlayer` gains `matches` (cache key bumped to `pub-player-v16`).
- `../usecases/public.ts` — MODIFY: `publicCompetitionHub`, `publicOrgLive` (Redis `cached`, 15 s TTL variant).
- `../usecases/scoring.ts:491-520` — MODIFY: `invalidatePublicCache` also deletes `pub:v1:hub:{competitionId}` and `pub:v1:org-live:{orgId}`.
- `../api-v1/openapi.ts:196-201` — MODIFY: two new public entries; `npm run openapi:gen`.

**Pure helpers (`apps/web/src/lib/`)**
- `matches-hub.ts` — NEW, client-safe: `bucketFixture`, `defaultMatchesFilter`, `dayKeyInZone`, `groupByDay`, `sortHubMatches`, `deriveHubTabs`, `landingStatus`.
- `public-site.ts:400-421` — MODIFY: `competitionChip(status, inPlay)`.

**API routes**
- `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/hub/route.ts` — NEW.
- `apps/web/src/app/api/v1/public/orgs/[orgSlug]/live/route.ts` — NEW.

**UI (`apps/web/src/components/public-site/`)**
- `competition-hub-data.ts` — NEW: `fetchCompetitionHub`, `fetchOrgLive` (via `api()` from `@/lib/client`).
- `use-live-competition.ts` — NEW: the transport hook (poll + `division:{id}` Realtime).
- `tab-rail.tsx` — NEW: `PublicTabRail` (generic: role=tablist, tabindex=0, aria-label, arrow keys, `data-testid={prefix}-tab-{id}`).
- `matches-hub/match-card.tsx`, `matches-hub/matches-tab.tsx`, `matches-hub/table-tab.tsx`, `matches-hub/stats-tab.tsx`, `matches-hub/teams-tab.tsx`, `matches-hub/info-tab.tsx`, `matches-hub/overview-tab.tsx`, `matches-hub/competition-landing.tsx` — NEW.
- `standings-table-view.tsx` — NEW: client-safe phone-composed table over a `TableViewT` (the old `standings-table.tsx` stays for the console and the embed).
- `sponsors-board.tsx` — NEW (server): the sponsor board lifted from `[competitionSlug]/page.tsx:272-412`, i18n'd, passed to the landing as a slot.
- `division-landing.tsx`, `division-schedule.tsx` — NEW: the division page's client root and its MatchCard schedule (the old `schedule.tsx` stays for the embed).
- `org-live-chips.tsx` — NEW: the org home's polling chip island.
- `share-bar.tsx` (`apps/web/src/components/share-bar.tsx`) — MODIFY: optional `labels` prop.
- `tabs.tsx` — DELETE (its only consumer was the division page).

**Pages (`apps/web/src/app/(public)/shared/[orgSlug]/`)**
- `[competitionSlug]/page.tsx` — MODIFY: hero i18n + `<CompetitionLanding>`; metadata from the dictionary.
- `[competitionSlug]/[divisionSlug]/page.tsx` — MODIFY: `<DivisionLanding>`, phone standings, badges, i18n.
- `[competitionSlug]/players/[personId]/page.tsx` — MODIFY: per-match performances + i18n.
- `page.tsx` (org home) — MODIFY: live chip + `<OrgLiveChips>` + locale-aware dates.
- `layout.tsx:96-114` — MODIFY: tagline and footer through the dictionary.
- `news/[postSlug]/page.tsx:141` — MODIFY: pass `ShareBar` labels.

**Dictionaries**: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (+ `npm run i18n:gen-keys`).

**Tests**: `apps/web/src/lib/__tests__/matches-hub.test.ts`; `apps/web/src/server/public-site/__tests__/{standings-view,champion,describe-format,leaders,public-leaders,competition-hub,public-player-matches,hub-dictionary}.test.ts`; `apps/web/src/components/public-site/__tests__/{match-card,matches-tab,standings-table-view,stats-teams-info-tabs,overview-tab,competition-landing,public-tab-rail,use-live-competition,division-schedule,org-live-chips}.test.tsx`; page tests beside each page in `__tests__/`; `apps/web/src/lib/__tests__/public-english-sweep.test.tsx`; API route tests beside each route; `apps/web/e2e/walkthrough/spectator-public.spec.ts` (W2 block); `apps/web/e2e/mobile.spec.ts` (two added routes); `scripts/smoke.ts` (three added checks).

---
## Premises to re-pin before execution (this plan is a DRAFT until each is checked)

Every line number below was opened on 2026-09-05 on the branch named; W1 is still on two lane branches and the main worktree, so anything W1 touches can move. A false premise is a finding to record in `_INDEX.md`, not a blocker.

> ### RE-PINNED 2026-09-08 against merged `main` (W1 = #743; `main` at `4ee38278d`)
>
> All twenty premises re-opened file by file — read, not grepped. **Three hold
> unchanged (P3, P4, P7). Seventeen moved, changed, or were false.** The
> corrected pins are in the **re-pin table directly below the original table**;
> where it and the original 2026-09-05 row disagree, **the re-pin table wins**.
> The rows below are left as written so the drift itself stays legible.
>
> **The five that change what gets built, not just where it lives:**
>
> 1. **P5 — copying W1's "TabRail contract" verbatim would re-introduce two
>    defects W1 deliberately fixed.** The tablist does NOT carry `tabIndex={0}`
>    (roving tabindex lives on the buttons, `tabIndex={isActive ? 0 : -1}`), and
>    `aria-controls` is emitted only on the ACTIVE tab. A code comment at
>    `tab-rail.tsx:39-54` records both as fixed. Task 19 must copy the CURRENT
>    contract, and no test may assert the old one.
> 2. **P14 — `recomputePlayerStats` is NOT watermark-based.** It re-folds EVERY
>    `score_event` in the division on every call (`throughSeq` is a running count,
>    not a resume point). The Stats tab calls it per division on a hub page, so
>    this is a cost question Task 3 owes an answer to — the plan assumed an
>    incremental read. Signature is also `(tx, divisionId)` returning
>    `{ rows, throughSeq, hasModel }`, with no `orgId`: callers wrap it in
>    `withTenant` themselves.
> 3. **P11 — `bucketFixture` has never existed.** The plan cites it as a thing to
>    reuse; it is an export of `lib/matches-hub.ts`, a file this plan CREATES.
>    Nothing classifies a fixture under that name today. Task 4 writes it from
>    scratch, and the empty-case-first ladder is its own to get right.
> 4. **P13 — the reschedule staleness recorded here is too pessimistic.** Schedule
>    writes go through `afterScheduleWrite` (`schedule.ts:97-105`), which DOES drop
>    `pub:v1:div:{id}:*` and fire `fireDivisionRevalidate`. What it never drops is
>    `pub:v1:fixture:{id}`. So a reschedule is not invisible until TTL; only the
>    per-fixture key is. Task 4's hub key must be added in BOTH paths.
> 5. **P12 — W1 already falsified this one, in our favour.** `/public/fixtures/{id}`
>    now carries `response: S.PublicFixtureSummary` (`openapi.ts:201`, added by
>    `21b68b2fe`). The other six public routes still carry none. Task 5 has a
>    worked precedent to copy rather than a pattern to invent.
>
> **P9 — the ruling's premise is CONFIRMED, hard.** `PlayerStatsModel`
> (`stats.ts:106`) declares no floor, threshold, qualification or leaderboard
> field under any name, and `packages/engine/src/stats/` holds nothing else. The
> count keys the ruling names all exist as declared metrics: cricket `runs`,
> `wickets`, `sixes` (plus `fours`, `catches`, `stumpings`, `dismissals` and ten
> `dismissals_<kind>`); football `goals`, `assists` (plus cards, penalties,
> shots). So ruling 15.2 is buildable exactly as written, and the additive
> `leaderboards` declaration it permits has no existing field to collide with.
>
> **P20 is the worst doc drift and touches every e2e task.** The W0 helpers did
> NOT move to `e2e/spectator-public.spec.ts` — that file does not exist. They live
> in `e2e/spectator-public-helpers.ts` (`postEvent:52`, `createPersons:103`,
> `playInnings:134`, `fixtureSides:227`, `putLineups:239`, `controlSet:472`),
> imported by `e2e/walkthrough/spectator-public.spec.ts` and `…-2.spec.ts`.
> **`setScheduledAt` does not exist anywhere** — zero matches across `apps/`,
> `packages/`, `scripts/`. Any task that plans to call it needs a different plan.
> `DEFAULT_SHOT_WIDTHS` is `[1280, 768, 320]` — THREE widths, not the seven-width
> matrix; the seven widths are `mobile.spec.ts` projects, a different mechanism.
>
> **P1 and P2 need no work.** P1 is ruled `mh-*` (`_INDEX.md` ruling 15.1) and the
> plan already uses it — 94 `mh-` occurrences against 2 `cl-`, both of which are
> inside P1's own row describing the error. No rename. P2 is stale: `W2-landing.md:4`
> already points at this file, and the path it calls wrong does not exist.

| # | Premise | Pinned at | Moves when |
|---|---|---|---|
| P1 | Testid prefix. The spec (R7) and `W2-landing.md` item 11 say **`mh-*`**; the dispatch brief for this plan said `cl-*`. This plan follows the spec. If the owner wants `cl-*`, it is a global rename of the `mh-` literals in Tasks 7–17 and of the smoke markers — decide before Task 7. | spec §R7; `W2-landing.md:60-63` | owner ruling |
| P2 | Plan path. `W2-landing.md:4` expects `../../plans/2026-09-04-spectator-w2.md`; this file is `2026-09-05-spectator-w2-competition-landing.md`. Update the prompt's pointer and `_INDEX.md` in the wave's PR (Task 18) — not here (docs-only draft, one file). | `W2-landing.md:4`; `_INDEX.md:7` | Task 18 |
| P3 | W1's document schema and its exported names: `MatchCentreHeader`, `Msg`, `Side`, `Person`, `MatchCentreDoc`, types `…T` (`match-centre-schema.ts:8-85` on lane C, 65 lines on lane B and on this branch). Lane C adds `SetsView.unit/columnLabels` and `MatchCentreDoc.derivedComplete`. This plan imports only `Msg`, `Side`, `Person`, `MatchCentreHeader` and their `…T` types. | lane C `apps/web/src/server/public-site/match-centre-schema.ts:8-24,83-85` | W1 merge |
| P4 | W1's transport hook `useLiveFixture` and `POLL_MS = 15_000` (`use-live-fixture.ts:10,18-22`, lane B); the hub's `HUB_POLL_MS` must equal it — Task 7's test imports both once W1 is merged. | lane B `components/public-site/match-centre/use-live-fixture.ts:10` | W1 merge |
| P5 | W1's `TabRail` DOM contract (`role="tablist" tabIndex={0} aria-label`, `id="mc-tab-<id>"`, `aria-controls`, Left/Right/Home/End) — `tab-rail.tsx:39-87` lane B. Task 19 (optional) folds it onto `PublicTabRail`. | lane B `components/public-site/match-centre/tab-rail.tsx` | W1 merge |
| P6 | W1's `LiveScoreBody` split and `MatchCentre` mount on the fixture page (W1 Task 14) — this plan does not touch the fixture page; the english-sweep test (Task 16) includes it only if W1's Task 14 has landed. | W1 plan Task 14 | W1 merge |
| P7 | The engine fold IS on this branch already: `packages/engine/src/sports/cricket/scorecard.ts`, `scorecard-types.ts`, exported from `index.ts:68` (`deriveCricketScorecard`, `ScorecardInput`); `__tests__/scorecard-ledger.ts` (24 KB) is the scripted-ledger builder Task 14's test copies. `BattingLine.dismissal.kind`, `BowlingLine.wickets/runs/legalBalls` per `scorecard-types.ts`. | this branch, `packages/engine/src/sports/cricket/index.ts:68` | engine rebase |
| P8 | W1's web-side `apps/web/src/server/public-site/__tests__/cricket-ledger.ts` (the copy of the builder the W1 plan's Task 6 promised) does NOT exist on either lane yet — Task 14 copies from the engine test folder if it is still absent. | lane C `__tests__/` listing (no such file) | W1 merge |
| P9 | **False premise in the spec**: "leaders' floor read from the module's metric spec". `PlayerStatsModel` (`packages/engine/src/stats/stats.ts:106-`) declares `metrics[] {key,label,from,field,agg,sumField,when,entrantField,fromEntrant,value}`, `derived[] {key,label,derive}`, `awards[]`, `folded` — **no floor, no leaderboard declaration anywhere**. W2 therefore ships COUNT leaders only (runs, wickets, sixes; goals, assists), whose declared keys a test pins against the module, and ships NO ratio leader (strike rate, economy). The ratio boards need an engine declaration (a `leaderboards?: {...}` on `PlayerStatsModel`) — an owner question (see the report), not a W2 engine touch. | `stats.ts:60-200`; `cricket.ts:2510-2600` | owner ruling |
| P10 | `division:{id}` Realtime channels are subscribed WITHOUT a token and WITHOUT `private: true` by the slideshow (`components/v2/slideshow.tsx:118-130`); `publishDivisionUpdate(divisionId, "score")` fires `state_changed` on every scoring write (`usecases/scoring.ts:140-144`, `lib/realtime.ts:49-86`). The hub subscribes the same way, gated by the competition's `realtime` entitlement. If Supabase's realtime config has since made broadcast channels private, the hook silently falls back to polling — the walkthrough still passes on poll, so ALSO assert the transport it saw (`data-transport`). | `slideshow.tsx:123`; `realtime.ts:49` | Supabase config |
| P11 | The public fixture status vocabulary is `scheduled | in_play | decided | finalized | abandoned | forfeited | cancelled` (`server/api-v1/schemas.ts:1034`); W1's header adds `postponed`/`walkover` dictionary keys that the DB enum does not carry. `bucketFixture` treats anything not `in_play` and not terminal as upcoming. Division status is `setup | scheduled | active | completed` (`schemas.ts:53`) — the current competition page tests `d.status === "in_play"`, which never matches. | `schemas.ts:53,1034` | schema change |
| P12 | Public API routes carry NO typed response in `openapi.ts` (`:196-201`: `public: true`, no `response`). This plan ADDS `response: CompetitionHubDoc` so the drift gate sees the doc; `RouteSpec.response?: ZodType` (`openapi.ts:27`). | `openapi.ts:21-30,196-201` | — |
| P13 | `invalidatePublicCache` (`scoring.ts:491-520`) deletes `pub:v1:fixture:{id}` and `pub:v1:div:{divisionId}:*` and fires `fireDivisionRevalidate(divisionId, competitionId)`; it knows the competition id (row query) — Task 4 adds the hub key there. Schedule writes go through `publishDivisionUpdate(...,"schedule")` and do NOT call `invalidatePublicCache` — a reschedule reaches the hub within the Redis TTL (15 s) + ISR window, which is accepted and recorded. | `scoring.ts:491-520` | — |
| P14 | `recomputePlayerStats(tx, divisionId)` is watermark-based and is what the public leaderboard already calls before reading (`usecases/player-stats.ts:55,539`); it needs `withTenant(orgId, …)`. | `player-stats.ts:525-545` | — |
| P15 | `getPublicDivision(...)` returns `{ stages, pools, fixtures, standings, entrants, tz }` under `unstable_cache` tags `divisionTag`+`competitionTag` (`data.ts:610-687`); `tz = coalesce(schedule_settings.tz, organizations.timezone, 'UTC')` (`data.ts:664-669`) — the venue zone per division. `getPublicCompetition` selects no `config` column (`data.ts:425-436`); Task 4 adds `dv.config`. | `data.ts:407-687` | — |
| P16 | `renderIsland` (`apps/web/src/components/__tests__/_hook-harness`) is the node-env island renderer stateful-component tests use (`live-score.test.tsx:22`); `stubFetch`/`stubInterval` are file-local there (`:26-55`) — Task 7 copies them. | `live-score.test.tsx:21-55` | — |
| P17 | `mobile.spec.ts`'s public seed has a generic-sport competition with entrants and NO fixtures (`:343-380`) — the Matches/Table/Stats tabs are absent there by design (R4); Task 17 adds `?tab=teams` and `?tab=info` routes there and runs the seven-width scan for every tab inside the walkthrough instead. | `mobile.spec.ts:326-400,1205-1260` | — |
| P18 | `decidedOutcomeText(outcome, entrantNames, msgFn, shootout)` and `shootoutScoreFromDetail` (`@/lib/scoring-vocab`, used by the fixture page `page.tsx:38-45`) — the ONE result-sentence authority; it resolves through the `ui` namespace via `msgFor(locale, …)` (`lib/messages-i18n.ts:24`), already in four locales. | fixture `page.tsx:16-45` | W1 Task 14 edits this page |
| P19 | `roundRoleFor(...)`/`roundRoleLabel(msg, role)` (`lib/round-role-label.ts:21,90`) — pin `roundRoleFor`'s parameter shape (it reads `round_no`, `lane`, `is_final`, `third_place` off a `LaneRoundFixture`, `:59-`) before Task 4. | `round-role-label.ts:59-110` | — |
| P20 | `_hook-harness`, `expectNoHorizontalScroll` (`e2e/helpers.ts:43-101`), `screenshotAtWidths` (`helpers.ts:240`, widths `[1280, 768, 320]` at `:229`), `AxeBuilder` usage (`mobile.spec.ts:1391`), the W0 harness's `controlSet` (`w0-spectator-capture.spec.ts:266-289`) and its seeding helpers (`postEvent`, `createPersons`, `playInnings`, `fixtureSides`, `putLineups`, `setScheduledAt`, `:33-262`) — W1 Task 15 moves these into `spectator-public.spec.ts` and DELETES the W0 file; Task 17 imports from wherever W1 left them. | W1 plan Task 15 | W1 merge |

### Re-pin table — verified 2026-09-08 against merged `main` (`4ee38278d`)

Authoritative over the 2026-09-05 rows above. Every pin below was read in the
file, not grepped.

| # | Verdict | Corrected pin / what is actually true |
|---|---|---|
| P1 | **RULED, no work** | `mh-*` (`_INDEX.md` ruling 15.1). Plan already uses it: 94 `mh-` vs 2 `cl-`, both inside P1's own row. |
| P2 | **STALE, already fixed** | `W2-landing.md:4` already points at this file. The path it calls wrong (`2026-09-04-spectator-w2.md`) does not exist. |
| P3 | **HOLDS** | `match-centre-schema.ts` — `Msg:9`, `Side:11`, `Person:12`, `MatchCentreHeader:14`, `MatchCentreDoc:84`, `SetsView.unit`/`.columnLabels:81`, `derivedComplete:96`, `…T` types `:98-110`. |
| P4 | **HOLDS** | `use-live-fixture.ts` — `POLL_MS = 15_000` at `:10`; `useLiveFixture` at `:17`. |
| P5 | **CHANGED — two claims now FALSE** | `tab-rail.tsx:129`. `role="tablist":175`, `aria-label:176`, `onKeyDown:178`, `id="mc-tab-<id>":188`, `aria-controls:194`, `tabIndex:201`, Arrow/Home/End `:160-163`. **No `tabIndex={0}` on the tablist** (roving `tabIndex={isActive ? 0 : -1}` on the buttons) and **`aria-controls` only on the ACTIVE tab**. `tab-rail.tsx:39-54` records both as deliberately fixed — do not re-assert the old contract. |
| P6 | **CHANGED** | The fixture page mounts `MatchCentreWithTabParam` (`…/fixtures/[fixtureId]/page.tsx:293`, import `:22`), which renders `MatchCentre` (`match-centre.tsx:51`). `LiveScoreBody` split exists at `live-score.tsx:103`, consumed at `match-centre.tsx:90` and `summary-tab.tsx:58`. |
| P7 | **HOLDS** | `cricket/index.ts:68` exports `deriveCricketScorecard` + `ScorecardInput`; `__tests__/scorecard-ledger.ts` present (24.7K); `scorecard-types.ts` — `BattingLine.dismissal:21`, `BowlingLine.legalBalls:29`, `.runs:32`, `.wickets:33`. |
| P8 | **FALSE (absence is stale)** | `apps/web/src/server/public-site/__tests__/cricket-ledger.ts` **exists** (24.8K): `scriptLedger:209`, `summaryOnlyLedger:427`, `lineLedger:468`, `SUPER_OVER_SCRIPT:516`, `TIE_NO_SUPER_OVER:491`. Task 14 copies nothing. |
| P9 | **CONFIRMED false premise** | `PlayerStatsModel` `stats.ts:106` — fields are `metrics`, `derived?`, `awards?`, `folded?` only. **No floor/threshold/qualification, no leaderboard**, anywhere in `packages/engine/src/stats/`. Cricket keys (`cricket.ts:2602`, not `:2510`): `runs`, `sixes`, `wickets`, `fours`, `catches`, `stumpings`, `dismissals`, +10 `dismissals_<kind>`. Football (`football.ts:2642`): `goals`, `assists`, cards, penalties, shots. |
| P10 | **CHANGED** | `slideshow.tsx:122-129` — `sb.channel(\`division:${id}\`)` takes no second argument, so no `private: true`, no token anywhere in the file; it listens for **both** `state_changed` and `schedule_changed`. Publish is `scoring.ts:144-146`. `publishDivisionUpdate(divisionId, reason: "schedule"\|"publish"\|"start"\|"score")` (`realtime.ts:49-52`) emits `state_changed` **only** when `reason === "score"` (`:69`), else `schedule_changed`. |
| P11 | **MOVED + one FALSE** | Fixture status `schemas.ts:1195` (a field of `PublicFixture`, not a named export); `DivisionStatus` `:60`. Both unions verbatim as claimed; **no `postponed`, no `walkover`** anywhere in the file. **`bucketFixture` DOES NOT EXIST** — it is an export of `lib/matches-hub.ts`, which this plan creates. |
| P12 | **CHANGED — W1 falsified it** | `RouteSpec.response?` still `openapi.ts:27`; interface now `:21-32`. Public block `:196-203`. **`/public/fixtures/{id}` (`:201`) HAS `response: S.PublicFixtureSummary`** (added by `21b68b2fe`). The other six (`:197-200`, `:202-203`) still carry none. |
| P13 | **MOVED + too pessimistic** | `invalidatePublicCache` `scoring.ts:518-547`; deletes `pub:v1:fixture:${id}` `:534` and `pub:v1:div:${id}:*` `:536`, fires `fireDivisionRevalidate` `:537`. Callers: `scoring.ts:147`, `event-import.ts:470` only. Schedule writes go through **`afterScheduleWrite`** (`schedule.ts:97-105`; `moveFixture:2886` fires at `:3214`), which **does** drop `pub:v1:div:*` and revalidate — it only misses `pub:v1:fixture:{id}`. |
| P14 | **MOVED + CHANGED** | `recomputePlayerStats` `player-stats.ts:55-272` (callers `:437`, `:523`, `:718`). `(tx: Tx, divisionId: string) => { rows, throughSeq, hasModel }` — **no `orgId`**; callers wrap in `withTenant`. **NOT watermark-based**: `:66` selects all `score_events` for the division every call; `throughSeq` is a running count. |
| P15 | **MOVED + CHANGED** | `getPublicDivision` `data.ts:624-699`; `unstable_cache` `:645`, tags `:689`, `tz` coalesce `:679-685` — tags and tz HOLD. **Returns 9 keys, not 6**: `org, competition, division, stages, pools, fixtures, standings, entrants, tz` (the six are the inner cached callback's return, `:685`). `getPublicCompetition` `:421-433` — **selects no `config`**; the string `config` appears 0 times in the file. |
| P16 | **FALSE for the consumer** | `_hook-harness.tsx` exists: `renderIsland:169`, `walk:99`, `textOf:112`, `propsOf:96`. But `public-site/__tests__/live-score.test.tsx` **does not import it** and has no `stubFetch`/`stubInterval` — it is a pure `renderToStaticMarkup` test. The harness consumer is `match-centre/__tests__/use-live-fixture.test.ts:10` (file-local `mount()` `:28`). `stubFetch` lives in `live-score-data.test.ts:8`; **`stubInterval` exists nowhere**. |
| P17 | **CHANGED** | Public seed `mobile.spec.ts:348-560`. The generic-sport division (`:372`) still has entrants (`:379`) and **no fixtures** — but the same setup now seeds a real band-3 cricket fixture at `:519-556` via `seedRosteredFixture`, which creates its **own** competition/division (`helpers.ts:1733`), so it adds nothing to the generic one. `publicCricketFixturePath` set at `:559`. |
| P18 | **HOLDS + signature change** | `scoring-vocab.ts` — `decidedOutcomeText:1440`, `shootoutScoreFromDetail:1458`. **A fifth param `sportKey?: string` was added.** Fixture page import `:34`, `msgFor` wrapper `:41-42`, both called in `decidedLineFor` (`:62`, `:66`). `msgFor` at `messages-i18n.ts:24` as claimed. |
| P19 | **MOVED (pins swapped) + CHANGED** | `round-role-label.ts` — `roundRoleLabel:21`, `roundRoleFor:90` (the row has these reversed). `roundRoleFor(all, target, stageKind, extKey = null)` — `target` carries a **fifth field `conditional`**, and `stageKind`/`extKey` are not in the row at all. `LaneRoundFixture:59` declares only `round_no` and `lane`; `is_final`/`third_place` are on the inline `target` type. |
| P20 | **MOVED — worst drift; touches every e2e task** | `expectNoHorizontalScroll` `helpers.ts:49-107`; `screenshotAtWidths` `:259`; `DEFAULT_SHOT_WIDTHS` `:235` = **`[1280, 768, 320]`, three widths** (the seven widths are `mobile.spec.ts` projects, a different mechanism); `AxeBuilder` `mobile.spec.ts:1620`. `w0-spectator-capture.spec.ts` is deleted, but **`e2e/spectator-public.spec.ts` does not exist** — helpers live in **`e2e/spectator-public-helpers.ts`** (`postEvent:52`, `createPersons:103`, `playInnings:134`, `fixtureSides:227`, `putLineups:239`, `controlSet:472`), imported by `e2e/walkthrough/spectator-public.spec.ts` and `…-2.spec.ts`. **`setScheduledAt` does not exist** — zero matches across `apps/`, `packages/`, `scripts/`. |

---

### Task 1: Hub document schema and the pure matches-hub helpers

**Files:**
- Create: `apps/web/src/server/public-site/competition-hub-schema.ts`
- Create: `apps/web/src/lib/matches-hub.ts`
- Test: `apps/web/src/lib/__tests__/matches-hub.test.ts`

**Interfaces:**
- Consumes: `Msg`, `Side`, `Person`, `MatchCentreHeader` zod schemas from `@/server/public-site/match-centre-schema` (W1, P3).
- Produces: every zod schema + `…T` type below (used by Tasks 2–16), and from `lib/matches-hub.ts`: `MatchBucket`, `bucketFixture(status)`, `defaultMatchesFilter(counts)`, `dayKeyInZone(iso, tz)`, `groupByDay(items)`, `sortHubMatches(items)`, `HubTabId`, `deriveHubTabs(counts)`, `LandingStatus`, `landingStatus(args)`.

- [ ] **Step 1: Write the schema**

`apps/web/src/server/public-site/competition-hub-schema.ts`:

```ts
// Spectator surface W2 — the competition-hub document. ONE document feeds the
// competition page's server render, the poll endpoint, the division page's
// slice and every tab; every number is formatted and every name resolved
// BEFORE it is put here, so the client only ever renders (design §W2, R3/R5).
import { z } from "zod";
import { Msg, Side, Person, MatchCentreHeader } from "./match-centre-schema";

export const MatchBucketSchema = z.enum(["live", "upcoming", "completed"]);
export const CompetitionHubTabId = z.enum(["overview", "matches", "table", "stats", "teams", "gallery", "info"]);

export const HubDivision = z.object({
  id: z.string(), slug: z.string(), name: z.string(), sportKey: z.string(), sportName: z.string().nullable(),
  status: z.string(), tz: z.string(), entrantCount: z.number(),
  formatLine: Msg.nullable(),         // describeFormat(cfg) — null falls back to variantKey
  variantKey: z.string(),
  href: z.string(),
});

export const HubMatch = z.object({
  fixtureId: z.string(), divisionId: z.string(), divisionSlug: z.string(), divisionName: z.string(), sportKey: z.string(),
  stageName: z.string(), roundNo: z.number(), roundLabel: z.string().nullable(),   // roundRoleLabel — pre-resolved, org locale
  bucket: MatchBucketSchema,
  tz: z.string(), scheduledAt: z.string().nullable(),          // ISO; day grouping happens in `tz`
  venueName: z.string().nullable(), courtName: z.string().nullable(),
  href: z.string(),
  header: MatchCentreHeader,                                    // W1's shape: sides, scoreLines, subLines, status, statusLine, updatedAt
  winnerIndex: z.union([z.literal(0), z.literal(1)]).nullable(),
  resultLine: z.string().nullable(),                           // decidedOutcomeText — pre-resolved
});

export const TableColumn = z.object({ key: z.string(), abbr: z.string(), title: z.string(), compact: z.boolean() });
export const TableRow = z.object({
  rank: z.number().nullable(), entrantId: z.string(), name: z.string(), badgeUrl: z.string().nullable(),
  cells: z.array(z.string()), tieBreakText: z.string().nullable(), champion: z.boolean(),
});
export const TableView = z.object({
  id: z.string(), divisionId: z.string(), divisionSlug: z.string(), divisionName: z.string(),
  caption: z.string(), columns: z.array(TableColumn), rows: z.array(TableRow), updatedAt: z.string(), fullHref: z.string(),
});

export const LeaderRow = z.object({
  person: Person, personHref: z.string().nullable(), entrantName: z.string().nullable(), badgeUrl: z.string().nullable(), value: z.string(),
});
export const LeaderBoard = z.object({
  divisionId: z.string(), divisionSlug: z.string(), divisionName: z.string(), sportKey: z.string(),
  key: z.string(), label: z.string(), rows: z.array(LeaderRow),
});

export const TeamCard = z.object({
  entrantId: z.string(), divisionId: z.string(), divisionSlug: z.string(), divisionName: z.string(),
  name: z.string(), badgeUrl: z.string().nullable(), colour: z.string().nullable(), seed: z.number().nullable(), href: z.string(),
});

export const HubInfo = z.object({
  startsOn: z.string().nullable(), endsOn: z.string().nullable(),
  venues: z.array(z.string()),
  registrationOpen: z.boolean(), registerHref: z.string(),
  calendars: z.array(z.object({ divisionName: z.string(), href: z.string() })),
  presentHref: z.string(),
});

export const CompetitionHubDoc = z.object({
  competitionId: z.string(), orgSlug: z.string(), competitionSlug: z.string(),
  name: z.string(), orgName: z.string(), branded: z.boolean(), realtime: z.boolean(), locale: z.string(),
  generatedAt: z.string(),
  divisions: z.array(HubDivision), matches: z.array(HubMatch), tables: z.array(TableView),
  leaders: z.array(LeaderBoard), teams: z.array(TeamCard), info: HubInfo,
  tabs: z.array(CompetitionHubTabId).min(1),
});

export type CompetitionHubDocT = z.infer<typeof CompetitionHubDoc>;
export type CompetitionHubTabIdT = z.infer<typeof CompetitionHubTabId>;
export type HubDivisionT = z.infer<typeof HubDivision>;
export type HubMatchT = z.infer<typeof HubMatch>;
export type TableViewT = z.infer<typeof TableView>;
export type TableRowT = z.infer<typeof TableRow>;
export type TableColumnT = z.infer<typeof TableColumn>;
export type LeaderBoardT = z.infer<typeof LeaderBoard>;
export type LeaderRowT = z.infer<typeof LeaderRow>;
export type TeamCardT = z.infer<typeof TeamCard>;
export type HubInfoT = z.infer<typeof HubInfo>;
export { Side, Person, Msg };
```

- [ ] **Step 2: Write the failing tests — empty case FIRST, then the ladders with order-differential cases, then the DST day key**

`apps/web/src/lib/__tests__/matches-hub.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  bucketFixture, defaultMatchesFilter, dayKeyInZone, groupByDay, sortHubMatches, deriveHubTabs, landingStatus,
} from "@/lib/matches-hub";

// FixtureStatus enum, server/api-v1/schemas.ts:1034 — typed here ON PURPOSE as the
// full list so a new status added to the schema without a bucket reds this file.
const STATUSES = ["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"] as const;

describe("defaultMatchesFilter — the filter ladder", () => {
  it("EMPTY: no matches at all → null (nothing is selected, the tab renders its empty state)", () => {
    expect(defaultMatchesFilter({ live: 0, upcoming: 0, completed: 0 })).toBeNull();
  });
  it("live wins over upcoming and completed (order-differential: a set with all three picks live)", () => {
    expect(defaultMatchesFilter({ live: 1, upcoming: 4, completed: 9 })).toBe("live");
  });
  it("upcoming wins over completed when nothing is live (order-differential: more completed than upcoming)", () => {
    expect(defaultMatchesFilter({ live: 0, upcoming: 1, completed: 9 })).toBe("upcoming");
  });
  it("completed only → completed", () => {
    expect(defaultMatchesFilter({ live: 0, upcoming: 0, completed: 3 })).toBe("completed");
  });
});

describe("bucketFixture — every status the schema declares has a bucket", () => {
  it("in_play is the ONLY live status; terminal statuses are completed; the rest are upcoming", () => {
    const buckets = Object.fromEntries(STATUSES.map((s) => [s, bucketFixture(s)]));
    expect(buckets).toEqual({
      scheduled: "upcoming", in_play: "live", decided: "completed", finalized: "completed",
      abandoned: "completed", forfeited: "completed", cancelled: "completed",
    });
    expect(bucketFixture("postponed")).toBe("upcoming"); // unknown/non-terminal → still listed, never dropped
  });
});

describe("dayKeyInZone — the venue day across a DST boundary", () => {
  // Europe/London leaves BST at 01:00 UTC on 2026-10-25.
  it("23:30Z on the 24th is 00:30 BST on the 25th; 23:30Z on the 25th is 23:30 GMT on the 25th — SAME venue day", () => {
    expect(dayKeyInZone("2026-10-24T23:30:00.000Z", "Europe/London")).toBe("2026-10-25");
    expect(dayKeyInZone("2026-10-25T23:30:00.000Z", "Europe/London")).toBe("2026-10-25");
  });
  it("positive pair: the same two instants fall on DIFFERENT days in UTC", () => {
    expect(dayKeyInZone("2026-10-24T23:30:00.000Z", "UTC")).toBe("2026-10-24");
    expect(dayKeyInZone("2026-10-25T23:30:00.000Z", "UTC")).toBe("2026-10-25");
  });
  it("null in → null out; an unknown zone falls back to UTC rather than throwing", () => {
    expect(dayKeyInZone(null, "Europe/London")).toBeNull();
    expect(dayKeyInZone("2026-10-24T23:30:00.000Z", "Mars/Olympus")).toBe("2026-10-24");
  });
});

describe("groupByDay + sortHubMatches", () => {
  const m = (id: string, bucket: "live" | "upcoming" | "completed", at: string | null, tz = "Europe/London") =>
    ({ fixtureId: id, bucket, scheduledAt: at, tz });
  it("EMPTY → []", () => expect(groupByDay([])).toEqual([]));
  it("groups by the venue day, unscheduled LAST under the 'unscheduled' key", () => {
    const groups = groupByDay([m("a", "upcoming", "2026-09-06T13:00:00Z"), m("b", "upcoming", null), m("c", "upcoming", "2026-09-06T15:00:00Z")]);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-06", "unscheduled"]);
    expect(groups[0]!.items.map((x) => x.fixtureId)).toEqual(["a", "c"]);
  });
  it("live first, then upcoming by time ascending (unscheduled last), then completed most-recent first", () => {
    const sorted = sortHubMatches([
      m("done-old", "completed", "2026-09-01T10:00:00Z"), m("up-late", "upcoming", "2026-09-08T10:00:00Z"),
      m("live", "live", "2026-09-05T10:00:00Z"), m("up-tbd", "upcoming", null),
      m("up-soon", "upcoming", "2026-09-06T10:00:00Z"), m("done-new", "completed", "2026-09-04T10:00:00Z"),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual(["live", "up-soon", "up-late", "up-tbd", "done-new", "done-old"]);
  });
});

describe("deriveHubTabs — tabs by PRESENCE, gallery never (W4's slot)", () => {
  it("EMPTY: nothing → overview + info only", () => {
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 0, teams: 0 })).toEqual(["overview", "info"]);
  });
  it("full: every tab in the spec's order, gallery absent", () => {
    expect(deriveHubTabs({ matches: 3, tables: 1, leaderRows: 2, teams: 4 })).toEqual(["overview", "matches", "table", "stats", "teams", "info"]);
  });
  it("a board list with zero rows does not earn a Stats tab", () => {
    expect(deriveHubTabs({ matches: 1, tables: 0, leaderRows: 0, teams: 2 })).toEqual(["overview", "matches", "teams", "info"]);
  });
});

describe("landingStatus — the Overview status line ladder (empty → live → next → finished → dates)", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const base = { divisions: 2, startsOn: "2026-09-01", endsOn: "2026-10-31", now };
  const m = (bucket: "live" | "upcoming" | "completed", at: string | null) => ({ bucket, scheduledAt: at, tz: "Europe/London" });
  it("EMPTY: a competition with no divisions is 'empty', never finished (competition-desk amendment 3)", () => {
    expect(landingStatus({ ...base, divisions: 0, matches: [] })).toEqual({ kind: "empty" });
  });
  it("live outranks a nearer upcoming fixture (order-differential)", () => {
    expect(landingStatus({ ...base, matches: [m("upcoming", "2026-09-05T12:30:00Z"), m("live", "2026-09-05T11:00:00Z")] })).toEqual({ kind: "live", n: 1 });
  });
  it("next = the EARLIEST upcoming fixture still ahead of now, carrying its zone", () => {
    expect(landingStatus({ ...base, matches: [m("upcoming", "2026-09-07T13:00:00Z"), m("upcoming", "2026-09-06T13:00:00Z"), m("upcoming", "2026-09-05T09:00:00Z")] }))
      .toEqual({ kind: "next", at: "2026-09-06T13:00:00Z", tz: "Europe/London" });
  });
  it("all played → finished, even though the competition's end date is still ahead (order-differential vs dates)", () => {
    expect(landingStatus({ ...base, matches: [m("completed", "2026-09-04T10:00:00Z")] })).toEqual({ kind: "finished" });
  });
  it("divisions but no fixtures yet → dates", () => {
    expect(landingStatus({ ...base, matches: [] })).toEqual({ kind: "dates", startsOn: "2026-09-01", endsOn: "2026-10-31" });
  });
});
```

- [ ] **Step 3: Run to verify the suite fails to collect** (module missing)

Run: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && pnpm exec vitest run src/lib/__tests__/matches-hub.test.ts --reporter=json --outputFile=/tmp/spx-w2-t1.json; node -e "const r=require('/tmp/spx-w2-t1.json');console.log(r.numTotalTests,r.numFailedTests,r.numFailedTestSuites)"`
Expected: `0 0 1` (collection failure) — NOT a pass.

- [ ] **Step 4: Implement `lib/matches-hub.ts`**

```ts
// Spectator surface W2 — pure, client-safe helpers for the Matches hub and the
// landing status line. No server imports (rides into client components).
export type MatchBucket = "live" | "upcoming" | "completed";
/** FixtureStatus (server/api-v1/schemas.ts:1034). Anything not in_play and not
 *  terminal is UPCOMING — an unknown status is listed, never dropped. */
const TERMINAL = new Set(["decided", "finalized", "abandoned", "forfeited", "cancelled"]);
export function bucketFixture(status: string): MatchBucket {
  if (status === "in_play") return "live";
  return TERMINAL.has(status) ? "completed" : "upcoming";
}
/** EMPTY CASE FIRST (R9): nothing at all → null. Then live → upcoming → completed. */
export function defaultMatchesFilter(c: Record<MatchBucket, number>): MatchBucket | null {
  if (c.live + c.upcoming + c.completed === 0) return null;
  if (c.live > 0) return "live";
  if (c.upcoming > 0) return "upcoming";
  return "completed";
}
/** Venue-local calendar date (YYYY-MM-DD) — the same en-CA trick schedule.tsx:46-53 uses. */
export function dayKeyInZone(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); }
  catch { return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d); }
}
export const UNSCHEDULED_KEY = "unscheduled";
export interface DayGroup<T> { key: string; tz: string; items: T[] }
export function groupByDay<T extends { scheduledAt: string | null; tz: string }>(items: readonly T[]): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  for (const it of items) {
    const key = dayKeyInZone(it.scheduledAt, it.tz) ?? UNSCHEDULED_KEY;
    const g = groups.get(key) ?? { key, tz: it.tz, items: [] };
    g.items.push(it); groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) =>
    a.key === UNSCHEDULED_KEY ? 1 : b.key === UNSCHEDULED_KEY ? -1 : a.key.localeCompare(b.key));
}
const RANK: Record<MatchBucket, number> = { live: 0, upcoming: 1, completed: 2 };
export function sortHubMatches<T extends { bucket: MatchBucket; scheduledAt: string | null }>(items: readonly T[]): T[] {
  const ms = (x: T) => (x.scheduledAt ? Date.parse(x.scheduledAt) : Number.POSITIVE_INFINITY);
  return [...items].sort((a, b) => {
    if (RANK[a.bucket] !== RANK[b.bucket]) return RANK[a.bucket] - RANK[b.bucket];
    return a.bucket === "completed" ? ms(b) - ms(a) : ms(a) - ms(b);   // results newest first; the rest by time, unscheduled last
  });
}
export type HubTabId = "overview" | "matches" | "table" | "stats" | "teams" | "gallery" | "info";
/** Tabs by PRESENCE (R4). Gallery is W4's reserved slot: never emitted here. */
export function deriveHubTabs(c: { matches: number; tables: number; leaderRows: number; teams: number }): HubTabId[] {
  return [
    "overview",
    ...(c.matches > 0 ? (["matches"] as const) : []),
    ...(c.tables > 0 ? (["table"] as const) : []),
    ...(c.leaderRows > 0 ? (["stats"] as const) : []),
    ...(c.teams > 0 ? (["teams"] as const) : []),
    "info",
  ];
}
export type LandingStatus =
  | { kind: "empty" } | { kind: "live"; n: number } | { kind: "next"; at: string; tz: string }
  | { kind: "finished" } | { kind: "dates"; startsOn: string | null; endsOn: string | null };
/** ORDER IS THE RULE (competition-desk _RULES.md): empty → live → next → finished → dates. */
export function landingStatus(a: {
  matches: readonly { bucket: MatchBucket; scheduledAt: string | null; tz: string }[];
  divisions: number; startsOn: string | null; endsOn: string | null; now: Date;
}): LandingStatus {
  if (a.divisions === 0) return { kind: "empty" };
  const live = a.matches.filter((m) => m.bucket === "live").length;
  if (live > 0) return { kind: "live", n: live };
  const nowMs = a.now.getTime();
  const next = a.matches
    .filter((m) => m.bucket === "upcoming" && m.scheduledAt !== null && Date.parse(m.scheduledAt) >= nowMs)
    .sort((x, y) => Date.parse(x.scheduledAt!) - Date.parse(y.scheduledAt!))[0];
  if (next) return { kind: "next", at: next.scheduledAt!, tz: next.tz };
  if (a.matches.length > 0 && a.matches.every((m) => m.bucket === "completed")) return { kind: "finished" };
  return { kind: "dates", startsOn: a.startsOn, endsOn: a.endsOn };
}
```

- [ ] **Step 5: Run — expect green**: same command; expected `numTotalTests` 17, `numFailedTests` 0. Then apply and RECORD two mutants in a "Mutants killed" comment at the top of the test file: (a) swap the `live`/`upcoming` rungs in `defaultMatchesFilter` → the first order-differential case reds; (b) make `landingStatus` test `finished` before `live` → the live-outranks case reds. Restore.

- [ ] **Step 6: Commit** — `/usr/bin/git add apps/web/src/server/public-site/competition-hub-schema.ts apps/web/src/lib/matches-hub.ts apps/web/src/lib/__tests__/matches-hub.test.ts` then `/usr/bin/git commit -F <message file>` — "web(public-site): competition-hub document schema and the pure matches-hub ladders (empty case first)" + the two trailers.

---
### Task 2: Standings view builder (server) and the phone-composed `StandingsTableView` (client-safe)

**Files:**
- Create: `apps/web/src/server/public-site/standings-view.ts`
- Create: `apps/web/src/components/public-site/standings-table-view.tsx`
- Test: `apps/web/src/server/public-site/__tests__/standings-view.test.ts`, `apps/web/src/components/public-site/__tests__/standings-table-view.test.tsx`
- NOT touched: `components/public-site/standings-table.tsx` (the console at `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:649` and the embed at `app/embed/divisions/[id]/[widget]/page.tsx:103` keep it).

**Interfaces:**
- Consumes: `standingsColumns(metricSpecs, cascade, rows, DERIVED_METRICS)` and `formatMetric` (`@/lib/public-site:226-261`), `DERIVED_METRICS`, `derivedMetricText`, `tieBreakLabel`, `StandingsRow` (`@seazn/engine/competition`), `EntityLogo` (`@/components/ui/entity-logo`), `TableView`/`TableViewT` (Task 1).
- Produces:
  ```ts
  export interface TableViewInput {
    id: string; division: { id: string; slug: string; name: string }; caption: string; fullHref: string;
    rows: StandingsRow[]; metricSpecs: MetricSpecLike[]; cascade: readonly string[];
    entrantNames: Record<string, string>; entrantLogos: Record<string, string | null>;
    championId: string | null; updatedAt: string;
    msg: (key: TKey, vars?: Record<string, string | number>) => string;   // t(dict, …) bound by the caller
  }
  export const COMPACT_KEYS: ReadonlySet<string>;   // played, won, lost, points — the 320 column set
  export function buildTableView(input: TableViewInput): TableViewT;
  export function StandingsTableView(props: { view: TableViewT; dict: PublicDict; testid: string; preview?: number; showFullLink?: boolean }): JSX.Element;  // "use client"
  ```

- [ ] **Step 1: Failing builder tests**

```ts
// apps/web/src/server/public-site/__tests__/standings-view.test.ts
import { describe, expect, it } from "vitest";
import { buildTableView, COMPACT_KEYS } from "../standings-view";
import type { StandingsRow } from "@seazn/engine/competition";

const msg = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? ":" + JSON.stringify(vars) : ""}`;
const row = (entrantId: string, over: Partial<StandingsRow>): StandingsRow =>
  ({ entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, ...over });
const base = {
  id: "div-s1-overall", division: { id: "d1", slug: "div", name: "Div" }, caption: "League", fullHref: "/shared/o/c/div?tab=standings",
  metricSpecs: [{ key: "gf", label: "GF" }, { key: "ga", label: "GA" }, { key: "gd", label: "GD" }, { key: "cards", label: "Cards", display: false }],
  cascade: ["points", "gd"], entrantNames: { a: "Alpha", b: "Beta" }, entrantLogos: { a: "https://x/a.png", b: null },
  championId: null, updatedAt: "2026-09-05T10:00:00Z", msg,
};

describe("buildTableView", () => {
  it("EMPTY rows → the structural columns still exist, rows are [] (the tab then states its empty case)", () => {
    const v = buildTableView({ ...base, rows: [] });
    expect(v.rows).toEqual([]);
    expect(v.columns.map((c) => c.key)).toEqual(["played", "won", "lost", "points"]);   // no draws → no D; no row carries gf/ga/gd → hidden
  });
  it("compact columns are exactly P W L Pts; metrics and the cascade's derived columns are the long tail", () => {
    const rows = [row("a", { played: 2, won: 2, points: 6, metrics: { gf: 5, ga: 1, gd: 4 }, rank: 1 }), row("b", { played: 2, lost: 2, metrics: { gf: 1, ga: 5, gd: -4 }, rank: 2 })];
    const v = buildTableView({ ...base, rows });
    expect(v.columns.map((c) => [c.key, c.compact])).toEqual([["played", true], ["won", true], ["lost", true], ["gf", false], ["ga", false], ["gd", false], ["points", true]]);
    expect(v.columns.every((c) => c.compact === COMPACT_KEYS.has(c.key))).toBe(true);
    // titles: structural columns localised via table.col.<key>; metric labels stay the engine's notation
    expect(v.columns[0]!.title).toBe("table.col.played");
    expect(v.columns[3]!.abbr).toBe("GF");
  });
  it("rows come in rank order with formatted cells, badge urls, the champion flag and a tie-break sentence", () => {
    const rows = [row("b", { played: 1, points: 3, metrics: { gf: 1, ga: 0, gd: 1 }, rank: 2, tieBreak: { key: "gd", with: ["a"] } }), row("a", { played: 1, points: 3, metrics: { gf: 2, ga: 0, gd: 2 }, rank: 1 })];
    const v = buildTableView({ ...base, rows, championId: "a" });
    expect(v.rows.map((r) => r.entrantId)).toEqual(["a", "b"]);
    expect(v.rows[0]).toMatchObject({ name: "Alpha", badgeUrl: "https://x/a.png", champion: true, tieBreakText: null });
    expect(v.rows[0]!.cells).toEqual(["1", "0", "0", "2", "0", "2", "3"]);
    expect(v.rows[1]!.tieBreakText).toBe('table.tieBreak:{"with":"Alpha","rule":"Goal difference"}');   // tieBreakLabel("gd") — pin the engine's exact label
  });
  it("D appears only when some row has a draw (positive pair for the empty case above)", () => {
    const v = buildTableView({ ...base, rows: [row("a", { played: 1, drawn: 1, points: 1 })] });
    expect(v.columns.map((c) => c.key)).toContain("drawn");
  });
});
```

- [ ] **Step 2: Run — collection failure** (`cd <worktree>/apps/web && pnpm exec vitest run src/server/public-site/__tests__/standings-view.test.ts --reporter=json --outputFile=/tmp/spx-w2-t2.json` then read `numFailedTestSuites`).

- [ ] **Step 3: Implement `standings-view.ts`**

```ts
import "server-only";
import { DERIVED_METRICS, derivedMetricText, tieBreakLabel, type StandingsRow } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { standingsColumns, formatMetric, type MetricSpecLike } from "@/lib/public-site";
import type { TKey } from "@/lib/i18n-runtime";
import type { TableViewT } from "./competition-hub-schema";

export const COMPACT_KEYS: ReadonlySet<string> = new Set(["played", "won", "lost", "points"]);
const STRUCTURAL = new Set(["played", "won", "drawn", "lost", "points"]);

export interface TableViewInput { /* as in Interfaces */ }

export function buildTableView(input: TableViewInput): TableViewT {
  const columns = standingsColumns(input.metricSpecs, input.cascade, input.rows, DERIVED_METRICS);
  const ranked = [...input.rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const name = (id: string) => input.entrantNames[id] ?? id;
  return {
    id: input.id, divisionId: input.division.id, divisionSlug: input.division.slug, divisionName: input.division.name,
    caption: input.caption, fullHref: input.fullHref, updatedAt: input.updatedAt,
    columns: columns.map((c) => ({
      key: c.key, abbr: c.label,
      title: STRUCTURAL.has(c.key) ? input.msg(`table.col.${c.key}`) : c.label,   // notation keeps the engine label as its title too
      compact: COMPACT_KEYS.has(c.key),
    })),
    rows: ranked.map((r) => ({
      rank: r.rank ?? null, entrantId: r.entrantId, name: name(r.entrantId), badgeUrl: input.entrantLogos[r.entrantId] ?? null,
      cells: columns.map((c) =>
        c.kind === "derived" ? (derivedMetricText(r, c.key as TiebreakerKey) ?? "—")
        : c.kind === "structural" ? formatMetric(r[c.key as "played" | "won" | "drawn" | "lost" | "points"])
        : formatMetric(r.metrics[c.key], c.decimals)),                       // byte-for-byte standings-table.tsx:132-136
      tieBreakText: r.tieBreak
        ? input.msg("table.tieBreak", { with: r.tieBreak.with.map(name).join(", "), rule: tieBreakLabel(r.tieBreak.key) })
        : null,
      champion: input.championId === r.entrantId,
    })),
  };
}
```

- [ ] **Step 4: Run — green.** Mutant (a): drop `points` from `COMPACT_KEYS` → the compact-set assertion reds. Record it.

- [ ] **Step 5: Failing component tests** (static markup, no DOM):

```tsx
// apps/web/src/components/public-site/__tests__/standings-table-view.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StandingsTableView } from "../standings-table-view";
import en from "@/dictionaries/en/public.json";
import type { TableViewT } from "@/server/public-site/competition-hub-schema";

const view: TableViewT = {
  id: "t1", divisionId: "d1", divisionSlug: "div", divisionName: "Div", caption: "League", fullHref: "/shared/o/c/div?tab=standings", updatedAt: "2026-09-05T10:00:00Z",
  columns: [
    { key: "played", abbr: "P", title: "Played", compact: true }, { key: "won", abbr: "W", title: "Won", compact: true },
    { key: "lost", abbr: "L", title: "Lost", compact: true }, { key: "gd", abbr: "GD", title: "GD", compact: false },
    { key: "points", abbr: "Pts", title: "Points", compact: true },
  ],
  rows: [
    { rank: 1, entrantId: "a", name: "Bartholomew Ravindranath-Oyelaran-Whitaker XI", badgeUrl: null, cells: ["2", "2", "0", "4", "6"], tieBreakText: null, champion: true },
    { rank: 2, entrantId: "b", name: "Beta", badgeUrl: "https://x/b.png", cells: ["2", "0", "2", "-4", "0"], tieBreakText: "Level with Alpha — separated on GD", champion: false },
  ],
};
const html = (over: Partial<Parameters<typeof StandingsTableView>[0]> = {}) =>
  renderToStaticMarkup(<StandingsTableView view={view} dict={en} testid="mh-table-t1" {...over} />);

describe("StandingsTableView — phone composition", () => {
  it("EMPTY rows → the empty-case copy and NO table element", () => {
    const h = renderToStaticMarkup(<StandingsTableView view={{ ...view, rows: [] }} dict={en} testid="mh-table-t1" />);
    expect(h).toContain(`data-testid="mh-table-t1-empty"`);
    expect(h).not.toContain("<table");
  });
  it("long-tail columns carry max-md:hidden on BOTH th and td; compact columns never do (anchor on the leading space + closing quote)", () => {
    const h = html();
    expect(h).toMatch(/<th[^>]*data-col="gd"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(h).toMatch(/<td[^>]*data-col="gd"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(h).not.toMatch(/<th[^>]*data-col="points"[^>]*max-md:hidden/);
  });
  it("the phone-only disclosure exists once per table, is md:hidden and announces its state; the scroll region is focusable and named", () => {
    const h = html();
    expect(h.match(/data-testid="mh-table-t1-more"/g)?.length).toBe(1);
    expect(h).toMatch(/data-testid="mh-table-t1-more"[^>]*aria-expanded="false"/);
    expect(h).toMatch(/data-testid="mh-table-t1-more"[^>]*class="[^"]*\smd:hidden"/);
    expect(h).toMatch(/role="region"[^>]*tabindex="0"[^>]*aria-label="League"/);
  });
  it("rows: rank chip, crest (img when badgeUrl, initials otherwise), truncating name cell, tabular cells, champion marker, tie-break in a title", () => {
    const h = html();
    expect(h).toContain(`data-testid="mh-table-row-a"`);
    expect(h).toContain('src="https://x/b.png"');
    expect(h).toContain(">BR<");                                     // initials for the badge-less row… (EntityLogo initials: first + last word)
    expect(h).toMatch(/class="[^"]*truncate[^"]*"[^>]*>Bartholomew Ravindranath-Oyelaran-Whitaker XI</);
    expect(h).toMatch(/data-testid="mh-table-row-a"[^>]*data-champion="true"/);
    expect(h).toContain('title="Level with Alpha — separated on GD"');
  });
  it("preview={1} renders one row and the full-division link; showFullLink=false hides it (positive pair)", () => {
    expect(html({ preview: 1 }).match(/data-testid="mh-table-row-/g)?.length).toBe(1);
    expect(html({ preview: 1 })).toContain(`data-testid="mh-table-t1-full"`);
    expect(html({ showFullLink: false })).not.toContain(`data-testid="mh-table-t1-full"`);
  });
});
```

- [ ] **Step 6: Run — failures.** **Step 7: Implement `standings-table-view.tsx`** (`"use client"`; `useState(false)` for `expanded`):

```tsx
export function StandingsTableView({ view, dict, testid, preview, showFullLink = true }: Props) {
  const [expanded, setExpanded] = useState(false);
  const rows = preview ? view.rows.slice(0, preview) : view.rows;
  const colCls = (c: TableColumnT, base: string) => `${base}${c.compact || expanded ? "" : " max-md:hidden"}`;
  if (view.rows.length === 0) return <p data-testid={`${testid}-empty`} className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">{t(dict, "table.empty")}</p>;
  return (
    <section data-testid={testid} className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate font-display text-lg font-semibold text-ink">{view.caption}</h3>
        {showFullLink ? <Link data-testid={`${testid}-full`} href={view.fullHref} className="shrink-0 text-xs font-medium uppercase tracking-wide text-accent-strong hover:underline">{t(dict, "table.fullDivision")}</Link> : null}
      </div>
      {/* Unconditional tabindex/role/name: it scrolls only once expanded on a phone, but tabindex cannot follow a media query (AGENTS.md #23). */}
      <div role="region" tabIndex={0} aria-label={view.caption} className={`rounded-xl border border-zinc-200/80 bg-surface shadow-sm ${expanded ? "overflow-x-auto" : "overflow-hidden"}`}>
        <table className="w-full table-fixed text-sm tabular-nums">
          <caption className="sr-only">{view.caption}</caption>
          <thead><tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-ink-muted">
            <th scope="col" className="w-8 py-2 pl-3 text-left font-semibold"><span className="sr-only">{t(dict, "table.col.rank")}</span>#</th>
            <th scope="col" className="py-2 pr-2 text-left font-semibold">{t(dict, "table.team")}</th>
            {view.columns.map((c) => <th key={c.key} scope="col" data-col={c.key} title={c.title} className={colCls(c, `${c.key === "points" ? "w-10" : "w-8"} px-0.5 py-2 text-right font-semibold`)}>{c.abbr}</th>)}
          </tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.entrantId} data-testid={`mh-table-row-${r.entrantId}`} data-champion={r.champion ? "true" : undefined} className={`border-b border-zinc-100 last:border-0 ${r.rank === 1 ? "bg-amber-50/60" : ""}`}>
              <td className="py-2 pl-3 tabular-nums">{rankChip(r.rank)}{r.tieBreakText ? <span title={r.tieBreakText} className="text-[10px] text-accent">*</span> : null}</td>
              <th scope="row" className="py-2 pr-2 text-left font-medium text-ink"><span className="flex min-w-0 items-center gap-2"><EntityLogo src={r.badgeUrl} name={r.name} size={20} /><span className="block min-w-0 truncate" title={r.name}>{r.name}</span></span></th>
              {view.columns.map((c, i) => <td key={c.key} data-col={c.key} className={colCls(c, `px-0.5 py-2 text-right ${c.key === "points" ? "font-display text-base font-bold text-accent-strong" : "text-zinc-600"}`)}>{r.cells[i]}</td>)}
            </tr>))}</tbody>
        </table>
      </div>
      {view.columns.some((c) => !c.compact) ? (
        <button type="button" data-testid={`${testid}-more`} aria-expanded={expanded} onClick={() => setExpanded((x) => !x)} className="min-h-11 w-full rounded-lg border border-zinc-200/80 bg-surface px-3 text-sm font-medium text-accent-strong md:hidden">
          {t(dict, expanded ? "table.fewer" : "table.more")}
        </button>) : null}
    </section>);
}
```
`rankChip` = the medal classes copied from `standings-table.tsx:41-55` (`1: bg-amber-300 text-amber-950`, `2: bg-slate-300 text-slate-900`, `3: bg-orange-300 text-orange-950`). The name column has NO width utility; `table-fixed` + explicit `w-8`/`w-10` numeric columns give it the remainder (W1's stat-table lesson, `stat-table.tsx:11-39`).

- [ ] **Step 8: Run — green.** Mutant (b): remove `max-md:hidden` from the `td` branch → the th/td test reds. **Step 9: Commit** — "web(public-site): standings view builder and the phone-composed StandingsTableView (compact P W L Pts, long tail behind a phone disclosure)".

---
### Task 3: Leaders — the pure board builder and the consent-gated snapshot reader

**Files:**
- Create: `apps/web/src/server/public-site/leaders.ts`
- Create: `apps/web/src/server/public-site/public-leaders.ts`
- Test: `apps/web/src/server/public-site/__tests__/leaders.test.ts` (pure), `apps/web/src/server/public-site/__tests__/public-leaders.test.ts` (DB-backed — `consent.test.ts:1-50` pattern: `vi.mock("next/cache")` passthrough, skips without `DATABASE_URL`)

**Interfaces:**
- Consumes: `PlayerStatsModel` (`@seazn/engine/stats`), `resolveLatestModule` (`@/server/engine-db`), `resolvePersonDisplayName` (`@/lib/name-display:72`), `resolveEntrantBadge` (`@/lib/entrant-badge:8`), `player_stat_snapshots` (`db/migration/jul3/V248__player_stats.sql:6`), `public_players_v` (`V307:28-40` — only persons with `public_name` consent), `LeaderBoard`/`LeaderRow` (Task 1).
- Produces:
  ```ts
  export interface LeaderSpec { key: string; labelKey: TKey | null }        // null → the module's own declared label
  export const LEADER_SPECS: Readonly<Record<string, readonly LeaderSpec[]>>;  // cricket, football, hockey, icehockey — see P9
  export const LEADER_LIMIT = 5;
  export interface LeaderInputRow { divisionId: string; personId: string; name: string; masked: boolean; publicProfile: boolean; entrantName: string | null; badgeUrl: string | null; stats: Record<string, number> }
  export interface LeaderDivision { id: string; slug: string; name: string; sportKey: string; moduleVersion: string }
  export function declaredStatKeys(model: PlayerStatsModel | undefined): Set<string>;    // metrics ∪ derived ∪ folded.keys ∪ awards (+"_awards")
  export function specsFor(sportKey: string, model: PlayerStatsModel | undefined): LeaderSpec[];  // LEADER_SPECS[sport] ?? first two declared metrics
  export function buildLeaderBoards(args: { divisions: LeaderDivision[]; rows: LeaderInputRow[]; modelFor: (d: LeaderDivision) => PlayerStatsModel | undefined; label: (spec: LeaderSpec, model: PlayerStatsModel | undefined) => string; personHref: (personId: string) => string; limit?: number }): LeaderBoardT[];
  export async function readLeaderRows(sql: Sql, divisions: { id: string; orgId: string; youth?: boolean; player_name_display?: string | null }[]): Promise<LeaderInputRow[]>;
  ```

- [ ] **Step 1: Failing pure tests**

```ts
// apps/web/src/server/public-site/__tests__/leaders.test.ts
import { describe, expect, it } from "vitest";
import { registry } from "@seazn/engine/sport";            // pin the exact registry import from server/engine-db/registry.ts:6-8
import { registerBuiltins } from "@seazn/engine/sports";
import { LEADER_SPECS, buildLeaderBoards, declaredStatKeys, specsFor } from "../leaders";
import { resolveLatestModule } from "@/server/engine-db";

registerBuiltins(registry);
const cricket = { id: "d1", slug: "t8", name: "Men's T8", sportKey: "cricket", moduleVersion: resolveLatestModule("cricket").version };
const row = (personId: string, stats: Record<string, number>, over = {}) =>
  ({ divisionId: "d1", personId, name: personId.toUpperCase(), masked: false, publicProfile: true, entrantName: "Blazers", badgeUrl: null, stats, ...over });
const args = (rows: ReturnType<typeof row>[]) => ({
  divisions: [cricket], rows, modelFor: (d: typeof cricket) => resolveLatestModule(d.sportKey).playerStats,
  label: (s: { key: string; labelKey: string | null }) => s.labelKey ?? s.key, personHref: (id: string) => `/shared/o/c/players/${id}`,
});

describe("LEADER_SPECS are DECLARED keys — a typo cannot ship (guard against every registered module)", () => {
  for (const [sportKey, specs] of Object.entries(LEADER_SPECS)) {
    it(`${sportKey}: every spec key is declared by the module's playerStats`, () => {
      const declared = declaredStatKeys(resolveLatestModule(sportKey).playerStats);
      for (const s of specs) expect(declared.has(s.key), `${sportKey}.${s.key}`).toBe(true);
    });
  }
  it("a sport without a spec list falls back to the module's first two declared metrics, in declaration order", () => {
    const model = resolveLatestModule("tennis").playerStats;
    const fallback = specsFor("tennis", model);
    expect(fallback.map((s) => s.key)).toEqual((model?.metrics ?? []).slice(0, 2).map((m) => m.key));
    expect(fallback.every((s) => s.labelKey === null)).toBe(true);
  });
});

describe("buildLeaderBoards", () => {
  it("EMPTY: no rows → [] (no Stats tab)", () => expect(buildLeaderBoards(args([]))).toEqual([]));
  it("a board whose metric nobody has scored is dropped; zero values never make a row", () => {
    const boards = buildLeaderBoards(args([row("p1", { runs: 12, wickets: 0 })]));
    expect(boards.map((b) => b.key)).toEqual(["runs"]);
  });
  it("rows sort by value DESC, then name ASC (order-differential: equal runs), capped at the limit", () => {
    const boards = buildLeaderBoards({ ...args([row("zed", { runs: 30 }), row("amy", { runs: 30 }), row("bob", { runs: 41 }), row("c", { runs: 1 }), row("d", { runs: 2 }), row("e", { runs: 3 })]), limit: 5 });
    expect(boards[0]!.rows.map((r) => r.person.personId)).toEqual(["bob", "amy", "zed", "e", "d"]);
    expect(boards[0]!.rows[0]!.value).toBe("41");
  });
  it("a masked person keeps the masked label (never blank) and gets NO player-page link; a public one links (positive pair)", () => {
    const boards = buildLeaderBoards(args([row("p1", { runs: 9 }, { name: "A. B.", masked: true, publicProfile: false }), row("p2", { runs: 8 })]));
    const [masked, open] = boards[0]!.rows;
    expect(masked).toMatchObject({ person: { personId: "p1", name: "A. B.", masked: true }, personHref: null });
    expect(open!.personHref).toBe("/shared/o/c/players/p2");
  });
  it("boards are emitted per division in division order, spec order within a division", () => {
    const b2 = { ...cricket, id: "d2", slug: "w8", name: "Women's T8" };
    const boards = buildLeaderBoards({ ...args([row("p1", { runs: 5, wickets: 2 }), row("p9", { runs: 7 }, { divisionId: "d2" })]), divisions: [cricket, b2] });
    expect(boards.map((b) => `${b.divisionId}:${b.key}`)).toEqual(["d1:runs", "d1:wickets", "d2:runs"]);
  });
});
```

- [ ] **Step 2: Run — collection failure.**

- [ ] **Step 3: Implement `leaders.ts`**

```ts
import type { PlayerStatsModel } from "@seazn/engine/stats";
import type { TKey } from "@/lib/i18n-runtime";
import type { LeaderBoardT } from "./competition-hub-schema";

export interface LeaderSpec { key: string; labelKey: TKey | null }
/** COUNT leaders only — see plan premise P9: the engine declares no ratio floor,
 *  so strike rate / economy boards wait for an engine `leaderboards` declaration. */
export const LEADER_SPECS: Readonly<Record<string, readonly LeaderSpec[]>> = {
  cricket: [{ key: "runs", labelKey: "leaders.cricket.runs" }, { key: "wickets", labelKey: "leaders.cricket.wickets" }, { key: "sixes", labelKey: "leaders.cricket.sixes" }],
  football: [{ key: "goals", labelKey: "leaders.football.goals" }, { key: "assists", labelKey: "leaders.football.assists" }],
  hockey: [{ key: "goals", labelKey: "leaders.hockey.goals" }],
  icehockey: [{ key: "goals", labelKey: "leaders.hockey.goals" }],
};
export const LEADER_LIMIT = 5;
export function declaredStatKeys(model: PlayerStatsModel | undefined): Set<string> {
  return new Set([
    ...(model?.metrics ?? []).map((m) => m.key), ...(model?.derived ?? []).map((d) => d.key),
    ...(model?.folded?.keys ?? []).map((k) => k.key), ...(model?.awards ?? []).map((a) => `${a.key}_awards`),
  ]);
}
export function specsFor(sportKey: string, model: PlayerStatsModel | undefined): LeaderSpec[] {
  const declared = LEADER_SPECS[sportKey];
  if (declared) return [...declared];
  const seen = new Set<string>();
  return (model?.metrics ?? []).filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true))).slice(0, 2).map((m) => ({ key: m.key, labelKey: null }));
}
export function buildLeaderBoards(a: { /* Interfaces */ }): LeaderBoardT[] {
  const limit = a.limit ?? LEADER_LIMIT;
  const out: LeaderBoardT[] = [];
  for (const d of a.divisions) {
    const model = a.modelFor(d);
    const rows = a.rows.filter((r) => r.divisionId === d.id);
    for (const spec of specsFor(d.sportKey, model)) {
      const ranked = rows
        .filter((r) => (r.stats[spec.key] ?? 0) > 0)
        .sort((x, y) => (y.stats[spec.key]! - x.stats[spec.key]!) || x.name.localeCompare(y.name))
        .slice(0, limit);
      if (ranked.length === 0) continue;                                  // EMPTY board → no board
      out.push({
        divisionId: d.id, divisionSlug: d.slug, divisionName: d.name, sportKey: d.sportKey, key: spec.key, label: a.label(spec, model),
        rows: ranked.map((r) => ({
          person: { personId: r.personId, name: r.name, masked: r.masked },
          personHref: r.publicProfile && !r.masked ? a.personHref(r.personId) : null,
          entrantName: r.entrantName, badgeUrl: r.badgeUrl, value: String(r.stats[spec.key]),
        })),
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — green.** Mutants: (a) change `"wickets"` to `"wkts"` in `LEADER_SPECS.cricket` → the declared-keys guard reds; (b) sort names DESC → the order-differential case reds. Record both.

- [ ] **Step 5: Failing DB-backed reader test** — seed through the same helpers `consent.test.ts` uses (`seedOrg`, `createCompetition`, `createDivision`, `createEntrants`; a cricket division needs the `sports`/`sport_variants` rows for `cricket` — copy the `insert into sports … on conflict do nothing` shape at `consent.test.ts:41-48` with `key 'cricket'`); insert two `player_stat_snapshots` rows directly (`division_id, person_id, org_id, sport_key, stats, computed_through_seq`) for two persons, one with `consent {public_name:false}`:

```ts
it("readLeaderRows joins snapshot → person (consent-resolved) → entrant (name + badge) and flags the public profile", async () => {
  const rows = await readLeaderRows(sql, [{ id: divisionId, orgId, youth: false, player_name_display: null }]);
  const open = rows.find((r) => r.personId === publicPersonId)!;
  const priv = rows.find((r) => r.personId === privatePersonId)!;
  expect(open).toMatchObject({ name: publicFullName, masked: false, publicProfile: true, entrantName: "Blazers", stats: { runs: 34, wickets: 1 } });
  expect(priv.masked).toBe(true);
  expect(priv.name).not.toBe("");
  expect(priv.name).not.toBe(privateFullName);
  expect(priv.publicProfile).toBe(false);
});
it("a division with no snapshots yields no rows (EMPTY), and the watermark recompute is invoked once per division", async () => { /* spy recomputePlayerStats via vi.mock("@/server/usecases/player-stats") wrapping the real one */ });
```

- [ ] **Step 6: Run** with `DATABASE_URL` — `numTotalTests` must be ≥ 2 (a `0` means it skipped, which is NOT a pass).

- [ ] **Step 7: Implement `public-leaders.ts`**

```ts
import "server-only";
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { recomputePlayerStats } from "@/server/usecases/player-stats";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import type { LeaderInputRow } from "./leaders";
export type Sql = ReturnType<typeof postgres>;

export async function readLeaderRows(sql: Sql, divisions: { id: string; orgId: string; youth?: boolean; player_name_display?: string | null }[]): Promise<LeaderInputRow[]> {
  if (divisions.length === 0) return [];
  // Watermark refresh — the same call the public leaderboard makes before reading (usecases/player-stats.ts:539).
  for (const d of divisions) await withTenant(d.orgId, (tx) => recomputePlayerStats(tx, d.id));
  const byDivision = new Map(divisions.map((d) => [d.id, d]));
  const rows = await sql<{
    division_id: string; person_id: string; full_name: string; consent: { public_name?: boolean } | null; stats: Record<string, number>;
    entrant_name: string | null; badge_url: string | null; team_logo_path: string | null; public_profile: boolean;
  }[]>`
    select ps.division_id, ps.person_id, p.full_name, p.consent, ps.stats,
           e.display_name as entrant_name, e.badge_url, pe.team_display->>'logo_path' as team_logo_path,
           exists (select 1 from public_players_v v where v.id = p.id) as public_profile
    from player_stat_snapshots ps
    join persons p on p.id = ps.person_id and p.merged_into is null
    left join lateral (
      select em.entrant_id from entrant_members em
      join entrants en on en.id = em.entrant_id
      where em.person_id = ps.person_id and en.division_id = ps.division_id
      order by em.entrant_id limit 1) m on true
    left join entrants e on e.id = m.entrant_id
    left join public_entrants_v pe on pe.id = e.id
    where ps.division_id in ${sql(divisions.map((d) => d.id))}`;
  return rows.map((r) => {
    const d = byDivision.get(r.division_id)!;
    const name = resolvePersonDisplayName(r.full_name, r.consent, d.player_name_display ?? null, d.youth ?? false);
    return {
      divisionId: r.division_id, personId: r.person_id, name, masked: name !== r.full_name, publicProfile: r.public_profile,
      entrantName: r.entrant_name, badgeUrl: resolveEntrantBadge({ badge_url: r.badge_url, team_logo_path: r.team_logo_path }), stats: r.stats,
    };
  });
}
```
Pin before writing: `entrants.badge_url` column exists (`V288__v13_fidelity.sql:11`, spec block I row 4) and `public_entrants_v.team_display` is the jsonb the division page reads (`data.ts:643-646`).

- [ ] **Step 8: Run — green** (DB). **Step 9: Commit** — "web(public-site): leaders — declared-key count boards per division, consent-resolved snapshot reader".

---
### Task 4: `loadCompetitionHub` — champion rule, format chip, match header, the document, its two caches and the write-side invalidation

**Files:**
- Create: `apps/web/src/server/public-site/champion.ts`, `describe-format.ts`, `competition-hub.ts`
- Modify: `apps/web/src/server/public-site/data.ts` — `PublicDivision` gains `config?: unknown` (`:190-214`), and `getPublicCompetition`'s division SELECT (`:425-436`) adds `dv.config`
- Modify: `apps/web/src/server/usecases/public.ts` — add `cachedFor(key, ttlSeconds, load)` beside `cached` (`:32-38`) and `publicCompetitionHub(orgSlug, slug)`
- Modify: `apps/web/src/server/usecases/scoring.ts:491-520` — `invalidatePublicCache` adds `await cacheDelPattern(\`pub:v1:hub:${row.competition_id}\`)`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx:125-149` — replace the inline champion IIFE with `divisionChampion(stages, fixtures, standings)` (same value, one authority)
- Test: `apps/web/src/server/public-site/__tests__/{champion,describe-format,competition-hub}.test.ts`

**Interfaces:**
- Consumes: `getPublicCompetition`, `getPublicDivision` (`data.ts:407,610`), `PublicFixture`, `PublicStandings`, `PublicStage`, `PublicEntrant`; `resolveModule(sportKey, moduleVersion)` (`server/engine-db/registry.ts:27` — `.metrics`, `.defaultTiebreakers`, `.playerStats`, `.configSchema`); `buildTableView` (Task 2); `readLeaderRows`, `buildLeaderBoards` (Task 3); `bucketFixture`, `sortHubMatches`, `deriveHubTabs` (Task 1); `decidedOutcomeText`, `shootoutScoreFromDetail` (`@/lib/scoring-vocab`); `roundRoleFor`, `roundRoleLabel` (`@/lib/round-role-label:90,21`); `resolveSlotLabel` (`@/lib/slot-label:55`); `msgFor` (`@/lib/messages-i18n:24`); `getDictionary`, `t` (`@/lib/i18n`); `publicRegistrationInfo` (`usecases/registrations.ts:1989`); `resolveEntrantBadge`; `unstable_cache`, `competitionTag`, `divisionTag`, `orgTag`, `REVALIDATE_FAST` (`data.ts:136-143`).
- Produces:
  ```ts
  // champion.ts (pure) — verbatim rule from [divisionSlug]/page.tsx:125-149, EMPTY case first (no stages → null)
  export const BRACKET_KINDS: ReadonlySet<string>;   // knockout, double_elim, stepladder, page_playoff (page.tsx:54)
  export function divisionChampion(stages: PublicStage[], fixtures: PublicFixture[], standings: PublicStandings[]): string | null;
  // describe-format.ts (pure)
  export function describeFormat(sportKey: string, cfg: unknown): MsgT | null;   // cricket → {key:"format.cricket.overs", params:{overs}}; football → {key:"format.minutes", params:{minutes}}; set sports → {key:"format.sets.bestOf", params:{n}}; else null
  // competition-hub.ts
  export function hubSide(entrantId: string | null, slotLabel: SlotLabel | null, ctx: { names: Record<string,string>; badges: Record<string,string|null>; colours: Record<string,string|null>; slot: (label) => string }): SideT;
  export function hubHeader(f: PublicFixture, sides: [SideT, SideT], generatedAt: string): MatchCentreHeaderT;
  export function loadCompetitionHub(orgSlug: string, compSlug: string, now?: Date): Promise<CompetitionHubDocT | null>;   // uncached
  export function getPublicCompetitionHub(orgSlug: string, compSlug: string): Promise<CompetitionHubDocT | null>;        // unstable_cache, tags [orgTag, competitionTag, ...divisionTags], REVALIDATE_FAST
  // usecases/public.ts
  export async function publicCompetitionHub(orgSlug: string, slug: string): Promise<CompetitionHubDocT>;   // Redis `pub:v1:hub:{competitionId}`, TTL 15
  ```

- [ ] **Step 1: Failing tests for the two pure helpers**

```ts
// champion.test.ts
describe("divisionChampion", () => {
  it("EMPTY: no stages → null", () => expect(divisionChampion([], [], [])).toBeNull());
  it("league not complete and not fully played → null; every fixture decided → rank 1 of the overall snapshot", () => { /* stage {kind:"league",status:"active",seq:1}; two fixtures decided; standings [{stage_id, pool_id:null, rows:[{entrantId:"a",rank:1},{entrantId:"b",rank:2}]}] → "a" */ });
  it("knockout: the highest round_no decided fixture's winner (order-differential: a lower-round winner is NOT the champion)", () => { /* … */ });
  it("stage flagged complete with a pool snapshot only → the pool row's rank 1 (the `?? find(stage_id)` fallback)", () => { /* … */ });
});
// describe-format.test.ts — expected values DERIVED from each module's own configSchema defaults, never typed constants
describe("describeFormat", () => {
  it("cricket: overs = ballsPerInnings / ballsPerOver from the parsed cfg (8-over match for the W0 seed's 48/6)", () => {
    const cfg = resolveLatestModule("cricket").configSchema.parse({ ballsPerInnings: 48, playersPerSide: 8 });
    expect(describeFormat("cricket", cfg)).toEqual({ key: "format.cricket.overs", params: { overs: 8 } });
  });
  it("football: minutes from the module's period config (pin the field name from football.ts's configSchema before asserting)", () => { /* … */ });
  it("set-based sports report best-of from their cfg; a sport with no describable format → null (generic)", () => {
    expect(describeFormat("generic", {})).toBeNull();
  });
  it("garbage cfg never throws — returns null", () => expect(describeFormat("cricket", null)).toBeNull());
});
```

- [ ] **Step 2: Run — collection failures.** **Step 3: Implement** `champion.ts` (lift the IIFE body; keep `BRACKET_KINDS` exported and import it in the division page instead of its local `const`) and `describe-format.ts` (a `switch (sportKey)` reading the module's PARSED config — parse with `resolveLatestModule(sportKey).configSchema.safeParse(cfg)`; on failure return null). **Step 4: Run — green.**

- [ ] **Step 5: Failing DB-backed test for the document** (seed as `consent.test.ts` does, plus: one football division with three entrants, `createStages`+`generateStageFixtures`, one fixture scored to a decision through `appendEvent` so a standings snapshot exists; one fixture left scheduled at a known `scheduled_at`):

```ts
describe("loadCompetitionHub", () => {
  it("EMPTY competition (no divisions) → tabs [overview, info], no matches/tables/leaders/teams, realtime false", async () => {
    const doc = (await loadCompetitionHub(orgSlug, emptyCompSlug))!;
    expect(doc.tabs).toEqual(["overview", "info"]);
    expect([doc.matches, doc.tables, doc.leaders, doc.teams].map((x) => x.length)).toEqual([0, 0, 0, 0]);
  });
  it("seeded competition: parses against the schema; matches sorted live→upcoming→completed; the decided match carries the result sentence and a winnerIndex; the scheduled one carries the division's venue tz", async () => {
    const doc = (await loadCompetitionHub(orgSlug, compSlug, new Date("2026-09-05T12:00:00Z")))!;
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
    const decided = doc.matches.find((m) => m.fixtureId === decidedFixtureId)!;
    expect(decided).toMatchObject({ bucket: "completed", winnerIndex: 0, header: { status: "decided", scoreLines: ["2", "1"] } });
    expect(decided.resultLine).toBe(decidedOutcomeText(fixtureOutcome, entrantNames, (k, v) => msgFor("en", k, v), null));  // ONE authority
    expect(doc.matches.find((m) => m.fixtureId === scheduledFixtureId)).toMatchObject({ bucket: "upcoming", tz: "Europe/London", header: { status: "scheduled", statusLine: null } });
    expect(doc.tabs).toEqual(["overview", "matches", "table", "teams", "info"]);   // no leaders: football snapshots need scorer attribution the seed does not post — EMPTY Stats stated by absence
  });
  it("a TBD side renders the org-locale slot label as the side's name (never blank, never 'undefined')", async () => { /* a knockout fixture with home_slot_label {key:"slot.winner_group", params:{g:"A"}} → header.sides[0].name === msgFor(locale, "slot.winner_group", {g:"A"}) */ });
  it("the table view per stage/pool carries the champion and the full-division href with ?tab=standings", async () => { /* … */ });
  it("a private competition → null (the shell 404s it)", async () => { expect(await loadCompetitionHub(orgSlug, privateSlug)).toBeNull(); });
});
```

- [ ] **Step 6: Run — failures.** **Step 7: Implement `competition-hub.ts`**

```ts
export function hubHeader(f: PublicFixture, sides: [SideT, SideT], generatedAt: string): MatchCentreHeaderT {
  const status = f.status === "in_play" ? "in_play" : f.status === "decided" || f.status === "finalized" ? "decided" : f.status === "scheduled" ? "scheduled" : "other";
  const byId = Object.fromEntries((f.summary?.perSide ?? []).map((s) => [s.entrantId, s.line]));   // schedule.tsx:63-71 shape
  const line = (id: string) => (id && byId[id] != null ? byId[id] : null);
  return {
    live: f.status === "in_play", status,
    sides, scoreLines: [line(sides[0].entrantId), line(sides[1].entrantId)], subLines: [null, null], battingIndex: null,
    statusLine: status === "other" ? { key: `matchCentre.status.${f.status}` } : null,   // W1 keys: abandoned/cancelled/forfeited (P11)
    rateLine: null, updatedAt: generatedAt,
  };
}

export async function loadCompetitionHub(orgSlug: string, compSlug: string, now = new Date()): Promise<CompetitionHubDocT | null> {
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const { org, competition, divisions } = shell;
  const locale = toLocale(org.default_locale);
  const dict = await getDictionary(locale, "public");
  const msg = (k: TKey, v?: Record<string, string | number>) => t(dict, k, v);
  const ui = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor(locale, k, v);
  const base = `/shared/${org.slug}/${competition.slug}`;
  const generatedAt = now.toISOString();
  const [rt] = await sql<{ realtime: boolean }[]>`select org_has_feature(${org.id}, 'realtime', ${competition.id}) as realtime`;
  const registration = await publicRegistrationInfo(orgSlug, compSlug).catch(() => null);
  const details = await Promise.all(divisions.map(async (d) => ({ d, detail: await getPublicDivision(orgSlug, compSlug, d.slug) })));
  const leaderRows = await readLeaderRows(sql, divisions.map((d) => ({ id: d.id, orgId: org.id, youth: d.youth, player_name_display: d.player_name_display })));

  const matches: HubMatchT[] = []; const tables: TableViewT[] = []; const teams: TeamCardT[] = []; const venues = new Set<string>(); const hubDivisions: HubDivisionT[] = [];
  for (const { d, detail } of details) {
    if (!detail) continue;
    const { stages, pools, fixtures, standings, entrants, tz } = detail;
    let module_: AnySportModule | null = null;
    try { module_ = resolveModule(d.sport_key, d.module_version); } catch { module_ = null; }
    const names = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));        // already masked by getPublicDivision (RS008)
    const badges = Object.fromEntries(entrants.map((e) => [e.id, resolveEntrantBadge({ badge_url: e.badge_url, team_logo_path: e.team_display?.logo_path ?? null })]));
    const colours = Object.fromEntries(entrants.map((e) => [e.id, primaryColour(e.team_display?.colors)]));  // string | null; pin the colors blob shape (V242:67-78)
    const slot = (label: SlotLabel | null) => resolveSlotLabel(label, ui, "schedule.tbd");
    const divHref = `${base}/${d.slug}`;
    hubDivisions.push({ id: d.id, slug: d.slug, name: d.name, sportKey: d.sport_key, sportName: d.sport_name, status: d.status, tz, entrantCount: d.entrant_count, formatLine: describeFormat(d.sport_key, d.config), variantKey: d.variant_key, href: divHref });
    const stageById = new Map(stages.map((s) => [s.id, s]));
    for (const f of fixtures) {
      const sides: [SideT, SideT] = [hubSide(f.home_entrant_id, f.home_slot_label, { names, badges, colours, slot }), hubSide(f.away_entrant_id, f.away_slot_label, { names, badges, colours, slot })];
      const stage = stageById.get(f.stage_id);
      const role = stage && BRACKET_KINDS.has(stage.kind) ? roundRoleLabel(ui, roundRoleFor(/* pin the argument shape at round-role-label.ts:90 */ f, fixtures.filter((x) => x.stage_id === f.stage_id), stage.kind)) : (f.round_no ? ui("bracket.round.plain", { n: f.round_no }) : null);
      if (f.venue_name) venues.add(f.venue_name);
      matches.push({
        fixtureId: f.id, divisionId: d.id, divisionSlug: d.slug, divisionName: d.name, sportKey: d.sport_key,
        stageName: stage?.name ?? "", roundNo: f.round_no, roundLabel: role, bucket: bucketFixture(f.status), tz, scheduledAt: f.scheduled_at,
        venueName: f.venue_name, courtName: f.court_name, href: `${divHref}/fixtures/${f.id}`,
        header: hubHeader(f, sides, generatedAt),
        winnerIndex: f.outcome?.winner ? (f.outcome.winner === f.home_entrant_id ? 0 : f.outcome.winner === f.away_entrant_id ? 1 : null) : null,
        resultLine: f.status === "decided" || f.status === "finalized" ? decidedOutcomeText(f.outcome, names, ui, shootoutScoreFromDetail(f.summary?.detail)) : null,
      });
    }
    const championId = divisionChampion(stages, fixtures, standings);
    const poolName = new Map(pools.map((p) => [p.id, p.name]));
    for (const stage of [...stages].sort((a, b) => ((a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0)) || a.seq - b.seq)) {   // page.tsx:117-120 order
      if (BRACKET_KINDS.has(stage.kind)) continue;
      for (const snap of standings.filter((s) => s.stage_id === stage.id).sort((a, b) => (a.pool_id ?? "").localeCompare(b.pool_id ?? ""))) {
        tables.push(buildTableView({
          id: `${d.slug}-${stage.id}-${snap.pool_id ?? "overall"}`, division: { id: d.id, slug: d.slug, name: d.name },
          caption: snap.pool_id ? `${stage.name} — ${poolName.get(snap.pool_id) ?? msg("table.pool")}` : stage.name, fullHref: `${divHref}?tab=standings`,
          rows: snap.rows as StandingsRow[], metricSpecs: module_?.metrics ?? [], cascade: d.tiebreakers ?? module_?.defaultTiebreakers ?? [],
          entrantNames: names, entrantLogos: badges, championId, updatedAt: snap.updated_at, msg,
        }));
      }
    }
    for (const e of entrants) teams.push({ entrantId: e.id, divisionId: d.id, divisionSlug: d.slug, divisionName: d.name, name: e.display_name, badgeUrl: badges[e.id] ?? null, colour: colours[e.id] ?? null, seed: e.seed, href: `${divHref}?tab=entrants` });
  }
  const leaders = buildLeaderBoards({
    divisions: divisions.map((d) => ({ id: d.id, slug: d.slug, name: d.name, sportKey: d.sport_key, moduleVersion: d.module_version })), rows: leaderRows,
    modelFor: (d) => { try { return resolveModule(d.sportKey, d.moduleVersion).playerStats; } catch { return undefined; } },
    label: (spec, model) => spec.labelKey ? msg(spec.labelKey) : (model?.metrics.find((m) => m.key === spec.key)?.label ?? spec.key),
    personHref: (id) => `${base}/players/${id}`,
  });
  const sorted = sortHubMatches(matches);
  return {
    competitionId: competition.id, orgSlug: org.slug, competitionSlug: competition.slug, name: competition.name, orgName: org.name, branded: org.branded,
    realtime: rt?.realtime === true, locale, generatedAt, divisions: hubDivisions, matches: sorted, tables, leaders, teams,
    info: { startsOn: competition.starts_on, endsOn: competition.ends_on, venues: [...venues].sort(), registrationOpen: registration?.divisions.some((x) => x.open) ?? false, registerHref: `${base}/register`, calendars: hubDivisions.map((d) => ({ divisionName: d.name, href: `${d.href}/calendar.ics` })), presentHref: `${base}/present` },
    tabs: deriveHubTabs({ matches: sorted.length, tables: tables.length, leaderRows: leaders.reduce((n, b) => n + b.rows.length, 0), teams: teams.length }),
  };
}

export async function getPublicCompetitionHub(orgSlug: string, compSlug: string) {
  const shell = await getPublicCompetition(orgSlug, compSlug);      // the ISR shell (tag orgTag) resolves the ids the tags below need
  if (!shell) return null;
  return unstable_cache(() => loadCompetitionHub(orgSlug, compSlug), ["pub-hub-v1", shell.competition.id], {
    tags: [orgTag(orgSlug), competitionTag(shell.competition.id), ...shell.divisions.map((d) => divisionTag(d.id))], revalidate: REVALIDATE_FAST,
  })();
}
```
`hubSide`: `{ entrantId: id ?? "", name: id ? names[id] ?? "?" : slot(label), short: shortName(name), colour: id ? colours[id] ?? null : null, badgeUrl: id ? badges[id] ?? null : null }` where `shortName` = first letters of up to three words, upper-cased (the same rule W1 uses for `Side.short` — pin it in `match-centre.ts` once W1 lands and import it if exported).

`usecases/public.ts`: `cachedFor` is `cached` with an explicit TTL; `publicCompetitionHub = findCompetition(orgSlug, slug)` (`:52-61`, 404 otherwise) then `cachedFor(\`pub:v1:hub:${full.id}\`, 15, () => loadCompetitionHub(orgSlug, slug))` — a null doc after a positive `findCompetition` is a 404 too. `invalidatePublicCache` (`scoring.ts:491-520`): add `await cacheDelPattern(\`pub:v1:hub:${row.competition_id}\`);` inside `if (row)` — a unit test in `usecases/__tests__/scoring-invalidate.test.ts` (create; mock `@/lib/cache`) asserts the exact key set `{fixture, div:*, hub}` (mutant: delete the new line → reds).

- [ ] **Step 8: Run — green; then `cd <worktree>/apps/web && pnpm exec vitest run "src/app/(public)/shared" src/server/public-site --reporter=json --outputFile=/tmp/spx-w2-t4.json`** — the division page's champion refactor must keep every existing public-site test green (compare `numTotalTests` with the run before this task). **Step 9: Commit** — "web(public-site): the competition hub document — champion and format helpers, match headers from the fixture summary, per-stage table views, count leaders; ISR + Redis caches invalidated on scoring writes".

---
### Task 5: The public hub endpoint (the poll target) and its OpenAPI entry

**Files:**
- Create: `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/hub/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts:196-201` (one entry after the competition landing entry at `:196`)
- Regenerate: `cd <worktree> && npm run openapi:gen`
- Test: `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/hub/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `v1`, `reply` (`server/api-v1/http.ts:96,124`), `publicRateLimit`, `PUBLIC_CACHE_CONTROL` (`usecases/public.ts:20,24`), `publicCompetitionHub` (Task 4), `CompetitionHubDoc` (Task 1).
- Produces: `GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}/hub` → `{ ok: true, data: CompetitionHubDocT }` with `Cache-Control: public, s-maxage=30, stale-while-revalidate=300`; 404 for an unknown or private competition; 429 under the per-IP public limit.

- [ ] **Step 1: Failing route test** (mock the usecase and the limiter, as `register-route.test.ts:16` mocks `@/lib/rate-limit`):

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));
const hub = vi.hoisted(() => ({ publicCompetitionHub: vi.fn() }));
vi.mock("@/server/usecases/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/public")>();
  return { ...actual, publicCompetitionHub: hub.publicCompetitionHub };
});
import { GET } from "../route";
import { HttpError } from "@/lib/errors";

const ctx = { params: Promise.resolve({ orgSlug: "riverside", slug: "cup" }) };
const doc = { competitionId: "c1", tabs: ["overview", "info"], matches: [], tables: [], leaders: [], teams: [] };

describe("GET /api/v1/public/orgs/{org}/competitions/{slug}/hub", () => {
  it("returns the usecase's document in the v1 envelope with the public cache header", async () => {
    hub.publicCompetitionHub.mockResolvedValue(doc);
    const res = await GET(new Request("http://x/api/v1/public/orgs/riverside/competitions/cup/hub"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=300");
    expect(await res.json()).toEqual({ ok: true, data: doc });
    expect(hub.publicCompetitionHub).toHaveBeenCalledWith("riverside", "cup");
  });
  it("a 404 from the usecase is a 404 envelope, never a 500", async () => {
    hub.publicCompetitionHub.mockRejectedValue(new HttpError(404, "competition not found"));
    const res = await GET(new Request("http://x/"), ctx);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — collection failure.** **Step 3: Implement**

```ts
import { v1, reply } from "@/server/api-v1/http";
import { publicCompetitionHub, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };
/** Spectator W2 — the competition hub document the landing page polls (R10). Same
 *  JSON the page rendered from; Redis 15 s in front, deleted on every scoring write. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug } = await params;
    return reply(200, await publicCompetitionHub(orgSlug, slug), { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
```
`openapi.ts` (after `:196`): `{ path: "/public/orgs/{orgSlug}/competitions/{slug}/hub", method: "get", summary: "Public competition hub: matches, tables, leaders, teams, info — the landing page's live document", tag: "public", public: true, response: CompetitionHubDoc },` with `import { CompetitionHubDoc } from "../public-site/competition-hub-schema.ts";` (this file is also loaded by `scripts/openapi-gen.ts` — no `server-only` import may reach it; `competition-hub-schema.ts` imports only zod and W1's schema file, which imports only zod — confirm before wiring).

- [ ] **Step 4: Run — green; then `cd <worktree> && npm run openapi:gen && /usr/bin/git status --porcelain openapi`** — the diff must be exactly the new path in `openapi/v1.json` and `openapi/v1.public.json`. **Step 5: Commit** — "api(public): GET …/competitions/{slug}/hub — the landing page's poll document; OpenAPI regenerated".

---

### Task 6: Dictionaries — every W2 key in four locales, generated key file, coverage test

**Files:**
- Modify: `apps/web/src/dictionaries/en/public.json`, `es/public.json`, `fr/public.json`, `nl/public.json`
- Regenerate: `cd <worktree> && npm run i18n:gen-keys && npm run i18n:check`
- Test: `apps/web/src/server/public-site/__tests__/hub-dictionary.test.ts`

- [ ] **Step 1: Failing coverage test** (the exact list of keys Tasks 7–16 use — a key added later is added HERE first):

```ts
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/public.json"; import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json"; import nl from "@/dictionaries/nl/public.json";
import { LEADER_SPECS } from "../leaders";

export const W2_KEYS = [
  // landing shell
  "landing.tabsLabel", "landing.tab.overview", "landing.tab.matches", "landing.tab.table", "landing.tab.stats", "landing.tab.teams", "landing.tab.gallery", "landing.tab.info",
  "landing.status.empty", "landing.status.live.one", "landing.status.live.other", "landing.status.next", "landing.status.finished", "landing.status.dates", "landing.status.datesFrom",
  "landing.liveNow", "landing.nextUp", "landing.tables", "landing.register", "landing.present", "landing.divisions.one", "landing.divisions.other",
  "landing.entrants.one", "landing.entrants.other", "landing.liveCount.one", "landing.liveCount.other", "landing.sponsors", "landing.presentedBy", "landing.partners", "landing.noDivisions",
  // matches hub
  "matchesHub.filter.live", "matchesHub.filter.upcoming", "matchesHub.filter.completed", "matchesHub.filtersLabel", "matchesHub.divisionsLabel", "matchesHub.division.all",
  "matchesHub.startsIn", "matchesHub.startsAt", "matchesHub.timeTbd", "matchesHub.unscheduled", "matchesHub.empty", "matchesHub.emptyFilter", "matchesHub.live", "matchesHub.ended",
  "matchesHub.round", "matchesHub.timesIn", "matchesHub.card.label",
  // table
  "table.team", "table.col.rank", "table.col.played", "table.col.won", "table.col.drawn", "table.col.lost", "table.col.points", "table.tieBreak", "table.fullDivision", "table.more", "table.fewer", "table.empty", "table.pool", "table.champion",
  // leaders / teams / info
  "leaders.title", "leaders.empty", ...Object.values(LEADER_SPECS).flat().map((s) => s.labelKey).filter((k): k is string => k !== null),
  "teams.title", "teams.seed", "teams.division", "info.title", "info.dates", "info.venues", "info.registration.open", "info.registration.closed", "info.calendar", "info.share",
  // division page
  "division.tab.schedule", "division.tab.standings", "division.tab.entrants", "division.tabsLabel", "division.champion", "division.resultsGrid", "division.standingsEmpty", "division.entrantsEmpty",
  "division.seed", "division.filter.label", "division.filter.all", "division.view.label", "division.view.day", "division.view.round", "division.calendar", "division.metaDescription", "division.scheduleEmpty",
  // player page
  "player.inThisCompetition", "player.noSquad", "player.stats", "player.matches", "player.matches.empty", "player.line.cricket", "player.line.batting", "player.line.bowling", "player.line.result",
  "player.result.won", "player.result.lost", "player.result.drawn", "player.result.live",
  // org home + layout + share
  "org.live.one", "org.live.other", "layout.tagline", "layout.poweredBy", "share.share", "share.whatsapp", "share.whatsappAria", "share.copy", "share.copied",
  // format chips
  "format.cricket.overs", "format.minutes", "format.sets.bestOf",
] as const;

describe("W2 public dictionary coverage", () => {
  for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
    it(`${locale} has every W2 key`, () => { for (const k of W2_KEYS) expect(dict, k).toHaveProperty(k); });
  }
  it("every {param} in an English template is present in the other three (a dropped {n} renders a raw brace)", () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of W2_KEYS) for (const d of [es, fr, nl]) expect(params((d as Record<string, string>)[k]), k).toEqual(params((en as Record<string, string>)[k]));
  });
  it("no key is namespaced with a leading `public.` (the W1 slip)", () => {
    expect(Object.keys(en).filter((k) => k.startsWith("public."))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failures listing the missing keys.** **Step 3: Add the keys** (English first; Spanish, French, Dutch as real translations, not copies — cricket vocabulary stays English where the language has none, e.g. "wickets" in nl reads "wickets"). English values, verbatim: `landing.status.live.one` "Live now: {count} match" / `.other` "Live now: {count} matches"; `landing.status.next` "Next: {when}"; `landing.status.finished` "Finished"; `landing.status.dates` "{from} – {to}"; `landing.status.datesFrom` "From {from}"; `landing.status.empty` "Nothing published yet"; `matchesHub.startsIn` "Starts {when}" (with `when` from `Intl.RelativeTimeFormat`); `matchesHub.startsAt` "{when}"; `matchesHub.timesIn` "times in {tz}"; `table.tieBreak` "Level with {with} — separated on {rule}"; `table.more` "Show all columns"; `table.fewer` "Fewer columns"; `player.line.cricket` "{batting} & {bowling}"; `player.line.batting` "{runs} ({balls})"; `player.line.bowling` "{wickets}/{runs}"; `layout.tagline` "Live scores · Schedules · Standings"; `layout.poweredBy` "Powered by {brand}"; `format.cricket.overs` "{overs}-over match"; `format.minutes` "{minutes} min"; `format.sets.bestOf` "Best of {n}". Then `cd <worktree> && npm run i18n:gen-keys && npm run i18n:check` and confirm `apps/web/src/lib/i18n-keys.ts` changed.

- [ ] **Step 4: Run — green** (`hub-dictionary.test.ts` and, scoped, `pnpm exec vitest run src/lib/__tests__/i18n --reporter=json` for the existing dictionary-shape tests). **Step 5: Commit** — "i18n(public): landing, matches hub, table, leaders, teams, info, division, player, layout and share keys in en/es/fr/nl; keys regenerated".

---
### Task 7: The live-competition transport hook, the generic `PublicTabRail`, and the `MatchCard`

**Files:**
- Create: `apps/web/src/components/public-site/competition-hub-data.ts`, `use-live-competition.ts`, `tab-rail.tsx`, `matches-hub/match-card.tsx`
- Test: `apps/web/src/components/public-site/__tests__/{use-live-competition,public-tab-rail,match-card}.test.tsx`

**Interfaces:**
- Consumes: `api<T>(path)` (`@/lib/client:6`), `supabaseBrowser` (`@/lib/supabase-browser`, dynamic import as `slideshow.tsx:118`), `CompetitionHubDocT`, `HubMatchT` (Task 1), `EntityLogo` (`@/components/ui/entity-logo:16`), `fmtTime`, `fmtDate` (`@/lib/format:33,42`), `t` (`@/lib/i18n-runtime`), `useNow` (W1, `match-centre/use-now.ts:12` — P4; if W1 is not merged yet, copy the 19-line hook to `components/public-site/use-now.ts` and note the duplicate for Task 19), `renderIsland` (`@/components/__tests__/_hook-harness`, P16).
- Produces:
  ```ts
  export const HUB_POLL_MS = 15_000;          // MUST equal W1's POLL_MS (use-live-fixture.ts:10) — pinned by a test once W1 is merged
  export const HUB_IDLE_POLL_MS = 60_000;      // no live match on the page → slower poll
  export async function fetchCompetitionHub(orgSlug: string, competitionSlug: string): Promise<CompetitionHubDocT>;   // GET /api/v1/public/orgs/{o}/competitions/{c}/hub
  export function useLiveCompetition(args: { orgSlug: string; competitionSlug: string; initial: CompetitionHubDocT; realtime: boolean }): { doc: CompetitionHubDocT; updatedAt: number; transport: "realtime" | "poll" };
  export function PublicTabRail<Id extends string>(props: { tabs: { id: Id; label: string }[]; active: Id; onChange: (id: Id) => void; ariaLabel: string; testidPrefix: string }): JSX.Element;  // "use client"; DOM contract identical to W1's TabRail (P5): role=tablist tabIndex=0 aria-label, id={prefix}-tab-{id}, aria-controls={prefix}-tab-panel-{id}, Left/Right/Home/End
  export function MatchCard(props: { match: HubMatchT; dict: PublicDict; locale: string; now: number; showDivision?: boolean; compact?: boolean }): JSX.Element;
  ```

- [ ] **Step 1: Failing hook test** (island harness; copy `stubFetch`/`stubInterval` from `live-score.test.tsx:26-55`):

```tsx
describe("useLiveCompetition", () => {
  it("polls the hub endpoint and replaces the WHOLE document on each tick (a card's score and a table row both move)", async () => {
    const interval = stubInterval();
    const island = renderIsland(Probe, { orgSlug: "o", competitionSlug: "c", initial: docWith({ live: "1-0", pts: "3" }), realtime: false });
    stubFetch({ ok: true, data: docWith({ live: "2-0", pts: "6" }) });
    await interval.fire();
    expect(island.text()).toContain("2-0");
    expect(island.text()).toContain("6");
    expect(fetch).toHaveBeenCalledWith("/api/v1/public/orgs/o/competitions/c/hub", expect.anything());   // pin `api()`'s exact call shape at lib/client.ts:6
  });
  it("a failed poll keeps the last document (never throws to the UI)", async () => { /* stubFetch({ ok:false }, false, 500); fire; text unchanged */ });
  it("with a live match the interval is HUB_POLL_MS; with none it is HUB_IDLE_POLL_MS (positive pair)", async () => { /* stubInterval records the delay argument */ });
  it("HUB_POLL_MS equals W1's POLL_MS — one poll cadence for the whole surface", async () => {
    const { POLL_MS } = await import("../match-centre/use-live-fixture");   // skips with a recorded note if W1 is not merged yet
    expect(HUB_POLL_MS).toBe(POLL_MS);
  });
});
```
`Probe` renders `doc.matches[0].header.scoreLines[0]` and `doc.tables[0].rows[0].cells.at(-1)` as text.

- [ ] **Step 2: Run — failures.** **Step 3: Implement the hook** — the lifted `useLiveFixture` logic (P4) with three differences: `refresh = () => fetchCompetitionHub(orgSlug, competitionSlug)`; the interval is `doc.matches.some((m) => m.bucket === "live") ? HUB_POLL_MS : HUB_IDLE_POLL_MS` (re-armed when that boolean flips); Realtime subscribes ONE channel per division that has a live match — `sb.channel(\`division:${id}\`).on("broadcast", { event: "state_changed" }, onPush).on("broadcast", { event: "schedule_changed" }, onPush).subscribe(...)` exactly as `slideshow.tsx:118-130` (no token; P10) — debounced 250 ms into `refresh`; `mountedRef` guard as `use-live-fixture.ts:32-38`. The root sets `data-transport={transport}` so the walkthrough can print what it saw.

- [ ] **Step 4: Failing rail + card tests** (static markup):

```tsx
it("PublicTabRail: tablist is focusable and named; one role=tab per tab with the prefix's testids; the active tab is aria-selected (positive pair on an inactive one)", () => {
  const h = renderToStaticMarkup(<PublicTabRail tabs={[{ id: "overview", label: "Overview" }, { id: "matches", label: "Matches" }]} active="matches" onChange={() => {}} ariaLabel="Competition sections" testidPrefix="mh" />);
  expect(h).toMatch(/role="tablist"[^>]*tabindex="0"[^>]*aria-label="Competition sections"/);
  expect(h.match(/role="tab"/g)?.length).toBe(2);
  expect(h).toMatch(/id="mh-tab-matches"[^>]*aria-controls="mh-tab-panel-matches"[^>]*data-testid="mh-tab-matches"[^>]*aria-selected="true"/);
  expect(h).toMatch(/data-testid="mh-tab-overview"[^>]*aria-selected="false"/);
});
describe("MatchCard", () => {
  const live = hubMatch({ bucket: "live", header: { status: "in_play", live: true, scoreLines: ["56/6", "12/0"], subLines: ["(8.0)", "(2.1)"] } });
  it("live: LIVE pill, both score lines with sub-lines, division chip, venue/court, links to the match centre", () => {
    const h = card(live);
    expect(h).toContain(`data-testid="mh-match-${live.fixtureId}"`);
    expect(h).toContain(`href="${live.href}"`);
    expect(h).toContain(`data-testid="mh-match-live"`);
    expect(h).toContain("56/6"); expect(h).toContain("(2.1)");
    expect(h).toContain(`data-testid="mh-match-division"`);
    expect(h).toContain("Court 1");
  });
  it("decided: the result line and the winner row in bold; no LIVE pill; no relative time (positive pair with scheduled)", () => {
    const h = card(hubMatch({ bucket: "completed", winnerIndex: 1, resultLine: "Queens won by 4 wickets", header: { status: "decided" } }));
    expect(h).toContain("Queens won by 4 wickets");
    expect(h).toMatch(/data-testid="mh-match-side-1"[^>]*data-winner="true"/);
    expect(h).not.toContain(`data-testid="mh-match-live"`);
    expect(h).not.toContain(`data-testid="mh-match-starts"`);
  });
  it("scheduled within 24h: 'Starts in 2 hours' from Intl.RelativeTimeFormat in the org locale; beyond 24h: the venue-zone date+time; unscheduled: Time TBD", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    expect(card(hubMatch({ bucket: "upcoming", scheduledAt: "2026-09-05T14:00:00Z", tz: "Europe/London" }), now)).toMatch(/mh-match-starts[^<]*>Starts in 2 hours</);
    expect(card(hubMatch({ bucket: "upcoming", scheduledAt: "2026-09-12T14:00:00Z", tz: "Europe/London" }), now)).toContain("15:00");   // BST
    expect(card(hubMatch({ bucket: "upcoming", scheduledAt: null }), now)).toContain("Time TBD");
  });
  it("a 43-character side name renders in a min-w-0 truncate cell with a title; a TBD side (entrantId '') renders its slot label, never blank", () => { /* … */ });
  it("crest: img when badgeUrl; initials otherwise (never an empty tile)", () => { /* … */ });
});
```

- [ ] **Step 5: Run — failures.** **Step 6: Implement**

`PublicTabRail`: W1's `TabRail` (`tab-rail.tsx:39-87`) with `tabs: {id,label}[]`, `testidPrefix`, `ariaLabel` in place of the dictionary lookups; pill classes verbatim from `tabs.tsx:30-33` (`shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm` / inactive `shrink-0 rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong`); wrapper `sticky top-[54px] z-30 -mx-4 bg-canvas/90 px-4 py-2 backdrop-blur` (`tabs.tsx:18`) with the rail itself `flex gap-1 overflow-x-auto` + `role="tablist" tabIndex={0} aria-label`. Minimum pill height `min-h-11` (44 px tap target).

`MatchCard` (one DOM; ≥`md` only widens):
```tsx
<Link href={m.href} data-testid={`mh-match-${m.fixtureId}`} aria-label={t(dict, "matchesHub.card.label", { home: s0.name, away: s1.name })}
      className="block rounded-xl border border-zinc-200/80 bg-surface p-3 shadow-sm transition hover:border-accent-line">
  <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-ink-muted">
    {showDivision ? <span data-testid="mh-match-division" className="rounded-full bg-accent-soft px-2 py-0.5 text-accent-strong">{m.divisionName}</span> : null}
    <span className="min-w-0 truncate">{[m.stageName, m.roundLabel].filter(Boolean).join(" · ")}</span>
    <span className="ml-auto shrink-0">
      {m.bucket === "live" ? <span data-testid="mh-match-live" className="flex items-center gap-1 font-bold text-emerald-600"><span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />{t(dict, "matchesHub.live")}</span>
       : m.bucket === "completed" ? t(dict, "matchesHub.ended")
       : m.scheduledAt ? fmtTime(m.tz, m.scheduledAt) : t(dict, "matchesHub.timeTbd")}
    </span>
  </div>
  <div className="mt-2 space-y-1">{[0, 1].map((i) => sideRow(i as 0 | 1))}</div>
  <div className="mt-2 flex items-baseline justify-between gap-2 text-xs text-ink-muted">
    <span className="min-w-0 truncate">{[m.venueName, m.courtName].filter(Boolean).join(" · ")}</span>
    {m.resultLine ? <span data-testid="mh-match-result" className="shrink-0 font-medium text-ink">{m.resultLine}</span>
     : m.bucket === "upcoming" ? <span data-testid="mh-match-starts" className="shrink-0">{startsText()}</span> : null}
  </div>
</Link>
```
`sideRow(i)`: `<div data-testid={`mh-match-side-${i}`} data-winner={m.winnerIndex === i ? "true" : undefined} className={`flex items-center gap-2 ${m.winnerIndex === i || m.header.battingIndex === i ? "font-semibold text-ink" : "text-ink"}`}><EntityLogo src={side.badgeUrl} name={side.name} size={24} /><span className="min-w-0 flex-1 truncate text-[15px]" title={side.name}>{side.name}</span><span className="shrink-0 font-display text-lg tabular-nums">{m.header.scoreLines[i] ?? ""}<span className="ml-1 text-xs text-ink-muted">{m.header.subLines[i] ?? ""}</span></span></div>`. `startsText()`: `Δ = Date.parse(m.scheduledAt) - now`; `|Δ| < 24h` → `t(dict, "matchesHub.startsIn", { when: new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(Math.round(Δ / 3_600_000) || Math.round(Δ / 60_000), Math.abs(Δ) >= 3_600_000 ? "hour" : "minute") })`; else `fmtDate(m.tz, m.scheduledAt, { weekday: "short", day: "numeric", month: "short" }) + " " + fmtTime(m.tz, m.scheduledAt)`; null → `t(dict, "matchesHub.timeTbd")`. W3's poster icon has no DOM in W2 (R4: no "coming soon").

- [ ] **Step 7: Run — green.** Mutants: (a) drop `min-w-0` from the name span → the truncate test's regex reds only if it asserts the class — make it assert `class="[^"]*min-w-0[^"]*truncate` (recorded); (b) invert `winnerIndex === i` → the decided test reds. **Step 8: Commit** — "ui(public-site): live-competition transport hook, generic PublicTabRail, MatchCard (W1 court-card variant)".

---
### Task 8: The Matches tab — filters with the default ladder, division chips, day groups

**Files:**
- Create: `apps/web/src/components/public-site/matches-hub/matches-tab.tsx`
- Test: `apps/web/src/components/public-site/__tests__/matches-tab.test.tsx`

**Interfaces:**
- Consumes: `defaultMatchesFilter`, `groupByDay`, `MatchBucket` (Task 1), `MatchCard` (Task 7), `fmtDate`, `fmtZoneAbbrev` (`@/lib/format:33,65`), `plural` (`@/lib/i18n-runtime:39`).
- Produces: `MatchesTab(props: { doc: CompetitionHubDocT; dict: PublicDict; locale: Locale; now: number; initialFilter?: MatchBucket | null; initialDivision?: string | null })` — `"use client"`; filter chips `mh-filter-{live|upcoming|completed}` (`aria-pressed`, with counts), division chips `mh-division-all` / `mh-division-{slug}` (`aria-pressed`), day sections `mh-day-{YYYY-MM-DD|unscheduled}`, empty states `mh-matches-empty` (no matches at all) and `mh-matches-empty-filter` (this filter/division combination has none).

- [ ] **Step 1: Failing tests** (static markup pins the VALUE each control opens at, not just its presence):

```tsx
const doc = hubDoc({ matches: [m("l1", "live", "2026-09-05T11:00:00Z", "t8"), m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"), m("u2", "upcoming", "2026-09-06T15:00:00Z", "sunday"), m("c1", "completed", "2026-09-04T10:00:00Z", "t8")] });
const render = (d = doc, over = {}) => renderToStaticMarkup(<MatchesTab doc={d} dict={en} locale="en" now={Date.parse("2026-09-05T12:00:00Z")} {...over} />);
it("EMPTY: no matches → mh-matches-empty, NO filter chips (nothing to filter)", () => {
  const h = render(hubDoc({ matches: [] }));
  expect(h).toContain(`data-testid="mh-matches-empty"`);
  expect(h).not.toContain(`data-testid="mh-filter-live"`);
});
it("default filter follows the ladder — with a live match the Live chip is pressed and ONLY the live card renders (upcoming exists but is not shown)", () => {
  const h = render();
  expect(h).toMatch(/data-testid="mh-filter-live"[^>]*aria-pressed="true"/);
  expect(h).toMatch(/data-testid="mh-filter-upcoming"[^>]*aria-pressed="false"/);
  expect(h).toContain(`data-testid="mh-match-l1"`);
  expect(h).not.toContain(`data-testid="mh-match-u1"`);
});
it("with no live match the default is Upcoming (order-differential: completed outnumber upcoming); chips carry counts", () => {
  const h = render(hubDoc({ matches: [m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8"), m("c1", "completed", null, "t8"), m("c2", "completed", null, "t8")] }));
  expect(h).toMatch(/data-testid="mh-filter-upcoming"[^>]*aria-pressed="true"/);
  expect(h).toMatch(/mh-filter-completed[^>]*>[^<]*2/);
});
it("upcoming matches group by venue day with a localised day header and the zone caption; unscheduled last", () => {
  const h = render(doc, { initialFilter: "upcoming" });
  expect(h).toContain(`data-testid="mh-day-2026-09-06"`);
  expect(h).toMatch(/mh-day-2026-09-06[^>]*>[\s\S]*?Sunday 6 September[\s\S]*?times in BST/);   // fmtDate(tz, iso, {weekday:"long", day:"numeric", month:"long"}) in the ORG locale — pin the exact English string the formatter yields in CI's ICU
});
it("division chips: 'All' pressed by default; a division filter narrows to that division and shows the empty-filter state when nothing matches", () => {
  const h = render(doc, { initialFilter: "completed", initialDivision: "sunday" });
  expect(h).toMatch(/data-testid="mh-division-sunday"[^>]*aria-pressed="true"/);
  expect(h).toContain(`data-testid="mh-matches-empty-filter"`);
  expect(h).not.toContain(`data-testid="mh-matches-empty"`);   // positive pair: the absolute-empty state is different
});
it("filter and division rails are focusable, named scrolling regions (R1)", () => {
  const h = render();
  expect(h).toMatch(/data-testid="mh-filters"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
  expect(h).toMatch(/data-testid="mh-divisions"[^>]*role="group"[^>]*tabindex="0"[^>]*aria-label="/);
});
```

- [ ] **Step 2: Run — failures.** **Step 3: Implement** — state `filter` (initialised `initialFilter ?? defaultMatchesFilter(counts)`), `division` (`initialDivision ?? null`); counts per bucket over ALL matches (chips show totals, not the filtered subset); `shown = doc.matches.filter(bucket === filter && (!division || divisionSlug === division))`; day groups via `groupByDay(shown)` (completed groups keep `sortHubMatches`'s newest-first order inside a day); each `<section data-testid={`mh-day-${key}`}>` with `<h3>` = `fmtDate(g.tz, first.scheduledAt, { weekday: "long", day: "numeric", month: "long" })` (or `matchesHub.unscheduled`) + `<span>{t(dict, "matchesHub.timesIn", { tz: fmtZoneAbbrev(g.tz, first.scheduledAt) })}</span>` — the caption is DROPPED when `g.tz` equals the viewer's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`, guarded for SSR: compare only after mount via `useEffect`, default shown) — the spec's "W2 drops the zone caption when it equals the viewer's". Chip rails: `<div role="group" tabIndex={0} aria-label className="flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4">` with `min-h-11` pills. Cards: `<ul className="grid gap-2 md:grid-cols-2">` (≥768 lays two-up, no new control).

- [ ] **Step 4: Run — green.** Mutant: hard-code `filter` to `"upcoming"` → the ladder test reds. **Step 5: Commit** — "ui(matches-hub): Matches tab — filter ladder with the empty case first, division chips, venue-day groups".

---

### Task 9: The Table tab

**Files:**
- Create: `apps/web/src/components/public-site/matches-hub/table-tab.tsx`
- Test: `apps/web/src/components/public-site/__tests__/table-tab.test.tsx`

- [ ] **Step 1: Failing tests**: (a) EMPTY `tables: []` → `mh-table-empty` copy (this is unreachable when the tab is hidden by `deriveHubTabs`, so the test also asserts the tab-level presence rule in Task 11); (b) one `StandingsTableView` per table view, in document order, each with `testid={`mh-table-${view.id}`}` and its `mh-table-${id}-full` link to `${divisionHref}?tab=standings`; (c) tables of one division are grouped under an `<h2 data-testid="mh-table-division-{slug}">` heading; (d) a champion row carries `data-champion="true"` and the `table.champion` label above the table.
- [ ] **Step 2: Run — failures.** **Step 3: Implement** — group `doc.tables` by `divisionId` preserving order; render heading + `StandingsTableView view dict testid showFullLink`; ≥`md` two-up when a division has more than one table (`md:grid-cols-2`). **Step 4: Run — green.** **Step 5: Commit** — "ui(matches-hub): Table tab — per-division standings, phone-composed".

---

### Task 10: Stats, Teams and Info tabs

**Files:**
- Create: `apps/web/src/components/public-site/matches-hub/stats-tab.tsx`, `teams-tab.tsx`, `info-tab.tsx`
- Test: `apps/web/src/components/public-site/__tests__/stats-teams-info-tabs.test.tsx`

**Interfaces:**
- `StatsTab({ doc, dict })` — boards grouped by division; each `<section data-testid={`mh-leaders-${divisionSlug}-${key}`}>` with an `<ol>`; row `<li data-testid={`mh-leader-${personId}`}>`: rank, `EntityLogo` (badge or initials), name (a `Link` to `personHref` when non-null, plain text otherwise), entrant name, value `tabular-nums font-display`.
- `TeamsTab({ doc, dict })` — per division, a grid of `mh-team-{entrantId}` links to `href` (`…?tab=entrants`) with the crest: `<img>` when `badgeUrl`, else a monogram tile `style={{ background: colour ?? undefined }}` with `initials(name)` (`entity-logo.tsx:57`); seed chip when `seed`.
- `InfoTab({ doc, dict, locale, descriptionSlot, sponsorsSlot })` — rows: dates (`fmtDate` in `Intl` of the org locale, UTC calendar dates), venues, registration state (+ `landing.register` link when open), one `.ics` link per division (`mh-info-calendar-{slug}`), share bar slot (rendered by the page, passed as a slot), the org's sponsor board slot, `presentHref` link.

- [ ] **Step 1: Failing tests**:

```tsx
it("Stats EMPTY: no boards → mh-leaders-empty; with boards: division heading, ordered rows, value, entrant; a masked leader has NO link and shows the masked label; a public one links (positive pair)", () => {
  const h = renderToStaticMarkup(<StatsTab doc={hubDoc({ leaders: [board("t8", "runs", [leader("p1", "Arjun Mehta", "/shared/o/c/players/p1"), leader("p2", "B. R.", null, { masked: true })])] })} dict={en} />);
  expect(h).toContain(`data-testid="mh-leaders-t8-runs"`);
  expect(h).toMatch(/mh-leader-p1[\s\S]*?href="\/shared\/o\/c\/players\/p1"/);
  expect(h).toMatch(/mh-leader-p2[^]*?>B\. R\.</);
  expect(h).not.toMatch(/mh-leader-p2[\s\S]{0,300}href=/);
});
it("Teams: badge img when badgeUrl, monogram tile in the team colour otherwise; every card links to the division's Entrants tab", () => {
  const h = renderToStaticMarkup(<TeamsTab doc={hubDoc({ teams: [team("e1", "Southend Blue Blazers", "https://x/b.png", null), team("e2", "Rochford Ramblers CC", null, "#123456")] })} dict={en} />);
  expect(h).toContain('src="https://x/b.png"');
  expect(h).toMatch(/data-testid="mh-team-e2"[\s\S]*?background:#123456[\s\S]*?>RC</);
  expect(h).toContain(`href="/shared/o/c/t8?tab=entrants"`);
});
it("Info: dates, venues, registration open → register link; closed → the closed copy and no link (positive pair); one calendar link per division", () => { /* … */ });
```

- [ ] **Step 2: Run — failures.** **Step 3: Implement** the three components (`TabPanel`-style root `<div data-testid={`mh-${id}`}>`, matching W1's `tab-panel.tsx:21-35` contract: NO `role="tabpanel"`/`id`/`aria-labelledby` here — the root wrapper owns them). **Step 4: Run — green.** Mutant: make the masked branch render a `Link` too → the no-link assertion reds. **Step 5: Commit** — "ui(matches-hub): Stats, Teams and Info tabs".

---
### Task 11: The Overview tab and the `CompetitionLanding` client root

**Files:**
- Create: `apps/web/src/components/public-site/matches-hub/overview-tab.tsx`, `matches-hub/competition-landing.tsx`
- Test: `apps/web/src/components/public-site/__tests__/{overview-tab,competition-landing}.test.tsx`

**Interfaces:**
- Consumes: `landingStatus` (Task 1), `MatchCard` (Task 7), `StandingsTableView` (Task 2), `PublicTabRail` (Task 7), `useLiveCompetition` (Task 7), `MatchesTab`/`TableTab`/`StatsTab`/`TeamsTab`/`InfoTab` (Tasks 8–10), `plural`, `fmtDate`, `fmtTime`.
- Produces:
  ```ts
  export function OverviewTab(props: { doc: CompetitionHubDocT; dict: PublicDict; locale: Locale; now: number; onOpenTab: (id: CompetitionHubTabIdT) => void; sponsorsSlot?: ReactNode; descriptionSlot?: ReactNode }): JSX.Element;
  export function CompetitionLanding(props: { initial: CompetitionHubDocT; dict: PublicDict; locale: Locale; sponsorsSlot?: ReactNode; descriptionSlot?: ReactNode; shareSlot?: ReactNode }): JSX.Element;  // "use client"
  ```
  DOM contract: `mh-root[data-transport]` → `PublicTabRail testidPrefix="mh"` → `<div role="tabpanel" id="mh-tab-panel-{active}" aria-labelledby="mh-tab-{active}" data-testid="mh-tab-panel-{active}">` → the active tab (the W1 root's shape, `match-centre.tsx:107-120`).

- [ ] **Step 1: Failing Overview tests**:

```tsx
it("status line ladder is rendered from landingStatus — EMPTY doc reads the empty copy and NOTHING else on the tab (no live rail, no next-up, no tables)", () => {
  const h = render(hubDoc({ divisions: [], matches: [], tables: [] }));
  expect(h).toContain(`data-testid="mh-status"`);
  expect(h).toContain(en["landing.status.empty"]);
  expect(h).not.toContain(`data-testid="mh-live-now"`);
  expect(h).not.toContain(`data-testid="mh-next-up"`);
});
it("live: the Live-now rail holds one MatchCard per live match WITH team names (the W0 defect), is a focusable named scroll region, and the status line counts them", () => {
  const h = render(docLive2);
  expect(h).toMatch(/data-testid="mh-live-now"[^>]*role="list"[^>]*tabindex="0"[^>]*aria-label="/);
  expect(h.match(/data-testid="mh-live-now-card-/g)?.length).toBe(2);
  expect(h).toContain("Southend Queens");
  expect(h).toContain("Live now: 2 matches");
});
it("next up: the three earliest upcoming matches only (a fourth exists), then the first three rows of each table with the full-division link", () => {
  const h = render(docUpcoming4);
  expect(h.match(/data-testid="mh-next-up-card-/g)?.length).toBe(3);
  expect(h.match(/data-testid="mh-table-row-/g)?.length).toBe(3);   // one table, preview 3
  expect(h).toContain(`data-testid="mh-table-preview-t8-s1-overall-full"`);
});
it("register CTA only when registration is open (positive pair); sponsors slot renders where given", () => { /* … */ });
```

- [ ] **Step 2: Run — failures.** **Step 3: Implement `OverviewTab`** — `const status = landingStatus({ matches: doc.matches, divisions: doc.divisions.length, startsOn: doc.info.startsOn, endsOn: doc.info.endsOn, now: new Date(now) })`; `<p data-testid="mh-status" data-kind={status.kind}>` text per kind (`live` → `plural(dict, "landing.status.live", n, locale)`; `next` → `t(dict, "landing.status.next", { when: `${fmtDate(tz, at)} ${fmtTime(tz, at)}` })`; `dates` → `landing.status.dates`/`datesFrom`; `finished`; `empty`). Sections, each rendered ONLY when it has content: `mh-live-now` (`<ul role="list" tabIndex={0} aria-label className="flex gap-3 overflow-x-auto pb-1 max-md:-mx-4 max-md:px-4">` of `<li className="min-w-[260px] shrink-0 max-w-[320px]" data-testid={`mh-live-now-card-${id}`}><MatchCard compact …/></li>`), `mh-next-up` (three earliest `upcoming`, `grid gap-2 md:grid-cols-3`), `mh-tables` (each `StandingsTableView preview={3} testid={`mh-table-preview-${view.id}`}` — its `-full` link goes to the Table TAB via `onOpenTab("table")` for the hub? No: keep the doc's `fullHref` (the division page) — the tab is one tap away on the rail), register CTA (`mh-register`, `min-h-11`), `descriptionSlot`, `sponsorsSlot`.

- [ ] **Step 4: Failing root tests**:

```tsx
it("renders only the tabs the document lists — no Stats tab without leaders (positive pair: Teams present)", () => {
  const h = renderToStaticMarkup(<CompetitionLanding initial={hubDoc({ leaders: [], teams: [team("e1", "A", null, null)] })} dict={en} locale="en" />);
  expect(h).not.toContain(`data-testid="mh-tab-stats"`);
  expect(h).toContain(`data-testid="mh-tab-teams"`);
  expect(h).toContain(`data-testid="mh-tab-panel-overview"`);   // first tab is active at first paint
  expect(h).toContain(`data-testid="mh-root"`);
});
it("the gallery slot is never rendered in W2, even if a document claimed it", () => { /* doc.tabs includes "gallery" → not in the rail */ });
it("a poll that changes the document re-renders the active tab in place (island harness): a new live match appears in the Live-now rail without navigation", async () => { /* renderIsland + stubInterval + stubFetch, assert text before/after; window.location untouched */ });
```

- [ ] **Step 5: Run — failures.** **Step 6: Implement `CompetitionLanding`** — `const { doc, transport } = useLiveCompetition({ orgSlug: initial.orgSlug, competitionSlug: initial.competitionSlug, initial, realtime: initial.realtime })`; `manualTab` state + `onChange` with `history.replaceState(…?tab=…)` (W1 root `:70-79`); the INITIAL tab comes from `window.location.search` read in a `useEffect` after mount (never on the server — ISR contract), falling back to `doc.tabs[0]`; `active = manualTab && doc.tabs.includes(manualTab) ? manualTab : doc.tabs[0]`; `tabs = doc.tabs.filter((id) => id !== "gallery").map((id) => ({ id, label: t(dict, `landing.tab.${id}`) }))`; `now` from `useNow()`; panel switch over `active` rendering the six tab components with `sponsorsSlot`/`descriptionSlot`/`shareSlot` handed to Overview and Info.

- [ ] **Step 7: Run — green.** Mutant: render every tab regardless of `doc.tabs` → the presence test reds. **Step 8: Commit** — "ui(matches-hub): Overview tab (status ladder, Live-now rail with names, next up, table previews) and the CompetitionLanding root".

---

### Task 12: Competition page wiring, sponsors board, metadata, regression on the old grid

**Files:**
- Create: `apps/web/src/components/public-site/sponsors-board.tsx` (server) — the board lifted verbatim from `[competitionSlug]/page.tsx:272-412`, every literal through `t(dict, …)` (`landing.sponsors`, `landing.presentedBy`, `landing.partners`).
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx` (whole body; keep `:20-26` ISR exports byte-identical).
- Modify: `apps/web/src/components/share-bar.tsx:23-92` — optional `labels?: { share: string; whatsapp: string; whatsappAria: string; copy: string; copied: string }` with the current English as defaults.
- Test: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/__tests__/page.test.tsx`

- [ ] **Step 1: Failing page tests** (stub the data layer the way the fixture page test does, `fixtures/[fixtureId]/__tests__/page.test.ts:15-40`):

```tsx
const data = vi.hoisted(() => ({ getPublicCompetition: vi.fn(), getPublicCompetitionHub: vi.fn() }));
vi.mock("@/server/public-site/data", () => ({ getPublicCompetition: data.getPublicCompetition }));
vi.mock("@/server/public-site/competition-hub", () => ({ getPublicCompetitionHub: data.getPublicCompetitionHub }));
vi.mock("@/server/usecases/sponsors", () => ({ resolveSponsors: vi.fn(async () => []) }));
vi.mock("@/server/usecases/registrations", () => ({ publicRegistrationInfo: vi.fn(async () => ({ divisions: [] })) }));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn(async () => false) }));
vi.mock("@/lib/prose", () => ({ renderProse: vi.fn(async (s: string) => `<p>${s}</p>`) }));
const OLD_ENGLISH = ["Divisions", "No divisions published yet.", "Register now", "Live now", "Present ▸", "Sponsors", "Presented by", "Partners", " live now", "entrant", "division"];

const render = async (locale: string) => {
  data.getPublicCompetition.mockResolvedValue(shell(locale)); data.getPublicCompetitionHub.mockResolvedValue(hubDoc({ locale }));
  const { default: Page } = await import("../page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c" }) }));
};
it("renders the landing root and the rail; the old divisions grid is GONE (regression) — positive: the hero still carries the competition name and the share bar", async () => {
  const h = await render("en");
  expect(h).toContain(`data-testid="mh-root"`); expect(h).toContain(`data-testid="mh-tab-overview"`);
  expect(h).not.toMatch(/<h2[^>]*>Divisions<\/h2>/);
  expect(h).toContain(`data-testid="mh-hero"`); expect(h).toContain("Copy link");
});
for (const locale of ["es", "fr", "nl"]) it(`${locale}: no old English literal survives`, async () => { const h = await render(locale); for (const s of OLD_ENGLISH) expect(h, s).not.toMatch(new RegExp(`>${s}<`)); });
it("generateMetadata: title and description from the dictionary in the org locale; unlisted → noindex", async () => { /* … */ });
```

- [ ] **Step 2: Run — failures.** **Step 3: Implement the page**: `const [data, hub] = await Promise.all([getPublicCompetition(...), getPublicCompetitionHub(...)])`; 404/redirect as today (`:58-62`); `locale = toLocale(org.default_locale)`, `dict = await getDictionary(locale, "public")`; hero `<section data-testid="mh-hero">` keeps the court slab (`:95-179`) with `t()` for every literal, chips via `plural(dict, "landing.divisions", n, locale)` etc., the live chip via `plural(dict, "landing.liveCount", hub.matches.filter(live).length, locale)` (derived from the hub, not `liveNow.length`), `ShareBar labels={…}`, `Present` link `mh-present`, register CTA `mh-hero-register` when `hub.info.registrationOpen`; then `<CompetitionLanding initial={hub} dict={dict} locale={locale} sponsorsSlot={<SponsorsBoard sponsors tiered dict />} descriptionSlot={competition.description ? <CompetitionProse html={await renderProse(...)}/> : null} />`. `generateMetadata`: `title` unchanged shape; `description: competitionMetaDescription(...)` stays (pin whether it hardcodes English — `lib/public-meta.ts:6`; if it does, route it through the dictionary here). The `liveNow` rail and the divisions grid are deleted from this file.

- [ ] **Step 4: Run — green; then `cd <worktree>/apps/web && pnpm exec vitest run src/lib/__tests__/public-isr-contract.test.ts "src/app/(public)/shared" --reporter=json --outputFile=/tmp/spx-w2-t12.json`** — the ISR contract must still pass. **Step 5: Commit** — "public(competition): the competition page is the landing — hero i18n'd, live document rendered server-side, sponsors board extracted; old divisions grid removed".

---
### Task 13: The division page — rail, MatchCard schedule, phone standings, badges, i18n

**Files:**
- Create: `apps/web/src/components/public-site/division-landing.tsx` (client root), `division-schedule.tsx` (client)
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx` (whole body; keep `:29-35` ISR exports byte-identical; `championId` now via `divisionChampion` — Task 4)
- Delete: `apps/web/src/components/public-site/tabs.tsx` (only consumer was this page — `grep -rl "public-site/tabs\"" apps/web/src` returned one file)
- NOT touched: `components/public-site/schedule.tsx` (the embed widget at `app/embed/divisions/[id]/[widget]/page.tsx:80` keeps it — `/embed` is not `/shared`; recorded as a follow-up in `_INDEX.md`)
- Test: `apps/web/src/components/public-site/__tests__/division-schedule.test.tsx`; `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `getPublicDivision` (`data.ts:610`), `getPublicCompetitionHub` (Task 4), `useLiveCompetition`, `PublicTabRail`, `MatchCard` (Task 7), `StandingsTableView` (Task 2), `groupByDay` (Task 1), `Bracket`, `ResultsMatrix`, `SuspensionsStrip` (unchanged server components), `EntityLogo`.
- Produces:
  ```ts
  export function DivisionSchedule(props: { matches: HubMatchT[]; dict: PublicDict; locale: Locale; now: number; calendarHref: string; entrantOptions: { id: string; name: string }[] }): JSX.Element;   // entrant <select mh-div-filter>, Day/Round toggle (mh-div-view-day|round, aria-pressed), calendar link mh-div-calendar, day/round sections, MatchCard rows (showDivision=false), empty mh-div-schedule-empty
  export function DivisionLanding(props: { divisionId: string; initial: CompetitionHubDocT; dict: PublicDict; locale: Locale; calendarHref: string; entrantOptions: { id: string; name: string }[]; standingsExtras: ReactNode; entrantsPanel: ReactNode; championBanner: ReactNode }): JSX.Element;  // "use client"; tabs schedule|standings|entrants (present by content), testids mh-div-tab-*, panels mh-div-tab-panel-*
  ```

- [ ] **Step 1: Failing schedule tests**: (a) EMPTY → `mh-div-schedule-empty`, no Day/Round toggle, calendar link still present (a subscription is useful before the draw); (b) day view groups by venue day with the zone caption; round view groups by `round_no` with `division.round` headers — the toggle is offered only when some match has a time (`schedule.tsx:165-167` rule); (c) the entrant filter narrows by either side and the calendar href gains `?entrant=`; (d) rows are `MatchCard`s (`mh-match-{id}`) without the division chip.
- [ ] **Step 2: Run — failures.** **Step 3: Implement `DivisionSchedule`** — the `Schedule` component's state machine (`schedule.tsx:156-196`) over `HubMatchT[]`: entrant filter on `header.sides[i].entrantId`; `mode = anyScheduled ? view : "round"`; groups via `groupByDay` (day) or `roundNo` (Task 1.s `HubMatch.roundNo`, filled from `f.round_no` in Task 4); labels via `t(dict, "division.round", { n })`; every literal (`schedule.tsx:126,188,202,210,245`: "TBD", "Time TBD", "Show matches for", "All entrants", "Add to calendar", "Round", "Live", "Ended") from the dictionary.
- [ ] **Step 4: Failing page tests** (stub `getPublicDivision` + `getPublicCompetitionHub` + `publicSuspensions` + `resolveModule`; render at `en`/`es`): the rail has `mh-div-tab-schedule|standings|entrants` only for panels with content (a division with no fixtures has no Schedule tab — but DOES keep Entrants); the Standings panel renders `StandingsTableView` (`mh-table-{id}`) plus the untouched `Bracket`/`ResultsMatrix`/`SuspensionsStrip` slots; entrants carry `EntityLogo` badges (`mh-div-entrant-{id}`) and member links only when `person_id` (consent — `page.tsx:274-284` rule kept); the champion banner reads `division.champion`; in `es` no old literal (`"Schedule", "Standings", "Entrants", "Champion", "Results grid", "Standings appear after the first results.", "No entrants yet.", "Seed", "Present ▸"`) survives; `generateMetadata.description` comes from `division.metaDescription`.
- [ ] **Step 5: Run — failures.** **Step 6: Implement the page** — load `data` and `hub` in parallel; `matches = hub.matches.filter((m) => m.divisionId === division.id)`, `tables = hub.tables.filter(...)`; build `entrantOptions` from `entrants` (masked names, sorted); keep `slotLabels`/`lookup` logic only where the server slots still need it (the bracket); render `<div style={publicThemeStyle(...)}>` nav + H1 + meta chips (format chip from `hub.divisions.find(id).formatLine` via `t()`, falling back to `variant_key`) + `<DivisionLanding …>`. `DivisionLanding`: `useLiveCompetition` on the hub doc (the division slice is re-derived from every new document — R10 for schedule rows AND standings); tabs by presence: schedule when `matches.length`, standings when `tables.length || standingsExtras`, entrants always when `entrantsPanel`; `?tab=` handled as in Task 11; `PublicTabRail testidPrefix="mh-div"`.
- [ ] **Step 7: Run — green** (both files and the whole `public-site/__tests__`). Mutant: make `DivisionSchedule` ignore the entrant filter → test (c) reds. **Step 8: Delete `tabs.tsx`**, run `cd <worktree>/apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -a "tabs\"" ` (scoped read; expected no output). **Step 9: Commit** — "public(division): rail with ?tab=, MatchCard schedule and phone standings from the live document, entrant badges, i18n; tabs.tsx removed".

---

### Task 14: The player page — per-match performances from W1's fold, i18n

**Files:**
- Create: `apps/web/src/server/public-site/public-player-matches.ts`
- Create (if absent, P8): `apps/web/src/server/public-site/__tests__/cricket-ledger.ts` — a copy of `packages/engine/src/sports/cricket/__tests__/scorecard-ledger.ts`'s `scriptLedger` (test scaffolding may be copied; the rule is about product code)
- Modify: `apps/web/src/server/public-site/data.ts:778-946` — `getPublicPlayer` returns `matches: PlayerMatchLine[]`; cache key `["pub-player-v15", …]` → `"pub-player-v16"` (`:930`; the comment there explains why the key is retired rather than waited out)
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx` (keep `:10-17` ISR exports byte-identical)
- Test: `apps/web/src/server/public-site/__tests__/public-player-matches.test.ts` (DB-backed), `players/[personId]/__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `deriveCricketScorecard`, `ScorecardInput` (`@seazn/engine/sports/cricket`, `index.ts:68` — P7), `BattingLine`/`BowlingLine` (`scorecard-types.ts`), `resolveModule`, `resolveFixtureCfg` (`server/engine-db`, `fixture-cfg.ts:39`), `loadLineupPair(tx, fixtureId, home, away)` (`engine-db/lineups.ts:64` — needs a `TransactionSql`: wrap the read in `sql.begin(async (tx) => …)`), the `score_events` SELECT shape (`engine-db/fold.ts:67-70`), `maskPublicEntrantNames` (`data.ts:510`), `lineups` table (`V215__lineups.sql`).
- Produces:
  ```ts
  export interface PlayerMatchLine { fixtureId: string; href: string; divisionName: string; divisionSlug: string; scheduledAt: string | null; tz: string; opponentName: string; line: string; result: "won" | "lost" | "drawn" | "live" | null }
  export async function readPlayerMatchLines(sql: Sql, args: { personId: string; competitionId: string; orgSlug: string; compSlug: string; locale: Locale }): Promise<PlayerMatchLine[]>;   // newest first; EMPTY → []
  ```

- [ ] **Step 1: Failing DB-backed test** — seed a cricket division (as Task 3), two entrants with rostered persons, one fixture; post a scripted two-innings ledger through `appendEvent` (the `consent.test.ts` helpers reach the usecases directly — or insert `score_events` rows built by `scriptLedger` with `recorded_at`/`recorded_by` set), then:

```ts
it("EMPTY: a person with no fixtures → []", async () => { expect(await readPlayerMatchLines(sql, { personId: unusedPersonId, ... })).toEqual([]); });
it("cricket: the line is DERIVED from the same fold the match centre shows — '{runs} ({balls}) & {wickets}/{runs conceded}' — and the result names the side", async () => {
  const [line] = await readPlayerMatchLines(sql, { personId: h1, competitionId, orgSlug, compSlug, locale: "en" });
  const card = deriveCricketScorecard({ events, cfg, lineups });                      // the test's OWN fold of the same ledger: one authority, two readers
  const bat = card.innings.flatMap((i) => i.batting).find((b) => b.person === h1)!;
  const bowl = card.innings.flatMap((i) => i.bowling).find((b) => b.person === h1);
  expect(line!.line).toBe(bowl ? `${bat.runs} (${bat.balls}) & ${bowl.wickets}/${bowl.runs}` : `${bat.runs} (${bat.balls})`);
  expect(line!.href).toBe(`/shared/${orgSlug}/${compSlug}/${divSlug}/fixtures/${fixtureId}`);
  expect(["won", "lost", "drawn"]).toContain(line!.result);
});
it("the opponent's name is the consent-masked entrant display name (a non-team entrant with an opted-out member masks)", async () => { /* … */ });
it("a non-cricket fixture carries the fixture's headline as the line", async () => { /* football seed: '2 – 1' */ });
```

- [ ] **Step 2: Run** (`numTotalTests` ≥ 4 with `DATABASE_URL`; 0 means skipped). **Step 3: Implement** — one query for the person's fixtures: `select f.id, f.division_id, f.stage_id, f.status, f.outcome, f.scheduled_at, f.home_entrant_id, f.away_entrant_id, f.config_snapshot, m.summary, d.slug, d.name, d.sport_key, d.module_version, d.config, d.youth, d.player_name_display, coalesce(ss.tz, o.timezone, 'UTC') as tz from lineups l join fixtures f on f.id = l.fixture_id join public_divisions_v pd on pd.id = f.division_id join divisions d on d.id = f.division_id left join schedule_settings ss on ss.division_id = d.id join organizations o on o.id = d.org_id left join match_states m on m.fixture_id = f.id where l.person_id = ${personId} and pd.competition_id = ${competitionId} and f.status in ('in_play','decided','finalized') order by f.scheduled_at desc nulls last`; per cricket fixture inside `sql.begin`: events (fold.ts:67 shape, `resolveVoids` applied), `cfg = resolveFixtureCfg(config_snapshot, d.config, stage.config)` parsed by the module's `configSchema`, `lineups = loadLineupPair(tx, …)`, `card = deriveCricketScorecard({ events, cfg, lineups })`; the line: `t(dict, "player.line.batting", { runs, balls })` + (bowling ? ` & ` + `t(dict, "player.line.bowling", { wickets, runs })` : "") — via `player.line.cricket` when both; a person who neither batted nor bowled → `"—"` (never dropped: the appearance is the fact). Other sports: `m.summary?.headline ?? "—"`. `result`: `in_play` → live; `outcome.winner` equals the person's entrant → won; the other side → lost; decided with no winner → drawn. Opponent: `maskPublicEntrantNames([...], d)` on the other side's entrant (query `public_entrants_v` for the two ids).

- [ ] **Step 4: Failing page test** (stub `getPublicPlayer`): `mh-player-matches` list with one `mh-player-match-{fixtureId}` link per line, newest first; EMPTY → `player.matches.empty` copy (the section still renders — the player exists, the record is empty); headings `player.inThisCompetition`/`player.stats`/`player.matches` in `es`; `careerLabel`/stat labels untouched (they are already localised server-side, `data.ts:897-905`). **Step 5: Run — failures. Step 6: Implement** (`getDictionary(toLocale(org.default_locale), "public")` in the page; `fmtDate(tz, scheduledAt)` per row; result chip classes: won `bg-emerald-50 text-emerald-700`, lost `bg-zinc-100 text-zinc-600`, live the pulse pill). **Step 7: Run — green.** Mutant: swap won/lost → the result assertion reds (add one decided fixture the person LOST to the seed so both branches are witnessed). **Step 8: Commit** — "public(player): per-match performances from the W1 cricket fold (one authority), i18n; player cache key v16".

---
### Task 15: The org home — a truthful chip from live fixtures, a polling chip island (R10), locale dates, layout tagline and footer

**Files:**
- Modify: `apps/web/src/lib/public-site.ts:400-421` — `competitionChip(status, inPlay = 0)` and `chipLabelKey(status, inPlay = 0)`
- Modify: `apps/web/src/server/public-site/data.ts:383-405` — `getPublicOrg` competitions gain `in_play: number`
- Modify: `apps/web/src/server/usecases/public.ts` — `publicOrgLive(orgSlug)`; `scoring.ts:491-520` also deletes `pub:v1:org-live:{orgId}` (the row query there already joins `competitions c` — add `c.org_id`)
- Create: `apps/web/src/app/api/v1/public/orgs/[orgSlug]/live/route.ts` (+ `openapi.ts` entry, `openapi:gen`), `apps/web/src/components/public-site/org-live-chips.tsx`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/page.tsx:46-74,178-206` and `layout.tsx:96-114`
- Test: `apps/web/src/lib/__tests__/public-site-chip.test.ts` (extend), `apps/web/src/components/public-site/__tests__/org-live-chips.test.tsx`, `apps/web/src/app/(public)/shared/[orgSlug]/__tests__/page.test.tsx`, the route test

- [ ] **Step 1: Failing chip tests** (extend `public-site-chip.test.ts`):

```ts
it("a competition with a match in play is ON NOW whatever its status says (the W0 'UPCOMING while live' defect) — order-differential vs status", () => {
  expect(competitionChip("published", 1)).toBe("on-now");
  expect(chipLabelKey("draft", 2)).toBe("chip.onNow");
});
it("with nothing in play the status ladder is unchanged (positive pair; the existing five cases still hold)", () => {
  expect(competitionChip("published", 0)).toBe("upcoming");
  expect(competitionChip("completed", 0)).toBe("finished");
});
```

- [ ] **Step 2: Run — failures. Step 3: Implement** — `if (inPlay > 0) return "on-now";` as the FIRST rung; `getPublicOrg`'s competitions query adds `(select count(*)::int from public_fixtures_v f join public_divisions_v d on d.id = f.division_id where d.competition_id = c.id and f.status = 'in_play') as in_play`; `publicOrgLive(orgSlug)` = `cachedFor(\`pub:v1:org-live:${org.id}\`, 15, () => sql\`select c.id, (…same subquery…) as in_play from public_competitions_v c where c.org_id = ${org.id} and c.visibility = 'public'\`)` → `{ competitions: [{ id, in_play }] }`; the route mirrors Task 5; `OrgLiveChips({ orgSlug, initial: {id,status,in_play}[], dict })` — `"use client"`, polls `fetchOrgLive(orgSlug)` every `HUB_POLL_MS` while any `in_play > 0`, else `HUB_IDLE_POLL_MS`, and renders `statusChip(competitionChip(status, in_play))` (the JSX lifted from `page.tsx:51-74`) as `<span data-testid={`mh-org-chip-${id}`} data-chip={chip}>` — the page renders the chip INSIDE each competition card by placing `<OrgLiveChips>` per card? No — ONE island per page (R10 "one subscription per page"): the island renders the whole competitions `<ul>` (cards are links + chip + dates), taking `competitions` and `dict` as props; dates via `fmtDate("UTC", starts_on, { day: "numeric", month: "short", year: "numeric" })` in the org locale (replace `toLocaleDateString("en-GB")` at `:46-47`). `layout.tsx`: `t(dict, "layout.tagline")` for `:97,101`; footer `t(dict, "layout.poweredBy", { brand: "Seazn Club" })` at `:112` (the `AttributionLink` stays); `dict = await getDictionary(toLocale(org.default_locale), "public")` in the layout.

- [ ] **Step 4: Failing island + page + route tests**: island — EMPTY competitions → `org.empty`? no: the page keeps its existing `empty` copy (`:175`), the island receives `[]` and renders nothing; a poll that flips `in_play` 0→1 re-renders the chip to `on-now` in place (island harness); page — in `es` none of `["Tournament hub", "Competitions", "About", "Live scores · Schedules · Standings", "Powered by Seazn Club"]` survive and `mh-org-chip-` appears once per competition; route — envelope + cache header. **Step 5: Run — failures. Step 6: Implement. Step 7: Run — green.** Mutant: drop the `inPlay > 0` rung → the chip test reds. **Step 8: Commit** — "public(org): status chip derived from live fixtures, polling chip island, locale dates, layout tagline and footer through the dictionary".

---

### Task 16: i18n sweep leftovers and the zero-English regression across every `/shared` page

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/news/[postSlug]/page.tsx:141` — `ShareBar labels={shareLabels(dict)}` (the news page already has a `public` dict — pin where it loads it); `[competitionSlug]/[divisionSlug]/page.tsx` — the `ShareButton` (`:327-331`) is replaced by the same `ShareBar` the competition page uses (R8: the share BAR on every page; `ShareButton` stays for other consumers).
- Create: `apps/web/src/components/public-site/share-labels.ts` — `shareLabels(dict): ShareBarLabels` (the five `share.*` keys).
- Test: `apps/web/src/lib/__tests__/public-english-sweep.test.tsx`

- [ ] **Step 1: Failing sweep test** — renders EVERY `/shared` page's default export with stubbed data (the per-page stubs from Tasks 12–15 lifted into `apps/web/src/app/(public)/shared/__tests__/_stubs.ts`) in `es`, `fr`, `nl`, and asserts a fixed list of the OLD English literals is absent from the HTML while the SAME render in `en` CONTAINS at least one of them (positive pair — proves the page rendered the section at all):

```tsx
const PAGES = [
  { name: "org home", load: () => import("../../app/(public)/shared/[orgSlug]/page"), params: { orgSlug: "o" } },
  { name: "competition", load: () => import("../../app/(public)/shared/[orgSlug]/[competitionSlug]/page"), params: { orgSlug: "o", competitionSlug: "c" } },
  { name: "division", load: () => import("../../app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page"), params: { orgSlug: "o", competitionSlug: "c", divisionSlug: "d" } },
  { name: "player", load: () => import("../../app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page"), params: { orgSlug: "o", competitionSlug: "c", personId: "00000000-0000-4000-8000-000000000001" } },
  // fixture page: included only once W1 Task 14 has landed (P6) — its literals: "Live", "Ended", "Discipline", "Goals by period", "Winner:", "Share on WhatsApp"
];
const OLD_ENGLISH = ["Tournament hub", "Competitions", "Live scores · Schedules · Standings", "Powered by Seazn Club", "Divisions", "Register now", "Live now", "Present ▸", "Sponsors",
  "Schedule", "Standings", "Entrants", "Champion", "Results grid", "Standings appear after the first results.", "No entrants yet.", "Add to calendar", "All entrants", "Time TBD",
  "In this competition", "No current squad entries.", "Stats", "Share on WhatsApp", "Copy link", "Copied ✓"];
for (const p of PAGES) {
  it(`${p.name}: en renders at least one of the literals (the page is not empty)`, async () => { expect(OLD_ENGLISH.some((s) => (await renderPage(p, "en")).includes(s))).toBe(true); });
  for (const locale of ["es", "fr", "nl"]) it(`${p.name} ${locale}: zero old English literals`, async () => {
    const html = await renderPage(p, locale);
    for (const s of OLD_ENGLISH) expect(html, `${p.name}/${locale}: "${s}"`).not.toMatch(new RegExp(`>\\s*${escapeRegExp(s)}\\s*<`));
  });
}
```

- [ ] **Step 2: Run — expect reds naming each surviving literal.** **Step 3: Fix each** by routing it through `t(dict, …)` (all keys already exist from Task 6; any new one goes into `hub-dictionary.test.ts`'s list FIRST). **Step 4: Run — green; `npm run i18n:check` clean.** Mutant: hardcode `"Copy link"` back into `ShareBar` ignoring `labels` → the sweep reds in three locales. **Step 5: Commit** — "i18n(public): share bar labels, division share bar, and a zero-English regression sweep over every /shared page in es/fr/nl".

---
### Task 17: Walkthrough v2, the seven-width scan per tab, mobile.spec routes, smoke checks

**Files:**
- Modify: `apps/web/e2e/walkthrough/spectator-public.spec.ts` — a new `test.describe("W2 — competition landing", …)` block reusing W1's seed (P20: `seedShort`, `playInnings`, `postEvent`, `controlSet` — import from wherever W1's Task 15 left them; if W1 has not merged, copy `controlSet` from `w0-spectator-capture.spec.ts:266-289` into `e2e/spectator-kit.ts` and note it for Task 19)
- Modify: `apps/web/e2e/mobile.spec.ts:1211-1227` — two routes added to the public-surfaces list: `` `/shared/${orgSlug}/${compSlug}?tab=teams` `` and `` `/shared/${orgSlug}/${compSlug}?tab=info` `` (P17: that seed has entrants but no fixtures, so Matches/Table/Stats are absent there by R4 — the seven-width scan for THOSE tabs runs inside the walkthrough below)
- Modify: `scripts/smoke.ts` — three `check`s inside `plgGrowthSuite` after `:4652`:
  ```ts
  check("W2 landing renders the hub root and rail", proShared.status === 200 && proShared.body.includes('data-testid="mh-root"') && proShared.body.includes('data-testid="mh-tab-overview"'));
  check("W2 landing no longer renders the old divisions grid", !/<h2[^>]*>Divisions<\/h2>/.test(proShared.body));
  const hub = await raw(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${proComp.slug}/hub`);   // pin `raw`'s signature near smoke.ts:12630
  check("W2 hub document: EMPTY competition → overview + info only, zero matches", hub.status === 200 && JSON.stringify(hub.data?.tabs) === '["overview","info"]' && hub.data?.matches?.length === 0);
  ```

**The W2 walkthrough, in order (R7 + R10 + R1 + R11):**
1. `beforeAll`: reuse W1's seeded competition (one cricket division, 8 overs, one finished + one live match; one football division with a decided match and two upcoming; one tennis division). Record `paths.competition`, `paths.division`, `paths.player`.
2. **Open the competition page in an anonymous 320×568 context FIRST** (`browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true })`, cookie bypass as the W0 harness `armCookieBypass`): assert `mh-root`, print `data-transport`; the rail lists exactly `overview matches table stats teams info` (`getByRole("tab")` names) — Stats is present only because W1's cricket ledger produced `player_stat_snapshots`; print the list.
3. Overview: `mh-status` reads `Live now: 1 match` (derive the count from the seed, never a literal); `mh-live-now` holds the live fixture's card WITH both team names visible (`toContainText(homeName)`, `toContainText(awayName)`); `mh-next-up` has ≤ 3 cards.
4. Matches: click `mh-tab-matches`; `mh-filter-live` is `aria-pressed="true"` (VALUE, not presence); the live card `mh-match-{liveFixtureId}` is visible; click `mh-filter-completed` → the finished match's `mh-match-result` reads the SAME sentence the match centre's `mc-status-line` shows (open the fixture page in a second tab and compare — one authority, two readers); click `mh-filter-upcoming` → day headers exist and every header's `times in …` caption is absent when the venue zone equals the browser's (the anonymous context's `timezoneId` is set to the seed's venue zone for one run and to `Pacific/Auckland` for another — both states witnessed).
5. Table: click `mh-tab-table`; at 320 the visible column set of the cricket table is `# Team P W L Pts` (assert `mh-table-more-*` visible and the `gd`/`nrr` `th` NOT visible via `toBeVisible()`); tap `mh-table-more-*` → the hidden columns become visible and the region scrolls (`scrollWidth > clientWidth` on the `role=region` box, which has `tabindex=0`); the `-full` link points at `?tab=standings`.
6. Stats: click `mh-tab-stats`; `mh-leaders-{t8}-runs` lists ≤ 5 rows; the top row's value equals the runs of the batter the seed made top scorer (derive from `seed.inn1`/`inn3` totals — the harness records per-batter runs; if it does not, add that to the seed's return); click the top leader → the player page: `mh-player-matches` holds `mh-player-match-{fixtureId}` for the finished match whose line matches `/^\d+ \(\d+\)( & \d+\/\d+)?$/`; `anon.goBack()`.
7. Teams → `mh-team-*` count equals the seed's entrant count across divisions; click one → the division page opens at `?tab=entrants` with `mh-div-tab-entrants` selected (the VALUE the control opens at).
8. Division page: `mh-div-tab-schedule` → rows are `mh-match-*`; `mh-div-tab-standings` → `mh-table-*` present; the champion banner absent while the division is unfinished (positive: present on a division the seed finishes — the football one if all three matches are decided; otherwise record the state that was reached).
9. **R10 — with the competition page OPEN on the Matches tab, Live filter**: read the live card's `mh-match-side-*` score text; in the signed-in `page` post `cricket.ball` events through the API for one over (or, if W1's tapped over runs in this same spec, order this block to run while W1 taps); `await expect(anon.getByTestId(`mh-match-${liveFixtureId}`)).not.toContainText(before, { timeout: HUB_POLL_MS + 5_000 })` and `expect(anon.url()).toBe(urlBefore)`; then `anon.getByTestId("mh-tab-overview").click()` and assert `mh-live-now-card-{liveFixtureId}` shows the new score too (same document, both surfaces). Then post the decisive events to END the live cricket match: within one interval the card leaves the Live filter (chip count 0 → the filter auto-advances? NO — the filter stays where the user put it; the empty-filter copy `mh-matches-empty-filter` appears — assert THAT, it is the designed behaviour) and the Table tab's cricket standings row for the winner shows `played` incremented (read the cell before and after — standings after a result lands, R10).
10. Repeat steps 2–5's assertions in a fresh 1280×800 anonymous context; **control-set diff**: `controlSet()` at 320 vs 1280 on Overview, Matches, Table — the ONLY differences allowed are `mh-table-more-*` (phone-only disclosure, `md:hidden`); print both lists.
11. **Seven widths per tab** (the mobile-spec seed cannot reach these tabs, P17): for each of 320/360/375/390/430/768/834 set the viewport, for each tab click it and `expectNoHorizontalScroll(anon)`; print `tab@width` beside each pass.
12. Axe at 320 on Overview and Matches (`new AxeBuilder({ page: anon }).withTags(["wcag2a", "wcag2aa"]).analyze()` as `mobile.spec.ts:1391`): zero `serious`/`critical`; the rails' `scrollable-region-focusable` must be clean.
13. Screens: `screenshotAtWidths(anon, testInfo, "w2-<tab>-<state>")` for every tab at 320/768/1280, live and after the result — into the test-results dir for Task 18's R11 read.
14. `afterAll` (never `finally`): close contexts; nothing shared to thaw.

- [ ] **Step 1: Write the block** (~250 lines, real code following the numbered steps). **Step 2: Run against a fresh env**: `seazn-env up --label spx --server` from the worktree, `eval` its env, `cd apps/web && PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test e2e/walkthrough/spectator-public.spec.ts --project=walkthrough --workers=1 --reporter=json > /tmp/spx-w2-wt.json`; judge on the JSON; take the env down. A blown budget reports as a data defect — check the poll's own timeout before chasing a count (AGENTS.md #20). **Step 3: Run the WHOLE `mobile.spec.ts`** across the seven projects (never `-g`; a serial file's red count is a floor). **Step 4: Smoke**: `SMOKE_BASE=… npm run test:smoke` → the three new checks print PASS with what they saw. **Step 5: Commit** — "e2e(spectator): walkthrough v2 — landing tabs at 320/1280 with the control-set diff, R10 in place on the hub card, Live-now rail and table, seven-width scan per tab; mobile routes; smoke checks".

---

### Task 18: Gates, review loop, R11 visual sign-off, programme index

- [ ] **Step 1: Orchestrator runs the full gate** from the worktree, quiescent tree: `seazn-env gate --label spx` (lint + typecheck; judge on the `Cached:` line — `rtk` prints tsc clean while tsc exits 1); `cd <worktree>/apps/web && pnpm exec vitest run --reporter=json --outputFile=/tmp/spx-w2-web.json`; paste `numTotalTests`/`numFailedTests`/`numFailedTestSuites` and confirm `.testResults[].name` paths are under the worktree and the total is ≥ the pre-wave total plus the tests this plan added. `npm run openapi:gen && /usr/bin/git status --porcelain openapi` prints nothing; `npm run i18n:check` clean.
- [ ] **Step 2: Reviewer dispatch** on the whole branch (Opus; brief = this plan + `_RULES.md` + spec §W2 + competition-desk `_RULES.md`; output = a gap list). Fix inline; re-review until clean. **Run the final whole-branch review even if every task review was clean** (the competition-desk W1 lesson).
- [ ] **Step 3: R11 sign-off** — the controller READS every screenshot from Task 17 (Overview live/final, Matches ×3 filters, Table collapsed/expanded, Stats, Teams, Info; division Schedule/Standings/Entrants; player; org home — each at 320/768/1280) and writes the per-screen verdict table into the spec ("W2 sign-off — per-screen verdicts"): alignment and baselines, spacing rhythm, pill sizes consistent with W1's match centre (same `px-4 py-1.5` pills, same court slab), the 43-character entrant name truncating with a `title`, contrast, icon alignment, tap targets ≥ 44 px by `elementFromPoint` on the filter chips and the table disclosure, overlaps, empty states (a competition with no divisions; a division with no fixtures; a player with no matches). Each row names what was SEEN. A cosmetic defect goes into ONE fix dispatch with the review findings — never parked.
- [ ] **Step 4: `_INDEX.md`** — W2 row → "PR #… open"; false premises found (P9's missing floor at minimum, plus anything Task 17 surfaced); mutants (Tasks 1–3, 7–8, 10–11, 13–16) with the test that killed each; the walkthrough's measured cost; the follow-ups: embed `schedule.tsx`/`standings-table.tsx` still English, W1 `TabRail` fold (Task 19), engine `leaderboards` declaration for ratio leaders. Fix the plan path in `W2-landing.md:4` (P2).
- [ ] **Step 5: Open the PR** only when the owner says so; e2e runs via `workflow_dispatch` with the PR number once it exists (e2e does not run on PRs; smoke does).

---

### Task 19 (optional, after W1 has merged): Fold W1's `TabRail` onto `PublicTabRail`

**Files:** Modify `apps/web/src/components/public-site/match-centre/tab-rail.tsx` to a wrapper: `export function TabRail({ tabs, active, onChange, dict }: TabRailProps) { return <PublicTabRail tabs={tabs.map((id) => ({ id, label: t(dict, `matchCentre.tab.${id}`) }))} active={active} onChange={onChange} ariaLabel={t(dict, "matchCentre.tabs.label")} testidPrefix="mc" />; }` — its existing tests (`__tests__/tab-rail.test.tsx`) must stay green unchanged (same DOM contract, P5). Also delete the `use-now.ts` copy if Task 7 made one. Skip and record in `_INDEX.md` if W1's file has moved on.

---

## Execution order

Sequential unless stated: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → (19)**. Parallel lanes with PROVABLY disjoint file sets, each in `isolation: "worktree"` and merged back before the next sequential task: {Task 2, Task 3} after Task 1; {Task 5, Task 6} after Task 4; {Task 8, Task 9, Task 10} after Task 7 (they share only Task 7's exports); {Task 14, Task 15} after Task 13 (Task 15 touches `data.ts:383-405`, Task 14 `data.ts:778-946` — disjoint ranges, but ONE file: run them sequentially if the reviewer prefers). Task 6 must land before any UI task's dictionary test runs. Tasks 17–18 are the orchestrator's.

## Self-review (done while writing)

- **Spec coverage (§W2)**: rail Overview·Matches·Table·Stats·Teams·Gallery slot·Info with presence rule → Tasks 1 (`deriveHubTabs`), 11; Overview (hero, status line, Live-now with names, next three, first three rows, register CTA, sponsors) → 11, 12; live in place, one subscription per page → 4 (caches + invalidation), 5, 7, 11, 13, 15, 17; Matches (all divisions, filter ladder empty-first, division chips, venue-day groups, the card, links to the match centre) → 1, 7, 8; Table (existing snapshots, 320 composition, long tail behind a disclosure, "Full division") → 2, 9; Stats (leaders from the existing snapshot folds, floor — recorded false premise P9, rows link to the player page only with consent) → 3, 10; Teams (badge_url / logo_path / monogram in team colour → Entrants tab) → 4, 10; Info (description, dates, venues, sponsors, registration state, .ics, share) → 4, 10, 12; division page (rail, MatchCard schedule, phone standings, badges) → 13; player page (per-match lines from W1's fold, consent-gated) → 14; i18n sweep (competition, division, LiveScore [W1], schedule, layout tagline; coverage assertion widened) → 6, 12–16; tests: unit (filter ladder empty-first 1; DST 1; leaders' declared keys 3; badge fallback 7/10), e2e walkthrough v2 with the control-set diff and R10 (17), smoke `mh-` markers (17), regression (zero English every page 16; old divisions grid gone 12); screens (17–18). Block-II findings: Live-now card without names → 11; org chip "UPCOMING" while live → 15; variant "T20" for 8 overs → 4 (`describeFormat`); "times in UTC" caption dropped when equal to the viewer's → 8. Gaps: none found. Deliberately out: `/embed` widgets (not `/shared`), the fixture page (W1), ratio leaders (P9).
- **Placeholders**: every test step carries code; implementation steps carry code or exact signatures; the only prose-described algorithms (Task 8's group rendering, Task 14's SQL) name every field and the file:line of the code they mirror.
- **Type consistency**: `CompetitionHubDocT`/`HubMatchT`/`TableViewT`/`TableRowT`/`TableColumnT`/`LeaderBoardT`/`LeaderRowT`/`TeamCardT`/`HubDivisionT`/`HubInfoT`/`CompetitionHubTabIdT` (Task 1) are the names used in Tasks 2–17; `HubMatch.roundNo` (Task 1 schema) is filled by Task 4 (`f.round_no`) and read by Task 13.s round view; `buildTableView(input: TableViewInput)` (Task 2) is what Task 4 calls; `readLeaderRows(sql, divisions)` / `buildLeaderBoards(args)` (Task 3) are what Task 4 calls; `useLiveCompetition({ orgSlug, competitionSlug, initial, realtime })` and `HUB_POLL_MS` (Task 7) are what Tasks 11, 13 and 15 use; `PublicTabRail({ tabs, active, onChange, ariaLabel, testidPrefix })` (Task 7) is what Tasks 11, 13 and 19 use; `MatchCard({ match, dict, locale, now, showDivision, compact })` (Task 7) is what Tasks 8, 11 and 13 render; `publicCompetitionHub(orgSlug, slug)` (Task 4) is what Task 5's route calls; `competitionChip(status, inPlay)` (Task 15) keeps its one-argument callers valid via the default.
