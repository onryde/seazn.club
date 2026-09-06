# W1 — step one: the overlay page, the projection, the stream link, the panel

Read `_RULES.md` → `_INDEX.md` (both pinned-symbol tables) → `_THEMES.md`
(binding design values: §1 type, §2 sport tokens, §3 bar, §4 bug, §6 motion,
§7 phone floors, §8 panel tokens; the overlay and panel tasks cite these
sections instead of restating numbers) → spec §"Architecture" 1–9, §"Tests",
§"Waves, PRs, gates": `../2026-09-05-stream-overlay-design.md`.
Plan: `../../plans/2026-09-05-stream-overlay-w1.md` (being written by a Fable
agent 2026-09-05; absent when this file was written). When the plan exists, its
task ORDER wins and this file's RULINGS win; a conflict between them is a finding
for `_INDEX.md`, never something resolved silently. Worktree
`.claude/worktrees/stream-overlay`, branch `feat/stream-overlay`; **one PR (PR1)**,
rebased after `feat/fixture-console-redesign` merges (R11).

## Why the wave exists

A club streams its match with OBS and the score is a phone held up to the camera.
CricHeroes sells a per-match "Score Ticker" for cricket only. seazn already has
the ledger, the realtime ping and eleven sport palettes; what is missing is a
transparent page that renders them, a link the club can paste, and a place to
save the stream URL so fans find the broadcast from the public match page. Step
one ships all of that for every sport the engine scores, with no moments and no
batter line (those are W2, R4).

## Owner rulings that bind this wave (verbatim, 2026-09-05)

- "I am ok with design" / "approve" — the spec and the two artboard directions
  are the design of record; do not redesign.
- "one or two themes" → **both** ship; style is a URL parameter (R2).
- "all sports" → all eleven through one projection (R3).
- "showing out, 4 or 6" → moments are **step two**; this wave leaves the slot.
- "hide this feature under special header" → no header gate exists and OBS
  cannot send one; the owner accepted the entitlement gate (R1).
- "will we do animation when score?" → exactly three motions (R13).
- "use OPus SubAgent" → `model: opus` on every dispatch (`_RULES.md` §Agents).

## Scope

Numbered in build order. Every `path:line` is from `_INDEX.md`'s tables unless
marked (re-pinned), and is re-pinned before an edit regardless.

1. **Hook extraction** — `apps/web/src/components/public-site/use-live-fixture.ts`,
   `useLiveFixture(fixtureId, initial: LiveFixtureData, realtime: boolean):
   LiveFixtureData`, lifted VERBATIM from `live-score.tsx:60-117` (`refresh`
   `:60-66`, `live` `:68`, the realtime effect `:73-110` — token via
   `fetchPublicRealtimeToken`, private channel, `state_changed`, 250 ms debounce —
   the `POLL_MS` fallback effect `:112-117`; `POLL_MS` itself at `:29`).
   `LiveScore` is repointed to the hook in the SAME commit, keeping `Props`
   (`:32-50`) and its render untouched. `live-score.test.tsx:77-140` (three
   cases: same instance polls a decided outcome; plain template when no
   `method`; never arms a poll when decided at mount) stay green UNCHANGED —
   they are the regression witness, not something to edit.
2. **Projection** — `apps/web/src/lib/overlay-model.ts`, `overlayModel(input)` and
   `OverlayModel` exactly as spec §2 (`live, decided, header{context, clock?},
   sides[2]{short,name,big,sub?,led,serving}, cells[], detail[], chase?,
   result?`). Pure; no React, no `@/server/**` import (the stage is a client
   component). Derivations imported from `@/lib/public-site` (`setBreakdown :290`,
   `periodBreakdown :319`, `matchStrength :338`, `disciplineList :352`,
   `servingSide :373`) — never re-derived. Every string via `msg: MsgFn`
   (`lib/messages-i18n.ts:24-28`). `short`: the linked team's `short_name`
   (`teams.short_name`, `db/migration/v2-engine/tables/V206__teams.sql:5`,
   re-pinned) when the entrant reaches one, else the first three letters of the
   name upper-cased; the plan pins HOW an entrant reaches its team's row or
   records that it cannot (watch-list 6). Empty case first: `status ===
   "scheduled"` → `live: false`, `big: "—"` both sides, `header.context` the
   localised start time in the venue zone, `cells: []`. Decided/finalized →
   `result` set, `chase` unset, the winning side keeps `led`. Also export
   `interface OverlayMoment { kind; headline; line?; tone: "led" | "caution" |
   "dismissal" }` as a TYPE ONLY — W2's slot (R4).
3. **Data** —
   - Migration `db/migration/deltas/V392__fixture_stream_url.sql` (number =
     next free at rebase, R10): `alter table fixtures add column stream_url text
     null check (stream_url is null or stream_url like 'https://%')`, then a
     FULL redefinition of `public_fixtures_v` copied from
     `V369__public_fixtures_round_role.sql:18` with `stream_url` appended LAST
     (R6). `PublicFixture` (`server/public-site/data.ts:206`) gains
     `stream_url: string | null` in BOTH hand-maintained column lists;
     `publicFixture(id)` (`server/usecases/public.ts:263`) selects from the view
     and therefore carries it — prove it, do not assume it (watch-list 3).
   - `apps/web/src/lib/stream-url.ts`: `streamUrlSchema` per R16, exported for
     both the route and the panel. `""` → `null`.
   - `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts`, `PUT`, body
     `{ streamUrl: string | null }` (`parseBody` + a new `PutFixtureStream` zod
     schema beside `PatchFixture` at `server/schemas.ts:964`), gate
     `requireResourceAuth(req, "fixture", id, "write")` (`server/api-v1/auth.ts:352`;
     precedent `fixtures/[id]/route.ts:17`) — watch-list 5 is RESOLVED: the gate is
     a reusable helper, nothing to extract. Usecase `setFixtureStreamUrl(auth,
     id, streamUrl)` in `server/usecases/fixtures.ts` beside `patchFixture`
     (`:136`), reading the fixture's `division_id` and its competition the way
     `patchFixture` does, then `fireDivisionRevalidate(divisionId, competitionId)`
     (`server/public-site/revalidate.ts:14`, re-pinned — the index row says
     `:13`; the `export function` line is 14). That helper is what invalidates
     the `["pub-fixture", fixtureId]` entry tagged `divisionTag(division.id)`
     (`data.ts:742`); spec §4's "`broadcastRevalidate`" is the peer primitive it
     calls internally (`@/lib/peer-revalidate`) — call the helper, not the
     primitive. Returns JSON `{ id, stream_url }`; never a redirect (R8).
   - OpenAPI: one `ROUTES` entry next to `PATCH /fixtures/{id}` (`openapi.ts:142`),
     `request: S.PutFixtureStream`, `errors: [403, 404, 422]`; `npm run
     openapi:gen`; commit both generated files (R7).
4. **Entitlement** — delta migration (next free number after the one above)
   inserting `streaming.overlay` with `bool_value = false` for every plan key
   present in `plan_entitlements` (form `V290__pro_plus_plan.sql:18,39`, `on
   conflict (plan_key, feature_key) do update`; a missing row already DENIES —
   `V024:1` — the rows exist so `/admin/entitlements` shows the key under
   "other"). **Do NOT add it to `ENTITLEMENT_DOMAINS`** (`lib/entitlement-domains.ts:5`)
   — that is the mechanism that keeps it off `/pricing` (R1). The test org's
   `org_entitlement_overrides` row is written by SQL, not a migration (the e2e
   uses `setBoolEntitlementOverrideSql(orgId, "streaming.overlay", true)`,
   `apps/web/e2e/helpers.ts:500` — an upsert with no delete, so the thaw is
   `…false` in `afterAll`; watch-list 4 resolved in the SQL direction). No
   pricing copy: a false-everywhere key that is not in the domains list needs
   none — the plan confirms by reading `buildPricingSections`
   (`lib/pricing-matrix.ts:191,199`) once.
5. **Overlay route, layout, theme, motions** —
   - `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx`: returns a
     `<div>` (a nested layout cannot emit `<html>`/`<body>` — `app/layout.tsx:54`
     is the only one, `slideshow/layout.tsx:20` and `embed/layout.tsx:26` are the
     precedents) carrying a `<style>` element with `html, body { background:
     transparent; margin: 0 }`, no header, footer or attribution script; Barlow
     Condensed mounted on that div exactly as `(public)/shared/[orgSlug]/layout.tsx:19-23,60`
     (`--ps-font-display`); Geist arrives from the root layout (`app/layout.tsx:10-13`,
     `@/lib/fonts:4`). `export const metadata = { robots: { index: false } }` on
     the page.
   - `page.tsx` (server): `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId)`
     (`data.ts:689`) needs THREE SLUGS the overlay URL does not carry — **spec §1
     under-specifies this** (watch-list 1, now a known gap). Resolution
     recommended: a small server helper `publicFixtureSlugs(fixtureId)` in
     `server/public-site/data.ts` that reads org/competition/division slugs
     through the `public_*_v` views (so visibility holds), then the existing
     `getPublicFixture(...)` call — no overload, so its cache key is untouched.
     The plan pins the view columns. Then `hasFeature(org.id, "streaming.overlay")`
     (`lib/entitlements.ts:454`); either null → `notFound()`. Passes `initial:
     { status, summary, outcome }`, `sportKey = division.sport_key` (`data.ts:180`),
     `entrantNames`, `realtime` (already in the return, `:689`) and the resolved
     theme (`?style=<themeId>`, resolved by `resolveTheme(styleParam,
     sportKey)` against `OVERLAY_THEMES`; an unknown, misspelt or
     sport-unsuitable id falls back to `defaultThemeFor(sportKey)` and never
     throws — owner answer on Q7, 2026-09-06: themes are a REGISTRY, not a
     two-value union, so a new theme is one entry plus one component) and
     `lang` (`toLocale`, `lib/i18n-constants.ts:42`) to the stage.
   - `apps/web/src/components/overlay/overlay-stage.tsx` (client): calls
     `useLiveFixture`, builds `overlayModel(...)`, renders `<OverlayBar>` or
     `<OverlayBug>` (`overlay-bar.tsx`, `overlay-bug.tsx`) inside a 1920×1080
     root scaled with `transform: scale(min(vw/1920, vh/1080))`, origin top-left
     (R15). Root `style={sportThemeStyle(sportKey)}` (`sport-theme.ts:557`;
     `undefined` for cricket/generic → `:root` defaults in
     `app/globals.css:1014-1022`); classes `.ovl-*` reading `var(--sport-board)`,
     `--sport-board-2`, `--sport-ink`, `--sport-led`, `--sport-caution`,
     `--sport-dismissal` (`SPORT_TOKENS`, `sport-theme.ts:77,508`) — never `.pad-*`.
     Tabular numerals on every value that can change width. Testids: `ovl-root`,
     `ovl-side-home`, `ovl-side-away`, `ovl-big-home`, `ovl-big-away`,
     `ovl-led`, `ovl-live-dot`, `ovl-cells`, `ovl-detail`, `ovl-chase`,
     `ovl-result`, `ovl-moment-slot` (empty in W1).
   - Motions per R13: class `ovl-tick` applied to the ONE `big` that changed
     (compare previous model to next in the stage; remove after 300 ms),
     `ovl-led` translates between rows over 200 ms, `ovl-live-dot` breathes
     while `model.live`. `@media (prefers-reduced-motion: reduce)` removes tick
     and breath (precedent `globals.css:187`). Nothing animates on mount.
6. **Console panel** — `apps/web/src/components/v2/fixture-stream-panel.tsx`
   (client). Mounted from `FixtureLine` (`stages-panel.tsx:1579`, re-pinned:
   `export function FixtureLine({`) behind `<button data-testid=
   "fixture-stream-toggle">` placed beside `fixture-schedule-toggle` (`:1747`,
   re-pinned; index range `:1745-1753`), rendered only when `streamingEntitled
   && canEdit`. **Its gate is NOT the schedule toggle's `fixture.status ===
   "scheduled"`** — a club pastes the replay link after the final whistle
   (product-owner call, recorded in `_INDEX.md`, reversible). ONE import and
   ONE conditional line in `stages-panel.tsx` (R11 — desk W1 is editing this
   file). `Props` (`:144-146,399`) gains `sportKey: string` and
   `streamingEntitled: boolean`, threaded through to `FixtureLine`; the division
   page `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:124-138`
   adds `hasFeature(auth.orgId, "streaming.overlay")` to its `Promise.all` and
   passes both — precedent `entitled={await hasFeature(auth.orgId,
   "embeds.enabled")}` at `:785`. Content per the "Organiser console" artboards:
   style tabs (default per R2; `role=tablist`) above a live preview that is
   `<OverlayStage>` itself at reduced scale on the row's own fixture; read-only
   overlay link `<origin>/overlay/fixtures/<id>?style=<themeId>` with a copy
   button (`embed.*` precedent); three NUMBERED steps (Browser source at
   1920×1080 · drag above the camera, background is transparent · start
   streaming and paste the link below); stream-link input + "Save link" calling
   `PUT /stream`, inline error from `streamUrlSchema`, success as "Saved" in
   the button (no toast). Phone first (R15): at 320 tabs/inputs/buttons full
   width ≥ 44 px; ≥ 768 the copy button sits inside the field; the control SET is
   identical at 320 and 1280. Testids `stream-tab-bar`, `stream-tab-bug`,
   `stream-preview`, `stream-link`, `stream-copy`, `stream-url-input`,
   `stream-save`, `stream-error`.
7. **Public match page link** — in
   `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx`,
   under the headline block and above the `<LiveScore>` mount (`:175-182`):
   when `fixture.stream_url` is set, `<a data-testid="public-stream-link"
   href={stream_url} target="_blank" rel="noopener">` labelled
   `public.overlay.watchLive` while `scheduled`/`in_play` and
   `public.overlay.replay` once `decided`/`finalized`. Placement only; spectator
   W1 owns the composition and will move the link into its court header (spec
   §7) — do not build a header here.
8. **i18n** — `public.overlay.*` (overlay strings incl. `notStarted`,
   `watchLive`, `replay`, cricket notation `title`s) and `ui.stream.*` (panel)
   in all four dictionaries; `pnpm i18n:gen-keys`; a unit test that every key
   the overlay and panel reference exists in every locale (derive the key list
   from the source, not a typed table).
9. **Tests, smoke, visual gate, inventory** — below.
10. **`_INDEX.md`** — wave table row, final migration numbers, PR number, any
    false premise found, in the same PR.

## Out of scope (this wave)

Moments, the cricket batter/bowler line, any per-event payload (W2). Video on
the seazn page, phone-only streaming, pricing, a fixtures/standings ticker,
sponsor logos, in-stream language switching (spec §"Out of scope").

## Do NOT touch

The scorepad and its skins (`components/v2/scorepad/**` — read `sport-theme.ts`,
import from it, never edit it); the engine; `components/v2/fixture-console.tsx`
(R12 — wrong console); the entitlement MATRIX rows of other keys and every
pricing surface; `ENTITLEMENT_DOMAINS`; `LiveScore`'s render and `Props`; the
public page's composition beyond the one link; `proxy.ts` CSP; `app/embed/**`
and `app/slideshow/**`; `.github/workflows/e2e.yml`; any file desk W1 is editing
other than the one import + one line in `stages-panel.tsx`.

## Acceptance — all four test kinds, with the assertions named

- **Unit** (`cd apps/web && vitest run --reporter=json --outputFile=…`):
  - `lib/__tests__/overlay-model.test.ts`: for each of the eleven `V3_SKINS`
    keys (`registry.ts:85`), fold a SHORT real ledger through the real module —
    `foldMatch(module, cfg, lineups, events)` (`packages/engine/src/core/events.ts:445`)
    with `defaultLineupPair` / `makeEnvelope` from `@seazn/engine/testkit`, the
    pattern at `components/v2/scorepad/__tests__/view-model.test.ts:8-12` — then
    project the resulting `summary` and assert: the EMPTY case first (scheduled
    → `live:false`, `big:"—"`, `cells:[]`, `result` undefined); `led`/`serving`
    truth table (cricket batting side; tennis/badminton/table tennis/volleyball
    serving side; football/hockey/ice hockey neither; boardgame/carrom/generic
    neither); boardgame, carrom, generic → `cells:[]` AND `detail:[]`; decided →
    `result` set, `chase` unset, winner keeps `led`; every string passed
    through `msg` (a spy `msg` that returns the key proves no literal leaked).
  - `lib/__tests__/stream-url.test.ts`: the ten hosts accepted; rejected:
    `https://evil.example/www.youtube.com`, `https://www.youtube.com.evil.example/`,
    `https://youtube.com.evil.example`, `javascript:alert(1)`, `http://www.youtube.com/x`,
    `https://m.youtube.com/x` (not on the list — record if the owner wants it),
    ` https://youtube.com` (leading space); `""` → `null`.
  - `components/public-site/__tests__/use-live-fixture.test.tsx` with
    `renderIsland` (`components/__tests__/_hook-harness.tsx`) and the captured
    `setInterval` idiom (`live-score.test.tsx:37-40`): realtime off + in play →
    one interval armed at `POLL_MS` and a fired tick replaces `data`; decided at
    mount → no interval armed; realtime on but token 403 → falls to the poll;
    subscribed → no poll. `live-score.test.tsx` passes unchanged.
  - Dictionary coverage test from scope 8.
  - **Mutation checks, per SURFACE, each recorded in the plan with the test that
    went red:** (a) delete the hostname `===` comparison in `streamUrlSchema`;
    (b) swap `led` to the other side in `overlayModel`; (c) return `[]` from the
    cells branch for tennis; (d) delete the `if (!live || subscribed) return`
    guard in the hook; (e) delete the `hasFeature` call in `page.tsx` (killed by
    the e2e 404 case, not a unit); (f) remove the `ovl-tick` class application
    (killed by the e2e tick assertion). A surviving mutant is a missing test, not
    a note.
- **E2E** (`apps/web/e2e/walkthrough/stream-overlay.spec.ts`, project
  `walkthrough` by path regex, R9; plus the WHOLE `mobile.spec.ts` file):
  - Setup: `seedOrg()` / `startedCricketDivisionWithFixture` idiom
    (`server/usecases/__tests__/_rig.ts:23,94,208`) or `apiJson` (`helpers.ts:128`)
    posting to `/api/v1/fixtures/${id}/events` (`competition-desk.spec.ts:465,492`),
    `cricket.toss` BEFORE `core.start`, a short match; override row via
    `setBoolEntitlementOverrideSql(orgId, "streaming.overlay", true)`; thaw to
    `false` in `afterAll` (a timeout skips `finally`).
  - Gate both directions in ONE test: override absent/false → `GET
    /overlay/fixtures/<id>` is 404; set true → 200. Then a second fixture of a
    NON-entitled org → 404 (the positive pair of the negative).
  - Anonymous context, `?style=bar`: `getComputedStyle(document.body).backgroundColor
    === "rgba(0, 0, 0, 0)"`; `ovl-big-home` text equals the seeded score read
    from `GET /api/v1/public/fixtures/<id>`; `ovl-root` has the sport's
    `--sport-board` custom property resolved (cricket → the `:root` default).
  - Post ONE more event through the API while the page is open; `expect.poll`
    (budget ≥ `POLL_MS` + slack, expressed in the constant) that the changed
    side's `big` updated, `page.url()` unchanged and no `framenavigated`
    fired; `ovl-tick` present on the changed side's value and ABSENT on the
    other (mutant f); the LED sits on the batting side.
  - `?style=bug` renders `ovl-root[data-style="bug"]`; an unknown style falls to
    the sport default; `?lang=fr` renders the French `notStarted` on a scheduled
    fixture (drive the DOM, not the HTML).
  - Console, signed in as an organiser of the entitled org, division page
    `?tab=fixtures` at 320, 768 and 1280 (fresh context per width): toggle
    `toBeAttached` then click; control-set diff (testid list, membership +
    order + repeats) identical at 320 and 1280; every `stream-*` control ≥ 44 px
    by `elementFromPoint` at 320; save `https://www.youtube.com/watch?v=x` →
    `stream-save` reads the localised "Saved"; save `https://evil.example/www.youtube.com`
    → `stream-error` visible, `PUT` never sent (`page.route` counter) or returns
    422 and the public JSON still carries the first URL; `expectNoHorizontalScroll`
    (`helpers.ts:49`) at all three widths.
  - Public match page in the anonymous context: `public-stream-link` present,
    `href` equals the saved URL, `rel="noopener"`, label "Watch live" while in
    play; after the match is decided through the API, the SAME open page reads
    "Replay" (drive the poll; no reload — spectator R10 applies to this link
    too, and if the current page cannot do it without a reload, record that as
    a W1-spectator hand-off rather than reloading in the test).
  - Not-entitled org: no `fixture-stream-toggle` in the DOM at all (assert
    absence AND that `fixture-schedule-toggle` is present — the positive pair).
- **Smoke** (`scripts/smoke.ts`, `check`/`expectFail` at `:91-95`): overlay
  route 200 with body containing `data-testid="ovl-root"` for the smoke org's
  fixture after its override row is set through smoke's existing SQL lever (pin
  it; if none exists, set it through the same upsert `helpers.ts:500` uses),
  404 for a fixture of an org without the row (the default state — no lever
  needed); `PUT /api/v1/fixtures/<id>/stream` with a valid link → 200 and `GET
  /api/v1/public/fixtures/<id>` returns `stream_url` equal to it (the seam,
  driven end to end); an invalid host → 422.
- **Regression**: `live-score.test.tsx` and `live-score-data.test.ts` unchanged
  and green (poll interval, debounce, decided templates identical); the whole
  `mobile.spec.ts` file green with the new toggle folded in at all seven widths
  (the fixtures-tab cases at `:578,2715,2907,3096,3189` are the ones that will
  see it); `npm run openapi:gen` and `pnpm i18n:gen-keys` leave no diff; `tsc
  --noEmit -p apps/web/tsconfig.json` clean; full `apps/web` vitest total ≥
  main's total.
- **Visual gate** (owner sign-off, per screen): bar AND bug for cricket,
  football, tennis and volleyball at 1920×1080 on a prod build (`E2E_PROD_TARGET`)
  with real seeded data — eight images that EXIST and DIFFER (hash them); the
  panel open at 320, 768 and 1280; the 404 state; a scheduled fixture (the
  "—" state). Attached to the PR with a per-screen verdict row saying what was
  SEEN (names at 43 characters, numeral alignment, LED position, contrast on
  the transparent ground over a light AND a dark video frame — composite the
  screenshot over both in the review, since OBS will).

## Inventory (pasted into the PR description)

Files added / changed with one line each; migration numbers as landed; the
`ROUTES` entry; dictionary keys added per namespace with the four-locale count;
vitest `numTotalTests`/`numFailedTests` from the JSON report; Playwright
per-project pass counts from `workflow_dispatch pr=<n>`; the mutant table (a–f,
killed by which test); the screenshot list with hashes; the control-set diff
output for 320 vs 1280; open questions for the owner (e.g. `m.youtube.com`).

## PR shape and gates

One PR. If review load forces a split, the split line is AFTER scope 4
(hook + model + data + entitlement, with the smoke assertion that the public
JSON carries `stream_url` and the unit sweep) — the route/panel/link PR then
carries the e2e. A seam is never left for "later"; it ships inert every time
this repo has tried. Gates exactly as `_RULES.md` §Merge gates 1–8; rebase on
`main` after `feat/fixture-console-redesign` merges and re-run the whole
`mobile.spec.ts` file after that rebase, not before it.

## Dispatch notes (for the orchestrator)

- Lanes that are provably disjoint and may run in parallel: (A) scope 1 + 2
  (`use-live-fixture.ts`, `live-score.tsx`, `overlay-model.ts`, their tests);
  (B) scope 3 + 4 (migrations, `stream-url.ts`, the route, usecase, schema,
  OpenAPI, entitlement rows). Scope 5 depends on A; scope 6 depends on 5 and B;
  scope 7 on B. Anything touching `stages-panel.tsx` or the division page is a
  single lane, sequential, and last.
- Every brief carries: the exact paths above; the acceptance bullets for that
  lane; "do NOT touch" verbatim; the verify command prefixed `cd
  /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay &&`
  with `DATABASE_URL=… DATABASE_SSL=disable` inline for DB-backed suites;
  `model: opus`; the shell guard (no heredocs, Write tool, `/usr/bin/git` only
  if ever needed — implementers do not commit); and the cap: **"final message
  under 15 lines — counts, paths, deviations, blockers; no file contents or
  diffs."**
- Reviewer after every lane; whole-branch reviewer before the PR; the
  orchestrator reruns the full vitest gate and the whole `mobile.spec.ts` at the
  wave boundary and pastes counts.
- A stopped agent is resumed where it stopped (owner ruling), never re-dispatched
  from scratch onto its half-written files.

## False-premise watch list (re-pin against the tree before building on any)

Spec §"False-premise watch list" 1–8, with what is already known:

1. `getPublicFixture` returns sport key (via `division.sport_key`), entrant
   names and `realtime` in one call — TRUE (`data.ts:689`) — but it takes three
   SLUGS the overlay URL lacks. Resolution in scope 5; the plan pins the view
   columns the slug helper reads.
2. `setBreakdown` and siblings importable — TRUE, `@/lib/public-site`
   (`:290-373`); nothing to move.
3. `public_fixtures_v` is what `publicFixture()` selects from — TRUE
   (`usecases/public.ts:263`); still PROVE `stream_url` arrives on the JSON with
   the smoke assertion, since `PublicFixture`'s list is hand-maintained twice.
4. Override row by SQL — TRUE (`helpers.ts:500`, upsert, no delete → thaw to
   false in `afterAll`). Whether `/admin/entitlements` can write one for the
   owner's org is unpinned; if not, the owner's row is a one-line SQL recorded
   in `_INDEX.md`.
5. Role gate reusable — TRUE (`requireResourceAuth`, `auth.ts:352`).
6. Entrant short name — `teams.short_name` exists (`V206:5`), `clubs.short_name`
   too (`V242:11`); NO column on entrants. Pin the entrant → team path or keep
   the three-letter fallback and say so in the panel copy.
7. Barlow mounted on a second layout — UNPINNED; check the built CSS for a
   double `@font-face` and the network tab for a second download.
8. Eleven `V3_SKINS` keys = every `sport_key` a division can carry — UNPINNED;
   run `select distinct sport_key from divisions` on the dev DB and diff.

Found while writing these prompts (also in `_INDEX.md`): `WALKTHROUGH_SPECS`
does not exist on this branch (R9) but does on `main` since PR #723, so the
capture spec is registered there after the rebase, same commit;
`broadcastRevalidate` is the peer primitive, the helper is
`fireDivisionRevalidate` at `revalidate.ts:14`; `renderIsland` exists, so the
hook's branches ARE unit-testable; the schedule toggle is gated on `status ===
"scheduled"` — copying that gate would hide the panel exactly when the club is
streaming.
