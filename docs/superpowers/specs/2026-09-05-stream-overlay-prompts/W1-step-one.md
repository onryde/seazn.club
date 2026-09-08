# W1 — step one: the overlay page, the projection, the stream link, the panel

**Look at the canvas first** —
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 — it is
what this wave builds: theme `bar` and theme `bug` on cricket, both across
football, tennis, badminton and volleyball, the phone legibility test, the OBS
setup flow, and the organiser panel at desktop and at 390. Then read
`_RULES.md` → `_INDEX.md` (both pinned-symbol tables) → `_THEMES.md`
(binding design values: §1 type, §2 sport tokens, §3 bar, §4 bug, §6 motion,
§7 phone floors, §8 panel tokens; the overlay and panel tasks cite these
sections instead of restating numbers) → **the design of record is now
`../2026-09-07-streaming-programme-design.md`** — §3 (Tier A, the authority
for every value in this wave), §3.2 (the overlay endpoint that replaces Task
0's superseded steps), §4 (T1, which W1-C waits for), §5.1/§5.3 (keys, the
Phone-tab gate cards), §9a (design patterns — a brief that cannot name the
exemplar is not compliant), §10, §13 (findings and re-pins). The 09-05 design
is superseded and kept only for the canvas and the approval record (re-pinned
2026-09-07 @ fb99bbd4c). Plan: `../../plans/2026-09-05-stream-overlay-w1.md`
(exists, `c303435a1`; its Task 0 Steps 2–13 are SUPERSEDED and are replaced by
the overlay-endpoint amendment the Fable plan-writer lands from design §3.2 —
until that amendment is committed, nothing in Task 0 beyond Step 1 executes).
The plan's task ORDER wins and this file's RULINGS win; a conflict between
them is a finding for `_INDEX.md`, never something resolved silently. Worktree
`.claude/worktrees/stream-overlay` (re-added 2026-09-07 from the branch; no
`node_modules` or `.env.local` until `pnpm i` and the symlink), branch
`feat/stream-overlay` rebased on `main` `fb99bbd4c`; **one PR (PR1)**.
Sequencing (re-pinned 2026-09-07 @ fb99bbd4c): `feat/fixture-console-redesign`
(desk W1) and desk W2 (#725, the run sheet) have BOTH merged — the mount
target is `desk/run-sheet-row.tsx`, and the live contention is **desk W3**
(`feat/competition-desk-w3-band-and-phone`, worktree `desk-w3`): W1-D rebases
after any desk-W3 merge touching that file, never races it (FS4). **W1-C
(scope 5) does not dispatch until T1 has landed** (`T1-theme-and-visual-gate.md`):
its visual gate is T1b's manifest rows, and `OVERLAY_TOKENS` is T1b's export.

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

Added 2026-09-07 (re-pinned @ fb99bbd4c; owner's words in `_INDEX.md`
rulings 18–22 and the design §0/§13):

- "1" — one design of record; this prompt is corrected IN PLACE against it.
- "we can keep corpus name as it" → the OBS tier's key stays
  `streaming.overlay`; a second key `streaming.relay` (Tier B) is R1's. W1
  lands `streaming.overlay` rows for the FIVE v18 plans **`false` everywhere**
  (design §10.4: dark until the GA flip; the §5.1 plan split — `pro`,
  `event_pass_l`, `enterprise` true — is the GA state, flipped by its own
  later migration together with the `ENTITLEMENT_DOMAINS` entry and the
  pricing copy).
- "we wwill buy the streaming in the fixture console page itself?" → the
  panel has TWO tabs from PR1: **OBS** (this wave, full) and **Phone** (this
  wave ships the tab and the design §5.3 gate cards — `UpgradeGate` or the
  buy-credits card — and nothing else; R1 fills the entitled body). The seam
  is live from PR1, never "left for later".
- "Can we have Wave for designing the theme and testing?" → "Ok": T1 exists;
  W1's visual gate is T1b's manifest rows; W1 adds rows, never harness code.
- Q2 (2026-09-06) "we can remove" (the cookie banner on the overlay) — and
  FS1 (2026-09-07): **no route-key mechanism exists** in `cookie-consent.tsx`;
  W1-C builds the `usePathname()` return.
- The football clock ships in W1 and TICKS (2026-09-06 ruling; design §3.6).

## Scope

Numbered in build order. Every `path:line` is from `_INDEX.md`'s tables unless
marked (re-pinned), and is re-pinned before an edit regardless.

1. **Hook generalisation** (re-pinned 2026-09-08 @ 60c0615b0) — spectator W1 (#743) already
   extracted the transport to `apps/web/src/components/public-site/match-centre/
   use-live-fixture.ts` (`POLL_MS` `:10`, `export function useLiveFixture(` `:17`,
   `refresh` `:42` with a `mountedRef` guard, `live = in_play || scheduled` `:52`,
   subscribe effect `:57-95`, poll effect `:96-100`, returns `{ data, transport }`
   `:102`). There is NO lift. `live-score.tsx` now exports only the hookless
   `LiveScoreBody`; the `LiveScore` wrapper is RETIRED and `MatchCentre`
   (`match-centre/match-centre.tsx:56`) is the hook's one production caller.
   W1 modifies the hook IN PLACE, per design §3.3: an options object
   `{ fetcher, delayMs? }` so the overlay polls ITS endpoint (scope 2b) while
   `MatchCentre` keeps `fetchLiveFixture` (the default); and a
   `presentationNowOffsetMs` FIELD on the returned `UseLiveFixtureResult<T>`
   (design FS17). With options absent the hook is byte-identical; `delayMs`
   buffers `(receivedAt, snapshot)` pairs and presents the newest with
   `receivedAt ≤ now − delayMs` on a 1 s drain — built and unit-tested HERE
   so the R2 seam is real. Witnesses: the hook's OWN five cases in
   `match-centre/__tests__/use-live-fixture.test.ts` (`renderIsland` +
   `vi.useFakeTimers` + module-mocked `fetchLiveFixture` — the file's
   convention; SSR `renderToStaticMarkup` cannot drive effects), plus
   `live-score.test.tsx` (SSR of `LiveScoreBody`) and `match-centre.test.tsx`,
   all UNCHANGED and green. Five new cases: default fetcher hits the public
   URL; `fetcher` is what the poll calls; no drain timer without options
   (`vi.getTimerCount() === 1`) and offset 0; `delayMs: 3000` presents at
   `t + 3000` with `presentationNowOffsetMs === 3000`; two snapshots drain in
   order.
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
   `interface OverlayMoment { kind; headline; line?; tone: SportTone }` as a
   TYPE ONLY — W2's slot (R4); `tone` typed against `SPORT_TONES`
   (`components/v2/scorepad/v3/sport-theme.ts:87`, re-pinned 2026-09-07 @
   fb99bbd4c — never a hand-typed union). Input is `OverlayLiveData` (scope
   2b), not the public fixture JSON.
3. **Data** —
   - Migration `db/migration/deltas/V400__fixture_stream_url.sql` (re-pinned
     2026-09-07 @ fb99bbd4c: deltas run to `V399__stats_player_career_split.sql`,
     so V392 AND the 09-06 documents' V399 are both taken — FS2; number = next
     free at rebase, R10, `ls db/migration/deltas | sort -V | tail -1` FIRST):
     `alter table fixtures add column stream_url text null check (stream_url
     is null or stream_url like 'https://%')`, then a FULL redefinition of
     `public_fixtures_v` copied from its LATEST definer (re-pinned 2026-09-07:
     the 09-06 scout found `V362:22` at `ac85c70` and no V369 definer exists —
     RP3; re-pin at Task 0 with `grep -al "public_fixtures_v" db/migration/deltas
     | sort -V | tail -1`) with `stream_url` appended LAST (R6). `PublicFixture` (`server/public-site/data.ts:206`) gains
     `stream_url: string | null` in BOTH hand-maintained column lists;
     `publicFixture(id)` (`server/usecases/public.ts:263`) selects from the view
     and therefore carries it — prove it, do not assume it (watch-list 3).
   - `apps/web/src/lib/stream-url.ts`: `streamUrlSchema` per R16, exported for
     both the route and the panel. `""` → `null`.
   - `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts`, `PUT`, body
     `{ streamUrl: string | null }` (`parseBody` + a new `PutFixtureStream` zod
     schema beside `PatchFixture` in **`server/api-v1/schemas.ts`** — re-pinned
     2026-09-07 @ fb99bbd4c, RP6; `run-sheet-row.tsx:26` imports
     `PatchFixture` from exactly that path), gate
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
4. **Entitlement** — delta migration `V401__streaming_overlay_entitlement.sql`
   (next free number after the one above; re-pinned 2026-09-07 @ fb99bbd4c)
   inserting `streaming.overlay` with `bool_value = false` for the FIVE v18
   plan keys — `community, pro, event_pass, event_pass_l, enterprise`
   (`V393__entitlements_v18.sql`; `pro_plus` retired and dropped there — RP4;
   the V290 insert form still applies, `on conflict (plan_key, feature_key)
   do update`, header prose to the V393 bar "measured, not assumed"; a
   missing row already DENIES — the rows exist so `/admin/entitlements` shows
   the key under "other"). **False everywhere is the LANDING state** (design
   §10.4 dark rollout); the design §5.1 split is the GA flip, its own
   migration later, never this one. **Do NOT add it to `ENTITLEMENT_DOMAINS`** (`lib/entitlement-domains.ts:5`)
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
     Condensed by **`import { barlowCondensed } from "@/lib/fonts"`** — REUSE
     the existing declaration (`lib/fonts.ts:7-9`, re-pinned 2026-09-07 @
     fb99bbd4c, RP8), never remount `next/font`; add weight `"800"` to that
     declaration (today `["600","700"]` — FS8; W2's slab needs it) and record
     the change; Geist arrives from the root layout (`app/layout.tsx:10-13`).
     `export const metadata = { robots: { index: false } }` on the page.
   - **Cookie banner** (Q2 + FS1, re-pinned 2026-09-07 @ fb99bbd4c): the
     banner is mounted unconditionally in the root layout (`app/layout.tsx:68`)
     and gated by `localStorage` only (`components/cookie-consent.tsx:34,66`)
     — **there is no pathname or route-key mechanism** (the 09-06 documents
     asserted one). Build it: `cookie-consent.tsx` reads `usePathname()` and
     returns `null` when the path starts with `/overlay/`; the e2e asserts the
     banner's testid absent on the overlay AND present on the public page
     (the positive pair), and `context.cookies()` empty after load and after
     one realtime refresh (nothing to consent to is proven).
   - `page.tsx` (server): `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId)`
     (`data.ts:689`) needs THREE SLUGS the overlay URL does not carry — **spec §1
     under-specifies this** (watch-list 1, now a known gap). Resolution
     recommended: a small server helper `publicFixtureSlugs(fixtureId)` in
     `server/public-site/data.ts` that reads org/competition/division slugs
     through the `public_*_v` views (so visibility holds), then the existing
     `getPublicFixture(...)` call — no overload, so its cache key is untouched.
     The plan pins the view columns. Then `hasFeature(org.id, "streaming.overlay")`
     (`lib/entitlements.ts:456` — re-pinned 2026-09-07 @ fb99bbd4c, moved from
     `:454`; cite the symbol); either null → `notFound()`. Passes `initial:
     OverlayLiveData` (from the SAME projection scope 2b's route uses — one
     authority; re-pinned 2026-09-07), `sportKey = division.sport_key` (`data.ts:180`),
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
     `app/globals.css:1014-1022`); classes `.ovl-*` reading ALL SEVEN custom
     properties `var(--sport-board)`, `--sport-board-2`, `--sport-ink`,
     `--sport-led`, **`--sport-advisory`**, `--sport-caution`,
     `--sport-dismissal` (`SPORT_TOKENS` at
     `components/v2/scorepad/v3/sport-theme.ts:77` — re-pinned 2026-09-07 @
     fb99bbd4c, F2: the earlier six-token list omitted `advisory`, which is
     real; the hex values reach code ONLY through T1b's `OVERLAY_TOKENS`
     export) — never `.pad-*`.
     Tabular numerals on every value that can change width. Testids: `ovl-root`,
     `ovl-side-home`, `ovl-side-away`, `ovl-big-home`, `ovl-big-away`,
     `ovl-led`, `ovl-live-dot`, `ovl-cells`, `ovl-detail`, `ovl-chase`,
     `ovl-result`, `ovl-moment-slot` (empty in W1).
   - Motions per R13: class `ovl-tick` applied to the ONE `big` that changed
     (compare previous model to next in the stage; remove after 300 ms),
     `ovl-led` translates between rows over 200 ms, `ovl-live-dot` breathes
     while `model.live`. `@media (prefers-reduced-motion: reduce)` removes tick
     and breath (precedent `globals.css:187`). Nothing animates on mount.
   - **The football clock** (owner ruling 2026-09-06; design §3.6; added
     here 2026-09-07): ONE 1 Hz phase-aware `setInterval`, re-anchored on
     every push from `OverlayLiveData.clock`, `displayed = anchorSeconds +
     (now − presentationNowOffsetMs − anchorAtWallMs)`, stopped between
     periods and at full time; the ONLY timer in the overlay; it **survives
     reduced-motion because it is information**. `data-testid="ovl-clock"`.
6. **Console panel** — `apps/web/src/components/v2/fixture-stream-panel.tsx`
   (client). Mounted from **`desk/run-sheet-row.tsx` beside
   `data-testid="run-sheet-edit-time"`** (the SYMBOL is the pin; `:407` on
   `main` b2244879f after desk W3 #740 — FS14; grep it, never seek a line) —
   re-pinned 2026-09-07 @ fb99bbd4c, RP1: `FixtureLine` and `fixture-schedule-toggle` were RETIRED by
   desk W2 (#725, the run sheet); `grep -a` for either returns nothing on
   `main`. Toggle `<button data-testid="fixture-stream-toggle">`, rendered
   when `streamingEntitled && canEdit`, at **EVERY fixture status** (owner Q6
   "Agree" — a club pastes the replay link after the final whistle); its gate
   is NOT `canEditFixtureTime` (`run-sheet-row.tsx:366`, which hides the
   edit-time control by status). ONE import and ONE conditional line in
   `run-sheet-row.tsx` (**desk W3 is editing this file** — FS4; rebase after
   any W3 merge, never race it). The row's props (`canEdit` at `:115`) gain
   `sportKey: string` and `streamingEntitled: boolean`, threaded from the
   division page `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`
   — precedent `entitled={await hasFeature(auth.orgId, "embeds.enabled",
   competition.id)}` at `:814` (re-pinned 2026-09-07; the earlier `:785` moved)
   and the `Promise.all` at `:132`. **Two tabs** in the expander (owner
   2026-09-07): `role=tablist` with `stream-tab-obs` and `stream-tab-phone`;
   the OBS tab is everything below; the **Phone tab** renders ONLY design
   §5.3's gate cards in this wave — no `streaming.overlay` → `UpgradeGate`
   (`components/upgrade-gate.tsx:252`, `feature="streaming.overlay"`);
   overlay but no `streaming.relay` → the same card; relay → a placeholder
   "buy credits" card whose packs and button are R1's (the card copy ships
   here in four locales; the button is `disabled` with `data-testid=
   "stream-buy-soon"`). Content of the OBS tab per the "Organiser console"
   artboards: style tabs (default per R2; `role=tablist`) above a live preview that is
   `<OverlayStage>` itself at reduced scale on the row's own fixture; read-only
   overlay link `<origin>/overlay/fixtures/<id>?style=<themeId>` with a copy
   button (`embed.*` precedent); three NUMBERED steps (Browser source at
   1920×1080 · drag above the camera, background is transparent · start
   streaming and paste the link below); stream-link input + "Save link" calling
   `PUT /stream`, inline error from `streamUrlSchema`, success as "Saved" in
   the button (no toast). Phone first (R15): at 320 tabs/inputs/buttons full
   width ≥ 44 px; ≥ 768 the copy button sits inside the field; the control SET is
   identical at 320 and 1280. Testids `stream-tab-obs`, `stream-tab-phone`,
   `stream-tab-bar`, `stream-tab-bug`, `stream-preview`, `stream-link`,
   `stream-copy`, `stream-url-input`, `stream-save`, `stream-error`,
   `stream-phone-gate` (the §5.3 card), `stream-buy-soon`. Dictionary
   namespace (RP9, pinned 2026-09-07 @ fb99bbd4c): `run-sheet-row.tsx:17`
   imports `useMsg` from `@/components/i18n/dict-provider` and keys such as
   `runsheet.sub.awaitingDraw` live in `dictionaries/<locale>/ui.json`
   (`lib/messages.ts:2` — "namespace `ui`") — so `ui.stream.*` is right;
   `console.json` is NOT the row's namespace. Finding closed.
7. **Public match page link** — in
   `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx`,
   under the headline block and above the `<MatchCentre>` mount (re-find it: `grep -a -n "<MatchCentre" …/fixtures/[fixtureId]/page.tsx`; the `<LiveScore>` mount is gone since #743 (re-pinned 2026-09-08 @ 60c0615b0)):
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
pricing surface; `ENTITLEMENT_DOMAINS`; `LiveScoreBody`'s render and props, `MatchCentre` and the hook's subscribe effect (re-pinned 2026-09-08 @ 60c0615b0); the
public page's composition beyond the one link; `proxy.ts` CSP; `app/embed/**`
and `app/slideshow/**`; `.github/workflows/e2e.yml`; `stages-panel.tsx` (no
longer the mount — re-pinned 2026-09-07 @ fb99bbd4c; import
`fixtureStatusLabel`/`VOID_STATUSES` from it at `:1494,:1513`, never edit);
any file desk W3 is editing other than the one import + one line in
`desk/run-sheet-row.tsx`; T1b's harness (`e2e/visual/capture.spec.ts`,
`asserts.ts` — add manifest ROWS only); `packages/engine` (Q15: nothing there
changes).

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
  - `lib/__tests__/stream-url.test.ts`: the **ELEVEN** hosts accepted
    (re-pinned 2026-09-07, F1 — `https://m.youtube.com/x` is ACCEPTED, owner
    Q5 "Agree"); rejected: `https://evil.example/www.youtube.com`,
    `https://www.youtube.com.evil.example/`, `https://youtube.com.evil.example`,
    `https://m.youtube.com.evil.example/x`, `javascript:alert(1)`,
    `http://www.youtube.com/x`, `https://youtube.com@evil.example/x`
    (userinfo), `https://youtube.com./x` (trailing dot), ` https://youtube.com`
    (leading space); `""` → `null`.
  - `server/__tests__/overlay-endpoint.test.ts` (scope 2b; re-pinned
    2026-09-07): EMPTY first — a scheduled fixture returns `clock` and
    `cricket` ABSENT (not null objects); a football fixture in play → `clock
    { phase, anchorSeconds, anchorAtWallMs }` equal to the fold's own
    `asOf`/`footballPosition` (derived from the engine, never a typed table);
    a cricket fixture → `cricket.innings[i].{ legalBalls, ballsLimit }` equal
    to the fold's state; the fold spy is called ≤ 1× per `last_seq` across
    three polls (the cache key), and EXACTLY once more after one new event
    (the positive pair).
  - `components/public-site/match-centre/__tests__/use-live-fixture.test.ts` (re-pinned 2026-09-08 @ 60c0615b0) — append to the file's own
    `renderIsland` + `vi.useFakeTimers` + module-mocked `fetchLiveFixture` convention (NOT a captured
    `setInterval` — `live-score.test.tsx` is SSR-only now): realtime off + in play →
    one interval armed at `POLL_MS` and a fired tick replaces `data`; decided at
    mount → no interval armed; realtime on but token 403 → falls to the poll;
    subscribed → no poll; **`{ fetcher }` is what the poll calls** (a spy
    fetcher counts) and `{ delayMs: 3000 }` presents a snapshot received at `t`
    only at `t + 3000` with `presentationNowOffsetMs === 3000`, while
    `delayMs` absent is byte-identical to the no-option assertions (added
    2026-09-07, design §3.3). The hook's five existing cases, `live-score.test.tsx` and `match-centre.test.tsx` pass unchanged.
  - Dictionary coverage test from scope 8.
  - **Mutation checks, per SURFACE, each recorded in the plan with the test that
    went red:** (a) delete the hostname `===` comparison in `streamUrlSchema`;
    (b) swap `led` to the other side in `overlayModel`; (c) return `[]` from the
    cells branch for tennis; (d) delete the `if (!live || subscribed) return`
    guard in the hook; (e) delete the `hasFeature` call in `page.tsx` (killed by
    the e2e 404 case, not a unit); (f) remove the `ovl-tick` class application
    (killed by the e2e tick assertion); added 2026-09-07 (design §10.2): (g)
    delete the `last_seq` cache key on the endpoint (killed by the fold-spy
    unit); (h) delete the `usePathname` return in `cookie-consent.tsx` (killed
    by the e2e "banner absent on the overlay"); (i) delete the
    `streamingEntitled` condition on the toggle (killed by the not-entitled e2e);
    (j) stop the clock interval (killed by the e2e "clock advances by ≥ 2 s
    over 3 s with no new event"). A surviving mutant is a missing test, not a
    note; the PR carries the KILLER LIST (`RULES.md` checklist), never a count.
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
  - Added 2026-09-07: **cookie banner** — its testid ABSENT on the overlay and
    PRESENT on the public match page in the same anonymous context (positive
    pair); `context.cookies()` is `[]` after the overlay loads and after one
    posted event has refreshed it. **Football clock** — a football fixture in
    the first half: `ovl-clock` advances by ≥ 2 s over a 3 s wait with no new
    event; `page.emulateMedia({ reducedMotion: "reduce" })` → the clock STILL
    advances while `ovl-live-dot` has no breath animation (information
    survives, decoration does not); after `core.period_end` the clock stops.
    **Phone tab shell** — `stream-tab-phone` present; for the entitled org
    (no relay override) it shows `stream-phone-gate` with the `UpgradeGate`
    copy; with a `streaming.relay` override row it shows `stream-buy-soon`
    disabled; the OBS tab's control set is unchanged by the second tab.
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
    absence AND that `run-sheet-edit-time` is present — the positive pair;
    re-pinned 2026-09-07 @ fb99bbd4c: `fixture-schedule-toggle` was retired by
    desk W2, and `run-sheet-edit-time` renders only when `canEditFixtureTime`
    allows it (`run-sheet-row.tsx:366`), so pick a SCHEDULED fixture with a
    future `scheduled_at` for this case or the pair proves nothing).
- **Smoke** (`scripts/smoke.ts`, `check`/`expectFail` at `:91-95`): overlay
  route 200 with body containing `data-testid="ovl-root"` for the smoke org's
  fixture after its override row is set through smoke's existing SQL lever (pin
  it; if none exists, set it through the same upsert `helpers.ts:500` uses),
  404 for a fixture of an org without the row (the default state — no lever
  needed); `PUT /api/v1/fixtures/<id>/stream` with a valid link → 200 and `GET
  /api/v1/public/fixtures/<id>` returns `stream_url` equal to it (the seam,
  driven end to end); an invalid host → 422.
- **Regression**: the hook's own five cases, `live-score.test.tsx`, `match-centre.test.tsx` and `live-score-data.test.ts` unchanged
  and green (poll interval, debounce, decided templates identical); the whole
  `mobile.spec.ts` file green with the new toggle folded in at all seven widths
  (the fixtures-tab cases at `:578,2715,2907,3096,3189` are the ones that will
  see it); `npm run openapi:gen` and `pnpm i18n:gen-keys` leave no diff; `tsc
  --noEmit -p apps/web/tsconfig.json` clean; full `apps/web` vitest total ≥
  main's total.
- **Visual gate** (owner sign-off, per screen; re-pinned 2026-09-07 — it is
  T1b's harness, never an ad-hoc capture): ADD rows to
  `apps/web/e2e/visual/manifest.json` — bar AND bug for cricket, football,
  tennis and volleyball at 1920×1080 on a prod build (`E2E_PROD_TARGET`) with
  real seeded data, each row `backdrop: "light"` AND a twin `"dark"`,
  `mustDifferFrom` naming its sport and style siblings (sixteen images that
  EXIST and DIFFER by hash); the panel open at 320, 768, 1280 AND 320 @ 125 %
  zoom with `checks: ["noRealClip", "tapTargets", "truncateChain",
  "railsAccessible"]` and the 320↔1280 `sameControlSet` pair; the 404 state; a
  scheduled fixture (the "—" state); the football clock mid-tick. Attached to
  the PR with a per-screen verdict row saying what was SEEN (names at 43
  characters, numeral alignment, LED position, contrast over both backdrops).

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
this repo has tried. Gates exactly as `_RULES.md` §Merge gates 1–8, plus
design §10.3's additions (T1b rows, JSON counts vs the re-baselined total,
`workflow_dispatch pr=<n>`); rebase on `main` after any desk-W3 merge that
touches `desk/run-sheet-row.tsx` (re-pinned 2026-09-07 @ fb99bbd4c — desk W1
and W2 have both merged) and re-run the whole `mobile.spec.ts` file after that
rebase, not before it; `ls db/migration/deltas | sort -V | tail -1` after
EVERY rebase (a duplicate Flyway version survives a clean rebase).

## Dispatch notes (for the orchestrator)

- Lanes that are provably disjoint and may run in parallel (re-pinned
  2026-09-07): (A) scope 1 + 2 + 2b (`match-centre/use-live-fixture.ts` + its test,
  `overlay-model.ts`, the overlay endpoint, their tests); (B) scope 3 + 4
  (migrations, `stream-url.ts`, the route, usecase, schema, OpenAPI,
  entitlement rows). Scope 5 depends on A AND on T1 having landed; scope 6
  depends on 5 and B; scope 7 on B. Anything touching `desk/run-sheet-row.tsx`
  or the division page is a single lane, sequential, and last.
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
7. Barlow mounted on a second layout — CLOSED 2026-09-07 (RP8): the layout
   imports `barlowCondensed` from `lib/fonts.ts:7-9` and adds weight 800 to
   THAT declaration; no second mount, so no double `@font-face` — still
   confirm in the built CSS once.
8. Eleven `V3_SKINS` keys = every `sport_key` a division can carry — UNPINNED;
   run `select distinct sport_key from divisions` on the dev DB and diff.

Found while writing these prompts (also in `_INDEX.md`): `WALKTHROUGH_SPECS`
NOW EXISTS on this branch after the 2026-09-07 rebase
(`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:155`, re-pinned @
fb99bbd4c) — `stream-overlay.spec.ts` is named there in the SAME commit that
adds it, or two CI jobs go red;
`broadcastRevalidate` is the peer primitive, the helper is
`fireDivisionRevalidate` at `revalidate.ts:14`; `renderIsland` exists, so the
hook's branches ARE unit-testable; the schedule toggle is gated on `status ===
"scheduled"` — copying that gate would hide the panel exactly when the club is
streaming.
