# Stream overlay — programme index

Design of record: `docs/superpowers/specs/2026-09-05-stream-overlay-design.md`
(owner-approved in chat 2026-09-05: design "I am ok with design", spec "approve").
Canvas: https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901
Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`.

## Status (2026-09-05)

| Step | State |
|---|---|
| Brainstorm, two theme directions on the canvas | done |
| Spec written, self-reviewed, committed (`0781ba76d`, motion `9ad0b9902`) | done, owner-approved |
| Symbol pinning for the plan (server side) | done, table below |
| Symbol pinning for the plan (web/ui/tests) | in flight when this index was written; re-run if absent |
| Implementation plan `docs/superpowers/plans/2026-09-05-stream-overlay.md` | not started |
| PR1 (step one) | not started; lands after `feat/fixture-console-redesign` merges |
| PR2 (moments, cricket batter line) | after `feat/spectator-surface` W1 merges |

Owner rulings this session, verbatim where short: "one or two themes" → both
ship; "showing out, 4 or 6" → moments, step two; "all sports" → all eleven via
one projection; "hide this feature under special header" → no header gate
exists and OBS cannot send one, owner accepted the entitlement gate
(`streaming.overlay`, granted by no plan, test org via override row); "use
OPus SubAgent" → pass `model: opus` on every dispatch this programme.

Environment: worktree has `pnpm install --frozen-lockfile` done (engine
resolves inside the worktree), `.env.local` symlinks (relative targets) in
root and `apps/web`, no database or server yet. Stand one up with
`seazn-env up --label ovl` from the worktree when execution starts.

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

False premises found and folded into the spec: the row component is
`FixtureLine`; the fixtures tab has no sport key and no entitlement prop; a
nested layout cannot emit `<html>`/`<body>`; the spectator W0 capture harness
lives only on `feat/spectator-surface`, so the overlay e2e seeds through
`apiJson` and the `_rig.ts` helpers instead.
