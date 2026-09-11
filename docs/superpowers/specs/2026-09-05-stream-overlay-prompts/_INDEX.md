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
| R2-prep | Documentation wave (no product code): fold the 22-row relay signal-path register into its owning documents before R2 starts — D1–D5, T1–T5, U1, C1–C2, M1–M4, P1–P5, plus six extras E1–E6 found while pinning it; owner rulings R-A and R-B taken during it | **Opened 2026-09-10**, branch `feat/stream-r2-prep` | — (docs wave; no plan file) | `_WAVE-2026-09-10-r2-prep.md` | — | Every register row lands in a named document or is recorded as a finding against the register; nothing is silently dropped. Per-row map: "## 2026-09-10 — wave R2-prep" below |

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

## 2026-09-10 — wave R2-prep (branch `feat/stream-r2-prep`)

Opened 2026-09-10, documentation only. Register of record:
`_FINDINGS-2026-09-10-relay-signal-path.html` (22 rows: D1–D5, T1–T5, U1,
C1–C2, P1–P5, M1–M4), committed beside the wave brief
`_WAVE-2026-09-10-r2-prep.md`.

**Why the wave exists at all.** R0, R1 and R2 all have prompts and no plans, and
none has started — no compositor code exists in the tree (no `x11grab`, no
`module-null-sink`, no `runner-fly.ts`). So every D row is a prompt edit costing
minutes rather than a defect costing a wave. That window closes the moment R2
starts.

### Owner rulings 2026-09-10 (R2-prep wave)

Rulings BY THE OWNER, taken 2026-09-10. Everything else recorded in this section
is a **recommendation** or a **finding** and is labelled as one. The two are not
interchangeable, and neither is carried to a peer session as the other.

24. **R-A — the QR contract carries BOTH credential shapes.** The capture QR
    payload v1 carries the SRT triple *and* the RTMPS pair, plus a `preferred`
    discriminator and a `slot`. The primary/fallback **ORDERING is DEFERRED to
    R3**, informed by P5's device spike — ordering is a config line in an app
    nobody has written, whereas the contract is a cross-repo boundary that costs
    two repos to change. Supporting fact:
    `stream.liveInputs.create()` returns `{ uid, rtmps, srt, webRTC }` in ONE
    response, so both shapes are already in hand at provision time; design §7.6
    carries only SRT out of a payload that already had both. Closes register row
    **C1**; NARROWS **T5** rather than closing it (the fallback leg is recorded
    as unproven, with the reason, in R2's acceptance).
25. **R-B — multi-camera is WANTED, later, with the seams shaped now.** Not
    parked, not built. The line: a boundary that **cannot be refactored
    unilaterally** gets shaped for N today — the **session model** (changing it
    later is a migration), the **cross-repo QR contract** (a second repo), the
    **provider port** `RunnerProvider` (a provider seam). Everything
    **in-process** explicitly does **NOT**: relay page layout, switching,
    per-source `jitterBufferTarget`, cross-source NTP — pre-building those is
    the speculative generality `AGENTS.md` forbids. Closes register row **M4**.

    **The modelling decision that makes R-B cheap: N inputs under ONE session,
    not N sessions.** That keeps `fixture_stream_sessions_one_active` correct as
    written (design §6.1), keeps credits and the state machine per-broadcast,
    and keeps §7.4's "one Machine, no fan-in" true.

    **Consequences.** **M3 becomes MANDATORY** — extract `fixture_stream_inputs`
    (`session_id`, `slot smallint`, the ingest columns that sit on the session
    row today, `created_at`); R1 and R2 write exactly one row at slot 0, and
    multi-cam later INSERTS rows instead of migrating a shipped table. An
    `inputs jsonb` column is **rejected**: no constraints, and this repo has
    already been bitten by jsonb coercion reading a written value back as
    something else. **M1 returns as ONE ROW in R0's bench rather than a wave** —
    if N-way WHEP decode does not fit an economic guest, "easy to extend" is
    false at the compute layer however clean the interfaces are, and R0 is
    already sizing that guest for 1x. **M2 stays deferred as mechanism** — see
    below.

Both rulings are struck through in `_OPEN-QUESTIONS.md` as **Q18** (R-A) and
**Q19** (R-B), per this programme's convention that an answered question moves
here with its date.

### The fold map — every register row and where it went

So that every one of the 22 rows is auditable, and a row that is NOT in a
document is visible as such. Destinations are from the wave brief; the rows
marked *finding* did not survive re-pinning and are recorded rather than folded.

| id | destination | edit |
|---|---|---|
| D1 | `R2-compositor.md:74-76` | drop `muted` from the video element |
| D1 | design §7.3 | specify the element's attributes — §7.3 specifies none, which is how the drift got in |
| D2 | design §7.2 | name `module-null-sink` AND `set-default-source <sink>.monitor` |
| D3 | `R2-compositor.md` scope 4, design §3.3 | snap on transport change, resume EWMA after |
| D4 | design §7.1, R2 scope 5 | pin the Machine restart policy to `no` |
| D5 | design §7.2, `R0-bench.md` | the x11grab/Chromium clock beat; R0 watch 1 asks whether capture WORKS, not whether it is smooth |
| T1 | R2 acceptance | a level floor (`astats`/`volumedetect`), not stream presence |
| T2 | R2 scope 7 | an assertion that reads the clap burst, with a millisecond budget |
| T3 | R2 scope 4 + mutants | controller unit, step input, bounded time-to-converge |
| T4 | R2 scope 7 | burn a frame ordinal; assert the decoded sequence has no repeats or gaps |
| T5 | R2 scope 7 | narrowed by R-A: record the fallback leg as unproven, and why |
| U1 | design §7.4, `_OPEN-QUESTIONS.md` **Q17** | BLOCKED on the Cloudflare account; until the spike runs, stated as load-bearing and unobserved |
| C1 | design §7.6 | dual credentials + `preferred` + `slot` — CLOSED by ruling 24 (R-A) |
| C2 | design §7.1 | write `RunnerProvider` down; the hold window as a BEHAVIOURAL clause, not just fields |
| M1 | `R0-bench.md` | 2x and 4x WHEP decode beside the 1x guest sizing |
| M2 | this file, below | DEFERRED; the mechanism owed when multi-cam is specced |
| M3 | design §6.1, `R1-relay-core.md` | extract `fixture_stream_inputs` |
| M4 | `_OPEN-QUESTIONS.md` **Q19**, ruling 25 above | RULED — R-B |
| P1–P5 | this file, below | the capture repo's inheritance; two rows constrain work in THIS repo |
| E1–E6 | see the wave brief | six extras found while pinning the register; E2 folded into `_STATE.md`, E3 corrected below |

### M2 — DEFERRED: cross-source capture sync has no mechanism at all

**Deferred, and owed when multi-camera is specced.** Not a defect in R2, which
ships single-camera; recorded here because it is the one multi-cam row that
ruling 25 does *not* shape a seam for, and a later wave will otherwise re-derive
it from scratch.

Each phone must report an **NTP-synced CAPTURE timestamp through the session
API**, folded into its playout target. Equalising transport latency with
`jitterBufferTarget` aligns **ARRIVAL**, not **CAPTURE**: independent handset
clocks with no genlock mean a cut taken mid-delivery jumps. Handset NTP is
accurate to tens of milliseconds; **without this mechanism the floor is 100–300
ms of visible error**, which is the difference between a cut and a glitch.

Consistent with ruling 25's line: the timestamp FIELD is a cross-repo session-API
boundary and would be shaped now if it were free, but the playout-target folding
is in-process and is explicitly not pre-built.

### P1–P5 — the capture repo's inheritance, recorded here because two rows constrain THIS repo

R3's native capture apps live in their own spec in the capture repo (ruling 18).
The app owns its binding — HaishinKit.swift on iOS, StreamPack on Android, a
React Native shell; no third-party streaming plugin (`haishin_kit` was ruled out
on its own maintainer's advice, and its Android engine has no SRT). These are the
risks that survive that decision. **Two of them are not the capture repo's
problem alone:**

- **P5 — no device spike has been run against the chosen engines. STARTABLE NOW,
  and it touches nothing in R2.** One afternoon before R3 commits: StreamPack on
  a real Android handset and HaishinKit.swift on a real iPhone, landscape,
  publishing three hours into a real Cloudflare input, with the screen locking
  part-way. It settles P1, P3 and P4 together and gives the binding estimate a
  floor. **It blocks the R3 estimate and nothing else** — R2's soak drives a
  synthetic source and needs no phone, so P5 runs in parallel with R2 rather
  than on its critical path. (It does share R0/R1/U1's one blocker: a real
  Cloudflare input needs the account.)
- **P1 — iOS drops the camera when backgrounded; Android does not. This changes
  what R2's SOAK should prove.** Android keeps publishing behind a foreground
  service with the right `foregroundServiceType`; iOS will not keep the camera
  running in the background at all. Over three hours the operator's phone **will**
  lock, take a call, or be switched away from — so on iOS the slate-and-reconnect
  path stops being an edge case and becomes **normal operating mode**. Either the
  app prevents idle lock and warns the operator, or design §7.4's choreography
  runs many times per match. A soak written as "prove the slate covers a rare
  blip" is therefore written against the wrong hypothesis.

The other three, for completeness, are R3-scoped and constrain nothing here:
**P2** the publish loop must live in native code, not JavaScript (a stalled JS
thread or a backgrounded app must not take the stream with it; native owns
connect, publish, reconnect and protocol fallback, reporting upward at ~1 Hz).
**P3** thermal and battery behaviour over a full match is unvalidated — assume
mains or a large PD bank; 720p30 at 3000k is the right ceiling but has not been
measured on the handsets clubs own. **P4** landscape capture is a known trap in
this problem space (HaishinKit.dart issue #160: preview and outgoing stream
remained portrait in landscape) — prove preview orientation, encoded orientation
and rotation metadata **separately**; they fail independently.

### E3 CORRECTION — the organiser-panel blocker, re-pinned 2026-09-10

The "W1 closing: what is OWED to the next wave" section above records this
blocker in terms of `canEdit` (via `editable`) alone. **Re-pinned against this
tree, the gate is FOUR conditions across TWO files, and the recorded mechanism is
one of three competing accounts.** All anchors below were opened and read on
2026-09-10, not grepped.

**The gate.** `apps/web/src/components/v2/desk/run-sheet-row.tsx:386` — note the
`desk/` segment, which the wave brief's path omits:

```
const showStream = canEdit && stream !== undefined && stream.entitled;
```

The middle condition is **not free**. `stream` is `undefined` unless the division
page passes it, and `d/[divSlug]/page.tsx:424` reads
`const streamOffered = tab === "fixtures" && editable;` with `:427` building the
object only when `streamOffered`. `editable` is itself `:259`
`canEdit && !billingFrozen`. So reaching the panel needs: the fixtures tab, an
org that is not billing-frozen, a session that can edit, **and** the entitlement.

**The entitlement half — the recorded reason is wrong, and the fix already
exists.** `stream.entitled` is `:426`
`hasFeature(auth.orgId, "streaming.overlay", competition.id)`. It is not a PLAN
read at all: `streaming.overlay` is granted by no plan on any tier, so no
plan-setting helper could ever satisfy it — which makes "the plan-setting helper
is group-scoped, not org-scoped" true of that helper but beside the point.
`e2e/overlay-kit.ts:240-241` already ships the right tool, ORG-scoped and lifting
exactly the key the gate reads:
`setBoolEntitlementOverrideSql(orgId, "streaming.overlay", true)`. **A panel rig
calls `grantOverlay(orgId)`; the entitlement half is solved.**

**The `canEdit` half — three accounts, and only one has an observation behind
it.** Recorded so the next session does not pick one and build a rig on it:

1. *This file's W1-closing section:* the SQL-minted org is never selected as the
   session's ACTIVE org, so sign-in lands on `/onboarding` and `canEdit` is
   false. Its evidence is an observation — `run-sheet-edit-time` is absent too,
   and that control has nothing to do with streaming. **This is the only one of
   the three with a measurement behind it.**
2. *The wave brief's account:* "the browser arrives as `AUTH_STATE`, a different
   user in the shared Pro org". **False as written for `seedOverlayFixture`:**
   `overlay-kit.ts:164` is `await signInAs(page, ownerEmail)`, and the docblock
   at `:135-137` states "`page` is left SIGNED IN as the rig's owner". The mint
   block the brief cites as `:151-159` is `:149-162` (four inserts inside
   `withDb`); the drift is one line at each end.
3. *The AUTH_STATE hazard, which is real but arrives differently:* the same
   docblock tells callers the overlay route is anonymous and "every assertion
   should open its own context", and a bare `browser.newContext()` inherits the
   project `storageState` — the shared Pro org, a different user against the
   minted org. A panel assertion written the way the overlay assertions are
   written lands in exactly this hole.

**Recommendation (mine, not a ruling): drive the panel once by hand before
writing the rig.** Which of the three is live is settled by loading
`?tab=fixtures` as the minted owner and looking, not by reading any of them. A
read is not a run.

**And the brief's conclusion stands, for a reason worth writing down.** Fixing
`canEdit` alone leaves the panel invisible with **no distinct empty state to say
why**: a false `stream.entitled` and an absent `stream` both collapse to
`showStream === false` at `:386`, so the DOM cannot tell a test which of the four
conditions failed. A rig that gets three of four right reports the same nothing
as a rig that gets none.

**One brief claim narrowed, not corrected:** `fixture-stream-panel.tsx` has one
reference under `apps/web/e2e` — a COMMENT at `stream-overlay.spec.ts:672`
naming the unit-test file. The W1-closing section's phrasing, "zero **browser**
references", is the accurate one and stands: nothing renders it.

### What this wave does NOT do

- It writes **no product code**. The organiser-panel e2e (G1) is the only code
  task the wave brief carries, and it is tracked separately.
- It does **not** answer U1 — blocked on the Cloudflare account, an owner
  action. See `_OPEN-QUESTIONS.md` Q17.
- It does **not** renumber the design's migrations. E1 (design §5.1's `V401` and
  §6.1's `V402` are both taken on `main`) is recorded in `_STATE.md` against the
  standing RULE — read the tail of `db/migration/deltas`, never carry a number
  forward from a document.
- The remaining extras **E4** (design §6.1 says RLS is enabled on "all three
  tables" and defines two), **E5** (§6.3 returns `503 storage_exhausted` while
  §6.4 lists it as a `failed(reason)` state — they disagree on whether that
  condition ever creates a row) and **E6** (§9a makes ports-and-adapters binding
  while `RunnerProvider` is named and never defined) belong to the design of
  record and are folded there, not here.

## 2026-09-10 — W2 task zero: the RE-PIN, closed

Three read-only scouts, `model: opus`, against `main` `10c7f94cd` in worktree
`.claude/worktrees/stream-w2` (branch `feat/stream-w2-moments`). The table in
`W2-moments.md` was last verified on 2026-09-08 at `60c0615b0`; W1 overlay
(#761), the R2-prep fold (#767) and four other PRs have landed since. Every row
was re-opened, not re-grepped.

**Verdict in one line: the wave's SHAPE changes. Its scope does not.** The
moments the owner named all still exist and all still fire; the mechanism that
was briefed to detect them does not, for the two sports he named first.

### RE-PIN table — outcomes

| Row | Verdict | Pin on `10c7f94cd` |
|---|---|---|
| Overlay route (the ONE poll target) | HELD | `apps/web/src/app/api/v1/public/fixtures/[id]/overlay/route.ts:11` |
| `OverlayLiveData` | HELD | `apps/web/src/components/public-site/live-score-data.ts:59-71` |
| The projector's emitted field set | **MOVED (semantic)** | `apps/web/src/server/overlay/project.ts:159-178` — emits ONLY `status, summary, outcome, lastSeq, venueTz, clock?, cricket?` |
| Overlay load path | HELD | `apps/web/src/server/overlay/load.ts:76-81` |
| `MatchCentreDoc` | HELD (±1) | `apps/web/src/server/public-site/match-centre-schema.ts:84-97`, `timeline` `:87` (was `85-97`) |
| `publicFixture()` / `match_centre` | MOVED | `apps/web/src/server/usecases/public.ts:433`, spread `:480-481` (was `:392-393`) |
| `TimelineLine` | HELD | `match-centre-schema.ts:69` — `{seq, at, marker, sideIndex, text, emphasis}`, still NO `type` |
| `TIMELINE_KEY_FOR` | HELD | `apps/web/src/lib/timeline-keys.ts:60` — many-to-one, inversion lossy |
| `buildTimeline` / `TimelineArgs` / `personOf` | HELD | `apps/web/src/server/public-site/timeline.ts:587`, `:80-92`, `personOf` `:91` |
| `loadMatchCentre` | HELD | `apps/web/src/server/public-site/match-centre-load.ts:248` |
| `useLiveFixture` | MOVED + **WIDENED** | `apps/web/src/components/public-site/match-centre/use-live-fixture.ts:65`; returns FOUR fields `{data, transport, presentationNowOffsetMs, awaitingDelay}` `:42-63` |
| Overlay's hook call | HELD | `apps/web/src/components/overlay/overlay-stage.tsx:64` |
| `LiveScoreBody` | MOVED (path) | `apps/web/src/components/public-site/live-score.tsx:103` — not under `match-centre/` |
| `Side` | HELD | `match-centre-schema.ts:11` |
| `MatchCentreHeader` | MOVED (range) | `match-centre-schema.ts:14-38` (was `:14-24`); `battingIndex` `:20`; `phase`/`strength` added by W1 |
| `CricketView.live` | MOVED | `match-centre-schema.ts:55`; all eight fields hold |
| `CricketBattingRow` / `CricketBowlingRow` | MOVED | `:40` / `:41` (was `:26-27`) |
| `maskPublicEntrantNames` | MOVED | `apps/web/src/server/public-site/data.ts:565` (was `:510`) |
| `PublicFixture.last_seq` | MOVED | `apps/web/src/server/public-site/data.ts:284` (was `:206`) |
| `registry.ts:35,89` | **GONE as briefed** | Those lines are `SportRegistry` and its singleton. The registry declares NO event vocabulary; event types are per-module |

### Findings

**W2-F1 — the moments source is the FALLBACK, and this is now settled.**
False-premise 1 confirmed false. No raw `score_events.type` reaches the
overlay's single poll by any path: `projectOverlayLiveData` never sets
`match_centre`, `TimelineLine` carries no `type`, and `TIMELINE_KEY_FOR` is
many-to-one so the key cannot be inverted. W2 therefore adds its own
`recentEvents` projection to `OverlayLiveData`, reading `score_events`
server-side under `apps/web/src/server/overlay/`. The PR says so in its first
paragraph, and the wave owes the spectator programme a RECOMMENDATION (never
"the owner ruled") that raw types be carried.

**W2-F2 — `match_centre` typechecks on the overlay payload and is always
`undefined` at runtime.** `OverlayLiveData extends LiveFixtureData`, so
`data.match_centre` compiles clean while the projector never sets it. An
implementer reaching for it gets a green `tsc` and silence. This is the repo's
inert-seam class with a type system actively vouching for the dead field.
Whatever W2 builds must not read it, and the wave should consider narrowing the
type so the compiler stops lying.

**W2-F3 — CORRECTED 2026-09-11, and it was overstated. The finding applies to
the BRIEF, not to the PLAN.** `W2-moments.md` scope item 2 briefs
`MOMENT_TYPES: Record<sportKey, Record<eventType, { tone; headlineKey }>>` — a
flat type→tone map, which is genuinely falsified below. But the implementation
plan (`plans/2026-09-05-stream-overlay-w2-moments.md`, Task 2) already specifies
`MOMENT_RULES: Record<sportKey, Record<string, MomentRule>>` where
`MomentRule = (ev, ctx) => OverlayMoment | null` — a FUNCTION that inspects the
payload. It already reads `boundary 6` → SIX, `boundary 4` → FOUR and
`wicketKind` → OUT off `cricket.ball`, already names `hockey.suspension.start`
and `icehockey.suspension.start` rather than a `*.card` that does not exist,
already derives set/match point, and additionally names
`cricket.superover.ball` (verified at `cricket.ts:408`, sharing the `CricketBall`
schema) which this re-pin's own scout list missed. **No mechanism change is owed
in the plan; the brief is what needs correcting.** Per `W2-moments.md`'s own
rule, a brief/plan conflict is this finding.

What DOES survive from the original finding, and is still owed: **a band-2
cricket ledger has no `cricket.ball` at all** (only `cricket.player.line`), so
an OUT at band 2 needs the line diff of W2-F6 — the plan's Task 2 does not
handle that case. And W2-F4's per-module EVENT-vs-DERIVED table CONFIRMS the
plan's derived branch rather than correcting it.

The falsified claim, which stands against the brief only:
**the brief's flat type→tone allowlist cannot express the two sports the
owner named first.** Scope item 2 briefs `MOMENT_TYPES: Record<sportKey,
Record<eventType, …>>`. Against the modules:

| concept | reality | pin |
|---|---|---|
| cricket four / six / wicket | **no discrete types** — all three are payload fields of `cricket.ball`: `boundary: 4`, `boundary: 6`, `wicket: CricketWicket` | `packages/engine/src/sports/cricket/cricket.ts:407,177,188,168` |
| football goal / card | `football.goal` / `football.card` — as briefed | `football.ts:438,439` |
| hockey card | **`hockey.suspension.start`** — there is no `hockey.card` | `period/kernel.ts:1822,1824`; `hockey.ts:45,49` |
| icehockey card | **`icehockey.suspension.start`** | `period/kernel.ts:1822,1824` |

An allowlist keyed on `"cricket.wicket"` or `"<sport>.card"` would mute every
cricket dismissal and both hockey codes while staying green — the strings do
not exist. The allowlist becomes a per-sport MATCHER over `(type, payload)`,
not a `type → tone` map. Owner scope is unchanged: SIX, OUT, GOAL and the cards
all still fire.

**W2-F4 — set point and match point are DERIVED in all four racket/net
modules; set won is an EVENT only at band 0.** No `matchPoint` / `setPoint`
symbol exists anywhere in `packages/engine/src` or `apps/web/src`.

| module | set point | match point | set won | ace |
|---|---|---|---|---|
| tennis | DERIVED | DERIVED | EVENT band 0 `tennis.set_summary`; DERIVED at band 3 | DERIVED — `tennis.point` `meta.kind: "ace"`, a payload field, not a type |
| badminton | DERIVED | DERIVED | EVENT band 0 `badminton.game.summary` (`partial:true` = NOT won) | n/a |
| tabletennis | DERIVED | DERIVED | EVENT band 0 `tabletennis.game.summary` | n/a |
| volleyball | DERIVED | DERIVED | EVENT band 0 `volleyball.set.summary` | n/a |

Evidence: `nested/kernel.ts:200,223,234,363,1565-1569,1702`;
`setbased/kernel.ts:147,281,1645-1650,1812`. The only summary readers that
exist are `setBreakdown` (`apps/web/src/lib/public-site.ts:301`) and
`servingSide` (`:416`) over `ScoreSummary {headline, perSide, detail}`
(`packages/engine/src/core/types.ts:143`). So the derived branch the brief
allowed for is the ONLY branch for these, at the bands anyone streams at.

**W2-F5 — false-premise 3 is false, and it falls the safe way.**
`PublicFixture.last_seq` (`data.ts:284`) is not `max(seq)` over the ledger — it
is the seq of the last appended row, cached on `match_states.last_seq` and
upserted per append (`engine-db/append-event.ts:341-345`,
`V217__match_states.sql:4`), surfaced through `public_fixtures_v`. Seq is
gapless, `expectedSeq + 1` (`append-event.ts:213`). A void **appends** a
`core.void` row through the same path (`usecases/scoring.ts:97,236`;
`core/events.ts:165-190`); the voided row is never mutated. So `last_seq` is
strictly monotonic and a void increases it. The re-fire the brief feared cannot
happen. `resolveVoids` still filters at read, so the projection must apply it.

**W2-F6 — a band-2 cricket wicket needs a line DIFF, not a type match.**
False-premise 5 confirmed false. Band 2 cricket declares exactly one type,
`cricket.player.line` (`cricket.ts:3358`, map `:3346-3361`); no `cricket.wicket`
exists at any band. A wicket is `CricketPlayerLine.batting.out: boolean` plus
optional `batting.dismissal.{kind,bowler,fielder}`, and `bowling.wickets` as a
count (`cricket.ts:332,341,346-353`). The line is a **cumulative** scorecard row
re-appended from the `post`-phase panel (`:3326-3330`), so the same person's
line arrives repeatedly with new totals — the OUT moment fires on `batting.out`
flipping false→true, and must not re-fire on the next cumulative re-append.

**W2-F7 — neither consent resolver is reachable from the overlay.**
False-premise 4 confirmed false, and worse than briefed. There are two disjoint
resolvers: `maskPublicEntrantNames` (`data.ts:565`) for entrant names and
`resolvePersonDisplayName` (`apps/web/src/lib/name-display.ts:72`) for person
names, the latter reached through `personOf` (type
`apps/web/src/server/public-site/match-centre.ts:185`, built `makePersonOf`
`:214`, wired `:984`) fed by `readPublicLineups`
(`apps/web/src/server/public-site/public-lineups.ts:25,41`). W2's moment lines
name PEOPLE, so `personOf` is the one — but `server/overlay/load.ts` and
`project.ts` do no lineup or person read at all. W2 must ADD that path
server-side. This was briefed as reuse; it is new work.

**W2-F8 — two one-authority duplicate pairs, confirmed.** False-premise 7
confirmed false: the overlay payload carries neither `Side.short` nor
`battingIndex`, and the overlay derives its own of each in the CLIENT from
`summary` — `shortCode()` (`apps/web/src/lib/overlay-model.ts:187`, three-letter
fallback `:191`) against wire `Side.short` (`match-centre-schema.ts:11`), and
`ledEntrantId()` (`overlay-model.ts:439`) → `battingEntrantId()`
(`apps/web/src/lib/public-site.ts:497`) against wire
`MatchCentreHeader.battingIndex`, derived server-side at `match-centre.ts:765`.
Retiring the overlay's copies is NOT a repoint: the wire values would have to
start arriving on the overlay payload first. Recorded, not actioned by W2.

**W2-F9 — plan/brief conflict on where `recent` lands.** The plan's
Architecture paragraph puts it on "the public fixture payload"; the brief's F4
ruling puts it on `OverlayLiveData`, because the overlay no longer polls the
public fixture route. Per `W2-moments.md`, the brief's rulings win and the
conflict is this finding. `recentEvents` goes on `OverlayLiveData`.

**W2-F10 — the plan's PRIMARY source for the cricket batter line is
unreachable.** The plan names `match_centre.cricket.live` as primary with a
server fallback. Per W2-F1 and W2-F2, `match_centre` never arrives on the
overlay payload, so the fallback — a server-side `foldMatch` with the real
cricket module, projecting striker/non-striker `runs(balls)` and bowler
`O-M-R-W` — is the ONLY source. The primary/fallback framing is struck.

**W2-F11 — the transport grew a field the slab must respect.**
`useLiveFixture` now returns `awaitingDelay` (I1, 2026-09-10), already
destructured at `overlay-stage.tsx:64`. A moment raised while the delayed
transport is still catching up would replay history — precisely what mutant (h)
exists to kill. The stage's `seenSeq` initialisation and the queue push must
both gate on it.

**W2-F12 — `HOLD_MS` has a shipped precedent to copy verbatim.**
False-premise 6 is true and already solved for the pad: five symbols —
`HOLD_MS_DEFAULT = 12000` (`apps/web/src/components/v2/scorepad/queue.ts:139`),
`MIN_HOLD_MS = 500` (`:160`), `HOLD_MS_ENV_VAR` (`:143`), the resolver
(`:161-165`, bad/empty/sub-floor → default, never 0) and the live constant whose
env read is spelled LITERALLY (`:184`) — plus four tests, including a value
guard pinned to the DEFAULT (`__tests__/soft-commit.test.ts:83-85`) and a
source-text guard (`:115-131`) that a dynamic `process.env[VAR]` read cannot
survive. W2 copies the shape.

### Stale pin found in code (not a defect, worth a one-line fix)

`apps/web/src/server/public-site/public-lineups.ts:10` cites
`data.ts:510-599` for `maskPublicEntrantNames`, which now begins at `:565`.

### What task zero does NOT close

The plan's Task 1 still carries comment-sketched and empty `it(...)` bodies,
written that way because these shapes were unpinned. They are now pinned. Those
bodies must be written into real assertions — and re-reviewed — before Task 1
starts. An empty `it()` passes vacuously; none may reach a commit.

## 2026-09-10 — U1 spike, step 1: the live input's real shape (MEASURED)

The owner provisioned a Cloudflare account, subscribed to Stream and issued an
account-owned token (`cfat_` format, `Account → Stream → Edit`). First
measurement against the real API. One live input was created, read and deleted;
`live_inputs` is back to 0 and nothing remains on the account.

Method: `POST /accounts/{id}/stream/live_inputs` with the design's own config
(`recording: { mode: "automatic", timeoutSeconds: 10, requireSignedURLs: false,
deleteRecordingAfterDays: 7 }`), then `DELETE`. Secrets were never printed —
only shapes and lengths.

### U1-S1 — `deleteRecordingAfterDays` is TOP-LEVEL, and nesting it is SILENTLY IGNORED

Sent as a member of `recording`. Cloudflare returned HTTP 200, `success: true`,
and an echoed `recording` block that does **not contain the key at all**:

```
recording echoed: { allowedOrigins, hideLiveViewerCount, mode, requireSignedURLs, timeoutSeconds }
top-level deleteRecordingAfterDays: null
```

The field is a sibling of `recording`, not a child. A nested spelling is
accepted with a 200 and dropped on the floor.

**Why this is not cosmetic.** Design §12 sets `deleteRecordingAfterDays = 7` at
launch, and §6.5 depends on it: recordings must expire for the prepaid storage
block to recycle. If R1 sends it nested, retention is never configured,
recordings accumulate, the block fills, and §6.5's `503 storage_exhausted`
begins refusing sessions — with a green create call and a 200 in the log at
every step. R1 must send it top-level AND assert it comes back non-null on the
create response; a test that only asserts HTTP 200 cannot see this.

### U1-S2 — C1 holds and UNDERCOUNTS: SIX credential objects, not three

The design (§7.6, C1) records that `liveInputs.create()` returns
`{ uid, rtmps, srt, webRTC }` in one response. It returns those **and a
playback twin of each**:

| object | keys |
|---|---|
| `rtmps` | `url`, `streamKey` |
| `rtmpsPlayback` | `url`, `streamKey` |
| `srt` | `url`, `streamId`, `passphrase` |
| `srtPlayback` | `url`, `streamId`, `passphrase` |
| `webRTC` | `url` (the WHIP publish endpoint) |
| `webRTCPlayback` | `url` (the WHEP play endpoint) |

plus `playback: { hls, dash }`, `uid`, `enabled`, `status`, `created`,
`modified`, `meta`.

**Consequence for R2.** `webRTCPlayback.url` is the compositor's WHEP pull
target and it is in hand at provision time — the compositor needs no second API
call and no URL construction to find its source. The same is true of
`playback.hls` for the LL-HLS fallback path (§3.x transport change). Both should
be persisted with the session rather than derived later.

Observed non-secret shapes: ingest `rtmps.url` is the shared
`rtmps://live.cloudflare.com:443/live/` with a per-input `streamKey` (65 chars);
`srt.url` is `srt://live.cloudflare.com:778` with `streamId` = the input `uid`
and a 65-char `passphrase`. Playback SRT uses `streamId` = `"play" + uid`.
The 65-char lengths pin the `*_enc` envelope column sizing in §7.6.

### U1-S3 — creation is NOT gated by zero storage headroom (partial, do not overread)

`storage-usage` reports `totalStorageMinutesLimit: 0` on this account, and the
create still returned 200. So the design's [B]-rated claim — *an exhausted
storage block stops NEW live streams from starting* — is **not about input
creation**, which succeeds regardless.

**This does not falsify the claim.** What was measured is that a live input can
be CREATED at zero headroom. Whether an ingest connection can be ESTABLISHED, or
a recording begun, at zero headroom is untested — that needs a real push, which
is step 2. §6.5's guard is therefore still correctly placed (it refuses before
the insert, on headroom, not on a create error), but the sentence justifying it
should say which of the two it rests on. Evidence stays [B] pending step 2.

### What step 1 did NOT answer

**U1 itself is still UNOBSERVED.** The hold window — *does a playback connection
survive its input disconnecting, and for how long* — requires pushing a feed,
opening a WHEP connection, cutting the ingest and timing the drop. That is step
2. Design §7.4's choreography, the ~8 s slate, and the "encoder never restarts"
property all still rest on it, and §9.2's evidence marker stays **D for the hold
window**.

`timeoutSeconds: 10` was accepted and echoed inside `recording`, consistent with
the standing reading that it governs the RECORDER, not a playback hold. Nothing
observed here contradicts or supports the hold.

## 2026-09-11 — U1 step 2: WHEP IS NOT AVAILABLE TO THIS ARCHITECTURE

**The composited tier cannot pull WHEP, and the design is built on the assumption
that it can.** Measured against the live API, and confirmed in Cloudflare's own
documentation.

### U1-S5 — an RTMPS/SRT live input is not playable over WHEP

Method: create a live input, push RTMPS from ffmpeg (`testsrc2` 720p30 + 1 kHz
tone), confirm Cloudflare reports `status.current.state = "connected"` with
`ingestProtocol: "rtmp"`, confirm the HLS manifest is serving and advancing, then
POST a WHEP offer to `webRTCPlayback.url`.

```
input state:                 connected   (ingestProtocol "rtmp")
HLS manifest:                200, media-sequence advancing
WHEP POST /webRTC/play:      409 Conflict — "Live broadcast not started yet"
```

Repeated across three runs. Cloudflare's WebRTC documentation states the rule
directly:

> "WHIP and WHEP must be used together: we do not yet support inputs using
> RTMP/SRT to be played using WHEP, or inputs using WHIP to be recorded and
> played using HLS/DASH."

**What breaks.** §3's Tier B composed path is *phone (SRT/RTMPS) → Cloudflare
live input → Fly Machine pulls **WHEP** → relay page → RTMPS to destination*.
The pull is impossible. The 409 is not a warm-up race or a beta gate — an
RTMPS-ingested input is never WHEP-playable, at any point in its life.

**The obvious escape hatch is also closed.** Switching the phone to WHIP ingest
would satisfy WHEP playback but forfeits HLS/DASH playback *and recording* — which
removes the recording the storage design (§6.5, §12) manages and the replay RD10
fills `stream_url` from. The same sentence closes both doors.

**So the compositor pulls HLS / LL-HLS.** Consequences that must be re-derived
rather than assumed:

| What | Was | Now |
|---|---|---|
| R2 relay page `<video>` source | WHEP, LL-HLS as fallback | LL-HLS (or HLS) as the ONLY source |
| Transport-change choreography (§3, the WHEP → LL-HLS fallback and its discontinuity rule) | a real code path | **moot — there is no second transport to fall back FROM** |
| Glass-to-glass latency | WHEP (sub-second class) | HLS; LL-HLS materially better than plain HLS but not WebRTC-class. **Unmeasured — the latency budget needs re-deriving** |
| Delivery cost | "WHEP delivery free until 2026-10-15" | **HLS delivery bills NOW** at $1 / 1,000 min. The £0.14-per-match delivery line in §9.2 is no longer zero-rated |
| LL-HLS beta toggle | never mentioned | **load-bearing.** Off by default (confirmed in the dashboard); the compositor's latency depends on it being ON |

The `webRTC` / `webRTCPlayback` pair still returns on every create (U1-S2) — it
is simply unusable for this ingest. Persisting `webRTCPlayback.url` with the
session is therefore pointless until an all-WebRTC tier exists; R1 should persist
`playback.hls` instead.

### U1-S6 — the edge 403s a non-browser client on the manifest

`GET` the HLS manifest with Python's default `urllib` agent returns
**403 `error code: 1010`** — Cloudflare's edge rejecting the client by user
agent — on a manifest that is healthy and serving. The same URL with a browser
`User-Agent` returns 200 and the playlist.

This is a live trap for the programme, not a probe artefact: **a server-side
health check, a watchdog, or any `fetch`-based liveness probe of the manifest
will read a healthy stream as down** unless it sets a browser-like agent. The
compositor is headless Chromium and is safe; anything in R1's heartbeat or the
sweep that polls the manifest from Node is not. Whatever polls the manifest sends
a real `User-Agent` and asserts a 200 against a KNOWN-GOOD stream in test, or the
guard is decoration.

### U1-S7 — THE HOLD WINDOW IS `recording.timeoutSeconds`, AND IT IS TUNABLE

**U1 is ANSWERED.** The premise §7.4 rests on — *the front door keeps a playback
path alive for ≥ N seconds while its input is disconnected* — is TRUE, N is
settable, and the control is the very field this programme withdrew as
irrelevant on 2026-09-10.

Method: one live input; ffmpeg pushing RTMPS (`testsrc2` 720p30 + 1 kHz tone);
settle; `SIGKILL` the encoder; poll the HLS master and its variant twice a second
(re-resolving the master each time, so a resumed broadcast arriving as a new
variant is visible); restore the encoder; watch. Run three times, varying
`recording.timeoutSeconds` and the gap, so causation is separated from
coincidence.

| gap | `timeoutSeconds` | `EXT-X-ENDLIST` | master after | resume lag | recorded videos |
|---|---|---|---|---|---|
| 60 s | **10** | cut **+12.2 s** | 200 (finished playlist) | — | 2 |
| 90 s | **60** | cut **+63.1 s** | **204** from +63.1 s | resume **+27.1 s** | 2 |
| **20 s** | **60** | **never** | **200 throughout** | resume **+3.9 s** | **1** |

Two points on the line at ≈ `timeoutSeconds + 3 s` (the +3 is this probe's 1–3 s
poll round trip, not a Cloudflare property), and a third run inside the window
that behaves exactly as that model predicts. The field is the control.

**The correction this forces.** The design's evidence table says
`timeoutSeconds` "governs when a disconnect starts a NEW recorded video, which
describes what the RECORDER does and says nothing about what a playback
connection sees". The first half is right; the second half is false. It governs
BOTH, because they are one event: at the deadline the recorded video closes AND
the live playlist is terminated. Measured: a 40 s pre-cut period produced a first
recorded video of `state=ready duration=40.02`, ended in the same beat as the
playlist.

**An IN-WINDOW dropout is invisible.** 20 s gap inside a 60 s window: no
`ENDLIST`, the master never leaves 200, the manifest resumes advancing **3.9 s**
after the encoder returns, on the same URL, and Cloudflare records the whole
thing as **ONE** video. This is the "encoder never restarts" property, measured.

**Inside the window, playback STALLS rather than fails.** The playlist stays
live-marked but does not advance — no ingest, no new segments. A player runs its
buffer down and waits. So the slate's trigger is "segments stopped arriving",
never "playback errored"; a guard written against an error event would never
fire.

**Beyond the window.** `EXT-X-ENDLIST` on the variant, `204` on the master, and
a SECOND recorded video on return. The master playback URL still survives and
re-resolves to the new broadcast — no new URL need be issued — but recovery cost
**27 s** on top of the 90 s outage, versus 3.9 s for the in-window case.

**Range, asked of the API rather than assumed** (the discipline that caught
U1-S4): `timeoutSeconds` accepts **1 … 86 400** (24 h) — every value probed at
1, 5, 30, 60, 300, 3600, 21600 and 86400 was accepted and echoed back intact.

**U1-S8 — `timeoutSeconds: 0` is silently swallowed.** Sent as 0, the API
returns 200 and echoes `timeoutSeconds: null` — the field reverts to unset,
NOT to "end immediately". Same shape as U1-S1's nested-field trap. If R1 ever
computes 0 from config (an unset env var read through `Number()`, say — see the
repo's standing `Number("") === 0` trap) it gets default behaviour with a green
call and no warning. The adapter clamps to ≥ 1 and asserts the echo.

**Design consequences.**

- `timeoutSeconds` is a deliberate product decision, not a default to copy. **It
  IS the phone-dropout tolerance.** Set it to the longest outage a club should
  survive invisibly. The cost of a high value is that a genuinely abandoned
  stream stays "live" that much longer before the sweep may call it over — so
  this number and the sweep's dead-stream threshold are ONE decision, not two.
- §6.4's disconnect choreography and the ~8 s slate now sit inside a measured
  envelope instead of a guess.
- The sweep must not treat a non-advancing manifest as a dead stream before
  `timeoutSeconds` has elapsed, or it will kill sessions the platform was still
  holding open.
- A dropout that crosses the window costs a second recorded video, which is a
  storage-accounting consequence as well as a viewer-experience one (§6.5).

**Evidence grade: A** — the window's existence, its control, its magnitude at two
settings, and the in-window and beyond-window behaviours are all measured
first-hand against the live API on 2026-09-11.

### U1-S9 — deleting a live input does NOT delete its recordings

After the spike, `GET /stream/live_inputs` returned **0** — every input had been
deleted by its own `finally` block — while `GET /stream/storage-usage` reported
**10 videos and 8.91 minutes still consumed**. Listing `/stream` showed all ten,
each still carrying its `liveInput` id pointing at an input that no longer
exists. They were removed with `DELETE /stream/{videoId}`, after which usage
returned to `0 / 1000`.

**Why this matters more than it looks.** §6.5's headroom guard and §12's
retention plan both reason about storage as though it follows the session. It
does not: the session ends, the input is deleted, and the recording stays,
billing against the prepaid block until its retention expires — which, per
U1-S4, is at least 30 days.

So a cleanup path that deletes the live input and stops there **leaks storage
permanently at the rate of one recording per session**. R1's sweep must delete
the VIDEO, not just the input, and the test for it asserts
`storage-usage.videoCount` returns to its prior value — deleting the input and
asserting a 200 cannot see this.

This is also the mechanical argument for Q21's lever (c): an own-sweep calling
`DELETE /stream/{videoId}` is not merely a way around the 30-day floor, it is
required anyway for cleanup correctness.

## 2026-09-11 — owner rulings 26 and 27, and a peer session's two verified findings

### Ruling 26 (Q20, from U1-S7) — the phone-dropout tolerance is 180 s

`recording.timeoutSeconds = 180` on every live input. The owner accepted the
recommendation as put. It covers a half-time phone swap, a walk behind a stand
and a cellular handover, and sits above §6.4's 90 s stale threshold so the
sweep's "stale" reads as *we think this is over* while `timeoutSeconds` is *the
platform agrees* — two observations in the same direction rather than a race.

**Owed:** §6.4's stale threshold re-derived against 180 s; R1 pinning it as a
named constant and asserting the echo (0 is silently swallowed — U1-S8).

### Ruling 27 (Q21, from U1-S4) — retention stays 7 days, delivered by our own cron

Recording stays ON for both tiers; lever (b) — switching it off for composed —
was declined. The 7-day intent survives, delivered by a sweep issuing
`DELETE /stream/{video_uid}`, because no native Cloudflare mechanism can express
a value under 30 days.

**`deleteRecordingAfterDays: 30` is also set, as a backstop — CONFIRMED by the
owner** ("set 30 and we will create a cron to clean up in 7 days"). It is the
lowest value the API accepts and costs nothing while the sweep is healthy; if
the sweep stops, recordings expire at 30 days instead of never, so a broken
sweep is a bigger bill rather than an unbounded one. **The owner is taking the
cron.** This repo owes the route and the usecase; the `schedule:` workflow is
raised in `onryde/seazn.club.workflow`.

**Owed:** §12's value; §6.5's arithmetic re-derived for a 7-day concurrent
window; R1's sweep deleting at 7 days and asserting both fields echo back; the
`schedule:` workflow raised in `onryde/seazn.club.workflow`.

### Peer findings, received and INDEPENDENTLY VERIFIED 2026-09-11

A peer session working the R1/W2 cron pair sent two findings, explicitly as a
recommendation and not a ruling. Both were re-pinned here before being acted on,
as they asked.

**P-1 — both native retention mechanisms are floored at 30 days.** This session
had measured `deleteRecordingAfterDays` rejecting 7 (`400 / 10060`, U1-S4); the
peer added the second mechanism, a video's `scheduledDeletion`, which the
Cloudflare API reference states "must be at least 30 days from upload time"
(re-fetched and confirmed here). So sub-30-day retention is cron-DELETE-only.
`DELETE /stream/{video_uid}` carries no minimum age — this session deleted ten
recordings minutes old (U1-S9) — so the mechanism works. **Directly load-bearing
for ruling 27, and the reason that ruling needs a sweep rather than a field.**

The peer also pinned that storage is prepaid CONCURRENT capacity rather than a
monthly allowance, which this session had observed independently (`8.91 / 1000`
with ten recordings, `0 / 1000` the instant they were deleted) and had stated
imprecisely in the first draft of Q21. Corrected there.

**P-2 — the `schedule:` workflow half belongs in a DIFFERENT repo.** Verified
against the tree: `d53d87024` (PR #757, 2026-09-09) "move 8 scheduled ops
workflows to onryde/seazn.club.workflow" is an ancestor of `origin/main`;
`origin/main` carries 11 workflow files of which `help-shots.yml` is the ONLY
`schedule:`; and `onryde/seazn.club.workflow` exists (private, updated
2026-09-09) holding the eight moved files including `registrations-sweep.yml`.
The ROUTE half of the idiom is still exactly right —
`apps/web/src/app/api/cron/registrations/route.ts:13-16` is 503-on-unset →
401-on-mismatch → one idempotent usecase, re-read and confirmed.

**Why it mattered:** design line 1329 told an implementer to ship "cron pair +
workflow" from this repo. A `schedule:` workflow added here is fired by nothing,
CI stays green, and the sweep silently never runs — and after ruling 27 that
sweep IS the storage bill. Corrected in the design's three cron rows.

The peer's further note that `CRON_SECRET` must be mirrored in both places, and
that the moved workflows skip-with-warning rather than failing red on a missing
secret, is recorded as received — it concerns the other repo and was not
verifiable from here.

**One part of the peer's message did NOT hold, checked rather than assumed.**
They warned that "the organiser can burn a credit and THEN have the live input
refuse to start". The debit fires AT `live` (§5.2, and R1's gate order), so a
session that never starts never reaches the debit and no credit is burned. The
adjacent risk underneath it is real, though, and is now a watch item in R1:
headroom is checked at CREATE and enforced at START, and U1-S3 measured that an
input is created successfully at `totalStorageMinutesLimit: 0` — so a block
exhausted between the check and the phone connecting yields a session that
provisions cleanly and never goes live, with no error to show. That is a
silent-stall risk for the stale sweep to end, not a money one.
