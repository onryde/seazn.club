# Stream overlay — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-05-stream-overlay-design.md` (owner-approved
  in chat 2026-09-05: design "I am ok with design", spec "approve"; committed
  `0781ba76d`, motion section `9ad0b9902`).
- **Design themes:** `_THEMES.md` (owner: "use frontedesign to tell all
  designthemes and add these to waves", 2026-09-05) — binding values at
  1920×1080 for both themes, the sport tokens, the slab, motion, phone floors
  and the panel; committed `0106f4d50`.
- **Resume state:** `_STATE.md` (owner: "commit and record everything in a
  dedicated state file so that when we start it knows", 2026-09-05).
- **Canvas:** https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901
  (artboards "A · Broadcast bar", "B · Corner bug", "A across sports", "B across
  sports", "Moments", "How fans see it on a phone", "What the club sets up",
  "Organiser console: Stream this match", "Same panel at 390").
- **Branch / worktree:** `feat/stream-overlay`, `.claude/worktrees/stream-overlay`,
  based on `997ad225b`.
- **Plans:** `../../plans/2026-09-05-stream-overlay-w1.md` (step one) and
  `../../plans/2026-09-05-stream-overlay-w2-moments.md` (moments; executes only
  after spectator W1 merges and its RE-PIN list is re-verified) — both being
  written by Fable agents (owner ruling 10 below); absent when this index was
  reshaped, so the wave prompts point at the paths and derive scope from the spec.
- **Waves:** W1 step one (`W1-step-one.md`) · W2 moments + cricket batter/bowler
  line (`W2-moments.md`). Two PRs.
- **Market reference the spec names:** CricHeroes' per-match "Score Ticker" for
  OBS/vMix, cricket only. Ruling by construction: every engine sport, one
  projection.
- **Related programmes:** spectator surface (`feat/spectator-surface`, W1 match
  centre in flight — owns the public page composition and the per-event template
  model W2 keys off) and competition desk W1 (`feat/fixture-console-redesign`,
  edits `components/v2/stages-panel.tsx` — PR1 rebases after it merges).

## Status (2026-09-05)

Programme steps:

| Step | State |
|---|---|
| Brainstorm, two theme directions on the canvas | done |
| Spec written, self-reviewed, committed (`0781ba76d`, motion `9ad0b9902`) | done, owner-approved |
| Symbol pinning for the plan (server side) | done, table below |
| Symbol pinning for the plan (web/ui/tests) | done, table below (was "in flight" when the first index was written; present now) |
| Prompt files `_RULES.md`, `W1-step-one.md`, `W2-moments.md`, this index reshaped | done 2026-09-05 (Fable agent, owner ruling 11) |
| Implementation plans `plans/2026-09-05-stream-overlay-w1.md`, `…-w2-moments.md` | in flight (Fable agents); the earlier single path `plans/2026-09-05-stream-overlay.md` is superseded by the two per-wave plans |
| PR1 (step one) | not started; lands after `feat/fixture-console-redesign` merges |
| PR2 (moments, cricket batter line) | after `feat/spectator-surface` W1 merges |

Waves:

| Wave | Scope | State | Plan | Prompt | PR | Gate |
|---|---|---|---|---|---|---|
| W1 | Hook extraction (`useLiveFixture`), `overlayModel`, `stream_url` + view + `PUT /stream` + OpenAPI, `streaming.overlay` key, overlay route + theme + three motions, console panel on `FixtureLine` with `sportKey`/`streamingEntitled` threaded from the division page, public "Watch live"/"Replay" link, all four test kinds, smoke, visual gate, inventory | Prompt written; plan in flight; code not started | `plans/2026-09-05-stream-overlay-w1.md` | `W1-step-one.md` | — | `_RULES.md` §Merge gates 1–8; rebase after desk W1 merges; owner per-screen sign-off |
| W2 | `OverlayMoment` + per-sport allowlist, FIFO slab (4 s hold, reduced-motion instant), consent on names, cricket batter/bowler line; source = spectator W1's model or the `score_events` fallback | Prompt written; plan in flight; blocked on spectator W1 merge + RE-PIN | `plans/2026-09-05-stream-overlay-w2-moments.md` | `W2-moments.md` | — | As W1, plus task-zero RE-PIN table in the PR |

## Owner rulings

Rulings BY THE OWNER, 2026-09-05, verbatim where short. Recommendations I made
are in the next section and are **not** interchangeable with these. Never carry
either to a peer session as the other.

1. **"I am ok with design"** — on the canvas; **"approve"** — on the spec. Both
   themes and the panel as drawn are the design of record.
2. **"one or two themes"** → both ship (A "Broadcast bar", B "Corner bug");
   style is a URL parameter, never a database column. The owner reverses the
   per-sport default by naming the other letter.
3. **"showing out, 4 or 6"** → moments (SIX, OUT, GOAL, MATCH POINT) exist and are
   **step two** (W2), after spectator W1's per-event template model.
4. **"all sports"** → all eleven engine sports through one projection.
5. **"hide this feature under special header"** → no header gate exists in this
   repo and OBS cannot send one; the owner accepted the entitlement gate
   (`streaming.overlay`, granted by no plan, test org via an override row).
6. **"use OPus SubAgent"** → pass `model: opus` on every dispatch this programme
   (this branch's agent frontmatter reads `model: sonnet`).
7. **"will we do animation when score?"** → spec §9: exactly three motions in
   step one, the moment slab in step two, nothing else ever.
8. **"approve the plan now"** — the planning approach (per-wave plans, prompts
   in this directory) is approved; execution still waits on the gates.
9. **"use fable agent to write all wave implementation plans"** — the two wave
   plans are written by Fable agents (planning note below).
10. **"Waves and Index.md as well"** — the wave prompt files and this index are
    written by a Fable agent too (this reshape).
11. **"Start the subagent where it left instead of starting from the
    beginning"** — a stopped agent is RESUMED with its own context, never
    re-dispatched fresh onto half-done work (`_RULES.md` §Agents).

## Product-owner calls made in-session (mine, recorded so they can be reversed)

- **Per-sport default: cricket opens on the bar, every other sport on the bug.**
  Value: the lower third suits a two-innings score with a chase line; the tile
  suits a set or period score. Reversible by the owner naming the other letter.
- **Entitlement key as the hiding mechanism** (recommended, owner accepted —
  ruling 5). Not entitled ⇒ 404 and no panel, never an upsell.
- **Three motions, `transform`/`opacity` only, no entrance animation.** Value:
  a graphic that moves for a reason and survives an OBS reconnect on air.
- **The panel's toggle is visible for EVERY fixture status** (`canEdit &&
  streamingEntitled`), not the schedule toggle's `status === "scheduled"` — a
  club pastes the replay link after the final whistle. Recorded while writing
  the prompts; reversible.
- **`m.youtube.com` is NOT on the host allowlist** as specified; the unit test
  pins that so the owner can add it deliberately. Open question in the PR1
  inventory.
- **Overlay page resolves slugs with a small server helper** before
  `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId)` (`data.ts:689` takes
  three slugs the overlay URL lacks — see "False premises found"). No overload,
  so the existing cache key is untouched.
- **W2 source policy:** spectator W1's model if it carries event types on the
  wire, else a `score_events`-backed helper of our own on the SAME public JSON;
  never a second endpoint, never an inverted dictionary key.

## Spec amendments (binding, in the design doc)

None yet. Precision notes to fold in at PR1 (recommended, not yet applied to
the spec): §4's "`broadcastRevalidate`" is the peer primitive
(`@/lib/peer-revalidate`); the helper to call is `fireDivisionRevalidate`
(`server/public-site/revalidate.ts:14`). §1's "same call the public fixture
page uses" needs the slug-resolution step. §6's first sentence names
`FixtureRow` where the row COMPONENT is `FixtureLine` (already folded, table
below).

## Base commit health (peer report, 2026-09-05, not reproduced here)

This branch is based on `997ad225b`. A peer session reports main's e2e
walkthrough leg RED in CI at that commit (run 33968571673), the failing flow
landing on `/login`. The peer's first explanation (a redirect built with
`new URL("/path", req.url)` emitting the CI bind address `0.0.0.0`) was later
withdrawn as unresolved; a competing hypothesis exists in another file. So:
the red is real, its cause is open. Two consequences for this programme: a
walkthrough red on this branch that ends on `/login` is that upstream red
until proven otherwise (check the CI run before blaming the branch), and, as
plain hygiene, no code in this programme builds a redirect from `req.url`;
the overlay page returns HTML or `notFound()`, and `PUT /stream` returns JSON.

Planning note (owner, 2026-09-05): "use fable agent to write all wave
implementation plans". Wave plans: `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md`
(step one) and `docs/superpowers/plans/2026-09-05-stream-overlay-w2-moments.md`
(moments, executes only after spectator W1 merges and its RE-PIN list is
re-verified).

## False premises found

Found during symbol pinning and folded into the spec:

- The row component is `FixtureLine` (`stages-panel.tsx:1578`); `FixtureRow`
  (`:73`) is the row's DATA type.
- The fixtures tab has no sport key and no entitlement prop — both are threaded
  from the division page.
- A nested layout cannot emit `<html>`/`<body>`; the overlay layout injects a
  segment-scoped `<style>` for the transparent background.
- The spectator W0 capture harness lives only on `feat/spectator-surface`, so
  the overlay e2e seeds through `apiJson` and the `_rig.ts` helpers instead.

Found while writing the prompt files (2026-09-05, this worktree; each carried
into `_RULES.md` or the wave file it affects):

- **`WALKTHROUGH_SPECS` does not exist** on this branch or on
  `feat/spectator-surface`, because it landed on `main` in PR #723
  (`01ea4a455`) after this branch's base. The walkthrough leg selects specs by
  the path regex at `apps/web/playwright.config.ts:119` (project `:164`; CI
  `e2e.yml:202-206`), AND after the rebase `e2e-ci-wiring.test.ts` requires
  every walkthrough spec to be named in the list (peer report: two CI jobs go
  red otherwise). Register the capture spec there in the same commit.
- **`getPublicFixture` takes three slugs** the overlay URL
  (`/overlay/fixtures/[fixtureId]`) does not carry — spec §1 under-specifies
  the lookup. Resolution in `W1-step-one.md` scope 5.
- **`useLiveFixture`'s branches ARE unit-testable** despite `environment:
  "node"`: `renderIsland` in `components/__tests__/_hook-harness.tsx` is the
  idiom `live-score.test.tsx:9-20` already uses.
- `fireDivisionRevalidate` is at `revalidate.ts:14` (the table below says
  `:13`; line 13 is blank).
- The schedule toggle's gate `canEdit && fixture.status === "scheduled"`
  (`stages-panel.tsx:1745-1753`) would hide the stream panel exactly while the
  club is streaming — the panel's gate is its own.
- The agent frontmatter on this branch reads `model: sonnet`
  (`.claude/agents/*.md:4`; `docs/superpowers/RULES.md:38-46`), which is why
  ruling 6 passes `model:` per dispatch.
- `teams.short_name` (`V206__teams.sql:5`) and `clubs.short_name` (`V242:11`)
  exist; entrants carry no short name — spec watch-list 6 is half-true.

## Environment (label `ovl`)

Worktree has `pnpm install --frozen-lockfile` done (engine resolves inside the
worktree), `.env.local` symlinks (relative targets) in root and `apps/web`, no
database or server yet. Stand one up with `seazn-env up --label ovl --server`
from the worktree when execution starts; `seazn-env rebuild --label ovl` after
code changes; `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
DATABASE_SSL=disable` (the label's port; what `seazn-env env --label ovl`
prints wins); Playwright from `apps/web` with `E2E_PROD_TARGET`. No standing
env between waves. Full recipe and traps: `_RULES.md` §Environment.

## Session status — 2026-09-05 (prompts written, execution not started)

Written this session: the spec (approved), the first index with both pinned
tables, and now `_RULES.md`, `W1-step-one.md`, `W2-moments.md` and this reshape.
The two wave plans are being written by sibling Fable agents and were absent
when this index was written — the wave files point at their paths; when a plan
exists, its task ORDER wins and the wave file's RULINGS win, and a conflict is a
finding recorded here. No code, migration, dictionary key or test exists yet on
this branch. No environment is up. Next: read the plans against the wave files,
record any inconsistency here, rebase PR1 after `feat/fixture-console-redesign`
merges, then dispatch W1 lane A and lane B (`W1-step-one.md` §Dispatch notes)
with `model: opus`.

## Pinned symbols — server and data (scout, 2026-09-05, this worktree)

| path:line | symbol | fact |
|---|---|---|
| `apps/web/src/server/public-site/data.ts:689` | `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId): Promise<{ org: PublicOrg; competition; division: PublicDivision; fixture: PublicFixture; entrantNames: Record<string,string>; realtime: boolean } \| null>` | names and realtime in one call; visibility through the `public_*_v` views |
| `apps/web/src/server/public-site/data.ts:180,187` | `PublicDivision.sport_key`, `.slug`, `.sport_name` | sport key lives on the DIVISION, not the fixture; `PublicOrg.id` available |
| `apps/web/src/server/public-site/data.ts:206` | `PublicFixture` | `id, division_id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, scheduled_at, venue, court_label, venue_name, court_name, status, outcome, summary, last_seq, lane, is_final, third_place, conditional`; column list hand-maintained in two places |
| `apps/web/src/server/public-site/data.ts:742` | cache | `["pub-fixture", fixtureId]` keyed, tagged `divisionTag(division.id)`; no per-fixture tag |
| `apps/web/src/server/public-site/data.ts:952` | `fixtureRealtimeEligible(fixtureId): Promise<boolean>` | `org_has_feature(c.org_id, 'realtime', c.id)` |
| `apps/web/src/server/usecases/public.ts:263` | `publicFixture(fixtureId)` | selects from `public_fixtures_v` |
| `db/migration/deltas/V369__public_fixtures_round_role.sql:18` | latest `create or replace view public_fixtures_v` | `create or replace view` may only APPEND: `stream_url` goes last in a full redefinition |
| `apps/web/src/lib/entitlements.ts:454` | `hasFeature(orgId, featureKey, competitionId?): Promise<boolean>` | `requireFeature` at `:666` throws 402; override row read at `:441` |
| `db/migration/v1-baseline/V024__plan_entitlements.sql:1` | `plan_entitlements (plan_key, feature_key, bool_value, int_value)` | missing row denies |
| `db/migration/v1-baseline/V025__org_entitlement_overrides.sql:1` | `org_entitlement_overrides (org_id, feature_key, bool_value, int_value, reason)` | resolver also filters `expires_at` |
| `db/migration/deltas/V290__pro_plus_plan.sql:18,39` | insert form | `select '<plan>', f, true, null from unnest(array[...])` with `on conflict (plan_key, feature_key) do update` |
| `apps/web/src/lib/entitlement-domains.ts:5` | `ENTITLEMENT_DOMAINS` | catalogue is CODE; a key left out is unadvertised on /pricing |
| `apps/web/src/lib/pricing-matrix.ts:191,199` | `buildPricingSections` | renders only `ENTITLEMENT_DOMAINS` keys |
| `apps/web/src/app/api/v1/fixtures/[id]/route.ts:17` | `PATCH` | `parseBody(req, PatchFixture)`, `requireResourceAuth(req, "fixture", id, "write")` |
| `apps/web/src/server/api-v1/auth.ts:352` | `requireResourceAuth(req, kind, id, scope): Promise<AuthCtx>` | reusable gate |
| `apps/web/src/server/usecases/fixtures.ts:136` | `patchFixture(auth, id, patch)` | schema `PatchFixture` at `schemas.ts:964` |
| `apps/web/src/server/api-v1/openapi.ts:57` | `ROUTES: RouteSpec[]` | hand-maintained; generator `scripts/openapi-gen.ts` writes `openapi/v1.json` and `openapi/v1.public.json`; CI drift `.github/workflows/ci.yml:94-98` |
| `apps/web/src/server/public-site/revalidate.ts:13` | `fireDivisionRevalidate(divisionId, competitionId?)` | tags `division:<id>`, `competition:<id>`, `org-public:<slug>` |
| `apps/web/src/components/v2/scorepad/__tests__/view-model.test.ts:8-12` | fold pattern | `foldMatch` from `@seazn/engine/core`, `defaultLineupPair`, `makeEnvelope` from `@seazn/engine/testkit` |
| `packages/engine/src/core/events.ts:445` | `foldMatch(module, cfg, lineups, events, opts?)` | production folder too |
| `packages/engine/src/sport/registry.ts:35,89` | `registry` | no enumerator of sport keys |
| `db/flyway.toml:6` | flat V numbering across subdirs | next free today `V392` |
| `apps/web/src/lib/realtime.ts:9,27,91` | `publishFixtureUpdate(fixtureId, reason)`, `mintPublicFixtureToken` | topic `fixture:<id>`, event `state_changed`, payload `{ v, reason, at }` |
| `apps/web/src/server/usecases/scoring.ts:139-144` | publish call sites | consumers `live-score.tsx:95`, `scorepad/use-fixture-stream.ts:58`, `slideshow.tsx:124` |

## Pinned symbols — web, UI, tests (scout, 2026-09-05, this worktree)

| path:line | symbol | fact |
|---|---|---|
| `apps/web/src/components/public-site/live-score.tsx:9-17` | imports | `disciplineLabel, disciplineList, matchStrength, periodBreakdown, servingSide, setBreakdown, stripLiveSetPoints` from `@/lib/public-site` |
| `apps/web/src/lib/public-site.ts:290,319,338,352,373` | `setBreakdown(summary: unknown, sportKey: string): SetBreakdown \| null`, `periodBreakdown(summary): PeriodScoreRow[] \| null`, `matchStrength(summary): string \| null`, `disciplineList(summary): DisciplineEntry[] \| null`, `servingSide(summary): "home" \| "away" \| null` | already a shared module; premise 2 false in the good direction, nothing to move |
| `live-score.tsx:29` | `const POLL_MS = 15_000;` | |
| `live-score.tsx:32-50` | `interface Props` | `fixtureId, initial: LiveFixtureData, realtime: boolean, entrantNames: Record<string,string>, sportKey: string, decidedTemplates: DecidedOutcomeTemplates` |
| `…/fixtures/[fixtureId]/page.tsx:175-182` | `<LiveScore>` call | `realtime={realtime} entrantNames={entrantNames} sportKey={division.sport_key} initial={{status,summary,outcome}}` |
| `app/(public)/shared/[orgSlug]/layout.tsx:19-23,60` | `Barlow_Condensed({ weight: ["500","600","700"], subsets: ["latin"], variable: "--ps-font-display" })` | variable class applied to a `<div>`, not `<body>`; root `app/layout.tsx:10-13` mounts Geist and `barlowCondensed` from `@/lib/fonts:4` |
| `app/layout.tsx:54`, `global-error.tsx:17` | the only two `<html>` in `src/app` | `slideshow/layout.tsx:20` and `embed/layout.tsx:26` return a `<div>` — a nested layout cannot restyle `<body>` by props; the overlay layout injects a global `<style>` for `html, body { background: transparent }` scoped to its segment |
| `…/v3/sport-theme.ts:557` | `sportThemeStyle(skinKey: string): CSSProperties \| undefined` | `undefined` when no palette entry (cricket, generic → `:root` defaults) |
| `sport-theme.ts:77,508` | `SPORT_TOKENS = ["board","board-2","ink","led","advisory","caution","dismissal"]`, `sportCustomProperty(token)` → `--sport-${token}` | seven tokens; palettes for 9 keys (football, hockey, icehockey, tennis, badminton, tabletennis, volleyball, boardgame, carrom) |
| `app/globals.css:1014-1022` | `:root { --sport-* }` defaults | 20 `var(--sport-` reads across 19 `.pad-*` rules; overlay adds its own classes |
| `components/v2/stages-panel.tsx:73` | `interface FixtureRow` | DATA type: `id, stage_id, pool_id, round_no, seq_in_round, fixture_no, home/away_entrant_id, home/away_slot_label, scheduled_at, venue, court_label, court_id, court_name, status` |
| `stages-panel.tsx:1578-1605` | `FixtureLine({ fixture: FixtureRow, href, entrantNames, canEdit, tz, boardSlotOptions, venues, courtNames, onRescheduled })` | the row COMPONENT the panel mounts from (spec §6 said `FixtureRow`) |
| `stages-panel.tsx:1745-1753` | `<button data-testid="fixture-schedule-toggle" onClick={() => setEditing(!editing)}>` | labels `msg("schedule.close")` / `msg("schedule.editTime")` / `msg("schedule.schedule")`; gated `canEdit && fixture.status === "scheduled"` |
| `stages-panel.tsx:144-146,399` | `Props` | `orgSlug, compSlug, divSlug`; NO sport key, NO entitlement prop — both threaded from the page |
| `app/**/d/[divSlug]/page.tsx:124-138,785` | division page | `Promise.all([getCompetition, listStages, listDivisionFixtures(auth, id), listEntrants, getScheduleSettings, hasFeature(auth.orgId,"exports"), listVenues])`; `entitled={await hasFeature(auth.orgId, "embeds.enabled")}` is the precedent for `streamingEntitled` |
| `dictionaries/en/` | `common, console, emails, errors, marketing, metadata, public, ui` | flat dotted keys, `{var}` interpolation; `embed.*` in `ui.json` is the copy-button precedent |
| `lib/messages-i18n.ts:24-28`, `components/i18n/dict-provider.tsx:113` | `msgFor(locale, key, vars?)`, `useMsg()` | |
| `server/usecases/__tests__/add-fixture.test.ts:5-17`, `__tests__/_rig.ts:23,94,208` | `HAS_DB = !!process.env.DATABASE_URL`; `seedOrg()`, `startedDivisionWithFixture(`, `startedCricketDivisionWithFixture(` | DB-backed vitest idiom and rig |
| `apps/web/e2e/helpers.ts:128,500,49` | `apiJson(request, path, method, body?)`, `setBoolEntitlementOverrideSql(orgId, featureKey, value)`, `expectNoHorizontalScroll(page, opts)` | override helper is the exact `streaming.overlay` lever; events posted to `/api/v1/fixtures/${id}/events` (`competition-desk.spec.ts:465,492`) |
| `apps/web/e2e/mobile.spec.ts:91,136` | `overflowingIn(...)`, `expectScorebugNotClipped(page, label)` | module-local, roots on `[data-role="v3-scorebug"]` |
| `apps/web/playwright.config.ts:138-266` | projects | setup, parallel, walkthrough, serial, mobile-se 375, mobile-14 390, mobile-320, mobile-360, mobile-430, tablet-768, tablet-834, gallery |
| `scripts/smoke.ts:24,91-95` | `BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"`; `check(label, cond)`, `expectFail(label, fn)` | |
| `lib/i18n-constants.ts:6,42` | `LOCALES = ["en","fr","es","nl"]`, `toLocale(x)` | |
