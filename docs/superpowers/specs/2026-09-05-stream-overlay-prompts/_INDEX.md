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
| T1a | theme design — slate (§4a), Phone tab (§8a), credits card (§8b), decided/void rows, the derived slab ink (§5) and the §2 contrast rows, all into `_THEMES.md` | **done 2026-09-08.** Owner picked **1A · 2A · 3A · 4A · 5C**, plus a separate addendum ruling: the red-card chip and the live dot take a 1-px `--sport-ink` hairline | `plans/2026-09-07-streaming-t1.md` | `T1-theme-and-visual-gate.md` | PR-T1 #752 | `_RULES.md` §Merge gates 1–8; owner per-screen sign-off on the five picks — asked per artboard, five verdicts |
| T1b | visual gate harness — `lib/contrast.ts`, `components/overlay/overlay-tokens.ts` + the eleven-sport contrast sweep, `e2e/visual/{manifest.ts,manifest.json,seeds.ts,asserts.ts,capture.spec.ts}`, `visualSeedRoutesSuite` in `scripts/smoke.ts`, `docs/runbooks/visual-gate.md`, `overflowingIn` moved to `e2e/helpers.ts`, and the D4 `min-w-0` fix in `court-card.tsx` | **done 2026-09-08.** Manifest ships **two groups, six rows**: `public-fixture` → `fixture-320`, `fixture-320-zoom125`, `fixture-768` (backdrop `dark`), `fixture-1280`; `embed-standings` → `standings-768`, `standings-320`. Six PNGs, all hashes distinct | `plans/2026-09-07-streaming-t1.md` | `T1-theme-and-visual-gate.md` | PR-T1 #752 | `_RULES.md` §Merge gates 1–8. **The plan's "six deliberately red contrast tests as the PR's open finding" did NOT ship** — pick 5C lands the suite green with hockey's 4.46 pinned two-sided. RP owed: `lib/contrast.ts` is a donor tidy — `scorepad/v3/__tests__/contrast.test.ts` still carries its own copy of the same formula, and `scorepad/**` is off-limits to this programme |
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

## Owner answers to the open questions (2026-09-06, verbatim)

Full text and consequences: `_OPEN-QUESTIONS.md`.

12. **"we can add it as required"** (Q1) — the venue time zone, cricket's
    balls remaining and the football match clock go onto the public fixture
    payload. Adds a **Task 0** to the W1 plan; closes W1 deviations 4 and 6
    and the unpinned football clock.
13. **"we can remove"** (Q2) — the cookie consent banner does not render on
    the overlay segment, so it cannot be composited into a club's broadcast.
14. **"we are using supabase realtime"** (Q3) — settles the transport. The
    entitlement coupling (must every plan granting `streaming.overlay` also
    grant `realtime`?) is folded into the pricing decision; until then the
    test org's override grants both, so it cannot bite.
15. **"we will plan it later on"** (Q4) — pricing deferred to launch; the key
    stays granted by no plan and out of `ENTITLEMENT_DOMAINS`.
16. **"now we can plan to load only if header appears"** — a hiding mechanism
    is wanted while pricing is deferred. A plain request header cannot gate
    either surface (a browser cannot set one on a navigation, and OBS sends
    none), so three workable mechanisms were put to the owner.
17. **Q14 answered same day: the per-organisation entitlement override**, over
    a preview cookie and over an environment flag. Both wave plans already
    assume exactly this, so no plan changes. One override row reveals the
    feature to one club, on production, with nothing on the pricing page.

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
| `apps/web/src/components/public-site/live-score.tsx:19-27` | imports | `disciplineLabel, disciplineList, matchStrength, periodBreakdown, servingSide, setBreakdown, stripLiveSetPoints` from `@/lib/public-site`. (Was `:9-17`, which is the file's header COMMENT — corrected 2026-09-08) |
| `apps/web/src/lib/public-site.ts:301,330,366,380,401` | `setBreakdown(summary: unknown, sportKey: string): SetBreakdown \| null`, `periodBreakdown(summary: unknown): PeriodScoreRow[] \| null`, `matchStrength(summary: unknown): string \| null`, `disciplineList(summary: unknown): DisciplineEntry[] \| null`, `servingSide(summary: unknown): "home" \| "away" \| null`; `stripLiveSetPoints` is `:297` | already a shared module; premise 2 false in the good direction, nothing to move. (Was `:290,319,338,352,373` — every one of the five landed on a brace, a comment or a blank line. Corrected 2026-09-08; **`W1-step-one.md`'s scope 2 carried the same five and was corrected with it**) |
| `match-centre/use-live-fixture.ts:10` | `export const POLL_MS = 15_000;` (used at `:98`); the hook is `export function useLiveFixture(` at `:17` | **Corrected 2026-09-08 (post-rebase repair).** The three rows here previously described `live-score.tsx` as it was BEFORE spectator W1 Task 10/14 and were all false against the tree: this one put `POLL_MS` at `live-score.tsx:29`, which is an `import {`. `live-score.tsx` holds no transport at all any more |
| `live-score.tsx:37-74` | `interface LiveScoreBodyProps` | `data: LiveFixtureData, entrantNames: Record<string,string>, sportKey: string, decidedTemplates: DecidedOutcomeTemplates, dict?: Dict, subscribed?: boolean, suppressScorebug?: boolean`. Previously recorded as `interface Props` at `:32-50` with `fixtureId, initial, realtime` — those are the RETIRED `LiveScore` wrapper's props and none of them exists in this file |
| `…/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx:22,293` | `import { MatchCentreWithTabParam }` / `<MatchCentreWithTabParam` | Task 14 replaced the `<LiveScore>` mount. **`LiveScore` is not exported anywhere** — `live-score.tsx`'s only exports are `LiveFixtureData` (`:35`) and `LiveScoreBody` (`:103`). Previously recorded as a `<LiveScore>` call at `:175-182`, with two route segments elided (`[competitionSlug]`, `[divisionSlug]`) — so even the path would not have resolved |
| `app/(public)/shared/[orgSlug]/layout.tsx:19-23,60` | `Barlow_Condensed({ weight: ["500","600","700"], subsets: ["latin"], variable: "--ps-font-display" })` | variable class applied to a `<div>`, not `<body>`; root `app/layout.tsx:10-13` mounts Geist and `barlowCondensed` from `@/lib/fonts:4` |
| `app/layout.tsx:54`, `global-error.tsx:17` | the only two `<html>` in `src/app` | `slideshow/layout.tsx:20` and `embed/layout.tsx:26` return a `<div>` — a nested layout cannot restyle `<body>` by props; the overlay layout injects a global `<style>` for `html, body { background: transparent }` scoped to its segment |
| `…/v3/sport-theme.ts:557` | `sportThemeStyle(skinKey: string): CSSProperties \| undefined` | `undefined` when no palette entry (cricket, generic → `:root` defaults) |
| `sport-theme.ts:77,508` | `SPORT_TOKENS = ["board","board-2","ink","led","advisory","caution","dismissal"]`, `sportCustomProperty(token)` → `--sport-${token}` | seven tokens; palettes for 9 keys (football, hockey, icehockey, tennis, badminton, tabletennis, volleyball, boardgame, carrom) |
| `app/globals.css:1135-1141` | `:root { --sport-* }` defaults | 20 `var(--sport-` reads across 19 `.pad-*` rules; overlay adds its own classes |
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

## 2026-09-07 — programme design rewrite

**Design of record is now `../2026-09-07-streaming-programme-design.md`.** The
09-05 design carries a superseded header and stays for the canvas links and
the approval record. Branch rebased onto `main` at `fb99bbd4c` (clean, 24
docs-only commits); the checklist the owner pasted is `docs/superpowers/RULES.md`
§"Owner checklist (2026-09-07)" (`ed094e519`).

### Owner rulings 2026-09-07 (verbatim where short)

18. **Shape — "1"**: one design of record replacing the 09-05 design (Tier A
    rewritten in, corrections folded, no findings layer); one step-level
    programme plan for the seazn.club work not yet planned (W1 amendment, T1,
    R1, R2, R0 brief); R3 native apps in their own spec in the capture repo.
19. **"all ok"** on decisions A–J, with two refinements:
    - **A, runner**: the owner asked *"are you saying that we can spin a flyVm
      for temp to run the compositor? can we invoke the flyway dynamically in
      the particular region or no need?"* — answered: yes, a Fly Machine per
      session through the Machines API, `region "lhr"`, `auto_destroy`, no
      need to move region (Cloudflare ingest is anycast). Cloud Run dropped.
    - **C, entitlements**: the owner asked for two keys — one "where we will
      offload to the OBS which include in the pro plan" and one add-on "where
      it will use the compositor and cloudflare". Ruling on names: **"we can
      keep corpus name as it"** → `streaming.overlay` (Pro, OBS) and
      `streaming.relay` (Tier B). Purchase surface: **"we wwill buy the
      streaming in the fixture console page itself?"** → yes, from the stream
      panel's Phone tab.
20. **Credits, per match**: *"what do you rec, I think per match? or how can
    we charge for org level?"* → recommendation (per-match credits in packs of
    1 / 5 / 20, a ledger not a counter, consumed at `live`, `streaming.relay`
    = "may buy credits") accepted with **"go"**.
21. **T1 wave**: *"Can we have Wave for designing the theme and testing?"* →
    T1a canvas (≥2 options per un-approved surface, 1920×1080 + 320/768/1280
    + 320 @ 125 % zoom, light+dark composite) and T1b manifest-driven visual
    harness — **"Ok"**.
22. Design batches 1 (§1–§3) and 2 (§4–§7) — **"Ok"** each.

The rest of A–J as recommended and accepted: B Cloudflare Stream as the front
door; D compositor self-mints realtime as a producer; E `max_duration` 5 h,
retention 7 days, no auto-end after decided (a "match decided — still
streaming" chip instead); F replay fill only when `stream_url` is null; G
720p30 only at launch; H cookie banner suppressed on `/overlay/*` by
`usePathname` + a zero-cookies e2e; I the checklist into `RULES.md`; J R3
deferred, only the QR contract fixed here.

### Findings 2026-09-07 (FS1–FS9: full text in the design §13)

The five `FS-T1*` entries below were appended 2026-09-08 and are NOT in the
design §13 — this file is their full text.

- **FS1** `cookie-consent.tsx` has NO route-key mechanism (the 09-06 documents
  said it had one) — `localStorage` only, mounted at `app/layout.tsx:68`.
- **FS2 — SUPERSEDED 2026-09-08. The migration line is now a RULE, not a
  number.** This entry used to read "programme migrations are V400 / V401 / V402
  at rebase". It went stale DURING the T1 wave: `main` took
  `V400__repair_orphaned_age_cutoff_half.sql`, so the corpus was reserving a
  number `main` already owned. Renumbering to V401/V402/V403 would only reset
  the same trap — this corpus has now had a reserved migration number overtaken
  repeatedly, and a fixed number written in a document cannot survive a branch
  that lives for days beside a moving `main`.

  **The rule, which replaces every reserved number in this programme:** a
  programme migration takes the next free numbers after
  `ls db/migration/deltas | sort -V | tail -1`, re-read **at every rebase** and
  again immediately before the migration file is written. Never carry a number
  forward from a document. (A duplicate Flyway version survives a clean rebase
  with no conflict, which is why the check is at every rebase and not once.)
  T1 added no migration; **W1 is the first wave in this programme that needs
  one**, and W1 Task 0 does the read.

  **The stale reservation survives in FIVE more places this wave could not
  edit, and one of them is the document W1 actually executes from.** Found by
  sweeping `V40[0-9]` across the corpus at T1 close, 2026-09-08 — the wave's own
  owed list named only three lines and there were eight. **W1 Task 0 must
  correct these before Step 6 writes a migration file**, because two of them are
  a literal filename to create:

  - `plans/2026-09-05-stream-overlay-w1.md` — **24 lines** carry `V400` /
    `V401`, including `:81-82` (the files-to-create table), `:2156`
    ("Create `db/migration/deltas/V400__fixture_stream_url.sql`") and `:2533`
    (the same for `V401`). `V400` is **taken on `main`**. The plan's renumber
    guard is real but it is at **Step 13**, a post-rebase step that runs long
    after Steps 6 and 3 have written and committed the files — a guard placed
    after the thing it guards. Read the deltas tail at Task 0 and rewrite the
    numbers throughout, in one edit, before any step creates a file.
  - `../2026-09-07-streaming-programme-design.md:1046` — the FS2 row still
    reads "this programme takes **V400 / V401 / V402** at rebase"; `:979` — the
    §11 Task 0 row still records `ls deltas | tail` → V400/V401/V402. Both are
    `[A]`-class statements in the design of record.
  - `plans/2026-09-07-streaming-t1.md:22` and `:133` — historical only (T1 is
    done and added no migration), but they say the same thing and will be read
    by anyone auditing the wave.
  - **`W1-step-one.md` itself — MISSED by the sweep above and FIXED in the
    final-review fix round, 2026-09-08.** Its scope 3 named
    `V400__fixture_stream_url.sql` and its scope 4 named
    `V401__streaming_overlay_entitlement.sql` as literal files to CREATE — in
    the one document this branch already edits, which is why "five more places
    this wave could not edit" undercounted. Both now state the RULE (`V<next>`
    off `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase)
    and name `V400`/`V401` only as numbers NOT to use. **The lesson, which is
    the reason this bullet exists rather than a silent edit: a named list of
    stale lines is a SAMPLE.** Re-sweep the pattern yourself before trusting the
    enumeration above — the same re-sweep also turned up two files the list does
    not name. `_STATE.md` (`:30`, `:142`, `:237-239`, `:293-294`) is fine: every
    mention there is describing the staleness, not reserving a number.
    `R1-relay-core.md:60-61` is fine too but is the closest to a trap —
    "the design intends V401 (keys) and V402 (sessions + credits)" — and it
    stands only because the same sentence says both are "next free at rebase"
    and puts the `ls … | tail -1` FIRST. **R1 must still re-read the tail; those
    two numbers are illustrative and are now wrong by at least one.**
- **FS3** `.claude/worktrees/stream-overlay` was an unregistered 15 MB residue
  with no `.git`; moved to `stream-overlay.stale-20260907`, worktree re-added.
- **FS4** desk W2 MERGED (#725); the live contention on `run-sheet-row.tsx` is
  desk W3.
- **FS5** Cloud Run dropped; Fly Machines only.
- **FS6** the relay "implies overlay" bundling and org monthly budget are
  replaced by two keys on the same plan split plus per-match credits.
- **FS7** T1 theme-design and visual-gate wave added ahead of W1-C.
- FS8 `barlowCondensed` weights are `["600","700"]`; W1-C adds 800.
- FS9 `playwright.config.ts` lives at `apps/web/`, not `apps/web/e2e/`.

T1 wave deviations, appended 2026-09-08 by the T1 plan's Task 0 Step 8. Listed
in the order the T1 plan's Step 8 gives them — a, c, d, e, then b — not
re-sorted, so a reader following the plan finds each where the plan put it.

- **FS-T1a** — `overflowingIn` is MOVED to `e2e/helpers.ts` and imported by
  `mobile.spec.ts`, overruling the T1 prompt's "copy the logic into
  `asserts.ts`" (`T1-theme-and-visual-gate.md` §Do NOT touch). Reason:
  `helpers.ts` is not a spec, so Playwright's "a test file should not import a
  test file" rule does not fire (`mobile.spec.ts:3-24` already imports 20
  symbols from it), and one authority beats a copy that drifts (the third copy,
  `e2e/run-sheet.spec.ts:100 expectRunSheetNotClipped`, is recorded as a tidy
  owed, not touched by T1). The owner is told in the T1 Task 4 sign-off message
  that the prompt's instruction was overruled and why.
- **FS-T1c — CLOSED 2026-09-08.** It read: `SLATE_TOKENS`'s three values are
  typed in `overlay-tokens.ts` AND in `_THEMES.md` §4a until Task 1 lands §4a
  and Task 2's contrast test gains a §4a parse. Both happened. Task 2's suite
  parses §4a out of the sheet and proves the slate values against it, so there
  is no second typed copy to drift; the sheet remains the authority.
- **FS-T1d** — the moments slab's `dismissal` tone (`_THEMES.md` §5: background
  `--sport-dismissal`, text `#fff5f5`) cannot clear WCAG 4.5:1 with any single
  fixed ink, because the eleven sports split into light-red and dark-red
  dismissals that want opposite inks. Measured 2026-09-08 against
  `SPORT_PALETTES` (`apps/web/src/components/v2/scorepad/v3/sport-theme.ts:165`)
  and the `:root` fall-throughs, across all three candidate inks.

  **Correction, 2026-09-08:** the first draft of this finding carried only SEVEN
  rows and generalised its conclusion to all eleven sports. `SPORT_PALETTES`
  holds OVERRIDES only — boardgame and carrom declare a `board` but no
  `dismissal`, and cricket and generic have no palette entry at all — so those
  four fall through to `:root --sport-dismissal: #dc2626` (`app/globals.css:1141`;
  `--sport-board: var(--mk-night)` = `#150b36` and `--sport-ink:
  var(--mk-cream)` = `#f5f0e8` at `:495-497`), where `#fff5f5` measures **4.51
  and PASSES**. The four sports a seven-row table hides are exactly the ones
  that reverse the conclusion. The full eleven, all three candidate inks
  (**bold** = the winning ink for that sport):

  | sport | dismissal | `#fff5f5` | own `board` | own `ink` | best |
  |---|---|---|---|---|---|
  | football | `#d00000` | **5.33** | 3.01 | 5.27 | 5.33 |
  | hockey | `#ff5a4d` | 2.88 | **4.46** | 2.81 | 4.46 |
  | icehockey | `#ff6b6b` | 2.59 | **7.06** | 2.47 | 7.06 |
  | tennis | `#fa5252` | 3.07 | **4.68** | 3.06 | 4.68 |
  | badminton | `#ff6b6b` | 2.59 | **6.14** | 2.47 | 6.14 |
  | tabletennis | `#ff7a80` | 2.35 | **7.35** | 2.31 | 7.35 |
  | volleyball | `#ff6b6b` | 2.59 | **6.11** | 2.58 | 6.11 |
  | boardgame | `#dc2626` (root) | **4.51** | 3.57 | 3.98 | 4.51 |
  | carrom | `#dc2626` (root) | **4.51** | 3.46 | 4.12 | 4.51 |
  | cricket | `#dc2626` (root) | **4.51** | 3.84 | 4.26 | 4.51 |
  | generic | `#dc2626` (root) | **4.51** | 3.84 | 4.26 | 4.51 |

  Counts: `#fff5f5` alone clears FIVE and fails six. The sport's own `board`
  alone clears FIVE, fails four, and is UNDEFINED for cricket and generic, which
  have no `board` of their own. **Neither fixed ink works — that is the
  finding.** The T1 plan's own remedy — "the slab LINE takes `board`, the
  headline stays `#fff5f5` at the 3:1 large-text floor, which all six clear" —
  is false in both halves: hockey's headline measures 2.88 and does not clear 3,
  and `board` would drop football from 5.33 to 3.01. The plan's other variant,
  darkening hockey's `dismissal` hex, is refused: `sport-theme.ts` is off-limits
  to this wave. This is a T1a design question, put to the owner with the four
  T1a picks:

  - **(A)** the `dismissal` tone takes the sport's own `board` as its text, as
    the `led` and `caution` tones already do. Clears five, and **regresses
    boardgame (4.51 → 3.57) and carrom (4.51 → 3.46) from passing to failing**;
    undefined for cricket and generic. The first draft recommended A on the
    claim that "nine sports clear outright" — that claim was false.
  - **(B)** §5 declares the slab line large text at floor 3, which still leaves
    five sports red (hockey, icehockey, badminton, tabletennis, volleyball).
  - **(C, recommended) — the slab's `dismissal` ink is DERIVED per sport:
    whichever of `#fff5f5` and that sport's own `board` measures higher against
    that sport's `dismissal`.** Ten of eleven sports clear 4.5 (five on `board`,
    five on `#fff5f5`); hockey alone lands at 4.46, 0.04 short — and 4.46 is
    already a documented, deliberately-pinned value in this repo
    (`sport-theme.ts:213` argues it two-sided for the discipline swatches). No
    palette hex moves, no sport is left undefined, and `overlay-tokens.ts` can
    compute the choice rather than a human maintaining an eleven-row lookup.

  ~~Until the sheet moves, Task 2's contrast suite commits with the six
  `#fff5f5` reds named.~~ **RESOLVED 2026-09-08 — the owner picked C.** The
  sheet moved before Task 2 committed, so the six deliberately-red tests the
  plan expected as this PR's open finding were never written. `_THEMES.md` §5
  now derives the ink per sport (whichever of `#fff5f5` and that sport's own
  `board` measures higher against that sport's `dismissal`), `overlay-tokens.ts`
  computes the choice rather than carrying an eleven-row lookup, and the suite
  lands **green**: ten of eleven clear 4.5, and hockey's 4.46 is a named
  two-sided exception pinned `>= 3.0` and `< 4.5`, the same shape
  `sport-theme.ts:213` already uses. No palette hex moved.
- **FS-T1e** — a third overflow scan remains at `e2e/run-sheet.spec.ts:100
  expectRunSheetNotClipped` (desk's spec, untouched by T1); tidy owed to
  whichever desk wave next edits that file.
- **FS-T1b** — the manifest vocabulary is the PLAN's: `awaitSelector` (a CSS
  selector — the public fixture page and the embed widgets carry no testids, so
  `awaitTestId` could not await them), group-level `mustDiffer: [id, id][]` and
  `controlSetEqual` (a pair is a group fact, not a row's), and `toBeVisible` on
  the awaited element (a screenshot proves what is painted; `toBeAttached` is
  the FOLD rule and the overlay has no fold). The design §4.2 block,
  `T1-theme-and-visual-gate.md` items 5–6 and `R2-compositor.md` were amended to
  this vocabulary on 2026-09-08 (design FS16).

### Status

Design committed. Owner rulings after the first commit, folded in
`97edecc55`'s follow-up: **§9a "Design patterns (binding on code)"** (*"include
the follow the design pattern when developing the code"*) and **§11 per-wave
prompt + plan pairs** — prompts for every wave now (`T1-theme-and-visual-gate.md`,
`R0-bench.md`, `R1-relay-core.md`, `R2-compositor.md`), step-level plans one
wave ahead only (`plans/2026-09-07-streaming-t1.md` now; R1 after PR1 merges;
R2 after the R0 memo). Written next. No code under `apps/`, `packages/` or
`db/` yet.

## 2026-09-08 — passthrough ruling

Owner asked "What's Passthrough?" and "Why people need that as they can do it
directly in YouTube Live right?" — the recommendation went back that passthrough
has no customer value (every destination app goes live from a phone for free;
the only edge is YouTube's 50-subscriber minimum for MOBILE-APP live, which RTMP
ingest does not have) and that its value is engineering only: R1 proves the
phone → Cloudflare → destination pipeline with zero new deployables, and it is
the fallback when composed is unavailable. **Ruling 23 (owner, 2026-09-08): "I am
good with passthroug now"** — passthrough is an INTERNAL MODE, never a tier,
never priced, never shown as a choice; the organiser sees one "Go live"; the
system falls back to clean feed with a chip "scorebug unavailable — streaming
clean". Spec §12 item 2 closed on this ruling.

## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)

First code this programme has shipped. Everything before this section is
documentation; T1 adds `apps/web/src/lib/contrast.ts`,
`apps/web/src/components/overlay/overlay-tokens.ts`, the `apps/web/e2e/visual/`
harness, a smoke suite, a runbook, and ONE production change — `court-card.tsx`
(+13 −1, of which the behaviour is a single `min-w-0` on the truncate chain; the
rest is the comment recording why). **No migration, no dictionary key, no
user-facing string**, so none of the four-locale, OpenAPI or Flyway gates had
anything to catch.

**Branch** `feat/stream-overlay`, four tasks, every task reviewed to clean. Its
commits are the range **`origin/main..feat/stream-overlay`**; **read the count
from `git log --oneline origin/main..feat/stream-overlay`, never from a number
written here** — a fix round appends a commit and cannot append to a count
already committed in prose, which is how "ten commits" survived into an
eleven-commit branch on four lines across this file and `_STATE.md`.

**Anchor the range on `origin/main`, never on a merge-base sha.** This line
first read `0cc4614b8..feat/stream-overlay` and was right for about a day. The
2026-09-08 rebase replayed the branch over `origin/main`, which made
`0cc4614b8` an ANCESTOR of `origin/main` — so that range then swept the 79
replayed `main` commits as well. Both measured on `9164a926a`:

    git rev-list --count 0cc4614b8..feat/stream-overlay   → 93
    git rev-list --count origin/main..feat/stream-overlay → 12

Replacing a number with a command was the right half of the repair; **the SHA
was the fragile half.** `origin/main..` survives any rebase.

**The same rebase invalidated every sha this section used to carry**, so the
table below is keyed by POSITION IN THE RANGE, oldest first, and by subject —
both of which a rebase preserves. Regenerate the hashes with
`git log --oneline --reverse --format="%h %s" origin/main..feat/stream-overlay | cat -n`;
do not write them back here.

| # | Task | What |
|---|---|---|
| 1 | 0 | `ovl` environment, the vitest baseline, the T1 index row and the five `FS-T1*` deviations |
| 2 | 1 | T1a — slate, Phone tab, credits card and decided/void values, owner-picked |
| 3 | 3 | `overflowingIn` moved out of `mobile.spec.ts` into `e2e/helpers.ts` |
| 4 | 3 | manifest-driven capture harness with the owner checklist as assertions (+ the D4 `court-card.tsx` fix) |
| 5 | 2 | `OVERLAY_TOKENS`, the derived slab ink, the eleven-sport contrast sweep |
| 6 | 3 | close four ways the gate could pass on what it exists to fail on |
| 7 | 2 | one home per value, the eleven keys as a literal, the swatch floors |
| 8 | 1 | T1a addendum — the card chips and live dot take an ink hairline |
| 9 | 2 | the ink hairline carries the boundary; the two fills are *covered*, not waived |
| 10 | 3 | `knownDefects` honoured one check and lied about the other four |
| 11 | — | T1 close: findings, mutant killer lists, and the migration RULE (this section) |
| 12 | — | final-review fix round: the withdrawn `LiveScore` premise, the extension point, the migration RULE in `W1-step-one.md`, the hairline attribution, and FS-T1j's unit test |
| 13 | — | post-rebase repair: re-anchor both ranges on `origin/main`, de-sha this table and six headings, three false `live-score.tsx` inventory rows, `seeds.ts`'s own contradiction |

A row here is a LABEL, not a count — the range command above is the count, and a
later round appends a commit whether or not anyone appends a row.

**Every "commit N" below refers to the `#` column.** The four mutation-round
headings and the two gate-number headings used to name shas and now name
positions, for the same reason.

### The owner's decisions (T1a)

Asked as five lettered picks with both/all options drawn at real values on the
canvas (https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901,
page "T1 — five decisions"). Picked:

| # | Surface | Pick | What it means in the sheet |
|---|---|---|---|
| 1 | Slate | **A — full-bleed board** | the club's own colours fill the frame; the score survives a dropout; no second palette (`_THEMES.md` §4a) |
| 2 | Phone tab | **A — stepper** | a four-step flow someone at the ground can locate themselves in, and support can ask "which step are you on" (§8a) |
| 3 | Credits card | **A — three tiles** | all three prices on screen; nothing owed to /pricing while streaming is dark (§8b) |
| 4 | Decided / void frame | **A — result in place** | the post-whistle arrival sees the score AND why it ended, in the frame the live viewer saw; nothing jumps |
| 5 | Slab ink | **C — split by luminance** | the slab writes in whichever of `#fff5f5` and the sport's own `board` measures higher on that sport's `dismissal` (§5) |

**A sixth ruling, taken separately** (owner: *"apply your rec"*, 2026-09-08).
The recommendation put to them, and the exact extent of what they approved:
**the red-card chip and the live dot take a 1-px `--sport-ink` hairline, not a
`board` one** — those two, the two that fail their floor — and it is the
hairline, never the fill, that carries the WCAG 1.4.11 boundary. **This ruling
is what closes two contrast findings**, and it creates an e2e obligation
recorded below.

`_THEMES.md` then extends the same hairline to the `advisory` and `caution`
chips so all three discipline chips share one treatment. **That widening is the
sheet's own consistency choice and is not part of the ruling** — it is
separable, and for those two the hairline is a boundary device rather than a
requirement (`_THEMES.md:221-223`: both fills clear 3:1 unaided). Said here
because this feeds the owner's per-screen sign-off, which binds on the red-card
chip and the live dot and takes the other two as a proposal. `_THEMES.md` §2
(`:126-141`), §3 (`:183-200`, `:233`) and §4 (`:328`, `:341`) are the binding
text for the drawing.

### Gate numbers — measured on the tree at commit 10

Commit 10 is `knownDefects honoured one check and lied about the other four`,
the last Task 3 commit. These numbers were measured on the sha it carried
BEFORE the 2026-09-08 rebase; that sha no longer resolves, which is why the
anchor is the position and the subject.

- **Full `apps/web` vitest, fresh `ovl` DB:** passed **15543** / total **15620**
  / failed **4** / pending **73**, across **1185 files**; `outside-worktree 0`.
  Task 0 baseline was **15121 / 15198 / 4 / 73** across 1182 files →
  **+422 tests, delta failed 0**.
- **The four reds are the baseline's own single file**,
  `apps/web/src/server/usecases/__tests__/schedule-build-honours-locks.test.ts`
  — the CP-SAT placement service the local `up` was not given (`--placement`).
  **ENVIRONMENTAL**, not this branch's; identical file and count to the baseline.
- **Spectator walkthroughs** (`spectator-public.spec.ts` +
  `spectator-public-2.spec.ts` — the two specs that cover `court-card.tsx`, the
  one production surface T1 changed): **19 passed, 0 failed.**
- **`mobile.spec.ts` @ mobile-320, isolated: 44 passed / 1 skipped / 0 failed** —
  matches the pre-change witness exactly, which is what the `overflowingIn` move
  is judged against.
- **Seven-width sweep: 271 passed / 1 failed / 4 skipped.** The one red is
  `page smokes: settings save + invoice/plan card render` — a
  read-modify-write on the org name against the SHARED Pro org, raced by running
  all seven width projects against ONE local server and ONE database.
  **Recorded as a run-method artefact, not as a pass and not as a defect:** the
  evidence is that re-running mobile-320 alone returns 44 / 1 / 0, and that CI
  matrixes the widths into separate jobs with their own database
  (`e2e-mobile`), so the race has no CI analogue. A reader who wants the number
  to mean something should re-run the widths one project at a time.
- `capture.spec.ts` **7 passed**; **6 PNGs written, all six hashes distinct**;
  smoke visual-gate checks **4 / 4**; `tsc --noEmit` exit 0; lint
  **`✖ 137 problems (0 errors, 137 warnings)`** — byte-identical to the Task 0
  baseline, none in T1's files.

### Mutant killer lists — Task 2 (`overlay-tokens.ts`, the contrast sweep)

Three rounds, **0 survivors at the end**. Per round: 19 / 19 (round 1),
**22 / 22** (fix round 1 — 16 new plus 6 re-runs of the still-relevant
originals: M3, M5, M6, M7, M12 and the test-side trio M16/M17/M18), **7 / 7**
(fix round 2). The killers, verbatim:

**Round 1 — commit 5**

| # | Mutation | Verdict | Named killer |
|---|---|---|---|
| M1 | `ROOT.led` `#9ae600` → `#a3e635` (the v3 Tailwind hex `sport-theme.ts` warns about) | KILLED (1) | `ROOT_SPORT_DEFAULTS mirrors globals.css :root exactly › --sport-led` |
| M2 | `ROOT.led` → the board hex | KILLED (11) | mirror `--sport-led`, **plus** `cricket · led-on-board`, `cricket · led-on-board-2`, `cricket · board-on-led-headline`, `… board-on-led-line`, `generic · …` |
| M3 | `srgbChannelToLinear` body → `return c / 255` (delete the sRGB curve) | KILLED (106) | `distinguishes gamma-correct from naive-linear luminance (#767676 on white)` + 105 sweep rows |
| M4 | swap the red and green luminance coefficients | KILLED (44) | `relativeLuminance weights the three primaries as WCAG does › green ≫ red ≫ blue` + 43 sweep rows |
| M5 | delete `expandHex`'s validation (NaN channels score every pair 1:1) | KILLED (1) | `refuses a value that is not a hex colour rather than scoring it` |
| M6 | `slabDismissalInkFor` → the superseded fixed `#fff5f5` | KILLED (21) | six `<sport> · slab-ink-on-dismissal` rows + `<sport>'s derived ink and ratio are the ones §5 records` |
| M7 | invert the derivation (`light <= dark`) — pick the LOWER-contrast candidate | KILLED (36) | eleven `slab-ink-on-dismissal` rows + `%s picks the higher-contrast of the two candidates` |
| M8a | empty `OVERLAY_PAIR_EXCEPTIONS` | KILLED (2) | `hockey · slab-ink-on-dismissal` (4.46 < 4.5) + `the exception table names hockey's slab row and nothing else` |
| M8b | move the exception from hockey to tennis | KILLED (3) | `hockey · slab-ink-on-dismissal`, `tennis · slab-ink-on-dismissal` (4.68 is not `< 4.5`), + the exception-table test |
| M9 | exception `atLeast 3.0/below 4.5` → `2.0/3` (a laxer licence than the floor) | KILLED (2) | `hockey · slab-ink-on-dismissal` + `the exception table…` (`below` must equal the role's floor) |
| M10 | `OVERLAY_SPORT_KEYS` off `SPORT_PALETTES` (the "short by four" mistake) | KILLED (4, **total 311 → 263**) | `is exactly the sport keys the pad's skin registry names`, `covers the four sports SPORT_PALETTES does not name at all`, `ten of the eleven clear 4.5 outright`, `a role scoped to a subset of sports names a NON-EMPTY subset` |
| M11 | `paletteFor` ignores the per-sport overrides | KILLED (13) | `paletteFor fills a missing token from the root defaults, never from another sport` + `hockey · slab-ink-on-dismissal` + `the sweep is not vacuous` + eight §5 record rows |
| M12 | `SLATE.lineInkAlpha` 0.7 → 0.75 (one alpha copied into both) | KILLED (1) | `the line and brand alphas are §4a's own numbers` |
| M13 | delete the `dismissal-on-board` role row | KILLED (1, **total 311 → 299**) | `the table IS the scope — these exact pairs are gated, by id` |
| M14 | widen `dismissal-on-board-2` from cricket to every sport | KILLED (1, total 311 → 320) | `football · dismissal-on-board-2` (2.56 < 3) |
| M15 | `liveDot` `#ef4444` → `#ff0000` | KILLED (1) | `the indicator is the live dot, and the live dot is what §2 names` |
| M16 | **test-side** — the pair sweep's `role.floor` → `1` | KILLED (1) | `HARNESS SELF-TEST: the sweep's own check refuses a ratio under the floor` |
| M17 | **test-side** — drop the exception's CEILING (leave a one-sided `>= 3.0`) | KILLED (1) | same harness self-test |
| M18 | **test-side** — the alpha sweep's `role.floor` → `1` | KILLED (1) | same harness self-test |
| M19 | `ROOT.board` `#150b36` → `#150b37` (one byte off the alias) | KILLED (1) | `ROOT_SPORT_DEFAULTS mirrors globals.css :root exactly › --sport-board` |

**M16 survived its first run** — 311/311 green with the sweep's floor replaced
by `1`. It was **converted into a kill, not recorded as a survivor**: the sweep
body was extracted into `assertPairClearsFloor` / `assertAlphaClearsFloor` and a
harness self-test drives each with a ratio on both sides of every floor. An
inline threshold is invisible to its own assertions; extracting it is what gives
the floor a test.

**Fix round 1 — commit 7**

| # | Mutation | Verdict | Killer |
|---|---|---|---|
| N1 | drop `"cricket"` from the eleven-key literal | KILLED (total 381→352) | `is exactly the sport keys the pad's skin registry names`, `covers the four sports SPORT_PALETTES does not name at all`, `the sweep is one row per sport per role`, `ten of the eleven clear 4.5 outright` |
| N2 | add a twelfth key no skin owns | KILLED (total 381→410) | the same registry pin, plus `§5 records a row for every one of the eleven sports` and `kabaddi's derived ink and ratio are the ones §5 records` |
| N3 | `ROOT_SPORT_DEFAULTS` back to a copy | KILLED | `is the SAME object as DEFAULT_SPORT_PALETTE, not a copy of it` |
| N4 | `paletteFor` back to a wrapper | KILLED | same |
| N5 | delete the `live-dot-on-board-2` role | KILLED (381→370) | `the table IS the scope — these exact pairs are gated, at these exact floors`, `the sweep is one row per sport per role`, HARNESS SELF-TEST, and both exception-integrity tests |
| N6 | `ink-on-board` 4.5 → 3 | KILLED | the id→floor map, `every role names a real token, and its where justifies its floor`, HARNESS SELF-TEST |
| N7 | `advisory-swatch-on-board-2` 3 → 4.5 (the text floor on a swatch) | KILLED (8) | the id→floor map, the `where`/floor test, and six sweep rows (tennis 3.93, volleyball 4.27, tabletennis 4.34, football 4.43, badminton 4.44, carrom 4.48) |
| N8 | relabel a GRAPHICAL row as TEXT, keeping floor 3 | KILLED | `every role names a real token, and its where justifies its floor` |
| N9 | move the football exception to another sport | KILLED (4) | `football · dismissal-swatch-on-board-2`, `volleyball · …`, the exception-list pin, `every exception is a REAL miss` |
| N10 | launder an `unruled` exception into `ruled` | KILLED | `is exactly these three rows, and the two UNRULED ones are owed to the owner` |
| N11 | tighten hockey's dot exception past the measured 2.75 | KILLED | `hockey · live-dot-on-board-2`, `every exception is a REAL miss` |
| N12 | point `SHEET_PATH` at a file that does not exist | KILLED (19 failures; total 381→366, **not** →0) | `both authority documents are readable at the paths this suite resolves` + 18 named §5/§2 tests |
| N13 | point `GLOBALS_CSS` at a file that does not exist | KILLED (10 failures; total stays 381) | the same named test + all seven `--sport-*` mirror rows |
| N14 | change `liveDot` to a hex that CLEARS hockey's band (a stale exception) | KILLED (4) | `hockey · live-dot-on-board-2`, `every exception is a REAL miss`, `the two unruled misses measure what the findings say they measure`, the §2 live-dot mirror |
| N15 | **donor** `DEFAULT_SPORT_PALETTE.led` `#9ae600` → `#a3e635` | KILLED | `…mirrored to globals.css once › --sport-led` |
| N16 | **donor** `DEFAULT_SPORT_PALETTE.board` `#150b36` → `#150b37` | KILLED | `…mirrored to globals.css once › --sport-board` |

N15/N16 replace M1/M2/M19: after the de-duplication those hexes have exactly ONE
home, so the old mirror mutants had no needle. Rather than report a hollow kill,
the one home (`sport-theme.ts`, ship-off-limits) was mutated under a restore
proven twice — byte comparison against the backup, and an empty
`git diff --stat` on that path.

**Fix round 2 — commit 9** (the hairline ruling)

| # | Mutation | Verdict | Killer |
|---|---|---|---|
| P1 | delete the `ink-hairline-on-board-2` role | KILLED (total 401→390) | `the table IS the scope — these exact pairs are gated, at these exact floors`; `the sweep is one row per sport per role`; **`a COVERED row names the pair that actually meets the criterion, and that pair clears`** |
| P2 | hairline takes `--sport-board` (the pad's rule wrongly transferred) | KILLED (12) | eleven `<sport> · ink-hairline-on-board-2` rows (1.08–1.33 < 3) + the carrier test |
| P3 | launder hockey's `covered` row into `ruled` | KILLED | `is exactly these three rows, with the two fills COVERED and nothing left unruled` |
| P4 | drop football's `coveredBy` | KILLED | `a COVERED row names the pair that actually meets the criterion` |
| P5 | point `coveredBy` at a carrier on the WRONG ground | KILLED | the same-ground half of that test |
| P6 | move `dismissal-swatch-on-board-2` to the `board` ground (hiding football's 2.56 again) | KILLED (3) | `football · dismissal-swatch-on-board-2`, the carrier test, `every exception is a REAL miss` |
| N17 | **donor** hockey's `board-2` `#0a4657` → `#1a6677` | KILLED (13) | `hockey · live-dot-on-board-2`, `hockey · dismissal-swatch-on-board-2`, `every exception is a REAL miss`, `the two covered misses measure what the ruling says they measure`, **and `§2's graphical range table … › --sport-ink 1-px hairline — 9.46 (hockey) to 16.11 (icehockey)`** |

N17 is the one that proves §2's new range block is **not** sheet-checking-sheet:
its ranges come from the sheet but its ratios are computed from `SPORT_PALETTES`,
so a palette move reds it and names the sport and the direction.

### Mutant killer list — Task 3 (the visual gate harness)

Three rounds, **23 mutants, 23 killed, no survivors** (the report's own running
total). Round 1 ran 11 with **2 survivors**; both were killed in fix round 1
rather than recorded, and round 2's numbering continues round 1's.

**Fix round 1 — commit 6** (16 run, 16 killed; 19 rows, `8b` replacing round
1's `8`, which the per-axis rewrite subsumes)

| # | Mutation | KILLER |
|---|---|---|
| 1 | `deviceScaleFactor: row.zoom` → `1` | `public-fixture/fixture-320-zoom125: PNG width — deviceScaleFactor did not apply (picture 256px, row declares 320px at zoom 1.25)` |
| 2 | `differingPairViolations`: `ha === hb` → `false` | unit › `differingPairViolations catches two identical pictures, and a pair that was never photographed` — **round 1's first survivor**, killed once `mustDiffer` became a pure function with a unit killer |
| 3 | `truncate-chain`: `minWidth !== "0px"` → `!== "auto"` | e2e probe › `truncate-chain: a length cap ends the walk, a percentage cap does not` (+ the fixture rows) |
| 4 | `expectRailsA11y`: delete the `if (ownTab)` role/name block | e2e probe › `rails-a11y: the tabindex arm and the unreachable arm both fire` — **round 1's second survivor**; it had been *unreached*, not satisfied |
| 5 | `parseManifest`: delete the duplicate-row throw | unit › `rejects what the harness cannot run, BY NAME` |
| 6 | `expectNoClip`: drop `reachable(el) \|\|` from the split | `probe-bleed: the bleed split (1 clip + 1 bleed) disagrees with overflowingIn (1 clipped)` |
| 7 | WCAG-inline predicate `"inline"` → `"block"` | `public-fixture/fixture-320: controls under 44px (kit: … (a) is 111.8x16px — height ×2)` |
| 8b | off-viewport: `xOk` ignores the horizontal rail | `public-fixture/fixture-320: a tap at the centre reaches something else` |
| 9 | `groups` loses `.min(1)` | unit › `rejects what the harness cannot run, BY NAME` |
| 10 | capture loop → `group.rows.slice(0, 1)` | `public-fixture: a PNG is missing` (both groups) |
| 11 | `MIN_PNG_BYTES` → `10_000_000` | `a PNG under 10000000 bytes is a blank or aborted capture` (both groups) |
| 12 | `awaitSelector` back to `main h1` | unit › `no row awaits a selector the branded 404 also satisfies` |
| 13 | bleed accounting `overhang <= attributable + 1` → `attributable >= 0` | e2e probe › `no-clip: a bleeding rail is excused, an overhang it cannot account for is not` |
| 14 | `isLengthCap` → `v !== "none"` (percentage counts as a bound) | e2e probe › `truncate-chain: a length cap ends the walk, a percentage cap does not` |
| 15 | `controlSetViolations`: drop the empty-list branch | unit › `controlSetViolations refuses the two ways an equal control set means nothing` |
| 16 | `knownDefects` wiring returns `[]` for every check | `embed-standings/standings-320: knownDefects records rails-a11y as still broken, but the check now finds nothing — the page was FIXED…` |
| 17 | exemption accumulator fed an empty list | `public-fixture/fixture-320: the bleeds exemptions the checks made do not match the row's declared exempt.bleeds` |
| 18 | zod enum custom `error` removed | unit › `rejects what the harness cannot run, BY NAME` |
| 19 | checks/knownDefects overlap guard removed | unit › `rejects what the harness cannot run, BY NAME` |

**Fix round 2 — commit 10** (7 new, 7 killed)

| # | Mutation | KILLER |
|---|---|---|
| 20 | `KNOWN_DEFECT_CHECKS` widened to every `VISUAL_CHECK` | unit › `knownDefects refuses a check the harness cannot re-run without asserting` |
| 21 | `manifest.json` declares a second offender that is not present | `embed-standings/standings-320: the rails-a11y offenders no longer match the ones this row records…` — proves the comparison is a SET, not "non-empty" |
| 22 | `EXEMPT_KINDS` hardcoded again, dropping `offscreen` | `public-fixture/fixture-320: a check returned exemption kind "offscreen", which no manifest row can declare` |
| 23 | `ExemptShape` back to `z.object` (non-strict) | unit › `refuses a misspelt exempt kind instead of silently dropping it` |
| 24 | the final anti-vacuity block HOISTED above the capture loop | `public-fixture: a PNG under 1024 bytes is a blank or aborted capture` (both groups) — **the mutant an earlier round had declared did not exist** |
| 25 | `offenderIds.push(identity)` → `push("div")` (attribution lost) | e2e probe › `rails-a11y: the tabindex arm and the unreachable arm both fire` |
| 26 | bare-heading guard back to `/^(main )?h[1-6]$/` | unit › `no row awaits a selector the branded 404 also satisfies` |

`numTotalTests` was pinned as well as failures on every round of both tasks — a
mutant that breaks collection shrinks the total and reads as a survivor if only
`numFailedTests` is watched. Two of Task 2's round-1 mutants did exactly that.

### T1 findings

**FS-T1f — the two sub-floor contrast rows are CLOSED as *covered*, and the
closure rests on an obligation W1 owes.** Football's red-card chip measures
**2.56** and hockey's live dot **2.75** on their own `board-2` bands, both under
the WCAG 1.4.11 floor of 3, both on **already-approved §3/§4 themes** that T1
did not design. They are not waived. The owner's hairline ruling makes the 1-px
`--sport-ink` border the element that meets the criterion (9.46–16.11 across all
eleven sports), and `overlay-tokens.ts` encodes this as `status: "covered"` with
a `coveredBy` the test holds to three conditions: the carrier must EXIST, must
clear its own floor for that sport, and must sit on the SAME ground as the pair
it covers. Both numbers stay asserted two-sided at their measured values.

> **The e2e obligation, stated exactly, and it belongs to W1: a 1-px
> `--sport-ink` border on the three discipline card chips and on the live dot —
> all three as the sheet draws them; the RULING covers the red-card chip and
> the live dot — in both §3's bar and §4's bug, asserted in W1's e2e.** No unit test can see
> it — `apps/web` vitest is `environment: "node"`, and the contrast sweep proves
> the colour PAIR would work if the border were drawn, never that it IS drawn.
> `ink` on `board-2` at 9.46–16.11 against a floor of 3 passes identically when
> the hairline is never rendered. **If W1 does not assert it, both closures
> above are unbacked.** The obligation is written into `W1-step-one.md`'s
> acceptance as well as here, because a closure recorded in only one document is
> a closure nobody is assigned.

**FS-T1g — `standings-table.tsx:58` is an axe SERIOUS finding on `main`, and it
needs an owner.** `<div className="overflow-x-auto rounded-xl …">` has no
`tabindex="0"`, no `role`, no accessible name — and in the embed it contains no
focusable child either, so axe's `scrollable-region-focusable` applies at
SERIOUS impact. The harness reported `div 364px in 294px: not keyboard-reachable
(no tabindex=0, no focusable child)` at 320. This is AGENTS.md recurring class
23, exactly the case the standing rule exists for. **T1 was barred from fixing
it and did not:** `StandingsTable` renders on the public site, the embed and the
console, so an accessible name is a new user-facing string owed in all four
locale dictionaries across three surfaces with visual sign-off on each — a wave,
not a line in a test task, and the "fix inline unless blast radius" rule saying
route it. It is encoded as a self-retiring `knownDefects` entry on the
`standings-320` row, so **the day it is fixed that row goes red and tells the
fixer to restore `rails-a11y` to its `checks`**. Nothing schedules the fix.
**Needs an owner and a wave.**

**FS-T1h — `live-score.tsx:245` carries the identical `truncate`-without-`min-w-0`
defect that D4 fixed at `court-card.tsx`.** Same span, same row-flex parent. It
was on T1's do-not-touch list and is recorded, not fixed. **Needs an owner.**

**Correction, recorded at T1 close — this finding was being carried with a
premise that does not hold, and it is worse than it was written.** Task 3's
report and the wave's owed list both justified leaving it with "`<LiveScore>` is
retired, so no photographed route renders it". Only the first half is true, and
the two halves are about different symbols. Read at close, 2026-09-08:

- The **wrapper** `LiveScore` is genuinely retired — `live-score.tsx` exports
  only `LiveScoreBody` (and the `LiveFixtureData` type), and the fixture page
  records the retirement at `fixtures/[fixtureId]/page.tsx:5,286`.
- The **body** is very much alive. `LiveScoreBody` is mounted in production at
  `match-centre/summary-tab.tsx:58` and `match-centre/match-centre.tsx:90`.
- Line 245 sits inside the `{suppressScorebug ? null : (…)}` branch opened at
  `live-score.tsx:194` — so it renders whenever `suppressScorebug` is false.
  `summary-tab.tsx:75` passes `suppressScorebug={!cricket}`, i.e. **false for
  cricket**; `match-centre.tsx:90` passes the prop **not at all**, so it takes
  the `= false` default at `:110` — that is the no-`match_centre`-document
  fallback path.

So this is **not dormant code**. It is a live truncate chain missing its
`min-w-0` on at least the cricket Summary tab and the fallback render — the
exact class that put 106 px of horizontal overflow on a page at 320–390 in the
phone-composition wave, visible only with a realistic long entrant name and only
in a browser. What is true is narrower and is all Task 3 could claim: **no row
in T1's visual manifest photographs it** (the manifest seeds a football fixture),
so the gate cannot see it — which is why it will sit there, not evidence that it
is harmless. **Whoever takes this must settle it by driving the product at 320
with a long cricket entrant name, not by reading either document** — this entry
is a code read, and a read is not a run. Recorded in
`docs/runbooks/visual-gate.md` and here.

**FS-T1i — `dismissal-on-board-2` is scoped to the WICKET slab, and W2 may widen
it.** `_THEMES.md` §5 grants the LED-takes-dismissal behaviour to the wicket
slab only. **If W2 extends that treatment to red-card slabs, football measures
2.56 on its own band** and the covered/carrier accounting above has to be
re-derived for the new pair. This is an owner question for W2's planning, not
for T1, and it must be asked before W2 paints a red-card slab.

**FS-T1j — `court-card.tsx` shipped with no pre-merge test. CLOSED in the
final-review fix round, 2026-09-08.** The D4 fix (a `min-w-0` on the truncate
chain) is a production change on a `main` page, and its only regression witness
was the visual gate — which `.github/workflows/e2e.yml` runs on push to `main`
only, never on pull requests. So the change was covered **after** merge, not
before: "every change ships a test that fails without it" was TRUE and still did
not mean pre-merge coverage.

Closed by two unit tests in
`components/public-site/match-centre/__tests__/court-card.test.tsx` (14 → 16
tests in that file), following the existing node-env idiom in that same file and
in `components/v2/__tests__/phone-disclosure.test.tsx`: `renderToStaticMarkup` of
the real `CourtCard`, then anchored class-list assertions on the rendered markup.
**"The visual gate is the only witness" was a choice, not a constraint** — the
repo already had this idiom in three places, and a review found them in minutes.
Killed by four hand-applied mutants, each restored from a `cp -p` backup: drop
`min-w-0` (both tests red), change it to `max-md:min-w-0` (both red — this is why
the assertions anchor on `(?:^|\s)…(?:\s|$)` and not `\bmin-w-0\b`, which matches
inside the variant), turn the row `flex` into `block` (both red), drop the score
span's `shrink-0` (one red). Total stayed at 16 in every run, so no mutant read
as a survivor by breaking collection.

What this does NOT close: the 320px PAINT. There is no jsdom here and jsdom does
no layout, so the class contract is what these tests pin; the picture stays the
visual gate's job. The only pre-merge e2e path this repo has is
`workflow_dispatch` with `pr=<n>`, and it must still be run against PR-T1 before
merge. Locally the two spectator walkthroughs that cover the surface were run and
returned 19 passed / 0 failed.

**FS-T1k — `auth: true` and `seed: "none"` are inert by ruling, and W1-E's brief
must name them as first-use.** Both are consumed by real harness code
(`capture.spec.ts`'s `storageState`, `seeds.ts`'s `case "none"`) but **no
manifest row declares either**, so neither is driven today. Ruled deliberate
rather than fixed: driving them now means inventing a manifest row that
photographs a page nobody needs, and a row that exists only to exercise the
harness is the kind of row that later reads as coverage. Both fail loudly at
context creation if wrong. **The condition of that ruling is that W1-E's brief
names both as first-use** — otherwise they reach that wave unexercised and
unremembered, which is the inert-seam class (recurring class 1) with a ruling
attached.

**RE-PIN outcomes.** Every brief pin held. Task 2: `sport-theme.ts:77-79`
(`SPORT_TOKENS` / `SportToken` / `SportPalette`), `:165` (`SPORT_PALETTES`),
`globals.css:1135-1141` (the seven `:root --sport-*`), `registry.ts:85`
(`V3_SKINS`) — all exact. `SPORT_PALETTES` has **nine** entries and `V3_SKINS`
**eleven**; the four `V3_SKINS` names with no palette entry (cricket, generic,
boardgame, carrom) are precisely the ones a palette-driven sweep would miss and
the ones that reversed FS-T1d's conclusion. `_THEMES.md` §5's eleven-row table
and §2's fifteen panel ratios reproduce exactly from the palettes. **No false
premise was found beyond the one the dispatch had already superseded.**

### Deferred minors — triaged, none blocking, each named so it is not re-found

- Task 0: the Step 8(a) re-pin check **sits exactly at its floor** (8 against
  ≥ 8) — no margin, so a later edit that drops one re-pin line takes it below
  its floor silently.
- Task 1: §2's "every pair" claim vs the unlisted `text-purple-500` icon
  (`#ad46ff` on white = 4.12:1 — it PASSES the applicable 3:1 non-text floor and
  fails the 4.5 the paragraph implies; same shape for `border-purple-500` on
  §8b's 5-pack tile and the 6-px `bg-red-500` pill dot). §8's `copy button` row
  still carries Tailwind **v3** hexes (`#e9d5ff`, `#7e22ce`) against the
  installed 4.3.1's `#e9d4ff` / `#8200db` — declared out of T1's scope by the
  sheet itself. §4a's `ended` Line says "`resultMsg`'s full sentence" with no
  fallback for the null-outcome case this wave newly established.
- Task 2: the `covered` carrier check omits `carrier.floor >= coveredRole.floor`
  (both are floor 3 today, so it cannot bite yet). Aliasing widens an unfrozen
  shared-object hazard from the pad into the overlay — `Object.freeze` on the
  donor is the right repair and `scorepad/**` is off-limits this wave. The
  eleven-key literal's "alphabetical" comment asserts nothing, since both sides
  of the comparison are sorted.
- Task 3: `ExemptSchema`'s `.default()` is a hand-written tuple and zod 4.4.3
  does **not** re-parse defaults, so a fourth `exempt` kind would be missing
  from every row that omits `exempt` (fail-closed today; one line —
  `.prefault({})`). **`standings-320` records `offenders: ["div"]`, an identity
  with no discriminator** — set equality catches a COUNT change but not a
  SUBSTITUTION, so if that rail is fixed and a different bare-`div` rail on the
  embed becomes unreachable, the row passes green while BOTH the fix and the new
  defect go unreported; this is the same attribution gap the probe rails were
  given `data-testid`s to close in that very commit. `offenderIds`' JSDoc says
  "DISTINCT" where the code deliberately does not dedupe (the behaviour is
  right; the comment describes away the property the comparison depends on).
- Out of scope, recorded: `checks` defaults to `[]`, so a later wave could
  append a row listing `rails-a11y` in **neither** `checks` nor `knownDefects`
  and get no rail assertion at all. All six current rows do one or the other; no
  unit test holds that invariant.

### What T1 does NOT prove

Stated plainly so no later wave reads the green suite as more than it is.
`overlay-tokens.ts` has **no HTTP surface** until the overlay route exists, so
T1 carries **no e2e and no smoke of its own for the token module** — those are
named in W1 Task 8's acceptance as this module's, and that naming is the whole
of the debt's record. The contrast sweep proves colour PAIRS, never that any
pixel is painted. The visual gate photographs `main` pages, not overlay pages,
because no overlay page exists yet. And no migration, dictionary key or
user-facing string was added, so none of the four-locale, OpenAPI or Flyway
gates had anything to catch.

## 2026-09-10 — W1 Task 8 (e2e, smoke, visual gate) — the hairline is DISCHARGED

**T1's one handed-forward obligation is now executed rather than documented.**
Two WCAG 1.4.11 findings — football's dismissal chip at 2.56:1 and hockey's live
dot at 2.75:1, both under the 3:1 graphical floor — were closed as *covered by
the 1-px `--sport-ink` hairline*. `apps/web` vitest is `environment: "node"`, so
until this task no test in the repo could see that border and both closures
rested on prose.

### Inventory

| File | What it is |
|---|---|
| `apps/web/e2e/stream-overlay.spec.ts` | NEW. 11 tests: the hairline (both themes × dot + three chip tones), the entitlement gate as a 404→200 differential, `?style=` fallback, `?lang=`, the canvas scale at four widths, no banner / no cookies, Task 7's link and its reload-for-Replay flip, and one recorded defect (below). Runs in `parallel` — a root spec joins the sharded remainder automatically, no config edit. |
| `apps/web/e2e/overlay-kit.ts` | NEW. The seed, shared with the visual gate: a fresh org, a LIVE FIH hockey fixture, one card of every class, a `stream_url`, and the `streaming.overlay` grant. |
| `apps/web/e2e/visual/manifest.json` | +1 group `stream-overlay`, 4 rows, 3 `mustDiffer` pairs. |
| `apps/web/e2e/visual/manifest.ts` / `seeds.ts` | +1 seed kind `overlay-fixture` — one entry in each of `SEED_KINDS`/`SEED_PARAMS` plus one `seedFor` case, exactly as the runbook's step 2 says. |
| `scripts/smoke.ts` | +`streamOverlaySuite` and its `setBoolEntitlement` SQL flip. Discharges the second handed-forward item: **`overlay-tokens.ts`'s owed smoke**. 12/12 checks. |

### The measured values (this is the point of the task)

Read in a real browser off the computed style, four sides at a time, against the
RESOLVED custom property — never a hex literal, which passes for one sport and
rots for the other ten the same CSS rule serves.

| Element | Measured |
|---|---|
| `[data-testid=ovl-live-dot]`, §3 bar and §4 bug | `1px` / `solid` / `rgb(238, 246, 248)` on all four sides |
| `[data-testid=ovl-chip]` × 3, both themes | same border; fills `rgb(61, 220, 132)` advisory, `rgb(255, 214, 10)` caution, `rgb(255, 90, 77)` dismissal |

`rgb(238,246,248)` is `#eef6f8` — hockey's OWN ink, asserted `!==` the root
default so the per-sport `sportThemeStyle` reaching the canvas is proved too.

**The chips had never rendered for anyone** — not an implementer, not a
reviewer, not the owner (F9). Football's three entries in
`DISCIPLINE_CLASS_TONE` are unreachable by construction and no hockey fixture
with cards existed. The seed here is the first execution of that path, and the
three tones came out right first try.

**Killers, 4 of 4** (injected in the live browser, not in the source, because
the served bundle must not be rebuilt mid-wave): border removed → widths red;
border colour changed → colour red; `.ovl-chip-advisory` repainted as caution →
the tone-mapping assertion red with both values named; scale forced to 1 → red
at 1280 but NOT at 1920, which is why the width list is enumerated.

### FS-W1-8a — §4's corner bug CLIPS ITS OWN FOOTER, and only a picture says so

With three cards the bug's footer wraps to a second line inside a 480 px tile
whose `overflow: hidden` then cuts it: "AWA Red" sliced through, stray `·` dots
along the bottom edge. **Measured: 9 px of the footer is clipped at 1920x1080**
(`.ovl-bug` `scrollHeight - clientHeight`, `overflow-y: hidden`). Three cards in
a hockey match is an ordinary state.

**The visual gate cannot see it and could not have**: `expectNoClip` compares
`scrollWidth` with `clientWidth`, so **every vertical clip in the product is
invisible to the gate**, not merely this one. Scoped separately by the owner.

Root cause is `className="contents"` on the per-entry span — `display: contents`
puts chip, label and separator straight into the flex container, so an "entry"
is not a box that can be kept together. **It is on BOTH twins**
(`overlay-bar.tsx:97` and `overlay-bug.tsx:84`); the bar is merely wide enough
to hide the same latent bug today.

Owner ruling 2026-09-10 (`_THEMES.md` §4 — "the bug footer caps at two entries" and "the bug footer is a list, not a space-between row"; find them with `git log --oneline origin/main..feat/stream-overlay -- docs/.../_THEMES.md`, never by the shas, which a rebase moves): at most
the two most recent entries, one nowrap line, start-aligned with `gap: 18` (not
`space-between`, which pushes two related cards to opposite edges of the tile),
and **the tile must not grow instead** — an OBS operator frames the bug against
their camera. Not fixed here (`overlay-bug.tsx`/`globals.css` are outside Task
8's file set). `stream-overlay.spec.ts` states the CORRECT behaviour behind
`test.fail()`, so the run reds the day the page is fixed; **the fix round's last
step is to delete that one line.**

### Three premises that proved false

- **"No helper under `apps/web/e2e` writes `org_entitlement_overrides`."**
  There is one, exported and documented: `setBoolEntitlementOverrideSql`
  (`helpers.ts:618`), the `bool_value` sibling of `setEntitlementOverrideSql`
  (`:597`). A negative grep was relayed as an absence.
- **F10, "`scrollWidth === clientWidth` is vacuous on the overlay route".** True
  of a hand-written probe, and `globals.css:66-71` sets `html, body {
  overflow-x: clip }` **app-wide** rather than on this route. But the gate's own
  `expectNoHorizontalScroll` temporarily forces `overflow-x: visible` on both
  before measuring, so it is NOT vacuous and the rows list it. The scale
  assertion is still the one that carries the geometry, and it is what has the
  killer.
- **The brief's "grant `streaming.overlay` for the org it creates"** reads as
  the shared Pro org. It must not be: the override is org-WIDE (`resolve()`
  overlays it before the competition-pass arm), so granting there adds the OBS
  panel to every division fixtures tab in the same Playwright job, where
  `run-sheet`/`competition-desk` assert on those rows — and it makes
  "unentitled ⇒ 404" vacuous for every later wave, which is exactly why T1's
  visual pass deleted its own nine override rows. The kit mints its own org.

### Two traps this seed hit, recorded so the next one does not

- **`getPublicFixture` is `unstable_cache`'d at 30 s**, and the overlay route,
  the public match page and the `PUT /stream` write all share that one row. A
  `stream_url` written after the first read is invisible for half a minute; the
  seed therefore writes it before anything reads. The same cache is why the
  live→Replay flip is proved against a SECOND, freshly-loaded page before
  anything is claimed about the first — otherwise "the open page still says
  Watch live" passes because of the cache rather than because of the transport.
- **`invalidateOrgEntitlements` borrows staff on the org's OWNER**, so it must
  be called with that owner's session. A bare `browser.newContext()` inherits
  `AUTH_STATE`, which flips the rig owner to staff and then calls the admin
  route as somebody else: 401.

### Gate numbers, measured on this tree

- `e2e/stream-overlay.spec.ts` — **13 passed** (11 of them this file's, 2 the
  `setup` project), whole file, `--project=parallel`, never a `-g` slice. The
  file is `mode: "serial"`, so a red count from it is a FLOOR: re-run after each
  fix until a full pass completes.
- `e2e/visual/capture.spec.ts` — **8 passed**, all three groups. The new group's
  four PNGs are 81502 / 70663 / 35965 / 91706 bytes with four distinct hashes.
- `scripts/smoke.ts` — **1021 passed, 7 failed**, all twelve overlay checks
  green. Five of the seven are the documented missing-`PLACEMENT_SERVICE_HOST`
  signature (`seazn-local-env` §3b names exactly five). The sixth
  (`billing-quantity`) fires at log line 65, BEFORE anything of this task runs.
  The seventh (`staff_audit_log` chain) is an accumulated-DB condition:
  `verify_staff_audit_log_chain()` already returns a broken row id against 1740
  rows, and appending rows cannot break a chain — only a mid-chain delete can.
- `visual-manifest.test.ts` 12/12, `tsc --noEmit` clean in both projects,
  `eslint` clean, `git status --porcelain packages` empty at every gate.

### What Task 8 does NOT prove

The overlay is photographed and asserted **only for hockey**, because hockey is
the only sport that reaches all three chip tones; the other ten sports' palettes
are proved by `overlay-tokens.ts`'s contrast sweep and by nothing painted.
`hit-targets` and `truncate-chain` are deliberately absent from the overlay rows
— the route has no controls and no ellipsis, so both would report
`inspected: 0`, which the runbook calls a finding rather than a pass. Nothing
here exercises `?delay=` (Task 5d) or the slate (Task 5e). And the gate still
photographs no CRICKET overlay, so §3's chase line remains unphotographed.

### 2026-09-10 (later) — two corrections after the footer fix landed

**The e2e suite only authenticates against `localhost`, never `127.0.0.1`.**
Measured on one server, one commit, one token: signing in at
`http://localhost:3303` lands on `/onboarding` and sets `seazn_session` +
`seazn_org` (**both `secure=true`, domain `localhost`**), and `/api/users/me`
answers 200. The identical flow at `http://127.0.0.1:3303` stays on
`/magic-link`, sets **no cookies at all**, and answers 401. The session cookies
carry `Secure` because `lib/auth.ts:73,172` sets
`secure: process.env.NODE_ENV === "production"` and the standalone prod server
runs `NODE_ENV=production`; a browser stores a `Secure` cookie from
`http://localhost` and not from `http://127.0.0.1`. The symptom is a **401 on
the first authenticated write after sign-in**, several frames from the cause —
`seedRosteredFixture: person "…" → 401`.

This is repo-wide, not this spec's: every spec that signs in is affected, and
`e2e/.auth/pro.json`'s cookies are domain-scoped to `localhost`, so even a
valid storage state does not authenticate a `127.0.0.1` context. **Use
`PLAYWRIGHT_BASE="$SMOKE_BASE"`** — `seazn-env env --label ovl` already emits
`http://localhost:3303`.

**The chip-count assertion was coupled to the pre-fix footer.** The §4 fix caps
the bug's footer at the two most recent entries (`overlay-bug.tsx`'s
`slice(-2)`), so the bug now draws 2 chips where the bar draws 3, and the
hairline test reddened on `toHaveCount(3)`. Corrected without weakening it: the
bar is still held to one chip per card, the bug is held to a count that is
**greater than zero and strictly fewer than the bar's** (the cap must BITE on a
real ledger), and the tones are taken from the **tail** of the seeded list — so
a `slice(2)` in place of `slice(-2)` would draw two bordered chips, satisfy
every per-chip assertion, and still red. The cap's NUMBER stays pinned by
`bug-footer-cap.test.tsx`; the browser asserts what only a browser can.

Re-verified on the rebuilt server at `e00bba49f`: **13 passed**
(`stream-overlay.spec.ts` whole file) and **8 passed** (`capture.spec.ts`, all
three groups). The `test.fail()` this task left behind did its job — the fix
round deleted one line and changed no assertion.

## 2026-09-10 — W1 closing: what is OWED to the next wave

Recorded here, in the tracked corpus, because `.superpowers/` is **gitignored**
(`.gitignore:59`) — the wave's `progress.md`, briefs and review findings die with
the worktree, so anything that must survive belongs in this file.

**Owner decision, 2026-09-10: the organiser panel's e2e goes in the NEXT wave.**
The panel (`components/v2/fixture-stream-panel.tsx`, ~509 lines) has **zero
browser references anywhere in `apps/web/e2e`** and **has never been rendered by
anyone at any width** — it ships on unit tests and a mutation sweep alone. It
does not block the merge: it is a new surface behind `streaming.overlay`, which
`V402` denies on every plan, so nothing regresses if it is imperfect. It is the
**first item of the next wave**, not a discovery for a later one.

Why nobody caught it: **it fell in the gap between two task briefs.** Task 6's
said "No e2e specs — Task 8 owns them"; Task 8's named the overlay route, smoke,
the visual gate and the index, and never named the panel. Both agents did exactly
as instructed. AGENTS.md's own "defect in the gap between two individually-correct
changes".

And a second reason it cannot be tested today: **`e2e/overlay-kit.ts` mints its
org by raw SQL for the OVERLAY ROUTE, which is anonymous.** The console panel
needs `editable = canEdit && !billingFrozen` (`d/[divSlug]/page.tsx:259`), and
the SQL-minted org is never selected as the session's active org — sign-in lands
on `/onboarding` and `canEdit` is false. Proof it is the rig and not the product:
**`run-sheet-edit-time` is absent too**, and that control has nothing to do with
streaming. A panel e2e therefore needs a fully-onboarded seeded org, not just an
entitlement grant.

**Also owed, same wave or sooner:**
- **`expectNoClip` is blind to VERTICAL clipping** — it compares `scrollWidth`
  with `clientWidth` only, so every vertical clip in the product is invisible to
  the visual gate. That is how §4's clipped footer shipped. Fixing it touches
  `e2e/visual/asserts.ts` + `capture.spec.ts`, both read-only for W1.
- **The e2e suite is ENGLISH-ONLY**, which is why a Spanish card label
  overflowing a 480 px tile by ~170 px was invisible to every visual row and
  browser assertion in it.
- `?delay=` leaves the overlay blank for `delayMs` after each load; the clean fix
  is a server-side fold as-of `now − delayMs`, which needs a payload timestamp
  `OverlayLiveData` does not carry.
- Slate renders **two** `seazn` marks — §4a specifies slate's own AND the
  composited scorebug's and never reconciled them. The `brand` slot in
  `2026-09-09-overlay-composition-seam-design.md` is the designed fix.
- The console panel's stream-link input does not pre-fill (`FixtureRow` lacks
  `stream_url`).
- The design of record still documents the **2-arg** `hasFeature` (§3.1, §3.8)
  that would deny an `event_pass_l` buyer; the code correctly uses the 3-arg
  competition-scoped form at every call site.
- The fr/es/nl penalty wordings in `overlay.card.*` are the implementer's own
  sport terminology and want a native speaker's pass.
- `stream-overlay-w2-moments.md` plans `overlay.moment.penaltyClass.*` with the
  same ten English words as `overlay.card.*` — it should **reuse** those keys
  rather than mint a second set.
